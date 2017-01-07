// アプリケーションの状態を保持する store

// ACTION は store の変更を行う
// view -> store 
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

    SHEET_RESIZE: 40,
    PANE_SPLITTER_MOVE: 50,
};

// VIEW は store で行われた変更の通知に使う
// store -> view
const VIEW = {
    TAB_OPEN: 100,
    TAB_UPDATE: 101,
    PANE_SIZE_UPDATE: 102,

    DIALOG_FILE_OPEN: 110,
    DIALOG_MODAL_MESSAGE: 111,
    DIALOG_MODAL_ERROR: 112,
};


function Store(){
    /* globals riot */
    riot.observable(this);
    
    let remote = require("electron").remote;

    /** @type {{
            tabs: {}, 
            nextTabID: number, 
            activeTabID: number,
            activeTab: {},
            sheet: {width: number, height: number},
            splitterPos: number,
        }} 
    */
    let self = this;

    // Tab
    self.tabs = {}; // id -> tab
    self.nextTabID = 0;
    self.activeTabID = 0;
    self.activeTab = null;

    // ウィンドウサイズ
    self.sheet = {
        width: 800,
        height: 600
    };

    // スプリッタ位置
    self.splitterPos = 150;


    // ダイアログ
    // 基本的に中継してるだけ
    self.on(ACTION.DIALOG_FILE_OPEN, function(){
        self.trigger(VIEW.DIALOG_FILE_OPEN);
    });
    self.on(ACTION.DIALOG_MODAL_MESSAGE, function(msg){
        self.trigger(VIEW.DIALOG_MODAL_MESSAGE, msg);
    });
    self.on(ACTION.DIALOG_MODAL_ERROR, function(msg){
        self.trigger(VIEW.DIALOG_MODAL_ERROR, msg);
    });


    // ファイルオープン
    self.on(ACTION.FILE_OPEN, function(fileName){

        // Load a file
        /* global Konata KonataRenderer */
        let konata = new Konata();
        if (!konata.OpenFile(fileName)) {
            konata.Close(fileName);
            self.trigger(VIEW.DIALOG_MODAL_ERROR, `${fileName} の読み込みに失敗しました．`);
            return;
        }
        let renderer = new KonataRenderer();
        //renderer.InitDraw(konata);

        // Create a new tab
        let tab = {
            id: self.nextTabID, 
            fileName: fileName,
            konata: konata,
            renderer: renderer,
            splitter: { // スプリッタの位置
                position: 150,
                initial: true   // 初期状態なので，position の値を VIEW に適用する
            }
        };
        self.tabs[self.nextTabID] = tab;
        self.activeTabID = self.nextTabID;
        self.activeTab = self.tabs[self.activeTabID];
        self.nextTabID++;
       
        self.trigger(VIEW.TAB_OPEN, self, tab);
        self.trigger(VIEW.TAB_UPDATE, self, tab);
        self.trigger(VIEW.PANE_SIZE_UPDATE, self, tab);
    });

    // ファイルクローズ
    self.on(ACTION.FILE_CLOSE, function(fileName){
        self.trigger(VIEW.TAB_CLOSE, fileName);
    });

    // アクティブなタブの変更
    self.on(ACTION.TAB_ACTIVATE, function(id){
        self.activeTabID = id;
        self.activeTab = self.tabs[self.activeTabID];
        self.trigger(VIEW.TAB_UPDATE, self);
    });

    // ウィンドウのサイズ変更
    self.on(ACTION.SHEET_RESIZE, function(width, height){
        self.sheet.width = width;
        self.sheet.height = height;
        self.trigger(VIEW.PANE_SIZE_UPDATE, self);
    });

    // スプリッタの位置変更
    self.on(ACTION.PANE_SPLITTER_MOVE, function(position){
        self.activeTab.splitterPos = position;
        self.trigger(VIEW.PANE_SIZE_UPDATE, self);
    });

    // アプリケーション終了
    self.on(ACTION.APP_QUIT, function(){
        remote.app.quit();
    });


}


module.exports = Store;
