/**
 * @constructor
 */
function KonataRenderer(){

    // ~.prototype.init = の書式でクラスを定義すると，VS Code の補完が効く
    // この関数では self に入れるとメンバを認識してくれないので，
    // this 経由で設定している．

    this.name = "KonataRenderer";

    // 現在の論理位置
    // この位置の単位は，横がサイクル数，縦が命令数となっている
    this.viewPos_ = {
        left: 0,
        top: 0
    }; 


    // 表示系
    this.ZOOM_RATIO_ = 0.8;   // 一回に拡大縮小する率 (2^ZOOM_RATIO)
    this.ZOOM_ANIMATION_SPEED_ = 0.07;    // ZOOM_RATIO のフレーム当たり加算値

    this.zoomLevel_ = 0;       // 拡大率レベル
    this.zoomScale_ = 1;       // 拡大率 (zoomLevel に同期)
    
    this.konata_ = null;
    this.style_ = null; // 親要素(.tab)の持つスタイル

    // 以下のパラメータはOp.jsと合わせる．(そうしないと表示がズレる)
    this.opH_ = 25; // スケール1のときの1命令の高さ
    this.opW_ = 25; // スケール1のときの1サイクルの幅
    this.skip_ = 1;

    //let m_maxScale = 2; // retinaの場合、倍精度必要なので最大倍率も倍
    //let m_minScale = 0.00006103515625;

}


KonataRenderer.prototype.init = function(konata){
    let self = this;
    self.viewPos_ = {left:0, top:0};
    self.zoomLevel_ = 0;
    self.zoomScale_ = 1;
    self.konata_ = konata;

    self.style_ = {};
};

/**
 * マウスホイールによる一単位の移動
 * どれだけ移動するかはその時の scale に依存
 * @param {boolean} wheelUp - ホイールの方向
 */
KonataRenderer.prototype.moveWheel = function(wheelUp){
    let self = this;
    let scroll = 3 / self.zoomScale_;
    self.moveTo([0, wheelUp ? scroll : -scroll], true);
};

/**
 * ピクセル数により表示位置を移動する
 * @param {Array} diff - 移動量
 */
KonataRenderer.prototype.movePos = function(diff){
    let self = this;
    // 論理座標に変換してから渡す
    self.moveToLogical([
        diff[0] / self.opW_ / self.zoomScale_,
        diff[1] / self.opH_ / self.zoomScale_,
    ], false);
};

/**
 * 論理座標により表示位置を移動する
 * @param {Array} diff - 移動量
 * @param {boolean} adjust - 命令が画面上左上にくるよう調整するかどうか
 */
KonataRenderer.prototype.moveToLogical = function(diff, adjust){
    let self = this;
    let posY = self.viewPos_.top + diff[1];
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
    } 
    else {
        self.viewPos_.left += diff[0];
        if (self.viewPos_.left < 0) {
            self.viewPos_.left = 0;
        }
    }
};

// 拡大率の計算
// level は指数で表す
KonataRenderer.prototype.calcScale_ = function(level){
    return Math.pow(2, level);
};

/**
 * @param {number} zoomOut - 1段階の拡大/縮小
 * @param {number} posX - ズームの中心点
 * @param {number} posY - ズームの中心点
 */
KonataRenderer.prototype.zoom = function(zoomOut, posX, posY){
    let self = this;
    self.zoomLevel_ += zoomOut ? self.ZOOM_RATIO_ : -self.ZOOM_RATIO_;
    self.zoomScale_ = self.calcScale_(self.zoomLevel_);
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
    let scale = self.zoomScale_;
    let top = pos.top;
    let left = pos.left;

    self.skip_ = Math.floor(20/(scale * Math.log(scale)/0.005));
    self.drawTile_(canvas, top, left);
    return true;
};

// private methods
KonataRenderer.prototype.drawTile_ = function(tile, top, left){
    let self = this;
    let scale = self.zoomScale_;
    let height = tile.height / (scale * self.opH_);
    let width = tile.width / (scale * self.opW_);

    let ctx = tile.getContext("2d");
    ctx.fillStyle = "rgb(255,255,255)";
    ctx.fillRect(0, 0, tile.width, tile.height);

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
        if (!op.Draw(id - top, left, left + width, scale, ctx, self.style_)) {
            return;
        }
    }
};

// この書式じゃないと IntelliSense が効かない
module.exports.KonataRenderer = KonataRenderer;
