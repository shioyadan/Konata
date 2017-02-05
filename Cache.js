function Cache(filePath, parser, that) {
    var m_konata = that;
    var m_filePath = filePath;
    var m_parser = parser;
    var m_cache = [];
    var m_range = 10;
    var m_lastIndex; // 最終要素以降を無駄に要求しないように覚えておく
    if (m_parser.getOp == null && m_parser.getOps == null) {
        // Error処理
    }

    this.GetOp = function(id) {
        if (m_cache[id] == null) {
            CacheRequest(id);
        }
        if (id > m_lastIndex) {
            return null;
        }
        return m_cache[id];
    };

    function CacheRequest(id) {
        if (id > m_lastIndex) {
            return;
        }
        var start = id - m_range;
        var end = id + m_range;
        if (start < 0) {
            start = 0;
        }
        if (end > m_lastIndex) {
            end = m_lastIndex;
        }
        var ops = null;
        if (m_parser.GetOps) {
            ops = m_parser.getOps(start,end);
        }
        for (var i = start; i < end; i++) {
            if (m_cache[i] != null) {
                continue;
            }
            if (ops) {
                var op = ops[i - start];
            } else {
                var op = m_parser.getOp(i);
            }
            if (op == null) {
                if (m_lastIndex == null || m_lastIndex > i - 1) {
                    m_lastIndex = i - 1;
                }
                break;
            }
            /*
            if (op.Draw == null) { // 
                op = new m_konata.Op(op);
            }*/
            m_cache[i] = op;
        }
    };
}

module.exports = Cache;
