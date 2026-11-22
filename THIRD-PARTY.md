# Third-party material

vibesketch itself is licensed under the GNU Affero General Public License, version 3 or later
([LICENSE](LICENSE)). The built site also contains the software and typefaces below, each under
its own licence. All of these licences allow redistribution, and all are compatible with
distributing the combined app under the AGPL.

Nothing has to be maintained by hand here: the build writes the complete notices, with every
copyright line and licence text, into the site, and stops if something has no known licence.

| In the built site | Covers | Written by |
| --- | --- | --- |
| `LICENSE.txt` | vibesketch | `vite.config.ts` |
| `THIRD-PARTY-LICENSES.txt` | every npm package in the bundle | `vite.config.ts` |
| `fonts/LICENSES.txt` | every bundled typeface | `scripts/build-fonts.ts` |
| `vibesketch-source.tar.gz` | the source of exactly that build | `flake.nix` |
| `licenses.html` | the page that links the four, opened from the app | `public/licenses.html` |

## Software

| Package | Licence | Used for |
| --- | --- | --- |
| mupdf (Artifex Software) | AGPL-3.0-or-later | PDF import. The reason the app as a whole is AGPL |
| preact, @preact/signals, @preact/signals-core | MIT | user interface |
| paper | MIT | boolean operations on paths |
| opentype.js | MIT | reading fonts, text outlines |
| jspdf, svg2pdf.js | MIT | PDF export |
| kiwi-schema | MIT | decoding `.fig` files |
| fflate, fzstd, pako | MIT (pako: MIT and Zlib) | compression |
| aws4fetch | MIT | signing S3 requests |
| dompurify | MPL-2.0 or Apache-2.0 (used under Apache-2.0) | pulled in by jspdf |
| html2canvas, canvg, core-js, @babel/runtime, fast-png, iobuffer, cssesc, font-family-papandreou, specificity, svgpath, svg-pathdata, stackblur-canvas, rgbcolor, raf, performance-now | MIT | pulled in by jspdf and svg2pdf.js |

MuPDF's WebAssembly binary has further libraries linked in (FreeType, HarfBuzz, OpenJPEG,
libjpeg, zlib, jbig2dec, Little CMS, Gumbo, MuJS, Brotli), each under a permissive licence or
the AGPL; their notices are in the `thirdparty` directory of the MuPDF source.

kiwi-schema is published without its licence file; the upstream text is kept in
[licenses/npm/kiwi-schema.txt](licenses/npm/kiwi-schema.txt).

Development tools (Vite, TypeScript, Playwright, linkedom and the type packages) are not part of
the built site.

## Typefaces

The font files are not in this repository. The Nix build takes them from the Google Fonts
repository (every family it publishes, about 2000) and from a few nixpkgs font packages, and
writes each family's copyright line and licence into `fonts/LICENSES.txt`. The licence texts are
in [licenses/](licenses).

| Licence | Families |
| --- | --- |
| SIL Open Font License 1.1 (`OFL-1.1`) | nearly all of them, about 1990 |
| Apache License 2.0 (`Apache-2.0`) | about 50, among them Open Sans, Roboto Slab, Caladea and the older Google families |
| Ubuntu Font Licence 1.0 (`Ubuntu-font-1.0`) | Ubuntu, Ubuntu Condensed, Ubuntu Mono, Ubuntu Sans, Ubuntu Sans Mono |
| Bitstream Vera Fonts Copyright, DejaVu changes in the public domain (`Bitstream-Vera`) | DejaVu Sans, DejaVu Sans Mono, DejaVu Serif |

How the licence of a family is known: Google Fonts keeps each family in a directory named after
its licence (`ofl`, `apache`, `ufl`) next to the licence file; for the nixpkgs packages it is
read from the font file itself. A family that names no redistributable licence stops the build.

Two things these licences ask of anyone hosting the app: the fonts may not be sold on their own,
and a modified font may not keep a reserved name (most OFL families reserve theirs). The app
ships them as published.

## Trademarks

vibesketch is an independent project, not affiliated with or endorsed by Figma, Inc. "Figma" is
a trademark of Figma, Inc. and is used only to describe the `.fig` file format and the control
conventions the app follows.
