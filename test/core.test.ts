import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc, Node, PathNode, RectNode } from '../src/core/model.ts';
import { emptyDoc, shapeDefaults, solid, BLACK } from '../src/core/model.ts';
import { around, rotate, scale, translate } from '../src/core/geom.ts';
import { worldBounds, worldMatrix } from '../src/core/bounds.ts';
import { alignNodes, distributeNodes, duplicateNodes, groupNodes, insertNodes, removeNodes, reorder, reparent, transformWorld, ungroupNodes } from '../src/core/ops.ts';
import { bendSegment, cubicAt, parsePathData, rectSubpaths, segmentsOf, splitSubpath, subpathsBounds, subpathsToD } from '../src/core/path.ts';
import { exportSvg } from '../src/io/export.ts';
import { snapBox, snapPoint } from '../src/editor/snap.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

function rect(id: string, x: number, y: number, w: number, h: number): RectNode {
  return { ...shapeDefaults(), id, name: id, parent: '', type: 'rect', w, h, radii: [0, 0, 0, 0], transform: [1, 0, 0, 1, x, y], fills: [solid(BLACK)] };
}
function docWith(...nodes: Node[]): { doc: Doc; page: string } {
  let doc = emptyDoc();
  const page = doc.pages[0].id;
  doc = insertNodes(doc, nodes, nodes.map(n => n.id), page);
  return { doc, page };
}

test('path data round-trips, including arcs and relative commands', () => {
  const sps = parsePathData('M10 10h20v20h-20z m40 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0');
  assert.equal(sps.length, 2);
  assert.ok(sps[0].closed && sps[0].pts.length === 4);
  const b = subpathsBounds(sps)!;
  near(b.x, 10); near(b.y, 0, 1e-3); near(b.w, 60, 1e-3); near(b.h, 30, 1e-3);
  const again = parsePathData(subpathsToD(sps));
  assert.deepEqual(subpathsBounds(again), subpathsBounds(parsePathData(subpathsToD(again))));
});

test('splitting a curve keeps its shape; bending moves the grabbed point exactly', () => {
  const sp = parsePathData('M0 0C30 -40 70 -40 100 0')[0];
  const seg = segmentsOf(sp)[0];
  const before = cubicAt(seg, 0.3);
  const { sp: split, index } = splitSubpath(sp, 0, 0.3);
  assert.equal(index, 1);
  near(split.pts[1].x, before.x); near(split.pts[1].y, before.y);
  // a point on the first half of the split curve lies on the original
  const half = cubicAt(segmentsOf(split)[0], 0.5), orig = cubicAt(seg, 0.15);
  near(half.x, orig.x); near(half.y, orig.y);

  const t = 0.4, delta = { x: 7, y: -12 };
  const r = bendSegment(seg, t, delta);
  const bent = { p0: seg.p0, p1: seg.p1, c1: { x: seg.p0.x + r.out0.x, y: seg.p0.y + r.out0.y }, c2: { x: seg.p1.x + r.in1.x, y: seg.p1.y + r.in1.y } };
  const moved = cubicAt(bent, t), was = cubicAt(seg, t);
  near(moved.x - was.x, delta.x); near(moved.y - was.y, delta.y);
});

test('rounded rect clamps oversized radii', () => {
  const b = subpathsBounds(rectSubpaths(40, 20, [100, 100, 100, 100]))!;
  near(b.w, 40); near(b.h, 20);
});

test('resizing absorbs scale into geometry and keeps strokes; rotation stays in the matrix', () => {
  const { doc } = docWith(rect('a', 10, 10, 100, 50));
  let d = transformWorld(doc, ['a'], around(scale(2, 3), { x: 10, y: 10 }));
  let a = d.nodes.a as RectNode;
  near(a.w, 200); near(a.h, 150); assert.deepEqual(a.transform, [1, 0, 0, 1, 10, 10]);
  assert.equal(a.strokeWeight, 1);
  d = transformWorld(d, ['a'], around(rotate(Math.PI / 2), { x: 10, y: 10 }));
  a = d.nodes.a as RectNode;
  near(a.w, 200); near(a.h, 150);
  const b = worldBounds(d, 'a');
  near(b.x, -140); near(b.y, 10); near(b.w, 150); near(b.h, 200);
});

test('scaling a group scales its children in place, nested and rotated', () => {
  const { doc, page } = docWith(rect('a', 0, 0, 10, 10), rect('b', 30, 0, 10, 10));
  const g = groupNodes(doc, page, ['a', 'b'])!;
  let d = transformWorld(g.doc, [g.id], around(rotate(0.5), { x: 0, y: 0 }));
  const before = worldBounds(d, g.id);
  d = transformWorld(d, [g.id], scale(2, 2));
  const after = worldBounds(d, g.id);
  near(after.w, before.w * 2); near(after.h, before.h * 2); near(after.x, before.x * 2);
  near((d.nodes.a as RectNode).w, 20);
  // the group's own matrix stays a pure rotation
  const m = d.nodes[g.id].transform;
  near(Math.hypot(m[0], m[1]), 1); near(Math.hypot(m[2], m[3]), 1);
});

test('group / ungroup / reparent keep page positions; empty groups disappear', () => {
  const { doc, page } = docWith(rect('a', 5, 5, 10, 10), rect('b', 50, 20, 10, 10), rect('c', 80, 80, 5, 5));
  const g = groupNodes(doc, page, ['a', 'b'])!;
  let d = transformWorld(g.doc, [g.id], around(rotate(1), { x: 20, y: 20 }));
  const wa = worldMatrix(d, 'a');
  d = reparent(d, ['c'], g.id);
  d = reparent(d, ['a'], page, 0);
  worldMatrix(d, 'a').forEach((v, i) => near(v, wa[i]));
  assert.equal(d.pages[0].children[0], 'a');
  const wb = worldMatrix(d, 'b');
  const u = ungroupNodes(d, [g.id]);
  worldMatrix(u.doc, 'b').forEach((v, i) => near(v, wb[i]));
  assert.ok(!u.doc.nodes[g.id]);
  // removing the last children removes the group too
  const g2 = groupNodes(doc, page, ['a', 'b'])!;
  const r = removeNodes(g2.doc, ['a', 'b']);
  assert.ok(!r.nodes[g2.id]);
  assert.deepEqual(r.pages[0].children, ['c']);
});

test('duplicate, reorder, align, distribute', () => {
  const { doc, page } = docWith(rect('a', 0, 0, 10, 10), rect('b', 30, 7, 10, 20), rect('c', 100, 3, 10, 10));
  const dup = duplicateNodes(doc, page, ['a']);
  assert.equal(dup.doc.pages[0].children.length, 4);
  assert.equal(dup.doc.pages[0].children[1], dup.ids[0]);
  assert.deepEqual(reorder(doc, page, ['a'], 'front').pages[0].children, ['b', 'c', 'a']);
  assert.deepEqual(reorder(doc, page, ['c'], 'backward').pages[0].children, ['a', 'c', 'b']);
  const al = alignNodes(doc, ['a', 'b', 'c'], 'vcenter');
  for (const id of ['a', 'b', 'c']) { const b = worldBounds(al, id); near(b.y + b.h / 2, 13.5); }
  const di = distributeNodes(doc, ['a', 'b', 'c'], 'x');
  near(worldBounds(di, 'b').x, 50);
});

test('smart guides: edges, centers and equal spacing', () => {
  const targets = [{ x: 0, y: 0, w: 100, h: 100 }];
  // left edge 3px off the target's right edge
  let r = snapBox({ x: 103, y: 200, w: 50, h: 50 }, targets, 5);
  near(r.dx, -3); near(r.dy, 0);
  assert.ok(r.guides.some(g => g.kind === 'line' && g.axis === 'x' && g.pos === 100));
  // centers
  r = snapBox({ x: 27, y: 300, w: 50, h: 50 }, targets, 5);
  near(r.dx, -2);
  // nothing within reach
  r = snapBox({ x: 300, y: 300, w: 50, h: 50 }, targets, 5);
  assert.equal(r.dx, 0); assert.equal(r.guides.length, 0);
  // equal gap: A [0..100], B [130..230] (gap 30) -> moving box snaps to x = 260
  const row = [{ x: 0, y: 0, w: 100, h: 100 }, { x: 130, y: 0, w: 100, h: 100 }];
  r = snapBox({ x: 263, y: 10, w: 40, h: 40 }, row, 5);
  near(r.dx, -3);
  assert.equal(r.guides.filter(g => g.kind === 'gap').length, 2);
  // centered between two boxes
  r = snapBox({ x: 143, y: 10, w: 40, h: 40 }, [{ x: 0, y: 0, w: 100, h: 100 }, { x: 220, y: 0, w: 100, h: 100 }], 5);
  near(r.dx, -3);
  const p = snapPoint({ x: 98, y: 51 }, targets, 5);
  near(p.p.x, 100); near(p.p.y, 50);
});

test('SVG export is readable', async () => {
  const a = rect('a', 40, 60, 100, 50);
  a.name = 'Card';
  a.radii = [8, 8, 8, 8];
  const line: PathNode = { ...shapeDefaults(), id: 'l', name: 'Line', parent: '', type: 'path', fillRule: 'nonzero', strokes: [solid(BLACK)], strokeWeight: 2, subpaths: parsePathData('M0 0L50 0'), transform: translate(40, 130) };
  const { doc, page } = docWith(a, line);
  const { svg, box } = await exportSvg(doc, page, null, { assetUrl: () => '' });
  assert.ok(box.x <= 40 && box.y <= 60 && box.x + box.w >= 140 && box.y + box.h >= 131);
  assert.match(svg, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="\d+" height="\d+"/);
  assert.match(svg, /<rect id="Card"[^>]* width="100" height="50" rx="8" fill="#000000"\/>/);
  assert.match(svg, /<path id="Line"[^>]* d="M0 0H50"[^>]* stroke="#000000" stroke-width="2"\/>/);
});
