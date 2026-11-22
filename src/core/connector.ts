import type { ArrowCap, Box, ConnectorEnd, Doc, Node, PathNode, PathPoint, Side, SubPath, Vec } from './model.ts';
import { apply, expandBox, invert } from './geom.ts';
import { worldBounds, worldMatrix } from './bounds.ts';
import { normalizePath } from './ops.ts';
import { transformSubpaths } from './path.ts';

// Diagram connectors (lines that stay attached to shapes) and arrowheads.
//
// A connector is an ordinary path node with a `connector` field. Its points are derived data:
// routeConnectors() recomputes them after every document change, so everything else (rendering,
// export, hit testing, bounds) just sees a path.

export const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
const DIR: Record<Side, Vec> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

export const isConnector = (n: Node | undefined | null): n is PathNode & { connector: NonNullable<PathNode['connector']> } =>
  !!n && n.type === 'path' && !!n.connector;

/** the point on a bounding box where connectors attached to `side` start */
export function sideAnchor(b: Box, side: Side): Vec {
  switch (side) {
    case 'top': return { x: b.x + b.w / 2, y: b.y };
    case 'right': return { x: b.x + b.w, y: b.y + b.h / 2 };
    case 'bottom': return { x: b.x + b.w / 2, y: b.y + b.h };
    case 'left': return { x: b.x, y: b.y + b.h / 2 };
  }
}

/** the side of `b` that faces `o` */
function facingSide(b: Box, o: Box): Side {
  const gx = Math.max(o.x - (b.x + b.w), b.x - (o.x + o.w));
  const gy = Math.max(o.y - (b.y + b.h), b.y - (o.y + o.h));
  const cx = o.x + o.w / 2 - (b.x + b.w / 2), cy = o.y + o.h / 2 - (b.y + b.h / 2);
  const horizontal = gx > 0 || gy > 0 ? gx >= gy : Math.abs(cx) >= Math.abs(cy);
  return horizontal ? (cx >= 0 ? 'right' : 'left') : (cy >= 0 ? 'bottom' : 'top');
}

/** where the ray from the centre of `b` towards `p` leaves the box */
function borderPoint(b: Box, p: Vec): Vec {
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = p.x - c.x, dy = p.y - c.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return c;
  const t = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

// ---------------------------------------------------------------- elbow routing

const STEP: Vec[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
const dirIndex = (d: Vec) => (Math.abs(d.x) > Math.abs(d.y) ? (d.x > 0 ? 0 : 2) : d.y > 0 ? 1 : 3);

function search(xs: number[], ys: number[], from: Vec, fromDir: number, to: Vec, toDir: number, blocked: Box[], midX: number | null, midY: number | null, bend: number): Vec[] | null {
  const nx = xs.length, ny = ys.length;
  const ix0 = xs.indexOf(from.x), iy0 = ys.indexOf(from.y), ix1 = xs.indexOf(to.x), iy1 = ys.indexOf(to.y);
  // state = grid point + the direction it was entered in (4 = none yet)
  const id = (ix: number, iy: number, d: number) => (ix * ny + iy) * 5 + d;
  const N = nx * ny * 5;
  const cost = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  cost[id(ix0, iy0, fromDir)] = 0;
  let best = -1, bestCost = Infinity;
  for (;;) {
    let cur = -1, c = Infinity;
    for (let i = 0; i < N; i++) if (!done[i] && cost[i] < c) { c = cost[i]; cur = i; }
    if (cur < 0 || c >= bestCost) break;
    done[cur] = 1;
    const d = cur % 5, cell = (cur - d) / 5, iy = cell % ny, ix = (cell - iy) / ny;
    if (ix === ix1 && iy === iy1) {
      const total = c + (toDir !== 4 && d !== 4 && d !== toDir ? bend : 0);
      if (total < bestCost) { bestCost = total; best = cur; }
      continue;
    }
    for (let nd = 0; nd < 4; nd++) {
      if (d !== 4 && nd === (d + 2) % 4) continue;
      const jx = ix + STEP[nd].x, jy = iy + STEP[nd].y;
      if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
      const mx = (xs[ix] + xs[jx]) / 2, my = (ys[iy] + ys[jy]) / 2;
      if (blocked.some(b => mx > b.x && mx < b.x + b.w && my > b.y && my < b.y + b.h)) continue;
      let len = Math.abs(xs[jx] - xs[ix]) + Math.abs(ys[jy] - ys[iy]);
      // among equally long routes prefer the one that runs through the middle of the gap
      if ((STEP[nd].x === 0 && xs[ix] === midX) || (STEP[nd].y === 0 && ys[iy] === midY)) len *= 0.999;
      const nc = c + len + (d !== 4 && nd !== d ? bend : 0);
      const ni = id(jx, jy, nd);
      if (nc < cost[ni]) { cost[ni] = nc; prev[ni] = cur; }
    }
  }
  if (best < 0) return null;
  const out: Vec[] = [];
  for (let i = best; i >= 0; i = prev[i]) {
    const cell = (i - (i % 5)) / 5, iy = cell % ny;
    out.push({ x: xs[(cell - iy) / ny], y: ys[iy] });
  }
  return out.reverse();
}

/** Orthogonal route from a to b. `da` / `db` are the directions in which the line leaves the
 *  boxes it is attached to (null for free ends); the route keeps `margin` away from both boxes. */
export function elbowRoute(a: Vec, da: Vec | null, boxA: Box | null, b: Vec, db: Vec | null, boxB: Box | null, margin = 16): Vec[] {
  const A = boxA ?? { x: a.x, y: a.y, w: 0, h: 0 }, B = boxB ?? { x: b.x, y: b.y, w: 0, h: 0 };
  const gx = Math.max(B.x - (A.x + A.w), A.x - (B.x + B.w));
  const gy = Math.max(B.y - (A.y + A.h), A.y - (B.y + B.h));
  let m = margin;
  const gap = Math.max(gx, gy);
  if (gap > 0) m = Math.min(m, Math.max(gap / 2, 0.5));
  const sa = da ? { x: a.x + da.x * m, y: a.y + da.y * m } : a;
  const sb = db ? { x: b.x + db.x * m, y: b.y + db.y * m } : b;
  const midX = gx > 0 ? (A.x + A.w < B.x ? (A.x + A.w + B.x) / 2 : (B.x + B.w + A.x) / 2) : null;
  const midY = gy > 0 ? (A.y + A.h < B.y ? (A.y + A.h + B.y) / 2 : (B.y + B.h + A.y) / 2) : null;
  const xs = [sa.x, sb.x], ys = [sa.y, sb.y];
  for (const bx of [boxA, boxB]) if (bx) { xs.push(bx.x - m, bx.x + bx.w + m); ys.push(bx.y - m, bx.y + bx.h + m); }
  if (midX != null) xs.push(midX);
  if (midY != null) ys.push(midY);
  const uniq = (v: number[]) => [...new Set(v)].sort((p, q) => p - q);
  const X = uniq(xs), Y = uniq(ys);
  const blocked = [boxA, boxB].filter((bx): bx is Box => !!bx).map(bx => expandBox(bx, m - Math.min(0.01, m / 2)));
  const bend = Math.max(4 * m, 24);
  const fd = da ? dirIndex(da) : 4, td = db ? dirIndex({ x: -db.x, y: -db.y }) : 4;
  const mid = search(X, Y, sa, fd, sb, td, blocked, midX, midY, bend)
    // boxes that overlap or sit too close leave no clear way: route as if they were not there
    ?? search(X, Y, sa, fd, sb, td, [], midX, midY, bend)
    ?? [sa, sb];
  return simplifyPolyline([a, ...mid, b]);
}

/** drop repeated points and points in the middle of a straight run */
function simplifyPolyline(pts: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (l && Math.abs(l.x - p.x) < 1e-6 && Math.abs(l.y - p.y) < 1e-6) continue;
    const k = out[out.length - 2];
    if (k && l && Math.abs((l.x - k.x) * (p.y - l.y) - (l.y - k.y) * (p.x - l.x)) < 1e-6 && (l.x - k.x) * (p.x - l.x) + (l.y - k.y) * (p.y - l.y) > 0) out.pop();
    out.push(p);
  }
  return out;
}

const KAPPA = 0.5523;
const corner = (x: number, y: number, hin: Vec | null = null, hout: Vec | null = null): PathPoint => ({ x, y, in: hin, out: hout, mode: 'corner' });

/** a polyline whose corners are replaced by quarter-circle-like curves of the given radius */
export function roundedPolyline(pts: Vec[], radius: number): PathPoint[] {
  if (pts.length < 3 || radius <= 0) return pts.map(p => corner(p.x, p.y));
  const out: PathPoint[] = [corner(pts[0].x, pts[0].y)];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], a = pts[i - 1], b = pts[i + 1];
    const la = Math.hypot(p.x - a.x, p.y - a.y), lb = Math.hypot(b.x - p.x, b.y - p.y);
    // interior segments are shared by two corners
    const r = Math.min(radius, i === 1 ? la : la / 2, i === pts.length - 2 ? lb : lb / 2);
    if (r < 0.01 || la < 1e-9 || lb < 1e-9) { out.push(corner(p.x, p.y)); continue; }
    const ua = { x: (p.x - a.x) / la, y: (p.y - a.y) / la }, ub = { x: (b.x - p.x) / lb, y: (b.y - p.y) / lb };
    const k = r * KAPPA;
    out.push(corner(p.x - ua.x * r, p.y - ua.y * r, null, { x: ua.x * k, y: ua.y * k }));
    out.push(corner(p.x + ub.x * r, p.y + ub.y * r, { x: -ub.x * k, y: -ub.y * k }, null));
  }
  const l = pts[pts.length - 1];
  out.push(corner(l.x, l.y));
  return out;
}

// ---------------------------------------------------------------- keeping connectors attached

interface End { p: Vec; dir: Vec | null; box: Box | null }

function attachable(doc: Doc, self: PathNode, e: ConnectorEnd | null): Box | null {
  const t = e && doc.nodes[e.node];
  if (!t || t.id === self.id || isConnector(t)) return null;
  // a group that contains the connector would grow with it
  for (let p = self.parent; doc.nodes[p]; p = doc.nodes[p].parent) if (p === t.id) return null;
  return worldBounds(doc, t.id);
}

function routed(doc: Doc, n: PathNode): PathNode {
  const c = n.connector!;
  const sp = n.subpaths[0];
  if (!sp || sp.pts.length < 2) return n;
  const W = worldMatrix(doc, n.id);
  const freeA = apply(W, sp.pts[0]), freeB = apply(W, sp.pts[sp.pts.length - 1]);
  const boxA = attachable(doc, n, c.from), boxB = attachable(doc, n, c.to);
  const from = boxA ? c.from : null, to = boxB ? c.to : null;
  const point = (p: Vec): Box => ({ x: p.x, y: p.y, w: 0, h: 0 });
  const resolve = (e: ConnectorEnd | null, box: Box | null, free: Vec, other: Box): End => {
    if (!e || !box) return { p: free, dir: null, box: null };
    if (e.side === 'auto' && c.kind === 'straight') return { p: borderPoint(box, { x: other.x + other.w / 2, y: other.y + other.h / 2 }), dir: null, box };
    const side = e.side === 'auto' ? facingSide(box, other) : e.side;
    return { p: sideAnchor(box, side), dir: DIR[side], box };
  };
  const A = resolve(from, boxA, freeA, boxB ?? point(freeB));
  const B = resolve(to, boxB, freeB, boxA ?? point(freeA));

  let pts: PathPoint[];
  if (c.kind === 'straight') pts = [corner(A.p.x, A.p.y), corner(B.p.x, B.p.y)];
  else if (c.kind === 'curved') {
    const h = Math.max(Math.hypot(B.p.x - A.p.x, B.p.y - A.p.y) * 0.5, 24);
    pts = [
      corner(A.p.x, A.p.y, null, A.dir && { x: A.dir.x * h, y: A.dir.y * h }),
      corner(B.p.x, B.p.y, B.dir && { x: B.dir.x * h, y: B.dir.y * h }, null),
    ];
  } else pts = roundedPolyline(elbowRoute(A.p, A.dir, A.box, B.p, B.dir, B.box), c.radius);

  const P = invert(worldMatrix(doc, n.parent));
  const next = normalizePath({ ...n, transform: [1, 0, 0, 1, 0, 0], subpaths: transformSubpaths([{ closed: false, pts }], P) });
  const connector = from === c.from && to === c.to ? c : { ...c, from, to };
  if (connector === c && sameGeometry(n, next)) return n;
  return { ...next, connector };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const nearV = (a: Vec | null, b: Vec | null) => (a && b ? near(a.x, b.x) && near(a.y, b.y) : a === b);
function sameGeometry(a: PathNode, b: PathNode): boolean {
  if (!a.transform.every((v, i) => near(v, b.transform[i])) || a.subpaths.length !== 1) return false;
  const p = a.subpaths[0].pts, q = b.subpaths[0].pts;
  return !a.subpaths[0].closed && p.length === q.length && p.every((u, i) => near(u.x, q[i].x) && near(u.y, q[i].y) && nearV(u.in, q[i].in) && nearV(u.out, q[i].out));
}

/** Re-route every connector whose surroundings changed. Returns the same doc when nothing moved. */
export function routeConnectors(doc: Doc): Doc {
  let out = doc;
  for (const id in doc.nodes) {
    const n = doc.nodes[id];
    if (!isConnector(n)) continue;
    // each connector is routed against the incoming document: connectors never attach to each other
    const r = routed(doc, n);
    if (r === n) continue;
    if (out === doc) out = { ...doc, nodes: { ...doc.nodes } };
    out.nodes[id] = r;
  }
  return out;
}

// ---------------------------------------------------------------- arrowheads

export type Head =
  | { type: 'polyline' | 'polygon'; pts: Vec[] }
  | { type: 'circle'; c: Vec; r: number };

/** direction in which the path leaves its first (start) or last point */
function endTangent(sp: SubPath, start: boolean): { p: PathPoint; t: Vec; chord: number } | null {
  const n = sp.pts.length;
  if (sp.closed || n < 2) return null;
  const p = sp.pts[start ? 0 : n - 1], q = sp.pts[start ? 1 : n - 2];
  const own = start ? p.out : p.in, theirs = start ? q.in : q.out;
  const ctrl = own ? { x: p.x + own.x, y: p.y + own.y } : theirs ? { x: q.x + theirs.x, y: q.y + theirs.y } : q;
  let dx = p.x - ctrl.x, dy = p.y - ctrl.y, l = Math.hypot(dx, dy);
  if (l < 1e-9) { dx = p.x - q.x; dy = p.y - q.y; l = Math.hypot(dx, dy); }
  if (l < 1e-9) return null;
  return { p, t: { x: dx / l, y: dy / l }, chord: Math.hypot(p.x - q.x, p.y - q.y) };
}

/** Arrowhead outlines for a path, plus the path shortened where a solid head covers its end
 *  (so the line does not poke through the tip). All in the node's local space. */
export function capLayout(n: PathNode): { subpaths: SubPath[]; heads: Head[] } {
  const heads: Head[] = [];
  const w = n.strokeWeight, len = w * 4 + 4, half = w * 2 + 2;
  const subpaths = n.subpaths.map(sp => {
    let pts = sp.pts;
    for (const start of [true, false]) {
      const cap: ArrowCap = (start ? n.startCap : n.endCap) ?? 'none';
      const e = cap !== 'none' ? endTangent({ closed: sp.closed, pts }, start) : null;
      if (!e) continue;
      const { p, t } = e, nx = -t.y, ny = t.x;
      const at = (along: number, across: number): Vec => ({ x: p.x - t.x * along + nx * across, y: p.y - t.y * along + ny * across });
      let trim = 0;
      if (cap === 'arrow') heads.push({ type: 'polyline', pts: [at(len, half), at(0, 0), at(len, -half)] });
      else if (cap === 'triangle') { heads.push({ type: 'polygon', pts: [at(0, 0), at(len, half), at(len, -half)] }); trim = len / 2; }
      else if (cap === 'diamond') { heads.push({ type: 'polygon', pts: [at(0, 0), at(len / 2, half * 0.8), at(len, 0), at(len / 2, -half * 0.8)] }); trim = len / 2; }
      else { const r = half * 0.8; heads.push({ type: 'circle', c: at(r, 0), r }); trim = r; }
      if (trim > 0 && e.chord > trim * 1.5) {
        const i = start ? 0 : pts.length - 1;
        pts = pts.slice();
        pts[i] = { ...p, x: p.x - t.x * trim, y: p.y - t.y * trim };
      }
    }
    return pts === sp.pts ? sp : { ...sp, pts };
  });
  return { subpaths, heads };
}
