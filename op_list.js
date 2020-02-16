let Op = require("./op").Op; // eslint-disable-line

class OpList {
    constructor(){
        // op 情報
        /** @type {Op[]} */
        this.opList_ = [];
        /** @type {Op[]} */
        this.retiredOpList_ = [];

        // 最後にパースが完了した ID
        this.lastID_ = -1;
        this.lastRID_ = -1;
    }

    close(){
        this.opList = [];
        this.retiredOpList_ = [];
        this.lastID_ = -1;
        this.lastRID_ = -1;
    }

    /** 
     * @param {number} id
     * @param {Op} op
     */
    setOp(id, op){
        this.opList_[id] = op;
    }

    getOp(id){
        if (id > this.lastID_){
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

    getOpFromRID(rid){
        if (rid > this.lastRID_){
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
    setRetiredOp(rid, op){
        this.retiredOpList_[rid] = op;
        if (this.lastRID_ < op.rid) {
            this.lastRID_ = op.rid;
        }
    }

    // 現在保持しているリストの長さ
    get length(){
        return this.opList_.length;
    }

    get lastID(){
        return this.lastID_;
    }

    set lastID(id){
        this.lastID_ = id;
    }

    get lastRID(){
        return this.lastRID_;
    }

    set lastRID(rid){
        this.lastRID_ = rid;
    }
}

module.exports.OpList = OpList;
