// アプリケーションの状態を保持する store


const ACTION = {
    DIALOG_FILE_OPEN: 0,
    
    FILE_OPEN: 10,
    FILE_CLOSE: 11,

    TAB_OPEN: 20,
    TAB_CLOSE: 21,

    APP_QUIT: 30
};

function Store(){
    /* globals riot */
    riot.observable(this);

    let self = this;

    self.fileName = null;

    // ファイルオープン
    self.on(ACTION.FILE_OPEN, function(fileName){
        self.fileName = fileName;
        self.trigger(ACTION.TAB_OPEN, fileName);
    });

    // ファイルクローズ
    self.on(ACTION.FILE_CLOSE, function(fileName){
        self.trigger(ACTION.TAB_CLOSE, fileName);
    });

}


module.exports = Store;
