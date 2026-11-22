// Collects the typefaces that ship with the app into public/fonts/ with a manifest the font
// picker reads. Sources: the directories in $VIBESKETCH_FONT_DIRS (colon separated; the Nix
// flake points this at a set of well-known open font packages). Needs fontconfig's fc-scan.
// Every family's copyright notice and licence go into public/fonts/LICENSES.txt, which has to
// travel with the font files; a family whose licence is not a known redistributable one stops
// the build. $VIBESKETCH_FONT_BUDGET_MB caps the total size for hosts with a limit: families
// from the directories listed last are left out, those with the largest files first.
//
//   node scripts/build-fonts.ts [outDir=public/fonts]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface Entry {
  id: string; family: string; style: string; weight: number; italic: boolean; file: string;
  /** a variable font: the weights its file covers (the app offers every hundred in between) */
  wght?: [number, number];
}
interface Cand extends Entry { src: string; face: number; variable: boolean }

// fontconfig weight -> CSS weight (see fontconfig's FcWeightToOpenType)
const WEIGHT_MAP: [number, number][] = [[0, 100], [40, 200], [50, 300], [55, 350], [75, 380], [80, 400], [100, 500], [180, 600], [200, 700], [205, 800], [210, 900], [215, 1000]];
export function fcWeightToCss(fc: number): number {
  if (!Number.isFinite(fc)) return 400;
  let css = 400;
  if (fc <= 0) css = 100;
  else if (fc >= 215) css = 1000;
  else for (let i = 1; i < WEIGHT_MAP.length; i++) {
    const [f0, c0] = WEIGHT_MAP[i - 1], [f1, c1] = WEIGHT_MAP[i];
    if (fc <= f1) { css = c0 + ((fc - f0) / (f1 - f0)) * (c1 - c0); break; }
  }
  return Math.min(900, Math.max(100, Math.round(css / 100) * 100));
}

const SEP = '\t';
const FORMAT = ['%{family[0]}', '%{style[0]}', '%{weight}', '%{slant}', '%{file}', '%{index}', '%{fontformat}', '%{variable}'].join(SEP) + '\n';

/** Parse `fc-scan --format FORMAT` output into the faces worth shipping. */
export function parseFcScan(out: string): Cand[] {
  const cands: Cand[] = [];
  for (const line of out.split('\n')) {
    const f = line.split(SEP);
    if (f.length < 7) continue;
    const [family, style, weight, slant, src, index, format, variable] = f;
    if (!family || !src || !/\.(ttf|otf|ttc|otc)$/i.test(src)) continue;
    if (format && !/^(TrueType|CFF)$/i.test(format)) continue;
    // index: low 16 bits = face in a collection, high bits = named instance of a variable font
    const idx = Number(index), face = idx & 0xffff;
    if (!Number.isFinite(idx) || idx >> 16 !== 0) continue;
    const collection = /\.(ttc|otc)$/i.test(src);
    if (!collection && face !== 0) continue;
    const isVar = /true/i.test(variable ?? '') || /^\[/.test(weight.trim());
    const range = /^\[\s*([\d.]+)\s+([\d.]+)\s*\]$/.exec(weight.trim());
    const fc = range ? (Number(range[1]) <= 80 && Number(range[2]) >= 80 ? 80 : Number(range[1])) : Number(weight);
    const id = createHash('sha256').update(`${path.basename(src)}#${face}#${family}#${style}`).digest('hex').slice(0, 16);
    const lo = range ? fcWeightToCss(Number(range[1])) : 0, hi = range ? fcWeightToCss(Number(range[2])) : 0;
    cands.push({ id, family, style: style || 'Regular', weight: fcWeightToCss(fc), italic: Number(slant) > 0, file: '', src, face, variable: isVar, ...(isVar && hi > lo ? { wght: [lo, hi] as [number, number] } : {}) });
  }
  // fontconfig also lists the default instance of a variable font as if it were a static
  // file: drop those rows, and prefer real static faces where a family has both.
  const variableFiles = new Set(cands.filter(c => c.variable).map(c => c.src));
  const rest = cands.filter(c => c.variable || !variableFiles.has(c.src));
  const hasStatic = new Set(rest.filter(c => !c.variable).map(c => c.family));
  const seen = new Set<string>(), out2: Cand[] = [];
  for (const c of rest) {
    if (c.variable && hasStatic.has(c.family)) continue;
    const key = `${c.family}\0${c.weight}\0${c.italic}`;
    // the same file from two packages can come with two opinions about its weight: first one counts
    if (seen.has(key) || seen.has(c.id)) continue;
    seen.add(key).add(c.id);
    out2.push(c);
  }
  return out2.sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight || Number(a.italic) - Number(b.italic));
}

/** Pull one face out of a TrueType / OpenType collection as a standalone font file. */
export function extractCollectionFace(ttc: Buffer, face: number): Buffer {
  if (ttc.toString('latin1', 0, 4) !== 'ttcf') return ttc;
  const count = ttc.readUInt32BE(8);
  if (face < 0 || face >= count) throw new Error('face index out of range');
  const dir = ttc.readUInt32BE(12 + face * 4);
  const numTables = ttc.readUInt16BE(dir + 4);
  const headerLen = 12 + numTables * 16;
  const tables: { rec: number; data: Buffer }[] = [];
  let size = headerLen;
  for (let i = 0; i < numTables; i++) {
    const rec = dir + 12 + i * 16;
    const off = ttc.readUInt32BE(rec + 8), len = ttc.readUInt32BE(rec + 12);
    if (off + len > ttc.length) throw new Error('corrupt font collection');
    tables.push({ rec, data: ttc.subarray(off, off + len) });
    size += (len + 3) & ~3;
  }
  const out = Buffer.alloc(size);
  ttc.copy(out, 0, dir, dir + 12);
  let pos = headerLen;
  tables.forEach((t, i) => {
    const rec = 12 + i * 16;
    ttc.copy(out, rec, t.rec, t.rec + 8); // tag + checksum
    out.writeUInt32BE(pos, rec + 8);
    out.writeUInt32BE(t.data.length, rec + 12);
    t.data.copy(out, pos);
    pos += (t.data.length + 3) & ~3;
  });
  return out;
}

// ---------------------------------------------------------------- licences

/** the licences bundled typefaces may have; the texts are in licenses/<id>.txt */
export const FONT_LICENSES = {
  'OFL-1.1': 'SIL Open Font License 1.1',
  'Apache-2.0': 'Apache License 2.0',
  'Ubuntu-font-1.0': 'Ubuntu Font Licence 1.0',
  'Bitstream-Vera': 'Bitstream Vera Fonts Copyright (DejaVu changes are in the public domain)',
} as const;
export type FontLicense = keyof typeof FONT_LICENSES;

/** families whose files name no licence; taken from their upstream repositories */
const LICENSE_OVERRIDE: Record<string, FontLicense> = { 'League Gothic': 'OFL-1.1', 'Zilla Slab': 'OFL-1.1' };

export interface FontNames { copyright: string; license: string; licenseUrl: string }

/** copyright (name id 0), licence description (13) and licence URL (14) of a font file */
export function fontNames(font: Buffer): FontNames {
  const got: Record<number, string> = {};
  const numTables = font.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (font.toString('latin1', rec, rec + 4) !== 'name') continue;
    const off = font.readUInt32BE(rec + 8), count = font.readUInt16BE(off + 2), strings = off + font.readUInt16BE(off + 4);
    const rank: Record<number, number> = {};
    for (let k = 0; k < count; k++) {
      const r = off + 6 + k * 12;
      const platform = font.readUInt16BE(r), lang = font.readUInt16BE(r + 4), id = font.readUInt16BE(r + 6);
      if (id !== 0 && id !== 13 && id !== 14) continue;
      const raw = font.subarray(strings + font.readUInt16BE(r + 10), strings + font.readUInt16BE(r + 10) + font.readUInt16BE(r + 8));
      // Windows English first, then any Unicode record, then Mac Roman
      const score = platform === 3 && lang === 0x409 ? 3 : platform === 3 || platform === 0 ? 2 : 1;
      if ((rank[id] ?? 0) >= score) continue;
      rank[id] = score;
      got[id] = (platform === 1 ? raw.toString('latin1') : Buffer.from(raw).swap16().toString('utf16le')).replace(/\r\n?/g, '\n').trim();
    }
  }
  return { copyright: got[0] ?? '', license: got[13] ?? '', licenseUrl: got[14] ?? '' };
}

/** Google Fonts keeps every family in a directory named after its licence, next to the licence file */
const GOOGLE_DIRS: Record<string, FontLicense> = { ofl: 'OFL-1.1', apache: 'Apache-2.0', ufl: 'Ubuntu-font-1.0' };

/** which of the known licences a font has (by where it is published, else by what the file
 *  itself declares), or null when it is none of them */
export function fontLicense(family: string, n: FontNames, src = ''): FontLicense | null {
  const dir = /[\\/](ofl|apache|ufl)[\\/][^\\/]+[\\/][^\\/]+$/.exec(src);
  if (dir) return GOOGLE_DIRS[dir[1]];
  const said = `${n.license}\n${n.licenseUrl}`;
  if (/open font license|scripts\.sil\.org|openfontlicense\.org/i.test(said)) return 'OFL-1.1';
  if (/apache/i.test(said)) return 'Apache-2.0';
  if (/bitstream/i.test(said)) return 'Bitstream-Vera';
  if (!said.trim() && /ubuntu font licence/i.test(n.copyright)) return 'Ubuntu-font-1.0';
  if (!said.trim()) return LICENSE_OVERRIDE[family] ?? null;
  return null;
}

export interface FamilyNotice { family: string; faces: number; license: FontLicense; copyright: string[]; terms: string[] }

/** the notice file shipped next to the fonts: who made each family, under which licence, and the licence texts */
export function licenseNotice(families: FamilyNotice[], texts: Record<string, string>): string {
  const rule = '='.repeat(78);
  const out = [
    'Typefaces bundled with vibesketch',
    '',
    'These font files are redistributed unmodified, each under its own licence. They are not',
    'covered by the licence of vibesketch itself. The full licence texts follow the list.',
    '',
  ];
  for (const f of families) {
    out.push(rule, `${f.family}  (${f.faces} ${f.faces === 1 ? 'face' : 'faces'})`, `Licence: ${FONT_LICENSES[f.license]} [${f.license}]`);
    for (const c of f.copyright) out.push(c);
    // a licence note that says more than "this is OFL" (reserved font names, extra notices)
    for (const t of f.terms) if (!f.copyright.includes(t) && !/^(this font software is )?licensed under the (sil )?(open font license|apache license),? version [\d.]+( or later)?\.?( this license is available with a faq at:? \S+)?$/i.test(t.replace(/\s+/g, ' '))) out.push(t);
    out.push('');
  }
  for (const id of [...new Set(families.map(f => f.license))].sort()) out.push(rule, `${FONT_LICENSES[id]} [${id}]`, rule, '', texts[id].trim(), '');
  return out.join('\n');
}

/** the copyright line Google Fonts records for a family (METADATA.pb next to the font files) */
const metadata = new Map<string, string>();
function metadataCopyright(dir: string): string {
  let c = metadata.get(dir);
  if (c === undefined) {
    const file = path.join(dir, 'METADATA.pb');
    const m = existsSync(file) ? /^\s*copyright:\s*"((?:[^"\\]|\\.)*)"/m.exec(readFileSync(file, 'utf8')) : null;
    metadata.set(dir, c = m ? m[1].replace(/\\(.)/g, '$1') : '');
  }
  return c;
}

/** widely used families with large files that a size budget must not cost */
const KEEP = /^(Noto (Sans|Serif)( Display| Mono)?|Roboto (Flex|Serif)|Playfair|Recursive)$/;

/** Leave out whole families until the rest fits into `bytes`: the ones with the largest font
 *  files go first (in practice the CJK families), and only families found under `optionalRoot`'s
 *  parent directory are candidates, so the hand-picked packages always stay. */
export function withinBudget<T extends { family: string; src: string }>(faces: T[], bytes: number, size: (f: T) => number, optionalRoot = ''): T[] {
  let total = 0;
  const fams = new Map<string, { sum: number; max: number; optional: boolean }>();
  const root = path.dirname(optionalRoot);
  for (const f of faces) {
    const s = size(f), e = fams.get(f.family) ?? { sum: 0, max: 0, optional: true };
    e.sum += s; e.max = Math.max(e.max, s); e.optional &&= !!optionalRoot && f.src.startsWith(root + path.sep) && !KEEP.test(f.family);
    fams.set(f.family, e);
    total += s;
  }
  if (total <= bytes) return faces;
  const dropped = new Set<string>();
  for (const [family, e] of [...fams].filter(([, e]) => e.optional).sort((a, b) => b[1].max - a[1].max || a[0].localeCompare(b[0]))) {
    if (total <= bytes) break;
    dropped.add(family);
    total -= e.sum;
  }
  if (total > bytes) throw new Error(`build-fonts: the fonts that always ship need ${(total / 1e6).toFixed(0)} MB, more than the budget`);
  console.log(`build-fonts: left out ${dropped.size} families to stay within ${(bytes / 1e6).toFixed(0)} MB: ${[...dropped].sort().join(', ')}`);
  return faces.filter(f => !dropped.has(f.family));
}

/** not shipped: "Poppins Latin" (the Poppins package carries it with a proprietary licence
 *  note), "EB Garamond Initials" (names no licence), test and demo fonts, maths / keyboard symbol fonts, and the "… Var" duplicates of
 *  families that are there under their plain name */
const SKIP = /^(Poppins Latin|EB Garamond Initials.*|.* Compat Test|AmstelvarAlpha|Decovar Alpha|Adobe Blank|IBM Plex Math|Libertinus (Keyboard|Math)|DejaVu Math.*|.* Var(iable)?)$/;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const outDir = path.resolve(process.argv[2] ?? 'public/fonts');
  const dirs = (process.env.VIBESKETCH_FONT_DIRS ?? '').split(':').filter(Boolean);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  let entries: Entry[] = [];
  if (!dirs.length) console.warn('build-fonts: $VIBESKETCH_FONT_DIRS is empty, bundling no fonts');
  else {
    const scanned = execFileSync('fc-scan', ['--format', FORMAT, ...dirs], { maxBuffer: 256 * 1024 * 1024 }).toString();
    const budget = Number(process.env.VIBESKETCH_FONT_BUDGET_MB) || Infinity;
    const wanted = parseFcScan(scanned).filter(c => !SKIP.test(c.family));
    // a collection is one file for several faces: each face is about its share of it
    const shared = new Map<string, number>();
    for (const c of wanted) shared.set(c.src, (shared.get(c.src) ?? 0) + 1);
    const faces = withinBudget(wanted, budget * 1e6, c => statSync(c.src).size / shared.get(c.src)!, dirs[dirs.length - 1]);
    let bytes = 0;
    const notices = new Map<string, FamilyNotice>(), unlicensed = new Set<string>();
    entries = faces.flatMap(c => {
      const raw = readFileSync(c.src);
      const data = /\.(ttc|otc)$/i.test(c.src) ? extractCollectionFace(raw, c.face) : raw;
      const names = fontNames(data), license = fontLicense(c.family, names, c.src);
      if (!names.copyright) names.copyright = metadataCopyright(path.dirname(c.src));
      if (!license) { unlicensed.add(`${c.family} (${c.src}): ${(names.license || names.licenseUrl || 'no licence named').replace(/\s+/g, ' ').slice(0, 120)}`); return []; }
      let notice = notices.get(c.family);
      if (!notice) notices.set(c.family, notice = { family: c.family, faces: 0, license, copyright: [], terms: [] });
      else if (notice.license !== license) throw new Error(`build-fonts: ${c.family} mixes ${notice.license} and ${license}`);
      notice.faces++;
      if (names.copyright && !notice.copyright.includes(names.copyright)) notice.copyright.push(names.copyright);
      if (names.license && !notice.terms.includes(names.license)) notice.terms.push(names.license);
      const file = `${c.id}.${data.toString('latin1', 0, 4) === 'OTTO' ? 'otf' : 'ttf'}`;
      writeFileSync(path.join(outDir, file), data);
      bytes += data.length;
      return [{ id: c.id, family: c.family, style: c.style, weight: c.weight, italic: c.italic, file, ...(c.wght ? { wght: c.wght } : {}) }];
    });
    if (unlicensed.size) throw new Error(`build-fonts: no redistributable licence recognised for\n  ${[...unlicensed].join('\n  ')}\nadd the family to SKIP, or to LICENSE_OVERRIDE once its licence is confirmed`);
    const texts = Object.fromEntries(Object.keys(FONT_LICENSES).map(id => [id, readFileSync(path.join(import.meta.dirname, '..', 'licenses', `${id}.txt`), 'utf8')]));
    writeFileSync(path.join(outDir, 'LICENSES.txt'), licenseNotice([...notices.values()], texts));
    console.log(`build-fonts: ${new Set(entries.map(e => e.family)).size} families, ${entries.length} faces, ${(bytes / 1e6).toFixed(0)} MB -> ${outDir}`);
  }
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(entries));
}
