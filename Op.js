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
        //var unit = 25; // 1 cycle width(or an op height) = unit * scale
        var top = h * opH * scale;
        context.clearRect(0, top, (endCycle - startCycle) * scale, opH * scale);
        if (this.retiredCycle < startCycle) {
            return true;
        } else if (endCycle < this.fetchedCycle) {
            return false;
        }
        var l = startCycle > this.fetchedCycle ? (startCycle - 1) : this.fetchedCycle; l -= startCycle;
        var r = endCycle >= this.retiredCycle ? this.retiredCycle : (endCycle + 1); r -= startCycle;
        var left = l * scale * opW;
        var right = r * scale * opW;
        context.fillStyle = "#888888";
        context.strokeRect(left, top, right - left, opH * scale);
        if (scale >= 0.5) { // これより小さいスケールだと見えないからいらない。
            left = (this.fetchedCycle - startCycle) * scale * opW;
            context.fillText(this.id + " " + this.fetchedCycle + " " + this.retiredCycle, left + 5, top + opH * scale - 2);
        }
        //console.log("Drawn!");
        return true;
    };
}
module.exports = Op;
