class FileReader{
    constructor(){
        this.path_ = require("path");
        this.filePath_ = "";
        this.readStream_ = null;
        this.readIF_ = null;
        this.fileSize_ = 0;
    }

    open(file_path){

        let fs = require("fs");

        let stat = fs.statSync(file_path);
        if (!stat) {
            throw "Failed to fs.statSync(). There seems to be no file.";
        }
        else{
            this.fileSize_ = stat.size;
        }

        this.filePath_ = file_path;

        //let zlib = require("zlib");
        let rs = fs.createReadStream(file_path);
        this.readStream_ = rs;  // 読み出し量はファイルサイズ基準なので，こっちをセット

        if (this.getExtension(file_path) == ".gz") {
            let zlib = require("zlib");
            rs = rs.pipe(zlib.createGunzip());
        }

        let readline = require("readline");
        this.readIF_ = readline.createInterface(rs, {});

    }

    close(){
        if (this.readIF_){
            this.readIF_.close();
            this.readIF_ = null;
        }
        if (this.readStream_) {
            this.readStream_.destroy();
            this.readStream_ = null;
        }
    }

    getPath(){
        return this.filePath_;
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

    get fileSize(){
        return this.fileSize_;
    }

    get bytesRead(){
        return this.readStream_.bytesRead;
    }

    getText(){
        if (this.text_) {
            return this.text_;
        }
        this.text_ = this.buf_.toString();
        return this.text_;
    }

    getExtension(){
        let ext = this.path_.extname(this.filePath_);
        return ext;
    }
}

module.exports.FileReader = FileReader;
