function Konata(){
    
    this.name = "Konata";

    // private変数．外部からはアクセサを用意しない限りアクセスできない．
    // ローカル変数と区別するため m_ を付ける．
    let m_files = {}; // 見たいファイル名とパース結果を関連付ける連想配列
    let m_lastFetchedId = {};

    let File = require("./File");
    let OnikiriParser_ = require("./OnikiriParser");
    let m_Cache = require("./Cache");

    this.Close = function (path) {
        m_files[path] = null;
        m_lastFetchedId[path] = null;
    };

    this.OpenFile = function (path) {
        if (m_files[path] != null) {
            // 既に開かれている。
            return;
        }
        let file = new File(path);
        console.log("Open :", path);

        let parser = new OnikiriParser_();
        try {
            if (parser.SetFile(file)) {
                console.log("Selected parser:" , parser.GetName());
                m_files[path] = new m_Cache(path, parser);
                return true;
            }
        } catch (e) {
            if (e == "Wait") {
                console.log("Selected parser:" , parser.GetName());
                m_files[path] = new m_Cache(path, parser);
                throw e;
            }
        }
        return false;
    };

    this.GetOp = function (path, id) {
        let file = m_files[path];
        if (file == null) {
            throw "Not open " + path;
        }
        let op = file.GetOp(id);
        if (op != null) {
            m_lastFetchedId[path] = id;
        }
        return op;
    };


    /*
    // プリフェッチも一旦無効に

    let m_prefetch = null;
    let m_prefetchInterval = 1000;
    let m_prefetchNum = 1000;

    // なにか時間のかかりそうな処理の前には呼び出す．
    this.CancelPrefetch = function(){
        if (m_prefetch !== null) {
            clearTimeout(m_prefetch);
            m_prefetch = null;
        }
    };

    // 時間のかかりそうな処理の終わりに呼んでおく．
    function SetPrefetch (self) {
        this.CancelPrefetch(); // 多重予約を防ぐために予約済のプリフェッチがあればキャンセルする．
        m_prefetch = setTimeout(function(){Prefetch(self);}, m_prefetchInterval);
    }

    // この関数を直接呼ぶことは禁止．
    // プリフェッチしたければSetPrefetchメソッドを利用する．
    function Prefetch(self) {
        for (let key in m_lastFetchedId) {
            let start = m_lastFetchedId[key] + 1;
            let end = start + m_prefetchNum;
            for (let id = start; id < end; id++) {
                let op = null;
                try {
                    op = self.GetOp(key, id);
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

module.exports = Konata;
