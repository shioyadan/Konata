"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.join(__dirname, "..");
const packageJSON = require(path.join(repositoryRoot, "package.json"));
const packageLock = require(path.join(repositoryRoot, "package-lock.json"));
const licenseDocument = fs.readFileSync(
    path.join(repositoryRoot, "THIRD_PARTY_LICENSES.md"),
    "utf8",
);

// これらはdevDependencyだが、loaderやWebpackのランタイムコードが生成HTMLへ入る。
// 単なるビルド・テスト用パッケージは列挙せず、配布物に含まれるものだけを監査する。
const bundledBuildPackages = [
    "css-loader",
    "style-loader",
    "webpack",
    "worker-loader",
];

const table = licenseDocument.match(
    /<!-- bundled-npm-packages:start -->([\s\S]*?)<!-- bundled-npm-packages:end -->/,
);
assert(table !== null, "The bundled npm package table was not found in THIRD_PARTY_LICENSES.md.");

const documentedPackages = new Map();
for (const line of table[1].split("\n")) {
    // 表をプレーンテキストで表示しても揃えられるよう、セル末尾の空白を許容する。
    const row = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|$/);
    if (row === null) {
        continue;
    }
    const [, name, version, license] = row;
    assert(!documentedPackages.has(name), `Duplicate third-party package entry: ${name}`);
    documentedPackages.set(name, { version, license });
}

// package-lock v3ではproduction依存にdev=trueが付かないため、間接依存も含めて拾える。
// 新しいproduction依存を追加したのにライセンス監査を忘れると、ここで集合がずれて失敗する。
const productionPackages = Object.entries(packageLock.packages)
    .filter(([packagePath, metadata]) => packagePath.startsWith("node_modules/") && metadata.dev !== true)
    .map(([packagePath]) => packagePath.slice("node_modules/".length));
const expectedPackages = [...new Set([...productionPackages, ...bundledBuildPackages])].sort();

assert.deepEqual(
    [...documentedPackages.keys()].sort(),
    expectedPackages,
    "THIRD_PARTY_LICENSES.md does not match the packages included in the production HTML.",
);

for (const name of expectedPackages) {
    const lockMetadata = packageLock.packages[`node_modules/${name}`];
    const packageMetadata = JSON.parse(fs.readFileSync(
        path.join(repositoryRoot, "node_modules", name, "package.json"),
        "utf8",
    ));
    const documented = documentedPackages.get(name);

    assert(lockMetadata !== undefined, `Package is missing from package-lock.json: ${name}`);
    assert(documented !== undefined, `Package is missing from THIRD_PARTY_LICENSES.md: ${name}`);
    assert.equal(documented.version, lockMetadata.version, `Version mismatch for ${name}.`);
    assert.equal(packageMetadata.version, lockMetadata.version, `Installed version mismatch for ${name}.`);
    assert.equal(documented.license, packageMetadata.license, `License mismatch for ${name}.`);
}

// rootのproduction依存は上のlockfile走査に必ず現れることも明示的に確認する。
for (const name of Object.keys(packageJSON.dependencies ?? {})) {
    assert(expectedPackages.includes(name), `Production dependency was not audited: ${name}`);
}

console.log(`Third-party license check passed: ${expectedPackages.length} bundled npm packages.`);
