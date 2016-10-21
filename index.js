var ipc = require("electron").ipcRenderer;
var jquery = require("./jquery");
var jQuery = jquery;
var Konata = require("./Konata");
var konata = new Konata(null, window.devicePixelRatio);


var index = {};
index.id = 0;
index.order = 0;
index.path = "./vis.c0.log";


function Send(path) {
    if (!path) {
        return;
    }
    index.path = path;
    console.log(path);
    var tabs = jquery("#tabs");
    if ( konata.InitDraw(path, tabs) ) {
        SetControl(tabs);
        WindowResize();
    }
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
    konata.Draw(index.path);
    index.order++;
}

function OpenFile(){
    ipc.send('index.js', {request:"Open file"});
}

ipc.on('main.js', function(event, args) {
    var request = args.request;
    if (request == "Open file") {
        var path = args.path;
        console.log(path);
        if (path) {
            Send(path);
        }
    }
});