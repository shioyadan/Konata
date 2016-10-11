var fs = require('fs');
var KanataData = require("./KanataData");
var Op = require("./Op");

function OnikiriLog (path) {
    this.cycle = 0;
    this.path = path;
    if (path == null) {
        return;
    }
    var buf = fs.readFileSync(path);
    this.text = buf.toString();

    this.AsyncProcess = function(callback) {
        if (this.text == null) {
            // error;
            return;
        }
        this.kanataData = new KanataData();
        this.lines = this.text.split('\n');
        max = 500;
        while (this.lines.length > 0) {
            this.AsyncReadLines(max).then(function(ops){callback(ops)});
            max += 2000;
        }
    };

    this.AsyncReadLines = function(max) {
        var i = 0;
        var len = this.lines.length;
        while (len - i > 0 && i < max) {
            var rawDatas = this.ReadLine(this.lines.shift());
            for (var j = 0, len_in = rawDatas.length; j < len_in; j++) {
                var data = rawDatas[j];
                this.kanataData.SetDataById(data[0], data[1]);
            }
            i++;
        }
        var ops = [];
        var linesEmpty = !(len - i > 0);
        for (var i = 0, len = this.kanataData.ops.length; i < len; i++) {
            var op = this.kanataData.ops[0];
            if (op.retired || linesEmpty) {
                ops.push(op);
                this.kanataData.ops.shift();
            } else {
                break;
            }
        }
        return new Promise(function(callback) {callback(ops);});
    }

    this.Process = function (callback) {
        if (this.text == null) {
            // error;
            return;
        }
        var kanataData = new KanataData();
        var lines = this.text.split('\n');
        console.log("Process start! Lines:", lines.length);
        for (var i = 0, len = lines.length; i < len; i++) {
            var line = lines[i];
            var rawDatas = this.ReadLine(line);
            for (var j = 0, len_in = rawDatas.length; j < len_in; j++) {
                var data = rawDatas[j];
                kanataData.SetDataById(data[0], data[1]);
            }
        }
        console.log("Parse complete");
        callback(kanataData.ops);
        return kanataData;
    }

    this.ReadLine = function (line) {
        var request = [];
        var mapping = {
            "I":["fetch"],
            "L":["label"],
            "S":["stage_b"],
            "E":["stage_e"],
            "R":["retire"],
            "W":["prod", "cons"],
        };
        // 末尾に意味のないTabが付いてるとデータが壊れるので、消す。
        line = line.trim();
        var TAB = String.fromCharCode(9);
        var elm = line.split(TAB);
        elm.push(this.cycle);
        var id = elm[1];
        if (mapping[elm[0]]) {
            for (var i = 0, len = mapping[elm[0]].length; i < len; i++) {
                var key = mapping[elm[0]][i];
                var args = elm.slice(2);
                if (key == "cons") {
                    var tmp = args[0];
                    args[0] = id;
                    id = tmp;
                }
                var array = {};
                array[key] = args;
                request.push([id, array]);
            }
        }
        else if (elm[0] == "C") {
            this.cycle += Number(elm[1]);
        } else if (elm[0] == "C=") {
            //this.cycle = Number(elm[1]);
            this.cycle = 0;
        }
        return request;
    };
};

module.exports = OnikiriLog;
