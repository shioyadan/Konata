class Konata{
    constructor(){
        this.name = "Konata";
        this.parser_ = null;
        this.FileReader_ = require("./file_reader").FileReader;
        this.OnikiriParser_ = require("./onikiri_parser").OnikiriParser;
    }

    close(){
        if (this.parser_) {
            this.parser_.close();
            this.parser_ = null;

        }
    }

    openFile(path, updateCallback, finishCallback){
        if (this.files != null) {
            this.close();
        }

        let file = new this.FileReader_();
        file.open(path);

        let parser = new this.OnikiriParser_();
        this.parser_ = parser;
        console.log("Open :", path);

        parser.setFile(file, updateCallback, finishCallback);
        console.log("Selected parser:" , parser.getName());
    }

    getOp(id){
        return this.parser_.getOp(id);
    }

    getOpFromRID(rid){
        return this.parser_.getOpFromRID(rid);
    }

    get lastID(){
        return this.parser_.lastID;
    }

    get lastRID(){
        return this.parser_.lastRID;
    }

    get laneMap(){
        return this.parser_.laneMap;
    }

    get stageLevelMap(){
        return this.parser_.stageLevelMap;
    }

}

module.exports.Konata = Konata;
