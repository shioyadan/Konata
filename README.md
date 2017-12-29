# Konata

An instruction pipeline visualizer for Onikiri2-Kanata format

Ryota Shioya
shioya@nuee.nagoya-u.ac.jp


## Development

    # Install electron/electron-packager
    # Since electron is huge, they are installed globally.
    npm -g install electron
    npm -g install electron-packager

    # Run and build
    make init   # Setup libraries
    make        # Run Konata
    make pack   # Build & pack Konata for Windows/Linux/Mac


## License

Copyright (C) 2016-2017 Ryota Shioya
This application is released under the 3-Clause BSD License, see LICENSE.md.

This application bundles ELECTRON and many third-party packages in accordance with 
the licenses presented in THIRD-PARTY-LICENSES.md.
