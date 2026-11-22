// Google Drive backend on the REST v3 API with plain fetch (works cross-origin from a browser).
//
// Auth is not this module's business: it is handed a `getToken(forceNew)` function. With the
// `drive.file` scope the app only sees files it created itself, so every device that should
// sync with the others must use the same OAuth client id.

import { NotFoundError, UnauthorizedError } from './backend.ts';
import type { FetchFn, RemoteEntry, RemoteObject, SyncBackend } from './backend.ts';
import { concatBytes, md5Hex, randomToken, sleep, timeoutSignal, utf8 } from './util.ts';

export const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MULTIPART_MAX = 5 * 1024 * 1024;

interface DriveFile {
  id: string; name: string; mimeType?: string; parents?: string[]; md5Checksum?: string;
  modifiedTime?: string; createdTime?: string; size?: string;
}

interface FileRef { id: string; md5: string; mtime: number; size: number; dupes: string[] }

interface Tree { folders: Map<string, string>; files: Map<string, FileRef> }

export interface GDriveOptions {
  folderName: string;
  /** a valid access token; `forceNew` = the previous one was rejected. Throws UnauthorizedError
   *  when the user has to sign in again. */
  getToken: (forceNew: boolean) => Promise<string>;
}

const escapeQ = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export class GDriveBackend implements SyncBackend {
  private cfg: GDriveOptions;
  private fetchFn: FetchFn;
  private rootId: Promise<string> | null = null;
  private tree: Tree | null = null;
  private creating = new Map<string, Promise<string>>();
  /** base delay for rate-limit backoff (tests set this to 0) */
  backoffMs = 1000;
  maxAttempts = 6;

  constructor(cfg: GDriveOptions, fetchFn?: FetchFn) {
    this.cfg = cfg;
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  /** Authorised request; asks for a new token once on 401, backs off on rate limits / 5xx. */
  private async api(url: string, init: RequestInit = {}, opts: { timeoutMs?: number } = {}): Promise<Response> {
    let renewed = false;
    let lastErr: Error = new Error('Google Drive request failed');
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const token = await this.cfg.getToken(renewed && attempt > 0 && lastErr instanceof Retry401);
      let res: Response;
      try {
        const req: RequestInit = {
          ...init,
          headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
        };
        const signal = timeoutSignal(opts.timeoutMs ?? 60_000);
        if (signal) req.signal = signal;
        res = await this.fetchFn(url, req);
      } catch (e) {
        lastErr = e instanceof TypeError
          ? new Error('Could not reach Google Drive (offline, or the request was blocked by the browser)')
          : e instanceof Error ? e : new Error(String(e));
        await sleep(this.backoffMs * 2 ** attempt);
        continue;
      }
      if (res.ok) return res;
      if (res.status === 401) {
        await res.body?.cancel();
        if (renewed) throw new UnauthorizedError('Google Drive rejected the access token; connect again');
        renewed = true;
        lastErr = new Retry401();
        continue;
      }
      const text = await res.text().catch(() => '');
      let message = res.statusText;
      let reason = '';
      try {
        const j = JSON.parse(text) as { error?: { message?: string; errors?: { reason?: string }[] } };
        message = j.error?.message || message;
        reason = j.error?.errors?.[0]?.reason ?? '';
      } catch { /* not JSON */ }
      const rateLimited = res.status === 429
        || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded|sharingRateLimitExceeded/i.test(reason + ' ' + message));
      if (rateLimited || res.status >= 500) {
        lastErr = new Error(`Google Drive: ${message} (${res.status})`);
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 && this.backoffMs > 0
          ? Math.min(retryAfter * 1000, 60_000)
          : this.backoffMs * 2 ** attempt + Math.random() * this.backoffMs;
        await sleep(wait);
        continue;
      }
      if (res.status === 404) throw new NotFoundError(`Google Drive: ${message}`);
      throw new Error(`Google Drive: ${message} (${res.status})`);
    }
    throw lastErr;
  }

  private async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    return (await (await this.api(url, init)).json()) as T;
  }

  // ---- folders

  private root(): Promise<string> {
    this.rootId ??= (async () => {
      const q = `name = '${escapeQ(this.cfg.folderName)}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`;
      const params = new URLSearchParams({ q, fields: 'files(id,name,createdTime)', orderBy: 'createdTime', pageSize: '10', spaces: 'drive' });
      const found = await this.json<{ files?: DriveFile[] }>(`${API}/files?${params}`);
      if (found.files?.length) return found.files[0]!.id;
      const created = await this.json<DriveFile>(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: this.cfg.folderName, mimeType: FOLDER_MIME, parents: ['root'] }),
      });
      return created.id;
    })();
    this.rootId.catch(() => { this.rootId = null; });
    return this.rootId;
  }

  private async ensureTree(): Promise<Tree> {
    if (!this.tree) await this.list();
    return this.tree!;
  }

  /** Folder id for a '/'-separated folder path below the root ('' = root), created on demand. */
  private async ensureFolder(folderPath: string): Promise<string> {
    if (folderPath === '') return this.root();
    const tree = await this.ensureTree();
    const known = tree.folders.get(folderPath);
    if (known) return known;
    let pending = this.creating.get(folderPath);
    if (!pending) {
      pending = (async () => {
        const slash = folderPath.lastIndexOf('/');
        const parent = await this.ensureFolder(slash < 0 ? '' : folderPath.slice(0, slash));
        const created = await this.json<DriveFile>(`${API}/files?fields=id`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: folderPath.slice(slash + 1), mimeType: FOLDER_MIME, parents: [parent] }),
        });
        tree.folders.set(folderPath, created.id);
        this.tree?.folders.set(folderPath, created.id);
        return created.id;
      })().finally(() => this.creating.delete(folderPath));
      this.creating.set(folderPath, pending);
    }
    return pending;
  }

  // ---- SyncBackend

  async list(): Promise<RemoteEntry[]> {
    const rootId = await this.root();
    const all: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: 'trashed = false',
        fields: 'nextPageToken,files(id,name,mimeType,parents,md5Checksum,modifiedTime,createdTime,size)',
        pageSize: '1000',
        spaces: 'drive',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.json<{ nextPageToken?: string; files?: DriveFile[] }>(`${API}/files?${params}`);
      all.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);

    // resolve every item's path by walking its parent chain up to our root folder
    const folderById = new Map<string, DriveFile>();
    for (const f of all) if (f.mimeType === FOLDER_MIME) folderById.set(f.id, f);
    const pathCache = new Map<string, string | null>([[rootId, '']]);
    const folderPath = (id: string, depth = 0): string | null => {
      const hit = pathCache.get(id);
      if (hit !== undefined) return hit;
      const f = folderById.get(id);
      let p: string | null = null;
      if (f && depth < 64 && f.parents?.[0] && !f.name.includes('/')) {
        const parent = folderPath(f.parents[0], depth + 1);
        if (parent !== null) p = parent ? `${parent}/${f.name}` : f.name;
      }
      pathCache.set(id, p);
      return p;
    };

    const tree: Tree = { folders: new Map([['', rootId]]), files: new Map() };
    const folders = [...folderById.values()].sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''));
    for (const f of folders) {
      const p = folderPath(f.id);
      // duplicates (two devices creating the same folder at once): the oldest one is canonical
      if (p && !tree.folders.has(p)) tree.folders.set(p, f.id);
    }
    for (const f of all) {
      if (f.mimeType === FOLDER_MIME || !f.md5Checksum || !f.parents?.[0] || f.name.includes('/')) continue;
      const parent = folderPath(f.parents[0]);
      if (parent === null) continue;
      const p = parent ? `${parent}/${f.name}` : f.name;
      const ref: FileRef = {
        id: f.id, md5: f.md5Checksum, mtime: Date.parse(f.modifiedTime ?? '') || 0, size: Number(f.size ?? 0), dupes: [],
      };
      const prev = tree.files.get(p);
      if (!prev) tree.files.set(p, ref);
      else if (ref.mtime > prev.mtime) { ref.dupes = [prev.id, ...prev.dupes]; tree.files.set(p, ref); }
      else prev.dupes.push(ref.id);
    }
    this.tree = tree;
    return [...tree.files].map(([path, f]) => ({ path, version: f.md5, mtime: f.mtime, size: f.size, md5: f.md5 }));
  }

  async get(path: string): Promise<RemoteObject> {
    let ref = (await this.ensureTree()).files.get(path);
    if (!ref) {
      await this.list();
      ref = this.tree!.files.get(path);
    }
    if (!ref) throw new NotFoundError(`Google Drive: ${path} not found`);
    const res = await this.api(`${API}/files/${encodeURIComponent(ref.id)}?alt=media`, {}, { timeoutMs: 15 * 60_000 });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, version: md5Hex(bytes), mtime: ref.mtime };
  }

  async put(path: string, bytes: Uint8Array, mtime: number): Promise<string> {
    const tree = await this.ensureTree();
    const slash = path.lastIndexOf('/');
    const modifiedTime = new Date(Number.isFinite(mtime) && mtime > 0 ? mtime : Date.now()).toISOString();
    const upload = async (existing: FileRef | undefined): Promise<DriveFile> => {
      const meta: Record<string, unknown> = { modifiedTime };
      let url = `${UPLOAD}/files`;
      let method = 'POST';
      if (existing) {
        url += `/${encodeURIComponent(existing.id)}`;
        method = 'PATCH';
      } else {
        meta.name = path.slice(slash + 1);
        meta.parents = [await this.ensureFolder(slash < 0 ? '' : path.slice(0, slash))];
      }
      const fields = 'fields=id,md5Checksum,modifiedTime,size';
      const multipart = async (): Promise<DriveFile> => {
        const boundary = `vibesketch-${randomToken(12)}`;
        const body = concatBytes([
          utf8(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
            + `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
          bytes,
          utf8(`\r\n--${boundary}--\r\n`),
        ]);
        const res = await this.api(`${url}?uploadType=multipart&${fields}`, {
          method, headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: body as BodyInit,
        }, { timeoutMs: 15 * 60_000 });
        return (await res.json()) as DriveFile;
      };
      if (bytes.byteLength <= MULTIPART_MAX) return multipart();
      // resumable: open a session, then send the content in one request
      const session = await this.api(`${url}?uploadType=resumable&${fields}`, {
        method,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': 'application/octet-stream',
          'x-upload-content-length': String(bytes.byteLength),
        },
        body: JSON.stringify(meta),
      });
      await session.body?.cancel();
      const location = session.headers.get('location');
      // the session URL is a response header; if the browser may not read it, a (larger than
      // recommended, but valid) multipart upload still gets the file there
      if (!location) return multipart();
      const res = await this.api(location, {
        method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes as BodyInit,
      }, { timeoutMs: 30 * 60_000 });
      return (await res.json()) as DriveFile;
    };

    const existing = tree.files.get(path);
    let file: DriveFile;
    try {
      file = await upload(existing);
    } catch (e) {
      if (!(e instanceof NotFoundError) || !existing) throw e;
      tree.files.delete(path); // the file vanished remotely: create it afresh
      file = await upload(undefined);
    }
    const md5 = file.md5Checksum || md5Hex(bytes);
    const ref: FileRef = {
      id: file.id, md5, mtime: Date.parse(file.modifiedTime ?? modifiedTime) || 0,
      size: bytes.byteLength, dupes: existing?.dupes ?? [],
    };
    tree.files.set(path, ref);
    this.tree?.files.set(path, ref);
    return md5;
  }

  /** Moves the file to the Drive trash (recoverable for 30 days) rather than destroying it. */
  async delete(path: string): Promise<void> {
    const tree = await this.ensureTree();
    const ref = tree.files.get(path);
    if (!ref) return;
    for (const id of [ref.id, ...ref.dupes]) {
      try {
        const res = await this.api(`${API}/files/${encodeURIComponent(id)}?fields=id`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }),
        });
        await res.body?.cancel();
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;
      }
    }
    tree.files.delete(path);
  }

  async test(): Promise<void> {
    await this.root();
  }
}

/** internal marker: the last attempt failed with 401, so the next token must be a new one */
class Retry401 extends Error {}
