function Cache(filePath, parser, that) {
    this.Konata = that;
    this.filePath = filePath;
    this.parser = parser;
    this.cache = [];
    this.range = 10;
    this.lastIndex; // 最終要素以降を無駄に要求しないように覚えておく
    if (this.parser.GetOp == null && this.parser.GetOps == null) {
        // Error処理
    }

    this.GetOp = function(id) {
        if (this.cache[id] == null) {
            this.CacheRequest(id);
        }
        if (id > this.lastIndex) {
            return null;
        }
        return this.cache[id];
    };

    this.CacheRequest = function(id) {
        if (id > this.lastIndex) {
            return;
        }
        var start = id - this.range;
        var end = id + this.range;
        if (start < 0) {
            start = 0;
        }
        if (end > this.lastIndex) {
            end = this.lastIndex;
        }
        var ops = null;
        if (this.parser.GetOps) {
            ops = this.parser.GetOps(start,end);
        }
        for (var i = start; i < end; i++) {
            if (this.cache[i] != null) {
                continue;
            }
            if (ops) {
                var op = ops[i - start];
            } else {
                var op = this.parser.GetOp(i);
            }
            if (op == null) {
                if (this.lastIndex == null || this.lastIndex > i - 1) {
                    this.lastIndex = i - 1;
                }
                break;
            }
            if (op.Draw == null) { // 
                op = new this.Konata.Op(op);
            }
            this.cache[i] = op;
        }
    };
}

module.exports = Cache;
