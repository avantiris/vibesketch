import type { Box, Mat } from '../../core/model.ts';
import { around, mul, rotate } from '../../core/geom.ts';

// The importer is written against a tiny DOM subset (childNodes, nodeType, localName/tagName,
// getAttribute, textContent, parentNode) so it works with browsers and linkedom alike.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type El = any;

/** lower-cased element name; an `svg:` prefix is dropped, other prefixes are kept
 *  (`sodipodi:namedview`) so foreign-namespace elements can be recognised by the colon. */
export function tagOf(el: El): string {
  const t = String(el.localName || el.tagName || el.nodeName || '').toLowerCase();
  return t.startsWith('svg:') ? t.slice(4) : t;
}

export function attr(el: El, name: string): string | null {
  if (!el || typeof el.getAttribute !== 'function') return null;
  let v = el.getAttribute(name);
  if (v == null) {
    const lower = name.toLowerCase();
    if (lower !== name) v = el.getAttribute(lower); // HTML-parsed documents lower-case names
  }
  return v == null ? null : String(v);
}

export function elementKids(el: El): El[] {
  const out: El[] = [];
  const cn = el?.childNodes;
  if (!cn) return out;
  for (let i = 0; i < cn.length; i++) if (cn[i].nodeType === 1) out.push(cn[i]);
  return out;
}

export const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
const NUM_RE = new RegExp(NUM, 'g');
const LEN_RE = new RegExp(`^\\s*(${NUM})\\s*([a-zA-Z%]*)\\s*$`);

/** every number in the string (list attributes like `points`, `viewBox`, `values`) */
export function numbers(s: string | null | undefined): number[] {
  if (!s) return [];
  return (s.match(NUM_RE) ?? []).map(Number);
}

/** CSS/SVG length -> px. `ref` is what 100% means. null when unparsable. */
export function parseLength(s: string | null | undefined, fontSize: number, ref: number): number | null {
  if (s == null) return null;
  const m = LEN_RE.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case '': case 'px': return v;
    case 'pt': return (v * 4) / 3;
    case 'pc': return v * 16;
    case 'mm': return (v * 96) / 25.4;
    case 'cm': return (v * 96) / 2.54;
    case 'in': return v * 96;
    case 'q': return (v * 96) / 101.6;
    case 'em': case 'rem': return v * fontSize;
    case 'ex': case 'ch': return v * fontSize * 0.5;
    case '%': return (v * ref) / 100;
    default: return null;
  }
}

/** number or percentage -> fraction (`50%` -> 0.5, `0.5` -> 0.5) */
export function parseFraction(s: string | null | undefined, def: number): number {
  if (s == null) return def;
  const v = parseFloat(s);
  if (Number.isNaN(v)) return def;
  return s.trim().endsWith('%') ? v / 100 : v;
}

const deg = (d: number): number => (d * Math.PI) / 180;

/** SVG `transform` attribute (also tolerates CSS-style units like `10px` / `45deg`). */
export function parseTransform(s: string | null | undefined): Mat {
  let m: Mat = [1, 0, 0, 1, 0, 0];
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewx|skewy)\s*\(([^)]*)\)/gi;
  for (let t; (t = re.exec(s)); ) {
    const a = t[2].split(/[\s,]+/).filter(Boolean).map(parseFloat);
    if (a.some(Number.isNaN)) continue;
    let n: Mat | null = null;
    switch (t[1].toLowerCase()) {
      case 'matrix': if (a.length >= 6) n = [a[0], a[1], a[2], a[3], a[4], a[5]]; break;
      case 'translate': if (a.length >= 1) n = [1, 0, 0, 1, a[0], a[1] ?? 0]; break;
      case 'scale': if (a.length >= 1) n = [a[0], 0, 0, a[1] ?? a[0], 0, 0]; break;
      case 'rotate':
        if (a.length >= 3) n = around(rotate(deg(a[0])), { x: a[1], y: a[2] });
        else if (a.length >= 1) n = rotate(deg(a[0]));
        break;
      case 'skewx': if (a.length >= 1) n = [1, 0, Math.tan(deg(a[0])), 1, 0, 0]; break;
      case 'skewy': if (a.length >= 1) n = [1, Math.tan(deg(a[0])), 0, 1, 0, 0]; break;
    }
    if (n) m = mul(m, n);
  }
  return m;
}

export function parseViewBox(s: string | null | undefined): Box | null {
  const n = numbers(s);
  if (n.length < 4 || !(n[2] > 0) || !(n[3] > 0)) return null;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

export interface Par { align: string; slice: boolean }
export function parsePar(s: string | null | undefined): Par {
  const parts = (s ?? '').trim().split(/\s+/).filter(p => p && p !== 'defer');
  const align = parts[0] && /^(none|x(Min|Mid|Max)Y(Min|Mid|Max))$/.test(parts[0]) ? parts[0] : 'xMidYMid';
  return { align, slice: parts[1] === 'slice' };
}

/** maps viewBox coordinates into the viewport rect (x, y, w, h) */
export function viewBoxTransform(vb: Box, par: Par, x: number, y: number, w: number, h: number): Mat {
  let sx = w / vb.w, sy = h / vb.h;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return [1, 0, 0, 1, x, y];
  let fx = 0, fy = 0;
  if (par.align !== 'none') {
    sx = sy = par.slice ? Math.max(sx, sy) : Math.min(sx, sy);
    fx = par.align.includes('xMid') ? 0.5 : par.align.includes('xMax') ? 1 : 0;
    fy = par.align.includes('YMid') ? 0.5 : par.align.includes('YMax') ? 1 : 0;
  }
  return [sx, 0, 0, sy, x - vb.x * sx + (w - vb.w * sx) * fx, y - vb.y * sy + (h - vb.h * sy) * fy];
}

/** `url(#id)` reference at the start of a value -> [id, rest] */
export function urlRef(v: string | null | undefined): { id: string; rest: string } | null {
  if (!v) return null;
  const m = /^\s*url\(\s*['"]?#([^'")]+?)['"]?\s*\)\s*(.*)$/i.exec(v);
  return m ? { id: m[1], rest: m[2].trim() } : null;
}

export function hrefId(el: El): string | null {
  const h = attr(el, 'href') ?? attr(el, 'xlink:href');
  if (!h) return null;
  const t = h.trim();
  return t.startsWith('#') ? t.slice(1) : null;
}
