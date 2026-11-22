import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { copyAsSvg, deleteSelection, duplicate, flip, group, order, selectAll, toggleFlag, toggleMask, ungroup } from '../editor/actions.ts';
import type { BoolOp } from '../editor/boolean.ts';
import { booleanOp, flatten } from '../editor/boolean.ts';
import { startTextEdit } from '../editor/interact.ts';
import { addMidpoints, cutAtPoints, deleteSelectedPoints, enterPathEdit, exitPathEdit, joinPoints, selectAllPoints, setPointMode, straightenPoints, toggleClosed } from '../editor/pathtool.ts';
import { contextMenu, doc, pathEdit, selection } from '../editor/store.ts';

// Menus: the right-click menu on the canvas and the "combine shapes" menu.

export interface Item { label: string; keys?: string; run: () => void; disabled?: boolean }
type Entry = Item | 'sep';

const BOOL: { op: BoolOp; label: string; icon: ComponentChildren }[] = [
  { op: 'union', label: 'Union', icon: boolIcon('union') },
  { op: 'subtract', label: 'Subtract', icon: boolIcon('subtract') },
  { op: 'intersect', label: 'Intersect', icon: boolIcon('intersect') },
  { op: 'exclude', label: 'Exclude', icon: boolIcon('exclude') },
];

/** two overlapping squares with the kept area filled */
function boolIcon(op: BoolOp | 'flatten') {
  const a = 'M2.5 2.5h7v7h-7z', b = 'M6.5 6.5h7v7h-7z', both = 'M6.5 6.5h3v3h-3z';
  const fill = 'currentColor';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true">
      {op === 'union' && <path d="M2.5 2.5h7v4h4v7h-7v-4h-4z" fill={fill} fill-opacity="0.45" />}
      {op === 'subtract' && <><path d="M2.5 2.5h7v4h-3v3h-4z" fill={fill} fill-opacity="0.45" /><path d={b} stroke-dasharray="1.5 1.5" /></>}
      {op === 'intersect' && <><path d={a} stroke-dasharray="1.5 1.5" /><path d={b} stroke-dasharray="1.5 1.5" /><path d={both} fill={fill} fill-opacity="0.6" /></>}
      {op === 'exclude' && <><path d="M2.5 2.5h7v4h-3v3h-4z" fill={fill} fill-opacity="0.45" /><path d="M9.5 6.5h4v7h-7v-4h3z" fill={fill} fill-opacity="0.45" /></>}
      {op === 'flatten' && <><path d="M2.5 2.5h7v4h4v7h-7v-4h-4z" /><circle cx="2.500" cy="2.500" r="1" fill={fill} /><circle cx="13.500" cy="13.500" r="1" fill={fill} /><circle cx="9.500" cy="2.500" r="1" fill={fill} /><circle cx="6.500" cy="13.500" r="1" fill={fill} /></>}
    </svg>
  );
}
export const combineIcon = boolIcon('union');

function Menu({ x, y, entries, onClose }: { x: number; y: number; entries: Entry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 4)), top: Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 4)) });
  }, [x, y, entries.length]);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Element)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', onClose); };
  }, []);
  return (
    <div ref={ref} class="menu" role="menu" style={{ left: `${pos.left}px`, top: `${pos.top}px` }} onContextMenu={e => e.preventDefault()}>
      {entries.map(en => (en === 'sep' ? <hr /> : (
        <button type="button" role="menuitem" disabled={en.disabled} onClick={() => { onClose(); en.run(); }}>
          <span>{en.label}</span>{en.keys && <kbd>{en.keys}</kbd>}
        </button>
      )))}
    </div>
  );
}

export function ContextMenu() {
  const at = contextMenu.value;
  if (!at) return null;
  const d = doc.value;
  const ids = selection.value;
  const nodes = ids.map(id => d.nodes[id]).filter(Boolean);
  const has = nodes.length > 0, one = nodes.length === 1 ? nodes[0] : null;
  const pe = pathEdit.value;
  let entries: Entry[];
  if (pe) {
    const n = pe.sel.length;
    entries = [
      { label: 'Add point between selected', run: addMidpoints, disabled: n < 2 },
      { label: 'Delete points', keys: 'Del', run: () => void deleteSelectedPoints(), disabled: !n },
      'sep',
      { label: 'Straight corner (remove handles)', run: straightenPoints, disabled: !n },
      { label: 'Curve: no mirroring', run: () => setPointMode('corner'), disabled: !n },
      { label: 'Curve: mirror angle', run: () => setPointMode('smooth'), disabled: !n },
      { label: 'Curve: mirror angle and length', run: () => setPointMode('mirror'), disabled: !n },
      'sep',
      { label: 'Cut path at points', run: cutAtPoints, disabled: !n },
      { label: 'Join points', run: () => void joinPoints(), disabled: n !== 2 },
      { label: 'Open / close path', run: toggleClosed },
      'sep',
      { label: 'Select all points', keys: 'Ctrl+A', run: selectAllPoints },
      { label: 'Done', keys: 'Enter', run: exitPathEdit },
    ];
  } else {
    entries = [
      ...(one && one.type === 'text' ? [{ label: 'Edit text', keys: 'Enter', run: () => startTextEdit(one.id) }] : []),
      ...(one && one.type !== 'text' && one.type !== 'group' ? [{ label: 'Edit points', keys: 'Enter', run: () => enterPathEdit(one.id) }] : []),
      { label: 'Duplicate', keys: 'Ctrl+D', run: duplicate, disabled: !has },
      { label: 'Copy as SVG', run: () => void copyAsSvg(), disabled: !has },
      { label: 'Delete', keys: 'Del', run: deleteSelection, disabled: !has },
      'sep',
      { label: 'Bring to front', keys: ']', run: () => order('front'), disabled: !has },
      { label: 'Bring forward', keys: 'Ctrl+]', run: () => order('forward'), disabled: !has },
      { label: 'Send backward', keys: 'Ctrl+[', run: () => order('backward'), disabled: !has },
      { label: 'Send to back', keys: '[', run: () => order('back'), disabled: !has },
      'sep',
      { label: 'Group', keys: 'Ctrl+G', run: group, disabled: !has },
      { label: 'Ungroup', keys: 'Ctrl+Shift+G', run: ungroup, disabled: !nodes.some(n => n.type === 'group') },
      { label: 'Flatten', keys: 'Ctrl+E', run: () => void flatten(), disabled: !has },
      ...BOOL.map(b => ({ label: `${b.label} selection`, run: () => void booleanOp(b.op), disabled: nodes.length < 2 && one?.type !== 'group' })),
      { label: nodes.length && nodes.every(n => n.mask) ? 'Remove mask' : 'Use as mask', keys: 'Ctrl+Alt+M', run: toggleMask, disabled: !has },
      'sep',
      { label: 'Flip horizontal', keys: 'Shift+H', run: () => flip('x'), disabled: !has },
      { label: 'Flip vertical', keys: 'Shift+V', run: () => flip('y'), disabled: !has },
      { label: nodes.length && nodes.every(n => !n.visible) ? 'Show' : 'Hide', keys: 'Ctrl+Shift+H', run: () => toggleFlag('visible'), disabled: !has },
      { label: nodes.length && nodes.every(n => n.locked) ? 'Unlock' : 'Lock', keys: 'Ctrl+Shift+L', run: () => toggleFlag('locked'), disabled: !has },
      'sep',
      { label: 'Select all', keys: 'Ctrl+A', run: selectAll },
    ];
  }
  return <Menu x={at.x} y={at.y} entries={entries} onClose={() => { contextMenu.value = null; }} />;
}

/** toolbar button with the boolean operations */
export function CombineMenu({ disabled }: { disabled: boolean }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button type="button" class={`icon-btn ${at ? 'active' : ''}`} title="Combine shapes: union, subtract, intersect, exclude, flatten" aria-label="Combine shapes" disabled={disabled}
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setAt(at ? null : { x: r.left, y: r.top - 190 }); }}>
        {combineIcon}
      </button>
      {at && (
        <div class="menu icon-menu" style={{ left: `${at.x}px`, top: `${at.y}px` }}>
          <MenuCloser onClose={() => setAt(null)} />
          {BOOL.map(b => <button type="button" onClick={() => { setAt(null); void booleanOp(b.op); }}>{b.icon}<span>{b.label}</span></button>)}
          <hr />
          <button type="button" onClick={() => { setAt(null); void flatten(); }}>{boolIcon('flatten')}<span>Flatten</span><kbd>Ctrl+E</kbd></button>
        </div>
      )}
    </>
  );
}

function MenuCloser({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!(e.target as Element).closest('.icon-menu')) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    // registered after the opening click has finished
    const t = setTimeout(() => { window.addEventListener('pointerdown', down, true); window.addEventListener('keydown', key, true); }, 0);
    return () => { clearTimeout(t); window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); };
  }, []);
  return null;
}
