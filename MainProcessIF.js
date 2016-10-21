function MainProcessIF (that) {
    this.that = that; // Konataオブジェクト
    this.name = "MainProcessIF";
    this.path = null;
    var ipc = require("electron").ipcRenderer;

    this.SetFile = function (path) {
        this.path = path;
        return false;
        //console.log("Send message now");
        var response = ipc.sendSync('Konata', {request:"Please parser", path:path});
        console.log("Recieve response:", response);
        if (response == "Success") {
            return true;
        }
        return false;
    };

    this.GetName = function () {
        return "Main process";
    };

    this.GetOp = function (id) {
        var op = ipc.sendSync('Konata', {request:"GetOp", path:this.path, id:id});
        return op;
    };
}

module.exports = MainProcessIF;
