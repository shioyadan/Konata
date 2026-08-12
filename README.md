# Konata

* Konata is an instruction pipeline visualizer for Onikiri2-Kanata/Gem5-O3PipeView formats.
* Since v1.0.0, Konata is Web-based rather than Electron-based. Use the hosted site or a
  self-contained HTML file, with all trace processing kept local in the browser.
* Nearly all desktop features are retained, with faster, lower-memory processing for larger traces.
* ASPLOS 2018 learning gem5 tutorial presentation is [here](https://github.com/shioyadan/Konata/wiki/gem5-konata.pdf
)
* The Onikiri2-Kanata format is described in [here](docs/kanata-log-format.md). It can represent a more detailed pipeline behavior than Gem5-O3PipeView.

![demo](https://github.com/shioyadan/Konata/wiki/images/konata.gif)


## Run Konata

Open [Konata Web](https://shioyadan.github.io/Konata/), then choose or drop a plain-text,
gzip-compressed, or Zstandard-compressed Kanata/O3PipeView trace. For local use, download the latest
`konata-v*.zip` from [GitHub Releases](https://github.com/shioyadan/Konata/releases), extract it,
and open `index.html` in a browser. In either case, the selected trace is processed locally in the
browser and is not uploaded.


## Usage

### Generate and open a trace

Generate a trace from gem5 with the O3 CPU model. This example is based on the
[gem5 visualization documentation](http://www.m5sim.org/Visualization):

```bash
./build/ARM/gem5.opt \
    --debug-flags=O3PipeView \
    --debug-start=<first tick of interest> \
    --debug-file=trace.out \
    configs/example/se.py \
    --cpu-type=detailed \
    --caches -c <path to binary> \
    -m <last cycle of interest>
```

Open `trace.out` from the Open menu or drag and drop it onto Konata. Using `O3CPUAll` together
with `O3PipeView` adds detailed CPU messages and instruction dependencies:

```text
--debug-flags=O3PipeView,O3CPUAll
```

In `O3CPUAll` mode, Konata associates messages with instructions by tracking
`[sn:<serial number>]`. Custom log messages containing the same serial information are shown with
the corresponding instruction.

### Web controls

- **Open:** Choose one or more traces, or drag and drop them onto the window. In Chromium browsers
  that support the File System Access API, Open also lists the five most recently selected files and
  can reload the current file. The browser stores only file handles and summary metadata in
  IndexedDB; it does not store or upload trace contents. A restored handle may require permission
  again.
- **Reload:** When File System Observer is available, an external change shows Reload and Ignore
  actions instead of reloading automatically. Files opened by drag and drop or by the fallback file
  input do not provide a persistent handle, so these actions are disabled.
- **Search:** Open the command palette with `f ` prefilled. F3 and Shift+F3 move to the next and
  previous matches.
- **Bookmark:** Number keys `0`–`9` go to bookmarks. Ctrl/Command+`0`–`9` stores the current position
  and zoom in the corresponding slot.
- **Stats:** Show statistics for the current trace in a resizable dialog.
- **View:** Change the theme, pipeline colors, dependency arrows, lane layout, flushed-op visibility,
  and minimum lane heights used for drawing details. Custom colors can be edited from the Custom
  color scheme.
- **Zoom:** Change the zoom directly. Zoom steps per 2× controls how many input steps double or halve
  the view.
- **Application log:** Open it from the rightmost menu to show a resizable pane at the bottom of the
  window. The same messages are also written to the browser console.

Canvas and tab controls:

- Drag the canvas to pan. A horizontal trackpad wheel scrolls horizontally.
- Use the mouse wheel or Up/Down keys to follow instructions vertically.
- Use Ctrl/Command+wheel, `+`/`-`, or Ctrl/Command+Up/Down to zoom.
- Double-click to zoom in; Shift+double-click zooms out. A two-pointer pinch also zooms.
- Click an instruction label to align its fetch cycle with the left edge.
- Use Adjust position (the crosshair beside Reset) when the pipeline is outside the viewport.
  Adjust preserves the zoom; Reset restores both the position and zoom.
- Click a tab with the middle mouse button to close it. Ctrl/Command+Tab moves between tabs.

F1 or Ctrl/Command+Shift+P opens the full command palette, which accepts these commands:

```text
j  <op ID>    Jump to an operation ID
jr <RID>      Jump to a retired operation ID
f  <pattern>  Find a regular expression
l             Open the file picker
```

Command history, bookmarks, and view settings are saved in browser storage.

### Trace comparison

Open two traces, activate the tab to use as A, and choose Compare. A comparison tab provides A,
Overlay, and B modes. A and B modes keep the selected trace in its comparison color and show the
other trace as a faint gray reference. Overlay uses complementary colors so matching stages become
neutral and local stage or position differences remain colored. Dragging in A or B mode adjusts
only that trace; Overlay moves both traces together. Align to A adjusts A and aligns B using a
common retired-operation ID when one is available.

### Browser limitations

Recent files, persistent handles, and external-change detection depend on File System Access APIs
currently available in compatible Chromium browsers. Other browsers retain file input and drag and
drop. Remote-server/WSL reload will be considered together with a restricted read-only trace server.
Arbitrary URL or path loading is intentionally disabled.


## Development

Docker is the recommended development environment. Start a shell with the repository mounted at
`/workspace`:

```bash
./docker/launch.sh
```

Run all development operations from that shell:

```bash
make init          # Install dependencies
make               # Build the development Web application
make serve         # Start the Web development server
make production    # Build dist-web/index.html
make check         # Run the complete verification set
make benchmark-op-store
make release-archive
```

All operations are Make targets; npm scripts are not used. `make check` uses Electron only as a
sandboxed Chromium test runner, not as part of the application. Without Docker, install Node.js
22.12 or later and run the same Make targets directly.

### GitHub Pages preview

Pushing `master` runs `.github/workflows/pages.yml`. The workflow installs the locked dependencies
with `npm ci`, invokes the existing Make verification targets, uploads `dist-web`, and deploys it to
GitHub Pages. In the repository settings, Pages must use GitHub Actions and the `github-pages`
environment must allow deployments from `master`.

## Release

`make release-archive` runs the complete verification set and creates a versioned archive from the
version in `package.json`:

```text
dist-release/konata-v1.0.0.zip
└── konata-v1.0.0/
    ├── index.html
    ├── README.md
    └── LICENSE.md
```

After updating the versions in `package.json` and `package-lock.json`, commit and merge the release
to `master`. Create and push a matching annotated tag when that commit is ready to publish:

```bash
git tag -a v1.0.0 -m "Konata v1.0.0"
git push origin v1.0.0
```

The release workflow verifies that the tag matches `package.json` and belongs to `master`, runs
`make release-archive`, and publishes the ZIP as a GitHub Release asset. Its `GITHUB_TOKEN` requires
`contents: write`, as declared in `.github/workflows/release.yml`.

## License

Copyright (C) 2016-2026 Ryota Shioya <shioya@ci.i.u-tokyo.ac.jp>

This application is released under the 3-Clause BSD License, see LICENSE.md.
The Web application includes third-party packages under their respective licenses. Electron is a
development-only dependency used to run the Web smoke test and is not included in the application.
