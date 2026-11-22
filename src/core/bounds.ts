import type { Box, Doc, Mat, Node } from './model.ts';
import { ident, mul, transformBox, union } from './geom.ts';
import { nodeSubpaths, subpathsBounds } from './path.ts';
import { layoutText, textLayoutVersion } from './text.ts';

// Bounds + world matrices, cached per Doc identity (docs are immutable snapshots).

interface Cache { world: Map<string, Mat>; local: Map<string, Box>; textVersion: number }
const caches = new WeakMap<Doc, Cache>();
function cacheOf(doc: Doc): Cache {
  let c = caches.get(doc);
  if (!c || c.textVersion !== textLayoutVersion()) {
    c = { world: new Map(), local: new Map(), textVersion: textLayoutVersion() };
    caches.set(doc, c);
  }
  return c;
}

/** local -> page space matrix of a node (identity for pages / unknown ids) */
export function worldMatrix(doc: Doc, id: string): Mat {
  const n = doc.nodes[id];
  if (!n) return ident();
  const c = cacheOf(doc);
  let m = c.world.get(id);
  if (!m) {
    m = mul(worldMatrix(doc, n.parent), n.transform);
    c.world.set(id, m);
  }
  return m;
}

/** Tight bounds of the node's fill geometry after applying `m` (node-local -> target space).
 *  Strokes and effects are not included. null for empty groups. */
export function boundsIn(doc: Doc, n: Node, m: Mat): Box | null {
  switch (n.type) {
    case 'group': {
      let b: Box | null = null;
      for (const cid of n.children) {
        const c = doc.nodes[cid];
        if (c) b = union(b, boundsIn(doc, c, mul(m, c.transform)));
      }
      return b;
    }
    case 'rect': return transformBox(m, { x: 0, y: 0, w: n.w, h: n.h });
    case 'text': { const l = layoutText(n); return transformBox(m, { x: 0, y: 0, w: l.w, h: l.h }); }
    default: return subpathsBounds(nodeSubpaths(n), m) ?? transformBox(m, { x: 0, y: 0, w: 0, h: 0 });
  }
}

/** bounds in the node's own coordinate space */
export function localBounds(doc: Doc, id: string): Box {
  const c = cacheOf(doc);
  let b = c.local.get(id);
  if (!b) {
    const n = doc.nodes[id];
    b = (n && boundsIn(doc, n, ident())) ?? { x: 0, y: 0, w: 0, h: 0 };
    c.local.set(id, b);
  }
  return b;
}

/** axis-aligned bounds in page space */
export function worldBounds(doc: Doc, id: string): Box {
  const n = doc.nodes[id];
  if (!n) return { x: 0, y: 0, w: 0, h: 0 };
  return boundsIn(doc, n, worldMatrix(doc, id)) ?? { x: 0, y: 0, w: 0, h: 0 };
}

export function worldBoundsOf(doc: Doc, ids: Iterable<string>): Box | null {
  let b: Box | null = null;
  for (const id of ids) if (doc.nodes[id]) b = union(b, worldBounds(doc, id));
  return b;
}

/** How far paint can reach outside the geometry bounds (stroke, shadows, blur), in local px. */
export function paintOutset(doc: Doc, n: Node): number {
  let out = 0;
  if (n.type !== 'group') {
    if (n.strokes.some(s => s.visible)) {
      const w = n.strokeAlign === 'inside' ? 0 : n.strokeAlign === 'outside' ? n.strokeWeight : n.strokeWeight / 2;
      // miter joins / square caps can extend further than half the width
      out = n.strokeJoin === 'miter' || n.strokeCap === 'square' ? w * 4 : w;
      // arrowheads are wider than the line
      if (n.type === 'path' && ((n.startCap ?? 'none') !== 'none' || (n.endCap ?? 'none') !== 'none')) out = Math.max(out, n.strokeWeight * 2.5 + 2);
    }
  } else {
    for (const cid of n.children) { const c = doc.nodes[cid]; if (c) out = Math.max(out, paintOutset(doc, c)); }
  }
  let fx = 0;
  for (const e of n.effects) {
    if (!e.visible) continue;
    if (e.type === 'drop-shadow') fx = Math.max(fx, Math.abs(e.x) + e.blur + e.spread, Math.abs(e.y) + e.blur + e.spread);
    else if (e.type === 'layer-blur') fx = Math.max(fx, e.blur * 1.5);
    else if (e.type === 'texture') fx = Math.max(fx, e.radius);
  }
  return out + fx;
}

/** page-space bounds including strokes and effects (approximate, never too small) */
export function visualBounds(doc: Doc, id: string): Box {
  const n = doc.nodes[id];
  const b = worldBounds(doc, id);
  if (!n) return b;
  const m = worldMatrix(doc, id);
  const k = Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));
  let o = paintOutset(doc, n) * k;
  // ancestors' effects also spill
  for (let p = doc.nodes[n.parent]; p; p = doc.nodes[p.parent]) if (p.effects.length) o += paintOutset(doc, { ...p, children: [] } as Node) * k;
  return { x: b.x - o, y: b.y - o, w: b.w + 2 * o, h: b.h + 2 * o };
}
