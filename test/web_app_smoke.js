"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {app, BrowserWindow} = require("electron");

// Xvfb環境ではGPUを利用できないため、ウィンドウ生成前にsoftware描画へ固定する。
app.commandLine.appendSwitch("disable-gpu");

async function dropFixture(window, fixturePath, mimeType) {
    const contents = fs.readFileSync(fixturePath).toString("base64");
    const fileName = path.basename(fixturePath);

    // RendererへNode APIを公開せず、browserで選択した時と同じFile/DragEventを組み立てる。
    await window.webContents.executeJavaScript(`(() => {
        const binary = atob(${JSON.stringify(contents)});
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
        }
        const transfer = new DataTransfer();
        transfer.items.add(new File(
            [bytes],
            ${JSON.stringify(fileName)},
            {type: ${JSON.stringify(mimeType)}}
        ));
        const target = document.querySelector(".trace-app");
        if (target === null) {
            throw new Error("The trace drop target was not found.");
        }
        target.dispatchEvent(new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer
        }));
    })()`);

    // gzip sampleでも十分な余裕を持たせ、失敗時には画面のstatusをそのまま報告する。
    return window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = performance.now() + 20000;
        const check = () => {
            const root = document.querySelector(".trace-app");
            const state = root?.dataset.loadState;
            if (state === "ready" && root?.dataset.fileName === ${JSON.stringify(fileName)}) {
                requestAnimationFrame(() => requestAnimationFrame(resolve));
                return;
            }
            if (state === "error") {
                reject(new Error(document.querySelector(".status")?.textContent ?? "Trace loading failed."));
                return;
            }
            if (performance.now() >= deadline) {
                reject(new Error("Timed out while waiting for the dropped trace."));
                return;
            }
            setTimeout(check, 25);
        };
        check();
    })`);
}

async function readRenderedState(window) {
    return window.webContents.executeJavaScript(`(() => {
        const root = document.querySelector(".trace-app");
        const heading = document.querySelector(".app-toolbar h1");
        const pipeline = document.querySelector(".pipeline-pane canvas");
        if (!(pipeline instanceof HTMLCanvasElement)) {
            throw new Error("The pipeline canvas was not found.");
        }
        const context = pipeline.getContext("2d");
        if (context === null) {
            throw new Error("The pipeline canvas has no 2D context.");
        }

        // 背景色以外のpixelが十分にあれば、gridだけでなくstageも描かれたと判断できる。
        const pixels = context.getImageData(0, 0, pipeline.width, pipeline.height).data;
        let nonBackgroundPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
            if (pixels[index] !== 38 || pixels[index + 1] !== 41 || pixels[index + 2] !== 48) {
                nonBackgroundPixels++;
            }
        }

        return {
            heading: heading?.textContent ?? null,
            status: document.querySelector(".status")?.textContent ?? null,
            headingColor: heading === null ? null : getComputedStyle(heading).color,
            rootChildCount: document.querySelector("#konata-root")?.childElementCount ?? 0,
            loadState: root?.dataset.loadState ?? null,
            fileName: root?.dataset.fileName ?? null,
            opCount: Number(root?.dataset.opCount ?? -1),
            laneCount: Number(root?.dataset.laneCount ?? -1),
            pipelineWidth: pipeline.width,
            pipelineHeight: pipeline.height,
            nonBackgroundPixels,
            zoom: document.querySelector(".zoom-controls output")?.textContent ?? null
        };
    })()`);
}

async function run() {
    // 製品Web版と同じくNode integrationを使わないRendererで検証する。
    const window = new BrowserWindow({
        show: false,
        width: 1100,
        height: 700,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });

    await window.loadFile(path.join(__dirname, "..", "dist-web", "index.html"));

    // Reactの初期描画とCSS適用を、file読み込み前にも独立して確認する。
    const initialState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const heading = document.querySelector(".app-toolbar h1");
            resolve({
                heading: heading?.textContent ?? null,
                status: document.querySelector(".status")?.textContent ?? null,
                headingColor: heading === null ? null : getComputedStyle(heading).color,
                rootChildCount: document.querySelector("#konata-root")?.childElementCount ?? 0,
                canvasCount: document.querySelectorAll(".viewer canvas").length
            });
        }));
    })`);
    if (initialState.heading !== "Konata Web" ||
        initialState.status !== "Open or drop a Kanata or gem5 O3PipeView trace." ||
        initialState.headingColor !== "rgb(255, 107, 53)" ||
        initialState.rootChildCount !== 1 ||
        initialState.canvasCount !== 2) {
        throw new Error(`React initialization is incomplete: ${JSON.stringify(initialState)}`);
    }

    const plainFixture = path.join(__dirname, "fixtures", "kanata-basic.txt");
    await dropFixture(window, plainFixture, "text/plain");
    const plainState = await readRenderedState(window);
    if (plainState.loadState !== "ready" ||
        plainState.fileName !== "kanata-basic.txt" ||
        plainState.opCount !== 2 ||
        plainState.laneCount !== 2 ||
        plainState.nonBackgroundPixels < 100) {
        throw new Error(`Plain-text trace rendering is incomplete: ${JSON.stringify(plainState)}`);
    }

    // Kanataとして不一致になった入力をgem5 Parserで開き直し、同じCanvasへ表示できることを確認する。
    const gem5Fixture = path.join(__dirname, "fixtures", "gem5-basic.txt");
    await dropFixture(window, gem5Fixture, "text/plain");
    const gem5State = await readRenderedState(window);
    if (gem5State.loadState !== "ready" ||
        gem5State.fileName !== "gem5-basic.txt" ||
        gem5State.opCount !== 1 ||
        gem5State.laneCount !== 1 ||
        gem5State.nonBackgroundPixels < 100) {
        throw new Error(`gem5 trace rendering is incomplete: ${JSON.stringify(gem5State)}`);
    }

    const gzipFixture = path.join(__dirname, "..", "docs", "kanata-sample-2.log.gz");
    await dropFixture(window, gzipFixture, "application/gzip");
    const gzipState = await readRenderedState(window);
    if (gzipState.loadState !== "ready" ||
        gzipState.fileName !== "kanata-sample-2.log.gz" ||
        gzipState.opCount !== 4041 ||
        gzipState.laneCount !== 2 ||
        gzipState.pipelineWidth <= 0 ||
        gzipState.pipelineHeight <= 0 ||
        gzipState.nonBackgroundPixels < 100) {
        throw new Error(`Gzip trace rendering is incomplete: ${JSON.stringify(gzipState)}`);
    }

    // toolbar操作もRendererへ届き、旧Rendererの1段階zoom（100%→200%）で再描画されることを確認する。
    await window.webContents.executeJavaScript(`new Promise((resolve) => {
        document.querySelector('button[aria-label="Zoom in"]')?.click();
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`);
    const zoomedState = await readRenderedState(window);
    if (zoomedState.zoom !== "200%" || zoomedState.nonBackgroundPixels < 100) {
        throw new Error(`Zoom rendering is incomplete: ${JSON.stringify(zoomedState)}`);
    }

    console.log(`Web smoke test passed: ${JSON.stringify(zoomedState)}`);
    window.destroy();
}

app.whenReady()
    .then(run)
    .then(() => app.exit(0))
    .catch((error) => {
        console.error("Web smoke test failed:", error);
        app.exit(1);
    });
