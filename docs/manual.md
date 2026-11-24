# vibesketch manual

## Run it

```sh
nix run github:avantiris/vibesketch    # without a checkout
nix run                    # serves the app on http://127.0.0.1:5173
nix run . -- --port 8080
```

## Host it

```sh
nix build .#site           # ./result is the complete website (about 2.5 GB, nearly all of it fonts)
nix build .#site-pages     # every font family that fits into 900 MB (for GitHub Pages)
nix build .#site-small     # the same app with 80 well-known font families only (about 170 MB)
```

The full site carries every family Google Fonts publishes, about 2000. A visitor only ever
downloads the faces their text uses, so the size is a matter of disk space on the host, not of
loading time. Check your host's limits before choosing: some cap the total size (GitHub Pages:
1 GB) or the size of one file (Cloudflare Pages: 25 MB, which a few CJK fonts exceed).

Copy `result/` to any static host (nginx, Caddy, GitHub Pages, an S3 bucket, …). It uses
relative URLs, so it works from a sub-path too. Two requirements:

- **https (or localhost).** Browsers only allow file access and private storage in a secure
  context. Opening `index.html` from disk does not work.
- `.wasm` must be served as `application/wasm` (every common server does this).

Nothing is sent to the host after the files are loaded.

### GitHub Pages

The repository deploys itself: `.github/workflows/pages.yml` builds `site-pages` on every push
to `main` and publishes it. Turn it on once under *Settings → Pages → Source: GitHub Actions*;
the site then lives at <https://avantiris.github.io/vibesketch/> (a fork gets
`https://<user>.github.io/<repository>/`).

GitHub Pages allows 1 GB per site, so `site-pages` leaves out the families with the largest
files until the fonts fit into 900 MB. Those are mostly Chinese, Japanese and Korean families (a
single one can be 50 MB) plus some emoji, symbol and effect fonts; the build log lists them.
About 1850 of the 2050 families stay.

## Where projects are stored

| Browser | Storage |
|---|---|
| Chrome, Edge, Brave, other Chromium | **A folder you pick** (Projects → *Use a folder…*): each project is a plain folder `name.vsk/` with `doc.json` and `assets/`, written as you work. Changes other programs make to it show up in the open editor. After a browser restart one click re-grants access. |
| Firefox, Safari | **The browser's private storage for the site.** It stays on the computer but is not visible as files, because these browsers have no API for writing to a folder. |

In every browser, *Projects* can download a project as `.zip` (its `.vsk` folder) and import
one again, and sync mirrors everything to a remote. Clearing the site's data in the browser
deletes projects that live in private storage, so use a folder, sync or the occasional zip for
anything you care about.

```
<workspace>/
  My logo.vsk/
    doc.json          the document (readable JSON)
    assets/<hash>.*   images and embedded fonts
  .vibesketch/        sync state and trash (deleted projects end up here)
```

## Sync

Cloud icon in the left panel → add a remote. Sync is two-way and continuous while the app is
open: local changes upload within about a second, remote changes are picked up every 15
seconds. If both sides changed a file, the newer one wins and the other is kept next to it as
`doc.conflict-<time>.json`. Credentials are stored in that browser only.

**S3** (AWS, R2, MinIO, Garage, Backblaze, …): endpoint, bucket, prefix and keys. Because the
browser talks to the bucket directly, the bucket needs a CORS rule for the site's origin; the
dialog shows the exact JSON:

```json
[{ "AllowedOrigins": ["https://your.host"], "AllowedMethods": ["GET", "PUT", "DELETE", "HEAD"],
   "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag", "x-amz-meta-mtime"] }]
```

**Google Drive** needs a Google OAuth client ID, since Google only lets registered apps use
Drive: Google Cloud console → enable the Drive API → OAuth client ID of type *Web application*
with `https://your.host/oauth.html` as authorised redirect URI and `https://your.host` as
JavaScript origin. Each user can paste their own client ID, or the host can bake one in at
build time with `VITE_GOOGLE_CLIENT_ID`. The app only sees files it created. Google's browser
sign-in lasts about an hour; after that the cloud icon shows *Not connected* until you click
*Connect* again.

## Fonts

The font picker lists the families bundled into the site: everything Google Fonts publishes
(about 2000 families, variable fonts with their whole weight range) plus a few nixpkgs font
packages (`bundledFonts` in `flake.nix`; any nixpkgs font package can be added). A face is only downloaded when a text
layer uses it. On Chromium, *Add fonts installed on this computer* in the picker adds your
system fonts. For anything else, drop a `.ttf` / `.otf` on the canvas and it is stored in the
project.

## Controls

| | |
|---|---|
| `V` `H` `R` `O` `L` `P` `T` `X` `S` | move, hand, rectangle, ellipse, line, pen, text, connector, slice |
| drag / `Shift` / `Alt` | move · constrain axis or proportions · duplicate, or resize from center |
| `Ctrl` while dragging | no snapping |
| `Alt` + hover | distances from the selection to the layer under the cursor |
| `Ctrl`+click, double-click | select inside groups · enter a group |
| `Tab` / `Shift+Tab`, `Shift+Enter` | next / previous sibling · select the parent group |
| `Enter` / double-click | edit points (or text) · `Esc` leaves |
| in point editing | its own toolbar: move, pen, bend. Drag points, handles and segments; drag the dot in the middle of a segment to pull out a new point; with the pen, click any point to branch off it; hold `Ctrl` (or use the bend tool) to drag a segment or point into a curve; `Alt` breaks handle symmetry; `Del` removes points. The panel and right-click menu have curve / straight, mirroring, add, cut, join and open / close |
| connector tool (`X`) | drag from one layer to another: the arrow stays attached and re-routes with rounded bends when either moves. Drop on a side dot to pin that side, hold `Ctrl` for a free end. A selected connector has two end handles to re-attach it; the panel sets elbow / straight / curved, the bend radius and the arrowheads (also available for any open line). Group a box with its label (`Ctrl+G`) to move and connect them as one |
| double-click an image | crop it: the blue handles cut the picture (it stays where it is), dragging the picture moves it behind the frame, its round corner handles scale it. `Enter` / `Esc` or a click outside finishes. `Enter` on an image still edits its outline as a vector |
| slice tool (`S`) | draw a frame over any part of the page. Select it and export: the file is exactly what the page shows inside the frame, whatever layers that is. A slice is never part of an export itself |
| dots inside a rectangle's corners | corner radius (`Alt`: one corner) |
| gradient fill open in the panel | drag its two end points on the canvas (`Shift`: 45° steps) |
| `Ctrl+E`, combine menu, right-click | flatten · union, subtract, intersect, exclude (the result is one editable path with the bottom layer's look) |
| `Ctrl+D` | duplicate; right after an `Alt`-drag it repeats the same offset |
| `Ctrl+G` / `Ctrl+Shift+G` | group / ungroup |
| `]` `[` / `Ctrl+]` `Ctrl+[` | to front / back · one step |
| arrows / `Ctrl`+arrows (`Shift` ×10) | nudge / resize |
| `Alt+A/D/H/V/W/S` | align left / right / h-center / v-center / top / bottom |
| `Shift+H` `Shift+V` | flip |
| `Shift+X`, `Alt+/`, `Shift+/` | swap fill and stroke · remove fill · remove stroke |
| `Ctrl+Alt+C` / `Ctrl+Alt+V` | copy / paste properties |
| `I` | eyedropper: click a colour on the canvas for the selection's fill (`Esc` cancels); also in every colour picker |
| `Ctrl+B` / `Ctrl+I`, `Ctrl+R` | bold / italic on text layers · rename layer |
| `1`–`9`, `0` | opacity |
| `Ctrl`+wheel, `Space`+drag | zoom, pan · `Shift+1` fit · `Shift+2` selection · `Shift+0` 100% |
| `Ctrl+Alt+M`, `Ctrl+\` | use as mask · hide the interface |

Drop files on the canvas (or paste): SVG, PDF, PNG / JPG / GIF / WebP, fonts, `.fig` (opens as
a new project) and project `.zip` files.

## Development

```sh
nix develop -c npm install      # once
nix develop -c npm run fonts    # once: copies the bundled fonts (2.5 GB) into public/fonts
nix develop -c npm run dev      # http://127.0.0.1:5173 with hot reload

nix develop -c npm run typecheck
nix develop -c npm test         # unit tests; the sync tests run against a real S3 server (versitygw)
```

Browser tests drive the real app (see the header of each file in `test/e2e/`): `smoke.mjs`
(editing, import / export, storage), `diagram.mjs` (connectors), `fonts.mjs` (bundled and variable fonts), `crop.mjs`, `slice.mjs` (also the export preview), `eyedropper.mjs`, `folder.mjs` (folder storage on Chromium), `sync-s3.mjs`
(two browsers syncing through a real S3 server).

Layout: `src/core` (document model, geometry, SVG rendering; no DOM), `src/editor` (state and
canvas interaction), `src/ui` (panels), `src/io` (import / export, project storage),
`src/storage` (folder / browser file system), `src/sync` (S3 and Google Drive).

After changing dependencies, set `npmDepsHash` in `flake.nix` to the hash `nix build` reports.
Flakes only see files git knows about, so `git add` new files before building.
