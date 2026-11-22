// Geometry blobs of .fig files: path command lists and vector networks, plus the outline
// comparison used to decide whether an editable representation renders like Figma's own
// pre-computed `fillGeometry`.

import type { PathPoint, SubPath, Vec } from '../../core/model.ts';
import { PathBuilder, inferMode, segmentsOf, cubicAt } from '../../core/path.ts';

// ---------------------------------------------------------------- commandsBlob

/** [u8 cmd][f32 LE args]*: 0 close, 1 moveTo, 2 lineTo, 3 quadTo, 4 cubicTo. Returns null when
 *  the blob is malformed. */
export function parseCommandsBlob(blob: Uint8Array): SubPath[] | null {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const b = new PathBuilder();
  let o = 0;
  const f = (): number => { const v = dv.getFloat32(o, true); o += 4; return v; };
  const need = [0, 2, 2, 4, 6];
  while (o < blob.length) {
    const cmd = blob[o++];
    if (cmd > 4 || o + need[cmd] * 4 > blob.length) return null;
    switch (cmd) {
      case 0: b.close(); break;
      case 1: b.moveTo(f(), f()); break;
      case 2: b.lineTo(f(), f()); break;
      case 3: b.quadTo(f(), f(), f(), f()); break;
      case 4: b.cubicTo(f(), f(), f(), f(), f(), f()); break;
    }
  }
  const sps = b.done();
  for (const sp of sps) for (const p of sp.pts) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return sps;
}

// ---------------------------------------------------------------- vector networks

export interface NetVertex { x: number; y: number; styleID: number }
export interface NetSegment { styleID: number; a: number; ta: Vec; b: number; tb: Vec }
export interface NetRegion { styleID: number; evenOdd: boolean; loops: number[][] }
export interface VectorNetwork { vertices: NetVertex[]; segments: NetSegment[]; regions: NetRegion[] }

/** Layout (all little endian):
 *    u32 vertexCount, u32 segmentCount, u32 regionCount
 *    vertex  = u32 styleID, f32 x, f32 y                                           (12 bytes)
 *    segment = u32 styleID, u32 start, f32 tsx, f32 tsy, u32 end, f32 tex, f32 tey (28 bytes)
 *    region  = u32 (styleID << 1 | evenOdd), u32 loopCount, loop = u32 n + n * u32 segment
 *  Coordinates are in `vectorData.normalizedSize` space; `sx`/`sy` scale them to the node size. */
export function parseVectorNetwork(blob: Uint8Array, sx = 1, sy = 1): VectorNetwork | null {
  if (blob.length < 12) return null;
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const nv = dv.getUint32(0, true), ns = dv.getUint32(4, true), nr = dv.getUint32(8, true);
  let o = 12;
  if (o + nv * 12 + ns * 28 > blob.length) return null;
  const vertices: NetVertex[] = [];
  for (let i = 0; i < nv; i++, o += 12) {
    vertices.push({ styleID: dv.getUint32(o, true), x: dv.getFloat32(o + 4, true) * sx, y: dv.getFloat32(o + 8, true) * sy });
  }
  const segments: NetSegment[] = [];
  for (let i = 0; i < ns; i++, o += 28) {
    const a = dv.getUint32(o + 4, true), b = dv.getUint32(o + 16, true);
    if (a >= nv || b >= nv) return null;
    segments.push({
      styleID: dv.getUint32(o, true),
      a, ta: { x: dv.getFloat32(o + 8, true) * sx, y: dv.getFloat32(o + 12, true) * sy },
      b, tb: { x: dv.getFloat32(o + 20, true) * sx, y: dv.getFloat32(o + 24, true) * sy },
    });
  }
  const regions: NetRegion[] = [];
  for (let i = 0; i < nr; i++) {
    if (o + 8 > blob.length) return null;
    const head = dv.getUint32(o, true), nl = dv.getUint32(o + 4, true);
    o += 8;
    const loops: number[][] = [];
    for (let l = 0; l < nl; l++) {
      if (o + 4 > blob.length) return null;
      const n = dv.getUint32(o, true);
      o += 4;
      if (o + n * 4 > blob.length) return null;
      const loop: number[] = [];
      for (let k = 0; k < n; k++, o += 4) loop.push(dv.getUint32(o, true));
      loops.push(loop);
    }
    regions.push({ styleID: head >>> 1, evenOdd: (head & 1) === 1, loops });
  }
  for (const v of vertices) if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
  for (const s of segments) if (![s.ta.x, s.ta.y, s.tb.x, s.tb.y].every(Number.isFinite)) return null;
  return { vertices, segments, regions };
}

export interface NetworkChains {
  subpaths: SubPath[];
  /** some vertex joins more than two segments: the chains are split there */
  branching: boolean;
  /** vertex indices that end an open chain */
  endVertices: number[];
}

const nzv = (v: Vec): Vec | null => (Math.abs(v.x) > 1e-6 || Math.abs(v.y) > 1e-6 ? { x: v.x, y: v.y } : null);

/** Chain segments that share vertices into open / closed subpaths. */
export function networkToSubpaths(net: VectorNetwork): NetworkChains {
  const { vertices, segments } = net;
  const adj: number[][] = vertices.map(() => []);
  segments.forEach((s, i) => { adj[s.a].push(i); adj[s.b].push(i); });
  // a self-loop is listed twice on its vertex, which gives the right degree of 2
  const branching = adj.some(a => a.length > 2);
  const used = new Array<boolean>(segments.length).fill(false);
  const subpaths: SubPath[] = [];
  const endVertices: number[] = [];

  const walk = (startV: number, firstSeg: number): void => {
    const pts: PathPoint[] = [];
    const mk = (vi: number): PathPoint => ({ x: vertices[vi].x, y: vertices[vi].y, in: null, out: null, mode: 'corner' });
    let v = startV, si = firstSeg, closed = false;
    pts.push(mk(v));
    for (;;) {
      used[si] = true;
      const s = segments[si];
      const fwd = s.a === v;
      const next = fwd ? s.b : s.a;
      pts[pts.length - 1].out = nzv(fwd ? s.ta : s.tb);
      const tin = nzv(fwd ? s.tb : s.ta);
      if (next === startV && adj[next].length === 2) {
        pts[0].in = tin;
        closed = true;
        break;
      }
      const p = mk(next);
      p.in = tin;
      pts.push(p);
      v = next;
      if (adj[v].length !== 2) break;
      const n = adj[v].find(k => !used[k]);
      if (n === undefined) break;
      si = n;
    }
    if (!closed) endVertices.push(startV, v);
    for (const p of pts) p.mode = inferMode(p);
    subpaths.push({ closed, pts });
  };

  // open chains first: start at every vertex that is not a plain pass-through
  for (let v = 0; v < vertices.length; v++) {
    if (adj[v].length === 2) continue;
    for (const si of adj[v]) if (!used[si]) walk(v, si);
  }
  // what remains are closed loops of degree-2 vertices
  for (let si = 0; si < segments.length; si++) if (!used[si]) walk(segments[si].a, si);
  return { subpaths, branching, endVertices };
}

// ---------------------------------------------------------------- outline comparison

/** flatten to a polyline; `close` adds the implicit closing edge (how fills treat open subpaths) */
export function flatten(sp: SubPath, close: boolean, steps = 24): Vec[] {
  const out: Vec[] = [];
  if (!sp.pts.length) return out;
  out.push({ x: sp.pts[0].x, y: sp.pts[0].y });
  for (const s of segmentsOf(sp)) {
    if (s.straight) out.push({ x: s.p1.x, y: s.p1.y });
    else for (let i = 1; i <= steps; i++) out.push(cubicAt(s, i / steps));
  }
  if (close && !sp.closed && sp.pts.length > 1) out.push({ x: sp.pts[0].x, y: sp.pts[0].y });
  return out;
}

export function signedArea(poly: Vec[]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function distToPoly(p: Vec, poly: Vec[]): number {
  let best = Infinity;
  if (poly.length === 1) return Math.hypot(p.x - poly[0].x, p.y - poly[0].y);
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const d = (p.x - a.x - dx * t) ** 2 + (p.y - a.y - dy * t) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** max distance from the points of `a` to the polyline `b` (one-sided Hausdorff, sampled) */
function oneSided(a: Vec[], b: Vec[], stopAt: number): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const d = distToPoly(p, b);
    if (d > worst) { worst = d; if (worst > stopAt) return worst; }
    // also test edge midpoints so long straight edges are covered
    if (i + 1 < a.length) {
      const q = a[i + 1];
      const dm = distToPoly({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, b);
      if (dm > worst) { worst = dm; if (worst > stopAt) return worst; }
    }
  }
  return worst;
}

export function outlineDistance(a: Vec[], b: Vec[], stopAt = Infinity): number {
  if (!a.length || !b.length) return Infinity;
  const d = oneSided(a, b, stopAt);
  return d > stopAt ? d : Math.max(d, oneSided(b, a, stopAt));
}

export interface FillMatch {
  /** worst outline deviation over all matched subpaths */
  deviation: number;
  /** candidate subpaths, re-oriented so every loop winds like its counterpart in `truth` */
  subpaths: SubPath[];
}

export function reverseSubpath(sp: SubPath): SubPath {
  const pts = sp.pts.map(p => ({ x: p.x, y: p.y, in: p.out, out: p.in, mode: p.mode })).reverse();
  // keep the same start point for closed paths (nicer for editing; irrelevant for rendering)
  if (sp.closed && pts.length > 1) pts.unshift(pts.pop()!);
  return { closed: sp.closed, pts };
}

/** Does filling `candidate` produce the same picture as filling `truth` (Figma's fillGeometry)?
 *  Every area-enclosing candidate subpath must coincide with exactly one truth subpath and vice
 *  versa. Returns null when they differ by more than `tol`. */
export function matchFill(candidate: SubPath[], truth: SubPath[], tol: number): FillMatch | null {
  const minArea = tol * tol;
  const cand = candidate.map(sp => { const poly = flatten(sp, true); return { sp, poly, area: signedArea(poly) }; });
  const tru = truth.map(sp => { const poly = flatten(sp, true); return { poly, area: signedArea(poly) }; })
    .filter(t => Math.abs(t.area) > minArea);
  const filled = cand.filter(c => Math.abs(c.area) > minArea);
  if (filled.length !== tru.length) return null;
  const taken = new Set<number>();
  const flip = new Set<SubPath>();
  let deviation = 0;
  for (const c of filled) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < tru.length; i++) {
      if (taken.has(i)) continue;
      // cheap reject: areas must agree before the expensive outline test
      const ra = Math.abs(c.area), rb = Math.abs(tru[i].area);
      if (Math.abs(ra - rb) > 0.05 * Math.max(ra, rb) + 4 * tol * tol) continue;
      const d = outlineDistance(c.poly, tru[i].poly, Math.min(bd, tol));
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0 || bd > tol) return null;
    taken.add(best);
    if (bd > deviation) deviation = bd;
    if (Math.sign(c.area) !== Math.sign(tru[best].area)) flip.add(c.sp);
  }
  return { deviation, subpaths: candidate.map(sp => (flip.has(sp) ? reverseSubpath(sp) : sp)) };
}
