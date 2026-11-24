// Browser test for slices: the tool, and exporting the region of the page a slice frames.
//   node test/e2e/slice.mjs <url> <chromium-executable>      (BROWSER=firefox for Firefox)
import { chromium, firefox } from 'playwright';
import fs from 'node:fs';

const [url = 'http://127.0.0.1:5199', exe] = process.argv.slice(2);
const engine = process.env.BROWSER === 'firefox' ? firefox : chromium;
const browser = await engine.launch({ executablePath: exe || undefined });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };

await page.goto(url);
await page.waitForSelector('.stage');
await page.waitForFunction(() => location.hash.length > 1 && window.__vs);
const box = await page.locator('.stage').boundingBox();
const P = (x, y) => [box.x + x, box.y + y];
await page.evaluate(() => { window.__vs.view.value = { x: 0, y: 0, zoom: 1 }; });
const drag = async (x0, y0, x1, y1) => { await page.mouse.move(x0, y0); await page.mouse.down(); for (let i = 1; i <= 6; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6); await page.mouse.up(); await page.waitForTimeout(450); };
const setFill = (id, r, g, b) => page.evaluate(([id, r, g, b]) => window.__vs.update(d => ({ ...d, nodes: { ...d.nodes, [id]: { ...d.nodes[id], fills: [{ type: 'solid', visible: true, opacity: 1, color: { r, g, b, a: 1 } }] } } })), [id, r, g, b]);
const nodes = () => page.evaluate(() => Object.values(window.__vs.doc.value.nodes));

// two rectangles: red 200..400, blue 400..600 (both y 200..400)
await page.keyboard.press('r'); await drag(...P(200, 200), ...P(400, 400));
await page.keyboard.press('r'); await drag(...P(400, 200), ...P(600, 400));
const [a, b] = (await nodes()).sort((x, y) => x.transform[4] - y.transform[4]);
await setFill(a.id, 1, 0, 0); await setFill(b.id, 0, 0, 1);

// ---- the slice tool: a frame over the right half of red and the left half of blue
await page.keyboard.press('Escape');
await page.keyboard.press('s');
check('S selects the slice tool', await page.evaluate(() => window.__vs.tool.value === 'slice'));
await drag(...P(300, 250), ...P(500, 350));
const slice = (await nodes()).find(n => n.slice);
check('a slice is created and selected', !!slice && slice.w === 200 && slice.h === 100 && await page.evaluate(id => window.__vs.selection.value[0] === id, slice?.id), JSON.stringify(slice));
check('it is drawn as a dashed frame', await page.locator(`.stage [data-id="${slice.id}"] rect[stroke-dasharray]`).count() === 1);
check('the panel calls it a slice', (await page.locator('.panel.right .panel-title').textContent()).startsWith('Slice') && await page.locator('.panel.right', { hasText: 'Export slice' }).count() === 1);

const exportAs = async (format) => {
  await page.locator('.section', { hasText: /Export (slice|page|selection)/ }).locator('select').first().selectOption(format);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.section', { hasText: /Export (slice|page|selection)/ }).locator('button.primary').click()]);
  return { name: dl.suggestedFilename(), file: await dl.path() };
};

// ---- the preview shows what will be written
const preview = async () => {
  await page.waitForTimeout(700);
  return page.evaluate(async () => {
    const img = document.querySelector('.export-preview-box img');
    if (!img) return null;
    await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const at = (u, v) => [...x.getImageData(Math.floor(c.width * u), Math.floor(c.height * v), 1, 1).data].slice(0, 3).join(',');
    return { w: img.naturalWidth, h: img.naturalHeight, left: at(0.25, 0.5), right: at(0.75, 0.5), size: document.querySelector('.export-preview-size')?.textContent };
  });
};
let pv = await preview();
check('the export preview shows the framed region', !!pv && pv.w === 200 && pv.h === 100 && pv.left === '255,0,0' && pv.right === '0,0,255' && pv.size === '200 × 100 px', JSON.stringify(pv));
await page.locator('.section', { hasText: 'Export slice' }).locator('select').first().selectOption('png');
pv = await preview();
check('…and the size the file will have', pv?.size === '400 × 200 px', JSON.stringify(pv));
await page.locator('.section', { hasText: 'Export slice' }).locator('select').first().selectOption('pdf');
pv = await preview();
check('…in points for a PDF', pv?.size === '150 × 75 pt', JSON.stringify(pv));

// ---- SVG: the slice's size, artwork shifted into it, no slice in the file
const svg = await exportAs('svg');
const text = fs.readFileSync(svg.file, 'utf8');
check('SVG export has the size of the slice', /<svg[^>]*width="200"[^>]*height="100"[^>]*viewBox="0 0 200 100"/.test(text) && svg.name === 'Slice.svg', `${svg.name} ${text.slice(0, 160)}`);
check('…with the artwork under it and without the frame itself', (text.match(/<rect|<path/g) ?? []).length === 2 && !text.includes('dasharray') && !text.includes('Slice'), text);

// ---- PNG: left half red, right half blue
const png = await exportAs('png');
const px = await page.evaluate(async b64 => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const at = (u, v) => [...x.getImageData(Math.floor(img.width * u), Math.floor(img.height * v), 1, 1).data].slice(0, 3).join(',');
  return { w: img.width, h: img.height, left: at(0.25, 0.5), right: at(0.75, 0.5) };
}, fs.readFileSync(png.file).toString('base64'));
check('PNG export is the framed region', px.w === 400 && px.h === 200 && px.left === '255,0,0' && px.right === '0,0,255', JSON.stringify(px));

// ---- a slice never shows up in other exports
await page.keyboard.press('Escape');
await page.mouse.click(...P(800, 600));
const whole = fs.readFileSync((await exportAs('svg')).file, 'utf8');
check('exporting the page ignores the slice', /width="400"[^>]*height="200"/.test(whole) && !whole.includes('dasharray'), whole.slice(0, 200));

pv = await preview();
check('the preview follows the selection (whole page)', !!pv && pv.w === 400 && pv.h === 200, JSON.stringify(pv));

// ---- the artwork inside a slice can still be clicked
await page.mouse.click(...P(350, 300));
check('layers inside a slice stay clickable', await page.evaluate(id => window.__vs.selection.value[0] === id, a.id));
await page.mouse.click(...P(300, 300));
check('the slice is selected by its frame', await page.evaluate(id => window.__vs.selection.value[0] === id, slice.id));

check('no errors in the page', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
