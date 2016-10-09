var Op = require("./Op.js");

function OpToHTML (op) {
    this.op = op;
    this.published = false;
    this.ordered = false;
    
    this.node = function () {
        if (!this.published) {
            this.MakeHTML();
        }
        return this.root;
    }
    this.html = function () {
        if (!this.published) {
            this.MakeHTML();
        }
        return this.root.prop('outerHTML');;
    };
    
    this.MakeHTML = function () {
        var info = this.op.info;
        var start = Number(info.fetch[0][2]);
        var root = jquery("<div></div>", {"class":"line", "id":"line_" + this.id});
        this.root = root;
        var labelsParent = jquery("<div></div>", {"class":"labels-parent"});
        var spacer = jquery("<span></span>", {"class":"spacer"});
        var pipeline = jquery("<div></div>", {"class":"pipeline"});
        var block = jquery("<span></span>", {"class":"block"});
        spacer.attr("data-width", start);
        //block.attr("data-relative-pos-left", start);
        root.append(labelsParent);
        pipeline.append(spacer);
        pipeline.append(block);
        root.append(pipeline);
        var op = jquery("<div></div>", {"id":"op_" + this.op.id, "class":"op"});
        block.append(op);
        var end, flush;
        if (info.retired) {
            end = info.retire[0][2];
            flush = info.retire[0][1];
            op.attr("data-width", end - start);
        }
        var labels = info.label;
        // Set labels
        for (var i = 0; i < labels.length; i++) {
            var label = jquery("<div></div>", {"class":"label"});
            label.addClass("type_" + labels[i][0]);
            label.text(labels[i][1]);
            labelsParent.append(label);
        }
        // Set lanes
        block.append(this.MakeLanesHTML(start));
        // Set producers, consumers
        
        this.published = true;
        //this.Resize();
        return root;
    };
    
    this.MakeLanesHTML = function (start) {
        var lanes = this.OrderedLane();
        var activeNum = this.GetViewedLaneNum();
        var height = 1/activeNum;
        var lanesParent = jquery("<div></div>", {"class": "lanes-parent"});
        for (var i = 0; i < lanes.length; i++) {
            var lane = jquery("<div></div>", {"class":"lane"});
            var prevStage;
            lane.addClass("lane_" + lanes[i][0][0]);
            for (var j = 0; j < lanes[i].length; j++) {
                var array = lanes[i][j];
                var stage = jquery("<span></span>", {"class":"stage"});
                stage.addClass("stage_" + array[1]); // Stage name
                stage.text(array[1]);
                stage.attr("data-begin", array[2]); // Stage start
                if (array[3]) {
                    stage.attr("data-end", array[3]); // Stage end
                    stage.attr("data-width", array[3] - array[2]);
                }
                if (prevStage != null && prevStage.attr("data-end") == null) {
                    prevStage.attr("data-end", array[2]);
                    prevStage.attr("data-width", array[2] - prevStage.attr("data-begin"));
                }
                if (j == 0 && (Number(array[2]) - start != 0)) {
                    var laneSpacer = jquery("<span></span>", {"class":"spacer"});
                    laneSpacer.attr("data-width", Number(array[2]) - start);
                    lane.append(laneSpacer);
                }
                stage.attr("data-height", height);
                lane.append(stage);
                prevStage = stage;
            }
            
            lanesParent.append(lane);
        }
        return lanesParent;
    };
    
    this.GetViewedLaneNum = function () {
        var lanes = this.OrderedLane();
        var actives = 0;
        for (var i = 0; i < lanes.length; i++) {
            if (this.IsViewedLane(lanes[i])) {
                actives++;
            }
        }
        return actives;
    };
    this.IsViewedLane = function (lane) {
        return true;
    };

    // stage_b: [[Lane1, stage, start], [Lane2, stage, start], ...]
    // stage_e: [[Lane2, stage ,end], [Lane1, stage, end], ...]
    // のようにただの出現順になっているLaneに関する二重配列を
    // [[[Lane1, stage, start, end], [Lane1, stage, start, end]...],
    // [[Lane2, stage, start, end], [Lane2, stage, start, end]...]]
    // みたいな三重配列に変換する。
    // この際、二つほど注意点がある。
    // ・Laneの順序が一意に決まるようにする。 <- レーンごとに表示するときの見やすさのため。
    // ・ベースとなるLaneが必ず一番最初に来るようにする。
    this.OrderedLane = function (optBaseLane) {
        if (this.ordered) {
            return this.lane;
        }
        var baseLane = optBaseLane || "0";
        var lanes = {};
        var stage_b = this.op.info.stage_b;
        var stage_e = this.op.info.stage_e;
        // まずは、Lane名ごとに配列を分ける。
        for (var i = 0; i < stage_b.length; i++) {
            var info = stage_b[i];
            var name = info[0];
            if(lanes[name] == null) {
                lanes[name] = [];
            }
            lanes[name].push(info);
        }
        // ステージの終了情報をくっつける
        for (var i = 0; i < stage_e.length; i++) {
            var info = stage_e[i];
            var name = info[0];
            var stage = info[1];
            var endCycle = info[2];
            var found = false;
            for (var j = 0; j < lanes[name].length; j++) {
                var lane = lanes[name][j];
                if (lane[1] == stage) {
                    lane.push(endCycle);
                    found = true;
                    break;
                }
            }
            if (!found) {
                // ステージの終了だけがダンプされていることはありえない。
                // エラー処理;
                return;
            }
        }
        // 並び順が一意になるようにソート。
        var keys = [];
        for (var key in lanes) {
            keys.push(key);
        }
        keys.sort();
        
        var lane = [];
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (key == baseLane) {
                // Base laneならば先頭に。
                lane.unshift(lanes[key]);
            } else {
                // それ以外はそのまま。
                lane.push(lanes[key]);
            }
        }
        this.lane = lane;
        this.ordered = true;
        return this.lane;
    };
}
module.exports = OpToHTML;