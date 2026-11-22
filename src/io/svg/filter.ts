import type { Color, Effect } from '../../core/model.ts';
import type { El } from './parse.ts';
import { attr, elementKids, numbers, tagOf } from './parse.ts';

export type FilterResult =
  | { kind: 'effects'; effects: Effect[] }
  /** a filter that only turns the content white keeping its alpha (cairo's `alpha` /
   *  `filter-remove-color` inside masks): the content then acts as an alpha mask */
  | { kind: 'alpha' }
  /** white, with the luminance of the content written into alpha (cairo's `filter-color-to-alpha`
   *  inside masks): the content then acts as a luminance mask, whatever the mask type */
  | { kind: 'luminance-to-alpha' }
  | { kind: 'unsupported'; why: string };

export interface FilterHelpers {
  /** the element's own declarations (attributes + CSS + inline style) */
  decls(el: El): Record<string, string>;
  color(value: string): Color | null;
}

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };

function stdDev(el: El, def = 0): number {
  const n = numbers(attr(el, 'stdDeviation'));
  if (!n.length) return def;
  return n.length > 1 ? (n[0] + n[1]) / 2 : n[0];
}
const num = (el: El, name: string, def: number): number => {
  const v = parseFloat(attr(el, name) ?? '');
  return Number.isNaN(v) ? def : v;
};
const isSource = (v: string | null): boolean => v == null || v === '' || v === 'SourceGraphic';

/** Map an SVG <filter> to our effects. Only the common, recognisable shapes are handled:
 *  a lone feGaussianBlur, feDropShadow(s), and the primitive chains Figma exports. */
export function parseFilter(filter: El, h: FilterHelpers): FilterResult {
  const prims = elementKids(filter).filter(e => tagOf(e).startsWith('fe'));
  const tags = prims.map(tagOf);
  if (!prims.length) return { kind: 'unsupported', why: 'no primitives' };

  // --- lone gaussian blur
  if (prims.length === 1 && tags[0] === 'fegaussianblur') {
    if (!isSource(attr(prims[0], 'in'))) return { kind: 'unsupported', why: 'blur input is not SourceGraphic' };
    return { kind: 'effects', effects: [{ type: 'layer-blur', visible: true, blur: 2 * stdDev(prims[0]) }] };
  }

  // --- lone "alpha -> white" colour matrix
  if (prims.length === 1 && tags[0] === 'fecolormatrix') {
    const v = numbers(attr(prims[0], 'values'));
    const type = attr(prims[0], 'type') ?? 'matrix';
    const white = v.length === 20 && [0, 1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13].every(i => v[i] === 0) && v[4] === 1 && v[9] === 1 && v[14] === 1;
    const close = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;
    if (type === 'matrix' && white && close(v[15], 0.2126) && close(v[16], 0.7152) && close(v[17], 0.0722) && v[18] === 0 && v[19] === 0) {
      return { kind: 'luminance-to-alpha' };
    }
    if (type === 'matrix' && v.length === 20 && v[15] === 0 && v[16] === 0 && v[17] === 0 && v[18] === 1 && v[19] === 0
      && [0, 1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13].every(i => v[i] === 0) && v[4] === 1 && v[9] === 1 && v[14] === 1) {
      return { kind: 'alpha' };
    }
    return { kind: 'unsupported', why: 'feColorMatrix' };
  }

  // --- feDropShadow(s)
  if (tags.every(t => t === 'fedropshadow')) {
    const effects: Effect[] = prims.map(p => {
      const d = h.decls(p);
      const c = h.color(d['flood-color'] ?? 'black') ?? BLACK;
      const op = parseFloat(d['flood-opacity'] ?? '1');
      return {
        type: 'drop-shadow', visible: true, x: num(p, 'dx', 2), y: num(p, 'dy', 2), blur: 2 * stdDev(p, 2), spread: 0,
        color: { r: c.r, g: c.g, b: c.b, a: c.a * (Number.isNaN(op) ? 1 : Math.max(0, Math.min(1, op))) },
      };
    });
    return { kind: 'effects', effects };
  }

  // --- Figma's chains. Signature: starts with <feFlood flood-opacity="0" result="BackgroundImageFix"/>
  const first = prims[0];
  const figma = tags[0] === 'feflood' && (attr(first, 'result') === 'BackgroundImageFix' || parseFloat(h.decls(first)['flood-opacity'] ?? '1') === 0);
  if (!figma) return { kind: 'unsupported', why: [...new Set(prims.map(p => String(p.localName || p.tagName)))].join(', ') };

  interface Pending { x: number; y: number; blur: number; spread: number; inner: boolean; color: Color | null }
  const effects: Effect[] = [];
  let pending: Pending | null = null;
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i], t = tags[i];
    const input = attr(p, 'in');
    switch (t) {
      case 'feflood': break;
      case 'fecolormatrix': {
        const v = numbers(attr(p, 'values'));
        if (input === 'SourceAlpha') pending = { x: 0, y: 0, blur: 0, spread: 0, inner: false, color: null };
        else if (pending && v.length === 20) pending.color = { r: v[4], g: v[9], b: v[14], a: Math.max(0, Math.min(1, v[18])) };
        else return { kind: 'unsupported', why: 'feColorMatrix' };
        break;
      }
      case 'femorphology': {
        if (!pending) return { kind: 'unsupported', why: 'feMorphology' };
        const r = numbers(attr(p, 'radius'))[0] ?? 0;
        pending.spread = attr(p, 'operator') === 'dilate' ? r : -r;
        break;
      }
      case 'feoffset':
        if (!pending) return { kind: 'unsupported', why: 'feOffset' };
        pending.x = num(p, 'dx', 0); pending.y = num(p, 'dy', 0);
        break;
      case 'fegaussianblur':
        if (pending) pending.blur = 2 * stdDev(p);
        else if (input && /^BackgroundImage/.test(input)) effects.push({ type: 'background-blur', visible: true, blur: 2 * stdDev(p) });
        else effects.push({ type: 'layer-blur', visible: true, blur: 2 * stdDev(p) });
        break;
      case 'fecomposite':
        if (pending && attr(p, 'operator') === 'arithmetic') pending.inner = true;
        break;
      case 'feblend': {
        if (pending && pending.color) {
          const inner = pending.inner || /innerShadow/i.test(attr(p, 'result') ?? '');
          effects.push({
            type: inner ? 'inner-shadow' : 'drop-shadow', visible: true, color: pending.color,
            x: pending.x, y: pending.y, blur: pending.blur, spread: pending.spread,
          });
          pending = null;
        }
        break;
      }
      default:
        return { kind: 'unsupported', why: String(p.localName || p.tagName) };
    }
  }
  if (!effects.length) return { kind: 'unsupported', why: 'no recognisable effect' };
  return { kind: 'effects', effects };
}
