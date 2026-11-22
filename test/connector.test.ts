import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Box, Connector, Doc, Node, PathNode, RectNode, Vec } from '../src/core/model.ts';
import { emptyDoc, shapeDefaults, solid, BLACK } from '../src/core/model.ts';
import { apply } from '../src/core/geom.ts';
import { worldMatrix } from '../src/core/bounds.ts';
import { capLayout, elbowRoute, roundedPolyline, routeConnectors } from '../src/core/connector.ts';
import { duplicateNodes, groupNodes, insertNodes, removeNodes, translateWorld } from '../src/core/ops.ts';
import { segmentsOf } from '../src/core/path.ts';
import { exportSvg } from '../src/io/export.ts';

function rect(id: string, x: number, y: number, w: number, h: number): RectNode {
  return { ...shapeDefaults(), id, name: id, parent: '', type: 'rect', w, h, radii: [0, 0, 0, 0], transform: [1, 0, 0, 1, x, y], fills: [solid(BLACK)] };
}
function conn(id: string, c: Partial<Connector>, a: Vec = { x: 0, y: 0 }, b: Vec = { x: 1, y: 1 }): PathNode {
  const pt = (p: Vec) => ({ x: p.x, y: p.y, in: null, out: null, mode: 'corner' as const });
  return {
    ...shapeDefaults(), id, name: id, parent: '', type: 'path', fillRule: 'nonzero', strokes: [solid(BLACK)], strokeWeight: 2, endCap: 'arrow',
    connector: { kind: 'elbow', radius: 0, from: null, to: null, ...c }, subpaths: [{ closed: false, pts: [pt(a), pt(b)] }],
  };
}
function docWith(...nodes: Node[]): { doc: Doc; page: string } {
  let doc = emptyDoc();
  const page = doc.pages[0].id;
  doc = routeConnectors(insertNodes(doc, nodes, nodes.map(n => n.id), page));
  return { doc, page };
}
/** the connector's points in page space */
function worldPts(doc: Doc, id: string): Vec[] {
  const n = doc.nodes[id] as PathNode;
  return n.subpaths[0].pts.map(p => apply(worldMatrix(doc, id), p));
}
const orthogonal = (pts: Vec[]) => pts.every((p, i) => i === 0 || Math.abs(p.x - pts[i - 1].x) < 1e-6 || Math.abs(p.y - pts[i - 1].y) < 1e-6);
function crosses(pts: Vec[], b: Box): boolean {
  for (let i = 1; i < pts.length; i++) {
    for (let t = 0.02; t < 1; t += 0.02) {
      const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
      if (x > b.x + 0.5 && x < b.x + b.w - 0.5 && y > b.y + 0.5 && y < b.y + b.h - 0.5) return true;
    }
  }
  return false;
}

test('elbow route between facing sides is a Z through the middle of the gap', () => {
  const A = { x: 0, y: 0, w: 100, h: 60 }, B = { x: 300, y: 200, w: 100, h: 60 };
  const r = elbowRoute({ x: 100, y: 30 }, { x: 1, y: 0 }, A, { x: 300, y: 230 }, { x: -1, y: 0 }, B);
  assert.deepEqual(r, [{ x: 100, y: 30 }, { x: 200, y: 30 }, { x: 200, y: 230 }, { x: 300, y: 230 }]);
});

test('elbow route is straight when the anchors line up, and an L for perpendicular sides', () => {
  const A = { x: 0, y: 0, w: 100, h: 60 }, B = { x: 300, y: 0, w: 100, h: 60 };
  assert.deepEqual(elbowRoute({ x: 100, y: 30 }, { x: 1, y: 0 }, A, { x: 300, y: 30 }, { x: -1, y: 0 }, B), [{ x: 100, y: 30 }, { x: 300, y: 30 }]);
  const C = { x: 300, y: 200, w: 100, h: 60 };
  assert.deepEqual(elbowRoute({ x: 100, y: 30 }, { x: 1, y: 0 }, A, { x: 350, y: 200 }, { x: 0, y: -1 }, C), [{ x: 100, y: 30 }, { x: 350, y: 30 }, { x: 350, y: 200 }]);
});

test('elbow routes never cut through the boxes they connect, whatever the sides', () => {
  const dirs = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
  const anchor = (b: Box, s: keyof typeof dirs): Vec => ({ x: b.x + b.w * (s === 'left' ? 0 : s === 'right' ? 1 : 0.5), y: b.y + b.h * (s === 'top' ? 0 : s === 'bottom' ? 1 : 0.5) });
  const A = { x: 0, y: 0, w: 120, h: 80 };
  for (const [bx, by] of [[300, 0], [300, 300], [0, 300], [-300, 150], [60, 200], [200, -200], [150, 40]]) {
    const B = { x: bx, y: by, w: 90, h: 70 };
    for (const sa of Object.keys(dirs) as (keyof typeof dirs)[]) for (const sb of Object.keys(dirs) as (keyof typeof dirs)[]) {
      const r = elbowRoute(anchor(A, sa), dirs[sa], A, anchor(B, sb), dirs[sb], B);
      const where = `${sa} -> ${sb} at ${bx},${by}: ${JSON.stringify(r)}`;
      assert.ok(orthogonal(r), `not orthogonal, ${where}`);
      assert.ok(r.length <= 7, `too many bends, ${where}`);
      assert.ok(!crosses(r, A) && !crosses(r, B), `crosses a box, ${where}`);
    }
  }
});

test('overlapping boxes still get a route', () => {
  const A = { x: 0, y: 0, w: 100, h: 100 }, B = { x: 50, y: 50, w: 100, h: 100 };
  const r = elbowRoute({ x: 100, y: 50 }, { x: 1, y: 0 }, A, { x: 50, y: 100 }, { x: -1, y: 0 }, B);
  assert.ok(r.length >= 2 && orthogonal(r));
});

test('rounded corners become curves and never exceed half a segment', () => {
  const pts = roundedPolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 10 }, { x: 200, y: 10 }], 12);
  assert.equal(pts.length, 6);
  // the 10px riser is shared by two corners: each gets a radius of 5
  assert.deepEqual([pts[1].x, pts[2].y, pts[3].y, pts[4].x], [95, 5, 5, 105]);
  const curved = segmentsOf({ closed: false, pts }).filter(s => !s.straight);
  assert.equal(curved.length, 2);
});

test('a connector follows the shapes it is attached to', () => {
  const { doc } = docWith(rect('a', 0, 0, 100, 60), rect('b', 300, 200, 100, 60), conn('c', { from: { node: 'a', side: 'auto' }, to: { node: 'b', side: 'auto' } }));
  let p = worldPts(doc, 'c');
  assert.deepEqual([p[0], p[p.length - 1]], [{ x: 100, y: 30 }, { x: 300, y: 230 }]);
  assert.equal(routeConnectors(doc), doc, 'routing is stable');

  // b moves below a: the connector switches to the bottom / top sides
  const moved = routeConnectors(translateWorld(doc, ['b'], -300, 100));
  p = worldPts(moved, 'c');
  assert.deepEqual([p[0], p[p.length - 1]], [{ x: 50, y: 60 }, { x: 50, y: 300 }]);
  assert.equal(moved.nodes.a, doc.nodes.a);

  // a pinned side stays pinned
  const pinned = docWith(rect('a', 0, 0, 100, 60), rect('b', 300, 200, 100, 60), conn('c', { from: { node: 'a', side: 'top' }, to: { node: 'b', side: 'auto' } })).doc;
  assert.deepEqual(worldPts(pinned, 'c')[0], { x: 50, y: 0 });
});

test('free ends stay where they are; a deleted shape leaves its end free', () => {
  const { doc } = docWith(rect('a', 0, 0, 100, 60), conn('c', { from: { node: 'a', side: 'auto' } }, { x: 0, y: 0 }, { x: 250, y: 200 }));
  let p = worldPts(doc, 'c');
  assert.deepEqual(p[p.length - 1], { x: 250, y: 200 });
  assert.deepEqual(p[0], { x: 100, y: 30 });
  const gone = routeConnectors(removeNodes(doc, ['a']));
  const c = gone.nodes.c as PathNode;
  assert.equal(c.connector!.from, null);
  p = worldPts(gone, 'c');
  assert.deepEqual([p[0], p[p.length - 1]], [{ x: 100, y: 30 }, { x: 250, y: 200 }]);
  assert.equal(routeConnectors(gone), gone);
});

test('connectors work inside transformed groups and when attached to groups', () => {
  const { doc, page } = docWith(rect('a', 0, 0, 100, 60), rect('b', 300, 0, 100, 60), rect('x', 300, 80, 100, 20), conn('c', { kind: 'straight', from: { node: 'a', side: 'auto' }, to: { node: 'b', side: 'auto' } }));
  const g = groupNodes(doc, page, ['b', 'x'])!;
  let d = g.doc;
  d = { ...d, nodes: { ...d.nodes, c: { ...(d.nodes.c as PathNode), connector: { ...(d.nodes.c as PathNode).connector!, to: { node: g.id, side: 'left' } } } } };
  d = routeConnectors(translateWorld(d, [g.id], 50, 0));
  const p = worldPts(d, 'c');
  assert.deepEqual(p[1], { x: 350, y: 50 }, 'left side of the group box (300..400 x 0..100, moved by 50)');
  // a group that contains the connector cannot be its target
  const self = groupNodes(d, page, ['a', 'c'])!;
  const bad = routeConnectors({ ...self.doc, nodes: { ...self.doc.nodes, c: { ...(self.doc.nodes.c as PathNode), connector: { ...(self.doc.nodes.c as PathNode).connector!, to: { node: self.id, side: 'auto' } } } } });
  assert.equal((bad.nodes.c as PathNode).connector!.to, null);
});

test('duplicating shapes with their connector keeps the copy attached to the copies', () => {
  const { doc, page } = docWith(rect('a', 0, 0, 100, 60), rect('b', 300, 200, 100, 60), conn('c', { from: { node: 'a', side: 'auto' }, to: { node: 'b', side: 'auto' } }));
  const dup = duplicateNodes(doc, page, ['a', 'b', 'c']);
  const [a2, b2, c2] = dup.ids;
  assert.deepEqual((dup.doc.nodes[c2] as PathNode).connector, { kind: 'elbow', radius: 0, from: { node: a2, side: 'auto' }, to: { node: b2, side: 'auto' } });
  assert.deepEqual(dup.doc.pages[0].children, ['a', a2, 'b', b2, 'c', c2]);
  // the connector alone: its copy is a free line in the same place
  const lone = duplicateNodes(doc, page, ['c']);
  const c3 = lone.doc.nodes[lone.ids[0]] as PathNode;
  assert.deepEqual([c3.connector!.from, c3.connector!.to], [null, null]);
  assert.deepEqual(worldPts(routeConnectors(lone.doc), lone.ids[0])[0], { x: 100, y: 30 });
});

test('arrowheads: outlines at the ends, line shortened under solid heads, exported as plain SVG', async () => {
  const { doc, page } = docWith(rect('a', 0, 0, 100, 60), rect('b', 300, 0, 100, 60), conn('c', { from: { node: 'a', side: 'auto' }, to: { node: 'b', side: 'auto' } }));
  const c = doc.nodes.c as PathNode;
  const open = capLayout(c);
  assert.equal(open.heads.length, 1);
  assert.equal(open.subpaths[0], c.subpaths[0], 'an open arrow leaves the line alone');
  const tip = open.heads[0].type === 'polyline' ? open.heads[0].pts[1] : null;
  assert.deepEqual(tip && apply(worldMatrix(doc, 'c'), tip), { x: 300, y: 30 });
  const solidHead = capLayout({ ...c, startCap: 'circle', endCap: 'triangle' });
  assert.equal(solidHead.heads.length, 2);
  const pts = solidHead.subpaths[0].pts;
  assert.ok(pts[0].x > c.subpaths[0].pts[0].x && pts[1].x < c.subpaths[0].pts[1].x);
  const svg = (await exportSvg(doc, page, ['c'], { assetUrl: () => '' })).svg;
  assert.match(svg, /<polyline points="[^"]+" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"\/>/);
  assert.doesNotMatch(svg, /marker/);
});
