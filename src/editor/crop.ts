import { effect, signal } from '@preact/signals';
import type { Box, ImagePaint, Mat, Node, Vec } from '../core/model.ts';
import { apply, invert, mul, translate } from '../core/geom.ts';
import { worldMatrix } from '../core/bounds.ts';
import { cropFor, imageRect } from '../core/crop.ts';
import { setNode } from '../core/ops.ts';
import type { DragOp } from './pathtool.ts';
import { eventScreen, redraw, toScreen, toWorld } from './stage.ts';
import { commit, doc, pathEdit, revert, select, selection, textEdit, update, view } from './store.ts';

// Cropping an image, entered by double-clicking it. The layer's box is the crop frame: its
// eight handles cut the picture (the image stays where it is), dragging the picture moves it
// behind the frame, and the image's own corner handles scale it.

type BoxNode = Extract<Node, { type: 'rect' | 'ellipse' | 'polygon' | 'star' }>;
export const cropEdit = signal<{ id: string; index: number } | null>(null);

const isBoxNode = (n: Node | undefined): n is BoxNode => !!n && (n.type === 'rect' || n.type === 'ellipse' || n.type === 'polygon' || n.type === 'star');
/** index of the image fill that would be cropped (the topmost visible one), or -1 */
export function croppable(n: Node | undefined): number {
  if (!isBoxNode(n) || n.locked) return -1;
  for (let i = n.fills.length - 1; i >= 0; i--) { const p = n.fills[i]; if (p.type === 'image' && p.visible && p.mode !== 'tile') return i; }
  return -1;
}

export function enterCrop(id: string): boolean {
  const index = croppable(doc.value.nodes[id]);
  if (index < 0) return false;
  pathEdit.value = null;
  select([id]);
  cropEdit.value = { id, index };
  redraw();
  return true;
}
export function exitCrop() {
  if (cropEdit.value) { cropEdit.value = null; redraw(); }
}
// cropping ends with anything that takes the layer out of the selection (undo, delete, a click elsewhere)
effect(() => {
  const c = cropEdit.value;
  if (!c) return;
  const sel = selection.value, n = doc.value.nodes[c.id];
  if (sel.length !== 1 || sel[0] !== c.id || croppable(n) < 0 || textEdit.value || pathEdit.value) cropEdit.value = null;
});

export interface CropState { node: BoxNode; index: number; paint: ImagePaint; box: Box; img: Box; M: Mat }
/** the layer being cropped: its box and the image's rectangle (both in its own coordinates) */
export function cropState(): CropState | null {
  const c = cropEdit.value, n = c ? doc.value.nodes[c.id] : undefined;
  if (!c || !isBoxNode(n)) return null;
  const paint = n.fills[c.index];
  if (!paint || paint.type !== 'image') return null;
  const box = { x: 0, y: 0, w: n.w, h: n.h };
  return { node: n, index: c.index, paint, box, img: imageRect(paint, box, doc.value.assets[paint.asset]), M: worldMatrix(doc.value, n.id) };
}

type Grip = { kind: 'frame' | 'image'; hx: number; hy: number };
const FRAME: [number, number][] = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
const CORNERS: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const at = (b: Box, hx: number, hy: number): Vec => ({ x: b.x + b.w * hx, y: b.y + b.h * hy });

/** handle positions on screen, for drawing and hit testing */
export function cropGrips(s: CropState): { grip: Grip; p: Vec }[] {
  const scr = (b: Box, hx: number, hy: number) => toScreen(apply(s.M, at(b, hx, hy)));
  return [
    ...FRAME.map(([hx, hy]) => ({ grip: { kind: 'frame' as const, hx, hy }, p: scr(s.box, hx, hy) })),
    ...CORNERS.map(([hx, hy]) => ({ grip: { kind: 'image' as const, hx, hy }, p: scr(s.img, hx, hy) })),
  ];
}
function gripAt(s: CropState, p: Vec): Grip | null {
  let best: Grip | null = null, d = 9;
  for (const g of cropGrips(s)) { const k = Math.hypot(g.p.x - p.x, g.p.y - p.y); if (k < d) { d = k; best = g.grip; } }
  return best;
}
const inside = (b: Box, p: Vec) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

function resizeCursor(s: CropState, g: Grip): string {
  const b = g.kind === 'frame' ? s.box : s.img;
  const c = toScreen(apply(s.M, at(b, 0.5, 0.5))), p = toScreen(apply(s.M, at(b, g.hx, g.hy)));
  const k = ((Math.round((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI / 45) % 4) + 4) % 4;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][k];
}

export function cropHover(e: PointerEvent): string {
  const s = cropState();
  if (!s) return 'default';
  const g = gripAt(s, eventScreen(e));
  if (g) return resizeCursor(s, g);
  const l = apply(invert(s.M), toWorld(eventScreen(e)));
  return inside(s.img, l) || inside(s.box, l) ? 'move' : 'default';
}

/** Pointer down while cropping. Null = the press was outside: cropping has ended and the
 *  press is handled like any other. */
export function cropDown(e: PointerEvent, dbl: boolean): DragOp | null {
  const s = cropState();
  if (!s) { exitCrop(); return null; }
  const inv = invert(s.M), l0 = apply(inv, toWorld(eventScreen(e)));
  const grip = gripAt(s, eventScreen(e));
  if (dbl || (!grip && !inside(s.img, l0) && !inside(s.box, l0))) { exitCrop(); return null; }
  const base = doc.value, n0 = s.node, { box, img } = s;
  // a few screen pixels, in the layer's own units
  const o = apply(s.M, { x: 0, y: 0 });
  const unit = (v: Vec) => { const p = apply(s.M, v); return Math.hypot(p.x - o.x, p.y - o.y) || 1; };
  const tx = 6 / view.value.zoom / unit({ x: 1, y: 0 }), ty = 6 / view.value.zoom / unit({ x: 0, y: 1 });
  const snap = (v: number, targets: number[], t: number, off: boolean) => { if (off) return v; for (const k of targets) if (Math.abs(v - k) <= t) return k; return v; };
  const write = (nb: Box, ni: Box) => {
    update(() => setNode<BoxNode>(base, n0.id, cur => {
      const fills = cur.fills.slice();
      fills[s.index] = { ...s.paint, mode: 'crop', crop: cropFor(ni, nb) };
      const moved = nb.x !== 0 || nb.y !== 0;
      // the layer's box always starts at its own origin: shift the layer instead
      return { ...cur, w: nb.w, h: nb.h, transform: moved ? mul(n0.transform, translate(nb.x, nb.y)) : n0.transform, fills } as BoxNode;
    }), { transient: true });
    redraw();
  };
  let moved = false;
  return {
    move(ev) {
      const l = apply(inv, toWorld(eventScreen(ev))), free = ev.ctrlKey || ev.metaKey;
      if (!moved && Math.hypot(l.x - l0.x, l.y - l0.y) * view.value.zoom < 2) return;
      moved = true;
      if (grip?.kind === 'frame') {
        // cut: the frame's edges move, the image stays
        let x0 = box.x, y0 = box.y, x1 = box.x + box.w, y1 = box.y + box.h;
        const ex = [img.x, img.x + img.w], ey = [img.y, img.y + img.h];
        if (grip.hx === 0) x0 = Math.min(snap(l.x, ex, tx, free), x1 - 1);
        if (grip.hx === 1) x1 = Math.max(snap(l.x, ex, tx, free), x0 + 1);
        if (grip.hy === 0) y0 = Math.min(snap(l.y, ey, ty, free), y1 - 1);
        if (grip.hy === 1) y1 = Math.max(snap(l.y, ey, ty, free), y0 + 1);
        write({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, img);
      } else if (grip) {
        // scale the image from the opposite corner, keeping its proportions
        const a = at(img, 1 - grip.hx, 1 - grip.hy);
        const k = Math.max(Math.abs(l.x - a.x) / img.w, Math.abs(l.y - a.y) / img.h, 4 / Math.max(img.w, img.h));
        const w = img.w * k, h = img.h * k;
        write(box, { x: grip.hx ? a.x : a.x - w, y: grip.hy ? a.y : a.y - h, w, h });
      } else {
        // move the image behind the frame; its edges catch on the frame's
        let x = img.x + l.x - l0.x, y = img.y + l.y - l0.y;
        x = snap(x, [box.x, box.x + box.w - img.w], tx, free);
        y = snap(y, [box.y, box.y + box.h - img.h], ty, free);
        write(box, { ...img, x, y });
      }
    },
    up() { if (moved) commit(); else revert(); redraw(); },
    cancel() { revert(); redraw(); },
  };
}
