/**
 * @constructor
 */

function KonataRenderer(){

    // ~.prototype.init = の書式でクラスを定義すると，VS Code の補完が効く
    // この関数では self に入れるとメンバを認識してくれないので，
    // this 経由で設定している．

    this.name = "KonataRenderer";

    // 現在の論理位置
    // この論理位置の単位は，横がサイクル数，縦が命令数となっている
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
    this.colorScheme_ = "default";   // カラースキーム名

    this.styleCSS_ = null; // 親要素(.tab)の持つスタイル

    // 以下のパラメータはOp.jsと合わせる．(そうしないと表示がズレる)
    this.opH_ = 25; // スケール1のときの1命令の高さ
    this.opW_ = 25; // スケール1のときの1サイクルの幅
    this.margin_ = 5; // スケール1のときの高さ方向のマージン（命令の間隔）[px]
    this.skip_ = 1;

    // JSON で定義された JSON
    this.STYLE_FILE_NAME_ = "./style.json";
    this.styleObj_ = null;

    //let m_maxScale = 2; // retinaの場合、倍精度必要なので最大倍率も倍
    //let m_minScale = 0.00006103515625;

}


/**
 * 初期化
 * @param {Konata.Konata} konata - Konata オブジェクトへの参照
 */
KonataRenderer.prototype.init = function(konata){

    let self = this;
    self.konata_ = konata;

    self.viewPos_ = {left:0, top:0};
    self.zoomLevel_ = 0;
    self.zoomScale_ = 1;
    self.styleCSS_ = {};

    self.loadStyle_(self.STYLE_FILE_NAME_);
};

/**
 * パイプラインのスタイル定義 JSON の読み込み
 * @param {string} fileName - ファイル名
 */
KonataRenderer.prototype.loadStyle_ = function(fileName){
    let self = this;
    let fs = require("fs");
    self.styleObj_ = JSON.parse(fs.readFileSync(fileName, "utf8"));
};

/**
 * ステージ関係のスタイル読込
 */
KonataRenderer.prototype.getStageColor_ = function(lane, stage){
    let self = this;

    if (self.colorScheme_ != "default") {
        return self.colorScheme_;
    }

    let style = self.styleObj_["lane-style"];
    if (lane in style) {
        if (stage in style[lane]) {
            return style[lane][stage];
        }
    }
    return self.styleObj_["default-color"];
};

/**
 * カラースキームの変更
 * @param {string} scheme - カラースキーム名
 */
KonataRenderer.prototype.changeColorScheme = function(scheme){
    let self = this;
    self.colorScheme_ = scheme;
};


/**
 * マウスホイールによる一単位の移動
 * どれだけ移動するかはその時の scale に依存
 * @param {boolean} wheelUp - ホイールの方向
 */
KonataRenderer.prototype.moveWheel = function(wheelUp){
    let self = this;
    let scroll = 3 / self.zoomScale_;
    self.moveToLogical([0, wheelUp ? scroll : -scroll], true);
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

// canvas にラベルを描画
KonataRenderer.prototype.drawLabel = function(canvas){
    let self = this;
    let pos = self.viewPos_;
    let scale = self.zoomScale_;
    let top = pos.top;
    let left = pos.left;

    self.skip_ = Math.floor(20/(scale * Math.log(scale)/0.005));
    self.drawTile_(canvas, top, left);
    return true;
};

// canvas にパイプラインを描画
KonataRenderer.prototype.drawPipeline = function(canvas){
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
        if (!self.drawOp_(op, id - top, left, left + width, scale, ctx, self.styleCSS_)) {
            return;
        }
    }
};


KonataRenderer.prototype.drawOp_ = function(op, h, startCycle, endCycle, scale, context, parentStyle){
    let self = this;
    if (!context.fillRect) {
        console.log("Not context object");
        return false;
    }
    if (parentStyle && parentStyle["opacity"]) {
        context.globalAlpha = parentStyle.opacity;
    }

    let colorSet = false;
    if (parentStyle && parentStyle["color"]) {
        context.fillStyle = parentStyle.color;
        context.strokeStyle = parentStyle.color;
        colorSet = true;
    }
    let top = h * self.opH_ * scale;
    //context.fillStyle = "#ffffff";
    context.clearRect(0, top, (endCycle - startCycle) * scale, self.opH_ * scale);
    //context.fillStyle = null;
    if (op.retiredCycle < startCycle) {
        return true;
    } else if (endCycle < op.fetchedCycle) {
        return false;
    }
    if (op.retiredCycle == op.fetchedCycle) {
        return true;
    }
    let l = startCycle > op.fetchedCycle ? (startCycle - 1) : op.fetchedCycle; l -= startCycle;
    let r = endCycle >= op.retiredCycle ? op.retiredCycle : (endCycle + 1); r -= startCycle;
    let left = l * scale * self.opW_;
    let right = r * scale * self.opW_;
    if (colorSet) {
    } else if (scale < 0.2) {
        context.strokeStyle = "#888888";
    } else {
        context.strokeStyle = "#333333";
    }
    if (!colorSet) {
        context.fillStyle = "#888888";
    }
    context.strokeRect(left, top, right - left, (self.opH_ - self.margin_) * scale);
    if (scale >= 0.1) {
        let keys = [];
        for (let key in op.lanes) {
            keys.push(key);
        }
        keys = keys.sort();
        for (let i = 0, len = keys.length; i < len; i++) {
            let key = keys[i];
            self.drawLane_(op, h, startCycle, endCycle, scale, context, key, parentStyle);
        }
    }
    if (op.flush) {
        let opacity = "0.4"; //self.getStyleRule_([".flush"], "opacity", 1, "0.8");
        let bgc = "#000"; //self.getStyleRule_([".flush"], "background-color", 1, "#888");
        context.globalAlpha *= opacity;
        context.fillStyle = bgc;
        context.fillRect(left, top, right - left, (self.opH_ - self.margin_) * scale);
    }
    self.ClearStyle_(context);
    return true;
};

KonataRenderer.prototype.ClearStyle_ = function(context){
    //let self = op;
    context.globalAlpha = 1;
    context.fillStyle = null;
    context.strokeStyle = null;
};

/**
 * @param {object} parentStyle - 外部から指定されたスタイル
 */
KonataRenderer.prototype.drawLane_ = function(op, h, startCycle, endCycle, scale, context, laneName, parentStyle){
    let self = this;

    let fontSize = self.styleObj_["font-size"];
    fontSize = parseInt(fontSize) * scale;
    fontSize = fontSize + "px";
    let fontFamily = self.styleObj_["font-family"];
    let fontStyle = self.styleObj_["font-style"];

    let colorSet = false;
    if (parentStyle && parentStyle["color"]) {
        colorSet = true;
    }
    let lane = op.lanes[laneName];
    let top = h * self.opH_ * scale;
    for (let i = 0, len = lane.length; i < len; i++) {
        let stage = lane[i];
        if (stage.endCycle == null) {
            stage.endCycle = op.retiredCycle;
        }
        if (stage.endCycle < startCycle) {
            continue;
        } else if (endCycle < stage.startCycle) {
            break; // stage.startCycle が endCycleを超えているなら，以降のステージはこのcanvasに描画されない．
        }
        if (stage.endCycle == stage.startCycle) {
            continue;
        }
        let color;
        if (!colorSet) {
            color = self.getStageColor_(laneName, stage.name);
        } else {
            color = parentStyle.color;
        }
        let l = startCycle > stage.startCycle ? (startCycle - 1) : stage.startCycle; l -= startCycle;
        let r = endCycle >= stage.endCycle ? stage.endCycle : (endCycle + 1); r -= startCycle;
        let left = l * scale * self.opW_;
        let right = r * scale * self.opW_;
        let grad = context.createLinearGradient(0,top,0,top+self.opH_ * scale);
        grad.addColorStop(1, color);
        grad.addColorStop(0, "#eee");
        context.fillStyle = grad;
        context.font = fontStyle + " " + fontSize + " '" + fontFamily + "'";
        context.clearRect(left, top, right - left, (self.opH_ - self.margin_) * scale);
        context.fillRect(left, top, right - left, (self.opH_ - self.margin_) * scale);
        context.strokeRect(left, top, right - left, (self.opH_ - self.margin_) * scale);
        left = (stage.startCycle - startCycle) * scale * self.opW_;
        if (scale >= 0.5) {
            context.fillStyle = "#555555";
            let textTop = top + (self.opH_ - self.margin_) * scale*3/4;
            let textLeft = left + (self.opW_ * scale/3);
            for (let j = 1, len_in = stage.endCycle - stage.startCycle; j < len_in; j++) {
                context.fillText(j, textLeft + j * scale * self.opW_, textTop);
            }
            context.fillStyle = "#000000";
            context.fillText(stage.name, textLeft, textTop);
        }
    }
};

// この書式じゃないと IntelliSense が効かない
module.exports.KonataRenderer = KonataRenderer;
