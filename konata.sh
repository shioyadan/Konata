#!/bin/sh
if [ -e $(dirname $0)/node_modules ]; then
    npx --prefix $(dirname $0) electron $(dirname $0) $1
else
    echo "'node_modules' does not exit. Please install node.js and type 'node install' in this directory."-
fi 