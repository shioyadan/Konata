"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {app, BrowserWindow} = require("electron");

// Xvfb環境ではGPUを利用できないため、ウィンドウ生成前にsoftware描画へ固定する。
app.commandLine.appendSwitch("disable-gpu");

async function dropFixture(window, fixturePath, mimeType, verifyProgressBar = false) {
    const contents = fs.readFileSync(fixturePath).toString("base64");
    const fileName = path.basename(fixturePath);

    // RendererへNode APIを公開せず、browserで選択した時と同じFile/DragEventを組み立てる。
    await window.webContents.executeJavaScript(`(() => {
        const binary = atob(${JSON.stringify(contents)});
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
        }
        const file = new File(
            [bytes],
            ${JSON.stringify(fileName)},
            {type: ${JSON.stringify(mimeType)}}
        );
        if (${verifyProgressBar ? "true" : "false"}) {
            // 高速なfixtureでも読み込み中の1frameを観測できるよう、この検査時だけ先頭chunkを遅らせる。
            const originalStream = file.stream.bind(file);
            Object.defineProperty(file, "stream", {value: () => {
                const reader = originalStream().getReader();
                let first = true;
                return new ReadableStream({
                    async pull(controller) {
                        if (first) {
                            first = false;
                            await new Promise((resolve) => setTimeout(resolve, 250));
                        }
                        const result = await reader.read();
                        if (result.done) {
                            controller.close();
                        }
                        else {
                            controller.enqueue(result.value);
                        }
                    },
                    cancel(reason) {
                        return reader.cancel(reason);
                    }
                });
            }});
        }
        const target = document.querySelector(".trace-app");
        if (target === null) {
            throw new Error("The trace drop target was not found.");
        }
        if (${verifyProgressBar ? "true" : "false"}) {
            const event = new Event("drop", {bubbles: true, cancelable: true});
            Object.defineProperty(event, "dataTransfer", {value: {files: [file]}});
            target.dispatchEvent(event);
        }
        else {
            const transfer = new DataTransfer();
            transfer.items.add(file);
            target.dispatchEvent(new DragEvent("drop", {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer
            }));
        }
    })()`);

    if (verifyProgressBar) {
        // 旧版と同じ、背景trackなし・高さ3pxの青いbarが読み込み中だけ現れることを確認する。
        const progressState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
            const deadline = performance.now() + 200;
            const check = () => {
                const progress = document.querySelector('[role="progressbar"]');
                const bar = progress?.firstElementChild;
                if (progress instanceof HTMLElement && bar instanceof HTMLElement) {
                    resolve({
                        found: true,
                        height: getComputedStyle(progress).height,
                        trackColor: getComputedStyle(progress).backgroundColor,
                        barColor: getComputedStyle(bar).backgroundColor
                    });
                }
                else if (performance.now() >= deadline) {
                    resolve({found: false, height: null, trackColor: null, barColor: null});
                }
                else {
                    setTimeout(check, 5);
                }
            };
            check();
        })`);
        if (!progressState.found ||
            progressState.height !== "3px" ||
            progressState.trackColor !== "rgba(0, 0, 0, 0)" ||
            progressState.barColor !== "rgb(77, 136, 255)") {
            throw new Error(`Load progress appearance is incomplete: ${JSON.stringify(progressState)}`);
        }
    }

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
            status: document.querySelector(".status")?.textContent ?? null,
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
            resolve({
                title: document.title,
                headingCount: document.querySelectorAll(".app-toolbar h1").length,
                status: document.querySelector(".status")?.textContent ?? null,
                rootChildCount: document.querySelector("#konata-root")?.childElementCount ?? 0,
                canvasCount: document.querySelectorAll(".viewer canvas").length
            });
        }));
    })`);
    if (initialState.title !== "Konata" ||
        initialState.headingCount !== 0 ||
        initialState.status !== "Open or drop a Kanata or gem5 O3PipeView trace." ||
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

    // 実Canvas上のpointer位置をRendererへ渡し、旧版と同じcycle/op/stage tooltipを表示する。
    const toolTipText = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const canvas = document.querySelector(".pipeline-pane canvas");
        if (!(canvas instanceof HTMLCanvasElement)) {
            throw new Error("The pipeline canvas was not found.");
        }
        const rect = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new MouseEvent("mousemove", {
            bubbles: true,
            clientX: rect.left + 8,
            clientY: rect.top + 8
        }));
        requestAnimationFrame(() => resolve(document.querySelector('[role="tooltip"]')?.textContent ?? null));
    })`);
    if (typeof toolTipText !== "string" || !toolTipText.startsWith("[0, 0]")) {
        throw new Error(`Pipeline tooltip is incomplete: ${JSON.stringify(toolTipText)}`);
    }

    // 旧label paneと同じく、2命令目のlabelをクリックするとそのfetch cycleを左端へ合わせる。
    const labelClickToolTip = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const label = document.querySelector(".label-pane canvas");
        const pipeline = document.querySelector(".pipeline-pane canvas");
        if (!(label instanceof HTMLCanvasElement) || !(pipeline instanceof HTMLCanvasElement)) {
            throw new Error("The trace canvases were not found.");
        }
        const labelRect = label.getBoundingClientRect();
        label.dispatchEvent(new MouseEvent("click", {
            bubbles: true,
            clientX: labelRect.left + 8,
            clientY: labelRect.top + 30
        }));
        const pipelineRect = pipeline.getBoundingClientRect();
        pipeline.dispatchEvent(new MouseEvent("mousemove", {
            bubbles: true,
            clientX: pipelineRect.left + 8,
            clientY: pipelineRect.top + 8
        }));
        requestAnimationFrame(() => resolve(document.querySelector('[role="tooltip"]')?.textContent ?? null));
    })`);
    if (typeof labelClickToolTip !== "string" || !labelClickToolTip.startsWith("[3, 0]")) {
        throw new Error(`Label click alignment is incomplete: ${JSON.stringify(labelClickToolTip)}`);
    }

    // 旧版の左右キーは1回につき6cycle移動する。右へ動かした後、後続テスト用に左へ戻す。
    const keyboardToolTip = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        document.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true}));
        const pipeline = document.querySelector(".pipeline-pane canvas");
        if (!(pipeline instanceof HTMLCanvasElement)) {
            throw new Error("The pipeline canvas was not found.");
        }
        const rect = pipeline.getBoundingClientRect();
        pipeline.dispatchEvent(new MouseEvent("mousemove", {
            bubbles: true,
            clientX: rect.left + 8,
            clientY: rect.top + 8
        }));
        requestAnimationFrame(() => {
            const text = document.querySelector('[role="tooltip"]')?.textContent ?? null;
            document.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowLeft", bubbles: true}));
            resolve(text);
        });
    })`);
    if (typeof keyboardToolTip !== "string" || !keyboardToolTip.startsWith("[9, 0]")) {
        throw new Error(`Keyboard navigation is incomplete: ${JSON.stringify(keyboardToolTip)}`);
    }

    // Webでは旧native menuの代わりにView panelからRendererの表示modeを変更する。
    const viewControlState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const split = document.querySelector('input[aria-label="Split lanes"]');
        const fixed = document.querySelector('input[aria-label="Fix op height"]');
        const arrows = document.querySelector('select[aria-label="Dependency arrow type"]');
        const theme = document.querySelector('select[aria-label="UI color theme"]');
        const color = document.querySelector('select[aria-label="Pipeline color scheme"]');
        const textThreshold = document.querySelector('input[aria-label="Text drawing threshold"]');
        if (!(split instanceof HTMLInputElement) ||
            !(fixed instanceof HTMLInputElement) ||
            !(arrows instanceof HTMLSelectElement) ||
            !(theme instanceof HTMLSelectElement) ||
            !(color instanceof HTMLSelectElement) ||
            !(textThreshold instanceof HTMLInputElement)) {
            throw new Error("The renderer view controls were not found.");
        }
        split.click();
        arrows.value = "leftSideCurve";
        arrows.dispatchEvent(new Event("change", {bubbles: true}));
        theme.value = "light";
        theme.dispatchEvent(new Event("change", {bubbles: true}));
        color.value = "Custom";
        color.dispatchEvent(new Event("change", {bubbles: true}));
        textThreshold.value = "12";
        textThreshold.dispatchEvent(new Event("input", {bubbles: true}));
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            split: split.checked,
            fixEnabled: !fixed.disabled,
            arrows: arrows.value,
            theme: document.querySelector(".trace-app")?.dataset.theme ?? null,
            color: color.value,
            textThreshold: textThreshold.value,
            labelBackground: getComputedStyle(document.querySelector(".label-pane")).backgroundColor,
            pipelineBackground: getComputedStyle(document.querySelector(".pipeline-pane")).backgroundColor
        })));
    })`);
    if (!viewControlState.split ||
        !viewControlState.fixEnabled ||
        viewControlState.arrows !== "leftSideCurve" ||
        viewControlState.theme !== "light" ||
        viewControlState.color !== "Custom" ||
        viewControlState.textThreshold !== "12" ||
        viewControlState.labelBackground !== "rgb(244, 244, 244)" ||
        viewControlState.pipelineBackground !== "rgb(255, 255, 255)") {
        throw new Error(`Renderer view controls are incomplete: ${JSON.stringify(viewControlState)}`);
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
    await dropFixture(window, gzipFixture, "application/gzip", true);
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
