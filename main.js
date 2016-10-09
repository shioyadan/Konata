'user strict';
const electron = require("electron");
const {app} = electron;
const {BrowserWindow} = electron;
// アプリケーションをコントロールするモジュール
//var app = require('app');
// ウィンドウを作成するモジュール
//var BrowserWindow = require('browser-window');
// 起動URL
var currentURL = 'file://' + __dirname + '/index.html';
// クラッジュレポーター
require('crash-reporter').start();
// メインウィンドウはGCされないようにグローバル宣言
var mainWindow = null;
var ipc = electron.ipcMain;

var KanataData = require("./KanataData");
var Op = require("./Op");
var OnikiriLog = require("./OnikiriLog");

var text = "Kanata	0004¥n" +
    "C=	1¥n" +
    "I	0	0	0¥n" +
    "L	0	0	12000d918 r4 = iALU(r3, r2)¥n" +
    "S	0	0	F¥n" +
    "I	1	1	0¥n" +
    "L	1	0	12000d91c iBC(r17)¥n" +
    "S	1	0	F¥n" +
    "C	1¥n" +
    "E	0	0	F¥n" +
    "S	0	0	Rn¥n" +
    "S	0	1	iX¥n" +
    "E	1	0	F¥n" +
    "S	1	0	Rn¥n"	// 命令1のFステージ開始
    
//var mo = require("./Module");

// 全てのウィンドウが閉じたら終了
app.on('window-all-closed', function() {
  if (process.platform != 'darwin') {
    app.quit();
  }
});
// Electronの初期化完了後に実行
app.on('ready', function() {
    
    mainWindow = new BrowserWindow(
        {width: 800, height: 600, 
            //webPreferences: {nodeIntegration: false}
    });

    //kanataData.PrintAsHTML();
    mainWindow.loadUrl(currentURL);
    mainWindow.toggleDevTools();
    // ウィンドウが閉じられたらアプリも終了
    mainWindow.on('closed', function() {
        mainWindow = null;
    });
});


ipc.on('asynchronous-message', function(event, arg) {
    var onikiri = new OnikiriLog("./vis.150.txt");
    var kanataData = onikiri.Process();
    
    event.sender.send('asynchronous-reply', 'pong');  // 送信元へレスポンスを返す
    console.log("main:recieved message: " + arg[0]);
    var op = kanataData.ops[0];
    console.log(op.info.fetch[0]);
    mainWindow.webContents
        .send('asynchronous-message', ['Draw', kanataData]);
    }
);

