function Konata (that, retina) {
    this.that = that;
    this.name = "Konata";
    this.Op = require("./Op");
    this.File = require("./File");
    this.Stage = require("./Stage");
    this.Label = require("./Label");
    // private変数．外部からはアクセサを用意しない限りアクセスできない．
    // ローカル変数と区別するため m_ を付ける．
    let m_position = {}; // ファイル毎の現在位置を覚えておく連想配列
    let m_files = {}; // 見たいファイル名とパース結果を関連付ける連想配列
    let m_tabs = {}; // 表示用HTML(jQuery)オブジェクトの連想配列
    let m_tiles = {}; // ファイルごとのtileの二重配列を覚えておく連想配列
    let m_parentStyle = {}; // 親要素(.tab)の持つスタイル
    let m_scale = {};
    let m_lastFetchedId = {};
    let m_prefetch = null;
    let m_prefetchInterval = 1000;
    let m_prefetchNum = 1000;
    // jQuery HTMLをいじるときに使う．
    let m_jquery = require("./lib/js/jquery");
    let m_Parsers = [require("./OnikiriParser")];
    let m_RemoteParsers = [require("./MainProcessIF")]; // 通信によってパース結果を受け取る場合に利用する。
    let m_Cache = require("./Cache");
    // キャンバスの縦横．0でなければなんでもいいと思う．
    let m_canvasW = 300;
    let m_canvasH = 300;
    // 以下のパラメータはOp.jsと合わせる．(そうしないと表示がズレる)
    let m_opH = 25; // スケール1のときの1命令の高さ
    let m_opW = 25; // スケール1のときの1サイクルの幅
    let m_skip = 1;
    let m_retina = false;//retina;
    if (retina) {
        // MacのRetinaディスプレイだとm_retinaをtrueにしないとぼやけるが，
        // Ubuntu上ではRetinaディスプレイ判定されても通常通りの描画の方が綺麗．
        // もう少し別の判定方法が必要？
        console.log("Retina display");
    }
    let m_normalScale = m_retina? 2:1;
    let m_maxScale = m_retina? 4:2; // retinaの場合、倍精度必要なので最大倍率も倍
    let m_minScale = m_retina? 0.00006103515625 * 2: 0.00006103515625;
    
    this.GetScale = function (path) {
        return m_scale[path];
    };

    this.Close = function (path) {
        m_position[path] = null;
        m_files[path] = null;
        m_tabs[path] = null;
        m_tiles[path] = null;
        m_parentStyle[path] = null;
        m_scale[path] = null;
        m_lastFetchedId[path] = null;
    };

    this.RetinaSwitch = function () {
        m_retina = !m_retina;
        m_maxScale = m_retina? 4:2;
        m_minScale = m_retina? 0.00006103515625 * 2: 0.00006103515625;
    };

    // なにか時間のかかりそうな処理の前には呼び出す．
    function CancelPrefetch () {
        if (m_prefetch !== null) {
            clearTimeout(m_prefetch);
            m_prefetch = null;
        }
    }
    // 時間のかかりそうな処理の終わりに呼んでおく．
    function SetPrefetch (self) {
        CancelPrefetch(); // 多重予約を防ぐために予約済のプリフェッチがあればキャンセルする．
        m_prefetch = setTimeout(function(){Prefetch(self);}, m_prefetchInterval);
    }

    this.ParentStyle = function (path, style, value) {
        if (value !== undefined) {
            m_parentStyle[path][style] = value;
        } else {
            return m_parentStyle[path][style];
        }
    };

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

    this.InitDraw = function (path, tab) {
        if (m_tabs[path]) {
            // 既にタブが有るのはおかしい．
            return false;
        }
        m_tabs[path] = tab;
        m_position[path] = {top:0, left:0};
        m_scale[path] = m_normalScale;
        m_parentStyle[path] = {};
        try {
            if (!this.OpenFile(path)) {
                Close(path);
                return false;
            }
            this.Draw(path);
        } catch(e) {
            if (e == "Wait") {
                //console.log(path, " extract waiting..,");
                //let self = this;
                //setTimeout(self.Draw(path), 10000);
            }
        }

        return true;
    };

    // Use renderer process only
    this.Draw = function (path) {
        if (!path) {
            return;
        }
        this.SetTile(path);
        let pos = m_position[path];
        CancelPrefetch();
        let scale = m_scale[path];
        //let tab = m_tabs[path];
        let tiles = m_tiles[path];
        let top = pos.top;
        m_skip = Math.floor(20/(scale * Math.log(scale)/0.005));
        for (let y = 0; y < tiles.length; y++) {
            let left = pos.left;
            for (let x = 0; x < tiles[y].length; x++) {
                let tile = tiles[y][x];
                this.DrawTile(tile, top, left, path);
                left += m_canvasW/(scale * m_opW);
            }
            top += m_canvasH/(scale * m_opH);
        }
        //SetPrefetch(this);
        return true;
    };

    this.MoveTo = function (diff, path, adjust) {
        let posY = m_position[path].top + diff.top;
        if (posY < 0) {
            posY = 0;
        }
        let id = Math.floor(posY);
        let op = null;
        try {
            op = this.GetOp(path, id);
        } catch (e) {
            console.log(e);
            return;
        }
        if (op == null) {
            return; //this.position[path];
        }
        m_position[path].top = posY;
        if (adjust) {
            m_position[path].left = op.fetchedCycle;
        } else {
            m_position[path].left += diff.left;
            if (m_position[path].left < 0) {
                m_position[path].left = 0;
            }
        }
        this.Draw(path);
    };

    this.Zoom = function (path, scale) {
        if (m_tiles[path] == null) {
            console.log("tile null");
            return;
        }
        m_scale[path] = m_scale[path] * scale;
        if (m_scale[path] > m_maxScale) {
            m_scale[path] = m_maxScale;
        } else if (m_scale[path] < m_minScale) {
            m_scale[path] = m_minScale;
        }
        this.Draw(path);
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

    // private methods
    this.DrawTile = function (tile, top, left, path) {
        let scale = m_scale[path];
        let height = m_canvasH / (scale * m_opH);
        let width = m_canvasW / (scale * m_opW);
        for (let id = Math.floor(top); id < top + height; id++) {
            if (scale < 0.005 && id % m_skip  != 0) {
                continue;
            }
            let op = null;
            try {
                op = this.GetOp(path, id);
            } catch(e) {
                console.log(e);
                return;
            }
            if (op == null) {
                return;
            }
            if ( !op.Draw(id - top, left, left + width, scale, tile, m_parentStyle[path]) ) {
                return;
            }
        }
    };

    this.SetTile = function (path) {
        let tabs = {};
        if (path) {
            tabs[path] = m_tabs[path];
        } else {
            tabs = m_tabs;
        }
        // canvasのサイズを定義する[px]
        for (let key in tabs) {
            let tab = tabs[key];
            let p = tab.find(".pipelines-window");
            // 必要なcanvas数を考える
            let x, y;
            if (m_retina) { // retinaだと倍精度で描かないとボケる
                x = Math.ceil(p.width()/m_canvasW) * 2 + 2;
                y = Math.ceil(p.height()/m_canvasH) * 2 + 2;
            } else {
                x = Math.ceil(p.width()/m_canvasW) + 2;
                y = Math.ceil(p.height()/m_canvasH) + 2;
            }
            LayTiles(p, x, y, key);
            //console.log(key , "set tiles:", p.width(), p.height());
        }
    };

    // obj内に幅width, 高さheightのタイルをx * y個敷き詰める。
    function LayTiles(obj, x, y, path) {
        obj.html("");
        let tiles = [];
        for (let h = 0; h < y; h++) {
            let tileY = m_jquery("<div></div>", {class:"tileY"}).appendTo(obj);
            if (m_retina) {
                tileY.css("max-height", m_canvasH/2);
            } else {
                tileY.css("max-height", m_canvasH);
            }
            tiles.push([]);
            for (let w = 0; w < x; w++) {
                let tileX = m_jquery("<canvas></canvas>", {class:"tileX"}).appendTo(tileY);
                tileX.attr("width", m_canvasW);
                tileX.attr("height", m_canvasH);
                if (m_retina) {
                    tileX.css({"width":m_canvasW/2, "height":m_canvasH/2}); // Retinaディスプレイの解像度に対応
                }
                if (!tileX[0].getContext) {
                    console.log("tileX.getContext not found");
                    return;
                }
                tiles[h].push( tileX[0].getContext("2d") );
            }
        }
        m_tiles[path] = tiles;
    }
}

module.exports = Konata;
