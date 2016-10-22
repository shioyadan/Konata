var jquery = require("./jquery");
const remote = require('electron').remote;
const Menu = remote.Menu;
const MenuItem = remote.MenuItem;

var p_menu = new Menu();
p_menu.append(new MenuItem({ label: '全体を半透明化', click: function() { Transparent(true); } }));
p_menu.append(new MenuItem({ label: '背景だけ透明化', click: function() { Transparent(true, true); } }));
p_menu.append(new MenuItem({ label: '透明化を解除', click: function() { Transparent(false); } }));
p_menu.append(new MenuItem({ label: '全体を橙色に', click: function() { Color("#f80"); } }));
p_menu.append(new MenuItem({ label: '全体を青色に', click: function() { Color("#08f"); } }));
p_menu.append(new MenuItem({ label: 'デフォルトの配色', click: function() { Color(null); } }));


var control = {};
control.name = "Controler name space";
control.mouse = false;
control.mouseX = [];
control.mouseY = [];
control.resizeing = false;
control.tabnum = 0;
control.bind = {};

function Bind(path) {
    //var path = control.temp;
    if (index.path == path) {
        return;
    }
    if (control.bind[index.path]) {
        console.log(control.bind[index.path]);
    }
    var i = jquery.inArray(path, control.bind[index.path]);
    if (i < 0) {
        control.bind[index.path].push(path);
    }
}

function Release(path) {
    //var path = control.temp;
    var i = jquery.inArray(path, control.bind[index.path]);
    if (i > -1) {
        control.bind[index.path].splice(i, 1);
    }

}

function Color(color) {
    konata.ParentStyle(index.path, "color", color);
    konata.Draw(index.path);
}

function Transparent (enable, all) {
    var tabs = jquery("#tabs");
    var tab = tabs.find('[data-path="' + index.path + '"]');
    if (enable) {
        if (!all) {
            SetOpacity(0.5);
        } else {
            SetOpacity(1);
        }
        tab.find("*").css("background-color", "transparent");
    } else {
        SetOpacity(1);
        tab.find("*").css("background-color", "#fff");
    }
}

function SetOpacity(alpha) {
    var tabs = jquery("#tabs");
    var tab = tabs.find('[data-path="' + index.path + '"]');
    konata.ParentStyle(index.path, "opacity", alpha);
    konata.Draw(index.path);
}

function CreateTabMenu (path) {
    var array = path.split("/");
    var shortPath = array[array.length - 1]; // なんかタブ上に表示できる程度に加工した名前にしたい。
    var tabs = jquery("#tabs-selector");
    var tab = jquery("<span>" + shortPath + "</span>").appendTo(tabs);
    tabs = tabs.find(".tab-selector");
    tab.attr("data-path", path);
    tab.addClass("tab-selector");

    // コンテキストメニューの内容
    var t_menu = new Menu();
    t_menu.append(new MenuItem({label: "スクロール・ズームを連携", 
        click: function() {
            Bind(path);
        }
    }));
    t_menu.append(new MenuItem({label: "連携を解除",
        click:function() {
            Release(path);
        }
    }));


    // 各種イベントを設定
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
                t.css("min-height", 20);
            } else {
                SetZIndex(p, -1, true);
                t.css("background-color", "#fff");
                t.css("min-height", 18);
            }
        });
    });
    // 右クリック
    tab.contextmenu(function () {
        t_menu.popup(remote.getCurrentWindow());
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
    konata.Zoom(index.path, scale);
    console.log("Complete");
    control.resizeing = false;
}

function MoveTo (diff, adjust) {
    konata.MoveTo(diff, index.path, adjust);
    for (var i = 0, len = control.bind[index.path].length; i < len; i++) {
        var path = control.bind[index.path][i];
        konata.MoveTo(diff, path, adjust);
    }
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
            var scroll = 3/konata.GetScale(index.path);
            if (deltaY < 0) {
                deltaY = scroll;
            } else {
                deltaY = -scroll;
            }
            if (deltaX < 0) {

            } else {

            }
            MoveTo({top:deltaY, left:0}, true);
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
            diffY = -diffY/25/konata.GetScale(index.path);
            MoveTo({left:diffX, top:diffY},  null);
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
