class Konata{
    constructor(){
        this.name = "Konata";

        // private変数．外部からはアクセサを用意しない限りアクセスできない．
        // ローカル変数と区別するため this. を付ける．
        this.files = null; // 見たいファイル名とパース結果を関連付ける連想配列
        this.lastFetchedId = 0;

        this.File_ = require("./File");
        this.OnikiriParser_ = require("./onikiri_parser").OnikiriParser;
        this.Cache_ = require("./Cache");
    }

    close(){
        this.files = null;
        this.lastFetchedId = null;
    }


    openFile(path){
        if (this.files != null) {
            // 既に開かれている。
            return;
        }

        let file = new this.File_(path);
        let parser = new this.OnikiriParser_();
        console.log("Open :", path);

        try {
            if (parser.setFile(file)) {
                console.log("Selected parser:" , parser.getName());
                this.files = new this.Cache_(path, parser);
                return true;
            }
        } catch (e) {
            if (e == "Wait") {
                console.log("Selected parser:" , parser.getName());
                this.files = new this.Cache_(path, parser);
                throw e;
            }
        }
        return false;
    }

    getOp(id){
        let file = this.files;
        if (file == null) {
            throw "Not opened";
        }
        let op = file.GetOp(id);
        if (op != null) {
            this.lastFetchedId = id;
        }
        return op;
    }


    /*
    // プリフェッチも一旦無効に

    this.prefetch = null;
    this.prefetchInterval = 1000;
    this.prefetchNum = 1000;

    // なにか時間のかかりそうな処理の前には呼び出す．
    this.CancelPrefetch = function(){
        if (this.prefetch !== null) {
            clearTimeout(this.prefetch);
            this.prefetch = null;
        }
    };

    // 時間のかかりそうな処理の終わりに呼んでおく．
    function SetPrefetch (self) {
        this.CancelPrefetch(); // 多重予約を防ぐために予約済のプリフェッチがあればキャンセルする．
        this.prefetch = setTimeout(function(){Prefetch(self);}, this.prefetchInterval);
    }

    // この関数を直接呼ぶことは禁止．
    // プリフェッチしたければSetPrefetchメソッドを利用する．
    function Prefetch(self) {
        for (let key in this.lastFetchedId) {
            let start = this.lastFetchedId[key] + 1;
            let end = start + this.prefetchNum;
            for (let id = start; id < end; id++) {
                let op = null;
                try {
                    op = self.getOp(key, id);
                } catch(e) {
                    console.log(e);
                    break;
                }
                if (op == null) {
                    break;
                }
            }
        }
        SetPrefetch(self);
    }
    */
}

module.exports.Konata = Konata;
