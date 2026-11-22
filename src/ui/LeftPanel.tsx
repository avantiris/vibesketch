import { useEffect, useRef, useState } from 'preact/hooks';
import type { Node } from '../core/model.ts';
import { childrenOf } from '../core/model.ts';
import { isAncestor, reparent, setNode, setPage, sortByOrder, topMost } from '../core/ops.ts';
import { addPage, deletePage, switchPage } from '../editor/actions.ts';
import { renameRequest } from '../editor/extras.ts';
import { exitPathEdit } from '../editor/pathtool.ts';
import { doc, hover, page, pageId, pathEdit, project, remotes, saveError, saveState, scope, select, selection, storage, update } from '../editor/store.ts';
import { IconButton, icons } from './controls.tsx';

// Project header, pages and the layer tree.

function typeIcon(n: Node) {
  if (n.mask) return icons.mask;
  switch (n.type) {
    case 'group': return icons.group;
    case 'rect': return n.fills.some(f => f.type === 'image') ? icons.image : icons.rect;
    case 'ellipse': return icons.ellipse;
    case 'polygon': return icons.polygon;
    case 'star': return icons.star;
    case 'text': return icons.text;
    default: return icons.vector;
  }
}

function InlineEdit({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input ref={ref} class="inline-edit" type="text" defaultValue={value} spellcheck={false}
      onBlur={e => onDone(e.currentTarget.value.trim() || null)}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { e.currentTarget.value = ''; onDone(null); } e.stopPropagation(); }}
      onPointerDown={e => e.stopPropagation()} onDblClick={e => e.stopPropagation()} />
  );
}

type DropPos = { id: string; where: 'above' | 'below' | 'into' } | null;

function Layers() {
  const d = doc.value, pg = page.value;
  const sel = new Set(selection.value);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropPos>(null);
  const anchor = useRef<string | null>(null);
  // Ctrl+R on the canvas
  const wanted = renameRequest.value;
  useEffect(() => { if (wanted) { setRenaming(wanted); renameRequest.value = null; } }, [wanted]);
  const listRef = useRef<HTMLDivElement>(null);

  // reveal the selection: open its ancestors and scroll to it
  const first = selection.value[0];
  useEffect(() => {
    if (!first) return;
    const need: string[] = [];
    for (let p = d.nodes[first]?.parent; p && d.nodes[p]; p = d.nodes[p].parent) if (!open.has(p)) need.push(p);
    if (need.length) setOpen(new Set([...open, ...need]));
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-layer="${first}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [first]);

  // rows in display order: top-most layer first
  const rows: { n: Node; depth: number }[] = [];
  const walk = (cid: string, depth: number) => {
    const kids = childrenOf(d, cid);
    for (let i = kids.length - 1; i >= 0; i--) {
      const n = d.nodes[kids[i]];
      if (!n) continue;
      rows.push({ n, depth });
      if (n.type === 'group' && open.has(n.id)) walk(n.id, depth + 1);
    }
  };
  walk(pg.id, 0);

  const pick = (n: Node, e: MouseEvent) => {
    if (pathEdit.value) exitPathEdit();
    let next: string[];
    if (e.shiftKey && anchor.current) {
      const a = rows.findIndex(r => r.n.id === anchor.current), b = rows.findIndex(r => r.n.id === n.id);
      next = a < 0 ? [n.id] : rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(r => r.n.id);
    } else if (e.ctrlKey || e.metaKey) {
      next = sel.has(n.id) ? selection.value.filter(x => x !== n.id) : [...selection.value, n.id];
      anchor.current = n.id;
    } else { next = [n.id]; anchor.current = n.id; }
    scope.value = d.nodes[n.parent] ? n.parent : null;
    select(topMost(d, next));
  };

  const onDrop = (target: DropPos, dragged: string) => {
    setDrop(null);
    if (!target) return;
    const ids = sortByOrder(d, pg.id, sel.has(dragged) ? topMost(d, selection.value) : [dragged]);
    const t = d.nodes[target.id];
    if (!t || ids.includes(target.id) || ids.some(id => isAncestor(d, id, target.id))) return;
    if (target.where === 'into' && t.type === 'group') {
      update(cur => reparent(cur, ids, t.id));
      setOpen(new Set([...open, t.id]));
    } else {
      const sibs = childrenOf(d, t.parent), at = sibs.indexOf(t.id);
      update(cur => reparent(cur, ids, t.parent, target.where === 'above' ? at + 1 : at));
    }
    select(ids);
  };

  return (
    <div class="layers" ref={listRef} onPointerLeave={() => { if (hover.value) hover.value = null; }}>
      {rows.map(({ n, depth }) => (
        <div key={n.id} data-layer={n.id} draggable={renaming !== n.id}
          class={`layer ${sel.has(n.id) ? 'selected' : ''} ${n.visible ? '' : 'hidden'} ${drop?.id === n.id ? `drop-${drop.where}` : ''}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={e => pick(n, e)}
          onDblClick={() => setRenaming(n.id)}
          onPointerEnter={() => { hover.value = n.id; }}
          onDragStart={e => { e.dataTransfer?.setData('application/x-vibesketch-layer', n.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={e => {
            if (!e.dataTransfer?.types.includes('application/x-vibesketch-layer')) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect(), f = (e.clientY - r.top) / r.height;
            const where = n.type === 'group' && f > 0.3 && f < 0.7 ? 'into' : f < 0.5 ? 'above' : 'below';
            if (drop?.id !== n.id || drop.where !== where) setDrop({ id: n.id, where });
          }}
          onDragLeave={() => setDrop(null)}
          onDrop={e => { e.preventDefault(); const id = e.dataTransfer?.getData('application/x-vibesketch-layer'); if (id) onDrop(drop, id); }}>
          {n.type === 'group'
            ? <button type="button" class={`twisty ${open.has(n.id) ? 'open' : ''}`} aria-label="Expand" onClick={e => { e.stopPropagation(); const s = new Set(open); if (s.has(n.id)) s.delete(n.id); else s.add(n.id); setOpen(s); }}>{icons.chevron}</button>
            : <span class="twisty" />}
          <span class="layer-icon">{typeIcon(n)}</span>
          {renaming === n.id
            ? <InlineEdit value={n.name} onDone={v => { setRenaming(null); if (v && v !== n.name) update(cur => setNode(cur, n.id, { name: v })); }} />
            : <span class="layer-name">{n.name}</span>}
          <span class="layer-actions">
            <IconButton class={n.locked ? 'on' : ''} icon={n.locked ? icons.lock : icons.unlock} title={n.locked ? 'Unlock' : 'Lock'} onClick={e => { e.stopPropagation(); update(cur => setNode(cur, n.id, { locked: !n.locked })); }} />
            <IconButton class={n.visible ? '' : 'on'} icon={n.visible ? icons.eye : icons.eyeOff} title={n.visible ? 'Hide' : 'Show'} onClick={e => { e.stopPropagation(); update(cur => setNode(cur, n.id, { visible: !n.visible })); }} />
          </span>
        </div>
      ))}
      {!rows.length && <div class="empty">Nothing here yet. Draw something, or drop SVG, PDF, images or a .fig file onto the canvas.</div>}
    </div>
  );
}

function Pages() {
  const d = doc.value;
  const [renaming, setRenaming] = useState<string | null>(null);
  return (
    <div class="pages">
      <header class="section-head"><span>Pages</span><IconButton icon={icons.plus} title="Add page" onClick={addPage} /></header>
      {d.pages.map(p => (
        <div class={`page-row ${p.id === pageId.value ? 'selected' : ''}`} onClick={() => switchPage(p.id)} onDblClick={() => setRenaming(p.id)}>
          <span class="layer-icon">{icons.page}</span>
          {renaming === p.id
            ? <InlineEdit value={p.name} onDone={v => { setRenaming(null); if (v) update(cur => setPage(cur, p.id, { name: v })); }} />
            : <span class="layer-name">{p.name}</span>}
          {d.pages.length > 1 && <span class="layer-actions"><IconButton icon={icons.trash} title="Delete page" onClick={e => { e.stopPropagation(); if (p.children.length === 0 || confirm(`Delete page "${p.name}" and everything on it?`)) deletePage(p.id); }} /></span>}
        </div>
      ))}
    </div>
  );
}

function SaveBadge({ onSync }: { onSync: () => void }) {
  const s = saveState.value;
  const rs = remotes.value.filter(r => r.enabled);
  const syncing = rs.some(r => r.state === 'syncing' || r.pending > 0);
  const syncErr = rs.find(r => r.state === 'error' || r.state === 'unauthorized');
  const where = storage.value.kind === 'folder' ? `Saved to ${storage.value.name}` : 'Saved in browser';
  const text = s === 'saved' ? where : s === 'saving' || s === 'dirty' ? 'Saving…' : s === 'conflict' ? 'Conflict' : 'Save failed';
  const cls = s === 'error' || s === 'conflict' ? 'bad' : s === 'saved' ? 'ok' : 'busy';
  return (
    <div class="save-row">
      <span class={`save-badge ${cls}`} title={saveError.value ?? (storage.value.kind === 'folder' ? `Every change is written to the folder "${storage.value.name}" on this computer` : 'Every change is saved in this browser\'s private storage for this site. Open Projects to move to a folder, download a copy, or set up sync.')}><i />{text}</span>
      <button type="button" class={`sync-badge ${syncErr ? 'bad' : syncing ? 'busy' : rs.length ? 'ok' : ''}`} onClick={onSync}
        title={syncErr ? `${syncErr.name}: ${syncErr.error ?? syncErr.state}` : rs.length ? `Syncing with ${rs.map(r => r.name).join(', ')}` : 'Set up cloud sync (S3, Google Drive)'}>
        {icons.cloud}<span>{syncErr ? 'Sync error' : syncing ? 'Syncing…' : rs.length ? 'Synced' : 'Sync off'}</span>
      </button>
    </div>
  );
}

export function LeftPanel(p: { onProjects: () => void; onSync: () => void; onImport: () => void }) {
  return (
    <aside class="panel left">
      <header class="project-head">
        <button type="button" class="project-name" title="Projects" onClick={p.onProjects}>
          <span>{project.value ?? '…'}</span>{icons.chevronDown}
        </button>
        <IconButton icon={icons.plus} title="Import file (SVG, PDF, image, font, .fig)" onClick={p.onImport} />
      </header>
      <SaveBadge onSync={p.onSync} />
      <Pages />
      <header class="section-head"><span>Layers</span></header>
      <Layers />
    </aside>
  );
}
