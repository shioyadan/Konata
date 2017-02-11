class Op{
    constructor(){
        // ファイル内での ID
        // Konata 内の識別はこの ID によって行う
        this.id = -1; 

        this.gid = -1; // シミュレータ上のグローバル ID
        this.rid = -1; // シミュレータ上のリタイア ID
        this.tid = -1; // シミュレータ上のスレッド ID
        
        this.retired = false; // リタイアしてるかどうか
        this.flush = false; // Flushであるかどうか
        
        this.eof = false; // ファイル終端による終了
        this.lanes = {}; // レーン情報の連想配列
        this.fetchedCycle = -1;
        this.retiredCycle = -1;

        this.line = 0;
        
        this.labelName = "";
        this.labelDetail = "";
        this.labelStage = {};
        
        this.lastParsedStage = "";

        this.labels = []; // ラベル情報の入っている配列
        
        this.prods = []; // プロデューサ命令のIDの配列
        this.cons = []; // コンシューマ命令のIDの配列

        // 依存関係の描画に使用
        this.prodCycle = -1;    // 実行ステージの開始
        this.consCycle = -1;    // 実行ステージの修了
    }
}

module.exports.Op = Op;
