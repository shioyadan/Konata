// アプリケーションの状態を保持する store
// store の更新は必ず ACTION による trigger 経由で行う
// 参照は自由に行って良い
// store は ACTION による更新が行われると CHANGE による通知を行う

// ACTION は store の変更を行う
// CHANGE の数字とかぶってはいけない
// view -> store 
const ACTION = {
    APP_QUIT: 0,

    DIALOG_FILE_OPEN: 10,
    DIALOG_MODAL_MESSAGE: 11,
    DIALOG_MODAL_ERROR: 12,
    
    COMMAND_PALETTE_OPEN: 13,   // コマンドパレットのオープン
    COMMAND_PALETTE_CLOSE: 14,  // コマンドパレットのクローズ
    COMMAND_PALETTE_EXECUTE: 15,    // 引数で受け取った文字列を実行

    FILE_OPEN: 20,
    FILE_RELOAD: 21,
    FILE_CHECK_RELOAD: 22,
    FILE_SHOW_STATS: 23,

    TAB_CLOSE: 32,
    TAB_ACTIVATE: 33,
    TAB_MOVE: 34,

    SHEET_RESIZE: 40,           // シートサイズの変更
    SHEET_SHOW_DEV_TOOL: 41,    // 開発者ツールの表示切り替え
    PANE_SPLITTER_MOVE: 50,     // スプリッタ位置の変更

    KONATA_CHANGE_COLOR_SCHEME: 60,     // カラースキームの変更
    KONATA_TRANSPARENT: 61,             // 透過モードの設定
    KONATA_EMPHASIZE_IN_TRANSPARENT: 62, // 透過モード時にアルファ値を下げる
    KONATA_SYNC_SCROLL: 63,             // 同期スクロール
    KONATA_CHANGE_UI_COLOR_THEME: 64,   // UI のカラーテーマの変更

    KONATA_ZOOM: 73,        // 拡大/縮小

    KONATA_ADJUST_POSITION: 74,  // 位置自動調整
    
    KONATA_MOVE_WHEEL_VERTICAL: 75,  // ホイールによるスクロール（垂直）
    KONATA_MOVE_WHEEL_HORIZONTAL: 76,  // ホイールによるスクロール（水平）
    
    KONATA_MOVE_PIXEL_DIFF: 77,     // 位置移動，引数はピクセル相対値
    KONATA_MOVE_LOGICAL_POS: 78,    // 位置移動，引数は論理座標（サイクル数，命令ID）
    KONATA_MOVE_LABEL_CLICK: 79,    // ラベルペーンのクリック時の移動

    KONATA_SET_DEP_ARROW_TYPE: 88,  // 依存関係の矢印のタイプの設定
    KONATA_SPLIT_LANES: 89,         // レーンを分割して表示するか
    KONATA_FIX_OP_HEIGHT: 90,       // レーン分割時に高さを一定にするかどうか
    KONATA_HIDE_FLUSHED_OPS: 91,         // フラッシュされた命令を隠すかどうか

    KONATA_FIND_STRING: 92,         // Find a specified string
    KONATA_FIND_NEXT_STRING: 93,    // Find a next specified string 
    KONATA_FIND_PREV_STRING: 94,    // Find a previous specified string
    KONATA_FIND_HIDE_RESULT: 95,    // Hide found result
    
    KONATA_GO_TO_BOOKMARK: 96,      // Go to a specified bookmark
    KONATA_SET_BOOKMARK: 97,        // Set a bookmark

    // MUST NOT OVERLAP NUMBERS IN CHANGE
};

// CHANGE は store で行われた変更の通知に使う
// ACTION の数字とかぶってはいけない
// store -> view
const CHANGE = {
    TAB_OPEN: 100,
    TAB_UPDATE: 101,    // タブ切り替え時の更新

    PANE_SIZE_UPDATE: 102,
    PANE_CONTENT_UPDATE: 103,   // ペーンの中身の更新

    DIALOG_FILE_OPEN: 110,
    DIALOG_MODAL_MESSAGE: 111,
    DIALOG_MODAL_ERROR: 112,
    DIALOG_CHECK_RELOAD: 113,
    DIALOG_SHOW_STATS: 114,
    
    COMMAND_PALETTE_OPEN: 115,
    COMMAND_PALETTE_CLOSE: 116,

    MENU_UPDATE: 120,   // メニュー内容の更新

    SHEET_UPDATE_DEV_TOOL: 190,    // 開発者ツールの表示

    PROGRESS_BAR_START:  200,    // プレグレスバーの更新開始
    PROGRESS_BAR_UPDATE: 201,    // 読み込みのプレグレスバーの更新
    PROGRESS_BAR_FINISH: 202,    // ファイル読み込み終了

    WINDOW_CSS_UPDATE: 300 // テーマ変更により，CSS が変更された
};


class Tab{
    /** 
     * @param {string} fileName
     * @param {Konata} konata
     * @param {KonataRenderer} renderer
     * */
    constructor(id, fileName, konata, renderer){
        let fs = require("fs");
        let KonataRenderer = require("./konata_renderer").KonataRenderer;
        let Konata = require("./konata").Konata;
        let Op = require("./op").Op;   // eslint-disable-line

        // ファイル更新時間
        let mtime = fs.statSync(fileName).mtime;

        this.id = id; 
        this.fileName = fileName;
        this.lastFileCheckedTime = mtime;
        this.konata = konata;
        this.renderer = renderer;
        this.splitterPos = 450;
        this.transparent = false; // 透明化の有効無効
        this.hideFlushedOps = false;  // フラッシュされた命令を隠すか
        this.emphasize_in_transparent = false; // 透明化の際に表示を強調するかどうか
        this.colorScheme = "Auto";  // カラースキーム
        this.syncScroll =  false;  // スクロールを同期 
        
        this.scrollEndPos =  [0, 0];   // スクロール終了位置
        this.curScrollPos =  [0, 0];   // 現在のスクロール位置

        this.FindContext = class{
            constructor(){
                this.targetPattern = "";  // 検索中の文字の正規表現パターン
                this.foundStr = "";       // ヒットした文字列全体
                this.found = false;       // ヒットしたかどうか
                this.visibility = false;  // 検索結果を表示するかどうか
                /** @type {Op} */
                this.op = null; // 見つかった op

                // 検索の ID．新しい検索を行うたびにインクリメントされる
                // 現在実行中の検索は，ID が変化した場合はキャンセルされる
                this.findID = 0;
                this.flushed = false;   // フラッシュされたかどうか
            }
        }
        this.findContext = new this.FindContext;
    }
}

/**
 * @mixes Observable
 */
class Store{
    constructor(){
        
        // この書式じゃないと IntelliSense が効かない
        let electron = require("electron");
        let fs = require("fs");

        let KonataRenderer = require("./konata_renderer");
        let Konata = require("./konata");
        let Config = require("./config");
        let Op = require("./op").Op;   // eslint-disable-line


        // Tab
        this.config = new Config.Config();
        this.tabs = {}; // id -> tab
        this.nextOpenedTabID = 0; // 次にオープンされるタブの ID 

        this.activeTabID = 0;   // 現在アクティブなタブの ID 
        this.activeTab = null;  // 現在アクティブなタブ
        this.prevTabID = -1;     // 前回アクティブだったタブの ID 
        this.prevTab = null;       // 前回アクティブだったタブ

        // 開発者ツールの表示切り替え
        this.showDevTool = false;

        // レーンひょうじかんけい
        this.splitLanes = false;
        this.fixOpHeight = false;

        // アニメーション
        this.inZoomAnimation = false;
        this.zoomAnimationID = null;

        // ズームのアニメーション
        this.zoomEndLevel = 0;
        this.curZoomLevel = 0;
        this.zoomBasePoint = [0, 0];
        this.zoomAnimationDirection = false;
        let ZOOM_ANIMATION_SPEED = 0.2;

        // スクロールのアニメーション
        this.inScrollAnimation = false;
        this.scrollAnimationDiff = [0, 0];
        this.scrollAnimationDirection = [false, false];
        this.scrollAnimationID = null;
        let SCROLL_ANIMATION_PERIOD = 100;  // ミリ秒

        // Command palette
        this.isCommandPaletteOpened = false;

        // Dummy functions for a type-script checker
        // The actual handlers are set in riot.observable.
        this.on = (ev, func) => { return [ev, func]; };
        this.trigger = (ev, ...args) => { return [ev, args]; };
        /* globals riot */
        riot.observable(this);

        let self = this;

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

        // コマンドパレット
        self.on(ACTION.COMMAND_PALETTE_OPEN, function(command){
            if (!self.isCommandPaletteOpened) { // Avoid overwriting palette contents
                self.isCommandPaletteOpened = true;
                self.trigger(CHANGE.COMMAND_PALETTE_OPEN, command);
            }
        });
        self.on(ACTION.COMMAND_PALETTE_CLOSE, function(){
            self.isCommandPaletteOpened = false;
            self.trigger(CHANGE.COMMAND_PALETTE_CLOSE);
        });
        self.on(ACTION.COMMAND_PALETTE_EXECUTE, function(cmd){
            if (!self.activeTab) {
                return;
            }

            
            if (cmd.match(/j[\s]+(\d+)/)) { // js #line
                let id = Number(RegExp.$1);
                let renderer = self.activeTab.renderer;
                let pos = renderer.viewPos;
                let op = renderer.getVisibleOp(id);
                if (op) {
                    self.startScroll([op.fetchedCycle - pos[0], id - pos[1]]);
                }
            }
            else if (cmd.match(/jr[\s](\d+)/)) { // jr #rid
                let rid = Number(RegExp.$1);
                let renderer = self.activeTab.renderer;
                let pos = renderer.viewPos;
                let op = renderer.getOpFromRID(rid);
                let y = renderer.getPosY_FromRID(rid);
                if (op) {
                    self.startScroll([op.fetchedCycle - pos[0], y - pos[1]]);
                }
            }
            else if (cmd.match(/^f[\s]+(.+)$/)) {   // find #
                let target = RegExp.$1;
                self.trigger(ACTION.KONATA_FIND_STRING, target);
            }
            else {
                self.trigger(CHANGE.DIALOG_MODAL_ERROR, `Failed to parse: ${cmd}`);
            }

            /*
            else if (cmd.match(/^o[\s]+(.+)$/)) {   // find #
                let target = RegExp.$1;
                self.trigger(ACTION.FILE_OPEN, target);
            }
            */
        });

        // 開発者ツールの表示切り替え
        self.on(ACTION.SHEET_SHOW_DEV_TOOL, function(show){
            self.showDevTool = show;
            self.trigger(CHANGE.SHEET_UPDATE_DEV_TOOL, show);
        });

        // ファイルオープン
        self.on(ACTION.FILE_OPEN, function(fileName){
            // Load a file
            let konata = new Konata.Konata();
            let tabID = self.nextOpenedTabID;
            try {
                self.trigger(CHANGE.PROGRESS_BAR_START, tabID);
                konata.openFile(fileName, 
                    (percent, count) => {  // 更新通知ハンドラ
                        self.trigger(CHANGE.PROGRESS_BAR_UPDATE, percent, tabID);
                        if (count % 10 == 0) {  // 常に再描画すると重いので，10% おきに再描画
                            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
                        }
                    },
                    () => {  // 読み出し終了ハンドラ
                        self.trigger(CHANGE.PROGRESS_BAR_FINISH, tabID);
                        self.trigger(CHANGE.PANE_CONTENT_UPDATE);
                    },
                    (errorMsg) => { // エラーハンドラ
                        self.trigger(CHANGE.DIALOG_MODAL_ERROR, `Failed to load '${fileName}': ${errorMsg}`);
                        self.trigger(ACTION.TAB_CLOSE, tabID);
                    }
                );
            }
            catch (e) {
                konata.close();
                self.trigger(CHANGE.DIALOG_MODAL_ERROR, `Failed to load '${fileName}': ${e}`);
                return;
            }

            self.config.onLoadFile(fileName);

            let renderer = new KonataRenderer.KonataRenderer();
            renderer.init(konata, self.config);

            let tab = new Tab(self.nextOpenedTabID, fileName, konata, renderer);

            self.tabs[self.nextOpenedTabID] = tab;
            self.activeTabID = self.nextOpenedTabID;
            self.activeTab = self.tabs[self.activeTabID];
            self.nextOpenedTabID++;
        
            self.trigger(CHANGE.TAB_OPEN, tab);
            self.trigger(CHANGE.TAB_UPDATE, tab);
            self.trigger(CHANGE.PANE_SIZE_UPDATE);
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
            self.trigger(CHANGE.MENU_UPDATE);
        });

        // ファイルリロード
        self.on(ACTION.FILE_RELOAD, function(){
            let konata = self.activeTab.konata;
            konata.reload();
            self.trigger(CHANGE.PROGRESS_BAR_START, self.activeTab.id);
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
        });

        // リロードのチェック要求
        self.on(ACTION.FILE_CHECK_RELOAD, function(){
            if (!self.activeTab) {
                return;
            }
            // ファイル更新時間
            let fileName = self.activeTab.fileName;
            let mtime = fs.statSync(fileName).mtime;
            if (self.activeTab.lastFileCheckedTime < mtime){
                // リロードチェックのダイアログを起動
                self.trigger(CHANGE.DIALOG_CHECK_RELOAD, fileName);
            }
            self.activeTab.lastFileCheckedTime = mtime;
        });

        // Show statistics
        self.on(ACTION.FILE_SHOW_STATS, function(){
            let konata = self.activeTab.konata;
            konata.stats(function(stats){
                self.trigger(CHANGE.DIALOG_SHOW_STATS, stats);
            });
        });

        // アクティブなタブの変更
        self.on(ACTION.TAB_ACTIVATE, function(id){
            if (!(id in self.tabs)) {
                console.log(`ACTION.TAB_ACTIVATE: invalid id: ${id}`);
                return;
            }

            self.prevTabID = self.activeTabID;
            self.prevTab = self.activeTab;

            self.activeTabID = id;
            self.activeTab = self.tabs[self.activeTabID];

            self.trigger(CHANGE.TAB_UPDATE);
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
            self.trigger(CHANGE.MENU_UPDATE);
        });

        // タブ移動
        self.on(ACTION.TAB_MOVE, function(next){
            let ids = Object.keys(self.tabs).sort();
            for (let i = 0; i < ids.length; i++) {
                if (self.activeTab.id == ids[i]) {
                    let to = next ? ids[(i+1)%ids.length] : ids[(i+ids.length-1)%ids.length];
                    self.trigger(ACTION.TAB_ACTIVATE, to);
                    break;
                }
            }
        });

        // タブを閉じる
        self.on(ACTION.TAB_CLOSE, function(id){
            if (!(id in self.tabs)) {
                console.log(`ACTION.TAB_CLOSE: invalid id: ${id}`);
                return;
            }

            self.tabs[id].konata.close();   // 非同期読み込みを明示的に終わらせる
            delete self.tabs[id];
            self.activeTab = null;

            for(let newID in self.tabs){
                self.activeTabID = Number(newID);
                self.activeTab = self.tabs[newID];
                break;
            }
            if (!self.activeTab) {
                self.activeTabID = -1;
            }
            self.trigger(CHANGE.TAB_UPDATE);
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
            self.trigger(CHANGE.MENU_UPDATE);
            self.trigger(CHANGE.PROGRESS_BAR_FINISH, id);   // 読み込み中なら，更新を終了
        });

        // ウィンドウのサイズ変更
        self.on(ACTION.SHEET_RESIZE, function(){
            self.trigger(CHANGE.PANE_SIZE_UPDATE);
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
        });

        // スプリッタの位置変更
        self.on(ACTION.PANE_SPLITTER_MOVE, function(position){
            if (!self.activeTab) {
                return;
            }
            let sync = self.activeTab.syncScroll;   // 同期
            for (let id in self.tabs) {
                let tab = self.tabs[id];
                if (sync || self.activeTab.id == tab.id) {
                    tab.splitterPos = position;
                }
            }
            self.trigger(CHANGE.PANE_SIZE_UPDATE);
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
        });

        // アプリケーション終了
        self.on(ACTION.APP_QUIT, function(){
            // store.config が生きている間 = ウィンドウの生存期間内に処理をしないといけない
            // app.quit ではウィンドウの close イベントが呼ばれないため，手動で保存する
            self.config.save(); 
            electron.remote.app.quit();
        });


        // ズームのスタート
        this.startZoom = function(zoomLevelDiff, offsetX, offsetY){
            if (!self.inZoomAnimation) {
                // 拡大 or 縮小
                self.zoomAnimationDirection = zoomLevelDiff > 0;
                self.curZoomLevel = self.activeTab.renderer.zoomLevel;
                self.zoomEndLevel = 
                    self.curZoomLevel + zoomLevelDiff;
                self.zoomBasePoint = [offsetX, offsetY];
                self.inZoomAnimation = true;
                self.zoomAnimationID = setInterval(self.animateZoom, 16);
            }
        };

        // ズームアニメーション中は，一定時間毎に呼び出される
        this.animateZoom = function(){
            if (!self.inZoomAnimation) {
                return;
            }

            self.curZoomLevel += 
                self.zoomAnimationDirection ? ZOOM_ANIMATION_SPEED : -ZOOM_ANIMATION_SPEED;
            
            self.zoomAbs(
                self.curZoomLevel, 
                self.zoomBasePoint[0], 
                self.zoomBasePoint[1]
            );

            if ((self.zoomAnimationDirection && self.curZoomLevel >= self.zoomEndLevel) ||
                (!self.zoomAnimationDirection && self.curZoomLevel <= self.zoomEndLevel)){
                self.inZoomAnimation = false;
                clearInterval(self.zoomAnimationID);
                self.zoomAbs(
                    self.zoomEndLevel, 
                    self.zoomBasePoint[0], 
                    self.zoomBasePoint[1]
                );
            }
        };

        // 拡大/縮小
        // zoomLevel は zoom level の値
        // posX, posY はズームの中心点
        this.zoomAbs = function(zoomLevel, posX, posY){
            if (!self.activeTab) {
                return;
            }
            self.scrollTabs(function(tab){
                tab.renderer.zoomAbs(zoomLevel, posX, posY);
            });
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
        };

        // 拡大/縮小
        // zoomLevelDiff は zoom level の差分
        // posX, posY はズームの中心点
        self.on(ACTION.KONATA_ZOOM, function(zoomLevelDiff, posX, posY){
            if (!self.activeTab || self.inZoomAnimation) {
                return;
            }
            self.startZoom(zoomLevelDiff, posX, posY);
        });

        // スクロール同期対象のタブに，渡された関数を適用する
        this.scrollTabs = function(f){
            let sync = self.activeTab.syncScroll;   // 同期
            for (let id in self.tabs) {
                let tab = self.tabs[id];
                if (sync || self.activeTab.id == tab.id) {
                    f(tab);
                }
            }
        };

        // スクロールのアニメーションのスタート
        this.startScroll = function(scrollDiff){
            if (self.inScrollAnimation) {
                self.finishScroll();
            }

            self.scrollAnimationDiff = scrollDiff;
            self.scrollAnimationDirection = [scrollDiff[0] > 0, scrollDiff[1] > 0];
            self.scrollTabs(function(tab){
                tab.curScrollPos = tab.renderer.viewPos;
                tab.scrollEndPos = [
                    tab.curScrollPos[0] + scrollDiff[0],
                    tab.curScrollPos[1] + scrollDiff[1]
                ];
            });
            self.inScrollAnimation = true;
            self.scrollAnimationID = setInterval(self.animateScroll, 16);
        };

        // アニメーション中は，一定時間毎に呼び出される
        this.animateScroll = function(){
            if (!self.inScrollAnimation) {
                return;
            }

            let diff = self.scrollAnimationDiff;
            let dir = self.scrollAnimationDirection;
            let frames = SCROLL_ANIMATION_PERIOD / 16;

            self.scrollTabs(function(tab){
                tab.curScrollPos[0] += diff[0] / frames;
                tab.curScrollPos[1] += diff[1] / frames;
                tab.renderer.moveLogicalPos(tab.curScrollPos);
            });

            if (((dir[0] && self.activeTab.curScrollPos[0] >= self.activeTab.scrollEndPos[0]) ||
                (!dir[0] && self.activeTab.curScrollPos[0] <= self.activeTab.scrollEndPos[0])) &&
                ((dir[1] && self.activeTab.curScrollPos[1] >= self.activeTab.scrollEndPos[1]) ||
                (!dir[1] && self.activeTab.curScrollPos[1] <= self.activeTab.scrollEndPos[1]))
            ){
                self.inScrollAnimation = false;
                clearInterval(self.scrollAnimationID);
                self.scrollTabs(function(tab){
                    tab.renderer.moveLogicalPos(tab.scrollEndPos);
                });
            }
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
        };

        // スクロールの強制終了
        this.finishScroll = function(){
            self.inScrollAnimation = false;
            clearInterval(self.scrollAnimationID);
            
            self.scrollTabs(function(tab){
                tab.renderer.moveLogicalPos(tab.scrollEndPos);
            });
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
        };

        // その時のパイプラインの左上がくるように移動
        this.on(ACTION.KONATA_ADJUST_POSITION, function(){
            if (!self.activeTab) {
                return;
            }
            if (self.inScrollAnimation) {
                self.finishScroll();
            }

            let activeRenderer = self.activeTab.renderer;
            let op = null;
            if (activeRenderer.viewPos[1] < 0) {
                op = activeRenderer.getOpFromID(0);
            }
            else if (activeRenderer.viewPos[1] > activeRenderer.getVisibleBottom()) {
                let bottom = activeRenderer.getVisibleBottom() - 30;
                op = self.activeTab.hideFlushedOps ? activeRenderer.getOpFromRID(bottom) : activeRenderer.getOpFromID(bottom);
            }
            else{
                op = activeRenderer.getOpFromPixelPosY(0);
            }
            if (op) {
                let activeY = self.activeTab.hideFlushedOps ? op.rid : op.id;
                activeRenderer.moveLogicalPos([op.fetchedCycle, activeY]);
                
                // 同期が有効の場合，左上の命令の RID が一致するようにスクロールさせる
                let sync = self.activeTab.syncScroll;   
                if (sync) {
                    for (let id in self.tabs) {
                        let tab = self.tabs[id];
                        let renderer = tab.renderer;
                        let synchedOp = renderer.getOpFromRID(op.rid);
                        if (synchedOp && self.activeTab.id != tab.id) {
                            let y = tab.hideFlushedOps ? synchedOp.rid : synchedOp.id;
                            renderer.moveLogicalPos([synchedOp.fetchedCycle, y]);
                        }
                    }
                }
                self.trigger(CHANGE.PANE_CONTENT_UPDATE);
            }
        });


        // ホイールによる移動（垂直）
        // delta: delta * 3 / scale だけ上下に移動
        // adjust: 水平方向のスクロール補正を行うかどうか
        self.on(ACTION.KONATA_MOVE_WHEEL_VERTICAL, function(delta, adjust){
            if (!self.activeTab) {
                return;
            }
            if (self.inScrollAnimation) {
                self.finishScroll();
            }
            let renderer = self.activeTab.renderer;
            let scale = renderer.zoomScale;
            let diffY = delta * 3 / scale;
            let diffX = adjust ? renderer.adjustScrollDiffX(diffY) : 0;
            self.startScroll([diffX, diffY]);
        });

        // ホイールによる移動（水平）
        // 引数 delta * 6 / scale だけ左右に移動
        self.on(ACTION.KONATA_MOVE_WHEEL_HORIZONTAL, function(delta){
            if (!self.activeTab) {
                return;
            }
            if (self.inScrollAnimation) {
                self.finishScroll();
            }
            let renderer = self.activeTab.renderer;
            let scale = renderer.zoomScale;
            let diffX = delta * 6 / scale;
            let diffY = 0;
            self.startScroll([diffX, diffY]);
        });


        // 位置移動，引数はピクセル相対値
        self.on(ACTION.KONATA_MOVE_PIXEL_DIFF, function(diff){
            if (!self.activeTab) {
                return;
            }
            self.scrollTabs(function(tab){
                tab.renderer.movePixelDiff(diff);
            });
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
        });

        // 位置移動，引数は論理座標（サイクル数，命令ID）
        self.on(ACTION.KONATA_MOVE_LOGICAL_POS, function(pos){
            if (!self.activeTab) {
                return;
            }
            self.scrollTabs(function(tab){
                tab.renderer.moveLogicalPos(pos);
            });
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
        });

        // ラベルクリック時の移動
        // 引数は縦方向のピクセル座標
        // 同期時は，それぞれのタブごとに独立に位置を合わせる
        self.on(ACTION.KONATA_MOVE_LABEL_CLICK, function(offsetY){
            if (!self.activeTab) {
                return;
            }

            self.scrollTabs(function(tab){
                let renderer = tab.renderer;
                let op = renderer.getOpFromPixelPosY(offsetY);
                if (op) {
                    renderer.moveLogicalPos([op.fetchedCycle, renderer.viewPos[1]]);
                }
            });
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
        });

        // カラースキームの変更
        self.on(ACTION.KONATA_CHANGE_COLOR_SCHEME, function(tabID, scheme){
            if (!(tabID in self.tabs)) {
                return;
            }
            let tab = self.tabs[tabID];
            tab.colorScheme = scheme;
            tab.renderer.changeColorScheme(scheme);
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
            self.trigger(CHANGE.MENU_UPDATE);
        });

        // UI のカラーテーマの変更
        self.on(ACTION.KONATA_CHANGE_UI_COLOR_THEME, function(theme){
            self.config.theme = theme;
            for (let tabID in self.tabs) {
                self.tabs[tabID].renderer.loadStyle();
            }
            self.trigger(CHANGE.WINDOW_CSS_UPDATE);
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
            self.trigger(CHANGE.MENU_UPDATE);
        });

        // 依存関係の矢印のタイプを変更
        self.on(ACTION.KONATA_SET_DEP_ARROW_TYPE, function(type){
            self.config.depArrowType = type;
            for (let tabID in self.tabs) {
                self.tabs[tabID].renderer.depArrowType = type;
            }
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
            self.trigger(CHANGE.MENU_UPDATE);
        });

        // レーンを分割して表示するか
        self.on(ACTION.KONATA_SPLIT_LANES, function(enabled){
            self.splitLanes = enabled;
            for (let tabID in self.tabs) {
                self.tabs[tabID].renderer.splitLanes = enabled;
            }
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
            self.trigger(CHANGE.MENU_UPDATE);
        });

        // レーン分割時に高さを一定にするかどうか
        self.on(ACTION.KONATA_FIX_OP_HEIGHT, function(enabled){
            self.fixOpHeight = enabled;
            for (let tabID in self.tabs) {
                self.tabs[tabID].renderer.fixOpHeight = enabled;
            }
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
            self.trigger(CHANGE.MENU_UPDATE);
        });

        // フラッシュされた命令を表示しない
        self.on(ACTION.KONATA_HIDE_FLUSHED_OPS, function(tabID, enable){
            if (!(tabID in self.tabs)) {
                return;
            }
            let tab = self.tabs[tabID];
            let renderer = self.tabs[tabID].renderer;

            // 現在の表示位置を取得
            let orgOp = renderer.getOpFromPixelPosY(0);
            let rid = 0;
            if (orgOp) {
                rid = orgOp.rid;
            }

            tab.hideFlushedOps = enable;
            renderer.hideFlushedOps = enable;

            // 元の命令の RID の位置に移動
            let op = renderer.getOpFromRID(rid);
            if (op) {
                renderer.moveLogicalPos([op.fetchedCycle, enable ? rid : op.id]);
            }

            self.trigger(CHANGE.MENU_UPDATE);
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
        });

        // パイプラインのペーンを透明化
        self.on(ACTION.KONATA_TRANSPARENT, function(tabID, enable){
            if (!(tabID in self.tabs)) {
                return;
            }
            let tab = self.tabs[tabID];
            tab.transparent = enable;
            self.trigger(CHANGE.TAB_UPDATE);
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
            self.trigger(CHANGE.MENU_UPDATE);
        });

        // パイプラインのペーンが透明化されている際に，表示を強調する
        self.on(ACTION.KONATA_EMPHASIZE_IN_TRANSPARENT, function(tabID, enable){
            if (!(tabID in self.tabs)) {
                return;
            }
            let tab = self.tabs[tabID];
            tab.emphasize_in_transparent = enable;
            self.trigger(CHANGE.TAB_UPDATE);
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
            self.trigger(CHANGE.MENU_UPDATE);
        });

        // スクロールの同期化
        self.on(ACTION.KONATA_SYNC_SCROLL, function(tabID, syncedTabID, enable){

            if (!(tabID in self.tabs)) {
                self.trigger(
                    ACTION.DIALOG_MODAL_MESSAGE,
                    `An invalid tab id ${tabID} is specified in ACTION.KONATA_SYNC_SCROLL.`
                );
            }
            let tab = self.tabs[tabID];

            if (enable) {
                if (!(syncedTabID in self.tabs)) {
                    return;
                }
                tab.syncScroll = true;
            }
            else{
                tab.syncScroll = false;
            }

            self.trigger(CHANGE.MENU_UPDATE);
        });

        /** @param {Op} op */ 
        this.makeFindTargetString = function(op) {
            let labelString = 
            `${op.id}: s${op.gid} (t${op.tid}: r${op.rid}) ${op.labelName}\n${op.labelDetail}`;
            for (let laneName in op.lanes) {
                for (let stage of op.lanes[laneName].stages) {
                    for (let label of stage.labels) {
                        labelString += "\n" + label;
                    }
                }
            }
            return labelString;
        };

        // Find a specified string
        this.findString = function(target, basePos, reverse) {

            //console.log(`Find: ${target}, start from ${basePos}, reverse:${reverse}`);

            let konata = self.activeTab.konata;
            let targetPattern = new RegExp(target);

            let search = function(i){
                let op = konata.getOp(i);
                if (!op) {
                    return false;
                }

                if (targetPattern.exec(self.makeFindTargetString(op))) {
                    return true;
                }
                else {
                    return false;
                }
            };

            let found = false;
            let foundPos = -1;
            let lastID = konata.lastID;
            if (reverse) {
                for (let i = basePos;i >= 0; i--) {
                    if (search(i)) { found = true; foundPos = i; break; }
                }
                if (!found) {
                    for (let i = lastID - 1;i > basePos; i--) {
                        if (search(i)) { found = true; foundPos = i; break; }
                    }
                }
            }
            else{
                for (let i = basePos;i < lastID; i++) {
                    if (search(i)) { found = true; foundPos = i; break; }
                }
                if (!found) {
                    for (let i = 0;i < basePos; i++) {
                        if (search(i)) { found = true; foundPos = i; break; }
                    }
                }
            }

            self.activeTab.findContext.found = false;
            if (found) {
                let op = konata.getOp(foundPos);
                if (op) {
                    let renderer = self.activeTab.renderer;
                    let viewPos = renderer.viewPos;
                    let moveTo = renderer.getPosY_FromOp(op);

                    let ctx = self.activeTab.findContext;
                    ctx.found = true;
                    ctx.visibility = true;
                    ctx.targetPattern = target;
                    ctx.foundStr = this.makeFindTargetString(op);
                    ctx.op = renderer.getVisibleOp(moveTo);
                    ctx.flushed = op.flush;

                    self.startScroll([op.fetchedCycle - viewPos[0], moveTo - viewPos[1]]);
                }
                //console.log(`Found: ${target}@${foundPos}`);
            }
            return found;
        };

        self.on(ACTION.KONATA_FIND_STRING, function(target){
            if (!self.activeTab) {
                return;
            }

            let findContext = self.activeTab.findContext;
            findContext.targetPattern = target;
            
            let pos = Math.floor(self.activeTab.renderer.viewPos[1]);
            if (!self.findString(target, pos, false)) {
                self.trigger(CHANGE.DIALOG_MODAL_ERROR, `"${target}" is not found.`);
            }
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
        });

        // Find a next string
        self.on(ACTION.KONATA_FIND_NEXT_STRING, function(){
            if (!self.activeTab) {
                return;
            }

            let findContext = self.activeTab.findContext;
            let pos = Math.floor(self.activeTab.renderer.viewPos[1]);
            if (!self.findString(findContext.targetPattern, pos + 1, false)) {
                self.trigger(CHANGE.DIALOG_MODAL_ERROR, `"${findContext.targetPattern}" is not found.`);
            }
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
        });

        // Find a previous string
        self.on(ACTION.KONATA_FIND_PREV_STRING, function(){
            if (!self.activeTab) {
                return;
            }

            let findContext = self.activeTab.findContext;
            let pos = Math.floor(self.activeTab.renderer.viewPos[1]);
            if (!self.findString(findContext.targetPattern, pos - 1, true)) {
                self.trigger(CHANGE.DIALOG_MODAL_ERROR, `"${findContext.targetPattern}" is not found.`);
            }
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
        });

        self.on(ACTION.KONATA_FIND_HIDE_RESULT, function(){
            if (!self.activeTab) {
                return;
            }

            let findContext = self.activeTab.findContext;
            findContext.visibility = false;
            self.trigger(CHANGE.PANE_CONTENT_UPDATE);
        });

        self.on(ACTION.KONATA_SET_BOOKMARK, function(index){
            let b = self.config.bookmarks[index];
            let tab = self.activeTab;
            let renderer = tab.renderer;
            b.x = Math.floor(renderer.viewPos[0]);
            b.y = Math.floor(renderer.viewPos[1]);
            b.zoom = renderer.zoomLevel;

            // リロード時に消えないように保存
            self.config.save(); 
        });
        self.on(ACTION.KONATA_GO_TO_BOOKMARK, function(index){
            let b = self.config.bookmarks[index];
            let tab = self.activeTab;
            let renderer = tab.renderer;
            self.startScroll([
                b.x - renderer.viewPos[0],
                b.y - renderer.viewPos[1]
            ]);
            self.startZoom(b.zoom - renderer.zoomLevel, b.x, b.y);
        });
    }

}


module.exports.Store = Store;
module.exports.ACTION = ACTION;
module.exports.CHANGE = CHANGE;

