function Konata (that) {
    this.that = that;
    this.name = "Konata";
    this.Op = require("./Op");
    this.Cache = require("./Cache");
    this.Parsers = [require("./OnikiriParser")];
    this.RemoteParser = [require("./MainProcessIF")]; // 通信によってパース結果を受け取る場合に利用する。
    this.File = require("./File");
    this.Stage = require("./Stage");
    this.Label = require("./Label");
    this.files = {}; // 見たいファイル名とパース結果を関連付ける連想配列
    this.tabs = {}; // 表示用HTML(jQuery)オブジェクトの連想配列
    this.tiles = {}; // ファイルごとのtileの二重配列を覚えておく連想配列
    this.position = {}; // ファイル毎の現在位置を覚えておく連想配列
    var jQuery = require("./jquery");
    this.skip = 1;
    this.scale = {};

    this.GetOp = function (path, id, remote) {
        var file = this.files[path];
        if (file == null) {
            file = this.OpenFile(path, remote);
        }
        return file.GetOp(id);
    };

    this.OpenFile = function (path, remote) {
        if (this.files[path] != null) {
            // 既に開かれている。
            return this.files[path];
        }
        console.log("Open :", path);
        if (remote) { // 通信による解決を図る
            var connection = this.Connect(path);
            return connection;
        }
        var file = new this.File(path);
        for (var i = 0, len = this.Parsers.length; i < len; i++) {
            var parser = new this.Parsers[i](this);
            if (parser.SetFile(file)) {
                console.log("Selected parser:" , parser.GetName());
                this.files[path] = new this.Cache(path, parser);
                return this.files[path];
            }
        }
        return null;
    };

    this.Connect = function (path) {
        console.log("Challenge connection");
        for (var i = 0, len = this.RemoteParser.length; i < len; i++) {
            var parser = new this.RemoteParser[i](this);
            if (parser.SetFile(path)) {
                console.log("Selected remote parser:", parser.GetName());
                this.files[path] = new this.Cache(path, parser, this);
                return this.files[path];
            }
        }
        console.log("Not found");
        return null;
    };

    // Use renderer process only
    this.Draw = function (path, position, obj) {
        this.position[path] = position;
        if (this.scale[path] == null) {
            this.scale[path] = 1;
        }
        var scale = this.scale[path];
        if (this.tabs[path] == null) {
            // pathは空白なしに変換する(HTMLの属性値に空白文字を利用できないため)
            this.tabs[path] = this.MakeTable(obj, path);
        }
        if (this.tiles[path] == null) {
            this.SetTile(path);
            console.log("Set tiles");
        }
        var tab = this.tabs[path];
        var tiles = this.tiles[path];
        var top = position.top;
        this.skip = Math.floor(20/(scale * Math.log(scale)/0.005));
        for (var y = 0; y < tiles.length; y++) {
            var left = position.left;
            for (var x = 0; x < tiles[y].length; x++) {
                var tile = tiles[y][x];
                this.DrawTile(tile, top, left, path);
                left += 300/(scale * 25);
            }
            top += 300/(scale * 25);
        }
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
        if (this.tiles[path] == null) {
            console.log("tile null");
            return;
        }
        this.scale[path] = this.scale[path] * scale;
        if (this.scale[path] > 1) {
            this.scale[path] = 1;
        } else if (this.scale[path] < 0.00006103515625) {
            this.scale[path] = 0.00006103515625;
        }
        this.Draw(path, this.position[path]);
    }

    // private methods
    this.DrawTile = function (tile, top, left, path) {
        var scale = this.scale[path];
        var height = 300/(scale*25);
        var width = 300/(scale*25);
        for (var id = Math.floor(top); id < top + height; id++) {
            if (scale < 0.005 && id % this.skip  != 0) {
                continue;
            }
            var op = this.GetOp(path, id, true);
            if (op == null) {
                return;
            }
            if ( !op.Draw(id - top, left, left + width, scale, tile) ) {
                return;
            }
        }
    }

    this.MakeTable = function (obj, path) {
        var tab = jQuery("<div></div>", {"class":"tab"}).appendTo(obj);
        tab.attr("id", "Konata_" + path);
        jQuery("<span></span>", {"class":"labels-window"}).appendTo(tab);
        jQuery("<span></span>", {"class":"window-sizing"}).appendTo(tab);
        var p = jQuery("<span></span>", {"class":"pipelines-window"}).appendTo(tab);
        console.log("Make tab");
        return tab;
    };

    this.SetTile = function (path) {
        var tabs = {};
        if (path) {
            tabs[path] = this.tabs[path];
        } else {
            var tabs = this.tabs;
        }
        // canvasのサイズを定義する[px]
        var width = 300;
        var height = 300;
        for (var key in tabs) {
            var tab = tabs[key];
            var p = tab.find(".pipelines-window");
            // 必要なcanvas数を考える
            var x = p.width()/width + 2;
            var y = p.height()/height + 2;
            this.LayTiles(p, x, y, width, height, key);
            //console.log(key , "set tiles:", p.width(), p.height());
        }
    }

    // obj内に幅width, 高さheightのタイルをx * y個敷き詰める。
    this.LayTiles = function (obj, x, y, width, height, path) {
        obj.html("");
        var tiles = [];
        for (var h = 0; h < y; h++) {
            var tileY = jQuery("<div></div>", {class:"tileY"}).appendTo(obj);
            tiles.push([]);
            for (var w = 0; w < x; w++) {
                var tileX = jQuery("<canvas></canvas>", {class:"tileX"}).appendTo(tileY);
                tileX.attr("width", width);
                tileX.attr("height", height);
                if (!tileX[0].getContext) {
                    console.log("tileX.getContext not found");
                    return;
                }
                tiles[h].push( tileX[0].getContext("2d") );
            }
        }
        this.tiles[path] = tiles;
    }
}

module.exports = Konata;
