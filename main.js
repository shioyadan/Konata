'user strict';
const electron = require("electron");
const {app} = electron;
const {BrowserWindow} = electron;
const {Menu} = electron;
var currentURL = 'file://' + __dirname + '/index.html';
// メインウィンドウはGCされないようにグローバル宣言
var m_window = null;
var ipc = electron.ipcMain;
var dialog = electron.dialog;//remote.require('dialog');

function installMenu() {
    var template;

    template = [
    {
        label: 'app-name', // なににしてもElectronになる。
        submenu: [
            {
                label: 'Open',
                accelerator: 'Command+O',
                click: function() { OpenFile(); }
            },
            {
                label: 'Quit',
                accelerator: 'Command+Q',
                click: function() { app.quit(); }
            },
        ]
    },
    {
        label: '操作',
        submenu: [
            {
                label:"Next Tab",
                accelerator:"Command+N",
                click: function () {m_window.webContents
                .send('main.js', {request:'NextTab', dir:true});;}
            },
            {
                label:"Previous Tab",
                accelerator:"Command+P",
                click: function () {m_window.webContents
                .send('main.js', {request:'NextTab', dir:false});;}
            },
            {
                label:"Zoom up",
                accelerator:"Command+Shift+=",
                click: function () {m_window.webContents
                .send('main.js', {request:'Zoom up'});;}
            },
            {
                label:"Zoom down",
                accelerator:"Command+-",
                click: function () {m_window.webContents
                .send('main.js', {request:'Zoom down'});;}
            },
        ]
    },
    {
        label: '表示',
        submenu: [
            {
                label:"全体を半透明化",
                accelerator:"Command+Shift+O",
                click: function () {m_window.webContents
                .send('main.js', {request:'Transparent', enable:true, all:false});;}
            },
            {
                label:"背景を透明化",
                //accelerator:"Command+P",
                click: function () {m_window.webContents
                .send('main.js', {request:'Transparent', enable:true, all:true});;}
            },
            {
                label:"透明化を解除",
                //accelerator:"Command+Shift+=",
                click: function () {m_window.webContents
                .send('main.js', {request:'Transparent', enable:false});;}
            },
            {
                label:"全体を橙色に",
                //accelerator:"Command+-",
                click: function () {m_window.webContents
                .send('main.js', {request:'Color', color:"#f80"});;}
            },
            {
                label:"全体を青色に",
                //accelerator:"Command+-",
                click: function () {m_window.webContents
                .send('main.js', {request:'Color', color:"#08f"});;}
            },
            {
                label:"デフォルトの配色",
                //accelerator:"Command+-",
                click: function () {m_window.webContents
                .send('main.js', {request:'Color', color:null});;}
            },
            {
                label:"Retina切り替え",
                //accelerator:"Command+-",
                click: function () {m_window.webContents
                .send('main.js', {request:'Retina'});;}
            },
        ]
    }
    ];

    const menu = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(menu);
}

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
    m_window = new BrowserWindow({width: 800, height: 600});
    m_window.loadURL(currentURL);
    m_window.toggleDevTools();
    // ウィンドウが閉じられたらアプリも終了
    m_window.on('closed', function() {
        m_window = null;
    });
    installMenu();
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

ipc.on('index.js', function(event, args) {
    var request = args.request;
    if (request == "Open file") {
        OpenFile();
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

function OpenFile() {
    var win = BrowserWindow.getFocusedWindow();
    dialog.showOpenDialog(
        win,
        // どんなダイアログを出すかを指定するプロパティ
        {
            properties: ['openFile'],
            filters: [
                {
                    name: 'Konata log data',
                    extensions: ['txt', 'text', 'log', 'gz']
                }
            ]
        },
        // [ファイル選択]ダイアログが閉じられた後のコールバック関数
        function (filenames) {
            if (filenames) {
                m_window.webContents
                .send('main.js', {request:'Open file', path:filenames[0]});
            }
        });
}