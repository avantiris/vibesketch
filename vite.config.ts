import preact from '@preact/preset-vite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** What MuPDF's licence file does not say: its WebAssembly build has other libraries linked in. */
const MUPDF_NOTE = `The MuPDF WebAssembly binary statically links third-party libraries that keep their own
licences, among them FreeType (FreeType License), HarfBuzz (MIT), OpenJPEG (BSD-2-Clause),
libjpeg (IJG), zlib (Zlib), jbig2dec (AGPL-3.0-or-later), Little CMS (MIT), Gumbo (Apache-2.0),
MuJS (ISC) and Brotli (MIT). Their notices are in the "thirdparty" directory of the MuPDF
source: https://github.com/ArtifexSoftware/mupdf`;

/**
 * The built site ships other people's code in minified form, which strips the copyright
 * notices their licences require to be kept. This writes them back out: LICENSE.txt (the
 * app's own licence) and THIRD-PARTY-LICENSES.txt (every npm package that ends up in the
 * bundle, with its licence text). The fonts' notices are written by scripts/build-fonts.ts.
 */
function licenses(): Plugin {
  const root = import.meta.dirname;
  const packageRoot = (id: string) => /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id.replace(/^\0/, '').split('?')[0])?.[1];
  return {
    name: 'vibesketch-licenses',
    apply: 'build',
    generateBundle(_, bundle) {
      const own = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
      // everything listed as a dependency is shipped, even where it is loaded as a worker or .wasm
      const dirs = new Set(Object.keys(own.dependencies).map(name => path.join(root, 'node_modules', name)));
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules)) { const dir = packageRoot(id); if (dir) dirs.add(dir); }
      }
      const rule = '='.repeat(78);
      const out = [
        'Third-party software in vibesketch',
        '',
        'vibesketch itself is licensed under the GNU Affero General Public License, version 3 or',
        'later (LICENSE.txt). It includes the packages below, each under its own licence. The',
        'bundled typefaces are listed in fonts/LICENSES.txt.',
        '',
      ];
      const packages = [...dirs].filter(dir => existsSync(path.join(dir, 'package.json')))
        .map(dir => ({ dir, pkg: JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) }))
        .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
      for (const { dir, pkg } of packages) {
        const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
        if (!license) this.error(`${pkg.name} declares no licence: check it before shipping it`);
        // a package published without its licence file has the upstream text in licenses/npm/
        const kept = path.join(root, 'licenses', 'npm', `${pkg.name.replace('/', '__')}.txt`);
        const files = existsSync(kept) ? [kept] : readdirSync(dir).filter(f => /^(licen[sc]e|copying|notice)/i.test(f)).sort().map(f => path.join(dir, f));
        if (!files.length) this.error(`${pkg.name} ships no licence file: put its upstream licence text in licenses/npm/`);
        const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
        const repo = (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url)?.replace(/^git\+/, '').replace(/\.git$/, '');
        out.push(rule, `${pkg.name} ${pkg.version}`, `Licence: ${license}`);
        if (author) out.push(`Author: ${author}`);
        if (repo || pkg.homepage) out.push(`Source: ${repo ?? pkg.homepage}`);
        out.push(rule, '');
        if (pkg.name === 'mupdf') out.push(MUPDF_NOTE, '');
        for (const f of files) out.push(readFileSync(f, 'utf8').replace(/\r\n?/g, '\n').trim(), '');
      }
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-LICENSES.txt', source: out.join('\n') });
      this.emitFile({ type: 'asset', fileName: 'LICENSE.txt', source: readFileSync(path.join(root, 'LICENSE'), 'utf8') });
    },
  };
}

export default defineConfig({
  // relative URLs: the built site works from any path (a sub-folder, a bucket, file hosting)
  base: './',
  plugins: [preact(), licenses()],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  // mupdf loads its .wasm relative to its own module; pre-bundling would break that
  optimizeDeps: { exclude: ['mupdf'] },
  server: { host: '127.0.0.1' },
});
