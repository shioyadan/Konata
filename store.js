// アプリケーションの状態を保持する store


const ACTION = {
    // TREE_LOAD: 0,
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
