// Browser test for the bundled typefaces: a family from the full Google Fonts set, the weights
// of a variable font on the canvas and as outlines.
//   node test/e2e/fonts.mjs <url> <chromium-executable>      (BROWSER=firefox for Firefox)
import { chromium, firefox } from 'playwright';

const [url = 'http://127.0.0.1:5199', exe] = process.argv.slice(2);
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
await page.evaluate(() => { window.__vs.view.value = { x: 0, y: 0, zoom: 1 }; });

const manifest = await page.evaluate(async () => (await fetch('fonts/manifest.json')).json());
const families = new Set(manifest.map(f => f.family));
check('the Google Fonts catalogue is bundled', families.size > 1500 && ['Playfair Display', 'Bebas Neue', 'Pacifico', 'Noto Sans', 'Montserrat'].every(f => families.has(f)), `${families.size} families`);
check('every font has its licence notice', await page.evaluate(async () => { const t = await (await fetch('fonts/LICENSES.txt')).text(); return t.includes('Playfair Display') && t.includes('SIL OPEN FONT LICENSE'); }));

await page.keyboard.press('t');
await page.mouse.click(box.x + 200, box.y + 300);
await page.keyboard.type('Hamburgefonstiv');
await page.keyboard.press('Escape');
const id = await page.evaluate(() => window.__vs.selection.value[0]);

// pick the family the way a user does
await page.locator('.font-btn').click();
await page.locator('.popover input.search, input.search').first().fill('Playfair Display');
await page.keyboard.press('Enter');
const style = page.locator('select[title="Font style"]');
const options = await style.locator('option').allTextContents();
check('a variable font offers its whole weight range', ['Regular', 'Medium', 'Semi Bold', 'Bold', 'Extra Bold', 'Black', 'Black Italic'].every(o => options.includes(o)), options.join(', '));

const width = async weight => {
  await style.selectOption(String(weight));
  await page.waitForFunction(w => document.fonts.check(`${w} 20px "Playfair Display"`), weight, { timeout: 15000 });
  await page.waitForTimeout(400);
  return page.evaluate(i => document.querySelector(`.stage [data-id="${i}"]`).getBoundingClientRect().width, id);
};
const w400 = await width(400), w900 = await width(900);
check('the weight changes what is drawn', w900 > w400 * 1.05, `400: ${w400.toFixed(1)}  900: ${w900.toFixed(1)}`);

// outlines follow the weight too
const outline = async weight => {
  await style.selectOption(String(weight));
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+e');
  await page.waitForFunction(i => window.__vs.doc.value.nodes[window.__vs.selection.value[0]]?.type === 'path', id, { timeout: 15000 });
  const r = await page.evaluate(() => {
    const n = window.__vs.doc.value.nodes[window.__vs.selection.value[0]];
    const xs = n.subpaths.flatMap(sp => sp.pts.map(p => p.x)), ys = n.subpaths.flatMap(sp => sp.pts.map(p => p.y));
    // area of the outlines: bolder letters cover more
    let area = 0;
    for (const sp of n.subpaths) for (let i = 0; i < sp.pts.length; i++) { const a = sp.pts[i], b = sp.pts[(i + 1) % sp.pts.length]; area += a.x * b.y - b.x * a.y; }
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), area: Math.abs(area) / 2, contours: n.subpaths.length };
  });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  return r;
};
const o400 = await outline(400), o900 = await outline(900);
check('text becomes outlines', o400.contours > 15 && o400.w > 50, JSON.stringify(o400));
check('outlines of the heavier weight are heavier', o900.area > o400.area * 1.3 && o900.w > o400.w * 1.05, `400: ${JSON.stringify(o400)}  900: ${JSON.stringify(o900)}`);
check('outlines are as wide as the text on the canvas', Math.abs(o900.w - w900) < w900 * 0.04, `outline ${o900.w.toFixed(1)}  canvas ${w900.toFixed(1)}`);

check('no errors in the page', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
