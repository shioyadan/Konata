"user strict";

const electron = require("electron");
const {app} = electron;
const {BrowserWindow} = electron;

// __dirname には現在のファイルの場所が入る
let currentURL = "file://" + __dirname + "/index.html";

// 使用できるメモリの最大使用量を 8GB に
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=8192");

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
    m_window = new BrowserWindow({width: 800, height: 600});
    m_window.loadURL(currentURL);
    //m_window.toggleDevTools();
    // ウィンドウが閉じられたらアプリも終了
    m_window.on("closed", function() {
        m_window = null;
    });
});

/*

// 現在使われていないので，とりあえずコメントアウト

let ipc = electron.ipcMain;
let dialog = electron.dialog;//remote.require('dialog');

// メインプロセス側のKonata
let Konata = require("./konata");
let konata = new Konata();

// レンダラプロセスのkonataからの通信
ipc.on('Konata', function(event, args) {
    var request = args.request;
    if (request == "Please parser") { // args.pathのパーサーとして働くように頼まれた
        var path = args.path;
        if (konata.openFile(path)) { // pathをOpenできたので解析できそう。
            event.returnValue = "Success";
        } else { // pathは開けなかった、または非対応の形式だった。
            event.returnValue = "Can not parse";
        }
    } else if (request == "GetOp") { // Op情報を要求された
        var id = args.id;
        var path = args.path;
        event.returnValue = konata.getOp(path, id); // メインプロセス側のkonataにデータを要求して返却
    }
});

function SendOps(ops) {
    m_window.webContents
        .send('asynchronous-message', {request:'DrawOps', ops:ops});
}

function SendOp(op) {
    m_window.webContents
        .send('asynchronous-message', {request:'Draw', op:op});
}
*/
