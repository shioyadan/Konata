let fs = require("fs");
let electron = require("electron");

class Config{
    constructor(){
        // 最後が _ で終わってるメンバは保存/読み込みを行わない
        this.DIR_ = electron.remote.app.getPath("userData") + "/konata";
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
            let replacer = (key, value) => {
                return key.match(/^[A-Z_]+$/) ? undefined : value;
            };

            // スペース４つでインデントする
            fs.writeFileSync(this.FILE_NAME_, JSON.stringify(this, replacer, "    "));
            console.log(`Successfully wrote configuration data to ${this.FILE_NAME_}`);
        }
        catch (e) {
            console.log(`Could not write ${this.FILE_NAME_}`);
        }
    }
}

module.exports.Config = Config;
