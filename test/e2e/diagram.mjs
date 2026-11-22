// Browser test for diagramming: the connector tool, attached ends following their shapes,
// end handles, the connector panel.
//   node test/e2e/diagram.mjs <url> <chromium-executable> [screenshot-dir]      (BROWSER=firefox for Firefox)
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
const shot = n => page.screenshot({ path: path.join(shots, `diagram-${n}.png`) });
const key = k => page.keyboard.press(k);
const drag = async (x0, y0, x1, y1, hold) => {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10);
  if (hold) await hold();
  await page.mouse.up();
  await page.waitForTimeout(450); // not the first half of a double-click
};
/** the connector with its end points in page space */
const conn = () => page.evaluate(() => {
  const d = window.__vs.doc.value;
  const n = Object.values(d.nodes).find(x => x.type === 'path' && x.connector);
  if (!n) return null;
  const m = n.transform, pts = n.subpaths[0].pts.map(p => [Math.round((m[0] * p.x + m[2] * p.y + m[4]) * 100) / 100, Math.round((m[1] * p.x + m[3] * p.y + m[5]) * 100) / 100]);
  return { id: n.id, connector: n.connector, startCap: n.startCap, endCap: n.endCap, first: pts[0], last: pts[pts.length - 1], count: pts.length, curved: n.subpaths[0].pts.some(p => p.in || p.out) };
});
const rects = () => page.evaluate(() => Object.values(window.__vs.doc.value.nodes).filter(n => n.type === 'rect').sort((a, b) => a.transform[4] - b.transform[4]).map(n => n.id));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

await page.goto(url);
await page.waitForSelector('.stage');
await page.waitForFunction(() => location.hash.length > 1 && window.__vs);
const box = await page.locator('.stage').boundingBox();
const P = (x, y) => [box.x + x, box.y + y]; // page space (at the view set below) -> mouse
await page.evaluate(() => { window.__vs.view.value = { x: 0, y: 0, zoom: 1 }; });

await key('r'); await drag(...P(150, 150), ...P(300, 230));
await key('r'); await drag(...P(500, 350), ...P(650, 430));
const [a, b] = await rects();
check('two boxes', !!a && !!b);

// ---- connector tool
await key('Escape');
await key('x');
check('X selects the connector tool', await page.evaluate(() => window.__vs.tool.value === 'connector'));
await page.mouse.move(...P(225, 190));
await shot('hover');
await drag(...P(225, 190), ...P(575, 390), () => shot('dragging'));
let c = await conn();
check('connector links the two boxes', !!c && eq(c.connector, { kind: 'elbow', radius: 12, from: { node: a, side: 'auto' }, to: { node: b, side: 'auto' } }), JSON.stringify(c?.connector));
check('it runs from the facing sides, with rounded bends and an arrowhead', !!c && eq(c.first, [300, 190]) && eq(c.last, [500, 390]) && c.curved && c.endCap === 'arrow', JSON.stringify(c));
check('the new connector is selected, tool back to move', await page.evaluate(id => window.__vs.selection.value[0] === id && window.__vs.tool.value === 'move', c?.id));
check('arrowhead is drawn', await page.locator(`.stage [data-id="${c?.id}"] polyline`).count() === 1);
await shot('connected');

// ---- moving a box takes the connector along
await drag(...P(630, 420), ...P(630, 220));
c = await conn();
check('connector follows the moved box', eq(c.first, [300, 190]) && eq(c.last, [500, 190]) && c.count === 2, JSON.stringify(c));
await drag(...P(630, 220), ...P(330, 520));
c = await conn();
check('sides switch when the box goes below', eq(c.first, [225, 230]) && c.last[1] === 450, JSON.stringify(c));
await key('Control+z');
c = await conn();
check('undo restores box and connector together', eq(c.last, [500, 190]), JSON.stringify(c));

// ---- end handles
await page.mouse.click(...P(400, 190));
await page.waitForTimeout(450);
check('clicking the line selects the connector', await page.evaluate(id => window.__vs.selection.value[0] === id, c.id));
await shot('selected');
await drag(...P(500, 190), ...P(520, 520));
c = await conn();
check('dragging an end into empty space frees it', c.connector.to === null && eq(c.last, [520, 520]) && eq(c.first, [225, 230]), JSON.stringify(c));
await drag(...P(520, 520), ...P(577, 152), () => shot('pin'));
c = await conn();
check('dropping it on a side dot pins that side', eq(c.connector.to, { node: b, side: 'top' }) && eq(c.last, [575, 150]), JSON.stringify(c));
await drag(...P(575, 150), ...P(400, 600));
await page.keyboard.down('Control');
await drag(...P(400, 600), ...P(575, 190));
await page.keyboard.up('Control');
c = await conn();
check('Ctrl keeps the end free even over a layer', c.connector.to === null && eq(c.last, [575, 190]), JSON.stringify(c));
await drag(...P(575, 190), ...P(600, 200));
c = await conn();
check('re-attached', eq(c.connector.to, { node: b, side: 'auto' }), JSON.stringify(c.connector));

// ---- panel
const section = page.locator('.section', { hasText: 'Connector' });
await section.locator('select').nth(0).selectOption('straight');
c = await conn();
check('straight connector', c.connector.kind === 'straight' && c.count === 2 && !c.curved, JSON.stringify(c));
await section.locator('select').nth(0).selectOption('curved');
c = await conn();
check('curved connector', c.connector.kind === 'curved' && c.count === 2 && c.curved);
await section.locator('select').nth(2).selectOption('triangle');
await section.locator('select').nth(1).selectOption('circle');
await page.waitForTimeout(150);
c = await conn();
check('arrowheads from the panel', c.endCap === 'triangle' && c.startCap === 'circle' && await page.locator(`.stage [data-id="${c.id}"] polygon`).count() === 1 && await page.locator(`.stage [data-id="${c.id}"] circle`).count() === 1);
await section.locator('select').nth(0).selectOption('elbow');
await section.getByText('Reverse direction').click();
c = await conn();
check('reverse direction', c.connector.from?.node === b && c.connector.to?.node === a && c.startCap === 'triangle', JSON.stringify(c));
await shot('styled');

// ---- point editing detaches only when something is edited
await page.mouse.dblclick(...P(400, 190));
await page.waitForTimeout(200);
check('double-click opens point editing', await page.evaluate(() => !!window.__vs.pathEdit.value));
await key('Escape');
c = await conn();
check('leaving without a change keeps it a connector', !!c && c.connector.from?.node === b, JSON.stringify(c?.connector));

// ---- stored, and survives a reload
await page.waitForFunction(() => window.__vs.saveState.value === 'saved', null, { timeout: 5000 }).catch(() => {});
await page.reload();
await page.waitForFunction(() => window.__vs && Object.keys(window.__vs.doc.value.nodes).length === 3, null, { timeout: 8000 }).catch(() => {});
c = await conn();
check('connector is saved with the project', !!c && c.connector.to?.node === a && c.startCap === 'triangle', JSON.stringify(c));

// ---- deleting a box leaves the connector with a free end
await page.evaluate(id => window.__vs.select([id]), a);
await key('Delete');
c = await conn();
check('deleting a box frees that end', !!c && c.connector.to === null && c.connector.from?.node === b, JSON.stringify(c?.connector));

check('no errors in the page', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
