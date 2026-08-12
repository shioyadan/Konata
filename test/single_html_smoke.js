"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const outputDirectory = path.join(__dirname, "..", "dist-web");
const outputFiles = fs.readdirSync(outputDirectory).sort();

// production成果物をそのまま配布できるよう、外部ファイルの混入をここで検出する。
assert.deepEqual(outputFiles, ["index.html"]);

const html = fs.readFileSync(path.join(outputDirectory, "index.html"), "utf8");

// scriptとCSSがHTML内にあり、file://でも追加取得なしに起動できることを保証する。
assert.match(html, /<script(?:\s[^>]*)?>[\s\S]+<\/script>/i);
assert.doesNotMatch(html, /<script[^>]+\bsrc\s*=/i);
assert.doesNotMatch(html, /<link[^>]+\brel=["']?stylesheet/i);

// 単一HTMLだけを渡しても、npm外で内包されたcomponentを含む通知が失われないことを確認する。
assert.match(html, /Copyright \(C\) 2016-2026 Ryota Shioya/);
assert.match(html, /Third-Party Licenses/);
assert.match(html, /Copyright \(c\) 2020 Arjun Barrett/);
assert.match(html, /For Zstandard software/);

console.log(`Single HTML smoke test passed: ${outputFiles[0]} (${html.length} bytes)`);
