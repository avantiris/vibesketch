import { addTextAt, importFiles, importSvgText } from '../io/import.ts';
import { align, deleteSelection, escape, flip, group, nudge, onCopy, onPaste, order, selectAll, setOpacity, toggleFlag, toggleMask, ungroup, zoomToSelection } from './actions.ts';
import { cancelDrag, endTextEdit, isDragging, setSpace, setZoom, startTextEdit, zoomToFit } from './interact.ts';
import { enterPathEdit, exitPathEdit, finishPen } from './pathtool.ts';
import { flatten } from './boolean.ts';
import { cropEdit, exitCrop } from './crop.ts';
import { altDown, clearPaint, copyProperties, duplicateSmart, eyedropToSelection, pasteProperties, requestRename, resizeBy, selectParent, selectSibling, swapFillStroke, toggleTextStyle, uiHidden } from './extras.ts';
import { ov } from './stage.ts';
import type { Tool } from './store.ts';
import { doc, pathEdit, redo, save, scope, select, selection, textEdit, tool, undo, view } from './store.ts';

// Keyboard shortcuts (Figma's where they exist).

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

const TOOLS: Record<string, Tool> = { v: 'move', h: 'hand', r: 'rect', o: 'ellipse', l: 'line', p: 'pen', t: 'text', x: 'connector', s: 'slice' };

export function setTool(t: Tool) {
  if (textEdit.value) endTextEdit();
  if (ov.pen) finishPen();
  ov.connect = null;
  if (t !== 'move' && t !== 'hand') exitCrop();
  // leaving the pen for anything else ends vector editing, except the move tool (to adjust points)
  if (pathEdit.value && t !== 'pen' && t !== 'bend' && t !== 'move' && t !== 'hand') exitPathEdit();
  if (t === 'bend' && !pathEdit.value) {
    // the bend tool works on points: open the selected shape for editing
    const n = selection.value.length === 1 ? doc.value.nodes[selection.value[0]] : null;
    if (n && n.type !== 'group' && n.type !== 'text') enterPathEdit(n.id);
    if (!pathEdit.value) return;
  }
  tool.value = t;
}

function onKeyDown(e: KeyboardEvent) {
  if (isTyping(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const done = () => { e.preventDefault(); };

  if (e.code === 'Space') { setSpace(true); return done(); }
  if (k === 'Escape') {
    if (cancelDrag()) return done();
    if (ov.pen) { finishPen(); return done(); }
    if (cropEdit.value) { exitCrop(); return done(); }
    if (tool.value !== 'move' && !pathEdit.value) { tool.value = 'move'; return done(); }
    escape();
    return done();
  }
  if (isDragging()) return;

  if (k === 'Tab') { if (!pathEdit.value) selectSibling(e.shiftKey ? -1 : 1); return done(); }
  if (k === 'Enter' && e.shiftKey && !pathEdit.value) { selectParent(); return done(); }
  if (k === 'Enter') {
    if (cropEdit.value) { exitCrop(); return done(); }
    if (pathEdit.value) { if (ov.pen) finishPen(); else exitPathEdit(); return done(); }
    const ids = selection.value;
    if (ids.length === 1) {
      const n = doc.value.nodes[ids[0]];
      if (n?.type === 'text') startTextEdit(n.id);
      else if (n?.type === 'group') { scope.value = n.id; select(n.children); }
      else if (n) enterPathEdit(n.id);
    }
    return done();
  }
  if (k === 'Delete' || k === 'Backspace') { deleteSelection(); return done(); }

  if (mod) {
    if (e.altKey && e.code === 'KeyC') { copyProperties(); return done(); }
    if (e.altKey && e.code === 'KeyV') { pasteProperties(); return done(); }
    if (k.startsWith('Arrow')) {
      const s = e.shiftKey ? 10 : 1;
      resizeBy(k === 'ArrowLeft' ? -s : k === 'ArrowRight' ? s : 0, k === 'ArrowUp' ? -s : k === 'ArrowDown' ? s : 0);
      return done();
    }
    switch (k) {
      case 'r': if (!e.shiftKey) { requestRename(); return done(); } break;
      case 'b': if (toggleTextStyle('bold')) return done(); break;
      case 'i': if (toggleTextStyle('italic')) return done(); break;
      case '\\': uiHidden.value = !uiHidden.value; return done();
      case 'z': if (e.shiftKey) redo(); else undo(); return done();
      case 'y': redo(); return done();
      case 'a': selectAll(); return done();
      case 'd': duplicateSmart(); return done();
      case 'g': if (e.shiftKey) ungroup(); else group(); return done();
      case 's': void save(); return done();
      case 'e': void flatten(); return done();
      case ']': order('forward'); return done();
      case '[': order('backward'); return done();
      case '0': setZoom(1); return done();
      case '=': case '+': setZoom(view.value.zoom * 1.5); return done();
      case '-': setZoom(view.value.zoom / 1.5); return done();
    }
    if (e.shiftKey && e.code === 'KeyH') { toggleFlag('visible'); return done(); }
    if (e.shiftKey && e.code === 'KeyL') { toggleFlag('locked'); return done(); }
    if (e.altKey && e.code === 'KeyM') { toggleMask(); return done(); }
    return;
  }

  if (e.altKey) {
    const map: Record<string, Parameters<typeof align>[0]> = { KeyA: 'left', KeyD: 'right', KeyH: 'hcenter', KeyV: 'vcenter', KeyW: 'top', KeyS: 'bottom' };
    const how = map[e.code];
    if (how) { align(how); return done(); }
    if (e.code === 'Slash') { clearPaint('fills'); return done(); }
    return;
  }

  if (k.startsWith('Arrow')) {
    const s = e.shiftKey ? 10 : 1;
    nudge(k === 'ArrowLeft' ? -s : k === 'ArrowRight' ? s : 0, k === 'ArrowUp' ? -s : k === 'ArrowDown' ? s : 0);
    return done();
  }
  if (e.shiftKey) {
    switch (e.code) {
      case 'Digit1': zoomToFit(); return done();
      case 'Digit2': zoomToSelection(); return done();
      case 'Digit0': setZoom(1); return done();
      case 'KeyH': flip('x'); return done();
      case 'KeyV': flip('y'); return done();
      case 'KeyX': swapFillStroke(); return done();
      case 'Slash': clearPaint('strokes'); return done();
    }
    if (k === '+') { setZoom(view.value.zoom * 1.5); return done(); }
    return;
  }
  if (TOOLS[k]) { setTool(TOOLS[k]); return done(); }
  if (k === 'i') { void eyedropToSelection(); return done(); }
  if (k === ']') { order('front'); return done(); }
  if (k === '[') { order('back'); return done(); }
  if (k === '+' || k === '=') { setZoom(view.value.zoom * 1.5); return done(); }
  if (k === '-') { setZoom(view.value.zoom / 1.5); return done(); }
  if (/^[0-9]$/.test(k) && selection.value.length) { setOpacity(k === '0' ? 1 : Number(k) / 10); return done(); }
}

export function installKeys(): () => void {
  const up = (e: KeyboardEvent) => {
    if (e.code === 'Space') setSpace(false);
    if (e.key === 'Alt') { altDown.value = false; if (!isTyping(e.target)) e.preventDefault(); } // keep the browser menu closed
  };
  const alt = (e: KeyboardEvent) => { if (e.key === 'Alt' && !altDown.value) altDown.value = true; };
  const blur = () => { setSpace(false); altDown.value = false; };
  const copy = (e: ClipboardEvent) => { if (!isTyping(e.target)) void onCopy(e, false); };
  const cut = (e: ClipboardEvent) => { if (!isTyping(e.target)) void onCopy(e, true); };
  const paste = (e: ClipboardEvent) => { if (!isTyping(e.target)) void onPaste(e, f => importFiles(f), async s => { await importSvgText(s); }, t => addTextAt(t)); };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keydown', alt);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', blur);
  document.addEventListener('copy', copy);
  document.addEventListener('cut', cut);
  document.addEventListener('paste', paste);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keydown', alt);
    window.removeEventListener('keyup', up);
    window.removeEventListener('blur', blur);
    document.removeEventListener('copy', copy);
    document.removeEventListener('cut', cut);
    document.removeEventListener('paste', paste);
  };
}
