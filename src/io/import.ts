import type { AssetMeta, Doc, GroupNode, Node, RectNode, TextNode, Vec } from '../core/model.ts';
import { BLACK, groupDefaults, newId, shapeDefaults, solid } from '../core/model.ts';
import { invert, mul, translate } from '../core/geom.ts';
import { worldBoundsOf, worldMatrix } from '../core/bounds.ts';
import { insertNodes } from '../core/ops.ts';
import { fontMetrics, layoutText } from '../core/text.ts';
import { defaultFamily, describeFontFile, ensureFont } from '../editor/fonts.ts';
import { zoomToBox } from '../editor/interact.ts';
import { toWorld, stage } from '../editor/stage.ts';
import { addAsset, doc, newProject, openProject, project, refreshProjects, scopeId, select, toast, uniqueProjectName, update } from '../editor/store.ts';
import { api } from './api.ts';
import { importFig } from './fig.ts';
import { projectFromZip } from './projectZip.ts';
import { importSvg } from './svgImport.ts';

// Bringing outside files into the editor: drag & drop, paste and the import button.

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ext = (name: string) => (name.split('.').pop() ?? '').toLowerCase();
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp']);
const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2']);

function viewCenter(): Vec {
  const r = stage.el?.getBoundingClientRect();
  return toWorld({ x: (r?.width ?? 800) / 2, y: (r?.height ?? 600) / 2 });
}

function summarize(warnings: string[], what: string) {
  if (!warnings.length) return;
  console.warn(`${what}:\n- ${warnings.join('\n- ')}`);
  toast(`${what}: ${warnings.slice(0, 3).join('; ')}${warnings.length > 3 ? ` (+${warnings.length - 3} more, see console)` : ''}`, 'info', 9000);
}

async function uploadAssets(assets: Map<string, { bytes: Uint8Array; meta: AssetMeta }>): Promise<Record<string, AssetMeta>> {
  const name = project.value;
  if (!name) throw new Error('no project open');
  const out: Record<string, AssetMeta> = {};
  for (const [key, a] of assets) { await api.putAsset(name, key, a.bytes); out[key] = a.meta; }
  return out;
}

/** Insert an imported node set so that its bounds are centered on `at` (page space). */
function place(nodes: Record<string, Node>, roots: string[], assets: Record<string, AssetMeta>, at: Vec, name: string | null): string[] {
  const container = scopeId.value;
  let list = Object.values(nodes);
  let top = roots;
  if (name && roots.length > 1) {
    const g: GroupNode = { ...groupDefaults(), id: newId(), name, parent: container, children: roots };
    for (const id of roots) nodes[id] = { ...nodes[id], parent: g.id };
    list = [...Object.values(nodes), g];
    top = [g.id];
  } else if (name && roots.length === 1) nodes[roots[0]] = { ...nodes[roots[0]], name };
  if (top === roots) list = Object.values(nodes);
  update(cur => {
    let next: Doc = { ...cur, assets: { ...cur.assets, ...assets } };
    next = insertNodes(next, list, top, container);
    // imported coordinates are page-like: express them in the container and center on the target
    const b = worldBoundsOf(next, top);
    const P = worldMatrix(next, container), Pinv = invert(P);
    const shift = b ? translate(at.x - (b.x + b.w / 2), at.y - (b.y + b.h / 2)) : translate(0, 0);
    const m = mul(Pinv, mul(shift, P));
    const moved = { ...next.nodes };
    for (const id of top) moved[id] = { ...moved[id], transform: mul(m, moved[id].transform) };
    // land on whole pixels
    const nb = worldBoundsOf({ ...next, nodes: moved }, top);
    if (nb) for (const id of top) { const t = moved[id].transform; moved[id] = { ...moved[id], transform: [t[0], t[1], t[2], t[3], t[4] + Math.round(nb.x) - nb.x, t[5] + Math.round(nb.y) - nb.y] }; }
    return { ...next, nodes: moved };
  });
  select(top);
  return top;
}

export async function importSvgText(svg: string, at: Vec = viewCenter(), name: string | null = null): Promise<string[]> {
  const r = await importSvg(svg, { textMetrics: (font, size) => fontMetrics(font, size) });
  if (!r.roots.length) { toast('That SVG has no visible content', 'error'); return []; }
  // make fonts available before measuring anchored text
  const texts = Object.values(r.nodes).filter((n): n is TextNode => n.type === 'text');
  await Promise.all(texts.map(t => ensureFont(t.font)));
  for (const [id, anchor] of Object.entries(r.textAnchors)) {
    const n = r.nodes[id];
    if (!n || n.type !== 'text') continue;
    const w = layoutText(n).w * (anchor === 'end' ? 1 : 0.5);
    r.nodes[id] = { ...n, transform: mul(n.transform, translate(-w, 0)) };
  }
  const assets = await uploadAssets(r.assets);
  const ids = place(r.nodes, r.roots, assets, at, name);
  summarize(r.warnings, 'SVG import');
  return ids;
}

async function importImage(file: File, at: Vec) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const bmp = await createImageBitmap(file);
  const key = await addAsset(bytes, ext(file.name) || file.type.split('/')[1] || 'png');
  const id = newId();
  const node: RectNode = {
    ...shapeDefaults(), id, name: file.name.replace(/\.[^.]+$/, '') || 'Image', parent: '', type: 'rect', w: bmp.width, h: bmp.height, radii: [0, 0, 0, 0],
    fills: [{ type: 'image', asset: key, mode: 'fill', visible: true, opacity: 1 }],
  };
  place({ [id]: node }, [id], { [key]: { mime: file.type || 'image/png', w: bmp.width, h: bmp.height, name: file.name } }, at, null);
}

async function importPdf(file: File, at: Vec) {
  toast(`Converting ${file.name}…`);
  const pages = await api.pdf2svg(new Uint8Array(await file.arrayBuffer()));
  const base = file.name.replace(/\.pdf$/i, '');
  let x = at.x;
  const all: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const ids = await importSvgText(pages[i], { x, y: at.y }, pages.length > 1 ? `${base} – page ${i + 1}` : base);
    const b = worldBoundsOf(doc.value, ids);
    if (b && i === 0) x = b.x + b.w / 2;
    if (b) x += b.w + 40;
    all.push(...ids);
  }
  select(all);
}

async function importFont(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = describeFontFile(bytes, file.name);
  const key = await addAsset(bytes, ext(file.name));
  update(cur => ({
    ...cur,
    assets: { ...cur.assets, [key]: { mime: `font/${ext(file.name)}`, name: file.name } },
    fonts: [...cur.fonts.filter(f => !(f.family === info.family && f.weight === info.weight && f.italic === info.italic)), { ...info, asset: key }],
  }));
  toast(`Added font ${info.family} ${info.weight}${info.italic ? ' italic' : ''} to this project`);
}

async function importFigFile(file: File) {
  toast(`Importing ${file.name}…`);
  const r = await importFig(new Uint8Array(await file.arrayBuffer()));
  await refreshProjects();
  const name = uniqueProjectName(file.name.replace(/\.fig$/i, ''));
  // images first, so they are there when the document is opened
  for (const [key, a] of r.assets) await api.putAsset(name, key, a.bytes);
  await newProject(name, r.doc);
  await openProject(name);
  const count = Object.keys(r.doc.nodes).length;
  toast(`Imported "${name}" as a new project (${count} layers)`);
  summarize(r.warnings, 'Figma import');
  requestAnimationFrame(() => zoomToBox(worldBoundsOf(doc.value, doc.value.pages[0].children), 1));
}

export function addTextAt(text: string, at: Vec = viewCenter()) {
  const id = newId();
  const n: TextNode = {
    ...shapeDefaults(), id, name: text.split('\n')[0].slice(0, 40) || 'Text', parent: '', type: 'text', text,
    font: { family: defaultFamily(), weight: 400, italic: false }, size: 16, lineHeight: null, letterSpacing: 0, align: 'left', w: null, fills: [solid(BLACK)],
  };
  place({ [id]: n }, [id], {}, at, null);
}

/** Import any supported files. `at` is the page-space drop position. */
export async function importFiles(files: File[], at: Vec = viewCenter()): Promise<void> {
  let offset = 0;
  for (const file of files) {
    const e = ext(file.name);
    const pos = { x: at.x + offset, y: at.y + offset };
    try {
      if (e === 'fig') await importFigFile(file);
      else if (e === 'zip') {
        await refreshProjects();
        const name = await projectFromZip(new Uint8Array(await file.arrayBuffer()), file.name, uniqueProjectName);
        await refreshProjects();
        await openProject(name);
        toast(`Opened "${name}" from ${file.name}`);
      }
      else if (e === 'svg' || file.type === 'image/svg+xml') await importSvgText(await file.text(), pos, file.name.replace(/\.svg$/i, ''));
      else if (e === 'pdf' || file.type === 'application/pdf') await importPdf(file, pos);
      else if (FONT_EXT.has(e)) await importFont(file);
      else if (IMAGE_EXT.has(e) || file.type.startsWith('image/')) await importImage(file, pos);
      else { toast(`${file.name}: unsupported file type`, 'error'); continue; }
      offset += 24;
    } catch (err) {
      console.error(err);
      toast(`${file.name}: ${errText(err)}`, 'error');
    }
  }
}

export function pickFiles(): Promise<File[]> {
  return new Promise(res => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.svg,.pdf,.png,.jpg,.jpeg,.gif,.webp,.fig,.zip,.ttf,.otf,.woff,.woff2';
    input.onchange = () => res([...(input.files ?? [])]);
    input.click();
  });
}

// ---------------------------------------------------------------- dropped folders

interface Entry { isFile: boolean; isDirectory: boolean; name: string; file?(ok: (f: File) => void, err: (e: unknown) => void): void; createReader?(): { readEntries(ok: (e: Entry[]) => void, err: (e: unknown) => void): void } }

async function children(dir: Entry): Promise<Entry[]> {
  const reader = dir.createReader!();
  const out: Entry[] = [];
  // readEntries hands out the listing in batches until it returns an empty one
  for (;;) {
    const batch = await new Promise<Entry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) return out;
    out.push(...batch);
  }
}
const fileOf = (e: Entry) => new Promise<File>((res, rej) => e.file!(res, rej));

/** A dropped project folder (`name.vsk`, as written to disk by a folder workspace or by earlier
 *  versions of the app) becomes a project here. Returns the new project's name, or null when
 *  the folder is not a project. */
async function importProjectFolder(dir: Entry): Promise<string | null> {
  const kids = await children(dir);
  const docEntry = kids.find(k => k.isFile && k.name === 'doc.json');
  if (!docEntry) return null;
  const parsed = JSON.parse(await (await fileOf(docEntry)).text()) as Doc;
  if (!parsed || !Array.isArray(parsed.pages)) throw new Error(`${dir.name}: doc.json is not a vibesketch document`);
  await refreshProjects();
  const name = uniqueProjectName(dir.name.replace(/\.vsk$/i, ''));
  const assets = kids.find(k => k.isDirectory && k.name === 'assets');
  if (assets) for (const a of await children(assets)) {
    if (a.isFile && /^[a-f0-9]{8,64}\.[a-z0-9]{1,8}$/.test(a.name)) await api.putAsset(name, a.name, new Uint8Array(await (await fileOf(a)).arrayBuffer()));
  }
  await newProject(name, parsed);
  return name;
}

/** Everything dropped on the canvas: files, project folders, or a whole workspace folder. */
export async function importDrop(dt: DataTransfer, at: Vec): Promise<void> {
  // entries must be taken while the drop event is still being dispatched
  const items = [...dt.items].filter(i => i.kind === 'file');
  const entries = items.map(i => (i as unknown as { webkitGetAsEntry?(): Entry | null }).webkitGetAsEntry?.() ?? null);
  const plain = [...dt.files];
  const dirs = entries.filter((e): e is Entry => !!e && e.isDirectory);
  if (!dirs.length) { await importFiles(plain, at); return; }
  const files = await Promise.all(entries.filter((e): e is Entry => !!e && e.isFile).map(fileOf));
  let last: string | null = null, count = 0;
  for (const dir of dirs) {
    try {
      const direct = await importProjectFolder(dir);
      if (direct) { last = direct; count++; continue; }
      // a folder of projects (a whole workspace)
      let found = 0;
      for (const sub of await children(dir)) {
        if (!sub.isDirectory || sub.name.startsWith('.')) continue;
        const n = await importProjectFolder(sub);
        if (n) { last = n; count++; found++; }
      }
      if (!found) toast(`${dir.name}: no vibesketch projects in this folder`, 'error');
    } catch (err) {
      console.error(err);
      toast(`${dir.name}: ${errText(err)}`, 'error');
    }
  }
  if (last) { await openProject(last); toast(count > 1 ? `Imported ${count} projects` : `Imported "${last}"`); }
  if (files.length) await importFiles(files, at);
}
