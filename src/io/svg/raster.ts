// data: URI decoding, raster header sniffing and content-addressed asset keys.

export interface DataUri { mime: string; bytes: Uint8Array<ArrayBuffer> }

export function decodeDataUri(uri: string): DataUri | null {
  const s = uri.trim();
  if (!/^data:/i.test(s)) return null;
  const comma = s.indexOf(',');
  if (comma < 0) return null;
  const head = s.slice(5, comma).split(';').map(p => p.trim());
  const mime = (head[0] || 'text/plain').toLowerCase();
  const isB64 = head.slice(1).some(p => p.toLowerCase() === 'base64');
  const data = s.slice(comma + 1);
  try {
    if (isB64) {
      let b64 = data.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      b64 = b64.replace(/[\s]+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { mime, bytes };
    }
    let text: string;
    try { text = decodeURIComponent(data); } catch { text = data; }
    const enc = new TextEncoder().encode(text);
    const bytes = new Uint8Array(enc.length);
    bytes.set(enc);
    return { mime, bytes };
  } catch {
    return null;
  }
}

export interface RasterInfo { mime: string; ext: string; w: number; h: number }

const ascii = (b: Uint8Array, o: number, n: number): string => String.fromCharCode(...b.subarray(o, o + n));

/** Identify PNG / JPEG / GIF / WebP from the magic bytes and read the pixel size. */
export function sniffRaster(b: Uint8Array): RasterInfo | null {
  const u16be = (o: number): number => (b[o] << 8) | b[o + 1];
  const u32be = (o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u16le = (o: number): number => b[o] | (b[o + 1] << 8);
  const u24le = (o: number): number => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') {
    return { mime: 'image/png', ext: 'png', w: u32be(16), h: u32be(20) };
  }
  if (b.length >= 10 && ascii(b, 0, 3) === 'GIF') {
    return { mime: 'image/gif', ext: 'gif', w: u16le(6), h: u16le(8) };
  }
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const kind = ascii(b, 12, 4);
    if (kind === 'VP8 ') return { mime: 'image/webp', ext: 'webp', w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
    if (kind === 'VP8L') {
      const w = 1 + (((b[22] & 0x3f) << 8) | b[21]);
      const h = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
      return { mime: 'image/webp', ext: 'webp', w, h };
    }
    if (kind === 'VP8X') return { mime: 'image/webp', ext: 'webp', w: 1 + u24le(24), h: 1 + u24le(27) };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const marker = b[o + 1];
      if (marker === 0xff) { o++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', ext: 'jpg', w: u16be(o + 7), h: u16be(o + 5) };
      }
      o += 2 + u16be(o + 2);
    }
    return { mime: 'image/jpeg', ext: 'jpg', w: 0, h: 0 };
  }
  return null;
}

export function looksLikeSvg(d: DataUri): boolean {
  if (d.mime.includes('svg')) return true;
  if (sniffRaster(d.bytes)) return false;
  const head = new TextDecoder().decode(d.bytes.subarray(0, 512));
  return /<svg[\s>]/i.test(head);
}

/** asset key: first 32 hex chars of the sha256 + '.' + ext */
export async function assetKey(bytes: Uint8Array<ArrayBuffer>, ext: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const v of digest) hex += v.toString(16).padStart(2, '0');
  return `${hex.slice(0, 32)}.${ext}`;
}
