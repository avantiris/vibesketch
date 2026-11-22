import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { zipSync, deflateSync } from 'fflate';
import { importFig, parseFontStyle } from '../src/io/fig.ts';
import type { FigImport } from '../src/io/fig.ts';
import { parseCommandsBlob, parseVectorNetwork, networkToSubpaths, matchFill } from '../src/io/fig/geometry.ts';
import { sniffImage } from '../src/io/fig/image.ts';
import { nodeSubpaths, subpathsBounds, rectSubpaths } from '../src/core/path.ts';
import type { Node, Paint } from '../src/core/model.ts';

const FILES = ['/home/linus/Downloads/Selaiman.fig', '/home/linus/Downloads/Selaiman(1).fig', '/home/linus/Downloads/Selaiman(2).fig'];
const KEY_RE = /^[a-f0-9]{8,64}\.[a-z0-9]{1,8}$/;

const finite = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

function checkPaints(paints: Paint[], res: FigImport, where: string): void {
  for (const p of paints) {
    assert.ok(finite(p.opacity) && p.opacity >= 0 && p.opacity <= 1, `${where}: paint opacity`);
    assert.equal(typeof p.visible, 'boolean');
    if (p.type === 'solid') {
      for (const c of [p.color.r, p.color.g, p.color.b, p.color.a]) assert.ok(finite(c) && c >= 0 && c <= 1, `${where}: color`);
    } else if (p.type === 'gradient') {
      assert.ok(p.stops.length > 0, `${where}: gradient stops`);
      for (const s of p.stops) assert.ok(finite(s.offset) && s.offset >= 0 && s.offset <= 1, `${where}: stop offset`);
      for (const v of [p.from.x, p.from.y, p.to.x, p.to.y, p.width]) assert.ok(finite(v), `${where}: gradient geometry`);
      assert.ok(p.width > 0, `${where}: gradient width`);
      assert.ok(Math.hypot(p.to.x - p.from.x, p.to.y - p.from.y) > 0, `${where}: gradient has a direction`);
    } else {
      assert.match(p.asset, KEY_RE, `${where}: asset key`);
      assert.ok(res.doc.assets[p.asset], `${where}: asset meta exists`);
      assert.ok(res.assets.has(p.asset), `${where}: asset bytes exist`);
    }
  }
}

function checkImport(res: FigImport): { counts: Record<string, number> } {
  const { doc } = res;
  assert.equal(doc.version, 1);
  assert.ok(doc.pages.length >= 1, 'has pages');
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  const visit = (parent: string, ids: string[]): void => {
    for (const id of ids) {
      const n: Node = doc.nodes[id];
      assert.ok(n, `child ${id} of ${parent} exists`);
      assert.ok(!seen.has(id), `node ${id} is referenced once`);
      seen.add(id);
      assert.equal(n.id, id);
      assert.equal(n.parent, parent, `parent of "${n.name}"`);
      counts[n.type] = (counts[n.type] ?? 0) + 1;
      const where = `${n.type} "${n.name}"`;
      assert.equal(n.transform.length, 6);
      for (const v of n.transform) assert.ok(finite(v), `${where}: transform`);
      assert.ok(Math.abs(n.transform[0] * n.transform[3] - n.transform[1] * n.transform[2]) > 1e-12, `${where}: transform is invertible`);
      assert.ok(finite(n.opacity) && n.opacity >= 0 && n.opacity <= 1, `${where}: opacity`);
      assert.equal(typeof n.name, 'string');
      for (const e of n.effects) {
        for (const [k, v] of Object.entries(e)) if (typeof v === 'number') assert.ok(finite(v) && (k === 'x' || k === 'y' || k === 'spread' || v >= 0), `${where}: effect ${e.type}.${k}`);
      }
      if (n.type === 'group') { visit(id, n.children); continue; }
      checkPaints(n.fills, res, where);
      checkPaints(n.strokes, res, where);
      assert.ok(finite(n.strokeWeight) && n.strokeWeight >= 0, `${where}: strokeWeight`);
      for (const d of n.dash) assert.ok(finite(d) && d >= 0);
      if (n.type === 'text') {
        assert.ok(finite(n.size) && n.size > 0, `${where}: font size`);
        assert.ok(n.lineHeight === null || (finite(n.lineHeight) && n.lineHeight >= 0));
        assert.ok(n.w === null || (finite(n.w) && n.w >= 0));
        assert.ok(finite(n.letterSpacing));
        assert.ok(n.font.family.length > 0 && n.font.weight >= 100 && n.font.weight <= 900);
        continue;
      }
      if (n.type === 'path') {
        assert.ok(n.subpaths.length > 0, `${where}: has subpaths`);
        for (const sp of n.subpaths) {
          assert.ok(sp.pts.length > 0, `${where}: subpath has points`);
          for (const p of sp.pts) {
            assert.ok(finite(p.x) && finite(p.y), `${where}: point`);
            for (const hnd of [p.in, p.out]) if (hnd) assert.ok(finite(hnd.x) && finite(hnd.y), `${where}: handle`);
          }
        }
        const b = subpathsBounds(n.subpaths);
        assert.ok(b && finite(b.w) && finite(b.h) && b.w + b.h > 0, `${where}: non-empty bounds`);
      } else {
        assert.ok(finite(n.w) && finite(n.h) && n.w >= 0 && n.h >= 0 && n.w + n.h > 0, `${where}: size`);
        if (n.type === 'rect') for (const r of n.radii) assert.ok(finite(r) && r >= 0);
        if (n.type === 'star') assert.ok(n.points >= 3 && n.inner > 0 && n.inner <= 1);
        if (n.type === 'polygon') assert.ok(n.sides >= 3);
        assert.ok(nodeSubpaths(n).length > 0);
      }
    }
  };
  for (const p of doc.pages) {
    assert.ok(p.id && typeof p.name === 'string');
    for (const c of [p.background.r, p.background.g, p.background.b, p.background.a]) assert.ok(finite(c));
    visit(p.id, p.children);
  }
  assert.equal(seen.size, Object.keys(doc.nodes).length, 'no orphan nodes');
  for (const [key, a] of res.assets) {
    assert.match(key, KEY_RE);
    assert.deepEqual(doc.assets[key], a.meta);
    assert.ok(a.bytes.length > 0);
    assert.ok(a.meta.mime.startsWith('image/'));
    assert.ok(finite(a.meta.w) && finite(a.meta.h) && a.meta.w! > 0 && a.meta.h! > 0, 'image size parsed');
    assert.equal(key.split('.')[1], sniffImage(a.bytes)!.ext);
  }
  assert.equal(Object.keys(doc.assets).length, res.assets.size);
  assert.equal(new Set(res.warnings).size, res.warnings.length, 'warnings are deduplicated');
  // must survive a JSON round trip unchanged (doc.json is the on-disk format)
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
  return { counts };
}

for (const file of FILES) {
  test(`imports ${file}`, { skip: existsSync(file) ? false : 'file not present' }, async () => {
    const res = await importFig(new Uint8Array(readFileSync(file)));
    const { counts } = checkImport(res);
    assert.ok(Object.keys(res.doc.nodes).length > 100, 'has a substantial number of layers');
    assert.ok(counts.path > 0 && counts.group > 0 && counts.rect > 0 && counts.ellipse > 0 && counts.text > 0);
    assert.equal(res.doc.pages.length, 1, 'internal canvas is skipped');
    assert.equal(res.doc.pages[0].name, 'Page 1');
  });
}

test('rejects files that are not .fig', async () => {
  await assert.rejects(importFig(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), /Not a Figma/);
  await assert.rejects(importFig(zipSync({ 'hello.txt': new Uint8Array([104, 105]) })), /canvas\.fig/);
  const junk = new Uint8Array(40);
  junk.set(new TextEncoder().encode('fig-kiwi'));
  await assert.rejects(importFig(junk), /Corrupt|decode/);
  const bad = deflateSync(new Uint8Array([9, 9, 9, 9]));
  const file = new Uint8Array(12 + 2 * (4 + bad.length));
  file.set(new TextEncoder().encode('fig-kiwi'));
  const dv = new DataView(file.buffer);
  dv.setUint32(12, bad.length, true); file.set(bad, 16);
  dv.setUint32(16 + bad.length, bad.length, true); file.set(bad, 20 + bad.length);
  await assert.rejects(importFig(file), /Could not decode/);
});

test('commands blob parsing', () => {
  const buf = new ArrayBuffer(1 + 8 + 1 + 8 + 1 + 24 + 1);
  const dv = new DataView(buf);
  let o = 0;
  const put = (cmd: number, ...args: number[]) => { dv.setUint8(o++, cmd); for (const a of args) { dv.setFloat32(o, a, true); o += 4; } };
  put(1, 0, 0); put(2, 10, 0); put(4, 10, 5, 5, 10, 0, 10); put(0);
  const sps = parseCommandsBlob(new Uint8Array(buf))!;
  assert.equal(sps.length, 1);
  assert.equal(sps[0].closed, true);
  assert.equal(sps[0].pts.length, 3);
  assert.deepEqual(sps[0].pts[1].out, { x: 0, y: 5 });
  assert.equal(parseCommandsBlob(new Uint8Array([7])), null);
  assert.equal(parseCommandsBlob(new Uint8Array([1, 0, 0])), null);
});

test('vector network chaining', () => {
  // square 0-1-2-3 (closed) + open polyline 4-5-6, vertices: u32 style, f32 x, f32 y
  const verts = [[0, 0], [10, 0], [10, 10], [0, 10], [20, 0], [30, 0], [30, 10]];
  const segs = [[0, 1], [1, 2], [3, 2], [3, 0], [5, 4], [5, 6]];
  const buf = new ArrayBuffer(12 + verts.length * 12 + segs.length * 28 + 8 + 4 + 16);
  const dv = new DataView(buf);
  dv.setUint32(0, verts.length, true); dv.setUint32(4, segs.length, true); dv.setUint32(8, 1, true);
  let o = 12;
  for (const [x, y] of verts) { dv.setUint32(o, 0, true); dv.setFloat32(o + 4, x, true); dv.setFloat32(o + 8, y, true); o += 12; }
  for (const [a, b] of segs) { dv.setUint32(o + 4, a, true); dv.setUint32(o + 16, b, true); o += 28; }
  dv.setUint32(o, 1, true); dv.setUint32(o + 4, 1, true); dv.setUint32(o + 8, 4, true);
  for (let i = 0; i < 4; i++) dv.setUint32(o + 12 + i * 4, i, true);
  const net = parseVectorNetwork(new Uint8Array(buf), 2, 1)!;
  assert.equal(net.regions.length, 1);
  assert.equal(net.regions[0].evenOdd, true);
  assert.deepEqual(net.regions[0].loops, [[0, 1, 2, 3]]);
  const ch = networkToSubpaths(net);
  assert.equal(ch.branching, false);
  assert.equal(ch.subpaths.length, 2);
  const open = ch.subpaths.find(s => !s.closed)!, closed = ch.subpaths.find(s => s.closed)!;
  assert.equal(open.pts.length, 3);
  assert.equal(closed.pts.length, 4);
  assert.deepEqual(subpathsBounds([closed]), { x: 0, y: 0, w: 20, h: 10 });
  assert.deepEqual(subpathsBounds([open]), { x: 40, y: 0, w: 20, h: 10 });
  // the closed chain fills like a 20x10 rectangle, whichever way it winds
  const rect = rectSubpaths(20, 10, [0, 0, 0, 0]);
  assert.ok(matchFill([closed], rect, 0.01));
  assert.equal(matchFill([closed], rectSubpaths(20, 10, [3, 3, 3, 3]), 0.01), null);
  assert.equal(parseVectorNetwork(new Uint8Array(buf).subarray(0, 50)), null);
});

test('font style names', () => {
  assert.deepEqual(parseFontStyle('Semi Bold Italic'), { weight: 600, italic: true });
  assert.deepEqual(parseFontStyle('ExtraLight'), { weight: 200, italic: false });
  assert.deepEqual(parseFontStyle('Bold'), { weight: 700, italic: false });
  assert.deepEqual(parseFontStyle('Regular'), { weight: 400, italic: false });
  assert.deepEqual(parseFontStyle('Black Oblique'), { weight: 900, italic: true });
  assert.deepEqual(parseFontStyle(undefined), { weight: 400, italic: false });
});
