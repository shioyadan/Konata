var OpToHTML = require("./OpToHTML");
var jquery = require("./jquery");

var control = {};
control.name = "Controler name space";
control.position = 0;
control.left = true;


jquery(window).ready(function(){
    var tab = jquery(".tab");
    var l_window = tab.find(".labels-window");
    var p_window = tab.find(".pipelines-window");
    
    p_window.scroll (function() {
        l_window.scrollTop(p_window.scrollTop());
        ScrollLeft(p_window);
    });
    l_window.scroll (function() {
        p_window.scrollTop(l_window.scrollTop());
    });
});

function ScrollLeft(obj) {
    var prev = control.position;
    var now = obj.scrollTop();
    var height = parseInt(obj.find(".pipeline").css("max-height"));
    var prevIndex = parseInt(prev/height);
    var nowIndex = parseInt(now/height);
    if (control.left && nowIndex != prevIndex) {
        var distance = CalcPipelineDistance(prevIndex, nowIndex);
        var left = obj.scrollLeft();
        obj.scrollLeft(left + distance);
    }
    control.position = now;
}

function CalcPipelineDistance (prev, now) {
    var prevPipeline = jquery(".pipeline:eq(" + prev + ")");
    var nowPipeline = jquery(".pipeline:eq(" + now + ")");
    var pPos = parseInt(prevPipeline.children(".spacer").css("width"));
    var nPos = parseInt(nowPipeline.children(".spacer").css("width"));
    return nPos - pPos;
}

