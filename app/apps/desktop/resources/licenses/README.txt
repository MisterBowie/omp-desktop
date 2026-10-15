OMP Desktop source and notices

The inherited PI-Desktop license and original copyright statements are retained
verbatim. OMP's top-level and native THIRD-PARTY-NOTICES files are byte-identical
in the pinned source; OMP-THIRD-PARTY-NOTICES.txt preserves their common content.
Bun-LICENSE.md is the exact upstream overview for the embedded Bun 1.4.2 runtime.
Electron's own license and Chromium notices remain in the Electron distribution.
The dependencies subdirectory preserves published dependency notices, including
build dependencies; inventory.json maps each original file to exact byte offsets.

Corresponding product source: https://github.com/MisterBowie/omp-desktop
Use the revision from this release's BUILD-RECORD.json (or its stage tag), not
an unpinned default branch. GitHub also offers source archives for that tag.

  git clone https://github.com/MisterBowie/omp-desktop.git
  cd omp-desktop
  git checkout <revision from BUILD-RECORD.json>
  git submodule update --init --recursive

The root README, app/README.md and app/patches/oh-my-pi/manifest.json describe the
build entry points and controlled OMP source. The fork, base commit, patch,
runtime version and toolchains are pinned there and in packaged provenance.json.
SOURCES.json records original notice locations and SHA256 digests. See the
pinned Bun overview for its JavaScriptCore/WebKit source and relinking steps.
Product-specific names and artwork do not replace any inherited license.
