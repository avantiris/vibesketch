// The document model. This is also the on-disk format (doc.json), so keep it plain JSON.
//
// Conventions
//  - Colors are floats 0..1.
//  - Every node has a 2x3 affine `transform` relative to its parent (page or group), in SVG
//    order [a b c d e f]:  x' = a*x + c*y + e,  y' = b*x + d*y + f.
//  - Sized shapes (rect/ellipse/polygon/star/text) occupy the local box (0,0)-(w,h).
//  - Path points live in the node's local space; handles are offsets relative to their anchor.
//  - Nodes are stored flat in `doc.nodes`; order/nesting lives in `children` arrays
//    (first child = bottom of the z-order, like SVG).

export type Mat = [number, number, number, number, number, number];
export interface Vec { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }
export interface Color { r: number; g: number; b: number; a: number }

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge'
  | 'color-burn' | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'hue'
  | 'saturation' | 'color' | 'luminosity';

export const BLEND_MODES: BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];

// ---------------------------------------------------------------- paints

interface PaintBase { visible: boolean; opacity: number; blend?: BlendMode }

export interface SolidPaint extends PaintBase { type: 'solid'; color: Color }

export interface GradientStop { offset: number; color: Color }

/** Gradient geometry is expressed in the node's normalized local box (0..1 on both axes).
 *  linear: runs from `from` to `to`.
 *  radial: centered on `from`, reaches the last stop at `to`; `width` is the ratio of the
 *          perpendicular radius to |to - from| (1 = circle in normalized space). */
export interface GradientPaint extends PaintBase {
  type: 'gradient';
  kind: 'linear' | 'radial';
  stops: GradientStop[];
  from: Vec;
  to: Vec;
  width: number;
}

export interface ImagePaint extends PaintBase {
  type: 'image';
  /** key into doc.assets, also the file name inside the project's assets/ dir */
  asset: string;
  mode: 'fill' | 'fit' | 'stretch' | 'tile' | 'crop';
  /** crop: the rectangle the whole image covers, in fractions of the layer's box (x, y from
   *  its top left). Missing = the same placement as 'fill' */
  crop?: { x: number; y: number; w: number; h: number };
  /** tile scale (1 = natural pixel size) */
  scale?: number;
}

export type Paint = SolidPaint | GradientPaint | ImagePaint;

// ---------------------------------------------------------------- effects

export type Effect =
  | { type: 'drop-shadow' | 'inner-shadow'; visible: boolean; color: Color; x: number; y: number; blur: number; spread: number }
  | { type: 'layer-blur'; visible: boolean; blur: number }
  /** kept for round-tripping Figma files; SVG cannot render it, so it is a no-op on canvas */
  | { type: 'background-blur'; visible: boolean; blur: number }
  /** grain overlaid on the shape. size = grain size in px, density 0..1 */
  | { type: 'noise'; visible: boolean; size: number; density: number; color: Color }
  /** rough/distorted edges. size = feature size in px, radius = displacement in px */
  | { type: 'texture'; visible: boolean; size: number; radius: number };

// ---------------------------------------------------------------- nodes

export interface NodeBase {
  id: string;
  name: string;
  /** id of the parent group or page */
  parent: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  transform: Mat;
  effects: Effect[];
  /** Figma-style mask: this node is not painted; it clips (by its alpha) all following
   *  siblings in the same parent. */
  mask?: boolean;
  /** with mask: the mask's luminance instead of its alpha clips (SVG / PDF soft masks) */
  maskLuminance?: boolean;
}

export interface ShapeBase extends NodeBase {
  fills: Paint[];
  strokes: Paint[];
  strokeWeight: number;
  strokeAlign: 'center' | 'inside' | 'outside';
  strokeCap: 'butt' | 'round' | 'square';
  strokeJoin: 'miter' | 'round' | 'bevel';
  /** dash pattern, empty = solid */
  dash: number[];
}

export interface RectNode extends ShapeBase {
  type: 'rect'; w: number; h: number; /** tl,tr,br,bl */ radii: [number, number, number, number];
  /** an export region: not part of the artwork; exporting it gives what the page shows inside it */
  slice?: boolean;
}
export const isSlice = (n: Node | undefined): n is RectNode => !!n && n.type === 'rect' && !!n.slice;
export interface EllipseNode extends ShapeBase { type: 'ellipse'; w: number; h: number }
export interface PolygonNode extends ShapeBase { type: 'polygon'; w: number; h: number; sides: number }
export interface StarNode extends ShapeBase { type: 'star'; w: number; h: number; points: number; /** inner radius ratio 0..1 */ inner: number }

export interface PathPoint {
  x: number; y: number;
  /** incoming / outgoing bezier handle as an offset from (x,y); null = straight */
  in: Vec | null;
  out: Vec | null;
  /** corner: handles independent. smooth: handles colinear. mirror: colinear + equal length */
  mode: 'corner' | 'smooth' | 'mirror';
}
export interface SubPath { closed: boolean; pts: PathPoint[] }

/** decoration at the end of an open path */
export type ArrowCap = 'none' | 'arrow' | 'triangle' | 'circle' | 'diamond';
export type Side = 'top' | 'right' | 'bottom' | 'left';
/** where a connector end is attached: a node and one of the sides of its bounding box
 *  ('auto' = whichever side faces the other end) */
export interface ConnectorEnd { node: string; side: Side | 'auto' }
/** Makes a path a diagram connector: its geometry is recomputed (core/connector.ts) whenever
 *  the attached nodes move. An end that is null is free and sits wherever the path's first /
 *  last point is. */
export interface Connector {
  kind: 'elbow' | 'straight' | 'curved';
  /** corner radius of the bends (elbow) */
  radius: number;
  from: ConnectorEnd | null;
  to: ConnectorEnd | null;
}
export interface PathNode extends ShapeBase {
  type: 'path'; subpaths: SubPath[]; fillRule: 'nonzero' | 'evenodd';
  /** arrowheads on the first / last point of every open subpath */
  startCap?: ArrowCap;
  endCap?: ArrowCap;
  connector?: Connector;
}

export interface FontRef {
  family: string;
  /** 100..900 */
  weight: number;
  italic: boolean;
}

export interface TextNode extends ShapeBase {
  type: 'text';
  text: string;
  font: FontRef;
  size: number;
  /** line height in px; null = automatic (font metrics) */
  lineHeight: number | null;
  /** extra advance between characters, px */
  letterSpacing: number;
  align: 'left' | 'center' | 'right';
  /** fixed wrap width; null = auto width (grows with the text, never wraps) */
  w: number | null;
}

export interface GroupNode extends NodeBase { type: 'group'; children: string[] }

export type ShapeNode = RectNode | EllipseNode | PolygonNode | StarNode | PathNode | TextNode;
export type Node = ShapeNode | GroupNode;
export type NodeType = Node['type'];

export interface Page { id: string; name: string; children: string[]; background: Color }

export interface AssetMeta { mime: string; w?: number; h?: number; name?: string }

export interface Doc {
  version: 1;
  pages: Page[];
  nodes: Record<string, Node>;
  /** images and embedded font files, stored next to doc.json in assets/<key> */
  assets: Record<string, AssetMeta>;
  /** font files embedded in the project: family/weight/italic -> asset key */
  fonts: { family: string; weight: number; italic: boolean; asset: string }[];
}

// ---------------------------------------------------------------- helpers

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function newId(): string {
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
export const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
export const WHITE: Color = { r: 1, g: 1, b: 1, a: 1 };
export const DEFAULT_FILL: Color = { r: 0.85, g: 0.85, b: 0.85, a: 1 };

export function solid(color: Color, opacity = 1): SolidPaint {
  return { type: 'solid', color, opacity, visible: true };
}

export function isGroup(n: Node): n is GroupNode { return n.type === 'group'; }
export function isShape(n: Node): n is ShapeNode { return n.type !== 'group'; }

export function shapeDefaults(): Omit<ShapeBase, 'id' | 'name' | 'parent'> {
  return {
    visible: true, locked: false, opacity: 1, blend: 'normal', transform: [1, 0, 0, 1, 0, 0], effects: [],
    fills: [], strokes: [], strokeWeight: 1, strokeAlign: 'center', strokeCap: 'butt', strokeJoin: 'miter', dash: [],
  };
}

export function groupDefaults(): Omit<GroupNode, 'id' | 'name' | 'parent'> {
  return { type: 'group', visible: true, locked: false, opacity: 1, blend: 'normal', transform: [1, 0, 0, 1, 0, 0], effects: [], children: [] };
}

export function emptyDoc(): Doc {
  return {
    version: 1,
    pages: [{ id: newId(), name: 'Page 1', children: [], background: { r: 0.118, g: 0.118, b: 0.118, a: 1 } }],
    nodes: {},
    assets: {},
    fonts: [],
  };
}

/** children ids of a page or group id; empty for leaves / unknown ids */
export function childrenOf(doc: Doc, id: string): string[] {
  const n = doc.nodes[id];
  if (n) return n.type === 'group' ? n.children : [];
  return doc.pages.find(p => p.id === id)?.children ?? [];
}

export function pageOf(doc: Doc, id: string): Page | undefined {
  let cur = id;
  for (let i = 0; i < 10000; i++) {
    const n = doc.nodes[cur];
    if (!n) return doc.pages.find(p => p.id === cur);
    cur = n.parent;
  }
  return undefined;
}

/** all descendants of id (excluding id), depth first, bottom-to-top */
export function descendants(doc: Doc, id: string, out: string[] = []): string[] {
  for (const c of childrenOf(doc, id)) { out.push(c); descendants(doc, c, out); }
  return out;
}

/** Structural sanity check + repair. Used after loading files from disk / imports so the
 *  editor can rely on parent/children being consistent. Returns the same doc, mutated. */
export function repairDoc(doc: Doc): Doc {
  doc.version = 1;
  doc.assets ??= {};
  doc.fonts ??= [];
  doc.nodes ??= {};
  if (!Array.isArray(doc.pages) || doc.pages.length === 0) doc.pages = emptyDoc().pages;
  // projects created before the canvas went dark still carry the old light default
  for (const p of doc.pages) {
    const b = p.background;
    if (!b || (b.r === 0.96 && b.g === 0.96 && b.b === 0.96)) p.background = { r: 0.118, g: 0.118, b: 0.118, a: 1 };
  }
  const seen = new Set<string>();
  const visit = (parent: string, kids: string[]): string[] => {
    const ok: string[] = [];
    for (const id of kids) {
      const n = doc.nodes[id];
      if (!n || seen.has(id)) continue;
      seen.add(id);
      n.parent = parent;
      if (n.type === 'group') n.children = visit(id, n.children ?? []);
      ok.push(id);
    }
    return ok;
  };
  for (const p of doc.pages) p.children = visit(p.id, p.children ?? []);
  for (const id of Object.keys(doc.nodes)) if (!seen.has(id)) delete doc.nodes[id];
  return doc;
}
