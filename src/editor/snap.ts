import type { Box, Doc, Vec } from '../core/model.ts';
import { childrenOf } from '../core/model.ts';
import { boxesIntersect } from '../core/geom.ts';
import { worldBounds } from '../core/bounds.ts';

// Smart guides: alignment snapping against the edges / centers of nearby objects and
// equal-spacing snapping. Everything works on page-space axis-aligned boxes.

export type Guide =
  /** alignment line. axis 'x' = vertical line at x = pos, running from..to along y */
  | { kind: 'line'; axis: 'x' | 'y'; pos: number; from: number; to: number; marks: number[] }
  /** equal-gap indicator between two edges (from..to along `axis`), drawn at cross coordinate `at` */
  | { kind: 'gap'; axis: 'x' | 'y'; from: number; to: number; at: number };

export interface SnapResult { dx: number; dy: number; guides: Guide[] }

/** Boxes worth snapping to: the siblings of what is being moved (plus the enclosing group),
 *  limited to the visible area so far-away objects never grab the selection. */
export function collectTargets(doc: Doc, containerId: string, exclude: Set<string>, viewport: Box): Box[] {
  const out: Box[] = [];
  for (const id of childrenOf(doc, containerId)) {
    const n = doc.nodes[id];
    // connectors re-route while things move: aligning to them would chase a moving target
    if (!n || exclude.has(id) || !n.visible || (n.type === 'path' && n.connector)) continue;
    const b = worldBounds(doc, id);
    if (boxesIntersect(b, viewport)) out.push(b);
    if (out.length >= 400) break;
  }
  if (doc.nodes[containerId]) {
    // inside a group: the group's remaining content is covered above; also offer page-level neighbours
    let top = containerId;
    while (doc.nodes[doc.nodes[top].parent]) top = doc.nodes[top].parent;
    for (const id of childrenOf(doc, doc.nodes[top].parent)) {
      if (id === top || exclude.has(id) || !doc.nodes[id]?.visible) continue;
      const b = worldBounds(doc, id);
      if (boxesIntersect(b, viewport)) out.push(b);
      if (out.length >= 500) break;
    }
  }
  return out;
}

const EPS = 0.01;
type Axis = 'x' | 'y';
const sizeKey = (a: Axis) => (a === 'x' ? 'w' : 'h') as 'w' | 'h';
const other = (a: Axis): Axis => (a === 'x' ? 'y' : 'x');

interface AxisSnap { d: number; kind: 'line' | 'gap' | 'none' }

function lineDelta(vals: number[], targets: Box[], axis: Axis, thr: number): number | null {
  const s = sizeKey(axis);
  let best: number | null = null;
  for (const t of targets) {
    const tv = [t[axis], t[axis] + t[s] / 2, t[axis] + t[s]];
    for (const m of vals) for (const v of tv) {
      const d = v - m;
      if (Math.abs(d) <= thr && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  return best;
}

function lineGuides(box: Box, vals: number[], targets: Box[], axis: Axis): Guide[] {
  const s = sizeKey(axis), o = other(axis), os = sizeKey(o);
  const out: Guide[] = [];
  for (const m of [...new Set(vals)]) {
    let from = box[o], to = box[o] + box[os], hit = false;
    const marks = new Set<number>([box[o], box[o] + box[os]]);
    for (const t of targets) {
      const tv = [t[axis], t[axis] + t[s] / 2, t[axis] + t[s]];
      if (!tv.some(v => Math.abs(v - m) < EPS)) continue;
      hit = true;
      from = Math.min(from, t[o]); to = Math.max(to, t[o] + t[os]);
      marks.add(t[o]); marks.add(t[o] + t[os]);
    }
    if (hit) out.push({ kind: 'line', axis, pos: m, from, to, marks: [...marks] });
  }
  return out;
}

interface GapSnap { d: number; guides: (pos: number) => Guide[] }

/** equal-spacing candidates along `axis` for a moving box */
function gapCandidates(box: Box, targets: Box[], axis: Axis, thr: number): GapSnap[] {
  const s = sizeKey(axis), o = other(axis), os = sizeKey(o);
  const lo = box[axis], hi = box[axis] + box[s];
  const overlaps = (a: Box, b: Box) => a[o] < b[o] + b[os] - EPS && b[o] < a[o] + a[os] - EPS;
  const row = targets.filter(t => overlaps(t, box));
  const end = (b: Box) => b[axis] + b[s];
  // nearest neighbours on each side (allowing a little overlap so snapping can pull the box out)
  let L: Box | null = null, R: Box | null = null;
  for (const t of row) {
    if (end(t) <= lo + thr && (!L || end(t) > end(L))) L = t;
    if (t[axis] >= hi - thr && (!R || t[axis] < R[axis])) R = t;
  }
  const crossOf = (a: Box, b: Box) => (Math.max(a[o], b[o]) + Math.min(a[o] + a[os], b[o] + b[os])) / 2;
  const out: GapSnap[] = [];
  if (L && R) {
    const l = L, r = R;
    const target = (end(l) + r[axis] - box[s]) / 2;
    if (r[axis] - end(l) >= box[s]) out.push({
      d: target - lo,
      guides: pos => [
        { kind: 'gap', axis, from: end(l), to: pos, at: crossOf(l, box) },
        { kind: 'gap', axis, from: pos + box[s], to: r[axis], at: crossOf(r, box) },
      ],
    });
  }
  if (L) {
    const l = L;
    let L2: Box | null = null;
    for (const t of targets) if (t !== l && overlaps(t, l) && end(t) <= l[axis] + EPS && (!L2 || end(t) > end(L2))) L2 = t;
    if (L2) {
      const l2 = L2, g = l[axis] - end(l2);
      if (g > EPS) out.push({
        d: end(l) + g - lo,
        guides: pos => [
          { kind: 'gap', axis, from: end(l2), to: l[axis], at: crossOf(l2, l) },
          { kind: 'gap', axis, from: end(l), to: pos, at: crossOf(l, box) },
        ],
      });
    }
  }
  if (R) {
    const r = R;
    let R2: Box | null = null;
    for (const t of targets) if (t !== r && overlaps(t, r) && t[axis] >= end(r) - EPS && (!R2 || t[axis] < R2[axis])) R2 = t;
    if (R2) {
      const r2 = R2, g = r2[axis] - end(r);
      if (g > EPS) out.push({
        d: r[axis] - g - hi,
        guides: pos => [
          { kind: 'gap', axis, from: pos + box[s], to: r[axis], at: crossOf(r, box) },
          { kind: 'gap', axis, from: end(r), to: r2[axis], at: crossOf(r, r2) },
        ],
      });
    }
  }
  return out.filter(c => Math.abs(c.d) <= thr);
}

/** Snap a moving box. Returns the correction to add and the guides to display. */
export function snapBox(box: Box, targets: Box[], thr: number): SnapResult {
  const res: SnapResult = { dx: 0, dy: 0, guides: [] };
  const picks: Partial<Record<Axis, { snap: AxisSnap; gaps: GapSnap[] }>> = {};
  for (const axis of ['x', 'y'] as Axis[]) {
    const s = sizeKey(axis);
    const vals = [box[axis], box[axis] + box[s] / 2, box[axis] + box[s]];
    const ld = lineDelta(vals, targets, axis, thr);
    const gaps = gapCandidates(box, targets, axis, thr);
    const gd = gaps.reduce<number | null>((b, g) => (b === null || Math.abs(g.d) < Math.abs(b) ? g.d : b), null);
    let snap: AxisSnap = { d: 0, kind: 'none' };
    if (ld !== null && (gd === null || Math.abs(ld) <= Math.abs(gd))) snap = { d: ld, kind: 'line' };
    else if (gd !== null) snap = { d: gd, kind: 'gap' };
    picks[axis] = { snap, gaps };
    if (axis === 'x') res.dx = snap.d; else res.dy = snap.d;
  }
  const moved: Box = { x: box.x + res.dx, y: box.y + res.dy, w: box.w, h: box.h };
  for (const axis of ['x', 'y'] as Axis[]) {
    const { snap, gaps } = picks[axis]!;
    if (snap.kind === 'none') continue;
    const s = sizeKey(axis);
    res.guides.push(...lineGuides(moved, [moved[axis], moved[axis] + moved[s] / 2, moved[axis] + moved[s]], targets, axis));
    for (const g of gaps) if (Math.abs(g.d - snap.d) < EPS) res.guides.push(...g.guides(moved[axis]));
  }
  return res;
}

/** Snap a single point (resize edges, drawing, pen). `xs`/`ys` are extra exact positions. */
export function snapPoint(p: Vec, targets: Box[], thr: number, opts: { x?: boolean; y?: boolean; xs?: number[]; ys?: number[] } = {}): { p: Vec; guides: Guide[] } {
  const out = { x: p.x, y: p.y };
  const guides: Guide[] = [];
  for (const axis of ['x', 'y'] as Axis[]) {
    if (opts[axis] === false) continue;
    const extra = (axis === 'x' ? opts.xs : opts.ys) ?? [];
    let d = lineDelta([p[axis]], targets, axis, thr);
    for (const v of extra) { const e = v - p[axis]; if (Math.abs(e) <= thr && (d === null || Math.abs(e) < Math.abs(d))) d = e; }
    if (d === null) continue;
    out[axis] += d;
  }
  const dot: Box = { x: out.x, y: out.y, w: 0, h: 0 };
  for (const axis of ['x', 'y'] as Axis[]) {
    if (opts[axis] === false) continue;
    const lg = lineGuides(dot, [out[axis]], targets, axis);
    guides.push(...lg);
    const extra = (axis === 'x' ? opts.xs : opts.ys) ?? [];
    if (!lg.length && extra.some(v => Math.abs(v - out[axis]) < EPS)) {
      const o = other(axis);
      guides.push({ kind: 'line', axis, pos: out[axis], from: out[o] - 1e5, to: out[o] + 1e5, marks: [] });
    }
  }
  return { p: out, guides };
}
