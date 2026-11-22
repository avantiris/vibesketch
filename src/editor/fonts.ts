import { signal } from '@preact/signals';
import opentype from 'opentype.js';
import type { FontRef } from '../core/model.ts';
import { cssFont, invalidateTextLayout, setMeasurer } from '../core/text.ts';
import { api } from '../io/api.ts';

// Font registry: typefaces bundled with the app, fonts installed on this computer (where the
// browser lets a page read them) and fonts embedded in the project.
// Faces are loaded lazily the first time a text node needs them.

export interface Face {
  key: string; family: string; weight: number; italic: boolean; style?: string;
  source: 'system' | 'local' | 'project';
  /** a variable font: the weights its one file covers; `weight` is the one this face stands for */
  range?: [number, number];
  url?: string;
  /** font file bytes, for faces that have no URL (fonts read from this computer) */
  data?: () => Promise<ArrayBuffer>;
}

/** bumped whenever a face finishes loading (text needs re-layout) or the face list changes */
export const fontsVersion = signal(0);
export const families = signal<string[]>([]);

let faces: Face[] = [];
let localFaces: Face[] = [];
let projectFaces: Face[] = [];
const loaded = new Map<string, Promise<void>>();
const otCache = new Map<string, Promise<opentype.Font | null>>();

const FALLBACK = ['Inter', 'Noto Sans', 'DejaVu Sans', 'Liberation Sans', 'Arial'];

function refresh() {
  const set = new Map<string, string>();
  for (const f of [...projectFaces, ...localFaces, ...faces]) if (!set.has(f.family.toLowerCase())) set.set(f.family.toLowerCase(), f.family);
  families.value = [...set.values()].sort((a, b) => a.localeCompare(b));
  fontsVersion.value = fontsVersion.peek() + 1;
}

export async function loadSystemFonts(): Promise<void> {
  try {
    const list = await api.fonts();
    faces = list.flatMap(f => {
      const face = { key: `sys:${f.id}`, family: f.family, weight: f.weight, italic: f.italic, url: api.fontUrl(f.file), style: f.style, source: 'system' as const };
      if (!f.wght) return [face];
      // a variable font is one file for a whole range of weights: offer every hundred of it
      const out: Face[] = [];
      for (let w = f.wght[0]; w <= f.wght[1]; w += 100) out.push({ ...face, weight: w, range: f.wght });
      return out;
    });
  } catch (e) {
    console.warn('could not list bundled fonts', e);
    faces = [];
  }
  refresh();
  // fonts of this computer, if the user allowed that before
  try {
    const st = await (navigator.permissions as unknown as { query(d: { name: string }): Promise<{ state: string }> }).query({ name: 'local-fonts' });
    if (st.state === 'granted') await loadLocalFonts();
  } catch { /* not supported */ }
}

interface FontData { family: string; fullName: string; postscriptName: string; style: string; blob(): Promise<Blob> }
const queryLocalFonts = (): (() => Promise<FontData[]>) | undefined => (window as unknown as { queryLocalFonts?: () => Promise<FontData[]> }).queryLocalFonts?.bind(window);
/** this browser can list installed fonts (Chromium; asks the user once) */
export const canUseLocalFonts = (): boolean => !!queryLocalFonts();
export const localFontsLoaded = signal(false);

function styleToFace(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase().replace(/[\s_-]+/g, '');
  const italic = /italic|oblique/.test(s);
  const table: [RegExp, number][] = [[/thin|hairline/, 100], [/extralight|ultralight/, 200], [/semilight|demilight/, 300], [/light/, 300], [/extrabold|ultrabold/, 800], [/semibold|demibold/, 600], [/black|heavy/, 900], [/bold/, 700], [/medium/, 500]];
  for (const [re, w] of table) if (re.test(s)) return { weight: w, italic };
  return { weight: 400, italic };
}

/** Read the fonts installed on this computer (shows the browser's permission prompt the
 *  first time, so call it from a click). Returns how many families were added. */
export async function loadLocalFonts(): Promise<number> {
  const q = queryLocalFonts();
  if (!q) return 0;
  const list = await q();
  localFaces = list.map(f => ({
    key: `local:${f.postscriptName}`, family: f.family, style: f.style, ...styleToFace(f.style), source: 'local' as const,
    data: async () => (await f.blob()).arrayBuffer(),
  }));
  localFontsLoaded.value = true;
  refresh();
  return new Set(localFaces.map(f => f.family)).size;
}

export function setProjectFonts(list: { family: string; weight: number; italic: boolean; url: string }[]) {
  projectFaces = list.map(f => ({ key: `proj:${f.url}`, ...f, source: 'project' as const }));
  refresh();
}

export function facesOf(family: string): Face[] {
  const k = family.toLowerCase();
  const all = [...projectFaces, ...localFaces, ...faces].filter(f => f.family.toLowerCase() === k);
  const seen = new Set<string>();
  return all.filter(f => { const id = `${f.weight}${f.italic}`; if (seen.has(id)) return false; seen.add(id); return true; })
    .sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic));
}

export const hasFamily = (family: string): boolean => facesOf(family).length > 0;

export function defaultFamily(): string {
  for (const f of FALLBACK) if (hasFamily(f)) return f;
  return families.value[0] ?? 'sans-serif';
}

/** best face for a reference: same family, italic match preferred, nearest weight */
export function matchFace(ref: FontRef): Face | null {
  const cands = facesOf(ref.family);
  if (!cands.length) return null;
  let best = cands[0], score = Infinity;
  for (const f of cands) {
    const s = Math.abs(f.weight - ref.weight) + (f.italic === ref.italic ? 0 : 1000);
    if (s < score) { score = s; best = f; }
  }
  return best;
}

/** Make sure the face for `ref` is usable by the browser. Resolves immediately when it is
 *  already loaded (or unavailable). Triggers a text re-layout when a new face arrives. */
export function ensureFont(ref: FontRef): Promise<void> {
  const face = matchFace(ref);
  if (!face) return Promise.resolve();
  let p = loaded.get(face.key);
  if (!p) {
    p = (async () => {
      try {
        const src = face.data ? await face.data() : `url("${face.url}")`;
        const ff = new FontFace(face.family, src, { weight: face.range ? `${face.range[0]} ${face.range[1]}` : String(face.weight), style: face.italic ? 'italic' : 'normal' });
        await ff.load();
        document.fonts.add(ff);
      } catch (e) {
        console.warn(`font failed to load: ${face.family} ${face.weight}`, e);
      }
      invalidateTextLayout();
      fontsVersion.value = fontsVersion.peek() + 1;
    })();
    loaded.set(face.key, p);
  }
  return p;
}

/** Parsed font for converting text to outlines; null when the file can't be parsed. */
export function openFont(ref: FontRef): Promise<opentype.Font | null> {
  const face = matchFace(ref);
  if (!face) return Promise.resolve(null);
  let p = otCache.get(face.key);
  if (!p) {
    p = (async () => {
      try {
        const buf = face.data ? await face.data() : await (await fetch(face.url!)).arrayBuffer();
        return opentype.parse(buf);
      } catch (e) {
        console.warn(`font can't be outlined: ${face.family}`, e);
        return null;
      }
    })();
    otCache.set(face.key, p);
  }
  return p;
}

/** Where on its axes a variable font has to be set to draw `ref`; undefined for a static font. */
export function fontVariation(font: opentype.Font, ref: FontRef): Record<string, number> | undefined {
  const axes = (font.tables as { fvar?: { axes?: { tag: string; minValue: number; defaultValue: number; maxValue: number }[] } }).fvar?.axes;
  if (!axes?.length) return undefined;
  const coords: Record<string, number> = {};
  for (const a of axes) coords[a.tag] = a.tag === 'wght' ? Math.min(a.maxValue, Math.max(a.minValue, ref.weight)) : a.defaultValue;
  return coords;
}

/** Read family / weight / italic out of a font file (ttf, otf, woff). */
export function describeFontFile(bytes: Uint8Array, fileName: string): { family: string; weight: number; italic: boolean } {
  try {
    const f = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const names = f.names as unknown as Record<string, Record<string, string> | undefined>;
    const pick = (k: string) => names[k]?.en ?? Object.values(names[k] ?? {})[0];
    const family = pick('preferredFamily') ?? pick('fontFamily') ?? fileName.replace(/\.[^.]+$/, '');
    const os2 = (f.tables as Record<string, { usWeightClass?: number; fsSelection?: number } | undefined>).os2;
    const sub = (pick('preferredSubfamily') ?? pick('fontSubfamily') ?? '').toLowerCase();
    return { family, weight: Math.min(900, Math.max(100, Math.round((os2?.usWeightClass ?? 400) / 100) * 100)), italic: !!((os2?.fsSelection ?? 0) & 1) || /italic|oblique/.test(sub) };
  } catch {
    const base = fileName.replace(/\.[^.]+$/, '');
    return { family: base.replace(/[-_](regular|bold|italic|light|medium|black|thin|semibold|extrabold).*$/i, ''), weight: /bold/i.test(base) ? 700 : 400, italic: /italic/i.test(base) };
  }
}

// canvas-backed measuring
let ctx: CanvasRenderingContext2D | null = null;
export function installMeasurer() {
  ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return;
  const c = ctx as Omit<CanvasRenderingContext2D, 'letterSpacing'> & { letterSpacing?: string };
  const hasLS = c.letterSpacing !== undefined;
  setMeasurer({
    width(text, font, size, ls) {
      c.font = cssFont(font, size);
      if (hasLS) { c.letterSpacing = `${ls}px`; return c.measureText(text).width; }
      return c.measureText(text).width + [...text].length * ls;
    },
    metrics(font, size) {
      c.font = cssFont(font, size);
      if (hasLS) c.letterSpacing = '0px';
      const m = c.measureText('Hg');
      const a = m.fontBoundingBoxAscent, d = m.fontBoundingBoxDescent;
      return Number.isFinite(a) && Number.isFinite(d) && a + d > 0 ? { ascent: a, descent: d } : { ascent: size * 0.93, descent: size * 0.24 };
    },
  });
}
