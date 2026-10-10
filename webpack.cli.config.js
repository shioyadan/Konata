"use strict";

// CLIと依存ライブラリ（ZstandardのWASMを含む）をNode用の単一JSへまとめる。
// Web版とは出力先を分け、HTMLの再buildでCLIを消さず、実行時のnpm installも不要にする。
const fs = require("node:fs");
const path = require("node:path");
const TerserPlugin = require("terser-webpack-plugin");
const webpack = require("webpack");

module.exports = {
    mode: "production",
    target: "node18",
    entry: "./src/cli/main.ts",
    devtool: false,
    output: {
        path: path.resolve(__dirname, "dist-cli"),
        filename: "konata-cli.js",
        clean: true,
    },
    resolve: { extensions: [".ts", ".js"] },
    module: {
        rules: [{
            test: /\.ts$/,
            exclude: /node_modules/,
            loader: "ts-loader",
            options: { configFile: "tsconfig.cli.json" },
        }],
    },
    optimization: {
        minimizer: [new TerserPlugin({ extractComments: false })],
    },
    plugins: [
        // 外部chunkやlicense sidecarを作らず、JSを一つコピーするだけでも動く配布契約を保つ。
        new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
        new webpack.BannerPlugin({
            banner: "Konata CLI\n\n" + ["LICENSE.md", "THIRD_PARTY_LICENSES.md"]
                .map((name) => fs.readFileSync(path.join(__dirname, name), "utf8"))
                .join("\n\n"),
        }),
    ],
};
