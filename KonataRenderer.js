function KonataRenderer(){

    this.name = "KonataRenderer";

    // private変数．外部からはアクセサを用意しない限りアクセスできない．
    // ローカル変数と区別するため m_ を付ける．
    let m_position = null; // ファイル毎の現在位置
    let m_tabs = null; // 表示用HTML(jQuery)オブジェクト
    let m_tiles = null; // ファイルごとのtileの二重配列
    let m_parentStyle = null; // 親要素(.tab)の持つスタイル
    let m_scale = null;
    this.konata = null;

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
    
    this.GetScale = function(){
        return m_scale;
    };

    this.Close = function(){
        m_position = null;
        m_tabs = null;
        m_tiles = null;
        m_parentStyle = null;
        m_scale = null;

        this.konata.Close();
        this.konata = null;
        //m_files[path] = null;
        //m_lastFetchedId[path] = null;
    };

    this.RetinaSwitch = function () {
        m_retina = !m_retina;
        m_maxScale = m_retina? 4:2;
        m_minScale = m_retina? 0.00006103515625 * 2: 0.00006103515625;
    };

    this.ParentStyle = function (style, value) {
        if (value !== undefined) {
            m_parentStyle[style] = value;
        } else {
            return m_parentStyle[style];
        }
    };

    this.InitDraw = function(konata, tab){
        if (m_tabs) {
            // 既にタブが有るのはおかしい．
            return false;
        }
        m_tabs = tab;
        m_position = {top:0, left:0};
        m_scale = m_normalScale;
        m_parentStyle = {};
        this.konata = konata;
        this.Draw();
        return true;
    };

    // Use renderer process only
    this.Draw = function(){
        this.SetTile();
        let pos = m_position;
        
        //this.konata.CancelPrefetch();

        let scale = m_scale;
        let tiles = m_tiles;
        let top = pos.top;
        m_skip = Math.floor(20/(scale * Math.log(scale)/0.005));
        for (let y = 0; y < tiles.length; y++) {
            let left = pos.left;
            for (let x = 0; x < tiles[y].length; x++) {
                let tile = tiles[y][x];
                this.DrawTile(tile, top, left);
                left += m_canvasW/(scale * m_opW);
            }
            top += m_canvasH/(scale * m_opH);
        }
        //SetPrefetch(this);
        return true;
    };

    this.MoveTo = function (diff, adjust) {
        let posY = m_position.top + diff.top;
        if (posY < 0) {
            posY = 0;
        }
        let id = Math.floor(posY);
        let op = null;
        try {
            op = this.konata.GetOp(id);
        } catch (e) {
            console.log(e);
            return;
        }
        if (op == null) {
            return; //this.position[path];
        }
        m_position.top = posY;
        if (adjust) {
            m_position.left = op.fetchedCycle;
        } else {
            m_position.left += diff.left;
            if (m_position.left < 0) {
                m_position.left = 0;
            }
        }
        this.Draw();
    };

    this.Zoom = function (scale) {
        if (m_tiles == null) {
            console.log("tile null");
            return;
        }
        m_scale = m_scale * scale;
        if (m_scale > m_maxScale) {
            m_scale = m_maxScale;
        } else if (m_scale < m_minScale) {
            m_scale = m_minScale;
        }
        this.Draw();
    };

    // private methods
    this.DrawTile = function(tile, top, left){
        let scale = m_scale;
        let height = m_canvasH / (scale * m_opH);
        let width = m_canvasW / (scale * m_opW);
        for (let id = Math.floor(top); id < top + height; id++) {
            if (scale < 0.005 && id % m_skip  != 0) {
                continue;
            }
            let op = null;
            try {
                op = this.konata.GetOp(id);
            } catch(e) {
                console.log(e);
                return;
            }
            if (op == null) {
                return;
            }
            if (!op.Draw(id - top, left, left + width, scale, tile, m_parentStyle)) {
                return;
            }
        }
    };

    this.SetTile = function(){
        // canvasのサイズを定義する[px]
        let tab = m_tabs;
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
        LayTiles(p, x, y);
        //console.log(key , "set tiles:", p.width(), p.height());
    };

    // obj内に幅width, 高さheightのタイルをx * y個敷き詰める。
    function LayTiles(obj, x, y) {
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
        m_tiles = tiles;
    }
}

module.exports = KonataRenderer;
