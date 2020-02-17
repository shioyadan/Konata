let Op = require("./op").Op; // eslint-disable-line

let PAGE_SIZE_BITS = 8;
let PAGE_SIZE = 1 << PAGE_SIZE_BITS;
function idToPageIndex(id){
    return id >> PAGE_SIZE_BITS;
}
function PageIndexToID(pageIndex){
    return pageIndex << PAGE_SIZE_BITS;
}

class OpListPage {
    constructor(headID){

        this.headID = headID;
        
        /** @type {Op[]} */
        this.opList = [];
    }

    getOp(id) {
        let disp = id - this.headID;
        if (disp < 0 || disp >= PAGE_SIZE) {
            console.log(`Out of range id:${id} head:${this.headID}`);
            return null;
        }
        else{
            return this.opList[disp];
        }
    }

    setOp(id, op) {
        let disp = id - this.headID;
        if (disp < 0 || disp >= PAGE_SIZE) {
            console.log(`Out of range id:${id} head:${this.headID}`);
        }
        else{
            this.opList[disp] = op;
        }
    }
}

class OpList {
    constructor(){
        // op 情報
        /** @type {Op[]} */
        this.opList_ = [];

        /** @type {number[]} */
        this.retiredOpID_List_ = [];

        /** @type {OpListPage[]} */
        this.opPages_ = [];

        // 最後にパースが完了した ID
        this.parsedLastID_ = -1;
        this.parsedLastRID_ = -1;

        this.parsingLength_ = 0;
    }

    close(){
        this.opList = [];
        this.opPages_ = [];
        this.retiredOpID_List_ = [];
        this.parsedLastID_ = -1;
        this.parsedLastRID_ = -1;
    }

    /** 
     * @param {number} id
     * @param {Op} op
     */
    setOp(id, op){
        let pageIndex = idToPageIndex(id);
        if (!(pageIndex in this.opPages_)) {
            let pageHead = PageIndexToID(pageIndex);
            this.opPages_[pageIndex] = new OpListPage(pageHead);
        }
        this.opPages_[pageIndex].setOp(id, op);

        if (this.parsingLength_ <= id) {
            this.parsingLength_ = id + 1;
        }
        //this.opList_[id] = op;
    }

    getParsedOp(id){
        if (id <= this.parsedLastID_){
            return this.getParsingOp(id);
        }
        else{
            return null;
        }
    }
    
    getParsingOp(id){
        if (0 <= id && id < this.parsingLength_) {
            //return this.opList_[id];
            let pageIndex = idToPageIndex(id);
            return this.opPages_[pageIndex].getOp(id);
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
            let id = this.retiredOpID_List_[rid];
            return this.getParsedOp(id);
        }
    }

    /** 
     * @param {number} rid
     * @param {Op} op
     * */
    setParsedRetiredOp(rid, op){
        this.retiredOpID_List_[rid] = op.id;
        if (this.parsedLastRID_ < op.rid) {
            this.parsedLastRID_ = op.rid;
        }
    }

    setParsedLastID(id){
        this.parsedLastID_ = id;
    }

    // 現在保持しているリストの長さ
    get parsingLength(){
        return this.parsingLength_;
    }

    get parsedLastID(){
        return this.parsedLastID_;
    }

    get parsedLastRID(){
        return this.parsedLastRID_;
    }
}

module.exports.OpList = OpList;
