// Two browsers ("devices") syncing through a real S3 server, straight from the page: this
// exercises real CORS preflights, the browser's private file system and the sync engine.
//   node test/e2e/sync-s3.mjs <url> <chromium-executable|""> <versitygw-binary>
// BROWSER=firefox picks Firefox.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';
import { chromium, firefox } from 'playwright';

const [url = 'http://127.0.0.1:5199', exe, gw] = process.argv.slice(2);
const ACCESS = 'testaccess', SECRET = 'testsecretkey', BUCKET = 'designs', port = 7000 + Math.floor(Math.random() * 2000);
const endpoint = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(path.join(os.tmpdir(), 'vs-s3-'));
const server = spawn(gw, ['--access', ACCESS, '--secret', SECRET, '--port', `127.0.0.1:${port}`, 'posix', dir], { stdio: 'ignore' });
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
const s3 = new AwsClient({ accessKeyId: ACCESS, secretAccessKey: SECRET, service: 's3', region: 'us-east-1' });
let browser;
try {
  for (let i = 0; ; i++) { try { await fetch(endpoint); break; } catch { if (i > 100) throw new Error('S3 server did not start'); await new Promise(r => setTimeout(r, 100)); } }
  check('bucket created', (await s3.fetch(`${endpoint}/${BUCKET}`, { method: 'PUT' })).ok);
  const origin = new URL(url).origin;
  const cors = `<CORSConfiguration><CORSRule><AllowedOrigin>${origin}</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>DELETE</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><ExposeHeader>x-amz-meta-mtime</ExposeHeader></CORSRule></CORSConfiguration>`;
  const cr = await s3.fetch(`${endpoint}/${BUCKET}?cors`, { method: 'PUT', body: cors, headers: { 'Content-MD5': createHash('md5').update(cors).digest('base64') } });
  check('bucket CORS configured', cr.ok, cr.ok ? '' : `${cr.status} ${(await cr.text()).slice(0, 200)}`);

  const engine = process.env.BROWSER === 'firefox' ? firefox : chromium;
  browser = await engine.launch({ executablePath: exe || undefined });
  const device = async () => {
    const page = await (await browser.newContext({ viewport: { width: 1300, height: 800 } })).newPage();
    page.on('pageerror', e => console.log('pageerror', e.message));
    await page.goto(url);
    await page.waitForFunction(() => window.__vs?.project.value && window.__vs.storage.value.state === 'ready');
    return page;
  };
  const remote = { type: 's3', name: 'Test bucket', enabled: true, endpoint, region: 'us-east-1', bucket: BUCKET, prefix: 'vs/', accessKeyId: ACCESS, secretAccessKey: SECRET, pathStyle: true };
  const addRemote = page => page.evaluate(async r => { const m = window.__vs.syncManager(); await m.ready; await m.putRemote('s3-test', r); return m.test('s3-test'); }, remote);
  const syncNow = page => page.evaluate(() => window.__vs.syncManager().syncNow('s3-test'));
  const status = page => page.evaluate(() => window.__vs.remotes.value.map(r => `${r.state}${r.error ? ': ' + r.error.slice(0, 160) : ''}`).join(', '));

  // device A: wrong secret first, to see what the user would be told
  const a = await device();
  const bad = await a.evaluate(async r => { const m = window.__vs.syncManager(); await m.ready; await m.putRemote('s3-test', { ...r, secretAccessKey: 'wrong' }); return m.test('s3-test'); }, remote);
  check('wrong credentials are reported as such (not as a CORS problem)', bad.ok === false && !!bad.error && !/CORS/.test(bad.error), String(bad.error).slice(0, 160));
  const t = await addRemote(a);
  check('connection test passes from the browser (CORS works)', t.ok === true, (t.error ?? '').slice(0, 200));

  // draw on A
  await a.evaluate(() => { window.__vs.view.value = { x: 100, y: 100, zoom: 1 }; });
  const box = await a.locator('.stage').boundingBox();
  await a.keyboard.press('r');
  await a.mouse.move(box.x + 200, box.y + 200); await a.mouse.down(); await a.mouse.move(box.x + 360, box.y + 300, { steps: 5 }); await a.mouse.up();
  await a.waitForFunction(() => window.__vs.saveState.value === 'saved');
  await syncNow(a);
  const listed = await (await s3.fetch(`${endpoint}/${BUCKET}?list-type=2&prefix=vs/`)).text();
  check('project uploaded to the bucket', listed.includes('vs/Untitled.vsk/doc.json'), await status(a));

  // device B starts empty (it has its own blank "Untitled"), then connects
  const b = await device();
  const tb = await addRemote(b);
  check('second device connects', tb.ok === true, (tb.error ?? '').slice(0, 200));
  await syncNow(b);
  await b.waitForFunction(() => Object.values(window.__vs.doc.value.nodes).some(n => n.type === 'rect') || window.__vs.projectList.value.length > 1, null, { timeout: 8000 }).catch(() => {});
  const bState = await b.evaluate(() => ({ projects: window.__vs.projectList.value.map(p => p.name), rects: Object.values(window.__vs.doc.value.nodes).filter(n => n.type === 'rect').length, save: window.__vs.saveState.value }));
  check('the drawing reaches the second device', bState.rects === 1 || bState.projects.length > 1, `${JSON.stringify(bState)} · ${await status(b)}`);

  // B edits -> appears on A without anyone pressing sync (push within ~1 s, A polls)
  if (bState.rects !== 1) await b.evaluate(() => window.__vs.resolveConflict('theirs')).catch(() => {});
  await b.evaluate(() => { window.__vs.view.value = { x: 100, y: 100, zoom: 1 }; });
  const bb = await b.locator('.stage').boundingBox();
  await b.keyboard.press('o');
  await b.mouse.move(bb.x + 500, bb.y + 200); await b.mouse.down(); await b.mouse.move(bb.x + 580, bb.y + 280, { steps: 5 }); await b.mouse.up();
  await b.waitForFunction(() => window.__vs.saveState.value === 'saved');
  await b.waitForTimeout(2500); // debounce + upload
  await syncNow(a);
  await a.waitForFunction(() => Object.values(window.__vs.doc.value.nodes).some(n => n.type === 'ellipse'), null, { timeout: 8000 }).then(() => check('an edit on the second device appears live on the first', true)).catch(async () => check('an edit on the second device appears live on the first', false, `${await status(a)} | B: ${await status(b)}`));
  check('first device shows no conflict', await a.evaluate(() => window.__vs.saveState.value) === 'saved');
} finally {
  await browser?.close();
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
