import type { Doc } from '../core/model.ts';
import type { Workspace } from '../storage/workspace.ts';

// Project storage on top of the workspace (a folder or the browser's private storage).
// There is no server: this module is the whole "backend".

export const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let ws: Workspace | null = null;
export function setWorkspace(w: Workspace) {
  ws = w;
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
}
export function workspace(): Workspace {
  if (!ws) throw new ApiError(503, 'storage is not ready yet');
  return ws;
}

const dec = new TextDecoder();
const EXT = '.vsk';
const dirOf = (name: string) => `${checkName(name)}${EXT}`;
const docPath = (name: string) => `${dirOf(name)}/doc.json`;

export function checkName(name: string): string {
  if (typeof name !== 'string' || name.length < 1 || name.length > 100 || /[\\/\0]/.test(name) || name.startsWith('.') || name.trim() !== name) {
    throw new ApiError(400, 'Project names must be 1–100 characters without slashes and may not start with a dot');
  }
  return name;
}
const checkKey = (key: string) => { if (!/^[a-f0-9]{8,64}\.[a-z0-9]{1,8}$/.test(key)) throw new ApiError(400, `invalid asset key: ${key}`); return key; };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('');
}
const revOf = async (bytes: Uint8Array) => (await sha256Hex(bytes)).slice(0, 16);

export async function sha256Key(bytes: Uint8Array, ext: string): Promise<string> {
  return (await sha256Hex(bytes)).slice(0, 32) + '.' + (ext.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin');
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};
/** blob: URLs of assets, keyed "<project>/<key>" */
const urls = new Map<string, string>();
function remember(name: string, key: string, bytes: Uint8Array): string {
  const id = `${name}/${key}`;
  let u = urls.get(id);
  if (!u) {
    u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[key.split('.').pop() ?? ''] ?? 'application/octet-stream' }));
    urls.set(id, u);
  }
  return u;
}

async function copyDir(w: Workspace, from: string, to: string) {
  for (const f of await w.list(from)) {
    const data = await w.read(f.path);
    if (data) await w.write(to + f.path.slice(from.length), data);
  }
}

export interface ProjectInfo { name: string; mtime: number; size: number }
export interface FontInfo { id: string; family: string; style: string; weight: number; italic: boolean; file: string; /** variable font: the weights the file covers */ wght?: [number, number] }

export const api = {
  async projects(): Promise<ProjectInfo[]> {
    const w = workspace();
    const out: ProjectInfo[] = [];
    for (const d of await w.dirs('')) {
      if (!d.endsWith(EXT) || d.startsWith('.')) continue;
      const files = await w.list(d);
      const docFile = files.find(f => f.path === `${d}/doc.json`);
      if (!docFile) continue;
      out.push({ name: d.slice(0, -EXT.length), mtime: docFile.mtime, size: files.reduce((s, f) => s + f.size, 0) });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  },

  async createProject(name: string, doc: Doc): Promise<{ name: string; rev: string }> {
    const w = workspace();
    if (await w.stat(docPath(name))) throw new ApiError(409, `A project named "${name}" already exists`);
    const text = JSON.stringify(doc, null, 1);
    await w.write(docPath(name), text);
    return { name, rev: await revOf(new TextEncoder().encode(text)) };
  },

  async renameProject(name: string, to: string): Promise<void> {
    const w = workspace();
    if (await w.stat(docPath(to))) throw new ApiError(409, `A project named "${to}" already exists`);
    await copyDir(w, dirOf(name), dirOf(to));
    await w.removeDir(dirOf(name));
  },

  async duplicateProject(name: string, to: string): Promise<void> {
    const w = workspace();
    if (await w.stat(docPath(to))) throw new ApiError(409, `A project named "${to}" already exists`);
    await copyDir(w, dirOf(name), dirOf(to));
  },

  /** moves the project into the workspace's trash folder */
  async deleteProject(name: string): Promise<void> {
    const w = workspace();
    await copyDir(w, dirOf(name), `.vibesketch/trash/${new Date().toISOString().replace(/[:.]/g, '-')}-${dirOf(name)}`);
    await w.removeDir(dirOf(name));
  },

  async getDoc(name: string): Promise<{ doc: Doc; rev: string; mtime: number }> {
    const w = workspace();
    const bytes = await w.read(docPath(name));
    if (!bytes) throw new ApiError(404, `Project "${name}" was not found`);
    let doc: Doc;
    try { doc = JSON.parse(dec.decode(bytes)) as Doc; } catch { throw new ApiError(422, `"${name}" has a damaged doc.json`); }
    return { doc, rev: await revOf(bytes), mtime: (await w.stat(docPath(name)))?.mtime ?? 0 };
  },

  /** cheap check for changes made outside this tab */
  async docStamp(name: string): Promise<number | null> {
    return (await workspace().stat(docPath(name)))?.mtime ?? null;
  },
  async docRev(name: string): Promise<string | null> {
    const bytes = await workspace().read(docPath(name));
    return bytes ? revOf(bytes) : null;
  },

  /** throws ApiError(409) when the stored doc is not the one `baseRev` refers to (unless force) */
  async putDoc(name: string, doc: Doc, baseRev: string | null, force = false): Promise<{ rev: string; mtime: number }> {
    const w = workspace();
    if (baseRev && !force) {
      const cur = await w.read(docPath(name));
      if (cur && (await revOf(cur)) !== baseRev) throw new ApiError(409, 'The project changed outside this tab');
    }
    const bytes = new TextEncoder().encode(JSON.stringify(doc, null, 1));
    await w.write(docPath(name), bytes);
    return { rev: await revOf(bytes), mtime: (await w.stat(docPath(name)))?.mtime ?? Date.now() };
  },

  /** URL for an asset that was loaded with loadAssets / putAsset; '' while unknown */
  assetUrl: (name: string, key: string): string => urls.get(`${name}/${key}`) ?? '',

  async readAsset(name: string, key: string): Promise<Uint8Array | null> {
    return workspace().read(`${dirOf(name)}/assets/${checkKey(key)}`);
  },

  /** make assets displayable; returns the keys whose files are missing */
  async loadAssets(name: string, keys: Iterable<string>): Promise<string[]> {
    const missing: string[] = [];
    for (const key of keys) {
      if (urls.has(`${name}/${key}`)) continue;
      const bytes = /^[a-f0-9]{8,64}\.[a-z0-9]{1,8}$/.test(key) ? await api.readAsset(name, key) : null;
      if (bytes) remember(name, key, bytes); else missing.push(key);
    }
    return missing;
  },

  async putAsset(name: string, key: string, bytes: Uint8Array): Promise<void> {
    const w = workspace(), path = `${dirOf(name)}/assets/${checkKey(key)}`;
    // content addressed: an existing file already has these bytes
    if (!(await w.stat(path))) await w.write(path, bytes);
    remember(name, key, bytes);
  },

  /** typefaces shipped with the app (see scripts/build-fonts.ts); empty when none were bundled */
  async fonts(): Promise<FontInfo[]> {
    try {
      const res = await fetch(new URL('fonts/manifest.json', document.baseURI));
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return [];
      return (await res.json()) as FontInfo[];
    } catch { return []; }
  },
  fontUrl: (file: string) => new URL(`fonts/${file}`, document.baseURI).href,

  /** one SVG document per PDF page, converted in the browser by MuPDF (loaded on first use) */
  async pdf2svg(bytes: Uint8Array): Promise<string[]> {
    const { pdfToSvg } = await import('./pdf.ts');
    return pdfToSvg(bytes);
  },
};

// ---------------------------------------------------------------- change notifications

export type StoreEvent = { type: 'doc'; project: string; rev: string; origin: string } | { type: 'projects'; origin: string };

// opened on first use: an open channel would keep a Node process (tests) alive
let channel: BroadcastChannel | null = null;
const chan = () => (channel ??= typeof BroadcastChannel !== 'undefined' && typeof document !== 'undefined' ? new BroadcastChannel('vibesketch') : null);
/** tell other tabs of this browser that something was written */
export function announce(e: StoreEvent) { chan()?.postMessage(e); }
export function listen(onEvent: (e: StoreEvent) => void): () => void {
  const h = (m: MessageEvent) => { const e = m.data as StoreEvent; if (e && e.origin !== clientId) onEvent(e); };
  chan()?.addEventListener('message', h);
  return () => chan()?.removeEventListener('message', h);
}
