# Konata

* Konata is an instruction pipeline visualizer for Onikiri2-Kanata/Gem5-O3PipeView formats.
* ASPLOS 2018 learning gem5 tutorial presentation is [here](https://github.com/shioyadan/Konata/wiki/gem5-konata.pdf
)
* The Onikiri2-Kanata format is described in [here](docs/kanata-log-format.md). It can represent a more detailed pipeline behavior than Gem5-O3PipeView.

![demo](https://github.com/shioyadan/Konata/wiki/images/konata.gif)


## Run Konata

### Web application

Open [Konata Web](https://shioyadan.github.io/Konata/), then choose or drop a plain-text,
gzip-compressed, or Zstandard-compressed Kanata/O3PipeView trace. The selected file is parsed
locally in the browser and is not uploaded. The initial screen shows the application version,
commit, and build date.

The Web application is published from the `dev-v100` branch. To build it locally, use the Docker
development environment:

```bash
./docker/launch.sh make init
./docker/launch.sh make production
```

The result is `dist-web/index.html`. It contains the complete application, including the Zstandard
Worker, in one HTML file and can be copied to a static Web server. For development,
`./docker/launch.sh make serve` starts a server at `http://127.0.0.1:8080`.


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

The toolbar provides Open, Search, Bookmark, Stats, View, and zoom controls. In Chromium browsers
that support the File System Access API, Open also lists the five most recently selected files and
can reload the current file. The browser stores only its local file handle and summary metadata in
IndexedDB; it does not store the trace contents or upload them. A restored handle may require read
permission again. When File System Observer is available, an external change shows Reload and
Ignore actions instead of reloading automatically. Files opened by drag and drop or by the fallback
file input do not provide a persistent handle, so these extra actions are disabled.

Application log in
the rightmost menu opens a resizable pane at the bottom of the window for messages that are also
written to the browser console. View changes the theme, pipeline colors, dependency arrows, lane
layout, flushed-op visibility, and the minimum
lane heights used for drawing details. Zoom steps per 2× controls how many input steps double or
halve the view. Custom colors can be edited from the Custom color scheme.

- Drag the canvas to pan. A horizontal trackpad wheel scrolls horizontally.
- Use the mouse wheel or Up/Down keys to follow instructions vertically.
- Use Ctrl/Command+wheel, `+`/`-`, or Ctrl/Command+Up/Down to zoom.
- Double-click to zoom in; Shift+double-click zooms out. A two-pointer pinch also zooms.
- Click an instruction label to align its fetch cycle with the left edge.
- Use Adjust position (the crosshair beside Reset) when the pipeline is outside the viewport.
  Adjust preserves the zoom; Reset restores both the position and zoom.
- Click a tab with the middle mouse button to close it. Ctrl/Command+Tab moves between tabs.

Search opens the command palette with `f ` prefilled. F3 and Shift+F3 move to the next and previous
matches. F1 or Ctrl/Command+Shift+P opens the full palette, which accepts these commands:

```text
j  <op ID>    Jump to an operation ID
jr <RID>      Jump to a retired operation ID
f  <pattern>  Find a regular expression
l             Open the file picker
```

Number keys `0`–`9` go to bookmarks. Ctrl/Command+`0`–`9` stores the current position and zoom in
the corresponding slot. Command history, bookmarks, and view settings are saved in browser storage.

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

Docker is the recommended development environment. The launcher rebuilds its image when the Docker
definition changes, bind-mounts this repository, and runs the given command at the repository root.

```bash
# Install dependencies.
./docker/launch.sh make init

# Run type checks, parser tests, and the production Web smoke test.
./docker/launch.sh make check

# Build or serve the development Web application.
./docker/launch.sh make
./docker/launch.sh make serve

# Build the production single HTML file.
./docker/launch.sh make production

# Measure the current Web OpStore without using large work/ traces.
./docker/launch.sh make benchmark-op-store

# Open an interactive shell in the development container.
./docker/launch.sh
```

All build and test operations are Make targets; npm scripts are not used. The Web smoke test uses
Electron only as a sandboxed Chromium test runner; Electron APIs are not used by the application or
included in `dist-web/index.html`. To work without Docker, install Node.js 22.12 or later and run
the same targets directly:

```bash
make init          # Install dependencies
make               # Build the development Web application
make serve         # Start the Web development server
make production    # Build dist-web/index.html
make check         # Run the complete verification set
```

### GitHub Pages preview

Pushing `dev-v100` runs `.github/workflows/pages.yml`. The workflow installs the locked dependencies
with `npm ci`, invokes the existing Make verification targets, uploads `dist-web`, and deploys it to
GitHub Pages. In the repository settings, Pages must use GitHub Actions and the `github-pages`
environment must allow deployments from `dev-v100`.

## License

Copyright (C) 2016-2026 Ryota Shioya <shioya@ci.i.u-tokyo.ac.jp>

This application is released under the 3-Clause BSD License, see LICENSE.md.
The Web application includes third-party packages under their respective licenses. Electron is a
development-only dependency used to run the Web smoke test and is not included in the application.
