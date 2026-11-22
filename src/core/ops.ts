import type { Box, ConnectorEnd, Doc, GroupNode, Mat, Node, Page, PathNode, ShapeNode, SubPath } from './model.ts';
import { childrenOf, groupDefaults, isGroup, newId } from './model.ts';
import { apply, invert, mul, scale as scaleM, translate } from './geom.ts';
import { localBounds, worldBounds, worldMatrix } from './bounds.ts';
import { cloneSubpaths, nodeSubpaths, subpathsBounds, transformSubpaths } from './path.ts';

// Pure document operations: each returns a new Doc (structural sharing), never mutates.

export function setNode<T extends Node>(doc: Doc, id: string, patch: Partial<T> | ((n: T) => T)): Doc {
  const n = doc.nodes[id] as T | undefined;
  if (!n) return doc;
  const next = typeof patch === 'function' ? patch(n) : ({ ...n, ...patch } as T);
  if (next === n) return doc;
  return { ...doc, nodes: { ...doc.nodes, [id]: next } };
}

export function setNodes(doc: Doc, ids: Iterable<string>, fn: (n: Node) => Node): Doc {
  let nodes: Record<string, Node> | null = null;
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n) continue;
    const next = fn(n);
    if (next !== n) (nodes ??= { ...doc.nodes })[id] = next;
  }
  return nodes ? { ...doc, nodes } : doc;
}

/** replace the children list of a page or group */
export function setChildren(doc: Doc, containerId: string, children: string[]): Doc {
  const n = doc.nodes[containerId];
  if (n) return n.type === 'group' ? { ...doc, nodes: { ...doc.nodes, [containerId]: { ...n, children } } } : doc;
  const pi = doc.pages.findIndex(p => p.id === containerId);
  if (pi < 0) return doc;
  const pages = doc.pages.slice();
  pages[pi] = { ...pages[pi], children };
  return { ...doc, pages };
}

export function setPage(doc: Doc, pageId: string, patch: Partial<Page>): Doc {
  return { ...doc, pages: doc.pages.map(p => (p.id === pageId ? { ...p, ...patch } : p)) };
}

/** Insert already-built nodes. `nodes` may contain whole subtrees; `roots` are attached to
 *  `parentId` at `index` (default: on top). */
export function insertNodes(doc: Doc, nodes: Node[], roots: string[], parentId: string, index?: number): Doc {
  const map = { ...doc.nodes };
  for (const n of nodes) map[n.id] = roots.includes(n.id) ? { ...n, parent: parentId } : n;
  let next: Doc = { ...doc, nodes: map };
  const kids = childrenOf(next, parentId).filter(id => !roots.includes(id));
  const at = index == null ? kids.length : Math.max(0, Math.min(kids.length, index));
  kids.splice(at, 0, ...roots);
  next = setChildren(next, parentId, kids);
  return next;
}

/** Remove nodes with their subtrees. Groups left empty are removed as well. */
export function removeNodes(doc: Doc, ids: Iterable<string>): Doc {
  const nodes = { ...doc.nodes };
  let pages = doc.pages;
  const drop = (id: string) => {
    const n = nodes[id];
    if (!n) return;
    if (n.type === 'group') n.children.forEach(drop);
    delete nodes[id];
  };
  const queue: string[] = [];
  for (const id of ids) { const n = nodes[id]; if (n) { queue.push(n.parent); drop(id); } }
  while (queue.length) {
    const pid = queue.pop()!;
    const p = nodes[pid];
    if (p) {
      if (p.type !== 'group') continue;
      const left = p.children.filter(k => nodes[k]);
      if (left.length === 0) { delete nodes[pid]; queue.push(p.parent); }
      else if (left.length !== p.children.length) nodes[pid] = { ...p, children: left };
    } else {
      pages = pages.map(pg => (pg.id === pid ? { ...pg, children: pg.children.filter(k => nodes[k]) } : pg));
    }
  }
  return { ...doc, nodes, pages };
}

/** ids sorted by document order (bottom to top) within the page */
export function sortByOrder(doc: Doc, pageId: string, ids: Iterable<string>): string[] {
  const set = new Set(ids), out: string[] = [];
  const walk = (cid: string) => { for (const c of childrenOf(doc, cid)) { if (set.has(c)) out.push(c); walk(c); } };
  walk(pageId);
  return out;
}

/** drop ids whose ancestor is also in the list */
export function topMost(doc: Doc, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter(id => {
    for (let p = doc.nodes[id]?.parent; p && doc.nodes[p]; p = doc.nodes[p].parent) if (set.has(p)) return false;
    return !!doc.nodes[id];
  });
}

export function isAncestor(doc: Doc, ancestor: string, id: string): boolean {
  for (let p = doc.nodes[id]?.parent; p; p = doc.nodes[p]?.parent as string) if (p === ancestor) return true;
  return false;
}

/** Move nodes into another container, keeping their position on the page. */
export function reparent(doc: Doc, ids: string[], parentId: string, index?: number): Doc {
  ids = topMost(doc, ids).filter(id => id !== parentId && !isAncestor(doc, id, parentId));
  if (!ids.length) return doc;
  const targetInv = invert(worldMatrix(doc, parentId));
  const nodes = { ...doc.nodes };
  let next: Doc = { ...doc, nodes };
  // resolve the insertion index against the list without the moved nodes
  const before = childrenOf(doc, parentId);
  let at = index == null ? before.length : Math.max(0, Math.min(before.length, index));
  at -= before.slice(0, at).filter(k => ids.includes(k)).length;
  const oldParents = new Set<string>();
  for (const id of ids) {
    const n = nodes[id];
    oldParents.add(n.parent);
    nodes[id] = { ...n, parent: parentId, transform: mul(targetInv, worldMatrix(doc, id)) };
  }
  for (const pid of oldParents) next = setChildren(next, pid, childrenOf(next, pid).filter(k => !ids.includes(k)));
  const kids = childrenOf(next, parentId).filter(k => !ids.includes(k));
  kids.splice(at, 0, ...ids);
  next = setChildren(next, parentId, kids);
  // remove groups that became empty
  const empty = [...oldParents].filter(pid => { const p = next.nodes[pid]; return p && p.type === 'group' && p.children.length === 0; });
  return empty.length ? removeNodes(next, empty) : next;
}

export function groupNodes(doc: Doc, pageId: string, ids: string[]): { doc: Doc; id: string } | null {
  ids = sortByOrder(doc, pageId, topMost(doc, ids));
  if (!ids.length) return null;
  const top = doc.nodes[ids[ids.length - 1]];
  const parentId = top.parent;
  const g: GroupNode = { ...groupDefaults(), id: newId(), name: 'Group', parent: parentId };
  const index = childrenOf(doc, parentId).indexOf(top.id) + 1;
  let next = insertNodes(doc, [g], [g.id], parentId, index);
  next = reparent(next, ids, g.id);
  return { doc: next, id: g.id };
}

export function ungroupNodes(doc: Doc, ids: string[]): { doc: Doc; children: string[] } {
  let next = doc;
  const out: string[] = [];
  for (const id of ids) {
    const g = next.nodes[id];
    if (!g || g.type !== 'group') continue;
    const kids = g.children.slice();
    const index = childrenOf(next, g.parent).indexOf(id);
    // group opacity carries over to the children so the result looks the same
    if (g.opacity < 1) next = setNodes(next, kids, n => ({ ...n, opacity: n.opacity * g.opacity }));
    next = reparent(next, kids, g.parent, index);
    if (next.nodes[id]) next = removeNodes(next, [id]);
    out.push(...kids);
  }
  return { doc: next, children: out };
}

/** Deep-copy subtrees with fresh ids. Returned nodes are not yet part of any doc. Connectors
 *  among the copies follow the copies of the nodes they were attached to; ends whose node was
 *  not copied become free. */
export function cloneSubtrees(doc: Doc, ids: string[]): { nodes: Node[]; roots: string[] } {
  const nodes: Node[] = [], roots: string[] = [];
  const map = new Map<string, string>();
  const copy = (id: string, parent: string): string | null => {
    const n = doc.nodes[id];
    if (!n) return null;
    const nid = newId();
    const c = structuredClone(n) as Node;
    c.id = nid; c.parent = parent;
    map.set(id, nid);
    nodes.push(c);
    if (c.type === 'group') c.children = (n as GroupNode).children.map(k => copy(k, nid)).filter((k): k is string => !!k);
    return nid;
  };
  for (const id of ids) { const r = copy(id, doc.nodes[id]?.parent ?? ''); if (r) roots.push(r); }
  for (const c of nodes) {
    if (c.type !== 'path' || !c.connector) continue;
    const re = (e: ConnectorEnd | null): ConnectorEnd | null => (e && map.has(e.node) ? { ...e, node: map.get(e.node)! } : null);
    c.connector = { ...c.connector, from: re(c.connector.from), to: re(c.connector.to) };
  }
  return { nodes, roots };
}

export function duplicateNodes(doc: Doc, pageId: string, ids: string[]): { doc: Doc; ids: string[] } {
  ids = sortByOrder(doc, pageId, topMost(doc, ids));
  // cloned in one go so that connectors copied along with their shapes stay attached to the copies
  const { nodes, roots } = cloneSubtrees(doc, ids);
  let next: Doc = { ...doc, nodes: { ...doc.nodes, ...Object.fromEntries(nodes.map(n => [n.id, n])) } };
  ids.forEach((id, i) => {
    const parent = doc.nodes[id].parent;
    next = insertNodes(next, [], [roots[i]], parent, childrenOf(next, parent).indexOf(id) + 1);
  });
  return { doc: next, ids: roots };
}

// ---------------------------------------------------------------- transforms

/** Scale a node's own geometry by (kx, ky) in its local space (no transform change). */
function scaleGeometry(doc: Doc, n: Node, kx: number, ky: number, nodes: Record<string, Node>): Node {
  if (Math.abs(kx - 1) < 1e-12 && Math.abs(ky - 1) < 1e-12) return n;
  switch (n.type) {
    case 'rect': case 'ellipse': case 'polygon': case 'star':
      return { ...n, w: n.w * kx, h: n.h * ky };
    case 'path':
      return { ...n, subpaths: transformSubpaths(n.subpaths, scaleM(kx, ky)) };
    case 'text': {
      // text scales with the vertical factor; a differing horizontal factor only changes the wrap width
      return { ...n, size: n.size * ky, lineHeight: n.lineHeight == null ? null : n.lineHeight * ky, letterSpacing: n.letterSpacing * ky, w: n.w == null ? null : n.w * kx };
    }
    case 'group': {
      const S = scaleM(kx, ky);
      for (const cid of n.children) {
        const c = nodes[cid];
        if (c) nodes[cid] = transformed(doc, c, S, nodes);
      }
      return n;
    }
  }
}

/** Node after applying T (given in the node's parent space). Changes in the length of the
 *  transform's axes are absorbed into the geometry (sizes, points), so shapes keep clean
 *  transforms and strokes do not scale; rotation / skew / flips stay in the matrix. */
function transformed(doc: Doc, n: Node, T: Mat, nodes: Record<string, Node>): Node {
  const M = n.transform, M2 = mul(T, M);
  const lx = Math.hypot(M[0], M[1]), ly = Math.hypot(M[2], M[3]);
  const lx2 = Math.hypot(M2[0], M2[1]), ly2 = Math.hypot(M2[2], M2[3]);
  if (lx < 1e-9 || ly < 1e-9) return { ...n, transform: M2 };
  let kx = lx2 / lx, ky = ly2 / ly;
  if (n.type === 'text' && n.w == null && Math.abs(kx - ky) > 1e-6 * Math.max(kx, ky)) {
    // auto-width text can't stretch on one axis: keep the distortion in the matrix
    kx = ky = Math.sqrt(kx * ky);
  }
  if (kx < 1e-9 || ky < 1e-9) return { ...n, transform: M2 };
  const R: Mat = [M2[0] / kx, M2[1] / kx, M2[2] / ky, M2[3] / ky, M2[4], M2[5]];
  const scaled = scaleGeometry(doc, n, kx, ky, nodes);
  return { ...scaled, transform: R };
}

/** Apply T (in each node's parent space) to nodes. */
export function transformNodes(doc: Doc, items: { id: string; T: Mat }[]): Doc {
  const nodes = { ...doc.nodes };
  for (const { id, T } of items) {
    const n = nodes[id];
    if (n) nodes[id] = transformed(doc, n, T, nodes);
  }
  return { ...doc, nodes };
}

/** Apply a page-space transform W to the given nodes. */
export function transformWorld(doc: Doc, ids: string[], W: Mat): Doc {
  return transformNodes(doc, ids.map(id => {
    const P = worldMatrix(doc, doc.nodes[id]?.parent ?? '');
    return { id, T: mul(invert(P), mul(W, P)) };
  }));
}

export function translateWorld(doc: Doc, ids: string[], dx: number, dy: number): Doc {
  if (!dx && !dy) return doc;
  return transformWorld(doc, ids, translate(dx, dy));
}

// ---------------------------------------------------------------- paths

/** Shift path geometry so its local bounds start at (0,0), compensating in the transform.
 *  Keeps X/Y readouts meaningful after point edits. */
export function normalizePath(n: PathNode): PathNode {
  const b = subpathsBounds(n.subpaths);
  if (!b || (Math.abs(b.x) < 1e-9 && Math.abs(b.y) < 1e-9)) return n;
  const o = apply([n.transform[0], n.transform[1], n.transform[2], n.transform[3], 0, 0], { x: b.x, y: b.y });
  return {
    ...n,
    subpaths: transformSubpaths(n.subpaths, translate(-b.x, -b.y)),
    transform: [n.transform[0], n.transform[1], n.transform[2], n.transform[3], n.transform[4] + o.x, n.transform[5] + o.y],
  };
}

/** Convert any non-text shape into an editable path node (same id, same look). */
export function toPath(n: ShapeNode): PathNode | null {
  if (n.type === 'path') return n;
  if (n.type === 'text') return null;
  const { type: _t, ...rest } = n as ShapeNode & Record<string, unknown>;
  const base: Record<string, unknown> = { ...rest };
  for (const k of ['w', 'h', 'radii', 'sides', 'points', 'inner']) delete base[k];
  return { ...(base as unknown as Omit<PathNode, 'type' | 'subpaths' | 'fillRule'>), type: 'path', subpaths: cloneSubpaths(nodeSubpaths(n)), fillRule: 'nonzero' };
}

export function pathFromSubpaths(base: Omit<PathNode, 'type' | 'subpaths' | 'fillRule'>, subpaths: SubPath[], fillRule: PathNode['fillRule'] = 'nonzero'): PathNode {
  return normalizePath({ ...base, type: 'path', subpaths, fillRule });
}

// ---------------------------------------------------------------- z-order

export function reorder(doc: Doc, pageId: string, ids: string[], how: 'front' | 'back' | 'forward' | 'backward'): Doc {
  ids = topMost(doc, ids);
  const byParent = new Map<string, string[]>();
  for (const id of ids) { const p = doc.nodes[id].parent; byParent.set(p, [...(byParent.get(p) ?? []), id]); }
  let next = doc;
  for (const [pid, sel] of byParent) {
    const kids = childrenOf(next, pid).slice();
    const set = new Set(sel);
    const chosen = kids.filter(k => set.has(k)), rest = kids.filter(k => !set.has(k));
    let out: string[];
    if (how === 'front') out = [...rest, ...chosen];
    else if (how === 'back') out = [...chosen, ...rest];
    else {
      out = kids;
      const order = how === 'forward' ? [...kids.keys()].reverse() : [...kids.keys()];
      const step = how === 'forward' ? 1 : -1;
      for (const i of order) {
        const j = i + step;
        if (set.has(out[i]) && j >= 0 && j < out.length && !set.has(out[j])) [out[i], out[j]] = [out[j], out[i]];
      }
    }
    next = setChildren(next, pid, out);
  }
  void pageId;
  return next;
}

// ---------------------------------------------------------------- align / distribute


export type AlignHow = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** Align nodes to their common bounds; a single node aligns to its parent group's bounds. */
export function alignNodes(doc: Doc, ids: string[], how: AlignHow): Doc {
  ids = topMost(doc, ids);
  if (!ids.length) return doc;
  const boxes = ids.map(id => worldBounds(doc, id));
  let ref: Box;
  if (ids.length === 1) {
    const p = doc.nodes[ids[0]].parent;
    if (!doc.nodes[p]) return doc;
    ref = worldBounds(doc, p);
  } else {
    const x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y));
    ref = { x: x0, y: y0, w: Math.max(...boxes.map(b => b.x + b.w)) - x0, h: Math.max(...boxes.map(b => b.y + b.h)) - y0 };
  }
  let next = doc;
  ids.forEach((id, i) => {
    const b = boxes[i];
    let dx = 0, dy = 0;
    if (how === 'left') dx = ref.x - b.x;
    else if (how === 'hcenter') dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
    else if (how === 'right') dx = ref.x + ref.w - (b.x + b.w);
    else if (how === 'top') dy = ref.y - b.y;
    else if (how === 'vcenter') dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
    else dy = ref.y + ref.h - (b.y + b.h);
    next = translateWorld(next, [id], dx, dy);
  });
  return next;
}

/** Equalize the gaps between 3+ nodes along an axis. */
export function distributeNodes(doc: Doc, ids: string[], axis: 'x' | 'y'): Doc {
  ids = topMost(doc, ids);
  if (ids.length < 3) return doc;
  const size = axis === 'x' ? 'w' : 'h';
  const items = ids.map(id => ({ id, b: worldBounds(doc, id) })).sort((a, b) => a.b[axis] - b.b[axis]);
  const first = items[0].b, last = items[items.length - 1].b;
  const total = items.reduce((s, it) => s + it.b[size], 0);
  const gap = (last[axis] + last[size] - first[axis] - total) / (items.length - 1);
  let pos = first[axis], next = doc;
  for (const it of items) {
    const d = pos - it.b[axis];
    next = translateWorld(next, [it.id], axis === 'x' ? d : 0, axis === 'y' ? d : 0);
    pos += it.b[size] + gap;
  }
  return next;
}

export function flipNodes(doc: Doc, ids: string[], axis: 'x' | 'y'): Doc {
  ids = topMost(doc, ids);
  let b: Box | null = null;
  for (const id of ids) { const wb = worldBounds(doc, id); b = b ? unionBox(b, wb) : wb; }
  if (!b) return doc;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const W: Mat = axis === 'x' ? [-1, 0, 0, 1, 2 * cx, 0] : [1, 0, 0, -1, 0, 2 * cy];
  return transformWorld(doc, ids, W);
}

function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export { isGroup, localBounds };
