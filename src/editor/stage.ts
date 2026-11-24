import { signal } from '@preact/signals';
import type { Box, Doc, Mat, Node, Side, Vec } from '../core/model.ts';
import { apply, boxCorners, dist, ident, invert } from '../core/geom.ts';
import { localBounds, worldBoundsOf, worldMatrix } from '../core/bounds.ts';
import { topMost } from '../core/ops.ts';
import type { Guide } from './snap.ts';
import type { Scene } from './scene.ts';
import { doc, scope, scopeId, selection, view } from './store.ts';

// Shared, non-document state of the canvas: what the overlay draws and how screen points map
// to the page.

export const ov = {
  /** rubber-band selection rectangle, page space */
  marquee: null as Box | null,
  guides: [] as Guide[],
  /** pen tool: index of the subpath being drawn (in the path under edit) */
  pen: null as { si: number } | null,
  /** pen tool: current pointer position (page space) for the preview segment */
  penCursor: null as Vec | null,
  hoverPoint: null as string | null,
  hoverSeg: null as { si: number; seg: number } | null,
  /** small text next to the cursor (sizes, angles) */
  label: null as string | null,
  /** connector tool / end drag: the layer an end would attach to, and the chosen side */
  connect: null as { box: Box; side: Side | 'auto' } | null,
};
export const overlayTick = signal(0);
export const redraw = () => { overlayTick.value++; };

export const stage = {
  el: null as HTMLElement | null,
  scene: null as Scene | null,
  sceneRoot: null as SVGGElement | null,
};

export function eventScreen(e: { clientX: number; clientY: number }): Vec {
  const r = stage.el!.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
export function toWorld(s: Vec): Vec {
  const v = view.value;
  return { x: (s.x - v.x) / v.zoom, y: (s.y - v.y) / v.zoom };
}
export function toScreen(w: Vec): Vec {
  const v = view.value;
  return { x: w.x * v.zoom + v.x, y: w.y * v.zoom + v.y };
}
export const eventWorld = (e: { clientX: number; clientY: number }): Vec => toWorld(eventScreen(e));

/** visible part of the page, page space */
export function viewportWorld(): Box {
  const r = stage.el?.getBoundingClientRect();
  const v = view.value;
  return { x: -v.x / v.zoom, y: -v.y / v.zoom, w: (r?.width ?? 0) / v.zoom, h: (r?.height ?? 0) / v.zoom };
}

// ---------------------------------------------------------------- selection frame

/** The box the selection handles sit on: for one node its own (possibly rotated) local box,
 *  for several the page-aligned union. `M` maps box coordinates to page space. */
export interface Frame { M: Mat; box: Box; ids: string[]; single: Node | null }

export function selectionFrame(d: Doc = doc.value, sel: string[] = selection.value): Frame | null {
  const ids = topMost(d, sel);
  if (!ids.length) return null;
  if (ids.length === 1) return { M: worldMatrix(d, ids[0]), box: localBounds(d, ids[0]), ids, single: d.nodes[ids[0]] };
  const box = worldBoundsOf(d, ids);
  return box ? { M: ident(), box, ids, single: null } : null;
}

export const frameCorners = (f: Frame): Vec[] => boxCorners(f.box).map(p => apply(f.M, p));

export interface Handle { kind: 'resize' | 'rotate'; hx: 0 | 0.5 | 1; hy: 0 | 0.5 | 1 }

const HANDLES: [0 | 0.5 | 1, 0 | 0.5 | 1][] = [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];

export function handlePoint(f: Frame, hx: number, hy: number): Vec {
  return apply(f.M, { x: f.box.x + f.box.w * hx, y: f.box.y + f.box.h * hy });
}

function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

/** which transform handle is under the screen point */
export function hitHandle(f: Frame, s: Vec): Handle | null {
  const pts = HANDLES.map(([hx, hy]) => toScreen(handlePoint(f, hx, hy)));
  const wpx = dist(pts[0], pts[1]), hpx = dist(pts[0], pts[3]);
  for (let i = 0; i < 4; i++) if (dist(pts[i], s) <= 7) return { kind: 'resize', hx: HANDLES[i][0], hy: HANDLES[i][1] };
  // edges: only when the box is big enough to leave room for dragging the object itself
  const edges: [number, number, number, boolean][] = [[0, 1, 4, wpx > 14], [1, 2, 5, hpx > 14], [3, 2, 6, wpx > 14], [0, 3, 7, hpx > 14]];
  for (const [a, b, h, ok] of edges) {
    if (ok && distToSegment(s, pts[a], pts[b]) <= 5) return { kind: 'resize', hx: HANDLES[h][0], hy: HANDLES[h][1] };
  }
  // rotation: a ring just outside each corner
  const local = apply(invert(f.M), toWorld(s));
  const inside = local.x >= f.box.x && local.x <= f.box.x + f.box.w && local.y >= f.box.y && local.y <= f.box.y + f.box.h;
  if (!inside) for (let i = 0; i < 4; i++) if (dist(pts[i], s) <= 22) return { kind: 'rotate', hx: HANDLES[i][0], hy: HANDLES[i][1] };
  return null;
}

export function pointInFrame(f: Frame, w: Vec): boolean {
  const l = apply(invert(f.M), w);
  const pad = 2 / view.value.zoom;
  return l.x >= f.box.x - pad && l.x <= f.box.x + f.box.w + pad && l.y >= f.box.y - pad && l.y <= f.box.y + f.box.h + pad;
}

const ROTATE_CURSOR = (() => {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='-1 -1 26 26'><path d='M5 14a7 7 0 1 1 3 5.7' fill='none' stroke='white' stroke-width='5.4' stroke-linecap='round'/><path d='M5 14a7 7 0 1 1 3 5.7' fill='none' stroke='black' stroke-width='2.8' stroke-linecap='round'/><path d='M1.5 12.5 5 16.5l3.6-4' fill='none' stroke='white' stroke-width='5.4' stroke-linecap='round' stroke-linejoin='round'/><path d='M1.5 12.5 5 16.5l3.6-4' fill='none' stroke='black' stroke-width='2.8' stroke-linecap='round' stroke-linejoin='round'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 13 13, crosshair`;
})();

export function handleCursor(f: Frame, h: Handle): string {
  if (h.kind === 'rotate') return ROTATE_CURSOR;
  const c = toScreen(handlePoint(f, 0.5, 0.5)), p = toScreen(handlePoint(f, h.hx, h.hy));
  let a = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
  if (h.hx === 0.5 || h.hy === 0.5) {
    // edge handles resize along the edge normal, whatever the box aspect is
    const o = toScreen(handlePoint(f, h.hx === 0.5 ? 0.5 : 1 - h.hx, h.hy === 0.5 ? 0.5 : 1 - h.hy));
    a = (Math.atan2(p.y - o.y, p.x - o.x) * 180) / Math.PI;
  }
  const k = ((Math.round(a / 45) % 4) + 4) % 4;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][k];
}

// ---------------------------------------------------------------- node hit testing

/** deepest unlocked, visible node painted at the client point (a few px of tolerance) */
export function leafAt(cx: number, cy: number): string | null {
  const root = stage.sceneRoot;
  if (!root) return null;
  for (const [dx, dy] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]]) {
    for (const el of document.elementsFromPoint(cx + dx, cy + dy)) {
      if (!root.contains(el)) continue;
      const g = el.closest<SVGGElement>('[data-id]');
      if (g?.dataset.id && doc.value.nodes[g.dataset.id]) return g.dataset.id;
    }
  }
  return null;
}

/** Map a hit leaf to what a click should select: the ancestor that is a direct child of the
 *  entered group, or the top-level ancestor when the leaf is outside of it. */
export function resolveTarget(leaf: string, deep: boolean): { id: string; scope: string | null } {
  const d = doc.value;
  const parentScope = (id: string) => (d.nodes[d.nodes[id].parent] ? d.nodes[id].parent : null);
  if (deep) return { id: leaf, scope: parentScope(leaf) };
  const container = scopeId.value;
  let cur = leaf;
  for (let i = 0; i < 1000; i++) {
    const n = d.nodes[cur];
    if (n.parent === container) return { id: cur, scope: scope.value };
    if (!d.nodes[n.parent]) return { id: cur, scope: null };
    cur = n.parent;
  }
  return { id: leaf, scope: null };
}

export function hitNode(e: { clientX: number; clientY: number }, deep: boolean): { id: string; scope: string | null; leaf: string } | null {
  const leaf = leafAt(e.clientX, e.clientY);
  return leaf ? { ...resolveTarget(leaf, deep), leaf } : null;
}
