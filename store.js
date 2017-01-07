// アプリケーションの状態を保持する store

const ACTION = {
    APP_QUIT: 0,

    DIALOG_FILE_OPEN: 10,
    DIALOG_MODAL_MESSAGE: 11,
    DIALOG_MODAL_ERROR: 12,

    FILE_OPEN: 20,
    FILE_CLOSE: 21,

    TAB_OPEN: 30,
    TAB_CLOSE: 32,
    TAB_ACTIVATE: 33,

    WINDOW_RESIZE: 40,
    PANE_SPLITTER_MOVE: 50,
};

const VIEW = {
    TAB_OPEN: 100,
    TAB_UPDATE: 101,
    PANE_UPDATE: 102,
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

    // ウィンドウサイズ
    self.window = {
        width: 800,
        height: 600
    };

    // ファイルオープン
    self.on(ACTION.FILE_OPEN, function(fileName){
        self.fileName = fileName;

        // Load a file
        let konata = new Konata();
        if (!konata.OpenFile(fileName)) {
            konata.Close(fileName);
            self.trigger(ACTION.DIALOG_MODAL_ERROR, `${fileName} の読み込みに失敗しました．`);
            return;
        }

        // Create a new tab
        let tab = {
            id: self.nextTabID, 
            fileName: fileName,
            konata: konata,
            splitter: { // スプリッタの位置
                position: 150
            }
        };
        self.tabs[self.nextTabID] = tab;
        self.activeTabID = self.nextTabID;
        self.nextTabID++;
        
        self.trigger(VIEW.TAB_OPEN, self, tab);
        self.trigger(VIEW.TAB_UPDATE, self, tab);
        self.trigger(VIEW.PANE_UPDATE, self, tab);
    });

    // ファイルクローズ
    self.on(ACTION.FILE_CLOSE, function(fileName){
        self.trigger(VIEW.TAB_CLOSE, fileName);
    });

    // アクティブなタブの変更
    self.on(ACTION.TAB_ACTIVATE, function(id){
        self.activeTabID = id;
        self.trigger(VIEW.TAB_UPDATE, self);
    });

    // ウィンドウのサイズ変更
    self.on(ACTION.WINDOW_RESIZE, function(width, height){
        self.window.width = width;
        self.window.height = height;
        self.trigger(VIEW.PANE_UPDATE, self);
    });

    // スプリッタの位置変更
    self.on(ACTION.PANE_SPLITTER_MOVE, function(position){
        self.tabs[self.activeTabID].splitter.position = position;
        self.trigger(VIEW.PANE_UPDATE, self);
    });

    // アプリケーション終了
    self.on(ACTION.APP_QUIT, function(){
        remote.app.quit();
    });


}


module.exports = Store;
