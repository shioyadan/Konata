function KonataRenderer(){

    // ~.prototype.init = の書式でクラスを定義すると，VS Code の補完が効く
    // この関数では self に入れるとメンバを認識してくれないので，
    // this 経由で設定している．

    this.name = "KonataRenderer";

    // ファイル毎の現在位置
    this.viewPos_ = {
        left: 0,
        top: 0
    }; 
    
    this.scale_ = null; // 拡大率
    this.konata_ = null;
    this.style_ = null; // 親要素(.tab)の持つスタイル

    // 以下のパラメータはOp.jsと合わせる．(そうしないと表示がズレる)
    this.opH_ = 25; // スケール1のときの1命令の高さ
    this.opW_ = 25; // スケール1のときの1サイクルの幅
    this.skip_ = 1;

    //let m_maxScale = 2; // retinaの場合、倍精度必要なので最大倍率も倍
    //let m_minScale = 0.00006103515625;

}


KonataRenderer.prototype.init = function(konata_){
    let self = this;
    self.viewPos_ = {left:0, top:0};
    self.scale_ = 1;
    self.konata_ = konata_;

    self.style_ = {};
};

KonataRenderer.prototype.setScale = function(scale){
    let self = this;
    self.scale_ = scale;

};

KonataRenderer.prototype.moveTo = function (diff, adjust) {
    let self = this;
    let posY = self.viewPos_.top + diff.top;
    if (posY < 0) {
        posY = 0;
    }
    let id = Math.floor(posY);
    let op = null;
    try {
        op = self.konata_.GetOp(id);
    } catch (e) {
        console.log(e);
        return;
    }
    if (op == null) {
        return; //self.position[path];
    }
    self.viewPos_.top = posY;
    if (adjust) {
        self.viewPos_.left = op.fetchedCycle;
    } else {
        self.viewPos_.left += diff.left;
        if (self.viewPos_.left < 0) {
            self.viewPos_.left = 0;
        }
    }
};

KonataRenderer.prototype.getScale = function(){
    let self = this;
    return self.scale_;
};

KonataRenderer.prototype.style = function(style, value){
    let self = this;
    if (value !== undefined) {
        self.style_[style] = value;
    } else {
        return self.style_[style];
    }
};


// Use renderer process only
KonataRenderer.prototype.draw = function(canvas){
    let self = this;
    let pos = self.viewPos_;
    let scale = self.scale_;
    let top = pos.top;
    let left = pos.left;

    self.skip_ = Math.floor(20/(scale * Math.log(scale)/0.005));
    self.drawTile_(canvas, top, left);
    return true;
};

// private methods
KonataRenderer.prototype.drawTile_ = function(tile, top, left){
    let self = this;
    let scale = self.scale_;
    let height = tile.height / (scale * self.opH_);
    let width = tile.width / (scale * self.opW_);
    for (let id = Math.floor(top); id < top + height; id++) {
        if (scale < 0.005 && id % self.skip_  != 0) {
            continue;
        }
        let op = null;
        try {
            op = self.konata_.GetOp(id);
        } catch(e) {
            console.log(e);
            return;
        }
        if (op == null) {
            return;
        }
        if (!op.Draw(id - top, left, left + width, scale, tile.getContext("2d"), self.style_)) {
            return;
        }
    }
};


module.exports = KonataRenderer;
