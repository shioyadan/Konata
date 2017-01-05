// アプリケーションの状態を保持する store


const ACTION = {
    DIALOG_FILE_OPEN: 0,
    
    FILE_OPEN: 10,
    FILE_CLOSE: 11,

    TAB_OPEN: 20,
    TAB_UPDATE: 21,
    TAB_CLOSE: 22,
    TAB_ACTIVATE: 23,

    APP_QUIT: 30
};

function Store(){
    /* globals riot */
    riot.observable(this);
    
    let remote = require("electron").remote;
    let Konata = require("./Konata.js");

    let self = this;
    self.fileName = null;

    // Tab
    self.tabs = {}; // id -> tab
    self.nextTabID = 0;
    self.activeTabID = 0;


    // ファイルオープン
    self.on(ACTION.FILE_OPEN, function(fileName){
        self.fileName = fileName;

        // Load a file
        let konata = new Konata();
        if (!konata.OpenFile(fileName)) {
            konata.Close(fileName);
            return;
        }

        // Create a new tab
        let tab = {
            id: self.nextTabID, 
            fileName: fileName,
            konata: konata
        };
        self.tabs[self.nextTabID] = tab;
        self.activeTabID = self.nextTabID;
        self.nextTabID++;
        
        self.trigger(ACTION.TAB_OPEN, self, tab);
    });

    // ファイルクローズ
    self.on(ACTION.FILE_CLOSE, function(fileName){
        self.trigger(ACTION.TAB_CLOSE, fileName);
    });

    // アクティブなタブの変更
    self.on(ACTION.TAB_ACTIVATE, function(id){
        self.activeTabID = id;
        self.trigger(ACTION.TAB_UPDATE, self);
    });

    // アプリケーション終了
    self.on(ACTION.APP_QUIT, function(){
        remote.app.quit();
    });


}


module.exports = Store;
