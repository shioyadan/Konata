function Konata (that, retina) {
    this.that = that;
    this.name = "Konata";
    this.Op = require("./Op");
    this.File = require("./File");
    this.Stage = require("./Stage");
    this.Label = require("./Label");
    // private変数．外部からはアクセサを用意しない限りアクセスできない．
    // ローカル変数と区別するため m_ を付ける．
    var m_position = {}; // ファイル毎の現在位置を覚えておく連想配列
    var m_files = {}; // 見たいファイル名とパース結果を関連付ける連想配列
    var m_tabs = {}; // 表示用HTML(jQuery)オブジェクトの連想配列
    var m_tiles = {}; // ファイルごとのtileの二重配列を覚えておく連想配列
    var m_parentStyle = {}; // 親要素(.tab)の持つスタイル
    var m_scale = {};
    var m_lastFetchedId = {};
    var m_prefetch = null;
    var m_prefetchInterval = 1000;
    var m_prefetchNum = 1000;
    // jQuery HTMLをいじるときに使う．
    var m_jquery = require("./jquery");
    var m_Parsers = [require("./OnikiriParser")];
    var m_RemoteParsers = [require("./MainProcessIF")]; // 通信によってパース結果を受け取る場合に利用する。
    var m_Cache = require("./Cache");
    // キャンバスの縦横．0でなければなんでもいいと思う．
    var m_canvasW = 300;
    var m_canvasH = 300;
    // 以下のパラメータはOp.jsと合わせる．(そうしないと表示がズレる)
    var m_opH = 25; // スケール1のときの1命令の高さ
    var m_opW = 25; // スケール1のときの1サイクルの幅
    var m_skip = 1;
    var m_retina = false;//retina;
    if (retina) {
        // MacのRetinaディスプレイだとm_retinaをtrueにしないとぼやけるが，
        // Ubuntu上ではRetinaディスプレイ判定されても通常通りの描画の方が綺麗．
        // もう少し別の判定方法が必要？
        console.log("Retina display");
    }
    var m_normalScale = m_retina? 2:1;
    var m_maxScale = m_retina? 4:2; // retinaの場合、倍精度必要なので最大倍率も倍
    var m_minScale = m_retina? 0.00006103515625 * 2: 0.00006103515625;
    
    this.GetScale = function (path) {
        return m_scale[path];
    }

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
    }

    this.OpenFile = function (path) {
        if (m_files[path] != null) {
            // 既に開かれている。
            return;
        }
        var file = new this.File(path);
        console.log("Open :", path);
        if (!file.success) { // pathを理解できないので外部の人に解決を頼む
            var connection = Connect(path, this);
            return;
        }

        for (var i = 0, len = m_Parsers.length; i < len; i++) {
            var parser = new m_Parsers[i](this);
            try {
                if (parser.SetFile(file)) {
                    console.log("Selected parser:" , parser.GetName());
                    m_files[path] = new m_Cache(path, parser);
                    return;
                }
            } catch (e) {
                if (e == "Wait") {
                    console.log("Selected parser:" , parser.GetName());
                    m_files[path] = new m_Cache(path, parser);
                    throw e;
                }
            }
        }
        return null;
    };

    function Connect (path, self) {
        console.log("Challenge connection");
        for (var i = 0, len = m_RemoteParsers.length; i < len; i++) {
            var parser = new m_RemoteParsers[i](self);
            if (parser.SetFile(path)) {
                console.log("Selected remote parser:", parser.GetName());
                m_files[path] = new m_Cache(path, parser, self);
                return;
            }
        }
        console.log("Not found");
        return null;
    };

    this.InitDraw = function (path, obj) {
        if (m_tabs[path]) {
            // 既にタブが有るのはおかしい．
            return false;
        }
        m_position[path] = {top:0, left:0};
        m_tabs[path] = this.MakeTable(obj, path);
        m_scale[path] = m_normalScale;
        m_parentStyle[path] = {};
        try {
            this.OpenFile(path);
            this.Draw(path);
        } catch(e) {
            if (e == "Wait") {
                //console.log(path, " extract waiting..,");
                //var self = this;
                //setTimeout(self.Draw(path), 10000);
            }
        }

        return true;
    }

    // Use renderer process only
    this.Draw = function (path) {
        this.SetTile(path);
        var pos = m_position[path];
        CancelPrefetch();
        var scale = m_scale[path];
        var tab = m_tabs[path];
        var tiles = m_tiles[path];
        var top = pos.top;
        m_skip = Math.floor(20/(scale * Math.log(scale)/0.005));
        for (var y = 0; y < tiles.length; y++) {
            var left = pos.left;
            for (var x = 0; x < tiles[y].length; x++) {
                var tile = tiles[y][x];
                this.DrawTile(tile, top, left, path);
                left += m_canvasW/(scale * m_opW);
            }
            top += m_canvasH/(scale * m_opH);
        }
        //SetPrefetch(this);
        return true;
    };

    this.MoveTo = function (diff, path, adjust) {
        var posY = m_position[path].top + diff.top;
        if (posY < 0) {
            posY = 0;
        }
        var id = Math.floor(posY);
        try {
            var op = this.GetOp(path, id);
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
    }

    this.GetOp = function (path, id) {
        var file = m_files[path];
        if (file == null) {
            throw "Not open " + path;
        }
        var op = file.GetOp(id);
        if (op != null) {
            m_lastFetchedId[path] = id;
        }
        return op;
    };

    // この関数を直接呼ぶことは禁止．
    // プリフェッチしたければSetPrefetchメソッドを利用する．
    function Prefetch(self) {
        for (var key in m_lastFetchedId) {
            var start = m_lastFetchedId[key] + 1;
            var end = start + m_prefetchNum;
            for (var id = start; id < end; id++) {
                try {
                    var op = self.GetOp(key, id);
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
    };

    // private methods
    this.DrawTile = function (tile, top, left, path) {
        var scale = m_scale[path];
        var height = m_canvasH / (scale * m_opH);
        var width = m_canvasW / (scale * m_opW);
        for (var id = Math.floor(top); id < top + height; id++) {
            if (scale < 0.005 && id % m_skip  != 0) {
                continue;
            }
            try {
                var op = this.GetOp(path, id);
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
    }

    this.MakeTable = function (obj, path) {
        // pathは空白なしに変換する(HTMLの一般的な属性値に空白文字を利用できないため)
        var noSpacePath = path; // 面倒臭い．
        var tab = m_jquery("<div></div>", {"class":"tab"}).appendTo(obj);
        tab.attr("id", "Konata_" + noSpacePath);
        tab.attr("data-path", path);
        m_jquery("<span></span>", {"class":"labels-window"}).appendTo(tab);
        m_jquery("<span></span>", {"class":"window-sizing"}).appendTo(tab);
        var p = m_jquery("<span></span>", {"class":"pipelines-window"}).appendTo(tab);
        console.log("Make tab");
        return tab;
    };

    this.SetTile = function (path) {
        var tabs = {};
        if (path) {
            tabs[path] = m_tabs[path];
        } else {
            var tabs = m_tabs;
        }
        // canvasのサイズを定義する[px]
        for (var key in tabs) {
            var tab = tabs[key];
            var p = tab.find(".pipelines-window");
            // 必要なcanvas数を考える
            if (m_retina) { // retinaだと倍精度で描かないとボケる
                var x = Math.ceil(p.width()/m_canvasW) * 2 + 2;
                var y = Math.ceil(p.height()/m_canvasH) * 2 + 2;
            } else {
                var x = Math.ceil(p.width()/m_canvasW) + 2;
                var y = Math.ceil(p.height()/m_canvasH) + 2;
            }
            LayTiles(p, x, y, key);
            //console.log(key , "set tiles:", p.width(), p.height());
        }
    }

    // obj内に幅width, 高さheightのタイルをx * y個敷き詰める。
    function LayTiles(obj, x, y, path) {
        obj.html("");
        var tiles = [];
        for (var h = 0; h < y; h++) {
            var tileY = m_jquery("<div></div>", {class:"tileY"}).appendTo(obj);
            if (m_retina) {
                tileY.css("max-height", m_canvasH/2);
            } else {
                tileY.css("max-height", m_canvasH);
            }
            tiles.push([]);
            for (var w = 0; w < x; w++) {
                var tileX = m_jquery("<canvas></canvas>", {class:"tileX"}).appendTo(tileY);
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
