function KonataRenderer(konata) {

    this.konata = konata;
    this.name = "KonataRenderer";

    // private変数．外部からはアクセサを用意しない限りアクセスできない．
    // ローカル変数と区別するため m_ を付ける．
    let m_position = {}; // ファイル毎の現在位置を覚えておく連想配列
    let m_tabs = {}; // 表示用HTML(jQuery)オブジェクトの連想配列
    let m_tiles = {}; // ファイルごとのtileの二重配列を覚えておく連想配列
    let m_parentStyle = {}; // 親要素(.tab)の持つスタイル
    let m_scale = {};

    // jQuery HTMLをいじるときに使う．
    let m_jquery = require("./lib/js/jquery");

    // キャンバスの縦横．0でなければなんでもいいと思う．
    let m_canvasW = 300;
    let m_canvasH = 300;

    // 以下のパラメータはOp.jsと合わせる．(そうしないと表示がズレる)
    let m_opH = 25; // スケール1のときの1命令の高さ
    let m_opW = 25; // スケール1のときの1サイクルの幅
    let m_skip = 1;
    let m_retina = false;//retina;

    let m_normalScale = m_retina? 2:1;
    let m_maxScale = m_retina? 4:2; // retinaの場合、倍精度必要なので最大倍率も倍
    let m_minScale = m_retina? 0.00006103515625 * 2: 0.00006103515625;
    
    this.GetScale = function (path) {
        return m_scale[path];
    };

    this.Close = function (path) {
        m_position[path] = null;
        m_tabs[path] = null;
        m_tiles[path] = null;
        m_parentStyle[path] = null;
        m_scale[path] = null;

        this.konata.Close(path);
        //m_files[path] = null;
        //m_lastFetchedId[path] = null;
    };

    this.RetinaSwitch = function () {
        m_retina = !m_retina;
        m_maxScale = m_retina? 4:2;
        m_minScale = m_retina? 0.00006103515625 * 2: 0.00006103515625;
    };

    this.ParentStyle = function (path, style, value) {
        if (value !== undefined) {
            m_parentStyle[path][style] = value;
        } else {
            return m_parentStyle[path][style];
        }
    };

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
            if (!this.konata.OpenFile(path)) {
                this.Close(path);
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
        
        //this.konata.CancelPrefetch();

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
            op = this.konata.GetOp(path, id);
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
                op = this.konata.GetOp(path, id);
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

module.exports = KonataRenderer;
