var ipc = require("electron").ipcRenderer;
var OpToHTML = require("./OpToHTML");
var jquery = require("./jquery");
var jQuery = jquery;

// 非同期通信
ipc.on('asynchronous-message', function(event, arg) {
    //event.sender.send('asynchronous-reply', 'pong');  // 送信元へレスポンスを返す
    //console.log("function:recieved message: " + arg[0]);
    var message = arg[0];
    if (message == 'Draw') {
        var ops = arg[1];
        var tab = jquery(".tab");
        var l_window = tab.find(".labels-window");
        var p_window = tab.find(".pipelines-cell");
        //l_window.empty(); p_window.empty();
        for (var i = 0, len = ops.length; i < len; i++) {
            op = new OpToHTML(ops[i]);
            var label = op.node().find(".labels-parent");
            var pipeline = op.node().find(".pipeline");
            var lineHeight = pipeline.css("max-height");
            p_window.attr("data-height", i);
            label.attr("data-height", 1);
            pipeline.attr("data-height", 1);
            l_window.append(label);
            p_window.append(pipeline);
        }
        Resize(tab, control.zoom);
    }
});


function Resize(node, optBaseSize) {
    var baseSize; // javascript的にここで宣言する意味は特にない。
    if (optBaseSize == null) {
        baseSize = {"w":0.3, "h": 0.2};
    } else {
        baseSize = optBaseSize;
    }
    node.find("[data-width]").each(
        function() {
            var w = baseSize.w * jquery(this).attr("data-width");
            //console.log (jquery(this).attr("class")) 
            jquery(this).css("width", w + "px");
            jquery(this).css("max-width", w + "px");
            jquery(this).css("min-width", w + "px");
            if (w == 0) {
                jquery(this).css("display", "none");
            }
        }
    );
    node.find("[data-height]").each(
        function() {
            var h = baseSize.h * jquery(this).attr("data-height");
            //console.log (jquery(this).attr("class")) 
            jquery(this).css("height", h + "px");
            jquery(this).css("max-height", h + "px");
            jquery(this).css("min-height", h + "px");
            if (h == 0) {
                jquery(this).css("display", "none");
            }
        }
    );
    var h = baseSize.h * node.find("[data-height]").attr("data-height");
    if (h < 14) {
        node.find(".label").css("visibility", "hidden");
        //node.find(".stage").css("visibility", "hidden");
    } else {
        node.find(".label").css("visibility", "visible");
        //node.find(".stage").css("visibility", "visible");
    }
    node.find("[data-relative-pos-left]").each(
        function() {
            var w = baseSize.w * jquery(this).attr("data-relative-pos-left");
            //jquery(this).css("position", "absolute");
            jquery(this).css("left", w + "px");
        }
    );
    node.find("[data-relative-pos-top]").each(
        function() {
            var h = baseSize.h * jquery(this).attr("data-relative-pos-top");
            //console.log("Pos top:", h, "px");
            //jquery(this).css("position", "absolute");
            jquery(this).css("top", h + "px");
        }
    );
}


function Send() {
    ipc.send("asynchronous-message", ["aaa"]);
}