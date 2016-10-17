function Konata (that) {
    this.that = that;
    this.name = "Konata";
    this.Op = require("./Op");
    var m_Cache = require("./Cache");
    this.File = require("./File");
    this.Stage = require("./Stage");
    this.Label = require("./Label");
    // 以下の変数は（基本的に）外部から直接触らないことを前提にしてるので，
    // その内 var m_* の形に変える．
    this.position = {}; // ファイル毎の現在位置を覚えておく連想配列
    // private変数．外部からはアクセサを用意しない限りアクセスできない．
    // ローカル変数と区別するため m_ を付ける．
    var m_files = {}; // 見たいファイル名とパース結果を関連付ける連想配列
    var m_tabs = {}; // 表示用HTML(jQuery)オブジェクトの連想配列
    var m_tiles = {}; // ファイルごとのtileの二重配列を覚えておく連想配列
    var m_scale = {};
    var m_lastFetchedId = {};
    var m_prefetch = null;
    var m_prefetchInterval = 2000;
    var m_prefetchNum = 500;
    // jQuery HTMLをいじるときに使う．
    var m_jquery = require("./jquery");
    var m_Parsers = [require("./OnikiriParser")];
    var m_RemoteParsers = [require("./MainProcessIF")]; // 通信によってパース結果を受け取る場合に利用する。
    // キャンバスの縦横．0でなければなんでもいいと思う．
    var m_canvasW = 300;
    var m_canvasH = 300;
    // 以下のパラメータはOp.jsと合わせる．(そうしないと表示がズレる)
    var m_opH = 25; // スケール1のときの1命令の高さ
    var m_opW = 25; // スケール1のときの1サイクルの幅
    var m_skip = 1;

    this.GetScale = function (path) {
        return m_scale[path];
    }
    this.OpenFile = function (path, remote) {
        if (m_files[path] != null) {
            // 既に開かれている。
            return m_files[path];
        }
        if (this.prefech) {
            clearTimeout(m_prefetch);
        }
        console.log("Open :", path);
        if (remote) { // 通信による解決を図る
            var connection = Connect(path, this);
            Prefetch(this);
            return connection;
        }
        var file = new this.File(path);
        for (var i = 0, len = m_Parsers.length; i < len; i++) {
            var parser = new m_Parsers[i](this);
            if (parser.SetFile(file)) {
                console.log("Selected parser:" , parser.GetName());
                m_files[path] = new m_Cache(path, parser);
                Prefetch(this);
                return m_files[path];
            }
        }
        Prefetch(this);
        return null;
    };

    function Connect (path, self) {
        console.log("Challenge connection");
        for (var i = 0, len = m_RemoteParsers.length; i < len; i++) {
            var parser = new m_RemoteParsers[i](self);
            if (parser.SetFile(path)) {
                console.log("Selected remote parser:", parser.GetName());
                m_files[path] = new m_Cache(path, parser, self);
                return m_files[path];
            }
        }
        console.log("Not found");
        return null;
    };

    // Use renderer process only
    this.Draw = function (path, position, obj) {
        if (this.prefech) {
            clearTimeout(m_prefetch);
        }
        this.position[path] = position;
        if (m_scale[path] == null) {
            m_scale[path] = 1;
        }
        var scale = m_scale[path];
        if (m_tabs[path] == null) {
            // pathは空白なしに変換する(HTMLの属性値に空白文字を利用できないため)
            m_tabs[path] = this.MakeTable(obj, path);
        }
        if (m_tiles[path] == null) {
            this.SetTile(path);
            console.log("Set tiles");
        }
        var tab = m_tabs[path];
        var tiles = m_tiles[path];
        var top = position.top;
        m_skip = Math.floor(20/(scale * Math.log(scale)/0.005));
        for (var y = 0; y < tiles.length; y++) {
            var left = position.left;
            for (var x = 0; x < tiles[y].length; x++) {
                var tile = tiles[y][x];
                this.DrawTile(tile, top, left, path);
                left += m_canvasW/(scale * m_opW);
            }
            top += m_canvasH/(scale * m_opH);
        }
        Prefetch(this);
        return tab;
    };

    this.Move = function (path, scrollY) {
        var posY = this.position[path].top + scrollY
        if (posY < 0) {
            posY = 0;
        }
        var id = Math.floor(posY);
        var op = this.GetOp(path, id);
        if (op == null) {
            return this.position[path];
        }
        this.position[path].top = posY;
        this.position[path].left = op.fetchedCycle;
        //console.log(path, this.position[path]);
        this.Draw(path, this.position[path]);
        return this.position[path];
    };

    this.Zoom = function (path, scale) {
        if (m_tiles[path] == null) {
            console.log("tile null");
            return;
        }
        m_scale[path] = m_scale[path] * scale;
        if (m_scale[path] > 2) {
            m_scale[path] = 1;
        } else if (m_scale[path] < 0.00006103515625) {
            m_scale[path] = 0.00006103515625;
        }
        this.Draw(path, this.position[path]);
    }

    this.GetOp = function (path, id, remote) {
        var file = m_files[path];
        if (file == null) {
            file = this.OpenFile(path, remote);
        }
        var op = file.GetOp(id);
        if (op != null) {
            m_lastFetchedId[path] = id;
        }
        return op;
    };

    function Prefetch(self) {
        m_prefetch = setTimeout(function(){Prefetch(self)}, m_prefetchInterval);
        for (var key in m_lastFetchedId) {
            var start = m_lastFetchedId[key] + 1;
            var end = start + m_prefetchNum;
            for (var id = start; id < end; id++) {
                var op = self.GetOp(key, id);
                if (op == null) {
                    break;
                }
            }
        }
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
            var op = this.GetOp(path, id, true);
            if (op == null) {
                return;
            }
            if ( !op.Draw(id - top, left, left + width, scale, tile, m_jquery) ) {
                return;
            }
        }
    }

    this.MakeTable = function (obj, path) {
        var tab = m_jquery("<div></div>", {"class":"tab"}).appendTo(obj);
        tab.attr("id", "Konata_" + path);
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
        var width = m_canvasW;
        var height = m_canvasH;
        for (var key in tabs) {
            var tab = tabs[key];
            var p = tab.find(".pipelines-window");
            // 必要なcanvas数を考える
            var x = Math.ceil(p.width()/width) + 2;
            var y = Math.ceil(p.height()/height) + 2;
            this.LayTiles(p, x, y, width, height, key);
            //console.log(key , "set tiles:", p.width(), p.height());
        }
    }

    // obj内に幅width, 高さheightのタイルをx * y個敷き詰める。
    this.LayTiles = function (obj, x, y, width, height, path) {
        obj.html("");
        var tiles = [];
        for (var h = 0; h < y; h++) {
            var tileY = m_jquery("<div></div>", {class:"tileY"}).appendTo(obj);
            tiles.push([]);
            for (var w = 0; w < x; w++) {
                var tileX = m_jquery("<canvas></canvas>", {class:"tileX"}).appendTo(tileY);
                tileX.attr("width", width);
                tileX.attr("height", height);
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
