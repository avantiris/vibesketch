import type { Box, Color, Doc, GroupNode, Node, PathNode, TextNode } from '../core/model.ts';
import { childrenOf, descendants, isSlice } from '../core/model.ts';
import { mul, translate, union } from '../core/geom.ts';
import { visualBounds, worldMatrix } from '../core/bounds.ts';
import { sortByOrder, topMost } from '../core/ops.ts';
import { PathBuilder } from '../core/path.ts';
import { h, hex, matrixAttr, renderTree, serialize, simplify } from '../core/render.ts';
import type { VEl } from '../core/render.ts';
import { layoutText } from '../core/text.ts';
import { ensureFont, fontVariation, openFont } from '../editor/fonts.ts';

// Export of a page or a set of nodes to SVG / PNG / JPEG / PDF. All formats are produced from
// the same SVG the canvas shows.

export interface ExportOptions {
  /** convert text to vector outlines (no font needed to view the file) */
  outlineText?: boolean;
  /** page background behind the artwork; omitted = transparent */
  background?: Color | null;
  assetUrl: (key: string) => string;
  /** export this region of the page (a slice) instead of the bounds of the exported layers */
  clip?: Box;
  /** prefix for generated ids (when several exports end up in one document) */
  idPrefix?: string;
}

const slug = (s: string) => s.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, '_$1') || 'layer';

function exportRoots(doc: Doc, pageId: string, ids: string[] | null): string[] {
  if (!ids || !ids.length) return childrenOf(doc, pageId).slice();
  return sortByOrder(doc, pageId, topMost(doc, ids));
}

/** whole pixels, never smaller than the region */
function snapOut(b: Box): Box {
  const x = Math.round(b.x), y = Math.round(b.y);
  return { x, y, w: Math.max(1, Math.round(b.x + b.w) - x), h: Math.max(1, Math.round(b.y + b.h) - y) };
}

export function exportBounds(doc: Doc, roots: string[]): Box {
  let b: Box | null = null;
  for (const id of roots) if (doc.nodes[id]?.visible && !isSlice(doc.nodes[id])) b = union(b, visualBounds(doc, id));
  if (!b) return { x: 0, y: 0, w: 1, h: 1 };
  const x = Math.floor(b.x), y = Math.floor(b.y);
  return { x, y, w: Math.max(1, Math.ceil(b.x + b.w) - x), h: Math.max(1, Math.ceil(b.y + b.h) - y) };
}

/** Replace text nodes in the subtrees by outline paths where the font file can be parsed. */
export async function outlineText(doc: Doc, roots: string[]): Promise<Doc> {
  const ids = roots.flatMap(r => [r, ...descendants(doc, r)]).filter(id => doc.nodes[id]?.type === 'text');
  if (!ids.length) return doc;
  const nodes = { ...doc.nodes };
  for (const id of ids) {
    const n = nodes[id] as TextNode;
    await ensureFont(n.font);
    const font = await openFont(n.font);
    if (!font) continue;
    const lay = layoutText(n);
    const scale = n.size / font.unitsPerEm;
    const variation = fontVariation(font, n.font);
    const b = new PathBuilder();
    for (const line of lay.lines) {
      let x = line.x;
      // one glyph per character: opentype.js throws on GSUB features it does not implement,
      // so ligature substitution is skipped in favour of always producing outlines
      const glyphs = [...line.text].map(ch => font.charToGlyph(ch));
      glyphs.forEach((g, i) => {
        // for a variable font this also sets the glyph's advance width for these coordinates
        for (const c of (variation ? g.getPath(x, line.y, n.size, { variation } as never, font) : g.getPath(x, line.y, n.size)).commands) {
          if (c.type === 'M') b.moveTo(c.x, c.y);
          else if (c.type === 'L') b.lineTo(c.x, c.y);
          else if (c.type === 'C') b.cubicTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
          else if (c.type === 'Q') b.quadTo(c.x1, c.y1, c.x, c.y);
          else b.close();
        }
        x += (g.advanceWidth ?? 0) * scale + n.letterSpacing;
        if (glyphs[i + 1]) { try { x += font.getKerningValue(g, glyphs[i + 1]) * scale; } catch { /* unsupported kerning table */ } }
      });
    }
    const { text: _t, font: _f, size: _s, lineHeight: _l, letterSpacing: _ls, align: _a, w: _w, type: _ty, ...rest } = n;
    const p: PathNode = { ...rest, type: 'path', subpaths: b.done(), fillRule: 'nonzero' };
    nodes[id] = p;
  }
  return { ...doc, nodes };
}

async function toDataUrl(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

function usedAssets(doc: Doc, roots: string[]): string[] {
  const out = new Set<string>();
  for (const id of roots.flatMap(r => [r, ...descendants(doc, r)])) {
    const n = doc.nodes[id];
    if (n && n.type !== 'group') for (const p of n.fills) if (p.type === 'image' && p.visible) out.add(p.asset);
  }
  return [...out];
}

export interface SvgResult { svg: string; width: number; height: number; box: Box }

export async function exportSvg(doc: Doc, pageId: string, ids: string[] | null, opts: ExportOptions): Promise<SvgResult> {
  const roots = exportRoots(doc, pageId, ids);
  if (opts.outlineText) doc = await outlineText(doc, roots);
  else for (const id of roots.flatMap(r => [r, ...descendants(doc, r)])) { const n = doc.nodes[id]; if (n?.type === 'text') await ensureFont(n.font); }
  const box = opts.clip ? snapOut(opts.clip) : exportBounds(doc, roots);

  const data = new Map<string, string>();
  await Promise.all(usedAssets(doc, roots).map(async k => { try { data.set(k, await toDataUrl(opts.assetUrl(k))); } catch { /* missing asset: left out */ } }));

  // readable, unique ids derived from layer names
  const names = new Map<string, string>(), taken = new Set<string>();
  const ref = (id: string): string => {
    let s = names.get(id);
    if (!s) {
      const base = (opts.idPrefix ?? '') + slug(doc.nodes[id]?.name ?? 'layer');
      s = base;
      for (let i = 2; taken.has(s); i++) s = `${base}-${i}`;
      taken.add(s);
      names.set(id, s);
    }
    return s;
  };
  const defs: VEl[] = [];
  const ctx = { assetUrl: (k: string) => data.get(k) ?? '', ref };
  const decorate = (n: Node, attrs: Record<string, unknown>) => { attrs.id = ref(n.id); };

  // roots may live in different (transformed) groups: bring each into page space
  const body: VEl[] = [];
  const origin = translate(-box.x, -box.y);
  let run: { parent: string; ids: string[] } | null = null;
  const flush = () => {
    if (!run) return;
    const kids = renderTree(doc, run.ids, ctx, defs, decorate as never);
    const m = mul(origin, worldMatrix(doc, run.parent));
    const t = matrixAttr(m);
    if (t) body.push(h('g', { transform: t }, kids)); else body.push(...kids);
    run = null;
  };
  for (const id of roots) {
    const parent = doc.nodes[id].parent;
    if (run && run.parent !== parent) flush();
    (run ??= { parent, ids: [] }).ids.push(id);
  }
  flush();

  const children: VEl[] = [];
  if (defs.length) children.push(h('defs', {}, defs));
  if (opts.background && opts.background.a > 0) children.push(h('rect', { width: box.w, height: box.h, fill: hex(opts.background), 'fill-opacity': opts.background.a < 1 ? opts.background.a : undefined }));
  children.push(...body.map(simplify));
  const root = h('svg', { xmlns: 'http://www.w3.org/2000/svg', width: box.w, height: box.h, viewBox: `0 0 ${box.w} ${box.h}`, fill: 'none' }, children);
  return { svg: serialize(root) + '\n', width: box.w, height: box.h, box };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('could not rasterize the SVG'));
    img.src = url;
  });
}

const MAX_SIDE = 16384;

export async function exportRaster(doc: Doc, pageId: string, ids: string[] | null, format: 'png' | 'jpeg', scale: number, opts: ExportOptions): Promise<Blob> {
  // outlines make the result independent of what fonts the rasterizer can see
  const bg = format === 'jpeg' ? (opts.background && opts.background.a > 0 ? { ...opts.background, a: 1 } : { r: 1, g: 1, b: 1, a: 1 }) : opts.background;
  const r = await exportSvg(doc, pageId, ids, { ...opts, outlineText: true, background: bg });
  const s = Math.min(scale, MAX_SIDE / r.width, MAX_SIDE / r.height);
  const url = URL.createObjectURL(new Blob([r.svg], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(r.width * s));
    canvas.height = Math.max(1, Math.round(r.height * s));
    const c = canvas.getContext('2d')!;
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('encoding failed'))), `image/${format}`, 0.92));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** true when the subtree uses something PDF vector output can't express */
function needsRaster(doc: Doc, id: string): boolean {
  return [id, ...descendants(doc, id)].some(i => {
    const n = doc.nodes[i];
    if (!n || !n.visible) return false;
    if (n.mask || n.blend !== 'normal' || n.effects.some(e => e.visible)) return true;
    return n.type !== 'group' && [...n.fills, ...n.strokes].some(p => p.visible && ((p.blend && p.blend !== 'normal') || (p.type === 'image' && p.mode === 'tile')));
  });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

/** Vector PDF. Layers with effects, masks or blend modes are embedded as 3x images, since
 *  PDF output has no equivalent for SVG filters. */
export async function exportPdf(doc: Doc, pageId: string, ids: string[] | null, opts: ExportOptions): Promise<{ blob: Blob; rasterized: number }> {
  const top = exportRoots(doc, pageId, ids).filter(id => doc.nodes[id].visible);
  const box = opts.clip ? snapOut(opts.clip) : exportBounds(doc, top);
  opts = { ...opts, clip: undefined }; // the parts below are placed by their own bounds
  // rasterize as little as possible: open up plain groups so only the layers that really
  // need it (and what they mask) become images
  const roots: string[] = [];
  const expand = (id: string) => {
    const n = doc.nodes[id];
    if (!n || !n.visible) return;
    const plain = n.type === 'group' && !n.mask && n.blend === 'normal' && n.opacity === 1 && !n.effects.some(e => e.visible) && !n.children.some(c => doc.nodes[c]?.mask);
    if (plain && needsRaster(doc, id)) (n as GroupNode).children.forEach(expand); else roots.push(id);
  };
  top.forEach(expand);
  const [{ jsPDF }, { svg2pdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const k = 0.75; // px -> pt
  const pdf = new jsPDF({ unit: 'pt', format: [box.w * k, box.h * k], orientation: box.w > box.h ? 'landscape' : 'portrait', compress: true });
  let rasterized = 0;

  const parts: string[] = [];
  const bg = opts.background && opts.background.a > 0 ? `<rect width="${box.w}" height="${box.h}" fill="${hex(opts.background)}"/>` : '';
  // consecutive vector layers are exported together, raster layers one by one, keeping z-order
  let vec: string[] = [];
  const flushVec = async () => {
    if (!vec.length) return;
    const r = await exportSvg(doc, pageId, vec, { ...opts, outlineText: true, background: null, idPrefix: `p${parts.length}-` });
    const inner = r.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    parts.push(`<g transform="translate(${r.box.x - box.x} ${r.box.y - box.y})">${inner}</g>`);
    vec = [];
  };
  for (const id of roots) {
    if (!needsRaster(doc, id)) { vec.push(id); continue; }
    await flushVec();
    const b = exportBounds(doc, [id]);
    const png = await exportRaster(doc, pageId, [id], 'png', 3, { ...opts, background: null });
    parts.push(`<image x="${b.x - box.x}" y="${b.y - box.y}" width="${b.w}" height="${b.h}" href="${await blobToDataUrl(png)}"/>`);
    rasterized++;
  }
  await flushVec();
  const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${box.w}" height="${box.h}" viewBox="0 0 ${box.w} ${box.h}">${bg}${parts.join('')}</svg>`;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden';
  host.innerHTML = svgText;
  document.body.append(host);
  try {
    await svg2pdf(host.firstElementChild as Element, pdf, { x: 0, y: 0, width: box.w * k, height: box.h * k });
  } finally {
    host.remove();
  }
  return { blob: pdf.output('blob'), rasterized };
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
