// Browser test for the eyedropper: I on a selection, and the button in the colour picker.
//   node test/e2e/eyedropper.mjs <url> <chromium-executable> [screenshot-dir]      (BROWSER=firefox for Firefox)
import { chromium, firefox } from 'playwright';
import path from 'node:path';

const [url = 'http://127.0.0.1:5199', exe, shots = '.'] = process.argv.slice(2);
const engine = process.env.BROWSER === 'firefox' ? firefox : chromium;
const browser = await engine.launch({ executablePath: exe || undefined });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
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
const drag = async (x0, y0, x1, y1) => { await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2); await page.mouse.move(x1, y1); await page.mouse.up(); await page.waitForTimeout(450); };
const rects = () => page.evaluate(() => Object.values(window.__vs.doc.value.nodes).filter(n => n.type === 'rect').sort((a, b) => a.transform[4] - b.transform[4]));
const setFill = (id, r, g, b) => page.evaluate(([id, r, g, b]) => window.__vs.update(d => ({ ...d, nodes: { ...d.nodes, [id]: { ...d.nodes[id], fills: [{ type: 'solid', visible: true, opacity: 1, color: { r, g, b, a: 1 } }] } } })), [id, r, g, b]);
const fillHex = async id => page.evaluate(id => { const c = window.__vs.doc.value.nodes[id].fills.at(-1).color; return [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join(''); }, id);

await page.keyboard.press('r'); await drag(...P(150, 150), ...P(300, 300));
await page.keyboard.press('r'); await drag(...P(450, 150), ...P(600, 300));
const [a, b] = await rects();
await setFill(a.id, 1, 0, 0);      // ff0000
await setFill(b.id, 0, 0.502, 1);  // 0080ff

// ---- I: pick onto the selection (b is selected)
await page.keyboard.press('i');
await page.waitForSelector('.eyedrop');
await page.mouse.move(...P(220, 220));
await page.waitForTimeout(100);
check('the loupe shows the colour under the pointer', (await page.locator('.eyedrop-loupe span').textContent()) === '#FF0000', await page.locator('.eyedrop-loupe span').textContent());
await page.screenshot({ path: path.join(shots, 'eyedropper.png') });
await page.mouse.click(...P(220, 220));
check('I picks a colour from the canvas onto the selection', await fillHex(b.id) === 'ff0000', await fillHex(b.id));
check('the eyedropper closes after the pick', await page.locator('.eyedrop').count() === 0);
check('the pick did not move or change the selection', await page.evaluate(id => window.__vs.selection.value.length === 1 && window.__vs.selection.value[0] === id, b.id));

// ---- Esc cancels
await setFill(b.id, 0, 0.502, 1);
await page.keyboard.press('i');
await page.waitForSelector('.eyedrop');
await page.mouse.move(...P(220, 220));
await page.keyboard.press('Escape');
check('Esc cancels', await page.locator('.eyedrop').count() === 0 && await fillHex(b.id) === '0080ff');

// ---- the page background can be picked too
await page.keyboard.press('i');
await page.waitForSelector('.eyedrop');
await page.mouse.click(...P(800, 500));
check('empty canvas gives the page colour', await fillHex(b.id) === '1e1e1e', await fillHex(b.id));

// ---- from the colour picker, which stays open
await page.locator('.swatch').first().click();
await page.waitForSelector('.color-picker');
await page.locator('.color-picker button[aria-label="Eyedropper"]').click();
await page.waitForSelector('.eyedrop');
await page.mouse.click(...P(220, 220));
check('the picker button picks from the canvas', await fillHex(b.id) === 'ff0000', await fillHex(b.id));
await page.waitForTimeout(200);
const open = await page.locator('.color-picker').count(), shown = open ? await page.locator('.color-picker .cp-hex input').inputValue() : '';
check('the colour picker stays open and shows the picked colour', open === 1 && shown.toUpperCase() === 'FF0000', `open ${open}, shows ${shown}`);

// ---- a page with a photo, text and a shadow on it can be picked from as well
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 120; c.height = 80; const x = c.getContext('2d'); x.fillStyle = '#00c864'; x.fillRect(0, 0, 120, 80); return c.toDataURL('image/png').split(',')[1]; });
const dt = await page.evaluateHandle(b => { const d = new DataTransfer(); d.items.add(new File([Uint8Array.from(atob(b), c => c.charCodeAt(0))], 'green.png', { type: 'image/png' })); return d; }, png);
await page.locator('.stage').dispatchEvent('drop', { dataTransfer: dt, clientX: box.x + 300, clientY: box.y + 500 });
await page.waitForFunction(() => Object.values(window.__vs.doc.value.nodes).some(n => n.fills?.some(f => f.type === 'image')));
await page.keyboard.press('t'); await page.mouse.click(...P(500, 500)); await page.keyboard.type('Hello'); await page.keyboard.press('Escape');
await page.evaluate(id => window.__vs.update(d => ({ ...d, nodes: { ...d.nodes, [id]: { ...d.nodes[id], effects: [{ type: 'drop-shadow', visible: true, color: { r: 0, g: 0, b: 0, a: 0.5 }, x: 4, y: 4, blur: 8, spread: 0 }] } } })), a.id);
await page.evaluate(id => window.__vs.select([id]), b.id);
await page.waitForTimeout(500);
await page.keyboard.press('i');
await page.waitForSelector('.eyedrop', { timeout: 8000 });
await page.mouse.click(...P(300, 500));
check('picks from an image, with text and effects on the page', await fillHex(b.id) === '00c864', await fillHex(b.id));

check('no errors in the page', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
