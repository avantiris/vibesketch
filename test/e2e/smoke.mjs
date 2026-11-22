// Browser smoke test: drives the real app through its main interactions.
//   node test/e2e/smoke.mjs <url> <chromium-executable> [screenshot-dir] [fig-file]
// The server must already be running (use a scratch --workspace).
import { chromium, firefox } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://127.0.0.1:5199', exe, shots = '.', figFile] = process.argv.slice(2);
const engine = process.env.BROWSER === 'firefox' ? firefox : chromium;
const browser = await engine.launch({ executablePath: exe || undefined });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
const shot = n => page.screenshot({ path: path.join(shots, `${n}.png`) });
// what is actually stored: read doc.json back out of the browser's private file system
const doc = async () => {
  await page.waitForFunction(() => window.__vs.saveState.value === 'saved', null, { timeout: 5000 }).catch(() => {});
  return page.evaluate(async () => {
    const name = decodeURIComponent(location.hash.slice(1));
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(name + '.vsk');
    return JSON.parse(await (await (await dir.getFileHandle('doc.json')).getFile()).text());
  });
};
const nodes = async () => Object.values((await doc()).nodes);
const stage = page.locator('.stage');
const key = k => page.keyboard.press(k);
const drag = async (x0, y0, x1, y1, opts = {}) => {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  const steps = opts.steps ?? 8;
  for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
  if (opts.hold) await opts.hold();
  await page.mouse.up();
};
const near = (a, b, eps = 0.51) => Math.abs(a - b) <= eps;

await page.goto(url);
await page.waitForSelector('.stage');
await page.waitForFunction(() => location.hash.length > 1);
const box = await stage.boundingBox();
// stage-relative -> page coordinates
const P = (x, y) => [box.x + x, box.y + y];
// start from a known view: 100% with the origin at the stage's top-left + (100,100)
const setView = (x, y, zoom) => page.evaluate(v => { window.__vs.view.value = v; }, { x, y, zoom });
await page.waitForTimeout(300);
await setView(100, 100, 1);

check('dark canvas by default', (await stage.evaluate(el => getComputedStyle(el).backgroundColor)) === 'rgb(30, 30, 30)');

// ---- rectangle
await key('r');
await drag(...P(200, 200), ...P(400, 320));
let ns = await nodes();
let rect = ns.find(n => n.type === 'rect');
check('draw rectangle', !!rect && near(rect.w, 200) && near(rect.h, 120) && near(rect.transform[4], 100) && near(rect.transform[5], 100), JSON.stringify(rect && [rect.transform[4], rect.transform[5], rect.w, rect.h]));

// ---- ellipse, then move it so its center snaps to the rectangle's center
await key('o');
await drag(...P(520, 380), ...P(620, 480));
ns = await nodes();
let ell = ns.find(n => n.type === 'ellipse');
check('draw ellipse', !!ell && near(ell.w, 100) && near(ell.h, 100));
// rect center is at world (200,160) => stage (300,260). Drag the ellipse (center stage 570,430) to ~4px off.
await drag(...P(570, 430), ...P(303, 263), { steps: 12, hold: async () => { await shot('guides'); } });
ns = await nodes();
ell = ns.find(n => n.type === 'ellipse');
check('smart guides snap centers', near(ell.transform[4] + 50, 200, 0.01) && near(ell.transform[5] + 50, 160, 0.01), `${ell.transform[4] + 50},${ell.transform[5] + 50}`);

// ---- undo / redo
await key('Control+z');
ns = await nodes();
check('undo move', near(ns.find(n => n.type === 'ellipse').transform[4], 420));
await key('Control+Shift+z');
ns = await nodes();
check('redo move', near(ns.find(n => n.type === 'ellipse').transform[4] + 50, 200, 0.01));

// ---- resize the ellipse with the bottom-right handle (selected after move)
// ellipse occupies stage (250,210)-(350,310)
await drag(...P(350, 310), ...P(390, 350));
ns = await nodes();
ell = ns.find(n => n.type === 'ellipse');
check('resize via handle', near(ell.w, 140) && near(ell.h, 140), `${ell.w}x${ell.h}`);

// ---- rotate with the zone outside the corner (shift = 15° steps)
await page.keyboard.down('Shift');
await drag(...P(402, 362), ...P(360, 420));
await page.keyboard.up('Shift');
ns = await nodes();
ell = ns.find(n => n.type === 'ellipse');
const rot = (Math.atan2(ell.transform[1], ell.transform[0]) * 180) / Math.PI;
check('rotate snaps to 15°', Math.abs(rot) > 1 && Math.abs(rot / 15 - Math.round(rot / 15)) < 1e-6, `${rot.toFixed(3)}°`);
await key('Control+z');

// ---- pen: triangle with one curved side, closed by clicking the first point
await key('Escape');
await key('p');
await page.mouse.click(...P(600, 150));
await drag(...P(700, 150), ...P(730, 190));
await page.mouse.click(...P(650, 260));
await page.mouse.click(...P(600, 150));
await key('Escape');
await key('Escape');
ns = await nodes();
let pathN = ns.find(n => n.type === 'path');
check('pen draws closed path', !!pathN && pathN.subpaths.length === 1 && pathN.subpaths[0].closed && pathN.subpaths[0].pts.length === 3, JSON.stringify(pathN?.subpaths?.[0]?.pts.length));
check('pen drag creates handles', !!pathN && pathN.subpaths[0].pts.some(p => p.in && p.out && p.mode === 'mirror'));
check('path normalized to origin', !!pathN && Math.min(...pathN.subpaths[0].pts.map(p => p.x)) >= -0.01 && near(pathN.transform[4], 500, 1), JSON.stringify(pathN?.transform));

// ---- vector edit: bend the straight segment between point 3 and point 1
await key('v');
await page.mouse.dblclick(...P(640, 180)); // inside the (stroke-only) shape: nothing; so select via stroke
await page.mouse.click(...P(625, 205)); // on the left edge (600,150)-(650,260)
await key('Enter');
await page.waitForTimeout(450); // not a double-click
await page.keyboard.down('Control'); // Ctrl = bend
await drag(...P(625, 205), ...P(590, 215));
await page.keyboard.up('Control');
await shot('bend');
await key('Enter');
ns = await nodes();
pathN = ns.find(n => n.type === 'path');
const bent = pathN.subpaths[0].pts.filter(p => p.in || p.out).length;
check('bend segment by dragging it', bent === 3, `points with handles: ${bent}`);

// ---- text
await key('t');
await page.mouse.click(...P(200, 520));
await page.keyboard.type('Hello vectors');
await key('Escape');
ns = await nodes();
const text = ns.find(n => n.type === 'text');
check('text tool', text?.text === 'Hello vectors');

// ---- group + duplicate + delete
await key('Control+a');
await key('Control+g');
ns = await nodes();
check('group', ns.filter(n => n.type === 'group').length === 1 && ns.find(n => n.type === 'group').children.length === 4);
await key('Control+d');
ns = await nodes();
check('duplicate', ns.length === 10);
await key('Delete');
ns = await nodes();
check('delete', ns.length === 5);

// ---- fill color via panel
await key('Escape');
await page.keyboard.down('Control'); // deep-select the rect inside the group
await page.mouse.click(...P(210, 210));
await page.keyboard.up('Control');
const hexInputCount = await page.locator('.panel.right .paint-label').count();
check('properties show fill', hexInputCount >= 1);
await page.locator('.panel.right .swatch').first().click();
const hexField = page.locator('.popover .cp-hex input');
await hexField.fill('FF3366');
await hexField.press('Enter');
await key('Escape');
ns = await nodes();
rect = ns.find(n => n.type === 'rect');
check('change fill color', rect.fills[0]?.type === 'solid' && Math.round(rect.fills[0].color.r * 255) === 255 && Math.round(rect.fills[0].color.g * 255) === 0x33);

// ---- effect
await page.locator('.panel.right .section', { hasText: 'Effects' }).locator('.icon-btn').first().click();
ns = await nodes();
check('add drop shadow', ns.find(n => n.type === 'rect').effects[0]?.type === 'drop-shadow');
check('filter rendered', (await page.locator('.scene filter').count()) >= 1);
await shot('editor');

// ---- SVG import through drop
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><rect width="120" height="80" rx="10" fill="url(#g)"/><circle cx="60" cy="40" r="20" fill="#fff" stroke="#000" stroke-width="2"/></svg>`;
const before = (await nodes()).length;
const dt = await page.evaluateHandle(s => { const d = new DataTransfer(); d.items.add(new File([s], 'badge.svg', { type: 'image/svg+xml' })); return d; }, svg);
await stage.dispatchEvent('drop', { dataTransfer: dt, clientX: box.x + 800, clientY: box.y + 500 });
await page.waitForTimeout(600);
ns = await nodes();
check('drop SVG imports nodes', ns.length >= before + 2, `${before} -> ${ns.length}`);
check('imported gradient', ns.some(n => n.fills?.some(f => f.type === 'gradient')));

// ---- PNG import
const png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 40; c.height = 30; const x = c.getContext('2d'); x.fillStyle = '#2a7'; x.fillRect(0, 0, 40, 30); x.fillStyle = '#fff'; x.fillRect(10, 10, 20, 10); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
const dt2 = await page.evaluateHandle(b => { const d = new DataTransfer(); d.items.add(new File([Uint8Array.from(atob(b), c => c.charCodeAt(0))], 'dot.png', { type: 'image/png' })); return d; }, png.toString('base64'));
await stage.dispatchEvent('drop', { dataTransfer: dt2, clientX: box.x + 900, clientY: box.y + 200 });
await page.waitForTimeout(600);
const d1 = await doc();
check('drop PNG creates image fill + asset', Object.values(d1.nodes).some(n => n.fills?.some(f => f.type === 'image')) && Object.keys(d1.assets).length === 1);

// ---- exports
await key('Escape');
const exportOne = async fmt => {
  await page.locator('.panel.right .section', { hasText: 'Export' }).locator('select').first().selectOption(fmt);
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }).catch(async e => { throw new Error(`${fmt} export produced no download; toasts: ${await page.locator('.toast').allInnerTexts()}; errors: ${errors.join(' | ')}`, { cause: e }); }),
    page.locator('.panel.right button.primary').click(),
  ]);
  const p = path.join(shots, `export.${fmt}`);
  await dl.saveAs(p);
  return fs.readFileSync(p);
};
const svgOut = (await exportOne('svg')).toString();
check('export SVG', svgOut.startsWith('<svg') && svgOut.includes('<rect') && svgOut.includes('Hello vectors') && svgOut.includes('<filter'), `${svgOut.length} bytes`);
const pngOut = await exportOne('png');
check('export PNG', pngOut.subarray(1, 4).toString() === 'PNG' && pngOut.length > 1000, `${pngOut.length} bytes`);
const jpgOut = await exportOne('jpg');
check('export JPG', jpgOut[0] === 0xff && jpgOut[1] === 0xd8, `${jpgOut.length} bytes`);
const pdfOut = await exportOne('pdf');
check('export PDF', pdfOut.subarray(0, 5).toString() === '%PDF-', `${pdfOut.length} bytes`);

// ---- PDF import: feed our own PDF export back in (server converts it with pdftocairo)
{
  const n0 = (await nodes()).length;
  const dtp = await page.evaluateHandle(b => { const d = new DataTransfer(); d.items.add(new File([Uint8Array.from(atob(b), c => c.charCodeAt(0))], 'roundtrip.pdf', { type: 'application/pdf' })); return d; }, pdfOut.toString('base64'));
  await stage.dispatchEvent('drop', { dataTransfer: dtp, clientX: box.x + 500, clientY: box.y + 650 });
  await page.waitForFunction(n => Object.keys(window.__vs.doc.value.nodes).length > n, n0, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  const after = await nodes();
  check('drop PDF imports vectors', after.length > n0 && after.some(n => n.name.startsWith('roundtrip')), `${n0} -> ${after.length}; toasts: ${await page.locator('.toast.error').allInnerTexts()}`);
  await shot('pdf');

  // copy / paste
  await key('Escape');
  await page.keyboard.down('Control');
  await page.mouse.click(...P(210, 210));
  await page.keyboard.up('Control');
  const n1 = (await nodes()).length;
  await key('Control+c');
  await key('Control+v');
  await page.waitForTimeout(300);
  check('copy / paste', (await nodes()).length === n1 + 1, `${n1} -> ${(await nodes()).length}`);
}

// ---- external edit on disk shows up live
const name = await page.evaluate(() => decodeURIComponent(location.hash.slice(1)));
const d2 = await doc();
const victim = Object.values(d2.nodes).find(n => n.type === 'text');
d2.nodes[victim.id].text = 'Changed on disk';
await page.evaluate(async ({ name, text }) => {
  const root = await navigator.storage.getDirectory();
  const file = await (await root.getDirectoryHandle(name + '.vsk')).getFileHandle('doc.json');
  const w = await file.createWritable();
  await w.write(text);
  await w.close();
}, { name, text: JSON.stringify(d2) });
await page.waitForFunction(() => [...document.querySelectorAll('.scene text')].some(t => t.textContent === 'Changed on disk'), null, { timeout: 5000 }).then(() => check('external change appears live', true)).catch(() => check('external change appears live', false));

// ---- vector edit: draw a line, grab the dot in its middle and pull a new point out
{
  await key('Escape');
  await setView(100, 100, 1);
  await key('l');
  await drag(...P(300, 640), ...P(500, 640));
  await key('Enter');
  await page.waitForTimeout(450);
  await page.mouse.move(...P(380, 641));
  await page.mouse.move(...P(400, 640));
  await shot('midpoint');
  await drag(...P(400, 640), ...P(400, 590));
  await key('Enter');
  const line = (await nodes()).find(n => n.name === 'Line');
  check('drag segment midpoint adds a point', line?.subpaths[0].pts.length === 3 && near(Math.min(...line.subpaths[0].pts.map(p => p.y)), 0) && near(line.transform[5], 490, 1), JSON.stringify(line?.subpaths[0].pts.map(p => [p.x, p.y])));
  const ink = line?.strokes[0]?.color;
  check('new strokes contrast with the dark canvas', ink && ink.r === 1 && ink.g === 1, JSON.stringify(ink));

  // pen: branch off the middle point of that line
  await key('Enter');
  await key('p');
  await page.mouse.click(...P(400, 590));
  await page.mouse.click(...P(400, 540));
  await key('Escape');
  await key('Escape');
  const branched = (await nodes()).find(n => n.name === 'Line');
  check('pen branches off an existing point', branched?.subpaths.length === 2 && branched.subpaths[1].pts.length === 2, JSON.stringify(branched?.subpaths.map(s => s.pts.length)));

  // vector toolbar + points panel
  await key('Enter');
  check('vector edit toolbar', (await page.locator('.toolbar .done').count()) === 1 && (await page.locator('.toolbar [aria-label^="Bend"]').count()) === 1);
  await key('Control+a');
  check('points panel', (await page.locator('.panel.right .section-head', { hasText: '5 points' }).count()) === 1);
  await page.locator('.panel.right button', { hasText: 'Curve' }).click();
  const curved = (await nodes()).find(n => n.name === 'Line');
  check('curve button gives points handles', curved.subpaths[0].pts[1].in && curved.subpaths[0].pts[1].out && curved.subpaths[0].pts[1].mode === 'smooth');
  await page.locator('.toolbar .done').click();
}

// ---- boolean subtract through the right-click menu, then flatten
{
  await key('r'); await drag(...P(700, 560), ...P(800, 660));
  await key('r'); await drag(...P(750, 610), ...P(850, 710));
  await page.keyboard.down('Shift'); await page.mouse.click(...P(710, 570)); await page.keyboard.up('Shift');
  await page.mouse.click(...P(720, 580), { button: 'right' });
  await shot('contextmenu');
  await page.locator('.menu button', { hasText: 'Subtract selection' }).click();
  await page.waitForFunction(() => Object.values(window.__vs.doc.value.nodes).some(n => n.name === 'Subtract'), null, { timeout: 8000 }).catch(() => {});
  const sub = (await nodes()).find(n => n.name === 'Subtract');
  check('boolean subtract', sub?.type === 'path' && sub.subpaths.length === 1 && sub.subpaths[0].pts.length === 6 && near(sub.transform[4], 600, 1), `${JSON.stringify(sub?.subpaths?.map(s => s.pts.length))}; toasts: ${await page.locator('.toast').allInnerTexts()}`);

  await key('o'); await drag(...P(560, 700), ...P(620, 760));
  await key('Control+e');
  await page.waitForTimeout(400);
  const flat = (await nodes()).find(n => n.name === 'Ellipse' && n.type === 'path');
  check('flatten turns a primitive into a path', !!flat && flat.subpaths[0].pts.length === 4, `toasts: ${await page.locator('.toast').allInnerTexts()}; ${JSON.stringify((await nodes()).filter(n => n.name === 'Ellipse').map(n => n.type))}; local: ${await page.evaluate(() => JSON.stringify({ sel: window.__vs.selection.value.map(i => window.__vs.doc.value.nodes[i]?.type), tool: window.__vs.tool.value, save: window.__vs.saveState.value, active: document.activeElement?.tagName + '.' + document.activeElement?.className }))}`);
  await shot('boolean');
}

// ---- on-canvas handles and Figma-style shortcuts
{
  await key('Escape');
  await setView(100, 100, 1);
  const local = () => page.evaluate(() => { const s = window.__vs; return s.selection.value.map(id => JSON.parse(JSON.stringify(s.doc.value.nodes[id]))); });
  await key('r');
  await drag(...P(40, 340), ...P(180, 460));
  // corner radius dot (14px inside the top-left corner)
  await page.mouse.move(...P(54, 354));
  await drag(...P(54, 354), ...P(74, 374));
  let [r] = await local();
  check('corner radius handle', r.type === 'rect' && r.radii.every(v => v === 20), JSON.stringify(r.radii));
  await shot('radius');

  // gradient end point dragged on the canvas
  await page.locator('.panel.right .swatch').first().click();
  await page.locator('.popover .tabs button', { hasText: 'Linear' }).click();
  await key('Escape');
  await page.mouse.move(...P(110, 458));
  await shot('gradient');
  await drag(...P(110, 460), ...P(180, 400));
  [r] = await local();
  const g = r.fills[0];
  check('gradient handle on canvas', g?.type === 'gradient' && near(g.to.x, 1, 0.01) && near(g.to.y, 0.5, 0.01) && near(g.from.x, 0.5, 0.01) && near(g.from.y, 0, 0.01), JSON.stringify(g && [g.from, g.to]));

  // Ctrl+arrow resizes, Ctrl+Alt+C / V carries the look over
  await key('Control+ArrowRight');
  await key('Control+Shift+ArrowDown');
  [r] = await local();
  check('Ctrl+arrows resize', near(r.w, 141) && near(r.h, 130), `${r.w}x${r.h}`);
  await key('Control+Alt+c');

  // Alt-drag duplicates, Ctrl+D repeats the same step
  await page.keyboard.down('Alt');
  await drag(...P(110, 400), ...P(110, 560), { steps: 10 });
  await page.keyboard.up('Alt');
  const y1 = (await local())[0].transform[5];
  await key('Control+d');
  const y2 = (await local())[0].transform[5];
  check('Ctrl+D repeats the Alt-drag offset', near(y1 - 240, y2 - y1, 0.01) && y2 > y1 + 50, `240 -> ${y1} -> ${y2}`);

  // Tab walks the siblings; paste properties onto another layer
  const before = (await local())[0].id;
  await key('Tab');
  const after = await local();
  check('Tab selects the next sibling', after.length === 1 && after[0].id !== before);
  await key('Control+Alt+v');
  const pasted = (await local())[0];
  check('paste properties', pasted.type === 'group' || pasted.fills?.[0]?.type === 'gradient', pasted.type);
  await key('Control+z');

  // Alt shows distances to the hovered layer (drawn on the overlay)
  await page.mouse.click(...P(110, 400));
  await page.keyboard.down('Alt');
  await page.mouse.move(...P(300, 250));
  await page.mouse.move(...P(310, 255));
  const alt = await page.evaluate(() => window.__vs.hover.value !== null);
  await shot('measure');
  await page.keyboard.up('Alt');
  check('Alt-hover picks a layer to measure against', alt);
}

// ---- everything survives a reload (stored in the browser, no server involved)
{
  const before = (await nodes()).length;
  await page.reload();
  await page.waitForSelector('.stage');
  await page.waitForFunction(() => window.__vs && Object.keys(window.__vs.doc.value.nodes).length > 0, null, { timeout: 10000 }).catch(() => {});
  const after = await page.evaluate(() => Object.keys(window.__vs.doc.value.nodes).length);
  check('project survives a reload', after === before && before > 5, `${before} -> ${after}`);
  check('images survive a reload', await page.evaluate(() => [...document.querySelectorAll('.scene image')].every(i => (i.getAttribute('href') ?? '').startsWith('blob:')) && document.querySelectorAll('.scene image').length > 0));
  check('bundled fonts are listed', await page.evaluate(async () => (await (await fetch('fonts/manifest.json')).json()).some(f => f.family === 'Montserrat')));
}

// ---- project zip: download and import again
{
  await page.locator('.project-name').click();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.locator('.project-item button', { hasText: 'Download' }).first().click()]);
  const zipPath = path.join(shots, 'project.zip');
  await dl.saveAs(zipPath);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.dialog button', { hasText: 'Import .zip' }).click()]);
  await chooser.setFiles(zipPath);
  await page.waitForFunction(() => decodeURIComponent(location.hash.slice(1)) === 'Untitled 2', null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const copy = await page.evaluate(() => ({ name: decodeURIComponent(location.hash.slice(1)), nodes: Object.keys(window.__vs.doc.value.nodes).length, images: [...document.querySelectorAll('.scene image')].filter(i => (i.getAttribute('href') ?? '').startsWith('blob:')).length }));
  check('project zip round-trips', copy.name === 'Untitled 2' && copy.nodes > 5 && copy.images > 0, JSON.stringify(copy));
}

// ---- .fig import
if (figFile && fs.existsSync(figFile)) {
  const b64 = fs.readFileSync(figFile).toString('base64');
  const dt3 = await page.evaluateHandle(b => { const d = new DataTransfer(); d.items.add(new File([Uint8Array.from(atob(b), c => c.charCodeAt(0))], 'Imported.fig')); return d; }, b64);
  const t0 = Date.now();
  await stage.dispatchEvent('drop', { dataTransfer: dt3, clientX: box.x + 300, clientY: box.y + 300 });
  await page.waitForFunction(() => decodeURIComponent(location.hash.slice(1)).startsWith('Imported'), null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const d3 = await doc();
  check('.fig import opens as project', Object.keys(d3.nodes).length > 100, `${Object.keys(d3.nodes).length} nodes in ${Date.now() - t0} ms`);
  await shot('fig');
  // interaction cost on a big document: time a drag of one node
  await key('Shift+1');
  await page.waitForTimeout(500);
  const t1 = Date.now();
  await drag(...P(600, 400), ...P(640, 430), { steps: 20 });
  check('drag in big doc stays responsive', Date.now() - t1 < 4000, `${Date.now() - t1} ms for 20 moves`);
  await key('Control+z');
}

check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
