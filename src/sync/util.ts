// Helpers for the sync code. Everything here runs in browsers and in Node (no node: imports).

const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);
export const byteLength = (s: string): number => enc.encode(s).length;

function hex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)));
}

const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

/** MD5 (WebCrypto has none). Only used to compare with S3 ETags / Drive md5Checksum. */
export function md5Hex(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const n = bytes.length;
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const M = new Int32Array(16);
  const block = (view: DataView, off: number): void => {
    for (let i = 0; i < 16; i++) M[i] = view.getInt32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + MD5_K[i]! + M[g]!) | 0;
      A = D; D = C; C = B;
      const s = MD5_S[(i >> 4) * 4 + (i & 3)]!;
      B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  };
  // full blocks straight from the input (no copy of large files), then the padded tail
  const full = n - (n % 64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let off = 0; off < full; off += 64) block(view, off);
  const rest = n - full;
  const tail = new Uint8Array(rest + 9 > 64 ? 128 : 64);
  tail.set(bytes.subarray(full));
  tail[rest] = 0x80;
  const tv = new DataView(tail.buffer);
  tv.setUint32(tail.length - 8, (n * 8) >>> 0, true);
  tv.setUint32(tail.length - 4, Math.floor(n / 2 ** 29), true);
  for (let off = 0; off < tail.length; off += 64) block(tv, off);
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setInt32(0, a0, true); ov.setInt32(4, b0, true); ov.setInt32(8, c0, true); ov.setInt32(12, d0, true);
  return hex(out);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function randomToken(bytes = 24): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** setTimeout that does not keep a Node process alive (no-op difference in browsers). */
export function timer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, ms);
  (t as unknown as { unref?: () => void }).unref?.();
  return t;
}

/** AbortSignal.timeout where available (all current browsers and Node). */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(ms) : undefined;
}

/** File-name safe ISO timestamp (no ':' so it is valid on every OS / remote). */
export function fileTimestamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** Run `fn` over `items` with at most `limit` in flight. `fn` must not throw. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------- workspace paths

export const PRIVATE_DIR = '.vibesketch';
const EXT = '.vsk';

function isValidProjectName(name: string): boolean {
  const len = [...name].length;
  return len >= 1 && len <= 100 && !/[/\\\0]/.test(name) && !name.startsWith('.');
}

/**
 * Is `path` ('/'-separated, relative to the workspace) something sync may touch? Used for the
 * local listing and to validate (untrusted) remote listings: never `.vibesketch/`, dot files,
 * temp files or conflict copies, and only below a `<project>.vsk/` folder.
 */
export function isSyncablePath(path: string): boolean {
  const segs = path.split('/');
  if (segs.length < 2) return false;
  for (const s of segs) {
    if (!s || s === '.' || s === '..' || s.startsWith('.') || /[\\\0]/.test(s)) return false;
    if (s.includes('.conflict-') || s.endsWith('.crswap') || s.endsWith('.tmp') || byteLength(s) > 255) return false;
  }
  const top = segs[0]!;
  return top.endsWith(EXT) && isValidProjectName(top.slice(0, -EXT.length));
}

/** `doc.json` -> `doc.conflict-<ts>.json` */
export function conflictName(path: string, ts: string): string {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? `${dir}${base.slice(0, dot)}.conflict-${ts}${base.slice(dot)}` : `${dir}${base}.conflict-${ts}`;
}
