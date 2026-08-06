"use strict";

const path = require("node:path");
const HtmlWebpackPlugin = require("html-webpack-plugin");

module.exports = (_env, argv) => {
    const isProduction = argv.mode === "production";

    return {
        mode: isProduction ? "production" : "development",
        devtool: isProduction ? false : "inline-source-map",
        entry: "./src/index.ts",
        output: {
            // Electronのpackaging-workと混在させず、双方を独立して検証できるようにする。
            path: path.resolve(__dirname, "dist-web"),
            filename: "bundle.js",
            publicPath: "",
            clean: true,
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
            ],
        },
        plugins: [
            new HtmlWebpackPlugin({
                template: "./src/index.html",
                inject: "body",
                scriptLoading: "defer",
            }),
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
