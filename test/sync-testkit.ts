// Test support for src/sync (not a test file itself): an in-memory backend, a fake Google
// Drive, and the backend-independent two-workspace scenarios every backend has to pass.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { emptyDoc } from '../src/core/model.ts';
import { MemoryWorkspace } from '../src/storage/workspace.ts';
import { NotFoundError, PreconditionFailed } from '../src/sync/backend.ts';
import type { FetchFn, PutOptions, RemoteEntry, RemoteObject, SyncBackend } from '../src/sync/backend.ts';
import { SyncEngine } from '../src/sync/engine.ts';
import type { EngineStatus, PassResult } from '../src/sync/engine.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const md5 = (b: Uint8Array | string) => createHash('md5').update(b).digest('hex');
export const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

export async function until(what: string, pred: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

// ---------------------------------------------------------------- memory backend

export class MemoryBackend implements SyncBackend {
  files: Map<string, { bytes: Uint8Array; mtime: number; version: string }>;
  private n = 0;
  constructor(files = new Map<string, { bytes: Uint8Array; mtime: number; version: string }>()) {
    this.files = files;
  }
  async list(): Promise<RemoteEntry[]> {
    return [...this.files].map(([p, f]) => ({ path: p, version: f.version, mtime: f.mtime, size: f.bytes.byteLength }));
  }
  async get(p: string): Promise<RemoteObject> {
    const f = this.files.get(p);
    if (!f) throw new NotFoundError(p);
    return { bytes: f.bytes.slice(), version: f.version, mtime: f.mtime };
  }
  async put(p: string, bytes: Uint8Array, mtime: number, opts: PutOptions = {}): Promise<string> {
    const cur = this.files.get(p);
    if (opts.ifVersion === null && cur) throw new PreconditionFailed(p);
    if (typeof opts.ifVersion === 'string' && cur?.version !== opts.ifVersion) throw new PreconditionFailed(p);
    const version = `v${++this.n}-${md5(bytes).slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`;
    this.files.set(p, { bytes: bytes.slice(), mtime, version });
    return version;
  }
  async delete(p: string): Promise<void> {
    this.files.delete(p);
  }
  async test(): Promise<void> {}
}

// ---------------------------------------------------------------- fake Google Drive

interface FakeFile {
  id: string; name: string; mimeType: string; parents: string[]; trashed: boolean;
  content: Buffer | null; modifiedTime: string; createdTime: string;
}

const FOLDER = 'application/vnd.google-apps.folder';

/** A tiny in-process stand-in for the Drive v3 REST API (bearer tokens are minted by tests). */
export class FakeDrive {
  files = new Map<string, FakeFile>();
  validAccess = new Set<string>();
  pageSize = 3;
  /** responses to inject before the real handler runs */
  inject: { status: number; body: unknown; headers?: Record<string, string> }[] = [];
  /** hide the resumable session URL, as a browser would if the header were not CORS-exposed */
  hideLocation = false;
  log: string[] = [];
  private seq = 0;
  private sessions = new Map<string, { id: string | null; meta: Record<string, unknown> }>();

  mintToken(): string {
    const t = `access-${++this.seq}`;
    this.validAccess.add(t);
    return t;
  }

  fetch: FetchFn = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body == null ? Buffer.alloc(0)
      : typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body as Uint8Array);
    this.log.push(`${method} ${url.pathname}${url.search ? '?' + [...url.searchParams.keys()].sort().join('&') : ''}`);
    const json = (status: number, data: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...extra } });

    assert.equal(url.host, 'www.googleapis.com', 'the browser flow never talks to a token endpoint');
    const auth = headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !this.validAccess.has(auth.slice(7))) {
      return json(401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } });
    }
    const injected = this.inject.shift();
    if (injected) return json(injected.status, injected.body, injected.headers);

    const view = (f: FakeFile) => {
      const v: Record<string, unknown> = {
        id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, modifiedTime: f.modifiedTime, createdTime: f.createdTime,
      };
      if (f.content) {
        v.md5Checksum = md5(f.content);
        v.size = String(f.content.byteLength);
      }
      return v;
    };
    const create = (meta: Record<string, unknown>, content: Buffer | null): FakeFile => {
      const now = new Date().toISOString();
      const f: FakeFile = {
        id: `id${++this.seq}`, name: String(meta.name), mimeType: String(meta.mimeType ?? 'application/octet-stream'),
        parents: (meta.parents as string[] | undefined) ?? ['root'], trashed: false, content,
        modifiedTime: String(meta.modifiedTime ?? now), createdTime: now,
      };
      this.files.set(f.id, f);
      return f;
    };
    const update = (f: FakeFile, meta: Record<string, unknown>, content: Buffer | null): FakeFile => {
      if (typeof meta.name === 'string') f.name = meta.name;
      if (typeof meta.modifiedTime === 'string') f.modifiedTime = meta.modifiedTime;
      else if (content) f.modifiedTime = new Date().toISOString();
      if (typeof meta.trashed === 'boolean') f.trashed = meta.trashed;
      if (content) f.content = content;
      return f;
    };
    const notFound = () => json(404, { error: { code: 404, message: 'File not found.', errors: [{ reason: 'notFound' }] } });

    const upload = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(url.pathname);
    if (upload) {
      const id = upload[1] ? decodeURIComponent(upload[1]) : null;
      const type = url.searchParams.get('uploadType');
      if (id && (!this.files.has(id) || this.files.get(id)!.trashed) && !url.searchParams.get('upload_id')) return notFound();
      if (type === 'multipart') {
        const boundary = /boundary=(.+)$/.exec(headers.get('content-type') ?? '')?.[1];
        assert.ok(boundary, 'multipart boundary');
        const delim = Buffer.from(`--${boundary}`);
        const first = body.indexOf(delim);
        const second = body.indexOf(delim, first + delim.length);
        const last = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
        const part1 = body.subarray(first + delim.length, second).toString();
        const meta = JSON.parse(part1.slice(part1.indexOf('\r\n\r\n') + 4)) as Record<string, unknown>;
        const part2 = body.subarray(second + delim.length, last);
        const content = Buffer.from(part2.subarray(part2.indexOf('\r\n\r\n') + 4));
        const f = id ? update(this.files.get(id)!, meta, content) : create(meta, content);
        return json(200, view(f));
      }
      if (type === 'resumable') {
        const session = url.searchParams.get('upload_id');
        if (!session) {
          assert.ok(method === 'POST' || method === 'PATCH');
          assert.ok(headers.get('x-upload-content-length'));
          const sid = `sess${++this.seq}`;
          this.sessions.set(sid, { id, meta: JSON.parse(body.toString()) as Record<string, unknown> });
          const loc = new URL(url);
          loc.searchParams.set('upload_id', sid);
          return new Response(null, { status: 200, headers: this.hideLocation ? {} : { location: loc.toString() } });
        }
        assert.equal(method, 'PUT');
        const s = this.sessions.get(session);
        if (!s) return notFound();
        this.sessions.delete(session);
        const f = s.id ? update(this.files.get(s.id)!, s.meta, body) : create(s.meta, body);
        return json(200, view(f));
      }
      return json(400, { error: { message: 'bad uploadType' } });
    }

    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      assert.match(q, /trashed = false/, 'listings must exclude trashed files');
      let items = [...this.files.values()].filter((f) => !f.trashed);
      const byName = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
      if (byName) {
        const name = byName[1]!.replace(/\\(.)/g, '$1');
        items = items.filter((f) => f.name === name && f.mimeType === FOLDER && f.parents.includes('root'));
      }
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const page = items.slice(offset, offset + this.pageSize);
      const out: Record<string, unknown> = { files: page.map(view) };
      if (offset + this.pageSize < items.length) out.nextPageToken = String(offset + this.pageSize);
      return json(200, out);
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      return json(200, view(create(JSON.parse(body.toString()) as Record<string, unknown>, null)));
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const f = this.files.get(decodeURIComponent(one[1]!));
      if (!f) return notFound();
      if (method === 'GET' && url.searchParams.get('alt') === 'media') {
        return f.content && !f.trashed ? new Response(new Uint8Array(f.content), { status: 200 }) : notFound();
      }
      if (method === 'PATCH') return json(200, view(update(f, JSON.parse(body.toString()) as Record<string, unknown>, null)));
    }
    return json(400, { error: { message: `fake drive: unhandled ${method} ${url.pathname}` } });
  };

  /** live file paths below a root folder name */
  paths(rootName: string): string[] {
    const out: string[] = [];
    const pathOf = (f: FakeFile): string | null => {
      const parent = this.files.get(f.parents[0] ?? '');
      if (!parent) return f.parents[0] === 'root' && f.name === rootName ? '' : null;
      const pp = pathOf(parent);
      return pp === null ? null : pp ? `${pp}/${f.name}` : f.name;
    };
    for (const f of this.files.values()) {
      if (f.trashed || !f.content) continue;
      const p = pathOf(f);
      if (p !== null) out.push(p);
    }
    return out.sort();
  }
}

// ---------------------------------------------------------------- workspaces

export interface TestWs {
  ws: MemoryWorkspace;
  engine: SyncEngine;
  /** every onLocalChanged call */
  changed: string[][];
  statuses: EngineStatus[];
  sync(): Promise<PassResult>;
  close(): Promise<void>;
}

export const MANIFEST = '.vibesketch/sync-test.json';

export function makeWs(backend: SyncBackend, label = 'ws'): TestWs {
  const ws = new MemoryWorkspace(label);
  const changed: string[][] = [];
  const statuses: EngineStatus[] = [];
  const engine = new SyncEngine({
    workspace: ws, backend, manifestPath: MANIFEST, target: 'test',
    onStatus: (s) => statuses.push(s), onLocalChanged: (p) => changed.push(p), auto: false,
  });
  return { ws, engine, changed, statuses, sync: () => engine.syncNow(), close: () => engine.stop() };
}

export function docBytes(label: string): Uint8Array {
  const d = emptyDoc();
  d.pages[0]!.id = 'page-1';
  d.pages[0]!.name = label;
  return new TextEncoder().encode(JSON.stringify(d, null, 2));
}

export const docPath = (project: string) => `${project}.vsk/doc.json`;

async function docLabel(w: TestWs, project: string): Promise<string> {
  return (JSON.parse(text(await w.ws.read(docPath(project)))!) as { pages: { name: string }[] }).pages[0]!.name;
}

/** Write a doc with a chosen modification time (MemoryWorkspace stamps writes with `now()`). */
async function writeDoc(w: TestWs, project: string, label: string, mtime?: number): Promise<void> {
  const prev = w.ws.now;
  if (mtime !== undefined) w.ws.now = () => mtime;
  try { await w.ws.write(docPath(project), docBytes(label)); } finally { w.ws.now = prev; }
}

const quiet = (r: PassResult): boolean =>
  r.uploaded.length + r.downloaded.length + r.deletedRemote.length + r.trashedLocal.length + r.conflicts.length + r.errors.length === 0;

const userFiles = (w: TestWs): string[] => [...w.ws.files.keys()].filter((p) => !p.startsWith('.vibesketch/')).sort();

// ---------------------------------------------------------------- scenarios

export interface ScenarioOptions {
  /** a new backend instance pointing at the (shared) remote location `scope` */
  backend: (scope: string) => SyncBackend | Promise<SyncBackend>;
  /** return a reason to skip (e.g. no S3 server available) */
  skip?: () => string | false;
  /** size of the "large asset" test, 0 to leave it out */
  bigBytes?: number;
}

/** Registers the two-workspace sync scenarios with node:test (call inside a `describe`). */
export function defineSyncScenarios(o: ScenarioOptions): void {
  let n = 0;
  const run = (name: string, fn: (a: TestWs, b: TestWs, scope: string) => Promise<void>): void => {
    test(name, async (t) => {
      const reason = o.skip?.();
      if (reason) return t.skip(reason);
      const scope = `scope-${Date.now().toString(36)}-${++n}`;
      const a = makeWs(await o.backend(scope), 'a');
      const b = makeWs(await o.backend(scope), 'b');
      try {
        await fn(a, b, scope);
      } finally {
        await a.close();
        await b.close();
      }
    });
  };

  const P = 'Entwurf ü 日本 & co #1 (final)+';
  const KEY = 'a3f1c2d4e5f60718293a4b5c6d7e8f90.png';
  const asset = (project: string, key = KEY) => `${project}.vsk/assets/${key}`;

  run('create in A appears in B, edit in B updates A (unicode + space names)', async (a, b) => {
    await writeDoc(a, P, 'v1');
    await a.ws.write(asset(P), 'fake png bytes');
    const ra = await a.sync();
    assert.deepEqual(ra.errors, []);
    assert.deepEqual(ra.uploaded.sort(), [asset(P), docPath(P)]);
    assert.deepEqual(a.changed, [], 'uploading does not touch local files');

    const rb = await b.sync();
    assert.deepEqual(rb.errors, []);
    assert.deepEqual(rb.downloaded.sort(), [asset(P), docPath(P)]);
    assert.deepEqual(await b.ws.read(docPath(P)), await a.ws.read(docPath(P)));
    assert.equal(text(await b.ws.read(asset(P))), 'fake png bytes');
    assert.deepEqual(b.changed.flat().sort(), [asset(P), docPath(P)], 'onLocalChanged reports what was written');
    assert.deepEqual((await b.ws.dirs()).filter((d) => !d.startsWith('.')), [`${P}.vsk`]);
    assert.deepEqual(b.statuses.map((s) => s.state).filter((s, i, all) => s !== all[i - 1]), ['syncing', 'idle']);

    // nothing left to do on either side
    assert.ok(quiet(await a.sync()));
    assert.ok(quiet(await b.sync()));

    await writeDoc(b, P, 'v2 from B');
    assert.deepEqual((await b.sync()).uploaded, [docPath(P)]);
    const ra2 = await a.sync();
    assert.deepEqual(ra2.downloaded, [docPath(P)]);
    assert.equal(await docLabel(a, P), 'v2 from B');
    assert.deepEqual(a.changed, [[docPath(P)]]);
    assert.ok(quiet(await b.sync()));
    assert.ok(quiet(await a.sync()), 'a download (local mtime = now) is not mistaken for a local edit');
    for (const w of [a, b]) assert.deepEqual(userFiles(w), [asset(P), docPath(P)]);
  });

  run('concurrent edits keep both versions (newer wins, loser becomes a conflict copy)', async (a, b, scope) => {
    await writeDoc(a, 'C', 'base');
    await a.sync();
    await b.sync();
    const now = Date.now();

    // local (B) is newer than remote (A's upload): B wins, A's version is kept in B
    await writeDoc(a, 'C', 'edit from A', now - 60_000);
    await writeDoc(b, 'C', 'edit from B', now);
    assert.deepEqual((await a.sync()).uploaded, ['C.vsk/doc.json']);
    b.changed.length = 0;
    const rb = await b.sync();
    assert.deepEqual(rb.errors, []);
    assert.equal(rb.conflicts.length, 1);
    assert.match(rb.conflicts[0]!, /^C\.vsk\/doc\.conflict-\d{4}-\d\d-\d\dT[\d-]+Z\.json$/);
    assert.equal(await docLabel(b, 'C'), 'edit from B');
    assert.match(text(await b.ws.read(rb.conflicts[0]!))!, /edit from A/);
    assert.deepEqual(rb.uploaded, ['C.vsk/doc.json']);
    assert.deepEqual(b.changed.flat(), [rb.conflicts[0]!]);
    assert.deepEqual((await a.sync()).downloaded, ['C.vsk/doc.json']);
    assert.equal(await docLabel(a, 'C'), 'edit from B');

    // remote (A's upload) is newer than local (B): A wins in B, B's version is kept in B
    await writeDoc(a, 'C', 'second from A', now + 120_000);
    await writeDoc(b, 'C', 'second from B', now + 60_000);
    await a.sync();
    b.changed.length = 0;
    const rb2 = await b.sync();
    assert.deepEqual(rb2.errors, []);
    assert.equal(rb2.conflicts.length, 1);
    assert.equal(await docLabel(b, 'C'), 'second from A');
    assert.match(text(await b.ws.read(rb2.conflicts[0]!))!, /second from B/);
    assert.deepEqual(b.changed.flat().sort(), [rb2.conflicts[0]!, 'C.vsk/doc.json'].sort());
    assert.equal(userFiles(b).filter((f) => f.includes('.conflict-')).length, 2);

    // conflict copies are never synced, and everything is settled now
    assert.ok(quiet(await a.sync()));
    assert.ok(quiet(await b.sync()));
    const remote = (await (await o.backend(scope)).list()).map((e) => e.path);
    assert.deepEqual(remote.sort(), ['C.vsk/doc.json']);
    assert.deepEqual(userFiles(a), ['C.vsk/doc.json']);
  });

  run('delete in A trashes in B; delete-vs-edit keeps the edit', async (a, b, scope) => {
    await writeDoc(a, 'Gone', 'x');
    await a.ws.write(asset('Gone'), 'asset');
    await writeDoc(a, 'Kept', 'kept');
    await a.sync();
    await b.sync();
    assert.deepEqual(await b.ws.dirs(), ['.vibesketch', 'Gone.vsk', 'Kept.vsk']);

    await a.ws.removeDir('Gone.vsk');
    const ra = await a.sync();
    assert.deepEqual(ra.deletedRemote.sort(), [asset('Gone'), 'Gone.vsk/doc.json']);
    assert.deepEqual((await (await o.backend(scope)).list()).map((e) => e.path), ['Kept.vsk/doc.json']);

    b.changed.length = 0;
    const rb = await b.sync();
    assert.deepEqual(rb.errors, []);
    assert.deepEqual(rb.trashedLocal.sort(), [asset('Gone'), 'Gone.vsk/doc.json']);
    assert.deepEqual(b.changed.flat().sort(), [asset('Gone'), 'Gone.vsk/doc.json']);
    assert.deepEqual(userFiles(b), ['Kept.vsk/doc.json']);
    const trashed = [...b.ws.files.keys()].filter((p) => p.startsWith('.vibesketch/trash/'));
    assert.equal(trashed.filter((f) => /-sync\/Gone\.vsk\/(doc\.json|assets\/.+\.png)$/.test(f)).length, 2, String(trashed));
    assert.equal(text(await b.ws.read(trashed.find((f) => f.endsWith('.png'))!)), 'asset');
    assert.ok(quiet(await a.sync()));
    assert.ok(quiet(await b.sync()));

    // A deletes while B edits: the edit survives and comes back to A
    await a.ws.removeDir('Kept.vsk');
    await writeDoc(b, 'Kept', 'edited in B');
    await a.sync();
    const rb2 = await b.sync();
    assert.deepEqual(rb2.uploaded, ['Kept.vsk/doc.json']);
    assert.deepEqual(rb2.trashedLocal, []);
    assert.deepEqual((await a.sync()).downloaded, ['Kept.vsk/doc.json']);
    assert.equal(await docLabel(a, 'Kept'), 'edited in B');
  });

  run('first sync of a non-empty workspace with a non-empty remote merges', async (a, b, scope) => {
    await writeDoc(a, 'FromA', 'a');
    await writeDoc(a, 'Both', 'same');
    await a.sync();
    // B starts out with its own project and an identical copy of "Both"
    await writeDoc(b, 'FromB', 'b');
    await writeDoc(b, 'Both', 'same');
    const rb = await b.sync();
    assert.deepEqual(rb.errors, []);
    assert.deepEqual(rb.trashedLocal, []);
    assert.deepEqual(rb.deletedRemote, []);
    assert.deepEqual(rb.conflicts, []);
    assert.deepEqual(rb.uploaded, ['FromB.vsk/doc.json']);
    assert.deepEqual(rb.downloaded, ['FromA.vsk/doc.json']);
    assert.deepEqual(userFiles(b), ['Both.vsk/doc.json', 'FromA.vsk/doc.json', 'FromB.vsk/doc.json']);
    assert.deepEqual((await a.sync()).downloaded, ['FromB.vsk/doc.json']);

    // a lost manifest must behave like a first sync: no transfers, and certainly no deletions
    await a.ws.remove(MANIFEST);
    assert.ok(quiet(await a.sync()));
    assert.equal((await (await o.backend(scope)).list()).length, 3);
    assert.equal(userFiles(a).length, 3);

    // the whole workspace is wiped (folder swapped / storage cleared): merge again, delete nothing
    a.ws.files.clear();
    const ra = await a.sync();
    assert.deepEqual(ra.deletedRemote, []);
    assert.equal(ra.downloaded.length, 3);
    assert.equal((await (await o.backend(scope)).list()).length, 3);
  });

  run('a failing file neither aborts the pass nor corrupts the manifest', async (a, b) => {
    await writeDoc(a, 'F', 'f');
    await a.ws.write(asset('F'), 'will fail once');
    const backend = (a.engine as unknown as { backend: SyncBackend }).backend;
    const realPut = backend.put.bind(backend);
    let failures = 0;
    backend.put = async (p, bytes, mtime, opts) => {
      if (p.includes('/assets/') && failures++ === 0) throw new Error('simulated network failure');
      return realPut(p, bytes, mtime, opts);
    };
    const r1 = await a.sync();
    assert.deepEqual(r1.uploaded, ['F.vsk/doc.json']);
    assert.equal(r1.errors.length, 1);
    assert.match(r1.errors[0]!.error, /simulated network failure/);
    assert.equal(a.engine.getStatus().state, 'error');
    assert.match(a.engine.getStatus().error ?? '', /simulated network failure/);
    const manifest = JSON.parse(text(await a.ws.read(MANIFEST))!) as { files: Record<string, unknown> };
    assert.deepEqual(Object.keys(manifest.files), ['F.vsk/doc.json']);
    // B already gets the part that worked
    assert.deepEqual((await b.sync()).downloaded, ['F.vsk/doc.json']);

    const r2 = await a.sync();
    assert.deepEqual(r2.errors, []);
    assert.deepEqual(r2.uploaded, [asset('F')]);
    assert.equal(a.engine.getStatus().state, 'idle');
    assert.equal(a.engine.getStatus().error, null);
    assert.deepEqual((await b.sync()).downloaded, [asset('F')]);
  });

  run('passes of one remote never overlap', async (a) => {
    const backend = (a.engine as unknown as { backend: SyncBackend }).backend;
    const realList = backend.list.bind(backend);
    let inFlight = 0;
    let max = 0;
    let calls = 0;
    backend.list = async () => {
      calls++;
      max = Math.max(max, ++inFlight);
      await sleep(30);
      try { return await realList(); } finally { inFlight--; }
    };
    await writeDoc(a, 'S', 's');
    const results = await Promise.all([a.sync(), a.sync(), a.sync()]);
    assert.equal(max, 1);
    assert.equal(calls, 3);
    assert.equal(results.flatMap((r) => r.uploaded).length, 1);
  });

  if (o.bigBytes) {
    const size = o.bigBytes;
    run(`a ${Math.round(size / 1024 / 1024)} MB asset round-trips intact`, async (a, b) => {
      const big = new Uint8Array(size);
      const view = new DataView(big.buffer);
      for (let i = 0; i + 4 <= size; i += 4096) view.setUint32(i, (i * 2654435761) >>> 0, true);
      const key = `${sha256(big).slice(0, 32)}.bin`;
      await writeDoc(a, 'Big', 'big');
      await a.ws.write(asset('Big', key), big);
      const ra = await a.sync();
      assert.deepEqual(ra.errors, []);
      assert.equal(ra.uploaded.length, 2);
      const rb = await b.sync();
      assert.deepEqual(rb.errors, []);
      const got = await b.ws.read(asset('Big', key));
      assert.equal(got!.byteLength, size);
      assert.equal(sha256(got!), sha256(big));
      assert.ok(quiet(await a.sync()));
      assert.ok(quiet(await b.sync()));
    });
  }
}
