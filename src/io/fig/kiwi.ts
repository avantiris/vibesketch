// Container + kiwi decoding for Figma .fig files.
//
// A .fig is either a raw "fig-kiwi" blob or a ZIP holding `canvas.fig` (fig-kiwi), `meta.json`,
// `thumbnail.png` and `images/<sha1 hex>`. fig-kiwi = 8 byte magic, u32 version, then
// length-prefixed chunks (deflate-raw or zstd): chunk 0 is a kiwi binary schema, chunk 1 the
// message encoded with it.
//
// The message is decoded with a small schema *interpreter* instead of kiwi-schema's
// `compileSchema`, which generates JS source from the (untrusted) schema and runs it through
// `new Function` – that would be both a CSP problem in the browser and needless attack surface.

import { inflateSync, unzipSync } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';
import { ByteBuffer, decodeBinarySchema } from 'kiwi-schema';
import type { Definition, Schema } from 'kiwi-schema';
import type { FigMessage } from './types.ts';

export interface FigContainer {
  message: FigMessage;
  schema: Schema;
  /** zip entries under images/, keyed by lower-case hex hash; empty for raw fig-kiwi files */
  images: Map<string, Uint8Array>;
  meta: unknown;
  version: number;
}

const ascii = (b: Uint8Array, off: number, n: number): string => {
  let s = '';
  for (let i = off; i < off + n && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

function decompressChunk(chunk: Uint8Array): Uint8Array {
  if (chunk.length >= 4 && chunk[0] === 0x28 && chunk[1] === 0xb5 && chunk[2] === 0x2f && chunk[3] === 0xfd) {
    return zstdDecompress(chunk);
  }
  return inflateSync(chunk);
}

export function readFigContainer(bytes: Uint8Array): FigContainer {
  let kiwi = bytes;
  const images = new Map<string, Uint8Array>();
  let meta: unknown = null;
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes);
    } catch (e) {
      throw new Error(`Not a readable .fig file (broken ZIP container: ${(e as Error).message})`);
    }
    const canvas = files['canvas.fig'];
    if (!canvas) throw new Error('Not a Figma design file: the archive has no canvas.fig');
    kiwi = canvas;
    for (const [name, data] of Object.entries(files)) {
      if (name.startsWith('images/') && data.length) images.set(name.slice(7).toLowerCase(), data);
    }
    if (files['meta.json']) {
      try { meta = JSON.parse(new TextDecoder().decode(files['meta.json'])); } catch { /* optional */ }
    }
  }
  const magic = ascii(kiwi, 0, 8);
  if (magic !== 'fig-kiwi') {
    if (magic === 'fig-jam.' || magic === 'fig-deck' || magic.startsWith('fig-')) {
      throw new Error(`Unsupported Figma file flavour "${magic}" (only design files are supported)`);
    }
    throw new Error('Not a Figma .fig file (missing fig-kiwi header)');
  }
  const dv = new DataView(kiwi.buffer, kiwi.byteOffset, kiwi.byteLength);
  const version = dv.getUint32(8, true);
  const chunks: Uint8Array[] = [];
  let off = 12;
  while (off + 4 <= kiwi.length) {
    const len = dv.getUint32(off, true);
    off += 4;
    if (off + len > kiwi.length) throw new Error('Corrupt .fig file (truncated chunk)');
    chunks.push(kiwi.subarray(off, off + len));
    off += len;
  }
  if (chunks.length < 2) throw new Error('Corrupt .fig file (schema or data chunk missing)');
  let schema: Schema, message: FigMessage;
  try {
    schema = decodeBinarySchema(decompressChunk(chunks[0]));
    message = decodeMessage(schema, 'Message', decompressChunk(chunks[1])) as FigMessage;
  } catch (e) {
    throw new Error(`Could not decode the .fig file (version ${version}): ${(e as Error).message}`);
  }
  return { message, schema, images, meta, version };
}

/** Decode a kiwi message by interpreting the schema (same semantics as kiwi's generated code). */
export function decodeMessage(schema: Schema, root: string, data: Uint8Array): unknown {
  const defs = new Map<string, Definition>();
  const enums = new Map<string, Map<number, string>>();
  const fieldsByValue = new Map<string, Map<number, Definition['fields'][number]>>();
  for (const d of schema.definitions) {
    defs.set(d.name, d);
    if (d.kind === 'ENUM') enums.set(d.name, new Map(d.fields.map(f => [f.value, f.name])));
    else if (d.kind === 'MESSAGE') fieldsByValue.set(d.name, new Map(d.fields.map(f => [f.value, f])));
  }
  const bb = new ByteBuffer(data);

  const readValue = (type: string | null, depth: number): unknown => {
    switch (type) {
      case 'bool': return !!bb.readByte();
      case 'byte': return bb.readByte();
      case 'int': return bb.readVarInt();
      case 'uint': return bb.readVarUint();
      case 'float': return bb.readVarFloat();
      case 'string': return bb.readString();
      case 'int64': return bb.readVarInt64();
      case 'uint64': return bb.readVarUint64();
    }
    const def = type === null ? undefined : defs.get(type);
    if (!def) throw new Error(`schema references unknown type "${type}"`);
    if (def.kind === 'ENUM') return enums.get(def.name)!.get(bb.readVarUint());
    return readDef(def, depth + 1);
  };

  const readField = (out: Record<string, unknown>, f: Definition['fields'][number], depth: number): void => {
    let v: unknown;
    if (f.isArray) {
      if (f.type === 'byte') v = bb.readByteArray();
      else {
        const n = bb.readVarUint();
        const arr: unknown[] = [];
        for (let i = 0; i < n; i++) arr.push(readValue(f.type, depth));
        v = arr;
      }
    } else v = readValue(f.type, depth);
    if (!f.isDeprecated && f.name !== '__proto__') out[f.name] = v;
  };

  const readDef = (def: Definition, depth: number): Record<string, unknown> => {
    if (depth > 200) throw new Error('message nesting too deep');
    const out: Record<string, unknown> = {};
    if (def.kind === 'MESSAGE') {
      const byValue = fieldsByValue.get(def.name)!;
      for (;;) {
        const tag = bb.readVarUint();
        if (tag === 0) return out;
        const f = byValue.get(tag);
        if (!f) throw new Error(`unknown field ${tag} in ${def.name}`);
        readField(out, f, depth);
      }
    }
    for (const f of def.fields) readField(out, f, depth);
    return out;
  };

  const def = defs.get(root);
  if (!def || def.kind !== 'MESSAGE') throw new Error(`schema has no "${root}" message`);
  return readDef(def, 0);
}
