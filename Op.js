function Op(args) {
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
    var m_opH = 25; // スケール1のときの1命令の高さ[px]
    var m_opW = 25; // スケール1のときの1サイクルの幅[px]
    var m_margin = 5; //
    for (var key in args) {
        this[key] = args[key];
    }

    this.Draw = function (h, startCycle, endCycle, scale, context) {
        if (!context.fillRect) {
            console.log("Not context object");
            return false;
        }
        var top = h * m_opH * scale;
        context.clearRect(0, top, (endCycle - startCycle) * scale, m_opH * scale);
        if (this.retiredCycle < startCycle) {
            return true;
        } else if (endCycle < this.fetchedCycle) {
            return false;
        }
        if (this.retiredCycle == this.fetchedCycle) {
            return true;
        }
        var l = startCycle > this.fetchedCycle ? (startCycle - 1) : this.fetchedCycle; l -= startCycle;
        var r = endCycle >= this.retiredCycle ? this.retiredCycle : (endCycle + 1); r -= startCycle;
        var left = l * scale * m_opW;
        var right = r * scale * m_opW;
        if (scale < 0.2) {
            context.strokeStyle = "#888888";
        } else {
            context.strokeStyle = "#333333";
        }
        context.fillStyle = "#888888";
        context.strokeRect(left, top, right - left, (m_opH - m_margin) * scale);
        if (scale >= 0.1) {
            var keys = [];
            for (var key in this.lanes) {
                keys.push(key);
            }
            keys = keys.sort();
            for (var i = 0, len = keys.length; i < len; i++) {
                var key = keys[i];
                this.DrawLane(h, startCycle, endCycle, scale, context, key);
            }
        }
        return true;
    };

    this.DrawLane = function (h, startCycle, endCycle, scale, context, laneName) {
        var lane = this.lanes[laneName];
        var top = h * m_opH * scale;
        for (var i = 0, len = lane.length; i < len; i++) {
            var stage = lane[i];
            if (stage.endCycle == null) {
                stage.endCycle = this.retiredCycle;
            }
            if (stage.endCycle < startCycle) {
                continue;
            } else if (endCycle < stage.startCycle) {
                break; // stage.startCycle が endCycleを超えているなら，以降のステージはこのcanvasに描画されない．
            }
            if (stage.endCycle == stage.startCycle) {
                continue;
            }
            var color = 
            getStyleRuleValue(".lane_" + laneName + " .stage_" + stage.name, "background-color", 1) || 
            getStyleRuleValue(".stage_" + stage.name, "background-color", 1) || 
            getStyleRuleValue(".lane_" + laneName, "background-color", 1) || 
            getStyleRuleValue(".default", "background-color", 1) || "#888";
            var fontSize = getStyleRuleValue(".lane_" + laneName + " .stage_" + stage.name, "font-size", 1) || 
            getStyleRuleValue(".stage_" + stage.name, "font-size", 1) || 
            getStyleRuleValue(".lane_" + laneName, "font-size", 1) || 
            getStyleRuleValue(".default", "font-size", 1) || "12px";
            fontSize = parseInt(fontSize) * scale;
            fontSize = fontSize + "px";
            var fontFamily = getStyleRuleValue(".lane_" + laneName + " .stage_" + stage.name, "font-family", 1) || 
            getStyleRuleValue(".stage_" + stage.name, "font-family", 1) || 
            getStyleRuleValue(".lane_" + laneName, "font-family", 1) || 
            getStyleRuleValue(".default", "font-family", 1) || "MS Gothic";
            var fontStyle = getStyleRuleValue(".lane_" + laneName + " .stage_" + stage.name, "font-style", 1) || 
            getStyleRuleValue(".stage_" + stage.name, "font-style", 1) || 
            getStyleRuleValue(".lane_" + laneName, "font-style", 1) || 
            getStyleRuleValue(".default", "font-style", 1) || "normal";
            var l = startCycle > stage.startCycle ? (startCycle - 1) : stage.startCycle; l -= startCycle;
            var r = endCycle >= stage.endCycle ? stage.endCycle : (endCycle + 1); r -= startCycle;
            var left = l * scale * m_opW;
            var right = r * scale * m_opW;
            var grad = context.createLinearGradient(0,top,0,top+m_opH * scale);
            grad.addColorStop(1, color);
            grad.addColorStop(0, "#eee");
            context.fillStyle = grad;
            context.font = fontStyle + " " + fontSize + " '" + fontFamily + "'";
            context.fillRect(left, top, right - left, (m_opH - m_margin) * scale);
            context.strokeRect(left, top, right - left, (m_opH - m_margin) * scale);
            left = (stage.startCycle - startCycle) * scale * m_opW;
            if (scale >= 0.5) {
                context.fillStyle = "#000000";
                context.fillText(stage.name, left + (m_opW * scale/3), top + (m_opH - m_margin) * scale*3/4);
            }
        }
    };
    
    function getStyleRuleValue(selector, style, sheetIndex) {
        if (sheetIndex != null) {
            var sheet = document.styleSheets[ sheetIndex ];
        }
        var sheets = typeof sheet !== 'undefined' ? [sheet] : document.styleSheets;
        for (var i = 0, l = sheets.length; i < l; i++) {
            var sheet = sheets[i];
            if( !sheet.cssRules ) { continue; }
            for (var j = 0, k = sheet.cssRules.length; j < k; j++) {
                var rule = sheet.cssRules[j];
                if (rule.selectorText && rule.selectorText.split(',').indexOf(selector) !== -1) {
                    return rule.style[style];
                }
            }
        }
        return null;
    }
}
module.exports = Op;
