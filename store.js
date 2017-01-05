// アプリケーションの状態を保持する store


const ACTION = {
    DIALOG_FILE_OPEN: 0,
    
    FILE_OPEN: 10,
    FILE_CLOSE: 11,

    TAB_UPDATE: 20,
    TAB_CLOSE: 21,

    APP_QUIT: 30
};

function Store(){
    /* globals riot */
    riot.observable(this);
    
    let remote = require("electron").remote;

    let self = this;
    self.fileName = null;

    // Tab
    self.tabs = [];
    self.nextTabID = 0;
    self.activeTabID = 0;

    // ファイルオープン
    self.on(ACTION.FILE_OPEN, function(fileName){
        self.fileName = fileName;

        // Create a new tab
        let tab = {
            id: self.nextTabID, 
            fileName: fileName
        };
        self.tabs.push(tab);
        self.activeTabID = self.nextTabID;
        self.nextTabID++;
        
        self.trigger(ACTION.TAB_UPDATE, self, tab);
    });

    // ファイルクローズ
    self.on(ACTION.FILE_CLOSE, function(fileName){
        self.trigger(ACTION.TAB_CLOSE, fileName);
    });

    // アプリケーション終了
    self.on(ACTION.APP_QUIT, function(){
        remote.app.quit();
    });


}


module.exports = Store;
