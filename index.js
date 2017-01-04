var ipc = require("electron").ipcRenderer;
var jquery = jQuery;
var Konata = require("./Konata");
var konata = new Konata(null, window.devicePixelRatio);


var index = {};
index.id = 0;
index.order = 0;
index.path = null;


function Send(path) {
    if (!path) {
        return;
    }
    console.log(path);
    var tabs = jquery("#tabs");
    if ( konata.InitDraw(path, tabs) ) {
        SetControl(tabs);
        WindowResize();
        control.tabnum++;
        CreateTabMenu(path);
        SetZIndex(path, control.tabnum);
        control.bind[path] = [];
        MoveFront(index.path);
        MoveFront(path);
        index.path = path;
    }
}

function Close(path) {
    konata.Close(path);
    jquery('[data-path="' + path + '"]').remove();
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

ipc.on('main.js', function(event, args) {
    var request = args.request;
    if (request == "Transparent") {
        Transparent(args.enable, args.all);
    }
    if (request == "NextTab") {
        NextTab(args.dir);
    }
    if (request == "Retina") {
        konata.RetinaSwitch();
        konata.Draw(index.path);
    }
});