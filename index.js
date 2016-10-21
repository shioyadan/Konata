var ipc = require("electron").ipcRenderer;
var jquery = require("./jquery");
var jQuery = jquery;
var Konata = require("./Konata");
var konata = new Konata(null, window.devicePixelRatio);


var index = {};
index.id = 0;
index.order = 0;
index.path = "./vis.c0.log";


function Send() {
    var path = index.path;

    var tab = konata.Draw(path, jquery("#tabs"));
    SetControl(tab);
    WindowResize();
}

function Change() {
    var tabs = jquery("#tabs").children(".tab");
    var len = tabs.length;
    tabs.each(function(i, box) {
        var tab = jquery(box);
        var z = (index.order + i) % len
        tab.find("*").css("zIndex", z );
        if (z == len - 1) {
            // 最前面にあるオブジェクトを操作する．
            index.path = tab.attr("data-path");
        }
    });
    if (len < 1) {
        return;
    }
    konata.Draw(index.path, tabs);
    index.order++;
}

