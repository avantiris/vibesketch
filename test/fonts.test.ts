import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractCollectionFace, fcWeightToCss, fontLicense, fontNames, licenseNotice, parseFcScan, withinBudget } from '../scripts/build-fonts.ts';

test('font budget: families with the largest files go first, hand-picked ones stay', () => {
  const f = (family: string, src: string, size: number) => ({ family, src, size });
  const faces = [
    f('Picked Huge', '/nix/picked/share/fonts/Huge.ttf', 50), f('Small', '/g/ofl/small/a.ttf', 5), f('Small', '/g/ofl/small/b.ttf', 5),
    f('CJK', '/g/ofl/cjk/a.ttf', 40), f('Mid', '/g/apache/mid/a.ttf', 20), f('Mid', '/g/apache/mid/b.ttf', 20),
  ];
  const kept = (budget: number) => [...new Set(withinBudget(faces, budget, x => x.size, '/g/ufl').map(x => x.family))];
  assert.deepEqual(kept(1000), ['Picked Huge', 'Small', 'CJK', 'Mid']);
  assert.deepEqual(kept(100), ['Picked Huge', 'Small', 'Mid']);
  assert.deepEqual(kept(60), ['Picked Huge', 'Small']);
  assert.throws(() => kept(40));
});

/** a font file that has nothing but a name table */
function fontWithNames(records: [platform: number, lang: number, id: number, text: string][]): Buffer {
  const strings = records.map(([platform, , , text]) => platform === 1 ? Buffer.from(text, 'latin1') : Buffer.from(text, 'utf16le').swap16());
  const name = Buffer.alloc(6 + records.length * 12);
  name.writeUInt16BE(records.length, 2);
  name.writeUInt16BE(name.length, 4);
  let off = 0;
  records.forEach(([platform, lang, id], i) => {
    const r = 6 + i * 12;
    name.writeUInt16BE(platform, r); name.writeUInt16BE(lang, r + 4); name.writeUInt16BE(id, r + 6);
    name.writeUInt16BE(strings[i].length, r + 8); name.writeUInt16BE(off, r + 10);
    off += strings[i].length;
  });
  const head = Buffer.alloc(28);
  head.writeUInt32BE(0x00010000, 0); head.writeUInt16BE(1, 4);
  head.write('name', 12, 'latin1'); head.writeUInt32BE(28, 20); head.writeUInt32BE(name.length + off, 24);
  return Buffer.concat([head, name, ...strings]);
}

test('licence of a font is read from its name table', () => {
  const ofl = fontNames(fontWithNames([
    [1, 0, 0, 'Copyright (mac)'], [3, 0x407, 0, 'Urheberrecht'], [3, 0x409, 0, 'Copyright 2011 The Authors'],
    [3, 0x409, 13, 'This Font Software is licensed under the SIL Open Font License, Version 1.1.'], [3, 0x409, 14, 'https://openfontlicense.org'],
  ]));
  assert.deepEqual(ofl, { copyright: 'Copyright 2011 The Authors', license: 'This Font Software is licensed under the SIL Open Font License, Version 1.1.', licenseUrl: 'https://openfontlicense.org' });
  assert.equal(fontLicense('Any', ofl), 'OFL-1.1');
  const names = (license: string, licenseUrl = '', copyright = '') => ({ copyright, license, licenseUrl });
  assert.equal(fontLicense('Any', names('Copyright (c) 2010, Somebody', 'http://scripts.sil.org/OFL')), 'OFL-1.1');
  assert.equal(fontLicense('Any', names('Licensed under the Apache License, Version 2.0')), 'Apache-2.0');
  assert.equal(fontLicense('Any', names('Fonts are (c) Bitstream (see below).')), 'Bitstream-Vera');
  assert.equal(fontLicense('Ubuntu', names('', '', 'Copyright 2011 Canonical Ltd.  Licensed under the Ubuntu Font Licence 1.0')), 'Ubuntu-font-1.0');
  assert.equal(fontLicense('Zilla Slab', names('')), 'OFL-1.1');
  // nothing said, or something we do not know: never shipped on a guess
  assert.equal(fontLicense('Mystery', names('')), null);
  assert.equal(fontLicense('Zilla Slab', names('This Font Software is protected under domestic and international trademark and copyright law.', 'https://example.com/licensing')), null);
});

test('font notice lists each family with its copyright and the licence texts in use', () => {
  const text = licenseNotice([
    { family: 'Alpha', faces: 2, license: 'OFL-1.1', copyright: ['Copyright 2011 The Alpha Authors'], terms: ['This Font Software is licensed under the SIL Open Font License, Version 1.1. This license is available with a FAQ at: https://openfontlicense.org', 'Reserved Font Name Alpha.'] },
    { family: 'Beta', faces: 1, license: 'Apache-2.0', copyright: ['(c) Beta'], terms: [] },
  ], { 'OFL-1.1': 'OFL TEXT', 'Apache-2.0': 'APACHE TEXT', 'Ubuntu-font-1.0': 'UFL TEXT', 'Bitstream-Vera': 'VERA TEXT' });
  assert.match(text, /Alpha  \(2 faces\)\nLicence: SIL Open Font License 1\.1 \[OFL-1\.1\]\nCopyright 2011 The Alpha Authors\nReserved Font Name Alpha\.\n/);
  assert.match(text, /Beta  \(1 face\)\nLicence: Apache License 2\.0 \[Apache-2\.0\]\n\(c\) Beta\n/);
  assert.ok(text.includes('OFL TEXT') && text.includes('APACHE TEXT') && !text.includes('UFL TEXT') && !text.includes('VERA TEXT'));
});

test('fontconfig weight conversion', () => {
  const pairs: [number, number][] = [[0, 100], [40, 200], [50, 300], [80, 400], [100, 500], [180, 600], [200, 700], [205, 800], [210, 900], [215, 900]];
  for (const [fc, css] of pairs) assert.equal(fcWeightToCss(fc), css);
});

test('fc-scan parsing: collections, variable fonts, duplicates', () => {
  // family, style, weight, slant, file, index, format, variable
  const rows = [
    ['Zed', 'Bold', '200', '0', '/f/Zed-Bold.ttf', '0', 'TrueType', 'False'],
    ['Alpha', 'Italic', '80', '100', '/f/Alpha-Italic.otf', '0', 'CFF', 'False'],
    ['Alpha', 'Regular', '80', '0', '/f/Alpha.otf', '0', 'CFF', 'False'],
    ['Alpha', 'Book', '80', '0', '/f/Alpha-Book.otf', '0', 'CFF', 'False'], // same weight + slant: one is enough
    ['Coll', 'Regular', '80', '0', '/f/Coll.ttc', '0', 'TrueType', 'False'], // collection: one entry per face
    ['Coll', 'Bold', '200', '0', '/f/Coll.ttc', '1', 'TrueType', 'False'],
    ['Bits', 'Regular', '80', '0', '/f/bits.pcf.gz', '0', 'PCF', 'False'], // bitmap
    ['Var', 'Regular', '[40 210]', '0', '/f/Var.ttf', '0', 'TrueType', 'True'],
    ['Var', 'Light', '50', '0', '/f/Var.ttf', '0', 'TrueType', 'False'], // default instance of the variable file
    ['Var', 'Bold', '200', '0', '/f/Var.ttf', '131072', 'TrueType', 'False'], // named instance
    ['Mix', 'Regular', '[40 210]', '0', '/f/Mix[wght].ttf', '0', 'TrueType', 'True'], // static faces win
    ['Mix', 'Regular', '80', '0', '/f/Mix-Regular.ttf', '0', 'TrueType', 'False'],
    ['Mix', 'Bold', '200', '0', '/f/Mix-Bold.ttf', '0', 'TrueType', 'False'],
  ];
  const fonts = parseFcScan(rows.map(r => r.join('\t')).join('\n') + '\n');
  // a variable font is one entry that carries its weight range
  assert.deepEqual(fonts.find(f => f.family === 'Var')?.wght, [200, 900]);
  assert.ok(fonts.filter(f => f.family !== 'Var').every(f => f.wght === undefined));
  assert.deepEqual(fonts.map(f => `${f.family}/${f.style}/${f.weight}/${f.italic}`), [
    'Alpha/Regular/400/false', 'Alpha/Italic/400/true', 'Coll/Regular/400/false', 'Coll/Bold/700/false',
    'Mix/Regular/400/false', 'Mix/Bold/700/false', 'Var/Regular/400/false', 'Zed/Bold/700/false',
  ]);
  assert.equal(new Set(fonts.map(f => f.id)).size, fonts.length);
  for (const f of fonts) assert.match(f.id, /^[a-f0-9]{16}$/);
});

test('a face is extracted from a font collection as a standalone file', () => {
  const table = (tag: string, body: string, at: number) => { const r = Buffer.alloc(16); r.write(tag, 0, 'latin1'); r.writeUInt32BE(7, 4); r.writeUInt32BE(at, 8); r.writeUInt32BE(body.length, 12); return r; };
  const dir = () => { const h = Buffer.alloc(12); h.writeUInt32BE(0x00010000, 0); h.writeUInt16BE(1, 4); return h; };
  const head = Buffer.alloc(20); head.write('ttcf', 0, 'latin1'); head.writeUInt32BE(0x00010000, 4); head.writeUInt32BE(2, 8); head.writeUInt32BE(20, 12); head.writeUInt32BE(48, 16);
  const ttc = Buffer.concat([head, dir(), table('aaaa', 'first', 76), dir(), table('bbbb', 'second!', 81), Buffer.from('first'), Buffer.from('second!')]);
  const one = extractCollectionFace(ttc, 1);
  assert.equal(one.readUInt16BE(4), 1);
  assert.equal(one.toString('latin1', 12, 16), 'bbbb');
  const off = one.readUInt32BE(20), len = one.readUInt32BE(24);
  assert.equal(off, 28);
  assert.equal(one.toString('latin1', off, off + len), 'second!');
  assert.equal(one.length % 4, 0);
  assert.throws(() => extractCollectionFace(ttc, 2));
});
