// Minimal image sniffing (type + pixel size) without DOM APIs.

export interface ImageInfo { ext: string; mime: string; w?: number; h?: number }

export function sniffImage(b: Uint8Array): ImageInfo | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG: signature, then IHDR with big-endian width/height
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { ext: 'png', mime: 'image/png', w: dv.getUint32(16), h: dv.getUint32(20) };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { ext: 'gif', mime: 'image/gif', w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const info: ImageInfo = { ext: 'jpg', mime: 'image/jpeg' };
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      const len = dv.getUint16(o + 2);
      // SOF0..SOF15 except DHT (c4), JPG (c8), DAC (cc)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        info.h = dv.getUint16(o + 5);
        info.w = dv.getUint16(o + 7);
        break;
      }
      if (m === 0xda || len < 2) break;
      o += 2 + len;
    }
    return info;
  }
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const info: ImageInfo = { ext: 'webp', mime: 'image/webp' };
    const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fourcc === 'VP8X') {
      info.w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      info.h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    } else if (fourcc === 'VP8L' && b[20] === 0x2f) {
      const bits = dv.getUint32(21, true);
      info.w = 1 + (bits & 0x3fff);
      info.h = 1 + ((bits >>> 14) & 0x3fff);
    } else if (fourcc === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      info.w = dv.getUint16(26, true) & 0x3fff;
      info.h = dv.getUint16(28, true) & 0x3fff;
    }
    return info;
  }
  return null;
}

const HEX = '0123456789abcdef';
export function toHex(b: Uint8Array): string {
  let s = '';
  for (const v of b) s += HEX[v >> 4] + HEX[v & 15];
  return s;
}

export async function sha256Hex(b: Uint8Array): Promise<string> {
  // copy into a plain ArrayBuffer: subarrays of the unzip buffer are not accepted everywhere
  const buf = new Uint8Array(b).buffer;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
}
