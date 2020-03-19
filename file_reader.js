let path = require("path");
let fs = require("fs");
let readline = require("readline");
let zlib = require("zlib");

class FileReader{
    constructor(){
        this.filePath_ = "";
        this.readStream_ = null;
        this.readIF_ = null;
        this.fileSize_ = 0;
        this.complete_ = false;
    }


    /**
     * Open a file
     * @param {string} filePath - a file path
     */
    open(filePath){

        let stat = fs.statSync(filePath);
        if (!stat) {
            throw "Failed to fs.statSync(). There seems to be no file.";
        }
        else{
            this.fileSize_ = stat.size;
        }

        this.filePath_ = filePath;

        // GZip の chunk size と合わせて，少し増やすと２割ぐらい速くなる
        let rs = fs.createReadStream(filePath, {highWaterMark: 1024*64});
        this.readStream_ = rs;  // 読み出し量はファイルサイズ基準なので，こっちをセット

        if (this.getExtension() == ".gz") {
            let gzipRS = rs.pipe(zlib.createGunzip({chunkSize: 1024*32}));
            this.readIF_ = readline.createInterface({"input": gzipRS});
        }
        else {
            this.readIF_ = readline.createInterface({"input": rs});
        }
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

    /**
     * Open a file
     * @param {function(string): void} read - Called when a line is read
     * @param {function(string): void} finish - Called when all lines have been read
     */
    readlines(read, finish){
        this.readIF_.on("line", read);
        this.readIF_.on("close", finish);
    }

    get fileSize(){
        return this.fileSize_;
    }

    get bytesRead(){
        return this.readStream_ ? this.readStream_.bytesRead : 0;
    }

    getExtension(){
        let ext = path.extname(this.filePath_);
        return ext;
    }
}


module.exports.FileReader = FileReader;
