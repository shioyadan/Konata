var Op = require("./Op");
/* （主に）メインプロセス側の勉強用の.jsファイル．色々試しに使ってる． */

function Module(id) {
    this.id = id;

    this.init = function() {
        console.log("hello", this.goodbye(), " " , this.id);
        return 'hello!';
    };
    this.goodbye = function() {
        return 'goodbye!';
    };

// 非同期の書き方はsetTimeout()とPromise()の二通り
//   基礎知識としてjavascriptは1つの実行キューを持つシングルスレッドな言語．
// 基本的に，逐次に実行キューに関数（命令）が挿入され，逐次実行される．
// (Electronはメインプロセスとレンダラプロセスでそれぞれキューを持っている？)
//   setTimeout(function(){}, delay)では，delay後に実行キューに挿入される．
// なので，delay後に実行開始を保証するわけではない．
//   Promise(function(){}) はこれを返り値にすることで，その関数の終了時に
// function(){}を実行する．Promiseを渡された呼び出し元の関数はこの関数の
// 終了を待たず次ステップに進むことができる．
// …シングルスレッドなのに，なぜPromise()を使うと先行することができるのか？
// → DBやCGIに仕事を任せて，待機している状態においてその待機時間を先行実行に充てている．
// つまり，Promiseを返す関数は外部に仕事を委託することを前提になっている．
// ということはElectronでこの仕組みを上手く使うには，例えばレンダラプロセス側でPromiseを使い，メインプロセスの応答を待つ，あるいはメインプロセス側でPromiseを使いレンダラプロセスの応答を待つ，という使い方が正しい？
    this.AsyncMethod = function () {
        //setTimeout(function () {
        for (var j = 0; j < 100000; j++) {
            var i = 0;
            var array = [];
            while(i < 500) {
                array.push(i);
                //array.sort();
                array = array.reverse();
                //this.Sleep(1);
                i++;
            }
        }
        return new Promise(function(callback){
            callback(array);
        });
    }

    this.Sleep = function (T) {
        var d1 = new Date().getTime();
        var d2 = new Date().getTime();
        while( d2 < d1+1000*T ){    //T秒待つ
            d2=new Date().getTime();
        }
        return;
    }
}
module.exports = Module;
