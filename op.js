// JSDoc のタイプチェックに型を認識させるため
let Stage = require("./stage").Stage; // eslint-disable-line
let Lane = require("./stage").Lane; // eslint-disable-line

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
        /** @type {Object<string, Lane>} */
        this.lanes = {}; // レーン情報の連想配列
        this.fetchedCycle = -1;
        this.retiredCycle = -1;

        this.line = 0;  // 行番号
        
        this.labelName = "";    // 逆アセンブルのペーンに出すコメント
        this.labelDetail = "";  // パイプラインのペーンに出すコメント
        //this.labelStage = {};   // ステージごとのラベル
        
        /** @type {Stage} */
        this.lastParsedStage = null;
        this.lastParsedCycle = -1;

        /** @type {Array<Dependency>} prods - プロデューサ命令のIDの配列 */
        this.prods = []; 

        /** @type {Array<Dependency>} cons - コンシューマ命令のIDの配列 */
        this.cons = [];

        // 依存関係の描画に使用
        this.prodCycle = -1;    // 実行ステージの開始
        this.consCycle = -1;    // 実行ステージの修了
    }
}

class Dependency{
    /** 
     * @param {Op} op 
     * @param {number} type
     * @param {number} cycle
     * */
    constructor(op, type, cycle) {
        this.op = op;
        this.type = type;
        this.cycle = cycle;
    }
}

module.exports.Op = Op;
module.exports.Dependency = Dependency;
