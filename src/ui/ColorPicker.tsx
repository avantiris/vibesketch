import { useEffect, useRef, useState } from 'preact/hooks';
import type { Color } from '../core/model.ts';
import { hex } from '../core/render.ts';
import { pickColor } from '../editor/extras.ts';
import { Num } from './controls.tsx';

export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const f = (n: number) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return { r: f(5), g: f(3), b: f(1) };
}
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s: max < 1e-9 ? 0 : d / max, v: max };
}

export function parseHex(text: string): Color | null {
  let t = text.trim().replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(t)) return null;
  if (t.length === 1) t = t.repeat(6);
  else if (t.length === 2) t = t.repeat(3);
  else if (t.length === 3 || t.length === 4) t = [...t].map(c => c + c).join('');
  if (t.length !== 6 && t.length !== 8) return null;
  const n = (i: number) => parseInt(t.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: t.length === 8 ? n(6) : 1 };
}

export const cssColor = (c: Color, opacity = 1) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a * opacity})`;

function useDrag(onDrag: (x: number, y: number, final: boolean) => void) {
  return (e: PointerEvent & { currentTarget: EventTarget | null }) => {
    const el = e.currentTarget as HTMLElement;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const at = (ev: PointerEvent, final: boolean) => {
      const r = el.getBoundingClientRect();
      onDrag(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)), final);
    };
    at(e, false);
    const move = (ev: PointerEvent) => at(ev, false);
    const up = (ev: PointerEvent) => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); at(ev, true); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
}

/** HSV picker with alpha and hex entry. `final=false` while dragging. */
export function ColorPicker(p: { color: Color; onChange: (c: Color, final: boolean) => void; alpha?: boolean }) {
  const [hsv, setHsv] = useState(() => rgbToHsv(p.color.r, p.color.g, p.color.b));
  const own = useRef<string>(hex(p.color));
  // follow outside changes, but keep our hue/saturation when the color is unchanged (greys lose them)
  useEffect(() => {
    if (hex(p.color) !== own.current) { own.current = hex(p.color); setHsv(rgbToHsv(p.color.r, p.color.g, p.color.b)); }
  }, [p.color.r, p.color.g, p.color.b]);
  const emit = (h: number, s: number, v: number, a: number, final: boolean) => {
    setHsv({ h, s, v });
    const c = { ...hsvToRgb(h, s, v), a };
    own.current = hex(c);
    p.onChange(c, final);
  };
  const pure = hsvToRgb(hsv.h, 1, 1);
  const [hexText, setHexText] = useState(hex(p.color).slice(1).toUpperCase());
  useEffect(() => setHexText(hex(p.color).slice(1).toUpperCase()), [hex(p.color)]);
  return (
    <div class="color-picker">
      <div class="cp-sv" style={{ background: `rgb(${pure.r * 255},${pure.g * 255},${pure.b * 255})` }} onPointerDown={useDrag((x, y, f) => emit(hsv.h, x, 1 - y, p.color.a, f))}>
        <div class="cp-sv-white" /><div class="cp-sv-black" />
        <div class="cp-knob" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex(p.color) }} />
      </div>
      <div class="cp-slider cp-hue" onPointerDown={useDrag((x, _y, f) => emit(Math.min(x, 0.9999), hsv.s, hsv.v, p.color.a, f))}>
        <div class="cp-knob" style={{ left: `${hsv.h * 100}%`, top: '50%' }} />
      </div>
      {p.alpha !== false && (
        <div class="cp-slider cp-alpha" onPointerDown={useDrag((x, _y, f) => emit(hsv.h, hsv.s, hsv.v, Math.round(x * 100) / 100, f))}>
          <div class="cp-alpha-fill" style={{ background: `linear-gradient(to right, transparent, ${hex(p.color)})` }} />
          <div class="cp-knob" style={{ left: `${p.color.a * 100}%`, top: '50%' }} />
        </div>
      )}
      <div class="cp-row">
        {<button type="button" class="icon-btn" title="Pick a colour from the canvas (I)" aria-label="Eyedropper" onClick={() => void pickColor().then(c => { if (c) { own.current = ''; p.onChange({ ...c, a: p.color.a }, true); } })}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 4.5l2 2M3 13l.5-2.500 6-6 2 2-6 6zM10.500 3.500l1-1a1.400 1.400 0 0 1 2 2l-1 1" /></svg>
        </button>}
        <label class="num cp-hex"><span class="num-label">#</span>
          <input type="text" value={hexText} spellcheck={false} maxLength={9}
            onInput={e => setHexText(e.currentTarget.value)}
            onFocus={e => e.currentTarget.select()}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }}
            onBlur={e => {
              const c = parseHex(e.currentTarget.value);
              if (c) { const next = { ...c, a: e.currentTarget.value.replace('#', '').trim().length > 6 ? c.a : p.color.a }; own.current = ''; p.onChange(next, true); }
              else setHexText(hex(p.color).slice(1).toUpperCase());
            }} />
        </label>
        {p.alpha !== false && <Num value={p.color.a} scale={100} suffix="%" min={0} max={1} onChange={(a, f) => p.onChange({ ...p.color, a }, f)} class="cp-a" />}
      </div>
    </div>
  );
}
