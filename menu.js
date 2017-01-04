function installMenu(){

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
                    click: function(){remote.app.quit();}
                },
            ]
        },
        {
            label: "操作",
            submenu: [
                {
                    label:"Next Tab",
                    accelerator:"Command+N",
                    click: function(){NextTab(true);}
                },
                {
                    label:"Previous Tab",
                    accelerator:"Command+P",
                    click: function(){NextTab(false);}
                },
                {
                    label:"Zoom up",
                    accelerator:"Command+Shift+=",
                    click: function(){Zoom(true);}
                },
                {
                    label:"Zoom down",
                    accelerator:"Command+-",
                    click: function(){Zoom(false);}
                },
            ]
        },
        {
            label: "表示",
            submenu: [
                {
                    label:"全体を半透明化",
                    accelerator:"Command+Shift+O",
                    click: function(){Transparent(true, false);}
                },
                {
                    label:"背景を透明化",
                    //accelerator:"Command+P",
                    click: function(){Transparent(true, true);}
                },
                {
                    label:"透明化を解除",
                    //accelerator:"Command+Shift+=",
                    click: function(){Transparent(false, false);}
                },
                {
                    label:"全体を橙色に",
                    //accelerator:"Command+-",
                    click: function(){Color("#f80");}
                },
                {
                    label:"全体を青色に",
                    //accelerator:"Command+-",
                    click: function(){Color("#08f");}
                },
                {
                    label:"デフォルトの配色",
                    //accelerator:"Command+-",
                    click: function(){Color(null);}
                },
                {
                    label:"Retina切り替え",
                    //accelerator:"Command+-",
                    click: function(){
                        konata.RetinaSwitch();
                        konata.Draw(index.path);
                    }
                },
            ]
        }
    ];

    let Menu = remote.Menu;
    let menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);
}

module.exports = installMenu;
