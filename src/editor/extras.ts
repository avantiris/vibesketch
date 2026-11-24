import { signal } from '@preact/signals';
import type { Color, Effect, Node, Paint, ShapeNode, TextNode } from '../core/model.ts';
import { childrenOf, isShape, solid } from '../core/model.ts';
import { around, scale as scaleM, translate } from '../core/geom.ts';
import { worldBoundsOf } from '../core/bounds.ts';
import { duplicateNodes, setNodes, topMost, transformWorld } from '../core/ops.ts';
import { ensureFont, matchFace } from './fonts.ts';
import { stage } from './stage.ts';
import { assetUrl, doc, page, pageId, pathEdit, scope, select, selection, toast, update, view } from './store.ts';

// Smaller Figma behaviours: selection navigation, property copy / paste, quick style keys,
// keyboard resizing, repeat-duplicate, eyedropper.

/** keep width : height when resizing (panel fields and canvas handles) */
export const lockAspect = signal(false);
/** Alt is held: the canvas shows distances from the selection to the hovered layer */
export const altDown = signal(false);
/** gradient whose handles are shown on the canvas (set while its editor is open) */
export const gradientEdit = signal<{ id: string; prop: 'fills' | 'strokes'; index: number } | null>(null);
/** layer the layers panel should start renaming */
export const renameRequest = signal<string | null>(null);
/** panels and toolbar hidden (Ctrl+\) */
export const uiHidden = signal(false);

const sel = () => topMost(doc.value, selection.value);
const editable = () => sel().filter(id => !doc.value.nodes[id].locked);

// ---------------------------------------------------------------- selection navigation

/** Tab / Shift+Tab: the next / previous layer among the siblings */
export function selectSibling(dir: 1 | -1) {
  const d = doc.value, ids = sel();
  const parent = ids.length ? d.nodes[ids[0]].parent : (scope.value ?? pageId.value);
  const sibs = childrenOf(d, parent).filter(id => d.nodes[id]?.visible && !d.nodes[id].locked);
  if (!sibs.length) return;
  // layer order on screen is top first, so "next" walks down the z-order
  const at = ids.length ? sibs.indexOf(ids[dir === 1 ? 0 : ids.length - 1]) : dir === 1 ? sibs.length : -1;
  const next = sibs[(at - dir + sibs.length) % sibs.length];
  scope.value = d.nodes[parent] ? parent : null;
  select([next]);
}

/** Shift+Enter: select the group containing the selection */
export function selectParent() {
  const d = doc.value, ids = sel();
  if (!ids.length) return;
  const p = d.nodes[ids[0]].parent;
  if (!d.nodes[p]) return;
  const gp = d.nodes[p].parent;
  scope.value = d.nodes[gp] ? gp : null;
  select([p]);
}

export function requestRename() {
  const ids = sel();
  if (ids.length === 1) renameRequest.value = ids[0];
}

// ---------------------------------------------------------------- quick style keys

const shapesOf = (ids: string[]) => ids.map(id => doc.value.nodes[id]).filter(isShape);

/** Shift+X */
export function swapFillStroke() {
  const ids = editable();
  if (!shapesOf(ids).length) return;
  update(d => setNodes(d, ids, n => (isShape(n) ? { ...n, fills: n.strokes, strokes: n.fills.filter(p => p.type !== 'image'), strokeWeight: n.strokeWeight || 1 } : n)));
}

/** Alt+/ and Shift+/ */
export function clearPaint(prop: 'fills' | 'strokes') {
  const ids = editable();
  if (!shapesOf(ids).length) return;
  update(d => setNodes(d, ids, n => (isShape(n) && n[prop].length ? { ...n, [prop]: [] } : n)));
}

/** Ctrl+B / Ctrl+I on text layers */
export function toggleTextStyle(what: 'bold' | 'italic') {
  const ids = editable().filter(id => doc.value.nodes[id].type === 'text');
  if (!ids.length) return false;
  const texts = ids.map(id => doc.value.nodes[id] as TextNode);
  const on = what === 'bold' ? texts.every(t => t.font.weight >= 600) : texts.every(t => t.font.italic);
  update(d => setNodes(d, ids, n => {
    if (n.type !== 'text') return n;
    const want = what === 'bold' ? { ...n.font, weight: on ? 400 : 700 } : { ...n.font, italic: !on };
    // snap to a face the family really has
    const face = matchFace(want);
    const font = face ? { family: n.font.family, weight: what === 'bold' ? face.weight : want.weight, italic: what === 'italic' ? face.italic : want.italic } : want;
    void ensureFont(font);
    return { ...n, font };
  }));
  return true;
}

// ---------------------------------------------------------------- copy / paste properties

interface Props { fills?: Paint[]; strokes?: Paint[]; stroke?: Pick<ShapeNode, 'strokeWeight' | 'strokeAlign' | 'strokeCap' | 'strokeJoin' | 'dash'>; effects: Effect[]; opacity: number; blend: Node['blend']; text?: Pick<TextNode, 'font' | 'size' | 'lineHeight' | 'letterSpacing' | 'align'>; radii?: [number, number, number, number] }
let copied: Props | null = null;

/** Ctrl+Alt+C */
export function copyProperties() {
  const n = doc.value.nodes[sel()[0]];
  if (!n) return;
  copied = { effects: n.effects, opacity: n.opacity, blend: n.blend };
  if (isShape(n)) {
    copied.fills = n.fills; copied.strokes = n.strokes;
    copied.stroke = { strokeWeight: n.strokeWeight, strokeAlign: n.strokeAlign, strokeCap: n.strokeCap, strokeJoin: n.strokeJoin, dash: n.dash };
  }
  if (n.type === 'text') copied.text = { font: n.font, size: n.size, lineHeight: n.lineHeight, letterSpacing: n.letterSpacing, align: n.align };
  if (n.type === 'rect') copied.radii = n.radii;
  toast('Properties copied');
}

/** Ctrl+Alt+V */
export function pasteProperties() {
  const c = copied, ids = editable();
  if (!c || !ids.length) return;
  update(d => setNodes(d, ids, n => {
    let out: Node = { ...n, effects: c.effects, opacity: c.opacity, blend: c.blend };
    if (isShape(out) && c.fills && c.strokes && c.stroke) out = { ...out, fills: c.fills, strokes: c.strokes, ...c.stroke };
    if (out.type === 'text' && c.text) out = { ...out, ...c.text };
    if (out.type === 'rect' && c.radii) out = { ...out, radii: c.radii };
    return out;
  }));
}

// ---------------------------------------------------------------- keyboard resize, repeat duplicate

/** Ctrl+arrows: grow / shrink the selection by whole pixels, anchored at its top-left */
export function resizeBy(dw: number, dh: number) {
  const ids = editable();
  const b = worldBoundsOf(doc.value, ids);
  if (!b || !ids.length) return;
  const sx = b.w > 1e-6 ? Math.max(1, b.w + dw) / b.w : 1, sy = b.h > 1e-6 ? Math.max(1, b.h + dh) / b.h : 1;
  update(d => transformWorld(d, ids, around(scaleM(sx, sy), { x: b.x, y: b.y })));
}

let lastDup: { ids: string[]; dx: number; dy: number } | null = null;
/** an Alt-drag produced these copies at this offset: Ctrl+D continues the row */
export function rememberDuplicate(ids: string[], dx: number, dy: number) { lastDup = { ids: ids.slice(), dx, dy }; }

/** Ctrl+D: duplicate; right after an Alt-drag (or another Ctrl+D) the copy keeps the same offset */
export function duplicateSmart() {
  if (pathEdit.value) return;
  const ids = sel();
  if (!ids.length) return;
  const rep = lastDup && lastDup.ids.length === ids.length && lastDup.ids.every(id => ids.includes(id)) ? lastDup : null;
  let out: string[] = [];
  update(d => {
    const r = duplicateNodes(d, pageId.value, ids);
    out = r.ids;
    return rep ? transformWorld(r.doc, out, translate(rep.dx, rep.dy)) : r.doc;
  });
  select(out);
  lastDup = rep ? { ids: out, dx: rep.dx, dy: rep.dy } : null;
}

// ---------------------------------------------------------------- eyedropper

// Works the same in every browser: the canvas is rendered into a bitmap once, and a loupe
// follows the pointer over it until a click picks the pixel under its centre.

let picking: (() => void) | null = null;

/** the part of the page the stage shows, as pixels (device resolution) */
async function stageSnapshot(el: HTMLElement): Promise<HTMLCanvasElement> {
  const r = el.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  const bg = page.value?.background ?? { r: 0.118, g: 0.118, b: 0.118, a: 1 };
  c.fillStyle = `rgb(${Math.round(bg.r * 255)},${Math.round(bg.g * 255)},${Math.round(bg.b * 255)})`;
  c.fillRect(0, 0, canvas.width, canvas.height);
  if (!page.value?.children.length) return canvas;
  const { exportSvg } = await import('../io/export.ts');
  const svg = await exportSvg(doc.value, pageId.value, null, { outlineText: true, background: null, assetUrl });
  if (!(svg.width > 0 && svg.height > 0)) return canvas;
  const url = URL.createObjectURL(new Blob([svg.svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('could not render the canvas')); img.src = url; });
    const v = view.value;
    c.drawImage(img, (v.x + svg.box.x * v.zoom) * dpr, (v.y + svg.box.y * v.zoom) * dpr, svg.box.w * v.zoom * dpr, svg.box.h * v.zoom * dpr);
  } finally { URL.revokeObjectURL(url); }
  return canvas;
}

/** Pick a colour from the canvas: a loupe follows the pointer, a click takes the colour under
 *  it. Null when cancelled (Esc, right click, or starting it a second time). */
export async function pickColor(): Promise<Color | null> {
  if (picking) { picking(); return null; }
  const el = stage.el;
  if (!el) return null;
  let cancelled = false;
  picking = () => { cancelled = true; };
  let shot: HTMLCanvasElement;
  try { shot = await stageSnapshot(el); }
  catch (e) { picking = null; toast(`Eyedropper failed: ${e instanceof Error ? e.message : e}`, 'error'); return null; }
  if (cancelled) { picking = null; return null; }
  const px = shot.getContext('2d')!;
  const rect = el.getBoundingClientRect(), sx = shot.width / rect.width, sy = shot.height / rect.height;

  const CELLS = 11, CELL = 10, SIZE = CELLS * CELL;
  const cover = document.createElement('div');
  cover.className = 'eyedrop';
  cover.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
  const loupe = document.createElement('div');
  loupe.className = 'eyedrop-loupe';
  const lens = document.createElement('canvas');
  lens.width = lens.height = SIZE;
  const label = document.createElement('span');
  loupe.append(lens, label);
  cover.append(loupe);
  document.body.append(cover);
  const lc = lens.getContext('2d')!;
  lc.imageSmoothingEnabled = false;

  const at = (e: { clientX: number; clientY: number }) => ({
    x: Math.min(shot.width - 1, Math.max(0, Math.floor((e.clientX - rect.left) * sx))),
    y: Math.min(shot.height - 1, Math.max(0, Math.floor((e.clientY - rect.top) * sy))),
  });
  const colorAt = (p: { x: number; y: number }): Color => { const d = px.getImageData(p.x, p.y, 1, 1).data; return { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: 1 }; };
  const hexOf = (c: Color) => '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  const move = (e: PointerEvent) => {
    const p = at(e), half = (CELLS - 1) / 2;
    lc.fillStyle = '#1e1e1e';
    lc.fillRect(0, 0, SIZE, SIZE);
    lc.drawImage(shot, p.x - half, p.y - half, CELLS, CELLS, 0, 0, SIZE, SIZE);
    lc.strokeStyle = '#fff'; lc.lineWidth = 2;
    lc.strokeRect(half * CELL, half * CELL, CELL, CELL);
    lc.strokeStyle = '#000'; lc.lineWidth = 1;
    lc.strokeRect(half * CELL - 1.5, half * CELL - 1.5, CELL + 3, CELL + 3);
    const c = hexOf(colorAt(p));
    label.textContent = c;
    loupe.style.borderColor = c;
    // beside the pointer, flipped where it would leave the stage
    const lx = e.clientX - rect.left + 18, ly = e.clientY - rect.top + 18, w = SIZE + 8, h = SIZE + 30;
    loupe.style.left = `${lx + w > rect.width ? lx - w - 36 : lx}px`;
    loupe.style.top = `${ly + h > rect.height ? ly - h - 36 : ly}px`;
    loupe.style.visibility = 'visible';
  };

  return new Promise<Color | null>(resolve => {
    const finish = (c: Color | null) => {
      picking = null;
      window.removeEventListener('keydown', key, true);
      cover.remove();
      resolve(c);
    };
    const key = (e: KeyboardEvent) => { e.stopPropagation(); e.preventDefault(); if (e.key === 'Escape' || e.key.toLowerCase() === 'i') finish(null); };
    picking = () => finish(null);
    window.addEventListener('keydown', key, true);
    cover.addEventListener('pointermove', move);
    cover.addEventListener('contextmenu', e => { e.preventDefault(); finish(null); });
    cover.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); if (e.button === 0) finish(colorAt(at(e))); else finish(null); });
  });
}

/** I: eyedropper onto the selection's fill (stroke for layers without a fill) */
export async function eyedropToSelection() {
  const c = await pickColor();
  const ids = editable();
  if (!c || !ids.length) return;
  update(d => setNodes(d, ids, n => {
    if (!isShape(n)) return n;
    const prop = n.fills.length || !n.strokes.length ? 'fills' : 'strokes';
    const list = n[prop];
    const top = list[list.length - 1];
    const paint: Paint = top && top.type === 'solid' ? { ...top, color: { ...c, a: top.color.a } } : solid(c);
    return { ...n, [prop]: list.length ? [...list.slice(0, -1), paint] : [paint] };
  }));
}
