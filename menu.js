function installMainMenu(){

    /* global RiotControl ACTION */
    let rc = RiotControl;
    let remote = require("electron").remote;

    let menuTemplate = [
        {
            label: "ファイル",
            submenu: [
                {
                    label: "Open",
                    accelerator: "Command+O",
                    click: function(){rc.trigger(ACTION.DIALOG_FILE_OPEN);}
                },
                {
                    label: "Quit",
                    accelerator: "Command+Q",
                    click: function(){rc.trigger(ACTION.APP_QUIT);}
                },
            ]
        },
        {
            label: "操作",
            submenu: [
                {
                    label:"Next Tab",
                    accelerator:"Command+N",
                    click: function(){rc.trigger(ACTION.TAB_MOVE, true);}
                },
                {
                    label:"Previous Tab",
                    accelerator:"Command+P",
                    click: function(){rc.trigger(ACTION.TAB_MOVE, false);}
                },
                {
                    label:"Zoom out",
                    accelerator:"Command+Shift+=",
                    click: function(){rc.trigger(ACTION.KONATA_ZOOM, false, 0, 0);}
                },
                {
                    label:"Zoom in",
                    accelerator:"Command+-",
                    click: function(){rc.trigger(ACTION.KONATA_ZOOM, true, 0, 0);}
                },
            ]
        },
        {
            label: "表示",
            submenu: [
                {
                    label: "透明化",
                    type: "checkbox",
                    checked: false, // 初期値
                    click: function(e){
                        rc.trigger(ACTION.TAB_TRANSPARENT, e.checked);
                    }
                },
                {
                    label:"全体を橙色に",
                    click: function(){rc.trigger(ACTION.KONATA_CHANGE_COLOR_SCHEME, "orange");}
                },
                {
                    label:"全体を青色に",
                    click: function(){rc.trigger(ACTION.KONATA_CHANGE_COLOR_SCHEME, "blue");}
                },
                {
                    label:"デフォルトの配色",
                    click: function(){rc.trigger(ACTION.KONATA_CHANGE_COLOR_SCHEME, "default");}
                },
            ]
        },
        {
            label: "ヘルプ",
            submenu: [
                {
                    label: "バージョン情報",
                    click: function(){
                        RiotControl.trigger(
                            ACTION.DIALOG_MODAL_MESSAGE,
                            "Konata ver 0.0.2, Kojiro Izuoka and Ryota Shioya."
                        );
                    }
                }
            ]
        }
    ];

    let Menu = remote.Menu;
    let menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);
}


function popupTabMenu(tabID, store){

    /* global RiotControl ACTION */
    let rc = RiotControl;
    let remote = require("electron").remote;
    let tab = store.tabs[tabID];

    let menuTemplate = [
        {
            label: "Transparent mode",
            type: "checkbox",
            checked: tab.transparent, 
            click: function(e){
                rc.trigger(ACTION.TAB_TRANSPARENT, e.checked);
            }
        },
        {
            label: "Color scheme",
            submenu: [
                {
                    label: "Default",
                    type: "checkbox",
                    checked: tab.colorScheme == "default", 
                    click: function(){rc.trigger(ACTION.KONATA_CHANGE_COLOR_SCHEME, "default");}
                },
                {
                    label: "Orange",
                    type: "checkbox",
                    checked: tab.colorScheme == "orange", 
                    click: function(){rc.trigger(ACTION.KONATA_CHANGE_COLOR_SCHEME, "orange");}
                },
                {
                    label: "Blue",
                    checked: tab.colorScheme == "blue", 
                    type: "checkbox",
                    click: function(){rc.trigger(ACTION.KONATA_CHANGE_COLOR_SCHEME, "blue");}
                },
            ]
        }
    ];

    let Menu = remote.Menu;
    let menu = Menu.buildFromTemplate(menuTemplate);
    menu.popup();
}

module.exports.installMainMenu = installMainMenu;
module.exports.popupTabMenu = popupTabMenu;
