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

async function verifyIncrementalRendering(window) {
    return window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const firstLines = [
            "Kanata\\t0004",
            "I\\t0\\t10\\t0",
            "S\\t0\\t0\\tF",
            "C\\t1",
            "R\\t0\\t0\\t0"
        ];
        // 8,192行目の進捗通知で1命令を描画し、残りの入力は観測できる時間だけ遅らせる。
        while (firstLines.length < 8192) {
            firstLines.push("C\\t0");
        }
        const firstText = firstLines.join("\\n") + "\\n";
        const secondText = [
            "I\\t1\\t11\\t0",
            "S\\t1\\t0\\tF",
            "C\\t1",
            "R\\t1\\t1\\t0"
        ].join("\\n");
        const file = new File([firstText, secondText], "incremental.log", {type: "text/plain"});
        const encoder = new TextEncoder();
        const chunks = [encoder.encode(firstText), encoder.encode(secondText)];

        // browserのFile APIは維持し、検査時だけ2番目のchunk到着を遅らせる。
        Object.defineProperty(file, "stream", {value: () => {
            let index = 0;
            return new ReadableStream({
                async pull(controller) {
                    if (index >= chunks.length) {
                        controller.close();
                        return;
                    }
                    if (index === 1) {
                        await new Promise((done) => setTimeout(done, 300));
                    }
                    controller.enqueue(chunks[index]);
                    index++;
                }
            });
        }});

        const target = document.querySelector(".trace-app");
        if (target === null) {
            reject(new Error("The trace drop target was not found."));
            return;
        }
        const event = new Event("drop", {bubbles: true, cancelable: true});
        Object.defineProperty(event, "dataTransfer", {value: {files: [file]}});
        target.dispatchEvent(event);

        const deadline = performance.now() + 5000;
        let partialPixels = 0;
        const check = () => {
            const root = document.querySelector(".trace-app");
            const state = root?.dataset.loadState;
            const opCount = Number(root?.dataset.opCount ?? -1);
            if (state === "loading" && opCount === 1 && partialPixels === 0) {
                const canvas = document.querySelector(".pipeline-pane canvas");
                if (canvas instanceof HTMLCanvasElement) {
                    const context = canvas.getContext("2d");
                    const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
                    if (pixels !== undefined) {
                        for (let index = 0; index < pixels.length; index += 4) {
                            if (pixels[index] !== 38 || pixels[index + 1] !== 41 || pixels[index + 2] !== 48) {
                                partialPixels++;
                            }
                        }
                    }
                }
            }
            if (state === "ready" && opCount === 2) {
                resolve({partialPixels, finalOpCount: opCount});
                return;
            }
            if (state === "error") {
                reject(new Error(document.querySelector(".status")?.textContent ?? "Trace loading failed."));
                return;
            }
            if (performance.now() >= deadline) {
                reject(new Error("Timed out while waiting for incremental rendering."));
                return;
            }
            setTimeout(check, 5);
        };
        check();
    })`);
}

async function verifyClosedTabCancelsLoading(window) {
    return window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const lines = ["Kanata\\t0004", "I\\t0\\t10\\t0", "S\\t0\\t0\\tF"];
        while (lines.length < 8192) {
            lines.push("C\\t0");
        }
        const contents = lines.join("\\n") + "\\n";
        const file = new File([contents], "cancel-loading.log", {type: "text/plain"});
        let streamCanceled = false;
        Object.defineProperty(file, "stream", {value: () => new ReadableStream({
            start(controller) {
                // EOFを渡さず、タブを閉じるまでParserが入力待ちになるstreamを作る。
                controller.enqueue(new TextEncoder().encode(contents));
            },
            cancel() {
                streamCanceled = true;
            }
        })});

        const target = document.querySelector(".trace-app");
        if (target === null) {
            reject(new Error("The trace drop target was not found."));
            return;
        }
        const event = new Event("drop", {bubbles: true, cancelable: true});
        Object.defineProperty(event, "dataTransfer", {value: {files: [file]}});
        target.dispatchEvent(event);

        const deadline = performance.now() + 5000;
        let closeClicked = false;
        const check = () => {
            const close = document.querySelector('button[aria-label="Close cancel-loading.log"]');
            const loading = document.querySelector(".trace-app")?.dataset.loadState === "loading";
            const opCount = Number(document.querySelector(".trace-app")?.dataset.opCount ?? -1);
            if (!closeClicked && close instanceof HTMLButtonElement && loading && opCount === 0) {
                closeClicked = true;
                close.click();
            }
            if (closeClicked && streamCanceled && close === null) {
                resolve({streamCanceled, tabClosed: true});
                return;
            }
            if (performance.now() >= deadline) {
                reject(new Error("Timed out while waiting for the closed tab to cancel loading."));
                return;
            }
            setTimeout(check, 5);
        };
        check();
    })`);
}

async function moveSplitter(window, position) {
    return window.webContents.executeJavaScript(`new Promise((resolve) => {
        const viewer = document.querySelector(".viewer");
        const label = document.querySelector(".label-pane");
        const pipeline = document.querySelector(".pipeline-pane");
        const splitter = document.querySelector('[role="separator"][aria-label="Resize instruction labels"]');
        if (!(viewer instanceof HTMLElement) ||
            !(label instanceof HTMLElement) ||
            !(pipeline instanceof HTMLElement) ||
            !(splitter instanceof HTMLElement)) {
            throw new Error("The trace pane splitter was not found.");
        }
        const viewerRect = viewer.getBoundingClientRect();
        const splitterRect = splitter.getBoundingClientRect();
        const initialLabelWidth = Math.round(label.getBoundingClientRect().width);
        splitter.dispatchEvent(new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: splitterRect.left + splitterRect.width / 2
        }));
        window.dispatchEvent(new MouseEvent("mousemove", {
            bubbles: true,
            clientX: viewerRect.left + ${position}
        }));
        window.dispatchEvent(new MouseEvent("mouseup", {bubbles: true}));
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            initialLabelWidth,
            viewerWidth: Math.round(viewer.getBoundingClientRect().width),
            labelWidth: Math.round(label.getBoundingClientRect().width),
            splitterWidth: Math.round(splitter.getBoundingClientRect().width),
            pipelineWidth: Math.round(pipeline.getBoundingClientRect().width),
            position: splitter.getAttribute("aria-valuenow"),
            cursor: getComputedStyle(splitter).cursor
        })));
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
            // bookmark検査を実環境の保存値から隔離し、同じprocess内のreloadでは維持する。
            partition: "web-smoke",
        },
    });

    const webFile = path.join(__dirname, "..", "dist-web", "index.html");
    await window.loadFile(webFile);

    // Reactの初期描画とCSS適用を、file読み込み前にも独立して確認する。
    const initialState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const openButton = document.querySelector(".primary-button");
            const buildInfo = document.querySelector(".build-info");
            const viewer = document.querySelector(".viewer");
            const labelPane = document.querySelector(".label-pane");
            const pipelinePane = document.querySelector(".pipeline-pane");
            resolve({
                title: document.title,
                headingCount: document.querySelectorAll(".app-toolbar h1").length,
                status: document.querySelector(".status")?.textContent ?? null,
                rootChildCount: document.querySelector("#konata-root")?.childElementCount ?? 0,
                paneTitleCount: document.querySelectorAll(".pane-title").length,
                openButtonColor: openButton === null ? null : getComputedStyle(openButton).backgroundColor,
                canvasCount: document.querySelectorAll(".viewer canvas").length,
                splitterCount: document.querySelectorAll(".pane-splitter").length,
                viewerWidth: Math.round(viewer?.getBoundingClientRect().width ?? -1),
                labelWidth: Math.round(labelPane?.getBoundingClientRect().width ?? -1),
                pipelineWidth: Math.round(pipelinePane?.getBoundingClientRect().width ?? -1),
                version: buildInfo?.dataset.version ?? null,
                commit: buildInfo?.dataset.commit ?? null,
                date: buildInfo?.dataset.date ?? null,
                buildInfoText: buildInfo?.textContent?.trim() ?? null
            });
        }));
    })`);
    if (initialState.title !== "Konata" ||
        initialState.headingCount !== 0 ||
        initialState.status !== "Open or drop a Kanata or gem5 O3PipeView trace." ||
        initialState.rootChildCount !== 1 ||
        initialState.paneTitleCount !== 0 ||
        initialState.openButtonColor !== "rgb(52, 74, 100)" ||
        initialState.canvasCount !== 2 ||
        initialState.splitterCount !== 0 ||
        initialState.labelWidth !== 0 ||
        initialState.pipelineWidth !== initialState.viewerWidth ||
        initialState.version !== "1.0.0" ||
        !/^[0-9a-f]+$/.test(initialState.commit ?? "") ||
        !/^\d{4}-\d{2}-\d{2}$/.test(initialState.date ?? "") ||
        initialState.buildInfoText !==
            `Version ${initialState.version} · Commit ${initialState.commit} · ${initialState.date}`) {
        throw new Error(`React initialization is incomplete: ${JSON.stringify(initialState)}`);
    }

    const incrementalState = await verifyIncrementalRendering(window);
    if (incrementalState.partialPixels < 100 || incrementalState.finalOpCount !== 2) {
        throw new Error(`Incremental trace rendering is incomplete: ${JSON.stringify(incrementalState)}`);
    }

    const canceledLoadState = await verifyClosedTabCancelsLoading(window);
    if (!canceledLoadState.streamCanceled || !canceledLoadState.tabClosed) {
        throw new Error(`Closing a loading tab did not cancel its stream: ${JSON.stringify(canceledLoadState)}`);
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

    // Ctrl+wheelはKonataのzoomだけに使い、browser標準のpage zoomへ同じeventを渡さない。
    const wheelZoomState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const viewer = document.querySelector(".viewer");
        const reset = [...document.querySelectorAll(".zoom-controls button")]
            .find((button) => button.textContent?.trim() === "Reset");
        if (!(viewer instanceof HTMLElement) || !(reset instanceof HTMLButtonElement)) {
            throw new Error("The viewer zoom controls were not found.");
        }
        const event = new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            deltaY: -1,
            clientX: viewer.getBoundingClientRect().left + 400,
            clientY: viewer.getBoundingClientRect().top + 200
        });
        const dispatched = viewer.dispatchEvent(event);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const zoom = document.querySelector(".zoom-controls output")?.textContent ?? null;
            reset.click();
            requestAnimationFrame(() => resolve({
                canceled: !dispatched && event.defaultPrevented,
                zoom
            }));
        }));
    })`);
    if (!wheelZoomState.canceled || wheelZoomState.zoom !== "200%") {
        throw new Error(`Wheel zoom handling is incomplete: ${JSON.stringify(wheelZoomState)}`);
    }

    // 旧コマンドパレットの起動、履歴、正規表現の前後検索、ID移動を実画面で確認する。
    const commandState = await window.webContents.executeJavaScript(`(async () => {
        const setInput = (input, value) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            setter?.call(input, value);
            input.dispatchEvent(new Event("input", {bubbles: true}));
        };
        // 非表示windowではrequestAnimationFrameが強く間引かれるため、React反映だけを短いtimerで待つ。
        const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 10));
        const waitForResult = (opID) => new Promise((resolve, reject) => {
            const deadline = performance.now() + 2000;
            const check = () => {
                const result = document.querySelector('.find-result');
                if (result instanceof HTMLElement && result.dataset.opId === String(opID)) {
                    resolve(result.textContent ?? "");
                }
                else if (performance.now() >= deadline) {
                    reject(new Error('Timed out while waiting for a search result.'));
                }
                else {
                    setTimeout(check, 5);
                }
            };
            check();
        });
        const openPalette = async (init) => {
            document.dispatchEvent(new KeyboardEvent("keydown", init));
            await nextFrame();
            const input = document.querySelector('.command-palette input');
            if (!(input instanceof HTMLInputElement)) {
                throw new Error('The command palette was not opened.');
            }
            return input;
        };
        const execute = async (input, value) => {
            setInput(input, value);
            await nextFrame();
            input.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
            await nextFrame();
        };

        const searchInput = await openPalette({key: "f", ctrlKey: true, bubbles: true, cancelable: true});
        const prefilled = searchInput.value;
        const hints = [...document.querySelectorAll('.command-hint code')].map((hint) => hint.textContent);
        await execute(searchInput, "f execute|consumer");
        const firstResult = await waitForResult(1);
        document.dispatchEvent(new KeyboardEvent("keydown", {key: "F3", bubbles: true, cancelable: true}));
        const nextResult = await waitForResult(0);
        document.dispatchEvent(new KeyboardEvent("keydown", {key: "F3", shiftKey: true, bubbles: true, cancelable: true}));
        const previousResult = await waitForResult(1);
        document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
        await nextFrame();

        const historyInput = await openPalette({key: "F1", bubbles: true, cancelable: true});
        historyInput.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowUp", bubbles: true, cancelable: true}));
        await nextFrame();
        const history = historyInput.value;
        await execute(historyInput, "j 1");

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
        await nextFrame();
        const jumpToolTip = document.querySelector('[role="tooltip"]')?.textContent ?? null;

        // 後続のCanvas操作テストが従来どおり先頭位置から始まるよう戻す。
        const restoreInput = await openPalette({key: "F1", bubbles: true, cancelable: true});
        await execute(restoreInput, "j 0");
        return {prefilled, hints, firstResult, nextResult, previousResult, history, jumpToolTip};
    })()`);
    if (commandState.prefilled !== "f " ||
        JSON.stringify(commandState.hints) !== JSON.stringify([
            "j  <#line>",
            "jr <rid>",
            "f  <string>",
            "l",
        ]) ||
        !commandState.firstResult.includes("consumer") ||
        !commandState.nextResult.includes("execute") ||
        !commandState.previousResult.includes("consumer") ||
        commandState.history !== "f execute|consumer" ||
        typeof commandState.jumpToolTip !== "string" ||
        !commandState.jumpToolTip.startsWith("[3, 1]")) {
        throw new Error(`Command palette is incomplete: ${JSON.stringify(commandState)}`);
    }

    // 旧Stats dialogと同じName/Value表を開き、正規表現filterとclose操作まで確認する。
    const statsState = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const button = [...document.querySelectorAll(".app-toolbar button")]
            .find((candidate) => candidate.textContent?.trim() === "Stats");
        if (!(button instanceof HTMLButtonElement)) {
            throw new Error("The Stats button was not found.");
        }
        button.click();
        const deadline = performance.now() + 5000;
        const check = () => {
            const dialog = document.querySelector('[role="dialog"]');
            if (dialog instanceof HTMLElement) {
                const rows = [...dialog.querySelectorAll("tbody tr")];
                const fetchedRow = rows.find((row) => row.firstElementChild?.textContent === "numFetchedOps");
                const filter = dialog.querySelector('input[aria-label="Filter statistics"]');
                if (!(filter instanceof HTMLInputElement)) {
                    reject(new Error("The statistics filter was not found."));
                    return;
                }
                const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
                valueSetter?.call(filter, "numFlush");
                filter.dispatchEvent(new Event("input", {bubbles: true}));
                requestAnimationFrame(() => {
                    const filteredNames = [...dialog.querySelectorAll("tbody tr td:first-child")]
                        .map((cell) => cell.textContent);
                    dialog.querySelector("footer button")?.click();
                    requestAnimationFrame(() => resolve({
                        title: dialog.querySelector("h2")?.textContent ?? null,
                        initialRowCount: rows.length,
                        fetchedValue: fetchedRow?.lastElementChild?.textContent ?? null,
                        filteredNames,
                        closed: document.querySelector('[role="dialog"]') === null
                    }));
                });
                return;
            }
            if (performance.now() >= deadline) {
                reject(new Error("Timed out while waiting for the statistics dialog."));
                return;
            }
            setTimeout(check, 10);
        };
        check();
    })`);
    if (statsState.title !== "Stats" ||
        statsState.initialRowCount !== 24 ||
        statsState.fetchedValue !== "1" ||
        JSON.stringify(statsState.filteredNames) !== JSON.stringify(["numFlush", "numFlushedOps"]) ||
        !statsState.closed) {
        throw new Error(`Statistics dialog is incomplete: ${JSON.stringify(statsState)}`);
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

    // 旧版と同じ数字キーでの移動とCtrl/Command+数字での設定を、表示中のslot値とCanvasで確認する。
    const bookmarkState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const reset = [...document.querySelectorAll(".zoom-controls button")]
            .find((button) => button.textContent?.trim() === "Reset");
        if (!(reset instanceof HTMLButtonElement)) {
            throw new Error("The Reset button was not found.");
        }
        reset.click();
        document.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true, cancelable: true}));
        document.dispatchEvent(new KeyboardEvent("keydown", {
            key: "2",
            ctrlKey: true,
            bubbles: true,
            cancelable: true
        }));
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const slot = document.querySelector('button[aria-label="Go to bookmark 2"]')?.nextElementSibling;
            document.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true, cancelable: true}));
            document.dispatchEvent(new KeyboardEvent("keydown", {key: "2", bubbles: true, cancelable: true}));

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
            requestAnimationFrame(() => resolve({
                slot: slot?.textContent ?? null,
                goButtons: document.querySelectorAll('button[aria-label^="Go to bookmark "]').length,
                setButtons: document.querySelectorAll('button[aria-label^="Set bookmark "]').length,
                toolTip: document.querySelector('[role="tooltip"]')?.textContent ?? null
            }));
        }));
    })`);
    if (bookmarkState.slot !== "2: x:6, y:0, zoom:0" ||
        bookmarkState.goButtons !== 10 ||
        bookmarkState.setButtons !== 10 ||
        typeof bookmarkState.toolTip !== "string" ||
        !bookmarkState.toolTip.startsWith("[6, 0]")) {
        throw new Error(`Bookmarks are incomplete: ${JSON.stringify(bookmarkState)}`);
    }

    const bookmarkZoomState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const reset = [...document.querySelectorAll(".zoom-controls button")]
            .find((button) => button.textContent?.trim() === "Reset");
        const zoomIn = document.querySelector('button[aria-label="Zoom in"]');
        if (!(reset instanceof HTMLButtonElement) || !(zoomIn instanceof HTMLButtonElement)) {
            throw new Error("The zoom controls were not found.");
        }
        zoomIn.click();
        document.dispatchEvent(new KeyboardEvent("keydown", {
            key: "3",
            ctrlKey: true,
            bubbles: true,
            cancelable: true
        }));
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const slot = document.querySelector('button[aria-label="Go to bookmark 3"]')?.nextElementSibling;
            reset.click();
            document.dispatchEvent(new KeyboardEvent("keydown", {key: "3", bubbles: true, cancelable: true}));
            requestAnimationFrame(() => requestAnimationFrame(() => resolve({
                slot: slot?.textContent ?? null,
                zoom: document.querySelector(".zoom-controls output")?.textContent ?? null
            })));
        }));
    })`);
    if (typeof bookmarkZoomState.slot !== "string" ||
        !bookmarkZoomState.slot.endsWith("zoom:-1") ||
        bookmarkZoomState.zoom !== "200%") {
        throw new Error(`Bookmark zoom is incomplete: ${JSON.stringify(bookmarkZoomState)}`);
    }

    // 同じ単一HTMLを読み直しても保存値を復元し、壊れた値では安全に初期値へ戻ることを確認する。
    await window.loadFile(webFile);
    const persistedBookmarkState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            slot2: document.querySelector('button[aria-label="Go to bookmark 2"]')?.nextElementSibling?.textContent ?? null,
            slot3: document.querySelector('button[aria-label="Go to bookmark 3"]')?.nextElementSibling?.textContent ?? null
        })));
    })`);
    if (persistedBookmarkState.slot2 !== "2: x:6, y:0, zoom:0" ||
        typeof persistedBookmarkState.slot3 !== "string" ||
        !persistedBookmarkState.slot3.endsWith("zoom:-1")) {
        throw new Error(`Bookmark persistence is incomplete: ${JSON.stringify(persistedBookmarkState)}`);
    }

    await window.webContents.executeJavaScript(
        `localStorage.setItem("konata.bookmarks", "{broken")`,
    );
    await window.loadFile(webFile);
    const recoveredBookmarkState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            loadState: document.querySelector(".trace-app")?.dataset.loadState ?? null,
            slot2: document.querySelector('button[aria-label="Go to bookmark 2"]')?.nextElementSibling?.textContent ?? null,
            slot3: document.querySelector('button[aria-label="Go to bookmark 3"]')?.nextElementSibling?.textContent ?? null
        })));
    })`);
    if (recoveredBookmarkState.loadState !== "idle" ||
        recoveredBookmarkState.slot2 !== "2: x:0, y:0, zoom:0" ||
        recoveredBookmarkState.slot3 !== "3: x:0, y:0, zoom:0") {
        throw new Error(`Bookmark recovery is incomplete: ${JSON.stringify(recoveredBookmarkState)}`);
    }

    // reloadで空になったsheetへ、後続のView操作用traceを戻す。
    await dropFixture(window, plainFixture, "text/plain");

    // 旧版と同じ10pxのsplitterをdragし、label/pipelineのCanvas領域が実際に変わることを確認する。
    const firstSplitterState = await moveSplitter(window, 320);
    if (firstSplitterState.initialLabelWidth !== 450 ||
        firstSplitterState.labelWidth !== 320 ||
        firstSplitterState.splitterWidth !== 10 ||
        firstSplitterState.pipelineWidth !== firstSplitterState.viewerWidth - 330 ||
        firstSplitterState.position !== "320" ||
        firstSplitterState.cursor !== "col-resize") {
        throw new Error(`Trace pane splitter is incomplete: ${JSON.stringify(firstSplitterState)}`);
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
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        inputSetter?.call(textThreshold, "12");
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

    // tab固有のRenderer状態として倍率も保持されるよう、別traceを開く前に変更する。
    await window.webContents.executeJavaScript(`new Promise((resolve) => {
        document.querySelector('button[aria-label="Zoom in"]')?.click();
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`);

    // 検索結果を残したまま別traceを開き、Tabを戻した時に同じ結果が復元されることを後で確認する。
    const persistentSearchState = await window.webContents.executeJavaScript(`(async () => {
        const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 10));
        document.dispatchEvent(new KeyboardEvent("keydown", {
            key: "f",
            ctrlKey: true,
            bubbles: true,
            cancelable: true
        }));
        await nextFrame();
        const input = document.querySelector('.command-palette input');
        if (!(input instanceof HTMLInputElement)) {
            throw new Error("The command palette was not opened for the persistent search.");
        }
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, "f consumer");
        input.dispatchEvent(new Event("input", {bubbles: true}));
        await nextFrame();
        input.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));

        const deadline = performance.now() + 2000;
        while (performance.now() < deadline) {
            const result = document.querySelector('.find-result');
            if (result instanceof HTMLElement && result.dataset.opId === "1") {
                return {opID: result.dataset.opId, text: result.textContent ?? ""};
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("Timed out while waiting for the persistent search result.");
    })()`);
    if (persistentSearchState.opID !== "1" || !persistentSearchState.text.includes("consumer")) {
        throw new Error(`Persistent search setup is incomplete: ${JSON.stringify(persistentSearchState)}`);
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
    // 新しいTabは直前の幅を引き継ぐが、移動後は既存Tabと独立して保持する。
    const secondSplitterState = await moveSplitter(window, 280);
    if (secondSplitterState.initialLabelWidth !== 320 ||
        secondSplitterState.labelWidth !== 280 ||
        secondSplitterState.splitterWidth !== 10 ||
        secondSplitterState.pipelineWidth !== secondSplitterState.viewerWidth - 290 ||
        secondSplitterState.position !== "280") {
        throw new Error(`Second tab splitter is incomplete: ${JSON.stringify(secondSplitterState)}`);
    }

    // 2枚を開いた後で、全Tab共通設定とgem5だけの設定を異なる値へ変更する。
    const secondTabSettingsState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const split = document.querySelector('input[aria-label="Split lanes"]');
        const arrows = document.querySelector('select[aria-label="Dependency arrow type"]');
        const theme = document.querySelector('select[aria-label="UI color theme"]');
        const color = document.querySelector('select[aria-label="Pipeline color scheme"]');
        const hideFlushed = document.querySelector('input[aria-label="Hide flushed ops"]');
        const textThreshold = document.querySelector('input[aria-label="Text drawing threshold"]');
        if (!(split instanceof HTMLInputElement) ||
            !(arrows instanceof HTMLSelectElement) ||
            !(theme instanceof HTMLSelectElement) ||
            !(color instanceof HTMLSelectElement) ||
            !(hideFlushed instanceof HTMLInputElement) ||
            !(textThreshold instanceof HTMLInputElement)) {
            throw new Error("The second tab view controls were not found.");
        }
        split.click();
        arrows.value = "notShow";
        arrows.dispatchEvent(new Event("change", {bubbles: true}));
        theme.value = "dark";
        theme.dispatchEvent(new Event("change", {bubbles: true}));
        color.value = "RoyalBlue";
        color.dispatchEvent(new Event("change", {bubbles: true}));
        hideFlushed.click();
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        inputSetter?.call(textThreshold, "14");
        textThreshold.dispatchEvent(new Event("input", {bubbles: true}));
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            split: split.checked,
            arrows: arrows.value,
            theme: document.querySelector(".trace-app")?.dataset.theme ?? null,
            color: color.value,
            hideFlushed: hideFlushed.checked,
            textThreshold: textThreshold.value
        })));
    })`);
    if (secondTabSettingsState.split ||
        secondTabSettingsState.arrows !== "notShow" ||
        secondTabSettingsState.theme !== "dark" ||
        secondTabSettingsState.color !== "RoyalBlue" ||
        !secondTabSettingsState.hideFlushed ||
        secondTabSettingsState.textThreshold !== "14") {
        throw new Error(`Second tab settings are incomplete: ${JSON.stringify(secondTabSettingsState)}`);
    }

    // traceとRenderer設定を保持して切り替え、middle clickでactive tabを閉じたら隣へ移る。
    const tabState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const tabButtons = [...document.querySelectorAll('[role="tab"]')];
        const plainTab = tabButtons.find((button) => button.textContent?.trim() === "kanata-basic.txt");
        const closePlain = document.querySelector('button[aria-label="Close kanata-basic.txt"]');
        const tabBar = document.querySelector(".tab-bar");
        const toolbar = document.querySelector(".app-toolbar");
        if (!(plainTab instanceof HTMLButtonElement) ||
            !(closePlain instanceof HTMLButtonElement) ||
            !(tabBar instanceof HTMLElement) ||
            !(toolbar instanceof HTMLElement)) {
            throw new Error("The trace tabs were not found.");
        }
        const tabsAboveToolbar = tabBar.nextElementSibling === toolbar;
        const initialSelected = document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null;
        plainTab.click();
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const root = document.querySelector(".trace-app");
            const split = document.querySelector('input[aria-label="Split lanes"]');
            const arrows = document.querySelector('select[aria-label="Dependency arrow type"]');
            const color = document.querySelector('select[aria-label="Pipeline color scheme"]');
            const hideFlushed = document.querySelector('input[aria-label="Hide flushed ops"]');
            const textThreshold = document.querySelector('input[aria-label="Text drawing threshold"]');
            const switched = {
                fileName: root?.dataset.fileName ?? null,
                opCount: Number(root?.dataset.opCount ?? -1),
                theme: root?.dataset.theme ?? null,
                split: split instanceof HTMLInputElement && split.checked,
                arrows: arrows instanceof HTMLSelectElement ? arrows.value : null,
                color: color instanceof HTMLSelectElement ? color.value : null,
                hideFlushed: hideFlushed instanceof HTMLInputElement && hideFlushed.checked,
                textThreshold: textThreshold instanceof HTMLInputElement ? textThreshold.value : null,
                zoom: document.querySelector(".zoom-controls output")?.textContent ?? null,
                searchOpID: document.querySelector('.find-result')?.dataset.opId ?? null,
                searchText: document.querySelector('.find-result')?.textContent ?? null,
                labelWidth: Math.round(document.querySelector('.label-pane')?.getBoundingClientRect().width ?? -1)
            };
            const middleDown = new MouseEvent("mousedown", {
                bubbles: true,
                cancelable: true,
                button: 1
            });
            const middleClick = new MouseEvent("auxclick", {
                bubbles: true,
                cancelable: true,
                button: 1
            });
            const downDispatched = plainTab.dispatchEvent(middleDown);
            const clickDispatched = plainTab.dispatchEvent(middleClick);
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const remainingRoot = document.querySelector(".trace-app");
                resolve({
                    initialCount: tabButtons.length,
                    initialSelected,
                    tabsAboveToolbar,
                    middleClickCanceled:
                        !downDispatched && middleDown.defaultPrevented &&
                        !clickDispatched && middleClick.defaultPrevented,
                    switched,
                    remainingCount: document.querySelectorAll('[role="tab"]').length,
                    remainingSelected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null,
                    remainingFileName: remainingRoot?.dataset.fileName ?? null,
                    remainingOpCount: Number(remainingRoot?.dataset.opCount ?? -1),
                    remainingTheme: remainingRoot?.dataset.theme ?? null,
                    remainingSplit: document.querySelector('input[aria-label="Split lanes"]')?.checked ?? null,
                    remainingArrows: document.querySelector('select[aria-label="Dependency arrow type"]')?.value ?? null,
                    remainingColor: document.querySelector('select[aria-label="Pipeline color scheme"]')?.value ?? null,
                    remainingHideFlushed: document.querySelector('input[aria-label="Hide flushed ops"]')?.checked ?? null,
                    remainingTextThreshold: document.querySelector('input[aria-label="Text drawing threshold"]')?.value ?? null,
                    remainingZoom: document.querySelector(".zoom-controls output")?.textContent ?? null,
                    remainingSearchOpID: document.querySelector('.find-result')?.dataset.opId ?? null,
                    remainingLabelWidth: Math.round(document.querySelector('.label-pane')?.getBoundingClientRect().width ?? -1)
                });
            }));
        }));
    })`);
    if (tabState.initialCount !== 2 ||
        tabState.initialSelected !== "gem5-basic.txt" ||
        !tabState.tabsAboveToolbar ||
        !tabState.middleClickCanceled ||
        tabState.switched.fileName !== "kanata-basic.txt" ||
        tabState.switched.opCount !== 2 ||
        tabState.switched.theme !== "dark" ||
        tabState.switched.split ||
        tabState.switched.arrows !== "notShow" ||
        tabState.switched.color !== "Custom" ||
        tabState.switched.hideFlushed ||
        tabState.switched.textThreshold !== "14" ||
        tabState.switched.zoom !== "200%" ||
        tabState.switched.searchOpID !== "1" ||
        typeof tabState.switched.searchText !== "string" ||
        !tabState.switched.searchText.includes("consumer") ||
        tabState.switched.labelWidth !== 320 ||
        tabState.remainingCount !== 1 ||
        tabState.remainingSelected !== "gem5-basic.txt" ||
        tabState.remainingFileName !== "gem5-basic.txt" ||
        tabState.remainingOpCount !== 1 ||
        tabState.remainingTheme !== "dark" ||
        tabState.remainingSplit ||
        tabState.remainingArrows !== "notShow" ||
        tabState.remainingColor !== "RoyalBlue" ||
        !tabState.remainingHideFlushed ||
        tabState.remainingTextThreshold !== "14" ||
        tabState.remainingZoom !== "100%" ||
        tabState.remainingSearchOpID !== null ||
        tabState.remainingLabelWidth !== 280) {
        throw new Error(`Trace tabs are incomplete: ${JSON.stringify(tabState)}`);
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
