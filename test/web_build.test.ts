import assert from "node:assert/strict";
import test from "node:test";

const minifyCSS = require("../tools/minify_css_loader.js");

test("Production CSS removes comments while preserving literals, licenses and imports", () => {
    const css = `
        /*! Example license */
        @import "./theme.css";
        /* 開発用コメント */
        .example::after {
            content: "/* literal, not a comment */";
            background: url("./image.png");
            width: calc(100% - var(--gap));
        }
    `;
    const result = minifyCSS.call({ emitWarning: assert.fail }, css);
    assert(!result.includes("開発用コメント"));
    assert(result.includes("/*! Example license */"));
    assert(result.includes('"/* literal, not a comment */"'));
    assert(result.includes("@import url(theme.css);"));
    assert(result.includes('url("./image.png")'));
    assert(result.includes("calc(100% - var(--gap))"));
    assert(result.length < css.length);
});
