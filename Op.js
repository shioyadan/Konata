var jquery = require("./jquery");
//if(!window || !window.document) {
//    window = require('jsdom').createWindow();
//    window.document = require('jsdom').jsdom();

function Op(id) {
    if (id == null) {
        // エラー処理
    }
    this.id = id;
    this.info = {};
    //this.root = jquery("<div></div>");//, {"class":"op", "id":"line_" + id});
    this.published = true;
    this.retired = false;
    this.lane = [];
    this.ordered = true;
    
    this.SetData = function (args) {
        if (this.retired) {
            // エラー処理;
            return;
        }
        this.published = false;
        for (var key in args) {
            var elm = args[key];
            switch(key) {
                case "label":  // [Type, "message", Cycle] (Type:0 or 1)
                case "fetch":  // fetch: [GID, TID, Cycle]
                case "retire": // retire: [RID, Commit/Flush, Cycle]
                case "prod":   // prod: [Consumer ID, Type, Cycle]
                case "cons":   // cons: [Producer ID, Type, Cycle]
                case "stage_b":
                //    this.SetInfoAsArray(key, elm);
                //    break;
                case "stage_b": // stage_b: [Lane, Stage name, Cycle]
                //    this.SetStageBegin(key, elm);
                //    break;
                case "stage_e": // stage_e: [Lane, Stage name, Cycle]
                //    this.SetStageEnd(key, elm);
                //    break;
                    this.SetInfoAsArray(key, elm);
                    break;
                default:
                    break;
            }
            if (key == "retire") {
                this.retired = true;
            } else if (key.match(/^stage_(?:b|e)$/)) {
                this.ordered = false;
            }
        } 
    };
    
    this.SetInfoAsArray = function(key, elm) {
        var info = this.info;
        if (info[key] == null) {
            info[key] = [elm];
        } else {
            info[key].push(elm);
        }
    };
    
    this.PrintOpInfo = function () {
        for (var key in this.info) {
            console.log(key + ": " + this.info[key]);
        }
    };

    

}
module.exports = Op;
