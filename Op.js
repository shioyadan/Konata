class Op{
    constructor(args){
        this.id = null;
        this.gid = null; // シミュレータ上のグローバルID
        this.rid = null; // シミュレータ上のリタイアID
        this.tid = null; // スレッドID
        this.retired = false; // リタイアしてるかどうか
        this.flush = false; // Flushであるかどうか
        this.eof = false; // ファイル終端による終了
        this.lanes = {}; // レーン情報の連想配列
        this.fetchedCycle = null;
        this.retiredCycle = null;
        this.labels = []; // ラベル情報の入っている配列
        this.prods = []; // プロデューサ命令のIDの配列
        this.cons = []; // コンシューマ命令のIDの配列

        for (let key in args) {
            this[key] = args[key];
        }
    }
}

module.exports.Op = Op;
