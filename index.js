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
        control.tabnum++;
        CreateTabMenu(path);
        SetZIndex(path, control.tabnum);
    }
}

function SetZIndex (path, z, relative) {
    var tabs = jquery("#tabs");
    var tab = tabs.find('[data-path="' + path + '"]');
    if (!relative) {
        if (tab.data("zIndex") == z) {
            return false;
        }
    }
    if (relative) {
        z += parseInt(tab.data("zIndex"));
    }
    tab.find("*").css("zIndex", z);
    tab.css("zIndex", z);
    tab.data("zIndex", z);
    return true;
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