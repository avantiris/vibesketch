import { useEffect, useState } from 'preact/hooks';
import { copyAsSvg, group, order, ungroup } from '../editor/actions.ts';
import { cropEdit } from '../editor/crop.ts';
import { uiHidden } from '../editor/extras.ts';
import { setZoom, zoomToFit } from '../editor/interact.ts';
import { installKeys, setTool } from '../editor/keys.ts';
import type { Tool } from '../editor/store.ts';
import { canRedo, canUndo, pathEdit, prefs, reconnectFolder, redo, resolveConflict, saveState, selection, storage, toasts, tool, undo, useBrowserStorage, view } from '../editor/store.ts';
import { importFiles, pickFiles } from '../io/import.ts';
import { CanvasView } from './CanvasView.tsx';
import { IconButton, icons } from './controls.tsx';
import { ProjectsDialog, SyncDialog } from './dialogs.tsx';
import { LeftPanel } from './LeftPanel.tsx';
import { CombineMenu, ContextMenu } from './menus.tsx';
import { exitPathEdit } from '../editor/pathtool.ts';
import { RightPanel } from './RightPanel.tsx';

const TOOLS: { id: Tool; title: string; icon: keyof typeof icons }[] = [
  { id: 'move', title: 'Move (V)', icon: 'move' },
  { id: 'hand', title: 'Hand (H)', icon: 'hand' },
  { id: 'rect', title: 'Rectangle (R)', icon: 'rect' },
  { id: 'ellipse', title: 'Ellipse (O)', icon: 'ellipse' },
  { id: 'polygon', title: 'Polygon', icon: 'polygon' },
  { id: 'star', title: 'Star', icon: 'star' },
  { id: 'line', title: 'Line (L)', icon: 'line' },
  { id: 'pen', title: 'Pen (P)', icon: 'pen' },
  { id: 'connector', title: 'Connector: drag from one layer to another to link them with an arrow that stays attached (X)', icon: 'connector' },
  { id: 'text', title: 'Text (T)', icon: 'text' },
  { id: 'slice', title: 'Slice: draw a frame, then export it to get exactly what the page shows inside (S)', icon: 'slice' },
];

function Toolbar() {
  const has = selection.value.length > 0;
  if (pathEdit.value) {
    // vector edit mode has its own tools, like Figma
    return (
      <div class="toolbar">
        <div class="tool-group">
          <IconButton icon={icons.move} title="Move points and segments (V)" active={tool.value === 'move'} onClick={() => setTool('move')} />
          <IconButton icon={icons.pen} title="Pen: add points, continue or branch off a path (P)" active={tool.value === 'pen'} onClick={() => setTool('pen')} />
          <IconButton icon={icons.bend} title="Bend: drag a segment or a point into a curve, click a point to toggle corner / curve (hold Ctrl)" active={tool.value === 'bend'} onClick={() => setTool('bend')} />
          <IconButton icon={icons.hand} title="Hand (H)" active={tool.value === 'hand'} onClick={() => setTool('hand')} />
        </div>
        <div class="tool-group">
          <IconButton icon={<span class="txt-icon">↶</span>} title="Undo (Ctrl+Z)" disabled={!canUndo.value} onClick={undo} />
          <IconButton icon={<span class="txt-icon">↷</span>} title="Redo (Ctrl+Shift+Z)" disabled={!canRedo.value} onClick={redo} />
        </div>
        <div class="tool-group">
          <button type="button" class="btn primary done" title="Leave vector edit mode (Enter)" onClick={exitPathEdit}>Done</button>
          <button type="button" class="zoom" title="Click for 100%, double-click to fit" onClick={() => setZoom(1)} onDblClick={zoomToFit}>{Math.round(view.value.zoom * 100)}%</button>
        </div>
      </div>
    );
  }
  return (
    <div class="toolbar">
      <div class="tool-group">
        {TOOLS.map(t => <IconButton icon={icons[t.icon]} title={t.title} active={tool.value === t.id} onClick={() => setTool(t.id)} />)}
      </div>
      <div class="tool-group">
        <IconButton icon={<span class="txt-icon">↶</span>} title="Undo (Ctrl+Z)" disabled={!canUndo.value} onClick={undo} />
        <IconButton icon={<span class="txt-icon">↷</span>} title="Redo (Ctrl+Shift+Z)" disabled={!canRedo.value} onClick={redo} />
      </div>
      <div class="tool-group">
        <CombineMenu disabled={!has} />
        <IconButton icon={icons.group} title="Group (Ctrl+G)" disabled={!has} onClick={group} />
        <IconButton icon={<span class="txt-icon">⊟</span>} title="Ungroup (Ctrl+Shift+G)" disabled={!has} onClick={ungroup} />
        <IconButton icon={<span class="txt-icon">⤒</span>} title="Bring to front ( ] )" disabled={!has} onClick={() => order('front')} />
        <IconButton icon={<span class="txt-icon">⤓</span>} title="Send to back ( [ )" disabled={!has} onClick={() => order('back')} />
        <IconButton icon={<span class="txt-icon">⧉</span>} title="Copy as SVG code" disabled={!has} onClick={() => void copyAsSvg()} />
      </div>
      <div class="tool-group">
        <IconButton icon={<span class="txt-icon">⌖</span>} title="Snap to objects (smart guides)" active={prefs.snapObjects.value} onClick={() => { prefs.snapObjects.value = !prefs.snapObjects.value; }} />
        <IconButton icon={<span class="txt-icon">▦</span>} title="Snap to pixel grid" active={prefs.snapPixel.value} onClick={() => { prefs.snapPixel.value = !prefs.snapPixel.value; }} />
        <button type="button" class="zoom" title="Zoom to fit (Shift+1). Click for 100%" onClick={() => setZoom(1)} onDblClick={zoomToFit}>{Math.round(view.value.zoom * 100)}%</button>
      </div>
    </div>
  );
}

/** shown instead of the editor while storage is not usable yet */
function StorageGate() {
  const st = storage.value;
  if (st.state === 'loading') return <div class="gate"><div class="gate-card"><h1>vibesketch</h1><p class="dim">Opening your projects…</p></div></div>;
  if (st.state === 'needs-permission') {
    return (
      <div class="gate"><div class="gate-card">
        <h1>vibesketch</h1>
        <p>Your projects are in the folder <b>{st.name}</b> on this computer. The browser asks for access again after a restart.</p>
        <div class="row end">
          <button type="button" class="btn" onClick={() => void useBrowserStorage()}>Use browser storage instead</button>
          <button type="button" class="btn primary" onClick={() => void reconnectFolder()}>Open folder “{st.name}”</button>
        </div>
      </div></div>
    );
  }
  return (
    <div class="gate"><div class="gate-card">
      <h1>vibesketch</h1>
      <p>This browser cannot store projects.</p>
      <p class="note bad">{st.error}</p>
    </div></div>
  );
}

export function App() {
  const [dialog, setDialog] = useState<'projects' | 'sync' | null>(null);
  useEffect(() => installKeys(), []);
  if (storage.value.state !== 'ready') return <StorageGate />;
  const hint = pathEdit.value
    ? (tool.value === 'pen' ? 'Click to add points, drag for curves · click the first point to close · click any point to branch off it · Enter / Esc to finish'
      : tool.value === 'bend' ? 'Drag a segment or a point to curve it · click a point to toggle corner / curve'
      : 'Drag points, handles and segments · drag the dot in the middle of a segment to add a point · hold Ctrl to bend · right-click for more')
    : cropEdit.value ? 'Drag the blue handles to cut the picture · drag the picture to move it behind the frame · round handles scale it · Ctrl: no snapping · Enter / Esc to finish'
    : tool.value === 'slice' ? 'Drag a frame around what you want to export · select it and use Export in the right panel'
    : tool.value === 'connector' ? 'Drag from one layer to another · drop on a side dot to pin that side · Ctrl keeps the end free'
    : null;
  return (
    <div class={`app ${uiHidden.value ? 'ui-hidden' : ''}`}>
      <LeftPanel onProjects={() => setDialog('projects')} onSync={() => setDialog('sync')} onImport={() => void pickFiles().then(f => importFiles(f))} />
      <main class="center">
        <CanvasView />
        <Toolbar />
        {hint && <div class="hintbar">{hint}</div>}
        {saveState.value === 'conflict' && (
          <div class="conflict">
            <span>This project was changed outside this tab (another tab, another program or sync) while you had unsaved edits.</span>
            <button type="button" class="btn" onClick={() => void resolveConflict('theirs')}>Load the other version</button>
            <button type="button" class="btn primary" onClick={() => void resolveConflict('mine')}>Keep mine</button>
          </div>
        )}
        <div class="toasts">{toasts.value.map(t => <div key={t.id} class={`toast ${t.kind}`}>{t.text}</div>)}</div>
      </main>
      <RightPanel />
      <ContextMenu />
      {dialog === 'projects' && <ProjectsDialog onClose={() => setDialog(null)} />}
      {dialog === 'sync' && <SyncDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
