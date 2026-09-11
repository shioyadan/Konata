"use strict";

const CleanCSS = require("clean-css");

module.exports = function minifyCSS(source) {
    const result = new CleanCSS({
        // 宣言の最適化はせず、通常コメントと空白だけを削る。ライセンスコメントは保つ。
        level: { 1: { all: false, specialComments: "all" } },
        // importとURLの解決は後段のcss-loaderへ任せる。
        inline: false,
        rebase: false,
    }).minify(source);
    if (result.errors.length > 0) {
        throw new Error(result.errors.join("\n"));
    }
    for (const warning of result.warnings) {
        this.emitWarning(new Error(warning));
    }
    return result.styles;
};
