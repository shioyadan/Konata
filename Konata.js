function Konata(){
    
    this.name = "Konata";
    this.Op = require("./Op");
    this.File = require("./File");
    this.Stage = require("./Stage");
    this.Label = require("./Label");

    // private変数．外部からはアクセサを用意しない限りアクセスできない．
    // ローカル変数と区別するため m_ を付ける．
    let m_files = {}; // 見たいファイル名とパース結果を関連付ける連想配列
    let m_lastFetchedId = {};
    let m_prefetch = null;
    let m_prefetchInterval = 1000;
    let m_prefetchNum = 1000;

    let m_Parsers = [require("./OnikiriParser")];
    let m_RemoteParsers = [require("./MainProcessIF")]; // 通信によってパース結果を受け取る場合に利用する。
    let m_Cache = require("./Cache");

    this.Close = function (path) {
        m_files[path] = null;
        m_lastFetchedId[path] = null;
    };

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

    this.OpenFile = function (path) {
        if (m_files[path] != null) {
            // 既に開かれている。
            return;
        }
        let file = new this.File(path);
        console.log("Open :", path);
        if (!file.success) { // pathを理解できないので外部の人に解決を頼む
            let connection = Connect(path, this);
            return true;
        }

        for (let i = 0, len = m_Parsers.length; i < len; i++) {
            let parser = new m_Parsers[i](this);
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
        }
        return false;
    };

    function Connect (path, self) {
        console.log("Challenge connection");
        for (let i = 0, len = m_RemoteParsers.length; i < len; i++) {
            let parser = new m_RemoteParsers[i](self);
            if (parser.SetFile(path)) {
                console.log("Selected remote parser:", parser.GetName());
                m_files[path] = new m_Cache(path, parser, self);
                return;
            }
        }
        console.log("Not found");
        return null;
    }

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
}

module.exports = Konata;
