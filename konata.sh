#!/bin/sh
if [ -e $(dirname $0)/node_modules/electron/dist/electron ]; then
    # It directly uses an Electron binary instead npx because 
    # the current directory must not be changed so that $1 works.  
    $(dirname $0)/node_modules/electron/dist/electron $(dirname $0) $1
else
    echo "'node_modules' does not exit. Please install node.js and type 'node install' in this directory."-
fi 
