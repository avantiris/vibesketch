import type { Box, Color, Doc, Effect, Mat, Node, Paint, ShapeNode } from './model.ts';
import { expandBox, round, transformBox } from './geom.ts';
import { localBounds, paintOutset } from './bounds.ts';
import { capLayout } from './connector.ts';
import { nodeSubpaths, subpathsToD } from './path.ts';
import { cssFamily, layoutText } from './text.ts';

// Node -> SVG, as a tiny virtual tree. The canvas turns it into DOM, the exporter into text,
// so what you see is exactly what gets exported.

export type Attrs = Record<string, string | number | undefined | null>;
export interface VEl { tag: string; attrs: Attrs; children?: (VEl | string)[] }
export const h = (tag: string, attrs: Attrs = {}, children?: (VEl | string)[]): VEl => ({ tag, attrs, children });

export interface RenderCtx {
  /** URL (or data: URI) for an asset key */
  assetUrl(key: string): string;
  /** document-unique id stem for a node's defs (gradients, clips, filters) */
  ref(nodeId: string): string;
  /** decimals for coordinates */
  digits?: number;
}

export interface Rendered {
  /** attributes for the node's wrapper <g> */
  attrs: Attrs;
  defs: VEl[];
  /** painted content (empty for groups: the caller appends the children) */
  content: VEl[];
}

const f = (v: number, d = 3) => round(v, d);

export function hex(c: Color): string {
  const b = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${b(c.r)}${b(c.g)}${b(c.b)}`;
}

export function matrixAttr(m: Mat): string | undefined {
  const [a, b, c, d, e, g] = m.map(v => f(v, 5));
  if (a === 1 && b === 0 && c === 0 && d === 1) return e === 0 && g === 0 ? undefined : `translate(${f(e)} ${f(g)})`;
  return `matrix(${a} ${b} ${c} ${d} ${f(e)} ${f(g)})`;
}

function shapeBox(doc: Doc, n: ShapeNode): Box {
  return localBounds(doc, n.id);
}

function isClosed(n: ShapeNode): boolean {
  if (n.type === 'text') return false;
  if (n.type === 'path') return n.subpaths.length > 0 && n.subpaths.every(s => s.closed);
  return true;
}

function geometry(n: ShapeNode, digits: number): VEl {
  switch (n.type) {
    case 'rect': {
      const [a, b, c, d] = n.radii;
      if (a === b && b === c && c === d) {
        const r = Math.min(a, n.w / 2, n.h / 2);
        return h('rect', { width: f(n.w), height: f(n.h), rx: r > 0 ? f(r) : undefined });
      }
      return h('path', { d: subpathsToD(nodeSubpaths(n), digits) });
    }
    case 'ellipse':
      return h('ellipse', { cx: f(n.w / 2), cy: f(n.h / 2), rx: f(n.w / 2), ry: f(n.h / 2) });
    case 'text': {
      const l = layoutText(n);
      return h('text', {
        'font-family': cssFamily(n.font.family),
        'font-size': f(n.size),
        'font-weight': n.font.weight === 400 ? undefined : n.font.weight,
        'font-style': n.font.italic ? 'italic' : undefined,
        'letter-spacing': n.letterSpacing ? f(n.letterSpacing) : undefined,
        'xml:space': 'preserve',
      }, l.lines.filter(x => x.text.length).map(x => h('tspan', { x: f(x.x), y: f(x.y) }, [x.text])));
    }
    case 'path': {
      const evenodd = n.fillRule === 'evenodd' ? 'evenodd' : undefined;
      return h('path', { d: subpathsToD(n.subpaths, digits), 'fill-rule': evenodd, 'clip-rule': evenodd });
    }
    default:
      return h('path', { d: subpathsToD(nodeSubpaths(n), digits) });
  }
}

interface PaintOut { value: string; opacity: number; defs: VEl[] }

function paintValue(p: Paint, box: Box, id: string, doc: Doc, ctx: RenderCtx): PaintOut | null {
  if (p.type === 'solid') return { value: hex(p.color), opacity: p.color.a * p.opacity, defs: [] };
  if (p.type === 'gradient') {
    const stops = p.stops.map(s => h('stop', {
      offset: f(s.offset, 4), 'stop-color': hex(s.color), 'stop-opacity': s.color.a < 1 ? f(s.color.a) : undefined,
    }));
    const x1 = box.x + p.from.x * box.w, y1 = box.y + p.from.y * box.h;
    const x2 = box.x + p.to.x * box.w, y2 = box.y + p.to.y * box.h;
    if (p.kind === 'linear') {
      return { value: `url(#${id})`, opacity: p.opacity, defs: [h('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: f(x1), y1: f(y1), x2: f(x2), y2: f(y2) }, stops)] };
    }
    const vx = x2 - x1, vy = y2 - y1, r = Math.hypot(vx, vy);
    const circle = Math.abs(p.width - 1) < 1e-4;
    const attrs: Attrs = circle
      ? { id, gradientUnits: 'userSpaceOnUse', cx: f(x1), cy: f(y1), r: f(r) }
      : { id, gradientUnits: 'userSpaceOnUse', cx: 0, cy: 0, r: 1, gradientTransform: `matrix(${f(vx)} ${f(vy)} ${f(-vy * p.width)} ${f(vx * p.width)} ${f(x1)} ${f(y1)})` };
    return { value: `url(#${id})`, opacity: p.opacity, defs: [h('radialGradient', attrs, stops)] };
  }
  if (p.type === 'image' && p.mode === 'tile') {
    const meta = doc.assets[p.asset];
    const s = p.scale ?? 1, w = (meta?.w ?? 100) * s, hh = (meta?.h ?? 100) * s;
    return {
      value: `url(#${id})`, opacity: p.opacity,
      defs: [h('pattern', { id, patternUnits: 'userSpaceOnUse', x: f(box.x), y: f(box.y), width: f(w), height: f(hh) },
        [h('image', { href: ctx.assetUrl(p.asset), width: f(w), height: f(hh), preserveAspectRatio: 'none' })])],
    };
  }
  return null;
}

const blendStyle = (b: string | undefined): string | undefined => (b && b !== 'normal' ? `mix-blend-mode:${b}` : undefined);

function strokeAttrs(n: ShapeNode, width: number): Attrs {
  return {
    'stroke-width': f(width),
    'stroke-linecap': n.strokeCap === 'butt' ? undefined : n.strokeCap,
    'stroke-linejoin': n.strokeJoin === 'miter' ? undefined : n.strokeJoin,
    'stroke-dasharray': n.dash.length ? n.dash.map(v => f(v)).join(' ') : undefined,
  };
}

function renderShape(doc: Doc, n: ShapeNode, ctx: RenderCtx, out: Rendered) {
  const ref = ctx.ref(n.id), digits = ctx.digits ?? 3;
  const box = shapeBox(doc, n);
  const fills = n.fills.filter(p => p.visible);
  const strokes = n.strokeWeight > 0 ? n.strokes.filter(p => p.visible && p.type !== 'image') : [];
  const align = isClosed(n) ? n.strokeAlign : 'center';
  const caps = n.type === 'path' && strokes.length && ((n.startCap ?? 'none') !== 'none' || (n.endCap ?? 'none') !== 'none') ? capLayout(n) : null;
  const geo = geometry(caps && n.type === 'path' ? { ...n, subpaths: caps.subpaths } : n, digits);
  // arrowheads take the (first) stroke paint; its defs are emitted with the stroke itself
  const addHeads = () => {
    const pv = caps?.heads.length ? paintValue(strokes[0], box, `${ref}-stroke`, doc, ctx) : null;
    if (!caps || !pv) return;
    const op = pv.opacity < 1 ? f(pv.opacity) : undefined;
    const points = (pts: { x: number; y: number }[]) => pts.map(p => `${f(p.x)},${f(p.y)}`).join(' ');
    for (const hd of caps.heads) {
      if (hd.type === 'circle') out.content.push(h('circle', { cx: f(hd.c.x), cy: f(hd.c.y), r: f(hd.r), fill: pv.value, 'fill-opacity': op }));
      else if (hd.type === 'polygon') out.content.push(h('polygon', { points: points(hd.pts), fill: pv.value, 'fill-opacity': op }));
      else out.content.push(h('polyline', { points: points(hd.pts), fill: 'none', stroke: pv.value, 'stroke-opacity': op, 'stroke-width': f(n.strokeWeight), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
  };

  // common case: one element carrying both fill and stroke
  const simpleFill = fills.length === 0 || (fills.length === 1 && (fills[0].type !== 'image' || fills[0].mode === 'tile') && !blendStyle(fills[0].blend));
  const simpleStroke = strokes.length === 0 || (strokes.length === 1 && align === 'center' && !blendStyle(strokes[0].blend));
  if (simpleFill && simpleStroke) {
    const a: Attrs = { ...geo.attrs };
    const fp = fills[0] && paintValue(fills[0], box, `${ref}-fill`, doc, ctx);
    if (fp) { a.fill = fp.value; a['fill-opacity'] = fp.opacity < 1 ? f(fp.opacity) : undefined; out.defs.push(...fp.defs); } else a.fill = 'none';
    const sp = strokes[0] && paintValue(strokes[0], box, `${ref}-stroke`, doc, ctx);
    if (sp) {
      a.stroke = sp.value; a['stroke-opacity'] = sp.opacity < 1 ? f(sp.opacity) : undefined;
      Object.assign(a, strokeAttrs(n, n.strokeWeight));
      out.defs.push(...sp.defs);
    }
    out.content.push({ tag: geo.tag, attrs: a, children: geo.children });
    addHeads();
    return;
  }

  // general case: geometry defined once, each paint layer is a <use>
  const shapeId = `${ref}-shape`;
  out.defs.push({ tag: geo.tag, attrs: { id: shapeId, ...geo.attrs }, children: geo.children });
  let clipId: string | undefined;
  const clip = () => {
    if (!clipId) { clipId = `${ref}-clip`; out.defs.push(h('clipPath', { id: clipId }, [h('use', { href: `#${shapeId}` })])); }
    return `url(#${clipId})`;
  };
  fills.forEach((p, i) => {
    if (p.type === 'image' && p.mode !== 'tile') {
      out.content.push(h('image', {
        href: ctx.assetUrl(p.asset), x: f(box.x), y: f(box.y), width: f(box.w), height: f(box.h),
        preserveAspectRatio: p.mode === 'fill' ? 'xMidYMid slice' : p.mode === 'fit' ? 'xMidYMid meet' : 'none',
        opacity: p.opacity < 1 ? f(p.opacity) : undefined, 'clip-path': clip(), style: blendStyle(p.blend),
      }));
      return;
    }
    const pv = paintValue(p, box, `${ref}-fill${i || ''}`, doc, ctx);
    if (!pv) return;
    out.defs.push(...pv.defs);
    out.content.push(h('use', { href: `#${shapeId}`, fill: pv.value, 'fill-opacity': pv.opacity < 1 ? f(pv.opacity) : undefined, style: blendStyle(p.blend) }));
  });
  let maskId: string | undefined;
  strokes.forEach((p, i) => {
    const pv = paintValue(p, box, `${ref}-stroke${i || ''}`, doc, ctx);
    if (!pv) return;
    out.defs.push(...pv.defs);
    const a: Attrs = {
      href: `#${shapeId}`, fill: 'none', stroke: pv.value, 'stroke-opacity': pv.opacity < 1 ? f(pv.opacity) : undefined,
      ...strokeAttrs(n, align === 'center' ? n.strokeWeight : n.strokeWeight * 2), style: blendStyle(p.blend),
    };
    if (align === 'inside') a['clip-path'] = clip();
    else if (align === 'outside') {
      if (!maskId) {
        maskId = `${ref}-outside`;
        const r = expandBox(box, n.strokeWeight * 4 + 2);
        out.defs.push(h('mask', { id: maskId, maskUnits: 'userSpaceOnUse', x: f(r.x), y: f(r.y), width: f(r.w), height: f(r.h) }, [
          h('rect', { x: f(r.x), y: f(r.y), width: f(r.w), height: f(r.h), fill: '#fff' }),
          h('use', { href: `#${shapeId}`, fill: '#000' }),
        ]));
      }
      a.mask = `url(#${maskId})`;
    }
    out.content.push(h('use', a));
  });
  addHeads();
}

/** SVG filter implementing the node's effects, or null when there is nothing to render. */
export function buildFilter(id: string, effects: Effect[], region: Box): VEl | null {
  const fx = effects.filter(e => e.visible && e.type !== 'background-blur');
  if (!fx.length) return null;
  const prims: VEl[] = [];
  let cur = 'SourceGraphic', alpha = 'SourceAlpha', k = 0;
  const name = (s: string) => `${s}${++k}`;
  const flood = (c: Color, shape: string): string => {
    const fl = name('flood'), res = name('tint');
    prims.push(h('feFlood', { 'flood-color': hex(c), 'flood-opacity': f(c.a), result: fl }));
    prims.push(h('feComposite', { in: fl, in2: shape, operator: 'in', result: res }));
    return res;
  };
  const over = (top: string) => {
    const res = name('layer');
    prims.push(h('feMerge', { result: res }, [h('feMergeNode', { in: cur }), h('feMergeNode', { in: top })]));
    cur = res;
  };

  const tex = fx.find(e => e.type === 'texture');
  if (tex && tex.type === 'texture' && tex.radius > 0) {
    prims.push(h('feTurbulence', { type: 'fractalNoise', baseFrequency: f(0.6 / Math.max(0.5, tex.size), 5), numOctaves: 2, seed: 3, result: 'rough' }));
    prims.push(h('feDisplacementMap', { in: 'SourceGraphic', in2: 'rough', scale: f(tex.radius * 2), xChannelSelector: 'R', yChannelSelector: 'G', result: 'textured' }));
    prims.push(h('feColorMatrix', { in: 'textured', type: 'matrix', values: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0', result: 'texturedAlpha' }));
    cur = 'textured'; alpha = 'texturedAlpha';
  }
  for (const e of fx) {
    if (e.type !== 'noise') continue;
    const n = name('noise'), nc = name('grain'), ni = name('grainIn');
    // fractal noise hovers around 0.5: threshold it so `density` controls the grain coverage
    const s = 7 * e.color.a, t = 0.5 + (0.5 - e.density) * 0.55;
    prims.push(h('feTurbulence', { type: 'fractalNoise', baseFrequency: f(0.7 / Math.max(0.2, e.size), 5), numOctaves: 2, seed: 7 + k, result: n }));
    prims.push(h('feColorMatrix', { in: n, type: 'matrix', values: `0 0 0 0 ${f(e.color.r)} 0 0 0 0 ${f(e.color.g)} 0 0 0 0 ${f(e.color.b)} ${f(s)} 0 0 0 ${f(-s * t)}`, result: nc }));
    prims.push(h('feComposite', { in: nc, in2: alpha, operator: 'in', result: ni }));
    over(ni);
  }
  for (const e of fx) {
    if (e.type !== 'inner-shadow') continue;
    let src = alpha;
    if (e.spread > 0) { const er = name('erode'); prims.push(h('feMorphology', { in: src, operator: 'erode', radius: f(e.spread), result: er })); src = er; }
    const off = name('off'), bl = name('blur'), diff = name('inner');
    prims.push(h('feOffset', { in: src, dx: f(e.x), dy: f(e.y), result: off }));
    prims.push(h('feGaussianBlur', { in: off, stdDeviation: f(e.blur / 2), result: bl }));
    prims.push(h('feComposite', { in: alpha, in2: bl, operator: 'arithmetic', k2: 1, k3: -1, result: diff }));
    over(flood(e.color, diff));
  }
  const shadows: string[] = [];
  for (const e of fx) {
    if (e.type !== 'drop-shadow') continue;
    let src = alpha;
    if (e.spread > 0) { const di = name('spread'); prims.push(h('feMorphology', { in: src, operator: 'dilate', radius: f(e.spread), result: di })); src = di; }
    const off = name('off'), bl = name('blur');
    prims.push(h('feOffset', { in: src, dx: f(e.x), dy: f(e.y), result: off }));
    prims.push(h('feGaussianBlur', { in: off, stdDeviation: f(e.blur / 2), result: bl }));
    shadows.push(flood(e.color, bl));
  }
  if (shadows.length) {
    const res = name('shadowed');
    prims.push(h('feMerge', { result: res }, [...shadows, cur].map(s => h('feMergeNode', { in: s }))));
    cur = res;
  }
  const blur = fx.find(e => e.type === 'layer-blur');
  if (blur && blur.blur > 0) prims.push(h('feGaussianBlur', { in: cur, stdDeviation: f(blur.blur / 2) }));
  else if (cur === 'SourceGraphic') return null;
  else if (prims[prims.length - 1].attrs.result !== cur) prims.push(h('feMerge', {}, [h('feMergeNode', { in: cur })]));
  return h('filter', {
    id, filterUnits: 'userSpaceOnUse', x: f(region.x), y: f(region.y), width: f(region.w), height: f(region.h),
    'color-interpolation-filters': 'sRGB',
  }, prims);
}

export function renderNode(doc: Doc, n: Node, ctx: RenderCtx): Rendered {
  const out: Rendered = { attrs: {}, defs: [], content: [] };
  out.attrs.transform = matrixAttr(n.transform);
  if (n.opacity < 1) out.attrs.opacity = f(n.opacity);
  out.attrs.style = blendStyle(n.blend);
  if (n.type !== 'group') renderShape(doc, n, ctx, out);
  if (n.effects.some(e => e.visible)) {
    const id = `${ctx.ref(n.id)}-fx`;
    const region = expandBox(localBounds(doc, n.id), paintOutset(doc, n) + 4);
    const filter = buildFilter(id, n.effects, region);
    if (filter) { out.defs.push(filter); out.attrs.filter = `url(#${id})`; }
  }
  return out;
}

/** <mask> definition for a Figma-style mask node; `inner` is the mask node's own rendering. */
export function maskDef(doc: Doc, maskNode: Node, id: string, inner: VEl): VEl {
  const b = expandBox(transformBox(maskNode.transform, localBounds(doc, maskNode.id)), paintOutset(doc, maskNode) + 2);
  return h('mask', { id, maskUnits: 'userSpaceOnUse', x: f(b.x), y: f(b.y), width: f(b.w), height: f(b.h), style: maskNode.maskLuminance ? 'mask-type:luminance' : 'mask-type:alpha' }, [inner]);
}

// ---------------------------------------------------------------- full tree (export)

/** Render nodes (with descendants) to a nested virtual tree. Invisible nodes are skipped.
 *  `decorate` lets the caller add attributes (ids) to each node's element. */
export function renderTree(doc: Doc, ids: string[], ctx: RenderCtx, defs: VEl[], decorate?: (n: Node, attrs: Attrs) => void): VEl[] {
  const out: VEl[] = [];
  let target = out;
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n || !n.visible) continue;
    const r = renderNode(doc, n, ctx);
    defs.push(...r.defs);
    const kids = n.type === 'group' ? renderTree(doc, n.children, ctx, defs, decorate) : r.content;
    const el = h('g', r.attrs, kids);
    if (n.mask) {
      const mid = `${ctx.ref(n.id)}-mask`;
      defs.push(maskDef(doc, n, mid, el));
      const wrap = h('g', { mask: `url(#${mid})` }, []);
      target.push(wrap);
      target = wrap.children as VEl[];
      continue;
    }
    decorate?.(n, el.attrs);
    target.push(el);
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;');

/** Collapse `<g attrs><single child/></g>` when the attributes can live on the child. */
export function simplify(el: VEl): VEl {
  const kids = el.children?.map(c => (typeof c === 'string' ? c : simplify(c)));
  let cur: VEl = { tag: el.tag, attrs: el.attrs, children: kids };
  if (cur.tag === 'g' && kids && kids.length === 1 && typeof kids[0] !== 'string') {
    const child = kids[0];
    const mine = Object.entries(cur.attrs).filter(([, v]) => v != null);
    const clash = mine.some(([k]) => child.attrs[k] != null);
    // a filter/mask/opacity on the group must not merge into a <g> child that has its own paint order semantics,
    // but for a leaf they are equivalent
    const safe = child.tag !== 'g' || mine.every(([k]) => k === 'id' || k === 'transform');
    // mask / filter / clip-path are resolved in the user space of the element carrying them,
    // so they cannot move onto a child that establishes its own transform
    const spaceBound = child.attrs.transform != null && mine.some(([k]) => k === 'mask' || k === 'filter' || k === 'clip-path');
    if (!clash && safe && !spaceBound) {
      const theirs = Object.entries(child.attrs).filter(([, v]) => v != null);
      const merged = Object.fromEntries([...mine, ...theirs]);
      // ids read best up front
      cur = { tag: child.tag, attrs: merged.id != null ? { id: merged.id, ...merged } : merged, children: child.children };
    }
  }
  return cur;
}

export function serialize(el: VEl, indent = 0): string {
  const pad = '  '.repeat(indent);
  const attrs = Object.entries(el.attrs).filter(([, v]) => v != null && v !== '').map(([k, v]) => ` ${k}="${escAttr(String(v))}"`).join('');
  const kids = el.children ?? [];
  if (!kids.length) return `${pad}<${el.tag}${attrs}/>`;
  if (kids.every(c => typeof c === 'string')) return `${pad}<${el.tag}${attrs}>${kids.map(c => esc(c as string)).join('')}</${el.tag}>`;
  // text content must not gain whitespace from pretty-printing
  if (el.tag === 'text') return `${pad}<${el.tag}${attrs}>${kids.map(c => (typeof c === 'string' ? esc(c) : serialize(c, 0))).join('')}</${el.tag}>`;
  return `${pad}<${el.tag}${attrs}>\n${kids.map(c => (typeof c === 'string' ? pad + '  ' + esc(c) : serialize(c, indent + 1))).join('\n')}\n${pad}</${el.tag}>`;
}
