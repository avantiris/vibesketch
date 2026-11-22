import type { Doc, Mat, Node, SubPath, Vec } from '../core/model.ts';
import { apply, mul } from '../core/geom.ts';
import { localBounds, worldBounds, worldMatrix } from '../core/bounds.ts';
import { SIDES, sideAnchor } from '../core/connector.ts';
import { connectorEnds } from './connect.ts';
import { gradientLine, measurements, radiusDots } from './handles.ts';
import { nodeSubpaths, segmentsOf } from '../core/path.ts';
import { handlePoints, key, midpointOf, parseKey, pathNode } from './pathtool.ts';
import { frameCorners, handlePoint, ov, selectionFrame } from './stage.ts';
import { doc, hover, pathEdit, selection, textEdit, tool, view } from './store.ts';

// Everything drawn on top of the artwork in screen space: selection, handles, smart guides,
// vector-edit points, marquee.

const ACCENT = '#0d99ff';
const GUIDE = '#ff3b6b';

export function drawOverlay(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const c = canvas.getContext('2d');
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const v = view.value;
  const V: Mat = [v.zoom, 0, 0, v.zoom, v.x, v.y];
  const d = doc.value;
  const scr = (p: Vec): Vec => ({ x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y });

  const tracePath = (sps: SubPath[], M: Mat) => {
    c.beginPath();
    for (const sp of sps) {
      if (!sp.pts.length) continue;
      const p0 = apply(M, sp.pts[0]);
      c.moveTo(p0.x, p0.y);
      for (const s of segmentsOf(sp)) {
        const c1 = apply(M, s.c1), c2 = apply(M, s.c2), p1 = apply(M, s.p1);
        if (s.straight) c.lineTo(p1.x, p1.y); else c.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p1.x, p1.y);
      }
      if (sp.closed) c.closePath();
    }
  };
  const outline = (n: Node, width: number) => {
    const M = mul(V, worldMatrix(d, n.id));
    c.lineWidth = width;
    c.strokeStyle = ACCENT;
    if (n.type === 'group' || n.type === 'text') {
      const b = localBounds(d, n.id);
      const pts = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }].map(p => apply(M, p));
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
    } else tracePath(nodeSubpaths(n), M);
    c.stroke();
  };

  const pe = pathEdit.value;
  const editing = pe ? pathNode() : null;

  // hover
  const hn = hover.value && d.nodes[hover.value];
  if (hn && !editing && tool.value === 'move') outline(hn, 2);

  // selection
  if (!editing) {
    const sel = selection.value;
    if (sel.length > 1 && sel.length <= 200) for (const id of sel) { const n = d.nodes[id]; if (n) outline(n, 1); }
    const f = selectionFrame(d, sel);
    const ends = connectorEnds();
    if (ends) {
      // a connector shows its line and two end handles instead of a resize box
      outline(ends.node, 1);
      for (const k of ['from', 'to'] as const) {
        const p = ends[k], attached = !!ends.node.connector[k];
        c.beginPath(); c.arc(p.x, p.y, 5, 0, Math.PI * 2);
        c.fillStyle = attached ? ACCENT : '#fff'; c.fill();
        c.strokeStyle = attached ? '#fff' : ACCENT; c.lineWidth = 1.5; c.stroke();
      }
    } else if (f && !textEdit.value) {
      const pts = frameCorners(f).map(scr);
      if (f.single && f.single.type !== 'group' && f.single.type !== 'text' && sel.length === 1) outline(f.single, 1);
      c.strokeStyle = ACCENT;
      c.lineWidth = 1;
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
      c.stroke();
      if (tool.value === 'move') {
        c.fillStyle = '#fff';
        for (const p of pts) { c.beginPath(); c.rect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7); c.fill(); c.stroke(); }
      }
      // size badge under the box
      const bottom = pts.reduce((a, p) => (p.y > a.y ? p : a), pts[0]);
      const cx = (Math.min(...pts.map(p => p.x)) + Math.max(...pts.map(p => p.x))) / 2;
      const wpx = Math.hypot(f.M[0], f.M[1]) * f.box.w, hpx = Math.hypot(f.M[2], f.M[3]) * f.box.h;
      badge(c, ov.label ?? `${num(wpx)} × ${num(hpx)}`, cx, bottom.y + 16, ACCENT);
    }
  }

  // vector editing
  if (editing && pe) {
    const M = mul(V, worldMatrix(d, editing.id));
    c.strokeStyle = ACCENT;
    c.lineWidth = 1;
    tracePath(editing.subpaths, M);
    c.stroke();
    if (ov.hoverSeg) {
      const sp = editing.subpaths[ov.hoverSeg.si], s = sp && segmentsOf(sp)[ov.hoverSeg.seg];
      if (s) {
        const a = apply(M, s.p0), c1 = apply(M, s.c1), c2 = apply(M, s.c2), b = apply(M, s.p1);
        c.lineWidth = 2.5;
        c.beginPath(); c.moveTo(a.x, a.y); c.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y); c.stroke();
        c.lineWidth = 1;
        // the dot that adds a point when dragged
        const m = tool.value === 'move' ? midpointOf(editing, ov.hoverSeg.si, ov.hoverSeg.seg) : null;
        if (m) { c.fillStyle = '#fff'; c.beginPath(); c.arc(m.x, m.y, 4, 0, Math.PI * 2); c.fill(); c.stroke(); c.beginPath(); c.moveTo(m.x - 2, m.y); c.lineTo(m.x + 2, m.y); c.moveTo(m.x, m.y - 2); c.lineTo(m.x, m.y + 2); c.stroke(); }
      }
    }
    // pen preview
    if (ov.pen && ov.penCursor) {
      const sp = editing.subpaths[ov.pen.si], last = sp?.pts[sp.pts.length - 1];
      if (last) {
        const a = apply(M, last), b = scr(ov.penCursor);
        const c1 = last.out ? apply(M, { x: last.x + last.out.x, y: last.y + last.out.y }) : a;
        c.beginPath(); c.moveTo(a.x, a.y); c.bezierCurveTo(c1.x, c1.y, b.x, b.y, b.x, b.y); c.stroke();
      }
    }
    const selSet = new Set(pe.sel);
    for (const k of handlePoints(editing, pe.sel)) {
      const [si, pi] = parseKey(k);
      const p = editing.subpaths[si]?.pts[pi];
      if (!p) continue;
      const a = apply(M, p);
      for (const hnd of [p.in, p.out]) {
        if (!hnd) continue;
        const q = apply(M, { x: p.x + hnd.x, y: p.y + hnd.y });
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(q.x, q.y); c.stroke();
        c.save();
        c.translate(q.x, q.y); c.rotate(Math.PI / 4);
        c.fillStyle = '#fff';
        c.beginPath(); c.rect(-3, -3, 6, 6); c.fill(); c.stroke();
        c.restore();
      }
    }
    editing.subpaths.forEach((sp, si) => sp.pts.forEach((p, pi) => {
      const a = apply(M, p), k = key(si, pi);
      const on = selSet.has(k), hot = ov.hoverPoint === k;
      c.beginPath();
      c.arc(a.x, a.y, on || hot ? 4.5 : 3.5, 0, Math.PI * 2);
      c.fillStyle = on ? ACCENT : '#fff';
      c.fill();
      c.strokeStyle = on ? '#fff' : ACCENT;
      c.lineWidth = on ? 1.5 : 1;
      c.stroke();
      c.strokeStyle = ACCENT; c.lineWidth = 1;
    }));
  }

  // where a connector end would attach
  if (ov.connect) {
    const b = ov.connect.box, q = scr(b);
    c.strokeStyle = ACCENT; c.lineWidth = 2;
    c.strokeRect(q.x, q.y, b.w * v.zoom, b.h * v.zoom);
    for (const sd of SIDES) {
      const p = scr(sideAnchor(b, sd)), on = ov.connect.side === sd;
      c.beginPath(); c.arc(p.x, p.y, on ? 6 : 4, 0, Math.PI * 2);
      c.fillStyle = on ? ACCENT : '#fff'; c.fill();
      c.strokeStyle = on ? '#fff' : ACCENT; c.lineWidth = 1.5; c.stroke();
    }
  }

  // corner radius dots
  if (!editing && tool.value === 'move' && !ov.marquee) {
    for (const p of radiusDots()) {
      c.beginPath(); c.arc(p.x, p.y, 4, 0, Math.PI * 2);
      c.fillStyle = '#fff'; c.fill();
      c.strokeStyle = ACCENT; c.lineWidth = 1; c.stroke();
    }
  }

  // gradient handles
  const grad = !editing ? gradientLine() : null;
  if (grad) {
    for (const [w0, col] of [[4, 'rgba(0,0,0,0.5)'], [2, '#fff']] as [number, string][]) {
      c.strokeStyle = col; c.lineWidth = w0;
      c.beginPath(); c.moveTo(grad.from.x, grad.from.y); c.lineTo(grad.to.x, grad.to.y); c.stroke();
    }
    const css = (k: { r: number; g: number; b: number }) => `rgb(${Math.round(k.r * 255)},${Math.round(k.g * 255)},${Math.round(k.b * 255)})`;
    const dot = (p: Vec, col: string, r: number) => {
      c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2);
      c.fillStyle = col; c.fill();
      c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke();
      c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 1; c.beginPath(); c.arc(p.x, p.y, r + 1.5, 0, Math.PI * 2); c.stroke();
    };
    const stops = grad.paint.stops;
    for (const st of stops.slice(1, -1)) dot({ x: grad.from.x + (grad.to.x - grad.from.x) * st.offset, y: grad.from.y + (grad.to.y - grad.from.y) * st.offset }, css(st.color), 3.5);
    dot(grad.from, css(stops[0].color), 6);
    dot(grad.to, css(stops[stops.length - 1].color), 6);
  }

  // Alt: distances to the hovered layer
  const meas = measurements();
  if (meas.length) {
    c.strokeStyle = GUIDE; c.lineWidth = 1;
    for (const m of meas) {
      const a = scr(m.a), b = scr(m.b);
      c.beginPath(); c.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5); c.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5); c.stroke();
      badge(c, num(m.value), (a.x + b.x) / 2 + (Math.abs(a.x - b.x) < 1 ? 22 : 0), (a.y + b.y) / 2 - (Math.abs(a.y - b.y) < 1 ? 12 : 0), GUIDE);
    }
    const hb = hover.value && d.nodes[hover.value] ? worldBounds(d, hover.value) : null;
    if (hb) { const q = scr(hb); c.strokeStyle = GUIDE; c.strokeRect(Math.round(q.x) + 0.5, Math.round(q.y) + 0.5, hb.w * v.zoom, hb.h * v.zoom); }
  }

  // smart guides
  if (ov.guides.length) {
    c.strokeStyle = GUIDE; c.fillStyle = GUIDE; c.lineWidth = 1;
    for (const g of ov.guides) {
      if (g.kind === 'line') {
        const a = g.axis === 'x' ? scr({ x: g.pos, y: g.from }) : scr({ x: g.from, y: g.pos });
        const b = g.axis === 'x' ? scr({ x: g.pos, y: g.to }) : scr({ x: g.to, y: g.pos });
        const clampX = (x: number) => Math.max(-10, Math.min(w + 10, x)), clampY = (y: number) => Math.max(-10, Math.min(h + 10, y));
        c.beginPath();
        c.moveTo(Math.round(clampX(a.x)) + 0.5, Math.round(clampY(a.y)) + 0.5);
        c.lineTo(Math.round(clampX(b.x)) + 0.5, Math.round(clampY(b.y)) + 0.5);
        c.stroke();
        for (const m of g.marks) {
          const p = g.axis === 'x' ? scr({ x: g.pos, y: m }) : scr({ x: m, y: g.pos });
          cross(c, p.x, p.y);
        }
      } else {
        const a = g.axis === 'x' ? scr({ x: g.from, y: g.at }) : scr({ x: g.at, y: g.from });
        const b = g.axis === 'x' ? scr({ x: g.to, y: g.at }) : scr({ x: g.at, y: g.to });
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y);
        // end ticks
        if (g.axis === 'x') { c.moveTo(a.x, a.y - 4); c.lineTo(a.x, a.y + 4); c.moveTo(b.x, b.y - 4); c.lineTo(b.x, b.y + 4); }
        else { c.moveTo(a.x - 4, a.y); c.lineTo(a.x + 4, a.y); c.moveTo(b.x - 4, b.y); c.lineTo(b.x + 4, b.y); }
        c.stroke();
        badge(c, num(Math.abs(g.to - g.from)), (a.x + b.x) / 2, (a.y + b.y) / 2 + (g.axis === 'x' ? -12 : 0), GUIDE);
      }
    }
  }

  // marquee
  if (ov.marquee) {
    const a = scr(ov.marquee), z = v.zoom;
    c.fillStyle = 'rgba(13,153,255,0.12)';
    c.strokeStyle = ACCENT;
    c.lineWidth = 1;
    c.beginPath();
    c.rect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, ov.marquee.w * z, ov.marquee.h * z);
    c.fill(); c.stroke();
  }
  void handlePoint;
}

const num = (v: number) => String(Math.round(v * 100) / 100);

function cross(c: CanvasRenderingContext2D, x: number, y: number) {
  c.beginPath();
  c.moveTo(x - 3, y - 3); c.lineTo(x + 3, y + 3);
  c.moveTo(x + 3, y - 3); c.lineTo(x - 3, y + 3);
  c.stroke();
}

function badge(c: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  c.font = '11px Inter, system-ui, sans-serif';
  const tw = c.measureText(text).width + 10;
  c.fillStyle = color;
  c.beginPath();
  c.roundRect(x - tw / 2, y - 9, tw, 18, 4);
  c.fill();
  c.fillStyle = '#fff';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, x, y + 0.5);
}

export type { Doc };
