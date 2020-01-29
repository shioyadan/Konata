"user strict";

const electron = require("electron");
const {app} = electron;
const {BrowserWindow} = electron;

// __dirname には現在のファイルの場所が入る
let currentURL = "file://" + __dirname + "/index.html";

// appendSwitch は複数回呼ぶと，前回に与えたスイッチを上書きしてしまうので注意
// --max-old-space-size=32768: 使用できるメモリの最大使用量を 32GB に
// --expose-gc: Make it possible to call GC manually
app.commandLine.appendSwitch("js-flags", "--expose-gc --max-old-space-size=65536");


// メインウィンドウはGCされないようにグローバル宣言
let m_window = null;

// 全てのウィンドウが閉じたら終了
app.on("window-all-closed", function(){
    if (process.platform != "darwin") {
        app.quit();
    }
});

// Electronの初期化完了後に実行
app.on("ready", function() {
    // The main window is not shown while loading. 
    m_window = new BrowserWindow({
        width: 800, 
        height: 600,

        // The window is initially hidden and 
        // is activate in an initial handler in <app> in app.tag.html
        show: false,
        
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        }
    });
    m_window.setMenu(null);

    m_window.loadURL(currentURL);
    //m_window.toggleDevTools();

    // ウィンドウが閉じる前に，設定を保存
    // store.config が生きている間 = ウィンドウの生存期間内に処理をしないといけない
    m_window.on("close", function() {
        m_window.webContents.executeJavaScript("store.config.save();");
    });

    // ウィンドウが閉じられたらアプリも終了
    m_window.on("closed", function() {
        m_window = null;
    });
});

