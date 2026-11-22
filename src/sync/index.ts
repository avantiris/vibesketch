// Sync entry point: owns the configured remotes (one SyncEngine per enabled remote), their
// status, and the Google sign-in state. Remote configs and tokens live in the KV store (per
// browser); manifests live in the workspace under `.vibesketch/`.

import type { KV, Workspace } from '../storage/workspace.ts';
import { UnauthorizedError } from './backend.ts';
import type { FetchFn, SyncBackend } from './backend.ts';
import { SyncEngine } from './engine.ts';
import type { EngineStatus } from './engine.ts';
import { GDriveBackend } from './gdrive.ts';
import { oauthRedirectUri, popupAuthorize } from './oauth-popup.ts';
import type { AccessToken } from './oauth-popup.ts';
import { normalizePrefix, S3Backend } from './s3.ts';
import { errMessage, PRIVATE_DIR } from './util.ts';

export { s3CorsRule, s3NetworkHelp } from './s3.ts';
export { oauthRedirectUri } from './oauth-popup.ts';

export type RemoteConfig =
  | { id: string; type: 's3'; name: string; enabled: boolean; endpoint: string /* '' = AWS */; region: string;
      bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string; pathStyle: boolean }
  | { id: string; type: 'gdrive'; name: string; enabled: boolean; clientId: string; folderName: string };

type S3Config = Extract<RemoteConfig, { type: 's3' }>;
type GDriveConfig = Extract<RemoteConfig, { type: 'gdrive' }>;

export interface RemoteStatus {
  id: string; type: 's3' | 'gdrive'; name: string; enabled: boolean;
  /** RemoteConfig without secrets; gdrive adds `connected: boolean` and `redirectUri: string` */
  config: Record<string, unknown>;
  state: 'idle' | 'syncing' | 'error' | 'disabled' | 'unauthorized';
  lastSync: number | null; error: string | null;
  /** files waiting */
  pending: number;
}

export interface SyncManagerOptions {
  workspace: Workspace;
  kv: KV;
  /** whenever any status changes */
  onStatus(remotes: RemoteStatus[]): void;
  /** files the sync wrote / removed locally (reload an open doc, refresh the project list) */
  onLocalChanged(paths: string[]): void;
  fetch?: typeof fetch;
  /** default 15000 */
  pollMs?: number;
  /** default 1000 */
  debounceMs?: number;
  /** obtain a Google access token; default = popup flow (oauth-popup.ts). Tests inject a fake. */
  authorize?: (clientId: string, interactive: boolean) => Promise<{ accessToken: string; expiresAt: number }>;
}

export interface SyncManager {
  /** configs loaded, engines started */
  ready: Promise<void>;
  remotes(): RemoteStatus[];
  /** create / update; omitted fields (and empty secrets) keep their old value */
  putRemote(id: string, partial: Partial<RemoteConfig> & { type?: 's3' | 'gdrive' }): Promise<RemoteStatus>;
  /** forget the remote (remote data is left alone) */
  deleteRemote(id: string): Promise<void>;
  test(id: string): Promise<{ ok: boolean; error?: string }>;
  /** resolves when the pass(es) finished; failures are reported through the status */
  syncNow(id?: string): Promise<void>;
  /** the editor wrote something: debounce a push */
  notifyLocalChange(): void;
  /** opens the Google sign-in popup synchronously: call it directly from a click handler */
  connectGdrive(id: string): Promise<void>;
  dispose(): void;
}

export const REMOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KV_REMOTES = 'sync.remotes';
const kvToken = (id: string): string => `sync.gdrive.token.${id}`;

function str(v: unknown, field: string, max = 2048): string {
  if (typeof v !== 'string' || v.length > max || /[\0\r\n]/.test(v)) throw new Error(`invalid ${field}`);
  return v;
}

/** Validate a partial config and merge it over the existing one. */
export function mergeRemoteConfig(id: string, partial: Record<string, unknown>, old: RemoteConfig | undefined): RemoteConfig {
  if (!REMOTE_ID_RE.test(id)) throw new Error('invalid remote id');
  if (typeof partial !== 'object' || partial === null) throw new Error('expected an object');
  const type = partial.type ?? old?.type;
  if (type !== 's3' && type !== 'gdrive') throw new Error("type must be 's3' or 'gdrive'");
  if (old && old.type !== type) old = undefined;
  const pick = (key: string, fallback: unknown): unknown => (partial[key] === undefined ? fallback : partial[key]);
  const name = str(pick('name', old?.name ?? id), 'name', 200);
  const enabled = pick('enabled', old?.enabled ?? true);
  if (typeof enabled !== 'boolean') throw new Error('invalid enabled');

  if (type === 's3') {
    const o = old as S3Config | undefined;
    const endpoint = str(pick('endpoint', o?.endpoint ?? ''), 'endpoint').trim().replace(/\/+$/, '');
    if (endpoint) {
      let u: URL;
      try { u = new URL(endpoint); } catch { throw new Error('endpoint must be a http(s) URL or empty'); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('endpoint must be a http(s) URL or empty');
    }
    const bucket = str(pick('bucket', o?.bucket ?? ''), 'bucket', 255).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/.test(bucket)) throw new Error('invalid bucket name');
    const pathStyle = pick('pathStyle', o?.pathStyle ?? !!endpoint);
    if (typeof pathStyle !== 'boolean') throw new Error('invalid pathStyle');
    const secretIn = partial.secretAccessKey;
    const secretAccessKey = secretIn === undefined || secretIn === null || secretIn === ''
      ? o?.secretAccessKey ?? '' : str(secretIn, 'secretAccessKey');
    return {
      id, type, name, enabled, endpoint,
      region: str(pick('region', o?.region ?? 'us-east-1'), 'region', 64).trim() || 'us-east-1',
      bucket,
      prefix: normalizePrefix(str(pick('prefix', o?.prefix ?? ''), 'prefix', 512)),
      accessKeyId: str(pick('accessKeyId', o?.accessKeyId ?? ''), 'accessKeyId', 256).trim(),
      secretAccessKey,
      pathStyle,
    };
  }
  const o = old as GDriveConfig | undefined;
  const folderName = str(pick('folderName', o?.folderName ?? 'VibeSketch'), 'folderName', 200).trim() || 'VibeSketch';
  if (folderName.includes('/')) throw new Error('folderName must not contain "/"');
  return { id, type, name, enabled, clientId: str(pick('clientId', o?.clientId ?? ''), 'clientId', 512).trim(), folderName };
}

function targetOf(c: RemoteConfig): string {
  return c.type === 's3' ? ['s3', c.endpoint, c.bucket, c.prefix].join('|') : ['gdrive', c.clientId, c.folderName].join('|');
}

export function createSyncManager(opts: SyncManagerOptions): SyncManager {
  const { workspace, kv } = opts;
  const fetchFn: FetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  const authorize = opts.authorize ?? popupAuthorize;

  let configs: RemoteConfig[] = [];
  let loaded = false;
  let disposed = false;
  const engines = new Map<string, SyncEngine>();
  const status = new Map<string, EngineStatus>();
  /** which gdrive remotes currently hold a token (mirror of the KV, for synchronous status) */
  const connected = new Set<string>();
  const renewing = new Map<string, Promise<string>>();
  /** serializes reconfiguration so two engines never run for one remote */
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  const find = (id: string): RemoteConfig | undefined => configs.find((c) => c.id === id);
  const need = (id: string): RemoteConfig => {
    const c = find(id);
    if (!c) throw new Error(`unknown remote: ${id}`);
    return c;
  };
  const manifestPath = (id: string): string => `${PRIVATE_DIR}/sync-${id}.json`;

  const statusOf = (c: RemoteConfig): RemoteStatus => {
    const s = engines.get(c.id)?.getStatus() ?? status.get(c.id)
      ?? { state: c.enabled ? 'idle' : 'disabled', lastSync: null, error: null, pending: 0 };
    // an engine only knows what happened since it was created; keep the older lastSync
    const lastSync = s.lastSync ?? status.get(c.id)?.lastSync ?? null;
    let config: Record<string, unknown>;
    if (c.type === 's3') {
      const { secretAccessKey: _secret, ...rest } = c;
      config = rest;
    } else {
      config = { ...c, connected: connected.has(c.id) && s.state !== 'unauthorized', redirectUri: oauthRedirectUri() };
    }
    return { id: c.id, type: c.type, name: c.name, enabled: c.enabled, config, state: s.state, lastSync, error: s.error, pending: s.pending };
  };
  const remotes = (): RemoteStatus[] => configs.map(statusOf);
  const emit = (): void => {
    if (!disposed) opts.onStatus(remotes());
  };
  const setStatus = (id: string, s: EngineStatus): void => {
    status.set(id, s);
    emit();
  };

  /** Token source for a gdrive remote: the stored token, else ONE silent renewal attempt. */
  const tokenSource = (c: GDriveConfig) => (forceNew: boolean): Promise<string> => {
    const run = async (): Promise<string> => {
      const stored = await kv.get<AccessToken>(kvToken(c.id));
      if (!stored) throw new UnauthorizedError('Not connected to Google Drive yet');
      if (!forceNew && stored.expiresAt - 60_000 > Date.now()) return stored.accessToken;
      let fresh: AccessToken;
      try {
        fresh = await authorize(c.clientId, false);
      } catch (e) {
        throw new UnauthorizedError(`Google Drive sign-in expired (${errMessage(e)}); connect again`);
      }
      await kv.set(kvToken(c.id), fresh);
      return fresh.accessToken;
    };
    let p = renewing.get(c.id);
    if (!p) {
      p = run().finally(() => renewing.delete(c.id));
      renewing.set(c.id, p);
    }
    return p;
  };

  const makeBackend = (c: RemoteConfig): SyncBackend =>
    c.type === 's3' ? new S3Backend(c, fetchFn) : new GDriveBackend({ folderName: c.folderName, getToken: tokenSource(c) }, fetchFn);

  /** (Re)create the engine for a remote according to its current config. */
  const setup = async (c: RemoteConfig): Promise<void> => {
    await engines.get(c.id)?.stop();
    engines.delete(c.id);
    if (disposed) return;
    const prev = status.get(c.id);
    const base: EngineStatus = { state: 'idle', lastSync: prev?.lastSync ?? null, error: null, pending: 0 };
    if (!c.enabled) return setStatus(c.id, { ...base, state: 'disabled' });
    if (c.type === 'gdrive') {
      if (!c.clientId) return setStatus(c.id, { ...base, state: 'unauthorized', error: 'Enter the OAuth client ID first' });
      if (!connected.has(c.id)) return setStatus(c.id, { ...base, state: 'unauthorized', error: 'Not connected to Google Drive yet' });
    }
    let backend: SyncBackend;
    try {
      backend = makeBackend(c);
    } catch (e) {
      return setStatus(c.id, { ...base, state: 'error', error: errMessage(e) });
    }
    const o: ConstructorParameters<typeof SyncEngine>[0] = {
      workspace, backend, manifestPath: manifestPath(c.id), target: targetOf(c),
      onStatus: (s) => { if (engines.get(c.id) === engine) setStatus(c.id, s); },
      onLocalChanged: (paths) => { if (!disposed) opts.onLocalChanged(paths); },
    };
    if (opts.pollMs !== undefined) o.pollMs = opts.pollMs;
    if (opts.debounceMs !== undefined) o.debounceMs = opts.debounceMs;
    const engine: SyncEngine = new SyncEngine(o);
    engines.set(c.id, engine);
    engine.setPaused(isHidden());
    setStatus(c.id, base);
    engine.start();
  };

  // ---- pause while the tab is hidden, sync right away when it comes back
  const doc = (globalThis as { document?: Document }).document;
  const isHidden = (): boolean => !!doc?.hidden;
  const onVisibility = (): void => {
    for (const e of engines.values()) e.setPaused(isHidden());
  };
  doc?.addEventListener?.('visibilitychange', onVisibility);

  const ready = serial(async () => {
    const stored = await kv.get<RemoteConfig[]>(KV_REMOTES);
    configs = Array.isArray(stored)
      ? stored.filter((c) => c && typeof c === 'object' && REMOTE_ID_RE.test(String(c.id)) && (c.type === 's3' || c.type === 'gdrive'))
      : [];
    for (const c of configs) if (c.type === 'gdrive' && await kv.get(kvToken(c.id))) connected.add(c.id);
    loaded = true;
    for (const c of configs) await setup(c);
  });

  return {
    ready,
    remotes,

    putRemote(id, partial) {
      return serial(async () => {
        const old = find(id);
        const next = mergeRemoteConfig(id, partial as Record<string, unknown>, old);
        // a token belongs to one OAuth client: drop it when the client id changes
        if (next.type === 'gdrive' && (old?.type !== 'gdrive' || old.clientId !== next.clientId)) {
          connected.delete(id);
          await kv.delete(kvToken(id));
        }
        if (next.type === 's3' && old?.type === 'gdrive') {
          connected.delete(id);
          await kv.delete(kvToken(id));
        }
        configs = old ? configs.map((c) => (c.id === id ? next : c)) : [...configs, next];
        await kv.set(KV_REMOTES, configs);
        await setup(next);
        return statusOf(next);
      });
    },

    deleteRemote(id) {
      return serial(async () => {
        need(id);
        await engines.get(id)?.stop();
        engines.delete(id);
        status.delete(id);
        connected.delete(id);
        configs = configs.filter((c) => c.id !== id);
        await kv.set(KV_REMOTES, configs);
        await kv.delete(kvToken(id));
        await workspace.remove(manifestPath(id));
        emit();
      });
    },

    async test(id) {
      try {
        await ready;
        await makeBackend(need(id)).test();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errMessage(e) };
      }
    },

    async syncNow(id) {
      await ready;
      await chain;
      if (id !== undefined) need(id);
      const targets = id !== undefined ? [engines.get(id)] : [...engines.values()];
      await Promise.all(targets.map((e) => e?.syncNow().catch(() => {})));
    },

    notifyLocalChange() {
      for (const e of engines.values()) e.notifyLocalChange();
    },

    connectGdrive(id) {
      // No `await` before `authorize`: the popup must open inside the user's click.
      let pending: Promise<AccessToken>;
      try {
        if (!loaded) throw new Error('Sync is still starting; try again in a moment');
        const c = need(id);
        if (c.type !== 'gdrive') throw new Error('not a Google Drive remote');
        if (!c.clientId) throw new Error('Enter the OAuth client ID first');
        pending = authorize(c.clientId, true);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      return pending.then((token) => serial(async () => {
        const c = find(id);
        if (!c || c.type !== 'gdrive') throw new Error('the remote was removed during sign-in');
        await kv.set(kvToken(id), token);
        connected.add(id);
        await setup(c);
      }));
    },

    dispose() {
      disposed = true;
      doc?.removeEventListener?.('visibilitychange', onVisibility);
      for (const e of engines.values()) void e.stop();
      engines.clear();
    },
  };
}
