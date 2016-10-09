var ipc = require("electron").ipcRenderer;
var OpToHTML = require("./OpToHTML");
var jquery = require("./jquery.js");

// 非同期通信
ipc.on('asynchronous-message', function(event, arg) {
    //event.sender.send('asynchronous-reply', 'pong');  // 送信元へレスポンスを返す
    console.log("function:recieved message: " + arg[0]);
    var message = arg[0];
    if (message == 'Draw') {
        var ops = arg[1].ops;
        var tab = jquery(".tab");
        var l_window = tab.find(".labels-window");
        var p_window = tab.find(".pipelines-window");
        l_window.empty(); p_window.empty();
        for (var i = 0; i < ops.length; i++) {
            op = new OpToHTML(ops[i]);
            var label = op.node().find(".labels-parent");
            var pipeline = op.node().find(".pipeline");
            var lineHeight = 24;//pipeline.css("max-height");

            label.css("height", lineHeight + "px");
            pipeline.css("height", lineHeight + "px");
            l_window.append(label);
            p_window.append(pipeline);
        }
    }
});

function Send() {
    ipc.send("asynchronous-message", ["aaa"]);
}