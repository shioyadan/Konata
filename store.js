// アプリケーションの状態を保持する store


const ACTION = {
    DIALOG_FILE_OPEN: 0,
    FILE_OPEN: 10
};

function Store(){
    /* globals riot */
    riot.observable(this);

    let self = this;

    /*
    self.on(ACTION.TREE_LOAD, function(folderName) {
    });
    */

}


module.exports = Store;
