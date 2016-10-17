'user strict';
const electron = require("electron");
const {app} = electron;
const {BrowserWindow} = electron;
var currentURL = 'file://' + __dirname + '/index.html';
// メインウィンドウはGCされないようにグローバル宣言
var mainWindow = null;
var ipc = electron.ipcMain;

// メインプロセス側のKonata
var Konata = require("./Konata");
var konata = new Konata();

// 全てのウィンドウが閉じたら終了
app.on('window-all-closed', function() {
  if (process.platform != 'darwin') {
    app.quit();
  }
});
// Electronの初期化完了後に実行
app.on('ready', function() {

    mainWindow = new BrowserWindow({width: 800, height: 600});
    mainWindow.loadURL(currentURL);
    mainWindow.toggleDevTools();
    // ウィンドウが閉じられたらアプリも終了
    mainWindow.on('closed', function() {
        mainWindow = null;
    });
});

// レンダラプロセスのkonataからの通信
ipc.on('Konata', function(event, args) {
    var request = args.request;
    if (request == "Please parser") { // args.pathのパーサーとして働くように頼まれた
        var path = args.path;
        if (konata.OpenFile(path)) { // pathをOpenできたので解析できそう。
            event.returnValue = "Success";
        } else { // pathは開けなかった、または非対応の形式だった。
            event.returnValue = "Can not parse";
        }
    } else if (request == "GetOp") { // Op情報を要求された
        var id = args.id;
        var path = args.path;
        event.returnValue = konata.GetOp(path, id); // メインプロセス側のkonataにデータを要求して返却
    }
});

function SendOps(ops) {
    mainWindow.webContents
        .send('asynchronous-message', {request:'DrawOps', ops:ops});
}

function SendOp(op) {
    mainWindow.webContents
        .send('asynchronous-message', {request:'Draw', op:op});
}
