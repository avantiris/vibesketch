import { batch, computed, effect, signal } from '@preact/signals';
import type { Doc, Node, SubPath, Vec } from '../core/model.ts';
import { emptyDoc, repairDoc } from '../core/model.ts';
import { routeConnectors } from '../core/connector.ts';
import { announce, api, ApiError, clientId, listen, setWorkspace, sha256Key, workspace as workspaceNow } from '../io/api.ts';
import { HandleWorkspace, IdbKV } from '../storage/workspace.ts';
import type { Workspace } from '../storage/workspace.ts';
import { createSyncManager } from '../sync/index.ts';
import type { RemoteStatus, SyncManager } from '../sync/index.ts';
import { loadSystemFonts, setProjectFonts } from './fonts.ts';

// Central editor state. The document is an immutable snapshot; every change goes through
// `update()` so history, saving and rendering stay consistent.

export type Tool = 'move' | 'hand' | 'rect' | 'ellipse' | 'line' | 'polygon' | 'star' | 'pen' | 'bend' | 'text' | 'connector' | 'slice';

export const doc = signal<Doc>(emptyDoc());
export const pageId = signal<string>(doc.value.pages[0].id);
export const selection = signal<string[]>([]);
/** the group the user has "entered" (double click); null = page level */
export const scope = signal<string | null>(null);
export const tool = signal<Tool>('move');
/** screen = world * zoom + (x, y) */
export const view = signal({ x: 0, y: 0, zoom: 1 });
/** vector edit mode: node id + selected points as "subpath:point" */
export interface PathEdit {
  id: string;
  sel: string[];
  /** set when a primitive was converted on entering edit mode: the original node, the
   *  geometry it was converted to and the doc right after conversion. Leaving edit mode
   *  without touching the geometry restores the primitive. */
  restore?: { node: Node; pristine: SubPath[]; doc: Doc };
}
export const pathEdit = signal<PathEdit | null>(null);
export const textEdit = signal<string | null>(null);
export const hover = signal<string | null>(null);

export const project = signal<string | null>(null);
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
export const saveState = signal<SaveState>('saved');
export const saveError = signal<string | null>(null);
export const remotes = signal<RemoteStatus[]>([]);

export const prefs = {
  snapObjects: signal(localGet('snapObjects', true)),
  snapPixel: signal(localGet('snapPixel', true)),
};
function localGet<T>(k: string, d: T): T {
  try { const v = localStorage.getItem('vs:' + k); return v == null ? d : (JSON.parse(v) as T); } catch { return d; }
}
export function localSet(k: string, v: unknown) { try { localStorage.setItem('vs:' + k, JSON.stringify(v)); } catch { /* private mode */ } }
effect(() => localSet('snapObjects', prefs.snapObjects.value));
effect(() => localSet('snapPixel', prefs.snapPixel.value));

export const page = computed(() => doc.value.pages.find(p => p.id === pageId.value) ?? doc.value.pages[0]);
/** default colour for new strokes and text: readable on the current page background */
export function inkColor(): { r: number; g: number; b: number; a: number } {
  const b = page.value.background;
  return 0.2126 * b.r + 0.7152 * b.g + 0.0722 * b.b < 0.4 ? { r: 1, g: 1, b: 1, a: 1 } : { r: 0, g: 0, b: 0, a: 1 };
}

/** right-click menu position (client coordinates), null = closed */
export const contextMenu = signal<{ x: number; y: number } | null>(null);

/** container new nodes go into / the selection lives in */
export const scopeId = computed(() => (scope.value && doc.value.nodes[scope.value]?.type === 'group' ? scope.value : page.value.id));

// ---------------------------------------------------------------- toasts

export interface Toast { id: number; text: string; kind: 'info' | 'error' }
export const toasts = signal<Toast[]>([]);
let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = kind === 'error' ? 8000 : 3500) {
  const t = { id: ++toastId, text, kind };
  toasts.value = [...toasts.value, t];
  setTimeout(() => { toasts.value = toasts.value.filter(x => x !== t); }, ms);
}

// ---------------------------------------------------------------- history

interface Snap { doc: Doc; selection: string[]; pageId: string }
let undoStack: Snap[] = [];
let redoStack: Snap[] = [];
let committed: Snap = { doc: doc.value, selection: [], pageId: pageId.value };
export const canUndo = signal(false);
export const canRedo = signal(false);
const HISTORY_LIMIT = 300;

function syncFlags() { canUndo.value = undoStack.length > 0; canRedo.value = redoStack.length > 0; }

/** Change the document. Transient updates (during a drag) are not recorded until `commit()`. */
export function update(fn: (d: Doc) => Doc, opts: { transient?: boolean } = {}) {
  let next = fn(doc.value);
  // connectors follow whatever they are attached to
  if (next !== doc.value) next = routeConnectors(next);
  if (next !== doc.value) doc.value = next;
  if (!opts.transient) commit();
}

/** Record the current document as an undo step (no-op when nothing changed). */
export function commit() {
  if (doc.value === committed.doc) { committed = { ...committed, selection: selection.value, pageId: pageId.value }; return; }
  undoStack.push(committed);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  committed = { doc: doc.value, selection: selection.value, pageId: pageId.value };
  syncFlags();
  markDirty();
}

/** Undo the latest commit without leaving a redo entry, but only if `d` is still the
 *  current committed document (used to silently take back an automatic conversion). */
export function rollbackIf(d: Doc) {
  if (doc.value !== d || committed.doc !== d || !undoStack.length) return;
  const s = undoStack.pop()!;
  doc.value = s.doc;
  committed = { doc: s.doc, selection: selection.value, pageId: pageId.value };
  syncFlags();
  markDirty();
}

/** Drop transient changes made since the last commit. */
export function revert() {
  if (doc.value !== committed.doc) doc.value = committed.doc;
}

function restore(s: Snap) {
  batch(() => {
    doc.value = s.doc;
    pageId.value = s.doc.pages.some(p => p.id === s.pageId) ? s.pageId : s.doc.pages[0].id;
    selection.value = s.selection.filter(id => s.doc.nodes[id]);
    if (scope.value && !s.doc.nodes[scope.value]) scope.value = null;
    const pe = pathEdit.value;
    if (pe) pathEdit.value = s.doc.nodes[pe.id]?.type === 'path' ? { id: pe.id, sel: [] } : null;
    if (textEdit.value && !s.doc.nodes[textEdit.value]) textEdit.value = null;
  });
  committed = { doc: s.doc, selection: selection.value, pageId: pageId.value };
  syncFlags();
  markDirty();
}

export function undo() {
  revert();
  const s = undoStack.pop();
  if (!s) return;
  redoStack.push({ doc: doc.value, selection: selection.value, pageId: pageId.value });
  restore(s);
}
export function redo() {
  revert();
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push({ doc: doc.value, selection: selection.value, pageId: pageId.value });
  restore(s);
}

export function select(ids: string[]) {
  const d = doc.value;
  const next = [...new Set(ids)].filter(id => d.nodes[id]);
  const cur = selection.value;
  if (next.length !== cur.length || next.some((id, i) => id !== cur[i])) selection.value = next;
}

// ---------------------------------------------------------------- persistence

let rev: string | null = null;
let stamp: number | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
let savedDoc: Doc | null = null;
let sync: SyncManager | null = null;
/** cloud sync, available once storage is ready */
export const syncManager = (): SyncManager | null => sync;
/** bumped when asset files of the open project arrive after the document did */
export const assetsVersion = signal(0);

function markDirty() {
  if (!project.value || doc.value === savedDoc) return;
  if (saveState.value !== 'conflict') saveState.value = 'dirty';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 350);
}

export async function save(force = false): Promise<void> {
  const name = project.value;
  if (!name) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (saveState.value === 'conflict' && !force) return;
  if (saving) { saveTimer = setTimeout(() => void save(force), 150); return; }
  const snapshot = committed.doc;
  if (snapshot === savedDoc && !force) { saveState.value = 'saved'; return; }
  saving = true;
  saveState.value = 'saving';
  try {
    const first = rev === null;
    const r = await api.putDoc(name, snapshot, rev, force);
    if (project.value !== name) return;
    rev = r.rev; stamp = r.mtime;
    if (first) { localSet('lastProject', name); void refreshProjects(); }
    savedDoc = snapshot;
    saveError.value = null;
    announce({ type: 'doc', project: name, rev: r.rev, origin: clientId });
    sync?.notifyLocalChange();
    if (committed.doc === snapshot) saveState.value = 'saved';
    else { saveState.value = 'dirty'; saveTimer = setTimeout(() => void save(), 150); }
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      saveState.value = 'conflict';
    } else {
      saveState.value = 'error';
      saveError.value = e instanceof Error ? e.message : String(e);
      // keep trying: the work only exists in this tab until it is written
      saveTimer = setTimeout(() => void save(), 3000);
    }
  } finally {
    saving = false;
  }
}

const assetKeys = (d: Doc): string[] => [...Object.keys(d.assets ?? {}), ...(d.fonts ?? []).map(f => f.asset)];

function adopt(d: Doc, r: string, mtime: number, asUndoStep: boolean) {
  repairDoc(d);
  batch(() => {
    if (asUndoStep) { undoStack.push(committed); redoStack = []; } else { undoStack = []; redoStack = []; }
    doc.value = d;
    if (!d.pages.some(p => p.id === pageId.value)) pageId.value = d.pages[0].id;
    selection.value = selection.value.filter(id => d.nodes[id]);
    if (scope.value && !d.nodes[scope.value]) scope.value = null;
    pathEdit.value = null;
    textEdit.value = null;
  });
  committed = { doc: d, selection: selection.value, pageId: pageId.value };
  savedDoc = d;
  rev = r; stamp = mtime;
  saveState.value = 'saved';
  syncFlags();
}

export async function openProject(name: string): Promise<void> {
  await flush();
  const { doc: d, rev: r, mtime } = await api.getDoc(name);
  await api.loadAssets(name, assetKeys(d));
  batch(() => {
    project.value = name;
    selection.value = [];
    scope.value = null;
    pageId.value = '';
    adopt(d, r, mtime, false);
  });
  localSet('lastProject', name);
  history.replaceState(null, '', `#${encodeURIComponent(name)}`);
  document.title = `${name} – vibesketch`;
}

/** Start with an empty project that only exists in memory until the first edit. Writing a
 *  blank "Untitled" to storage on every fresh device would collide with the real project of
 *  that name the moment sync is switched on. */
function openBlank(name: string) {
  batch(() => {
    project.value = name;
    selection.value = [];
    scope.value = null;
    pageId.value = '';
    adopt(emptyDoc(), '', 0, false);
  });
  rev = null; stamp = null;
  history.replaceState(null, '', `#${encodeURIComponent(name)}`);
  document.title = `${name} – vibesketch`;
}

/** write pending changes now (before switching projects / closing) */
export async function flush(): Promise<void> {
  if (project.value && committed.doc !== savedDoc && saveState.value !== 'conflict') await save();
}

/** conflict resolution: take the stored version, or overwrite it with ours */
export async function resolveConflict(how: 'theirs' | 'mine') {
  const name = project.value;
  if (!name) return;
  if (how === 'mine') { await save(true); return; }
  const { doc: d, rev: r, mtime } = await api.getDoc(name);
  await api.loadAssets(name, assetKeys(d));
  adopt(d, r, mtime, true);
}

/** the stored document of the open project changed outside this tab */
async function onOutsideChange(name: string, newRev: string | null) {
  if (name !== project.value || !newRev || newRev === rev) return;
  if (committed.doc !== savedDoc || saving) {
    // we have unsaved edits: the pending save will see the mismatch and surface the conflict
    if (!saving) void save();
    return;
  }
  try {
    const { doc: d, rev: r, mtime } = await api.getDoc(name);
    await api.loadAssets(name, assetKeys(d));
    if (name !== project.value || committed.doc !== savedDoc) return;
    adopt(d, r, mtime, true);
  } catch (e) {
    console.warn('reload failed', e);
  }
}

export const projectList = signal<{ name: string; mtime: number; size: number }[]>([]);
export async function refreshProjects() {
  try { projectList.value = await api.projects(); } catch (e) { console.warn('could not list projects', e); }
}

export function uniqueProjectName(base: string): string {
  const names = new Set(projectList.value.map(p => p.name.toLowerCase()));
  base = base.replace(/[\\/\0]/g, ' ').replace(/^\.+/, '').trim().slice(0, 90) || 'Untitled';
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

export async function newProject(base = 'Untitled', initial?: Doc): Promise<string> {
  await refreshProjects();
  const name = uniqueProjectName(base);
  await api.createProject(name, initial ?? emptyDoc());
  announce({ type: 'projects', origin: clientId });
  sync?.notifyLocalChange();
  await refreshProjects();
  return name;
}

/** call after projects were renamed / deleted / copied */
export function projectsChanged() {
  announce({ type: 'projects', origin: clientId });
  sync?.notifyLocalChange();
  void refreshProjects();
}

/** Store bytes as a project asset (content addressed) and return its key. */
export async function addAsset(bytes: Uint8Array, ext: string): Promise<string> {
  const name = project.value;
  if (!name) throw new Error('no project open');
  const key = await sha256Key(bytes, ext);
  await api.putAsset(name, key, bytes);
  sync?.notifyLocalChange();
  return key;
}

export const assetUrl = (key: string): string => (project.value ? api.assetUrl(project.value, key) : '');

// ---------------------------------------------------------------- where things are stored

export interface StorageInfo {
  state: 'loading' | 'ready' | 'needs-permission' | 'unsupported';
  kind: 'folder' | 'browser' | null;
  /** folder name, or "Browser storage" */
  name: string;
  /** this browser can use a real folder (Chromium) */
  canPickFolder: boolean;
  error?: string;
}
type Picker = (o?: { mode?: string; id?: string }) => Promise<FileSystemDirectoryHandle>;
const picker = (): Picker | undefined => (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker?.bind(window);
type Perm = { queryPermission?(o: { mode: string }): Promise<string>; requestPermission?(o: { mode: string }): Promise<string> };

export const storage = signal<StorageInfo>({ state: 'loading', kind: null, name: '', canPickFolder: false });
const kv = new IdbKV();
let pendingFolder: FileSystemDirectoryHandle | null = null;
interface SavedWorkspace { kind: 'folder' | 'browser'; handle?: FileSystemDirectoryHandle }

async function start(ws: Workspace) {
  setWorkspace(ws);
  storage.value = { state: 'ready', kind: ws.kind === 'folder' ? 'folder' : 'browser', name: ws.name, canPickFolder: !!picker() };
  // ask the browser not to evict our data when disk space runs low
  if (ws.kind === 'browser') void navigator.storage?.persist?.().catch(() => false);

  sync = createSyncManager({
    workspace: ws, kv,
    onStatus: list => { remotes.value = list.slice().sort((a, b) => a.name.localeCompare(b.name)); },
    onLocalChanged: paths => {
      void refreshProjects();
      const name = project.value;
      if (!name) return;
      if (paths.includes(`${name}.vsk/doc.json`)) void api.docRev(name).then(r => onOutsideChange(name, r));
      if (paths.some(p => p.startsWith(`${name}.vsk/assets/`))) void api.loadAssets(name, assetKeys(doc.value)).then(() => { assetsVersion.value++; });
    },
  });

  listen(e => {
    if (e.type === 'doc') void onOutsideChange(e.project, e.rev);
    else void refreshProjects();
  });
  // other programs (or a sync client) may change a folder behind our back
  setInterval(() => {
    const name = project.value;
    if (!name || document.hidden || saving) return;
    void api.docStamp(name).then(async s => {
      if (s == null || s === stamp || name !== project.value || saving) return;
      stamp = s;
      await onOutsideChange(name, await api.docRev(name));
    }).catch(() => {});
  }, 2000);

  await Promise.all([loadSystemFonts(), refreshProjects()]);
  const wanted = decodeURIComponent(location.hash.slice(1)) || localGet<string | null>('lastProject', null);
  const list = projectList.value;
  try {
    if (wanted && list.some(p => p.name === wanted)) await openProject(wanted);
    else if (list.length) await openProject(list[0].name);
    else openBlank('Untitled');
  } catch (e) {
    toast(`Could not open project: ${e instanceof Error ? e.message : e}`, 'error');
  }
  window.addEventListener('beforeunload', ev => {
    if (committed.doc !== savedDoc) { void save(); ev.preventDefault(); }
  });
  window.addEventListener('pagehide', () => { if (committed.doc !== savedDoc) void save(); });
  window.addEventListener('hashchange', () => {
    const n = decodeURIComponent(location.hash.slice(1));
    if (n && n !== project.value && projectList.value.some(p => p.name === n)) void openProject(n);
  });
}

async function browserWorkspace(): Promise<Workspace> {
  if (!navigator.storage?.getDirectory) throw new Error('This browser has no private file storage (OPFS). Use a current Firefox, Chrome, Edge or Safari, and not a private window.');
  return new HandleWorkspace(await navigator.storage.getDirectory(), 'browser');
}

export async function boot() {
  try {
    const saved = await kv.get<SavedWorkspace>('workspace').catch(() => undefined);
    if (saved?.kind === 'folder' && saved.handle) {
      const h = saved.handle as FileSystemDirectoryHandle & Perm;
      const perm = (await h.queryPermission?.({ mode: 'readwrite' }).catch(() => 'denied')) ?? 'denied';
      if (perm === 'granted') return await start(new HandleWorkspace(h, 'folder'));
      // browsers want a click before they hand a folder back after a restart
      pendingFolder = h;
      storage.value = { state: 'needs-permission', kind: 'folder', name: h.name, canPickFolder: !!picker() };
      return;
    }
    await start(await browserWorkspace());
  } catch (e) {
    storage.value = { state: 'unsupported', kind: null, name: '', canPickFolder: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** must be called from a click: re-grants access to the folder chosen earlier */
export async function reconnectFolder() {
  const h = pendingFolder as (FileSystemDirectoryHandle & Perm) | null;
  if (!h) return;
  const perm = await h.requestPermission?.({ mode: 'readwrite' });
  if (perm !== 'granted') { toast('Access to the folder was not granted', 'error'); return; }
  pendingFolder = null;
  await start(new HandleWorkspace(h, 'folder'));
}

async function copyWorkspace(from: Workspace, to: Workspace): Promise<number> {
  let n = 0;
  for (const dir of await from.dirs('')) {
    if (!dir.endsWith('.vsk') || (await to.stat(`${dir}/doc.json`))) continue;
    for (const f of await from.list(dir)) { const data = await from.read(f.path); if (data) await to.write(f.path, data); }
    n++;
  }
  return n;
}

/** must be called from a click: pick a folder on this computer and keep projects there */
export async function chooseFolder() {
  const pick = picker();
  if (!pick) return;
  let handle: FileSystemDirectoryHandle;
  try { handle = await pick({ mode: 'readwrite', id: 'vibesketch' }); } catch { return; }
  await flush();
  const target = new HandleWorkspace(handle, 'folder');
  try {
    const here = projectList.value.length;
    if (storage.value.state === 'ready' && here && confirm(`Copy the ${here} project${here > 1 ? 's' : ''} from ${storage.value.name} into "${handle.name}"? Projects that already exist there are left alone.`)) {
      await copyWorkspace(workspaceNow(), target);
    }
    await kv.set('workspace', { kind: 'folder', handle } satisfies SavedWorkspace);
  } catch (e) {
    toast(`Could not use that folder: ${e instanceof Error ? e.message : e}`, 'error');
    return;
  }
  location.reload();
}

export async function useBrowserStorage() {
  await flush().catch(() => {});
  await kv.set('workspace', { kind: 'browser' } satisfies SavedWorkspace);
  location.reload();
}

// project-embedded fonts follow the document
const docFonts = computed(() => doc.value.fonts);
effect(() => {
  const fonts = docFonts.value, name = project.value;
  void assetsVersion.value;
  setProjectFonts(name ? fonts.map(f => ({ family: f.family, weight: f.weight, italic: f.italic, url: api.assetUrl(name, f.asset) })).filter(f => f.url) : []);
});

export const worldToScreen = (p: Vec): Vec => ({ x: p.x * view.value.zoom + view.value.x, y: p.y * view.value.zoom + view.value.y });
export const screenToWorld = (p: Vec): Vec => ({ x: (p.x - view.value.x) / view.value.zoom, y: (p.y - view.value.y) / view.value.zoom });
