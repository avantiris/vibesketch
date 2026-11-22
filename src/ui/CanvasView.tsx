import { effect } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { TextNode } from '../core/model.ts';
import { mul } from '../core/geom.ts';
import { worldMatrix } from '../core/bounds.ts';
import { setNode } from '../core/ops.ts';
import { hex } from '../core/render.ts';
import { cssFont, layoutText } from '../core/text.ts';
import { altDown, gradientEdit } from '../editor/extras.ts';
import { fontsVersion } from '../editor/fonts.ts';
import { attach, endTextEdit, zoomToFit } from '../editor/interact.ts';
import { drawOverlay } from '../editor/overlay.ts';
import { Scene } from '../editor/scene.ts';
import { eventWorld, overlayTick, stage } from '../editor/stage.ts';
import { assetUrl, assetsVersion, doc, hover, page, pageId, pathEdit, project, selection, textEdit, tool, update, view } from '../editor/store.ts';
import { importDrop } from '../io/import.ts';
import { cssColor } from './ColorPicker.tsx';

/** Textarea laid exactly over the text layer being edited. */
function TextEditor() {
  const id = textEdit.value;
  const ref = useRef<HTMLTextAreaElement>(null);
  void fontsVersion.value;
  const n = id ? (doc.value.nodes[id] as TextNode | undefined) : undefined;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [id]);
  if (!n || n.type !== 'text') return null;
  const v = view.value;
  const M = mul([v.zoom, 0, 0, v.zoom, v.x, v.y], worldMatrix(doc.value, n.id));
  const lay = layoutText(n);
  const fill = n.fills.find(f => f.visible && f.type === 'solid');
  const autoW = n.w == null;
  // auto-width boxes grow from the side their alignment pins
  const width = autoW ? Math.max(lay.w + n.size * 2, n.size * 4) : n.w!;
  const shift = autoW ? (n.align === 'center' ? (lay.w - width) / 2 : n.align === 'right' ? lay.w - width : 0) : 0;
  return (
    <textarea
      ref={ref} class="text-editor" spellcheck={false} value={n.text} wrap={autoW ? 'off' : 'soft'}
      style={{
        transform: `matrix(${M.join(',')}) translate(${shift}px,0)`,
        width: `${width}px`, height: `${lay.h + lay.lineHeight}px`,
        font: cssFont(n.font, n.size), lineHeight: `${lay.lineHeight}px`, letterSpacing: `${n.letterSpacing}px`,
        textAlign: n.align, color: fill && fill.type === 'solid' ? cssColor(fill.color, fill.opacity) : '#000',
        whiteSpace: autoW ? 'pre' : 'pre-wrap', caretColor: fill && fill.type === 'solid' ? hex(fill.color) : '#000',
      }}
      onInput={e => { const text = e.currentTarget.value; update(d => setNode<TextNode>(d, n.id, { text }), { transient: true }); }}
      onKeyDown={e => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); endTextEdit(); } e.stopPropagation(); }}
      onBlur={() => { if (textEdit.value === n.id) endTextEdit(); }}
      onPointerDown={e => e.stopPropagation()}
    />
  );
}

export function CanvasView() {
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<SVGGElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = host.current!, g = root.current!, cv = canvas.current!;
    const scene = new Scene(g, assetUrl);
    stage.el = el; stage.sceneRoot = g; stage.scene = scene;
    const detach = attach(el);

    let sceneDirty = false, overlayDirty = false, raf = 0, fitPending = false;
    const frame = () => {
      raf = 0;
      if (sceneDirty) { sceneDirty = false; scene.sync(doc.value, pageId.value); scene.setHidden(textEdit.value); }
      if (fitPending && el.clientWidth > 0) { fitPending = false; zoomToFit(); }
      if (overlayDirty) { overlayDirty = false; drawOverlay(cv); }
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(frame); };

    const stops = [
      effect(() => { void project.value; scene.reset(); fitPending = true; sceneDirty = true; schedule(); }),
      // images that arrived after the document (sync): their URLs only exist now
      effect(() => { void assetsVersion.value; scene.reset(); sceneDirty = true; schedule(); }),
      effect(() => { void pageId.value; fitPending = true; schedule(); }),
      effect(() => { void doc.value; void pageId.value; void fontsVersion.value; void textEdit.value; sceneDirty = true; overlayDirty = true; schedule(); }),
      effect(() => { const v = view.value; g.setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.zoom})`); overlayDirty = true; schedule(); }),
      effect(() => { void overlayTick.value; void selection.value; void hover.value; void pathEdit.value; void tool.value; void altDown.value; void gradientEdit.value; overlayDirty = true; schedule(); }),
      effect(() => { el.style.background = cssColor(page.value.background); }),
      effect(() => { el.dataset.tool = tool.value; }),
    ];
    const ro = new ResizeObserver(() => { overlayDirty = true; schedule(); });
    ro.observe(el);
    return () => { detach(); stops.forEach(s => s()); ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, []);

  return (
    <div
      ref={host} class="stage"
      onDragOver={e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDrop={e => {
        if (!e.dataTransfer?.files.length) return;
        e.preventDefault();
        void importDrop(e.dataTransfer, eventWorld(e));
      }}>
      <svg class="scene" xmlns="http://www.w3.org/2000/svg"><g ref={root} /></svg>
      <canvas ref={canvas} class="overlay" />
      <TextEditor />
    </div>
  );
}
