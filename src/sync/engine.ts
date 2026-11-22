// Two-way sync of one workspace with one remote.
//
// A manifest (.vibesketch/sync-<remoteId>.json inside the workspace) remembers, per file, the
// local content hash and the remote version at the last successful sync. Each pass lists the
// workspace and the remote, compares both with the manifest and uploads, downloads, deletes,
// trashes or keeps conflict copies. An empty manifest (first sync) therefore merges: deletions
// are only ever inferred from manifest entries.
//
// There is no file watcher in a browser: local changes are found by listing the workspace on
// every pass (files are only re-read when their size / mtime differ from the manifest).

import type { FileInfo, Workspace } from '../storage/workspace.ts';
import { NotFoundError, PreconditionFailed, UnauthorizedError } from './backend.ts';
import type { RemoteEntry, SyncBackend } from './backend.ts';
import {
  bytesEqual, conflictName, errMessage, fileTimestamp, fromUtf8, isSyncablePath, md5Hex, pool, PRIVATE_DIR, sha256Hex, timer,
} from './util.ts';

interface ManifestEntry {
  /** sha256 of the local content at the last sync */
  hash: string;
  size: number;
  /** local mtime at the last sync (lets us skip re-hashing unchanged files) */
  mtime: number;
  remoteVersion: string;
  /** the remote's modification time at the last sync (local mtimes cannot be set in a browser) */
  remoteMtime: number;
  /** when this entry was recorded (see `statTrusted`) */
  syncedAt: number;
}

/**
 * May an unchanged size + mtime be taken as "content unchanged"? Not if the file was modified
 * around the time we recorded it: another write within the timestamp's resolution would look
 * identical. Such entries are re-hashed once on a later pass (like git's "racily clean" files).
 */
const RACY_MS = 2000;
const statTrusted = (m: ManifestEntry, l: Stat): boolean =>
  l.size === m.size && l.mtime === m.mtime && m.mtime + RACY_MS < (m.syncedAt ?? 0);

interface Manifest {
  version: 1;
  /** identifies the remote location; a different target invalidates the manifest */
  target: string;
  files: Record<string, ManifestEntry>;
}

export type SyncState = 'idle' | 'syncing' | 'error' | 'disabled' | 'unauthorized';

export interface EngineStatus { state: SyncState; lastSync: number | null; error: string | null; pending: number }

export interface EngineOptions {
  workspace: Workspace;
  backend: SyncBackend;
  /** workspace path of the manifest, e.g. `.vibesketch/sync-<id>.json` */
  manifestPath: string;
  target: string;
  onStatus: (s: EngineStatus) => void;
  /** workspace paths this engine wrote or removed (downloads, conflict copies, trashed files) */
  onLocalChanged?: (paths: string[]) => void;
  debounceMs?: number;
  pollMs?: number;
  concurrency?: number;
  /** false: never schedule passes on its own (tests drive `syncNow()` themselves) */
  auto?: boolean;
}

export interface PassResult {
  uploaded: string[]; downloaded: string[]; deletedRemote: string[]; trashedLocal: string[];
  conflicts: string[]; errors: { path: string; error: string }[];
}

const emptyResult = (): PassResult => ({ uploaded: [], downloaded: [], deletedRemote: [], trashedLocal: [], conflicts: [], errors: [] });

/** files above this size are transferred one at a time, to bound memory use */
const BIG_FILE = 8 * 1024 * 1024;

type Stat = Pick<FileInfo, 'size' | 'mtime'>;

/** Internal: this file was touched while we were looking at it; retry in the next pass. */
class Skip extends Error {}

export class SyncEngine {
  private ws: Workspace;
  private backend: SyncBackend;
  private manifestPath: string;
  private target: string;
  private onStatus: (s: EngineStatus) => void;
  private onLocalChanged: (paths: string[]) => void;
  private debounceMs: number;
  private pollMs: number;
  private concurrency: number;
  private auto: boolean;

  private status: EngineStatus = { state: 'idle', lastSync: null, error: null, pending: 0 };
  private running: Promise<PassResult> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = Infinity;
  private dirty = false;
  private failures = 0;
  private stopped = false;
  private paused = false;
  private lastManifestSave = 0;
  private bigLock: Promise<unknown> = Promise.resolve();

  constructor(o: EngineOptions) {
    this.ws = o.workspace;
    this.backend = o.backend;
    this.manifestPath = o.manifestPath;
    this.target = o.target;
    this.onStatus = o.onStatus;
    this.onLocalChanged = o.onLocalChanged ?? (() => {});
    this.debounceMs = o.debounceMs ?? 1000;
    this.pollMs = o.pollMs ?? 15_000;
    this.concurrency = o.concurrency ?? 3;
    this.auto = o.auto ?? true;
  }

  getStatus(): EngineStatus {
    return { ...this.status };
  }

  start(): void {
    this.schedule(0);
  }

  /** Stop scheduling and wait for a running pass to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
  }

  /** Paused (tab hidden): no automatic passes. Resuming syncs right away. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.timerAt = Infinity;
    } else {
      this.schedule(0);
    }
  }

  /** Something changed locally: sync soon (debounced). */
  notifyLocalChange(): void {
    this.dirty = true;
    this.schedule(this.debounceMs);
  }

  /** Run a pass now (after the current one, if any) and resolve with its result. */
  async syncNow(): Promise<PassResult> {
    while (this.running) await this.running.catch(() => {});
    if (this.stopped) return emptyResult();
    return this.startPass();
  }

  private schedule(ms: number): void {
    if (this.stopped || this.paused || !this.auto) return;
    if (this.status.state === 'unauthorized') return; // waits for the user to sign in again
    const at = Date.now() + ms;
    if (this.timer && this.timerAt <= at) return; // an earlier run is already planned
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = timer(() => {
      this.timer = null;
      this.timerAt = Infinity;
      if (this.running) { this.dirty = true; return; } // the running pass reschedules when done
      void this.startPass().catch(() => {});
    }, ms);
  }

  private setStatus(patch: Partial<EngineStatus>): void {
    const next = { ...this.status, ...patch };
    const changed = next.state !== this.status.state || next.error !== this.status.error || next.pending !== this.status.pending;
    this.status = next;
    if (changed) this.onStatus(this.getStatus());
  }

  /** Passes are strictly serialized: `running` is set synchronously. */
  private startPass(): Promise<PassResult> {
    this.dirty = false;
    const p = this.pass().then(
      (result) => {
        this.running = null;
        if (result.errors.length) {
          this.failures++;
          const first = result.errors[0]!;
          const more = result.errors.length > 1 ? ` (+${result.errors.length - 1} more)` : '';
          this.setStatus({ state: 'error', error: `${first.path}: ${first.error}${more}`, pending: result.errors.length, lastSync: Date.now() });
          this.schedule(this.backoff());
        } else {
          this.failures = 0;
          this.setStatus({ state: 'idle', error: null, pending: 0, lastSync: Date.now() });
          this.schedule(this.dirty ? this.debounceMs : this.pollMs);
        }
        return result;
      },
      (e: unknown) => {
        this.running = null;
        this.failures++;
        if (e instanceof UnauthorizedError) {
          // only the user can fix this (sign in again); the manager restarts us afterwards
          if (this.timer) clearTimeout(this.timer);
          this.timer = null;
          this.timerAt = Infinity;
          this.setStatus({ state: 'unauthorized', error: errMessage(e), pending: 0 });
        } else {
          this.setStatus({ state: 'error', error: errMessage(e), pending: 0 });
          this.schedule(this.backoff());
        }
        throw e;
      },
    );
    this.running = p;
    return p;
  }

  private backoff(): number {
    return Math.min(5 * 60_000, Math.max(this.pollMs, 2000 * 2 ** Math.min(this.failures, 10)));
  }

  // -------------------------------------------------------------- manifest

  private async loadManifest(): Promise<Manifest> {
    const raw = await this.ws.read(this.manifestPath);
    if (raw) {
      try {
        const m = JSON.parse(fromUtf8(raw)) as Manifest;
        if (m && m.version === 1 && m.target === this.target && m.files && typeof m.files === 'object') return m;
      } catch { /* corrupt: same as missing */ }
    }
    // a missing or corrupt manifest just means "first sync": merge, delete nothing
    return { version: 1, target: this.target, files: {} };
  }

  private async saveManifest(m: Manifest): Promise<void> {
    this.lastManifestSave = Date.now();
    await this.ws.write(this.manifestPath, JSON.stringify(m));
  }

  // -------------------------------------------------------------- one pass

  private async pass(): Promise<PassResult> {
    const result = emptyResult();
    let manifest = await this.loadManifest();
    const local = new Map<string, Stat>();
    for (const f of await this.ws.list()) {
      if (!f.path.startsWith(PRIVATE_DIR + '/') && isSyncablePath(f.path)) local.set(f.path, { size: f.size, mtime: f.mtime });
    }
    // The manifest lives in the workspace. If the workspace looks empty although the manifest
    // has entries, make sure it was not the whole folder that vanished or got swapped: in that
    // case the manifest is gone too and we must merge instead of deleting the remote.
    if (local.size === 0 && Object.keys(manifest.files).length > 0 && !(await this.ws.stat(this.manifestPath))) {
      manifest = { version: 1, target: this.target, files: {} };
    }
    const remote = new Map<string, RemoteEntry>();
    for (const e of await this.backend.list()) {
      // remote listings are untrusted input: only accept paths we would have produced ourselves
      if (isSyncablePath(e.path)) remote.set(e.path, e);
    }

    const work: string[] = [];
    for (const p of new Set([...local.keys(), ...remote.keys(), ...Object.keys(manifest.files)])) {
      const l = local.get(p);
      const r = remote.get(p);
      const m = manifest.files[p];
      const settled = l && r && m && statTrusted(m, l) && r.version === m.remoteVersion;
      if (!settled) work.push(p);
    }
    if (work.length === 0) return result;

    // docs first, so collaborators see changes before big assets finish
    work.sort((a, b) => Number(b.endsWith('/doc.json')) - Number(a.endsWith('/doc.json')) || a.localeCompare(b));
    let pending = work.length;
    let manifestDirty = false;
    let saving: Promise<void> = Promise.resolve();
    let unauthorized: UnauthorizedError | null = null;
    const ctx: PassContext = { manifest, result, stamp: fileTimestamp(), touched: [], emptied: new Set() };
    const flushTouched = (): void => {
      if (ctx.touched.length) this.onLocalChanged(ctx.touched.splice(0));
    };
    this.setStatus({ state: 'syncing', pending });

    await pool(work, this.concurrency, async (p) => {
      if (unauthorized) return; // pointless to continue without credentials
      const l = local.get(p);
      const r = remote.get(p);
      const run = async (): Promise<void> => {
        try {
          if (await this.syncFile(p, l, r, ctx)) {
            manifestDirty = true;
            // persist progress regularly so an interrupted pass does not redo finished transfers
            if (Date.now() - this.lastManifestSave > 2000) {
              manifestDirty = false;
              saving = saving.then(() => this.saveManifest(manifest)).catch(() => { manifestDirty = true; });
              flushTouched();
            }
          }
        } catch (e) {
          if (e instanceof UnauthorizedError) unauthorized = e;
          else if (e instanceof PreconditionFailed || e instanceof Skip) this.dirty = true; // lost a race: next pass sorts it out
          else result.errors.push({ path: p, error: errMessage(e) });
        }
      };
      if (Math.max(l?.size ?? 0, r?.size ?? 0) > BIG_FILE) {
        const mine = this.bigLock.then(run);
        this.bigLock = mine;
        await mine;
      } else {
        await run();
      }
      pending--;
      this.setStatus({ state: 'syncing', pending });
    });

    await saving;
    // project folders whose last file was trashed disappear from the project list
    for (const top of ctx.emptied) {
      try {
        if ((await this.ws.list(top)).length === 0) await this.ws.removeDir(top);
      } catch { /* cosmetic */ }
    }
    if (manifestDirty) await this.saveManifest(manifest);
    flushTouched();
    if (unauthorized) throw unauthorized;
    return result;
  }

  /**
   * Bring one path in sync. Mutates `manifest.files[p]` only after the transfer succeeded.
   * Returns true if the manifest changed.
   */
  private async syncFile(p: string, l: Stat | undefined, r: RemoteEntry | undefined, ctx: PassContext): Promise<boolean> {
    const { manifest, result } = ctx;
    const m = manifest.files[p];
    const record = (hash: string, st: Stat, remoteVersion: string, remoteMtime: number): true => {
      manifest.files[p] = { hash, size: st.size, mtime: st.mtime, remoteVersion, remoteMtime, syncedAt: Date.now() };
      return true;
    };
    const forget = (): boolean => {
      if (!manifest.files[p]) return false;
      delete manifest.files[p];
      return true;
    };

    // ---- read the local side (only when its stat says it may have changed)
    let bytes: Uint8Array | null = null;
    let hash: string | null = null;
    const readLocal = async (): Promise<Uint8Array> => {
      if (!bytes) {
        bytes = await this.ws.read(p);
        if (!bytes) throw new Skip(); // deleted since the listing
      }
      return bytes;
    };
    if (l) {
      if (m && statTrusted(m, l)) hash = m.hash;
      else hash = await sha256Hex(await readLocal());
    }
    const localChanged = !!l && (!m || hash !== m.hash);
    const remoteChanged = !!r && (!m || r.version !== m.remoteVersion);

    const upload = async (ifVersion: string | null): Promise<true> => {
      const data = await readLocal();
      const version = await this.backend.put(p, data, Math.round(l!.mtime), { ifVersion });
      result.uploaded.push(p);
      return record(await sha256Hex(data), { size: data.byteLength, mtime: l!.mtime }, version, Math.round(l!.mtime));
    };
    /** Make sure the local file is still what we listed before replacing / removing it. */
    const assertLocalUntouched = async (): Promise<void> => {
      const now = await this.ws.stat(p);
      if (l ? !now || now.size !== l.size || now.mtime !== l.mtime : now !== null) throw new Skip();
    };
    const fetchRemote = async () => {
      try {
        return await this.backend.get(p);
      } catch (e) {
        if (e instanceof NotFoundError) throw new Skip(); // deleted since the listing
        throw e;
      }
    };
    /** Write remote content into the workspace and record it. */
    const place = async (obj: { bytes: Uint8Array; version: string; mtime: number }): Promise<true> => {
      await this.ws.write(p, obj.bytes);
      ctx.touched.push(p);
      result.downloaded.push(p);
      // the browser stamps the file with "now": remember what we actually see on disk
      const st = (await this.ws.stat(p)) ?? { size: obj.bytes.byteLength, mtime: 0 };
      return record(await sha256Hex(obj.bytes), st, obj.version || r!.version, obj.mtime || r!.mtime);
    };
    const download = async (): Promise<true> => {
      const obj = await fetchRemote();
      await assertLocalUntouched();
      return place(obj);
    };
    const keepConflictCopy = async (data: Uint8Array): Promise<void> => {
      // never overwrite an earlier conflict copy (two conflicts within one millisecond)
      const ts = fileTimestamp();
      let name = conflictName(p, ts);
      for (let i = 2; await this.ws.stat(name); i++) name = conflictName(p, `${ts}-${i}`);
      await this.ws.write(name, data);
      ctx.touched.push(name);
      result.conflicts.push(name);
    };

    if (l && r) {
      if (!localChanged && !remoteChanged) return record(hash!, l, r.version, m?.remoteMtime ?? r.mtime); // verified: only the stat moved
      if (localChanged && !remoteChanged) return upload(r.version);
      if (!localChanged && remoteChanged) return download();

      // both changed (or first sync with the file on both sides)
      const mine = await readLocal();
      if (r.md5 && r.size === mine.byteLength && md5Hex(mine) === r.md5) return record(hash!, l, r.version, r.mtime);
      const obj = await fetchRemote();
      if (bytesEqual(obj.bytes, mine)) return record(hash!, l, obj.version || r.version, obj.mtime || r.mtime);

      // a real conflict: newer modification time wins, the loser is kept as a conflict copy
      const remoteMtime = obj.mtime || r.mtime;
      if (remoteMtime >= l.mtime) {
        await assertLocalUntouched();
        await keepConflictCopy(mine);
        return place(obj);
      }
      await keepConflictCopy(obj.bytes);
      return upload(obj.version || r.version);
    }

    if (l && !r) {
      if (!m || localChanged) return upload(null); // new file, or edited here while deleted there
      // deleted remotely: move it to the trash (the workspace API has no rename)
      await assertLocalUntouched();
      const data = await readLocal();
      await this.ws.write(`${PRIVATE_DIR}/trash/${ctx.stamp}-sync/${p}`, data);
      await this.ws.remove(p);
      ctx.touched.push(p);
      ctx.emptied.add(p.slice(0, p.indexOf('/')));
      result.trashedLocal.push(p);
      return forget();
    }

    if (!l && r) {
      if (!m || remoteChanged) return download(); // new file, or edited there while deleted here
      await this.backend.delete(p); // deleted locally
      result.deletedRemote.push(p);
      return forget();
    }

    return forget(); // gone on both sides
  }
}

interface PassContext {
  manifest: Manifest;
  result: PassResult;
  stamp: string;
  touched: string[];
  emptied: Set<string>;
}
