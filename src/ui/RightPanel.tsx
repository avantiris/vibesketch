import { useEffect, useRef, useState } from 'preact/hooks';
import type { ArrowCap, Color, Connector, Effect, GradientPaint, Mat, Node, Paint, PathNode, ShapeNode, TextNode } from '../core/model.ts';
import { BLACK, BLEND_MODES, DEFAULT_FILL, isShape, solid } from '../core/model.ts';
import { apply, around, invert, mul, rotate, rotationOf, scale as scaleM, translate } from '../core/geom.ts';
import { localBounds, worldBoundsOf, worldMatrix } from '../core/bounds.ts';
import { setNodes, setPage, topMost, transformNodes, transformWorld } from '../core/ops.ts';
import { hex } from '../core/render.ts';
import { align, distribute, exportSelection, flip, toggleMask } from '../editor/actions.ts';
import type { ExportFormat } from '../editor/actions.ts';
import { connectorStyle } from '../editor/connect.ts';
import { gradientEdit, lockAspect } from '../editor/extras.ts';
import { canUseLocalFonts, ensureFont, facesOf, families, fontsVersion, hasFamily, loadLocalFonts, localFontsLoaded } from '../editor/fonts.ts';
import { lastFont } from '../editor/interact.ts';
import { addMidpoints, cutAtPoints, deleteSelectedPoints, joinPoints, nudgePoints, selectedPointInfo, setPointMode, straightenPoints, toggleClosed } from '../editor/pathtool.ts';
import { addAsset, assetUrl, commit, doc, localSet, page, pageId, pathEdit, selection, toast, update } from '../editor/store.ts';
import { ColorPicker, cssColor } from './ColorPicker.tsx';
import { IconButton, Num, Popover, Section, Select, icons } from './controls.tsx';

// The design panel: geometry, appearance, text, effects and export of the selection.

type Change = (fn: (n: Node) => Node, final?: boolean) => void;

/** value shared by all items, or null when they differ */
function shared<T, V>(items: T[], get: (t: T) => V): V | null {
  if (!items.length) return null;
  const first = get(items[0]);
  const key = JSON.stringify(first);
  return items.every(i => JSON.stringify(get(i)) === key) ? first : null;
}

// ---------------------------------------------------------------- transform

function TransformSection({ nodes }: { nodes: Node[] }) {
  const d = doc.value;
  const ids = nodes.map(n => n.id);
  const single = nodes.length === 1 ? nodes[0] : null;
  let x: number, y: number, w: number, h: number, rot = 0;
  if (single) {
    const b = localBounds(d, single.id), m = single.transform;
    const o = apply(m, { x: b.x, y: b.y });
    x = o.x; y = o.y; w = b.w * Math.hypot(m[0], m[1]); h = b.h * Math.hypot(m[2], m[3]);
    rot = (-rotationOf(m) * 180) / Math.PI;
  } else {
    const b = worldBoundsOf(d, ids) ?? { x: 0, y: 0, w: 0, h: 0 };
    x = b.x; y = b.y; w = b.w; h = b.h;
  }
  const run = (fn: (cur: typeof d) => typeof d, final: boolean) => update(fn, { transient: !final });
  const moveBy = (dx: number, dy: number, final: boolean) => {
    if (single) run(cur => transformNodes(cur, [{ id: single.id, T: translate(dx, dy) }]), final);
    else run(cur => transformWorld(cur, ids, translate(dx, dy)), final);
  };
  // scrubbing reports absolute values; apply them relative to the last committed state
  const base = useRef<{ doc: typeof d; x: number; y: number; w: number; h: number; rot: number } | null>(null);
  const begin = () => (base.current ??= { doc: d, x, y, w, h, rot });
  const end = (final: boolean) => { if (final) base.current = null; };
  const resize = (nw: number, nh: number, final: boolean) => {
    const b0 = begin();
    const sx = b0.w > 1e-9 ? Math.max(nw, 0.01) / b0.w : 1, sy = b0.h > 1e-9 ? Math.max(nh, 0.01) / b0.h : 1;
    if (single) {
      const n0 = b0.doc.nodes[single.id];
      if (n0.type === 'text') {
        update(() => setNodes(b0.doc, [single.id], n => ({ ...(n as TextNode), w: Math.max(1, nw) })), { transient: !final });
      } else {
        const lb = localBounds(b0.doc, single.id), M = n0.transform;
        const T = mul(M, mul(around(scaleM(sx, sy), { x: lb.x, y: lb.y }), invert(M)));
        update(() => transformNodes(b0.doc, [{ id: single.id, T }]), { transient: !final });
      }
    } else update(() => transformWorld(b0.doc, ids, around(scaleM(sx, sy), { x: b0.x, y: b0.y })), { transient: !final });
    end(final);
  };
  const setRot = (deg: number, final: boolean) => {
    if (!single) return;
    const b0 = begin();
    const n0 = b0.doc.nodes[single.id], lb = localBounds(b0.doc, single.id);
    const c = apply(n0.transform, { x: lb.x + lb.w / 2, y: lb.y + lb.h / 2 });
    const T = around(rotate((-(deg - b0.rot) * Math.PI) / 180), c);
    update(() => transformNodes(b0.doc, [{ id: single.id, T }]), { transient: !final });
    end(final);
  };
  const abs = (axis: 'x' | 'y') => (v: number, final: boolean) => {
    const b0 = begin();
    const dx = axis === 'x' ? v - b0.x : 0, dy = axis === 'y' ? v - b0.y : 0;
    if (single) update(() => transformNodes(b0.doc, [{ id: single.id, T: translate(dx, dy) }]), { transient: !final });
    else update(() => transformWorld(b0.doc, ids, translate(dx, dy)), { transient: !final });
    end(final);
  };
  void moveBy;
  const isText = single?.type === 'text';
  return (
    <Section title="Position">
      <div class="row icons-row">
        <IconButton icon={icons.alignLeft} title="Align left (Alt+A)" onClick={() => align('left')} />
        <IconButton icon={icons.alignHCenter} title="Align horizontal centers (Alt+H)" onClick={() => align('hcenter')} />
        <IconButton icon={icons.alignRight} title="Align right (Alt+D)" onClick={() => align('right')} />
        <IconButton icon={icons.alignTop} title="Align top (Alt+W)" onClick={() => align('top')} />
        <IconButton icon={icons.alignVCenter} title="Align vertical centers (Alt+V)" onClick={() => align('vcenter')} />
        <IconButton icon={icons.alignBottom} title="Align bottom (Alt+S)" onClick={() => align('bottom')} />
        <IconButton icon={icons.distH} title="Distribute horizontal spacing" disabled={nodes.length < 3} onClick={() => distribute('x')} />
        <IconButton icon={icons.distV} title="Distribute vertical spacing" disabled={nodes.length < 3} onClick={() => distribute('y')} />
      </div>
      <div class="row grid2">
        <Num label="X" value={x} onChange={abs('x')} />
        <Num label="Y" value={y} onChange={abs('y')} />
        <Num label="W" value={w} min={0.01} onChange={(v, f) => { const bw = base.current?.w ?? w, bh = base.current?.h ?? h; resize(v, lockAspect.value && bw > 0 ? (v * bh) / bw : bh, f); }} />
        <Num label="H" value={h} min={0.01} disabled={isText} onChange={(v, f) => { const bw = base.current?.w ?? w, bh = base.current?.h ?? h; resize(lockAspect.value && bh > 0 ? (v * bw) / bh : bw, v, f); }} />
        <Num label="∠" title="Rotation" value={single ? rot : null} suffix="°" disabled={!single} placeholder="–" onChange={setRot} />
        <div class="row icons-row">
          <IconButton icon={<span class="txt-icon">{lockAspect.value ? '🔗' : '⛓'}</span>} title="Constrain proportions" active={lockAspect.value} onClick={() => { lockAspect.value = !lockAspect.value; }} />
          <IconButton icon={icons.flipH} title="Flip horizontal (Shift+H)" onClick={() => flip('x')} />
          <IconButton icon={icons.flipV} title="Flip vertical (Shift+V)" onClick={() => flip('y')} />
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- shape specifics

function ShapeSection({ nodes, change }: { nodes: Node[]; change: Change }) {
  const rects = nodes.filter(n => n.type === 'rect');
  const polys = nodes.filter(n => n.type === 'polygon');
  const stars = nodes.filter(n => n.type === 'star');
  const [split, setSplit] = useState(false);
  if (rects.length + polys.length + stars.length !== nodes.length || !nodes.length) return null;
  const uniform = shared(rects, r => (r.type === 'rect' && r.radii.every(v => v === r.radii[0]) ? r.radii[0] : null));
  const radii = shared(rects, r => (r.type === 'rect' ? r.radii : null));
  return (
    <Section title="Shape">
      {rects.length > 0 && (
        <div class="row grid2">
          <Num label="◜" title="Corner radius" value={uniform} min={0} placeholder="Mixed"
            onChange={(v, f) => change(n => (n.type === 'rect' ? { ...n, radii: [v, v, v, v] } : n), f)} />
          <IconButton icon={<span class="txt-icon">⌜⌟</span>} title="Independent corners" active={split} onClick={() => setSplit(!split)} />
          {split && (['Top left', 'Top right', 'Bottom right', 'Bottom left'] as const).map((t, i) => (
            <Num label={['◜', '◝', '◞', '◟'][i]} title={t} value={radii ? radii[i] : null} min={0}
              onChange={(v, f) => change(n => { if (n.type !== 'rect') return n; const r = n.radii.slice() as typeof n.radii; r[i] = v; return { ...n, radii: r }; }, f)} />
          ))}
        </div>
      )}
      {polys.length > 0 && <div class="row grid2"><Num label="Sides" value={shared(polys, n => (n.type === 'polygon' ? n.sides : 0))} min={3} max={60} onChange={(v, f) => change(n => (n.type === 'polygon' ? { ...n, sides: Math.round(v) } : n), f)} /></div>}
      {stars.length > 0 && (
        <div class="row grid2">
          <Num label="Points" value={shared(stars, n => (n.type === 'star' ? n.points : 0))} min={3} max={60} onChange={(v, f) => change(n => (n.type === 'star' ? { ...n, points: Math.round(v) } : n), f)} />
          <Num label="Ratio" value={shared(stars, n => (n.type === 'star' ? n.inner : 0))} scale={100} suffix="%" min={0.01} max={1} onChange={(v, f) => change(n => (n.type === 'star' ? { ...n, inner: v } : n), f)} />
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- lines, arrows, connectors

const CAPS: { value: ArrowCap; label: string }[] = [
  { value: 'none', label: 'None' }, { value: 'arrow', label: 'Arrow' }, { value: 'triangle', label: 'Triangle' },
  { value: 'circle', label: 'Circle' }, { value: 'diamond', label: 'Diamond' },
];

function LineSection({ nodes, change }: { nodes: Node[]; change: Change }) {
  const paths = nodes.filter((n): n is PathNode => n.type === 'path' && n.subpaths.some(sp => !sp.closed));
  if (!paths.length || paths.length !== nodes.length) return null;
  const conns = paths.filter(p => p.connector);
  const all = conns.length === paths.length;
  const setConn = (patch: Partial<Connector>, final = true) => {
    Object.assign(connectorStyle, patch);
    change(n => (n.type === 'path' && n.connector ? { ...n, connector: { ...n.connector, ...patch } } : n), final);
  };
  const setCap = (end: 'startCap' | 'endCap') => (v: ArrowCap) => {
    if (all) connectorStyle[end] = v;
    change(n => (n.type === 'path' ? { ...n, [end]: v } : n));
  };
  const kind = shared(conns, p => p.connector!.kind);
  return (
    <Section title={all ? 'Connector' : 'Line ends'}>
      {all && (
        <div class="row grid2">
          <Select value={kind} title="How the connector runs between its ends"
            options={[{ value: 'elbow', label: 'Elbow' }, { value: 'straight', label: 'Straight' }, { value: 'curved', label: 'Curved' }]}
            onChange={v => setConn({ kind: v })} />
          <Num label="◜" title="Radius of the rounded bends" value={shared(conns, p => p.connector!.radius)} min={0} placeholder="Mixed" disabled={kind !== 'elbow'}
            onChange={(v, f) => setConn({ radius: v }, f)} />
        </div>
      )}
      <div class="row grid2">
        <Select value={shared(paths, p => p.startCap ?? 'none')} title="Start of the line" options={CAPS.map(c => ({ value: c.value, label: `Start: ${c.label}` }))} onChange={setCap('startCap')} />
        <Select value={shared(paths, p => p.endCap ?? 'none')} title="End of the line" options={CAPS.map(c => ({ value: c.value, label: `End: ${c.label}` }))} onChange={setCap('endCap')} />
      </div>
      {all && (
        <div class="row">
          <button type="button" class="btn" title="Swap the two ends" onClick={() => change(n => (n.type === 'path' && n.connector
            ? { ...n, startCap: n.endCap, endCap: n.startCap, connector: { ...n.connector, from: n.connector.to, to: n.connector.from }, subpaths: n.subpaths.map(sp => ({ ...sp, pts: [sp.pts[sp.pts.length - 1], sp.pts[0]] })) }
            : n))}>Reverse direction</button>
        </div>
      )}
    </Section>
  );
}

function LayerSection({ nodes, change }: { nodes: Node[]; change: Change }) {
  return (
    <Section title="Layer">
      <div class="row grid2">
        <Num label="Opacity" value={shared(nodes, n => n.opacity)} scale={100} suffix="%" min={0} max={1} onChange={(v, f) => change(n => ({ ...n, opacity: v }), f)} />
        <Select value={shared(nodes, n => n.blend)} options={BLEND_MODES} title="Blend mode" onChange={v => change(n => ({ ...n, blend: v }))} />
      </div>
      <div class="row">
        <label class="check"><input type="checkbox" checked={nodes.every(n => n.mask)} onChange={() => toggleMask()} /> Use as mask <span class="hint">(clips the layers above it)</span></label>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- text

const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' };

function FontPicker({ value, onPick }: { value: string | null; onPick: (family: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const btn = useRef<HTMLButtonElement>(null);
  const list = families.value;
  const shown = (q ? list.filter(f => f.toLowerCase().includes(q.toLowerCase())) : list).slice(0, 300);
  const missing = value != null && !hasFamily(value);
  return (
    <>
      <button ref={btn} type="button" class={`select font-btn ${missing ? 'warn' : ''}`} title={missing ? `"${value}" is not installed – a fallback font is shown` : 'Font family'} onClick={() => { setOpen(!open); setQ(''); }}>
        <span>{value ?? 'Mixed'}{missing ? ' ⚠' : ''}</span>{icons.chevronDown}
      </button>
      {open && (
        <Popover anchor={btn.current} onClose={() => setOpen(false)} width={260}>
          <input class="search" type="text" placeholder={`Search ${list.length} fonts`} value={q} autoFocus
            onInput={e => setQ(e.currentTarget.value)}
            onKeyDown={e => { if (e.key === 'Enter' && shown[0]) { onPick(shown[0]); setOpen(false); } if (e.key !== 'Escape') e.stopPropagation(); }} />
          <div class="font-list">
            {shown.map(f => <button type="button" class={f === value ? 'active' : ''} onClick={() => { onPick(f); setOpen(false); }}>{f}</button>)}
            {!shown.length && <div class="empty">No fonts match. Drop a .ttf / .otf file on the canvas to add one to this project.</div>}
          </div>
          {canUseLocalFonts() && !localFontsLoaded.value && (
            <div class="row"><button type="button" class="btn wide" title="The browser asks for permission once" onClick={() => void loadLocalFonts().then(n => toast(n ? `Added ${n} font families from this computer` : 'No fonts were shared')).catch(e => toast(`Could not read installed fonts: ${e instanceof Error ? e.message : e}`, 'error'))}>Add fonts installed on this computer</button></div>
          )}
        </Popover>
      )}
    </>
  );
}

function TextSection({ nodes, change }: { nodes: TextNode[]; change: Change }) {
  void fontsVersion.value;
  const family = shared(nodes, n => n.font.family);
  const weight = shared(nodes, n => n.font.weight), italic = shared(nodes, n => n.font.italic);
  const faces = family ? facesOf(family) : [];
  const styleKey = weight != null && italic != null ? `${weight}${italic ? 'i' : ''}` : null;
  const styles = faces.length
    ? faces.map(f => ({ value: `${f.weight}${f.italic ? 'i' : ''}`, label: `${WEIGHT_NAMES[f.weight] ?? f.weight}${f.italic ? ' Italic' : ''}` }))
    : [400, 700].flatMap(wt => [{ value: `${wt}`, label: WEIGHT_NAMES[wt] }, { value: `${wt}i`, label: `${WEIGHT_NAMES[wt]} Italic` }]);
  if (styleKey && !styles.some(s => s.value === styleKey)) styles.push({ value: styleKey, label: `${WEIGHT_NAMES[weight!] ?? weight}${italic ? ' Italic' : ''}` });
  const t = (fn: (n: TextNode) => TextNode, final = true) => change(n => (n.type === 'text' ? fn(n) : n), final);
  const lh = shared(nodes, n => n.lineHeight);
  const autoLh = nodes.every(n => n.lineHeight == null);
  return (
    <Section title="Text">
      <div class="row">
        <FontPicker value={family} onPick={f => {
          const faceList = facesOf(f);
          t(n => {
            // keep the weight if the new family has it, else the nearest
            const best = faceList.reduce<{ weight: number; italic: boolean } | null>((b, c) => (!b || Math.abs(c.weight - n.font.weight) + (c.italic === n.font.italic ? 0 : 1000) < Math.abs(b.weight - n.font.weight) + (b.italic === n.font.italic ? 0 : 1000) ? c : b), null);
            const font = { family: f, weight: best?.weight ?? n.font.weight, italic: best?.italic ?? n.font.italic };
            void ensureFont(font);
            Object.assign(lastFont, font);
            return { ...n, font };
          });
        }} />
      </div>
      <div class="row grid2">
        <Select value={styleKey} options={styles} title="Font style" onChange={v => t(n => { const font = { ...n.font, weight: parseInt(v, 10), italic: v.endsWith('i') }; Object.assign(lastFont, font); return { ...n, font }; })} />
        <Num label="Size" value={shared(nodes, n => n.size)} min={1} max={2000} onChange={(v, f) => { lastFont.size = v; t(n => ({ ...n, size: v }), f); }} />
        <Num label="↕" title="Line height (empty = automatic)" value={autoLh ? null : lh} placeholder={autoLh ? 'Auto' : 'Mixed'} min={1} onChange={(v, f) => t(n => ({ ...n, lineHeight: v }), f)} />
        <Num label="↔" title="Letter spacing" value={shared(nodes, n => n.letterSpacing)} step={0.1} onChange={(v, f) => t(n => ({ ...n, letterSpacing: v }), f)} />
      </div>
      <div class="row icons-row">
        {(['left', 'center', 'right'] as const).map(a => (
          <IconButton icon={a === 'left' ? icons.textLeft : a === 'center' ? icons.textCenter : icons.textRight} title={`Align ${a}`} active={nodes.every(n => n.align === a)} onClick={() => t(n => ({ ...n, align: a }))} />
        ))}
        <span class="spacer" />
        {!autoLh && <button type="button" class="link" onClick={() => t(n => ({ ...n, lineHeight: null }))}>Auto line height</button>}
        <button type="button" class="link" title="Text box grows with its content" disabled={nodes.every(n => n.w == null)} onClick={() => t(n => ({ ...n, w: null }))}>Auto width</button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- paints

function paintCss(p: Paint): string {
  if (p.type === 'solid') return cssColor(p.color);
  if (p.type === 'gradient') {
    const stops = p.stops.map(s => `${cssColor(s.color)} ${s.offset * 100}%`).join(',');
    return p.kind === 'linear' ? `linear-gradient(90deg,${stops})` : `radial-gradient(circle,${stops})`;
  }
  return `center/cover url("${assetUrl(p.asset)}")`;
}

function toGradient(p: Paint, kind: 'linear' | 'radial'): GradientPaint {
  const base = { visible: p.visible, opacity: p.opacity, blend: p.blend };
  const stops = p.type === 'gradient' ? p.stops : (() => { const c = p.type === 'solid' ? p.color : DEFAULT_FILL; return [{ offset: 0, color: c }, { offset: 1, color: { ...c, a: 0 } }]; })();
  return kind === 'linear'
    ? { ...base, type: 'gradient', kind, stops, from: { x: 0.5, y: 0 }, to: { x: 0.5, y: 1 }, width: 1 }
    : { ...base, type: 'gradient', kind, stops, from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 }, width: 1 };
}

function GradientEditor({ paint, set }: { paint: GradientPaint; set: (p: Paint, final: boolean) => void }) {
  const [active, setActive] = useState(0);
  const i = Math.min(active, paint.stops.length - 1);
  const bar = useRef<HTMLDivElement>(null);
  const setStops = (stops: GradientPaint['stops'], final: boolean) => set({ ...paint, stops }, final);
  const angle = (Math.atan2(paint.to.y - paint.from.y, paint.to.x - paint.from.x) * 180) / Math.PI;
  const dragStop = (idx: number) => (e: PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    setActive(idx);
    const el = bar.current!;
    const id = paint.stops[idx];
    let cur = paint.stops;
    const move = (ev: PointerEvent, final: boolean) => {
      const r = el.getBoundingClientRect();
      const off = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      cur = paint.stops.map(s => (s === id ? { ...s, offset: off } : s));
      const sorted = cur.slice().sort((a, b) => a.offset - b.offset);
      setActive(sorted.findIndex(s => s.offset === off && s.color === id.color));
      setStops(sorted, final);
    };
    const mm = (ev: PointerEvent) => move(ev, false);
    const up = (ev: PointerEvent) => { window.removeEventListener('pointermove', mm); window.removeEventListener('pointerup', up); move(ev, true); };
    window.addEventListener('pointermove', mm);
    window.addEventListener('pointerup', up);
  };
  return (
    <div class="gradient-editor">
      <div ref={bar} class="grad-bar" style={{ background: `linear-gradient(90deg,${paint.stops.map(s => `${cssColor(s.color)} ${s.offset * 100}%`).join(',')})` }}
        onPointerDown={e => {
          const r = e.currentTarget.getBoundingClientRect();
          const off = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
          const next = [...paint.stops, { offset: off, color: paint.stops[i].color }].sort((a, b) => a.offset - b.offset);
          setActive(next.findIndex(s => s.offset === off));
          setStops(next, true);
        }}>
        {paint.stops.map((s, idx) => <div class={`grad-stop ${idx === i ? 'active' : ''}`} style={{ left: `${s.offset * 100}%`, background: hex(s.color) }} onPointerDown={dragStop(idx)} />)}
      </div>
      <div class="row grid2">
        <Num label="Stop" value={paint.stops[i].offset} scale={100} suffix="%" min={0} max={1} onChange={(v, f) => setStops(paint.stops.map((s, k) => (k === i ? { ...s, offset: v } : s)).sort((a, b) => a.offset - b.offset), f)} />
        {paint.kind === 'linear'
          ? <Num label="∠" title="Angle" value={angle} suffix="°" onChange={(v, f) => { const a = (v * Math.PI) / 180, dx = Math.cos(a) / 2, dy = Math.sin(a) / 2; set({ ...paint, from: { x: 0.5 - dx, y: 0.5 - dy }, to: { x: 0.5 + dx, y: 0.5 + dy } }, f); }} />
          : <Num label="R" title="Radius" value={Math.hypot(paint.to.x - paint.from.x, paint.to.y - paint.from.y)} scale={100} suffix="%" min={0.01} onChange={(v, f) => set({ ...paint, to: { x: paint.from.x + v, y: paint.from.y } }, f)} />}
      </div>
      <div class="row">
        <button type="button" class="link" disabled={paint.stops.length <= 2} onClick={() => { setStops(paint.stops.filter((_, k) => k !== i), true); setActive(0); }}>Remove stop</button>
        <span class="spacer" />
        <button type="button" class="link" onClick={() => setStops(paint.stops.map(s => ({ ...s, offset: 1 - s.offset })).reverse(), true)}>Reverse</button>
      </div>
      <ColorPicker color={paint.stops[i].color} onChange={(c, f) => setStops(paint.stops.map((s, k) => (k === i ? { ...s, color: c } : s)), f)} />
    </div>
  );
}

function ImageEditor({ paint, set }: { paint: Paint; set: (p: Paint, final: boolean) => void }) {
  const pick = async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const bmp = await createImageBitmap(file);
      const ext = (file.name.split('.').pop() ?? file.type.split('/')[1] ?? 'png').toLowerCase();
      const key = await addAsset(bytes, ext);
      update(cur => ({ ...cur, assets: { ...cur.assets, [key]: { mime: file.type || 'image/png', w: bmp.width, h: bmp.height, name: file.name } } }), { transient: true });
      set({ type: 'image', asset: key, mode: paint.type === 'image' ? paint.mode : 'fill', visible: paint.visible, opacity: paint.opacity, blend: paint.blend }, true);
    } catch (e) { toast(`Could not use that image: ${e instanceof Error ? e.message : e}`, 'error'); }
  };
  return (
    <div class="image-editor">
      {paint.type === 'image' && <div class="image-preview" style={{ background: paintCss(paint) }} />}
      <div class="row grid2">
        <label class="btn">Choose image…<input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" hidden onChange={e => { const f = e.currentTarget.files?.[0]; if (f) void pick(f); }} /></label>
        {paint.type === 'image' && <Select value={paint.mode} options={['fill', 'fit', 'stretch', 'tile']} onChange={mode => set({ ...paint, mode }, true)} />}
      </div>
      {paint.type === 'image' && paint.mode === 'tile' && <div class="row grid2"><Num label="Scale" value={paint.scale ?? 1} scale={100} suffix="%" min={0.01} onChange={(v, f) => set({ ...paint, scale: v }, f)} /></div>}
    </div>
  );
}

function PaintRow({ paint, set, remove, allowImage, target }: { paint: Paint; set: (p: Paint, final: boolean) => void; remove: () => void; allowImage: boolean; target: { id: string; prop: 'fills' | 'strokes'; index: number } | null }) {
  const [open, setOpen] = useState(false);
  // while a gradient is being edited its end points can be dragged on the canvas
  useEffect(() => { if (open && target && paint.type === 'gradient') gradientEdit.value = target; }, [open, paint.type, target?.id, target?.index]);
  const sw = useRef<HTMLButtonElement>(null);
  const kind = paint.type === 'gradient' ? paint.kind : paint.type;
  const label = paint.type === 'solid' ? hex(paint.color).slice(1).toUpperCase() : paint.type === 'gradient' ? (paint.kind === 'linear' ? 'Linear' : 'Radial') : 'Image';
  const switchTo = (k: string) => {
    if (k === kind) return;
    if (k === 'solid') set({ type: 'solid', color: paint.type === 'gradient' ? paint.stops[0].color : DEFAULT_FILL, visible: paint.visible, opacity: paint.opacity, blend: paint.blend }, true);
    else if (k === 'linear' || k === 'radial') set(toGradient(paint, k), true);
    else if (k === 'image' && paint.type !== 'image') setOpen(true), setTab('image');
  };
  const [tab, setTab] = useState<string | null>(null);
  const cur = tab === 'image' && paint.type !== 'image' ? 'image' : kind;
  return (
    <div class={`paint-row ${paint.visible ? '' : 'off'}`}>
      <button ref={sw} type="button" class="swatch" aria-label="Edit paint" onClick={() => { setOpen(!open); setTab(null); }}>
        <span style={{ background: paintCss(paint) }} />
      </button>
      <span class="paint-label" onClick={() => setOpen(!open)}>{label}</span>
      <Num value={paint.opacity} scale={100} suffix="%" min={0} max={1} class="narrow" title="Opacity" onChange={(v, f) => set({ ...paint, opacity: v }, f)} />
      <IconButton icon={paint.visible ? icons.eye : icons.eyeOff} title={paint.visible ? 'Hide' : 'Show'} onClick={() => set({ ...paint, visible: !paint.visible }, true)} />
      <IconButton icon={icons.minus} title="Remove" onClick={remove} />
      {open && (
        <Popover anchor={sw.current} onClose={() => setOpen(false)} width={248}>
          <div class="tabs">
            {(['solid', 'linear', 'radial', ...(allowImage ? ['image'] : [])] as string[]).map(k => (
              <button type="button" class={cur === k ? 'active' : ''} onClick={() => { setTab(k === 'image' ? 'image' : null); switchTo(k); }}>{k[0].toUpperCase() + k.slice(1)}</button>
            ))}
          </div>
          {cur === 'image' ? <ImageEditor paint={paint} set={set} />
            : paint.type === 'solid' ? <ColorPicker color={paint.color} onChange={(c, f) => set({ ...paint, color: c }, f)} />
            : paint.type === 'gradient' ? <GradientEditor paint={paint} set={set} /> : null}
          <div class="row"><span class="dim">Blend</span><Select value={paint.blend ?? 'normal'} options={BLEND_MODES} onChange={b => set({ ...paint, blend: b === 'normal' ? undefined : b }, true)} /></div>
        </Popover>
      )}
    </div>
  );
}

function PaintList({ title, nodes, prop, change }: { title: string; nodes: ShapeNode[]; prop: 'fills' | 'strokes'; change: Change }) {
  const list = shared(nodes, n => n[prop]);
  const setList = (fn: (l: Paint[]) => Paint[], final = true) => change(n => (isShape(n) ? { ...n, [prop]: fn(n[prop]) } : n), final);
  const add = () => {
    const p = solid(prop === 'fills' ? DEFAULT_FILL : BLACK);
    if (list == null) setList(() => [p]); else setList(l => [...l, p]);
  };
  return (
    <Section title={title} action={<IconButton icon={icons.plus} title={`Add ${prop === 'fills' ? 'fill' : 'stroke'}`} onClick={add} />}>
      {list == null && <div class="row dim">Mixed – click + to replace</div>}
      {/* top-most paint first, like the layer list */}
      {list?.map((_, k) => list.length - 1 - k).map(i => (
        <PaintRow key={i} paint={list[i]} allowImage={prop === 'fills'} target={nodes.length === 1 ? { id: nodes[0].id, prop, index: i } : null}
          set={(p, f) => setList(l => l.map((x, k) => (k === i ? p : x)), f)}
          remove={() => setList(l => l.filter((_, k) => k !== i))} />
      ))}
      {prop === 'strokes' && list != null && list.length > 0 && (
        <>
          <div class="row grid2">
            <Num label="Weight" value={shared(nodes, n => n.strokeWeight)} min={0} step={0.5} onChange={(v, f) => change(n => (isShape(n) ? { ...n, strokeWeight: v } : n), f)} />
            <Select value={shared(nodes, n => n.strokeAlign)} options={['center', 'inside', 'outside']} title="Stroke position" onChange={v => change(n => (isShape(n) ? { ...n, strokeAlign: v } : n))} />
            <Select value={shared(nodes, n => n.strokeCap)} options={[{ value: 'butt', label: 'Cap: none' }, { value: 'round', label: 'Cap: round' }, { value: 'square', label: 'Cap: square' }]} onChange={v => change(n => (isShape(n) ? { ...n, strokeCap: v } : n))} />
            <Select value={shared(nodes, n => n.strokeJoin)} options={[{ value: 'miter', label: 'Join: miter' }, { value: 'round', label: 'Join: round' }, { value: 'bevel', label: 'Join: bevel' }]} onChange={v => change(n => (isShape(n) ? { ...n, strokeJoin: v } : n))} />
          </div>
          <DashInput value={shared(nodes, n => n.dash)} onChange={dash => change(n => (isShape(n) ? { ...n, dash } : n))} />
        </>
      )}
    </Section>
  );
}

function DashInput({ value, onChange }: { value: number[] | null; onChange: (d: number[]) => void }) {
  return (
    <div class="row">
      <label class="num wide" title="Dash pattern: dash and gap lengths, e.g. 4 2"><span class="num-label">Dash</span>
        <input type="text" placeholder={value == null ? 'Mixed' : 'solid'} value={value?.join(' ') ?? ''} spellcheck={false}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }}
          onBlur={e => {
            const next = e.currentTarget.value.split(/[\s,]+/).map(Number).filter(v => Number.isFinite(v) && v >= 0);
            if (JSON.stringify(next) !== JSON.stringify(value ?? [])) onChange(next.some(v => v > 0) ? next : []);
          }} />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------- effects

const EFFECT_LABELS: Record<Effect['type'], string> = {
  'drop-shadow': 'Drop shadow', 'inner-shadow': 'Inner shadow', 'layer-blur': 'Layer blur', 'background-blur': 'Background blur', noise: 'Noise', texture: 'Texture',
};
const SHADOW: Color = { r: 0, g: 0, b: 0, a: 0.25 };
function makeEffect(type: Effect['type']): Effect {
  switch (type) {
    case 'drop-shadow': case 'inner-shadow': return { type, visible: true, color: SHADOW, x: 0, y: 4, blur: 4, spread: 0 };
    case 'layer-blur': case 'background-blur': return { type, visible: true, blur: 4 };
    case 'noise': return { type, visible: true, size: 1, density: 0.5, color: { r: 0, g: 0, b: 0, a: 0.25 } };
    case 'texture': return { type, visible: true, size: 8, radius: 4 };
  }
}

function EffectRow({ fx, set, remove }: { fx: Effect; set: (e: Effect, final: boolean) => void; remove: () => void }) {
  const [open, setOpen] = useState(false);
  const sw = useRef<HTMLButtonElement>(null);
  const hasColor = fx.type === 'drop-shadow' || fx.type === 'inner-shadow' || fx.type === 'noise';
  return (
    <div class={`effect ${fx.visible ? '' : 'off'}`}>
      <div class="paint-row">
        {hasColor
          ? <button ref={sw} type="button" class="swatch" aria-label="Effect color" onClick={() => setOpen(!open)}><span style={{ background: cssColor(fx.color) }} /></button>
          : <span class="swatch ghost" />}
        <Select value={fx.type} options={(Object.keys(EFFECT_LABELS) as Effect['type'][]).map(v => ({ value: v, label: EFFECT_LABELS[v] }))} onChange={t => set({ ...makeEffect(t), visible: fx.visible }, true)} />
        <IconButton icon={fx.visible ? icons.eye : icons.eyeOff} title={fx.visible ? 'Hide' : 'Show'} onClick={() => set({ ...fx, visible: !fx.visible }, true)} />
        <IconButton icon={icons.minus} title="Remove" onClick={remove} />
      </div>
      <div class="row grid2 effect-params">
        {(fx.type === 'drop-shadow' || fx.type === 'inner-shadow') && (<>
          <Num label="X" value={fx.x} onChange={(v, f) => set({ ...fx, x: v }, f)} />
          <Num label="Y" value={fx.y} onChange={(v, f) => set({ ...fx, y: v }, f)} />
          <Num label="Blur" value={fx.blur} min={0} onChange={(v, f) => set({ ...fx, blur: v }, f)} />
          <Num label="Spread" value={fx.spread} min={0} onChange={(v, f) => set({ ...fx, spread: v }, f)} />
        </>)}
        {(fx.type === 'layer-blur' || fx.type === 'background-blur') && <Num label="Blur" value={fx.blur} min={0} onChange={(v, f) => set({ ...fx, blur: v }, f)} />}
        {fx.type === 'background-blur' && <div class="hint span2">Kept for Figma round-trips; not rendered (SVG has no backdrop blur).</div>}
        {fx.type === 'noise' && (<>
          <Num label="Size" value={fx.size} min={0.1} step={0.1} onChange={(v, f) => set({ ...fx, size: v }, f)} />
          <Num label="Density" value={fx.density} scale={100} suffix="%" min={0} max={1} onChange={(v, f) => set({ ...fx, density: v }, f)} />
        </>)}
        {fx.type === 'texture' && (<>
          <Num label="Size" value={fx.size} min={0.5} step={0.5} onChange={(v, f) => set({ ...fx, size: v }, f)} />
          <Num label="Radius" value={fx.radius} min={0} onChange={(v, f) => set({ ...fx, radius: v }, f)} />
        </>)}
      </div>
      {open && hasColor && <Popover anchor={sw.current} onClose={() => setOpen(false)} width={248}><ColorPicker color={fx.color} onChange={(c, f) => set({ ...fx, color: c }, f)} /></Popover>}
    </div>
  );
}

function EffectsSection({ nodes, change }: { nodes: Node[]; change: Change }) {
  const list = shared(nodes, n => n.effects);
  const setList = (fn: (l: Effect[]) => Effect[], final = true) => change(n => ({ ...n, effects: fn(n.effects) }), final);
  return (
    <Section title="Effects" action={<IconButton icon={icons.plus} title="Add effect" onClick={() => (list == null ? setList(() => [makeEffect('drop-shadow')]) : setList(l => [...l, makeEffect('drop-shadow')]))} />}>
      {list == null && <div class="row dim">Mixed – click + to replace</div>}
      {list?.map((fx, i) => <EffectRow key={i} fx={fx} set={(e, f) => setList(l => l.map((x, k) => (k === i ? e : x)), f)} remove={() => setList(l => l.filter((_, k) => k !== i))} />)}
    </Section>
  );
}

// ---------------------------------------------------------------- export + page

function ExportSection({ hasSelection }: { hasSelection: boolean }) {
  const [format, setFormat] = useState<ExportFormat>('svg');
  const [scale, setScale] = useState(2);
  const [outline, setOutline] = useState(false);
  const [bg, setBg] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Section title={hasSelection ? 'Export selection' : 'Export page'}>
      <div class="row grid2">
        <Select value={format} options={[{ value: 'svg', label: 'SVG' }, { value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }, { value: 'pdf', label: 'PDF' }]} onChange={setFormat} />
        {(format === 'png' || format === 'jpg') ? <Num label="Scale" value={scale} suffix="x" min={0.1} max={32} step={0.5} onChange={v => setScale(v)} /> : <span />}
      </div>
      {format === 'svg' && <div class="row"><label class="check"><input type="checkbox" checked={outline} onChange={e => setOutline(e.currentTarget.checked)} /> Outline text</label></div>}
      <div class="row"><label class="check"><input type="checkbox" checked={bg} onChange={e => setBg(e.currentTarget.checked)} /> Include page background</label></div>
      <div class="row"><button type="button" class="btn primary wide" disabled={busy} onClick={async () => { setBusy(true); await exportSelection(format, scale, { outlineText: outline, background: bg, selectionOnly: hasSelection }); setBusy(false); }}>{busy ? 'Exporting…' : `Export ${format.toUpperCase()}`}</button></div>
    </Section>
  );
}

function PageSection() {
  const p = page.value;
  const [open, setOpen] = useState(false);
  const sw = useRef<HTMLButtonElement>(null);
  const set = (c: Color, final: boolean) => update(d => setPage(d, pageId.value, { background: c }), { transient: !final });
  return (
    <Section title="Page">
      <div class="paint-row">
        <button ref={sw} type="button" class="swatch" aria-label="Page background" onClick={() => setOpen(!open)}><span style={{ background: cssColor(p.background) }} /></button>
        <span class="paint-label" onClick={() => setOpen(!open)}>{hex(p.background).slice(1).toUpperCase()}</span>
        <span class="dim">Background</span>
      </div>
      {open && <Popover anchor={sw.current} onClose={() => setOpen(false)} width={248}><ColorPicker color={p.background} alpha={false} onChange={set} /></Popover>}
    </Section>
  );
}

function PointsSection() {
  void doc.value;
  const pe = pathEdit.value;
  const info = selectedPointInfo();
  const n = pe?.sel.length ?? 0;
  const move = (axis: 'x' | 'y') => (v: number, final: boolean) => { if (final && info) nudgePoints(axis === 'x' ? v - info.x : 0, axis === 'y' ? v - info.y : 0); };
  return (
    <Section title={n ? `${n} point${n > 1 ? 's' : ''}` : 'Vector'}>
      {!n && <div class="row dim">Select points to edit them. Drag the dot in the middle of a segment to add a point; use the pen to draw on or branch off.</div>}
      <div class="row grid2">
        <Num label="X" value={info ? info.x : null} placeholder="–" disabled={!info} onChange={move('x')} />
        <Num label="Y" value={info ? info.y : null} placeholder="–" disabled={!info} onChange={move('y')} />
      </div>
      <div class="row">
        <Select value={info ? info.mode : 'corner'} title="How the two curve handles of a point follow each other"
          options={[{ value: 'corner', label: 'No mirroring' }, { value: 'smooth', label: 'Mirror angle' }, { value: 'mirror', label: 'Mirror angle and length' }]}
          onChange={m => setPointMode(m)} />
      </div>
      <div class="row grid2 btn-grid">
        <button type="button" class="btn" disabled={!n} title="Turn the selected points into curves" onClick={() => setPointMode('smooth')}>Curve</button>
        <button type="button" class="btn" disabled={!n} title="Remove the curve handles" onClick={straightenPoints}>Straight</button>
        <button type="button" class="btn" disabled={n < 2} title="Add a point in the middle of each selected segment" onClick={addMidpoints}>Add point</button>
        <button type="button" class="btn" disabled={!n} title="Delete the selected points (Del)" onClick={() => void deleteSelectedPoints()}>Delete</button>
        <button type="button" class="btn" disabled={!n} title="Cut the path at the selected points" onClick={cutAtPoints}>Cut</button>
        <button type="button" class="btn" disabled={n !== 2} title="Connect two end points" onClick={() => void joinPoints()}>Join</button>
        <button type="button" class="btn span2" title="Open or close the path" onClick={toggleClosed}>Open / close path</button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- panel

export function RightPanel() {
  const d = doc.value;
  const ids = topMost(d, selection.value);
  const nodes = ids.map(id => d.nodes[id]).filter(Boolean);
  // scrubbing a field sends many transient changes followed by a final one
  const change: Change = (fn, final = true) => update(cur => setNodes(cur, ids, fn), { transient: !final });
  if (!nodes.length) {
    return (
      <aside class="panel right">
        <PageSection />
        <ExportSection hasSelection={false} />
        <Section title="Shortcuts">
          <div class="shortcuts">
            {[['V', 'Move'], ['R / O / L', 'Rectangle / Ellipse / Line'], ['P', 'Pen'], ['T', 'Text'], ['X', 'Connector'], ['Enter', 'Edit points / text'], ['Space + drag', 'Pan'], ['Ctrl + wheel', 'Zoom'], ['Shift + 1', 'Zoom to fit'], ['Alt + drag', 'Duplicate'], ['Ctrl + G', 'Group'], ['Ctrl + click', 'Select inside groups'], ['Ctrl (hold)', 'Disable snapping']].map(([k, v]) => <div><kbd>{k}</kbd><span>{v}</span></div>)}
          </div>
        </Section>
        <p class="legal">Free software under the GNU AGPL, version 3 or later. <a href="licenses.html" target="_blank" rel="noopener">Licences and source code</a></p>
      </aside>
    );
  }
  const shapes = nodes.filter(isShape);
  const texts = nodes.filter((n): n is TextNode => n.type === 'text');
  const allShapes = shapes.length === nodes.length;
  const kind = nodes.length === 1 ? ({ rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', path: 'Vector', text: 'Text', group: 'Group' } as const)[nodes[0].type].replace('Vector', nodes[0].type === 'path' && nodes[0].connector ? 'Connector' : 'Vector') : `${nodes.length} layers`;
  return (
    <aside class="panel right" key={pathEdit.value ? 'edit' : 'design'}>
      <div class="panel-title">{kind}{pathEdit.value && <span class="badge">editing points</span>}</div>
      {pathEdit.value && <PointsSection />}
      <TransformSection nodes={nodes} />
      <ShapeSection nodes={nodes} change={change} />
      {!pathEdit.value && <LineSection nodes={nodes} change={change} />}
      <LayerSection nodes={nodes} change={change} />
      {texts.length > 0 && texts.length === nodes.length && <TextSection nodes={texts} change={change} />}
      {allShapes && <PaintList title="Fill" nodes={shapes} prop="fills" change={change} />}
      {allShapes && <PaintList title="Stroke" nodes={shapes} prop="strokes" change={change} />}
      <EffectsSection nodes={nodes} change={change} />
      <ExportSection hasSelection />
    </aside>
  );
}

export { commit, localSet, worldMatrix };
export type { Mat };
