# Konata

* Konata is an instruction pipeline visualizer for traces in the Onikiri2-Kanata and gem5
  O3PipeView formats.
* Starting with v1.0.0, Konata runs in the browser instead of as an Electron desktop application.
  Open [Konata Web](https://shioyadan.github.io/Konata/) or download the self-contained HTML release
  from [GitHub Releases](https://github.com/shioyadan/Konata/releases). All trace processing remains
  local to the browser. Konata makes no background network requests, and trace data never leaves
  the browser.
* Nearly all features from the desktop version are retained. Faster processing and lower memory use
  make it possible to open larger traces.
* The [ASPLOS 2018 gem5 tutorial presentation](https://github.com/shioyadan/Konata/wiki/gem5-konata.pdf)
  provides an introduction to Konata.
* The [Onikiri2-Kanata format](docs/kanata-log-format.md) represents pipeline behavior in greater
  detail than the gem5 O3PipeView format.

![demo](https://github.com/shioyadan/Konata/wiki/images/konata.gif)


## Run Konata

Open [Konata Web](https://shioyadan.github.io/Konata/), then select or drag and drop a plain-text,
gzip-compressed, or Zstandard-compressed Kanata/O3PipeView trace. To run Konata locally, download
the latest `konata-v*.zip` from [GitHub Releases](https://github.com/shioyadan/Konata/releases),
extract it, and open `index.html` in a browser. Konata processes the trace entirely in the browser
and never uploads it.


## Usage

### Generate and open a trace

Generate an O3PipeView trace with the gem5 O3 CPU model. This example follows the
[gem5 O3 Pipeline Viewer documentation](https://www.gem5.org/documentation/general_docs/cpu_models/visualization/):

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

Open `trace.out` using the Open menu or drag and drop it onto Konata. Enabling `O3CPUAll` alongside
`O3PipeView` adds detailed CPU messages and instruction dependencies:

```text
--debug-flags=O3PipeView,O3CPUAll
```

With `O3CPUAll` enabled, Konata associates messages with instructions using
`[sn:<serial number>]`. Custom log messages with the same serial number are shown with the
corresponding instruction.

### Web controls

- **Open:** Choose one or more traces, or drag and drop them onto the window.
- **Recent and Reload:** Reopen a recent trace or reload the current trace after its source file
  changes. If a change notice appears, choose Reload or Ignore.
- **Search:** Search the current trace with a regular expression. F3 and Shift+F3 move to the next
  and previous matches.
- **Bookmark:** Press `0`–`9` to go to a bookmark. Press Ctrl/Command+`0`–`9` to save the current
  position and zoom in that slot.
- **Stats:** Show statistics for the current trace in a resizable dialog.
- **View:** Change the theme, pipeline colors, dependency arrows, lane layout, flushed-op visibility,
  and minimum lane heights used for drawing details. Custom colors can be edited from the Custom
  color scheme.
- **Zoom:** Change the zoom level. Zoom steps per 2× sets how many steps double or halve the view.
- **Application log:** Review parser warnings and other messages in a resizable pane at the bottom
  of the window.

Canvas and tab controls:

- Drag the canvas to pan. Use a horizontal trackpad gesture to scroll horizontally.
- Use the mouse wheel or Up/Down keys to move through instructions vertically.
- Use Ctrl/Command+wheel, `+`/`-`, or Ctrl/Command+Up/Down to zoom.
- Double-click to zoom in. Shift+double-click to zoom out. Pinch with two pointers to zoom.
- Click an instruction label to align its fetch cycle with the left edge.
- Use Adjust position (the crosshair beside Reset) when the pipeline is outside the viewport.
  Adjust position preserves the zoom. Reset restores both the position and zoom.
- Middle-click a tab to close it. Ctrl/Command+Tab moves between tabs.

F1 or Ctrl/Command+Shift+P opens the full command palette, which accepts these commands:

```text
j  <op ID>    Jump to an operation ID
jr <RID>      Jump to a retired operation ID
f  <pattern>  Find a regular expression
l             Open the file picker
```

Command palette history, bookmarks, and view settings are saved between browser sessions.

### Trace comparison

Open two traces, select the tab to use as A, and choose Compare. Use A or B to inspect one trace with
the other as a faint reference. Use Overlay to highlight differences. Dragging in A or B mode moves
only that trace. Overlay mode moves both traces together. Align to A aligns them using a shared
retired-operation ID when available.

### Browser limitations

Recent files, reload, and external-change detection require File System Access APIs supported by
compatible Chromium-based browsers. Other browsers still support file selection and drag and drop.
Support for reloading traces from remote servers or WSL may be added in the future with a restricted
read-only trace server. Loading arbitrary URLs or paths is intentionally disabled.


## Development

Docker is the recommended development environment. Start a shell with the repository mounted at
`/workspace`:

```bash
./docker/launch.sh
```

Run development commands from that shell:

```bash
make init          # Install dependencies
make               # Build the development Web application
make serve         # Start the Web development server
make production    # Build dist-web/index.html
make check         # Run the complete verification set
make benchmark-op-store
```

All build and test operations are Make targets. npm scripts are not used. `make check` uses Electron
only to run the Web smoke test in sandboxed Chromium. Electron is not part of the application. To
work without Docker, install Node.js 22.12 or later and run the same Make targets directly.

See [Deployment and release](docs/releasing.md) for deployment to GitHub Pages and release
procedures.

## License

Copyright (C) 2016-2026 Ryota Shioya <shioya@ci.i.u-tokyo.ac.jp>

Konata is released under the BSD 3-Clause License. See [LICENSE.md](LICENSE.md).
The Web application includes third-party packages under their respective licenses. Electron is a
development-only dependency used to run the Web smoke test. It is not included in the application.
