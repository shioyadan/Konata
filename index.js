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

    var tab = konata.Draw(path, jquery("#tabs"));
    SetControl(tab);
}

