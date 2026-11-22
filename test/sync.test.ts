// Sync tests for the in-browser engine (src/sync), run in Node with MemoryWorkspaces.
//  - always: the two-workspace scenarios against an in-memory backend, helpers, S3 XML parsing,
//    CORS / network error wording
//  - when an S3 server binary is obtainable (versitygw or minio; on PATH or through nix): the
//    same scenarios against that real S3 server, plus S3-specific and SyncManager tests.
//    Without one, those tests are SKIPPED (not failed).
// Run: nix develop -c node --test test/sync*.test.ts
// Env: VIBESKETCH_TEST_S3=off disables the real-S3 part; VIBESKETCH_TEST_NO_NIX=1 only looks on PATH.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { AwsClient } from 'aws4fetch';
import { MemoryKV, MemoryWorkspace } from '../src/storage/workspace.ts';
import { PreconditionFailed } from '../src/sync/backend.ts';
import { createSyncManager } from '../src/sync/index.ts';
import type { RemoteStatus } from '../src/sync/index.ts';
import { parseListObjectsV2, S3Backend, s3CorsRule, xmlUnescape } from '../src/sync/s3.ts';
import type { S3Options } from '../src/sync/s3.ts';
import { conflictName, isSyncablePath, md5Hex, sha256Hex } from '../src/sync/util.ts';
import { defineSyncScenarios, docBytes, docPath, makeWs, md5, MemoryBackend, sha256, sleep, text, until } from './sync-testkit.ts';

// ---------------------------------------------------------------- helpers

describe('sync helpers', () => {
  test('md5 / sha256 match Node for awkward lengths', async () => {
    assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 65537]) {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = (i * 31 + n) & 255;
      assert.equal(md5Hex(b), md5(b), `md5 of ${n} bytes`);
      assert.equal(md5Hex(b.subarray(n >> 1)), md5(b.subarray(n >> 1)), `md5 of a subarray (${n})`);
      assert.equal(await sha256Hex(b), sha256(b));
    }
  });

  test('syncable paths and conflict names', () => {
    for (const ok of ['P.vsk/doc.json', 'Ünï 日本 & co.vsk/assets/0123abcd.png']) assert.equal(isSyncablePath(ok), true, ok);
    assert.equal(conflictName('P.vsk/doc.json', 'TS'), 'P.vsk/doc.conflict-TS.json');
    assert.equal(conflictName('P.vsk/assets/noext', 'TS'), 'P.vsk/assets/noext.conflict-TS');
    assert.equal(isSyncablePath(conflictName('P.vsk/doc.json', 'TS')), false);
  });
});

// ---------------------------------------------------------------- in-memory backend

describe('sync engine (in-memory backend)', () => {
  const remotes = new Map<string, MemoryBackend['files']>();
  defineSyncScenarios({
    backend: (scope) => {
      if (!remotes.has(scope)) remotes.set(scope, new Map());
      return new MemoryBackend(remotes.get(scope));
    },
    bigBytes: 2 * 1024 * 1024,
  });

  test('ignores unsafe / private paths in remote listings and in the workspace', async () => {
    const backend = new MemoryBackend();
    const evil = [
      '../evil.vsk/doc.json', '../../etc/passwd', '/abs.vsk/doc.json', 'P.vsk/../../escape.json', 'P.vsk/./doc.json',
      '.vibesketch/sync-test.json', '.hidden.vsk/doc.json', 'P.vsk/.secret', 'P.vsk/doc.conflict-2026.json',
      'notaproject/file.txt', 'toplevel.json', 'P.vsk//doc.json', 'P.vsk/a\\b', 'P.vsk/nul\0.json', '.vsk/doc.json',
      'P.vsk/doc.json.crswap',
    ];
    for (const p of evil) {
      assert.equal(isSyncablePath(p), false, p);
      backend.files.set(p, { bytes: new TextEncoder().encode('{"evil":true}'), mtime: Date.now(), version: 'v' });
    }
    backend.files.set('Good.vsk/doc.json', { bytes: docBytes('good'), mtime: Date.now(), version: 'g' });
    const w = makeWs(backend, 'evil');
    // local files that must never be uploaded
    await w.ws.write('.vibesketch/trash/old/X.vsk/doc.json', 'trash');
    await w.ws.write('Good.vsk/doc.conflict-2026-01-01T00-00-00-000Z.json', 'conflict');
    await w.ws.write('Good.vsk/.hidden', 'x');
    await w.ws.write('loose-file.txt', 'x');
    const r = await w.sync();
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.downloaded, ['Good.vsk/doc.json']);
    assert.deepEqual(r.uploaded, []);
    assert.equal(w.ws.files.size, 4 + 1 + 1, 'only Good.vsk/doc.json and the manifest were added');
    // and the engine does not delete what it does not manage
    assert.equal(backend.files.size, evil.length + 1);
    await w.close();
  });

  test('an unreadable workspace fails the pass instead of deleting the remote', async () => {
    const backend = new MemoryBackend();
    const w = makeWs(backend, 'vanish');
    await w.ws.write(docPath('Precious'), docBytes('p'));
    await w.sync();
    assert.equal(backend.files.size, 1);
    w.ws.list = async () => { throw new DOMException('gone', 'NotFoundError'); };
    await assert.rejects(w.sync());
    assert.equal(backend.files.size, 1);
    assert.equal(w.engine.getStatus().state, 'error');
    await w.close();
  });

  test('unchanged files are not re-read on later passes', async () => {
    const w = makeWs(new MemoryBackend(), 'reads');
    w.ws.now = () => Date.now() - 60_000; // files last modified a minute ago
    await w.ws.write(docPath('A'), docBytes('a'));
    await w.ws.write(docPath('B'), docBytes('b'));
    w.ws.now = () => Date.now();
    await w.sync();
    const reads: string[] = [];
    const realRead = w.ws.read.bind(w.ws);
    w.ws.read = async (p) => { reads.push(p); return realRead(p); };
    await w.sync();
    await w.ws.write(docPath('B'), docBytes('b2'));
    const r = await w.sync();
    assert.deepEqual(r.uploaded, [docPath('B')]);
    assert.deepEqual(reads.filter((p) => !p.startsWith('.vibesketch/')), [docPath('B')]);
    await w.close();
  });
});

// ---------------------------------------------------------------- S3 without a server

describe('S3 backend (no server)', () => {
  const opts: S3Options = {
    endpoint: '', region: 'eu-central-1', bucket: 'my-bucket', prefix: 'pre/', accessKeyId: 'k', secretAccessKey: 's', pathStyle: false,
  };

  test('ListObjectsV2 parsing: entities, url encoding, pagination markers', () => {
    assert.equal(xmlUnescape('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#x26; &#38; &amp;amp;'), 'a & b <c> "d" \'e\' & & &amp;');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><Prefix>team/</Prefix>
<EncodingType>url</EncodingType><KeyCount>2</KeyCount><MaxKeys>2</MaxKeys><IsTruncated>true</IsTruncated>
<NextContinuationToken>tok&amp;1==</NextContinuationToken>
<Contents><Key>team/A+%26+B%2B.vsk/doc.json</Key><LastModified>2026-01-02T03:04:05.000Z</LastModified>
<ETag>&quot;0123456789abcdef0123456789abcdef&quot;</ETag><Size>42</Size><StorageClass>STANDARD</StorageClass></Contents>
<Contents>
  <Key>team/%E6%97%A5%E6%9C%AC.vsk/assets/k.png</Key>
  <LastModified>2026-01-02T03:04:06Z</LastModified><ETag>"abc-2"</ETag><Size>7</Size>
</Contents></ListBucketResult>`;
    const page = parseListObjectsV2(xml);
    assert.equal(page.truncated, true);
    assert.equal(page.nextToken, 'tok&1==');
    assert.deepEqual(page.entries, [
      { key: 'team/A & B+.vsk/doc.json', etag: '0123456789abcdef0123456789abcdef', lastModified: Date.UTC(2026, 0, 2, 3, 4, 5), size: 42 },
      { key: 'team/日本.vsk/assets/k.png', etag: 'abc-2', lastModified: Date.UTC(2026, 0, 2, 3, 4, 6), size: 7 },
    ]);
    const plain = parseListObjectsV2('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a+b &amp; 100%.vsk/doc.json</Key><ETag>"x"</ETag><Size>1</Size></Contents></ListBucketResult>');
    assert.equal(plain.truncated, false);
    assert.equal(plain.entries[0]!.key, 'a+b & 100%.vsk/doc.json');
    assert.deepEqual(parseListObjectsV2('<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>').entries, []);
  });

  test('URL styles', async () => {
    const seen: string[] = [];
    const fake: typeof fetch = async (input) => {
      seen.push((input as Request).url);
      return new Response('<ListBucketResult></ListBucketResult>', { status: 200 });
    };
    await new S3Backend(opts, fake).test();
    await new S3Backend({ ...opts, pathStyle: true }, fake).test();
    await new S3Backend({ ...opts, endpoint: 'https://acc.r2.cloudflarestorage.com', pathStyle: true }, fake).test();
    await new S3Backend({ ...opts, endpoint: 'http://localhost:9000', pathStyle: false }, fake).test();
    assert.deepEqual(seen.map((u) => u.split('?')[0]), [
      'https://my-bucket.s3.eu-central-1.amazonaws.com/',
      'https://s3.eu-central-1.amazonaws.com/my-bucket/',
      'https://acc.r2.cloudflarestorage.com/my-bucket/',
      'http://my-bucket.localhost:9000/',
    ]);
    assert.match(seen[0]!, /list-type=2/);
    assert.match(seen[0]!, /encoding-type=url/);
    assert.match(seen[0]!, /prefix=pre%2F/);
  });

  test('a network / CORS failure is explained in plain words, with the CORS rule', async () => {
    const g = globalThis as { location?: unknown };
    const hadLocation = 'location' in g;
    g.location = { origin: 'https://sketch.example.com' };
    try {
      const blocked: typeof fetch = async () => { throw new TypeError('Failed to fetch'); };
      const backend = new S3Backend(opts, blocked);
      backend.retryMs = 0;
      await assert.rejects(backend.test(), (e: Error) => {
        assert.match(e.message, /CORS/);
        assert.match(e.message, /https:\/\/sketch\.example\.com/);
        assert.match(e.message, /GET, PUT, DELETE, HEAD/);
        assert.match(e.message, /ETag/);
        assert.match(e.message, /x-amz-meta-/);
        assert.ok(!e.message.includes('Failed to fetch'));
        return true;
      });
      const rule = JSON.parse(s3CorsRule()) as Record<string, string[]>[];
      assert.deepEqual(rule[0]!.AllowedOrigins, ['https://sketch.example.com']);
      assert.deepEqual(rule[0]!.AllowedMethods, ['GET', 'PUT', 'DELETE', 'HEAD']);
      assert.deepEqual(rule[0]!.AllowedHeaders, ['*']);
      assert.deepEqual(rule[0]!.ExposeHeaders, ['ETag', 'x-amz-meta-mtime']);

      // through the manager: test() and the status both carry the explanation, never the secret
      const statuses: RemoteStatus[][] = [];
      const kv = new MemoryKV();
      const mgr = createSyncManager({
        workspace: new MemoryWorkspace(), kv, fetch: blocked, pollMs: 60_000,
        onStatus: (r) => statuses.push(r), onLocalChanged: () => {},
      });
      await mgr.ready;
      const st = await mgr.putRemote('r1', {
        type: 's3', name: 'Bucket', endpoint: 'https://s3.example.com', bucket: 'bkt', prefix: '/a/b', accessKeyId: 'AKIA', secretAccessKey: 'TOPSECRET',
      });
      assert.equal(st.config.prefix, 'a/b/');
      assert.equal(st.config.pathStyle, true);
      const t = await mgr.test('r1');
      assert.equal(t.ok, false);
      assert.match(t.error ?? '', /CORS/);
      await mgr.syncNow('r1');
      const now = mgr.remotes()[0]!;
      assert.equal(now.state, 'error');
      assert.match(now.error ?? '', /does not allow this app through CORS/);
      assert.ok(!JSON.stringify(statuses).includes('TOPSECRET'), 'status never contains the secret');
      assert.ok(!('secretAccessKey' in now.config));
      assert.equal((await kv.get<{ secretAccessKey: string }[]>('sync.remotes'))![0]!.secretAccessKey, 'TOPSECRET');
      // omitted / empty secret keeps the old one
      await mgr.putRemote('r1', { name: 'Renamed', secretAccessKey: '' });
      const saved = (await kv.get<{ secretAccessKey: string; name: string; endpoint: string }[]>('sync.remotes'))![0]!;
      assert.deepEqual([saved.name, saved.secretAccessKey, saved.endpoint], ['Renamed', 'TOPSECRET', 'https://s3.example.com']);
      await assert.rejects(mgr.putRemote('bad id', { type: 's3', bucket: 'b' }), /invalid remote id/);
      await assert.rejects(mgr.putRemote('r2', { type: 'ftp' as 's3' }), /type must be/);
      assert.deepEqual(await mgr.test('nope'), { ok: false, error: 'unknown remote: nope' });
      const off = await mgr.putRemote('r1', { enabled: false });
      assert.equal(off.state, 'disabled');
      await mgr.deleteRemote('r1');
      assert.deepEqual(mgr.remotes(), []);
      assert.deepEqual(await kv.get('sync.remotes'), []);
      mgr.dispose();
    } finally {
      if (hadLocation) delete g.location; else delete g.location;
    }
  });
});

// ---------------------------------------------------------------- real S3 server

const ACCESS = 'vsktestaccess';
const SECRET = 'vsktestsecret0123456789';
const BUCKET = 'vsk-test';

function exec(cmd: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

interface S3Server { kind: string; endpoint: string; stop(): Promise<void> }

async function findBinary(): Promise<{ kind: 'versitygw' | 'minio'; bin: string } | null> {
  for (const kind of ['versitygw', 'minio'] as const) {
    if (await exec(kind, ['--version'], 10_000) !== null) return { kind, bin: kind };
  }
  if (process.env.VIBESKETCH_TEST_NO_NIX) return null;
  // minio was removed from nixpkgs (abandoned upstream); versitygw is a free single-binary S3 server
  const out = await exec('nix', ['build', '--no-link', '--print-out-paths', 'nixpkgs#versitygw'], 240_000);
  const store = out?.trim().split('\n').pop();
  if (store) return { kind: 'versitygw', bin: path.join(store, 'bin', 'versitygw') };
  return null;
}

async function startS3(): Promise<S3Server | string> {
  if (process.env.VIBESKETCH_TEST_S3 === 'off') return 'disabled by VIBESKETCH_TEST_S3=off';
  const found = await findBinary();
  if (!found) return 'no S3 server binary (versitygw / minio) on PATH or obtainable through nix';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibesketch-s3-'));
  const port = await freePort();
  let child: ChildProcess;
  if (found.kind === 'versitygw') {
    child = spawn(found.bin, ['--access', ACCESS, '--secret', SECRET, '--port', `127.0.0.1:${port}`, 'posix', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    child = spawn(found.bin, ['server', dir, '--address', `127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MINIO_ROOT_USER: ACCESS, MINIO_ROOT_PASSWORD: SECRET },
    });
  }
  let log = '';
  child.stdout?.on('data', (c) => { log += c; });
  child.stderr?.on('data', (c) => { log += c; });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const stop = async (): Promise<void> => {
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.on('exit', r)), sleep(3000)]);
      if (!exited) child.kill('SIGKILL');
    }
    await rm(dir, { recursive: true, force: true });
  };
  const endpoint = `http://127.0.0.1:${port}`;
  const client = new AwsClient({ accessKeyId: ACCESS, secretAccessKey: SECRET, service: 's3', region: 'us-east-1', retries: 0 });
  const end = Date.now() + 20_000;
  let last = '';
  while (Date.now() < end && !exited) {
    try {
      const res = await client.fetch(`${endpoint}/${BUCKET}`, { method: 'PUT' }); // signed CreateBucket
      last = `${res.status} ${await res.text()}`;
      if (res.ok || res.status === 409) return { kind: found.kind, endpoint, stop };
    } catch (e) {
      last = String(e);
    }
    await sleep(150);
  }
  await stop();
  return `could not start ${found.kind}: ${last} ${log.slice(-500)}`;
}

describe('sync engine (real S3 server)', () => {
  let s3: S3Server | null = null;
  let skipReason = '';
  const skip = (): string | false => (s3 ? false : skipReason);
  const cfg = (prefix: string, over: Partial<S3Options> = {}): S3Options => ({
    endpoint: s3!.endpoint, region: 'us-east-1', bucket: BUCKET, prefix, accessKeyId: ACCESS, secretAccessKey: SECRET, pathStyle: true, ...over,
  });

  before(async () => {
    const r = await startS3();
    if (typeof r === 'string') {
      skipReason = r;
      console.log(`# real S3 tests skipped: ${r}`);
    } else {
      s3 = r;
      console.log(`# real S3 tests run against ${r.kind} at ${r.endpoint}`);
    }
  }, { timeout: 300_000 });

  after(async () => {
    await s3?.stop();
  });

  defineSyncScenarios({
    backend: (scope) => new S3Backend(cfg(`scenarios/${scope}`)),
    skip,
    bigBytes: 20 * 1024 * 1024,
  });

  test('S3 backend: awkward keys, pagination, prefix isolation, mtime metadata', async (t) => {
    if (skip()) return t.skip(skip() as string);
    const a = new S3Backend(cfg('iso/a space & more/'), fetch, { pageSize: 2 });
    const b = new S3Backend(cfg('iso/b'));
    const names = [
      'Plain.vsk/doc.json',
      'With space & amp <tag> "q" \'s\'.vsk/doc.json',
      'Ünï cödé 日本語 émoji 🎨.vsk/doc.json',
      'plus+percent%25 (paren) !*~.vsk/assets/0123456789abcdef.png',
      'semi;colon,comma=eq@at$dollar.vsk/doc.json',
    ];
    const enc = (s: string) => new TextEncoder().encode(s);
    const mtime = Date.UTC(2020, 4, 17, 12, 0, 0) + 123;
    const versions = new Map<string, string>();
    for (const n of names) versions.set(n, await a.put(n, enc(`content of ${n}`), mtime));
    await b.put('Other.vsk/doc.json', enc('b'), mtime);

    const listed = await a.list(); // 5 objects with page size 2 -> 3 pages
    assert.deepEqual(listed.map((e) => e.path).sort(), [...names].sort());
    for (const e of listed) {
      assert.equal(e.version, versions.get(e.path));
      assert.equal(e.size, enc(`content of ${e.path}`).length);
    }
    assert.deepEqual((await b.list()).map((e) => e.path), ['Other.vsk/doc.json']);

    for (const n of names) {
      const got = await a.get(n);
      assert.equal(text(got.bytes), `content of ${n}`);
      assert.equal(got.mtime, mtime, 'mtime is stored as object metadata');
      assert.equal(got.version, versions.get(n));
    }
    await assert.rejects(a.get('Missing.vsk/doc.json'), /not found/);

    // optimistic concurrency (where the server implements conditional writes)
    const v1 = versions.get(names[0]!)!;
    const v2 = await a.put(names[0]!, enc('second'), mtime, { ifVersion: v1 });
    assert.notEqual(v2, v1);
    let conditional = true;
    try {
      await a.put(names[0]!, enc('stale writer'), mtime, { ifVersion: v1 });
      conditional = false;
    } catch (e) {
      assert.ok(e instanceof PreconditionFailed, String(e));
    }
    if (conditional) {
      assert.equal(text((await a.get(names[0]!)).bytes), 'second');
      await assert.rejects(a.put(names[0]!, enc('x'), mtime, { ifVersion: null }), PreconditionFailed);
    } else {
      t.diagnostic('this S3 server ignores conditional writes (If-Match)');
    }

    for (const n of names) await a.delete(n);
    await a.delete(names[0]!); // deleting a missing key is not an error
    assert.deepEqual(await a.list(), []);
    assert.equal((await b.list()).length, 1);

    await new S3Backend(cfg('x')).test();
    await assert.rejects(new S3Backend(cfg('x', { secretAccessKey: 'wrong-secret' })).test(), /S3 list failed \(403/);
    await assert.rejects(new S3Backend(cfg('x', { bucket: 'no-such-bucket-here' })).test(), /S3 list failed \(404/);
  });

  test('works when CORS hides ETag and x-amz-meta-* response headers', async (t) => {
    if (skip()) return t.skip(skip() as string);
    // what a browser shows of a cross-origin response without ExposeHeaders
    const safelisted = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);
    const hiding: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const headers = new Headers();
      res.headers.forEach((v, k) => { if (safelisted.has(k)) headers.set(k, v); });
      return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers });
    };
    const prefix = `hidden-${Date.now()}`;
    const a = makeWs(new S3Backend(cfg(prefix), hiding), 'a');
    const b = makeWs(new S3Backend(cfg(prefix), hiding), 'b');
    const direct = new S3Backend(cfg(prefix), hiding);
    const v = await direct.put('Probe.vsk/doc.json', docBytes('probe'), 1_600_000_000_000);
    assert.match(v, /^[a-f0-9]{32}$/, 'the ETag is recovered from a listing');
    const got = await direct.get('Probe.vsk/doc.json');
    assert.equal(got.version, '');
    assert.ok(Math.abs(got.mtime - Date.now()) < 120_000, 'falls back to Last-Modified when the metadata is hidden');

    await a.ws.write(docPath('H'), docBytes('h1'));
    assert.deepEqual((await a.sync()).errors, []);
    const rb = await b.sync();
    assert.deepEqual(rb.errors, []);
    assert.deepEqual(rb.downloaded.sort(), ['H.vsk/doc.json', 'Probe.vsk/doc.json']);
    await b.ws.write(docPath('H'), docBytes('h2'));
    assert.deepEqual((await b.sync()).uploaded, ['H.vsk/doc.json']);
    assert.deepEqual((await a.sync()).downloaded, ['H.vsk/doc.json']);
    assert.deepEqual(await a.ws.read(docPath('H')), docBytes('h2'));
    for (const w of [a, b]) {
      const r = await w.sync();
      assert.equal(r.uploaded.length + r.downloaded.length + r.errors.length, 0, 'settled');
      await w.close();
    }
  });

  test('SyncManager: continuous two-way sync between two "browsers"', async (t) => {
    if (skip()) return t.skip(skip() as string);
    const mk = (label: string) => {
      const ws = new MemoryWorkspace(label);
      const kv = new MemoryKV();
      const statuses: RemoteStatus[][] = [];
      const changed: string[] = [];
      const mgr = createSyncManager({
        workspace: ws, kv, pollMs: 60, debounceMs: 20,
        onStatus: (r) => statuses.push(r), onLocalChanged: (p) => changed.push(...p),
      });
      return { ws, kv, statuses, changed, mgr };
    };
    const A = mk('a');
    const B = mk('b');
    try {
      await Promise.all([A.mgr.ready, B.mgr.ready]);
      const remote = { type: 's3' as const, name: 'Team', ...cfg(`mgr-${Date.now()}`) };
      for (const x of [A, B]) {
        const st = await x.mgr.putRemote('team', remote);
        assert.equal(st.state, 'idle');
        assert.ok(!('secretAccessKey' in st.config));
        assert.deepEqual(await x.mgr.test('team'), { ok: true });
      }

      // A's editor saves and tells the manager; B finds it by polling
      await A.ws.write(docPath('Shared ✏️'), docBytes('v1'));
      A.mgr.notifyLocalChange();
      await until('doc in B', async () => (await B.ws.read(docPath('Shared ✏️'))) !== null);
      await until('onLocalChanged in B', () => B.changed.includes(docPath('Shared ✏️')));
      assert.ok(B.statuses.flat().some((s) => s.state === 'syncing' && s.pending > 0), 'reports progress');
      await until('B idle', () => B.mgr.remotes()[0]!.state === 'idle');
      assert.equal(typeof B.mgr.remotes()[0]!.lastSync, 'number');

      // B's workspace is changed behind the manager's back (another program wrote into the
      // folder): no notifyLocalChange, the poll alone has to pick it up
      await B.ws.write(docPath('Shared ✏️'), docBytes('v2 written by another program'));
      await until('edit in A', async () => text(await A.ws.read(docPath('Shared ✏️')))?.includes('another program') === true);
      await until('onLocalChanged in A', () => A.changed.length > 0);
      assert.deepEqual(A.changed, [docPath('Shared ✏️')]);
      assert.deepEqual(A.mgr.remotes()[0]!.error, null);

      // delete in A -> trashed in B
      await A.ws.removeDir('Shared ✏️.vsk');
      await until('deletion in B', async () => (await B.ws.read(docPath('Shared ✏️'))) === null);
      assert.ok([...B.ws.files.keys()].some((p) => /^\.vibesketch\/trash\/.+-sync\/Shared ✏️\.vsk\/doc\.json$/.test(p)));

      // syncNow resolves after a pass; disabling stops syncing; secrets stay in the KV only
      await A.mgr.syncNow();
      await A.mgr.syncNow('team');
      await assert.rejects(A.mgr.syncNow('nope'), /unknown remote/);
      const off = await B.mgr.putRemote('team', { enabled: false });
      assert.equal(off.state, 'disabled');
      await A.ws.write(docPath('Later'), docBytes('later'));
      await A.mgr.syncNow();
      await sleep(250);
      assert.equal(await B.ws.read(docPath('Later')), null);
      assert.ok(!JSON.stringify([A.statuses, B.statuses]).includes(SECRET));
      assert.equal((await A.kv.get<{ secretAccessKey: string }[]>('sync.remotes'))![0]!.secretAccessKey, SECRET);
      assert.ok(![...A.ws.files.values()].some((f) => text(f.data)!.includes(SECRET)), 'no secrets in the workspace');

      // a new manager on the same KV + workspace picks the remote up again
      B.mgr.dispose();
      const statuses: RemoteStatus[][] = [];
      const again = createSyncManager({ workspace: B.ws, kv: B.kv, pollMs: 60, onStatus: (r) => statuses.push(r), onLocalChanged: () => {} });
      await again.ready;
      await again.putRemote('team', { enabled: true });
      await again.syncNow();
      assert.notEqual(await B.ws.read(docPath('Later')), null);
      await again.deleteRemote('team');
      assert.equal(await B.ws.read('.vibesketch/sync-team.json'), null);
      again.dispose();
    } finally {
      A.mgr.dispose();
      B.mgr.dispose();
    }
  });
});
