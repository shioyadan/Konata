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

    SHEET_RESIZE: 40,       // シートサイズの変更
    PANE_SPLITTER_MOVE: 50, // スプリッタ位置の変更

    KONATA_ZOOM: 60,        // 拡大/縮小
    KONATA_MOVE_WHEEL: 61,  // ホイールによるスクロール
    KONATA_MOVE_POS: 62,    // ドラッグによる位置移動
};

// CHANGE は store で行われた変更の通知に使う
// store -> view
const CHANGE = {
    TAB_OPEN: 100,
    TAB_UPDATE: 101,    // タブの内容の更新

    PANE_SIZE_UPDATE: 102,
    PANE_CONTENT_UPDATE: 103,

    DIALOG_FILE_OPEN: 110,
    DIALOG_MODAL_MESSAGE: 111,
    DIALOG_MODAL_ERROR: 112,
};

function Store(){
    /* globals riot */
    riot.observable(this);
    
    // この書式じゃないと IntelliSense が効かない
    let electron = require("electron");
    let KonataRenderer = require("./KonataRenderer");
    let Konata = require("./Konata");
    
    /** @type {{
            tabs: {}, 
            nextTabID: number, 
            activeTabID: number,
            activeTab: {},
            sheet: {width: number, height: number},
        }} 
    */
    let self = this;

    // Tab
    this.tabs = {}; // id -> tab
    self.nextTabID = 0;
    self.activeTabID = 0;
    self.activeTab = null;


    // ウィンドウサイズ
    self.sheet = {
        width: 800,
        height: 600
    };

    // ダイアログ
    // 基本的に中継してるだけ
    self.on(ACTION.DIALOG_FILE_OPEN, function(){
        self.trigger(CHANGE.DIALOG_FILE_OPEN);
    });
    self.on(ACTION.DIALOG_MODAL_MESSAGE, function(msg){
        self.trigger(CHANGE.DIALOG_MODAL_MESSAGE, msg);
    });
    self.on(ACTION.DIALOG_MODAL_ERROR, function(msg){
        self.trigger(CHANGE.DIALOG_MODAL_ERROR, msg);
    });

    // ファイルオープン
    self.on(ACTION.FILE_OPEN, function(fileName){
        // Load a file
        let konata = new Konata.Konata();
        if (!konata.OpenFile(fileName)) {
            konata.Close(fileName);
            self.trigger(CHANGE.DIALOG_MODAL_ERROR, `${fileName} の読み込みに失敗しました．`);
            return;
        }
        let renderer = new KonataRenderer.KonataRenderer();
        renderer.init(konata);

        // Create a new tab
        let tab = {
            id: self.nextTabID, 
            fileName: fileName,
            konata: konata,
            renderer: renderer,
            splitterPos: 150,   // スプリッタの位置
            viewPort: {         // 表示領域
                top: 0,
                left: 0,
                width: 0,
                height: 0,
            },  
        };
        self.tabs[self.nextTabID] = tab;
        self.activeTabID = self.nextTabID;
        self.activeTab = self.tabs[self.activeTabID];
        self.nextTabID++;
       
        self.trigger(CHANGE.TAB_OPEN, self, tab);
        self.trigger(CHANGE.TAB_UPDATE, self, tab);
        self.trigger(CHANGE.PANE_SIZE_UPDATE, self, tab);
        self.trigger(CHANGE.PANE_CONTENT_UPDATE, self, tab);

    });

    // ファイルクローズ
    self.on(ACTION.FILE_CLOSE, function(fileName){
        self.trigger(CHANGE.TAB_CLOSE, fileName);
    });

    // アクティブなタブの変更
    self.on(ACTION.TAB_ACTIVATE, function(id){
        self.activeTabID = id;
        self.activeTab = self.tabs[self.activeTabID];
        self.trigger(CHANGE.TAB_UPDATE, self);
        self.trigger(CHANGE.PANE_CONTENT_UPDATE, self);
    });

    // ウィンドウのサイズ変更
    self.on(ACTION.SHEET_RESIZE, function(width, height){
        self.sheet.width = width;
        self.sheet.height = height;
        self.trigger(CHANGE.PANE_SIZE_UPDATE, self);
        self.trigger(CHANGE.PANE_CONTENT_UPDATE, self);
    });

    // スプリッタの位置変更
    self.on(ACTION.PANE_SPLITTER_MOVE, function(position){
        self.activeTab.splitterPos = position;
        self.trigger(CHANGE.PANE_SIZE_UPDATE, self);
        self.trigger(CHANGE.PANE_CONTENT_UPDATE, self);
    });

    // アプリケーション終了
    self.on(ACTION.APP_QUIT, function(){
        electron.remote.app.quit();
    });

    // 1段階の拡大/縮小
    // zoomOut は true の際にズームアウト
    // posX, posY はズームの中心点
    self.on(ACTION.KONATA_ZOOM, function(zoomOut, posX, posY){
        let renderer = self.activeTab.renderer;
        renderer.zoom(zoomOut, posX, posY);
        self.trigger(CHANGE.PANE_CONTENT_UPDATE, self);
    });

    // ホイールによる移動
    self.on(ACTION.KONATA_MOVE_WHEEL, function(wheelUp){
        let renderer = self.activeTab.renderer;
        renderer.moveWheel(wheelUp);
        self.trigger(CHANGE.PANE_CONTENT_UPDATE, self);
    });

    // ホイールによる移動
    self.on(ACTION.KONATA_MOVE_POS, function(diff){
        let renderer = self.activeTab.renderer;
        renderer.movePos(diff);
        self.trigger(CHANGE.PANE_CONTENT_UPDATE, self);
    });




}


module.exports = Store;
