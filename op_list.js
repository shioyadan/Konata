// 全体の構造
// OpList:                      BigKeyValueStore を使って id->op のマップを実装
//   BigKeyValueStore           キャッシュとページレベルでの圧縮をサポートしたマップ
//     OpCache                  キャッシュ
//       LinkedListMap          LRU のための linked list
//         LinkedListMapNode
//     OpPageStore              ページレベルでの圧縮
//       OpListPage

let Op = require("./op").Op; // eslint-disable-line
let zlib = require("zlib"); 

class BigKeyValueStoreConfigLarge {
    constructor() {
        this.PAGE_SIZE_BITS_MAP = [13, 10, 10, 10, 10];     // 圧縮して持つページのサイズ（2の累乗）
        this.PAGE_LEVEL_MAP = [1, 8, 8*8, 8*8*8, 8*8*8*8];  // ページレベルごとの間引いて保持する命令の単位（2の累乗）
        // 展開済みページの最大数
        // Op はおおよそ１つで 1KB を消費するが，圧縮すると 1/10 になる
        // PAGE_SIZE * MAX_DECOMPRESSED_PAGES * PAGE_LEVEL_NUM * 1KB ぐらいのメモリが非圧縮で保持される
        this.MAX_DECOMPRESSED_PAGES = 4;
        this.CACHE_SIZE = 1024*8;   // キャッシュ最大量
    }
}

class BigKeyValueStoreConfigDefault {
    constructor() {
        this.PAGE_SIZE_BITS_MAP = [8, 8, 8, 8, 8];          // 圧縮して持つページのサイズ
        this.PAGE_LEVEL_MAP = [1, 8, 8*8, 8*8*8, 8*8*8*8];  // ページレベルごとの間引いて保持する命令の単位
        this.MAX_DECOMPRESSED_PAGES = 4;
        this.CACHE_SIZE = 1024*32;   // キャッシュ最大量
    }
}

class BigKeyValueStoreConfigTest {  // テスト用
    constructor() {
        this.PAGE_SIZE_BITS_MAP = [8];          // 圧縮して持つページのサイズ
        this.PAGE_LEVEL_MAP = [1];  // ページレベルごとの間引いて保持する命令の単位
        this.MAX_DECOMPRESSED_PAGES = 4;
        this.CACHE_SIZE = 16;   // キャッシュ最大量
    }
}



class LinkedListMapNode {
    constructor() {
        this.id = -1;
        /** @type {Op} */
        this.op = null;

        /** @type {LinkedListMapNode} */
        this.next = null;

        /** @type {LinkedListMapNode} */
        this.prev = null;
    }
}

class LinkedListMap {
    constructor() {
        this.size_ = 0;
        /** @type {Object<number, LinkedListMapNode>} */
        this.map_ = {};

        /** @type {LinkedListMapNode} */
        this.head_ = new LinkedListMapNode();

        /** @type {LinkedListMapNode} */
        this.tail_ = new LinkedListMapNode();

        this.head_.next = this.tail_;
        this.tail_.prev = this.head_;
    }

    /**
     * @param {number} id 
     */
    has(id) {
        return id in this.map_;
    }

    /**
     * @param {number} id 
     * @param {Op} op
     */
    set(id, op) {

        if (id in this.map_) {
            this.map_[id].op = op;
            this.moveToBack(id);
            return;
        }

        let node = new LinkedListMapNode();
        node.id = id;
        node.op = op;
        this.map_[id] = node;

        let tail = this.tail_.prev;
        tail.next = node;
        node.prev = tail;
        node.next = this.tail_;
        this.tail_.prev = node;

        this.size_++;

        // if (this.size_ != Object.keys(this.map_).length) {
        //     let i = 0;
        // }
    }

    /**
     * @param {number} id 
     */
    get(id) {
        return this.map_[id].op;
    }

    /**
     * @param {number} id 
     */
    delete(id) {

        if (id in this.map_ && id != -1) {
            let node = this.map_[id];
            node.prev.next = node.next;
            node.next.prev = node.prev;
            
            node.op = null;
            node.prev = null;
            node.next = null;

            delete this.map_[id];
            this.size_--;
        }
    }

    moveToBack(id) {
        if (id in this.map_) {
            let node = this.map_[id];
            node.prev.next = node.next;
            node.next.prev = node.prev;

            let tail = this.tail_.prev;
            tail.next = node;
            node.prev = tail;
            node.next = this.tail_;
            this.tail_.prev = node;
        }
    }

    deleteHead() {
        let head = this.head_.next;
        if (head.id != -1) {
            this.delete(head.id);
        }
    }

    get size() {
        return this.size_;
    }
}

class OpCache {
    /**
     * @param {number} size
     */
    constructor(size) {
        this.size_ = size;

        // Stats
        this.numAccess_ = 0;
        this.numHit_ = 0;

        // /** @type {Map<number, Op>} */
        /** @type {LinkedListMap} */
        this.cache_ = new LinkedListMap();

    }

    /** 
     * @param {number} id
     * @param {Op} op
     */
     cacheWrite(id, op) {
        this.cache_.set(id, op);
        if (this.cache_.size > this.size_) {
            this.cache_.deleteHead();
        }
    }

    /** 
     * @param {number} id
     * @param {number} resolutionLevel
     * @return {Op}
     */
     cacheRead(id, resolutionLevel) {
        this.numAccess_++;
        if (this.numAccess_ > 10000) {
            // console.log(`${this.name_}, cache hit rate:${this.numHit_  /  this.numAccess_}, resolutionLevel:${resolutionLevel}`)
            this.numAccess_ = 0;
            this.numHit_ = 0;
        }

        if (this.cache_.has(id)) {
            this.numHit_++;
            let op = this.cache_.get(id);
            // Update replacement
            this.cache_.moveToBack(id);
            return op;
        }
        else {
            return null;
        }
    }

    invalidate(id) {
        if (this.cache_.has(id)) {
            this.cache_.delete(id);
            return true;
        }
        else{
            return false;
        }
       
    }
}

class OpListPage {
    idToPageIndex(id){
        return id >> this.pageSizeBits_;
    }
    pageIndexToID(pageIndex){
        return pageIndex << this.pageSizeBits_;
    }

    /**
     * @param {number} headID 
     * @param {number} pageSizeBits 
     * @param {number} pageSize 
     */
    constructor(headID, pageSizeBits, pageSize){

        this.pageSizeBits_ = pageSizeBits;
        this.pageSize_ = pageSize;

        this.headID_ = headID;
        
        /** @type {Op[]} */
        this.opList_ = [];

        /** @type {Buffer} */
        this.compressedData_ = null;

        // 非圧縮データが存在するかどうか
        this.decompressedDataExists_ = true;
        this.isCompressing_ = false;

        this.compressingTaskID = -1;
        this.nextTaskID = 0;

        this.dirty_ = false;

        // this.compressible_ = false;  // 圧縮可能か？
    }

    /**
     * @param {number} id 
     * @returns {Op}
     */
    getOp(id) {
        let disp = id - this.headID_;
        if (disp < 0 || disp >= this.pageSize_) {
            console.log(`Error: Out of range id:${id} head:${this.headID_}`);
            return null;
        }
        else{
            if (!this.decompressedDataExists_) {
                this.decompress();
            }
            return this.opList_[disp];
        }
    }

    /**
     * @param {number} id 
     * @param {Op} op 
     */
    setOp(id, op) {
        let disp = id - this.headID_;
        if (disp < 0 || disp >= this.pageSize_) {
            console.log(`Error: Out of range id:${id} head:${this.headID_}`);
        }
        else{
            this.decompress();  // 圧縮中の場合，内部で必要に応じて圧縮中止の処理をしている
            this.opList_[disp] = op;
            this.dirty_ = true;
        }

        if (this.isCompressing_) {
            console.log("Error: Compressing data is updated");
        }
    }

    compress_(){
        if (!this.compressedData_ || this.dirty_) {
            //console.log(`compress: ${this.headID_}`);
            // this.markedCompressed_ = true;
            this.isCompressing_ = true;

            let taskID = this.nextTaskID;
            this.nextTaskID++;
            this.compressingTaskID = taskID;
            
            let json = JSON.stringify(this.opList_);
            // 圧縮は非同期で行われ，その間は OpList は解放されない
            zlib.gzip(json, (error, data) => {
                if (taskID == this.compressingTaskID) {
                    this.compressedData_ = data;
                    this.opList_ = [];
                    this.decompressedDataExists_ = false;
                    this.isCompressing_ = false;
                    this.dirty_ = false;
                }
            });
        }
    }

    decompress(){
        if (this.isCompressing_) {
            // 中止
            this.compressingTaskID = -1;    // タスク ID を無効にすることで，圧縮が完了した際の結果を破棄するようにする
            this.isCompressing_ = false;
            if (!this.decompressedDataExists_) {
                console.log("Error: Decompressed data does not exist while compressing.");
            }
        }
        else {
            if (!this.decompressedDataExists_) {
                //console.log(`decompress: ${this.headID_}`);
                let json = zlib.gunzipSync(this.compressedData_).toString();
                this.opList_ = JSON.parse(json);
                this.decompressedDataExists_ = true;
                this.dirty_ = false;
                // op にロードしないとプロパティが使えない
                /*
                for (let i = 0; i < this.opList_.length; i++) {
                    let op = new Op();
                    op.load(this.opList_[i]);
                    this.opList_[i] = op;
                }*/
            }
        }
    }

    purgeDecompressedData(){
        if (!this.compressedData_ || this.dirty_) {
            this.compress_();
        }
        else if (!this.isCompressing_){
            // 非 dirty で既に圧縮済み，圧縮中でないなら即時パージ
            this.opList_ = [];
            this.decompressedDataExists_ = false;
        }
        //console.log(`purge: ${this.headID_}`);
    }

    get isCompressed(){
        return !this.decompressedDataExists_;
    }
}

class OpPageStore {
    /**
     * @param {string} name 
     * @param {number} pageSizeBits 
     * @param {number} pageSize 
     * @param {number} maxDecompressedPages
     */
     constructor(name, pageSizeBits, pageSize, maxDecompressedPages) {
        this.pageSizeBits_ = pageSizeBits;
        this.pageSize_ = pageSize;
        this.maxDecompressedPages_ = maxDecompressedPages;

        this.name_ = name;

        /** @type {OpListPage[]} */
        this.opPages_ = [];

        // LRU 置き換えで非圧縮ページを管理
        // this.decompressedPageList_ = [];
        /** @type {Set<number>} */
        this.decompressedPageSet_ = new Set();

        // Stats
        this.numPageDecompress_ = 0;
    }

    idToPageIndex(id){
        return id >> this.pageSizeBits_;
    }
    pageIndexToID(pageIndex){
        return pageIndex << this.pageSizeBits_;
    }
    
    close(){
        this.opPages_ = [];
        this.decompressedPageSet_ = new Set();
    }

    /** 
     * @param {number} id
     * @param {Op} op
     */
    set(id, op){
        if (id < 0) {
            return;
        }

        let pageIndex = this.idToPageIndex(id);
        if (pageIndex >= this.opPages_.length) {
            let curPageIndex = this.opPages_.length;
            let endPageIndex = pageIndex;
            while (curPageIndex <= endPageIndex) {
                let page = new OpListPage(this.pageIndexToID(curPageIndex), this.pageSizeBits_, this.pageSize_);
                this.opPages_[curPageIndex] = page;
                this.updateReplacement_(curPageIndex, true);
                curPageIndex++;
                // console.log(`id:${id}, page:${pageIndex}`)
            }
        }
        this.updateReplacement_(pageIndex, false);
        this.opPages_[pageIndex].setOp(id, op);
    }

    /**
     * @param {number} id 
     * @param {number} resolutionLevel 
     */
     get(id, resolutionLevel=0){
        if (id < 0) {
            return null;
        }

        let pageIndex = this.idToPageIndex(id);
        if (pageIndex >= this.opPages_.length) {
            return null;
        }

        let page = this.opPages_[pageIndex];
        if (!page) {
            return null;
        }
        this.updateReplacement_(pageIndex, false);
        let op = page.getOp(id);

        return op;
    }
    getPage_(pageIndex) {
        if (pageIndex >= this.opPages_.length) {
            return null;
        }
        return this.opPages_[pageIndex];
    }

    // タッチしたときに呼ばれる
    updateReplacement_(pageIndex, initialTouch){
        let page = this.getPage_(pageIndex);
        if (!page) {
            return;
        }

        if (page.isCompressed || initialTouch) {
            if (page.isCompressed) {
                page.decompress();
                this.numPageDecompress_++;
            }
            this.decompressedPageSet_.add(pageIndex);
            if (this.decompressedPageSet_.size > this.maxDecompressedPages_) {
                let compress = this.decompressedPageSet_.keys().next().value;
                this.decompressedPageSet_.delete(compress);
                let target = this.opPages_[compress];
                target.purgeDecompressedData();
            }
        }
        else if (!page.isCompressed) {
            // LRU
            this.decompressedPageSet_.delete(pageIndex);
            this.decompressedPageSet_.add(pageIndex);
        }
    }
}

class BigKeyValueStore {
    /**
     * @param {BigKeyValueStoreConfigDefault|BigKeyValueStoreConfigLarge|BigKeyValueStoreConfigTest} config 
     */
    constructor(config) {
        this.config_ = config;

        /** @type {OpPageStore[]} */
        this.page_ = [];

        /** @type {OpCache} */
        this.cache_ = null;

        this.setup_();

        this.numAccess_ = 0;
        this.numHit_ = 0;
    }

    setup_() {
        this.page_ = [];
        let PAGE_LEVEL_NUM = this.config_.PAGE_LEVEL_MAP.length;
        let PAGE_SIZE_MAP = this.config_.PAGE_SIZE_BITS_MAP.map((bits)=>{return 1<<bits});
        for (let i = 0; i < PAGE_LEVEL_NUM; i++) {
            this.page_.push(new OpPageStore(`lv${i}`, this.config_.PAGE_SIZE_BITS_MAP[i], PAGE_SIZE_MAP[i], this.config_.MAX_DECOMPRESSED_PAGES));
        }

        this.cache_ = new OpCache(this.config_.CACHE_SIZE);
    }

    close(){
        this.page_.map((page, level) => {page.close()});
        this.setup_();
    }

    invalidateCache_(id) {
        this.cache_.invalidate(id);
    }

    /** 
     * @param {number} id
     * @param {Op} op
     */
    set(id, op){
        if (id < 0) {
            return;
        }

        this.invalidateCache_(id);
        this.page_.map((page, level) => {
            if (id % this.config_.PAGE_LEVEL_MAP[level] == 0) {
                let blockID = Math.floor(id / this.config_.PAGE_LEVEL_MAP[level]);
                page.set(blockID, op)
            }
        });
    }

    /** 
     * @param {number} id
     * @param {Op} op
     */
    cacheWrite_(id, op) {
        this.cache_.cacheWrite(id, op);
    }

    /** 
     * @param {number} id
     * @param {number} resolutionLevel
     * @return {Op}
     */
    cacheRead_(id, resolutionLevel) {
        this.numAccess_++;
        if (this.numAccess_ > 10000) {
            // console.log(`${"lv-all"}, cache hit rate:${this.numHit_  /  this.numAccess_}, resolutionLevel:${resolutionLevel}`);
            this.numAccess_ = 0;
            this.numHit_ = 0;
        }

        let op = this.cache_.cacheRead(id, resolutionLevel);
        if (op) {
            this.numHit_++;
            return op;
        }
        return null;
    }

    /**
     * @param {number} id 
     * @param {number} resolutionLevel 
     * @param {boolean} updateCache
     */
     get(id, resolutionLevel=0, updateCache){
        if (id < 0) {
            return null;
        }

        if (resolutionLevel < 0) {
            resolutionLevel=resolutionLevel;
        }

        // 縮小表示時は id を丸めることでキャッシュの汚染を減らす
        resolutionLevel = Math.floor(resolutionLevel);
        if (resolutionLevel >= 1) {
            id -= id & ((2 << resolutionLevel) - 1);
        }

        let cachedOp = this.cacheRead_(id, resolutionLevel);
        if (cachedOp) {
            return cachedOp;
        }

        // let op = this.page_.get(id, resolutionLevel);
        let op = null;
        let PAGE_LEVEL_NUM = this.config_.PAGE_LEVEL_MAP.length;
        for (let i = PAGE_LEVEL_NUM - 1; i >= 0; i--) {
            if (id % this.config_.PAGE_LEVEL_MAP[i] == 0) {
                let blockID = Math.floor(id / this.config_.PAGE_LEVEL_MAP[i]);
                op = this.page_[i].get(blockID);
                break;
            }
        }

        // if (op && updateCache) {
        if (updateCache) {
            this.cacheWrite_(id, op);
        }
        return op;
    }

}


class RawKeyValueStore {
    /**
     * @param {BigKeyValueStoreConfigDefault|BigKeyValueStoreConfigLarge|BigKeyValueStoreConfigTest} config 
     */
    constructor(config) {
        this.store_ = [];
    }

    close(){
        this.store_ = [];
    }

    /** 
     * @param {number} id
     * @param {Op} op
     */
    set(id, op){
        if (id < 0) {
            return;
        }
        this.store_[id] = op;
    }

    /**
     * @param {number} id 
     * @param {number} resolutionLevel 
     * @param {boolean} updateCache
     */
     get(id, resolutionLevel=0, updateCache=false){
        if (id < 0) {
            return null;
        }
        // BigKeyValueStore とあわせる
        if (resolutionLevel < 0) {
            resolutionLevel=resolutionLevel;
        }
        resolutionLevel = Math.floor(resolutionLevel);
        if (resolutionLevel >= 1) {
            id -= id & ((2 << resolutionLevel) - 1);
        }
        return this.store_[id];
    }

}



// パース完了した op を保持する
// OpList から取得した op は複製なため，update で再設定しないと反映されない
class OpList {
    constructor(){

        /** @type {number[]} */
        this.retiredOpID_List_ = [];

        // 最後にパースが完了した ID
        this.parsedLastID_ = -1;
        this.parsedLastRID_ = -1;

        // 実際のストア
        // let config = new BigKeyValueStoreConfigSmall();
        let config = new BigKeyValueStoreConfigDefault();

        /** @type {BigKeyValueStore|RawKeyValueStore} */
        this.store = new BigKeyValueStore(config);
    }

    // このメソッドを呼ぶとデータはクリアされるので注意
    setCompressionLevel(level) {
        let config = null;
        if (level <= 0) {
            this.store = new RawKeyValueStore(config);
        }
        else {
            config = new BigKeyValueStoreConfigDefault();
            this.store = new BigKeyValueStore(config);
        }
    }

    close(){
        this.retiredOpID_List_ = [];
        this.parsedLastID_ = -1;
        this.parsedLastRID_ = -1;

        this.store.close();
    }

    /** 
     * @param {number} id
     * @param {Op} op
     */
    setOp(id, op){
        this.store.set(id, op);
    }

    /**
     * パースが終わって表示可能な op を返す
     * このメソッドから得た op を書き換えた場合は変更の反映は保証されない
     * @param {number} id 
     * @param {number} resolutionLevel 
     */
    getParsedOp(id, resolutionLevel=0){
        if (id <= this.parsedLastID_){
            return this.store.get(id, resolutionLevel, true);
        }
        else{
            return null;
        }
    }

    /**
     * @param {number} rid 
     * @param {number} resolutionLevel 
     */
    getParsedOpFromRID(rid, resolutionLevel){
        if (rid > this.parsedLastRID_){
            return null;
        }
        else{
            let id = this.retiredOpID_List_[rid];
            return this.getParsedOp(id, resolutionLevel);
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

    // このメソッドを呼ばれた後は基本的に op は書き換わらないものとして扱われる
    setParsedLastID(id){
        this.parsedLastID_ = id;
    }

    get parsedLastID(){
        return this.parsedLastID_;
    }

    get parsedLastRID(){
        return this.parsedLastRID_;
    }
}

// パース中の Op を保持するバッファ
// ParsingOpList から取得された op は本体への参照であり，そのまま書き換え可能
class ParsingOpList {
    constructor(){

        // 最後にパースが完了した ID
        this.parsingLastID_ = -1;

        /** @type {Object<number, Op>} */
        this.parsingOpList_ = {};
    }

    close(){
        this.parsingOpList_ = {};
    }

    /** 
     * @param {number} id
     * @param {Op} op
     */
    setOp(id, op){
        this.parsingOpList_[id] = op;
        if (this.parsingLastID_ < id) {
            this.parsingLastID_ = id;
        }
    }

    
    /**
     * まだパース中であり，表示はできない op を返す
     * @param {number} id 
     */
     getParsingOp(id){
        if (id in this.parsingOpList_) {
            return this.parsingOpList_[id];
        }
        else {
            return null;
        }
    }

    /** @param {number} id */
    purge(id) {
        if (id in this.parsingOpList_) {
            delete this.parsingOpList_[id];
        }
    }

    get parsingID_List() {
        return Object.keys(this.parsingOpList_);
    }

    // パース中の最後の ID
    get parsingLastID() {
        return this.parsingLastID_;
    }

}

module.exports.OpList = OpList;
module.exports.ParsingOpList = ParsingOpList;
