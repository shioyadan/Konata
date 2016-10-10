var OpToHTML = require("./OpToHTML");
var jquery = require("./jquery");

jquery(window).ready(function(){
    var tab = jquery(".tab");
    var l_window = tab.find(".labels-window");
    var p_window = tab.find(".pipelines-window");
    p_window.scroll (function() {
        l_window.scrollTop(p_window.scrollTop());
        
    });
    l_window.scroll (function() {
        p_window.scrollTop(l_window.scrollTop());
    });
    //});
});
