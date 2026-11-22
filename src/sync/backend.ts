// The small interface every sync remote implements. Paths are '/'-separated and relative to
// the workspace root (e.g. `My Project.vsk/doc.json`).

export interface RemoteEntry {
  path: string;
  /** opaque; changes whenever the remote content changes (S3 ETag / Drive md5Checksum) */
  version: string;
  /** ms; best effort in listings (S3 only knows the upload time there); 0 = unknown */
  mtime: number;
  size: number;
  /** hex md5 of the content when the remote knows it cheaply (lets us skip downloads) */
  md5?: string;
}

export interface RemoteObject {
  bytes: Uint8Array;
  /** '' when the remote did not tell (e.g. ETag header hidden by CORS) */
  version: string;
  /** ms; the modification time recorded by the uploader; 0 = unknown */
  mtime: number;
}

export interface PutOptions {
  /**
   * Optimistic concurrency, where the remote supports it: the version we expect to replace,
   * or `null` if we expect the file not to exist. A mismatch throws `PreconditionFailed`.
   */
  ifVersion?: string | null;
}

export interface SyncBackend {
  list(): Promise<RemoteEntry[]>;
  get(path: string): Promise<RemoteObject>;
  put(path: string, bytes: Uint8Array, mtime: number, opts?: PutOptions): Promise<string>;
  delete(path: string): Promise<void>;
  /** Cheap credentials / reachability check; throws with a readable message. */
  test(): Promise<void>;
}

/** The remote needs (re-)authorisation by the user; retrying will not help. */
export class UnauthorizedError extends Error {}

/** Somebody else changed the remote file between our listing and our upload. */
export class PreconditionFailed extends Error {}

export class NotFoundError extends Error {}

export type FetchFn = typeof fetch;
