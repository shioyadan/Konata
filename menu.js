function installMainMenu(){

    /* global RiotControl ACTION CHANGE store */
    let rc = RiotControl;
    let remote = require("electron").remote;
    let DEP_ARROW_TYPE = require("./konata_renderer").DEP_ARROW_TYPE;

    function makeMenuTemplate(){

        let tab = store ? store.activeTab : null;
        let tabID = store ? store.activeTabID : 0;
        
        // https://github.com/electron/electron/blob/master/docs/api/menu-item.md
        return [
            {
                label: "File",
                submenu: [
                    {
                        label: "Open",
                        accelerator: "Command+O",
                        click: function(){rc.trigger(ACTION.DIALOG_FILE_OPEN);}
                    },
                    {
                        label: "Reload",
                        enabled: tab ? true : false,
                        accelerator: "Command+R",
                        click: function(){rc.trigger(ACTION.FILE_RELOAD);}
                    },
                    {
                        label: "Stats",
                        enabled: tab ? true : false,
                        accelerator: "Command+T",
                        click: function(){rc.trigger(ACTION.FILE_SHOW_STATS);}
                    },
                    {
                        label: "Quit",
                        accelerator: "Command+Q",
                        click: function(){rc.trigger(ACTION.APP_QUIT);}
                    },
                ]
            },
            {
                label: "Window",
                submenu: [
                    {
                        label:"Next tab",
                        accelerator:"Command + N",
                        click: function(){rc.trigger(ACTION.TAB_MOVE, true);}
                    },
                    {
                        label:"Previous tab",
                        accelerator:"Command + P",
                        click: function(){rc.trigger(ACTION.TAB_MOVE, false);}
                    },
                    {
                        label:"Zoom out",
                        accelerator:"Command + Shift + =",
                        click: function(){rc.trigger(ACTION.KONATA_ZOOM, 1, 0, 0);}
                    },
                    {
                        label:"Zoom in",
                        accelerator:"Command + -",
                        click: function(){rc.trigger(ACTION.KONATA_ZOOM, -1, 0, 0);}
                    },
                ]
            },
            {
                label: "View",
                enabled: tab ? true : false,
                submenu: [
                    {
                        label: "Commpand palette",
                        click: function(){
                            rc.trigger(ACTION.COMMAND_PALETTE_OPEN);
                        }
                    },
                    {
                        type: "separator"
                    },
                    {
                        label: "Transparent mode",
                        type: "checkbox",
                        checked: tab ? tab.transparent : false, 
                        click: function(e){
                            rc.trigger(ACTION.KONATA_TRANSPARENT, tabID, e.checked);
                        }
                    },
                    {
                        label: "Hide flushed ops",
                        type: "checkbox",
                        checked: tab ? tab.hideFlushedOps : false, 
                        click: function(e){
                            rc.trigger(ACTION.KONATA_HIDE_FLUSHED_OPS, tabID, e.checked);
                        }
                    },
                    {
                        label: "Color scheme",
                        submenu: ["Auto", "Orange", "RoyalBlue", "Onikiri"].map(function(color){
                            return {
                                label: color,
                                type: "checkbox",
                                checked: tab ? tab.colorScheme == color : true, 
                                click: function(){rc.trigger(ACTION.KONATA_CHANGE_COLOR_SCHEME, tabID, color);}
                            };
                        }),
                    },
                    {
                        label: "Lane",
                        submenu: [
                            {
                                label: "Split lanes",
                                type: "checkbox",
                                checked: store.splitLanes, 
                                click: function(e){
                                    rc.trigger(
                                        ACTION.KONATA_SPLIT_LANES,
                                        e.checked
                                    );
                                }
                            },
                            {
                                label: "Fix op height",
                                type: "checkbox",
                                checked: store.fixOpHeight, 
                                enabled: store.splitLanes,
                                click: function(e){
                                    rc.trigger(
                                        ACTION.KONATA_FIX_OP_HEIGHT,
                                        e.checked
                                    );
                                }
                            },
                        ]
                    },
                    {
                        label: "Dependency arrow",
                        submenu: [
                            {
                                label: "Inside-line",
                                type: "checkbox",
                                checked: store.depArrowType == DEP_ARROW_TYPE.INSIDE_LINE, 
                                click: function(){
                                    rc.trigger(
                                        ACTION.KONATA_SET_DEP_ARROW_TYPE,
                                        DEP_ARROW_TYPE.INSIDE_LINE
                                    );
                                }
                            },
                            {
                                label: "Leftside-curve",
                                type: "checkbox",
                                checked: store.depArrowType == DEP_ARROW_TYPE.LEFT_SIDE_CURVE, 
                                click: function(){
                                    rc.trigger(
                                        ACTION.KONATA_SET_DEP_ARROW_TYPE,
                                        DEP_ARROW_TYPE.LEFT_SIDE_CURVE
                                    );
                                }
                            }
                        ]
                    },
                ]
            },
            {
                label: "Help",
                submenu: [
                    {
                        label: "Toggle Dev Tool",
                        click: function(){
                            rc.trigger(ACTION.SHEET_SHOW_DEV_TOOL, !store.showDevTool);
                        }
                    },
                    {
                        label: "About Konata",
                        click: function(){
                            let version = require("./version.js");
                            rc.trigger(
                                ACTION.DIALOG_MODAL_MESSAGE,
                                version.KONATA_VERSION_INFO.about
                            );
                        }
                    }
                ]
            }
        ];
    }

    function setMenu(template){
        let Menu = remote.Menu;
        let menu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(menu);
    }

    // 初期状態として store なしで1回メニューを作る
    setMenu(makeMenuTemplate());

    // メニューのチェックボックス状態の更新
    rc.on(CHANGE.MENU_UPDATE, function(){
        setMenu(makeMenuTemplate());
    });
}

// タブ用のポップアップメニューアイテムを作る
function makePopupTabMenuTemaplte(tabID){
    /* global RiotControl ACTION */
    let rc = RiotControl;
    let tab = store.tabs[tabID];

    let menuTemplate = [
        {
            label: "Syncronize scroll",
            type: "checkbox",
            checked: 
                store.activeTab.syncScroll,
            click: function(e){
                rc.trigger(ACTION.KONATA_SYNC_SCROLL, store.activeTabID, tabID, e.checked);
                // 透明化も一緒に有効にする
                rc.trigger(ACTION.KONATA_TRANSPARENT, tabID, true);
            }
        },
        {
            label: "Transparent mode",
            type: "checkbox",
            checked: tab.transparent, 
            click: function(e){
                rc.trigger(ACTION.KONATA_TRANSPARENT, tabID, e.checked);
            }
        },
        {
            label: "Hide flushed ops",
            type: "checkbox",
            checked: tab.hideFlushedOps, 
            click: function(e){
                rc.trigger(ACTION.KONATA_HIDE_FLUSHED_OPS, tabID, e.checked);
            }
        },
        {
            label: "Color scheme",
            submenu: ["Auto", "Orange", "RoyalBlue", "Onikiri"].map(function(color){
                return {
                    label: color,
                    type: "checkbox",
                    checked: tab ? tab.colorScheme == color : true, 
                    click: function(){rc.trigger(ACTION.KONATA_CHANGE_COLOR_SCHEME, tabID, color);}
                };
            }),
        },
    ];
    return menuTemplate;    
}

function popupTabMenu(tabID){

    let menuTemplate = makePopupTabMenuTemaplte(tabID);

    let remote = require("electron").remote;
    let Menu = remote.Menu;
    let menu = Menu.buildFromTemplate(menuTemplate);
    menu.popup();
}

function popupPipelineMenu(pos){

    /* global RiotControl ACTION */
    let rc = RiotControl;
    let remote = require("electron").remote;

    // 右クリック時専用
    let menuTemplate = [
        {
            label: "Adjust position",
            click: function(){rc.trigger(ACTION.KONATA_ADJUST_POSITION);}
        },
        {
            label:"Zoom out",
            click: function(){rc.trigger(ACTION.KONATA_ZOOM, 1, pos[0], pos[1]);}
        },
        {
            label:"Zoom in",
            click: function(){rc.trigger(ACTION.KONATA_ZOOM, -1, pos[0], pos[1]);}
        },
        {
            type: "separator"
        },
    ];

    // タブごとの右クリックメニューを結合
    menuTemplate = menuTemplate.concat(makePopupTabMenuTemaplte(store.activeTab.id));

    let Menu = remote.Menu;
    let menu = Menu.buildFromTemplate(menuTemplate);
    menu.popup();
}



module.exports.installMainMenu = installMainMenu;
module.exports.popupTabMenu = popupTabMenu;
module.exports.popupPipelineMenu = popupPipelineMenu;
