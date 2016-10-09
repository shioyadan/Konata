var Op = require("./Op");

function KanataData() {
    this.ops = [];
    
    this.Push = function(id, args) {
        if (id == null) {
            // エラー処理;
            return;
        }
        op = new Op(id, args);
        this.ops.push(op);
        return op;
    };
    
    this.SetDataById = function(id, args) {
        var op = this.GetOpById(id);
        if (op == null) {
            op = this.Push(id, args);
        }
        op.SetData(args);
    };
    
    this.GetOpById = function(id) {
        var ops = this.ops;
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (op.id == id) {
                return op;
            }
        }
        return null;
    };
    
    this.GetDataById = function(id, arg) {
        if (arg == null) {
            return this.GetOpById(id);
        }
        return this.GetOpById(id).info[arg];
    };

    this.Print = function () {
        var ops = this.ops;
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            op.PrintOpInfo();
        }
    }
}

module.exports = KanataData;
