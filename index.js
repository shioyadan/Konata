var ipc = require("electron").ipcRenderer;
var OpToHTML = require("./OpToHTML");
var jquery = require("./jquery");

jquery(window).ready(function(){
    var tab = jquery(".tab");
    var l_window = tab.find(".labels-window");
    var p_window = tab.find(".pipelines-window");
    p_window.html("test message");
    p_window.scroll (function() {
        l_window.scrollTop(p_window.scrollTop());
    });
    l_window.scroll (function() {
        p_window.scrollTop(l_window.scrollTop());
    });
    //});
});

// 非同期通信
ipc.on('asynchronous-message', function(event, arg) {
    //event.sender.send('asynchronous-reply', 'pong');  // 送信元へレスポンスを返す
    //console.log("function:recieved message: " + arg[0]);
    var message = arg[0];
    if (message == 'Draw') {
        var ops = arg[1].ops;
        var tab = jquery(".tab");
        var l_window = tab.find(".labels-window");
        var p_window = tab.find(".pipelines-window");
        l_window.empty(); p_window.empty();
        for (var i = 0; i < ops.length; i++) {
            op = new OpToHTML(ops[i]);
            Resize(op.node());
            var label = op.node().find(".labels-parent");
            var pipeline = op.node().find(".pipeline");
            var lineHeight = pipeline.css("max-height");

            label.css("height", lineHeight + "px");
            pipeline.css("height", lineHeight + "px");
            l_window.append(label);
            p_window.append(pipeline);
        }
    }
});


function Resize(node) {
    node.find("[data-width]").each(
        function() {
            var w = 36 * jquery(this).attr("data-width");
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
            var w = 24 * jquery(this).attr("data-height");
            //console.log (jquery(this).attr("class")) 
            jquery(this).css("height", w + "px");
            jquery(this).css("max-height", w + "px");
            jquery(this).css("min-height", w + "px");
            if (w == 0) {
                jquery(this).css("display", "none");
            }
        }
    );
    node.find("[data-relative-pos-left]").each(
        function() {
            var w = 36 * jquery(this).attr("data-relative-pos-left");
            //jquery(this).css("position", "absolute");
            jquery(this).css("left", w + "px");
        }
    );
    node.find("[data-relative-pos-top]").each(
        function() {
            var h = 12 * jquery(this).attr("data-relative-pos-top");
            //console.log("Pos top:", h, "px");
            //jquery(this).css("position", "absolute");
            jquery(this).css("top", h + "px");
        }
    );
}


function Send() {
    ipc.send("asynchronous-message", ["aaa"]);
}