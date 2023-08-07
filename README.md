# Konata

* Konata is an instruction pipeline visualizer for Onikiri2-Kanata/Gem5-O3PipeView formats.
* ASPLOS 2018 learning gem5 tutorial presentation is [here](https://github.com/shioyadan/Konata/wiki/gem5-konata.pdf
)
* The Onikiri2-Kanata format is described in [here](docs/kanata-log-format.md). It can represent a more detailed pipeline behavior than Gem5-O3PipeView.

![demo](https://github.com/shioyadan/Konata/wiki/images/konata.gif)


## Installation

There are two ways to launch Konata.
If you fail to launch a pre-built binary, please try the second way.

1. Extract an archive and launch an executable file (konata.exe or konata).
    * Pre-built binaries are available from [here](https://github.com/shioyadan/Konata/releases).
2. Launch from this repository.
    1. Install node.js from https://nodejs.org
    2. Clone this repository.
    3. Launch install.bat (Windows) or install.sh (Linux/MacOS).
    4. Launch Konata from konata.vbs (Windows) or konata.sh (Linux/MacOS).


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
* ctrl + mouse wheel up, key "+", ctrl+key up: zoom in
* ctrl + mouse wheel down, key "-", ctrl+key down: zoom out
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
        libgconf-2-4 \
        libgtk-3-0 \
        libxss1 \
        libnss3 \
        libasound2 \
        libx11-xcb1 \
        libcanberra-gtk3-module \
        libgbm-dev
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

Copyright (C) 2016-2022 Ryota Shioya <shioya@ci.i.u-tokyo.ac.jp>

This application is released under the 3-Clause BSD License, see LICENSE.md.
This application bundles ELECTRON and many third-party packages in accordance with 
the licenses presented in THIRD-PARTY-LICENSES.md.
