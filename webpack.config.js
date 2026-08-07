"use strict";

const path = require("node:path");
const HtmlInlineScriptPlugin = require("html-inline-script-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const TerserPlugin = require("terser-webpack-plugin");

module.exports = (_env, argv) => {
    const isProduction = argv.mode === "production";

    return {
        mode: isProduction ? "production" : "development",
        devtool: isProduction ? false : "inline-source-map",
        entry: "./src/index.tsx",
        output: {
            // Electronのpackaging-workと混在させず、双方を独立して検証できるようにする。
            path: path.resolve(__dirname, "dist-web"),
            filename: "bundle.js",
            publicPath: "",
            clean: true,
        },
        optimization: {
            // 第三者ライセンスは専用文書で配布し、圧縮時のコメント外出しで単一HTMLを崩さない。
            minimizer: [new TerserPlugin({ extractComments: false })],
        },
        resolve: {
            extensions: [".ts", ".tsx", ".js"],
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    exclude: /node_modules/,
                    use: {
                        loader: "ts-loader",
                        options: {
                            configFile: "tsconfig.json",
                        },
                    },
                },
                {
                    test: /\.css$/,
                    use: ["style-loader", "css-loader"],
                },
                {
                    // 単一HTMLを壊さないよう、将来追加する画像とフォントもbundle内へ埋め込む。
                    test: /\.(?:eot|gif|jpe?g|png|svg|ttf|webp|woff2?)$/i,
                    type: "asset/inline",
                },
            ],
        },
        plugins: [
            new HtmlWebpackPlugin({
                template: "./src/index.html",
                inject: "body",
                scriptLoading: "defer",
                minify: isProduction,
            }),
            // 開発サーバとの相性を保つため、bundleのHTML内包はproduction時だけ行う。
            ...(isProduction ? [new HtmlInlineScriptPlugin()] : []),
        ],
        devServer: {
            // Docker外から接続できるよう全IFで待ち受け、公開範囲はMakefile側でlocalhostに絞る。
            host: "0.0.0.0",
            port: 8080,
            hot: false,
            liveReload: true,
            client: {
                overlay: true,
            },
        },
    };
};
