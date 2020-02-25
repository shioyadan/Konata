# Konata

* Konata is an instruction pipeline visualizer for Onikiri2-Kanata/Gem5-O3PipeView formats.
* Pre-built binaries are available from [here](https://github.com/shioyadan/Konata/releases).
* ASPLOS 2018 learning gem5 tutorial presentation is [here](http://learning.gem5.org/tutorial/presentations/vis-o3-gem5.pdf
)

![demo](https://github.com/shioyadan/Konata/wiki/images/konata.gif)


## Installation

Simply extract an archive and launch an executable file (konata.exe or konata).


## Usage

### Basic

1. Generate a trace log from gem5 with the O3 CPU model
    * Execute gem5 with the following flags
    * This example is from http://www.m5sim.org/Visualization
    ```
    $ ./build/ARM/gem5.opt \
        --debug-flags=O3PipeView \
        --debug-start=<first tick of interest> \
        --debug-file=trace.out \
        configs/example/se.py \
        --cpu-type=detailed \
        --caches -c <path to binary> \
        -m <last cycle of interest>
    ```
2. Load a generated "trace.out" to Konata
    * from a menu in a window or using drag&drop
3. If you use ```O3CPUAll``` as well as ```O3PipeView``` as follows, Konata shows more detailed CPU log and visualizes dependency between instructions. 
    ```
    --debug-flags=O3PipeView,O3CPUAll
    ```

### Keyboard

* mouse wheel up, key up: scroll up
* mouse wheel down, key down: scroll down
* ctrl + mouse wheel up, key "+": zoom in
* ctrl + mouse wheel down, key "-": zoom out
* ctrl + f, F3, shift+F3: find a string 
* F1, ctrl+shift+p: open a command palette

### Tips

* If you miss pipelines in a right pane, you can move to pipelines by click "Adjust position" in a right-click menu.
* You can visually compare two traces as follows:
    1. Load two trace files
    2. Right-click and select "Synchronized school" & "Transparent mode"
    3. Right-click and select a color scheme
    4. Move to another tab and adjust a position with the transparent mode
* If you cannot launch Konata, try to install the following runtimes (or try to install the latest Google Chrome, because it uses the same runtimes).
    ```
    sudo apt install \
        libgconf2-4
        libgtk-3-0 \
        libxss1 \
        libgconf2-4 \
        libnss3 \
        libasound2 \
        libX11-xcb1 \
        libcanberra-gtk3-module
    ```
* In ```O3CPUAll``` mode, Konata associates each line in trace.out with each instruction by tracking ```[sn:<serial number>]```. If you output custom log with the above serial information, Konata shows your custom log.


## Development

* Install dependent runtimes as follows or use Dockerfile included in a source tree
    ```
    # Install node.js/npm
    sudo apt install nodejs

    # Install electron/electron-packager
    # Since electron is huge, they are installed globally.
    npm -g install electron
    npm -g install electron-packager

    # Run and build
    make init   # Setup libraries
    make        # Run Konata
    make pack   # Build & pack Konata for Windows/Linux/Mac
    ```

## License

Copyright (C) 2016-2020 Ryota Shioya <shioya@ci.i.u-tokyo.ac.jp>

This application is released under the 3-Clause BSD License, see LICENSE.md.
This application bundles ELECTRON and many third-party packages in accordance with 
the licenses presented in THIRD-PARTY-LICENSES.md.
