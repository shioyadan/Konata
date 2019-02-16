class FileReader{
    constructor(){
        this.path_ = require("path");
        this.filePath_ = "";
        this.readStream_ = null;
        this.readIF_ = null;
        this.fileSize_ = 0;
    }

    /**
     * Open a file
     * @param {string} filePath - a file path
     */
    open(filePath){

        let fs = require("fs");

        let stat = fs.statSync(filePath);
        if (!stat) {
            throw "Failed to fs.statSync(). There seems to be no file.";
        }
        else{
            this.fileSize_ = stat.size;
        }

        this.filePath_ = filePath;

        //let zlib = require("zlib");
        let rs = fs.createReadStream(filePath);
        this.readStream_ = rs;  // 読み出し量はファイルサイズ基準なので，こっちをセット

        if (this.getExtension() == ".gz") {
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

    /**
     * Open a file
     * @param {function} read - Called when a line is read
     * @param {function} finish - Called when all lines have been read
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
        let ext = this.path_.extname(this.filePath_);
        return ext;
    }
}

module.exports.FileReader = FileReader;
