// Figma .fig importer: decodes the file and maps it onto our plain vector model.
//
// Frames, components, instances, sections and groups all become plain groups (no auto-layout,
// no prototyping). Geometry is imported in its *editable* form (rect / ellipse / star / vector
// network chains) whenever that renders exactly like Figma's pre-computed `fillGeometry`, and
// falls back to the pre-computed outlines otherwise: rendering fidelity beats editability.

import type {
  AssetMeta, BlendMode, Color, Doc, Effect, GroupNode, Mat, Node, Paint, PathNode, ShapeBase,
  ShapeNode, SubPath, TextNode, Vec,
} from '../core/model.ts';
import { groupDefaults, newId, repairDoc, shapeDefaults } from '../core/model.ts';
import { invert, mul, round } from '../core/geom.ts';
import { nodeSubpaths } from '../core/path.ts';
import { readFigContainer } from './fig/kiwi.ts';
import { matchFill, networkToSubpaths, parseCommandsBlob, parseVectorNetwork } from './fig/geometry.ts';
import type { NetworkChains, VectorNetwork } from './fig/geometry.ts';
import { sha256Hex, sniffImage, toHex } from './fig/image.ts';
import type { FigColor, FigEffect, FigGeometry, FigGuid, FigMatrix, FigNode, FigPaint } from './fig/types.ts';

export interface ImportedAsset { bytes: Uint8Array; meta: AssetMeta }
export interface FigImport { doc: Doc; assets: Map<string, ImportedAsset>; warnings: string[] }

// ---------------------------------------------------------------- small helpers

const gid = (g: FigGuid | undefined): string => (g ? `${g.sessionID}:${g.localID}` : '');
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const r4 = (v: number): number => round(v, 4);
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const color = (c: FigColor | undefined, alphaScale = 1): Color => ({
  r: r4(clamp01(num(c?.r))), g: r4(clamp01(num(c?.g))), b: r4(clamp01(num(c?.b))), a: r4(clamp01(num(c?.a, 1) * alphaScale)),
});

/** Figma row-major [[m00 m01 m02],[m10 m11 m12]] -> our column order [a b c d e f] */
function mat(t: FigMatrix | undefined): Mat {
  if (!t) return [1, 0, 0, 1, 0, 0];
  const m: Mat = [num(t.m00, 1), num(t.m10), num(t.m01), num(t.m11, 1), num(t.m02), num(t.m12)];
  return [round(m[0], 7), round(m[1], 7), round(m[2], 7), round(m[3], 7), r4(m[4]), r4(m[5])];
}

function roundSubpaths(sps: SubPath[]): SubPath[] {
  const v = (p: Vec | null): Vec | null => (p ? { x: r4(p.x), y: r4(p.y) } : null);
  return sps.map(sp => ({ closed: sp.closed, pts: sp.pts.map(p => ({ x: r4(p.x), y: r4(p.y), in: v(p.in), out: v(p.out), mode: p.mode })) }));
}

const BLEND: Record<string, BlendMode> = {
  PASS_THROUGH: 'normal', NORMAL: 'normal', DARKEN: 'darken', MULTIPLY: 'multiply', COLOR_BURN: 'color-burn',
  LIGHTEN: 'lighten', SCREEN: 'screen', COLOR_DODGE: 'color-dodge', OVERLAY: 'overlay', SOFT_LIGHT: 'soft-light',
  HARD_LIGHT: 'hard-light', DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue', SATURATION: 'saturation',
  COLOR: 'color', LUMINOSITY: 'luminosity',
  // no CSS/SVG equivalent: closest relatives
  LINEAR_BURN: 'color-burn', LINEAR_DODGE: 'color-dodge',
};

const FRAME_TYPES = new Set(['FRAME', 'GROUP', 'SECTION', 'SYMBOL', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET']);
const SKIPPED_NAMES: Record<string, string> = {
  SLICE: 'export slice', STICKY: 'sticky note', CONNECTOR: 'connector', WIDGET: 'widget', CODE_BLOCK: 'code block',
  SHAPE_WITH_TEXT: 'FigJam shape', STAMP: 'stamp', MEDIA: 'media', HIGHLIGHT: 'highlight', WASHI_TAPE: 'washi tape',
  TABLE: 'table', TABLE_CELL: 'table cell', TEXT_PATH: 'text on a path', SECTION_OVERLAY: 'section overlay',
};
/** bookkeeping nodes that are never visible layers */
const SILENT_TYPES = new Set(['NONE', 'VARIABLE', 'VARIABLE_SET', 'VARIABLE_OVERRIDE', 'BRUSH', 'CODE_LIBRARY', 'CODE_FILE', 'MANAGED_STRING', 'MODULE']);

const WEIGHTS: [string, number][] = [
  ['extralight', 200], ['ultralight', 200], ['semibold', 600], ['demibold', 600], ['extrabold', 800], ['ultrabold', 800],
  ['extrablack', 900], ['ultrablack', 900], ['hairline', 100], ['thin', 100], ['light', 300], ['regular', 400], ['normal', 400],
  ['book', 400], ['roman', 400], ['medium', 500], ['demi', 600], ['bold', 700], ['black', 900], ['heavy', 900],
];

export function parseFontStyle(style: string | undefined): { weight: number; italic: boolean } {
  const s = (style ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  const italic = s.includes('italic') || s.includes('oblique');
  for (const [name, weight] of WEIGHTS) if (s.includes(name)) return { weight, italic };
  return { weight: 400, italic };
}

// ---------------------------------------------------------------- importer

interface Geo { subpaths: SubPath[]; evenOdd: boolean; styleID: number }

class Importer {
  doc: Doc = { version: 1, pages: [], nodes: {}, assets: {}, fonts: [] };
  assets = new Map<string, ImportedAsset>();
  private warned = new Map<string, number>();
  private byId = new Map<string, FigNode>();
  private kids = new Map<string, FigNode[]>();
  private blobs: ({ bytes?: Uint8Array } | undefined)[];
  private nodes: FigNode[];
  /** figma image hash (hex) -> asset key, or null when the blob is missing / not an image */
  private imageKeys: Map<string, string | null>;
  private imagePool: Map<string, ImportedAsset>;

  constructor(nodes: FigNode[], blobs: ({ bytes?: Uint8Array } | undefined)[], imageKeys: Map<string, string | null>, imagePool: Map<string, ImportedAsset>) {
    this.nodes = nodes;
    this.blobs = blobs;
    this.imageKeys = imageKeys;
    this.imagePool = imagePool;
    for (const n of nodes) {
      if (!n.guid || n.phase === 'REMOVED') continue;
      this.byId.set(gid(n.guid), n);
    }
    for (const n of this.byId.values()) {
      const p = gid(n.parentIndex?.guid);
      if (!p) continue;
      let list = this.kids.get(p);
      if (!list) this.kids.set(p, (list = []));
      list.push(n);
    }
    // fractional-index strings order siblings; plain code unit comparison, bottom first
    const pos = (n: FigNode): string => n.parentIndex?.position ?? '';
    for (const list of this.kids.values()) list.sort((a, b) => (pos(a) < pos(b) ? -1 : pos(a) > pos(b) ? 1 : 0));
  }

  warn(msg: string): void {
    this.warned.set(msg, (this.warned.get(msg) ?? 0) + 1);
  }

  warnings(): string[] {
    return [...this.warned].map(([m, n]) => (n > 1 ? `${m} (×${n})` : m));
  }

  run(): void {
    const root = this.nodes.find(n => n.type === 'DOCUMENT' && n.phase !== 'REMOVED');
    const canvases = root ? this.children(root) : [...this.byId.values()].filter(n => n.type === 'CANVAS');
    for (const c of canvases) {
      if (c.type !== 'CANVAS' || c.internalOnly) continue;
      const page = { id: newId(), name: c.name || `Page ${this.doc.pages.length + 1}`, children: [] as string[], background: color(c.backgroundColor ?? { r: 0.96, g: 0.96, b: 0.96, a: 1 }) };
      page.background.a = 1;
      this.doc.pages.push(page);
      for (const k of this.children(c)) {
        const id = this.convert(k, page.id, []);
        if (id) page.children.push(id);
      }
    }
    if (!this.doc.pages.length) throw new Error('The .fig file contains no pages');
  }

  private children(n: FigNode): FigNode[] {
    return this.kids.get(gid(n.guid)) ?? [];
  }

  // -------------------------------------------------------------- node dispatch

  private add<T extends Node>(n: T): string {
    this.doc.nodes[n.id] = n;
    return n.id;
  }

  /** common NodeBase fields */
  private base(n: FigNode, parent: string): { id: string; name: string; parent: string; visible: boolean; locked: boolean; opacity: number; blend: BlendMode; transform: Mat; effects: Effect[]; mask?: boolean } {
    const out: ReturnType<Importer['base']> = {
      id: newId(), name: n.name ?? n.type ?? 'Layer', parent,
      visible: n.visible !== false, locked: n.locked === true, opacity: r4(clamp01(num(n.opacity, 1))),
      blend: this.blend(n.blendMode), transform: mat(n.transform), effects: this.effects(n.effects),
    };
    if (n.mask) {
      out.mask = true;
      if (n.maskType && n.maskType !== 'ALPHA') this.warn(`${n.maskType === 'LUMINANCE' ? 'Luminance' : 'Outline'} masks are imported as alpha masks`);
    }
    return out;
  }

  private blend(b: string | undefined): BlendMode {
    if (!b) return 'normal';
    if (b === 'LINEAR_BURN' || b === 'LINEAR_DODGE') this.warn(`Blend mode ${b === 'LINEAR_BURN' ? '"Plus darker"' : '"Plus lighter"'} is approximated by ${BLEND[b]}`);
    return BLEND[b] ?? 'normal';
  }

  private convert(n: FigNode, parent: string, symStack: string[]): string | null {
    const type = n.type ?? 'NONE';
    if (FRAME_TYPES.has(type)) return this.convertFrame(n, parent, symStack);
    switch (type) {
      case 'RECTANGLE': case 'ROUNDED_RECTANGLE': case 'ELLIPSE': case 'REGULAR_POLYGON': case 'STAR':
        return this.convertPrimitive(n, parent);
      case 'LINE': return this.convertLine(n, parent);
      case 'VECTOR': return this.convertVector(n, parent);
      case 'BOOLEAN_OPERATION': return this.convertOutlineOnly(n, parent);
      case 'TEXT': return this.convertText(n, parent);
    }
    if (!SILENT_TYPES.has(type)) {
      const what = SKIPPED_NAMES[type] ?? `"${type}" layer`;
      this.warn(`Skipped ${what} (not supported)`);
    }
    return null;
  }

  // -------------------------------------------------------------- frames & groups

  private convertFrame(n: FigNode, parent: string, symStack: string[]): string {
    const g: GroupNode = { ...groupDefaults(), ...this.base(n, parent) };
    const w = num(n.size?.x), h = num(n.size?.y);
    const isGroup = n.resizeToFit === true || n.type === 'GROUP';
    const radii = this.radii(n);

    // frame fill / stroke -> a rect at the bottom of the group
    const fills = isGroup ? [] : this.paints(n.fillPaints ?? n.backgroundPaints, w, h);
    const strokes = isGroup ? [] : this.paints(n.strokePaints, w, h);
    const strokeWeight = this.strokeWeight(n);
    if (fills.some(p => p.visible) || (strokes.some(p => p.visible) && strokeWeight > 0)) {
      g.children.push(this.add({
        ...shapeDefaults(), ...this.strokeProps(n), id: newId(), name: `${g.name} background`, parent: g.id,
        type: 'rect', w: r4(w), h: r4(h), radii, fills, strokes,
      }));
    }
    // Frames clip unless `frameMaskDisabled`; groups (`resizeToFit`) and sections never do.
    const clips = !isGroup && n.type !== 'SECTION' && n.frameMaskDisabled !== true && w > 0 && h > 0;
    if (clips) {
      g.children.push(this.add({
        ...shapeDefaults(), id: newId(), name: `${g.name} clip`, parent: g.id, mask: true,
        type: 'rect', w: r4(w), h: r4(h), radii, fills: [{ type: 'solid', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }],
      }));
    }

    let kids = this.children(n);
    let stack = symStack;
    if (n.type === 'INSTANCE' && !kids.length) {
      // children of an instance live in its master component; clone that subtree as-is
      const sym = gid(n.symbolData?.symbolID);
      const master = this.byId.get(sym);
      if (!master) this.warn('Component instance whose main component is not in the file was imported empty');
      else if (symStack.includes(sym)) this.warn('Recursive component instance was imported empty');
      else {
        kids = this.children(master);
        stack = [...symStack, sym];
        if (n.symbolData?.symbolOverrides?.length) this.warn('Component instance overrides are ignored (instances show their main component)');
        const mw = num(master.size?.x), mh = num(master.size?.y);
        if (Math.abs(mw - w) > 0.01 || Math.abs(mh - h) > 0.01) this.warn('Resized component instances keep the layout of their main component');
      }
    }
    for (const k of kids) {
      const id = this.convert(k, g.id, stack);
      if (id) g.children.push(id);
    }
    return this.add(g);
  }

  private radii(n: FigNode): [number, number, number, number] {
    const c = Math.max(0, num(n.cornerRadius));
    const pick = (v: number | undefined): number => r4(Math.max(0, num(v, c)));
    return [pick(n.rectangleTopLeftCornerRadius), pick(n.rectangleTopRightCornerRadius), pick(n.rectangleBottomRightCornerRadius), pick(n.rectangleBottomLeftCornerRadius)];
  }

  // -------------------------------------------------------------- strokes

  private strokeWeight(n: FigNode): number {
    let w = Math.max(0, num(n.strokeWeight));
    if (n.borderStrokeWeightsIndependent) {
      const sides = [n.borderTopWeight, n.borderRightWeight, n.borderBottomWeight, n.borderLeftWeight].map(v => num(v, w));
      if (sides.some(s => Math.abs(s - sides[0]) > 1e-6)) {
        this.warn('Per-side stroke weights are not supported; the largest one is used on all sides');
      }
      w = Math.max(...sides);
    }
    return r4(w);
  }

  private strokeProps(n: FigNode, cap?: string): Pick<ShapeBase, 'strokeWeight' | 'strokeAlign' | 'strokeCap' | 'strokeJoin' | 'dash'> {
    const c = cap ?? n.strokeCap ?? 'NONE';
    let strokeCap: ShapeBase['strokeCap'] = 'butt';
    if (c === 'ROUND') strokeCap = 'round';
    else if (c === 'SQUARE') strokeCap = 'square';
    else if (c !== 'NONE') this.warn('Arrow heads and other decorative stroke caps are not supported (imported as plain ends)');
    return {
      strokeWeight: this.strokeWeight(n),
      strokeAlign: n.strokeAlign === 'INSIDE' ? 'inside' : n.strokeAlign === 'OUTSIDE' ? 'outside' : 'center',
      strokeCap,
      strokeJoin: n.strokeJoin === 'ROUND' ? 'round' : n.strokeJoin === 'BEVEL' ? 'bevel' : 'miter',
      dash: (n.dashPattern ?? []).map(v => r4(Math.max(0, num(v)))),
    };
  }

  // -------------------------------------------------------------- paints

  private paints(list: FigPaint[] | undefined, w: number, h: number): Paint[] {
    const out: Paint[] = [];
    for (const p of list ?? []) {
      const base = { visible: p.visible !== false, opacity: r4(clamp01(num(p.opacity, 1))) };
      const blend = p.blendMode && p.blendMode !== 'NORMAL' && p.blendMode !== 'PASS_THROUGH' ? { blend: this.blend(p.blendMode) } : {};
      switch (p.type) {
        case 'SOLID':
          out.push({ type: 'solid', color: color(p.color), ...base, ...blend });
          break;
        case 'GRADIENT_LINEAR': case 'GRADIENT_RADIAL': case 'GRADIENT_ANGULAR': case 'GRADIENT_DIAMOND': {
          const stops = (p.stops ?? []).map(s => ({ offset: r4(clamp01(num(s.position))), color: color(s.color) }));
          if (!stops.length) break;
          stops.sort((a, b) => a.offset - b.offset);
          // paint.transform maps the node's normalized box into gradient space; we need the inverse
          const inv = invert(mat2(p.transform));
          const at = (x: number, y: number): Vec => ({ x: inv[0] * x + inv[2] * y + inv[4], y: inv[1] * x + inv[3] * y + inv[5] });
          const r6 = (v: Vec): Vec => ({ x: round(v.x, 6), y: round(v.y, 6) });
          if (p.type === 'GRADIENT_LINEAR') {
            out.push({ type: 'gradient', kind: 'linear', stops, from: r6(at(0, 0.5)), to: r6(at(1, 0.5)), width: 1, ...base, ...blend });
          } else {
            if (p.type === 'GRADIENT_ANGULAR') this.warn('Angular gradients are approximated by radial gradients');
            if (p.type === 'GRADIENT_DIAMOND') this.warn('Diamond gradients are approximated by radial gradients');
            const c = at(0.5, 0.5), to = at(1, 0.5), perp = at(0.5, 1);
            // the renderer measures `width` in pixel space, so scale by the node size first
            const major = Math.hypot((to.x - c.x) * w, (to.y - c.y) * h), minor = Math.hypot((perp.x - c.x) * w, (perp.y - c.y) * h);
            const width = major > 1e-9 && Number.isFinite(minor / major) ? round(minor / major, 6) : 1;
            out.push({ type: 'gradient', kind: 'radial', stops, from: r6(c), to: r6(to), width, ...base, ...blend });
          }
          break;
        }
        case 'IMAGE': {
          const hash = p.image?.hash?.length ? toHex(p.image.hash) : '';
          const key = this.imageKeys.get(hash);
          if (!key) { this.warn('Image fill whose image data is missing from the file was dropped'); break; }
          const asset = this.imagePool.get(key)!;
          if (!this.assets.has(key)) {
            const meta = { ...asset.meta };
            if (p.image?.name) meta.name = p.image.name;
            this.assets.set(key, { bytes: asset.bytes, meta });
            this.doc.assets[key] = meta;
          }
          const mode = p.imageScaleMode === 'FIT' ? 'fit' : p.imageScaleMode === 'TILE' ? 'tile' : p.imageScaleMode === 'STRETCH' ? 'stretch' : 'fill';
          const t = p.transform;
          if (mode === 'stretch' && t && (Math.abs(t.m00 - 1) > 1e-4 || Math.abs(t.m11 - 1) > 1e-4 || Math.abs(t.m01) > 1e-4 || Math.abs(t.m10) > 1e-4 || Math.abs(t.m02) > 1e-4 || Math.abs(t.m12) > 1e-4)) {
            this.warn('Cropped image fills are imported uncropped (stretched over the layer)');
          }
          if (num(p.rotation) !== 0) this.warn('Rotated image fills are imported unrotated');
          const img: Paint = { type: 'image', asset: key, mode, ...base, ...blend };
          if (mode === 'tile') img.scale = round(num(p.scale, 1) || 1, 6);
          out.push(img);
          break;
        }
        default:
          this.warn(`Unsupported ${String(p.type ?? 'unknown').toLowerCase()} paint was dropped`);
      }
    }
    return out;
  }

  // -------------------------------------------------------------- effects

  private effects(list: FigEffect[] | undefined): Effect[] {
    const out: Effect[] = [];
    for (const e of list ?? []) {
      const visible = e.visible !== false;
      const radius = r4(Math.max(0, num(e.radius)));
      const size = (): number => r4(Math.max(0, typeof e.noiseSize === 'number' ? e.noiseSize : num(e.noiseSize?.x, 1)));
      switch (e.type) {
        case 'DROP_SHADOW': case 'INNER_SHADOW':
          out.push({ type: e.type === 'DROP_SHADOW' ? 'drop-shadow' : 'inner-shadow', visible, color: color(e.color), x: r4(num(e.offset?.x)), y: r4(num(e.offset?.y)), blur: radius, spread: r4(num(e.spread)) });
          break;
        case 'FOREGROUND_BLUR': case 'BACKGROUND_BLUR':
          if (e.blurOpType === 'PROGRESSIVE') this.warn('Progressive blurs are imported as uniform blurs');
          out.push({ type: e.type === 'FOREGROUND_BLUR' ? 'layer-blur' : 'background-blur', visible, blur: radius });
          break;
        case 'NOISE': {
          // mono: `color`; duo: `color` + `secondaryColor`; multi: coloured grains at `opacity`
          let c = color(e.color);
          if (e.noiseType === 'MULTITONE') {
            c = { r: 0.5, g: 0.5, b: 0.5, a: r4(clamp01(num(e.opacity, 1))) };
            this.warn('Multi-tone noise effects are imported as single-colour noise');
          } else if (e.noiseType === 'DUOTONE') this.warn('Duo-tone noise effects are imported as single-colour noise');
          out.push({ type: 'noise', visible, size: size(), density: r4(clamp01(num(e.density, 1))), color: c });
          break;
        }
        case 'GRAIN': // Figma's "Texture" effect
          out.push({ type: 'texture', visible, size: size(), radius });
          break;
        default:
          this.warn(`Unsupported "${String(e.type ?? 'unknown').toLowerCase().replace(/_/g, ' ')}" effect was dropped`);
      }
    }
    return out;
  }

  // -------------------------------------------------------------- geometry

  private geometry(list: FigGeometry[] | undefined): Geo[] {
    const out: Geo[] = [];
    for (const g of list ?? []) {
      const blob = typeof g.commandsBlob === 'number' ? this.blobs[g.commandsBlob]?.bytes : undefined;
      const sps = blob ? parseCommandsBlob(blob) : null;
      if (!sps) { this.warn('Unreadable geometry data was skipped'); continue; }
      if (sps.length) out.push({ subpaths: sps, evenOdd: g.windingRule === 'ODD', styleID: num(g.styleID) });
    }
    return out;
  }

  private shapeBase(n: FigNode, parent: string, cap?: string): Omit<ShapeBase, 'fills' | 'strokes'> {
    return { ...shapeDefaults(), ...this.base(n, parent), ...this.strokeProps(n, cap) };
  }

  private static tol(n: FigNode): number {
    return 0.02 + 0.00005 * Math.hypot(num(n.size?.x), num(n.size?.y));
  }

  /** rect / ellipse / polygon / star, verified against Figma's own outline */
  private convertPrimitive(n: FigNode, parent: string): string | null {
    const w = num(n.size?.x), h = num(n.size?.y);
    const sb = { ...this.shapeBase(n, parent), fills: this.paints(n.fillPaints, w, h), strokes: this.paints(n.strokePaints, w, h) };
    let node: ShapeNode;
    let exact = true;
    switch (n.type) {
      case 'ELLIPSE': {
        const a = n.arcData;
        if (a && (Math.abs(Math.abs(num(a.endingAngle, 2 * Math.PI) - num(a.startingAngle)) - 2 * Math.PI) > 1e-4 || num(a.innerRadius) > 1e-6)) exact = false;
        node = { ...sb, type: 'ellipse', w: r4(w), h: r4(h) };
        break;
      }
      case 'REGULAR_POLYGON':
        node = { ...sb, type: 'polygon', w: r4(w), h: r4(h), sides: Math.max(3, Math.round(num(n.count, 3))) };
        break;
      case 'STAR':
        node = { ...sb, type: 'star', w: r4(w), h: r4(h), points: Math.max(3, Math.round(num(n.count, 5))), inner: round(clamp01(num(n.starInnerScale, 0.382)), 6) };
        break;
      default:
        node = { ...sb, type: 'rect', w: r4(w), h: r4(h), radii: this.radii(n) };
    }
    const fg = this.geometry(n.fillGeometry);
    if (fg.length) {
      if (exact) exact = fg.length === 1 && matchFill(nodeSubpaths(node), fg[0].subpaths, Importer.tol(n)) !== null;
      if (!exact) return this.outlineNode(n, parent, fg, this.geometry(n.strokeGeometry), true);
    }
    return this.add(node);
  }

  private convertLine(n: FigNode, parent: string): string {
    const w = num(n.size?.x), h = num(n.size?.y);
    const node: PathNode = {
      ...this.shapeBase(n, parent), fills: [], strokes: this.paints(n.strokePaints, w, h), type: 'path', fillRule: 'nonzero',
      subpaths: [{ closed: false, pts: [{ x: 0, y: 0, in: null, out: null, mode: 'corner' }, { x: r4(w), y: 0, in: null, out: null, mode: 'corner' }] }],
    };
    // lines have no inside/outside
    node.strokeAlign = 'center';
    return this.add(node);
  }

  /** boolean operations: Figma stores the computed result, which is all we keep */
  private convertOutlineOnly(n: FigNode, parent: string): string | null {
    const fg = this.geometry(n.fillGeometry), sg = this.geometry(n.strokeGeometry);
    if (!fg.length && !sg.length) {
      this.warn('Boolean operation without computed geometry was skipped');
      return null;
    }
    return this.outlineNode(n, parent, fg, sg, true);
  }

  private pathNode(sb: Omit<ShapeBase, 'fills' | 'strokes'>, subpaths: SubPath[], evenOdd: boolean, fills: Paint[], strokes: Paint[]): PathNode {
    return { ...sb, fills, strokes, type: 'path', subpaths: roundSubpaths(subpaths), fillRule: evenOdd ? 'evenodd' : 'nonzero' };
  }

  private hasVisibleStroke(n: FigNode): boolean {
    return this.strokeWeight(n) > 0 && (n.strokePaints ?? []).some(p => p.visible !== false && num(p.opacity, 1) > 0);
  }

  /** Build the node from Figma's pre-computed outlines.
   *  `strokeOnFill`: the stroke runs along the fill outline (closed shapes), so the fill path can
   *  carry the stroke itself; otherwise the stroke outline becomes a filled path of its own. */
  private outlineNode(n: FigNode, parent: string, fg: Geo[], sg: Geo[], strokeOnFill: boolean, strokeChains?: SubPath[]): string | null {
    const w = num(n.size?.x), h = num(n.size?.y);
    const overrides = new Map<number, FigNode>();
    for (const o of n.vectorData?.styleOverrideTable ?? []) if (typeof o.styleID === 'number') overrides.set(o.styleID, o);
    const stroked = this.hasVisibleStroke(n);
    const strokePaints = this.paints(n.strokePaints, w, h);
    const parts: { subpaths: SubPath[]; evenOdd: boolean; fills: Paint[]; strokes: Paint[]; kind: string }[] = [];

    for (const g of fg) {
      const fills = this.paints(overrides.get(g.styleID)?.fillPaints ?? n.fillPaints, w, h);
      parts.push({ subpaths: g.subpaths, evenOdd: g.evenOdd, fills, strokes: [], kind: 'fill' });
    }
    if (strokeOnFill && parts.length === 1) parts[0].strokes = strokePaints;
    else if (stroked && strokeChains) parts.push({ subpaths: strokeChains, evenOdd: false, fills: [], strokes: strokePaints, kind: 'stroke' });
    else if (stroked && sg.length) {
      // strokeGeometry is the outline of the stroke as if it were centered
      if (n.strokeAlign === 'INSIDE' || n.strokeAlign === 'OUTSIDE') this.warn('Inside/outside strokes on complex vector shapes are imported as centered stroke outlines');
      else this.warn('Strokes on complex vector shapes (brushes, branching paths, rounded open paths) were converted to filled outlines');
      for (const g of sg) parts.push({ subpaths: g.subpaths, evenOdd: g.evenOdd, fills: strokePaints, strokes: [], kind: 'outline' });
    }
    if (!parts.length) return null;

    if (parts.length === 1) {
      const p = parts[0];
      const node = this.pathNode(this.shapeBase(n, parent), p.subpaths, p.evenOdd, p.fills, p.strokes);
      if (p.kind === 'outline') node.strokeWeight = 0;
      return this.add(node);
    }
    // several paths: wrap them in a group that carries the layer-level properties
    const g: GroupNode = { ...groupDefaults(), ...this.base(n, parent) };
    for (const p of parts) {
      const sb: Omit<ShapeBase, 'fills' | 'strokes'> = { ...shapeDefaults(), ...this.strokeProps(n), id: newId(), name: `${g.name} ${p.kind}`, parent: g.id };
      const node = this.pathNode(sb, p.subpaths, p.evenOdd, p.fills, p.strokes);
      if (p.kind !== 'stroke' && !p.strokes.length) node.strokeWeight = 0;
      g.children.push(this.add(node));
    }
    return this.add(g);
  }

  // -------------------------------------------------------------- vectors

  private convertVector(n: FigNode, parent: string): string | null {
    const w = num(n.size?.x), h = num(n.size?.y);
    const fg = this.geometry(n.fillGeometry), sg = this.geometry(n.strokeGeometry);
    const stroked = this.hasVisibleStroke(n);
    const filled = fg.length > 0 && (n.fillPaints ?? []).some(p => p.visible !== false);

    let net: VectorNetwork | null = null;
    const vd = n.vectorData;
    const blob = typeof vd?.vectorNetworkBlob === 'number' ? this.blobs[vd.vectorNetworkBlob]?.bytes : undefined;
    if (blob) {
      // network coordinates live in normalizedSize space
      const ns = vd?.normalizedSize;
      const sx = ns && num(ns.x) > 1e-9 ? w / ns.x : 1, sy = ns && num(ns.y) > 1e-9 ? h / ns.y : 1;
      net = parseVectorNetwork(blob, sx, sy);
      if (!net) this.warn('Unreadable vector network; the pre-computed outline is used instead');
    }
    const chains: NetworkChains | null = net && net.segments.length ? networkToSubpaths(net) : null;
    if (!chains) {
      if (!fg.length && !sg.length) return null; // an empty vector layer
      return this.outlineNode(n, parent, fg, sg, false);
    }

    const overrides = new Map<number, FigNode>();
    for (const o of vd?.styleOverrideTable ?? []) if (typeof o.styleID === 'number') overrides.set(o.styleID, o);
    const brushed = n.strokeBrushGuid !== undefined && n.strokeBrushGuid !== null;
    const rounded = this.hasRoundedCorners(n, net!, overrides);
    const regionPaints = fg.some(g => overrides.get(g.styleID)?.fillPaints !== undefined);
    const allClosed = chains.subpaths.every(sp => sp.closed);
    const cap = this.endCap(n, net!, chains, overrides);
    // the chained network strokes exactly like Figma when nothing rewrites its outline
    const strokeExact = !chains.branching && !rounded && !brushed;

    // The chains are the outline Figma paints as long as nothing rewrites it (corner rounding,
    // junctions) and, if there is a stroke, it is a plain one.
    if (!chains.branching && !rounded && (strokeExact || !stroked)) {
      const strokes = this.paints(n.strokePaints, w, h);
      if (fg.length === 1 && !regionPaints) {
        // same picture as Figma's fill outline? then keep the editable network (wound the same way)
        const m = matchFill(chains.subpaths, fg[0].subpaths, Importer.tol(n));
        if (m) return this.add(this.pathNode(this.shapeBase(n, parent, cap), m.subpaths, fg[0].evenOdd, this.paints(n.fillPaints, w, h), strokes));
      }
      if (!filled) {
        // Nothing is filled in Figma. That includes open paths that merely *have* a fill paint
        // (Figma computes no fillGeometry for them), so the fill paints must go or we would
        // fill what Figma leaves empty.
        return this.add(this.pathNode(this.shapeBase(n, parent, cap), chains.subpaths, false, [], strokes));
      }
    }
    // Not representable as one editable path: fall back to Figma's outlines.
    if (fg.length === 1 && allClosed && !chains.branching && !brushed) {
      // rounded closed shapes: the stroke follows the (rounded) fill outline
      return this.outlineNode(n, parent, fg, sg, true);
    }
    return this.outlineNode(n, parent, fg, sg, false, strokeExact ? chains.subpaths : undefined);
  }

  /** does a corner radius actually round a vertex of this network? */
  private hasRoundedCorners(n: FigNode, net: VectorNetwork, overrides: Map<number, FigNode>): boolean {
    const nodeR = num(n.cornerRadius);
    if (nodeR <= 0 && ![...overrides.values()].some(o => num(o.cornerRadius) > 0)) return false;
    const deg = net.vertices.map(() => 0);
    const dirs: Vec[][] = net.vertices.map(() => []);
    for (const s of net.segments) {
      deg[s.a]++; deg[s.b]++;
      const a = net.vertices[s.a], b = net.vertices[s.b];
      const nz = (v: Vec): boolean => Math.abs(v.x) > 1e-6 || Math.abs(v.y) > 1e-6;
      dirs[s.a].push(nz(s.ta) ? s.ta : { x: b.x - a.x, y: b.y - a.y });
      dirs[s.b].push(nz(s.tb) ? s.tb : { x: a.x - b.x, y: a.y - b.y });
    }
    return net.vertices.some((v, i) => {
      const o = overrides.get(v.styleID);
      const r = o && typeof o.cornerRadius === 'number' ? o.cornerRadius : nodeR;
      if (r <= 0 || deg[i] < 2) return false;
      if (deg[i] > 2) return true;
      // a smooth pass-through vertex has nothing to round
      const [p, q] = dirs[i];
      const lp = Math.hypot(p.x, p.y), lq = Math.hypot(q.x, q.y);
      if (lp < 1e-9 || lq < 1e-9) return true;
      const cross = (p.x * q.y - p.y * q.x) / (lp * lq), dot = (p.x * q.x + p.y * q.y) / (lp * lq);
      return !(Math.abs(cross) < 1e-3 && dot < 0);
    });
  }

  /** stroke caps are stored per vertex in the style override table */
  private endCap(n: FigNode, net: VectorNetwork, chains: NetworkChains, overrides: Map<number, FigNode>): string {
    const nodeCap = n.strokeCap ?? 'NONE';
    const caps = new Set<string>();
    for (const vi of chains.endVertices) caps.add(overrides.get(net.vertices[vi].styleID)?.strokeCap ?? nodeCap);
    if (!caps.size) return nodeCap;
    if (caps.size > 1 && this.hasVisibleStroke(n)) this.warn('Paths with different caps on their ends use one cap style for all ends');
    return [...caps][0];
  }

  // -------------------------------------------------------------- text

  private convertText(n: FigNode, parent: string): string {
    const w = num(n.size?.x), h = num(n.size?.y);
    const size = num(n.fontSize, 12);
    let text = n.textData?.characters ?? '';
    if (n.textCase === 'UPPER') text = text.toUpperCase();
    else if (n.textCase === 'LOWER') text = text.toLowerCase();
    else if (n.textCase && n.textCase !== 'ORIGINAL') this.warn('Text case settings (title case / small caps) are not supported');
    if (n.textDecoration && n.textDecoration !== 'NONE') this.warn('Underline / strikethrough text decorations are not supported');
    if ((n.textData?.styleOverrideTable?.length ?? 0) > 0 && (n.textData?.characterStyleIDs ?? []).some(id => id !== 0)) {
      this.warn('Text layers with mixed styles use the style of the whole layer for all characters');
    }

    // Line height: PIXELS = px, RAW = multiple of the font size. PERCENT is relative to the
    // font's own line height, and exactly 100 % is how "Auto" is stored.
    let lineHeight: number | null = null;
    const lh = n.lineHeight;
    const first = n.derivedTextData?.baselines?.[0];
    if (lh && typeof lh.value === 'number') {
      if (lh.units === 'PIXELS') lineHeight = lh.value;
      else if (lh.units === 'RAW') lineHeight = lh.value * size;
      else if (lh.units === 'PERCENT' && Math.abs(lh.value - 100) > 1e-3) {
        // derived layout already holds the resolved value
        lineHeight = typeof first?.lineHeight === 'number' && first.lineHeight > 0 ? first.lineHeight : null;
      }
    }
    const ls = n.letterSpacing;
    const letterSpacing = ls && typeof ls.value === 'number' ? (ls.units === 'PERCENT' ? (ls.value / 100) * size : ls.units === 'RAW' ? ls.value * size : ls.value) : 0;
    const align = n.textAlignHorizontal === 'CENTER' ? 'center' : n.textAlignHorizontal === 'RIGHT' ? 'right' : 'left';
    if (n.textAlignHorizontal === 'JUSTIFIED') this.warn('Justified text is imported left-aligned');

    const node: TextNode = {
      ...this.shapeBase(n, parent), fills: this.paints(n.fillPaints, w, h), strokes: this.paints(n.strokePaints, w, h),
      type: 'text', text, font: { family: n.fontName?.family || 'Inter', ...parseFontStyle(n.fontName?.style) },
      size: r4(size), lineHeight: lineHeight === null ? null : r4(Math.max(0, lineHeight)), letterSpacing: r4(letterSpacing), align,
      w: n.textAutoResize === 'WIDTH_AND_HEIGHT' ? null : r4(w),
    };
    // Our layout starts the first line at the top of the box. For centre / bottom aligned
    // text move the node down to where Figma put the first line.
    if (n.textAlignVertical === 'CENTER' || n.textAlignVertical === 'BOTTOM') {
      const dy = typeof first?.lineY === 'number' && Number.isFinite(first.lineY) ? first.lineY : null;
      if (dy === null) this.warn('Vertically centred / bottom-aligned text without layout data is imported top-aligned');
      else if (Math.abs(dy) > 1e-3) {
        const m = mul(node.transform, [1, 0, 0, 1, 0, dy]);
        node.transform = [m[0], m[1], m[2], m[3], r4(m[4]), r4(m[5])];
      }
    }
    return this.add(node);
  }
}

/** like mat() but unrounded and with an identity fallback, for paint transforms */
function mat2(t: FigMatrix | undefined): Mat {
  return t ? [num(t.m00, 1), num(t.m10), num(t.m01), num(t.m11, 1), num(t.m02), num(t.m12)] : [1, 0, 0, 1, 0, 0];
}

// ---------------------------------------------------------------- entry point

export async function importFig(bytes: Uint8Array): Promise<FigImport> {
  const container = readFigContainer(bytes);
  const msg = container.message;
  const nodes = Array.isArray(msg.nodeChanges) ? msg.nodeChanges : [];
  if (!nodes.length) throw new Error('The .fig file contains no layers');
  const blobs = Array.isArray(msg.blobs) ? msg.blobs : [];

  // Hash every referenced image up front (hashing is async, the conversion is not).
  const imageKeys = new Map<string, string | null>();
  const pool = new Map<string, ImportedAsset>();
  const preWarnings: string[] = [];
  const visitPaints = (list: FigPaint[] | undefined): void => {
    for (const p of list ?? []) if (p.type === 'IMAGE' && p.image?.hash?.length) imageKeys.set(toHex(p.image.hash), null);
  };
  for (const n of nodes) {
    visitPaints(n.fillPaints); visitPaints(n.strokePaints); visitPaints(n.backgroundPaints);
    for (const o of n.vectorData?.styleOverrideTable ?? []) visitPaints(o.fillPaints);
  }
  for (const hash of imageKeys.keys()) {
    const data = container.images.get(hash);
    if (!data) continue;
    const info = sniffImage(data);
    if (!info) { preWarnings.push('An embedded image has an unsupported format and was dropped'); continue; }
    const key = `${(await sha256Hex(data)).slice(0, 32)}.${info.ext}`;
    const meta: AssetMeta = { mime: info.mime, name: `image.${info.ext}` };
    if (info.w && info.h) { meta.w = info.w; meta.h = info.h; }
    imageKeys.set(hash, key);
    pool.set(key, { bytes: data, meta });
  }

  const imp = new Importer(nodes, blobs, imageKeys, pool);
  for (const w of preWarnings) imp.warn(w);
  imp.run();
  const doc = repairDoc(imp.doc);
  return { doc, assets: imp.assets, warnings: imp.warnings() };
}
