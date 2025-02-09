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

### Annotate pipelines with function names


1. Prepare the input file:

```sh
# Extract used addresses:
cat m5out/trace.out | grep -oe '^O3PipeView:fetch:[0-9]\+:0x[0-9a-f]\+:' | grep -oe '0x[0-9a-f]\+' | uniq | sort | uniq > instructions.log


# Extract address info
addr2line -e <PROGRAM WITH DEBUG INFO> -f -C -i -f -p -a @instructions.log > addrinfo.log

# (Optionally), include source lines too:
awk -f - <<'EOF' addrinfo.log | awk '{ print gensub(/( at )(.*\/)([^/]+)$/, "\\1\\3", "g", $0) }' > addrinfo.withcode.log
    BEGIN { 
        RS="\n"; 
    }
    {
        if (match($0, /^(0x[0-9a-fA-F]+:)(.*) at ([^ ]+):([0-9]+)$/, arr)) {
            line=strtonum(arr[4])
            codeline=false
            if (line>0) {
                file=arr[3];
                file=gensub(/\/rustc\/1e9b0177da38e3f421a3b9b1942f1777d166e06a\//, "/home/sarunas/.rustup/toolchains/nightly-x86_64-unknown-linux-gnu/lib/rustlib/src/rust/", "g", file);
                if (linecache[file":"line]) {
                    codeline = linecache[file":"line];
                } else {
                    "sed -n '"line"p' "file | getline codeline;
                    gsub(/^[ \t]+|[ \t]+$/, "", codeline);
                    linecache[file":"line] = codeline;
                }
                print arr[1] " " codeline " @ " arr[2]
                print arr[2] " at " arr[3] ":" arr[4]
            } else {
                print $0
            }
        } else {
            print $0
        }
    }
EOF

# Annotate the trace file
awk -f - <<'EOF' addrinfo.log m5out/trace.out > processed.trace.out
    BEGIN { 
        RS="\n"; 
        F=0;
    }
    F==0 {
        if (match($0, /^(0x[0-9a-fA-F]+):(.*)$/, arr)) {
            k=strtonum(arr[1]);
            addrs[k]=arr[2];
        } else {
            addrs[k]=addrs[k] "\n" $0
        }
    }
    NR>1 && FNR==1 { 
        RS="\n"; 
        FS=":";
        F=1;
    }
    F==1 && $1=="O3PipeView" && $2=="fetch" {
        print "<ADDRESSINFO>\n"addrs[strtonum($4)]"\n</ADDRESSINFO>";
        print $0;
        next;
    }
    F==1 {
        print $0;
    }
EOF
```


2. Load the processed trace in Konata

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
