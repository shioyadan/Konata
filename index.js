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
        jquery(".tab").html("");
        for (var i = 0; i < ops.length; i++) {
            op = new OpToHTML(ops[i]);
            //console.log(op.html());
            var label = op.node().find(".labels-parent");
            var pipeline = op.node().find(".pipeline");
            jquery(".labels-window").append(label);
            jquery(".pipelines-window").append(pipeline);
            var lineHeight = pipeline.css("max-height");
            lineHeight = 48;
            console.log(lineHeight);
            jquery(".labels-parent").css("height", lineHeight + "px");
            jquery(".pipeline").css("height", lineHeight + "px");
            //jquery(".pipeline").css("position", "relative");
        }
    }
});

function Send() {
    ipc.send("asynchronous-message", ["aaa"]);
}