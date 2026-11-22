import type { Mat, PathNode, PathPoint, SubPath, Vec } from '../core/model.ts';
import { newId, shapeDefaults, solid } from '../core/model.ts';
import { apply, applyLin, dist, invert, len, normBox, pointInBox, sub } from '../core/geom.ts';
import { worldMatrix } from '../core/bounds.ts';
import { insertNodes, normalizePath, removeNodes, setNode, toPath } from '../core/ops.ts';
import { bendSegment, cubicAt, nearestOnSeg, segmentsOf, splitSubpath } from '../core/path.ts';
import { collectTargets, snapPoint } from './snap.ts';
import { eventScreen, eventWorld, ov, redraw, toScreen, viewportWorld } from './stage.ts';
import { commit, doc, inkColor, pathEdit, prefs, rollbackIf, scope, scopeId, select, tool, update, view } from './store.ts';

// Vector editing: the pen tool and direct manipulation of points, handles and segments.

export interface DragOp {
  move(e: PointerEvent, w: Vec): void;
  up(e: PointerEvent, w: Vec): void;
  cancel?(): void;
}

export const key = (si: number, pi: number) => `${si}:${pi}`;
export const parseKey = (k: string): [number, number] => k.split(':').map(Number) as [number, number];

export function pathNode(): PathNode | null {
  const pe = pathEdit.value;
  const n = pe && doc.value.nodes[pe.id];
  return n && n.type === 'path' ? n : null;
}

const W = (id: string): Mat => worldMatrix(doc.value, id);

function setSubpaths(id: string, subpaths: SubPath[], transient = true) {
  update(d => setNode<PathNode>(d, id, n => ({ ...n, subpaths })), { transient });
}
function setSel(sel: string[]) {
  const pe = pathEdit.value;
  if (pe) pathEdit.value = { ...pe, sel };
  redraw();
}

const clonePts = (sps: SubPath[]): SubPath[] => sps.map(sp => ({ closed: sp.closed, pts: sp.pts.map(p => ({ ...p })) }));
const neg = (v: Vec): Vec => ({ x: -v.x, y: -v.y });

// ---------------------------------------------------------------- enter / exit

export function enterPathEdit(id: string) {
  const n = doc.value.nodes[id];
  if (!n || n.type === 'group' || n.type === 'text' || n.locked) return;
  if (n.type === 'path' && n.connector) {
    // editing the points by hand turns a connector into a plain path (it would be re-routed
    // otherwise); leaving without a change keeps it attached
    const p: PathNode = { ...n, connector: undefined };
    update(d => setNode(d, id, () => p));
    pathEdit.value = { id, sel: [], restore: { node: n, pristine: p.subpaths, doc: doc.value } };
  } else if (n.type === 'path') { pathEdit.value = { id, sel: [] }; }
  else {
    const p = toPath(n);
    if (!p) return;
    update(d => setNode(d, id, () => p));
    pathEdit.value = { id, sel: [], restore: { node: n, pristine: p.subpaths, doc: doc.value } };
  }
  select([id]);
  ov.pen = null;
  redraw();
}

/** Remove degenerate subpaths; returns false when nothing drawable is left. */
function cleanup(id: string): boolean {
  const n = doc.value.nodes[id];
  if (!n || n.type !== 'path') return false;
  const good = n.subpaths.filter(sp => sp.pts.length >= 2);
  if (!good.length) return false;
  if (good.length !== n.subpaths.length) setSubpaths(id, good);
  return true;
}

/** Stop drawing with the pen but stay in edit mode. */
export function finishPen() {
  const pe = pathEdit.value;
  ov.pen = null;
  ov.penCursor = null;
  ov.guides = [];
  if (pe) {
    if (!cleanup(pe.id)) {
      update(d => removeNodes(d, [pe.id]));
      pathEdit.value = null;
      select([]);
    } else {
      pathEdit.value = { ...pe, sel: [] };
      commit();
    }
  }
  redraw();
}

export function exitPathEdit() {
  const pe = pathEdit.value;
  if (!pe) return;
  ov.pen = null; ov.penCursor = null; ov.guides = []; ov.hoverPoint = null; ov.hoverSeg = null;
  pathEdit.value = null;
  const n = doc.value.nodes[pe.id];
  if (n && n.type === 'path') {
    if (pe.restore && n.subpaths === pe.restore.pristine) {
      // nothing was edited: give the primitive back
      const before = doc.value;
      rollbackIf(pe.restore.doc);
      if (doc.value === before) update(d => setNode(d, pe.id, () => pe.restore!.node));
    } else if (!cleanup(pe.id)) {
      update(d => removeNodes(d, [pe.id]));
      select([]);
    } else {
      update(d => setNode<PathNode>(d, pe.id, p => normalizePath(p)));
    }
  }
  commit();
  if (tool.value === 'pen' || tool.value === 'bend') tool.value = 'move';
  redraw();
}

// ---------------------------------------------------------------- hit testing

export type PathHit =
  | { type: 'handle'; si: number; pi: number; which: 'in' | 'out' }
  | { type: 'anchor'; si: number; pi: number }
  /** the "add point" dot in the middle of a segment */
  | { type: 'mid'; si: number; seg: number }
  | { type: 'seg'; si: number; seg: number; t: number };

/** bend behaviour: the bend tool, or Ctrl / Cmd held with the move tool (as in Figma) */
export const isBend = (e: { ctrlKey: boolean; metaKey: boolean }) => tool.value === 'bend' || (tool.value === 'move' && (e.ctrlKey || e.metaKey));

/** segments long enough on screen to offer a midpoint dot */
export function midpointOf(n: PathNode, si: number, seg: number): Vec | null {
  const sp = n.subpaths[si], s = sp && segmentsOf(sp)[seg];
  if (!s) return null;
  const M = W(n.id);
  const a = toScreen(apply(M, s.p0)), b = toScreen(apply(M, s.p1)), m = toScreen(apply(M, cubicAt(s, 0.5)));
  return dist(a, m) + dist(m, b) >= 28 ? m : null;
}

/** points whose bezier handles are shown: the selected ones and their neighbours */
export function handlePoints(n: PathNode, sel: string[]): Set<string> {
  const out = new Set<string>();
  for (const k of sel) {
    const [si, pi] = parseKey(k);
    const sp = n.subpaths[si];
    if (!sp) continue;
    const c = sp.pts.length;
    out.add(k);
    if (pi > 0 || sp.closed) out.add(key(si, (pi - 1 + c) % c));
    if (pi < c - 1 || sp.closed) out.add(key(si, (pi + 1) % c));
  }
  return out;
}

export function hitPath(s: Vec, opts: { mid?: boolean } = {}): PathHit | null {
  const pe = pathEdit.value, n = pathNode();
  if (!pe || !n) return null;
  const M = W(n.id);
  const scr = (p: Vec) => toScreen(apply(M, p));
  for (const k of handlePoints(n, pe.sel)) {
    const [si, pi] = parseKey(k);
    const p = n.subpaths[si]?.pts[pi];
    if (!p) continue;
    for (const which of ['in', 'out'] as const) {
      const hnd = p[which];
      if (hnd && dist(scr({ x: p.x + hnd.x, y: p.y + hnd.y }), s) <= 7) return { type: 'handle', si, pi, which };
    }
  }
  let best: PathHit | null = null, bd = 8;
  n.subpaths.forEach((sp, si) => sp.pts.forEach((p, pi) => {
    const d = dist(scr(p), s);
    if (d <= bd) { bd = d; best = { type: 'anchor', si, pi }; }
  }));
  if (best) return best;
  if (opts.mid) {
    for (let si = 0; si < n.subpaths.length; si++) {
      const count = segmentsOf(n.subpaths[si]).length;
      for (let i = 0; i < count; i++) {
        const m = midpointOf(n, si, i);
        if (m && dist(m, s) <= 7) return { type: 'mid', si, seg: i };
      }
    }
  }
  const local = apply(invert(M), { x: (s.x - view.value.x) / view.value.zoom, y: (s.y - view.value.y) / view.value.zoom });
  bd = 6;
  n.subpaths.forEach((sp, si) => segmentsOf(sp).forEach((seg, i) => {
    const r = nearestOnSeg(seg, local);
    const d = dist(scr(r.pt), s);
    if (d <= bd) { bd = d; best = { type: 'seg', si, seg: i, t: r.t }; }
  }));
  return best;
}

// ---------------------------------------------------------------- snapping

/** Snap a page-space point against sibling objects and the other anchors of the path. */
function snapPt(w: Vec, e: { ctrlKey: boolean; metaKey: boolean }, exclude: Set<string> = new Set()): Vec {
  const n = pathNode();
  ov.guides = [];
  if (e.ctrlKey || e.metaKey) return w;
  let p = w;
  let sx = false, sy = false;
  if (prefs.snapObjects.value) {
    const xs: number[] = [], ys: number[] = [];
    let targets: ReturnType<typeof collectTargets> = [];
    if (n) {
      const M = W(n.id);
      n.subpaths.forEach((sp, si) => sp.pts.forEach((pt, pi) => {
        if (exclude.has(key(si, pi))) return;
        const q = apply(M, pt);
        xs.push(q.x); ys.push(q.y);
      }));
      targets = collectTargets(doc.value, n.parent, new Set([n.id]), viewportWorld());
    } else targets = collectTargets(doc.value, scopeId.value, new Set(), viewportWorld());
    const r = snapPoint(w, targets, 6 / view.value.zoom, { xs, ys });
    sx = r.p.x !== w.x; sy = r.p.y !== w.y;
    p = r.p;
    ov.guides = r.guides;
  }
  if (prefs.snapPixel.value) p = { x: sx ? p.x : Math.round(p.x), y: sy ? p.y : Math.round(p.y) };
  return p;
}

function constrain45(from: Vec, to: Vec): Vec {
  const d = sub(to, from), a = Math.round(Math.atan2(d.y, d.x) / (Math.PI / 4)) * (Math.PI / 4), l = len(d);
  return { x: from.x + Math.cos(a) * l, y: from.y + Math.sin(a) * l };
}

// ---------------------------------------------------------------- pen tool

function reverseSubpath(sp: SubPath): SubPath {
  return { closed: sp.closed, pts: sp.pts.slice().reverse().map(p => ({ ...p, in: p.out, out: p.in })) };
}

/** drag after placing a point: pull out mirrored handles */
function pullHandles(id: string, si: number, pi: number, base: SubPath[], onlyIn = false): DragOp {
  const M = W(id), inv = invert(M);
  return {
    move(e, w) {
      const sps = clonePts(base);
      const p = sps[si].pts[pi];
      const anchorW = apply(M, p);
      const target = e.shiftKey ? constrain45(anchorW, w) : w;
      const hnd = applyLin(inv, sub(target, anchorW));
      if (len(sub(toScreen(target), toScreen(anchorW))) < 3) return;
      if (!onlyIn) p.out = hnd;
      p.in = neg(hnd);
      p.mode = 'mirror';
      setSubpaths(id, sps);
    },
    up() { commit(); redraw(); },
  };
}

export function penDown(e: PointerEvent): DragOp | null {
  const s = eventScreen(e);
  let w = eventWorld(e);
  const pe = pathEdit.value, n = pathNode();

  if (pe && n && ov.pen) {
    const si = ov.pen.si, sp = n.subpaths[si];
    if (!sp) { ov.pen = null; return null; }
    const M = W(n.id), inv = invert(M);
    const first = sp.pts[0], last = sp.pts[sp.pts.length - 1];
    if (sp.pts.length >= 2 && dist(toScreen(apply(M, first)), s) <= 8) {
      // close the shape
      const sps = clonePts(n.subpaths);
      sps[si].closed = true;
      setSubpaths(n.id, sps);
      ov.pen = null; ov.penCursor = null; ov.guides = [];
      setSel([key(si, 0)]);
      return pullHandles(n.id, si, 0, sps, true);
    }
    if (e.shiftKey) w = constrain45(apply(M, last), w);
    else w = snapPt(w, e);
    const l = apply(inv, w);
    const sps = clonePts(n.subpaths);
    sps[si].pts.push({ x: l.x, y: l.y, in: null, out: null, mode: 'corner' });
    setSubpaths(n.id, sps);
    setSel([key(si, sps[si].pts.length - 1)]);
    return pullHandles(n.id, si, sps[si].pts.length - 1, sps);
  }

  if (pe && n) {
    const hit = hitPath(s);
    if (hit?.type === 'anchor') {
      const sp = n.subpaths[hit.si];
      const atEnd = hit.pi === sp.pts.length - 1, atStart = hit.pi === 0;
      if (!sp.closed && (atEnd || atStart)) {
        // continue drawing from an open end
        const sps = clonePts(n.subpaths);
        if (atStart && !atEnd) sps[hit.si] = reverseSubpath(sps[hit.si]);
        setSubpaths(n.id, sps);
        ov.pen = { si: hit.si };
        const pi = sps[hit.si].pts.length - 1;
        setSel([key(hit.si, pi)]);
        const base = sps;
        const M = W(n.id), inv = invert(M);
        return {
          move(ev, wp) {
            const c = clonePts(base), p = c[hit.si].pts[pi];
            if (len(sub(toScreen(wp), toScreen(apply(M, p)))) < 3) return;
            p.out = applyLin(inv, sub(wp, apply(M, p)));
            if (p.in && !ev.altKey) { p.in = neg(p.out); p.mode = 'mirror'; }
            setSubpaths(n.id, c);
          },
          up() { commit(); },
        };
      }
    }
    if (hit?.type === 'seg') {
      insertPoint(hit.si, hit.seg, hit.t);
      return null;
    }
    // start another subpath in the same vector: from an existing point (branching off it) or
    // from a free position
    const from = hit?.type === 'anchor' ? n.subpaths[hit.si].pts[hit.pi] : null;
    if (!from) w = snapPt(w, e);
    const l = from ? { x: from.x, y: from.y } : apply(invert(W(n.id)), w);
    const sps = [...clonePts(n.subpaths), { closed: false, pts: [{ x: l.x, y: l.y, in: null, out: null, mode: 'corner' as const }] }];
    setSubpaths(n.id, sps);
    ov.pen = { si: sps.length - 1 };
    setSel([key(sps.length - 1, 0)]);
    return pullHandles(n.id, sps.length - 1, 0, sps);
  }

  // brand-new vector
  w = snapPt(w, e);
  const container = scopeId.value;
  const id = newId();
  const node: PathNode = {
    ...shapeDefaults(), id, name: 'Vector', parent: container, type: 'path', fillRule: 'nonzero',
    // identity in page space, so points are simply page coordinates while drawing
    transform: invert(worldMatrix(doc.value, container)),
    strokes: [solid(inkColor())], strokeWeight: 1,
    subpaths: [{ closed: false, pts: [{ x: w.x, y: w.y, in: null, out: null, mode: 'corner' }] }],
  };
  update(d => insertNodes(d, [node], [id], container), { transient: true });
  select([id]);
  pathEdit.value = { id, sel: [key(0, 0)] };
  ov.pen = { si: 0 };
  redraw();
  return pullHandles(id, 0, 0, node.subpaths);
}

/** pen hover: rubber band + snapping preview */
export function penHover(e: PointerEvent) {
  const n = pathNode();
  if (n && ov.pen) {
    const sp = n.subpaths[ov.pen.si];
    const last = sp?.pts[sp.pts.length - 1];
    let w = eventWorld(e);
    if (last && e.shiftKey) { w = constrain45(apply(W(n.id), last), w); ov.guides = []; } else w = snapPt(w, e);
    ov.penCursor = w;
  } else {
    ov.penCursor = null;
    const hit = n ? hitPath(eventScreen(e)) : null;
    ov.hoverSeg = hit?.type === 'seg' ? { si: hit.si, seg: hit.seg } : null;
    ov.hoverPoint = hit?.type === 'anchor' ? key(hit.si, hit.pi) : null;
    if (!hit) snapPt(eventWorld(e), e); else ov.guides = [];
  }
  redraw();
}

// ---------------------------------------------------------------- point editing

export function insertPoint(si: number, seg: number, t: number) {
  const n = pathNode();
  if (!n) return;
  const r = splitSubpath(n.subpaths[si], seg, t);
  const sps = n.subpaths.slice();
  sps[si] = r.sp;
  setSubpaths(n.id, sps, false);
  setSel([key(si, r.index)]);
}

export function deleteSelectedPoints(): boolean {
  const pe = pathEdit.value, n = pathNode();
  if (!pe || !n || !pe.sel.length) return false;
  const dead = new Set(pe.sel);
  const sps = n.subpaths
    .map((sp, si) => ({ closed: sp.closed, pts: sp.pts.filter((_, pi) => !dead.has(key(si, pi))) }))
    .filter(sp => sp.pts.length >= 2);
  ov.pen = null;
  if (!sps.length) {
    update(d => removeNodes(d, [n.id]));
    pathEdit.value = null;
    select([]);
    if (tool.value === 'pen') tool.value = 'move';
  } else {
    setSubpaths(n.id, sps, false);
    setSel([]);
  }
  return true;
}

export function nudgePoints(dx: number, dy: number): boolean {
  const pe = pathEdit.value, n = pathNode();
  if (!pe || !n || !pe.sel.length) return false;
  const d = applyLin(invert(W(n.id)), { x: dx, y: dy });
  const sps = clonePts(n.subpaths);
  for (const k of pe.sel) { const [si, pi] = parseKey(k); const p = sps[si]?.pts[pi]; if (p) { p.x += d.x; p.y += d.y; } }
  setSubpaths(n.id, sps, false);
  return true;
}

export function selectAllPoints() {
  const n = pathNode();
  if (!n) return;
  const all: string[] = [];
  n.subpaths.forEach((sp, si) => sp.pts.forEach((_, pi) => all.push(key(si, pi))));
  setSel(all);
}

/** corner <-> smooth */
function toggleSmooth(si: number, pi: number) {
  const n = pathNode();
  if (!n) return;
  const sps = clonePts(n.subpaths), sp = sps[si], p = sp.pts[pi], c = sp.pts.length;
  if (p.in || p.out) { p.in = null; p.out = null; p.mode = 'corner'; }
  else {
    const prev = pi > 0 || sp.closed ? sp.pts[(pi - 1 + c) % c] : null;
    const next = pi < c - 1 || sp.closed ? sp.pts[(pi + 1) % c] : null;
    const a = prev ?? p, b = next ?? p;
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
    if (l < 1e-9) return;
    const ux = dx / l, uy = dy / l;
    const li = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) / 3 : 0, lo = next ? Math.hypot(next.x - p.x, next.y - p.y) / 3 : 0;
    p.in = prev ? { x: -ux * li, y: -uy * li } : null;
    p.out = next ? { x: ux * lo, y: uy * lo } : null;
    p.mode = 'smooth';
  }
  setSubpaths(n.id, sps, false);
  setSel([key(si, pi)]);
}

/** keep the opposite handle in line after one handle of a smooth point changed */
function followHandle(p: PathPoint, changed: 'in' | 'out') {
  const otherKey = changed === 'in' ? 'out' : 'in';
  const hnd = p[changed], opp = p[otherKey];
  if (!hnd || !opp || p.mode === 'corner') return;
  const l = Math.hypot(hnd.x, hnd.y);
  if (l < 1e-9) return;
  const ol = p.mode === 'mirror' ? l : Math.hypot(opp.x, opp.y);
  p[otherKey] = { x: (-hnd.x / l) * ol, y: (-hnd.y / l) * ol };
}

/** Drag a set of points (page-space snapping on the grabbed one). `onClick` runs when the
 *  pointer is released without having moved; `always` commits even then. */
function dragPoints(id: string, base: SubPath[], moving: Set<string>, grabbed: Vec, w0: Vec, onClick: () => void, always = false): DragOp {
  const M = W(id), inv = invert(M);
  const origin = apply(M, grabbed);
  let started = false;
  return {
    move(ev, w) {
      if (!started && dist(toScreen(w), toScreen(w0)) < 3) return;
      started = true;
      let target = { x: origin.x + (w.x - w0.x), y: origin.y + (w.y - w0.y) };
      if (ev.shiftKey) {
        ov.guides = [];
        if (Math.abs(target.x - origin.x) > Math.abs(target.y - origin.y)) target.y = origin.y; else target.x = origin.x;
      } else target = snapPt(target, ev, moving);
      const d = applyLin(inv, sub(target, origin));
      const sps = clonePts(base);
      for (const mk of moving) { const [si, pi] = parseKey(mk); const p = sps[si]?.pts[pi]; if (p) { p.x += d.x; p.y += d.y; } }
      setSubpaths(id, sps);
    },
    up() {
      ov.guides = [];
      if (started) commit(); else { onClick(); if (always) commit(); }
      redraw();
    },
  };
}

// ---------------------------------------------------------------- point operations (toolbar / panel)

function autoHandles(sp: SubPath, pi: number): boolean {
  const p = sp.pts[pi], c = sp.pts.length;
  const prev = pi > 0 || sp.closed ? sp.pts[(pi - 1 + c) % c] : null;
  const next = pi < c - 1 || sp.closed ? sp.pts[(pi + 1) % c] : null;
  const a = prev ?? p, b = next ?? p;
  const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
  if (l < 1e-9) return false;
  const ux = dx / l, uy = dy / l;
  const li = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) / 3 : 0, lo = next ? Math.hypot(next.x - p.x, next.y - p.y) / 3 : 0;
  p.in = prev ? { x: -ux * li, y: -uy * li } : null;
  p.out = next ? { x: ux * lo, y: uy * lo } : null;
  return true;
}

/** Handle mirroring of the selected points: none (corner), angle (smooth), angle + length (mirror). */
export function setPointMode(mode: PathPoint['mode']) {
  const pe = pathEdit.value, n = pathNode();
  if (!pe || !n || !pe.sel.length) return;
  const sps = clonePts(n.subpaths);
  for (const k of pe.sel) {
    const [si, pi] = parseKey(k);
    const sp = sps[si], p = sp?.pts[pi];
    if (!p) continue;
    if (mode !== 'corner') {
      if (!p.in && !p.out) autoHandles(sp, pi);
      else if (!p.in && p.out) p.in = neg(p.out);
      else if (!p.out && p.in) p.out = neg(p.in);
      p.mode = mode;
      followHandle(p, p.out ? 'out' : 'in');
    } else p.mode = 'corner';
  }
  setSubpaths(n.id, sps, false);
  redraw();
}

/** remove the bezier handles of the selected points (sharp corners) */
export function straightenPoints() {
  const pe = pathEdit.value, n = pathNode();
  if (!pe || !n || !pe.sel.length) return;
  const sps = clonePts(n.subpaths);
  for (const k of pe.sel) { const [si, pi] = parseKey(k); const p = sps[si]?.pts[pi]; if (p) { p.in = null; p.out = null; p.mode = 'corner'; } }
  setSubpaths(n.id, sps, false);
  redraw();
}

/** add a point in the middle of every segment whose two ends are selected */
export function addMidpoints() {
  const pe = pathEdit.value, n = pathNode();
  if (!pe || !n) return;
  const sel = new Set(pe.sel), next: string[] = [];
  const sps = n.subpaths.map((sp, si) => {
    let cur = sp;
    const segs = segmentsOf(sp);
    for (let i = segs.length - 1; i >= 0; i--) {
      if (sel.has(key(si, segs[i].i0)) && sel.has(key(si, segs[i].i1))) cur = splitSubpath(cur, i, 0.5).sp;
    }
    if (cur !== sp) cur.pts.forEach((_, pi) => next.push(key(si, pi)));
    return cur;
  });
  if (!next.length) return;
  setSubpaths(n.id, sps, false);
  setSel(next);
}

/** open or close the subpaths that have selected points (all of them when nothing is selected) */
export function toggleClosed() {
  const pe = pathEdit.value, n = pathNode();
  if (!pe || !n) return;
  const touched = new Set(pe.sel.map(k => parseKey(k)[0]));
  const sps = n.subpaths.map((sp, si) => (touched.size === 0 || touched.has(si) ? { ...sp, closed: !sp.closed } : sp));
  setSubpaths(n.id, sps, false);
  redraw();
}

/** Cut the path at the selected points: a closed shape opens there, an open one splits in two. */
export function cutAtPoints() {
  const pe = pathEdit.value, n = pathNode();
  if (!pe || !n || !pe.sel.length) return;
  const out: SubPath[] = [];
  const cutOpen = (pts: PathPoint[], cuts: Set<number>) => {
    let cur: PathPoint[] = [];
    pts.forEach((p, i) => {
      if (cuts.has(i) && i > 0 && i < pts.length - 1) {
        cur.push({ ...p, out: null, mode: 'corner' });
        out.push({ closed: false, pts: cur });
        cur = [{ ...p, in: null, mode: 'corner' }];
      } else cur.push({ ...p });
    });
    if (cur.length >= 2) out.push({ closed: false, pts: cur });
  };
  n.subpaths.forEach((sp, si) => {
    const idx = pe.sel.map(parseKey).filter(([s]) => s === si).map(([, p]) => p).sort((a, b) => a - b);
    if (!idx.length) { out.push(sp); return; }
    if (!sp.closed) { cutOpen(sp.pts, new Set(idx)); return; }
    const c = sp.pts.length, s = idx[0];
    const rot = [...sp.pts.slice(s), ...sp.pts.slice(0, s)].map(p => ({ ...p }));
    const first = rot[0];
    rot.push({ ...first, out: null, mode: 'corner' });
    rot[0] = { ...first, in: null, mode: 'corner' };
    cutOpen(rot, new Set(idx.slice(1).map(i => (i - s + c) % c)));
  });
  ov.pen = null;
  setSubpaths(n.id, out, false);
  setSel([]);
}

/** Connect two selected end points: closes a subpath or joins two open ones. */
export function joinPoints(): boolean {
  const pe = pathEdit.value, n = pathNode();
  if (!pe || !n || pe.sel.length !== 2) return false;
  const [a, b] = pe.sel.map(parseKey);
  const isEnd = ([si, pi]: [number, number]) => { const sp = n.subpaths[si]; return sp && !sp.closed && (pi === 0 || pi === sp.pts.length - 1); };
  if (!isEnd(a) || !isEnd(b)) return false;
  let sps: SubPath[];
  if (a[0] === b[0]) {
    if (a[1] === b[1]) return false;
    sps = n.subpaths.map((sp, si) => (si === a[0] ? { ...sp, closed: true } : sp));
  } else {
    let A = n.subpaths[a[0]], B = n.subpaths[b[0]];
    if (a[1] === 0) A = reverseSubpath(A);
    if (b[1] !== 0) B = reverseSubpath(B);
    const last = A.pts[A.pts.length - 1], first = B.pts[0];
    const same = Math.hypot(last.x - first.x, last.y - first.y) < 1e-6;
    const pts = same
      ? [...A.pts.slice(0, -1), { ...last, out: first.out, mode: 'corner' as const }, ...B.pts.slice(1)]
      : [...A.pts, ...B.pts];
    sps = n.subpaths.filter((_, si) => si !== a[0] && si !== b[0]);
    sps.push({ closed: false, pts: pts.map(p => ({ ...p })) });
  }
  ov.pen = null;
  setSubpaths(n.id, sps, false);
  setSel([]);
  return true;
}

/** page-space position and shared handle mode of the selected points (for the panel) */
export function selectedPointInfo(): { count: number; x: number; y: number; mode: PathPoint['mode'] | null } | null {
  const pe = pathEdit.value, n = pathNode();
  if (!pe || !n || !pe.sel.length) return null;
  const pts = pe.sel.map(k => { const [si, pi] = parseKey(k); return n.subpaths[si]?.pts[pi]; }).filter((p): p is PathPoint => !!p);
  if (!pts.length) return null;
  const w = apply(W(n.id), pts[0]);
  return { count: pts.length, x: w.x, y: w.y, mode: pts.every(p => p.mode === pts[0].mode) ? pts[0].mode : null };
}

export function pathDown(e: PointerEvent, dbl: boolean): DragOp | null {
  const pe = pathEdit.value, n = pathNode();
  if (!pe || !n) return null;
  const s0 = eventScreen(e), w0 = eventWorld(e);
  const bend = isBend(e);
  const hit = hitPath(s0, { mid: !bend });
  const id = n.id, M = W(id), inv = invert(M);
  const base = n.subpaths;

  if (!hit) {
    if (dbl) { exitPathEdit(); return null; }
    const before = e.shiftKey ? pe.sel : [];
    let moved = false;
    return {
      move(_e, w) {
        moved = true;
        const box = normBox(w0, w);
        ov.marquee = box;
        const sel = new Set(before);
        base.forEach((sp, si) => sp.pts.forEach((p, pi) => { if (pointInBox(apply(M, p), box)) sel.add(key(si, pi)); }));
        setSel([...sel]);
      },
      up() { ov.marquee = null; if (!moved && !e.shiftKey) setSel([]); redraw(); },
      cancel() { ov.marquee = null; setSel(before); },
    };
  }

  if (hit.type === 'handle') {
    return {
      move(ev, w) {
        const sps = clonePts(base), p = sps[hit.si].pts[hit.pi];
        const anchorW = apply(M, p);
        const target = ev.shiftKey ? constrain45(anchorW, w) : w;
        p[hit.which] = applyLin(inv, sub(target, anchorW));
        if (ev.altKey || bend) p.mode = 'corner';
        followHandle(p, hit.which);
        setSubpaths(id, sps);
      },
      up() { commit(); },
    };
  }

  if (hit.type === 'anchor') {
    const k = key(hit.si, hit.pi);
    if (dbl) { toggleSmooth(hit.si, hit.pi); return null; }
    if (bend) {
      // bend tool on a point: click toggles corner / smooth, drag pulls out new handles
      setSel([k]);
      const pull = pullHandles(id, hit.si, hit.pi, base);
      let moved = false;
      return {
        move(ev, w) { if (dist(toScreen(w), toScreen(w0)) >= 3) moved = true; pull.move(ev, w); },
        up(ev, w) { if (moved) pull.up(ev, w); else toggleSmooth(hit.si, hit.pi); },
      };
    }
    let sel = pe.sel;
    let deselectOnClick = false;
    if (e.shiftKey) {
      if (sel.includes(k)) deselectOnClick = true; else sel = [...sel, k];
    } else if (!sel.includes(k)) sel = [k];
    setSel(sel);
    const keep = sel;
    return dragPoints(id, base, new Set(sel), base[hit.si].pts[hit.pi], w0, () => {
      if (deselectOnClick) setSel(keep.filter(x => x !== k));
      else if (!e.shiftKey) setSel([k]);
    });
  }

  if (hit.type === 'mid') {
    // the dot in the middle of a segment: add a point there and keep dragging it
    const r = splitSubpath(base[hit.si], hit.seg, 0.5);
    const sps = base.slice();
    sps[hit.si] = r.sp;
    setSubpaths(id, sps);
    const k = key(hit.si, r.index);
    setSel([k]);
    return dragPoints(id, sps, new Set([k]), r.sp.pts[r.index], w0, () => commit(), true);
  }

  // segment
  if (dbl) { insertPoint(hit.si, hit.seg, hit.t); return null; }
  const seg = segmentsOf(base[hit.si])[hit.seg];
  const ends = [key(hit.si, seg.i0), key(hit.si, seg.i1)];
  if (!bend) {
    // move tool: the segment travels with both of its end points
    const sel = e.shiftKey ? [...new Set([...pe.sel, ...ends])] : ends.every(x => pe.sel.includes(x)) ? pe.sel : ends;
    setSel(sel);
    return dragPoints(id, base, new Set(sel), base[hit.si].pts[seg.i0], w0, () => { if (!e.shiftKey) setSel(ends); });
  }
  setSel(ends);
  const l0 = apply(inv, w0);
  let started = false;
  return {
    move(_e, w) {
      if (!started && dist(toScreen(w), toScreen(w0)) < 3) return;
      started = true;
      const l = apply(inv, w);
      const r = bendSegment(seg, hit.t, { x: l.x - l0.x, y: l.y - l0.y });
      const sps = clonePts(base), a = sps[hit.si].pts[seg.i0], b = sps[hit.si].pts[seg.i1];
      a.out = r.out0; b.in = r.in1;
      followHandle(a, 'out'); followHandle(b, 'in');
      setSubpaths(id, sps);
    },
    up() { if (started) commit(); },
  };
}

/** cursor feedback + hover state in edit mode (move tool) */
export function pathHover(e: PointerEvent): string {
  const bend = isBend(e);
  const hit = hitPath(eventScreen(e), { mid: !bend });
  const hp = hit?.type === 'anchor' ? key(hit.si, hit.pi) : null;
  const hs = hit?.type === 'seg' || hit?.type === 'mid' ? { si: hit.si, seg: hit.seg } : null;
  if (hp !== ov.hoverPoint || hs?.si !== ov.hoverSeg?.si || hs?.seg !== ov.hoverSeg?.seg) { ov.hoverPoint = hp; ov.hoverSeg = hs; redraw(); }
  if (!hit) return 'default';
  if (bend) return 'crosshair';
  return hit.type === 'mid' ? 'copy' : 'move';
}

export function leaveScopeIfGone() {
  if (scope.value && !doc.value.nodes[scope.value]) scope.value = null;
}
