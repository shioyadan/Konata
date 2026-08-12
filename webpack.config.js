"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const HtmlInlineScriptPlugin = require("html-inline-script-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const TerserPlugin = require("terser-webpack-plugin");
const webpack = require("webpack");
const packageJSON = require("./package.json");
const license = fs.readFileSync(path.join(__dirname, "LICENSE.md"), "utf8");
const thirdPartyLicenses = fs.readFileSync(
    path.join(__dirname, "THIRD_PARTY_LICENSES.md"),
    "utf8",
);

function getGitBuildInfo() {
    try {
        // 実行時刻ではなくcommit日を埋め込み、同じcommitからのbuild結果を安定させる。
        const output = execFileSync(
            "git",
            ["show", "-s", "--format=%h%n%cs", "HEAD"],
            { cwd: __dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        const [commit, date] = output.split("\n");
        return { commit: commit || "unknown", date: date || "unknown" };
    }
    catch {
        // .gitを含まないsource archiveからも単一HTMLを生成できるようにする。
        return { commit: "unknown", date: "unknown" };
    }
}

module.exports = (_env, argv) => {
    const isProduction = argv.mode === "production";
    const gitBuildInfo = getGitBuildInfo();

    return {
        mode: isProduction ? "production" : "development",
        devtool: isProduction ? false : "inline-source-map",
        entry: "./src/index.tsx",
        output: {
            // developmentとproductionの生成物を同じ場所へまとめ、ソースツリーへ出力しない。
            path: path.resolve(__dirname, "dist-web"),
            filename: "bundle.js",
            publicPath: "",
            clean: true,
        },
        optimization: {
            // 第三者ライセンスコメントをHTML内に保ち、別ファイルへの抽出で単一HTMLを崩さない。
            minimizer: [new TerserPlugin({ extractComments: false })],
        },
        resolve: {
            extensions: [".ts", ".tsx", ".js"],
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    exclude: [/node_modules/, /zstd_stream_worker\.ts$/],
                    use: {
                        loader: "ts-loader",
                        options: {
                            configFile: "tsconfig.json",
                        },
                    },
                },
                {
                    // productionの単一HTMLを維持するため、zstd WorkerもBlob URLとしてbundleへ内包する。
                    test: /zstd_stream_worker\.ts$/,
                    use: [
                        {
                            loader: "worker-loader",
                            options: {
                                inline: "no-fallback",
                                filename: "zstd_stream_worker.js",
                            },
                        },
                        {
                            loader: "ts-loader",
                            options: {
                                configFile: "tsconfig.json",
                            },
                        },
                    ],
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
            new webpack.DefinePlugin({
                __KONATA_VERSION__: JSON.stringify(packageJSON.version),
                __KONATA_COMMIT__: JSON.stringify(gitBuildInfo.commit),
                __KONATA_COMMIT_DATE__: JSON.stringify(gitBuildInfo.date),
                // 単一HTMLだけを配布してもライセンスが必ず同伴するよう、正本をそのまま埋め込む。
                __KONATA_LICENSE__: JSON.stringify(license),
                __KONATA_THIRD_PARTY_LICENSES__: JSON.stringify(thirdPartyLicenses),
            }),
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
