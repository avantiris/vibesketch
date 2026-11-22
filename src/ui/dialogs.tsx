import { useEffect, useState } from 'preact/hooks';
import { chooseFolder, flush, newProject, openProject, project, projectList, projectsChanged, refreshProjects, remotes, storage, syncManager, toast, uniqueProjectName, useBrowserStorage } from '../editor/store.ts';
import { api } from '../io/api.ts';
import { download } from '../io/export.ts';
import { projectFromZip, projectToZip } from '../io/projectZip.ts';
import type { RemoteStatus } from '../sync/index.ts';
import { Dialog, icons, IconButton } from './controls.tsx';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};
const size = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);

function pickZip(): Promise<File | null> {
  return new Promise(res => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.onchange = () => res(input.files?.[0] ?? null);
    input.click();
  });
}

function StorageBox() {
  const st = storage.value;
  return (
    <div class="storage-box">
      <div>
        <strong>{st.kind === 'folder' ? `Folder: ${st.name}` : 'Stored in this browser'}</strong>
        <p class="dim">
          {st.kind === 'folder'
            ? 'Projects are ordinary folders (name.vsk) inside that folder on this computer, written as you work.'
            : st.canPickFolder
              ? 'Projects are kept in this browser\'s private storage for this site. Choose a folder to have them as real files on this computer.'
              : 'Projects are kept in this browser\'s private storage for this site: they stay on this computer, but not as files you can see. This browser cannot write to a folder (Chrome, Edge and Brave can). Download a project as .zip to get a file, or set up sync.'}
        </p>
      </div>
      <div class="storage-actions">
        {st.canPickFolder && <button type="button" class="btn" onClick={() => void chooseFolder()}>{st.kind === 'folder' ? 'Change folder…' : 'Use a folder…'}</button>}
        {st.kind === 'folder' && <button type="button" class="btn" onClick={() => { if (confirm('Switch to this browser\'s private storage? The folder and its projects stay as they are.')) void useBrowserStorage(); }}>Use browser storage</button>}
      </div>
    </div>
  );
}

export function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => { void refreshProjects(); }, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast(errText(e), 'error'); }
    setBusy(false);
    projectsChanged();
  };
  const open = (name: string) => run(async () => { await openProject(name); onClose(); });
  return (
    <Dialog title="Projects" onClose={onClose} width={600}>
      <StorageBox />
      <div class="project-list">
        {projectList.value.map(p => (
          <div class={`project-item ${p.name === project.value ? 'current' : ''}`}>
            <button type="button" class="project-open" disabled={busy} onClick={() => open(p.name)}>
              <strong>{p.name}</strong><span class="dim">{ago(p.mtime)} · {size(p.size)}</span>
            </button>
            <button type="button" class="link" disabled={busy} onClick={() => {
              const to = prompt('Rename project', p.name)?.trim();
              if (to && to !== p.name) void run(async () => { await flush(); await api.renameProject(p.name, to); if (project.value === p.name) await openProject(to); });
            }}>Rename</button>
            <button type="button" class="link" disabled={busy} onClick={() => {
              const to = prompt('Name of the copy', `${p.name} copy`)?.trim();
              if (to) void run(async () => { await flush(); await api.duplicateProject(p.name, to); });
            }}>Duplicate</button>
            <button type="button" class="link" disabled={busy} title="Download the project folder as a .zip" onClick={() => void run(async () => { await flush(); download(await projectToZip(p.name), `${p.name}.vsk.zip`); })}>Download</button>
            <IconButton icon={icons.trash} title="Delete (moved to the workspace trash)" disabled={busy || projectList.value.length < 2} onClick={() => {
              if (!confirm(`Delete "${p.name}"? It is moved to the trash folder (.vibesketch/trash) of the workspace.`)) return;
              void run(async () => {
                if (project.value === p.name) { const other = projectList.value.find(x => x.name !== p.name); if (other) await openProject(other.name); }
                await api.deleteProject(p.name);
              });
            }} />
          </div>
        ))}
      </div>
      <div class="row end">
        <button type="button" class="btn" disabled={busy} title="Open a project that was downloaded as .zip" onClick={() => void pickZip().then(f => {
          if (f) void run(async () => { const n = await projectFromZip(new Uint8Array(await f.arrayBuffer()), f.name, uniqueProjectName); await refreshProjects(); await openProject(n); onClose(); });
        })}>Import .zip…</button>
        <button type="button" class="btn primary" disabled={busy} onClick={() => run(async () => { const n = await newProject('Untitled'); await openProject(n); onClose(); })}>New project</button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- sync

const STATE_TEXT: Record<RemoteStatus['state'], string> = { idle: 'Up to date', syncing: 'Syncing…', error: 'Error', disabled: 'Paused', unauthorized: 'Not connected' };

function Field(p: { label: string; value: string; onInput: (v: string) => void; type?: 'text' | 'password'; placeholder?: string; hint?: string }) {
  return (
    <label class="field">
      <span>{p.label}</span>
      <input type={(p.type ?? 'text') as 'text'} value={p.value} placeholder={p.placeholder} spellcheck={false} autocomplete="off" onInput={e => p.onInput(e.currentTarget.value)} />
      {p.hint && <small>{p.hint}</small>}
    </label>
  );
}

const redirectUri = () => new URL('oauth.html', document.baseURI).href;
const corsRule = () => JSON.stringify([{ AllowedOrigins: [location.origin], AllowedMethods: ['GET', 'PUT', 'DELETE', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag', 'x-amz-meta-mtime'] }], null, 2);
const BUILT_IN_CLIENT = (import.meta.env?.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';

function RemoteForm({ initial, onDone }: { initial: RemoteStatus | { type: 's3' | 'gdrive' }; onDone: () => void }) {
  const existing = 'id' in initial ? initial : null;
  const cfg = (existing?.config ?? {}) as Record<string, string | boolean | undefined>;
  const type = initial.type;
  const [f, setF] = useState<Record<string, string>>({
    name: existing?.name ?? (type === 's3' ? 'S3' : 'Google Drive'),
    endpoint: String(cfg.endpoint ?? ''), region: String(cfg.region ?? 'us-east-1'), bucket: String(cfg.bucket ?? ''), prefix: String(cfg.prefix ?? 'vibesketch/'),
    accessKeyId: String(cfg.accessKeyId ?? ''), secretAccessKey: '',
    clientId: String(cfg.clientId ?? BUILT_IN_CLIENT), folderName: String(cfg.folderName ?? 'VibeSketch'),
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: string) => (v: string) => setF({ ...f, [k]: v });
  const [id] = useState(() => existing?.id ?? `${type}-${Math.random().toString(36).slice(2, 8)}`);
  const body = (): Record<string, unknown> => {
    const b: Record<string, unknown> = { type, name: f.name.trim() || type, enabled: existing?.enabled ?? true };
    if (type === 's3') Object.assign(b, { endpoint: f.endpoint.trim(), region: f.region.trim() || 'us-east-1', bucket: f.bucket.trim(), prefix: f.prefix.trim(), accessKeyId: f.accessKeyId.trim() }, f.secretAccessKey ? { secretAccessKey: f.secretAccessKey } : {});
    else Object.assign(b, { clientId: f.clientId.trim(), folderName: f.folderName.trim() || 'VibeSketch' });
    return b;
  };
  const save = async (then?: 'test') => {
    const m = syncManager();
    if (!m) return;
    setBusy(true); setMsg(null);
    try {
      await m.putRemote(id, body());
      if (then === 'test') {
        const r = await m.test(id);
        setMsg(r.ok ? { ok: true, text: 'Connection works.' } : { ok: false, text: r.error ?? 'Connection failed' });
      } else onDone();
    } catch (e) { setMsg({ ok: false, text: errText(e) }); }
    setBusy(false);
  };
  // the Google popup has to open directly from the click, so saving happens first in the background
  const connect = () => {
    const m = syncManager();
    if (!m) return;
    setBusy(true); setMsg(null);
    void m.putRemote(id, body())
      .then(() => m.connectGdrive(id))
      .then(() => { setMsg({ ok: true, text: 'Connected to Google Drive.' }); })
      .catch(e => setMsg({ ok: false, text: errText(e) }))
      .finally(() => setBusy(false));
  };
  return (
    <div class="remote-form">
      <Field label="Name" value={f.name} onInput={set('name')} />
      {type === 's3' ? (<>
        <Field label="Endpoint" value={f.endpoint} onInput={set('endpoint')} placeholder="https://s3.eu-central-1.amazonaws.com" hint="Leave empty for AWS. Any S3-compatible service works (MinIO, R2, Backblaze, Garage…)." />
        <div class="grid2"><Field label="Bucket" value={f.bucket} onInput={set('bucket')} /><Field label="Region" value={f.region} onInput={set('region')} /></div>
        <Field label="Folder prefix" value={f.prefix} onInput={set('prefix')} />
        <div class="grid2">
          <Field label="Access key ID" value={f.accessKeyId} onInput={set('accessKeyId')} />
          <Field label="Secret access key" type="password" value={f.secretAccessKey} onInput={set('secretAccessKey')} placeholder={existing ? 'unchanged' : ''} />
        </div>
        <details class="help">
          <summary>The bucket must allow this site (CORS)</summary>
          <p class="dim">The browser talks to the bucket directly, so the bucket needs this CORS configuration. The keys are stored in this browser only and are sent to nobody but your S3 endpoint.</p>
          <pre>{corsRule()}</pre>
        </details>
      </>) : (<>
        <Field label="Google OAuth client ID" value={f.clientId} onInput={set('clientId')} placeholder="1234567890-abc.apps.googleusercontent.com" />
        <Field label="Drive folder" value={f.folderName} onInput={set('folderName')} />
        <details class="help" open={!f.clientId}>
          <summary>Where the client ID comes from</summary>
          <p class="dim">Google only lets registered apps use Drive. In the Google Cloud console enable the Drive API and create an OAuth client ID of type <b>Web application</b> with this authorised redirect URI and JavaScript origin, then paste its client ID above. Use the same client ID on every device. The app can only see files it created itself.</p>
          <pre>{`Redirect URI:      ${redirectUri()}\nJavaScript origin: ${location.origin}`}</pre>
          <p class="dim">Google signs you in for about an hour at a time; when that runs out the cloud icon shows “Not connected” and one click reconnects.</p>
        </details>
      </>)}
      {msg && <div class={`note ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}
      <div class="row end">
        <button type="button" class="btn" disabled={busy} onClick={onDone}>{msg?.ok ? 'Close' : 'Cancel'}</button>
        {type === 's3' ? <button type="button" class="btn" disabled={busy} onClick={() => void save('test')}>Save &amp; test</button>
          : <button type="button" class="btn" disabled={busy || !f.clientId.trim()} onClick={connect}>Save &amp; connect Google…</button>}
        <button type="button" class="btn primary" disabled={busy} onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}

export function SyncDialog({ onClose }: { onClose: () => void }) {
  const [editing, setEditing] = useState<RemoteStatus | { type: 's3' | 'gdrive' } | null>(null);
  const m = syncManager();
  const act = (fn: () => Promise<unknown>) => { void fn().catch(e => toast(errText(e), 'error')); };
  return (
    <Dialog title="Sync" onClose={onClose} width={600}>
      {!m ? <div class="empty">Storage is not ready yet.</div> : editing ? <RemoteForm initial={editing} onDone={() => setEditing(null)} /> : (<>
        <p class="dim">Your work is always saved on this computer first. A remote mirrors all projects both ways, straight from this browser to your own bucket or Drive: nothing passes through anyone else's server, and the credentials stay in this browser. Changes made here upload within a second; changes made elsewhere appear while the app is open. If both sides changed the same file, the newer one wins and the other is kept as a <code>.conflict</code> copy.</p>
        <div class="remote-list">
          {remotes.value.map(r => (
            <div class="remote-item">
              <div class="remote-main">
                <strong>{r.name}</strong>
                <span class="dim">{r.type === 's3' ? `S3 · ${String(r.config.bucket ?? '')}/${String(r.config.prefix ?? '')}` : `Google Drive · ${String(r.config.folderName ?? '')}`}</span>
                <span class={`state ${r.state}`}>{STATE_TEXT[r.state]}{r.pending ? ` · ${r.pending} pending` : ''}{r.lastSync ? ` · last sync ${ago(r.lastSync)}` : ''}</span>
                {r.error && <span class="note bad">{r.error}</span>}
              </div>
              {r.type === 'gdrive' && r.state === 'unauthorized'
                ? <button type="button" class="btn primary" onClick={() => act(() => m.connectGdrive(r.id))}>Connect</button>
                : <button type="button" class="link" onClick={() => act(() => m.syncNow(r.id))}>Sync now</button>}
              <button type="button" class="link" onClick={() => act(() => m.putRemote(r.id, { enabled: !r.enabled }))}>{r.enabled ? 'Pause' : 'Resume'}</button>
              <button type="button" class="link" onClick={() => setEditing(r)}>Edit</button>
              <IconButton icon={icons.trash} title="Remove remote (remote files are kept)" onClick={() => { if (confirm(`Stop syncing with "${r.name}"? Files on the remote are not deleted.`)) act(() => m.deleteRemote(r.id)); }} />
            </div>
          ))}
          {!remotes.value.length && <div class="empty">No remotes yet.</div>}
        </div>
        <div class="row end">
          <button type="button" class="btn" onClick={() => setEditing({ type: 's3' })}>Add S3 bucket</button>
          <button type="button" class="btn" onClick={() => setEditing({ type: 'gdrive' })}>Add Google Drive</button>
        </div>
      </>)}
    </Dialog>
  );
}
