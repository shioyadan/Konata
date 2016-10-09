function OnikiriLog (cycle) {
    if (cycle) {
        this.cycle = cycle;
    } else {
        this.cycle = 0;
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