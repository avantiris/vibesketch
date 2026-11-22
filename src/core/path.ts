import type { Box, Mat, Node, PathPoint, SubPath, Vec } from './model.ts';
import { apply, applyLin, lerp, round } from './geom.ts';

// ---------------------------------------------------------------- building

const EPS = 1e-6;
const nz = (v: Vec | null): Vec | null => (v && (Math.abs(v.x) > EPS || Math.abs(v.y) > EPS) ? v : null);

export function inferMode(p: PathPoint): PathPoint['mode'] {
  if (!p.in || !p.out) return 'corner';
  const li = Math.hypot(p.in.x, p.in.y), lo = Math.hypot(p.out.x, p.out.y);
  if (li < EPS || lo < EPS) return 'corner';
  const cross = (p.in.x * p.out.y - p.in.y * p.out.x) / (li * lo);
  const dotp = (p.in.x * p.out.x + p.in.y * p.out.y) / (li * lo);
  if (Math.abs(cross) > 0.01 || dotp > 0) return 'corner';
  return Math.abs(li - lo) < 0.01 * Math.max(li, lo) ? 'mirror' : 'smooth';
}

/** Incrementally builds SubPath[] from absolute drawing commands. */
export class PathBuilder {
  subpaths: SubPath[] = [];
  private cur: SubPath | null = null;
  private start: Vec = { x: 0, y: 0 };
  pos: Vec = { x: 0, y: 0 };

  moveTo(x: number, y: number): this {
    this.finish();
    this.cur = { closed: false, pts: [{ x, y, in: null, out: null, mode: 'corner' }] };
    this.start = { x, y };
    this.pos = { x, y };
    return this;
  }
  private ensure(): SubPath {
    if (!this.cur) this.moveTo(this.pos.x, this.pos.y);
    return this.cur!;
  }
  lineTo(x: number, y: number): this {
    const sp = this.ensure();
    sp.pts.push({ x, y, in: null, out: null, mode: 'corner' });
    this.pos = { x, y };
    return this;
  }
  cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    const sp = this.ensure();
    const prev = sp.pts[sp.pts.length - 1];
    prev.out = nz({ x: x1 - prev.x, y: y1 - prev.y });
    sp.pts.push({ x, y, in: nz({ x: x2 - x, y: y2 - y }), out: null, mode: 'corner' });
    this.pos = { x, y };
    return this;
  }
  quadTo(x1: number, y1: number, x: number, y: number): this {
    const p = this.pos;
    return this.cubicTo(p.x + (2 / 3) * (x1 - p.x), p.y + (2 / 3) * (y1 - p.y), x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y), x, y);
  }
  /** SVG elliptical arc (endpoint parameterization) */
  arcTo(rx: number, ry: number, xRotDeg: number, large: boolean, sweep: boolean, x: number, y: number): this {
    const p0 = this.pos;
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (rx < EPS || ry < EPS) return this.lineTo(x, y);
    if (Math.abs(p0.x - x) < EPS && Math.abs(p0.y - y) < EPS) return this;
    const phi = (xRotDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    const dx = (p0.x - x) / 2, dy = (p0.y - y) / 2;
    const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let k = Math.sqrt(Math.max(0, num / den));
    if (large === sweep) k = -k;
    const cxp = (k * rx * y1p) / ry, cyp = (-k * ry * x1p) / rx;
    const cx = cp * cxp - sp * cyp + (p0.x + x) / 2, cy = sp * cxp + cp * cyp + (p0.y + y) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => {
      const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      return a;
    };
    const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dth > 0) dth -= 2 * Math.PI;
    else if (sweep && dth < 0) dth += 2 * Math.PI;
    const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
    const step = dth / n, t = (4 / 3) * Math.tan(step / 4);
    const pt = (th: number): Vec => ({
      x: cx + rx * Math.cos(th) * cp - ry * Math.sin(th) * sp,
      y: cy + rx * Math.cos(th) * sp + ry * Math.sin(th) * cp,
    });
    const dv = (th: number): Vec => ({
      x: -rx * Math.sin(th) * cp - ry * Math.cos(th) * sp,
      y: -rx * Math.sin(th) * sp + ry * Math.cos(th) * cp,
    });
    for (let i = 0; i < n; i++) {
      const a = th1 + i * step, b = a + step;
      const pa = pt(a), pb = i === n - 1 ? { x, y } : pt(b), da = dv(a), db = dv(b);
      this.cubicTo(pa.x + t * da.x, pa.y + t * da.y, pb.x - t * db.x, pb.y - t * db.y, pb.x, pb.y);
    }
    return this;
  }
  close(): this {
    const sp = this.cur;
    if (sp && sp.pts.length) {
      const first = sp.pts[0], last = sp.pts[sp.pts.length - 1];
      if (sp.pts.length > 1 && Math.abs(first.x - last.x) < 1e-4 && Math.abs(first.y - last.y) < 1e-4) {
        first.in = last.in;
        sp.pts.pop();
      }
      sp.closed = true;
      this.pos = { ...this.start };
      this.finish();
    }
    return this;
  }
  private finish() {
    const sp = this.cur;
    this.cur = null;
    if (!sp) return;
    // a lone moveTo draws nothing
    if (sp.pts.length < 2 && !sp.closed) return;
    for (const p of sp.pts) p.mode = inferMode(p);
    this.subpaths.push(sp);
  }
  done(): SubPath[] {
    this.finish();
    return this.subpaths;
  }
}

/** Parse SVG path data into subpaths (all commands, relative + absolute). Malformed input
 *  yields whatever was parsed up to the error, as SVG requires. */
export function parsePathData(d: string): SubPath[] {
  const b = new PathBuilder();
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  const toks: (string | number)[] = [];
  for (let m; (m = re.exec(d)); ) toks.push(m[1] ?? parseFloat(m[2]));
  let i = 0, cmd = '', lastC: Vec | null = null, lastQ: Vec | null = null;
  // arc flags may be written without separators ("a1 1 0 01 2 2"); re-tokenize those lazily
  const num = (): number => {
    const t = toks[i];
    if (typeof t !== 'number') throw new Error('bad path');
    i++;
    return t;
  };
  const flag = (): boolean => {
    const t = toks[i];
    if (typeof t !== 'number') throw new Error('bad path');
    if (t === 0 || t === 1) { i++; return t === 1; }
    // glued flags like "01" or "110.5": split off the first digit
    const s = String(t);
    const f = s[0];
    if (f !== '0' && f !== '1') throw new Error('bad flag');
    const rest = s.slice(1);
    toks[i] = parseFloat(rest);
    if (Number.isNaN(toks[i] as number)) throw new Error('bad flag');
    return f === '1';
  };
  try {
    while (i < toks.length) {
      const t = toks[i];
      if (typeof t === 'string') { cmd = t; i++; } else if (!cmd) break;
      else if (cmd === 'M') cmd = 'L';
      else if (cmd === 'm') cmd = 'l';
      else if (cmd === 'Z' || cmd === 'z') break;
      const rel = cmd === cmd.toLowerCase();
      const ox = rel ? b.pos.x : 0, oy = rel ? b.pos.y : 0;
      let keepC = false, keepQ = false;
      switch (cmd.toUpperCase()) {
        case 'M': { const x = num() + ox, y = num() + oy; b.moveTo(x, y); break; }
        case 'L': { const x = num() + ox, y = num() + oy; b.lineTo(x, y); break; }
        case 'H': b.lineTo(num() + ox, b.pos.y); break;
        case 'V': b.lineTo(b.pos.x, num() + oy); break;
        case 'C': {
          const x1 = num() + ox, y1 = num() + oy, x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy;
          b.cubicTo(x1, y1, x2, y2, x, y); lastC = { x: x2, y: y2 }; keepC = true; break;
        }
        case 'S': {
          const x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy;
          const x1: number = lastC ? 2 * b.pos.x - lastC.x : b.pos.x, y1: number = lastC ? 2 * b.pos.y - lastC.y : b.pos.y;
          b.cubicTo(x1, y1, x2, y2, x, y); lastC = { x: x2, y: y2 }; keepC = true; break;
        }
        case 'Q': {
          const x1 = num() + ox, y1 = num() + oy, x = num() + ox, y = num() + oy;
          b.quadTo(x1, y1, x, y); lastQ = { x: x1, y: y1 }; keepQ = true; break;
        }
        case 'T': {
          const x = num() + ox, y = num() + oy;
          const x1: number = lastQ ? 2 * b.pos.x - lastQ.x : b.pos.x, y1: number = lastQ ? 2 * b.pos.y - lastQ.y : b.pos.y;
          b.quadTo(x1, y1, x, y); lastQ = { x: x1, y: y1 }; keepQ = true; break;
        }
        case 'A': {
          const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag(), x = num() + ox, y = num() + oy;
          b.arcTo(rx, ry, rot, large, sweep, x, y); break;
        }
        case 'Z': b.close(); break;
      }
      if (!keepC) lastC = null;
      if (!keepQ) lastQ = null;
    }
  } catch { /* keep what we have */ }
  return b.done();
}

// ---------------------------------------------------------------- primitives -> subpaths

const KAPPA = 0.5522847498307936;

export function rectSubpaths(w: number, h: number, radii: [number, number, number, number]): SubPath[] {
  // clamp radii like CSS: scale down uniformly when adjacent radii overflow a side
  let [tl, tr, br, bl] = radii.map(r => Math.max(0, r));
  const f = Math.min(1, w / (tl + tr || 1), w / (bl + br || 1), h / (tl + bl || 1), h / (tr + br || 1));
  if (f < 1) { tl *= f; tr *= f; br *= f; bl *= f; }
  const b = new PathBuilder();
  b.moveTo(tl, 0);
  b.lineTo(w - tr, 0);
  if (tr > 0) b.cubicTo(w - tr + tr * KAPPA, 0, w, tr - tr * KAPPA, w, tr);
  b.lineTo(w, h - br);
  if (br > 0) b.cubicTo(w, h - br + br * KAPPA, w - br + br * KAPPA, h, w - br, h);
  b.lineTo(bl, h);
  if (bl > 0) b.cubicTo(bl - bl * KAPPA, h, 0, h - bl + bl * KAPPA, 0, h - bl);
  b.lineTo(0, tl);
  if (tl > 0) b.cubicTo(0, tl - tl * KAPPA, tl - tl * KAPPA, 0, tl, 0);
  b.close();
  const sps = b.done();
  // drop zero-length duplicate points produced when a radius is 0
  for (const sp of sps) sp.pts = dedupe(sp.pts, sp.closed);
  return sps;
}

function dedupe(pts: PathPoint[], closed: boolean): PathPoint[] {
  const out: PathPoint[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.x - p.x) < EPS && Math.abs(q.y - p.y) < EPS && !q.out && !p.in) { q.out = p.out; continue; }
    out.push(p);
  }
  if (closed && out.length > 1) {
    const a = out[0], z = out[out.length - 1];
    if (Math.abs(a.x - z.x) < EPS && Math.abs(a.y - z.y) < EPS && !z.out && !a.in) { a.in = z.in; out.pop(); }
  }
  return out;
}

export function ellipseSubpaths(w: number, h: number): SubPath[] {
  const rx = w / 2, ry = h / 2, kx = rx * KAPPA, ky = ry * KAPPA;
  const P = (x: number, y: number, ix: number, iy: number): PathPoint => ({ x, y, in: { x: ix, y: iy }, out: { x: -ix, y: -iy }, mode: 'mirror' });
  return [{ closed: true, pts: [P(rx, 0, -kx, 0), P(w, ry, 0, -ky), P(rx, h, kx, 0), P(0, ry, 0, ky)] }];
}

export function polygonSubpaths(w: number, h: number, sides: number): SubPath[] {
  const n = Math.max(3, Math.round(sides));
  const pts: PathPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pts.push({ x: w / 2 + (w / 2) * Math.cos(a), y: h / 2 + (h / 2) * Math.sin(a), in: null, out: null, mode: 'corner' });
  }
  return [{ closed: true, pts }];
}

export function starSubpaths(w: number, h: number, points: number, inner: number): SubPath[] {
  const n = Math.max(3, Math.round(points));
  const pts: PathPoint[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n, r = i % 2 ? inner : 1;
    pts.push({ x: w / 2 + (w / 2) * r * Math.cos(a), y: h / 2 + (h / 2) * r * Math.sin(a), in: null, out: null, mode: 'corner' });
  }
  return [{ closed: true, pts }];
}

/** Outline geometry of any non-text, non-group node in its local space. */
export function nodeSubpaths(n: Node): SubPath[] {
  switch (n.type) {
    case 'rect': return rectSubpaths(n.w, n.h, n.radii);
    case 'ellipse': return ellipseSubpaths(n.w, n.h);
    case 'polygon': return polygonSubpaths(n.w, n.h, n.sides);
    case 'star': return starSubpaths(n.w, n.h, n.points, n.inner);
    case 'path': return n.subpaths;
    default: return [];
  }
}

// ---------------------------------------------------------------- serialization

export function subpathsToD(sps: SubPath[], digits = 3): string {
  const r = (v: number) => String(round(v, digits));
  const parts: string[] = [];
  for (const sp of sps) {
    const pts = sp.pts;
    if (!pts.length) continue;
    parts.push(`M${r(pts[0].x)} ${r(pts[0].y)}`);
    const n = pts.length, count = sp.closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const isLast = i === n - 1; // closing segment
      if (!a.out && !b.in) {
        if (isLast) continue; // Z draws the straight closing line
        if (Math.abs(a.y - b.y) < 0.5 * 10 ** -digits) parts.push(`H${r(b.x)}`);
        else if (Math.abs(a.x - b.x) < 0.5 * 10 ** -digits) parts.push(`V${r(b.y)}`);
        else parts.push(`L${r(b.x)} ${r(b.y)}`);
      } else {
        const c1 = a.out ? { x: a.x + a.out.x, y: a.y + a.out.y } : a;
        const c2 = b.in ? { x: b.x + b.in.x, y: b.y + b.in.y } : b;
        parts.push(`C${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(b.x)} ${r(b.y)}`);
      }
    }
    if (sp.closed) parts.push('Z');
  }
  return parts.join('');
}

// ---------------------------------------------------------------- segments & beziers

export interface Seg { p0: Vec; c1: Vec; c2: Vec; p1: Vec; /** indices of the end points in sp.pts */ i0: number; i1: number; straight: boolean }

export function segmentsOf(sp: SubPath): Seg[] {
  const out: Seg[] = [];
  const n = sp.pts.length, count = sp.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = sp.pts[i], b = sp.pts[(i + 1) % n];
    if (n === 1) break;
    out.push({
      p0: a, p1: b,
      c1: a.out ? { x: a.x + a.out.x, y: a.y + a.out.y } : { x: a.x, y: a.y },
      c2: b.in ? { x: b.x + b.in.x, y: b.y + b.in.y } : { x: b.x, y: b.y },
      i0: i, i1: (i + 1) % n, straight: !a.out && !b.in,
    });
  }
  return out;
}

export function cubicAt(s: { p0: Vec; c1: Vec; c2: Vec; p1: Vec }, t: number): Vec {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * s.p0.x + b * s.c1.x + c * s.c2.x + d * s.p1.x, y: a * s.p0.y + b * s.c1.y + c * s.c2.y + d * s.p1.y };
}

function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  // derivative roots of the cubic bezier coordinate function
  const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) { const s = Math.sqrt(disc); ts.push((-b + s) / (2 * a), (-b - s) / (2 * a)); }
  }
  return ts.filter(t => t > 0 && t < 1);
}

/** Exact bounds of the geometry, optionally after transforming by `m`. null when empty. */
export function subpathsBounds(sps: SubPath[], m?: Mat): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const acc = (p: Vec) => {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  };
  const T = (p: Vec) => (m ? apply(m, p) : p);
  for (const sp of sps) {
    if (sp.pts.length === 1) acc(T(sp.pts[0]));
    for (const s of segmentsOf(sp)) {
      const q = { p0: T(s.p0), c1: T(s.c1), c2: T(s.c2), p1: T(s.p1) };
      acc(q.p0); acc(q.p1);
      if (s.straight) continue;
      for (const t of cubicExtrema(q.p0.x, q.c1.x, q.c2.x, q.p1.x)) acc(cubicAt(q, t));
      for (const t of cubicExtrema(q.p0.y, q.c1.y, q.c2.y, q.p1.y)) acc(cubicAt(q, t));
    }
  }
  if (x0 === Infinity) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** closest point on a segment: returns parameter t and the distance */
export function nearestOnSeg(s: Seg, p: Vec): { t: number; d: number; pt: Vec } {
  if (s.straight) {
    const dx = s.p1.x - s.p0.x, dy = s.p1.y - s.p0.y, l2 = dx * dx + dy * dy;
    const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - s.p0.x) * dx + (p.y - s.p0.y) * dy) / l2));
    const pt = { x: s.p0.x + dx * t, y: s.p0.y + dy * t };
    return { t, d: Math.hypot(pt.x - p.x, pt.y - p.y), pt };
  }
  let best = 0, bd = Infinity;
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const q = cubicAt(s, i / N), d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bd) { bd = d; best = i / N; }
  }
  let step = 1 / N;
  for (let k = 0; k < 20; k++) {
    step /= 2;
    for (const t of [best - step, best + step]) {
      if (t < 0 || t > 1) continue;
      const q = cubicAt(s, t), d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
  }
  const pt = cubicAt(s, best);
  return { t: best, d: Math.sqrt(bd), pt };
}

/** Insert a point on segment `segIndex` of the subpath at parameter t, preserving the shape.
 *  Returns a new subpath and the index of the inserted point. */
export function splitSubpath(sp: SubPath, segIndex: number, t: number): { sp: SubPath; index: number } {
  const n = sp.pts.length;
  const i0 = segIndex, i1 = (segIndex + 1) % n;
  const a = sp.pts[i0], b = sp.pts[i1];
  const pts = sp.pts.map(p => ({ ...p }));
  let mid: PathPoint;
  if (!a.out && !b.in) {
    mid = { ...lerp(a, b, t), in: null, out: null, mode: 'corner' };
  } else {
    const p0 = { x: a.x, y: a.y }, p3 = { x: b.x, y: b.y };
    const p1 = a.out ? { x: a.x + a.out.x, y: a.y + a.out.y } : p0;
    const p2 = b.in ? { x: b.x + b.in.x, y: b.y + b.in.y } : p3;
    const q0 = lerp(p0, p1, t), q1 = lerp(p1, p2, t), q2 = lerp(p2, p3, t);
    const r0 = lerp(q0, q1, t), r1 = lerp(q1, q2, t), s = lerp(r0, r1, t);
    pts[i0] = { ...pts[i0], out: { x: q0.x - a.x, y: q0.y - a.y } };
    pts[i1] = { ...pts[i1], in: { x: q2.x - b.x, y: q2.y - b.y } };
    // splitting breaks mirror symmetry of the neighbours' handle lengths
    if (pts[i0].mode === 'mirror') pts[i0].mode = 'smooth';
    if (pts[i1].mode === 'mirror') pts[i1].mode = 'smooth';
    mid = { x: s.x, y: s.y, in: { x: r0.x - s.x, y: r0.y - s.y }, out: { x: r1.x - s.x, y: r1.y - s.y }, mode: 'smooth' };
  }
  pts.splice(i0 + 1, 0, mid);
  return { sp: { closed: sp.closed, pts }, index: i0 + 1 };
}

/** Bend a segment so that the curve point at parameter t moves by `delta` (the classic
 *  "drag the curve" interaction). Returns new handle offsets for the two end points. */
export function bendSegment(s: Seg, t: number, delta: Vec): { out0: Vec; in1: Vec } {
  t = Math.max(0.05, Math.min(0.95, t));
  // weighting from Inkscape: near the ends mostly the adjacent handle moves
  let w: number;
  if (t <= 1 / 6) w = 0;
  else if (t <= 0.5) w = Math.pow((6 * t - 1) / 2, 3) / 2;
  else if (t <= 5 / 6) w = (1 - Math.pow((6 * (1 - t) - 1) / 2, 3)) / 2 + 0.5;
  else w = 1;
  const k0 = (1 - w) / (3 * t * (1 - t) * (1 - t)), k1 = w / (3 * t * t * (1 - t));
  return {
    out0: { x: s.c1.x - s.p0.x + delta.x * k0, y: s.c1.y - s.p0.y + delta.y * k0 },
    in1: { x: s.c2.x - s.p1.x + delta.x * k1, y: s.c2.y - s.p1.y + delta.y * k1 },
  };
}

// ---------------------------------------------------------------- transforms

export function transformSubpaths(sps: SubPath[], m: Mat): SubPath[] {
  return sps.map(sp => ({
    closed: sp.closed,
    pts: sp.pts.map(p => {
      const q = apply(m, p);
      return { x: q.x, y: q.y, in: p.in ? applyLin(m, p.in) : null, out: p.out ? applyLin(m, p.out) : null, mode: p.mode };
    }),
  }));
}

export function cloneSubpaths(sps: SubPath[]): SubPath[] {
  return sps.map(sp => ({ closed: sp.closed, pts: sp.pts.map(p => ({ ...p, in: p.in && { ...p.in }, out: p.out && { ...p.out } })) }));
}
