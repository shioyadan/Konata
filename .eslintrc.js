module.exports = {
    "env": {
        "browser": true,
        "node": true,
        "jquery": true
    },
    "extends": "eslint:recommended",
    "rules": {
        "indent": [
            "error",
            4
        ],
        "linebreak-style": [
            "error",
            "windows"
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

    // let/const/forOf などを使う
    "parserOptions": {
        "ecmaVersion": 6,
    },
};