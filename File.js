class File{
    constructor(path){
        // この辺はnodejsの標準ライブラリらすぃ
        this.fs = require("fs");
        this.zlib = require("zlib");
        this.Path = require("path");

        this.buf = null;
        this.text = null;
        this.path = path;
        this.success = false;

        if (path == null) {
            // error;
            return;
        }

        try {
            if (this.fs.statSync(path)) {
                this.buf = this.fs.readFileSync(path);
                //console.log(this.buf);
                this.success = true;
            }
        } catch(e) {

        }
    }

    GetPath(){
        return this.path;
    }

    IsText(){
        let txts = [".txt",".log",".text"];
        for (let i = 0, len = txts.length; i < len; i++) {
            let ext = txts[i];
            if (this.GetExtension() == ext) {
                console.log("This file is text");
                return true;
            }
        }
        console.log("This file is not text");
        return false;
    }

    Extract(that){
        if (this.IsText()) {
            return;
        }
        console.log("gunzip start");

        return new Promise (function (resolve, reject) {
            this.zlib.gunzip(this.buf, function (err, binary) {
                let string = binary.toString("utf-8");
                //console.log(string);
                console.log("Extract");
                resolve(string, that);
                this.text = string;
            });
        });
    }

    AlloewedExension(){
        return [".txt", ".text", ".log", ".gz"];
    }

    GetText(){
        if (this.text) {
            return this.text;
        }
        this.text = this.buf.toString();
        return this.text;
    }

    GetExtension(){
        let ext = this.Path.extname(this.path);
        return ext;
    }
}

module.exports = File;
