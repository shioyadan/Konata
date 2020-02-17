let Op = require("./op").Op; // eslint-disable-line

class OpList {
    constructor(){
        // op 情報
        /** @type {Op[]} */
        this.opList_ = [];
        /** @type {Op[]} */
        this.retiredOpList_ = [];

        // 最後にパースが完了した ID
        this.parsedLastID_ = -1;
        this.parsedLastRID_ = -1;
    }

    close(){
        this.opList = [];
        this.retiredOpList_ = [];
        this.parsedLastID_ = -1;
        this.parsedLastRID_ = -1;
    }

    /** 
     * @param {number} id
     * @param {Op} op
     */
    setOp(id, op){
        this.opList_[id] = op;
    }

    getParsedOp(id){
        if (id > this.parsedLastID_){
            return null;
        }
        else{
            return this.opList_[id];
        }
    }
    
    getParsingOp(id){
        if (id in this.opList_) {
            return this.opList_[id];
        }
        else {
            return null;
        }
    }

    getParsedOpFromRID(rid){
        if (rid > this.parsedLastRID_){
            return null;
        }
        else{
            return this.retiredOpList_[rid];
        }
    }

    /** 
     * @param {number} rid
     * @param {Op} op
     * */
    setParsedRetiredOp(rid, op){
        this.retiredOpList_[rid] = op;
        if (this.parsedLastRID_ < op.rid) {
            this.parsedLastRID_ = op.rid;
        }
    }

    setParsedLastID(id){
        this.parsedLastID_ = id;
    }

    // 現在保持しているリストの長さ
    get parsingLength(){
        return this.opList_.length;
    }

    get parsedLastID(){
        return this.parsedLastID_;
    }

    get parsedLastRID(){
        return this.parsedLastRID_;
    }
}

module.exports.OpList = OpList;
