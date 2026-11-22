import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

// Small form controls used by the panels.

const round = (v: number, d = 2) => { const k = 10 ** d; return Math.round(v * k) / k; };

/** evaluates simple arithmetic like "100/3" or "+10" (relative to the current value) */
function parseNumber(text: string, current: number | null): number | null {
  const t = text.trim().replace(/,/g, '.').replace(/[°%px]+$/i, '');
  if (!t) return null;
  if (!/^[-+*/().\d\s]+$/.test(t)) return null;
  const rel = /^[+*/]/.test(t) && current != null ? `${current}${t}` : t;
  const v = evalExpr(rel);
  return v != null && Number.isFinite(v) ? v : null;
}

export interface NumProps {
  value: number | null;
  /** final=false while scrubbing (not yet an undo step) */
  onChange: (v: number, final: boolean) => void;
  label?: ComponentChildren;
  title?: string;
  min?: number; max?: number; step?: number;
  /** multiply for display (e.g. 100 for percentages) */
  scale?: number;
  suffix?: string;
  placeholder?: string;
  class?: string;
  disabled?: boolean;
}

/** Numeric field: type a value or expression, arrow keys to step, drag the label to scrub. */
export function Num(p: NumProps) {
  const k = p.scale ?? 1;
  const shown = p.value == null ? '' : String(round(p.value * k)) + (p.suffix ?? '');
  const [text, setText] = useState(shown);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(shown); }, [shown]);
  const clamp = (v: number) => Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, v));
  const commit = (raw: string) => {
    const v = parseNumber(raw, p.value == null ? null : p.value * k);
    if (v == null) { setText(shown); return; }
    const next = clamp(v / k);
    if (p.value == null || Math.abs(next - p.value) > 1e-9) p.onChange(next, true);
    setText(String(round(next * k)) + (p.suffix ?? ''));
  };
  const scrub = (e: PointerEvent) => {
    if (p.disabled || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const x0 = e.clientX, v0 = (p.value ?? 0) * k;
    let moved = false, last = v0;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      last = clamp((v0 + Math.round(dx) * (p.step ?? 1) * (ev.shiftKey ? 10 : 1)) / k);
      p.onChange(last, false);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (moved) p.onChange(last, true);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <label class={`num ${p.class ?? ''} ${p.disabled ? 'disabled' : ''}`} title={p.title}>
      {p.label != null && <span class="num-label" onPointerDown={scrub}>{p.label}</span>}
      <input
        type="text" value={text} placeholder={p.placeholder ?? (p.value == null ? 'Mixed' : '')} disabled={p.disabled} spellcheck={false}
        onFocus={e => { focused.current = true; e.currentTarget.select(); }}
        onInput={e => setText(e.currentTarget.value)}
        onBlur={e => { focused.current = false; commit(e.currentTarget.value); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.currentTarget.blur(); }
          else if (e.key === 'Escape') { setText(shown); focused.current = false; e.currentTarget.value = shown; e.currentTarget.blur(); }
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const cur = parseNumber(e.currentTarget.value, null) ?? (p.value ?? 0) * k;
            const next = clamp((cur + (e.key === 'ArrowUp' ? 1 : -1) * (p.step ?? 1) * (e.shiftKey ? 10 : 1)) / k);
            p.onChange(next, true);
            setText(String(round(next * k)) + (p.suffix ?? ''));
          }
          e.stopPropagation();
        }}
      />
    </label>
  );
}

export function Select<T extends string>(p: { value: T | null; options: readonly (T | { value: T; label: string })[]; onChange: (v: T) => void; title?: string; class?: string }) {
  return (
    <select class={`select ${p.class ?? ''}`} title={p.title} value={p.value ?? ''} onChange={e => p.onChange(e.currentTarget.value as T)} onKeyDown={e => e.stopPropagation()}>
      {p.value == null && <option value="" disabled>Mixed</option>}
      {p.options.map(o => (typeof o === 'string' ? <option value={o}>{o}</option> : <option value={o.value}>{o.label}</option>))}
    </select>
  );
}

export function IconButton(p: { icon: ComponentChildren; title: string; onClick?: (e: MouseEvent) => void; active?: boolean; disabled?: boolean; class?: string }) {
  return (
    <button type="button" class={`icon-btn ${p.active ? 'active' : ''} ${p.class ?? ''}`} title={p.title} aria-label={p.title} disabled={p.disabled} onClick={p.onClick}>
      {p.icon}
    </button>
  );
}

export function Section(p: { title: string; children?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <section class="section">
      <header class="section-head"><span>{p.title}</span>{p.action}</header>
      {p.children}
    </section>
  );
}

/** Floating panel anchored next to an element; closes on outside click or Escape. */
export function Popover(p: { anchor: HTMLElement | null; onClose: () => void; children: ComponentChildren; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!p.anchor) return;
    const place = () => {
      const r = p.anchor!.getBoundingClientRect(), w = p.width ?? 240, hgt = ref.current?.offsetHeight ?? 300;
      let left = r.left - w - 12;
      if (left < 8) left = Math.min(window.innerWidth - w - 8, r.right + 12);
      const top = Math.max(8, Math.min(window.innerHeight - hgt - 8, r.top - 20));
      setPos({ left, top });
    };
    place();
    const t = setTimeout(place, 0);
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Element) && !p.anchor!.contains(e.target as Element)) p.onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); p.onClose(); } };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', place);
    return () => { clearTimeout(t); window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); window.removeEventListener('resize', place); };
  }, [p.anchor]);
  if (!p.anchor) return null;
  return <div ref={ref} class="popover" style={{ left: `${pos?.left ?? -9999}px`, top: `${pos?.top ?? 0}px`, width: `${p.width ?? 240}px` }}>{p.children}</div>;
}

export function Dialog(p: { title: string; onClose: () => void; children: ComponentChildren; width?: number }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); p.onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  return (
    <div class="dialog-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div class="dialog" role="dialog" aria-label={p.title} style={{ width: `${p.width ?? 520}px` }} onKeyDown={e => e.stopPropagation()}>
        <header class="dialog-head"><h2>{p.title}</h2><button type="button" class="icon-btn" aria-label="Close" onClick={p.onClose}>✕</button></header>
        <div class="dialog-body">{p.children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- icons

const I = (d: string, extra?: JSX.Element) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={d} />{extra}
  </svg>
);

export const icons = {
  move: I('M3 2l9 5-4 1.2L6.5 12z'),
  hand: I('M5.5 8V3.5a1 1 0 0 1 2 0V7m0-4.5a1 1 0 0 1 2 0V7m0-3.5a1 1 0 0 1 2 0V8m0-2a1 1 0 0 1 2 0v4a4.5 4.5 0 0 1-4.5 4.5c-2 0-3-.8-4-2.3L3 9.6a1 1 0 0 1 1.6-1.1l.9 1'),
  rect: I('M2.5 3.5h11v9h-11z'),
  ellipse: I('M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z'),
  line: I('M3 13L13 3'),
  polygon: I('M8 2.5l6 10.5H2z'),
  star: I('M8 1.8l1.9 4 4.3.5-3.2 3 .9 4.3L8 11.5l-3.9 2.1.9-4.3-3.2-3 4.3-.5z'),
  pen: I('M3 13l1-4 6.5-6.5a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L7 12z M9.5 3.5l3 3'),
  text: I('M3.5 4V3h9v1M8 3v10M6.5 13h3'),
  connector: I('M2.5 12.5h3a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2h4M11.5 1.5l2 2-2 2'),
  bend: I('M2.5 12.5C4 4 12 4 13.5 12.5', <><circle cx="2.500" cy="12.500" r="1.200" fill="currentColor" /><circle cx="13.500" cy="12.500" r="1.200" fill="currentColor" /><path d="M8 6.300V2.500M6.500 4l1.500-1.500L9.500 4" /></>),
  eye: I('M1.5 8s2.4-4.5 6.5-4.5S14.500 8 14.500 8 12.100 12.500 8 12.500 1.500 8 1.500 8z', <circle cx="8" cy="8" r="1.8" />),
  eyeOff: I('M2 2l12 12M6.200 3.800A6.700 6.700 0 0 1 8 3.500c4.100 0 6.500 4.500 6.500 4.500a11 11 0 0 1-1.900 2.400M10.400 11.900a6.300 6.300 0 0 1-2.400.6C3.900 12.500 1.500 8 1.500 8a11 11 0 0 1 2.700-3.100'),
  lock: I('M4 7.500h8v6H4zM5.500 7.500V5.500a2.500 2.500 0 0 1 5 0v2'),
  unlock: I('M4 7.500h8v6H4zM5.500 7.500V5.500a2.500 2.500 0 0 1 4.700-1.200'),
  plus: I('M8 3v10M3 8h10'),
  minus: I('M3 8h10'),
  group: I('M2.500 2.500h4v4h-4zM9.500 9.500h4v4h-4zM6.500 4.500h3M4.500 6.500v3M11.500 6.500v3M6.500 11.500h3'),
  chevron: I('M6 4l4 4-4 4'),
  chevronDown: I('M4 6l4 4 4-4'),
  alignLeft: I('M2.500 2v12M5 5h6v2.200H5zM5 9h8.500v2.200H5z'),
  alignHCenter: I('M8 2v12M4.500 5h7v2.200h-7zM3 9h10v2.200H3z'),
  alignRight: I('M13.500 2v12M5 5h6v2.200H5zM2.500 9H11v2.200H2.500z'),
  alignTop: I('M2 2.500h12M5 5v6h2.200V5zM9 5v8.500h2.200V5z'),
  alignVCenter: I('M2 8h12M5 4.500v7h2.200v-7zM9 3v10h2.200V3z'),
  alignBottom: I('M2 13.500h12M5 5v6h2.200V5zM9 2.500V11h2.200V2.500z'),
  distH: I('M2.500 2v12M13.500 2v12M6.500 5h3v6h-3z'),
  distV: I('M2 2.500h12M2 13.500h12M5 6.500h6v3H5z'),
  cloud: I('M4.500 12.500a3 3 0 0 1-.4-6 4 4 0 0 1 7.700-.500 3.300 3.300 0 0 1-.3 6.500z'),
  menu: I('M2.500 4h11M2.500 8h11M2.500 12h11'),
  textLeft: I('M2.500 4h11M2.500 8h7M2.500 12h9'),
  textCenter: I('M2.500 4h11M4.500 8h7M3.500 12h9'),
  textRight: I('M2.500 4h11M6.500 8h7M4.500 12h9'),
  mask: I('M2.500 3.500h11v9h-11z', <circle cx="8" cy="8" r="2.600" />),
  trash: I('M3 4.500h10M6.500 4.500V3h3v1.500M4.500 4.500l.5 8.500h6l.5-8.500'),
  flipH: I('M8 2v12M6 4.500L2.500 8 6 11.500zM10 4.500L13.500 8 10 11.500z'),
  flipV: I('M2 8h12M4.500 6L8 2.500 11.500 6zM4.500 10L8 13.500 11.500 10z'),
  page: I('M4 2h5.500L12 4.500V14H4zM9.500 2v2.500H12'),
  vector: I('M3 12c0-5 3-8 8-8M2 12h2v2H2zM10 3h2v2h-2z'),
  image: I('M2.500 3.500h11v9h-11zM2.500 10.500l3-3 3 3 2-2 3 3', <circle cx="10.500" cy="6" r="1" />),
};

/** tiny arithmetic evaluator: + - * / and parentheses */
function evalExpr(src: string): number | null {
  const s = src.replace(/\s+/g, '');
  let i = 0;
  const factor = (): number => {
    if (s[i] === '-') { i++; return -factor(); }
    if (s[i] === '+') { i++; return factor(); }
    if (s[i] === '(') { i++; const v = expr(); if (s[i] !== ')') throw new Error('paren'); i++; return v; }
    const m = /^\d*\.?\d+|^\d+\.?/.exec(s.slice(i));
    if (!m) throw new Error('number');
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const term = (): number => {
    let v = factor();
    while (s[i] === '*' || s[i] === '/') { const op = s[i++]; const r = factor(); v = op === '*' ? v * r : v / r; }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (s[i] === '+' || s[i] === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  try { const v = expr(); return i === s.length ? v : null; } catch { return null; }
}
