class FileReader{
    constructor(file_path){

        this.path_ = require("path");


        this.file_path_ = file_path;

        //let zlib = require("zlib");
        let fs = require("fs");
        let rs = fs.createReadStream(file_path);
        let readline = require("readline");
        this.readIF_ = readline.createInterface(rs, {});
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

    alloewedExension(){
        return [".txt", ".text", ".log", ".gz"];
    }

    readlines(read, finish){
        this.readIF_.on("line", read);
        this.readIF_.on("close", finish);
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
