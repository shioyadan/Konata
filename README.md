# Konata

Konata is an instruction pipeline visualizer for Onikiri2-Kanata/Gem5-O3PipeView formats.

Pre-built binaries are available from [here](https://github.com/shioyadan/Konata/releases).

![demo](https://github.com/shioyadan/Konata/wiki/images/konata.gif)


## Installation

Simply extract the archive and launch the executable file (konata.exe or konata).


## Usage

* mouse wheel up, key up: scroll up
* mouse wheel down, key down: scroll down
* ctrl + mouse wheel up, key "+": zoom in
* ctrl + mouse wheel down, key "-": zoom out

## Development

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


## License

Copyright (C) 2016-2019 Ryota Shioya <shioya@ci.i.u-tokyo.ac.jp>

This application is released under the 3-Clause BSD License, see LICENSE.md.
This application bundles ELECTRON and many third-party packages in accordance with 
the licenses presented in THIRD-PARTY-LICENSES.md.
