let fs = require("fs");
let remote = require("@electron/remote");

class Config{
    constructor(){
        // 最後が _ で終わってるメンバは保存/読み込みを行わない
        this.DIR_ = remote.app.getPath("userData") + "/konata";
        this.FILE_NAME_ = this.DIR_ + "/config.json";


        // デフォルトの設定
        this.theme = "dark";
        this.VALID_THEME_LIST_ = [
            "light", "dark"
        ];
        this.THEME_STYLE_LIST = {
            dark:   "./theme/dark/style.json",    
            light:  "./theme/light/style.json", 
        };
        this.THEME_CSS_LIST = {
            dark:   "./theme/dark/style.css",    
            light:  "./theme/light/style.css", 
        };

        this.colorScheme = "Auto";
        /*
        this.VALID_COLOR_SCHEME_ = [
            "Auto", "Unique"
        ];*/

        // Window/Splitter position
        this.windowBounds = {
            x: 100,
            y: 100,
            width: 800,
            height: 600
        };
        this.splitterPosition = 450;

        // 描画モードの切り替え閾値
        this.drawDetailedlyThreshold = 1;   // レーンの高さがこれより小さい時はステージの描画を省略
        this.drawDependencyThreshold = 2 + 2;   // 枠1ピクセルを除いて内部があるかどうか
        this.drawFrameThreshold = 2 + 2;
        this.drawTextThreshold = 8 + 2; // 

        this.drawZoomFactor = 1; // ズーム時の拡大変化率


        // 
        this.depArrowType = "insideLine";
        this.VALID_DEP_ARROW_TYPES_ = [
            "insideLine", "leftSideCurve", "notShow"
        ];

        /** @type {string[]} */
        this.recentLoadedFiles = [];

        /** @type {Object<string, number>[]} */
        this.bookmarks = [];
        for (let i = 0; i < 10; i++) {
            this.bookmarks.push({
                x: 0,
                y: 0,
                zoom: 0
            });
        }

        /** The history of command pallettes  
         * @type {string[]} */
        this.commandHistory = [];
        this.maxCommandHistoryNum = 20;

        this.customColorSchemes = {
            "Custom": {
                "enable": 1,
                "defaultColor": {"h": "100", "s": "auto", "l": "auto"},
                "0": {
                    "F":    {"h": "0", "s": "auto", "l": "auto"},
                    "Rn":   {"h": "60", "s": "auto", "l": "auto"},
                    "Dc":   {"h": "120", "s": "auto", "l": "auto"},
                    "Is":   {"h": "180", "s": "auto", "l": "auto"},
                    "Cm":   {"h": "240", "s": "auto", "l": "auto"},
                    "f":    {"h": "0", "s": "0", "l": "auto"},
                },
                "1":  {
                    "stl":    {"h": "0", "s": "0", "l": "auto"},
                }
            }
        };

        // 設定読み込み
        this.load();
    }

    /** 
     * @param {string} name
     * @param {array} validList
     */
    check_(name, validList){
        let value = this[name];
        let found = false;
        for (let i of validList) {
            if (i == value) {
                found = true;
            }
        }
        if (!found) {
            this[name] = validList[0];
        }
    }

    get configDir(){
        return this.DIR_;
    }

    /** @param {string} fileName */
    onLoadFile(fileName){
        let files = this.recentLoadedFiles;
        for (let i = 0; i < files.length; i++) {
            if (files[i] == fileName) {
                files.splice(i, 1);
            }
        }

        files.unshift(fileName);
        while (files.length > 10) {
            files.pop();
        }

        this.save();
    }


    load(){
        try {
            // 1回ハッシュに読み込んでから適用する
            // 読み込んだものをそのまま使うと，this に何か追加したときに
            // それがなかったことになってしまう
            let data = JSON.parse(fs.readFileSync(this.FILE_NAME_, "utf8"));
            for (let i in data){
                if (!(i.match(/^[A-Z_]+$/)) && i in this) {
                    this[i] = data[i];
                }
            }
            console.log(`Successfully read configuration data from ${this.FILE_NAME_}`);
        }
        catch (e) {
            console.log(`Could not open ${this.FILE_NAME_}`);
        }

        this.check_("theme", this.VALID_THEME_LIST_);
        this.check_("depArrowType", this.VALID_DEP_ARROW_TYPES_);
    }
    
    // 終了時の保存は，main.js および store の quit ハンドラから呼ばれる
    save(){
        try {
            fs.statSync(this.DIR_);
        }
        catch (e) {
            console.log(`Could not open ${this.DIR_}`);
            try {
                fs.mkdirSync(this.DIR_);
                console.log(`Successfully made a configuration directory ${this.DIR_}`);
            }
            catch (e) {
                console.log(`Could not make ${this.DIR_}`);
            }
        }


        try {

            // 大文字のメンバは保存/読み込みを行わない
            let saved = {};
            for (let key of Object.keys(this)) {
                if (!key.match(/^[A-Z_]+$/)) {
                    saved[key] = this[key];
                }
            }

            // スペース４つでインデントする
            fs.writeFileSync(this.FILE_NAME_, JSON.stringify(saved, null, "    "));
            console.log(`Successfully wrote configuration data to ${this.FILE_NAME_}`);
        }
        catch (e) {
            console.log(`Could not write ${this.FILE_NAME_}`);
        }
    }

    get configItems(){
        return {
            drawTextThreshold: {
                comment: "If you set a smaller value, texts are drawn when you zoom out more. " +
                    "[Default: 10 CSS pixel]"
            },
            drawDetailedlyThreshold: {
                comment: "If you set a smaller value, colors are applied when you zoom out more. " +
                    "[Default: 1 CSS pixel]"
            },
            drawDependencyThreshold: {
                comment: "If you set a smaller value, dependency arrows are drawn when you zoom out more. " + 
                    "[Default: 4 CSS pixel]"
            },
            drawFrameThreshold: {
                comment: "If you set a smaller value, frames are drawn when you zoom out more. " +
                    "[Default: 4 CSS pixel]"
            },
            drawZoomFactor: {
                comment: "If you set a greater value (e.g., \"1.5\"), zoom in/out is performed at a finer granularity. " + 
                    "[Default: 1]"
            }
        };
    }
}

module.exports.Config = Config;
