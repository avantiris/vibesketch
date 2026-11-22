import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DOMParser } from 'linkedom';
import type { Box, EllipseNode, GradientPaint, GroupNode, ImagePaint, Mat, Node, PathNode, RectNode, ShapeNode, SolidPaint, TextNode } from '../src/core/model.ts';
import { mul, rotationOf, union } from '../src/core/geom.ts';
import { nodeSubpaths, subpathsBounds } from '../src/core/path.ts';
import { NAMED_COLORS, parseColor } from '../src/io/svg/color.ts';
import { parseLength, parseTransform } from '../src/io/svg/parse.ts';
import type { SvgImport } from '../src/io/svgImport.ts';
import { importSvg } from '../src/io/svgImport.ts';

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"';
const imp = (svg: string, extra: object = {}): Promise<SvgImport> => importSvg(svg, { DOMParser, ...extra });
const doc = (body: string, attrs = 'width="200" height="100"'): Promise<SvgImport> => imp(`<svg ${NS} ${attrs}>${body}</svg>`);

function byName<T extends Node = Node>(r: SvgImport, name: string): T {
  const n = Object.values(r.nodes).find(x => x.name === name);
  assert.ok(n, `node "${name}" not found; have: ${Object.values(r.nodes).map(x => x.name).join(', ')}`);
  return n as T;
}
const near = (a: number, b: number, eps = 1e-3, msg = ''): void => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const matNear = (m: Mat, e: number[], eps = 1e-3): void => e.forEach((v, i) => near(m[i], v, eps, `mat[${i}] of [${m}]`));
const rgb = (n: ShapeNode, which: 'fills' | 'strokes' = 'fills'): number[] => {
  const p = n[which][0] as SolidPaint;
  assert.equal(p?.type, 'solid');
  return [p.color.r, p.color.g, p.color.b].map(v => Math.round(v * 255));
};
/** world transform of a node (roots have parent '') */
function world(r: SvgImport, n: Node): Mat {
  let m = n.transform;
  for (let p = r.nodes[n.parent]; p; p = r.nodes[p.parent]) m = mul(p.transform, m);
  return m;
}
function worldBounds(r: SvgImport, n: Node): Box | null {
  if (n.type === 'group') return n.children.reduce<Box | null>((u, id) => union(u, worldBounds(r, r.nodes[id])), null);
  if (n.type === 'text') return null;
  return subpathsBounds(nodeSubpaths(n), world(r, n));
}
// 4x4 RGB PNG (99 bytes), as produced by cairo
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAABmJLR0QA/wD/AP+gvaeTAAAAGElEQVQImWNkYGgIYGCAIBaGAAY4wM0BAFrQAm5tCjdYAAAAAElFTkSuQmCC';
const PNG_URI = `data:image/png;base64,${PNG_B64}`;

// ---------------------------------------------------------------- unit: parsers

test('transform grammar', () => {
  matNear(parseTransform('translate(10,20) scale(2)'), [2, 0, 0, 2, 10, 20]);
  matNear(parseTransform('translate(5)scale(2 3),rotate(90)'), [0, 3, -2, 0, 5, 0]);
  matNear(parseTransform('rotate(90 10 10)'), [0, 1, -1, 0, 20, 0]);
  matNear(parseTransform('matrix(1,2 3,4\n5 6)'), [1, 2, 3, 4, 5, 6]);
  matNear(parseTransform(' matrix(1 0 0 -1 0 842) '), [1, 0, 0, -1, 0, 842]);
  matNear(parseTransform('skewX(45)'), [1, 0, 1, 1, 0, 0]);
  matNear(parseTransform('skewY(45)'), [1, 1, 0, 1, 0, 0]);
  matNear(parseTransform('scale(-1, 1) translate(-1e1 .5)'), [-1, 0, 0, 1, 10, 0.5]);
  matNear(parseTransform('bogus(1) nonsense'), [1, 0, 0, 1, 0, 0]);
  matNear(parseTransform(null), [1, 0, 0, 1, 0, 0]);
});

test('colors', () => {
  assert.equal(NAMED_COLORS.size, 148);
  const c = (s: string): number[] | null => {
    const v = parseColor(s);
    return v && [v.r * 255, v.g * 255, v.b * 255, v.a].map(x => Math.round(x * 1000) / 1000);
  };
  assert.deepEqual(c('red'), [255, 0, 0, 1]);
  assert.deepEqual(c('RebeccaPurple'), [102, 51, 153, 1]);
  assert.deepEqual(c('lightgoldenrodyellow'), [250, 250, 210, 1]);
  assert.deepEqual(c('#f00'), [255, 0, 0, 1]);
  assert.deepEqual(c('#f008'), [255, 0, 0, 0.533]);
  assert.deepEqual(c('#00FF00'), [0, 255, 0, 1]);
  assert.deepEqual(c('#0000ff80'), [0, 0, 255, 0.502]);
  assert.deepEqual(c('rgb(255, 0, 10)'), [255, 0, 10, 1]);
  assert.deepEqual(c('rgb(100%, 0%, 50%)'), [255, 0, 127.5, 1]);
  assert.deepEqual(c('rgba(0,0,255,0.5)'), [0, 0, 255, 0.5]);
  assert.deepEqual(c('rgb(0 128 255 / 50%)'), [0, 128, 255, 0.5]);
  assert.deepEqual(c('rgb(300, -5, 0)'), [255, 0, 0, 1]);
  assert.deepEqual(c('hsl(120, 100%, 50%)'), [0, 255, 0, 1]);
  assert.deepEqual(c('hsla(240, 100%, 50%, 0.25)'), [0, 0, 255, 0.25]);
  assert.deepEqual(c('hsl(0, 0%, 50%)'), [127.5, 127.5, 127.5, 1]);
  assert.deepEqual(c('transparent'), [0, 0, 0, 0]);
  assert.deepEqual(parseColor('currentColor', { r: 0.5, g: 0.25, b: 1, a: 1 }), { r: 0.5, g: 0.25, b: 1, a: 1 });
  assert.equal(c('notacolor'), null);
  assert.equal(c('#12'), null);
});

test('lengths', () => {
  assert.equal(parseLength('10', 16, 100), 10);
  assert.equal(parseLength('10px', 16, 100), 10);
  near(parseLength('72pt', 16, 100)!, 96);
  assert.equal(parseLength('1pc', 16, 100), 16);
  assert.equal(parseLength('1in', 16, 100), 96);
  near(parseLength('25.4mm', 16, 100)!, 96);
  near(parseLength('2.54cm', 16, 100)!, 96);
  assert.equal(parseLength('2em', 10, 100), 20);
  assert.equal(parseLength('50%', 16, 300), 150);
  assert.equal(parseLength('1e1', 16, 100), 10);
  assert.equal(parseLength('abc', 16, 100), null);
});

// ---------------------------------------------------------------- shapes

test('every shape type, x/y folded into the transform', async () => {
  const r = await doc(`
    <rect id="r1" x="10" y="20" width="30" height="40" rx="5"/>
    <rect id="r2" x="100" y="0" width="30" height="40" rx="5" ry="10"/>
    <circle id="c" cx="50" cy="50" r="10"/>
    <ellipse id="e" cx="50" cy="50" rx="20" ry="10"/>
    <line id="l" x1="10" y1="10" x2="50" y2="30" stroke="red" stroke-width="2"/>
    <polyline id="pl" points="0,0 10,10 20,0" fill="none" stroke="#000"/>
    <polygon id="pg" points="10,10 30,10 20,30"/>
    <path id="p" d="M10 10 h20 v20 h-20 z"/>
    <rect id="zero" width="0" height="10"/>
    <rect id="unit" x="1in" y="50%" width="10mm" height="1em" font-size="20"/>`);
  assert.equal(r.width, 200);
  assert.equal(r.height, 100);
  assert.deepEqual(r.roots.map(id => r.nodes[id].name), ['r1', 'r2', 'c', 'e', 'l', 'pl', 'pg', 'p', 'unit']);
  for (const id of r.roots) assert.equal(r.nodes[id].parent, '');

  const r1 = byName<RectNode>(r, 'r1');
  assert.equal(r1.type, 'rect');
  assert.deepEqual([r1.w, r1.h, r1.radii], [30, 40, [5, 5, 5, 5]]);
  matNear(r1.transform, [1, 0, 0, 1, 10, 20]);
  assert.deepEqual(rgb(r1), [0, 0, 0], 'SVG default fill is black');
  assert.equal(r1.strokes.length, 0);

  const r2 = byName<PathNode>(r, 'r2');
  assert.equal(r2.type, 'path', 'rx != ry becomes a path');
  matNear(r2.transform, [1, 0, 0, 1, 100, 0]);
  const b2 = subpathsBounds(r2.subpaths)!;
  matNear([b2.x, b2.y, b2.w, b2.h, 0, 0], [0, 0, 30, 40, 0, 0]);
  assert.equal(r2.subpaths[0].closed, true);
  assert.equal(r2.subpaths[0].pts.length, 8);

  const c = byName<EllipseNode>(r, 'c');
  assert.deepEqual([c.type, c.w, c.h], ['ellipse', 20, 20]);
  matNear(c.transform, [1, 0, 0, 1, 40, 40]);
  const e = byName<EllipseNode>(r, 'e');
  assert.deepEqual([e.type, e.w, e.h], ['ellipse', 40, 20]);
  matNear(e.transform, [1, 0, 0, 1, 30, 40]);

  const l = byName<PathNode>(r, 'l');
  assert.equal(l.type, 'path');
  assert.equal(l.fills.length, 0);
  assert.deepEqual(rgb(l, 'strokes'), [255, 0, 0]);
  assert.equal(l.strokeWeight, 2);
  assert.equal(l.strokeAlign, 'center');
  matNear(l.transform, [1, 0, 0, 1, 10, 10]);
  assert.deepEqual(l.subpaths[0].pts.map(p => [p.x, p.y]), [[0, 0], [40, 20]]);

  const pl = byName<PathNode>(r, 'pl');
  assert.equal(pl.subpaths[0].closed, false);
  assert.equal(pl.subpaths[0].pts.length, 3);
  const pg = byName<PathNode>(r, 'pg');
  assert.equal(pg.subpaths[0].closed, true);
  matNear(pg.transform, [1, 0, 0, 1, 10, 10]);
  assert.deepEqual(pg.subpaths[0].pts.map(p => [p.x, p.y]), [[0, 0], [20, 0], [10, 20]]);

  const p = byName<PathNode>(r, 'p');
  matNear(p.transform, [1, 0, 0, 1, 10, 10]);
  assert.deepEqual(p.subpaths[0].pts.map(q => [q.x, q.y]), [[0, 0], [20, 0], [20, 20], [0, 20]]);

  const u = byName<RectNode>(r, 'unit');
  matNear(u.transform, [1, 0, 0, 1, 96, 50]);
  near(u.w, 37.795);
  assert.equal(u.h, 20);
});

test('path normalisation: local bounds start at (0,0), offset folded into the transform; arcs', async () => {
  const r = await doc(`
    <path id="arc" d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="black"/>
    <path id="moved" transform="translate(100 0) rotate(90)" d="M 5 -20 L 25 -20 L 25 -10 Z" fill="blue"/>
    <path id="flip" transform="matrix(1,0,0,-1,0,100)" d="M 10 10 L 30 10 L 30 40 Z" fill="blue"/>`);
  const arc = byName<PathNode>(r, 'arc');
  const b = subpathsBounds(arc.subpaths)!;
  matNear([b.x, b.y, b.w, b.h, 0, 0], [0, 0, 80, 40, 0, 0], 1e-3);
  matNear(arc.transform, [1, 0, 0, 1, 10, 10]);
  assert.ok(arc.subpaths[0].pts.some(p => p.in || p.out), 'arc became curves');
  // every imported path has bounds at the origin
  for (const n of Object.values(r.nodes)) {
    if (n.type !== 'path') continue;
    const nb = subpathsBounds(n.subpaths)!;
    near(nb.x, 0, 1e-6); near(nb.y, 0, 1e-6);
  }
  // rotation is kept in the transform, the translation absorbs the bounds offset
  const mv = byName<PathNode>(r, 'moved');
  near(rotationOf(mv.transform), Math.PI / 2, 1e-6);
  const wb = subpathsBounds(mv.subpaths, mv.transform)!;
  matNear([wb.x, wb.y, wb.w, wb.h, 0, 0], [110, 5, 10, 20, 0, 0]);
  // an axis flip is baked into the geometry
  const fl = byName<PathNode>(r, 'flip');
  matNear(fl.transform, [1, 0, 0, 1, 10, 60]);
  assert.deepEqual(fl.subpaths[0].pts.map(q => [q.x, q.y]), [[0, 30], [20, 30], [20, 0]]);
});

// ---------------------------------------------------------------- structure

test('structure: groups, collapsing, nested svg, switch, display/visibility, names, unknown elements', async () => {
  const r = await doc(`
    <title>Doc title</title><desc>d</desc><metadata><x/></metadata>
    <g transform="translate(10,10)"><g transform="scale(2)"><rect id="deep" x="1" y="1" width="5" height="5"/></g></g>
    <g id="empty"><g/></g>
    <g id="pair" opacity="0.5"><rect width="1" height="1"/><rect id="hid" width="1" height="1" visibility="hidden"/></g>
    <g display="none"><rect id="gone" width="1" height="1"/></g>
    <rect id="gone2" style="display:none" width="1" height="1"/>
    <svg x="100" y="10" width="50" height="50" viewBox="0 0 10 20" preserveAspectRatio="xMidYMid meet"><rect id="nested" width="10" height="20"/></svg>
    <switch><foreignObject requiredExtensions="http://x"/><rect id="sw" width="3" height="3"/><rect id="sw2" width="3" height="3"/></switch>
    <a href="http://example.com"><circle id="link" r="4"/></a>
    <g inkscape:label="My Layer"><rect width="2" height="2"/><rect width="2" height="2"/></g>
    <rect id="Red_x20_Box_x5F_1" width="2" height="2"/>
    <rect data-name="Data Name" id="zz" width="2" height="2"/>
    <rect id="rect1234" width="2" height="2"><title>Titled &amp; so</title></rect>
    <foreignObject width="10" height="10"><div>html</div></foreignObject>
    <foreignObject width="10" height="10"/>
    <wibble/>
    <rect id="nofill" fill="none" width="5" height="5"/>
    <rect id="transp" fill="transparent" width="5" height="5"/>`);
  const deep = byName<RectNode>(r, 'deep');
  assert.equal(deep.parent, '', 'single-child groups are merged into the child');
  assert.deepEqual([deep.w, deep.h], [10, 10]);
  matNear(deep.transform, [1, 0, 0, 1, 12, 12]);

  const names = Object.values(r.nodes).map(n => n.name);
  for (const gone of ['empty', 'gone', 'gone2', 'sw2', 'nofill', 'transp']) assert.ok(!names.includes(gone), `${gone} must not be imported`);

  const pair = byName<GroupNode>(r, 'pair');
  assert.equal(pair.type, 'group');
  assert.equal(pair.opacity, 0.5);
  assert.equal(pair.children.length, 2);
  assert.equal(byName(r, 'hid').visible, false);
  assert.equal(byName(r, 'hid').parent, pair.id);
  assert.equal(r.nodes[pair.children[0]].visible, true);
  assert.equal(r.nodes[pair.children[0]].opacity, 1, 'opacity is not inherited');

  // viewBox 10x20 into 50x50 at (100,10): scale 2.5, centred horizontally (+12.5)
  const nested = byName<RectNode>(r, 'nested');
  assert.deepEqual([nested.w, nested.h], [25, 50]);
  matNear(nested.transform, [1, 0, 0, 1, 112.5, 10]);

  assert.equal(byName(r, 'sw').type, 'rect');
  assert.equal(byName(r, 'link').type, 'ellipse');
  assert.equal(byName<GroupNode>(r, 'My Layer').children.length, 2);
  assert.equal(byName(r, 'Red Box_1').type, 'rect');
  assert.equal(byName(r, 'Data Name').type, 'rect');
  assert.equal(byName(r, 'Titled & so').type, 'rect');
  assert.ok(names.includes('Rectangle'), 'unnamed shapes get a name by type');

  assert.deepEqual(r.warnings, ['Unsupported element <foreignObject> skipped', 'Unsupported element <wibble> skipped']);
  // consistency of the flat node table
  for (const n of Object.values(r.nodes)) {
    if (n.type === 'group') for (const c of n.children) assert.equal(r.nodes[c].parent, n.id);
    else assert.ok(n.parent === '' || r.nodes[n.parent].type === 'group');
  }
});

test('throws only without an <svg> root', async () => {
  await assert.rejects(imp('<html><body><p>nope</p></body></html>'), /no <svg> root/);
  await assert.rejects(imp('this is not xml'), /no <svg> root/);
  const r = await imp(`<svg ${NS}></svg>`);
  assert.deepEqual([r.roots.length, r.width, r.height], [0, 300, 150]);
  const vb = await imp(`<svg ${NS} viewBox="0 0 40 30" width="100%"><rect width="40" height="30"/></svg>`);
  assert.deepEqual([vb.width, vb.height], [40, 30]);
});

// ---------------------------------------------------------------- css

test('CSS cascade (specificity, order, inline, !important) and inheritance', async () => {
  const r = await doc(`
    <style>
      /* comment */
      .a { fill: red }
      rect { fill: blue; stroke: lime }
      #x { fill: green }
      rect.a.b { fill: #ff0 }
      g > rect { fill: pink }
      .imp { fill: orange !important }
      @media print { rect { fill: black } }
      circle, .late { stroke-width: 7 }
      .late { fill: teal }
      .late { fill: maroon }
    </style>
    <rect id="t" width="10" height="10"/>
    <rect id="cl" class="a" width="10" height="10"/>
    <rect id="x" class="a" width="10" height="10"/>
    <rect id="ab" class="b a" width="10" height="10"/>
    <rect id="inl" class="a" style="fill: #000080; stroke:none" width="10" height="10"/>
    <rect id="at" class="a" fill="white" width="10" height="10"/>
    <rect id="im" class="imp" style="fill:white" width="10" height="10"/>
    <ellipse id="late" class="late" rx="3" ry="2"/>
    <g fill="purple" stroke="red" stroke-width="3" stroke-linecap="round" stroke-linejoin="bevel" stroke-dasharray="4 2 1" fill-opacity="0.5" stroke-opacity="0.25" color="blue" opacity="0.5" mix-blend-mode="multiply" style="mix-blend-mode:multiply">
      <ellipse id="inh" rx="5" ry="5"/>
      <ellipse id="ov" rx="5" ry="5" fill="none" stroke-width="1" stroke-dasharray="none"/>
      <ellipse id="cc" rx="5" ry="5" fill="currentColor" stroke="none"/>
      <g color="#00ff00"><ellipse id="cc2" rx="5" ry="5" fill="currentColor" stroke="inherit"/><ellipse rx="1" ry="1"/></g>
    </g>`);
  assert.deepEqual(rgb(byName(r, 't')), [0, 0, 255], 'type selector');
  assert.deepEqual(rgb(byName(r, 't'), 'strokes'), [0, 255, 0]);
  assert.deepEqual(rgb(byName(r, 'cl')), [255, 0, 0], 'class beats type');
  assert.deepEqual(rgb(byName(r, 'x')), [0, 128, 0], 'id beats class');
  assert.deepEqual(rgb(byName(r, 'ab')), [255, 255, 0], 'compound selector beats single class');
  assert.deepEqual(rgb(byName(r, 'inl')), [0, 0, 128], 'inline style beats rules');
  assert.equal(byName<ShapeNode>(r, 'inl').strokes.length, 0);
  assert.deepEqual(rgb(byName(r, 'at')), [255, 0, 0], 'rules beat presentation attributes');
  assert.deepEqual(rgb(byName(r, 'im')), [255, 165, 0], '!important beats inline');
  const late = byName<ShapeNode>(r, 'late');
  assert.deepEqual(rgb(late), [128, 0, 0], 'later rule wins at equal specificity');
  assert.equal(late.strokes.length, 0);

  const inh = byName<ShapeNode>(r, 'inh');
  assert.deepEqual(rgb(inh), [128, 0, 128]);
  assert.equal(inh.fills[0].opacity, 0.5);
  assert.deepEqual(rgb(inh, 'strokes'), [255, 0, 0]);
  assert.equal(inh.strokes[0].opacity, 0.25);
  assert.deepEqual([inh.strokeWeight, inh.strokeCap, inh.strokeJoin, inh.strokeAlign], [3, 'round', 'bevel', 'center']);
  assert.deepEqual(inh.dash, [4, 2, 1, 4, 2, 1], 'odd dash arrays repeat');
  assert.deepEqual([inh.opacity, inh.blend], [1, 'normal'], 'opacity / blend are not inherited');
  const g = r.nodes[inh.parent] as GroupNode;
  assert.deepEqual([g.type, g.opacity, g.blend], ['group', 0.5, 'multiply']);

  const ov = byName<ShapeNode>(r, 'ov');
  assert.equal(ov.fills.length, 0);
  assert.deepEqual([ov.strokeWeight, ov.dash], [1, []]);
  assert.deepEqual(rgb(byName(r, 'cc')), [0, 0, 255], 'currentColor from inherited color');
  assert.deepEqual(rgb(byName(r, 'cc2')), [0, 255, 0], 'currentColor from the nearest color');
  assert.deepEqual(rgb(byName(r, 'cc2'), 'strokes'), [255, 0, 0]);

  assert.ok(r.warnings.some(w => w.includes('g > rect')), 'combinator selectors are skipped with a warning');
  assert.ok(r.warnings.some(w => w.includes('@media')));
});

// ---------------------------------------------------------------- gradients

test('gradients: both unit modes, gradientTransform, href inheritance, stops', async () => {
  const R = 'x="50" y="20" width="200" height="100"';
  const r = await doc(`
    <defs>
      <linearGradient id="base">
        <stop offset="0" stop-color="red"/>
        <stop offset="100%" style="stop-color:#0000ff;stop-opacity:0.5"/>
      </linearGradient>
      <linearGradient id="user" href="#base" gradientUnits="userSpaceOnUse" x1="50" y1="0" x2="150" y2="0"/>
      <linearGradient id="userT" xlink:href="#user" gradientTransform="rotate(90)"/>
      <linearGradient id="userShift" xlink:href="#user" gradientTransform="translate(50 0)"/>
      <linearGradient id="obb" href="#base"/>
      <linearGradient id="obbDiag" href="#base" x1="0" y1="0" x2="1" y2="1"/>
      <linearGradient id="obbT" href="#base" gradientTransform="translate(0.25 0) scale(0.5 1)"/>
      <linearGradient id="vert" href="#base" x1="0%" y1="0%" x2="0%" y2="100%"/>
      <radialGradient id="rObb" href="#base"/>
      <radialGradient id="rUser" href="#base" gradientUnits="userSpaceOnUse" cx="100" cy="70" r="50" fx="90" fy="60"/>
      <radialGradient id="rUserT" href="#base" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(150 70) scale(100 25)"/>
      <linearGradient id="stops" spreadMethod="reflect">
        <stop offset="50%" stop-color="#fff"/><stop offset="0.2" stop-color="#000"/><stop offset="150%" stop-color="currentColor" stop-opacity="2"/>
      </linearGradient>
      <linearGradient id="one"><stop offset="0.3" stop-color="lime"/></linearGradient>
      <linearGradient id="none"/>
    </defs>
    <rect id="user" ${R} fill="url(#user)"/>
    <rect id="userT" ${R} fill="url(#userT)"/>
    <rect id="userShift" ${R} fill="url(#userShift)" fill-opacity="0.5"/>
    <rect id="obb" ${R} fill="url(#obb)"/>
    <rect id="obbDiag" ${R} fill="url(#obbDiag)"/>
    <rect id="obbT" ${R} fill="url(#obbT)"/>
    <rect id="vert" ${R} fill="url('#vert')"/>
    <rect id="rObb" ${R} fill="url(#rObb)"/>
    <rect id="rUser" ${R} fill="url(#rUser)"/>
    <rect id="rUserT" ${R} fill="url(#rUserT)"/>
    <path id="pathUser" d="M50 20 h200 v100 h-200 z" fill="url(#user)"/>
    <rect id="stops" ${R} fill="url(#stops)" color="red"/>
    <rect id="one" ${R} fill="url(#one)"/>
    <rect id="none" ${R} fill="url(#none)" stroke="url(#user)" stroke-width="4"/>
    <rect id="missing" ${R} fill="url(#nope) #00f"/>
    <rect id="missing2" ${R} fill="url(#nope)"/>`, 'width="300" height="200"');
  const grad = (name: string, which: 'fills' | 'strokes' = 'fills'): GradientPaint => {
    const p = byName<ShapeNode>(r, name)[which][0] as GradientPaint;
    assert.equal(p?.type, 'gradient', name);
    return p;
  };
  const pts = (p: GradientPaint, from: number[], to: number[]): void => {
    near(p.from.x, from[0], 1e-6, 'from.x'); near(p.from.y, from[1], 1e-6, 'from.y');
    near(p.to.x, to[0], 1e-6, 'to.x'); near(p.to.y, to[1], 1e-6, 'to.y');
  };
  // userSpaceOnUse (50,0)->(150,0) on the box (50,20,200,100)
  const user = grad('user');
  assert.equal(user.kind, 'linear');
  pts(user, [0, -0.2], [0.5, -0.2]);
  assert.deepEqual(user.stops.map(s => s.offset), [0, 1]);
  assert.deepEqual(user.stops[0].color, { r: 1, g: 0, b: 0, a: 1 });
  assert.deepEqual(user.stops[1].color, { r: 0, g: 0, b: 1, a: 0.5 });
  // rotate(90): (50,0)->(0,50), (150,0)->(0,150)
  pts(grad('userT'), [-0.25, 0.3], [-0.25, 1.3]);
  pts(grad('userShift'), [0.25, -0.2], [0.75, -0.2]);
  assert.equal(grad('userShift').opacity, 0.5, 'fill-opacity -> paint opacity');
  // objectBoundingBox defaults
  pts(grad('obb'), [0, 0], [1, 0]);
  pts(grad('vert'), [0, 0], [0, 1]);
  pts(grad('obbT'), [0.25, 0], [0.75, 0]);
  // diagonal objectBoundingBox on a 2:1 box: stop lines stay parallel to the other diagonal, the
  // renderer draws them perpendicular to from->to in pixels => to = (130,180)px = (0.4, 1.6)
  pts(grad('obbDiag'), [0, 0], [0.4, 1.6]);
  // same geometry on a path whose local origin was normalised
  pts(grad('pathUser'), [0, -0.2], [0.5, -0.2]);

  // radial objectBoundingBox on a 2:1 box: ellipse, from->to along x, width = 50px / 100px
  const rObb = grad('rObb');
  assert.equal(rObb.kind, 'radial');
  pts(rObb, [0.5, 0.5], [1, 0.5]);
  near(rObb.width, 0.5, 1e-9);
  // userSpaceOnUse circle c=(100,70) r=50: a circle in pixels (focal point ignored)
  const rUser = grad('rUser');
  pts(rUser, [0.25, 0.5], [0.5, 0.5]);
  near(rUser.width, 1, 1e-9);
  // Figma style: unit circle + gradientTransform => centre (150,70), radii 100 x 25
  const rUserT = grad('rUserT');
  pts(rUserT, [0.5, 0.5], [1, 0.5]);
  near(rUserT.width, 0.25, 1e-9);

  // offsets are clamped and made monotonic; stop-opacity clamped; currentColor resolved
  const st = grad('stops');
  assert.deepEqual(st.stops.map(s => s.offset), [0.5, 0.5, 1]);
  assert.deepEqual(st.stops[2].color, { r: 1, g: 0, b: 0, a: 1 });
  assert.ok(r.warnings.some(w => w.includes('spreadMethod="reflect"')));

  assert.deepEqual(rgb(byName(r, 'one')), [0, 255, 0], 'single stop = solid');
  const none = byName<ShapeNode>(r, 'none');
  assert.equal(none.fills.length, 0, 'gradient without stops paints nothing');
  pts(grad('none', 'strokes'), [0, -0.2], [0.5, -0.2]);
  assert.deepEqual(rgb(byName(r, 'missing')), [0, 0, 255], 'fallback colour after a missing url()');
  assert.ok(!Object.values(r.nodes).some(n => n.name === 'missing2'));
  assert.ok(r.warnings.includes('Paint server #nope not found'));
});

// ---------------------------------------------------------------- use / symbol

test('use / symbol / cycles', async () => {
  const r = await doc(`
    <defs>
      <symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol>
      <symbol id="plain"><circle cx="5" cy="5" r="5"/></symbol>
      <rect id="proto" width="5" height="5"/>
      <g id="grp" fill="blue"><rect width="2" height="2"/><rect x="3" width="2" height="2" fill="red"/></g>
    </defs>
    <use id="u1" href="#proto" x="20" y="30" fill="red"/>
    <use id="u2" xlink:href="#s" x="40" y="0" width="20" height="20" fill="lime"/>
    <use id="u3" xlink:href="#plain" transform="translate(100 50)"/>
    <use id="u4" href="#grp" x="60" y="60"/>
    <g id="cyc"><rect width="1" height="1"/><use href="#cyc"/></g>
    <use id="dangling" href="#nothing"/>
    <symbol id="direct"><rect id="notRendered" width="9" height="9"/></symbol>`);
  const u1 = byName<RectNode>(r, 'u1');
  assert.deepEqual([u1.type, u1.w, u1.h, u1.parent], ['rect', 5, 5, '']);
  matNear(u1.transform, [1, 0, 0, 1, 20, 30]);
  assert.deepEqual(rgb(u1), [255, 0, 0], 'style inherits from the <use>');
  const u2 = byName<RectNode>(r, 'u2');
  assert.deepEqual([u2.type, u2.w, u2.h], ['rect', 20, 20]);
  matNear(u2.transform, [1, 0, 0, 1, 40, 0]);
  assert.deepEqual(rgb(u2), [0, 255, 0]);
  const u3 = byName<EllipseNode>(r, 'u3');
  assert.equal(u3.type, 'ellipse');
  matNear(u3.transform, [1, 0, 0, 1, 100, 50]);
  const u4 = byName<GroupNode>(r, 'u4');
  assert.equal(u4.children.length, 2);
  matNear(u4.transform, [1, 0, 0, 1, 60, 60]);
  assert.deepEqual(u4.children.map(id => rgb(r.nodes[id] as ShapeNode)), [[0, 0, 255], [255, 0, 0]]);
  assert.ok(r.warnings.some(w => /Circular <use>/.test(w)));
  assert.ok(r.warnings.includes('<use> references missing element #nothing'));
  assert.ok(!Object.values(r.nodes).some(n => n.name === 'notRendered'));
});

test('glyph runs: consecutive <use> of path-only symbols with identical paint merge into one path', async () => {
  const r = await doc(`
    <defs>
      <symbol overflow="visible" id="glyph0-0"><path style="stroke:none;" d="M 0 0 L 4 0 L 4 -6 L 0 -6 Z"/></symbol>
      <symbol overflow="visible" id="glyph0-1"><path style="stroke:none;" d=""/></symbol>
      <g id="glyph-1-0"><path d="M 0 0 L 2 0 L 2 -2 Z M 3 0 L 4 0 L 4 -1 Z"/></g>
      <path id="bare" d="M 0 0 h 1 v 1 z"/>
    </defs>
    <g style="fill:rgb(0%,0%,100%);fill-opacity:1;">
      <use xlink:href="#glyph0-0" x="10" y="20"/>
      <use xlink:href="#glyph0-1" x="15" y="20"/>
      <use xlink:href="#glyph0-0" x="20" y="20"/>
      <use xlink:href="#glyph-1-0" transform="matrix(2,0,0,2,30,20)"/>
      <use xlink:href="#bare" x="40" y="19"/>
    </g>
    <g id="mixed">
      <use xlink:href="#glyph0-0" x="10" y="40" fill="red"/>
      <use xlink:href="#glyph0-0" x="20" y="40" fill="red"/>
      <use xlink:href="#glyph0-0" x="30" y="40" fill="lime"/>
      <use xlink:href="#glyph0-0" x="40" y="40" fill="lime"/>
      <use xlink:href="#glyph0-0" x="50" y="40" fill="red" opacity="0.5"/>
    </g>
    <use xlink:href="#glyph0-0" x="10" y="60"/>`);
  assert.equal(r.roots.length, 3);
  const t = r.nodes[r.roots[0]] as PathNode;
  assert.deepEqual([t.type, t.name, t.parent], ['path', 'Text', '']);
  assert.equal(t.subpaths.length, 5, '2 boxes + 2 triangles + 1 bare path; the empty glyph adds nothing');
  assert.deepEqual(rgb(t), [0, 0, 255]);
  const b = subpathsBounds(t.subpaths, t.transform)!;
  matNear([b.x, b.y, b.w, b.h, 0, 0], [10, 14, 31, 6, 0, 0]);
  const mixed = byName<GroupNode>(r, 'mixed');
  assert.deepEqual(mixed.children.map(id => [r.nodes[id].type, r.nodes[id].name, (r.nodes[id] as PathNode).subpaths.length, r.nodes[id].opacity]),
    [['path', 'Text', 2, 1], ['path', 'Text', 2, 1], ['path', 'Path', 1, 0.5]]);
  assert.deepEqual(mixed.children.map(id => rgb(r.nodes[id] as ShapeNode)), [[255, 0, 0], [0, 255, 0], [255, 0, 0]]);
  assert.equal(r.nodes[r.roots[2]].type, 'path', 'a single <use> is imported normally');
});

// ---------------------------------------------------------------- clip / mask

test('clip-path -> mask node, redundant rect clips are dropped, masks', async () => {
  const r = await doc(`
    <defs>
      <clipPath id="frame"><rect width="100" height="100"/></clipPath>
      <clipPath id="framePath"><path d="M 0 0 L 100 0 L 100 100 L 0 100 Z M 0 0"/></clipPath>
      <clipPath id="small"><rect x="25" y="25" width="50" height="50" fill="red" stroke="blue" opacity="0.3"/></clipPath>
      <clipPath id="circ"><circle cx="50" cy="50" r="40"/></clipPath>
      <clipPath id="two" transform="translate(5 0)"><rect width="10" height="10"/><rect x="20" width="10" height="10"/></clipPath>
      <clipPath id="obb" clipPathUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5"/></clipPath>
      <clipPath id="nothing"/>
      <mask id="lum"><rect width="100" height="100" fill="white"/><circle cx="50" cy="50" r="10" fill="black"/><rect width="10" height="10" fill="#808080"/></mask>
      <mask id="alpha" style="mask-type:alpha"><rect width="10" height="10" fill="black"/></mask>
    </defs>
    <g id="A" clip-path="url(#frame)"><rect id="a1" x="10" y="10" width="20" height="20"/><rect id="a2" x="50" y="50" width="50" height="50"/></g>
    <rect id="B" clip-path="url(#framePath)" x="10" y="10" width="20" height="20" stroke="red" stroke-width="2"/>
    <g id="C" clip-path="url(#frame)"><rect id="c1" x="90" y="10" width="20" height="20"/><rect id="c2" width="5" height="5"/></g>
    <rect id="D" clip-path="url(#circ)" width="100" height="100" fill="red" transform="translate(7 9)" opacity="0.5"/>
    <rect id="E" clip-path="url(#small)" width="100" height="100"/>
    <rect id="F" clip-path="url(#two)" width="100" height="100"/>
    <rect id="G" clip-path="url(#obb)" x="10" y="20" width="100" height="50"/>
    <rect id="H" clip-path="url(#nothing)" width="100" height="100"/>
    <rect id="I" mask="url(#lum)" width="200" height="200" fill="blue"/>
    <rect id="J" mask="url(#alpha)" width="200" height="200" fill="blue"/>
    <text id="K" clip-path="url(#frame)" x="10" y="50">unknown bounds keep the clip</text>
    <rect id="L" clip-path="url(#doesNotExist)" width="4" height="4"/>`);
  const kids = (name: string): Node[] => byName<GroupNode>(r, name).children.map(id => r.nodes[id]);
  const anyMask = (n: Node): boolean => !!n.mask || (n.type === 'group' && n.children.some(id => anyMask(r.nodes[id])));

  // redundant: the rect contains the content
  assert.deepEqual(kids('A').map(n => n.name), ['a1', 'a2']);
  assert.ok(!anyMask(byName(r, 'A')));
  const B = byName<RectNode>(r, 'B');
  assert.deepEqual([B.type, B.parent, B.mask], ['rect', '', undefined]);

  // not redundant: content sticks out of the frame
  const C = kids('C');
  assert.deepEqual(C.map(n => [n.name, n.type, !!n.mask]), [['Clip', 'rect', true], ['c1', 'rect', false], ['c2', 'rect', false]]);
  const cm = C[0] as RectNode;
  assert.deepEqual([cm.w, cm.h], [100, 100]);
  assert.deepEqual(rgb(cm), [0, 0, 0]);

  // shape + circle clip: group [mask ellipse, shape]; transform / opacity go to the group
  const D = Object.values(r.nodes).find(n => n.type === 'group' && n.name === 'D') as GroupNode;
  assert.ok(D, 'wrapper group');
  matNear(D.transform, [1, 0, 0, 1, 7, 9]);
  assert.equal(D.opacity, 0.5);
  const [dm, ds] = D.children.map(id => r.nodes[id]) as [EllipseNode, RectNode];
  assert.deepEqual([dm.type, dm.mask, dm.w, dm.h, dm.opacity], ['ellipse', true, 80, 80, 1]);
  matNear(dm.transform, [1, 0, 0, 1, 10, 10]);
  assert.deepEqual(rgb(dm), [0, 0, 0], 'clip geometry is opaque black');
  assert.equal(dm.fills[0].opacity, 1);
  assert.equal(dm.strokes.length, 0);
  assert.deepEqual([ds.type, ds.mask, ds.opacity, ds.w], ['rect', undefined, 1, 100]);
  assert.deepEqual(rgb(ds), [255, 0, 0]);

  // a rect clip that really clips; paint of clip children is ignored
  const E = Object.values(r.nodes).find(n => n.type === 'group' && n.name === 'E') as GroupNode;
  const em = r.nodes[E.children[0]] as RectNode;
  assert.deepEqual([em.mask, em.w, em.h, em.opacity, em.strokes.length], [true, 50, 50, 1, 0]);
  assert.deepEqual(rgb(em), [0, 0, 0]);
  matNear(em.transform, [1, 0, 0, 1, 25, 25]);

  // several clip children: a mask group; the clipPath transform applies
  const F = Object.values(r.nodes).find(n => n.type === 'group' && n.name === 'F') as GroupNode;
  const fm = r.nodes[F.children[0]] as GroupNode;
  assert.deepEqual([fm.type, fm.mask, fm.children.length], ['group', true, 2]);
  matNear(fm.transform, [1, 0, 0, 1, 5, 0]);
  assert.equal(r.nodes[F.children[1]].type, 'rect');

  // objectBoundingBox units
  const G = Object.values(r.nodes).find(n => n.type === 'group' && n.name === 'G') as GroupNode;
  const gm = r.nodes[G.children[0]] as EllipseNode;
  assert.deepEqual([gm.type, gm.mask, gm.w, gm.h], ['ellipse', true, 100, 50]);
  matNear(gm.transform, [1, 0, 0, 1, 10, 20]);

  assert.ok(!Object.values(r.nodes).some(n => n.name === 'H'), 'an empty clipPath hides the element');

  // luminance mask: white stays, black disappears, grey becomes partial alpha
  const I = Object.values(r.nodes).find(n => n.type === 'group' && n.name === 'I') as GroupNode;
  const im = r.nodes[I.children[0]] as GroupNode;
  assert.deepEqual([im.type, im.mask, im.children.length], ['group', true, 2]);
  const [iw, ig] = im.children.map(id => r.nodes[id] as RectNode);
  near(iw.fills[0].opacity, 1, 1e-9);
  near(ig.fills[0].opacity, 128 / 255, 1e-6);
  assert.deepEqual(rgb(r.nodes[I.children[1]] as ShapeNode), [0, 0, 255]);
  assert.deepEqual([im.maskLuminance, iw.maskLuminance], [undefined, undefined], 'solid-only luminance masks are converted to alpha exactly');
  assert.ok(!r.warnings.some(w => /mask>/.test(w)), 'no approximation, no warning');
  // alpha mask: used as-is
  const J = Object.values(r.nodes).find(n => n.type === 'group' && n.name === 'J') as GroupNode;
  const jm = r.nodes[J.children[0]] as RectNode;
  assert.deepEqual([jm.mask, jm.w, jm.fills[0].opacity], [true, 10, 1]);

  const K = Object.values(r.nodes).find(n => n.type === 'group' && n.name === 'K') as GroupNode;
  assert.deepEqual(K.children.map(id => [r.nodes[id].type, !!r.nodes[id].mask]), [['rect', true], ['text', false]]);
  assert.equal(byName(r, 'L').type, 'rect');
  assert.ok(r.warnings.includes('clip-path reference #doesNotExist not found, ignored'));
});

test('luminance masks with images keep their colours and set maskLuminance; cairo colour-matrix wrappers', async () => {
  const r = await doc(`
    <defs>
      <filter id="filter-remove-color" x="0%" y="0%" width="100%" height="100%"><feColorMatrix color-interpolation-filters="sRGB" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0"/></filter>
      <filter id="filter-color-to-alpha" x="0%" y="0%" width="100%" height="100%"><feColorMatrix color-interpolation-filters="sRGB" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0.2126 0.7152 0.0722 0 0"/></filter>
      <image id="src" width="4" height="4" xlink:href="${PNG_URI}"/>
      <mask id="plain"><image width="40" height="40" href="${PNG_URI}"/><rect width="10" height="10" fill="#ff0000" fill-opacity="0.5"/></mask>
      <mask id="cairo"><g filter="url(#filter-remove-color)"><use xlink:href="#src" filter="url(#filter-color-to-alpha)" transform="matrix(10,0,0,10,0,0)"/></g></mask>
      <mask id="oldCairo"><g filter="url(#filter-remove-color)"><use xlink:href="#src" transform="matrix(10,0,0,10,0,0)"/></g></mask>
      <mask id="alphaType" mask-type="alpha"><image width="40" height="40" href="${PNG_URI}"/><rect width="10" height="10" fill="#ff0000"/></mask>
      <mask id="alphaWithLum" style="mask-type:alpha"><use xlink:href="#src" filter="url(#filter-color-to-alpha)"/><rect width="10" height="10" fill="#ff0000" fill-opacity="0.5"/></mask>
      <mask id="solidCairo"><rect width="10" height="10" fill="#808080" filter="url(#filter-color-to-alpha)"/></mask>
    </defs>
    <rect id="P" mask="url(#plain)" width="100" height="100" fill="blue"/>
    <rect id="C" mask="url(#cairo)" width="100" height="100" fill="blue"/>
    <rect id="O" mask="url(#oldCairo)" width="100" height="100" fill="blue"/>
    <rect id="T" mask="url(#alphaType)" width="100" height="100" fill="blue"/>
    <rect id="W" mask="url(#alphaWithLum)" width="100" height="100" fill="blue"/>
    <rect id="S" mask="url(#solidCairo)" width="100" height="100" fill="blue"/>
    <rect id="outside" filter="url(#filter-color-to-alpha)" width="5" height="5"/>`);
  const maskOf = (name: string): Node => {
    const g = Object.values(r.nodes).find(n => n.type === 'group' && n.name === name) as GroupNode;
    assert.ok(g, name);
    assert.equal(g.children.length, 2);
    assert.deepEqual([r.nodes[g.children[1]].type, r.nodes[g.children[1]].mask], ['rect', undefined]);
    return r.nodes[g.children[0]];
  };
  const img = (n: Node): string => ((n as RectNode).fills[0] as ImagePaint).type;

  // plain luminance mask with an image: colours are kept, the mask node is flagged
  const p = maskOf('P') as GroupNode;
  assert.deepEqual([p.type, p.mask, p.maskLuminance], ['group', true, true]);
  const [pi, pr] = p.children.map(id => r.nodes[id] as RectNode);
  assert.equal(img(pi), 'image');
  assert.deepEqual([rgb(pr), pr.fills[0].opacity], [[255, 0, 0], 0.5], 'real colour, not converted');
  assert.deepEqual([pi.maskLuminance, pr.maskLuminance], [undefined, undefined], 'the flag sits on the mask node only');

  // cairo: remove-color(color-to-alpha(image)) == the image's luminance masks
  const c = maskOf('C') as RectNode;
  assert.deepEqual([c.type, img(c), c.mask, c.maskLuminance, c.w, c.h, c.effects], ['rect', 'image', true, true, 40, 40, []]);
  // older cairo: only the alpha of the image is used => a normal (alpha) mask
  const o = maskOf('O') as RectNode;
  assert.deepEqual([img(o), o.mask, o.maskLuminance], ['image', true, undefined]);
  // mask-type alpha: as-is
  const t = maskOf('T') as GroupNode;
  assert.deepEqual([t.mask, t.maskLuminance], [true, undefined]);
  assert.deepEqual(rgb(r.nodes[t.children[1]] as ShapeNode), [255, 0, 0]);
  // alpha mask whose image goes through color-to-alpha: luminance mask; the alpha-only rect turns white
  const w = maskOf('W') as GroupNode;
  assert.deepEqual([w.mask, w.maskLuminance], [true, true]);
  const wr = r.nodes[w.children[1]] as RectNode;
  assert.deepEqual([rgb(wr), wr.fills[0].opacity], [[255, 255, 255], 0.5]);
  // color-to-alpha on a solid: exact conversion, plain alpha mask
  const s = maskOf('S') as RectNode;
  assert.equal(s.maskLuminance, undefined);
  near(s.fills[0].opacity, 128 / 255, 1e-6);

  // only outside of a mask the wrapper filters are unsupported
  assert.deepEqual(r.warnings, ['Unsupported filter #filter-color-to-alpha ignored (feColorMatrix)']);
  assert.ok(!Object.values(r.nodes).some(n => n.maskLuminance && !n.mask));
});

// ---------------------------------------------------------------- text

test('text: baseline placement, lines, anchors, font properties', async () => {
  const body = `
    <text id="single" x="10" y="50" font-family="'Open Sans', sans-serif" font-size="20" font-weight="bold" font-style="italic" letter-spacing="2" fill="#333">Hello  <tspan fill="red">big</tspan>
      world</text>
    <text id="multi" x="10" y="50" font-size="20"><tspan x="10" y="50">A</tspan><tspan x="10" y="80">B</tspan><tspan x="10" dy="30">C</tspan></text>
    <text id="split" font-size="10"><tspan x="10" y="20">left</tspan><tspan x="100" y="20">right</tspan></text>
    <text id="mid" x="100" y="40" font-size="10" text-anchor="middle" font-weight="300">centered</text>
    <text id="end" x="100" y="40" style="font: inherit; font-size: 12pt; text-anchor: end">ended</text>
    <text id="tp" font-size="10" y="10"><textPath href="#p">on a path</textPath></text>
    <g font-size="10" transform="translate(5 5) scale(2)"><text id="scaled" x="10" y="20">scaled</text><rect width="1" height="1"/></g>
    <text id="blank" x="1" y="1">   </text>
    <text id="invisible" x="1" y="1" fill="none">x</text>`;
  const r = await doc(body);
  const s = byName<TextNode>(r, 'single');
  assert.equal(s.type, 'text');
  assert.equal(s.text, 'Hello big world');
  assert.deepEqual(s.font, { family: 'Open Sans', weight: 700, italic: true });
  assert.deepEqual([s.size, s.letterSpacing, s.lineHeight, s.w, s.align], [20, 2, null, null, 'left']);
  // y_top = baseline - ascent (default ascent = 0.8 * size)
  matNear(s.transform, [1, 0, 0, 1, 10, 34]);
  assert.deepEqual(rgb(s), [51, 51, 51]);

  const m = byName<TextNode>(r, 'multi');
  assert.equal(m.text, 'A\nB\nC');
  assert.equal(m.lineHeight, 30);
  // y_top = 50 - 16 - (30 - 20) / 2
  matNear(m.transform, [1, 0, 0, 1, 10, 29]);

  const sp = byName<GroupNode>(r, 'split');
  assert.equal(sp.type, 'group');
  const [l, rt] = sp.children.map(id => r.nodes[id] as TextNode);
  assert.deepEqual([l.text, rt.text], ['left', 'right']);
  matNear(l.transform, [1, 0, 0, 1, 10, 12]);
  matNear(rt.transform, [1, 0, 0, 1, 100, 12]);

  const mid = byName<TextNode>(r, 'mid');
  assert.deepEqual([mid.align, mid.w, mid.font.weight], ['center', null, 300]);
  matNear(mid.transform, [1, 0, 0, 1, 100, 32]);
  const end = byName<TextNode>(r, 'end');
  assert.equal(end.align, 'right');
  assert.equal(end.size, 16);
  assert.deepEqual(r.textAnchors, { [mid.id]: 'middle', [end.id]: 'end' });

  assert.equal(byName<TextNode>(r, 'tp').text, 'on a path');
  assert.ok(r.warnings.some(w => w.includes('<textPath>')));

  // uniform scale is baked into the font size; origin = (5,5) + 2 * (10, 20 - 8)
  const sc = byName<TextNode>(r, 'scaled');
  assert.equal(sc.size, 20);
  assert.deepEqual(world(r, sc).map(v => Math.round(v * 1000) / 1000), [1, 0, 0, 1, 25, 29]);
  assert.ok(!Object.values(r.nodes).some(n => n.name === 'blank' || n.name === 'invisible'));

  // custom metrics
  const r2 = await doc(body, 'width="200" height="100"');
  assert.deepEqual(byName(r2, 'single').transform, s.transform);
  const r3 = await imp(`<svg ${NS} width="200" height="100">${body}</svg>`, {
    textMetrics: (font: { family: string }, size: number) => ({ ascent: font.family === 'Open Sans' ? 0.9 * size : size, descent: 0.3 * size }),
  });
  matNear(byName(r3, 'single').transform, [1, 0, 0, 1, 10, 32]);
  // 50 - 20 - (30 - 26) / 2
  matNear(byName(r3, 'multi').transform, [1, 0, 0, 1, 10, 28]);
});

// ---------------------------------------------------------------- images, patterns

test('images: data URIs become assets, external hrefs are never fetched, nested SVG, patterns', async () => {
  const inner = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect id="innerRect" x="2" y="2" width="6" height="6" fill="red"/><circle id="innerDot" cx="1" cy="1" r="1"/></svg>`;
  const r = await doc(`
    <defs>
      <pattern id="figmaFill" patternContentUnits="objectBoundingBox" width="1" height="1"><use xlink:href="#img0" transform="scale(0.25)"/></pattern>
      <image id="img0" width="4" height="4" xlink:href="${PNG_URI}"/>
      <pattern id="tiles" patternUnits="userSpaceOnUse" width="8" height="8"><image width="8" height="8" href="${PNG_URI}"/></pattern>
      <pattern id="dots" patternUnits="userSpaceOnUse" width="4" height="4"><circle r="1"/></pattern>
    </defs>
    <image id="fit" x="10" y="20" width="40" height="20" href="${PNG_URI}"/>
    <image id="stretch" width="40" height="20" preserveAspectRatio="none" xlink:href="${PNG_URI}"/>
    <image id="slice" width="40" height="20" preserveAspectRatio="xMidYMid slice" xlink:href="${PNG_URI}"/>
    <image id="auto" x="5" y="5" href="${PNG_URI}"/>
    <image id="ext" width="10" height="10" href="https://example.com/a.png"/>
    <image id="file" width="10" height="10" href="file:///etc/passwd"/>
    <image id="junk" width="10" height="10" href="data:image/png;base64,AAAA"/>
    <image id="svgimg" x="50" y="50" width="20" height="20" href="data:image/svg+xml;base64,${Buffer.from(inner).toString('base64')}"/>
    <image id="svgutf" x="0" y="0" width="10" height="10" href="data:image/svg+xml;utf8,${encodeURIComponent(inner)}"/>
    <rect id="pat" width="50" height="50" fill="url(#figmaFill)"/>
    <rect id="tiled" width="50" height="50" fill="url(#tiles)"/>
    <rect id="dotted" width="50" height="50" fill="url(#dots)" stroke="black"/>`);
  const key = createHash('sha256').update(Buffer.from(PNG_B64, 'base64')).digest('hex').slice(0, 32) + '.png';
  assert.deepEqual([...r.assets.keys()], [key], 'identical images are stored once');
  const asset = r.assets.get(key)!;
  assert.deepEqual(asset.meta, { mime: 'image/png', w: 4, h: 4 });
  assert.deepEqual(Buffer.from(asset.bytes), Buffer.from(PNG_B64, 'base64'));

  const fit = byName<RectNode>(r, 'fit');
  assert.deepEqual([fit.type, fit.w, fit.h], ['rect', 40, 20]);
  matNear(fit.transform, [1, 0, 0, 1, 10, 20]);
  assert.deepEqual(fit.fills, [{ type: 'image', asset: key, mode: 'fit', visible: true, opacity: 1 }]);
  assert.equal((byName<RectNode>(r, 'stretch').fills[0] as ImagePaint).mode, 'stretch');
  assert.equal((byName<RectNode>(r, 'slice').fills[0] as ImagePaint).mode, 'fill');
  const auto = byName<RectNode>(r, 'auto');
  assert.deepEqual([auto.w, auto.h], [4, 4], 'natural size when width/height are missing');

  for (const gone of ['ext', 'file', 'junk']) assert.ok(!Object.values(r.nodes).some(n => n.name === gone));
  assert.ok(r.warnings.some(w => w.startsWith('External image not imported') && w.includes('https://example.com/a.png')));
  assert.ok(r.warnings.some(w => w.startsWith('External image not imported') && w.includes('file:///etc/passwd')));
  assert.ok(r.warnings.some(w => w.startsWith('Unsupported embedded image format')));

  // nested SVG: imported as a group, scaled 2x into (50,50,20,20)
  const si = byName<GroupNode>(r, 'svgimg');
  assert.equal(si.type, 'group');
  assert.equal(si.children.length, 2);
  const ir = r.nodes[si.children[0]] as RectNode;
  assert.deepEqual([ir.name, ir.w, ir.h], ['innerRect', 12, 12]);
  assert.deepEqual(world(r, ir).map(v => Math.round(v * 1000) / 1000), [1, 0, 0, 1, 54, 54]);
  assert.equal(byName<GroupNode>(r, 'svgutf').children.length, 2);

  assert.deepEqual(byName<RectNode>(r, 'pat').fills, [{ type: 'image', asset: key, mode: 'fill', visible: true, opacity: 1 }]);
  assert.deepEqual(byName<RectNode>(r, 'tiled').fills, [{ type: 'image', asset: key, mode: 'tile', visible: true, opacity: 1, scale: 2 }]);
  const dotted = byName<RectNode>(r, 'dotted');
  assert.equal(dotted.fills.length, 0);
  assert.equal(dotted.strokes.length, 1);
  assert.ok(r.warnings.some(w => w.startsWith('Unsupported <pattern> #dots skipped')));
});

// ---------------------------------------------------------------- filters

test('filters: blur, feDropShadow, unsupported', async () => {
  const r = await doc(`
    <defs>
      <filter id="blur"><feGaussianBlur stdDeviation="4"/></filter>
      <filter id="ds"><feDropShadow dx="2" dy="3" stdDeviation="2" flood-color="red" flood-opacity="0.5"/></filter>
      <filter id="weird"><feTurbulence baseFrequency="0.1"/><feDisplacementMap in="SourceGraphic" scale="5"/></filter>
    </defs>
    <rect id="b" width="10" height="10" filter="url(#blur)"/>
    <g id="g" filter="url(#ds)"><rect width="10" height="10"/><rect width="5" height="5"/></g>
    <rect id="w" width="10" height="10" filter="url(#weird)"/>
    <rect id="w2" width="10" height="10" style="filter:blur(4px)"/>`);
  assert.deepEqual(byName(r, 'b').effects, [{ type: 'layer-blur', visible: true, blur: 8 }]);
  assert.deepEqual(byName(r, 'g').effects, [{ type: 'drop-shadow', visible: true, x: 2, y: 3, blur: 4, spread: 0, color: { r: 1, g: 0, b: 0, a: 0.5 } }]);
  assert.deepEqual(byName(r, 'w').effects, []);
  assert.deepEqual(r.warnings, ['Unsupported filter #weird ignored (feTurbulence, feDisplacementMap)', 'Unsupported filter "blur(4px)" ignored']);
});

// ---------------------------------------------------------------- real-world: export styles

test('Figma-style export', async () => {
  const r = await imp(`<svg width="200" height="120" viewBox="0 0 200 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<g clip-path="url(#clip0_1_2)">
<rect width="200" height="120" fill="white"/>
<g filter="url(#filter0_d_1_2)">
<rect x="20" y="20" width="80" height="40" rx="8" fill="url(#paint0_linear_1_2)"/>
</g>
<g filter="url(#filter1_i_1_2)">
<circle cx="150" cy="60" r="30" fill="#D9D9D9"/>
</g>
<path d="M120 100L140 110" stroke="black" stroke-opacity="0.8" stroke-width="2" stroke-linecap="round"/>
<g opacity="0.5" filter="url(#filter2_f_1_2)">
<path fill-rule="evenodd" clip-rule="evenodd" d="M10 80H50V110H10V80ZM20 90V100H40V90H20Z" fill="#FF00FF"/>
</g>
</g>
<defs>
<filter id="filter0_d_1_2" x="16" y="20" width="88" height="48" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
<feFlood flood-opacity="0" result="BackgroundImageFix"/>
<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
<feMorphology radius="1" operator="dilate" in="SourceAlpha" result="effect1_dropShadow_1_2"/>
<feOffset dy="4"/>
<feGaussianBlur stdDeviation="2"/>
<feComposite in2="hardAlpha" operator="out"/>
<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0.5 0 0 0 0 1 0 0 0 0.25 0"/>
<feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_1_2"/>
<feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_1_2" result="shape"/>
</filter>
<filter id="filter1_i_1_2" x="120" y="30" width="60" height="64" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
<feFlood flood-opacity="0" result="BackgroundImageFix"/>
<feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
<feOffset dx="1" dy="4"/>
<feGaussianBlur stdDeviation="3"/>
<feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
<feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0.4 0"/>
<feBlend mode="normal" in2="shape" result="effect1_innerShadow_1_2"/>
</filter>
<filter id="filter2_f_1_2" x="6" y="76" width="48" height="38" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
<feFlood flood-opacity="0" result="BackgroundImageFix"/>
<feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
<feGaussianBlur stdDeviation="1" result="effect1_foregroundBlur_1_2"/>
</filter>
<linearGradient id="paint0_linear_1_2" x1="60" y1="20" x2="60" y2="60" gradientUnits="userSpaceOnUse">
<stop stop-color="#FF0000"/>
<stop offset="1" stop-color="#0000FF" stop-opacity="0"/>
</linearGradient>
<clipPath id="clip0_1_2">
<rect width="200" height="120" fill="white"/>
</clipPath>
</defs>
</svg>`);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual([r.width, r.height], [200, 120]);
  // the frame clip is redundant and the <g filter> wrappers collapse: 5 plain root shapes
  assert.equal(Object.keys(r.nodes).length, 5);
  assert.ok(Object.values(r.nodes).every(n => !n.mask && n.parent === ''));
  const [bg, card, dot, line, blurred] = r.roots.map(id => r.nodes[id]) as [RectNode, RectNode, EllipseNode, PathNode, PathNode];
  assert.deepEqual([bg.type, bg.w, bg.h], ['rect', 200, 120]);
  assert.deepEqual(rgb(bg), [255, 255, 255]);

  assert.deepEqual([card.type, card.w, card.h, card.radii], ['rect', 80, 40, [8, 8, 8, 8]]);
  matNear(card.transform, [1, 0, 0, 1, 20, 20]);
  assert.deepEqual(card.effects, [{ type: 'drop-shadow', visible: true, color: { r: 0, g: 0.5, b: 1, a: 0.25 }, x: 0, y: 4, blur: 4, spread: 1 }]);
  const g = card.fills[0] as GradientPaint;
  assert.deepEqual([g.type, g.kind, g.from, g.to], ['gradient', 'linear', { x: 0.5, y: 0 }, { x: 0.5, y: 1 }]);
  assert.deepEqual(g.stops, [{ offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { offset: 1, color: { r: 0, g: 0, b: 1, a: 0 } }]);

  assert.deepEqual([dot.type, dot.w, dot.h], ['ellipse', 60, 60]);
  assert.deepEqual(dot.effects, [{ type: 'inner-shadow', visible: true, color: { r: 1, g: 0, b: 0, a: 0.4 }, x: 1, y: 4, blur: 6, spread: 0 }]);
  assert.deepEqual(rgb(dot), [217, 217, 217]);

  assert.deepEqual([line.type, line.fills.length, line.strokeWeight, line.strokeCap, line.strokes[0].opacity], ['path', 0, 2, 'round', 0.8]);
  matNear(line.transform, [1, 0, 0, 1, 120, 100]);

  // opacity + filter on a group with one child move onto the child
  assert.deepEqual([blurred.opacity, blurred.effects], [0.5, [{ type: 'layer-blur', visible: true, blur: 2 }]]);
  assert.deepEqual([blurred.type, blurred.fillRule, blurred.subpaths.length], ['path', 'evenodd', 2]);
  assert.deepEqual(rgb(blurred), [255, 0, 255]);
});

test('Inkscape-style export', async () => {
  const r = await imp(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<svg width="210mm" height="297mm" viewBox="0 0 210 297" version="1.1" id="svg5"
   inkscape:version="1.2.2" sodipodi:docname="drawing.svg"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns:xlink="http://www.w3.org/1999/xlink" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">
  <sodipodi:namedview id="namedview7" pagecolor="#ffffff" bordercolor="#666666" inkscape:zoom="0.5" inkscape:current-layer="layer1">
    <inkscape:grid type="xygrid" id="grid1"/>
  </sodipodi:namedview>
  <defs id="defs2">
    <linearGradient inkscape:collect="always" id="linearGradient100">
      <stop style="stop-color:#ff0000;stop-opacity:1;" offset="0" id="stop96"/>
      <stop style="stop-color:#0000ff;stop-opacity:0.5;" offset="1" id="stop98"/>
    </linearGradient>
    <linearGradient inkscape:collect="always" xlink:href="#linearGradient100" id="linearGradient102" x1="10" y1="10" x2="50" y2="10" gradientUnits="userSpaceOnUse"/>
  </defs>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1" transform="translate(5,5)">
    <rect style="fill:url(#linearGradient102);fill-opacity:1;stroke:#000000;stroke-width:0.5;stroke-dasharray:1, 2;stroke-dashoffset:0"
       id="rect10" width="40" height="20" x="10" y="10" ry="2"/>
    <g id="g20" transform="rotate(90)">
      <path style="fill:none;stroke:#00ff00;stroke-width:1;stroke-linecap:round;stroke-linejoin:round;stroke-opacity:1"
         d="m 10,-10 5,5 -5,5" id="path12" sodipodi:nodetypes="ccc" inkscape:label="Chevron"/>
    </g>
    <text xml:space="preserve" style="font-size:4px;line-height:1.25;font-family:'DejaVu Sans';-inkscape-font-specification:'DejaVu Sans';fill:#000000;stroke:none"
       x="10" y="50" id="text30"><tspan sodipodi:role="line" id="tspan28" x="10" y="50">Hello</tspan><tspan sodipodi:role="line" id="tspan29" x="10" y="55">World</tspan></text>
    <svg:circle cx="100" cy="100" r="5" style="fill:#abcdef" id="circle9"/>
  </g>
  <g inkscape:label="Hidden layer" inkscape:groupmode="layer" id="layer2" style="display:none"><rect width="10" height="10" id="rect99"/></g>
</svg>`);
  assert.deepEqual(r.warnings, [], 'sodipodi / inkscape elements are skipped silently');
  const K = 96 / 25.4; // px per mm
  near(r.width, 210 * K); near(r.height, 297 * K);
  assert.equal(r.roots.length, 1);
  const layer = byName<GroupNode>(r, 'Layer 1');
  assert.equal(layer.id, r.roots[0]);
  assert.equal(layer.children.length, 4);
  // the viewBox scale is pushed into the children; the layer keeps a plain translation
  matNear(layer.transform, [1, 0, 0, 1, 5 * K, 5 * K]);
  const [rect, chevron, text, circle] = layer.children.map(id => r.nodes[id]) as [RectNode, PathNode, TextNode, EllipseNode];

  assert.deepEqual([rect.type, rect.name], ['rect', 'Rectangle']);
  near(rect.w, 40 * K); near(rect.h, 20 * K); near(rect.radii[0], 2 * K);
  matNear(rect.transform, [1, 0, 0, 1, 10 * K, 10 * K]);
  near(rect.strokeWeight, 0.5 * K);
  matNear(rect.dash as unknown as Mat, [K, 2 * K]);
  const g = rect.fills[0] as GradientPaint;
  assert.equal(g.kind, 'linear');
  matNear([g.from.x, g.from.y, g.to.x, g.to.y, 0, 0], [0, 0, 1, 0, 0, 0], 1e-9);
  assert.deepEqual(g.stops.map(s => s.color), [{ r: 1, g: 0, b: 0, a: 1 }, { r: 0, g: 0, b: 1, a: 0.5 }]);

  assert.deepEqual([chevron.type, chevron.name, chevron.fills.length, chevron.strokeCap, chevron.strokeJoin], ['path', 'Chevron', 0, 'round', 'round']);
  assert.deepEqual(rgb(chevron, 'strokes'), [0, 255, 0]);
  near(chevron.strokeWeight, K);
  near(rotationOf(chevron.transform), Math.PI / 2, 1e-6);
  // rotate(90) maps (10,-10),(15,-5),(10,0) to (10,10),(5,15),(0,10); plus the layer offset, in mm * K
  const wb = worldBounds(r, chevron)!;
  matNear([wb.x, wb.y, wb.w, wb.h, 0, 0], [5 * K, 15 * K, 10 * K, 5 * K, 0, 0]);

  assert.deepEqual([text.type, text.text, text.font.family, text.align], ['text', 'Hello\nWorld', 'DejaVu Sans', 'left']);
  near(text.size, 4 * K); near(text.lineHeight!, 5 * K);
  // y_top = 50 - 3.2 - (5 - 4) / 2 = 46.3 mm
  matNear(text.transform, [1, 0, 0, 1, 10 * K, 46.3 * K]);

  assert.deepEqual([circle.type, rgb(circle)], ['ellipse', [0xab, 0xcd, 0xef]]);
  near(circle.w, 10 * K);
});

test('Illustrator-style export', async () => {
  const r = await imp(`<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 27.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
	 viewBox="0 0 100 100" style="enable-background:new 0 0 100 100;" xml:space="preserve">
<style type="text/css">
	.st0{fill:#FF0000;}
	.st1{fill:none;stroke:#0000FF;stroke-width:2;stroke-miterlimit:10;}
	.st2{opacity:0.5;fill:#00FF00;}
	.st3{font-family:'MyriadPro-Regular';}
	.st4{font-size:12px;}
	.st5{fill:url(#SVGID_1_);}
</style>
<switch>
	<foreignObject requiredExtensions="http://ns.adobe.com/AdobeIllustrator/10.0/" x="0" y="0" width="1" height="1">
	</foreignObject>
	<g>
		<g id="Shapes_x20_Layer">
			<rect id="Red_x5F_Box" x="10" y="10" class="st0" width="30" height="30"/>
			<circle class="st1" cx="70" cy="30" r="15"/>
			<polygon id="Tri_1_" class="st2" points="50,60 70,90 30,90 "/>
			<linearGradient id="SVGID_1_" gradientUnits="userSpaceOnUse" x1="80" y1="60" x2="100" y2="60">
				<stop  offset="0" style="stop-color:#FFFFFF"/>
				<stop  offset="1" style="stop-color:#000000"/>
			</linearGradient>
			<rect x="80" y="60" class="st5" width="20" height="10"/>
		</g>
		<text transform="matrix(1 0 0 1 10 95)" class="st3 st4">Label</text>
	</g>
</switch>
</svg>`);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual([r.width, r.height], [100, 100]);
  assert.deepEqual(r.roots.map(id => [r.nodes[id].type, r.nodes[id].name]), [['group', 'Shapes Layer'], ['text', 'Label']]);
  const layer = byName<GroupNode>(r, 'Shapes Layer');
  const [box, ring, tri, grad] = layer.children.map(id => r.nodes[id]) as [RectNode, EllipseNode, PathNode, RectNode];
  assert.deepEqual([box.name, box.type, box.w, rgb(box)], ['Red_Box', 'rect', 30, [255, 0, 0]]);
  matNear(box.transform, [1, 0, 0, 1, 10, 10]);
  assert.deepEqual([ring.type, ring.fills.length, ring.strokeWeight, rgb(ring, 'strokes')], ['ellipse', 0, 2, [0, 0, 255]]);
  matNear(ring.transform, [1, 0, 0, 1, 55, 15]);
  assert.deepEqual([tri.name, tri.type, tri.opacity, rgb(tri)], ['Tri_1_', 'path', 0.5, [0, 255, 0]]);
  matNear(tri.transform, [1, 0, 0, 1, 30, 60]);
  const gp = grad.fills[0] as GradientPaint;
  assert.deepEqual([gp.from, gp.to], [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  const text = r.nodes[r.roots[1]] as TextNode;
  assert.deepEqual([text.text, text.font.family, text.size], ['Label', 'MyriadPro-Regular', 12]);
  matNear(text.transform, [1, 0, 0, 1, 10, 95 - 9.6]);
});

// ---------------------------------------------------------------- real-world: pdftocairo

/** minimal hand-written one-page PDF: two lines of Helvetica text, a filled rect, a stroked
 *  polyline and a 4x4 RGB image */
function makePdf(): Buffer {
  const img = Buffer.alloc(4 * 4 * 3);
  for (let i = 0; i < 16; i++) { img[i * 3] = (i % 4) * 80; img[i * 3 + 1] = Math.floor(i / 4) * 80; img[i * 3 + 2] = 128; }
  const content = Buffer.from(
    '1 0 0 rg\n100 100 200 150 re f\n0 0 1 RG 3 w 50 50 m 150 80 l 250 50 l S\n' +
    'BT /F1 24 Tf 0 g 72 700 Td (Hello vibesketch, hello PDF import) Tj 0 -30 Td (Second line of text here) Tj ET\n' +
    'q 100 0 0 100 300 400 cm /Im1 Do Q\n', 'latin1');
  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> >>'),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${img.length} >>\nstream\n`), img, Buffer.from('\nendstream')]),
  ];
  const parts = [Buffer.from('%PDF-1.4\n%\xff\xff\xff\xff\n', 'latin1')];
  const offs: number[] = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    offs.push(pos); pos += b.length; parts.push(b);
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) xref += String(o).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

/** one page: blue background, a 4x4 RGB image with a 4x4 gray /SMask (a transparent image) */
function makeSoftMaskPdf(): Buffer {
  const img = Buffer.alloc(4 * 4 * 3), sm = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) { img[i * 3] = 255; img[i * 3 + 1] = (i % 4) * 80; img[i * 3 + 2] = 0; sm[i] = Math.floor(i / 4) * 85; }
  const content = Buffer.from('0 0 1 rg\n0 0 200 200 re f\nq 100 0 0 100 50 50 cm /Im1 Do Q\n', 'latin1');
  const stream = (dict: string, data: Buffer): Buffer => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);
  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>'),
    stream('', content),
    stream('/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 6 0 R', img),
    stream('/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8', sm),
  ];
  const parts = [Buffer.from('%PDF-1.4\n%\xff\xff\xff\xff\n', 'latin1')];
  const offs: number[] = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    offs.push(pos); pos += b.length; parts.push(b);
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) xref += String(o).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

const hasPdftocairo = spawnSync('pdftocairo', ['-v']).error === undefined;

test('real pdftocairo output: glyphs merge, content lands where the PDF put it', { skip: !hasPdftocairo && 'pdftocairo not on PATH' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vsk-svgimport-'));
  let svg: string;
  try {
    writeFileSync(join(dir, 'in.pdf'), makePdf());
    execFileSync('pdftocairo', ['-svg', join(dir, 'in.pdf'), join(dir, 'out.svg')]);
    svg = readFileSync(join(dir, 'out.svg'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const uses = (svg.match(/<use /g) ?? []).length;
  assert.ok(uses >= 50, `expected one <use> per glyph in the source, got ${uses}`);

  const r = await imp(svg);
  assert.deepEqual(r.warnings, []);
  const PT = 4 / 3; // the SVG is 595pt x 842pt with a 595 x 842 viewBox
  near(r.width, 595 * PT); near(r.height, 842 * PT);

  const nodes = Object.values(r.nodes);
  assert.ok(nodes.length <= 6, `glyph runs must be merged, got ${nodes.length} nodes for ${uses} glyph uses`);
  assert.ok(nodes.every(n => n.parent === '' && !n.mask), 'flat list of root shapes, page clip dropped');

  // red rect: PDF (100,100)-(300,250), y up => SVG pt (100,592)-(300,742)
  const red = nodes.find(n => n.type !== 'group' && n.fills[0]?.type === 'solid' && n.fills[0].color.r === 1 && n.fills[0].color.g === 0) as PathNode;
  assert.ok(red);
  const rb = worldBounds(r, red)!;
  matNear([rb.x, rb.y, rb.w, rb.h, 0, 0], [100 * PT, 592 * PT, 200 * PT, 150 * PT, 0, 0], 0.01);
  matNear(red.transform, [1, 0, 0, 1, 100 * PT, 592 * PT], 0.01);

  // blue polyline: stroke 3pt, PDF y 50..80 => SVG pt y 762..792 (flip baked into the geometry)
  const blue = nodes.find(n => n.type === 'path' && n.strokes.length === 1) as PathNode;
  assert.deepEqual([blue.fills.length, rgb(blue, 'strokes')], [0, [0, 0, 255]]);
  near(blue.strokeWeight, 3 * PT);
  matNear(blue.transform, [1, 0, 0, 1, 50 * PT, 762 * PT], 0.01);
  const bb = subpathsBounds(blue.subpaths)!;
  matNear([bb.x, bb.y, bb.w, bb.h, 0, 0], [0, 0, 200 * PT, 30 * PT, 0, 0], 0.01);

  // text: merged glyph outlines, black, baselines at SVG pt y = 142 and 172, starting at x = 72
  const texts = nodes.filter(n => n.name === 'Text') as PathNode[];
  assert.ok(texts.length >= 1 && texts.length <= 2);
  assert.ok(texts.every(t => t.type === 'path' && t.subpaths.length > 20), 'compound paths holding many glyph outlines');
  // expected contour count, straight from the source: closed subpaths per glyph definition * its uses
  const contours = new Map<string, number>();
  for (const m of svg.matchAll(/<(?:g|symbol)[^>]*\bid="(glyph[^"]*)"[^>]*>\s*(?:<path[^>]*\bd="([^"]*)"[^>]*\/>)?/g)) contours.set(m[1], (m[2]?.match(/Z/g) ?? []).length);
  let expected = 0;
  for (const m of svg.matchAll(/<use xlink:href="#(glyph[^"]*)"/g)) expected += contours.get(m[1]) ?? NaN;
  assert.ok(expected > 50);
  assert.equal(texts.reduce((s, t) => s + t.subpaths.length, 0), expected, 'all glyph contours are present');
  const tb = texts.map(t => worldBounds(r, t)).reduce<Box | null>(union, null)!;
  near(tb.x, 72 * PT, 3 * PT, 'text left edge');
  assert.ok(tb.y > (142 - 24) * PT && tb.y < (142 - 14) * PT, `text top ${tb.y}`);
  assert.ok(tb.y + tb.h > 172 * PT && tb.y + tb.h < (172 + 8) * PT, `text bottom ${tb.y + tb.h}`);
  assert.ok(tb.w > 300 * PT && tb.w < 420 * PT, `text width ${tb.w}`);

  // image: 100pt square at PDF (300,400) => SVG pt (300,342)
  const img = nodes.find(n => n.type === 'rect' && n.fills[0]?.type === 'image') as RectNode;
  assert.ok(img);
  near(img.w, 100 * PT, 0.01); near(img.h, 100 * PT, 0.01);
  matNear(img.transform, [1, 0, 0, 1, 300 * PT, 342 * PT], 0.01);
  assert.equal(r.assets.size, 1);
  const [key, asset] = [...r.assets][0];
  assert.match(key, /^[a-f0-9]{32}\.png$/);
  assert.equal((img.fills[0] as ImagePaint).asset, key);
  assert.deepEqual(asset.meta, { mime: 'image/png', w: 4, h: 4 });

  // overall content bounds: exactly the union of what the PDF drew, inside the page
  const all = nodes.map(n => worldBounds(r, n)).reduce<Box | null>(union, null)!;
  near(all.x, 50 * PT, 0.01, 'content left');
  near(all.x + all.w, Math.max(400 * PT, tb.x + tb.w), 1e-6, 'content right');
  near(all.y, tb.y, 1e-6, 'content top');
  near(all.y + all.h, 792 * PT, 0.01, 'content bottom');
  assert.ok(all.x >= 0 && all.y >= 0 && all.x + all.w <= r.width && all.y + all.h <= r.height);
});

test('real pdftocairo output: PDF soft mask (/SMask) -> luminance mask node + image', { skip: !hasPdftocairo && 'pdftocairo not on PATH' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vsk-svgimport-'));
  let svg: string;
  try {
    writeFileSync(join(dir, 'in.pdf'), makeSoftMaskPdf());
    execFileSync('pdftocairo', ['-svg', join(dir, 'in.pdf'), join(dir, 'out.svg')]);
    svg = readFileSync(join(dir, 'out.svg'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // what this test is about must really be in the source
  assert.match(svg, /<mask /);
  assert.match(svg, /mask="url\(#/);
  assert.match(svg, /0\.2126 0\.7152 0\.0722 0 0/, 'cairo color-to-alpha filter');

  const r = await imp(svg);
  assert.deepEqual(r.warnings, []);
  const PT = 4 / 3;
  assert.equal(r.roots.length, 2);
  const [bg, grp] = r.roots.map(id => r.nodes[id]) as [RectNode, GroupNode];
  assert.deepEqual([bg.type, rgb(bg)], ['rect', [0, 0, 255]]);
  assert.equal(grp.type, 'group');
  assert.equal(Object.keys(r.nodes).length, 4);
  const [mask, image] = grp.children.map(id => r.nodes[id]) as [RectNode, RectNode];
  for (const n of [mask, image]) {
    assert.equal(n.type, 'rect');
    assert.equal(n.fills.length, 1);
    assert.equal(n.fills[0].type, 'image');
    assert.equal(n.strokes.length, 0);
    assert.deepEqual(n.effects, []);
    near(n.w, 100 * PT, 0.01); near(n.h, 100 * PT, 0.01);
    // PDF (50,50)-(150,150) on a 200pt page => SVG pt (50,50)
    matNear(world(r, n), [1, 0, 0, 1, 50 * PT, 50 * PT], 0.01);
  }
  assert.deepEqual([mask.mask, mask.maskLuminance], [true, true], 'the soft mask is a luminance mask in front of the image');
  assert.deepEqual([image.mask, image.maskLuminance], [undefined, undefined]);
  // no opaque black box anywhere
  for (const n of Object.values(r.nodes)) {
    if (n.type === 'group') continue;
    assert.ok(!n.fills.some(p => p.type === 'solid' && p.color.r + p.color.g + p.color.b === 0), 'no black fill');
  }
  // the mask uses the gray soft-mask image (PNG colour type 0), the content the RGB one (type 2)
  assert.equal(r.assets.size, 2);
  const png = (n: RectNode): ImportedAssetLike => r.assets.get((n.fills[0] as ImagePaint).asset)!;
  assert.deepEqual([png(mask).meta, png(mask).bytes[25]], [{ mime: 'image/png', w: 4, h: 4 }, 0]);
  assert.deepEqual([png(image).meta, png(image).bytes[25]], [{ mime: 'image/png', w: 4, h: 4 }, 2]);
});
type ImportedAssetLike = { bytes: Uint8Array; meta: { mime: string; w?: number; h?: number } };
