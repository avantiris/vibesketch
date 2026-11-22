// S3 (and compatibles: R2, MinIO, Garage, versitygw, ...) backend on aws4fetch + fetch.
// Runs in the browser, so the bucket must allow the app's origin through CORS.

import { AwsClient } from 'aws4fetch';
import { NotFoundError, PreconditionFailed } from './backend.ts';
import type { FetchFn, PutOptions, RemoteEntry, RemoteObject, SyncBackend } from './backend.ts';
import { sleep, timeoutSignal } from './util.ts';

export interface S3Options {
  /** '' = AWS */
  endpoint: string; region: string; bucket: string; prefix: string;
  accessKeyId: string; secretAccessKey: string; pathStyle: boolean;
}

const META_MTIME = 'x-amz-meta-mtime';

/** The origin the bucket's CORS rule has to allow ('' outside a browser). */
export function appOrigin(): string {
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return loc?.origin && loc.origin !== 'null' ? loc.origin : '';
}

/** The CORS configuration a bucket needs, as the JSON most S3 consoles / CLIs accept. */
export function s3CorsRule(origin = appOrigin()): string {
  return JSON.stringify([{
    AllowedOrigins: [origin || 'https://<where this app is hosted>'],
    AllowedMethods: ['GET', 'PUT', 'DELETE', 'HEAD'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag', 'x-amz-meta-mtime'],
    MaxAgeSeconds: 3600,
  }], null, 2);
}

/** Plain-words explanation for a request the browser refused to make or to show us. */
export function s3NetworkHelp(origin = appOrigin()): string {
  return 'Could not reach the S3 bucket. Either the endpoint is wrong or offline, or (most often) the bucket does not allow '
    + `this app through CORS. Add this CORS rule to the bucket: allowed origin ${origin || '<the address of this app>'}, `
    + 'methods GET, PUT, DELETE, HEAD, allowed headers *, exposed headers ETag and x-amz-meta-* (x-amz-meta-mtime). As JSON:\n'
    + s3CorsRule(origin);
}

/** A network-level failure (in a browser this is also what a CORS rejection looks like). */
export class S3NetworkError extends Error {}

export function normalizePrefix(prefix: string): string {
  const p = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  return p ? p + '/' : '';
}

export function xmlUnescape(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (all, e: string) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const cp = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    try { return String.fromCodePoint(cp); } catch { return all; }
  });
}

function xmlTag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  if (!m) return undefined;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(m[1]!);
  return cdata ? cdata[1]! : xmlUnescape(m[1]!);
}

export interface ListPage {
  entries: { key: string; etag: string; lastModified: number; size: number }[];
  truncated: boolean;
  nextToken: string | undefined;
}

/** Tolerant ListObjectsV2 response parser. */
export function parseListObjectsV2(xml: string): ListPage {
  const entries: ListPage['entries'] = [];
  const rest = xml.replace(/<Contents>([\s\S]*?)<\/Contents>/g, (_all, block: string) => {
    entries.push({
      key: xmlTag(block, 'Key') ?? '',
      etag: (xmlTag(block, 'ETag') ?? '').replace(/^W\//, '').replace(/^"|"$/g, ''),
      lastModified: Date.parse(xmlTag(block, 'LastModified') ?? '') || 0,
      size: Number(xmlTag(block, 'Size') ?? 0) || 0,
    });
    return '';
  });
  // `encoding-type=url`: keys are percent-encoded, with '+' for space
  if ((xmlTag(rest, 'EncodingType') ?? '').toLowerCase() === 'url') {
    for (const e of entries) {
      try { e.key = decodeURIComponent(e.key.replace(/\+/g, ' ')); } catch { /* keep as is */ }
    }
  }
  return {
    entries: entries.filter((e) => e.key !== ''),
    truncated: (xmlTag(rest, 'IsTruncated') ?? '').trim().toLowerCase() === 'true',
    nextToken: xmlTag(rest, 'NextContinuationToken'),
  };
}

function encodeKey(key: string): string {
  return key.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

const cleanEtag = (h: string | null): string => (h ?? '').replace(/^W\//, '').replace(/^"|"$/g, '');
const isMd5 = (s: string): boolean => /^[a-f0-9]{32}$/.test(s);

export class S3Backend implements SyncBackend {
  private client: AwsClient;
  private base: string;
  private prefix: string;
  private fetchFn: FetchFn;
  /** some S3 compatibles reject conditional writes; remember and stop sending them */
  private conditional = true;
  private pageSize: number | undefined;
  /** base delay between retries of transient failures (tests set 0) */
  retryMs = 300;

  constructor(cfg: S3Options, fetchFn?: FetchFn, opts: { pageSize?: number } = {}) {
    if (!cfg.bucket) throw new Error('S3: no bucket configured');
    if (!cfg.accessKeyId || !cfg.secretAccessKey) throw new Error('S3: access key / secret missing');
    this.pageSize = opts.pageSize;
    const region = cfg.region || 'us-east-1';
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 's3', region, retries: 0,
    });
    const endpoint = new URL(cfg.endpoint || `https://s3.${region}.amazonaws.com`);
    const basePath = endpoint.pathname.replace(/\/+$/, '');
    if (cfg.pathStyle) {
      this.base = `${endpoint.protocol}//${endpoint.host}${basePath}/${cfg.bucket}`;
    } else {
      this.base = `${endpoint.protocol}//${cfg.bucket}.${endpoint.host}${basePath}`;
    }
    this.prefix = normalizePrefix(cfg.prefix || '');
    // (a bare `fetch` reference must be called with the global as `this` in browsers)
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  private objectUrl(path: string): string {
    return `${this.base}/${encodeKey(this.prefix + path)}`;
  }

  /** Signed request with retries for transient failures (network, 5xx, 429). */
  private async request(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
    const { timeoutMs = 60_000, ...rest } = init;
    let lastErr: unknown;
    let network = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(this.retryMs * 2 ** attempt);
      try {
        const signed = await this.client.sign(url, rest);
        const signal = timeoutSignal(timeoutMs);
        const res = await this.fetchFn(signed, signal ? { signal } : undefined);
        if ((res.status >= 500 && res.status !== 501) || res.status === 429) {
          lastErr = await this.error(res, 'request');
          network = false;
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        // fetch reports CORS rejections, DNS failures and refused connections all as TypeError
        network = e instanceof TypeError;
      }
    }
    if (network) throw new S3NetworkError(s3NetworkHelp());
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async error(res: Response, what: string): Promise<Error> {
    const text = await res.text().catch(() => '');
    const code = xmlTag(text, 'Code');
    const message = xmlTag(text, 'Message');
    const detail = [code, message].filter(Boolean).join(': ') || res.statusText;
    return new Error(`S3 ${what} failed (${res.status}${detail ? ` ${detail}` : ''})`);
  }

  private async listPage(prefix: string, token: string | undefined, maxKeys?: number): Promise<ListPage> {
    const q = new URLSearchParams({ 'list-type': '2', 'encoding-type': 'url' });
    if (prefix) q.set('prefix', prefix);
    if (token) q.set('continuation-token', token);
    if (maxKeys) q.set('max-keys', String(maxKeys));
    // aws4fetch signs the query exactly as sent; S3 wants %20, not '+'
    const res = await this.request(`${this.base}/?${q.toString().replace(/\+/g, '%20')}`, { method: 'GET' });
    if (!res.ok) throw await this.error(res, 'list');
    return parseListObjectsV2(await res.text());
  }

  async list(): Promise<RemoteEntry[]> {
    const out: RemoteEntry[] = [];
    let token: string | undefined;
    for (let page = 0; page < 100_000; page++) {
      const p = await this.listPage(this.prefix, token, this.pageSize);
      for (const e of p.entries) {
        if (!e.key.startsWith(this.prefix) || e.key.endsWith('/')) continue;
        const entry: RemoteEntry = {
          path: e.key.slice(this.prefix.length), version: e.etag, mtime: e.lastModified, size: e.size,
        };
        if (isMd5(e.etag)) entry.md5 = e.etag;
        out.push(entry);
      }
      if (!p.truncated || !p.nextToken) break;
      token = p.nextToken;
    }
    return out;
  }

  async get(path: string): Promise<RemoteObject> {
    const res = await this.request(this.objectUrl(path), { method: 'GET', timeoutMs: 15 * 60_000 });
    if (res.status === 404) {
      await res.body?.cancel();
      throw new NotFoundError(`S3: ${path} not found`);
    }
    if (!res.ok) throw await this.error(res, 'download');
    const bytes = new Uint8Array(await res.arrayBuffer());
    // both headers are invisible when the bucket's CORS rule does not expose them: that just
    // means "unknown" (Last-Modified is always readable and is a usable stand-in for the mtime)
    const meta = Number(res.headers.get(META_MTIME));
    const mtime = Number.isFinite(meta) && meta > 0 ? meta : Date.parse(res.headers.get('last-modified') ?? '') || 0;
    return { bytes, version: cleanEtag(res.headers.get('etag')), mtime };
  }

  async put(path: string, bytes: Uint8Array, mtime: number, opts: PutOptions = {}): Promise<string> {
    const send = (conditional: boolean): Promise<Response> => {
      const headers: Record<string, string> = {
        'content-type': 'application/octet-stream',
        [META_MTIME]: String(Math.round(mtime)),
      };
      if (conditional && opts.ifVersion === null) headers['if-none-match'] = '*';
      else if (conditional && opts.ifVersion) headers['if-match'] = `"${opts.ifVersion}"`;
      return this.request(this.objectUrl(path), { method: 'PUT', headers, body: bytes as BodyInit, timeoutMs: 15 * 60_000 });
    };
    const wantsCondition = this.conditional && opts.ifVersion !== undefined;
    let res = await send(wantsCondition);
    if (wantsCondition && (res.status === 501 || res.status === 400)) {
      // conditional writes are not implemented by every S3 compatible: degrade to plain PUT
      await res.body?.cancel();
      this.conditional = false;
      res = await send(false);
    }
    if (res.status === 412 || res.status === 409) {
      await res.body?.cancel();
      throw new PreconditionFailed(`S3: ${path} changed remotely during upload`);
    }
    if (!res.ok) throw await this.error(res, 'upload');
    await res.body?.cancel();
    let etag = cleanEtag(res.headers.get('etag'));
    if (!etag) {
      // ETag not exposed through CORS: the listing carries it in its body instead
      const key = this.prefix + path;
      etag = (await this.listPage(key, undefined, 5)).entries.find((e) => e.key === key)?.etag ?? '';
      if (!etag) throw new Error('S3 upload: the server returned no ETag');
    }
    return etag;
  }

  async delete(path: string): Promise<void> {
    const res = await this.request(this.objectUrl(path), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw await this.error(res, 'delete');
    await res.body?.cancel();
  }

  async test(): Promise<void> {
    await this.listPage(this.prefix, undefined, 1);
  }
}
