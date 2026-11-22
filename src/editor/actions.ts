import type { AssetMeta, Doc, Node, Paint } from '../core/model.ts';
import { childrenOf, descendants, emptyDoc, newId } from '../core/model.ts';
import { worldBoundsOf } from '../core/bounds.ts';
import type { AlignHow } from '../core/ops.ts';
import { alignNodes, cloneSubtrees, distributeNodes, duplicateNodes, flipNodes, groupNodes, insertNodes, removeNodes, reorder, setNodes, topMost, translateWorld, ungroupNodes } from '../core/ops.ts';
import { api } from '../io/api.ts';
import { download, exportPdf, exportRaster, exportSvg } from '../io/export.ts';
import { zoomToBox } from './interact.ts';
import { deleteSelectedPoints, exitPathEdit, nudgePoints, selectAllPoints } from './pathtool.ts';
import { redraw } from './stage.ts';
import { addAsset, assetUrl, doc, page, pageId, pathEdit, project, scope, scopeId, select, selection, toast, update } from './store.ts';

// Editor commands, shared by keyboard shortcuts, menus and panels.

const sel = () => topMost(doc.value, selection.value);
const unlocked = () => sel().filter(id => !doc.value.nodes[id].locked);

export function deleteSelection() {
  if (pathEdit.value) { if (deleteSelectedPoints()) return; }
  const ids = unlocked();
  if (!ids.length) return;
  update(d => removeNodes(d, ids));
  select([]);
  if (scope.value && !doc.value.nodes[scope.value]) scope.value = null;
}

export function selectAll() {
  if (pathEdit.value) { selectAllPoints(); return; }
  const d = doc.value;
  select(childrenOf(d, scopeId.value).filter(id => d.nodes[id]?.visible && !d.nodes[id].locked));
}

export function duplicate() {
  const ids = sel();
  if (!ids.length) return;
  let out: string[] = [];
  update(d => { const r = duplicateNodes(d, pageId.value, ids); out = r.ids; return r.doc; });
  select(out);
}

export function group() {
  const ids = sel();
  if (!ids.length) return;
  let gid: string | null = null;
  update(d => { const r = groupNodes(d, pageId.value, ids); if (!r) return d; gid = r.id; return r.doc; });
  if (gid) select([gid]);
}

export function ungroup() {
  const ids = sel().filter(id => doc.value.nodes[id].type === 'group');
  if (!ids.length) return;
  let kids: string[] = [];
  update(d => { const r = ungroupNodes(d, ids); kids = r.children; return r.doc; });
  if (scope.value && !doc.value.nodes[scope.value]) scope.value = null;
  select(kids);
}

export function order(how: 'front' | 'back' | 'forward' | 'backward') {
  const ids = sel();
  if (ids.length) update(d => reorder(d, pageId.value, ids, how));
}

export function align(how: AlignHow) { const ids = unlocked(); if (ids.length) update(d => alignNodes(d, ids, how)); }
export function distribute(axis: 'x' | 'y') { const ids = unlocked(); if (ids.length > 2) update(d => distributeNodes(d, ids, axis)); }
export function flip(axis: 'x' | 'y') { const ids = unlocked(); if (ids.length) update(d => flipNodes(d, ids, axis)); }

export function nudge(dx: number, dy: number) {
  if (pathEdit.value && nudgePoints(dx, dy)) return;
  const ids = unlocked();
  if (ids.length) { update(d => translateWorld(d, ids, dx, dy)); redraw(); }
}

export function toggleFlag(flag: 'visible' | 'locked') {
  const ids = sel();
  if (!ids.length) return;
  const all = ids.every(id => doc.value.nodes[id][flag]);
  update(d => setNodes(d, ids, n => ({ ...n, [flag]: !all })));
}

export function setOpacity(v: number) {
  const ids = unlocked();
  if (ids.length) update(d => setNodes(d, ids, n => ({ ...n, opacity: v })));
}

export function toggleMask() {
  const ids = sel();
  if (!ids.length) return;
  const on = !ids.every(id => doc.value.nodes[id].mask);
  update(d => setNodes(d, ids, n => ({ ...n, mask: on || undefined })));
}

export function zoomToSelection() {
  const b = worldBoundsOf(doc.value, sel());
  if (b) zoomToBox(b, 16);
}

export function escape() {
  if (pathEdit.value) { exitPathEdit(); return; }
  if (selection.value.length) { select([]); return; }
  scope.value = null;
}

// ---------------------------------------------------------------- clipboard

interface Clip { v: 1; project: string | null; nodes: Node[]; roots: string[]; assets: Record<string, AssetMeta>; fonts: Doc['fonts'] }
const MIME = 'application/x-vibesketch';
let lastClip: Clip | null = null;

function assetKeysOf(nodes: Node[]): string[] {
  const out = new Set<string>();
  for (const n of nodes) if (n.type !== 'group') for (const p of [...n.fills, ...n.strokes] as Paint[]) if (p.type === 'image') out.add(p.asset);
  return [...out];
}

export function buildClip(): Clip | null {
  const d = doc.value;
  const ids = sel();
  if (!ids.length) return null;
  // bake world position so pasting into another group / page keeps the place
  const all = ids.flatMap(id => [id, ...descendants(d, id)]).map(id => d.nodes[id]).filter(Boolean);
  const keys = assetKeysOf(all);
  const families = new Set(all.flatMap(n => (n.type === 'text' ? [n.font.family.toLowerCase()] : [])));
  return {
    v: 1, project: project.value, nodes: all, roots: ids,
    assets: Object.fromEntries(keys.filter(k => d.assets[k]).map(k => [k, d.assets[k]])),
    fonts: d.fonts.filter(f => families.has(f.family.toLowerCase())),
  };
}

export async function onCopy(e: ClipboardEvent, cut: boolean) {
  const clip = buildClip();
  if (!clip) return;
  e.preventDefault();
  lastClip = clip;
  try {
    e.clipboardData?.setData(MIME, JSON.stringify(clip));
    // marker so a paste in this tab finds the clip even if the browser drops custom types
    lastMarker = `vibesketch-clip-${newId()}`;
    e.clipboardData?.setData('text/plain', lastMarker);
  } catch { /* clipboard may refuse custom types; lastClip still works in this tab */ }
  if (cut) deleteSelection();
}
let lastMarker = '';

/** put the selection on the system clipboard as SVG source (for pasting into other tools) */
export async function copyAsSvg() {
  const ids = sel();
  if (!ids.length) return;
  try {
    const r = await exportSvg(doc.value, pageId.value, ids, { assetUrl });
    await navigator.clipboard.writeText(r.svg);
    toast('Copied as SVG');
  } catch (err) { toast(`Copy failed: ${err instanceof Error ? err.message : err}`, 'error'); }
}

async function pasteClip(clip: Clip) {
  const d = doc.value;
  // copy assets over when the clip comes from another project
  if (clip.project && clip.project !== project.value) {
    for (const k of Object.keys(clip.assets)) {
      if (d.assets[k]) continue;
      try {
        const bytes = await api.readAsset(clip.project, k);
        if (!bytes) throw new Error('missing');
        await addAsset(bytes, k.split('.').pop() ?? 'bin');
      } catch { toast(`Could not copy image ${k}`, 'error'); }
    }
  }
  const temp: Doc = { ...emptyDoc(), nodes: Object.fromEntries(clip.nodes.map(n => [n.id, n])) };
  const container = scopeId.value;
  const { nodes, roots } = cloneSubtrees(temp, clip.roots);
  update(cur => {
    let next: Doc = { ...cur, assets: { ...clip.assets, ...cur.assets }, fonts: [...cur.fonts, ...clip.fonts.filter(f => !cur.fonts.some(g => g.asset === f.asset))] };
    next = insertNodes(next, nodes, roots, container);
    return next;
  });
  select(roots);
}

export async function onPaste(e: ClipboardEvent, importFiles: (files: File[]) => Promise<void>, importSvgText: (svg: string) => Promise<void>, addText: (text: string) => void) {
  const cd = e.clipboardData;
  if (!cd) return;
  e.preventDefault();
  const files = [...cd.files];
  if (files.length) { await importFiles(files); return; }
  const raw = cd.getData(MIME);
  if (raw) {
    try { await pasteClip(JSON.parse(raw) as Clip); return; } catch { /* fall through */ }
  }
  const text = cd.getData('text/plain');
  if (lastClip && text === lastMarker) { await pasteClip(lastClip); return; }
  if (/<svg[\s>]/i.test(text)) { await importSvgText(text); return; }
  if (/^vibesketch-clip-/.test(text)) return;
  if (text.trim()) addText(text);
}

// ---------------------------------------------------------------- export

export type ExportFormat = 'svg' | 'png' | 'jpg' | 'pdf';

export async function exportSelection(format: ExportFormat, scale: number, opts: { outlineText: boolean; background: boolean; selectionOnly: boolean }) {
  const d = doc.value;
  const ids = opts.selectionOnly && selection.value.length ? sel() : null;
  const base = (ids && ids.length === 1 ? d.nodes[ids[0]].name : ids ? project.value : `${project.value}${d.pages.length > 1 ? ' - ' + page.value.name : ''}`) || 'export';
  const name = base.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'export';
  const common = { assetUrl, background: opts.background ? page.value.background : null };
  try {
    if (format === 'svg') {
      const r = await exportSvg(d, pageId.value, ids, { ...common, outlineText: opts.outlineText });
      download(new Blob([r.svg], { type: 'image/svg+xml' }), `${name}.svg`);
    } else if (format === 'pdf') {
      const r = await exportPdf(d, pageId.value, ids, common);
      download(r.blob, `${name}.pdf`);
      if (r.rasterized) toast(`${r.rasterized} layer${r.rasterized > 1 ? 's' : ''} with effects, masks or blend modes embedded as images in the PDF`);
    } else {
      const blob = await exportRaster(d, pageId.value, ids, format === 'jpg' ? 'jpeg' : 'png', scale, common);
      download(blob, `${name}${scale !== 1 ? `@${scale}x` : ''}.${format}`);
    }
  } catch (err) {
    toast(`Export failed: ${err instanceof Error ? err.message : err}`, 'error');
  }
}

// ---------------------------------------------------------------- pages

export function addPage() {
  const id = newId();
  update(d => ({ ...d, pages: [...d.pages, { id, name: `Page ${d.pages.length + 1}`, children: [], background: page.value.background }] }));
  select([]); scope.value = null; pathEdit.value = null;
  pageId.value = id;
}

export function deletePage(id: string) {
  const d = doc.value;
  if (d.pages.length < 2) return;
  const p = d.pages.find(x => x.id === id);
  if (!p) return;
  const dead = p.children.flatMap(c => [c, ...descendants(d, c)]);
  select([]); scope.value = null; pathEdit.value = null;
  if (pageId.value === id) pageId.value = d.pages.find(x => x.id !== id)!.id;
  update(cur => {
    const nodes = { ...cur.nodes };
    for (const k of dead) delete nodes[k];
    return { ...cur, nodes, pages: cur.pages.filter(x => x.id !== id) };
  });
}

export function switchPage(id: string) {
  if (id === pageId.value) return;
  if (pathEdit.value) exitPathEdit();
  select([]); scope.value = null;
  pageId.value = id;
}
