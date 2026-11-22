import type { Effect, Mat, Node, Paint, ShapeNode } from '../../core/model.ts';
import { mul, round } from '../../core/geom.ts';
import { subpathsBounds, transformSubpaths } from '../../core/path.ts';

/** intermediate tree used while importing; flattened into doc nodes at the end */
export interface B {
  node: Node;
  /** children for groups, null for leaves */
  kids: B[] | null;
  /** the name came from the source (id / label / title), not from a default */
  named: boolean;
  anchor?: 'middle' | 'end';
  /** content is forced to white by an alpha->luminance filter (luminance == 1) */
  white?: boolean;
  /** content is replaced by white whose alpha is the content's luminance (luminance-to-alpha filter) */
  lumAlpha?: boolean;
}

const EPS = 1e-9;
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function scaleEffects(effects: Effect[], k: number): void {
  for (const e of effects) {
    if ('spread' in e) { e.x *= k; e.y *= k; e.blur *= k; e.spread *= k; }
    else if (e.type === 'layer-blur' || e.type === 'background-blur') e.blur *= k;
    else if (e.type === 'noise') e.size *= k;
    else { e.size *= k; e.radius *= k; }
  }
}

const paintsOf = (n: ShapeNode): Paint[] => [...n.fills, ...n.strokes];

/** bake a positive scale into the leaf's geometry. uniform => stroke etc. scale too */
function bakeScale(n: ShapeNode, kx: number, ky: number, uniform: boolean): void {
  if (n.type === 'path') n.subpaths = transformSubpaths(n.subpaths, [kx, 0, 0, ky, 0, 0]);
  else if (n.type === 'text') {
    n.size *= kx; n.letterSpacing *= kx;
    if (n.lineHeight != null) n.lineHeight *= kx;
    if (n.w != null) n.w *= kx;
  } else {
    n.w *= kx; n.h *= ky;
    if (n.type === 'rect') n.radii = n.radii.map(r => r * kx) as [number, number, number, number];
  }
  if (uniform) {
    if (n.strokes.length) n.strokeWeight *= kx;
    n.dash = n.dash.map(d => d * kx);
    scaleEffects(n.effects, kx);
    for (const p of paintsOf(n)) if (p.type === 'image' && p.scale != null) p.scale *= kx;
  }
}

function flipGradients(n: ShapeNode, fx: boolean, fy: boolean): void {
  for (const p of paintsOf(n)) {
    if (p.type !== 'gradient') continue;
    if (fx) { p.from = { x: 1 - p.from.x, y: p.from.y }; p.to = { x: 1 - p.to.x, y: p.to.y }; }
    if (fy) { p.from = { x: p.from.x, y: 1 - p.from.y }; p.to = { x: p.to.x, y: 1 - p.to.y }; }
  }
}

function normalizeLeaf(n: ShapeNode): void {
  let m = n.transform;
  const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
  const hasStroke = n.strokes.length > 0, hasEffects = n.effects.length > 0;
  const hasImage = paintsOf(n).some(p => p.type === 'image');
  const diagonal = Math.abs(m[1]) < EPS * sx && Math.abs(m[2]) < EPS * sy && sx > EPS && sy > EPS;
  const uniform = Math.abs(sx - sy) <= 1e-9 * Math.max(sx, sy);
  const orthogonal = Math.abs(m[0] * m[2] + m[1] * m[3]) <= 1e-9 * sx * sy;
  if (diagonal) {
    const roundRect = n.type === 'rect' && n.radii.some(r => r !== 0);
    const canScale = uniform || (!hasStroke && !hasEffects && n.type !== 'text' && !roundRect
      // gradients and fitted images are laid out in local pixel space: a non-uniform scale would change them
      && paintsOf(n).every(p => p.type === 'solid' || (p.type === 'image' && p.mode === 'stretch')));
    if (canScale && !(near(sx, 1) && near(sy, 1))) {
      bakeScale(n, sx, sy, uniform);
      m = [Math.sign(m[0]), 0, 0, Math.sign(m[3]), m[4], m[5]];
    }
    const fx = m[0] < 0, fy = m[3] < 0;
    if ((fx || fy) && near(Math.abs(m[0]), 1) && near(Math.abs(m[3]), 1) && n.type !== 'text' && !hasEffects && !hasImage) {
      if (n.type === 'path') {
        n.subpaths = transformSubpaths(n.subpaths, [m[0], 0, 0, m[3], 0, 0]);
        m = [1, 0, 0, 1, m[4], m[5]];
      } else {
        if (n.type === 'rect') {
          let [tl, tr, br, bl] = n.radii;
          if (fx) [tl, tr, br, bl] = [tr, tl, bl, br];
          if (fy) [tl, tr, br, bl] = [bl, br, tr, tl];
          n.radii = [tl, tr, br, bl];
        }
        m = [1, 0, 0, 1, m[4] - (fx ? n.w : 0), m[5] - (fy ? n.h : 0)];
      }
      flipGradients(n, fx, fy);
    }
  } else if (uniform && orthogonal && sx > EPS && !near(sx, 1)) {
    // rotation / reflection with a uniform scale: bake only the scale
    bakeScale(n, sx, sx, true);
    m = [m[0] / sx, m[1] / sx, m[2] / sx, m[3] / sx, m[4], m[5]];
  }
  if (n.type === 'path') {
    const b = subpathsBounds(n.subpaths);
    if (b && (Math.abs(b.x) > 1e-12 || Math.abs(b.y) > 1e-12)) {
      n.subpaths = transformSubpaths(n.subpaths, [1, 0, 0, 1, -b.x, -b.y]);
      m = mul(m, [1, 0, 0, 1, b.x, b.y]);
    }
    for (const sp of n.subpaths) {
      for (const p of sp.pts) {
        p.x = round(p.x, 4); p.y = round(p.y, 4);
        if (p.in) p.in = { x: round(p.in.x, 4), y: round(p.in.y, 4) };
        if (p.out) p.out = { x: round(p.out.x, 4), y: round(p.out.y, 4) };
      }
    }
  } else if (n.type !== 'text') {
    n.w = round(n.w, 4); n.h = round(n.h, 4);
  }
  n.transform = m;
}

/** Push scales down the tree and into leaf geometry so that node transforms are as close to
 *  plain translations as possible, and shift path geometry to start at its local (0,0). */
export function normalizeTree(b: B): void {
  const n = b.node;
  if (b.kids && n.type === 'group') {
    const m = n.transform;
    const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
    const diagonal = Math.abs(m[1]) < EPS * sx && Math.abs(m[2]) < EPS * sy && sx > EPS && sy > EPS;
    const uniform = Math.abs(sx - sy) <= 1e-9 * Math.max(sx, sy);
    const orthogonal = Math.abs(m[0] * m[2] + m[1] * m[3]) <= 1e-9 * sx * sy;
    let push: Mat | null = null;
    if (diagonal && !(near(m[0], 1) && near(m[3], 1))) {
      if (n.effects.length === 0) { push = [m[0], 0, 0, m[3], 0, 0]; n.transform = [1, 0, 0, 1, m[4], m[5]]; }
      else if (uniform && m[0] > 0 && m[3] > 0) {
        push = [sx, 0, 0, sx, 0, 0]; n.transform = [1, 0, 0, 1, m[4], m[5]]; scaleEffects(n.effects, sx);
      }
    } else if (!diagonal && uniform && orthogonal && sx > EPS && !near(sx, 1)) {
      push = [sx, 0, 0, sx, 0, 0];
      n.transform = [m[0] / sx, m[1] / sx, m[2] / sx, m[3] / sx, m[4], m[5]];
      scaleEffects(n.effects, sx);
    }
    for (const k of b.kids) {
      if (push) k.node.transform = mul(push, k.node.transform);
      normalizeTree(k);
    }
  } else if (n.type !== 'group') {
    normalizeLeaf(n);
  }
  n.transform = n.transform.map(v => round(v, 6)) as Mat;
  n.opacity = round(n.opacity, 4);
}
