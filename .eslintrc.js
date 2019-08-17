module.exports = {
    "env": {
        "browser": true,
        "node": true,
        "jquery": true,
        "es6": true
    },
    "parserOptions": {
        // let/const/forOf/async などを使うため，バージョンをあげる
        "ecmaVersion": 2018
    },
    "extends": "eslint:recommended",
    "rules": {
        "indent": [
            "error",
            4
        ],
        "linebreak-style": [
            "error",
            "unix"
        ],
        "quotes": [
            "error",
            "double"
        ],
        "semi": [
            "error",
            "always"
        ],

        // var は不許可に
        "no-var": [
            "error"
        ],

        // riot タグ間で二重定義とされてしまうので無効化
        // let の場合，二重定義は実行時にエラーとされる
        "no-redeclare": [
            "off"
        ],

        // console.log を仕様できるように
        "no-console": [
            "off"
        ]
    },

    // HTML 内のスクリプトをチェックするためにプラグインを有効化
    "plugins": ["html"],

};