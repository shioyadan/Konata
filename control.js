var jquery = require("./jquery");
const remote = require('electron').remote;
const Menu = remote.Menu;
const MenuItem = remote.MenuItem;

var p_menu = new Menu();
p_menu.append(new MenuItem({ label: 'このタブを半透明化', click: function() { Transparent(true); } }));
p_menu.append(new MenuItem({ label: '透明化を解除', click: function() { Transparent(false); } }));
p_menu.append(new MenuItem({ label: '全体を橙色に', click: function() { Color("#f80"); } }));
p_menu.append(new MenuItem({ label: '全体を青色に', click: function() { Color("#08f"); } }));
p_menu.append(new MenuItem({ label: 'デフォルトの配色', click: function() { Color(null); } }));
//p_menu.append(new MenuItem({ type: 'separator' }));
//p_menu.append(new MenuItem({ label: 'MenuItem2', type: 'checkbox', checked: true }));


var control = {};
control.name = "Controler name space";
control.mouse = false;
control.mouseX = [];
control.mouseY = [];
control.resizeing = false;
control.tabnum = 0;

function Color(color) {
    konata.ParentStyle(index.path, "color", color);
    konata.Draw(index.path);
}

function Transparent (enable) {
    var tabs = jquery("#tabs");
    var tab = tabs.find('[data-path="' + index.path + '"]');
    if (enable) {
        SetOpacity(0.5);
        tab.find("*").css("background-color", "transparent");
    } else {
        SetOpacity(1);
        tab.find("*").css("background-color", "#fff");
    }
}

function SetOpacity(alpha) {
    var tabs = jquery("#tabs");
    var tab = tabs.find('[data-path="' + index.path + '"]');
    //SetZIndex(index.path, 0, true);
    konata.ParentStyle(index.path, "opacity", alpha);
    konata.Draw(index.path);
    //tab.find("*").css("opacity", alpha);
}

function CreateTabMenu (path) {
    var shortPath = path; // なんかタブ上に表示できる程度に加工した名前にしたい。
    var tabs = jquery("#tabs-selector");
    var tab = jquery("<span>" + shortPath + "</span>").appendTo(tabs);
    tabs = tabs.find(".tab-selector");
    tab.attr("data-path", path);
    tab.addClass("tab-selector");
    tab.click(function () {
        var tabs = jquery("#tabs-selector").find(".tab-selector");
        if (!SetZIndex(path, control.tabnum)) {
            return;
        }
        index.path = path;
        tabs.each (function(i, box) {
            var t = jquery(box);
            var p = t.attr("data-path");
            if (p == path) {
                t.css("background-color", "#ddd");
                t.css("min-height", 18);
            } else {
                SetZIndex(p, -1, true);
                t.css("background-color", "#fff");
                t.css("min-height", 16);
            }
        });
    });
}


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
        console.log("Context menu");
        p_menu.popup(remote.getCurrentWindow());
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
            konata.SetTile(index.path);
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
