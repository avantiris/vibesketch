// Where projects live. There is no server: the app talks to a directory through the browser's
// file system API. On Chromium that can be a real folder the user picked; everywhere else it is
// the browser's private storage for this site (OPFS). Both are FileSystemDirectoryHandles, so
// one implementation covers them.
//
// Layout inside a workspace (same as the old server used on disk):
//   <project>.vsk/doc.json
//   <project>.vsk/assets/<key>
//   .vibesketch/...            private state (sync manifests, trash); never synced

export interface FileInfo {
  /** '/'-separated, relative to the workspace root, no leading slash */
  path: string;
  size: number;
  /** last modified, ms since epoch */
  mtime: number;
}

export interface Workspace {
  readonly kind: 'folder' | 'browser' | 'memory';
  /** shown in the UI: the folder's name, or "Browser storage" */
  readonly name: string;
  /** every file below `dir` ('' = whole workspace), recursively. Missing dir -> [] */
  list(dir?: string): Promise<FileInfo[]>;
  /** names of the direct sub-directories of `dir` */
  dirs(dir?: string): Promise<string[]>;
  stat(path: string): Promise<FileInfo | null>;
  /** null when the file does not exist */
  read(path: string): Promise<Uint8Array | null>;
  /** creates parent directories; the write is atomic (readers never see a partial file).
   *  Note: browsers cannot set a file's modification time, it is always "now". */
  write(path: string, data: Uint8Array | string): Promise<void>;
  /** delete a file; no error if it is already gone */
  remove(path: string): Promise<void>;
  /** delete a directory with everything in it; no error if it is already gone */
  removeDir(path: string): Promise<void>;
}

const enc = new TextEncoder();

function split(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  for (const p of parts) if (p === '.' || p === '..' || p.includes('\\') || p.includes('\0')) throw new Error(`invalid path: ${path}`);
  return parts;
}

const isNotFound = (e: unknown) => e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');

/** Workspace on top of a FileSystemDirectoryHandle (picked folder or OPFS). */
export class HandleWorkspace implements Workspace {
  readonly kind: 'folder' | 'browser';
  readonly name: string;
  readonly root: FileSystemDirectoryHandle;

  constructor(root: FileSystemDirectoryHandle, kind: 'folder' | 'browser') {
    this.root = root;
    this.kind = kind;
    this.name = kind === 'browser' ? 'Browser storage' : root.name;
  }

  private async dir(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let d = this.root;
    for (const p of parts) {
      try { d = await d.getDirectoryHandle(p, { create }); } catch (e) { if (isNotFound(e)) return null; throw e; }
    }
    return d;
  }

  private async file(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const parts = split(path);
    const name = parts.pop();
    if (!name) throw new Error('empty path');
    const d = await this.dir(parts, create);
    if (!d) return null;
    try { return await d.getFileHandle(name, { create }); } catch (e) { if (isNotFound(e)) return null; throw e; }
  }

  async list(dir = ''): Promise<FileInfo[]> {
    const parts = split(dir);
    const start = await this.dir(parts, false);
    if (!start) return [];
    const out: FileInfo[] = [];
    const walk = async (d: FileSystemDirectoryHandle, prefix: string) => {
      const entries = (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
      for await (const [name, h] of entries) {
        // editors / browsers leave temp files behind while writing
        if (name.endsWith('.crswap') || name.endsWith('.tmp')) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, path);
        else {
          try { const f = await (h as FileSystemFileHandle).getFile(); out.push({ path, size: f.size, mtime: f.lastModified }); } catch (e) { if (!isNotFound(e)) throw e; }
        }
      }
    };
    await walk(start, parts.join('/'));
    return out;
  }

  async dirs(dir = ''): Promise<string[]> {
    const d = await this.dir(split(dir), false);
    if (!d) return [];
    const out: string[] = [];
    for await (const [name, h] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) if (h.kind === 'directory') out.push(name);
    return out.sort((a, b) => a.localeCompare(b));
  }

  async stat(path: string): Promise<FileInfo | null> {
    const h = await this.file(path, false);
    if (!h) return null;
    try { const f = await h.getFile(); return { path, size: f.size, mtime: f.lastModified }; } catch (e) { if (isNotFound(e)) return null; throw e; }
  }

  async read(path: string): Promise<Uint8Array | null> {
    const h = await this.file(path, false);
    if (!h) return null;
    try { return new Uint8Array(await (await h.getFile()).arrayBuffer()); } catch (e) { if (isNotFound(e)) return null; throw e; }
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    const h = await this.file(path, true);
    // createWritable() writes to a swap file and replaces the target on close()
    const w = await h!.createWritable();
    try {
      await w.write((typeof data === 'string' ? enc.encode(data) : data) as BufferSource as FileSystemWriteChunkType);
      await w.close();
    } catch (e) {
      await w.abort().catch(() => {});
      throw e;
    }
  }

  async remove(path: string): Promise<void> {
    const parts = split(path);
    const name = parts.pop();
    const d = name ? await this.dir(parts, false) : null;
    if (!d || !name) return;
    try { await d.removeEntry(name); } catch (e) { if (!isNotFound(e)) throw e; }
  }

  async removeDir(path: string): Promise<void> {
    const parts = split(path);
    const name = parts.pop();
    const d = name ? await this.dir(parts, false) : null;
    if (!d || !name) return;
    try { await d.removeEntry(name, { recursive: true }); } catch (e) { if (!isNotFound(e)) throw e; }
  }
}

/** In-memory workspace for tests. `now` lets tests control modification times. */
export class MemoryWorkspace implements Workspace {
  readonly kind = 'memory' as const;
  readonly name: string;
  files = new Map<string, { data: Uint8Array; mtime: number }>();
  now: () => number = () => Date.now();

  constructor(name = 'memory') { this.name = name; }

  async list(dir = ''): Promise<FileInfo[]> {
    const prefix = split(dir).join('/');
    const out: FileInfo[] = [];
    for (const [path, f] of this.files) if (!prefix || path.startsWith(prefix + '/')) out.push({ path, size: f.data.length, mtime: f.mtime });
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  async dirs(dir = ''): Promise<string[]> {
    const prefix = split(dir).join('/');
    const out = new Set<string>();
    for (const path of this.files.keys()) {
      if (prefix && !path.startsWith(prefix + '/')) continue;
      const rest = (prefix ? path.slice(prefix.length + 1) : path).split('/');
      if (rest.length > 1) out.add(rest[0]);
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }
  async stat(path: string): Promise<FileInfo | null> {
    const key = split(path).join('/'), f = this.files.get(key);
    return f ? { path: key, size: f.data.length, mtime: f.mtime } : null;
  }
  async read(path: string): Promise<Uint8Array | null> {
    const f = this.files.get(split(path).join('/'));
    return f ? f.data.slice() : null;
  }
  async write(path: string, data: Uint8Array | string): Promise<void> {
    this.files.set(split(path).join('/'), { data: typeof data === 'string' ? enc.encode(data) : data.slice(), mtime: this.now() });
  }
  async remove(path: string): Promise<void> { this.files.delete(split(path).join('/')); }
  async removeDir(path: string): Promise<void> {
    const prefix = split(path).join('/') + '/';
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
  }
}

/** small persistent key/value store for settings that must not live in the workspace
 *  (sync credentials, the handle of the chosen folder) */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryKV implements KV {
  private m = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { const v = this.m.get(key); return v === undefined ? undefined : (structuredClone(v) as T); }
  async set(key: string, value: unknown): Promise<void> { this.m.set(key, structuredClone(value)); }
  async delete(key: string): Promise<void> { this.m.delete(key); }
}

/** IndexedDB-backed KV (values are structured-cloned, so directory handles can be stored) */
export class IdbKV implements KV {
  private db: Promise<IDBDatabase>;
  constructor(name = 'vibesketch') {
    this.db = new Promise((res, rej) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db;
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', mode);
      const rq = fn(tx.objectStore('kv'));
      tx.oncomplete = () => res(rq.result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }
  get<T>(key: string): Promise<T | undefined> { return this.run('readonly', s => s.get(key) as IDBRequest<T | undefined>); }
  async set(key: string, value: unknown): Promise<void> { await this.run('readwrite', s => s.put(value, key)); }
  async delete(key: string): Promise<void> { await this.run('readwrite', s => s.delete(key)); }
}
