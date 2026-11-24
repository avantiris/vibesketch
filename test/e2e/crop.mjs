// Browser test for cropping images: double-click, the frame handles, moving and scaling the picture.
//   node test/e2e/crop.mjs <url> <chromium-executable> [screenshot-dir]      (BROWSER=firefox for Firefox)
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
const drag = async (x0, y0, x1, y1) => { await page.mouse.move(x0, y0); await page.mouse.down(); for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8); await page.mouse.up(); await page.waitForTimeout(450); };

// a 200 x 100 picture: left half red, right half blue
const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 200; c.height = 100; const x = c.getContext('2d'); x.fillStyle = '#f00'; x.fillRect(0, 0, 100, 100); x.fillStyle = '#00f'; x.fillRect(100, 0, 100, 100); return c.toDataURL('image/png').split(',')[1]; });
const dt = await page.evaluateHandle(b => { const d = new DataTransfer(); d.items.add(new File([Uint8Array.from(atob(b), c => c.charCodeAt(0))], 'halves.png', { type: 'image/png' })); return d; }, png);
await page.locator('.stage').dispatchEvent('drop', { dataTransfer: dt, clientX: box.x + 500, clientY: box.y + 300 });
await page.waitForFunction(() => Object.values(window.__vs.doc.value.nodes).some(n => n.fills?.some(f => f.type === 'image')));
await page.waitForTimeout(400);
const node = () => page.evaluate(() => { const n = Object.values(window.__vs.doc.value.nodes).find(n => n.fills?.some(f => f.type === 'image')); return { id: n.id, x: n.transform[4], y: n.transform[5], w: n.w, h: n.h, fill: n.fills.find(f => f.type === 'image') }; });
/** the picture's rectangle on the page, from what is actually drawn */
const drawn = id => page.evaluate(id => { const r = document.querySelector(`.stage [data-id="${id}"] image`).getBoundingClientRect(), s = document.querySelector('.stage').getBoundingClientRect(); return [r.left - s.left, r.top - s.top, r.width, r.height].map(v => Math.round(v * 10) / 10); }, id);
const cropping = () => page.evaluate(() => !!document.querySelector('.badge') && [...document.querySelectorAll('.badge')].some(b => b.textContent === 'cropping'));
const near = (a, b, t = 0.6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= t);

let n = await node();
const { x: X, y: Y } = n;
check('dropped image', n.w === 200 && n.h === 100 && n.fill.mode === 'fill', JSON.stringify(n));

// ---- double-click starts cropping
await page.mouse.dblclick(...P(X + 100, Y + 50));
await page.waitForTimeout(200);
check('double-click on an image starts cropping', await cropping());
check('…and does not turn it into a vector', await page.evaluate(() => !window.__vs.pathEdit.value) && (await node()).w === 200);

// ---- cut the right half away
await drag(...P(X + 200, Y + 50), ...P(X + 100, Y + 50));
n = await node();
check('dragging the right handle cuts the picture', n.w === 100 && n.h === 100 && n.x === X && n.fill.mode === 'crop' && near([n.fill.crop.x, n.fill.crop.y, n.fill.crop.w, n.fill.crop.h], [0, 0, 2, 1], 0.001), JSON.stringify(n));
check('the picture itself stays where it was', near(await drawn(n.id), [X, Y, 200, 100]), JSON.stringify(await drawn(n.id)));
await page.screenshot({ path: path.join(shots, 'crop.png') });

// ---- cut from the left: the layer moves, the picture does not
await drag(...P(X, Y + 50), ...P(X + 40, Y + 50));
n = await node();
check('cutting from the left moves the frame, not the picture', n.w === 60 && n.x === X + 40 && near(await drawn(n.id), [X, Y, 200, 100]), JSON.stringify(n));

// ---- move the picture behind the frame
await drag(...P(X + 70, Y + 50), ...P(X + 20, Y + 50));
n = await node();
check('dragging the picture moves it behind the frame', n.w === 60 && n.x === X + 40 && near(await drawn(n.id), [X - 50, Y, 200, 100]), JSON.stringify(await drawn(n.id)));

// ---- edges catch on the picture's edge
await drag(...P(X + 100, Y + 50), ...P(X + 147, Y + 50));
n = await node();
check('the frame snaps to the edge of the picture', near([n.x + n.w], [X + 150]), JSON.stringify(n));

// ---- scale the picture from its corner handle
await drag(...P(X - 50, Y + 100), ...P(X - 150, Y + 150));
n = await node();
check('a corner of the picture scales it in proportion', near(await drawn(n.id), [X - 150, Y, 300, 150]), JSON.stringify(await drawn(n.id)));

// ---- leaving, undo
await page.keyboard.press('Escape');
check('Esc ends cropping, the layer stays selected', !(await cropping()) && await page.evaluate(id => window.__vs.selection.value[0] === id, n.id));
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
check('one undo per step', near(await drawn(n.id), [X - 50, Y, 200, 100]), JSON.stringify(await drawn(n.id)));

// ---- resizing a cropped layer scales the picture with it
n = await node();
await page.evaluate(id => window.__vs.update(d => ({ ...d, nodes: { ...d.nodes, [id]: { ...d.nodes[id], w: d.nodes[id].w * 2, h: d.nodes[id].h * 2 } } })), n.id);
await page.waitForTimeout(150);
const big = await drawn(n.id);
check('resizing a cropped layer scales the picture with it', near([big[2], big[3]], [400, 200]), JSON.stringify(big));

// ---- clicking outside ends cropping
await page.mouse.dblclick(...P(n.x + 20, n.y + 20));
await page.waitForTimeout(200);
check('crop again', await cropping());
await page.mouse.click(...P(700, 600));
await page.waitForTimeout(150);
check('a click outside ends cropping', !(await cropping()));

check('no errors in the page', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
