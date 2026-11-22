// Folder storage (Chromium): the directory picker cannot be driven by automation, so it is
// replaced by a function handing out a directory handle; everything after that is the real code
// path (copying projects over, remembering the handle, reopening it after a reload).
//   node test/e2e/folder.mjs <url> <chromium-executable>
import { chromium } from 'playwright';

const [url = 'http://127.0.0.1:5199', exe] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: exe || undefined });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => void d.accept());
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
const ready = async () => { await page.waitForSelector('.stage'); await page.waitForFunction(() => window.__vs?.project.value && window.__vs.storage.value.state === 'ready'); };
const fake = () => page.addInitScript(() => {
  window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder', { create: true });
});
const listFolder = () => page.evaluate(async () => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder', { create: true });
  const out = [];
  const walk = async (d, p) => { for await (const [n, h] of d.entries()) { if (h.kind === 'directory') await walk(h, p + n + '/'); else out.push(p + n); } };
  await walk(dir, '');
  return out.sort();
});

await fake();
await page.goto(url);
await ready();
check('starts in browser storage', await page.evaluate(() => window.__vs.storage.value.kind === 'browser' && window.__vs.storage.value.canPickFolder));

// draw something so there is a project worth moving
const box = await page.locator('.stage').boundingBox();
await page.keyboard.press('r');
await page.mouse.move(box.x + 300, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 420, box.y + 380, { steps: 5 }); await page.mouse.up();
await page.waitForFunction(() => window.__vs.saveState.value === 'saved');

await page.locator('.project-name').click();
await Promise.all([page.waitForNavigation(), page.locator('.storage-box button', { hasText: 'Use a folder' }).click()]);
await ready();
const st = await page.evaluate(() => window.__vs.storage.value);
check('switches to the chosen folder', st.kind === 'folder' && st.name === 'picked-folder', JSON.stringify(st));
check('existing project was copied into the folder', (await listFolder()).includes('Untitled.vsk/doc.json'), JSON.stringify(await listFolder()));
check('the drawing is there', await page.evaluate(() => Object.values(window.__vs.doc.value.nodes).some(n => n.type === 'rect')));

// edits land in the folder
await page.keyboard.press('o');
await page.mouse.move(box.x + 500, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 560, box.y + 360, { steps: 5 }); await page.mouse.up();
await page.waitForFunction(() => window.__vs.saveState.value === 'saved');
const stored = await page.evaluate(async () => {
  const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder')).getDirectoryHandle('Untitled.vsk');
  return JSON.parse(await (await (await dir.getFileHandle('doc.json')).getFile()).text());
});
check('edits are written into the folder', Object.values(stored.nodes).some(n => n.type === 'ellipse'));
check('save badge names the folder', (await page.locator('.save-badge').innerText()).includes('picked-folder'), await page.locator('.save-badge').innerText());

// the folder is remembered
await page.reload();
await ready();
check('folder is reopened after a reload', await page.evaluate(() => window.__vs.storage.value.kind === 'folder' && Object.values(window.__vs.doc.value.nodes).length === 2));

// a file changed by another program shows up
stored.pages[0].name = 'Renamed elsewhere';
await page.evaluate(async text => {
  const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder')).getDirectoryHandle('Untitled.vsk');
  const w = await (await dir.getFileHandle('doc.json')).createWritable();
  await w.write(text); await w.close();
}, JSON.stringify(stored));
await page.waitForFunction(() => window.__vs.doc.value.pages[0].name === 'Renamed elsewhere', null, { timeout: 6000 }).then(() => check('outside change to the folder appears live', true)).catch(() => check('outside change to the folder appears live', false));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
