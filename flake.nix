{
  description = "vibesketch – a local-first vector design tool that runs entirely in the browser";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});

      # Typefaces that are always available in the font picker, whatever is installed on the
      # visitor's machine. They are copied into the site as static files and fetched one face
      # at a time, only when a text layer uses them.
      bundledFonts = pkgs: with pkgs; [
        montserrat inter roboto roboto-slab roboto-mono open-sans lato poppins raleway oswald
        merriweather merriweather-sans source-sans source-serif source-code-pro ibm-plex
        fira-sans fira-code jetbrains-mono work-sans nunito nunito-sans dm-sans rubik karla
        quicksand cabin barlow lexend public-sans overpass libre-franklin league-spartan
        league-gothic ubuntu-classic cantarell-fonts atkinson-hyperlegible
        libre-baskerville eb-garamond lora crimson-pro alegreya alegreya-sans vollkorn gelasio
        zilla-slab libertinus courier-prime inconsolata comic-neue dancing-script
        liberation_ttf carlito caladea dejavu_fonts
      ];
      # Everything Google Fonts publishes (about 2000 families, 2.3 GB), straight from its
      # repository: the directory a family is in says which licence it has. Families that are
      # also in the list above keep the files from there.
      googleFonts = pkgs: map (d: "${pkgs.google-fonts.src}/${d}") [ "ofl" "apache" "ufl" ];
      fontDirs = pkgs: all: pkgs.lib.concatStringsSep ":"
        (map (f: "${f}/share/fonts") (bundledFonts pkgs) ++ pkgs.lib.optionals all (googleFonts pkgs));

      # The whole app as static files: point any web server (or object storage) at it.
      # allFonts: with Google Fonts; fontBudget: megabytes of fonts at most ("" = no limit)
      mkSite = pkgs: allFonts: fontBudget: pkgs.buildNpmPackage {
        pname = "vibesketch-site";
        version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./package.json
            ./package-lock.json
            ./tsconfig.json
            ./vite.config.ts
            ./index.html
            ./public
            ./scripts
            ./src
            ./licenses
            # not needed to build, but part of the source archive the site offers
            ./LICENSE
            ./THIRD-PARTY.md
            ./README.md
            ./flake.nix
            ./flake.lock
            ./test
            ./docs
            ./.github
          ];
        };

        nodejs = pkgs.nodejs_24;
        npmDepsHash = "sha256-lVxCpOcYZg0Gqau5VWuMgkT5Hz1FCVz+3HDAiR2LKM8=";
        env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
        env.VIBESKETCH_FONT_DIRS = fontDirs pkgs allFonts;
        env.VIBESKETCH_FONT_BUDGET_MB = fontBudget;
        nativeBuildInputs = [ pkgs.fontconfig ];

        # fonts go into public/fonts before vite copies public/ into dist/
        preBuild = ''
          node scripts/build-fonts.ts public/fonts
        '';

        # The AGPL entitles everyone who uses a hosted copy to its source: ship it with the site.
        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp -r dist/. $out/
          tar --sort=name --mtime=@1 --owner=0 --group=0 --numeric-owner \
            --exclude=./node_modules --exclude=./dist --exclude=./public/fonts \
            --transform 's,^\.,vibesketch,' -cf - . | gzip -n > $out/vibesketch-source.tar.gz
          runHook postInstall
        '';

        meta.description = "vibesketch as a static website";
        meta.homepage = "https://github.com/avantiris/vibesketch";
        # the bundled typefaces keep their own licences (fonts/LICENSES.txt in the site)
        meta.license = pkgs.lib.licenses.agpl3Plus;
      };

      # `nix run`: serve the static site on localhost (browsers only allow file access and
      # private storage on https or localhost, so opening index.html from disk is not enough).
      mkApp = pkgs: site: pkgs.writeShellApplication {
        name = "vibesketch";
        runtimeInputs = [ pkgs.static-web-server ];
        text = ''
          port="''${PORT:-5173}"
          while [ $# -gt 0 ]; do
            case "$1" in
              --port) port="$2"; shift 2 ;;
              -h|--help) echo "usage: vibesketch [--port N]   (serves the app on http://127.0.0.1:N)"; exit 0 ;;
              *) echo "unknown option: $1" >&2; exit 2 ;;
            esac
          done
          echo "vibesketch on http://127.0.0.1:$port  (Ctrl+C to stop)"
          exec static-web-server --host 127.0.0.1 --port "$port" --root ${site} --log-level warn
        '';
      };
    in {
      packages = forAll (pkgs: rec {
        site = mkSite pkgs true "";
        # for hosts that cap the size of a site (GitHub Pages: 1 GB): the families with the
        # largest files, nearly all of them CJK, are left out until the fonts fit
        site-pages = mkSite pkgs true "900";
        # the same app with 80 well-known families only (170 MB instead of 2.4 GB)
        site-small = mkSite pkgs false "";
        vibesketch = mkApp pkgs site;
        default = vibesketch;
      });

      apps = forAll (pkgs: rec {
        vibesketch = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/vibesketch";
          meta.description = "Serve vibesketch on http://127.0.0.1:5173";
        };
        default = vibesketch;
      });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_24 pkgs.fontconfig ];
          VIBESKETCH_FONT_DIRS = fontDirs pkgs true;
        };
      });
    };
}
