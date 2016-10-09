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
    //console.log(this.text);
    
    this.Process = function () {
        if (this.text == null) {
            // error;
            
            return;
        }
        var kanataData = new KanataData();
        var lines = this.text.split('\n');
        console.log("Process start! Lines:", lines.length);

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var rawDatas = this.ReadLine(line);
            for (var j = 0; j < rawDatas.length; j++) {
                var data = rawDatas[j];
                kanataData.SetDataById(data[0], data[1]);
            }
            //console.log(i);
        }
        console.log("Parse complete");
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
            for (var i = 0; i < mapping[elm[0]].length; i++) {
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
            this.cycle = Number(elm[1]);
        }
        return request;
    };
};

module.exports = OnikiriLog;