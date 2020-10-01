#!/bin/sh
if [ -e ./node_modules ]; then
    npx electron . $1
else
    echo "'node_modules' does not exit. Please install node.js and type 'node install' in this directory." 
fi

