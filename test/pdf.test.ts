import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOMParser } from 'linkedom';
import { pdfToSvg } from '../src/io/pdf.ts';
import { importSvg } from '../src/io/svgImport.ts';

function tinyPdf(content: string): Uint8Array {
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>', `<</Length ${content.length}>>stream\n${content}endstream`, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  let pdf = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

test('a PDF page becomes editable vectors (MuPDF -> SVG -> nodes)', async () => {
  const pages = await pdfToSvg(tinyPdf('BT /F1 24 Tf 72 700 Td (Hello PDF world) Tj ET\n1 0 0 rg 72 500 200 100 re f\n0 0 1 RG 4 w 72 450 m 272 450 l S\n'));
  assert.equal(pages.length, 1);
  assert.match(pages[0], /^<svg /);
  const r = await importSvg(pages[0], { DOMParser: DOMParser as never });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.width, 595); assert.equal(r.height, 842);
  const nodes = r.roots.map(id => r.nodes[id]);
  assert.equal(nodes.length, 3, 'text, rectangle, line');
  const [text, rect, line] = nodes as any[];
  // the 15 glyphs are merged into one outline, not 15 layers
  assert.equal(text.type, 'path'); assert.ok(text.subpaths.length >= 13);
  assert.equal(rect.type, 'path');
  assert.deepEqual([rect.fills[0].color.r, rect.fills[0].color.g, rect.fills[0].color.b], [1, 0, 0]);
  // PDF y is up from the bottom: 842 - 500 - 100 = 242
  assert.deepEqual(rect.transform.map((v: number) => Math.round(v)), [1, 0, 0, 1, 72, 242]);
  assert.equal(line.strokeWeight, 4);
  assert.equal(line.strokes[0].color.b, 1);
});

test('unreadable input gives a readable error', async () => {
  await assert.rejects(pdfToSvg(new TextEncoder().encode('not a pdf at all')), /could not be read/);
});
