function Op(args){
    this.id = null;
    this.gid = null; // シミュレータ上のグローバルID
    this.rid = null; // シミュレータ上のリタイアID
    this.tid = null; // スレッドID
    this.retired = false; // リタイアしてるかどうか
    this.flush = false; // Flushであるかどうか
    this.eof = false; // ファイル終端による終了
    this.lanes = {}; // レーン情報の連想配列
    this.fetchedCycle = null;
    this.retiredCycle = null;
    this.labels = []; // ラベル情報の入っている配列
    this.prods = []; // プロデューサ命令のIDの配列
    this.cons = []; // コンシューマ命令のIDの配列

    this.opH_ = 25; // スケール1のときの1命令の高さ[px]
    this.opW_ = 25; // スケール1のときの1サイクルの幅[px]
    this.margin_ = 5; // スケール1のときの高さ方向のマージン（命令の間隔）[px]

    for (let key in args) {
        this[key] = args[key];
    }
}


Op.prototype.draw = function (h, startCycle, endCycle, scale, context, parentStyle){
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
    if (this.retiredCycle < startCycle) {
        return true;
    } else if (endCycle < this.fetchedCycle) {
        return false;
    }
    if (this.retiredCycle == this.fetchedCycle) {
        return true;
    }
    let l = startCycle > this.fetchedCycle ? (startCycle - 1) : this.fetchedCycle; l -= startCycle;
    let r = endCycle >= this.retiredCycle ? this.retiredCycle : (endCycle + 1); r -= startCycle;
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
        for (let key in this.lanes) {
            keys.push(key);
        }
        keys = keys.sort();
        for (let i = 0, len = keys.length; i < len; i++) {
            let key = keys[i];
            self.drawLane(h, startCycle, endCycle, scale, context, key, this, parentStyle);
        }
    }
    if (this.flush) {
        let opacity = self.getStyleRule([".flush"], "opacity", 1, "0.8");
        let bgc = self.getStyleRule([".flush"], "background-color", 1, "#888");
        context.globalAlpha *= opacity;
        context.fillStyle = bgc;
        context.fillRect(left, top, right - left, (self.opH_ - self.margin_) * scale);
    }
    self.ClearStyle(context);
    return true;
};

Op.prototype.ClearStyle = function(context){
    //let self = this;
    context.globalAlpha = 1;
    context.fillStyle = null;
    context.strokeStyle = null;
};

Op.prototype.drawLane = function(h, startCycle, endCycle, scale, context, laneName, op, parentStyle){
    let self = this;
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
            color = self.getStyleRule([".lane_" + laneName, ".stage_" + stage.name], "background-color", 1, "#888");
        } else {
            color = parentStyle.color;
        }
        let fontSize = self.getStyleRule([".lane_" + laneName, ".stage_" + stage.name], "font-size", 1, "12px");
        fontSize = parseInt(fontSize) * scale;
        fontSize = fontSize + "px";
        let fontFamily = self.getStyleRule([".lane_" + laneName, ".stage_" + stage.name], "font-family", 1, "MS Gothc");
        let fontStyle = self.getStyleRule([".lane_" + laneName, ".stage_" + stage.name], "font-style", 1, "normal");
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

Op.prototype.getStyleRule = function(selectors, style, sheetIndex, defaultValue){
    let self = this;
    let s = [];
    let copyArray = [];
    while (selectors.length > 1) {
        s.push(selectors.join(" "));
        copyArray.push(selectors.shift());
    }
    copyArray.push(selectors.shift());
    copyArray = copyArray.reverse();
    s = s.concat(copyArray);
    for (let i = 0, len = s.length; i < len; i++) {
        let prop = self.getStyleRuleValue(s[i], style, sheetIndex);
        if (prop) {
            return prop;
        }
    }
    let d = self.getStyleRuleValue(".default", style, sheetIndex);
    if (d) {
        return d;
    }
    return defaultValue;
};

Op.prototype.getStyleRuleValue = function(selector, style, sheetIndex){
    //let self = this;
    let sheet;
    if (sheetIndex != null) {
        sheet = document.styleSheets[ sheetIndex ];
    }
    let sheets = typeof sheet !== "undefined" ? [sheet] : document.styleSheets;
    for (let i = 0, l = sheets.length; i < l; i++) {
        let sheet = sheets[i];
        if( !sheet.cssRules ) { continue; }
        for (let j = 0, k = sheet.cssRules.length; j < k; j++) {
            let rule = sheet.cssRules[k-j-1]; // 後ろの結果を優先する．
            if (rule.selectorText && rule.selectorText.split(",").indexOf(selector) !== -1) {
                if (rule.style[style] == "" || rule.style[style] == null) {
                    continue;
                }
                return rule.style[style];
            }
        }
    }
    return null;
};

module.exports.Op = Op;
