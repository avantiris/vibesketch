// SVG -> document nodes. Used for hand-written SVGs, Figma / Inkscape / Illustrator exports and
// PDF import (the server converts pages with `pdftocairo -svg`).
//
// The importer never fetches anything and never throws on unknown content: unsupported things
// are skipped with a (deduplicated) warning. It only throws when there is no <svg> root.

import type {
  AssetMeta, BlendMode, Box, Color, FontRef, GradientStop, GroupNode, ImagePaint, Mat, Node, Paint, PathNode,
  ShapeNode, SubPath, TextNode, Vec,
} from '../core/model.ts';
import { BLACK, BLEND_MODES, groupDefaults, newId, shapeDefaults, solid } from '../core/model.ts';
import { apply, applyLin, boxContains, expandBox, mul, scaleXOf, scaleYOf, transformBox, translate, union } from '../core/geom.ts';
import { PathBuilder, nodeSubpaths, parsePathData, subpathsBounds, transformSubpaths } from '../core/path.ts';
import { parseColor } from './svg/color.ts';
import type { Rule } from './svg/css.ts';
import { matches, parseDeclarations, parseStylesheet } from './svg/css.ts';
import { parseFilter } from './svg/filter.ts';
import type { B } from './svg/normalize.ts';
import { normalizeTree } from './svg/normalize.ts';
import type { El } from './svg/parse.ts';
import {
  attr, elementKids, hrefId, numbers, parseFraction, parseLength, parsePar, parseTransform, parseViewBox, tagOf,
  urlRef, viewBoxTransform,
} from './svg/parse.ts';
import type { RasterInfo } from './svg/raster.ts';
import { assetKey, decodeDataUri, looksLikeSvg, sniffRaster } from './svg/raster.ts';

export interface ImportedAsset { bytes: Uint8Array; meta: AssetMeta }

export interface SvgImport {
  /** every created node, keyed by id; root nodes have parent '' (caller re-parents) */
  nodes: Record<string, Node>;
  /** top-level node ids, bottom-to-top */
  roots: string[];
  /** embedded raster images (data: URIs) extracted as assets */
  assets: Map<string, ImportedAsset>;
  /** document size in px (from width/height/viewBox) */
  width: number;
  height: number;
  warnings: string[];
  /** Text nodes whose SVG anchor is not `start`. They are emitted with `w: null` and the matching
   *  `align`, positioned as if the anchor point (the SVG x) were the LEFT edge of the box. Once
   *  fonts are loaded the caller must shift such a node left along its local x axis by the measured
   *  text width (`end`) or half of it (`middle`):  transform = transform * translate(-k * width, 0). */
  textAnchors: Record<string, 'middle' | 'end'>;
}

export interface SvgImportOptions {
  /** DOMParser implementation; defaults to globalThis.DOMParser (tests pass linkedom's) */
  DOMParser?: { new (): { parseFromString(s: string, type: string): any } };
  /** font metrics for placing <text>: ascent/descent in px for a font at `size`. Default: 0.8 / 0.2 * size */
  textMetrics?: (font: FontRef, size: number) => { ascent: number; descent: number };
}

// ---------------------------------------------------------------- style tables

type Style = Record<string, string>;

const INHERITED = [
  'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'clip-rule', 'color',
  'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'letter-spacing', 'visibility',
  'marker-start', 'marker-mid', 'marker-end', 'white-space',
];
const NOT_INHERITED = [
  'opacity', 'display', 'mix-blend-mode', 'filter', 'clip-path', 'mask', 'stop-color', 'stop-opacity',
  'flood-color', 'flood-opacity', 'mask-type',
];
const PRES_ATTRS = [...INHERITED, ...NOT_INHERITED];

const NON_RENDERED = new Set([
  'defs', 'style', 'title', 'desc', 'metadata', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'pattern',
  'filter', 'symbol', 'marker', 'script', 'font', 'font-face', 'cursor', 'view', 'animate', 'animatetransform',
  'animatemotion', 'set', 'color-profile', 'solidcolor', 'meshgradient', 'hatch',
]);
const SHAPES = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path']);
const RENDERED = new Set([...SHAPES, 'g', 'a', 'svg', 'use', 'switch', 'image', 'text']);

const DEFAULT_NAMES: Record<string, string> = {
  rect: 'Rectangle', circle: 'Ellipse', ellipse: 'Ellipse', line: 'Line', polyline: 'Polyline', polygon: 'Polygon',
  path: 'Path', image: 'Image', g: 'Group', a: 'Group', svg: 'Group', use: 'Group', switch: 'Group', text: 'Text',
};
// ids that editors generate automatically carry no information
const AUTO_ID = /^(path|rect|g|circle|ellipse|text|tspan|use|image|svg|line|polygon|polyline|flowroot|layer|glyph|source|surface|clip|mask|pattern)[-_]?\d+([-_]\d+)*$/i;

const MAX_NESTED_SVG_NODES = 5000;
const MAX_NESTED_SVG_DEPTH = 2;

interface PendingImage { token: string; bytes: Uint8Array<ArrayBuffer>; info: RasterInfo }
interface Shared {
  warnings: string[];
  seen: Set<string>;
  pending: PendingImage[];
  byHref: Map<string, PendingImage | null>;
}
interface Ctx {
  /** computed style of the parent */
  style: Style;
  vp: { w: number; h: number };
  /** <use> targets currently being expanded (cycle guard) */
  uses: El[];
  /** inside a <clipPath>: geometry only, opaque black, clip-rule */
  clip?: boolean;
  /** inside a <mask> */
  mask?: boolean;
}
interface NestedSvg { roots: B[]; width: number; height: number }

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const IDENT = (): Mat => [1, 0, 0, 1, 0, 0];

function decodeId(id: string): string {
  return id.replace(/_x([0-9A-Fa-f]{2,6})_/g, (m, h: string) => {
    const cp = parseInt(h, 16);
    try { return cp > 0 ? String.fromCodePoint(cp) : m; } catch { return m; }
  });
}

function opacityOf(v: string | undefined): number {
  if (v == null) return 1;
  const n = parseFloat(v);
  if (Number.isNaN(n)) return 1;
  return clamp01(v.trim().endsWith('%') ? n / 100 : n);
}

function fontSizeOf(v: string, parent: number): number {
  switch (v.trim().toLowerCase()) {
    case 'xx-small': return 9;
    case 'x-small': return 10;
    case 'small': return 13;
    case 'medium': return 16;
    case 'large': return 18;
    case 'x-large': return 24;
    case 'xx-large': return 32;
    case 'smaller': return parent / 1.2;
    case 'larger': return parent * 1.2;
  }
  const n = parseLength(v, parent, parent);
  return n != null && n >= 0 ? n : parent;
}

// ---------------------------------------------------------------- importer

class Importer {
  ids = new Map<string, El>();
  rules: Rule[] = [];
  declCache = new Map<El, Style>();
  docStyleCache = new Map<El, Style>();
  pathCache = new Map<El, SubPath[]>();
  imageCache = new Map<El, PendingImage | null>();
  nested = new Map<El, NestedSvg>();
  width = 0;
  height = 0;
  root: El;
  shared: Shared;
  opts: SvgImportOptions;

  constructor(root: El, opts: SvgImportOptions, shared: Shared) {
    this.root = root;
    this.opts = opts;
    this.shared = shared;
  }

  warn(msg: string): void {
    if (this.shared.seen.has(msg)) return;
    this.shared.seen.add(msg);
    this.shared.warnings.push(msg);
  }

  // ------------------------------------------------------------ setup

  index(el: El, depth = 0): void {
    const id = attr(el, 'id');
    if (id && !this.ids.has(id)) this.ids.set(id, el);
    if (tagOf(el) === 'style') {
      const type = attr(el, 'type');
      if (!type || /css/i.test(type)) {
        this.rules.push(...parseStylesheet(String(el.textContent ?? ''), m => this.warn(m), this.rules.length));
      }
      return;
    }
    if (depth > 2000) return;
    for (const k of elementKids(el)) this.index(k, depth + 1);
  }

  collectSvgImages(el: El, out: El[]): void {
    if (tagOf(el) === 'image') out.push(el);
    for (const k of elementKids(el)) this.collectSvgImages(k, out);
  }

  // ------------------------------------------------------------ styles

  /** the element's own declarations: presentation attributes < CSS rules < inline style */
  ownDecls(el: El): Style {
    let d = this.declCache.get(el);
    if (d) return d;
    d = {};
    for (const p of PRES_ATTRS) {
      const v = attr(el, p);
      if (v != null && v.trim() !== '') d[p] = v.trim();
    }
    const important: [string, string][] = [];
    if (this.rules.length) {
      const tag = tagOf(el), id = attr(el, 'id');
      const classes = (attr(el, 'class') ?? '').split(/\s+/).filter(Boolean);
      const hit = this.rules.filter(r => matches(r.sel, tag, id, classes)).sort((a, b) => a.spec - b.spec || a.order - b.order);
      for (const r of hit) for (const dc of r.decls) (dc.important ? important.push([dc.prop, dc.value]) : (d[dc.prop] = dc.value));
    }
    const inlineImportant: [string, string][] = [];
    for (const dc of parseDeclarations(attr(el, 'style'))) {
      if (dc.important) inlineImportant.push([dc.prop, dc.value]);
      else d[dc.prop] = dc.value;
    }
    for (const [k, v] of important) d[k] = v;
    for (const [k, v] of inlineImportant) d[k] = v;
    this.declCache.set(el, d);
    return d;
  }

  computeStyle(el: El, parent: Style): Style {
    const own = this.ownDecls(el);
    const st: Style = {};
    for (const k of INHERITED) if (parent[k] !== undefined) st[k] = parent[k];
    for (const k in own) {
      const v = own[k];
      const lv = v.toLowerCase();
      if (lv === 'inherit') {
        if (parent[k] !== undefined) st[k] = parent[k]; else delete st[k];
      } else if (lv === 'initial' || lv === 'unset' || lv === 'revert') {
        if (lv === 'initial' || !INHERITED.includes(k)) delete st[k];
      } else if (k === 'font-size') {
        st[k] = String(fontSizeOf(v, parseFloat(parent['font-size'] ?? '16')));
      } else st[k] = v;
    }
    return st;
  }

  /** computed style of an element in its document position (for clipPath / mask / pattern content) */
  docStyle(el: El): Style {
    let st = this.docStyleCache.get(el);
    if (st) return st;
    const p = el.parentNode;
    st = this.computeStyle(el, p && p.nodeType === 1 ? this.docStyle(p) : {});
    this.docStyleCache.set(el, st);
    return st;
  }

  fontSize(st: Style): number { return parseFloat(st['font-size'] ?? '16') || 16; }

  len(v: string | null | undefined, st: Style, ctx: Ctx, axis: 'x' | 'y' | 'o', def = 0): number {
    const ref = axis === 'x' ? ctx.vp.w : axis === 'y' ? ctx.vp.h : Math.hypot(ctx.vp.w, ctx.vp.h) / Math.SQRT2;
    const n = parseLength(v, this.fontSize(st), ref);
    return n == null || !Number.isFinite(n) ? def : n;
  }

  currentColor(st: Style): Color {
    const c = st.color && st.color.toLowerCase() !== 'currentcolor' ? parseColor(st.color) : null;
    return c ?? { ...BLACK };
  }

  transformOf(el: El, st: Style): Mat {
    const a = attr(el, 'transform');
    if (a != null) return parseTransform(a);
    const css = this.ownDecls(el).transform;
    void st;
    return css && css !== 'none' ? parseTransform(css) : IDENT();
  }

  nameOf(el: El): string | null {
    let n: string | null | undefined = attr(el, 'inkscape:label') ?? attr(el, 'data-name');
    if (!n || !n.trim()) {
      const t = elementKids(el).find(k => tagOf(k) === 'title');
      if (t && tagOf(el) !== 'svg') n = String(t.textContent ?? '');
    }
    if (!n || !n.trim()) {
      const id = attr(el, 'id');
      if (id && !AUTO_ID.test(id)) n = decodeId(id);
    }
    n = n?.replace(/\s+/g, ' ').trim();
    return n || null;
  }

  // ------------------------------------------------------------ node factories

  group(name: string, named: boolean, kids: B[]): B {
    const node: GroupNode = { ...groupDefaults(), id: newId(), name, parent: '' };
    return { node, kids, named };
  }

  leafFor(el: El | null, tag: string, node: ShapeNode): B {
    const name = el ? this.nameOf(el) : null;
    if (name) node.name = name;
    else if (!node.name) node.name = DEFAULT_NAMES[tag] ?? 'Shape';
    return { node, kids: null, named: !!name };
  }

  // ------------------------------------------------------------ walking

  convert(el: El, ctx: Ctx): B[] {
    const tag = tagOf(el);
    if (tag.includes(':') || NON_RENDERED.has(tag)) return [];
    if (!RENDERED.has(tag)) {
      this.warn(`Unsupported element <${String(el.localName || el.tagName)}> skipped`);
      return [];
    }
    const st = this.computeStyle(el, ctx.style);
    if ((st.display ?? '').toLowerCase() === 'none') return [];
    try {
      return this.build(el, tag, st, ctx);
    } catch (e) {
      this.warn(`Failed to import <${tag}>: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  build(el: El, tag: string, st: Style, ctx: Ctx): B[] {
    const T = this.transformOf(el, st);
    const cctx: Ctx = { ...ctx, style: st };
    let inner: B | null = null;
    if (SHAPES.has(tag)) inner = this.shape(el, tag, st, ctx);
    else if (tag === 'image') inner = this.image(el, st, ctx);
    else if (tag === 'text') inner = this.text(el, st, ctx);
    else if (tag === 'g' || tag === 'a') {
      inner = this.group(this.nameOf(el) ?? 'Group', !!this.nameOf(el), this.containerKids(el, cctx));
    } else if (tag === 'switch') {
      const pick = elementKids(el).find(k => {
        const t = tagOf(k);
        return RENDERED.has(t) && !attr(k, 'requiredExtensions') && (this.ownDecls(k).display ?? '') !== 'none';
      });
      inner = this.group(this.nameOf(el) ?? 'Group', !!this.nameOf(el), pick ? this.convert(pick, cctx) : []);
    } else if (tag === 'svg') inner = this.svgContainer(el, st, ctx, null, null);
    else if (tag === 'use') inner = this.use(el, st, ctx);
    if (!inner) return [];
    return this.decorate(inner, el, st, T, ctx);
  }

  /** filter, clip-path, mask, opacity, blend and the element transform */
  decorate(inner: B, el: El, st: Style, T: Mat, ctx: Ctx): B[] {
    if (ctx.clip) {
      // children of a <clipPath> contribute geometry only
      inner.node.transform = mul(T, inner.node.transform);
      return [inner];
    }
    const fref = st.filter && st.filter.toLowerCase() !== 'none' ? st.filter : null;
    if (fref) {
      const ref = urlRef(fref);
      const fel = ref ? this.ids.get(ref.id) : null;
      if (!fel || tagOf(fel) !== 'filter') this.warn(`Unsupported filter "${fref.slice(0, 60)}" ignored`);
      else {
        const res = parseFilter(fel, {
          decls: e => this.ownDecls(e),
          color: v => parseColor(v, this.currentColor(st)),
        });
        if (res.kind === 'effects') inner.node.effects.push(...res.effects.map(e => ({ ...e })));
        // the colour-matrix wrappers cairo puts around mask content only select which channel masks
        else if (res.kind === 'alpha' && ctx.mask) inner.white = true;
        else if (res.kind === 'luminance-to-alpha' && ctx.mask) inner.lumAlpha = true;
        else if (res.kind !== 'unsupported') this.warn(`Unsupported filter #${ref!.id} ignored (feColorMatrix)`);
        else this.warn(`Unsupported filter #${ref!.id} ignored (${res.why})`);
      }
    }
    let cur: B | null = inner;
    for (const prop of ['clip-path', 'mask'] as const) {
      const v = st[prop];
      if (!v || v.toLowerCase() === 'none' || !cur) continue;
      const ref = urlRef(v);
      const target = ref ? this.ids.get(ref.id) : null;
      const want = prop === 'clip-path' ? 'clippath' : 'mask';
      if (!target || tagOf(target) !== want) {
        this.warn(ref ? `${prop} reference #${ref.id} not found, ignored` : `Unsupported ${prop} "${v.slice(0, 60)}" ignored`);
        continue;
      }
      cur = this.applyClip(cur, target, ctx, prop === 'mask');
    }
    if (!cur) return [];
    const n = cur.node;
    n.transform = mul(T, n.transform);
    n.opacity *= opacityOf(st.opacity);
    const blend = (st['mix-blend-mode'] ?? 'normal').toLowerCase() as BlendMode;
    if (blend !== 'normal') {
      if (BLEND_MODES.includes(blend)) n.blend = blend;
      else this.warn(`Unsupported mix-blend-mode "${blend}" ignored`);
    }
    void el;
    return [cur];
  }

  containerKids(el: El, cctx: Ctx): B[] {
    const out: B[] = [];
    const els = elementKids(el);
    let i = 0;
    while (i < els.length) {
      if (tagOf(els[i]) === 'use') {
        const run = this.glyphRun(els, i, cctx);
        if (run) {
          if (run.b) out.push(run.b);
          i = run.next;
          continue;
        }
      }
      out.push(...this.convert(els[i], cctx));
      i++;
    }
    return out;
  }

  // ------------------------------------------------------------ containers

  rootSize(el: El): { w: number; h: number } {
    const vb = parseViewBox(attr(el, 'viewBox'));
    const dim = (name: string, vbDim: number | undefined, def: number): number => {
      const v = attr(el, name);
      if (v != null && !v.trim().endsWith('%')) {
        const n = parseLength(v, 16, 0);
        if (n != null && n > 0) return n;
      }
      return vbDim ?? def;
    };
    let w = dim('width', undefined, NaN), h = dim('height', undefined, NaN);
    // one dimension missing: keep the viewBox aspect ratio
    if (vb) {
      if (Number.isNaN(w) && Number.isNaN(h)) { w = vb.w; h = vb.h; }
      else if (Number.isNaN(w)) w = (h * vb.w) / vb.h;
      else if (Number.isNaN(h)) h = (w * vb.h) / vb.w;
    }
    return { w: Number.isNaN(w) ? 300 : w, h: Number.isNaN(h) ? 150 : h };
  }

  svgContainer(el: El, st: Style, ctx: Ctx, wOverride: string | null, hOverride: string | null): B {
    const vb = parseViewBox(attr(el, 'viewBox'));
    let x = 0, y = 0, w: number, h: number;
    if (el === this.root) {
      ({ w, h } = this.rootSize(el));
      this.width = w; this.height = h;
    } else {
      x = this.len(attr(el, 'x'), st, ctx, 'x');
      y = this.len(attr(el, 'y'), st, ctx, 'y');
      w = this.len(wOverride ?? attr(el, 'width') ?? '100%', st, ctx, 'x', ctx.vp.w);
      h = this.len(hOverride ?? attr(el, 'height') ?? '100%', st, ctx, 'y', ctx.vp.h);
    }
    const m = vb ? viewBoxTransform(vb, parsePar(attr(el, 'preserveAspectRatio')), x, y, w, h) : translate(x, y);
    const vp = vb ? { w: vb.w, h: vb.h } : { w, h };
    const name = el === this.root ? null : this.nameOf(el);
    const g = this.group(name ?? 'Group', !!name, this.containerKids(el, { ...ctx, style: st, vp }));
    g.node.transform = m;
    return g;
  }

  use(el: El, st: Style, ctx: Ctx): B | null {
    const id = hrefId(el);
    const target = id ? this.ids.get(id) : null;
    if (!target) {
      this.warn(id ? `<use> references missing element #${id}` : '<use> with an external or missing href skipped');
      return null;
    }
    if (ctx.uses.includes(target) || ctx.uses.length > 64) {
      this.warn(`Circular <use> reference to #${id} skipped`);
      return null;
    }
    const cctx: Ctx = { ...ctx, style: st, uses: [...ctx.uses, target] };
    const x = this.len(attr(el, 'x'), st, ctx, 'x'), y = this.len(attr(el, 'y'), st, ctx, 'y');
    const ttag = tagOf(target);
    let kids: B[];
    if (ttag === 'symbol') {
      const sst = this.computeStyle(target, st);
      const vb = parseViewBox(attr(target, 'viewBox'));
      const sctx: Ctx = { ...cctx, style: sst };
      if (vb) {
        const w = this.len(attr(el, 'width') ?? attr(target, 'width') ?? '100%', st, ctx, 'x', ctx.vp.w);
        const h = this.len(attr(el, 'height') ?? attr(target, 'height') ?? '100%', st, ctx, 'y', ctx.vp.h);
        const g = this.group('Group', false, this.containerKids(target, { ...sctx, vp: { w: vb.w, h: vb.h } }));
        g.node.transform = viewBoxTransform(vb, parsePar(attr(target, 'preserveAspectRatio')), 0, 0, w, h);
        kids = [g];
      } else kids = this.containerKids(target, sctx);
    } else if (ttag === 'svg') {
      const sst = this.computeStyle(target, st);
      if ((sst.display ?? '') === 'none') return null;
      kids = this.decorate(this.svgContainer(target, sst, cctx, attr(el, 'width'), attr(el, 'height')), target, sst, this.transformOf(target, sst), cctx);
    } else kids = this.convert(target, cctx);
    const name = this.nameOf(el);
    // the instance name is more specific than the name of the shared definition
    if (name && kids.length === 1) { kids[0].node.name = name; kids[0].named = true; }
    const g = this.group(name ?? 'Group', !!name, kids);
    g.node.transform = translate(x, y);
    return g;
  }

  // ------------------------------------------------------------ glyph runs

  pathData(el: El): SubPath[] {
    let sps = this.pathCache.get(el);
    if (!sps) {
      sps = parsePathData(attr(el, 'd') ?? '');
      this.pathCache.set(el, sps);
    }
    return sps;
  }

  private plain(st: Style): boolean {
    const none = (v: string | undefined): boolean => v == null || v.toLowerCase() === 'none';
    return none(st.filter) && none(st['clip-path']) && none(st.mask) && (st.display ?? '') !== 'none'
      && (st['mix-blend-mode'] ?? 'normal') === 'normal';
  }

  /** a <use> that just places path outlines: returns the outlines + the paint they share */
  glyphInfo(el: El, cctx: Ctx): { key: string | null; style: Style | null; pieces: { sps: SubPath[]; m: Mat }[] } | null {
    if (tagOf(el) !== 'use') return null;
    const id = hrefId(el);
    const target = id ? this.ids.get(id) : null;
    if (!target) return null;
    const ttag = tagOf(target);
    if (ttag !== 'path' && ttag !== 'symbol' && ttag !== 'g') return null;
    const st = this.computeStyle(el, cctx.style);
    if (!this.plain(st)) return null;
    const useM = mul(this.transformOf(el, st), translate(this.len(attr(el, 'x'), st, cctx, 'x'), this.len(attr(el, 'y'), st, cctx, 'y')));
    let leaves: El[], baseStyle = st, baseM = useM;
    if (ttag === 'path') leaves = [target];
    else {
      if (ttag === 'symbol' && attr(target, 'viewBox')) return null;
      leaves = elementKids(target).filter(k => !['title', 'desc'].includes(tagOf(k)));
      if (leaves.some(k => tagOf(k) !== 'path')) return null;
      baseStyle = this.computeStyle(target, st);
      if (!this.plain(baseStyle) || opacityOf(baseStyle.opacity) !== 1) return null;
      if (ttag === 'g') baseM = mul(useM, this.transformOf(target, baseStyle));
    }
    let key: string | null = null, style: Style | null = null;
    const pieces: { sps: SubPath[]; m: Mat }[] = [];
    for (const leaf of leaves) {
      const pst = this.computeStyle(leaf, baseStyle);
      if (!this.plain(pst) || opacityOf(pst.opacity) !== 1) return null;
      const fill = pst.fill ?? 'black', stroke = pst.stroke ?? 'none';
      if (/url\(/i.test(fill) || /url\(/i.test(stroke)) return null;
      if (fill === 'none' && stroke === 'none' && !cctx.clip) return null;
      const m = mul(baseM, this.transformOf(leaf, pst));
      // a stroke would be scaled by the transform: only allow pure translations then
      if (stroke !== 'none' && (Math.abs(m[0] - 1) > 1e-9 || Math.abs(m[3] - 1) > 1e-9 || Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9)) return null;
      const k = JSON.stringify([
        fill, pst['fill-opacity'] ?? '', pst['fill-rule'] ?? '', stroke, pst['stroke-width'] ?? '', pst['stroke-opacity'] ?? '',
        pst['stroke-linecap'] ?? '', pst['stroke-linejoin'] ?? '', pst['stroke-dasharray'] ?? '', pst['clip-rule'] ?? '',
        pst.color ?? '', pst.visibility ?? '', pst['font-size'] ?? '', st.opacity ?? '',
      ]);
      if (key !== null && key !== k) return null;
      key = k; style = pst;
      const sps = this.pathData(leaf);
      if (sps.length) pieces.push({ sps, m });
    }
    return { key, style, pieces };
  }

  /** merge a run of >= 2 consecutive glyph-like <use> siblings with identical paint into one path */
  glyphRun(els: El[], start: number, cctx: Ctx): { b: B | null; next: number } | null {
    let key: string | null = null, style: Style | null = null, useOpacity = 1;
    const subpaths: SubPath[] = [];
    let j = start;
    for (; j < els.length; j++) {
      const g = this.glyphInfo(els[j], cctx);
      if (!g) break;
      if (g.key !== null) {
        if (key === null) {
          key = g.key; style = g.style;
          useOpacity = opacityOf(this.computeStyle(els[j], cctx.style).opacity);
        } else if (key !== g.key) break;
      }
      for (const p of g.pieces) subpaths.push(...transformSubpaths(p.sps, p.m));
    }
    if (j - start < 2) return null;
    if (!style || !subpaths.length) return { b: null, next: j };
    const node: PathNode = { ...shapeDefaults(), id: newId(), name: 'Text', parent: '', type: 'path', subpaths, fillRule: 'nonzero' };
    if (!this.paintShape(node, style, cctx, subpathsBounds(subpaths))) return { b: null, next: j };
    node.opacity = useOpacity;
    return { b: { node, kids: null, named: false }, next: j };
  }

  // ------------------------------------------------------------ shapes

  shape(el: El, tag: string, st: Style, ctx: Ctx): B | null {
    const L = (name: string, axis: 'x' | 'y' | 'o'): number => this.len(attr(el, name), st, ctx, axis);
    const base = { ...shapeDefaults(), id: newId(), name: '', parent: '' };
    let node: ShapeNode;
    let bbox: Box | null;
    const pathNode = (subpaths: SubPath[]): PathNode => ({ ...base, type: 'path', subpaths, fillRule: 'nonzero' });
    switch (tag) {
      case 'rect': {
        const x = L('x', 'x'), y = L('y', 'y'), w = L('width', 'x'), h = L('height', 'y');
        if (!(w > 0 && h > 0)) return null;
        const opt = (name: string, axis: 'x' | 'y'): number | null => {
          const v = attr(el, name);
          if (v == null || v.trim() === 'auto') return null;
          const n = parseLength(v, this.fontSize(st), axis === 'x' ? ctx.vp.w : ctx.vp.h);
          return n == null || n < 0 ? null : n;
        };
        let rx = opt('rx', 'x'), ry = opt('ry', 'y');
        if (rx == null && ry == null) rx = ry = 0;
        else if (rx == null) rx = ry;
        else if (ry == null) ry = rx;
        let rxn = Math.min(rx!, w / 2), ryn = Math.min(ry!, h / 2);
        if (rxn === 0 || ryn === 0) rxn = ryn = 0;
        if (Math.abs(rxn - ryn) < 1e-9) {
          node = { ...base, type: 'rect', w, h, radii: [rxn, rxn, rxn, rxn], transform: translate(x, y) };
          bbox = { x, y, w, h }; // in user space: userSpaceOnUse paint servers refer to it
        } else {
          const b = new PathBuilder();
          b.moveTo(x + rxn, y).lineTo(x + w - rxn, y).arcTo(rxn, ryn, 0, false, true, x + w, y + ryn)
            .lineTo(x + w, y + h - ryn).arcTo(rxn, ryn, 0, false, true, x + w - rxn, y + h)
            .lineTo(x + rxn, y + h).arcTo(rxn, ryn, 0, false, true, x, y + h - ryn)
            .lineTo(x, y + ryn).arcTo(rxn, ryn, 0, false, true, x + rxn, y).close();
          node = pathNode(b.done());
          bbox = { x, y, w, h };
        }
        break;
      }
      case 'circle': case 'ellipse': {
        const cx = L('cx', 'x'), cy = L('cy', 'y');
        let rx: number, ry: number;
        if (tag === 'circle') rx = ry = L('r', 'o');
        else {
          const hasRx = attr(el, 'rx') != null && attr(el, 'rx') !== 'auto', hasRy = attr(el, 'ry') != null && attr(el, 'ry') !== 'auto';
          rx = hasRx ? L('rx', 'x') : L('ry', 'y');
          ry = hasRy ? L('ry', 'y') : rx;
        }
        if (!(rx > 0 && ry > 0)) return null;
        node = { ...base, type: 'ellipse', w: 2 * rx, h: 2 * ry, transform: translate(cx - rx, cy - ry) };
        bbox = { x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry };
        break;
      }
      case 'line': {
        const b = new PathBuilder();
        b.moveTo(L('x1', 'x'), L('y1', 'y')).lineTo(L('x2', 'x'), L('y2', 'y'));
        node = pathNode(b.done());
        bbox = subpathsBounds(node.subpaths);
        break;
      }
      case 'polyline': case 'polygon': {
        const n = numbers(attr(el, 'points'));
        if (n.length < 4) return null;
        const b = new PathBuilder();
        b.moveTo(n[0], n[1]);
        for (let i = 2; i + 1 < n.length; i += 2) b.lineTo(n[i], n[i + 1]);
        if (tag === 'polygon') b.close();
        node = pathNode(b.done());
        bbox = subpathsBounds(node.subpaths);
        break;
      }
      default: {
        // parsePathData results are cached and shared: copy before use
        node = pathNode(transformSubpaths(this.pathData(el), IDENT()));
        bbox = subpathsBounds(node.subpaths);
      }
    }
    if (node.type === 'path' && !node.subpaths.length) return null;
    if (!this.paintShape(node, st, ctx, bbox, tag === 'line')) return null;
    for (const mk of ['marker-start', 'marker-mid', 'marker-end']) {
      if (st[mk] && st[mk].toLowerCase() !== 'none' && tag !== 'rect' && tag !== 'circle' && tag !== 'ellipse') {
        this.warn('Markers (marker-start/mid/end) are not supported and were dropped');
      }
    }
    return this.leafFor(el, tag, node);
  }

  /** fills / strokes / stroke props from the computed style. false => nothing visible */
  paintShape(node: ShapeNode, st: Style, ctx: Ctx, bbox: Box | null, noFill = false): boolean {
    if (ctx.clip) {
      node.fills = [solid({ ...BLACK })];
      node.strokes = [];
      if (node.type === 'path') node.fillRule = (st['clip-rule'] ?? '').toLowerCase() === 'evenodd' ? 'evenodd' : 'nonzero';
      return true;
    }
    if (node.type === 'path') node.fillRule = (st['fill-rule'] ?? '').toLowerCase() === 'evenodd' ? 'evenodd' : 'nonzero';
    const fill = noFill ? null : this.paint(st.fill ?? 'black', opacityOf(st['fill-opacity']), st, bbox);
    node.fills = fill ? [fill] : [];
    const sw = this.len(st['stroke-width'] ?? '1', st, ctx, 'o', 1);
    const stroke = sw > 0 ? this.paint(st.stroke ?? 'none', opacityOf(st['stroke-opacity']), st, bbox) : null;
    node.strokes = stroke ? [stroke] : [];
    if (stroke) node.strokeWeight = sw;
    node.strokeAlign = 'center';
    const cap = (st['stroke-linecap'] ?? 'butt').toLowerCase();
    node.strokeCap = cap === 'round' || cap === 'square' ? cap : 'butt';
    const join = (st['stroke-linejoin'] ?? 'miter').toLowerCase();
    node.strokeJoin = join === 'round' || join === 'bevel' ? join : 'miter';
    const da = st['stroke-dasharray'];
    if (da && da.toLowerCase() !== 'none') {
      const ds = da.split(/[\s,]+/).filter(Boolean).map(d => this.len(d, st, ctx, 'o', NaN));
      if (ds.length && ds.every(d => d >= 0) && ds.some(d => d > 0)) node.dash = ds.length % 2 ? [...ds, ...ds] : ds;
    }
    const vis = (st.visibility ?? 'visible').toLowerCase();
    if (vis === 'hidden' || vis === 'collapse') node.visible = false;
    return node.fills.length > 0 || node.strokes.length > 0;
  }

  // ------------------------------------------------------------ paints

  paint(value: string, opacity: number, st: Style, bbox: Box | null, depth = 0): Paint | null {
    const v = value.trim();
    if (!v || v.toLowerCase() === 'none' || opacity <= 0 || depth > 4) return null;
    const ref = urlRef(v);
    if (ref) {
      const server = this.ids.get(ref.id);
      let p: Paint | null | undefined;
      if (server) p = this.paintServer(server, ref.id, opacity, st, bbox);
      else this.warn(`Paint server #${ref.id} not found`);
      if (p !== undefined) return p;
      return ref.rest ? this.paint(ref.rest, opacity, st, bbox, depth + 1) : null;
    }
    const c = parseColor(v, this.currentColor(st));
    if (!c) {
      this.warn(`Unrecognised paint "${v.slice(0, 40)}" treated as none`);
      return null;
    }
    if (c.a <= 0) return null;
    return solid(c, opacity);
  }

  /** undefined = unsupported (caller uses the fallback colour), null = paints nothing */
  paintServer(el: El, id: string, opacity: number, st: Style, bbox: Box | null): Paint | null | undefined {
    const tag = tagOf(el);
    if (tag === 'lineargradient' || tag === 'radialgradient') return this.gradient(el, tag === 'radialgradient', opacity, st, bbox);
    if (tag === 'pattern') return this.pattern(el, id, opacity, st, bbox);
    this.warn(`Unsupported paint server <${tag}> #${id} skipped`);
    return undefined;
  }

  private hrefChain(el: El): El[] {
    const chain: El[] = [el];
    for (let cur = el; chain.length < 16; ) {
      const id = hrefId(cur);
      const next = id ? this.ids.get(id) : null;
      if (!next || chain.includes(next)) break;
      chain.push(next);
      cur = next;
    }
    return chain;
  }

  gradient(el: El, radial: boolean, opacity: number, st: Style, bbox: Box | null): Paint | null {
    const chain = this.hrefChain(el).filter(e => /gradient$/.test(tagOf(e)));
    const A = (name: string): string | null => {
      for (const e of chain) { const v = attr(e, name); if (v != null) return v; }
      return null;
    };
    const stopEls = chain.map(e => elementKids(e).filter(k => tagOf(k) === 'stop')).find(s => s.length) ?? [];
    const cur = this.currentColor(st);
    const stops: GradientStop[] = [];
    let last = 0;
    for (const s of stopEls) {
      const d = this.ownDecls(s);
      const c = parseColor(d['stop-color'] ?? 'black', cur) ?? { ...BLACK };
      const offset = Math.max(last, clamp01(parseFraction(attr(s, 'offset') ?? d.offset, 0)));
      last = offset;
      stops.push({ offset, color: { r: c.r, g: c.g, b: c.b, a: c.a * opacityOf(d['stop-opacity']) } });
    }
    if (!stops.length) return null;
    const flat = (): Paint | null => {
      const c = stops[stops.length - 1].color;
      return c.a > 0 ? solid({ ...c }, opacity) : null;
    };
    if (stops.length === 1) return flat();
    const spread = A('spreadMethod');
    if (spread && spread !== 'pad') this.warn(`Gradient spreadMethod="${spread}" is not supported (rendered as pad)`);

    const user = A('gradientUnits') === 'userSpaceOnUse';
    const G = parseTransform(A('gradientTransform'));
    // P: gradient space -> the shape's local pixel space; the model stores points normalised to the box
    let box = bbox;
    if (!box) {
      if (user) {
        this.warn('userSpaceOnUse gradient on text cannot be placed exactly; approximated as a left-to-right gradient');
        return { type: 'gradient', kind: radial ? 'radial' : 'linear', stops, from: radial ? { x: 0.5, y: 0.5 } : { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 }, width: 1, visible: true, opacity };
      }
      box = { x: 0, y: 0, w: 1, h: 1 };
    } else if (!user && (box.w <= 0 || box.h <= 0)) return null; // objectBoundingBox on a degenerate box paints nothing
    const bw = box.w || 1, bh = box.h || 1;
    const P = user ? G : mul([bw, 0, 0, bh, box.x, box.y], G);
    const toBox = (p: Vec): Vec => ({ x: (p.x - box.x) / bw, y: (p.y - box.y) / bh });
    const fs = this.fontSize(st);
    const coord = (name: string, def: string, axis: 'x' | 'y' | 'o'): number => {
      const v = A(name) ?? def;
      if (!user) return parseFraction(v, parseFraction(def, 0));
      const vp = this.vpForUnits;
      const ref = axis === 'x' ? vp.w : axis === 'y' ? vp.h : Math.hypot(vp.w, vp.h) / Math.SQRT2;
      return parseLength(v, fs, ref) ?? 0;
    };
    if (!radial) {
      const p1 = { x: coord('x1', '0%', 'x'), y: coord('y1', '0%', 'y') }, p2 = { x: coord('x2', '100%', 'x'), y: coord('y2', '0%', 'y') };
      const dv = { x: p2.x - p1.x, y: p2.y - p1.y };
      if (Math.hypot(dv.x, dv.y) < 1e-12) return flat();
      const from = apply(P, p1);
      let v = applyLin(P, dv);
      // colour-stop lines are the images of the gradient normals; the renderer draws them perpendicular
      // to from->to in pixel space, so keep only the component of v perpendicular to them (exact for any affine P)
      const d = applyLin(P, { x: -dv.y, y: dv.x });
      const dd = d.x * d.x + d.y * d.y;
      if (dd > 1e-18) {
        const k = (v.x * d.x + v.y * d.y) / dd;
        v = { x: v.x - k * d.x, y: v.y - k * d.y };
      }
      if (Math.hypot(v.x, v.y) < 1e-12) return flat();
      return { type: 'gradient', kind: 'linear', stops, from: toBox(from), to: toBox({ x: from.x + v.x, y: from.y + v.y }), width: 1, visible: true, opacity };
    }
    const c = { x: coord('cx', '50%', 'x'), y: coord('cy', '50%', 'y') };
    const r = coord('r', '50%', 'o');
    if (!(r > 0)) return flat();
    const from = apply(P, c);
    const u = applyLin(P, { x: r, y: 0 }), w = applyLin(P, { x: 0, y: r });
    const lu = Math.hypot(u.x, u.y), lw = Math.hypot(w.x, w.y);
    if (lu < 1e-12 || lw < 1e-12) return flat();
    let axis = u, width = lw / lu;
    if (Math.abs(u.x * w.x + u.y * w.y) > 1e-9 * lu * lw) {
      // skewed: principal axes of the ellipse via the SVD of [u w]
      const e = u.x * u.x + w.x * w.x, f = u.x * u.y + w.x * w.y, g = u.y * u.y + w.y * w.y;
      const s2 = Math.sqrt((e - g) * (e - g) + 4 * f * f);
      const s1 = Math.sqrt((e + g + s2) / 2), sMin = Math.sqrt(Math.max(0, (e + g - s2) / 2));
      const th = 0.5 * Math.atan2(2 * f, e - g);
      axis = { x: s1 * Math.cos(th), y: s1 * Math.sin(th) };
      width = sMin / s1;
    }
    return { type: 'gradient', kind: 'radial', stops, from: toBox(from), to: toBox({ x: from.x + axis.x, y: from.y + axis.y }), width, visible: true, opacity };
  }

  /** viewport used to resolve percentages in userSpaceOnUse paint servers */
  vpForUnits: { w: number; h: number } = { w: 0, h: 0 };

  pattern(el: El, id: string, opacity: number, st: Style, bbox: Box | null): Paint | null | undefined {
    const chain = this.hrefChain(el).filter(e => tagOf(e) === 'pattern');
    const A = (name: string): string | null => {
      for (const e of chain) { const v = attr(e, name); if (v != null) return v; }
      return null;
    };
    const content = chain.map(e => elementKids(e).filter(k => !['title', 'desc', 'metadata'].includes(tagOf(k)))).find(k => k.length) ?? [];
    let img: El | null = null, scale = 1;
    if (content.length === 1) {
      let c = content[0];
      if (tagOf(c) === 'use') {
        const tid = hrefId(c);
        const t = tid ? this.ids.get(tid) : null;
        if (t && tagOf(t) === 'image') { scale *= scaleXOf(this.transformOf(c, {})); c = t; }
      }
      if (tagOf(c) === 'image') img = c;
    }
    if (!img) {
      this.warn(`Unsupported <pattern> #${id} skipped (only patterns containing a single <image> are supported)`);
      return undefined;
    }
    const reg = this.registerImage(img);
    if (!reg) return null;
    const user = A('patternUnits') === 'userSpaceOnUse';
    const pw = parseFraction(A('width'), 0), ph = parseFraction(A('height'), 0);
    const paint: ImagePaint = { type: 'image', asset: reg.token, mode: 'fill', visible: true, opacity };
    if (!user && Math.abs(pw - 1) < 1e-6 && Math.abs(ph - 1) < 1e-6) return paint; // one tile covers the box (Figma image fills)
    const imgW = parseLength(attr(img, 'width'), 16, 0) ?? reg.info.w;
    scale *= scaleXOf(parseTransform(A('patternTransform')));
    if (A('patternContentUnits') === 'objectBoundingBox') scale *= bbox?.w ?? 1;
    paint.mode = 'tile';
    paint.scale = reg.info.w > 0 ? (imgW * scale) / reg.info.w : 1;
    return paint;
  }

  // ------------------------------------------------------------ images

  registerImage(el: El): PendingImage | null {
    if (this.imageCache.has(el)) return this.imageCache.get(el)!;
    const href = (attr(el, 'href') ?? attr(el, 'xlink:href') ?? '').trim();
    let res: PendingImage | null = null;
    if (!href) this.warn('<image> without href skipped');
    else if (!/^data:/i.test(href)) this.warn(`External image not imported (nothing is ever fetched): ${href.length > 80 ? href.slice(0, 77) + '...' : href}`);
    else if (this.shared.byHref.has(href)) res = this.shared.byHref.get(href)!;
    else {
      const data = decodeDataUri(href);
      const info = data ? sniffRaster(data.bytes) : null;
      if (!data) this.warn('Undecodable data: URI in <image> skipped');
      else if (!info) this.warn(`Unsupported embedded image format (${data.mime}) skipped`);
      else {
        res = { token: `pending:${this.shared.pending.length}`, bytes: data.bytes, info };
        this.shared.pending.push(res);
      }
      this.shared.byHref.set(href, res);
    }
    this.imageCache.set(el, res);
    return res;
  }

  image(el: El, st: Style, ctx: Ctx): B | null {
    const x = this.len(attr(el, 'x'), st, ctx, 'x'), y = this.len(attr(el, 'y'), st, ctx, 'y');
    const dim = (name: string, axis: 'x' | 'y'): number | null => {
      const v = attr(el, name);
      if (v == null || v.trim() === 'auto') return null;
      const n = parseLength(v, this.fontSize(st), axis === 'x' ? ctx.vp.w : ctx.vp.h);
      return n != null && n >= 0 ? n : null;
    };
    let w = dim('width', 'x'), h = dim('height', 'y');
    const size = (nw: number, nh: number): boolean => {
      if (w == null && h == null) { w = nw; h = nh; }
      else if (w == null) w = nh > 0 ? (h! * nw) / nh : nw;
      else if (h == null) h = nw > 0 ? (w * nh) / nw : nh;
      return w! > 0 && h! > 0;
    };
    const par = parsePar(attr(el, 'preserveAspectRatio'));
    const nested = this.nested.get(el);
    if (nested) {
      if (!size(nested.width, nested.height)) return null;
      const g = this.group(this.nameOf(el) ?? 'Image', !!this.nameOf(el), nested.roots);
      this.nested.delete(el); // the subtree can only be placed once
      g.node.transform = viewBoxTransform({ x: 0, y: 0, w: nested.width, h: nested.height }, par, x, y, w!, h!);
      return g;
    }
    if (this.skippedSvgImages.has(el)) return null;
    const reg = this.registerImage(el);
    if (!reg || !size(reg.info.w, reg.info.h)) return null;
    const paint: ImagePaint = {
      type: 'image', asset: reg.token, visible: true, opacity: 1,
      mode: par.align === 'none' ? 'stretch' : par.slice ? 'fill' : 'fit',
    };
    const node: ShapeNode = {
      ...shapeDefaults(), id: newId(), name: '', parent: '', type: 'rect', w: w!, h: h!, radii: [0, 0, 0, 0],
      transform: translate(x, y), fills: ctx.clip ? [solid({ ...BLACK })] : [paint],
    };
    const vis = (st.visibility ?? 'visible').toLowerCase();
    if (vis === 'hidden' || vis === 'collapse') node.visible = false;
    return this.leafFor(el, 'image', node);
  }

  skippedSvgImages = new Set<El>();

  // ------------------------------------------------------------ text

  text(el: El, st: Style, ctx: Ctx): B | null {
    interface Line { x: number; y: number; text: string; st: Style; styled: boolean }
    const lines: Line[] = [];
    let cur: Line | null = null;
    const first = (v: string | null): string | null => (v == null ? null : v.trim().split(/[\s,]+/)[0] || null);
    let lineX = this.len(first(attr(el, 'x')), st, ctx, 'x') + this.len(first(attr(el, 'dx')), st, ctx, 'x');
    let penY = this.len(first(attr(el, 'y')), st, ctx, 'y') + this.len(first(attr(el, 'dy')), st, ctx, 'y');
    const walk = (node: El, nst: Style, depth: number): void => {
      const cn = node.childNodes;
      if (!cn || depth > 50) return;
      for (let i = 0; i < cn.length; i++) {
        const c = cn[i];
        if (c.nodeType === 3 || c.nodeType === 4) {
          const t = String(c.data ?? c.textContent ?? '');
          if (!cur) { cur = { x: lineX, y: penY, text: '', st: nst, styled: false }; lines.push(cur); }
          if (t.trim() && !cur.styled) { cur.st = nst; cur.styled = true; }
          cur.text += t;
        } else if (c.nodeType === 1) {
          const tag = tagOf(c);
          if (tag !== 'tspan' && tag !== 'textpath' && tag !== 'a') continue;
          if (tag === 'textpath') this.warn('<textPath> is not supported: imported as plain text');
          const cst = this.computeStyle(c, nst);
          if ((cst.display ?? '') === 'none') continue;
          if (tag === 'tspan') {
            const ax = first(attr(c, 'x')), ay = first(attr(c, 'y'));
            const dx = this.len(first(attr(c, 'dx')), cst, ctx, 'x'), dy = this.len(first(attr(c, 'dy')), cst, ctx, 'y');
            // absolute positioning, or a vertical shift big enough to be a line feed, starts a new line
            if (ax != null || ay != null || Math.abs(dy) >= 0.75 * this.fontSize(cst)) {
              if (ax != null) lineX = this.len(ax, cst, ctx, 'x') + dx;
              if (ay != null) penY = this.len(ay, cst, ctx, 'y');
              penY += dy;
              cur = null;
            }
          }
          walk(c, cst, depth + 1);
        }
      }
    };
    walk(el, st, 0);
    const preserve = attr(el, 'xml:space') === 'preserve' || /^pre/.test(st['white-space'] ?? '');
    for (const l of lines) {
      l.text = l.text.replace(/[\n\r\t]/g, ' ');
      if (!preserve) l.text = l.text.replace(/ +/g, ' ').trim();
    }
    const real = lines.filter(l => l.text.trim() !== '');
    if (!real.length) return null;

    const fontOf = (s: Style): FontRef => {
      const fam = (s['font-family'] ?? 'sans-serif').split(',')[0].trim().replace(/^['"]|['"]$/g, '').trim() || 'sans-serif';
      const wv = (s['font-weight'] ?? 'normal').toLowerCase();
      let weight = wv === 'normal' ? 400 : wv === 'bold' ? 700 : wv === 'bolder' ? 700 : wv === 'lighter' ? 300 : parseFloat(wv);
      if (Number.isNaN(weight)) weight = 400;
      weight = Math.max(100, Math.min(900, Math.round(weight / 100) * 100));
      return { family: fam, weight, italic: /^(italic|oblique)/.test((s['font-style'] ?? '').toLowerCase()) };
    };
    const styleKey = (s: Style): string => JSON.stringify([
      fontOf(s), this.fontSize(s), s.fill ?? '', s['fill-opacity'] ?? '', s.stroke ?? '', s['stroke-width'] ?? '',
      s['text-anchor'] ?? '', s['letter-spacing'] ?? '', s.visibility ?? '', s.color ?? '',
    ]);

    // consecutive lines with the same x, style and a regular advance become one multi-line node
    const blocks: { lines: Line[]; spacing: number | null }[] = [];
    for (const l of real) {
      const b = blocks[blocks.length - 1];
      if (b) {
        const prev = b.lines[b.lines.length - 1], fs = this.fontSize(l.st), dy = l.y - prev.y;
        const ok = Math.abs(l.x - prev.x) < 0.01 && dy >= 0.5 * fs && dy <= 3 * fs && styleKey(l.st) === styleKey(prev.st)
          && (b.spacing == null || Math.abs(dy - b.spacing) <= 0.02 * b.spacing + 0.01);
        if (ok) { b.lines.push(l); b.spacing ??= dy; continue; }
      }
      blocks.push({ lines: [l], spacing: null });
    }
    const metrics = this.opts.textMetrics ?? ((_f: FontRef, size: number) => ({ ascent: 0.8 * size, descent: 0.2 * size }));
    const out: B[] = [];
    for (const b of blocks) {
      const s = b.lines[0].st;
      const font = fontOf(s), size = this.fontSize(s);
      const { ascent, descent } = metrics(font, size);
      const lineHeight = b.spacing;
      const lh = lineHeight ?? ascent + descent;
      const yTop = b.lines[0].y - ascent - (lh - (ascent + descent)) / 2;
      const anchor = (s['text-anchor'] ?? 'start').toLowerCase();
      const ls = s['letter-spacing'];
      const text = b.lines.map(l => l.text).join('\n');
      const node: TextNode = {
        ...shapeDefaults(), id: newId(), name: '', parent: '', type: 'text', text, font, size, lineHeight,
        letterSpacing: ls && ls.toLowerCase() !== 'normal' ? this.len(ls, s, ctx, 'x') : 0,
        align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left', w: null,
        transform: translate(b.lines[0].x, yTop),
      };
      if (!this.paintShape(node, s, ctx, null)) continue;
      node.name = b.lines[0].text.length > 40 ? b.lines[0].text.slice(0, 39) + '…' : b.lines[0].text;
      const leaf: B = { node, kids: null, named: false };
      if (anchor === 'middle' || anchor === 'end') leaf.anchor = anchor;
      out.push(leaf);
    }
    if (!out.length) return null;
    const name = this.nameOf(el);
    if (out.length === 1) {
      if (name) { out[0].node.name = name; out[0].named = true; }
      return out[0];
    }
    return this.group(name ?? 'Text', !!name, out);
  }

  // ------------------------------------------------------------ clip-path / mask

  boundsOf(b: B, pm: Mat, stroke: boolean, flag: { unknown: boolean }): Box | null {
    const n = b.node;
    const m = mul(pm, n.transform);
    const s = Math.max(scaleXOf(m), scaleYOf(m));
    // painted extent of effects (blur = 2 * sigma; 3 sigma covers everything visible)
    let fx = 0;
    if (stroke) {
      for (const e of n.effects) {
        if (e.type === 'drop-shadow') fx = Math.max(fx, Math.max(Math.abs(e.x), Math.abs(e.y)) + 1.5 * e.blur + Math.max(0, e.spread));
        else if (e.type === 'layer-blur') fx = Math.max(fx, 1.5 * e.blur);
      }
    }
    const grow = (box: Box | null): Box | null => (box && fx > 0 ? expandBox(box, fx * s) : box);
    if (b.kids) {
      let u: Box | null = null;
      for (const k of b.kids) if (!k.node.mask) u = union(u, this.boundsOf(k, m, stroke, flag));
      return grow(u);
    }
    if (n.type === 'group') return null;
    if (n.type === 'text') { flag.unknown = true; return null; }
    const box = subpathsBounds(nodeSubpaths(n), m);
    if (box && stroke && n.strokes.length) {
      // conservative: miter joins can reach miterlimit (4) half-widths, square caps sqrt(2)
      const k = n.type !== 'path' ? 1 : n.strokeJoin === 'miter' ? 4 : n.strokeCap === 'square' ? Math.SQRT2 : 1;
      return grow(expandBox(box, (n.strokeWeight / 2) * k * s));
    }
    return grow(box);
  }

  /** the box covered by b if it is a plain axis-aligned, fully opaque rectangle */
  axisRect(b: B, pm: Mat): Box | null {
    const n = b.node;
    const m = mul(pm, n.transform);
    if (b.kids) return b.kids.length === 1 && n.opacity === 1 ? this.axisRect(b.kids[0], m) : null;
    if (n.type === 'group' || n.type === 'text' || n.opacity !== 1 || !n.visible) return null;
    if (Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9) return null;
    const f = n.fills[0];
    if (!f || f.type !== 'solid' || f.opacity < 1 || f.color.a < 1) return null;
    if (n.type === 'rect') return n.radii.every(r => r === 0) ? transformBox(m, { x: 0, y: 0, w: n.w, h: n.h }) : null;
    if (n.type !== 'path' || n.subpaths.length !== 1) return null;
    const sp = n.subpaths[0];
    if (sp.pts.length !== 4 || sp.pts.some(p => p.in || p.out)) return null;
    for (let i = 0; i < 4; i++) {
      const a = sp.pts[i], c = sp.pts[(i + 1) % 4];
      const dx = Math.abs(a.x - c.x) > 1e-9, dy = Math.abs(a.y - c.y) > 1e-9;
      if (dx === dy) return null; // each edge must move along exactly one axis
    }
    return subpathsBounds(n.subpaths, m);
  }

  /** Which channel of each leaf of a mask's content does the masking: 'L' = luminance (times alpha),
   *  'A' = alpha only. `def` is the mask type; cairo's colour-matrix wrappers override it. */
  maskLeaves(b: B, def: 'A' | 'L', out: { b: B; sem: 'A' | 'L' }[]): void {
    const sem = b.lumAlpha ? 'L' : b.white ? 'A' : def;
    if (b.kids) for (const k of b.kids) this.maskLeaves(k, b.lumAlpha ? 'L' : sem, out);
    else if (b.node.type !== 'group') out.push({ b, sem: b.lumAlpha ? 'L' : sem });
  }

  /** make a leaf whose alpha masks behave the same in a luminance mask: paint it white */
  whiten(b: B): void {
    const n = b.node;
    if (n.type === 'group') return;
    for (const p of [...n.fills, ...n.strokes]) {
      if (p.type === 'solid') p.color = { r: 1, g: 1, b: 1, a: p.color.a };
      else if (p.type === 'gradient') p.stops = p.stops.map(s => ({ offset: s.offset, color: { r: 1, g: 1, b: 1, a: s.color.a } }));
    }
  }

  /** remove leaves that ended up without paint (and the groups emptied by that) */
  prune(bs: B[]): B[] {
    return bs.filter(b => {
      if (b.kids) { b.kids = this.prune(b.kids); return b.kids.length > 0; }
      const n = b.node;
      return n.type !== 'group' && (n.fills.length > 0 || n.strokes.length > 0);
    });
  }

  /** luminance -> alpha for the solid / gradient paints of a leaf (exact) */
  luminance(b: B): boolean {
    const n = b.node;
    if (n.type === 'group') return false;
    const lum = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const conv = (ps: Paint[]): Paint[] => ps.filter(p => {
      if (p.type === 'solid') {
        p.opacity *= lum(p.color);
        p.color = { r: 1, g: 1, b: 1, a: p.color.a };
        return p.opacity > 1e-4;
      }
      if (p.type === 'gradient') {
        p.stops = p.stops.map(s => ({ offset: s.offset, color: { r: 1, g: 1, b: 1, a: s.color.a * lum(s.color) } }));
        return p.stops.some(s => s.color.a > 1e-4);
      }
      return true;
    });
    n.fills = conv(n.fills);
    n.strokes = conv(n.strokes);
    return n.fills.length > 0 || n.strokes.length > 0;
  }

  /** wrap `target` (in E's user space, before E's transform) into group [mask, target]. null => nothing visible */
  applyClip(target: B, clipEl: El, ctx: Ctx, isMask: boolean): B | null {
    const cst = this.docStyle(clipEl);
    const unitsAttr = isMask ? 'maskContentUnits' : 'clipPathUnits';
    let m = isMask ? IDENT() : this.transformOf(clipEl, cst);
    if (attr(clipEl, unitsAttr) === 'objectBoundingBox') {
      const bb = this.boundsOf(target, IDENT(), false, { unknown: false });
      if (!bb || bb.w <= 0 || bb.h <= 0) return null;
      m = mul(m, [bb.w, 0, 0, bb.h, bb.x, bb.y]);
    }
    if (ctx.uses.includes(clipEl)) return target;
    const kctx: Ctx = { ...ctx, style: cst, clip: !isMask, mask: isMask, uses: [...ctx.uses, clipEl] };
    let kids = this.containerKids(clipEl, kctx);
    let byLuminance = false;
    if (isMask) {
      const alpha = (attr(clipEl, 'mask-type') ?? cst['mask-type'] ?? 'luminance').toLowerCase() === 'alpha';
      const leaves: { b: B; sem: 'A' | 'L' }[] = [];
      for (const k of kids) this.maskLeaves(k, alpha ? 'A' : 'L', leaves);
      // solid and gradient paints can be expressed exactly in either kind of mask; images cannot
      const hasImage = (b: B): boolean => b.node.type !== 'group' && [...b.node.fills, ...b.node.strokes].some(p => p.type === 'image');
      const imgL = leaves.some(l => l.sem === 'L' && hasImage(l.b)), imgA = leaves.some(l => l.sem === 'A' && hasImage(l.b));
      byLuminance = imgL;
      if (imgL && imgA) this.warn('<mask> mixes images used by luminance and by alpha: approximated as a luminance mask');
      for (const l of leaves) {
        if (byLuminance && l.sem === 'A') this.whiten(l.b); // real colours stay on the 'L' leaves
        else if (!byLuminance && l.sem === 'L') this.luminance(l.b);
      }
      kids = this.prune(kids);
    } else if (cst['clip-path'] && cst['clip-path'] !== 'none') {
      this.warn('clip-path on a <clipPath> element is not supported and was ignored');
    }
    if (!kids.length) return null; // an empty clip hides everything
    // very common in Figma / pdftocairo output: a rectangle that does not actually clip anything
    if (kids.length === 1 && !byLuminance) {
      const rect = this.axisRect(kids[0], m);
      const flag = { unknown: false };
      const tb = rect ? this.boundsOf(target, IDENT(), true, flag) : null;
      if (rect && !flag.unknown && (!tb || boxContains(expandBox(rect, 0.01), tb))) return target;
    }
    let maskB: B;
    if (kids.length === 1) {
      maskB = kids[0];
      maskB.node.transform = mul(m, maskB.node.transform);
    } else {
      maskB = this.group(isMask ? 'Mask' : 'Clip', false, kids);
      maskB.node.transform = m;
    }
    maskB.node.mask = true;
    if (byLuminance) maskB.node.maskLuminance = true;
    if (!maskB.named) maskB.node.name = isMask ? 'Mask' : 'Clip';
    const tn = target.node;
    const flatten = target.kids && tn.opacity === 1 && tn.blend === 'normal' && !tn.effects.length && !tn.mask
      && tn.transform.every((v, i) => v === (i === 0 || i === 3 ? 1 : 0)) && !target.kids.some(k => k.node.mask);
    return this.group(tn.name, target.named, flatten ? [maskB, ...target.kids!] : [maskB, target]);
  }
}

// ---------------------------------------------------------------- tree post-processing

/** merge pointless groups into their only child, drop empty groups */
function collapse(b: B): B | null {
  if (!b.kids) return b;
  b.kids = b.kids.map(collapse).filter((k): k is B => k !== null);
  // only masks left (or nothing): renders nothing
  if (b.kids.every(k => k.node.mask)) return null;
  const n = b.node;
  const only = b.kids.length === 1 ? b.kids[0].node : null;
  // effects of the group can move to its only child when they mean the same there
  const effectsOk = !!only && (n.effects.length === 0 || (only.effects.length === 0 && only.opacity === 1 && only.blend === 'normal'
    && !only.mask && only.type !== 'group' && only.transform[0] === 1 && only.transform[1] === 0 && only.transform[2] === 0 && only.transform[3] === 1));
  // group opacity over a single child is the same as multiplying the child's opacity
  const opacityOk = !!only && (n.opacity === 1 || (only.blend === 'normal' && !only.mask && !n.mask));
  if (only && opacityOk && n.blend === 'normal' && effectsOk) {
    const k = b.kids[0];
    k.node.opacity *= n.opacity;
    if (n.effects.length) k.node.effects = n.effects;
    k.node.transform = mul(n.transform, k.node.transform);
    if (n.mask) { k.node.mask = true; if (n.maskLuminance) k.node.maskLuminance = true; }
    if (!n.visible) k.node.visible = false;
    if (b.named && !k.named) { k.node.name = n.name; k.named = true; }
    if (b.white) k.white = true;
    return k;
  }
  return b;
}

function flatten(b: B, parent: string, nodes: Record<string, Node>, anchors: Record<string, 'middle' | 'end'>): void {
  const n = b.node;
  n.parent = parent;
  nodes[n.id] = n;
  if (b.anchor) anchors[n.id] = b.anchor;
  if (n.type === 'group') {
    n.children = (b.kids ?? []).map(k => k.node.id);
    for (const k of b.kids ?? []) flatten(k, n.id, nodes, anchors);
  }
}

function countNodes(bs: B[]): number {
  let n = 0;
  for (const b of bs) n += 1 + (b.kids ? countNodes(b.kids) : 0);
  return n;
}

function findSvgRoot(svg: string, opts: SvgImportOptions): El {
  const Parser = opts.DOMParser ?? (globalThis as { DOMParser?: SvgImportOptions['DOMParser'] }).DOMParser;
  if (!Parser) throw new Error('importSvg: no DOMParser available (pass opts.DOMParser)');
  const find = (el: El, depth: number): El | null => {
    if (!el || el.nodeType !== 1) return null;
    if (tagOf(el) === 'svg') return el;
    if (depth > 6) return null;
    for (const k of elementKids(el)) { const r = find(k, depth + 1); if (r) return r; }
    return null;
  };
  for (const type of ['image/svg+xml', 'text/html']) {
    try {
      const doc = new Parser().parseFromString(svg, type);
      const de = doc?.documentElement;
      // a strict XML parser reports errors as a <parsererror> document: retry leniently as HTML
      const root = de && tagOf(de) === 'svg' ? de : type === 'text/html' ? find(de, 0) : null;
      if (root) return root;
    } catch { /* try the next mode */ }
  }
  throw new Error('Not an SVG document: no <svg> root element found');
}

async function importTree(svg: string, opts: SvgImportOptions, shared: Shared, depth: number): Promise<{ roots: B[]; width: number; height: number }> {
  const root = findSvgRoot(svg, opts);
  const imp = new Importer(root, opts, shared);
  imp.index(root);

  // SVG images embedded as data: URIs are imported recursively (hashing makes the import async,
  // so they are resolved up front and the tree walk itself stays synchronous)
  const images: El[] = [];
  imp.collectSvgImages(root, images);
  for (const img of images) {
    const href = (attr(img, 'href') ?? attr(img, 'xlink:href') ?? '').trim();
    if (!/^data:/i.test(href)) continue;
    const data = decodeDataUri(href);
    if (!data || !looksLikeSvg(data)) continue;
    let ok = false;
    if (depth < MAX_NESTED_SVG_DEPTH) {
      try {
        const sub = await importTree(new TextDecoder().decode(data.bytes), opts, shared, depth + 1);
        if (countNodes(sub.roots) <= MAX_NESTED_SVG_NODES) { imp.nested.set(img, sub); ok = true; }
      } catch { /* reported below */ }
    }
    if (!ok) {
      imp.skippedSvgImages.add(img);
      imp.warn('Embedded SVG image skipped (not a simple SVG: unparsable, too large or nested too deeply)');
    }
  }

  const size = imp.rootSize(root);
  const vb = parseViewBox(attr(root, 'viewBox'));
  imp.vpForUnits = vb ? { w: vb.w, h: vb.h } : size;
  const ctx: Ctx = { style: {}, vp: { w: size.w, h: size.h }, uses: [] };
  const top = imp.convert(root, ctx)[0] as B | undefined;
  let roots: B[] = [];
  if (top) {
    const n = top.node;
    const plain = top.kids && n.opacity === 1 && n.blend === 'normal' && !n.effects.length && n.visible && !top.white
      && !top.kids.some(k => k.node.mask);
    if (plain) {
      for (const k of top.kids!) {
        const c = collapse(k);
        if (!c || c.node.mask) continue;
        c.node.transform = mul(n.transform, c.node.transform);
        roots.push(c);
      }
    } else {
      const c = collapse(top);
      if (c) roots = [c];
    }
  }
  // a single anonymous wrapper group at the top (e.g. Illustrator's <switch><g>) is noise
  while (roots.length === 1) {
    const r = roots[0], n = r.node;
    if (!r.kids || r.named || n.opacity !== 1 || n.blend !== 'normal' || n.effects.length || !n.visible || n.mask
      || r.kids.some(k => k.node.mask)) break;
    for (const k of r.kids) k.node.transform = mul(n.transform, k.node.transform);
    roots = r.kids;
  }
  return { roots, width: size.w, height: size.h };
}

/** Import an SVG document. Throws only when the input has no <svg> root. */
export async function importSvg(svg: string, opts: SvgImportOptions = {}): Promise<SvgImport> {
  const shared: Shared = { warnings: [], seen: new Set(), pending: [], byHref: new Map() };
  const tree = await importTree(svg, opts, shared, 0);
  for (const r of tree.roots) normalizeTree(r);

  const nodes: Record<string, Node> = {};
  const textAnchors: Record<string, 'middle' | 'end'> = {};
  for (const r of tree.roots) flatten(r, '', nodes, textAnchors);

  // content-address the images that are actually referenced
  const used = new Set<string>();
  const eachPaint = (fn: (p: Paint) => void): void => {
    for (const n of Object.values(nodes)) if (n.type !== 'group') for (const p of [...n.fills, ...n.strokes]) fn(p);
  };
  eachPaint(p => { if (p.type === 'image') used.add(p.asset); });
  const assets = new Map<string, ImportedAsset>();
  const keys = new Map<string, string>();
  for (const img of shared.pending) {
    if (!used.has(img.token)) continue;
    const key = await assetKey(img.bytes, img.info.ext);
    keys.set(img.token, key);
    const meta: AssetMeta = { mime: img.info.mime };
    if (img.info.w > 0 && img.info.h > 0) { meta.w = img.info.w; meta.h = img.info.h; }
    if (!assets.has(key)) assets.set(key, { bytes: img.bytes, meta });
  }
  eachPaint(p => { if (p.type === 'image') p.asset = keys.get(p.asset) ?? p.asset; });

  return {
    nodes, roots: tree.roots.map(r => r.node.id), assets, width: tree.width, height: tree.height,
    warnings: shared.warnings, textAnchors,
  };
}
