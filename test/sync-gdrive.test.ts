// Google Drive sync tests against an in-process FAKE of the Drive v3 REST API
// (test/sync-testkit.ts) and an injected `authorize`. This checks our request shapes, token
// handling, pagination, folder handling and the engine/manager on top, but NOT the real
// Google API and NOT the real popup / iframe sign-in.
// Run: nix develop -c node --test test/sync*.test.ts

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MemoryKV, MemoryWorkspace } from '../src/storage/workspace.ts';
import { UnauthorizedError } from '../src/sync/backend.ts';
import { GDriveBackend } from '../src/sync/gdrive.ts';
import { createSyncManager } from '../src/sync/index.ts';
import type { RemoteStatus } from '../src/sync/index.ts';
import { buildAuthUrl, oauthRedirectUri, parseAuthFragment, popupAuthorize } from '../src/sync/oauth-popup.ts';
import { defineSyncScenarios, docBytes, docPath, FakeDrive, md5, sleep, text, until } from './sync-testkit.ts';

const enc = (s: string) => new TextEncoder().encode(s);

function setup(folderName = 'VibeSketch', drive = new FakeDrive()) {
  let token = drive.mintToken();
  const calls: boolean[] = [];
  const backend = new GDriveBackend({
    folderName,
    getToken: async (forceNew) => {
      calls.push(forceNew);
      if (forceNew) token = drive.mintToken();
      return token;
    },
  }, drive.fetch);
  backend.backoffMs = 0;
  return { drive, backend, calls };
}

describe('sync engine (fake Google Drive)', () => {
  const drive = new FakeDrive();
  defineSyncScenarios({
    backend: (scope) => setup(scope, drive).backend,
    bigBytes: 6 * 1024 * 1024, // > 5 MB: goes through the resumable upload path
  });
});

describe('Google Drive backend (fake API)', () => {
  test('a rejected access token is renewed exactly once per request', async () => {
    const { drive, backend, calls } = setup();
    await backend.put('P.vsk/doc.json', enc('one'), 1_700_000_000_000);
    await backend.list();
    assert.ok(calls.every((c) => c === false));

    drive.validAccess.clear(); // revoked / expired on Google's side
    assert.equal((await backend.list()).length, 1);
    assert.equal(calls.filter(Boolean).length, 1, 'asked for a new token once');

    // a token source that cannot help -> UnauthorizedError, not an endless loop
    let apiCalls = 0;
    const always401: typeof fetch = async () => {
      apiCalls++;
      return new Response('{"error":{"code":401,"message":"Invalid Credentials"}}', { status: 401 });
    };
    const b = new GDriveBackend({ folderName: 'X', getToken: async () => 'whatever' }, always401);
    await assert.rejects(b.list(), UnauthorizedError);
    assert.equal(apiCalls, 2, 'original attempt + exactly one retry');

    const noToken = new GDriveBackend({ folderName: 'X', getToken: async () => { throw new UnauthorizedError('sign in'); } }, drive.fetch);
    await assert.rejects(noToken.test(), UnauthorizedError);
  });

  test('rate limits and server errors are retried with backoff, other errors are not', async () => {
    const { drive, backend } = setup();
    await backend.put('P.vsk/doc.json', enc('x'), Date.now());
    drive.inject.push(
      { status: 429, body: { error: { code: 429, message: 'Too Many Requests', errors: [{ reason: 'rateLimitExceeded' }] } } },
      { status: 403, body: { error: { code: 403, message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } } },
      { status: 503, body: { error: { code: 503, message: 'Backend Error' } } },
    );
    const before = drive.log.length;
    assert.equal((await backend.list()).length, 1);
    assert.equal(drive.inject.length, 0);
    assert.ok(drive.log.length - before >= 4);

    drive.inject.push({ status: 403, body: { error: { code: 403, message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] } } });
    const n = drive.log.length;
    await assert.rejects(backend.list(), /Insufficient Permission \(403\)/);
    assert.equal(drive.log.length - n, 1, 'a real 403 is not retried');

    backend.maxAttempts = 3;
    for (let i = 0; i < 3; i++) drive.inject.push({ status: 429, body: { error: { message: 'slow down' } } });
    await assert.rejects(backend.list(), /slow down \(429\)/);
  });

  test('list: paginated, excludes trashed and foreign files, version = md5Checksum', async () => {
    const { drive, backend } = setup();
    drive.pageSize = 3;
    const contents = new Map<string, string>();
    for (let i = 0; i < 4; i++) {
      for (const f of ['doc.json', 'assets/aaaaaaaaaaaaaaaa.png']) {
        const p = `Project ${i}.vsk/${f}`;
        contents.set(p, `content ${i} ${f}`);
        await backend.put(p, enc(contents.get(p)!), 1_700_000_000_000 + i * 1000);
      }
    }
    const other = setup('SomethingElse', drive).backend;
    await other.put('Elsewhere.vsk/doc.json', enc('nope'), Date.now());

    const fresh = setup('VibeSketch', drive).backend; // no cached tree
    const before = drive.log.length;
    const listed = await fresh.list();
    assert.deepEqual(listed.map((e) => e.path).sort(), [...contents.keys()].sort());
    for (const e of listed) {
      assert.equal(e.version, md5(contents.get(e.path)!));
      assert.equal(e.md5, e.version);
      assert.equal(e.size, contents.get(e.path)!.length);
    }
    assert.equal(listed.find((e) => e.path === 'Project 2.vsk/doc.json')!.mtime, 1_700_000_002_000, 'modifiedTime carries the local mtime');
    const pages = drive.log.slice(before).filter((l) => l.startsWith('GET /drive/v3/files?') && l.includes('pageSize'));
    assert.ok(pages.filter((l) => l.includes('pageToken')).length >= 5, 'followed nextPageToken');

    await fresh.delete('Project 1.vsk/doc.json');
    assert.ok(!(await fresh.list()).some((e) => e.path === 'Project 1.vsk/doc.json'));
    assert.ok([...drive.files.values()].some((f) => f.name === 'doc.json' && f.trashed), 'deleted files go to the Drive trash');
    assert.deepEqual((await other.list()).map((e) => e.path), ['Elsewhere.vsk/doc.json']);
  });

  test('folders: root + nested folders are created on demand, exactly once', async () => {
    const { drive, backend } = setup('My Sketches');
    await Promise.all([
      backend.put("O'Brien & co.vsk/doc.json", enc('d'), Date.now()),
      backend.put("O'Brien & co.vsk/assets/aaaaaaaaaaaaaaaa.png", enc('a'), Date.now()),
      backend.put("O'Brien & co.vsk/assets/bbbbbbbbbbbbbbbb.png", enc('b'), Date.now()),
    ]);
    const folders = [...drive.files.values()].filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
    assert.deepEqual(folders.map((f) => f.name).sort(), ['My Sketches', "O'Brien & co.vsk", 'assets']);
    assert.deepEqual(folders.find((f) => f.name === 'My Sketches')!.parents, ['root']);
    assert.deepEqual(drive.paths('My Sketches'), [
      "O'Brien & co.vsk/assets/aaaaaaaaaaaaaaaa.png", "O'Brien & co.vsk/assets/bbbbbbbbbbbbbbbb.png", "O'Brien & co.vsk/doc.json",
    ]);

    // a second device finds and reuses the same folders
    const second = setup('My Sketches', drive).backend;
    await second.put("O'Brien & co.vsk/assets/cccccccccccccccc.png", enc('c'), Date.now());
    await second.put('New.vsk/doc.json', enc('n'), Date.now());
    const after = [...drive.files.values()].filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
    assert.deepEqual(after.map((f) => f.name).sort(), ['My Sketches', 'New.vsk', "O'Brien & co.vsk", 'assets']);
    assert.equal((await second.list()).length, 5);
  });

  test('upload / download paths: multipart create, PATCH update, resumable for large files', async () => {
    const { drive, backend } = setup();
    const v1 = await backend.put('P.vsk/doc.json', enc('{"v":1}'), 1_600_000_000_000);
    assert.equal(v1, md5('{"v":1}'));
    assert.ok(drive.log.includes('POST /upload/drive/v3/files?fields&uploadType'));
    const file = [...drive.files.values()].find((f) => f.name === 'doc.json')!;
    assert.equal(file.modifiedTime, new Date(1_600_000_000_000).toISOString());

    const v2 = await backend.put('P.vsk/doc.json', enc('{"v":2}'), 1_600_000_100_000);
    assert.equal(v2, md5('{"v":2}'));
    assert.ok(drive.log.includes(`PATCH /upload/drive/v3/files/${file.id}?fields&uploadType`), 'updates go to the existing file id');
    assert.equal([...drive.files.values()].filter((f) => f.name === 'doc.json').length, 1, 'no duplicate file');

    const got = await backend.get('P.vsk/doc.json');
    assert.equal(text(got.bytes), '{"v":2}');
    assert.equal(got.version, v2);
    assert.equal(got.mtime, 1_600_000_100_000);
    assert.ok(got.bytes instanceof Uint8Array && !Buffer.isBuffer(got.bytes));
    assert.ok(drive.log.includes(`GET /drive/v3/files/${file.id}?alt`));

    // binary content with bytes that look like multipart delimiters survives
    const tricky = new Uint8Array([...enc('\r\n--vibesketch-\r\n\r\n'), 0, 255, 13, 10, 45, 45]);
    await backend.put('P.vsk/assets/0000000000000000.bin', tricky, Date.now());
    assert.deepEqual((await backend.get('P.vsk/assets/0000000000000000.bin')).bytes, tricky);

    const big = new Uint8Array(5 * 1024 * 1024 + 17).fill(7);
    let n = drive.log.length;
    assert.equal(await backend.put('P.vsk/assets/1111111111111111.bin', big, 1_600_000_200_000), md5(big));
    assert.deepEqual(drive.log.slice(n).filter((c) => c.includes('/upload/')), [
      'POST /upload/drive/v3/files?fields&uploadType',
      'PUT /upload/drive/v3/files?fields&uploadType&upload_id',
    ]);
    assert.deepEqual((await backend.get('P.vsk/assets/1111111111111111.bin')).bytes, big);

    // the browser cannot read the session URL (header not exposed): multipart still delivers
    drive.hideLocation = true;
    n = drive.log.length;
    big[0] = 9;
    assert.equal(await backend.put('P.vsk/assets/2222222222222222.bin', big, Date.now()), md5(big));
    assert.equal(drive.log.slice(n).filter((c) => c.includes('/upload/')).length, 2);
    assert.deepEqual((await backend.get('P.vsk/assets/2222222222222222.bin')).bytes, big);
    drive.hideLocation = false;

    // the file disappears remotely behind our back: the next upload re-creates it
    file.trashed = true;
    await backend.put('P.vsk/doc.json', enc('{"v":3}'), Date.now());
    assert.equal(text((await setup('VibeSketch', drive).backend.get('P.vsk/doc.json')).bytes), '{"v":3}');
    await assert.rejects(backend.get('Nope.vsk/doc.json'), /not found/);
  });

  test('duplicate files at one path (two devices racing): newest wins, delete removes all', async () => {
    const { drive } = setup();
    const m1 = setup('VibeSketch', drive).backend;
    await m1.put('Seed.vsk/doc.json', enc('seed'), 1000);
    const m2 = setup('VibeSketch', drive).backend;
    await m1.list();
    await m2.list();
    await m1.put('Race.vsk/doc.json', enc('older'), 1_700_000_000_000);
    await m2.put('Race.vsk/doc.json', enc('newer'), 1_700_000_005_000);
    const m3 = setup('VibeSketch', drive).backend;
    assert.deepEqual((await m3.list()).map((e) => e.path).sort(), ['Race.vsk/doc.json', 'Seed.vsk/doc.json']);
    assert.equal(text((await m3.get('Race.vsk/doc.json')).bytes), 'newer');
    await m3.delete('Race.vsk/doc.json');
    assert.deepEqual((await setup('VibeSketch', drive).backend.list()).map((e) => e.path), ['Seed.vsk/doc.json']);
  });
});

describe('Google sign-in helpers', () => {
  test('consent URL (implicit flow) and silent variant', () => {
    const u = new URL(buildAuthUrl({ clientId: 'cid.apps.googleusercontent.com', redirectUri: 'https://app.example/vibe/oauth.html', state: 'st' }));
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(u.searchParams.get('response_type'), 'token');
    assert.equal(u.searchParams.get('client_id'), 'cid.apps.googleusercontent.com');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://app.example/vibe/oauth.html');
    assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
    assert.equal(u.searchParams.get('state'), 'st');
    assert.equal(u.searchParams.get('include_granted_scopes'), 'true');
    assert.equal(u.searchParams.get('prompt'), null);
    const silent = new URL(buildAuthUrl({ clientId: 'c', redirectUri: 'https://x/oauth.html', state: 's', silent: true }));
    assert.equal(silent.searchParams.get('prompt'), 'none');
  });

  test('fragment parsing validates state and reports errors', () => {
    const now = 1_000_000;
    assert.deepEqual(parseAuthFragment('#state=abc&access_token=ya29.x&token_type=Bearer&expires_in=3599&scope=x', 'abc', now),
      { accessToken: 'ya29.x', expiresAt: now + 3_599_000 });
    assert.equal(parseAuthFragment('#state=evil&access_token=ya29.x&expires_in=3599', 'abc', now), null, 'foreign state is ignored');
    assert.equal(parseAuthFragment('#access_token=ya29.x', 'abc', now), null);
    assert.equal(parseAuthFragment('#state=&access_token=ya29.x', '', now), null, 'an empty expected state never matches');
    assert.throws(() => parseAuthFragment('#state=abc&error=access_denied', 'abc'), /not granted/);
    assert.throws(() => parseAuthFragment('#state=abc&error=interaction_required', 'abc'), /sign in again/);
    assert.throws(() => parseAuthFragment('#state=abc', 'abc'), /no access token/);
  });

  test('outside a browser the popup flow fails cleanly', async () => {
    assert.equal(oauthRedirectUri(), '');
    await assert.rejects(popupAuthorize('cid', true), /needs a browser/);
  });
});

describe('SyncManager with Google Drive (fake API, injected authorize)', () => {
  function harness(drive = new FakeDrive(), ws = new MemoryWorkspace(), kv = new MemoryKV()) {
    const auth = { interactive: 0, silent: 0, silentWorks: true, ttlMs: 3600_000, sync: [] as string[] };
    const statuses: RemoteStatus[][] = [];
    const changed: string[] = [];
    const mgr = createSyncManager({
      workspace: ws, kv, fetch: drive.fetch, pollMs: 50, debounceMs: 10,
      onStatus: (r) => statuses.push(r), onLocalChanged: (p) => changed.push(...p),
      authorize: (clientId, interactive) => {
        // record synchronously: connectGdrive must reach us before any await
        auth.sync.push(`${interactive ? 'interactive' : 'silent'}:${clientId}`);
        if (interactive) auth.interactive++;
        else auth.silent++;
        if (!interactive && !auth.silentWorks) return Promise.reject(new Error('interaction_required'));
        return Promise.resolve({ accessToken: drive.mintToken(), expiresAt: Date.now() + auth.ttlMs });
      },
    });
    const state = () => mgr.remotes()[0]!;
    return { drive, ws, kv, auth, statuses, changed, mgr, state };
  }

  test('connect, sync both ways, pick up outside changes by polling', async () => {
    const drive = new FakeDrive();
    const A = harness(drive);
    const B = harness(drive);
    try {
      await A.mgr.ready;
      const st = await A.mgr.putRemote('drive', { type: 'gdrive', name: 'My Drive', clientId: 'cid-1', folderName: 'Sketches' });
      assert.equal(st.state, 'unauthorized');
      assert.deepEqual(st.config, { id: 'drive', type: 'gdrive', name: 'My Drive', enabled: true, clientId: 'cid-1', folderName: 'Sketches', connected: false, redirectUri: '' });
      assert.deepEqual(await A.mgr.test('drive'), { ok: false, error: 'Not connected to Google Drive yet' });
      assert.equal(A.auth.silent, 0, 'no silent sign-in attempts before the user ever connected');

      // connectGdrive calls authorize synchronously (popup must open inside the click)
      const connecting = A.mgr.connectGdrive('drive');
      assert.deepEqual(A.auth.sync, ['interactive:cid-1']);
      await connecting;
      assert.equal(A.state().config.connected, true);
      await until('A idle', () => A.state().state === 'idle' && A.state().lastSync !== null);
      assert.deepEqual(await A.mgr.test('drive'), { ok: true });

      await B.mgr.ready;
      await B.mgr.putRemote('drive', { type: 'gdrive', clientId: 'cid-1', folderName: 'Sketches' });
      await B.mgr.connectGdrive('drive');

      // editor in A saves + notifies
      await A.ws.write(docPath('Hello Drive'), docBytes('v1'));
      A.mgr.notifyLocalChange();
      await until('upload', () => drive.paths('Sketches').includes('Hello Drive.vsk/doc.json'));
      await until('doc in B', async () => (await B.ws.read(docPath('Hello Drive'))) !== null);
      await until('onLocalChanged in B', () => B.changed.length > 0);
      assert.deepEqual(B.changed, ['Hello Drive.vsk/doc.json']);

      // B's folder is edited by another program: nobody calls notifyLocalChange
      await B.ws.write(docPath('Hello Drive'), docBytes('v2 from outside'));
      await until('edit in A', async () => text(await A.ws.read(docPath('Hello Drive')))?.includes('from outside') === true);
      await until('onLocalChanged in A', () => A.changed.length > 0);
      assert.deepEqual(A.changed, ['Hello Drive.vsk/doc.json']);

      // tokens live in the KV, never in statuses or the workspace
      const stored = await A.kv.get<{ accessToken: string }>('sync.gdrive.token.drive');
      assert.match(stored!.accessToken, /^access-/);
      assert.ok(!JSON.stringify(A.statuses).includes(stored!.accessToken));
      assert.ok(![...A.ws.files.values()].some((f) => text(f.data)!.includes(stored!.accessToken)));
      assert.ok(!JSON.stringify(await A.kv.get('sync.remotes')).includes('access-'));

      await assert.rejects(A.mgr.connectGdrive('nope'), /unknown remote/);
    } finally {
      A.mgr.dispose();
      B.mgr.dispose();
    }
  });

  test('token expiry: one silent renewal, and "unauthorized" when that fails', async () => {
    const h = harness();
    try {
      await h.mgr.ready;
      await h.mgr.putRemote('drive', { type: 'gdrive', clientId: 'cid-1' });
      await h.mgr.connectGdrive('drive');
      await h.mgr.syncNow();
      assert.equal(h.state().state, 'idle');
      assert.equal(h.auth.silent, 0);

      // the stored token has expired -> exactly one silent renewal, sync keeps working
      const tok = (await h.kv.get<{ accessToken: string; expiresAt: number }>('sync.gdrive.token.drive'))!;
      await h.kv.set('sync.gdrive.token.drive', { ...tok, expiresAt: Date.now() - 1000 });
      await h.ws.write(docPath('After expiry'), docBytes('x'));
      await h.mgr.syncNow();
      assert.equal(h.state().state, 'idle');
      assert.equal(h.auth.silent, 1);
      assert.deepEqual(h.drive.paths('VibeSketch'), ['After expiry.vsk/doc.json']);
      const renewed = (await h.kv.get<{ accessToken: string; expiresAt: number }>('sync.gdrive.token.drive'))!;
      assert.notEqual(renewed.accessToken, tok.accessToken);
      assert.ok(renewed.expiresAt > Date.now());

      // Google revokes the (unexpired) token: the 401 also leads to one silent renewal
      h.drive.validAccess.clear();
      await h.ws.write(docPath('After revoke'), docBytes('y'));
      await h.mgr.syncNow();
      assert.equal(h.state().state, 'idle');
      assert.equal(h.auth.silent, 2);

      // now the silent renewal fails too -> unauthorized, and no hammering of the sign-in
      h.auth.silentWorks = false;
      h.drive.validAccess.clear();
      await h.ws.write(docPath('Offline work'), docBytes('z'));
      await h.mgr.syncNow();
      assert.equal(h.state().state, 'unauthorized');
      assert.match(h.state().error ?? '', /connect again/);
      assert.equal(h.state().config.connected, false);
      const silentAfter = h.auth.silent;
      await sleep(250); // several poll intervals
      assert.equal(h.auth.silent, silentAfter, 'an unauthorized remote waits for the user');
      assert.ok(!h.drive.paths('VibeSketch').includes('Offline work.vsk/doc.json'));

      // the user clicks Connect: back in business, the pending work goes up
      await h.mgr.connectGdrive('drive');
      await until('upload after reconnect', () => h.drive.paths('VibeSketch').includes('Offline work.vsk/doc.json'));
      await until('idle', () => h.state().state === 'idle');
      assert.equal(h.state().config.connected, true);
      assert.equal(h.auth.interactive, 2);

      // a denied / closed popup leaves the state alone and rejects
      const denied = harness();
      await denied.mgr.ready;
      await denied.mgr.putRemote('d', { type: 'gdrive', clientId: 'c' });
      const failing = createSyncManager({
        workspace: denied.ws, kv: denied.kv, fetch: denied.drive.fetch, onStatus: () => {}, onLocalChanged: () => {},
        authorize: () => Promise.reject(new Error('Access to Google Drive was not granted')),
      });
      await failing.ready;
      await assert.rejects(failing.connectGdrive('d'), /not granted/);
      assert.equal(failing.remotes()[0]!.state, 'unauthorized');
      failing.dispose();
      denied.mgr.dispose();
    } finally {
      h.mgr.dispose();
    }
  });

  test('changing the client id disconnects; deleting removes token and manifest', async () => {
    const h = harness();
    try {
      await h.mgr.ready;
      await h.mgr.putRemote('drive', { type: 'gdrive', clientId: 'cid-1' });
      await h.mgr.connectGdrive('drive');
      await h.ws.write(docPath('P'), docBytes('p'));
      await h.mgr.syncNow();
      assert.notEqual(await h.ws.read('.vibesketch/sync-drive.json'), null);

      const renamed = await h.mgr.putRemote('drive', { name: 'Renamed' });
      assert.equal(renamed.config.connected, true, 'unrelated edits keep the connection');
      const changed = await h.mgr.putRemote('drive', { clientId: 'cid-2' });
      assert.equal(changed.state, 'unauthorized');
      assert.equal(changed.config.connected, false);
      assert.equal(await h.kv.get('sync.gdrive.token.drive'), undefined);

      await h.mgr.connectGdrive('drive');
      assert.deepEqual(h.auth.sync.at(-1), 'interactive:cid-2');
      await h.mgr.deleteRemote('drive');
      assert.equal(await h.kv.get('sync.gdrive.token.drive'), undefined);
      assert.equal(await h.ws.read('.vibesketch/sync-drive.json'), null);
      assert.notEqual(await h.ws.read(docPath('P')), null, 'local files stay');
      assert.deepEqual(h.drive.paths('VibeSketch'), ['P.vsk/doc.json'], 'remote files stay');
      assert.deepEqual(h.statuses.at(-1), []);
    } finally {
      h.mgr.dispose();
    }
  });

  test('polling pauses while the tab is hidden and resumes with an immediate pass', async () => {
    const g = globalThis as { document?: unknown };
    assert.equal(g.document, undefined);
    const doc = Object.assign(new EventTarget(), { hidden: false, baseURI: 'https://app.example/vibe/index.html' });
    g.document = doc;
    const h = harness();
    try {
      await h.mgr.ready;
      const st = await h.mgr.putRemote('drive', { type: 'gdrive', clientId: 'cid-1' });
      assert.equal(st.config.redirectUri, 'https://app.example/vibe/oauth.html');
      await h.mgr.connectGdrive('drive');
      await until('first pass', () => h.state().lastSync !== null);

      doc.hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
      await sleep(80); // let a pass that was already running finish
      const n = h.drive.log.length;
      await h.ws.write(docPath('While hidden'), docBytes('h'));
      h.mgr.notifyLocalChange();
      await sleep(300);
      assert.equal(h.drive.log.length, n, 'no requests while hidden');

      doc.hidden = false;
      doc.dispatchEvent(new Event('visibilitychange'));
      await until('upload after resume', () => h.drive.paths('VibeSketch').includes('While hidden.vsk/doc.json'), 2000);
    } finally {
      h.mgr.dispose();
      delete g.document;
    }
    assert.equal(doc.hidden, false);
  });
});
