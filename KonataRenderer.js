function KonataRenderer(){

    this.name = "KonataRenderer";

    // private変数．外部からはアクセサを用意しない限りアクセスできない．
    // ローカル変数と区別するため m_ を付ける．
    let m_position = null; // ファイル毎の現在位置
    let m_parentStyle = null; // 親要素(.tab)の持つスタイル
    let m_scale = null;
    this.konata = null;

    // 以下のパラメータはOp.jsと合わせる．(そうしないと表示がズレる)
    let m_opH = 25; // スケール1のときの1命令の高さ
    let m_opW = 25; // スケール1のときの1サイクルの幅
    let m_skip = 1;

    let m_normalScale = 1;
    let m_maxScale = 2; // retinaの場合、倍精度必要なので最大倍率も倍
    let m_minScale = 0.00006103515625;
    
    this.GetScale = function(){
        return m_scale;
    };

    this.ParentStyle = function(style, value){
        if (value !== undefined) {
            m_parentStyle[style] = value;
        } else {
            return m_parentStyle[style];
        }
    };

    this.init = function(konata){
        m_position = {top:0, left:0};
        m_scale = m_normalScale;
        m_parentStyle = {};
        this.konata = konata;
        return true;
    };

    // Use renderer process only
    this.draw = function(canvas){
        let pos = m_position;
        let scale = m_scale;
        let top = pos.top;
        let left = pos.left;

        m_skip = Math.floor(20/(scale * Math.log(scale)/0.005));
        this.DrawTile(canvas, top, left);
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
    };

    this.setScale = function(scale){
        m_scale = scale;
    };

    // private methods
    this.DrawTile = function(tile, top, left){
        let scale = m_scale;
        let height = tile.height / (scale * m_opH);
        let width = tile.width / (scale * m_opW);
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
            if (!op.Draw(id - top, left, left + width, scale, tile.getContext("2d"), m_parentStyle)) {
                return;
            }
        }
    };
}

module.exports = KonataRenderer;
