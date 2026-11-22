import { unzipSync, zipSync } from 'fflate';
import type { Doc } from '../core/model.ts';
import { api, workspace } from './api.ts';

// A project as a single .zip (its .vsk folder). This is how projects leave or enter browsers
// that keep them in private storage, and a handy backup format everywhere.

export async function projectToZip(name: string): Promise<Blob> {
  const w = workspace(), dir = `${name}.vsk`;
  const files: Record<string, Uint8Array> = {};
  for (const f of await w.list(dir)) {
    const data = await w.read(f.path);
    if (data) files[f.path] = data;
  }
  if (!files[`${dir}/doc.json`]) throw new Error(`Project "${name}" was not found`);
  // images are already compressed: store, don't deflate
  return new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' });
}

/** Unpack a project zip into the workspace under a free name; returns that name. */
export async function projectFromZip(bytes: Uint8Array, fallbackName: string, uniqueName: (base: string) => string): Promise<string> {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch { throw new Error('This is not a readable zip file'); }
  const docPath = Object.keys(files).filter(p => /(^|\/)doc\.json$/.test(p)).sort((a, b) => a.length - b.length)[0];
  if (!docPath) throw new Error('No project found in this zip (it has no doc.json)');
  const root = docPath.slice(0, -'doc.json'.length);
  let doc: Doc;
  try { doc = JSON.parse(new TextDecoder().decode(files[docPath])) as Doc; } catch { throw new Error('The doc.json in this zip is damaged'); }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.pages)) throw new Error('The doc.json in this zip is not a vibesketch document');
  const folder = root.replace(/\/$/, '').split('/').pop() ?? '';
  const name = uniqueName(folder.replace(/\.vsk$/i, '') || fallbackName.replace(/(\.vsk)?\.zip$/i, '') || 'Imported');
  for (const [path, data] of Object.entries(files)) {
    const m = path.startsWith(root + 'assets/') ? path.slice((root + 'assets/').length) : null;
    if (m && /^[a-f0-9]{8,64}\.[a-z0-9]{1,8}$/.test(m)) await api.putAsset(name, m, data);
  }
  await api.createProject(name, doc);
  return name;
}
