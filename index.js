var ipc = require("electron").ipcRenderer;
var jquery = require("./jquery");
var jQuery = jquery;
var Konata = require("./Konata");
var konata = new Konata(null, window.devicePixelRatio);


var index = {};
index.id = 0;
index.path = "./vis.c0.log";


function Send() {
    var path = index.path;
    var pos = {};
    var scale = 1;
    if (index.id == 0) {
        pos = {top:0, left:0};
    } else {
        pos = {top:0, left:0};
        scale = index.scale/4;
    }
    index.pos = pos;
    index.scale = scale;
    console.log(pos.top, pos.left);

    var tab = konata.Draw(path, control.position, jquery("#tabs"));
    console.log(scale);
    SetControl(tab);
    index.id++;
}

