import type { Box, Mat, Vec } from './model.ts';

// ---------------------------------------------------------------- matrices
// Mat = [a b c d e f]:  x' = a*x + c*y + e,  y' = b*x + d*y + f

export const ident = (): Mat => [1, 0, 0, 1, 0, 0];

/** m * n : apply n first, then m */
export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 1, -m[4], -m[5]];
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export const apply = (m: Mat, p: Vec): Vec => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
/** apply only the linear part (for directions / offsets) */
export const applyLin = (m: Mat, p: Vec): Vec => ({ x: m[0] * p.x + m[2] * p.y, y: m[1] * p.x + m[3] * p.y });

export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy = sx): Mat => [sx, 0, 0, sy, 0, 0];
export function rotate(rad: number): Mat {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}
/** transform `m` applied around the pivot point p */
export const around = (m: Mat, p: Vec): Mat => mul(translate(p.x, p.y), mul(m, translate(-p.x, -p.y)));

/** rotation of the x axis, radians */
export const rotationOf = (m: Mat): number => Math.atan2(m[1], m[0]);
export const scaleXOf = (m: Mat): number => Math.hypot(m[0], m[1]);
export const scaleYOf = (m: Mat): number => Math.hypot(m[2], m[3]);
export const detOf = (m: Mat): number => m[0] * m[3] - m[1] * m[2];

export function matEq(m: Mat, n: Mat, eps = 1e-9): boolean {
  for (let i = 0; i < 6; i++) if (Math.abs(m[i] - n[i]) > eps) return false;
  return true;
}
export const isIdentity = (m: Mat): boolean => matEq(m, [1, 0, 0, 1, 0, 0]);

// ---------------------------------------------------------------- vectors

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mulS = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export function norm(a: Vec): Vec {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

// ---------------------------------------------------------------- boxes

export const EMPTY_BOX: Box = { x: 0, y: 0, w: 0, h: 0 };

export function boxFromPoints(pts: Vec[]): Box | null {
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function union(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export const boxCorners = (b: Box): [Vec, Vec, Vec, Vec] => [
  { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
];

/** axis-aligned bounds of a box after transformation */
export function transformBox(m: Mat, b: Box): Box {
  return boxFromPoints(boxCorners(b).map(p => apply(m, p)))!;
}

export const boxesIntersect = (a: Box, b: Box): boolean =>
  a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

export const boxContains = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

export const pointInBox = (p: Vec, b: Box, pad = 0): boolean =>
  p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;

export const boxCenter = (b: Box): Vec => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export function expandBox(b: Box, d: number): Box {
  return { x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d };
}

export function normBox(a: Vec, b: Vec): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** round to n decimals, killing -0 and float noise; used when serializing */
export function round(v: number, n = 3): number {
  const k = 10 ** n;
  const r = Math.round(v * k) / k;
  return r === 0 ? 0 : r;
}
