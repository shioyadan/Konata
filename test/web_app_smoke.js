"use strict";

const path = require("node:path");
const { app, BrowserWindow } = require("electron");

// Xvfb環境ではGPUを利用できないため、ウィンドウ生成前にソフトウェア描画へ固定する。
app.commandLine.appendSwitch("disable-gpu");

async function run() {
    // 製品Web版と同じくNode integrationを使わないRendererで検証する。
    const window = new BrowserWindow({
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });

    await window.loadFile(path.join(__dirname, "..", "dist-web", "index.html"));

    // Reactの描画予約が確実に反映された次のフレームで、DOMと計算済みスタイルを読む。
    const state = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const heading = document.querySelector(".app-shell h1");
            resolve({
                heading: heading?.textContent ?? null,
                status: document.querySelector(".status")?.textContent ?? null,
                headingColor: heading === null ? null : getComputedStyle(heading).color,
                rootChildCount: document.querySelector("#konata-root")?.childElementCount ?? 0
            });
        }));
    })`);

    if (state.heading !== "Konata Web" ||
        state.status !== "The React web shell is ready." ||
        state.headingColor !== "rgb(255, 107, 53)" ||
        state.rootChildCount !== 1) {
        throw new Error(`React initialization is incomplete: ${JSON.stringify(state)}`);
    }

    console.log(`Web smoke test passed: ${JSON.stringify(state)}`);
    window.destroy();
}

app.whenReady()
    .then(run)
    .then(() => app.exit(0))
    .catch((error) => {
        console.error("Web smoke test failed:", error);
        app.exit(1);
    });
