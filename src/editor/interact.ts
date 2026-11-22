import type { Box, Doc, Mat, Node, PathNode, ShapeNode, TextNode, Vec } from '../core/model.ts';
import { DEFAULT_FILL, childrenOf, newId, shapeDefaults, solid } from '../core/model.ts';
import { apply, around, boxesIntersect, dist, invert, mul, normBox, rotate, rotationOf, scale as scaleM, translate } from '../core/geom.ts';
import { worldBounds, worldBoundsOf, worldMatrix } from '../core/bounds.ts';
import { duplicateNodes, insertNodes, normalizePath, removeNodes, setNode, topMost, transformWorld, translateWorld } from '../core/ops.ts';
import { layoutText } from '../core/text.ts';
import { lockAspect, rememberDuplicate } from './extras.ts';
import { connectorDown, connectorEndAt, connectorEndDown, connectorHover, soleConnector } from './connect.ts';
import { defaultFamily } from './fonts.ts';
import { handleDown, handleHover } from './handles.ts';
import type { DragOp } from './pathtool.ts';
import { enterPathEdit, pathDown, pathHover, penDown, penHover } from './pathtool.ts';
import { collectTargets, snapBox, snapPoint } from './snap.ts';
import type { Frame, Handle } from './stage.ts';
import { eventScreen, eventWorld, handleCursor, handlePoint, hitHandle, hitNode, ov, pointInFrame, redraw, selectionFrame, stage, toScreen, toWorld, viewportWorld } from './stage.ts';
import { commit, contextMenu, doc, hover, inkColor, pathEdit, prefs, revert, scope, scopeId, select, selection, textEdit, tool, update, view } from './store.ts';

// Pointer handling for the canvas: selection, move / resize / rotate with smart guides,
// shape creation, text placement, panning and zooming.

let drag: DragOp | null = null;
let spaceDown = false;
let lastDown = { t: 0, x: 0, y: 0 };

export const isDragging = () => drag !== null;
export function setSpace(v: boolean) {
  spaceDown = v;
  if (stage.el && !drag) stage.el.style.cursor = v ? 'grab' : toolCursor();
}

const thr = () => 6 / view.value.zoom;
const noSnap = (e: { ctrlKey: boolean; metaKey: boolean }) => e.ctrlKey || e.metaKey;

function toolCursor(): string {
  switch (tool.value) {
    case 'hand': return 'grab';
    case 'text': return 'text';
    case 'move': return 'default';
    default: return 'crosshair';
  }
}

export function setZoom(zoom: number, about?: Vec) {
  const v = view.value;
  const z = Math.max(0.02, Math.min(256, zoom));
  const r = stage.el?.getBoundingClientRect();
  const c = about ?? { x: (r?.width ?? 0) / 2, y: (r?.height ?? 0) / 2 };
  view.value = { zoom: z, x: c.x - ((c.x - v.x) / v.zoom) * z, y: c.y - ((c.y - v.y) / v.zoom) * z };
}

export function zoomToBox(b: Box | null, maxZoom = 4) {
  const r = stage.el?.getBoundingClientRect();
  if (!r || !b || r.width < 10) return;
  const pad = 60;
  const z = Math.max(0.02, Math.min(maxZoom, (r.width - pad * 2) / Math.max(b.w, 1e-6), (r.height - pad * 2) / Math.max(b.h, 1e-6)));
  view.value = { zoom: z, x: r.width / 2 - (b.x + b.w / 2) * z, y: r.height / 2 - (b.y + b.h / 2) * z };
}

export function zoomToFit() {
  const d = doc.value;
  const ids = childrenOf(d, scopeIdPage());
  zoomToBox(worldBoundsOf(d, ids), 1);
  if (!ids.length) view.value = { zoom: 1, x: (stage.el?.clientWidth ?? 0) / 2, y: (stage.el?.clientHeight ?? 0) / 2 };
}
const scopeIdPage = () => { let id = scopeId.value; const d = doc.value; while (d.nodes[id]) id = d.nodes[id].parent; return id; };

// ---------------------------------------------------------------- snapping helpers

function targetsFor(d: Doc, ids: string[]): Box[] {
  if (!prefs.snapObjects.value) return [];
  const parent = d.nodes[ids[0]]?.parent ?? scopeId.value;
  return collectTargets(d, parent, new Set(ids), viewportWorld());
}

/** snap a free point (creation tools) to objects, then to the pixel grid */
function snapFree(w: Vec, e: PointerEvent, targets: Box[]): Vec {
  ov.guides = [];
  if (noSnap(e)) return w;
  const r = snapPoint(w, targets, thr());
  ov.guides = r.guides;
  let p = r.p;
  if (prefs.snapPixel.value) p = { x: p.x !== w.x ? p.x : Math.round(p.x), y: p.y !== w.y ? p.y : Math.round(p.y) };
  return p;
}

// ---------------------------------------------------------------- move

function startMove(e: PointerEvent, opts: { clickSelect?: string; clickClear?: boolean }): DragOp {
  const w0 = eventWorld(e), s0 = eventScreen(e);
  const base0 = doc.value;
  const selBefore = selection.value;
  let ids = topMost(base0, selection.value).filter(id => !base0.nodes[id].locked);
  let base = base0;
  let started = false, duplicated = false, lastDx = 0, lastDy = 0;
  let startBox: Box | null = null;
  let targets: Box[] = [];
  return {
    move(ev, w) {
      if (!started) {
        if (dist(eventScreen(ev), s0) < 3 || !ids.length) return;
        started = true;
        if (ev.altKey) {
          const dup = duplicateNodes(base0, scopeIdPage(), ids);
          base = dup.doc; ids = dup.ids; duplicated = true;
        }
        startBox = worldBoundsOf(base, ids);
        targets = targetsFor(base, ids);
        hover.value = null;
      }
      if (!startBox) return;
      let dx = w.x - w0.x, dy = w.y - w0.y;
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      ov.guides = [];
      let sx = false, sy = false;
      if (!noSnap(ev) && targets.length) {
        const r = snapBox({ x: startBox.x + dx, y: startBox.y + dy, w: startBox.w, h: startBox.h }, targets, thr());
        if (ev.shiftKey) { if (dy === 0) r.dy = 0; else r.dx = 0; }
        sx = r.dx !== 0 || r.guides.some(g => g.axis === 'x');
        sy = r.dy !== 0 || r.guides.some(g => g.axis === 'y');
        dx += r.dx; dy += r.dy;
        ov.guides = r.guides.filter(g => (ev.shiftKey ? (dy === 0 ? g.axis === 'x' : g.axis === 'y') : true));
      }
      if (prefs.snapPixel.value && !noSnap(ev)) {
        if (!sx) dx = Math.round(startBox.x + dx) - startBox.x;
        if (!sy) dy = Math.round(startBox.y + dy) - startBox.y;
      }
      update(() => translateWorld(base, ids, dx, dy), { transient: true });
      // the copies only exist in the document from here on
      if (duplicated && selection.value[0] !== ids[0]) select(ids);
      lastDx = dx; lastDy = dy;
      redraw();
    },
    up(ev) {
      ov.guides = [];
      if (started) { commit(); if (duplicated) rememberDuplicate(ids, lastDx, lastDy); }
      else if (opts.clickSelect && !ev.shiftKey) select([opts.clickSelect]);
      else if (opts.clickClear) { select([]); scope.value = null; }
      redraw();
    },
    cancel() {
      ov.guides = [];
      revert();
      if (duplicated) select(selBefore);
    },
  };
}

// ---------------------------------------------------------------- marquee

function startMarquee(e: PointerEvent): DragOp {
  const w0 = eventWorld(e);
  const before = e.shiftKey ? selection.value : [];
  const d = doc.value;
  const cands = childrenOf(d, scopeId.value).filter(id => d.nodes[id] && d.nodes[id].visible && !d.nodes[id].locked).map(id => ({ id, b: worldBounds(d, id) }));
  return {
    move(_e, w) {
      const box = normBox(w0, w);
      ov.marquee = box;
      const hit = cands.filter(c => boxesIntersect(c.b, box)).map(c => c.id);
      select([...before.filter(id => !hit.includes(id)), ...hit]);
      redraw();
    },
    up() { ov.marquee = null; redraw(); },
    cancel() { ov.marquee = null; select(before); },
  };
}

// ---------------------------------------------------------------- resize / rotate

function isAxisAligned(m: Mat): boolean {
  return Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;
}

function startResize(e: PointerEvent, f: Frame, h: Handle): DragOp {
  const base = doc.value, w0 = eventWorld(e);
  const ids = f.ids.filter(id => !base.nodes[id].locked);
  const inv = invert(f.M);
  const H = { x: f.box.x + f.box.w * h.hx, y: f.box.y + f.box.h * h.hy };
  const Hw = apply(f.M, H);
  const aligned = isAxisAligned(f.M);
  const targets = aligned ? targetsFor(base, ids) : [];
  const text = f.single && f.single.type === 'text' ? f.single : null;
  return {
    move(ev, w) {
      let p = { x: Hw.x + (w.x - w0.x), y: Hw.y + (w.y - w0.y) };
      ov.guides = [];
      if (aligned && !noSnap(ev)) {
        const r = snapPoint(p, targets, thr(), { x: h.hx !== 0.5, y: h.hy !== 0.5 });
        ov.guides = r.guides;
        const q = r.p;
        if (prefs.snapPixel.value) {
          if (q.x === p.x && h.hx !== 0.5) q.x = Math.round(q.x);
          if (q.y === p.y && h.hy !== 0.5) q.y = Math.round(q.y);
        }
        p = q;
      }
      const l = apply(inv, p);
      const center = ev.altKey;
      const A = { x: f.box.x + f.box.w * (center ? 0.5 : 1 - h.hx), y: f.box.y + f.box.h * (center ? 0.5 : 1 - h.hy) };
      const ratio = (cur: number, a: number, orig: number) => (Math.abs(orig - a) < 1e-9 ? 1 : (cur - a) / (orig - a));
      let sx = h.hx === 0.5 ? 1 : ratio(l.x, A.x, H.x);
      let sy = h.hy === 0.5 ? 1 : ratio(l.y, A.y, H.y);
      if (ev.shiftKey || lockAspect.value) {
        if (h.hx === 0.5) sx = Math.abs(sy);
        else if (h.hy === 0.5) sy = Math.abs(sx);
        else { const s = Math.max(Math.abs(sx), Math.abs(sy)); sx = Math.sign(sx || 1) * s; sy = Math.sign(sy || 1) * s; }
        if (h.hx === 0.5) A.x = f.box.x + f.box.w / 2;
        if (h.hy === 0.5) A.y = f.box.y + f.box.h / 2;
      }
      const tiny = (v: number, size: number) => (Math.abs(v * size) < 1e-3 ? (v < 0 ? -1 : 1) * (1e-3 / Math.max(size, 1e-3)) : v);
      sx = tiny(sx, f.box.w); sy = tiny(sy, f.box.h);
      if (text) {
        // text boxes: dragging sideways sets the wrap width instead of stretching glyphs
        if (h.hx === 0.5) return;
        const lay = layoutText(text);
        const nw = Math.max(1, Math.abs(sx) * lay.w);
        const shift = center ? (lay.w - nw) / 2 : h.hx === 0 ? lay.w - nw : 0;
        const m = text.transform;
        update(() => setNode<TextNode>(base, text.id, n => ({ ...n, w: nw, transform: [m[0], m[1], m[2], m[3], m[4] + m[0] * shift, m[5] + m[1] * shift] })), { transient: true });
        ov.label = `${Math.round(nw)}`;
        redraw();
        return;
      }
      const Wm = mul(f.M, mul(around(scaleM(sx, sy), A), inv));
      update(() => transformWorld(base, ids, Wm), { transient: true });
      ov.label = `${fmt(Math.abs(sx) * f.box.w * Math.hypot(f.M[0], f.M[1]))} × ${fmt(Math.abs(sy) * f.box.h * Math.hypot(f.M[2], f.M[3]))}`;
      redraw();
    },
    up() { ov.guides = []; ov.label = null; commit(); redraw(); },
    cancel() { ov.guides = []; ov.label = null; revert(); },
  };
}
const fmt = (v: number) => String(Math.round(v * 100) / 100);

function startRotate(e: PointerEvent, f: Frame): DragOp {
  const base = doc.value, w0 = eventWorld(e);
  const ids = f.ids.filter(id => !base.nodes[id].locked);
  const c = handlePoint(f, 0.5, 0.5);
  const a0 = Math.atan2(w0.y - c.y, w0.x - c.x);
  const baseRot = f.single ? rotationOf(f.M) : 0;
  return {
    move(ev, w) {
      let a = Math.atan2(w.y - c.y, w.x - c.x) - a0;
      if (ev.shiftKey) { const step = Math.PI / 12; a = Math.round((baseRot + a) / step) * step - baseRot; }
      update(() => transformWorld(base, ids, around(rotate(a), c)), { transient: true });
      let deg = ((baseRot + a) * 180) / Math.PI;
      deg = ((((deg + 180) % 360) + 360) % 360) - 180;
      ov.label = `${Math.round(deg * 10) / 10}°`;
      redraw();
    },
    up() { ov.label = null; commit(); redraw(); },
    cancel() { ov.label = null; revert(); },
  };
}

// ---------------------------------------------------------------- shape creation

function startCreate(e: PointerEvent, kind: 'rect' | 'ellipse' | 'polygon' | 'star' | 'line'): DragOp {
  const base = doc.value;
  const container = scopeId.value;
  const targets = prefs.snapObjects.value ? collectTargets(base, container, new Set(), viewportWorld()) : [];
  const p0 = snapFree(eventWorld(e), e, targets);
  const s0 = eventScreen(e);
  const id = newId();
  const Pinv = invert(worldMatrix(base, container));
  let started = false;
  const build = (a: Vec, b: Vec, ev: PointerEvent): Node => {
    const defaults = shapeDefaults();
    if (kind === 'line') {
      let q = b;
      if (ev.shiftKey) {
        const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4), l = Math.hypot(b.x - a.x, b.y - a.y);
        q = { x: a.x + Math.cos(ang) * l, y: a.y + Math.sin(ang) * l };
      }
      const n: PathNode = {
        ...defaults, id, name: 'Line', parent: container, type: 'path', fillRule: 'nonzero', transform: Pinv,
        strokes: [solid(inkColor())], strokeWeight: 1,
        subpaths: [{ closed: false, pts: [{ x: a.x, y: a.y, in: null, out: null, mode: 'corner' }, { x: q.x, y: q.y, in: null, out: null, mode: 'corner' }] }],
      };
      return normalizePath(n);
    }
    let dx = b.x - a.x, dy = b.y - a.y;
    if (ev.shiftKey) { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s; }
    const box = ev.altKey ? { x: a.x - Math.abs(dx), y: a.y - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 } : normBox(a, { x: a.x + dx, y: a.y + dy });
    const common = { ...defaults, id, parent: container, transform: mul(Pinv, translate(box.x, box.y)), fills: [solid(DEFAULT_FILL)], w: Math.max(box.w, 0.01), h: Math.max(box.h, 0.01) };
    if (kind === 'rect') return { ...common, type: 'rect', name: 'Rectangle', radii: [0, 0, 0, 0] };
    if (kind === 'ellipse') return { ...common, type: 'ellipse', name: 'Ellipse' };
    if (kind === 'polygon') return { ...common, type: 'polygon', name: 'Polygon', sides: 3 };
    return { ...common, type: 'star', name: 'Star', points: 5, inner: 0.382 };
  };
  const put = (n: Node) => update(() => insertNodes(base, [n], [id], container), { transient: true });
  return {
    move(ev, w) {
      if (!started && dist(eventScreen(ev), s0) < 3) return;
      started = true;
      const p1 = snapFree(w, ev, targets);
      const n = build(p0, p1, ev);
      put(n);
      const b = worldBounds(doc.value, id);
      ov.label = `${fmt(b.w)} × ${fmt(b.h)}`;
      redraw();
    },
    up(ev) {
      ov.guides = []; ov.label = null;
      if (!started) put(build(p0, { x: p0.x + 100, y: p0.y + (kind === 'line' ? 0 : 100) }, { ...ev, shiftKey: false, altKey: false } as PointerEvent));
      commit();
      select([id]);
      tool.value = 'move';
      redraw();
    },
    cancel() { ov.guides = []; ov.label = null; revert(); },
  };
}

// ---------------------------------------------------------------- text

export function startTextEdit(id: string) {
  const n = doc.value.nodes[id];
  if (!n || n.type !== 'text' || n.locked) return;
  pathEdit.value = null;
  select([id]);
  textEdit.value = id;
}

/** Leave text editing; empty text layers are removed. */
export function endTextEdit() {
  const id = textEdit.value;
  if (!id) return;
  textEdit.value = null;
  const n = doc.value.nodes[id];
  if (n && n.type === 'text' && n.text.trim() === '') {
    update(d => removeNodes(d, [id]), { transient: true });
    select([]);
  } else if (n && n.type === 'text' && n.name === 'Text') {
    update(d => setNode(d, id, { name: n.text.split('\n')[0].slice(0, 40) || 'Text' }), { transient: true });
  }
  commit();
  if (tool.value === 'text') tool.value = 'move';
}

function startText(e: PointerEvent): DragOp {
  const w0 = eventWorld(e), s0 = eventScreen(e);
  const container = scopeId.value;
  return {
    move(_e, w) { ov.marquee = normBox(w0, w); redraw(); },
    up(ev, w) {
      ov.marquee = null;
      const dragged = dist(eventScreen(ev), s0) > 5;
      const size = 16;
      const box = normBox(w0, w);
      const id = newId();
      const n: TextNode = {
        ...shapeDefaults(), id, name: 'Text', parent: container, type: 'text', text: '',
        font: { family: lastFont.family || defaultFamily(), weight: lastFont.weight, italic: lastFont.italic }, size: lastFont.size || size,
        lineHeight: null, letterSpacing: 0, align: 'left', w: dragged ? Math.max(8, box.w) : null,
        fills: [solid(inkColor())],
        transform: mul(invert(worldMatrix(doc.value, container)), translate(Math.round(dragged ? box.x : w0.x), Math.round(dragged ? box.y : w0.y - (lastFont.size || size) * 0.6))),
      };
      update(d => insertNodes(d, [n], [id], container), { transient: true });
      startTextEdit(id);
      redraw();
    },
    cancel() { ov.marquee = null; },
  };
}
/** the font used for new text layers follows the last text the user styled */
export const lastFont = { family: '', weight: 400, italic: false, size: 16 };

// ---------------------------------------------------------------- pan

function startPan(e: PointerEvent): DragOp {
  const v0 = view.value, s0 = { x: e.clientX, y: e.clientY };
  stage.el!.style.cursor = 'grabbing';
  return {
    move(ev) { view.value = { zoom: v0.zoom, x: v0.x + ev.clientX - s0.x, y: v0.y + ev.clientY - s0.y }; },
    up() { stage.el!.style.cursor = spaceDown ? 'grab' : toolCursor(); },
  };
}

// ---------------------------------------------------------------- dispatch

function moveToolDown(e: PointerEvent, dbl: boolean): DragOp | null {
  if (pathEdit.value) return pathDown(e, dbl);
  const s = eventScreen(e), w = toWorld(s);
  const f = selectionFrame();
  const deep = e.ctrlKey || e.metaKey;

  if (dbl) {
    const hit = hitNode(e, false);
    if (!hit) return null;
    const n = doc.value.nodes[hit.id];
    if (n.type === 'group') {
      scope.value = hit.id;
      const inner = hitNode(e, false);
      select(inner ? [inner.id] : []);
    } else if (n.type === 'text') startTextEdit(hit.id);
    else enterPathEdit(hit.id);
    return null;
  }

  const special = connectorEndDown(e) ?? handleDown(s);
  if (special) return special;
  // a connector is shaped by what it is attached to, not by a resize box
  if (f && !soleConnector() && !f.ids.every(id => doc.value.nodes[id].locked)) {
    const h = hitHandle(f, s);
    if (h?.kind === 'resize') return startResize(e, f, h);
    if (h?.kind === 'rotate') return startRotate(e, f);
  }
  const hit = hitNode(e, deep);
  if (hit) {
    const sel = selection.value;
    if (e.shiftKey) {
      if (sel.includes(hit.id)) { select(sel.filter(x => x !== hit.id)); return null; }
      select([...sel, hit.id]);
      return startMove(e, {});
    }
    // clicking empty-looking space inside a multi-selection still drags the whole selection
    const insideSel = sel.some(id => id === hit.id || isInside(doc.value, hit.leaf, id));
    if (insideSel && !deep) return startMove(e, { clickSelect: hit.id });
    scope.value = hit.scope;
    select([hit.id]);
    return startMove(e, {});
  }
  if (f && !e.shiftKey && pointInFrame(f, w)) return startMove(e, { clickClear: true });
  if (!e.shiftKey) { select([]); scope.value = null; }
  return startMarquee(e);
}

function isInside(d: Doc, leaf: string, ancestor: string): boolean {
  for (let cur: string | undefined = leaf; cur && d.nodes[cur]; cur = d.nodes[cur].parent) if (cur === ancestor) return true;
  return false;
}

function onDown(e: PointerEvent) {
  if (drag) return;
  if (contextMenu.value) contextMenu.value = null;
  const el = stage.el!;
  if (e.target instanceof HTMLTextAreaElement) return;
  if (textEdit.value) { endTextEdit(); if (tool.value === 'text') tool.value = 'move'; }
  (document.activeElement as HTMLElement | null)?.blur?.();
  const now = performance.now();
  const dbl = e.button === 0 && now - lastDown.t < 350 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 5;
  lastDown = dbl ? { t: 0, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };

  let op: DragOp | null = null;
  if (e.button === 1 || (e.button === 0 && (spaceDown || tool.value === 'hand'))) op = startPan(e);
  else if (e.button !== 0) return;
  else {
    switch (tool.value) {
      case 'move': op = moveToolDown(e, dbl); break;
      case 'pen': op = penDown(e); break;
      case 'bend': if (pathEdit.value) op = pathDown(e, dbl); else tool.value = 'move'; break;
      case 'text': op = startText(e); break;
      case 'connector': pathEdit.value = null; op = connectorDown(e); break;
      case 'rect': case 'ellipse': case 'polygon': case 'star': case 'line':
        pathEdit.value = null;
        op = startCreate(e, tool.value); break;
    }
  }
  e.preventDefault();
  if (!op) { redraw(); return; }
  drag = op;
  try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
}

function onMove(e: PointerEvent) {
  const el = stage.el!;
  if (drag) {
    // a press that turned into a drag is not the first half of a double-click
    if (lastDown.t && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) > 4) lastDown = { t: 0, x: 0, y: 0 };
    drag.move(e, eventWorld(e));
    return;
  }
  if (spaceDown || tool.value === 'hand') { el.style.cursor = 'grab'; return; }
  if (tool.value === 'pen') { penHover(e); el.style.cursor = 'crosshair'; return; }
  if (tool.value === 'connector') { connectorHover(e); el.style.cursor = 'crosshair'; return; }
  if (tool.value !== 'move' && !(tool.value === 'bend' && pathEdit.value)) { el.style.cursor = toolCursor(); return; }
  if (pathEdit.value) { el.style.cursor = pathHover(e); return; }
  if (handleHover(eventScreen(e))) { el.style.cursor = 'pointer'; if (hover.value) hover.value = null; return; }
  if (connectorEndAt(eventScreen(e))) { el.style.cursor = 'pointer'; if (hover.value) hover.value = null; return; }
  const f = soleConnector() ? null : selectionFrame();
  const h = f && hitHandle(f, eventScreen(e));
  if (f && h) { el.style.cursor = handleCursor(f, h); if (hover.value) hover.value = null; return; }
  el.style.cursor = 'default';
  const hit = hitNode(e, e.ctrlKey || e.metaKey);
  const id = hit && !selection.value.includes(hit.id) ? hit.id : null;
  if (hover.value !== id) hover.value = id;
}

function onUp(e: PointerEvent) {
  if (!drag) return;
  const op = drag;
  drag = null;
  try { stage.el!.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  op.up(e, eventWorld(e));
}

/** Esc during a drag */
export function cancelDrag(): boolean {
  if (!drag) return false;
  const op = drag;
  drag = null;
  if (op.cancel) op.cancel(); else revert();
  ov.guides = []; ov.marquee = null; ov.label = null;
  redraw();
  return true;
}

/** Zoom factor for one ctrl+wheel event, paced like Figma: a mouse wheel notch is ~20%, a
 *  trackpad pinch (many small fractional deltas) follows the fingers. */
export function wheelZoomFactor(e: { deltaY: number; deltaMode: number }): number {
  const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
  const notch = e.deltaMode !== 0 || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);
  if (notch) return Math.exp(-Math.max(-300, Math.min(300, px)) * 0.0018);
  return Math.exp(-Math.max(-40, Math.min(40, px)) * 0.01);
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const s = eventScreen(e);
  if (e.ctrlKey || e.metaKey) {
    setZoom(view.value.zoom * wheelZoomFactor(e), s);
  } else {
    const unit = e.deltaMode === 1 ? 33 : 1;
    const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit, dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
    view.value = { ...view.value, x: view.value.x - dx, y: view.value.y - dy };
  }
}

export function attach(el: HTMLElement): () => void {
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('wheel', onWheel, { passive: false });
  const leave = () => { if (hover.value) hover.value = null; if (ov.connect && !drag) { ov.connect = null; redraw(); } };
  el.addEventListener('pointerleave', leave);
  const ctx = (e: Event) => e.preventDefault();
  el.addEventListener('auxclick', ctx);
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    if (textEdit.value || isDragging()) return;
    // right-clicking something outside the selection selects it first
    if (!pathEdit.value) {
      const hit = hitNode(e, e.ctrlKey || e.metaKey);
      if (hit && !selection.value.some(id => id === hit.id || isInside(doc.value, hit.leaf, id))) { scope.value = hit.scope; select([hit.id]); }
      else if (!hit) select([]);
    }
    contextMenu.value = { x: e.clientX, y: e.clientY };
  };
  el.addEventListener('contextmenu', menu);
  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('pointerleave', leave);
    el.removeEventListener('auxclick', ctx);
    el.removeEventListener('contextmenu', menu);
  };
}

export type { ShapeNode };
