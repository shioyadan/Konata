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
    var opH = 25; // スケール1のときの1命令の高さ[px]
    var opW = 25; // スケール1のときの1サイクルの幅[px]
    for (var key in args) {
        this[key] = args[key];
    }

    this.Draw = function (h, startCycle, endCycle, scale, context) {
        if (!context.fillRect) {
            console.log("Not context object");
            return false;
        }
        var top = h * opH * scale;
        context.clearRect(0, top, (endCycle - startCycle) * scale, opH * scale);
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
        var left = l * scale * opW;
        var right = r * scale * opW;
        context.fillStyle = "#888888";
        context.strokeRect(left, top, right - left, opH * scale);
        if (scale >= 0.1) {
            var keys = [];
            for (var key in this.lanes) {
                keys.push(key);
            }
            keys = keys.sort();
            for (var i = 0, len = keys.length; i < len; i++) {
                var key = keys[i];
                this.DrawLane(h, startCycle, endCycle, scale, context, this.lanes[key]);
            }
        }
        return true;
    };

    this.DrawLane = function (h, startCycle, endCycle, scale, context, lane) {
        var top = h * opH * scale;
        for (var i = 0, len = lane.length; i < len; i++) {
            var stage = lane[i];
            if (stage.endCycle == null) {
                stage.endCycle = this.retiredCycle;
            }
            if (stage.endCycle == stage.startCycle) {
                continue;
            }
            if (stage.name == "Rn") {
                context.fillStyle = "#ff88ff"; // ステージの色はなんか別に設定表を作る．
            } else if (stage.name == "F") {
                context.fillStyle = "#ff8888";
            } else if (stage.name == "D") {
                context.fillStyle = "#0088ff";
            } else {
                context.fillStyle = "#888888";
            }
            var l = startCycle > stage.startCycle ? (startCycle - 1) : stage.startCycle; l -= startCycle;
            var r = endCycle >= stage.endCycle ? stage.endCycle : (endCycle + 1); r -= startCycle;
            var left = l * scale * opW;
            var right = r * scale * opW;
            context.fillRect(left, top, right - left, opH * scale);
            context.strokeRect(left, top, right - left, opH * scale);
            left = (stage.startCycle - startCycle) * scale * opW;
            if (scale >= 0.5) {
                context.fillStyle = "#000000";
                context.fillText(stage.name, left + 5, top + opH * scale - 2);
            }
        }
    }
}
module.exports = Op;
