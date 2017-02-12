let DEP_ARROW_TYPE = {
    INSIDE_LINE: 0,
    LEFT_SIDE_CURVE: 1
};

class KonataRenderer{

    constructor(){
        this.name = "KonataRenderer";

        // 現在の論理位置
        // この論理位置の単位は，横がサイクル数，縦が命令数となっている
        this.viewPos_ = {
            left: 0,
            top: 0
        }; 


        // 依存関係の矢印のタイプ
        this.depArrowType_ = DEP_ARROW_TYPE.INSIDE_LINE;

        // 表示系
        this.ZOOM_RATIO_ = 0.5;   // 一回に拡大縮小する率 (2^ZOOM_RATIO)
        this.ZOOM_ANIMATION_SPEED_ = 0.07;    // ZOOM_RATIO のフレーム当たり加算値
        
        this.konata_ = null;
        this.colorScheme_ = "Auto";   // カラースキーム名

        this.OP_W = 32; // スケール1のときの1サイクルの幅
        this.OP_H = 24; // スケール1のときの1命令の高さ

        // 拡大率レベル
        this.zoomLevel_ = 0;       
        this.zoomScale_ = 1;       // 拡大率 (zoomLevel に同期)
        this.laneNum_ = 1;
        this.laneW_ = this.OP_W * this.zoomScale_;
        this.laneH_ = this.OP_H * this.zoomScale_;
        this.opW_ = this.laneW_ * this.laneNum_; 
        this.opH_ = this.laneW_ * this.laneNum_; 

        this.LANE_HEIGHT_MARGIN = 2;
        this.lane_height_margin_ = this.LANE_HEIGHT_MARGIN; // スケール1のときの高さ方向のマージン（命令の間隔）[px]

        // レーンごとの表示オプション
        this.splitLanes_ = false;    // レーンを分割して表示するかどうか
        this.fixOpHeight_ = false;   // レーンを分割して表示する際に高さを一定にするかどうか

        // 線の描画がぼけるので，補正する
        // ref: http://stackoverflow.com/questions/18019453/svg-rectangle-blurred-in-all-browsers
        this.PIXEL_ADJUST = 0.5;    

        // 拡大率が大きい場合，一部描画をはしょる
        this.drawingInterval_ = 1;

        // JSON で定義された JSON
        this.STYLE_FILE_NAME_ = "./style.json";
        this.style_ = null;
    }

    /**
     * viewPos_ の getter
     */
    get viewPos(){
        return [this.viewPos_.left, this.viewPos_.top];
    }

    /**
     * 初期化
     * @param {Konata.Konata} konata - Konata オブジェクトへの参照
     */
    init(konata){

        let self = this;
        self.konata_ = konata;
        self.loadStyle_(self.STYLE_FILE_NAME_);

        self.viewPos_ = {left:0, top:0};
        self.zoomLevel_ = 0;
        self.zoomScale_ = self.calcScale_(self.zoomLevel_);
        self.laneNum_ = Object.keys(self.konata_.laneMap).length;

        self.updateScaleParameter();
    }

    /**
     * パイプラインのスタイル定義 JSON の読み込み
     * @param {string} fileName - ファイル名
     */
    loadStyle_(fileName){
        let self = this;
        let fs = require("fs");
        self.style_ = JSON.parse(fs.readFileSync(fileName, "utf8"));
    }

    /**
     * ステージ関係のスタイル読込
     */
    getStageColor_(lane, stage){
        let self = this;

        if (self.colorScheme_ == "Auto") {
            if (stage == "f" || stage == "stl") {
                return "#aaaaaa";
            }
            let level = self.konata_.stageLevelMap[stage];
            return `hsl(${((250-level*45)%360)},70%,80%)`;
        }

        if (self.colorScheme_ in self.style_.colorScheme) {
            let style = self.style_.colorScheme[self.colorScheme_];
            if (lane in style) {
                if (stage in style[lane]) {
                    return style[lane][stage];
                }
            }
            return style["defaultColor"];
        }

        return self.colorScheme_;
    }

    /**
     * カラースキームの変更
     * @param {string} scheme - カラースキーム名
     */
    changeColorScheme(scheme){
        let self = this;
        self.colorScheme_ = scheme;
    }

    /**
     * 依存関係の矢印のタイプを変更
    */
    get depArrowType(){
        return this.depArrowType_;
    }
    set depArrowType(type){
        this.depArrowType_ = type;
    }

    /**
     * マウスホイールによる一単位の移動
     * どれだけ移動するかはその時の scale に依存
     * @param {boolean} wheelUp - ホイールの方向
     */
    moveWheel(wheelUp){
        let self = this;
        let scroll = 3 / self.zoomScale_;
        self.moveLogicalDiff([0, wheelUp ? scroll : -scroll], true);
    }

    /**
     * ピクセル数により表示位置を移動する
     * @param {Array} diff - 移動量
     */
    movePixelDiff(diff){
        let self = this;
        // 論理座標での相対値に変換してから渡す
        self.moveLogicalDiff([
            diff[0] / self.opW_,
            diff[1] / self.opH_,
        ], false);
    }

    /**
     * 論理座標の相対値により表示位置を移動する
     * @param {Array} diff - 移動量
     * @param {boolean} adjust - 命令が画面上左上にくるよう調整するかどうか
     */
    moveLogicalDiff(diff, adjust){
        let self = this;
        let posY = self.viewPos_.top + diff[1];

        let id = Math.floor(posY);
        let op = null;
        op = self.konata_.getOp(id);

        let oldTop = self.viewPos_.top;
        self.viewPos_.top = posY;

        if (adjust && op) {
            // 水平方向の補正を行う
            let oldOp = self.konata_.getOp(Math.floor(oldTop));
            if (!oldOp) {
                self.viewPos_.left = op.fetchedCycle;
            }
            else{
                // スクロール前と後の，左上の命令の水平方向の差を加算
                self.viewPos_.left += op.fetchedCycle - oldOp.fetchedCycle;
            }
        } 
        else {
            self.viewPos_.left += diff[0];
            if (self.viewPos_.left < 0) {
                self.viewPos_.left = 0;
            }
        }
    }

    /**
     * 論理座標の絶対値により表示位置を移動する
     * @param {Array} pos - 位置
     */
    moveLogicalPos(pos){
        let self = this;
        self.viewPos_.left = Math.max(0, pos[0]);
        //self.viewPos_.top = Math.max(0, pos[1]);
        self.viewPos_.top = pos[1];
    }

    // ピクセル座標から対応する op を返す
    getOpFromPixelPosY(y){
        let self = this;
        let id = Math.floor(self.viewPos_.top + y / self.opH_);
        return self.konata_.getOp(id);   
    }

    getCycleFromPixelPosX(x){
        let self = this;
        return Math.floor(self.viewPos_.left + x / self.opW_);
    }

    // ピクセル座標に対応するツールチップのテキストを作る
    getLabelToolTipText(y){
        let self = this;
        let op = self.getOpFromPixelPosY(y);
        if (!op) {
            return null;
        }
        let text = 
            `${op.labelName}\n` + 
            `${op.labelDetail}\n` + 
            `Line: \t\t${op.line}\n` +
            `Global Serial ID:\t${op.gid}\n` +
            `Thread ID:\t\t${op.tid}\n` +
            `Retire ID:\t\t${op.rid}`;
        if( op.flush ) {
            text += "\n# This op is flushed.";
        }
        return text;
    }

    // ピクセル座標に対応するツールチップのテキストを作る
    getPipelineToolTipText(x, y){
        let self = this;

        // Y 座標に対応した op を取得
        let op = self.getOpFromPixelPosY(y);
        if (!op) {
            return null;
        }

        // X 座標に対応したサイクル数を取得
        let cycle = self.getCycleFromPixelPosX(x);
        let text = `[${cycle}, ${op.id}] `;
        if (cycle < op.fetchedCycle || cycle > op.retiredCycle) {
            return text;
        }

        let first = true;
        for (let laneName in op.lanes) {
            for (let stage of op.lanes[laneName]) {
                let start = stage.startCycle;
                let end = stage.endCycle;
                let length = end - start;
                if (length == 0) {
                    end += 1;   // 長さ0の場合，表示対象に
                }

                if (start <= cycle && cycle < end){
                    if (!first) {
                        text += ", ";
                    }
                    text += `${stage.name}[${stage.endCycle - stage.startCycle}]`;
                    first = false;
                }
            }
            
        }
        return text;
    }

    // 拡大率の計算
    // level は指数で表す
    calcScale_(level){
        let self = this;
        return Math.pow(2, -level * self.ZOOM_RATIO_);
    }

    // 拡大率が変更された際の，関連パラメータの更新
    updateScaleParameter(){
        let self = this;
        let zoomScale = self.zoomScale_;
        let laneNum = self.laneNum_;

        self.laneW_ = self.OP_W * zoomScale;
        self.opW_ = self.laneW_;

        if (!self.splitLanes_) {
            laneNum = 1;
        }
        if (self.fixOpHeight_){
            self.laneH_ = self.OP_H * zoomScale / laneNum;
            self.opH_ = self.laneH_ * laneNum;
        }
        else{
            self.laneH_ = self.OP_H * zoomScale;
            self.opH_ = self.laneH_ * laneNum;
        }

        self.drawingInterval_ = Math.floor(20/(zoomScale * Math.log(zoomScale)/0.005));

        self.lane_height_margin_ = self.canDrawFrame ? self.LANE_HEIGHT_MARGIN * zoomScale : 0;
    }

    // レーンを分割して表示するかどうか
    get splitLanes(){
        return this.splitLanes_;
    }
    set splitLanes(s){
        this.splitLanes_ = s;
        this.updateScaleParameter();
    }

    // レーンを分割して表示する際に高さを一定にするかどうか
    get fixOpHeight(){
        return this.fixOpHeight_;
    }   
    set fixOpHeight(f){
        this.fixOpHeight_ = f;
        this.updateScaleParameter();
    }

    // パイプラインの中まで詳細に表示するかどうか
    // 拡大率によって決定
    get canDrawDetailedly(){
        let laneHeight = this.laneH_ - this.lane_height_margin_ * 2;
        return laneHeight - 2 > 0;  // 枠1ピクセルを除いて内部があるかどうか
    }
    get canDrawFrame(){
        let laneHeight = this.laneH_ - this.lane_height_margin_ * 2;
        return laneHeight - 2 > 2;  // 枠1ピクセルを除いて内部があるかどうか
    }
    get canDrawtext(){
        let laneHeight = this.laneH_ - this.lane_height_margin_ * 2;
        return laneHeight - 2 > 8;  // 枠1ピクセルを除いて内部があるかどうか
    }
    

    /**
     * @param {number} zoomOut - 1段階の拡大/縮小
     * @param {number} posX - ズームの中心点
     * @param {number} posY - ズームの中心点
     */
    zoom(zoomOut, posX, posY){
        let self = this;
        self.zoomLevel_ += zoomOut ? -1 : 1;

        // 最大最小ズーム率に補正
        self.zoomLevel_ = Math.max(Math.min(self.zoomLevel_, 16), -1);

        let oldScale = self.zoomScale_;
        self.zoomScale_ = self.calcScale_(self.zoomLevel_);
        self.updateScaleParameter();

        // 位置の補正
        //let oldLeft = self.viewPos_.left;
        //let oldTop = self.viewPos_.top;
        let ratio = oldScale / self.zoomScale_;
        self.moveLogicalPos([
            self.viewPos_.left - (posX - posX / ratio) / self.opW_,
            self.viewPos_.top - (posY - posY / ratio) / self.opH_
        ]);
        //console.log(`zoom ratio:${ratio}  [${oldLeft}, ${oldTop}] to [${self.viewPos_.left}, ${self.viewPos_.top}]`);
    }

    // canvas にラベルを描画
    drawLabel(canvas){
        let self = this;
        let pos = self.viewPos_;
        let top = pos.top;

        self.drawLabelTile_(canvas, top);
        return true;
    }

    /** ラベルを実際に描画
     * @param {Obaject} tile - 描画対象の canvas
     * @param {float} logTop - 現在論理位置
     * @param {float} logLeft - 現在論理位置
     */
    drawLabelTile_(tile, logTop){
        let self = this;

        // スケールを勘案した論理サイズに変換
        let logHeight = tile.height / self.opH_;
        //let logWidth = tile.width / (scale * self.opW_);

        // 背景をクリア
        let ctx = tile.getContext("2d");
        ctx.fillStyle = "rgb(245,245,245)";
        ctx.fillRect(0, 0, tile.width, tile.height);

        // フォント
        let fontFamily = self.style_["fontFamily"];
        let fontStyle = self.style_["fontStyle"];
        let fontSizeRaw = self.style_["fontSize"];
        fontSizeRaw = parseInt(fontSizeRaw);// * scale;
        let fontSize = fontSizeRaw + "px";
        ctx.font = fontStyle + " " + fontSize + " '" + fontFamily + "'";
        ctx.fillStyle = self.style_.fontColor;
        
        let marginLeft = self.style_["labelStyle"]["marginLeft"];
        let marginTop = (self.laneH_ - self.lane_height_margin_*2 - fontSizeRaw) / 2 + fontSizeRaw;

        if (!self.canDrawtext) {
            return;
        }

        try {
            for (let id = Math.floor(logTop); id < logTop + logHeight; id++) {
                let x = marginLeft;
                let y = (id - logTop) * self.opH_ + marginTop;
                let op = self.konata_.getOp(id);
                if (op) {
                    let text = `${id}: ${op.gid} (T${op.tid}: R${op.rid}): ${op.labelName}`;
                    ctx.fillText(text, x, y);
                }
            }
        } catch(e) {
            console.log(e);
            return;
        }
    }

    // canvas にパイプラインを描画
    drawPipeline(canvas){
        let self = this;
        let pos = self.viewPos_;
        let top = pos.top;
        let left = pos.left;

        self.drawPipelineTile_(canvas, top, left);
        return true;
    }

    // private methods
    drawPipelineTile_(tile, top, left){
        let self = this;
        let scale = self.zoomScale_;
        let height = tile.height / self.opH_;
        let width = tile.width / self.opW_;

        let ctx = tile.getContext("2d");
        ctx.fillStyle = "rgb(255,255,255)";
        ctx.fillRect(0, 0, tile.width, tile.height);

        // 上側にはみ出ていた場合，暗く描画
        let offsetY = 0;
        if (top < 0) {
            let bottom = -top * self.opH_ + self.PIXEL_ADJUST;
            bottom = Math.min(tile.height, bottom);
            ctx.fillStyle = "rgb(128,128,128)";
            ctx.fillRect(0, 0, tile.width, bottom);
            if (bottom >= tile.height) {
                return;
            }
            offsetY = -top;
            top = 0;
        }

        // タイルの描画
        for (let id = Math.floor(top); id < top + height; id++) {
            if (scale < 0.005 && id % self.drawingInterval_  != 0) {
                continue;
            }
            let op = null;
            try {
                op = self.konata_.getOp(id);
            } catch(e) {
                console.log(e);
                return;
            }
            if (op == null) {
                break;
            }
            if (!self.drawOp_(op, id - top + offsetY, left, left + width, scale, ctx)) {
                break;
            }
        }

        // 依存関係
        self.drawDependency(offsetY, top, left, width, height, ctx);


        // 下側にはみ出ていた場合，暗く描画
        if (top - offsetY + height > self.konata_.lastID) {
            let begin = tile.height - (top - offsetY + height - self.konata_.lastID) * self.opH_ + self.PIXEL_ADJUST;
            begin = Math.max(0, begin);
            ctx.fillStyle = "rgb(128,128,128)";
            ctx.fillRect(0, begin, tile.width, tile.height);
        }
    }

    drawDependency(logOffsetY, logTop, logLeft, logWidth, logHeight, ctx){
        // 依存関係の描画
        let self = this;

        if (!self.canDrawDetailedly) {
            return;
        }
        let arrowBeginOffsetX = self.opW_ * 3 / 4 + self.PIXEL_ADJUST;
        let arrowEndOffsetX = self.opW_ * 1 / 4 + self.PIXEL_ADJUST;
        let arrowOffsetY = self.laneH_ / 2 + self.PIXEL_ADJUST;

        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgb(170,30,30)";
        ctx.fillStyle = "rgb(170,30,30)";

        for (let id = Math.floor(logTop - logHeight); id < logTop + logHeight; id++) {
            let op = self.konata_.getOp(id);
            if (!op) {
                continue;
            }

            let prodCycle = op.prodCycle;
            if (prodCycle == -1) {
                continue;
            }

            for (let dep of op.cons) {

                let cons = self.konata_.getOp(dep.id);
                if (!cons) {
                    continue;
                }
                let consCycle = cons.consCycle;
                if (consCycle == -1) {
                    continue;
                }

                if (self.depArrowType_ == DEP_ARROW_TYPE.INSIDE_LINE) {
                    let xBegin = (prodCycle - logLeft) * self.opW_ + arrowBeginOffsetX;
                    let yBegin = (id - logTop + logOffsetY) * self.opH_ + arrowOffsetY;
                    let xEnd = (consCycle - logLeft) * self.opW_ + arrowEndOffsetX;
                    let yEnd = (cons.id - logTop + logOffsetY) * self.opH_ + arrowOffsetY;

                    self.drawArrow_(ctx, [xBegin, yBegin], [xEnd, yEnd], [xEnd - xBegin, yEnd - yBegin]);
                }
                else {
                    let xBegin = (op.fetchedCycle - logLeft) * self.opW_;
                    let yBegin = (id - logTop + logOffsetY) * self.opH_ + arrowOffsetY;
                    let xEnd = (cons.fetchedCycle - logLeft) * self.opW_;
                    let yEnd = (cons.id - logTop + logOffsetY) * self.opH_ + arrowOffsetY;

                    self.drawArrow_(ctx, [xBegin, yBegin], [xEnd, yEnd], [1, 0]);
                }
            }
        }
    }

    
    /** 矢印を描画する
    * @param {Object} ctx - 2D context
    * @param {array} start - やじりの先端
    * @param {array} end - やじりの終端
    * @param {array} v - 向きと高さを指定するベクトル
    * @param {array} shape - 底辺と高さの比
    */
    drawArrow_(ctx, start, end, v){
        let self = this;
        if (self.depArrowType_ == DEP_ARROW_TYPE.INSIDE_LINE) {
            // パイプライン中の X ステージ
            ctx.beginPath();
            ctx.moveTo(start[0], start[1]);
            ctx.lineTo(end[0], end[1]);
            ctx.stroke();
        }
        else {
            // 左側の曲線
            let offsetX = start[0] - self.opW_ * Math.sqrt((end[1] - start[1]) / self.opH_);
            ctx.beginPath();
            ctx.moveTo(start[0], start[1]);
            ctx.bezierCurveTo(
                offsetX, start[1], 
                offsetX, end[1], 
                end[0], end[1]
            );
            ctx.stroke();
        }

        // 矢印の頭
        let shape = 0.8;
        let pts = [];
        let norm = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
        let f = 5 / norm;   // 5: サイズ
        v[0] *= f;
        v[1] *= f;

        pts[0] = end;
        pts[1] = [end[0] - v[0] - v[1] * 0.5 * shape, end[1] - v[1] + v[0] * 0.5 * shape];
        pts[2] = [end[0] - v[0] + v[1] * 0.5 * shape, end[1] - v[1] - v[0] * 0.5 * shape];
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        ctx.lineTo(pts[1][0], pts[1][1]);
        ctx.lineTo(pts[2][0], pts[2][1]);
        ctx.fill();
    }

    drawOp_(op, h, startCycle, endCycle, scale, ctx){
        let self = this;
        let top = h * self.opH_ + self.PIXEL_ADJUST;
        
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
        let left = l * self.opW_ + self.PIXEL_ADJUST;
        let right = r * self.opW_ + self.PIXEL_ADJUST;

        if (self.canDrawDetailedly) {
            // 枠内に表示の余地がある場合
            ctx.strokeStyle = "#333333";
            let keys = [];
            for (let key in op.lanes) {
                keys.push(key);
            }
            keys = keys.sort();
            for (let i = 0, len = keys.length; i < len; i++) {
                let key = keys[i];
                let laneTop = self.splitLanes_ ? (h + i / len) : h;  // logical pos
                self.drawLane_(op, laneTop, startCycle, endCycle, scale, ctx, key);
            }
        }
        else{
            // 十分小さい場合は簡略化モード
            ctx.lineWidth = 1;
            if (self.colorScheme_ != "default") {
                ctx.fillStyle = self.colorScheme_;
            }
            else{
                ctx.fillStyle = "#888888";
            }
            ctx.fillRect(left, top + self.lane_height_margin_, right - left, self.laneH_ - self.lane_height_margin_ * 2);

            if (op.flush) {
                let opacity = "0.4"; //self.getStyleRule_([".flush"], "opacity", 1, "0.8");
                let bgc = "#000"; //self.getStyleRule_([".flush"], "background-color", 1, "#888");
                ctx.globalAlpha = opacity;
                ctx.fillStyle = bgc;
                ctx.fillRect(left, top + self.lane_height_margin_, right - left, self.laneH_ - self.lane_height_margin_ * 2);
                ctx.globalAlpha = 1;
            }

        }
        return true;
    }

    drawLane_(op, h, startCycle, endCycle, scale, ctx, laneName){
        let self = this;

        let fontSizeRaw = self.style_["fontSize"];
        fontSizeRaw = parseInt(fontSizeRaw) * scale;
        let fontSize = fontSizeRaw + "px";
        let fontFamily = self.style_["fontFamily"];
        let fontStyle = self.style_["fontStyle"];
        ctx.font = fontStyle + " " + fontSize + " '" + fontFamily + "'";

        let lane = op.lanes[laneName];
        let top = h * self.opH_ + self.PIXEL_ADJUST;
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
            let color = self.getStageColor_(laneName, stage.name);
            let l = startCycle > stage.startCycle ? (startCycle - 1) : stage.startCycle; l -= startCycle;
            let r = endCycle >= stage.endCycle ? stage.endCycle : (endCycle + 1); r -= startCycle;
            let left = l * self.opW_ + self.PIXEL_ADJUST;
            let right = r * self.opW_ + self.PIXEL_ADJUST;
            let rect = [left, top + self.lane_height_margin_, right - left, (self.laneH_ - self.lane_height_margin_ * 2)];

            let grad = ctx.createLinearGradient(0, top, 0, top+self.laneH_);
            grad.addColorStop(1, color);
            grad.addColorStop(0, "#eee");

            ctx.lineWidth = 1;
            ctx.fillStyle = grad;
            ctx.fillRect(rect[0], rect[1], rect[2], rect[3]);

            if (op.flush) {
                let opacity = "0.4"; //self.getStyleRule_([".flush"], "opacity", 1, "0.8");
                let bgc = "#000"; //self.getStyleRule_([".flush"], "background-color", 1, "#888");
                ctx.globalAlpha = opacity;
                ctx.fillStyle = bgc;
                ctx.fillRect(rect[0], rect[1], rect[2], rect[3]);
                ctx.globalAlpha = 1;
            }
            
            if (self.canDrawFrame){
                ctx.strokeRect(rect[0], rect[1], rect[2], rect[3]);
            }


            if (self.canDrawtext) {
                ctx.fillStyle = "#555555";
                let textTop = top + (self.laneH_ - self.lane_height_margin_*2 - fontSizeRaw) / 2 + fontSizeRaw;
                let textLeft = (stage.startCycle - startCycle) * self.opW_ + (self.opW_/3);
                for (let j = 1, len_in = stage.endCycle - stage.startCycle; j < len_in; j++) {
                    ctx.fillText(j, textLeft + j * self.opW_, textTop);
                }
                ctx.fillStyle = self.style_.fontColor;
                ctx.fillText(stage.name, textLeft, textTop);
            }

        }
    }
}

// この書式じゃないと IntelliSense が効かない
module.exports.KonataRenderer = KonataRenderer;
module.exports.DEP_ARROW_TYPE = DEP_ARROW_TYPE;
