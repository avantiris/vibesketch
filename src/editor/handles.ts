import type { Box, GradientPaint, Mat, RectNode, ShapeNode, Vec } from '../core/model.ts';
import { apply, dist, invert } from '../core/geom.ts';
import { localBounds, worldBounds, worldBoundsOf, worldMatrix } from '../core/bounds.ts';
import { setNode, topMost } from '../core/ops.ts';
import { effect } from '@preact/signals';
import { altDown, gradientEdit } from './extras.ts';
import type { DragOp } from './pathtool.ts';
import { ov, redraw, toScreen, toWorld } from './stage.ts';
import { commit, doc, hover, pathEdit, revert, selection, textEdit, update, view } from './store.ts';

// On-canvas handles beyond move / resize / rotate: corner radius dots on rectangles, gradient
// end points, and the Alt-hover distance read-out.

// ---------------------------------------------------------------- corner radius

const CORNERS: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];

function soleRect(): RectNode | null {
  const sel = selection.value;
  if (sel.length !== 1 || pathEdit.value || textEdit.value) return null;
  const n = doc.value.nodes[sel[0]];
  return n && n.type === 'rect' && !n.locked ? n : null;
}

/** inset of the radius dots from the corners, in the rect's local units */
function radiusInset(n: RectNode, M: Mat): { inset: number; pad: number } | null {
  const k = Math.hypot(M[0], M[1]) * view.value.zoom;
  if (Math.min(n.w, n.h) * k < 48) return null; // too small to show them without clutter
  const pad = 14 / k;
  const r = Math.min(Math.max(...n.radii), n.w / 2, n.h / 2);
  return { inset: Math.min(Math.max(r, pad), Math.min(n.w, n.h) / 2), pad };
}

/** screen positions of the four corner-radius dots (empty when not applicable) */
export function radiusDots(): Vec[] {
  const n = soleRect();
  if (!n) return [];
  const M = worldMatrix(doc.value, n.id), g = radiusInset(n, M);
  if (!g) return [];
  return CORNERS.map(([cx, cy]) => toScreen(apply(M, { x: cx ? n.w - g.inset : g.inset, y: cy ? n.h - g.inset : g.inset })));
}

function radiusDown(s: Vec): DragOp | null {
  const n = soleRect();
  if (!n) return null;
  const dots = radiusDots();
  const i = dots.findIndex(p => dist(p, s) <= 7);
  if (i < 0) return null;
  const base = doc.value, inv = invert(worldMatrix(base, n.id));
  const [cx, cy] = CORNERS[i];
  // distance from the grabbed corner along its diagonal, in local units
  const depth = (w: Vec) => { const l = apply(inv, w); return Math.min(cx ? n.w - l.x : l.x, cy ? n.h - l.y : l.y); };
  const r0 = Math.min(Math.max(...n.radii), n.w / 2, n.h / 2);
  const d0 = depth(toWorld(s));
  return {
    move(ev, w) {
      const max = Math.min(n.w, n.h) / 2;
      let r = Math.max(0, Math.min(max, r0 + depth(w) - d0));
      if (!ev.ctrlKey && !ev.metaKey) r = Math.round(r);
      // Alt: only the grabbed corner, like Figma
      const radii = (ev.altKey ? n.radii.map((v, k) => (k === i ? r : v)) : [r, r, r, r]) as RectNode['radii'];
      update(() => setNode<RectNode>(base, n.id, { radii }), { transient: true });
      ov.label = `Radius ${r}`;
      redraw();
    },
    up() { ov.label = null; commit(); redraw(); },
    cancel() { ov.label = null; revert(); },
  };
}

// ---------------------------------------------------------------- gradient handles

// the handles belong to one layer: forget them when the selection moves on
effect(() => {
  const g = gradientEdit.peek(), sel = selection.value;
  if (g && !(sel.length === 1 && sel[0] === g.id)) gradientEdit.value = null;
});

function gradientTarget(): { node: ShapeNode; paint: GradientPaint; box: Box; M: Mat } | null {
  const g = gradientEdit.value;
  if (!g || pathEdit.value) return null;
  const n = doc.value.nodes[g.id];
  if (!n || n.type === 'group') return null;
  const paint = n[g.prop][g.index];
  if (!paint || paint.type !== 'gradient') return null;
  return { node: n, paint, box: localBounds(doc.value, n.id), M: worldMatrix(doc.value, n.id) };
}

/** screen positions of the gradient's start and end, plus its stops along the line */
export function gradientLine(): { from: Vec; to: Vec; paint: GradientPaint } | null {
  const t = gradientTarget();
  if (!t) return null;
  const P = (v: Vec) => toScreen(apply(t.M, { x: t.box.x + v.x * t.box.w, y: t.box.y + v.y * t.box.h }));
  return { from: P(t.paint.from), to: P(t.paint.to), paint: t.paint };
}

function gradientDown(s: Vec): DragOp | null {
  const line = gradientLine(), t = gradientTarget(), g = gradientEdit.value;
  if (!line || !t || !g) return null;
  const which = dist(line.to, s) <= 8 ? 'to' : dist(line.from, s) <= 8 ? 'from' : null;
  if (!which) return null;
  const base = doc.value, inv = invert(t.M);
  const other = which === 'to' ? t.paint.from : t.paint.to;
  return {
    move(ev, w) {
      const l = apply(inv, w);
      let v = { x: t.box.w > 1e-9 ? (l.x - t.box.x) / t.box.w : 0, y: t.box.h > 1e-9 ? (l.y - t.box.y) / t.box.h : 0 };
      if (ev.shiftKey) {
        // 45° steps, measured in pixels rather than in the box's stretched unit square
        const dx = (v.x - other.x) * t.box.w, dy = (v.y - other.y) * t.box.h;
        const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
        v = { x: other.x + (Math.cos(a) * len) / (t.box.w || 1), y: other.y + (Math.sin(a) * len) / (t.box.h || 1) };
      } else if (!ev.ctrlKey && !ev.metaKey) {
        // settle on the box's edges, centre lines and corners
        const snap = (c: number) => { for (const k of [0, 0.5, 1]) if (Math.abs(c - k) < 0.03) return k; return c; };
        v = { x: snap(v.x), y: snap(v.y) };
      }
      update(() => setNode<ShapeNode>(base, t.node.id, n => ({ ...n, [g.prop]: n[g.prop].map((p, i) => (i === g.index && p.type === 'gradient' ? { ...p, [which]: v } : p)) })), { transient: true });
      redraw();
    },
    up() { commit(); redraw(); },
    cancel() { revert(); },
  };
}

// ---------------------------------------------------------------- dispatch

/** pointer went down on one of the special handles? */
export function handleDown(s: Vec): DragOp | null {
  return gradientDown(s) ?? radiusDown(s);
}

export function handleHover(s: Vec): boolean {
  const line = gradientLine();
  if (line && (dist(line.to, s) <= 8 || dist(line.from, s) <= 8)) return true;
  return radiusDots().some(p => dist(p, s) <= 7);
}

// ---------------------------------------------------------------- Alt: measure distances

export interface Measure { a: Vec; b: Vec; value: number }

/** Distances from the selection to the hovered layer (page space), Figma's Alt read-out. */
export function measurements(): Measure[] {
  if (!altDown.value || pathEdit.value) return [];
  const d = doc.value, ids = topMost(d, selection.value);
  const target = hover.value;
  if (!ids.length || !target || !d.nodes[target] || ids.includes(target)) return [];
  const A = worldBoundsOf(d, ids), B = worldBounds(d, target);
  if (!A) return [];
  const out: Measure[] = [];
  const axis = (x: 'x' | 'y') => {
    const y = x === 'x' ? 'y' : 'x', w = x === 'x' ? 'w' : 'h', h = x === 'x' ? 'h' : 'w';
    const a0 = A[x], a1 = A[x] + A[w], b0 = B[x], b1 = B[x] + B[w];
    // the cross position of the read-out: middle of the overlap, else the selection's middle
    const lo = Math.max(A[y], B[y]), hi = Math.min(A[y] + A[h], B[y] + B[h]);
    const c = lo <= hi ? (lo + hi) / 2 : A[y] + A[h] / 2;
    const seg = (p: number, q: number) => {
      if (Math.abs(p - q) < 0.005) return;
      const pa = x === 'x' ? { x: p, y: c } : { x: c, y: p }, pb = x === 'x' ? { x: q, y: c } : { x: c, y: q };
      out.push({ a: pa, b: pb, value: Math.abs(p - q) });
    };
    if (a1 <= b0) seg(a1, b0);          // target is after the selection
    else if (b1 <= a0) seg(b1, a0);     // target is before it
    else { seg(a0, b0); seg(a1, b1); }  // overlapping / nested: edge to edge on both sides
  };
  axis('x'); axis('y');
  return out;
}
