var jquery = require("./jquery");

var control = {};
control.name = "Controler name space";
control.mouse = false;
control.mouseX = [];
control.mouseY = [];
control.resizeing = false;

function WindowResize(draw) {
    var tab = jquery(".tab");
    if (tab.length == 0) {
        return;
    }
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
    var path = index.path;
    if (draw) {
        konata.SetTile();
        konata.Draw(path,jquery("#tabs"));
    }
}

function Zoom(dir) {
    if (control.resizeing) {
        return;
    }
    console.log("Zoom", dir);
    control.resizeing = true;
    if (dir) {
        var scale = 2;
    } else {
        var scale = 0.5
    }
    konata.SetTile(index.path);
    konata.Zoom(index.path, scale);
    console.log("Complete");
    control.resizeing = false;
}

jquery(window).ready(function(){
    jquery(window).resize(function() {
        WindowResize();
    });
    WindowResize();
});

function SetControl (tab) {
    if (tab.length == 0) {
        return;
    }
    var l_window = tab.find(".labels-window");
    var p_window = tab.find(".pipelines-window");
    var w_sizing = tab.find(".window-sizing");

    p_window.scroll (function() {
        // ラベルウィンドウとパイプラインウィンドウのスクロールを同期
    });
    p_window.dblclick(function(){
        console.log("Double click!");
        Zoom(true);
    });
    p_window.contextmenu(function(){
    });
    p_window.mousewheel(function(e, delta, deltaX, deltaY){
        if (event.preventDefault) {
            // デフォルトのスクロール処理をキャンセル
            event.preventDefault();
        }
        if (e.ctrlKey) {
            if (deltaY > 0) {
                Zoom(true);
            } else {
                Zoom(false);
            }
        } else {
            konata.SetTile(index.path);
            var scroll = 3/konata.GetScale(index.path);
            if (deltaY < 0) {
                deltaY = scroll;
            } else {
                deltaY = -scroll;
            }
            if (deltaX < 0) {

            } else {

            }
            konata.MoveTo({top:deltaY, left:0}, index.path, true);
        }
    });
    OnDrag(p_window);

    w_sizing.draggable({
        axis:'x'
    });
    w_sizing.on("drag",function() {
        WindowResize(false);
    });
    w_sizing.on("dragstop",function() {
        WindowResize(true);
    });
    

    l_window.mousewheel(function(e, delta, deltaX, deltaY){
    });
    l_window.scroll (function() {
        // ラベルウィンドウとパイプラインウィンドウのスクロールを同期
    });
    l_window.dblclick(function(){
        //Zoom(true);
    });
}

function Sum(array) {
    var sum = 0;
    for (var i = 0, len = array.length; i < len; i++) {
        sum += array[i];
    }
    return sum;
}

function OnDrag (obj) {
    obj.on("mousedown", function (e) {
        control.mouse = true;
        control.mouseX = [e.screenX];
        control.mouseY = [e.screenY];
    });
    obj.on("mousemove", function (e) {
        if (control.mouse) {
            var oldX = Average(control.mouseX)
            var oldY = Average(control.mouseY)
            control.mouseY.push(e.screenY); // 値に多少のブレがあっても平滑化すればいいかなと。
            control.mouseX.push(e.screenX); // 今となってはあまり意味がないかもしれない。
            if (control.mouseX.length > 1) {
                control.mouseX.shift();
            }
            if (control.mouseY.length > 1) {
                control.mouseY.shift();
            }
            var diffY = Average(control.mouseY) - oldY;
            var diffX = Average(control.mouseX) - oldX;
            diffX = -diffX/25/konata.GetScale(index.path);
            diffY = -diffY/25/konata.GetScale(index.path)
            konata.SetTile();
            konata.MoveTo({left:diffX, top:diffY}, index.path, null);
        }
    });
    obj.on("mouseup", function(e) {
        if (control.mouse) {
        }
        control.mouse = false;
    });
    obj.on("mouseleave", function(e) {
    });
}

function Average (array) {
    return Sum(array)/array.length;
}
