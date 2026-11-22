import type { FontRef, TextNode } from './model.ts';

// Text layout shared by the canvas, bounds computation and export. Measuring is pluggable so
// the core stays free of DOM dependencies (the editor installs a canvas-backed measurer).

export interface FontMetrics { ascent: number; descent: number }
export interface Measurer {
  /** advance width of `text` in px, including letter spacing after every character */
  width(text: string, font: FontRef, size: number, letterSpacing: number): number;
  metrics(font: FontRef, size: number): FontMetrics;
}

/** crude fallback used outside the browser (tests, server) */
export const approxMeasurer: Measurer = {
  width: (text, _f, size, ls) => [...text].length * (size * 0.55 + ls),
  metrics: (_f, size) => ({ ascent: size * 0.93, descent: size * 0.24 }),
};

let measurer: Measurer = approxMeasurer;
let version = 0;
export function setMeasurer(m: Measurer) { measurer = m; invalidateTextLayout(); }
/** call when fonts finish loading: cached layouts are stale */
export function invalidateTextLayout() { version++; cache = new WeakMap(); }
export const textLayoutVersion = () => version;
export const fontMetrics = (font: FontRef, size: number): FontMetrics => measurer.metrics(font, size);

export interface TextLine { text: string; /** left edge */ x: number; /** baseline */ y: number; w: number }
export interface TextLayout { lines: TextLine[]; w: number; h: number; lineHeight: number; ascent: number; descent: number }

let cache = new WeakMap<TextNode, TextLayout>();

export function cssFont(font: FontRef, size: number): string {
  return `${font.italic ? 'italic ' : ''}${font.weight} ${size}px ${cssFamily(font.family)}`;
}
export const cssFamily = (family: string): string => `"${family.replace(/["\\]/g, '')}"`;

function wrapParagraph(par: string, maxW: number, w: (s: string) => number): string[] {
  if (w(par) <= maxW) return [par];
  const out: string[] = [];
  // tokens: runs of non-space followed by their trailing spaces
  const toks = par.match(/\S+\s*|\s+/g) ?? [''];
  let line = '';
  const pushLong = (tok: string) => {
    // a single word wider than the box: break between characters
    let cur = '';
    for (const ch of tok) {
      if (cur && w((cur + ch).trimEnd()) > maxW) { out.push(cur); cur = ch; } else cur += ch;
    }
    line = cur;
  };
  for (const tok of toks) {
    const cand = line + tok;
    if (w(cand.trimEnd()) <= maxW) { line = cand; continue; }
    if (line) { out.push(line.trimEnd()); line = ''; }
    if (w(tok.trimEnd()) <= maxW) line = tok; else pushLong(tok);
  }
  out.push(line.trimEnd());
  return out;
}

export function layoutText(n: TextNode): TextLayout {
  const hit = cache.get(n);
  if (hit) return hit;
  const m = measurer.metrics(n.font, n.size);
  const w = (s: string) => measurer.width(s, n.font, n.size, n.letterSpacing);
  const lh = n.lineHeight ?? Math.round((m.ascent + m.descent) * 100) / 100;
  const raw: string[] = [];
  for (const par of n.text.split('\n')) {
    if (n.w == null) raw.push(par); else raw.push(...wrapParagraph(par, Math.max(1, n.w), w));
  }
  const widths = raw.map(w);
  const W = n.w ?? Math.max(0, ...widths);
  const base = (lh - (m.ascent + m.descent)) / 2 + m.ascent;
  const lines = raw.map((text, i) => ({
    text,
    w: widths[i],
    x: n.align === 'center' ? (W - widths[i]) / 2 : n.align === 'right' ? W - widths[i] : 0,
    y: i * lh + base,
  }));
  const out: TextLayout = { lines, w: W, h: Math.max(1, raw.length) * lh, lineHeight: lh, ascent: m.ascent, descent: m.descent };
  cache.set(n, out);
  return out;
}
