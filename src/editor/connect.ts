import type { ArrowCap, Box, Connector, ConnectorEnd, PathNode, Side, Vec } from '../core/model.ts';
import { childrenOf, isSlice, newId, shapeDefaults, solid } from '../core/model.ts';
import { apply, boxContains, dist, expandBox, invert, pointInBox } from '../core/geom.ts';
import { worldBounds, worldMatrix } from '../core/bounds.ts';
import { SIDES, isConnector, sideAnchor } from '../core/connector.ts';
import { insertNodes, setNode } from '../core/ops.ts';
import type { DragOp } from './pathtool.ts';
import { eventScreen, eventWorld, ov, redraw, toScreen } from './stage.ts';
import { commit, doc, inkColor, pathEdit, prefs, revert, scopeId, select, selection, textEdit, tool, update, view } from './store.ts';

// Diagramming: the connector tool and the end handles of a selected connector. The routing
// itself lives in core/connector.ts and runs on every document change.

/** new connectors look like the one the user styled last */
export const connectorStyle = {
  kind: 'elbow' as Connector['kind'], radius: 12, startCap: 'none' as ArrowCap, endCap: 'arrow' as ArrowCap, weight: 2,
};

type Ev = { clientX: number; clientY: number; ctrlKey: boolean; metaKey: boolean };

/** What an end dropped at the pointer attaches to: the topmost layer whose box is under it
 *  (a few pixels of slack), on the side whose dot is close, else whichever side fits. Ctrl
 *  keeps the end free. */
function pickEnd(e: Ev, exclude: Set<string>): { end: ConnectorEnd | null; box: Box | null; p: Vec } {
  const w = eventWorld(e), s = eventScreen(e);
  const free = { end: null, box: null, p: prefs.snapPixel.value ? { x: Math.round(w.x), y: Math.round(w.y) } : w };
  if (e.ctrlKey || e.metaKey) return free;
  const d = doc.value, slack = 8 / view.value.zoom;
  const kids = childrenOf(d, scopeId.value);
  let hit: { id: string; box: Box; text: boolean } | null = null;
  for (let i = kids.length - 1; i >= 0; i--) {
    const n = d.nodes[kids[i]];
    if (!n || !n.visible || exclude.has(n.id) || isConnector(n) || isSlice(n)) continue;
    const box = worldBounds(d, n.id);
    if (!pointInBox(w, expandBox(box, slack))) continue;
    if (!hit) { hit = { id: n.id, box, text: n.type === 'text' }; if (!hit.text) break; continue; }
    // a label lying on a box: the arrow belongs to the box
    if (boxContains(expandBox(box, 0.5), hit.box)) { hit = { id: n.id, box, text: false }; break; }
  }
  if (!hit) return free;
  let side: Side | 'auto' = 'auto', best = 12;
  for (const sd of SIDES) {
    const k = dist(toScreen(sideAnchor(hit.box, sd)), s);
    if (k < best) { best = k; side = sd; }
  }
  return { end: { node: hit.id, side }, box: hit.box, p: w };
}

const show = (pick: { end: ConnectorEnd | null; box: Box | null }) => {
  ov.connect = pick.end && pick.box ? { box: pick.box, side: pick.end.side } : null;
};

/** connector tool, pointer just moving: show where a connector would attach */
export function connectorHover(e: PointerEvent) {
  const before = ov.connect;
  show(pickEnd(e, new Set()));
  if (before?.box !== ov.connect?.box || before?.side !== ov.connect?.side) redraw();
}

export function connectorDown(e: PointerEvent): DragOp {
  const base = doc.value, container = scopeId.value, id = newId();
  const start = pickEnd(e, new Set());
  const s0 = eventScreen(e);
  const P = invert(worldMatrix(base, container));
  const pt = (p: Vec) => ({ x: p.x, y: p.y, in: null, out: null, mode: 'corner' as const });
  let started = false;
  return {
    move(ev) {
      if (!started && dist(eventScreen(ev), s0) < 4) return;
      started = true;
      const end = pickEnd(ev, new Set(start.end ? [start.end.node] : []));
      show(end);
      const st = connectorStyle;
      const n: PathNode = {
        ...shapeDefaults(), id, name: 'Connector', parent: container, type: 'path', fillRule: 'nonzero', transform: P,
        strokes: [solid(inkColor())], strokeWeight: st.weight, strokeCap: 'round', strokeJoin: 'round',
        startCap: st.startCap, endCap: st.endCap,
        connector: { kind: st.kind, radius: st.radius, from: start.end, to: end.end },
        // free ends sit where these two points are; the router fills in everything between
        subpaths: [{ closed: false, pts: [pt(start.p), pt(end.p)] }],
      };
      update(() => insertNodes(base, [n], [id], container), { transient: true });
      redraw();
    },
    up() {
      ov.connect = null;
      if (started && doc.value.nodes[id]) { commit(); select([id]); tool.value = 'move'; }
      else revert();
      redraw();
    },
    cancel() { ov.connect = null; revert(); },
  };
}

// ---------------------------------------------------------------- end handles of a selected connector

/** the connector that is the whole selection, if any */
export function soleConnector(): (PathNode & { connector: Connector }) | null {
  const sel = selection.value;
  if (sel.length !== 1 || pathEdit.value || textEdit.value) return null;
  const n = doc.value.nodes[sel[0]];
  return isConnector(n) ? n : null;
}

/** screen positions of the two ends of the selected connector */
export function connectorEnds(): { from: Vec; to: Vec; node: PathNode & { connector: Connector } } | null {
  const n = soleConnector(), pts = n?.subpaths[0]?.pts;
  if (!n || !pts || pts.length < 2) return null;
  const M = worldMatrix(doc.value, n.id);
  return { from: toScreen(apply(M, pts[0])), to: toScreen(apply(M, pts[pts.length - 1])), node: n };
}

export function connectorEndAt(s: Vec): 'from' | 'to' | null {
  const ends = connectorEnds();
  if (!ends || ends.node.locked) return null;
  return dist(ends.to, s) <= 8 ? 'to' : dist(ends.from, s) <= 8 ? 'from' : null;
}

/** drag an end of the selected connector onto another layer, or off into free space */
export function connectorEndDown(e: PointerEvent): DragOp | null {
  const which = connectorEndAt(eventScreen(e)), n = soleConnector();
  if (!which || !n) return null;
  const base = doc.value, inv = invert(worldMatrix(base, n.id));
  const other = n.connector[which === 'from' ? 'to' : 'from'];
  const exclude = new Set([n.id, ...(other ? [other.node] : [])]);
  return {
    move(ev) {
      const pick = pickEnd(ev, exclude);
      show(pick);
      const l = apply(inv, pick.p);
      update(() => setNode<PathNode>(base, n.id, cur => {
        const pts = cur.subpaths[0].pts.slice(), i = which === 'from' ? 0 : pts.length - 1;
        pts[i] = { x: l.x, y: l.y, in: null, out: null, mode: 'corner' };
        return { ...cur, connector: { ...cur.connector!, [which]: pick.end }, subpaths: [{ closed: false, pts }] };
      }), { transient: true });
      redraw();
    },
    up() { ov.connect = null; commit(); redraw(); },
    cancel() { ov.connect = null; revert(); },
  };
}
