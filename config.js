let fs = require("fs");
let electron = require("electron");

class Config{
    constructor(){
        // 最後が _ で終わってるメンバは保存/読み込みを行わない
        this.DIR_ = electron.remote.app.getPath("userData");
        this.FILE_NAME_ = this.DIR_ + "/config.json";


        // デフォルトの設定
        this.theme = "dark";
        this.VALID_THEME_LIST_ = [
            "light", "dark"
        ];

        // 設定読み込み
        this.load();

        // 終了時に save する
        let self = this;
        electron.remote.app.on("quit", () => {
            self.save();
        });
    }

    /** 
     * @param {string} name
     * @param {array} validList
     */
    check_(name, validList){
        if (!(this[name] in validList)) {
            this[name] = validList[0];
        }
    }

    load(){
        try {
            // 1回ハッシュに読み込んでから適用する
            // 読み込んだものをそのまま使うと，this に何か追加したときに
            // それがなかったことになってしまう
            let data = JSON.parse(fs.readFileSync(this.FILE_NAME_, "utf8"));
            for (let i in data){
                if (!i.match(/^.+_$/) && i in this) {
                    this[i] = data[i];
                }
            }
            console.log(`Successfully read configuration data from ${this.FILE_NAME_}`);
        }
        catch (e) {
            console.log(`Could not open ${this.FILE_NAME_}`);
        }

        this.check_("theme", this.VALID_THEME_LIST_);
    }
    
    save(){
        try {
            fs.statSync(this.DIR_);
        }
        catch (e) {
            console.log(`Could not open ${this.DIR_}`);
            try {
                fs.mkdirSync(this.DIR_);
                console.log(`Successfully made a configuration directory ${this.FILE_NAME_}`);
            }
            catch (e) {
                console.log(`Could not make ${this.DIR_}`);
            }
        }


        try {

            // 最後が _ で終わってるメンバは保存/読み込みを行わない
            let replacer = (key, value) => {
                return key.match(/^.+_$/) ? undefined : value;
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
