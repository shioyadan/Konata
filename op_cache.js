class OpCache{
    constructor(filePath, parser, that) {
        this.konata = that;
        this.filePath = filePath;
        this.parser = parser;
        this.cache = [];
        this.range = 10;
        this.lastIndex; // 最終要素以降を無駄に要求しないように覚えておく
    }

    getOp(id){
        if (this.cache[id] == null) {
            this.cacheRequest(id);
        }
        if (id > this.lastIndex) {
            return null;
        }
        return this.cache[id];
    }

    getOpFromRID(rid){
        let cache = this.cache;
        for (let i = cache.length - 1; i >= 0; i--) {
            if (cache[i] && cache[i].rid == rid) {
                return cache[i];
            }
        }
        return null;
    }

    cacheRequest(id){
        if (id > this.lastIndex) {
            return;
        }
        let start = id - this.range;
        let end = id + this.range;
        if (start < 0) {
            start = 0;
        }
        if (end > this.lastIndex) {
            end = this.lastIndex;
        }
        let ops = null;
        if (this.parser.GetOps) {
            ops = this.parser.getOps(start,end);
        }
        for (let i = start; i < end; i++) {
            if (this.cache[i] != null) {
                continue;
            }
            let op;
            if (ops) {
                op = ops[i - start];
            } else {
                op = this.parser.getOp(i);
            }
            if (op == null) {
                if (this.lastIndex == null || this.lastIndex > i - 1) {
                    this.lastIndex = i - 1;
                }
                break;
            }
            /*
            if (op.Draw == null) { // 
                op = new this.konata.Op(op);
            }*/
            this.cache[i] = op;
        }
    }
}

module.exports.OpCache = OpCache;
