class FileReader{
    constructor(file_path){

        this.fs_ = require("fs");
        this.zlib_ = require("zlib");
        this.path_ = require("path");

        this.buf_ = null;
        this.text_ = null;
        this.file_path_ = file_path;
        this.success_ = false;

        if (file_path == null) {
            // error;
            return;
        }

        try {
            if (this.fs_.statSync(file_path)) {
                this.buf_ = this.fs_.readFileSync(file_path);
                //console.log(this.buf);
                this.success_ = true;
            }
        } catch(e) {

        }
    }

    getPath(){
        return this.file_path_;
    }

    isText(){
        let txts = [".txt",".log",".text"];
        for (let i = 0, len = txts.length; i < len; i++) {
            let ext = txts[i];
            if (this.getExtension() == ext) {
                console.log("This file is text");
                return true;
            }
        }
        console.log("This file is not text");
        return false;
    }

    extract(that){
        if (this.isText()) {
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

    alloewedExension(){
        return [".txt", ".text", ".log", ".gz"];
    }

    getText(){
        if (this.text_) {
            return this.text_;
        }
        this.text_ = this.buf_.toString();
        return this.text_;
    }

    getExtension(){
        let ext = this.path_.extname(this.file_path_);
        return ext;
    }
}

module.exports.FileReader = FileReader;
