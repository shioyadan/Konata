var OpToHTML = require("./OpToHTML");
var jquery = require("./jquery");

var control = {};
control.name = "Controler name space";
control.position = 0;
control.left = true;
control.mouse = false;
control.mouseX = Array(0,0);
control.mouseY = Array(0,0);


function WindowResize() {
    var tab = jquery(".tab");
    var l_window = tab.find(".labels-window");
    var p_window = tab.find(".pipelines-window");
    var w_sizing = tab.find(".window-sizing");
    var offset = w_sizing.offset();
    var l_width = offset.left - parseInt(l_window.css("left"));
    var p_left = offset.left + parseInt(w_sizing.css("width"));
    var p_width = jquery(window).width() - p_left - 5;
    l_window.css("width", l_width + "px");
    p_window.css("left", p_left + "px");
    p_window.css("width", p_width + "px");
    //console.log(jquery(window).width());
}

jquery(window).ready(function(){
    var tab = jquery(".tab");
    var l_window = tab.find(".labels-window");
    var p_window = tab.find(".pipelines-window");
    var w_sizing = tab.find(".window-sizing");
    var p_cell = tab.find(".pipelines-cell");
    
    p_window.scroll (function() {
        if (control.mouse) {
            //return;
        }
        l_window.scrollTop(p_window.scrollTop());
        ScrollLeft(p_window);
    });
    l_window.scroll (function() {
        p_window.scrollTop(l_window.scrollTop());
    });
    
    w_sizing.draggable({
        axis:'x'
    });
    w_sizing.on("drag",function() {
        WindowResize();
    });
    w_sizing.on("dragstop",function() {
        WindowResize();
    });
    jquery(window).resize(function() {
        WindowResize();
    });
    OnDrag(p_cell);
});

function Sum(array) {
    var sum = 0;
    for (var i = 0, len = array.length; i < len; i++) {
        sum += array[i];
    }
    return sum;
}

function OnDrag (obj) {
    var tab = jquery(".tab");
    var p_window = tab.find(".pipelines-window");
    obj.on("mousedown", function (e) {
        console.log("pipeline cell click!");
        control.mouse = true;
        control.initialX = e.screenX;
        control.initialY = e.screenY;
        control.mouseX = [e.screenX];
        control.mouseY = [e.screenY];
        control.positionY = p_window.scrollTop();
        control.positionX = p_window.scrollLeft();
    });
    obj.on("mousemove", function (e) {
        console.log("mouse move");
        if (control.mouse) {
            var top = control.positionY;
            var left = control.positionX;
            var oldX = control.initialX;
            var oldY = control.initialY;
            control.mouseY.push(e.screenY); // 値に多少のブレがあっても平滑化すればいいかなと。
            control.mouseX.push(e.screenX); // 今となってはあまり意味がないかもしれない。
            if (control.mouseX.length > 5) {
                control.mouseX.shift();
            }
            if (control.mouseY.length > 5) {
                control.mouseY.shift();
            }
            var diffY = Average(control.mouseY) - oldY;
            var diffX = Average(control.mouseX) - oldX;
            p_window.scrollTop(top - diffY);
            p_window.scrollLeft(left - diffX);
            //console.log("mouse move", control.mouseY, control.mouseX);
            console.log();
        }
    });
    obj.on("mouseup", function(e) {
        console.log("mouse release!");
        control.mouse = false;
    });
    obj.on("mouseleave", function(e) {
        //console.log("mouse release!");
        //control.mouse = false;
    });
}

function Average (array) {
    return Sum(array)/array.length;
}

function ScrollLeft(obj) {
    var height = parseInt(obj.find(".pipeline").css("max-height"));
    var prevIndex = control.position;
    var now = obj.scrollTop() + height/2;
    var nowIndex = parseInt(now/height);
    if (control.left && !control.mouse && nowIndex != prevIndex) {
        var distance = CalcPipelineDistance(prevIndex, nowIndex);
        var left = obj.scrollLeft();
        obj.scrollLeft(left + distance);
    }
    control.position = nowIndex;
}

function CalcPipelineDistance (prev, now) {
    var prevPipeline = jquery(".pipeline:eq(" + prev + ")");
    var nowPipeline = jquery(".pipeline:eq(" + now + ")");
    var pPos = parseInt(prevPipeline.children(".spacer").css("width"));
    var nPos = parseInt(nowPipeline.children(".spacer").css("width"));
    return nPos - pPos;
}

