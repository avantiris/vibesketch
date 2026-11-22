import type { Doc, Node, PathNode, ShapeNode, SubPath } from '../core/model.ts';
import { childrenOf, descendants, newId, shapeDefaults } from '../core/model.ts';
import { invert } from '../core/geom.ts';
import { worldMatrix } from '../core/bounds.ts';
import { insertNodes, normalizePath, removeNodes, sortByOrder, topMost } from '../core/ops.ts';
import { nodeSubpaths, parsePathData, subpathsToD, transformSubpaths } from '../core/path.ts';
import { outlineText } from '../io/export.ts';
import { exitPathEdit } from './pathtool.ts';
import { doc, pageId, pathEdit, select, selection, toast, update } from './store.ts';

// Boolean operations and flattening. Geometry is combined in page space with paper.js and
// comes back as one ordinary, editable path.

export type BoolOp = 'union' | 'subtract' | 'intersect' | 'exclude';
const NAMES: Record<BoolOp, string> = { union: 'Union', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude' };

type Paper = typeof import('paper/dist/paper-core');
let lib: Promise<Paper> | null = null;
function paper(): Promise<Paper> {
  lib ??= import('paper/dist/paper-core').then(m => {
    const p = ((m as unknown as { default?: Paper }).default ?? m) as Paper;
    p.setup(new p.Size(1, 1));
    return p;
  });
  return lib;
}

/** page-space outline of a node; groups contribute all of their shapes */
function worldSubpaths(d: Doc, id: string): { sps: SubPath[]; evenodd: boolean }[] {
  const n = d.nodes[id];
  if (!n || !n.visible) return [];
  if (n.type === 'group') return n.children.flatMap(c => worldSubpaths(d, c));
  if (n.type === 'text') return [];
  const sps = transformSubpaths(nodeSubpaths(n), worldMatrix(d, id)).filter(sp => sp.pts.length >= 2);
  return sps.length ? [{ sps, evenodd: n.type === 'path' && n.fillRule === 'evenodd' }] : [];
}

function firstShape(d: Doc, id: string): ShapeNode | null {
  const n = d.nodes[id];
  if (!n) return null;
  if (n.type !== 'group') return n;
  for (const c of n.children) { const s = firstShape(d, c); if (s) return s; }
  return null;
}

/** style of `like`, geometry `sps` given in page space, placed in `parent` */
function makePath(d: Doc, like: ShapeNode | null, sps: SubPath[], parent: string, name: string, fillRule: PathNode['fillRule']): PathNode {
  const s = like ?? ({ ...shapeDefaults(), fills: [], strokes: [] } as unknown as ShapeNode);
  return normalizePath({
    id: newId(), name, parent, type: 'path', fillRule,
    visible: true, locked: false, opacity: s.opacity, blend: s.blend, effects: s.effects,
    fills: s.fills, strokes: s.strokes, strokeWeight: s.strokeWeight, strokeAlign: s.strokeAlign, strokeCap: s.strokeCap, strokeJoin: s.strokeJoin, dash: s.dash,
    transform: invert(worldMatrix(d, parent)), subpaths: sps,
  });
}

function prepare(): { ids: string[]; top: Node } | null {
  if (pathEdit.value) exitPathEdit();
  const d = doc.value;
  const ids = sortByOrder(d, pageId.value, topMost(d, selection.value));
  if (!ids.length) return null;
  return { ids, top: d.nodes[ids[ids.length - 1]] };
}

function replace(ids: string[], top: Node, build: (d: Doc) => PathNode | null) {
  let made: string | null = null;
  update(cur => {
    const node = build(cur);
    if (!node) return cur;
    made = node.id;
    const index = childrenOf(cur, top.parent).indexOf(top.id) + 1;
    return removeNodes(insertNodes(cur, [node], [node.id], top.parent, index), ids);
  });
  if (made) select([made]);
}

/** Combine the selected layers. Subtract removes everything above from the bottom layer.
 *  The result is a single path that takes the bottom layer's appearance. */
export async function booleanOp(op: BoolOp) {
  const sel = prepare();
  if (!sel) return;
  const { ids, top } = sel;
  const single = ids.length === 1 ? doc.value.nodes[ids[0]] : null;
  const operands = single && single.type === 'group' ? single.children.slice() : ids;
  if (operands.length < 2) { toast('Select two or more shapes to combine'); return; }
  try {
    const P = await paper();
    const d = await outlineText(doc.value, operands);
    const items = operands.map(id => {
      // each layer first becomes one region (its own shapes united), honouring its fill rule
      const parts = worldSubpaths(d, id).map(part => {
        const cp = new P.CompoundPath({ pathData: subpathsToD(part.sps, 5), insert: false });
        cp.fillRule = part.evenodd ? 'evenodd' : 'nonzero';
        for (const ch of cp.children as paper.Path[]) ch.closed = true;
        return cp as paper.PathItem;
      });
      return parts.reduce<paper.PathItem | null>((a, b) => (a ? a.unite(b, { insert: false }) : b), null);
    }).filter((x): x is paper.PathItem => !!x);
    if (items.length < 2) { toast('Nothing to combine: the selection has fewer than two shapes'); return; }
    const fn = { union: 'unite', subtract: 'subtract', intersect: 'intersect', exclude: 'exclude' } as const;
    let res = items[0];
    for (const it of items.slice(1)) res = res[fn[op]](it, { insert: false });
    const sps = parsePathData(res.pathData);
    if (!sps.length) { toast(`${NAMES[op]}: the result is empty, nothing changed`); return; }
    replace(ids, top, cur => makePath(cur, firstShape(d, operands[0]), sps, top.parent, NAMES[op], 'nonzero'));
  } catch (e) {
    console.error(e);
    toast(`${NAMES[op]} failed: ${e instanceof Error ? e.message : e}`, 'error');
  }
}

/** Flatten the selection into one editable path: primitives and text become outlines, several
 *  layers are merged (keeping every contour, with the bottom layer's appearance). */
export async function flatten() {
  const sel = prepare();
  if (!sel) return;
  const { ids, top } = sel;
  try {
    const d = await outlineText(doc.value, ids);
    const parts = ids.flatMap(id => worldSubpaths(d, id));
    const sps = parts.flatMap(p => p.sps);
    if (!sps.length) { toast('Nothing to flatten'); return; }
    const leaves = ids.flatMap(id => [id, ...descendants(d, id)]).filter(id => d.nodes[id] && d.nodes[id].type !== 'group');
    const like = firstShape(d, ids[0]);
    const name = ids.length === 1 ? doc.value.nodes[ids[0]].name : 'Vector';
    replace(ids, top, cur => makePath(cur, like, sps, top.parent, name, leaves.length === 1 && parts[0].evenodd ? 'evenodd' : 'nonzero'));
  } catch (e) {
    console.error(e);
    toast(`Flatten failed: ${e instanceof Error ? e.message : e}`, 'error');
  }
}
