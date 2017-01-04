var ipc = require("electron").ipcRenderer;
var jquery = jQuery;
var Konata = require("./Konata");
var konata = new Konata(null, window.devicePixelRatio);


var index = {};
index.id = 0;
index.order = 0;
index.path = null;






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
