"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {app, BrowserWindow} = require("electron");

// XvfbではSwiftShaderを明示し、製品と同じWebGL2経路もsoftware GPU上で検査する。
if (process.env.KONATA_TEST_WEBGL === "1") {
    app.commandLine.appendSwitch("use-gl", "angle");
    app.commandLine.appendSwitch("use-angle", "swiftshader");
    app.commandLine.appendSwitch("enable-unsafe-swiftshader");
}
else {
    app.commandLine.appendSwitch("disable-gpu");
}

async function dropContents(window, contents, fileName, mimeType, verifyProgressBar = false) {
    const encodedContents = contents.toString("base64");

    // RendererへNode APIを公開せず、browserで選択した時と同じFile/DragEventを組み立てる。
    await window.webContents.executeJavaScript(`(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const binary = atob(${JSON.stringify(encodedContents)});
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
                reject(new Error("Timed out while waiting for " + ${JSON.stringify(fileName)} +
                    "; current file is " + (root?.dataset.fileName ?? "none") +
                    " in " + (state ?? "unknown") + " state."));
                return;
            }
            setTimeout(check, 25);
        };
        check();
    })`);
}

async function dropFixture(window, fixturePath, mimeType, verifyProgressBar = false) {
    return dropContents(
        window,
        fs.readFileSync(fixturePath),
        path.basename(fixturePath),
        mimeType,
        verifyProgressBar,
    );
}

async function dropConcurrentZstdContents(window, contents) {
    const encodedContents = contents.toString("base64");
    return window.webContents.executeJavaScript(`(async () => {
        const binary = atob(${JSON.stringify(encodedContents)});
        const source = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
            source[index] = binary.charCodeAt(index);
        }

        let startedStreams = 0;
        let releaseStreams;
        const bothStarted = new Promise((resolve) => {
            releaseStreams = resolve;
        });
        const makeFile = (name) => {
            const bytes = source.slice();
            const file = new File([bytes], name, {type: "application/zstd"});
            Object.defineProperty(file, "stream", {value: () => {
                let sent = false;
                return new ReadableStream({
                    async pull(controller) {
                        if (sent) {
                            controller.close();
                            return;
                        }
                        sent = true;
                        startedStreams++;
                        if (startedStreams === 2) {
                            releaseStreams();
                        }
                        // 両方が展開入力へ到達するまで待たせ、singletonによる直列化への退行を検出する。
                        await bothStarted;
                        // File constructorへ渡した元bufferとは分け、テスト用stream自身が所有するchunkにする。
                        controller.enqueue(bytes.slice());
                    }
                });
            }});
            return file;
        };

        const names = ["gem5-a.txt.zst", "gem5-b.txt.zstd"];
        const transfer = new DataTransfer();
        for (const name of names) {
            transfer.items.add(makeFile(name));
        }
        const target = document.querySelector(".trace-app");
        if (!(target instanceof HTMLElement)) {
            throw new Error("The Zstandard drop target was not found.");
        }
        target.dispatchEvent(new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer
        }));

        const deadline = performance.now() + 20000;
        while (performance.now() < deadline) {
            const tabs = [...document.querySelectorAll(".trace-tab")].filter((tab) =>
                names.includes(tab.querySelector('[role="tab"]')?.textContent?.trim() ?? ""));
            if (tabs.some((tab) => tab.dataset.loadState === "error")) {
                throw new Error("A concurrent Zstandard trace failed to load: " + JSON.stringify({
                    tabs: tabs.map((tab) => ({
                        name: tab.querySelector('[role="tab"]')?.textContent?.trim() ?? "",
                        state: tab.dataset.loadState
                    })),
                    status: document.querySelector(".status")?.textContent ?? "",
                    log: document.querySelector(".application-log-messages")?.textContent ?? ""
                }));
            }
            if (tabs.length === 2 && tabs.every((tab) => tab.dataset.loadState === "ready")) {
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                return {names, startedStreams};
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Timed out while loading concurrent Zstandard traces; started " +
            startedStreams + " streams.");
    })()`);
}

async function verifyMultipleFileDrop(window) {
    return window.webContents.executeJavaScript(`(async () => {
        const target = document.querySelector(".trace-app");
        if (!(target instanceof HTMLElement)) {
            throw new Error("The multiple-file drop target was not found.");
        }
        const initialTabCount = document.querySelectorAll(".trace-tab").length;
        const contents = (serialID) => [
            "Kanata\\t0004",
            "I\\t0\\t" + serialID + "\\t0",
            "S\\t0\\t0\\tF",
            "C\\t1",
            "R\\t0\\t0\\t0"
        ].join("\\n");
        let startedStreams = 0;
        let releaseStreams;
        const bothStarted = new Promise((resolve) => {
            releaseStreams = resolve;
        });
        const makeFile = (name, serialID) => {
            const bytes = new TextEncoder().encode(contents(serialID));
            const file = new File([bytes], name, {type: "text/plain"});
            Object.defineProperty(file, "stream", {value: () => {
                let sent = false;
                return new ReadableStream({
                    async pull(controller) {
                        if (sent) {
                            controller.close();
                            return;
                        }
                        sent = true;
                        startedStreams++;
                        if (startedStreams === 2) {
                            releaseStreams();
                        }
                        // 片方を待たせ、2つのParserが同時にstreamへ到達することを確認する。
                        await bothStarted;
                        controller.enqueue(bytes);
                    }
                });
            }});
            return file;
        };
        const transfer = new DataTransfer();
        transfer.items.add(makeFile("multi-a.log", 10));
        transfer.items.add(makeFile("multi-b.log", 20));
        target.dispatchEvent(new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer
        }));

        const deadline = performance.now() + 5000;
        while (performance.now() < deadline) {
            const tabs = [...document.querySelectorAll(".trace-tab")]
                .filter((tab) => ["multi-a.log", "multi-b.log"].includes(
                    tab.querySelector('[role="tab"]')?.textContent?.trim() ?? ""));
            if (tabs.length === 2 && tabs.every((tab) => tab.dataset.loadState === "ready")) {
                const activeName = document.querySelector('[role="tab"][aria-selected="true"]')
                    ?.textContent?.trim() ?? null;
                document.querySelector('button[aria-label="Close multi-a.log"]')?.click();
                document.querySelector('button[aria-label="Close multi-b.log"]')?.click();
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                return {
                    startedStreams,
                    activeName,
                    restoredTabCount: document.querySelectorAll(".trace-tab").length,
                    initialTabCount
                };
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Timed out while loading multiple dropped files; started " +
            startedStreams + " streams.");
    })()`);
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
                        await new Promise((done) => setTimeout(done, 900));
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
        let progressLayers = null;
        let loadingStatus = null;
        let initialDotTransforms = null;
        let dotSampleTime = 0;
        let dotsAnimated = false;
        let completionPending = false;
        const check = () => {
            const root = document.querySelector(".trace-app");
            const state = root?.dataset.loadState;
            const opCount = Number(root?.dataset.opCount ?? -1);
            if (state === "loading" && opCount === 1) {
                const canvas = document.querySelector(".pipeline-pane canvas");
                const toolbar = document.querySelector(".app-toolbar");
                const progress = document.querySelector(".operation-progress");
                const splitter = document.querySelector(".pane-splitter");
                const status = document.querySelector(".status-loading");
                const dots = status?.querySelector(".status-loading-dots");
                const dotElements = dots?.querySelectorAll(":scope > span") ?? [];
                const dotStyle = dotElements[0] instanceof HTMLElement
                    ? getComputedStyle(dotElements[0])
                    : null;
                const dotCenters = Array.from(dotElements, (dot) => {
                    const rect = dot.getBoundingClientRect();
                    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
                });
                const hexagonOrder = [0, 2, 4, 5, 3, 1, 0];
                const sideLengths = hexagonOrder.slice(1).map((dotIndex, index) => {
                    const from = dotCenters[hexagonOrder[index]];
                    const to = dotCenters[dotIndex];
                    return from === undefined || to === undefined
                        ? Number.NaN
                        : Math.hypot(to[0] - from[0], to[1] - from[1]);
                });
                loadingStatus = {
                    text: status?.textContent ?? null,
                    dots: dotElements.length,
                    dotBlur: dotStyle?.filter ?? null,
                    dotColor: dotStyle?.color ?? null,
                    dotShadow: dotStyle?.boxShadow ?? null,
                    dotOpacity: dotStyle?.opacity ?? null,
                    dotTiming: dotStyle?.animationTimingFunction ?? null,
                    dotTransformOrigin: dotStyle?.transformOrigin ?? null,
                    hexagonSideSpread: Math.max(...sideLengths) - Math.min(...sideLengths),
                    role: status?.getAttribute("role") ?? null
                };
                if (dotElements[0] instanceof HTMLElement && dotElements[1] instanceof HTMLElement) {
                    const transforms = [
                        getComputedStyle(dotElements[0]).transform,
                        getComputedStyle(dotElements[1]).transform
                    ];
                    if (initialDotTransforms === null) {
                        initialDotTransforms = transforms;
                        dotSampleTime = performance.now();
                    }
                    else if (performance.now() - dotSampleTime >= 450) {
                        dotsAnimated ||= transforms[0] !== initialDotTransforms[0] &&
                            transforms[1] !== initialDotTransforms[1];
                    }
                }
                if (toolbar instanceof HTMLElement &&
                    progress instanceof HTMLElement &&
                    splitter instanceof HTMLElement) {
                    // progressはtoolbarの下端からviewerへ3px重なるため、splitterより上の階層を維持する。
                    progressLayers = {
                        toolbar: getComputedStyle(toolbar).zIndex,
                        progress: getComputedStyle(progress).zIndex,
                        splitter: getComputedStyle(splitter).zIndex
                    };
                }
                if (canvas instanceof HTMLCanvasElement && partialPixels === 0) {
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
                if (!completionPending) {
                    completionPending = true;
                    setTimeout(() => {
                        const completionDots = document.querySelector(".status-ready .status-loading-dots");
                        const completionDot = completionDots?.querySelector(":scope > span");
                        const glowStyle = completionDots instanceof HTMLElement
                            ? getComputedStyle(completionDots, "::after")
                            : null;
                        resolve({
                            partialPixels,
                            finalOpCount: opCount,
                            progressLayers,
                            loadingStatus,
                            dotsAnimated,
                            completionStatus: {
                                dotAnimation: completionDot instanceof HTMLElement
                                    ? getComputedStyle(completionDot).animationName
                                    : null,
                                dotFilter: completionDot instanceof HTMLElement
                                    ? getComputedStyle(completionDot).filter
                                    : null,
                                dotOpacity: completionDot instanceof HTMLElement
                                    ? getComputedStyle(completionDot).opacity
                                    : null,
                                glowAnimation: glowStyle?.animationName ?? null,
                                glowOpacity: glowStyle?.opacity ?? null,
                                glowShadow: glowStyle?.boxShadow ?? null
                            }
                        });
                    }, 1100);
                }
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

async function verifyLoadErrorRecovery(window) {
    return window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const target = document.querySelector(".trace-app");
        if (target === null) {
            reject(new Error("The trace drop target was not found."));
            return;
        }
        const file = new File(["not a trace"], "unsupported.log", {type: "text/plain"});
        const event = new Event("drop", {bubbles: true, cancelable: true});
        Object.defineProperty(event, "dataTransfer", {value: {files: [file]}});
        target.dispatchEvent(event);

        const deadline = performance.now() + 2000;
        const check = () => {
            const root = document.querySelector(".trace-app");
            if (root?.dataset.loadState === "error") {
                const input = document.querySelector(".file-input");
                const chooseButton = [...document.querySelectorAll(".empty-state button")]
                    .find((button) => button.textContent?.trim() === "Choose another trace");
                if (!(input instanceof HTMLInputElement) || !(chooseButton instanceof HTMLButtonElement)) {
                    reject(new Error("The load error recovery controls were not found."));
                    return;
                }
                const pickerDescriptor = Object.getOwnPropertyDescriptor(window, "showOpenFilePicker");
                let pickerRequestCount = 0;
                Object.defineProperty(window, "showOpenFilePicker", {
                    configurable: true,
                    value: async () => {
                        pickerRequestCount++;
                        throw new DOMException("Canceled by smoke test", "AbortError");
                    }
                });
                chooseButton.click();
                const pickerRequested = pickerRequestCount === 1;
                const shortcutEvent = new KeyboardEvent("keydown", {
                    key: "o",
                    ctrlKey: true,
                    bubbles: true,
                    cancelable: true
                });
                const shortcutDispatched = document.dispatchEvent(shortcutEvent);
                const shortcutPickerRequested = pickerRequestCount === 2;
                if (pickerDescriptor === undefined) {
                    delete window.showOpenFilePicker;
                }
                else {
                    Object.defineProperty(window, "showOpenFilePicker", pickerDescriptor);
                }
                const result = {
                    title: document.querySelector(".empty-state strong")?.textContent ?? null,
                    detail: document.querySelector(".empty-state span")?.textContent ?? null,
                    status: document.querySelector(".status")?.textContent ?? null,
                    statusType: document.querySelector(".status")?.classList.contains("status-error") === true
                        ? "error"
                        : null,
                    statusIcon: document.querySelector(".status > svg") !== null,
                    statusRole: document.querySelector(".status")?.getAttribute("role") ?? null,
                    pickerRequested,
                    shortcutPickerRequested,
                    shortcutCanceled: !shortcutDispatched && shortcutEvent.defaultPrevented
                };
                document.querySelector(".trace-tab-close")?.click();
                requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)));
                return;
            }
            if (performance.now() >= deadline) {
                reject(new Error("Timed out while waiting for the load error state."));
                return;
            }
            setTimeout(check, 5);
        };
        check();
    })`);
}

async function verifyPersistentFileWorkflow(window, webFile) {
    await window.loadFile(webFile);
    const firstPage = await window.webContents.executeJavaScript(`(async () => {
        const waitFor = async (predicate, message) => {
            const deadline = performance.now() + 5000;
            while (performance.now() < deadline) {
                const value = predicate();
                if (value) {
                    return value;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            throw new Error(message);
        };
        const writeTrace = async (handle, opCount) => {
            const lines = ["Kanata\\t0004"];
            for (let id = 0; id < opCount; id++) {
                lines.push(
                    "I\\t" + id + "\\t" + (100 + id) + "\\t0",
                    "S\\t" + id + "\\t0\\tF",
                    "C\\t1",
                    "R\\t" + id + "\\t" + id + "\\t0",
                );
            }
            const writable = await handle.createWritable();
            await writable.write(lines.join("\\n") + "\\n");
            await writable.close();
        };

        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle("recent-reload-smoke.log", {create: true});
        await writeTrace(handle, 1);
        let observerCallback = null;
        let observerCount = 0;
        class SmokeFileSystemObserver {
            constructor(callback) {
                observerCount++;
                observerCallback = callback;
            }
            async observe() {}
            disconnect() {}
        }
        Object.defineProperty(window, "FileSystemObserver", {
            configurable: true,
            value: SmokeFileSystemObserver
        });
        Object.defineProperty(window, "showOpenFilePicker", {
            configurable: true,
            value: async () => [handle]
        });

        await waitFor(() => document.querySelector(".open-controls > summary"),
            "The Open menu was not mounted.");
        document.querySelector(".open-controls > summary").click();
        const openFile = [...document.querySelectorAll(".open-controls-panel > button")]
            .find((button) => button.textContent?.trim() === "Open file…");
        if (!(openFile instanceof HTMLButtonElement)) {
            throw new Error("The enhanced Open action was not found.");
        }
        openFile.click();
        await waitFor(() => {
            const app = document.querySelector(".trace-app");
            return app?.dataset.loadState === "ready" && app.dataset.opCount === "1";
        }, "The picker-backed trace did not load.");
        const originalTab = document.querySelector(".trace-tab");

        const openControls = document.querySelector(".open-controls");
        openControls?.querySelector(":scope > summary")?.click();
        const menuReload = [...(openControls?.querySelectorAll(".open-controls-panel > button") ?? [])]
            .find((button) => button.textContent?.trim() === "Reload current");
        menuReload?.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const menuClosedAfterReload = openControls instanceof HTMLDetailsElement && !openControls.open;
        await waitFor(() => {
            const app = document.querySelector(".trace-app");
            return observerCount >= 2 && app?.dataset.loadState === "ready";
        }, "Reload from the Open menu did not finish.");

        await writeTrace(handle, 2);
        observerCallback?.([{type: "modified"}]);
        await waitFor(() => document.querySelector(".status-changed"),
            "The external change confirmation was not shown.");
        const firstChangedStatus = document.querySelector(".status-changed");
        const changedRole = firstChangedStatus?.getAttribute("role") ?? null;
        const changedMessage = firstChangedStatus?.querySelector(".status-message")?.textContent ?? null;
        const ignore = [...(firstChangedStatus?.querySelectorAll("button") ?? [])]
            .find((button) => button.textContent?.trim() === "Ignore");
        ignore?.click();
        await waitFor(() => document.querySelector(".status-changed") === null,
            "Ignoring a change did not close the confirmation.");

        await new Promise((resolve) => setTimeout(resolve, 30));
        await writeTrace(handle, 3);
        observerCallback?.([{type: "modified"}]);
        const changedStatus = await waitFor(() => document.querySelector(".status-changed"),
            "The second external change confirmation was not shown.");
        const reload = [...changedStatus.querySelectorAll("button")]
            .find((button) => button.textContent?.trim() === "Reload");
        reload?.click();
        await waitFor(() => {
            const app = document.querySelector(".trace-app");
            return app?.dataset.loadState === "ready" && app.dataset.opCount === "3";
        }, "The changed trace did not reload.");

        document.querySelector(".open-controls > summary")?.click();
        const recent = await waitFor(() => document.querySelector(".recent-file"),
            "The opened handle was not added to Recent files.");
        const reloadCurrent = [...document.querySelectorAll(".open-controls-panel > button")]
            .find((button) => button.textContent?.trim() === "Reload current");
        return {
            changedRole,
            changedMessage,
            sameTab: originalTab === document.querySelector(".trace-tab"),
            tabCount: document.querySelectorAll(".trace-tab").length,
            opCount: document.querySelector(".trace-app")?.dataset.opCount ?? null,
            recentName: recent.textContent?.trim() ?? null,
            reloadEnabled: reloadCurrent instanceof HTMLButtonElement && !reloadCurrent.disabled,
            menuClosedAfterReload
        };
    })()`);

    await window.loadFile(webFile);
    const secondPage = await window.webContents.executeJavaScript(`(async () => {
        const waitFor = async (predicate, message) => {
            const deadline = performance.now() + 5000;
            while (performance.now() < deadline) {
                const value = predicate();
                if (value) {
                    return value;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            throw new Error(message);
        };
        await waitFor(() => document.querySelector(".open-controls > summary"),
            "The Open menu was not restored.");
        document.querySelector(".open-controls > summary").click();
        const recent = await waitFor(() => document.querySelector(".recent-file"),
            "The saved recent handle was not restored from IndexedDB.");
        const recentName = recent.textContent?.trim() ?? null;
        recent.click();
        await waitFor(() => {
            const app = document.querySelector(".trace-app");
            return app?.dataset.loadState === "ready" && app.dataset.opCount === "3";
        }, "The saved recent handle did not reopen its file.");
        return {
            recentName,
            fileName: document.querySelector(".trace-app")?.dataset.fileName ?? null,
            opCount: document.querySelector(".trace-app")?.dataset.opCount ?? null,
            tabCount: document.querySelectorAll(".trace-tab").length
        };
    })()`);

    return {firstPage, secondPage};
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
            statusType: ["loading", "ready", "warning", "error"]
                .find((type) => document.querySelector(".status")?.classList.contains("status-" + type)) ?? null,
            statusIcon: document.querySelector(".status > svg") !== null,
            statusDots: document.querySelectorAll(".status-loading-dots > span").length,
            rootChildCount: document.querySelector("#konata-root")?.childElementCount ?? 0,
            loadState: root?.dataset.loadState ?? null,
            fileName: root?.dataset.fileName ?? null,
            opCount: Number(root?.dataset.opCount ?? -1),
            laneCount: Number(root?.dataset.laneCount ?? -1),
            pipelineWidth: pipeline.width,
            pipelineHeight: pipeline.height,
            nonBackgroundPixels,
            zoom: document.querySelector(".zoom-controls output")?.textContent ?? null,
            menuWarningBadge: document.querySelector(".application-menu-warning-badge")?.textContent ?? null,
            menuLabel: document.querySelector(".application-menu > summary")?.getAttribute("aria-label") ?? null
        };
    })()`);
}

async function waitForViewAnimation(window, delay = 300) {
    // 製品側の短いrequestAnimationFrame補間が完了し、Reactが反映するまで待つ。
    await window.webContents.executeJavaScript(`new Promise((resolve) => {
        setTimeout(() => requestAnimationFrame(resolve), ${delay});
    })`);
}

async function verifyApplicationMenu(window) {
    return window.webContents.executeJavaScript(`(async () => {
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const menu = document.querySelector(".application-menu");
        const summary = menu?.querySelector(":scope > summary");
        const panel = menu?.querySelector(".application-menu-panel");
        if (!(menu instanceof HTMLDetailsElement) ||
            !(summary instanceof HTMLElement) ||
            !(panel instanceof HTMLElement)) {
            throw new Error("The application menu was not found.");
        }

        summary.click();
        await nextFrame();
        const menuItems = [...panel.querySelectorAll(":scope > button")]
            .map((item) => item.textContent?.trim() ?? "");
        const getMenuItem = (label) => [...panel.querySelectorAll(":scope > button")]
            .find((item) => item.textContent?.trim() === label);
        const menuVersion = panel.querySelector("small")?.textContent?.trim() ?? null;
        // 初期messageの半透明layerより手前にあり、menu項目を直接操作できることを確認する。
        const panelRect = panel.getBoundingClientRect();
        const menuPanelOnTop = panel.contains(document.elementFromPoint(
            panelRect.left + panelRect.width / 2,
            panelRect.top + 12
        ));

        // Aboutは初期画面と同じbuild情報を、作業中にも確認できる入口として検査する。
        getMenuItem("About Konata")?.click();
        await nextFrame();
        await nextFrame();
        const about = document.querySelector(".about-dialog");
        const aboutState = {
            title: about?.querySelector("h2")?.textContent ?? null,
            summary: [...(about?.querySelector(".about-summary")?.children ?? [])]
                .map((element) => element.textContent?.trim() ?? "").join(" "),
            authors: about?.querySelector(".about-authors")?.textContent?.trim() ?? null,
            values: [...(about?.querySelectorAll(".build-details dd") ?? [])]
                .map((value) => value.textContent?.trim() ?? ""),
            links: [...(about?.querySelectorAll(".about-links a") ?? [])]
                .map((link) => ({
                    text: link.textContent?.trim() ?? "",
                    href: link.getAttribute("href"),
                    target: link.getAttribute("target"),
                    rel: link.getAttribute("rel")
                })),
            backdropLayer: getComputedStyle(document.querySelector(".dialog-backdrop")).zIndex
        };
        const licenseButton = [...(about?.querySelectorAll(".about-links button") ?? [])]
            .find((button) => button.textContent?.trim() === "License");
        licenseButton?.click();
        await nextFrame();
        await nextFrame();
        const license = document.querySelector(".licenses-dialog");
        const mainLicenseState = {
            title: license?.querySelector("h2")?.textContent ?? null,
            hasCopyright: license?.querySelector(".third-party-licenses")?.textContent
                ?.includes("Copyright (C) 2016-2026 Ryota Shioya") ?? false
        };
        license?.querySelector("button[aria-label^='Close']")?.click();
        await nextFrame();

        summary.click();
        await nextFrame();
        getMenuItem("About Konata")?.click();
        await nextFrame();
        await nextFrame();
        const reopenedAbout = document.querySelector(".about-dialog");
        const thirdPartyButton = [...(reopenedAbout?.querySelectorAll(".about-links button") ?? [])]
            .find((button) => button.textContent?.trim() === "Third-party licenses");
        thirdPartyButton?.click();
        await nextFrame();
        await nextFrame();
        const licenses = document.querySelector(".licenses-dialog");
        const licenseText = licenses?.querySelector(".third-party-licenses")?.textContent ?? "";
        const licensesState = {
            title: licenses?.querySelector("h2")?.textContent ?? null,
            hasReact: licenseText.includes("react") && licenseText.includes("19.2.8"),
            hasBootstrapIcons: licenseText.includes("Bootstrap Icons") &&
                licenseText.includes("1.11.3"),
            hasFzstd: licenseText.includes("Copyright (c) 2020 Arjun Barrett"),
            hasZstandard: licenseText.includes("For Zstandard software"),
            hasApache: licenseText.includes("Apache License") &&
                licenseText.includes("Version 2.0, January 2004")
        };
        licenses?.querySelector("button[aria-label^='Close']")?.click();
        await nextFrame();

        // shortcut一覧とEscapeによる閉じ方を、menu本体とは独立して確認する。
        summary.click();
        await nextFrame();
        getMenuItem("Keyboard shortcuts")?.click();
        await nextFrame();
        await nextFrame();
        const shortcuts = document.querySelector(".shortcuts-dialog");
        const shortcutState = {
            title: shortcuts?.querySelector("h2")?.textContent ?? null,
            entries: [...(shortcuts?.querySelectorAll(".shortcut-list > div") ?? [])].map((row) => [
                row.querySelector("dt")?.textContent ?? "",
                row.querySelector("dd")?.textContent ?? ""
            ])
        };
        const escapeCanceled = !document.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true
        }));
        await nextFrame();
        const dialogClosedByEscape = document.querySelector(".application-dialog") === null;

        // menu外の操作でも閉じ、描画面へ不要なpanelを残さない。
        summary.click();
        await nextFrame();
        document.querySelector(".trace-app")?.dispatchEvent(new PointerEvent("pointerdown", {
            bubbles: true
        }));
        await nextFrame();

        return {
            menuItems,
            menuVersion,
            menuPanelOnTop,
            aboutState,
            mainLicenseState,
            licensesState,
            shortcutState,
            platform: navigator.platform,
            escapeCanceled,
            dialogClosedByEscape,
            menuClosedByOutsidePointer: !menu.open
        };
    })()`);
}

async function verifyLogPane(window) {
    return window.webContents.executeJavaScript(`(async () => {
        const nextFrame = () => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const menu = document.querySelector(".application-menu");
        const summary = menu?.querySelector(":scope > summary");
        const button = document.querySelector('button[aria-label="Application log"]');
        const viewer = document.querySelector(".viewer");
        if (!(menu instanceof HTMLDetailsElement) ||
            !(summary instanceof HTMLElement) ||
            !(button instanceof HTMLButtonElement) ||
            !(viewer instanceof HTMLElement)) {
            throw new Error("The application log control was not found.");
        }

        // 以前のmessageに依存せず、閉じた状態から未読数を検査する。
        summary.click();
        await nextFrame();
        button.click();
        await nextFrame();
        document.querySelector('button[aria-label="Clear logs"]')?.click();
        document.querySelector('button[aria-label="Close application log"]')?.click();
        await nextFrame();
        const initialViewerHeight = viewer.getBoundingClientRect().height;

        console.log("Log pane smoke info");
        await nextFrame();
        const infoOnlyWarningBadge = document.querySelector(".application-menu-warning-badge") !== null;
        console.warn("Log pane smoke warning");
        console.error("Log pane smoke error");
        await nextFrame();
        const unread = document.querySelector(".application-menu-count")?.textContent ?? null;
        const warningBadge = document.querySelector(".application-menu-warning-badge")?.textContent ?? null;
        const warningMenuLabel = summary.getAttribute("aria-label");

        summary.click();
        await nextFrame();
        button.click();
        await nextFrame();
        const pane = document.querySelector(".log-pane");
        const entries = [...document.querySelectorAll(".log-entry")].map((entry) => ({
            level: entry.querySelector("span")?.textContent ?? null,
            message: entry.querySelector("pre")?.textContent ?? null
        }));
        const openedViewerHeight = viewer.getBoundingClientRect().height;
        const initialPaneHeight = pane?.getBoundingClientRect().height ?? -1;
        const resizer = document.querySelector('[aria-label="Resize application log"]');
        if (!(resizer instanceof HTMLElement)) {
            throw new Error("The application log resizer was not found.");
        }
        const resizerStyle = getComputedStyle(resizer);
        const resizerBackground = resizerStyle.backgroundColor;
        const resizerBorder = resizerStyle.borderTopColor;
        resizer.dispatchEvent(new KeyboardEvent("keydown", {
            key: "ArrowUp",
            bubbles: true,
            cancelable: true
        }));
        await nextFrame();
        const resizedPaneHeight = pane?.getBoundingClientRect().height ?? -1;
        const copyEnabled = !(document.querySelector('button[aria-label="Copy logs"]')?.disabled ?? true);
        const unreadCleared = document.querySelector(".application-menu-count") === null;
        const warningBadgeCleared = document.querySelector(".application-menu-warning-badge") === null;

        document.querySelector('button[aria-label="Clear logs"]')?.click();
        await nextFrame();
        const cleared = document.querySelectorAll(".log-entry").length === 0 &&
            document.querySelector(".log-pane-empty")?.textContent === "No messages yet.";
        document.querySelector('button[aria-label="Close application log"]')?.click();
        await nextFrame();

        return {
            unread,
            infoOnlyWarningBadge,
            warningBadge,
            warningMenuLabel,
            warningBadgeCleared,
            entries,
            copyEnabled,
            unreadCleared,
            cleared,
            initialViewerHeight,
            openedViewerHeight,
            initialPaneHeight,
            resizedPaneHeight,
            resizerBackground,
            resizerBorder,
            restoredViewerHeight: viewer.getBoundingClientRect().height,
            closed: document.querySelector(".log-pane") === null
        };
    })()`);
}

async function verifyRemoteTraceWorkflow(window, webFile) {
    const traces = new Map([
        ["trace1", [
            "Kanata\t0004",
            "I\t0\t10\t0",
            "S\t0\t0\tF",
            "C\t1",
            "R\t0\t0\t0",
        ].join("\n")],
        ["trace2", [
            "Kanata\t0004",
            "I\t0\t20\t0",
            "S\t0\t0\tF",
            "C\t1",
            "R\t0\t0\t0",
        ].join("\n")],
    ]);
    const html = fs.readFileSync(webFile);
    const requests = [];
    const server = http.createServer((request, response) => {
        const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
        const name = pathname.slice(1);
        const body = pathname === "/" || pathname === "/index.html"
            ? html
            : traces.get(name);
        requests.push(`${request.method} ${pathname}`);
        if (body === undefined || (request.method !== "GET" && request.method !== "HEAD")) {
            response.writeHead(body === undefined ? 404 : 405).end();
            return;
        }
        const bytes = typeof body === "string" ? Buffer.from(body) : body;
        response.writeHead(200, {
            "Content-Length": bytes.byteLength,
            "Content-Type": pathname.endsWith(".html") || pathname === "/"
                ? "text/html; charset=utf-8"
                : "text/plain; charset=utf-8",
        });
        response.end(request.method === "HEAD" ? undefined : bytes);
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    try {
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("The remote trace test server did not start.");
        }
        await window.loadURL(
            `http://127.0.0.1:${address.port}/#name=remote-a.log&name=remote-b.log`,
        );
        const state = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const deadline = performance.now() + 10000;
            const check = () => {
                const tabs = [...document.querySelectorAll(".trace-tab")];
                if (tabs.some((tab) => tab.dataset.loadState === "error")) {
                    reject(new Error(document.querySelector(".status")?.textContent ??
                        "Remote trace loading failed."));
                    return;
                }
                if (tabs.length === 2 && tabs.every((tab) => tab.dataset.loadState === "ready")) {
                    const open = document.querySelector(".open-controls");
                    open?.querySelector(":scope > summary")?.click();
                    const reload = [...(open?.querySelectorAll("button") ?? [])]
                        .find((button) => button.textContent?.trim() === "Reload current");
                    resolve({
                        names: tabs.map((tab) =>
                            tab.querySelector('[role="tab"]')?.textContent?.trim() ?? ""),
                        activeOpCount: document.querySelector(".trace-app")?.dataset.opCount ?? null,
                        reloadEnabled: reload instanceof HTMLButtonElement && !reload.disabled
                    });
                    return;
                }
                if (performance.now() >= deadline) {
                    reject(new Error("Timed out while loading remote traces."));
                    return;
                }
                setTimeout(check, 10);
            };
            check();
        })`);
        return { ...state, requests };
    }
    finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

async function run() {
    // 製品Web版と同じくNode integrationを使わないRendererで検証する。
    const window = new BrowserWindow({
        // Xvfb内では表示状態にし、requestAnimationFrameの中間frameまで実際に描画する。
        show: true,
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
            const toolbar = document.querySelector(".app-toolbar");
            const openControls = document.querySelector(".open-controls");
            const openSummary = openControls?.querySelector(":scope > summary");
            openSummary?.click();
            const reloadButton = [...(openControls?.querySelectorAll("button") ?? [])]
                .find((button) => button.textContent?.trim() === "Reload current");
            const bookmarkControls = document.querySelector(".bookmark-controls");
            const bookmarkSummary = bookmarkControls?.querySelector(":scope > summary");
            bookmarkSummary?.click();
            const disabledViewControl = document.querySelector('select[aria-label="Pipeline color scheme"]');
            const enabledViewControl = document.querySelector('select[aria-label="UI color theme"]');
            const toolbarSequence = [...(toolbar?.children ?? [])].map((element) => {
                if (element.classList.contains("zoom-controls")) {
                    return "Zoom";
                }
                return element.matches("button.toolbar-action")
                    ? element.querySelector("span")?.textContent ?? null
                    : element.querySelector(":scope > summary.toolbar-action span")?.textContent ?? null;
            }).filter((label) => label !== null);
            resolve({
                title: document.title,
                headingCount: document.querySelectorAll(".app-toolbar h1").length,
                status: document.querySelector(".status")?.textContent ?? null,
                statusSpacer: document.querySelector(".status-spacer") !== null,
                fileAccept: document.querySelector(".file-input")?.getAttribute("accept") ?? null,
                emptyTitle: document.querySelector(".empty-state strong")?.textContent ?? null,
                emptyDetail: document.querySelector(".empty-state span")?.textContent ?? null,
                bookmarkDisabled: bookmarkSummary?.getAttribute("aria-disabled") ?? null,
                bookmarkOpensWithoutTrace: bookmarkControls?.open ?? null,
                bookmarkOpacity: bookmarkSummary === undefined ? null : getComputedStyle(bookmarkSummary).opacity,
                disabledViewOpacity:
                    disabledViewControl === null ? null : getComputedStyle(disabledViewControl).opacity,
                enabledViewOpacity:
                    enabledViewControl === null ? null : getComputedStyle(enabledViewControl).opacity,
                rootChildCount: document.querySelector("#konata-root")?.childElementCount ?? 0,
                paneTitleCount: document.querySelectorAll(".pane-title").length,
                openButtonColor: openButton === null ? null : getComputedStyle(openButton).backgroundColor,
                openButtonForeground: openButton === null ? null : getComputedStyle(openButton).color,
                openButtonDirection: openButton === null ? null : getComputedStyle(openButton).flexDirection,
                openIconSize: Number.parseFloat(getComputedStyle(openButton?.querySelector("svg")).width),
                openLabelSize: Number.parseFloat(getComputedStyle(openButton?.querySelector("span")).fontSize),
                openLabelColor: getComputedStyle(openButton?.querySelector("span")).color,
                openButtonText: openButton?.textContent?.trim() ?? null,
                openPanelTopLevel:
                    document.querySelector(".app-toolbar > .open-controls > .open-controls-panel") !== null,
                reloadDisabledWithoutHandle: reloadButton?.disabled ?? null,
                recentFilesEmpty: document.querySelector(".recent-files-empty")?.textContent ?? null,
                mainActionIconCount: document.querySelectorAll(
                    ".app-toolbar > .button-with-icon > svg, .app-toolbar > .open-controls > summary > svg",
                ).length,
                toolbarSequence,
                zoomIconCount: document.querySelectorAll(".zoom-controls .icon-button > svg").length,
                zoomSeparatorCount: document.querySelectorAll(".zoom-controls > .zoom-separator").length,
                zoomSeparatorPlacement:
                    document.querySelector('button[aria-label="Zoom in"]')?.nextElementSibling
                        ?.classList.contains("zoom-separator") === true &&
                    document.querySelector(".zoom-separator")?.nextElementSibling
                        ?.getAttribute("aria-label") === "Adjust position",
                zoomLabels: [...document.querySelectorAll(".zoom-controls .icon-button")]
                    .map((button) => button.getAttribute("aria-label")),
                viewSettingsIcon: document.querySelector('.view-controls > summary[aria-label="View settings"] > svg') !== null,
                bookmarkPanelTopLevel:
                    document.querySelector(".app-toolbar > .bookmark-controls > .bookmark-controls-panel") !== null,
                bookmarkInViewPanel: document.querySelector(".view-controls-panel .bookmark-controls") !== null,
                applicationMenuIcon:
                    document.querySelector('.application-menu > summary[aria-label="Application menu"] > svg') !== null,
                applicationMenuRightmost: toolbar?.lastElementChild?.classList.contains("application-menu") === true,
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
        initialState.status !== null ||
        !initialState.statusSpacer ||
        initialState.fileAccept !==
            ".log,.txt,.gz,.zst,.zstd,text/plain,application/gzip,application/zstd" ||
        initialState.emptyTitle !==
            "Drop one or more Kanata or gem5 O3PipeView traces anywhere in this window." ||
        initialState.emptyDetail !== "Plain text, gzip, and Zstandard files are supported." ||
        initialState.bookmarkDisabled !== "true" ||
        initialState.bookmarkOpensWithoutTrace !== false ||
        initialState.bookmarkOpacity !== "0.45" ||
        initialState.disabledViewOpacity !== "0.45" ||
        initialState.enabledViewOpacity !== "1" ||
        initialState.rootChildCount !== 1 ||
        initialState.paneTitleCount !== 0 ||
        initialState.openButtonColor !== "rgba(0, 0, 0, 0)" ||
        initialState.openButtonForeground !== "rgb(255, 255, 255)" ||
        initialState.openButtonDirection !== "column" ||
        initialState.openIconSize < 19 ||
        initialState.openLabelSize > 11 ||
        initialState.openLabelColor !== "rgb(255, 255, 255)" ||
        initialState.openButtonText !== "Open" ||
        !initialState.openPanelTopLevel ||
        !initialState.reloadDisabledWithoutHandle ||
        initialState.recentFilesEmpty !== "No recent files" ||
        initialState.mainActionIconCount !== 3 ||
        JSON.stringify(initialState.toolbarSequence) !==
            JSON.stringify(["Open", "Search", "Bookmark", "Compare", "Stats", "View", "Zoom", "Menu"]) ||
        initialState.zoomIconCount !== 4 ||
        initialState.zoomSeparatorCount !== 1 ||
        !initialState.zoomSeparatorPlacement ||
        JSON.stringify(initialState.zoomLabels) !==
            JSON.stringify(["Zoom out", "Zoom in", "Adjust position", "Reset view"]) ||
        !initialState.viewSettingsIcon ||
        !initialState.bookmarkPanelTopLevel ||
        initialState.bookmarkInViewPanel ||
        !initialState.applicationMenuIcon ||
        !initialState.applicationMenuRightmost ||
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

    const applicationMenuState = await verifyApplicationMenu(window);
    const shortcutCommandKey = applicationMenuState.platform.toLowerCase().startsWith("mac")
        ? "⌘"
        : "Ctrl";
    const expectedShortcuts = [
        ["Open trace", `${shortcutCommandKey}+O`],
        ["Command palette", `F1 · ${shortcutCommandKey}+Shift+P`],
        ["Search", `${shortcutCommandKey}+F · F3 / Shift+F3`],
        ["Move", "Arrow keys · Page Up / Page Down"],
        ["Pan canvas", "Drag · wheel · horizontal trackpad"],
        ["Zoom in", `+ · ${shortcutCommandKey}+↑ · Double-click`],
        ["Zoom out", `− · ${shortcutCommandKey}+↓ · Shift+double-click`],
        ["Zoom gesture", `${shortcutCommandKey}+wheel · Pinch`],
        ["Align fetch cycle", "Click instruction label"],
        ["Go to bookmark", "0–9"],
        ["Set bookmark", `${shortcutCommandKey}+0–9`],
        ["Close tab", "Middle-click tab"],
        ["Close dialog", "Esc"]
    ];
    if (JSON.stringify(applicationMenuState.menuItems) !== JSON.stringify([
        "Application log",
        "Keyboard shortcuts",
        "About Konata"
    ]) ||
        applicationMenuState.menuVersion !== `Version ${initialState.version}` ||
        !applicationMenuState.menuPanelOnTop ||
        applicationMenuState.aboutState.title !== "About Konata" ||
        applicationMenuState.aboutState.summary !== "Konata Pipeline visualization tool" ||
        applicationMenuState.aboutState.authors !== "Ryota Shioya and Kojiro Izuoka" ||
        JSON.stringify(applicationMenuState.aboutState.values) !==
            JSON.stringify([initialState.version, initialState.commit, initialState.date]) ||
        JSON.stringify(applicationMenuState.aboutState.links) !== JSON.stringify([
            {
                text: "GitHub",
                href: "https://github.com/shioyadan/Konata",
                target: "_blank",
                rel: "noreferrer"
            }
        ]) ||
        applicationMenuState.mainLicenseState.title !== "Konata License" ||
        !applicationMenuState.mainLicenseState.hasCopyright ||
        applicationMenuState.licensesState.title !== "Third-Party Licenses" ||
        !applicationMenuState.licensesState.hasReact ||
        !applicationMenuState.licensesState.hasBootstrapIcons ||
        !applicationMenuState.licensesState.hasFzstd ||
        !applicationMenuState.licensesState.hasZstandard ||
        !applicationMenuState.licensesState.hasApache ||
        applicationMenuState.aboutState.backdropLayer !== "30" ||
        applicationMenuState.shortcutState.title !== "Keyboard Shortcuts" ||
        JSON.stringify(applicationMenuState.shortcutState.entries) !== JSON.stringify(expectedShortcuts) ||
        !applicationMenuState.escapeCanceled ||
        !applicationMenuState.dialogClosedByEscape ||
        !applicationMenuState.menuClosedByOutsidePointer) {
        throw new Error(`Application menu is incomplete: ${JSON.stringify(applicationMenuState)}`);
    }

    const multipleFileDropState = await verifyMultipleFileDrop(window);
    if (multipleFileDropState.startedStreams !== 2 ||
        multipleFileDropState.activeName !== "multi-b.log" ||
        multipleFileDropState.restoredTabCount !== multipleFileDropState.initialTabCount) {
        throw new Error(`Multiple-file drop is incomplete: ${JSON.stringify(multipleFileDropState)}`);
    }

    const logPaneState = await verifyLogPane(window);
    if (logPaneState.unread !== "3" ||
        logPaneState.infoOnlyWarningBadge ||
        logPaneState.warningBadge !== "!" ||
        logPaneState.warningMenuLabel !== "Application menu, unread warnings in application log" ||
        !logPaneState.warningBadgeCleared ||
        JSON.stringify(logPaneState.entries) !== JSON.stringify([
            {level: "info", message: "Log pane smoke info"},
            {level: "warning", message: "Log pane smoke warning"},
            {level: "error", message: "Log pane smoke error"}
        ]) ||
        !logPaneState.copyEnabled ||
        !logPaneState.unreadCleared ||
        !logPaneState.cleared ||
        logPaneState.openedViewerHeight >= logPaneState.initialViewerHeight ||
        logPaneState.resizedPaneHeight <= logPaneState.initialPaneHeight ||
        logPaneState.resizerBackground !== "rgb(28, 32, 39)" ||
        logPaneState.resizerBorder !== "rgb(52, 59, 70)" ||
        logPaneState.restoredViewerHeight !== logPaneState.initialViewerHeight ||
        !logPaneState.closed) {
        throw new Error(`Application log pane is incomplete: ${JSON.stringify(logPaneState)}`);
    }

    const incrementalState = await verifyIncrementalRendering(window);
    if (incrementalState.partialPixels < 100 ||
        incrementalState.finalOpCount !== 2 ||
        !incrementalState.loadingStatus?.text?.startsWith("Loading incremental.log…") ||
        incrementalState.loadingStatus?.dots !== 6 ||
        incrementalState.loadingStatus?.dotBlur === "none" ||
        incrementalState.loadingStatus?.dotColor !== "rgb(216, 221, 229)" ||
        incrementalState.loadingStatus?.dotShadow === "none" ||
        incrementalState.loadingStatus?.dotOpacity !== "1" ||
        incrementalState.loadingStatus?.dotTiming !== "ease-in-out" ||
        incrementalState.loadingStatus?.dotTransformOrigin !== "1.125px 1.125px" ||
        !(incrementalState.loadingStatus?.hexagonSideSpread < 0.05) ||
        incrementalState.loadingStatus?.role !== "status" ||
        !incrementalState.dotsAnimated ||
        incrementalState.completionStatus?.dotAnimation !== "status-loading-complete-dots" ||
        incrementalState.completionStatus?.dotFilter !== "blur(0.1px) brightness(0.65)" ||
        incrementalState.completionStatus?.dotOpacity !== "0" ||
        incrementalState.completionStatus?.glowAnimation !== "status-loading-complete-glow" ||
        incrementalState.completionStatus?.glowOpacity !== "0" ||
        incrementalState.completionStatus?.glowShadow === "none" ||
        incrementalState.progressLayers?.toolbar !== "3" ||
        incrementalState.progressLayers?.progress !== "100" ||
        incrementalState.progressLayers?.splitter !== "0") {
        throw new Error(`Incremental trace rendering is incomplete: ${JSON.stringify(incrementalState)}`);
    }

    const parserTimingLog = await window.webContents.executeJavaScript(`(async () => {
        const nextFrame = () => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const menu = document.querySelector(".application-menu");
        menu?.querySelector(":scope > summary")?.click();
        await nextFrame();
        menu?.querySelector('button[aria-label="Application log"]')?.click();
        await nextFrame();
        const message = [...document.querySelectorAll(".log-entry pre")]
            .map((entry) => entry.textContent ?? "")
            .findLast((entry) => entry.startsWith("Parsed (OnikiriParser):")) ?? null;
        document.querySelector('button[aria-label="Close application log"]')?.click();
        await nextFrame();
        return message;
    })()`);
    if (!/^Parsed \(OnikiriParser\): \d+ ms$/.test(parserTimingLog ?? "")) {
        throw new Error(`Parser timing was not written to the application log: ${parserTimingLog}`);
    }

    const canceledLoadState = await verifyClosedTabCancelsLoading(window);
    if (!canceledLoadState.streamCanceled || !canceledLoadState.tabClosed) {
        throw new Error(`Closing a loading tab did not cancel its stream: ${JSON.stringify(canceledLoadState)}`);
    }

    // 読込み失敗を画面内に示し、同じfileの擬似reloadではなく再選択へ案内する。
    const loadErrorState = await verifyLoadErrorRecovery(window);
    if (loadErrorState.title !== "The trace could not be opened." ||
        typeof loadErrorState.detail !== "string" ||
        loadErrorState.detail === "" ||
        loadErrorState.status !== loadErrorState.detail ||
        loadErrorState.statusType !== "error" ||
        !loadErrorState.statusIcon ||
        loadErrorState.statusRole !== "alert" ||
        !loadErrorState.pickerRequested ||
        !loadErrorState.shortcutPickerRequested ||
        !loadErrorState.shortcutCanceled) {
        throw new Error(`Load error recovery is incomplete: ${JSON.stringify(loadErrorState)}`);
    }

    const plainFixture = path.join(__dirname, "fixtures", "kanata-basic.txt");
    await dropFixture(window, plainFixture, "text/plain");
    const plainState = await readRenderedState(window);
    if (plainState.loadState !== "ready" ||
        plainState.fileName !== "kanata-basic.txt" ||
        plainState.opCount !== 2 ||
        plainState.laneCount !== 2 ||
        plainState.status !== "Loaded with 1 warning · 2 ops · 5 cycles · 2 lanes" ||
        plainState.statusType !== "warning" ||
        !plainState.statusIcon ||
        plainState.menuWarningBadge !== "!" ||
        plainState.menuLabel !== "Application menu, unread warnings in application log" ||
        plainState.nonBackgroundPixels < 100) {
        throw new Error(`Plain-text trace rendering is incomplete: ${JSON.stringify(plainState)}`);
    }

    // Ctrl+wheelはbrowser zoomを抑止し、Konata内では移動経路が見えるよう補間する。
    const wheelZoomState = await window.webContents.executeJavaScript(`(async () => {
        const viewer = document.querySelector(".viewer");
        const reset = [...document.querySelectorAll(".zoom-controls button")]
            .find((button) => button.textContent?.trim() === "Reset");
        const output = document.querySelector(".zoom-controls output");
        if (!(viewer instanceof HTMLElement) || !(reset instanceof HTMLButtonElement)) {
            throw new Error("The viewer zoom controls were not found.");
        }
        const before = output?.textContent ?? null;
        const event = new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            deltaY: -1,
            clientX: viewer.getBoundingClientRect().left + 400,
            clientY: viewer.getBoundingClientRect().top + 200
        });
        const dispatched = viewer.dispatchEvent(event);
        const immediatelyAfter = output?.textContent ?? null;
        await new Promise((resolve) => requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const during = output?.textContent ?? null;
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const zoom = output?.textContent ?? null;
        reset.click();
        const resetImmediatelyAfter = output?.textContent ?? null;
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
            canceled: !dispatched && event.defaultPrevented,
            before,
            immediatelyAfter,
            during,
            zoom,
            resetImmediatelyAfter,
            resetZoom: output?.textContent ?? null
        };
    })()`);
    if (!wheelZoomState.canceled ||
        wheelZoomState.before !== "100%" ||
        wheelZoomState.immediatelyAfter !== "100%" ||
        wheelZoomState.during === "100%" ||
        wheelZoomState.during === "200%" ||
        wheelZoomState.zoom !== "200%" ||
        wheelZoomState.resetImmediatelyAfter !== "200%" ||
        wheelZoomState.resetZoom !== "100%") {
        throw new Error(`Wheel zoom handling is incomplete: ${JSON.stringify(wheelZoomState)}`);
    }

    // 完成済みのdblclickを直接送らず、実clickでpointer capture後にもzoomできることを確認する。
    const doubleClickSetup = await window.webContents.executeJavaScript(`(async () => {
        const pipeline = document.querySelector(".pipeline-pane canvas");
        const zoomOut = document.querySelector('button[aria-label="Zoom out"]');
        const output = document.querySelector(".zoom-controls output");
        if (!(pipeline instanceof HTMLCanvasElement) || !(zoomOut instanceof HTMLButtonElement)) {
            throw new Error("The double click zoom controls were not found.");
        }
        const rect = pipeline.getBoundingClientRect();
        // 拡大上限の200%から離し、4連打の2ペアを25%から100%まで観測する。
        zoomOut.click();
        zoomOut.click();
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            zoom: output?.textContent ?? null
        };
    })()`);
    // 4連打を一続きのmulti-clickとして送り、2回目と4回目をそれぞれ1段の拡大として積み上げる。
    for (let clickCount = 1; clickCount <= 4; clickCount++) {
        window.webContents.sendInputEvent({
            type: "mouseDown", button: "left", clickCount,
            x: doubleClickSetup.x, y: doubleClickSetup.y
        });
        window.webContents.sendInputEvent({
            type: "mouseUp", button: "left", clickCount,
            x: doubleClickSetup.x, y: doubleClickSetup.y
        });
    }
    const doubleClickZoomState = await window.webContents.executeJavaScript(`(async () => {
        const reset = [...document.querySelectorAll(".zoom-controls button")]
            .find((button) => button.textContent?.trim() === "Reset");
        const output = document.querySelector(".zoom-controls output");
        if (!(reset instanceof HTMLButtonElement)) {
            throw new Error("The double click zoom controls were not found.");
        }
        const immediatelyAfter = output?.textContent ?? null;
        await new Promise((resolve) => requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const during = output?.textContent ?? null;
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const zoom = output?.textContent ?? null;
        reset.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
            immediatelyAfter,
            during,
            zoom,
            resetZoom: output?.textContent ?? null
        };
    })()`);
    if (doubleClickSetup.zoom !== "25%" ||
        doubleClickZoomState.immediatelyAfter !== "25%" ||
        doubleClickZoomState.during === "25%" ||
        doubleClickZoomState.during === "100%" ||
        doubleClickZoomState.zoom !== "100%" ||
        doubleClickZoomState.resetZoom !== "100%") {
        throw new Error(`Double click zoom is incomplete: ${JSON.stringify(doubleClickZoomState)}`);
    }

    // shortcut一覧に示すCtrl/Command+上下が、browser scrollではなくKonataのzoomになることを確認する。
    const keyboardZoomState = await window.webContents.executeJavaScript(`(async () => {
        const output = document.querySelector(".zoom-controls output");
        const zoom = async (key) => {
            const event = new KeyboardEvent("keydown", {
                key,
                ctrlKey: true,
                bubbles: true,
                cancelable: true
            });
            const dispatched = document.dispatchEvent(event);
            await new Promise((resolve) => setTimeout(resolve, 220));
            await new Promise((resolve) => requestAnimationFrame(resolve));
            return {
                canceled: !dispatched && event.defaultPrevented,
                value: output?.textContent ?? null
            };
        };
        return {
            out: await zoom("ArrowDown"),
            in: await zoom("ArrowUp")
        };
    })()`);
    if (!keyboardZoomState.out.canceled ||
        keyboardZoomState.out.value !== "50%" ||
        !keyboardZoomState.in.canceled ||
        keyboardZoomState.in.value !== "100%") {
        throw new Error(`Keyboard zoom is incomplete: ${JSON.stringify(keyboardZoomState)}`);
    }

    // 通常wheelを素早く3回送ると、途中で跳ばずに目標へ18cycle分を積み上げる。
    // その後のAdjust positionは上端命令のfetch cycleへ、同じscroll補間で復帰する。
    const wheelScrollState = await window.webContents.executeJavaScript(`(async () => {
        const viewer = document.querySelector(".viewer");
        const pipeline = document.querySelector(".pipeline-pane canvas");
        const adjust = document.querySelector('button[aria-label="Adjust position"]');
        const reset = [...document.querySelectorAll(".zoom-controls button")]
            .find((button) => button.textContent?.trim() === "Reset");
        if (!(viewer instanceof HTMLElement) ||
            !(pipeline instanceof HTMLCanvasElement) ||
            !(adjust instanceof HTMLButtonElement) ||
            !(reset instanceof HTMLButtonElement)) {
            throw new Error("The wheel scroll controls were not found.");
        }
        const rect = pipeline.getBoundingClientRect();
        const readCycle = async () => {
            pipeline.dispatchEvent(new MouseEvent("mousemove", {
                bubbles: true,
                clientX: rect.left + 8,
                clientY: rect.top + 8
            }));
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const text = document.querySelector('[role="tooltip"]')?.textContent ?? "";
            return Number(text.startsWith("[") ? text.slice(1, text.indexOf(",")) : -1);
        };
        const events = Array.from({length: 3}, () => new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaX: 1,
            clientX: rect.left + 8,
            clientY: rect.top + 8
        }));
        const dispatched = events.map((event) => viewer.dispatchEvent(event));
        await new Promise((resolve) => requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const duringCycle = await readCycle();
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const finalCycle = await readCycle();
        adjust.click();
        await new Promise((resolve) => requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const adjustedDuringCycle = await readCycle();
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const adjustedFinalCycle = await readCycle();
        reset.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
            canceled: dispatched.every((value, index) => !value && events[index].defaultPrevented),
            duringCycle,
            finalCycle,
            adjustedDuringCycle,
            adjustedFinalCycle
        };
    })()`);
    if (!wheelScrollState.canceled ||
        wheelScrollState.duringCycle <= 0 ||
        wheelScrollState.duringCycle >= 18 ||
        wheelScrollState.finalCycle !== 18 ||
        wheelScrollState.adjustedDuringCycle <= 0 ||
        wheelScrollState.adjustedDuringCycle >= 18 ||
        wheelScrollState.adjustedFinalCycle !== 0) {
        throw new Error(`Wheel scroll animation is incomplete: ${JSON.stringify(wheelScrollState)}`);
    }

    // touch画面では2 pointer間の距離比を連続倍率へ変換し、browser gestureに渡さずzoomする。
    const pinchZoomState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const viewer = document.querySelector(".viewer");
        const pipeline = document.querySelector(".pipeline-pane");
        const reset = [...document.querySelectorAll(".zoom-controls button")]
            .find((button) => button.textContent?.trim() === "Reset");
        if (!(viewer instanceof HTMLElement) ||
            !(pipeline instanceof HTMLElement) ||
            !(reset instanceof HTMLButtonElement)) {
            throw new Error("The touch zoom controls were not found.");
        }
        // synthetic pointerにも製品コードと同じcapture寿命を与える。
        const captured = new Set();
        Object.defineProperties(viewer, {
            setPointerCapture: {configurable: true, value: (id) => captured.add(id)},
            hasPointerCapture: {configurable: true, value: (id) => captured.has(id)},
            releasePointerCapture: {configurable: true, value: (id) => captured.delete(id)}
        });
        const rect = pipeline.getBoundingClientRect();
        const dispatchPointer = (type, pointerId, x, buttons) => viewer.dispatchEvent(new PointerEvent(type, {
            pointerId,
            pointerType: "touch",
            isPrimary: pointerId === 1,
            button: type === "pointerdown" ? 0 : -1,
            buttons,
            clientX: rect.left + x,
            clientY: rect.top + 200,
            bubbles: true,
            cancelable: true
        }));
        dispatchPointer("pointerdown", 1, 100, 1);
        dispatchPointer("pointerdown", 2, 200, 1);
        dispatchPointer("pointermove", 2, 300, 1);
        dispatchPointer("pointerup", 2, 300, 0);
        dispatchPointer("pointerup", 1, 100, 0);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const result = {
                zoom: document.querySelector(".zoom-controls output")?.textContent ?? null,
                capturedPointers: captured.size,
                panning: viewer.classList.contains("is-panning"),
                touchAction: getComputedStyle(viewer).touchAction
            };
            delete viewer.setPointerCapture;
            delete viewer.hasPointerCapture;
            delete viewer.releasePointerCapture;
            reset.click();
            setTimeout(() => requestAnimationFrame(() => resolve(result)), 300);
        }));
    })`);
    if (pinchZoomState.zoom !== "200%" ||
        pinchZoomState.capturedPointers !== 0 ||
        pinchZoomState.panning ||
        pinchZoomState.touchAction !== "none") {
        throw new Error(`Pinch zoom handling is incomplete: ${JSON.stringify(pinchZoomState)}`);
    }

    // 旧コマンドパレットの起動、履歴、正規表現の前後検索、ID移動を実画面で確認する。
    const commandState = await window.webContents.executeJavaScript(`(async () => {
        const setInput = (input, value) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            setter?.call(input, value);
            input.dispatchEvent(new Event("input", {bubbles: true}));
        };
        // paletteのReact状態反映だけを待つ箇所では、短いtimerで十分とする。
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

        const searchButton = document.querySelector('button[aria-label="Search trace"]');
        if (!(searchButton instanceof HTMLButtonElement) || searchButton.querySelector("svg") === null) {
            throw new Error("The toolbar search button was not found.");
        }
        searchButton.click();
        await nextFrame();
        const searchInput = document.querySelector('.command-palette input');
        if (!(searchInput instanceof HTMLInputElement)) {
            throw new Error("The toolbar search button did not open the command palette.");
        }
        const prefilled = searchInput.value;
        const hints = [...document.querySelectorAll('.command-hint code')].map((hint) => hint.textContent);
        searchButton.click();
        await nextFrame();
        const closesOnSecondClick = document.querySelector('.command-palette') === null;
        searchButton.click();
        await nextFrame();
        const reopenedSearchInput = document.querySelector('.command-palette input');
        if (!(reopenedSearchInput instanceof HTMLInputElement)) {
            throw new Error("The toolbar search button did not reopen the command palette.");
        }
        await execute(reopenedSearchInput, "f execute|consumer");
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
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));

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
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {prefilled, hints, closesOnSecondClick, firstResult, nextResult, previousResult, history, jumpToolTip};
    })()`);
    if (commandState.prefilled !== "f " ||
        !commandState.closesOnSecondClick ||
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
                        closeIcon: dialog.querySelector('button[aria-label="Close statistics"] svg') !== null,
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
        !statsState.closeIcon ||
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
    const labelClickToolTip = await window.webContents.executeJavaScript(`(async () => {
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
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const pipelineRect = pipeline.getBoundingClientRect();
        pipeline.dispatchEvent(new MouseEvent("mousemove", {
            bubbles: true,
            clientX: pipelineRect.left + 8,
            clientY: pipelineRect.top + 8
        }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return document.querySelector('[role="tooltip"]')?.textContent ?? null;
    })()`);
    if (typeof labelClickToolTip !== "string" || !labelClickToolTip.startsWith("[3, 0]")) {
        throw new Error(`Label click alignment is incomplete: ${JSON.stringify(labelClickToolTip)}`);
    }

    // 旧版の左右キーは1回につき6cycle移動する。右へ動かした後、後続テスト用に左へ戻す。
    const keyboardToolTip = await window.webContents.executeJavaScript(`(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true}));
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
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
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const text = document.querySelector('[role="tooltip"]')?.textContent ?? null;
        document.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowLeft", bubbles: true}));
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return text;
    })()`);
    if (typeof keyboardToolTip !== "string" || !keyboardToolTip.startsWith("[9, 0]")) {
        throw new Error(`Keyboard navigation is incomplete: ${JSON.stringify(keyboardToolTip)}`);
    }

    // 旧版と同じ数字キーでの移動とCtrl/Command+数字での設定を、表示中のslot値とCanvasで確認する。
    const bookmarkState = await window.webContents.executeJavaScript(`(async () => {
        const nextFrame = () => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const bookmarkControls = document.querySelector(".bookmark-controls");
        const bookmarkSummary = bookmarkControls?.querySelector(":scope > summary");
        if (!(bookmarkControls instanceof HTMLDetailsElement) || !(bookmarkSummary instanceof HTMLElement)) {
            throw new Error("The toolbar bookmark controls were not found.");
        }
        bookmarkSummary.click();
        await nextFrame();
        const opensFromToolbar = bookmarkControls.open &&
            bookmarkControls.parentElement?.classList.contains("app-toolbar") === true;
        document.querySelector(".pipeline-pane")?.dispatchEvent(new MouseEvent("click", {bubbles: true}));
        await nextFrame();
        const closesOutside = !bookmarkControls.open;
        const reset = [...document.querySelectorAll(".zoom-controls button")]
            .find((button) => button.textContent?.trim() === "Reset");
        if (!(reset instanceof HTMLButtonElement)) {
            throw new Error("The Reset button was not found.");
        }
        reset.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        document.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true, cancelable: true}));
        // scroll完了後の座標をbookmarkへ保存する。
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        document.dispatchEvent(new KeyboardEvent("keydown", {
            key: "2",
            ctrlKey: true,
            bubbles: true,
            cancelable: true
        }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const slot = document.querySelector('button[aria-label="Go to bookmark 2"]')?.nextElementSibling;
        document.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true, cancelable: true}));
        document.dispatchEvent(new KeyboardEvent("keydown", {key: "2", bubbles: true, cancelable: true}));
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) => requestAnimationFrame(resolve));

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
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
            opensFromToolbar,
            closesOutside,
            slot: slot?.textContent ?? null,
            goButtons: document.querySelectorAll('button[aria-label^="Go to bookmark "]').length,
            setButtons: document.querySelectorAll('button[aria-label^="Set bookmark "]').length,
            toolTip: document.querySelector('[role="tooltip"]')?.textContent ?? null
        };
    })()`);
    if (!bookmarkState.opensFromToolbar ||
        !bookmarkState.closesOutside ||
        bookmarkState.slot !== "2: x:6, y:0, zoom:0" ||
        bookmarkState.goButtons !== 10 ||
        bookmarkState.setButtons !== 10 ||
        typeof bookmarkState.toolTip !== "string" ||
        !bookmarkState.toolTip.startsWith("[6, 0]")) {
        throw new Error(`Bookmarks are incomplete: ${JSON.stringify(bookmarkState)}`);
    }

    const bookmarkZoomState = await window.webContents.executeJavaScript(`(async () => {
        const reset = [...document.querySelectorAll(".zoom-controls button")]
            .find((button) => button.textContent?.trim() === "Reset");
        const zoomIn = document.querySelector('button[aria-label="Zoom in"]');
        if (!(reset instanceof HTMLButtonElement) || !(zoomIn instanceof HTMLButtonElement)) {
            throw new Error("The zoom controls were not found.");
        }
        zoomIn.click();
        // zoom完了後の倍率を保存する。
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        document.dispatchEvent(new KeyboardEvent("keydown", {
            key: "3",
            ctrlKey: true,
            bubbles: true,
            cancelable: true
        }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const slot = document.querySelector('button[aria-label="Go to bookmark 3"]')?.nextElementSibling;
        reset.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        document.dispatchEvent(new KeyboardEvent("keydown", {key: "3", bubbles: true, cancelable: true}));
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
            slot: slot?.textContent ?? null,
            zoom: document.querySelector(".zoom-controls output")?.textContent ?? null
        };
    })()`);
    if (typeof bookmarkZoomState.slot !== "string" ||
        !bookmarkZoomState.slot.endsWith("zoom:-1") ||
        bookmarkZoomState.zoom !== "200%") {
        throw new Error(`Bookmark zoom is incomplete: ${JSON.stringify(bookmarkZoomState)}`);
    }

    // 同じ単一HTMLを読み直しても保存値を復元し、壊れた値では安全に初期値へ戻ることを確認する。
    await window.loadFile(webFile);
    const persistedCommandHistory = await window.webContents.executeJavaScript(`(async () => {
        const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 10));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        document.dispatchEvent(new KeyboardEvent("keydown", {key: "F1", bubbles: true, cancelable: true}));
        await nextFrame();
        const input = document.querySelector('.command-palette input');
        if (!(input instanceof HTMLInputElement)) {
            throw new Error("The restored command palette was not opened.");
        }
        input.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowUp", bubbles: true, cancelable: true}));
        await nextFrame();
        const command = input.value;
        input.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
        return command;
    })()`);
    if (persistedCommandHistory !== "j 0") {
        throw new Error(`Command history persistence is incomplete: ${JSON.stringify(persistedCommandHistory)}`);
    }

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

    await window.webContents.executeJavaScript(`(() => {
        localStorage.setItem("konata.bookmarks", "{broken");
        localStorage.setItem("konata.commandHistory", "{broken");
    })()`);
    await window.loadFile(webFile);
    const recoveredBookmarkState = await window.webContents.executeJavaScript(`(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        document.dispatchEvent(new KeyboardEvent("keydown", {key: "F1", bubbles: true, cancelable: true}));
        await new Promise((resolve) => setTimeout(resolve, 10));
        const historyInput = document.querySelector('.command-palette input');
        if (!(historyInput instanceof HTMLInputElement)) {
            throw new Error("The recovered command palette was not opened.");
        }
        historyInput.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowUp", bubbles: true, cancelable: true}));
        await new Promise((resolve) => setTimeout(resolve, 10));
        const commandHistory = historyInput.value;
        historyInput.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
        return {
            loadState: document.querySelector(".trace-app")?.dataset.loadState ?? null,
            slot2: document.querySelector('button[aria-label="Go to bookmark 2"]')?.nextElementSibling?.textContent ?? null,
            slot3: document.querySelector('button[aria-label="Go to bookmark 3"]')?.nextElementSibling?.textContent ?? null,
            commandHistory
        };
    })()`);
    if (recoveredBookmarkState.loadState !== "idle" ||
        recoveredBookmarkState.slot2 !== "2: x:0, y:0, zoom:0" ||
        recoveredBookmarkState.slot3 !== "3: x:0, y:0, zoom:0" ||
        recoveredBookmarkState.commandHistory !== "") {
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
        const viewControls = document.querySelector(".view-controls");
        const viewPanel = document.querySelector(".view-controls-panel");
        const splitter = document.querySelector(".pane-splitter");
        const hideFlushed = document.querySelector('input[aria-label="Hide flushed ops"]');
        const split = document.querySelector('input[aria-label="Split lanes"]');
        const fixed = document.querySelector('input[aria-label="Fix op height"]');
        const arrows = document.querySelector('select[aria-label="Dependency arrow type"]');
        const theme = document.querySelector('select[aria-label="UI color theme"]');
        const color = document.querySelector('select[aria-label="Pipeline color scheme"]');
        const zoomSteps = document.querySelector('input[aria-label="Zoom steps per 2x"]');
        const webGL = document.querySelector('input[aria-label="WebGL rendering"]');
        const textCache = document.querySelector('input[aria-label="Text caching"]');
        const compatibility = document.querySelector(".compatibility-settings");
        const drawingThresholds = document.querySelector(".drawing-thresholds");
        const textThreshold = document.querySelector('input[aria-label="Text labels minimum lane height"]');
        if (!(viewControls instanceof HTMLDetailsElement) ||
            !(viewPanel instanceof HTMLElement) ||
            !(splitter instanceof HTMLElement) ||
            !(hideFlushed instanceof HTMLInputElement) ||
            !(split instanceof HTMLInputElement) ||
            !(fixed instanceof HTMLInputElement) ||
            !(arrows instanceof HTMLSelectElement) ||
            !(theme instanceof HTMLSelectElement) ||
            !(color instanceof HTMLSelectElement) ||
            !(zoomSteps instanceof HTMLInputElement) ||
            !(webGL instanceof HTMLInputElement) ||
            !(textCache instanceof HTMLInputElement) ||
            !(compatibility instanceof HTMLDetailsElement) ||
            !(drawingThresholds instanceof HTMLDetailsElement) ||
            !(textThreshold instanceof HTMLInputElement)) {
            throw new Error("The renderer view controls were not found.");
        }
        // panel内のclickでは開いたままにし、Canvas側のclickで閉じる。
        viewControls.open = true;
        viewPanel.dispatchEvent(new MouseEvent("click", {bubbles: true}));
        const staysOpenAfterInsideClick = viewControls.open;
        document.querySelector(".pipeline-pane")?.dispatchEvent(new MouseEvent("click", {bubbles: true}));
        const closesAfterOutsideClick = !viewControls.open;
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
            toolbarBackground: getComputedStyle(document.querySelector(".app-toolbar")).backgroundColor,
            toolbarShadow: getComputedStyle(document.querySelector(".app-toolbar")).boxShadow,
            primaryButtonBackground: getComputedStyle(document.querySelector(".primary-button")).backgroundColor,
            primaryButtonColor: getComputedStyle(document.querySelector(".primary-button")).color,
            primaryButtonLabelColor: getComputedStyle(
                document.querySelector(".primary-button span"),
            ).color,
            secondaryButtonBackground: getComputedStyle(
                document.querySelector(".app-toolbar > button:not(.primary-button)"),
            ).backgroundColor,
            secondaryButtonColor: getComputedStyle(
                document.querySelector(".app-toolbar > button:not(.primary-button)"),
            ).color,
            viewButtonBackground: getComputedStyle(viewControls.querySelector("summary")).backgroundColor,
            viewButtonColor: getComputedStyle(viewControls.querySelector("summary")).color,
            viewButtonLabel: viewControls.querySelector("summary span")?.textContent ?? null,
            tabBarBackground: getComputedStyle(document.querySelector(".tab-bar")).backgroundColor,
            tabBarBorderWidth: getComputedStyle(document.querySelector(".tab-bar")).borderBottomWidth,
            activeTabBackground: getComputedStyle(document.querySelector(".trace-tab.is-active")).backgroundColor,
            activeTabAccent: getComputedStyle(document.querySelector(".trace-tab.is-active")).boxShadow,
            activeTabFontWeight: getComputedStyle(document.querySelector(".trace-tab.is-active .trace-tab-activate")).fontWeight,
            viewPanelZIndex: getComputedStyle(viewPanel).zIndex,
            splitterZIndex: getComputedStyle(splitter).zIndex,
            staysOpenAfterInsideClick,
            closesAfterOutsideClick,
            split: split.checked,
            fixEnabled: !fixed.disabled,
            arrows: arrows.value,
            theme: document.querySelector(".trace-app")?.dataset.theme ?? null,
            color: color.value,
            webGL: webGL.checked,
            textCache: textCache.checked,
            compatibilityOpen: compatibility.open,
            compatibilitySummary: compatibility.querySelector("summary")?.textContent?.trim() ?? null,
            compatibilityTitle: compatibility.querySelector("summary")?.title ?? null,
            textThreshold: textThreshold.value,
            thresholdSummary: drawingThresholds.querySelector("summary")?.textContent?.trim() ?? null,
            thresholdSummaryTitle: drawingThresholds.querySelector("summary")?.title ?? null,
            settingTitles: [theme, hideFlushed, split, fixed, color, arrows, zoomSteps, webGL, textCache]
                .map((control) => control.closest("label")?.title ?? null),
            thresholdLabels: Array.from(drawingThresholds.querySelectorAll("label"), (label) => ({
                text: label.childNodes[0]?.textContent?.trim() ?? null,
                title: label.title,
                ariaLabel: label.querySelector("input")?.getAttribute("aria-label") ?? null
            })),
            labelBackground: getComputedStyle(document.querySelector(".label-pane")).backgroundColor,
            pipelineBackground: getComputedStyle(document.querySelector(".pipeline-pane")).backgroundColor
        })));
    })`);
    if (!viewControlState.split ||
        !viewControlState.fixEnabled ||
        viewControlState.arrows !== "leftSideCurve" ||
        viewControlState.theme !== "light" ||
        viewControlState.color !== "Custom" ||
        !viewControlState.webGL ||
        !viewControlState.textCache ||
        viewControlState.compatibilityOpen ||
        viewControlState.compatibilitySummary !== "Compatibility" ||
        viewControlState.compatibilityTitle !==
            "Rendering options for compatibility and troubleshooting." ||
        viewControlState.textThreshold !== "12" ||
        viewControlState.thresholdSummary !== "Minimum lane height (px)" ||
        viewControlState.thresholdSummaryTitle !==
            "Larger values hide details sooner as you zoom out; smaller values keep them visible longer." ||
        JSON.stringify(viewControlState.settingTitles) !== JSON.stringify([
            "Switch the interface and canvas between dark and light colors.",
            "Hide flushed instructions and arrange the remaining instructions by retire ID.",
            "Show each pipeline lane on a separate row.",
            "Keep each instruction at a fixed total height when lanes are split.",
            "Choose how pipeline stages are colored.",
            "Choose how instruction dependencies are drawn.",
            "Number of steps used to double or halve the zoom.",
            "Disable WebGL if rendering problems occur.",
            "Disable if cached text appears blurred or otherwise incorrect."
        ]) ||
        JSON.stringify(viewControlState.thresholdLabels) !== JSON.stringify([
            {
                text: "Text labels",
                title: "Show text labels when the lane is taller than this value.",
                ariaLabel: "Text labels minimum lane height"
            },
            {
                text: "Stage details",
                title: "Draw individual lanes and stages when the lane is taller than this value.",
                ariaLabel: "Stage details minimum lane height"
            },
            {
                text: "Dependency arrows",
                title: "Show dependency arrows when the lane is taller than this value.",
                ariaLabel: "Dependency arrows minimum lane height"
            },
            {
                text: "Stage borders",
                title: "Show stage borders when the lane is taller than this value.",
                ariaLabel: "Stage borders minimum lane height"
            }
        ]) ||
        viewControlState.toolbarBackground !== "rgb(82, 92, 125)" ||
        viewControlState.toolbarShadow !== "none" ||
        viewControlState.primaryButtonBackground !== "rgba(0, 0, 0, 0)" ||
        viewControlState.primaryButtonColor !== "rgb(255, 255, 255)" ||
        viewControlState.primaryButtonLabelColor !== "rgb(255, 255, 255)" ||
        viewControlState.secondaryButtonBackground !== "rgba(0, 0, 0, 0)" ||
        viewControlState.secondaryButtonColor !== "rgb(217, 221, 230)" ||
        viewControlState.viewButtonBackground !== viewControlState.secondaryButtonBackground ||
        viewControlState.viewButtonColor !== viewControlState.secondaryButtonColor ||
        viewControlState.viewButtonLabel !== "View" ||
        viewControlState.tabBarBackground !== "rgb(59, 65, 88)" ||
        viewControlState.tabBarBorderWidth !== "0px" ||
        viewControlState.activeTabBackground !== viewControlState.toolbarBackground ||
        viewControlState.activeTabAccent !== "none" ||
        viewControlState.activeTabFontWeight !== "650" ||
        viewControlState.viewPanelZIndex !== "10" ||
        viewControlState.splitterZIndex !== "0" ||
        !viewControlState.staysOpenAfterInsideClick ||
        !viewControlState.closesAfterOutsideClick ||
        viewControlState.labelBackground !== "rgb(244, 244, 244)" ||
        viewControlState.pipelineBackground !== "rgb(255, 255, 255)") {
        throw new Error(`Renderer view controls are incomplete: ${JSON.stringify(viewControlState)}`);
    }

    // tab固有のRenderer状態として倍率も保持されるよう、別traceを開く前に変更する。
    await window.webContents.executeJavaScript(
        `document.querySelector('button[aria-label="Zoom in"]')?.click()`,
    );
    await waitForViewAnimation(window);

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
        gem5State.statusType !== "ready" ||
        gem5State.statusIcon ||
        gem5State.statusDots !== 6 ||
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
        const textThreshold = document.querySelector('input[aria-label="Text labels minimum lane height"]');
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

    // 比較Tabは元の2つを残し、同じ表示領域をA・overlay・Bで切り替える。
    const comparisonState = await window.webContents.executeJavaScript(`(async () => {
        const nextFrame = () => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
        let comparisonLayerCompositions = [];
        CanvasRenderingContext2D.prototype.drawImage = function(...args) {
            // tile内部のCanvas copyではなく、A/B layerから最終表示Canvasへの合成だけを数える。
            if (args[0] instanceof HTMLCanvasElement &&
                this.canvas instanceof HTMLCanvasElement &&
                this.canvas.classList.contains("comparison-result-canvas")) {
                comparisonLayerCompositions.push({
                    opacity: this.globalAlpha,
                    operation: this.globalCompositeOperation,
                    filter: this.filter
                });
            }
            return Reflect.apply(originalDrawImage, this, args);
        };
        const summary = document.querySelector('[aria-label="Compare traces"]');
        if (!(summary instanceof HTMLElement)) {
            throw new Error("The comparison control was not found.");
        }
        summary.click();
        await nextFrame();
        const candidate = document.querySelector('select[aria-label="Comparison candidate"]');
        const open = [...document.querySelectorAll('.comparison-controls-panel button')]
            .find((button) => button.textContent?.trim() === "Compare");
        if (!(candidate instanceof HTMLSelectElement) || !(open instanceof HTMLButtonElement)) {
            throw new Error("The comparison source controls were not found.");
        }
        const baselineLabel = document.querySelector('.comparison-source-a')?.textContent?.trim() ?? null;
        const selectedCandidate = candidate.selectedOptions[0]?.textContent?.trim() ?? null;
        open.click();
        await nextFrame();
        const comparisonTab = document.querySelector('.trace-tab.is-active');
        const modeButtons = [...document.querySelectorAll('.comparison-mode-controls button')];
        const baselineMode = modeButtons.find((button) => button.textContent?.trim() === "A");
        const overlayMode = modeButtons.find((button) => button.textContent?.trim() === "Overlay");
        const candidateMode = modeButtons.find((button) => button.textContent?.trim() === "B");
        const alignToA = document.querySelector('button[aria-label="Align Candidate to A"]');
        if (!(baselineMode instanceof HTMLButtonElement) ||
            !(overlayMode instanceof HTMLButtonElement) ||
            !(candidateMode instanceof HTMLButtonElement) ||
            !(alignToA instanceof HTMLButtonElement)) {
            throw new Error("The comparison modes were not found.");
        }
        const initial = {
            baselineLabel,
            selectedCandidate,
            tabCount: document.querySelectorAll('[role="tab"]').length,
            tabKind: comparisonTab?.getAttribute('data-tab-kind') ?? null,
            title: comparisonTab?.querySelector('[role="tab"]')?.textContent?.trim() ?? null,
            tabTooltip: comparisonTab?.querySelector('[role="tab"]')?.getAttribute('title') ?? null,
            canvasCount: document.querySelectorAll('.comparison-result-canvas').length,
            modeLabels: modeButtons
                .filter((button) => button.hasAttribute("aria-pressed"))
                .map((button) => button.textContent?.trim() ?? null),
            activeMode: document.querySelector('.comparison-mode-controls button.is-active')?.textContent?.trim() ?? null,
            opacity: document.querySelector('input[aria-label="Comparison opacity"]')?.value ?? null,
            alignLabel: alignToA.textContent?.trim() ?? null,
            alignTitle: alignToA.title,
            status: document.querySelector('.status-message')?.textContent ?? null,
            comparisonControlHeight: document.querySelector('.comparison-mode-controls')
                ?.getBoundingClientRect().height ?? -1,
            zoomControlHeight: document.querySelector('.zoom-controls')
                ?.getBoundingClientRect().height ?? -1,
            comparisonColor: (() => {
                const color = document.querySelector('select[aria-label="Pipeline color scheme"]');
                return color instanceof HTMLSelectElement
                    ? {value: color.value, disabled: color.disabled}
                    : null;
            })(),
            overlayLayerCompositions: comparisonLayerCompositions.slice(-2)
        };
        comparisonLayerCompositions = [];
        alignToA.click();
        await nextFrame();
        const labelCanvas = document.querySelector('canvas[aria-label="Instruction labels canvas"]');
        if (!(labelCanvas instanceof HTMLCanvasElement)) {
            throw new Error("The comparison label canvas was not found.");
        }
        const readLabelToolTip = async (modeButton) => {
            comparisonLayerCompositions = [];
            modeButton.click();
            await nextFrame();
            const modeStyle = getComputedStyle(modeButton);
            const rect = labelCanvas.getBoundingClientRect();
            labelCanvas.dispatchEvent(new MouseEvent("mousemove", {
                clientX: rect.left + 8,
                clientY: rect.top + 8,
                bubbles: true
            }));
            await nextFrame();
            const text = document.querySelector('[role="tooltip"]')?.textContent ?? null;
            labelCanvas.dispatchEvent(new MouseEvent("mouseleave", {bubbles: true}));
            await nextFrame();
            return {
                text,
                color: modeStyle.color,
                background: modeStyle.backgroundColor,
                layerCompositions: comparisonLayerCompositions.slice(-2)
            };
        };
        // A/B単独表示では、左側ラベルとtooltipも選択したtraceへ切り替わる。
        const baselineLabelToolTip = await readLabelToolTip(baselineMode);
        const candidateLabelToolTip = await readLabelToolTip(candidateMode);
        comparisonLayerCompositions = [];
        overlayMode.click();
        await nextFrame();
        const finalOverlayState = {
            activeMode: document.querySelector('.comparison-mode-controls button.is-active')?.textContent?.trim() ?? null,
            canvasMode: document.querySelector('.comparison-result-canvas')?.dataset.comparisonMode ?? null,
            layerCompositions: comparisonLayerCompositions.slice(-2),
            baselineLabelToolTip: baselineLabelToolTip.text,
            candidateLabelToolTip: candidateLabelToolTip.text,
            baselineModeColor: baselineLabelToolTip.color,
            baselineModeBackground: baselineLabelToolTip.background,
            candidateModeColor: candidateLabelToolTip.color,
            candidateModeBackground: candidateLabelToolTip.background,
            baselineLayerCompositions: baselineLabelToolTip.layerCompositions,
            candidateLayerCompositions: candidateLabelToolTip.layerCompositions
        };
        const theme = document.querySelector('select[aria-label="UI color theme"]');
        if (!(theme instanceof HTMLSelectElement)) {
            throw new Error("The comparison theme control was not found.");
        }
        theme.value = "light";
        theme.dispatchEvent(new Event("change", {bubbles: true}));
        await nextFrame();
        const lightAlignStyle = getComputedStyle(alignToA);
        const lightControlsStyle = getComputedStyle(alignToA.parentElement);
        const lightBaselineStyle = getComputedStyle(baselineMode);
        const lightCandidateStyle = getComputedStyle(candidateMode);
        const lightAlign = {
            color: lightAlignStyle.color,
            background: lightAlignStyle.backgroundColor,
            controlsBackground: lightControlsStyle.backgroundColor,
            baselineColor: lightBaselineStyle.color,
            baselineBackground: lightBaselineStyle.backgroundColor,
            candidateColor: lightCandidateStyle.color,
            candidateBackground: lightCandidateStyle.backgroundColor
        };
        theme.value = "dark";
        theme.dispatchEvent(new Event("change", {bubbles: true}));
        await nextFrame();
        document.querySelector('.trace-tab.is-active .trace-tab-close')?.click();
        await nextFrame();
        CanvasRenderingContext2D.prototype.drawImage = originalDrawImage;
        return {
            initial,
            finalOverlayState,
            lightAlign,
            remainingCount: document.querySelectorAll('[role="tab"]').length,
            remainingSelected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null
        };
    })()`);
    if (comparisonState.initial.baselineLabel !== "A (current): gem5-basic.txt" ||
        comparisonState.initial.selectedCandidate !== "kanata-basic.txt" ||
        comparisonState.initial.tabCount !== 3 ||
        comparisonState.initial.tabKind !== "comparison" ||
        comparisonState.initial.title !== "gem5-basic.txt ↔ kanata-basic.txt" ||
        comparisonState.initial.tabTooltip !== "A: gem5-basic.txt\nB: kanata-basic.txt" ||
        comparisonState.initial.canvasCount !== 1 ||
        JSON.stringify(comparisonState.initial.modeLabels) !== JSON.stringify(["A", "Overlay", "B"]) ||
        comparisonState.initial.activeMode !== "Overlay" ||
        comparisonState.initial.opacity !== "0.5" ||
        comparisonState.initial.alignLabel !== "Align to A" ||
        !comparisonState.initial.alignTitle.includes("Adjust A") ||
        !comparisonState.initial.alignTitle.includes("retired instruction") ||
        comparisonState.initial.status !== "A: gem5-basic.txt ↔ B: kanata-basic.txt" ||
        Math.abs(comparisonState.initial.comparisonControlHeight -
            comparisonState.initial.zoomControlHeight) > 0.1 ||
        JSON.stringify(comparisonState.initial.comparisonColor) !== JSON.stringify({
            value: "Comparison",
            disabled: true
        }) ||
        JSON.stringify(comparisonState.initial.overlayLayerCompositions) !== JSON.stringify([
            {opacity: 1, operation: "source-over", filter: "none"},
            {opacity: 0.5, operation: "source-over", filter: "none"}
        ]) ||
        comparisonState.finalOverlayState.activeMode !== "Overlay" ||
        comparisonState.finalOverlayState.canvasMode !== "overlay" ||
        !comparisonState.finalOverlayState.baselineLabelToolTip?.includes("add r1, r2") ||
        !comparisonState.finalOverlayState.candidateLabelToolTip?.includes("producer\nname") ||
        comparisonState.finalOverlayState.baselineModeColor !== "rgb(255, 255, 255)" ||
        comparisonState.finalOverlayState.baselineModeBackground !== "rgb(47, 102, 157)" ||
        comparisonState.finalOverlayState.candidateModeColor !== "rgb(255, 255, 255)" ||
        comparisonState.finalOverlayState.candidateModeBackground !== "rgb(145, 67, 74)" ||
        JSON.stringify(comparisonState.finalOverlayState.baselineLayerCompositions) !== JSON.stringify([
            {opacity: 1, operation: "source-over", filter: "none"},
            {opacity: 0.2, operation: "source-over", filter: "none"}
        ]) ||
        JSON.stringify(comparisonState.finalOverlayState.candidateLayerCompositions) !== JSON.stringify([
            {opacity: 1, operation: "source-over", filter: "none"},
            {opacity: 0.2, operation: "source-over", filter: "none"}
        ]) ||
        JSON.stringify(comparisonState.finalOverlayState.layerCompositions) !== JSON.stringify([
            {opacity: 1, operation: "source-over", filter: "none"},
            {opacity: 0.5, operation: "source-over", filter: "none"}
        ]) ||
        comparisonState.lightAlign.color !== "rgb(231, 235, 243)" ||
        comparisonState.lightAlign.background !== "rgba(0, 0, 0, 0)" ||
        comparisonState.lightAlign.controlsBackground !== "rgb(70, 80, 109)" ||
        comparisonState.lightAlign.baselineColor !== "rgb(145, 197, 248)" ||
        comparisonState.lightAlign.baselineBackground !== "rgba(45, 118, 196, 0.18)" ||
        comparisonState.lightAlign.candidateColor !== "rgb(243, 160, 154)" ||
        comparisonState.lightAlign.candidateBackground !== "rgba(190, 66, 70, 0.18)" ||
        comparisonState.remainingCount !== 2 ||
        comparisonState.remainingSelected !== "gem5-basic.txt") {
        throw new Error(`Comparison tabs are incomplete: ${JSON.stringify(comparisonState)}`);
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
            const textThreshold = document.querySelector('input[aria-label="Text labels minimum lane height"]');
            const switched = {
                closeHasIcon: closePlain.querySelector("svg") !== null,
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
                labelWidth: Math.round(document.querySelector('.label-pane')?.getBoundingClientRect().width ?? -1),
                toolbarBackground: getComputedStyle(toolbar).backgroundColor,
                toolbarShadow: getComputedStyle(toolbar).boxShadow,
                tabBarBackground: getComputedStyle(tabBar).backgroundColor,
                tabBarBorderWidth: getComputedStyle(tabBar).borderBottomWidth,
                activeTabBackground: getComputedStyle(document.querySelector('.trace-tab.is-active')).backgroundColor,
                activeTabAccent: getComputedStyle(document.querySelector('.trace-tab.is-active')).boxShadow,
                activeTabFontWeight: getComputedStyle(document.querySelector('.trace-tab.is-active .trace-tab-activate')).fontWeight,
                inactiveTabBackground: getComputedStyle(document.querySelector('.trace-tab:not(.is-active)')).backgroundColor,
                inactiveTabColor: getComputedStyle(document.querySelector('.trace-tab:not(.is-active) .trace-tab-activate')).color
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
                    remainingTextThreshold: document.querySelector('input[aria-label="Text labels minimum lane height"]')?.value ?? null,
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
        !tabState.switched.closeHasIcon ||
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
        tabState.switched.toolbarBackground !== "rgb(36, 42, 51)" ||
        tabState.switched.toolbarShadow !== "none" ||
        tabState.switched.tabBarBackground !== "rgb(23, 26, 32)" ||
        tabState.switched.tabBarBorderWidth !== "0px" ||
        tabState.switched.activeTabBackground !== tabState.switched.toolbarBackground ||
        tabState.switched.activeTabAccent !== "none" ||
        tabState.switched.activeTabFontWeight !== "650" ||
        tabState.switched.inactiveTabBackground !== tabState.switched.tabBarBackground ||
        tabState.switched.inactiveTabColor !== "rgb(157, 164, 177)" ||
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

    const tileReuseState = await window.webContents.executeJavaScript(`(async () => {
        const prototype = CanvasRenderingContext2D.prototype;
        const originalDrawImage = prototype.drawImage;
        const originalFillRect = prototype.fillRect;
        const pipeline = document.querySelector('.pipeline-pane canvas');
        const viewer = document.querySelector('.viewer');
        const reset = document.querySelector('button[aria-label="Reset view"]');
        if (!(pipeline instanceof HTMLCanvasElement) || !(viewer instanceof HTMLElement) ||
            !(reset instanceof HTMLButtonElement)) {
            throw new Error("The tiled pipeline controls were not found.");
        }
        reset.click();
        // 可視範囲に続いて外周1 tileが完成するまで待ち、そこから1 tile分だけscrollする。
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const tileBackingSize = Math.round(256 * devicePixelRatio);
        let tileBlits = 0;
        let previousFrameBlits = 0;
        let operationOrder = 0;
        let firstTileBlitOrder = null;
        let firstNewTileRenderOrder = null;
        let frameIndex = 0;
        let observeFrames = true;
        const renderedTilesByFrame = new Map();
        const observeFrame = () => {
            frameIndex++;
            if (observeFrames) requestAnimationFrame(observeFrame);
        };
        requestAnimationFrame(observeFrame);
        prototype.drawImage = function(...args) {
            const source = args[0];
            if (this.canvas === pipeline && source instanceof HTMLCanvasElement &&
                !source.isConnected) {
                if (source.width === tileBackingSize && source.height === tileBackingSize) {
                    tileBlits++;
                    firstTileBlitOrder ??= ++operationOrder;
                }
                if (source.width === pipeline.width && source.height === pipeline.height) {
                    previousFrameBlits++;
                }
            }
            return Reflect.apply(originalDrawImage, this, args);
        };
        prototype.fillRect = function(...args) {
            if (this.canvas instanceof HTMLCanvasElement && !this.canvas.isConnected &&
                this.canvas.width === tileBackingSize && this.canvas.height === tileBackingSize) {
                firstNewTileRenderOrder ??= ++operationOrder;
                const canvases = renderedTilesByFrame.get(frameIndex) ?? new Set();
                canvases.add(this.canvas);
                renderedTilesByFrame.set(frameIndex, canvases);
            }
            return Reflect.apply(originalFillRect, this, args);
        };
        try {
            // 横へ1 tile index進み、先読みringを使いつつ次の外周生成も発生させる。
            for (let index = 0; index < 2; index++) {
                viewer.dispatchEvent(new WheelEvent("wheel", {
                    deltaX: 100,
                    deltaY: 0,
                    bubbles: true,
                    cancelable: true,
                }));
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            observeFrames = false;
            return {
                tileBlits,
                previousFrameBlits,
                firstTileBlitOrder,
                firstNewTileRenderOrder,
                maxNewTilesPerFrame: Math.max(
                    0,
                    ...[...renderedTilesByFrame.values()].map((canvases) => canvases.size),
                ),
            };
        }
        finally {
            prototype.drawImage = originalDrawImage;
            prototype.fillRect = originalFillRect;
            reset.click();
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    })()`);
    if (tileReuseState.tileBlits < 1 || tileReuseState.previousFrameBlits < 1 ||
        tileReuseState.firstTileBlitOrder === null ||
        tileReuseState.firstNewTileRenderOrder === null ||
        tileReuseState.firstTileBlitOrder >= tileReuseState.firstNewTileRenderOrder ||
        tileReuseState.maxNewTilesPerFrame !== 2) {
        throw new Error(`Pipeline tiles were not reused while scrolling: ${JSON.stringify(tileReuseState)}`);
    }

    // stage名と経過cycle数は最初の描画だけoffscreenへ描き、次の描画ではBLTだけになる。
    const textAtlasState = await window.webContents.executeJavaScript(`(async () => {
        const prototype = CanvasRenderingContext2D.prototype;
        const originalFillText = prototype.fillText;
        const originalDrawImage = prototype.drawImage;
        const pipeline = document.querySelector('.pipeline-pane canvas');
        const theme = document.querySelector('select[aria-label="UI color theme"]');
        const colorScheme = document.querySelector('select[aria-label="Pipeline color scheme"]');
        const zoomSteps = document.querySelector('input[aria-label="Zoom steps per 2x"]');
        const textCache = document.querySelector('input[aria-label="Text caching"]');
        const webGL = document.querySelector('input[aria-label="WebGL rendering"]');
        const zoomOut = document.querySelector('button[aria-label="Zoom out"]');
        const reset = document.querySelector('button[aria-label="Reset view"]');
        if (!(pipeline instanceof HTMLCanvasElement) ||
            !(theme instanceof HTMLSelectElement) ||
            !(colorScheme instanceof HTMLSelectElement) ||
            !(zoomSteps instanceof HTMLInputElement) ||
            !(textCache instanceof HTMLInputElement) ||
            !(webGL instanceof HTMLInputElement) ||
            !(zoomOut instanceof HTMLButtonElement) ||
            !(reset instanceof HTMLButtonElement)) {
            throw new Error("The text atlas controls were not found.");
        }
        const originalTheme = theme.value;
        const originalColorScheme = colorScheme.value;
        const originalZoomSteps = zoomSteps.value;
        const originalTextCache = textCache.checked;
        const originalWebGL = webGL.checked;
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        inputSetter?.call(zoomSteps, "2");
        zoomSteps.dispatchEvent(new Event("input", {bubbles: true}));
        // Canvas fallbackでも従来のatlas BLTとcache無効時の直接描画を維持する。
        if (webGL.checked) {
            webGL.click();
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        let atlasFillTexts = 0;
        let pipelineFillTexts = 0;
        let invalidPipelineTextStyles = 0;
        let pipelineBlits = 0;
        let smoothedPipelineBlits = 0;
        let unsmoothedPipelineBlits = 0;
        const blitScales = [];
        prototype.fillText = function(...args) {
            if (this.canvas === pipeline) {
                pipelineFillTexts++;
                if (this.fillStyle !== "#444444" || this.textBaseline !== "alphabetic" ||
                    !this.font.includes("px")) {
                    invalidPipelineTextStyles++;
                }
            }
            else if (this.canvas instanceof HTMLCanvasElement && !this.canvas.isConnected) {
                atlasFillTexts++;
            }
            return Reflect.apply(originalFillText, this, args);
        };
        prototype.drawImage = function(...args) {
            if (this.canvas === pipeline && args[0] instanceof HTMLCanvasElement &&
                !args[0].isConnected) {
                pipelineBlits++;
                if (this.imageSmoothingEnabled) {
                    smoothedPipelineBlits++;
                }
                else {
                    unsmoothedPipelineBlits++;
                }
                if (args.length === 9) {
                    blitScales.push(args[7] * devicePixelRatio / args[3]);
                }
                else if (args.length === 5) {
                    // タイル化後のzoom中は、直前の完成viewportを5引数drawImageで暫定拡縮する。
                    blitScales.push(args[3] * devicePixelRatio / args[0].width);
                }
            }
            return Reflect.apply(originalDrawImage, this, args);
        };
        const nextFrame = () => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)));
        try {
            theme.value = "light";
            theme.dispatchEvent(new Event("change", {bubbles: true}));
            await nextFrame();
            const first = {
                atlasFillTexts,
                pipelineFillTexts,
                invalidPipelineTextStyles,
                pipelineBlits,
                smoothedPipelineBlits,
                unsmoothedPipelineBlits,
            };

            // 半stepの縮小animationでも100%用atlasを共有し、表示時だけ縮小する。
            zoomOut.click();
            await new Promise((resolve) => setTimeout(resolve, 250));
            await nextFrame();
            const scaled = {
                atlasFillTexts,
                pipelineFillTexts,
                pipelineBlits,
                smoothedPipelineBlits,
                unsmoothedPipelineBlits,
                minimumBlitScale: Math.min(...blitScales),
                zoom: document.querySelector('.zoom-controls output')?.textContent ?? null,
            };

            // stageの配色だけを変えた再描画でも、同じatlasを維持する。
            colorScheme.value = "Unique";
            colorScheme.dispatchEvent(new Event("change", {bubbles: true}));
            await nextFrame();
            const recolored = {atlasFillTexts, pipelineFillTexts, pipelineBlits};

            // cacheを無効にするとatlasを破棄し、pipeline Canvasへ直接fillTextする。
            textCache.click();
            await nextFrame();
            const disabled = {
                enabled: textCache.checked,
                atlasFillTexts,
                pipelineFillTexts,
                invalidPipelineTextStyles,
                pipelineBlits,
            };
            textCache.click();
            await nextFrame();
            return {
                first,
                scaled,
                recolored,
                disabled,
                reenabled: {
                    enabled: textCache.checked,
                    atlasFillTexts,
                    pipelineFillTexts,
                    pipelineBlits,
                },
            };
        }
        finally {
            prototype.fillText = originalFillText;
            prototype.drawImage = originalDrawImage;
            theme.value = originalTheme;
            theme.dispatchEvent(new Event("change", {bubbles: true}));
            colorScheme.value = originalColorScheme;
            colorScheme.dispatchEvent(new Event("change", {bubbles: true}));
            if (textCache.checked !== originalTextCache) {
                textCache.click();
            }
            if (webGL.checked !== originalWebGL) {
                webGL.click();
            }
            inputSetter?.call(zoomSteps, originalZoomSteps);
            zoomSteps.dispatchEvent(new Event("input", {bubbles: true}));
            reset.click();
            await new Promise((resolve) => setTimeout(resolve, 250));
            await nextFrame();
        }
    })()`);
    if (textAtlasState.first.atlasFillTexts < 1 ||
        textAtlasState.first.pipelineFillTexts !== 0 ||
        textAtlasState.first.pipelineBlits <= textAtlasState.first.atlasFillTexts ||
        textAtlasState.first.smoothedPipelineBlits !== 0 ||
        textAtlasState.first.unsmoothedPipelineBlits !== textAtlasState.first.pipelineBlits ||
        textAtlasState.scaled.atlasFillTexts < textAtlasState.first.atlasFillTexts ||
        textAtlasState.scaled.pipelineFillTexts !== 0 ||
        textAtlasState.scaled.pipelineBlits <= textAtlasState.first.pipelineBlits ||
        textAtlasState.scaled.smoothedPipelineBlits <= textAtlasState.first.smoothedPipelineBlits ||
        // zoom animation中は直前frameのtile画像を少しずつ拡縮し、停止後に正確なtileへ替える。
        textAtlasState.scaled.minimumBlitScale < 0.8 ||
        textAtlasState.scaled.minimumBlitScale >= 1 ||
        textAtlasState.scaled.zoom !== "70.7%" ||
        textAtlasState.recolored.atlasFillTexts !== textAtlasState.scaled.atlasFillTexts ||
        textAtlasState.recolored.pipelineFillTexts !== 0 ||
        textAtlasState.recolored.pipelineBlits <= textAtlasState.scaled.pipelineBlits ||
        textAtlasState.disabled.enabled ||
        textAtlasState.disabled.pipelineFillTexts <= textAtlasState.recolored.pipelineFillTexts ||
        textAtlasState.disabled.invalidPipelineTextStyles !== 0 ||
        textAtlasState.disabled.pipelineBlits < textAtlasState.recolored.pipelineBlits ||
        !textAtlasState.reenabled.enabled ||
        textAtlasState.reenabled.atlasFillTexts <= textAtlasState.disabled.atlasFillTexts ||
        textAtlasState.reenabled.pipelineFillTexts !== textAtlasState.disabled.pipelineFillTexts ||
        textAtlasState.reenabled.pipelineBlits <= textAtlasState.disabled.pipelineBlits) {
        throw new Error(`Stage text atlas reuse is incomplete: ${JSON.stringify(textAtlasState)}`);
    }

    // 可視範囲へ十分な依存を置き、曲線矢印も矩形と同じWebGL batchへ入ることを確認する。
    const arrowFixtureLines = ["Kanata\t0004", "C=\t0"];
    for (let id = 0; id < 80; id++) {
        arrowFixtureLines.push(
            `I\t${id}\t${1000 + id}\t${id}`,
            `L\t${id}\t0\top ${id}`,
            `S\t${id}\t0\tF`,
            "C\t1",
            `S\t${id}\t0\tX`,
        );
        for (let distance = 1; distance <= 2 && distance <= id; distance++) {
            arrowFixtureLines.push(`W\t${id}\t${id - distance}\t0`);
        }
        arrowFixtureLines.push(
            "C\t1",
            `E\t${id}\t0\tX`,
            `R\t${id}\t${id}\t0`,
        );
    }
    await dropContents(
        window,
        Buffer.from(arrowFixtureLines.join("\n") + "\n"),
        "webgl-arrows.log",
        "text/plain",
    );

    // 70.7%でstage gradient、枠、atlas文字、依存矢印をWebGL2へ一括描画する。
    const webGLState = await window.webContents.executeJavaScript(`(async () => {
        const glPrototype = globalThis.WebGL2RenderingContext?.prototype;
        const canvasPrototype = HTMLCanvasElement.prototype;
        const theme = document.querySelector('select[aria-label="UI color theme"]');
        const colorScheme = document.querySelector('select[aria-label="Pipeline color scheme"]');
        const dependencyType = document.querySelector('select[aria-label="Dependency arrow type"]');
        const webGLToggle = document.querySelector('input[aria-label="WebGL rendering"]');
        const zoomSteps = document.querySelector('input[aria-label="Zoom steps per 2x"]');
        const zoomOut = document.querySelector('button[aria-label="Zoom out"]');
        const reset = document.querySelector('button[aria-label="Reset view"]');
        const pipeline = document.querySelector('.pipeline-pane canvas');
        if (glPrototype === undefined || !(theme instanceof HTMLSelectElement) ||
            !(colorScheme instanceof HTMLSelectElement) ||
            !(dependencyType instanceof HTMLSelectElement) ||
            !(webGLToggle instanceof HTMLInputElement) ||
            !(zoomSteps instanceof HTMLInputElement) ||
            !(zoomOut instanceof HTMLButtonElement) ||
            !(reset instanceof HTMLButtonElement) || !(pipeline instanceof HTMLCanvasElement)) {
            throw new Error("The WebGL2 simplified rendering controls were not found.");
        }
        const originalDraw = glPrototype.drawArraysInstanced;
        const originalBufferData = glPrototype.bufferData;
        const originalTexImage2D = glPrototype.texImage2D;
        const originalGetContext = canvasPrototype.getContext;
        const contextPrototype = CanvasRenderingContext2D.prototype;
        const originalBezierCurveTo = contextPrototype.bezierCurveTo;
        const originalTheme = theme.value;
        const originalColorScheme = colorScheme.value;
        const originalDependencyType = dependencyType.value;
        const originalWebGLEnabled = webGLToggle.checked;
        const originalZoomSteps = zoomSteps.value;
        let drawCalls = 0;
        let instances = 0;
        let maximumInstances = 0;
        let gradientInstances = 0;
        let strokeInstances = 0;
        let textInstances = 0;
        let interleavedText = false;
        let atlasUploads = 0;
        let webGLRequests = 0;
        let webGLContexts = 0;
        let arrowDrawCalls = 0;
        let arrowInstances = 0;
        let canvasBezierCurveCalls = 0;
        let acceleratedContext = null;
        canvasPrototype.getContext = function(type, ...args) {
            if (type === "webgl2") {
                webGLRequests++;
            }
            const context = Reflect.apply(originalGetContext, this, [type, ...args]);
            if (type === "webgl2" && context !== null) {
                webGLContexts++;
                acceleratedContext = context;
            }
            return context;
        };
        glPrototype.drawArraysInstanced = function(...args) {
            acceleratedContext = this;
            drawCalls++;
            instances += args[3];
            maximumInstances = Math.max(maximumInstances, args[3]);
            if (args[0] === this.TRIANGLE_STRIP && args[2] === 72) {
                arrowDrawCalls++;
                arrowInstances += args[3];
            }
            return Reflect.apply(originalDraw, this, args);
        };
        contextPrototype.bezierCurveTo = function(...args) {
            canvasBezierCurveCalls++;
            return Reflect.apply(originalBezierCurveTo, this, args);
        };
        glPrototype.bufferData = function(...args) {
            const data = args[1];
            if (data instanceof Uint8Array && data.byteLength % 8 === 0) {
                for (let offset = 0; offset < data.byteLength; offset += 8) {
                    if (data[offset] !== data[offset + 4] ||
                        data[offset + 1] !== data[offset + 5] ||
                        data[offset + 2] !== data[offset + 6] ||
                        data[offset + 3] !== data[offset + 7]) {
                        gradientInstances++;
                    }
                }
            }
            if (data instanceof Float32Array && data.length >= 64 &&
                data.every((value) => value === -1 || value === 0 || value === 1)) {
                strokeInstances += data.reduce(
                    (count, value) => count + (value > 0 ? 1 : 0),
                    0,
                );
                textInstances += data.reduce(
                    (count, value) => count + (value < 0 ? 1 : 0),
                    0,
                );
                const firstText = data.findIndex((value) => value < 0);
                interleavedText ||= firstText >= 0 &&
                    data.subarray(firstText + 1).some((value) => value >= 0);
            }
            return Reflect.apply(originalBufferData, this, args);
        };
        glPrototype.texImage2D = function(...args) {
            const source = args.at(-1);
            if (source instanceof HTMLCanvasElement && source.width === 1024 && source.height === 512) {
                atlasUploads++;
            }
            return Reflect.apply(originalTexImage2D, this, args);
        };
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        inputSetter?.call(zoomSteps, "2");
        zoomSteps.dispatchEvent(new Event("input", {bubbles: true}));
        theme.value = "light";
        theme.dispatchEvent(new Event("change", {bubbles: true}));
        colorScheme.value = "Auto";
        colorScheme.dispatchEvent(new Event("change", {bubbles: true}));
        dependencyType.value = "leftSideCurve";
        dependencyType.dispatchEvent(new Event("change", {bubbles: true}));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        for (let index = 0; index < 1; index++) {
            zoomOut.click();
        }
        // 画素比較はtarget倍率の可視tileが一括公開された完成画像に対して行う。
        await new Promise((resolve) => setTimeout(resolve, 700));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const countOpaquePixels = (pixels) => {
            let count = 0;
            if (pixels === undefined) {
                return count;
            }
            for (let index = 3; index < pixels.length; index += 4) {
                if (pixels[index] !== 0) {
                    count++;
                }
            }
            return count;
        };
        const countColorfulPixels = (pixels) => {
            let count = 0;
            if (pixels === undefined) {
                return count;
            }
            for (let index = 0; index < pixels.length; index += 4) {
                const red = pixels[index];
                const green = pixels[index + 1];
                const blue = pixels[index + 2];
                if (pixels[index + 3] !== 0 &&
                    Math.max(red, green, blue) - Math.min(red, green, blue) >= 16) {
                    count++;
                }
            }
            return count;
        };
        const context = pipeline.getContext("2d");
        const pixels = context?.getImageData(0, 0, pipeline.width, pipeline.height).data;
        const opaquePixels = countOpaquePixels(pixels);
        const colorfulPixels = countColorfulPixels(pixels);
        const zoom = document.querySelector('.zoom-controls output')?.textContent ?? null;
        const enabledBezierCurveCalls = canvasBezierCurveCalls;

        // View設定で無効にした直後は、同じ矩形列をWebGL drawなしでCanvasへ再生する。
        const drawCallsBeforeDisabled = drawCalls;
        const webGLRequestsBeforeDisabled = webGLRequests;
        const bezierCurveCallsBeforeDisabled = canvasBezierCurveCalls;
        webGLToggle.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const disabledDrawCalls = drawCalls - drawCallsBeforeDisabled;
        const disabledWebGLRequests = webGLRequests - webGLRequestsBeforeDisabled;
        const disabledBezierCurveCalls = canvasBezierCurveCalls - bezierCurveCallsBeforeDisabled;
        const disabledPixels = context?.getImageData(0, 0, pipeline.width, pipeline.height).data;
        const disabledOpaquePixels = countOpaquePixels(disabledPixels);
        const disabledColorfulPixels = countColorfulPixels(disabledPixels);
        const drawCallsBeforeReenabled = drawCalls;
        webGLToggle.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const reenabledDrawCalls = drawCalls - drawCallsBeforeReenabled;

        // context loss後も同じ操作を繰り返し、Canvas 2D fallbackだけで表示できることを確かめる。
        const loseContext = acceleratedContext?.getExtension("WEBGL_lose_context");
        if (acceleratedContext === null || loseContext === null || loseContext === undefined) {
            throw new Error("The WebGL context-loss extension was not available: " + JSON.stringify({
                hasContext: acceleratedContext !== null,
                contextLost: acceleratedContext?.isContextLost() ?? null,
                drawCalls,
                webGLRequests,
                webGLContexts,
                textInstances,
                atlasUploads,
            }));
        }
        const contextLost = new Promise((resolve) => {
            acceleratedContext.canvas.addEventListener("webglcontextlost", resolve, {once: true});
        });
        loseContext.loseContext();
        await contextLost;
        const drawCallsBeforeFallback = drawCalls;
        const bezierCurveCallsBeforeFallback = canvasBezierCurveCalls;
        reset.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        for (let index = 0; index < 1; index++) {
            zoomOut.click();
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const fallbackPixels = context?.getImageData(0, 0, pipeline.width, pipeline.height).data;
        const fallbackOpaquePixels = countOpaquePixels(fallbackPixels);
        const fallbackColorfulPixels = countColorfulPixels(fallbackPixels);
        let differingPixels = 0;
        let noticeablyDifferingPixels = 0;
        let maximumPixelDifference = 0;
        if (pixels !== undefined && fallbackPixels !== undefined && pixels.length === fallbackPixels.length) {
            for (let index = 0; index < pixels.length; index += 4) {
                let pixelDiffers = false;
                let pixelDifference = 0;
                for (let component = 0; component < 4; component++) {
                    const difference = Math.abs(pixels[index + component] - fallbackPixels[index + component]);
                    if (difference !== 0) {
                        pixelDiffers = true;
                        pixelDifference = Math.max(pixelDifference, difference);
                        maximumPixelDifference = Math.max(maximumPixelDifference, difference);
                    }
                }
                if (pixelDiffers) {
                    differingPixels++;
                }
                if (pixelDifference > 8) {
                    noticeablyDifferingPixels++;
                }
            }
        }
        else {
            differingPixels = Number.POSITIVE_INFINITY;
            noticeablyDifferingPixels = Number.POSITIVE_INFINITY;
            maximumPixelDifference = Number.POSITIVE_INFINITY;
        }
        const fallbackDrawCalls = drawCalls - drawCallsBeforeFallback;
        const fallbackBezierCurveCalls = canvasBezierCurveCalls - bezierCurveCallsBeforeFallback;
        loseContext.restoreContext();
        glPrototype.drawArraysInstanced = originalDraw;
        glPrototype.bufferData = originalBufferData;
        glPrototype.texImage2D = originalTexImage2D;
        canvasPrototype.getContext = originalGetContext;
        contextPrototype.bezierCurveTo = originalBezierCurveTo;
        theme.value = originalTheme;
        theme.dispatchEvent(new Event("change", {bubbles: true}));
        colorScheme.value = originalColorScheme;
        colorScheme.dispatchEvent(new Event("change", {bubbles: true}));
        dependencyType.value = originalDependencyType;
        dependencyType.dispatchEvent(new Event("change", {bubbles: true}));
        if (webGLToggle.checked !== originalWebGLEnabled) {
            webGLToggle.click();
        }
        inputSetter?.call(zoomSteps, originalZoomSteps);
        zoomSteps.dispatchEvent(new Event("input", {bubbles: true}));
        reset.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {drawCalls, instances, maximumInstances, gradientInstances, strokeInstances,
            textInstances, interleavedText, atlasUploads, arrowDrawCalls, arrowInstances,
            enabledBezierCurveCalls, disabledBezierCurveCalls, fallbackBezierCurveCalls,
            opaquePixels, colorfulPixels,
            disabledOpaquePixels, disabledColorfulPixels, disabledDrawCalls,
            disabledWebGLRequests, reenabledDrawCalls,
            fallbackOpaquePixels, fallbackColorfulPixels, fallbackDrawCalls,
            differingPixels, noticeablyDifferingPixels, maximumPixelDifference, zoom,
            webGLRequests, webGLContexts};
    })()`);
    if (webGLState.drawCalls < 1 ||
        webGLState.instances < 64 ||
        webGLState.gradientInstances < 1 ||
        webGLState.strokeInstances < 1 ||
        webGLState.textInstances < 1 ||
        !webGLState.interleavedText ||
        webGLState.atlasUploads < 1 ||
        webGLState.arrowDrawCalls < 1 ||
        webGLState.arrowInstances < 1 ||
        // 小さいdependency-only batchはCanvasへ残してよいが、GL有効時はfallbackより少なくする。
        webGLState.enabledBezierCurveCalls >= webGLState.fallbackBezierCurveCalls ||
        webGLState.disabledBezierCurveCalls < 1 ||
        webGLState.fallbackBezierCurveCalls < 1 ||
        webGLState.opaquePixels < 100 ||
        webGLState.colorfulPixels < 100 ||
        webGLState.disabledOpaquePixels < 100 ||
        webGLState.disabledColorfulPixels < 100 ||
        webGLState.disabledDrawCalls !== 0 ||
        webGLState.disabledWebGLRequests !== 0 ||
        webGLState.reenabledDrawCalls < 1 ||
        webGLState.fallbackOpaquePixels < 100 ||
        webGLState.fallbackColorfulPixels < 100 ||
        webGLState.fallbackDrawCalls !== 0 ||
        // atlas文字と矢印edgeのcoverageはnative Canvasと完全には一致しないため、
        // 差のある面積と最大差の両方に上限を置いて大きな形状崩れだけを検出する。
        webGLState.noticeablyDifferingPixels > webGLState.opaquePixels * 0.01 ||
        webGLState.maximumPixelDifference > 192 ||
        webGLState.zoom !== "70.7%") {
        throw new Error(`WebGL2 simplified rendering is incomplete: ${JSON.stringify(webGLState)}`);
    }
    await window.webContents.executeJavaScript(`(() => {
        const close = document.querySelector('button[aria-label="Close webgl-arrows.log"]');
        if (!(close instanceof HTMLButtonElement)) {
            throw new Error("The synthetic WebGL arrow tab was not found.");
        }
        close.click();
    })()`);

    const {Zstd} = await import("@hpcc-js/wasm-zstd");
    const zstdSource = fs.readFileSync(gem5Fixture);
    const zstdSourceBytes = new Uint8Array(
        zstdSource.buffer,
        zstdSource.byteOffset,
        zstdSource.byteLength,
    );
    // 圧縮fixtureを増やさず、2つのWorkerによる並行展開とgem5 fallbackをbrowser上で通す。
    const zstdContents = Buffer.from((await Zstd.load()).compress(zstdSourceBytes));
    const concurrentZstdState = await dropConcurrentZstdContents(window, zstdContents);
    const zstdState = await readRenderedState(window);
    // gem5 fallbackはKanata判定後にFile.stream()を開き直すため、2 filesで合計4回開始する。
    if (concurrentZstdState.startedStreams < 2 ||
        zstdState.loadState !== "ready" ||
        !concurrentZstdState.names.includes(zstdState.fileName) ||
        zstdState.opCount !== 1 ||
        zstdState.laneCount !== 1 ||
        zstdState.nonBackgroundPixels < 100) {
        throw new Error(`Zstandard trace rendering is incomplete: ${JSON.stringify({
            concurrentZstdState,
            zstdState,
        })}`);
    }
    // 後続の色設定検査はgzip sampleのstage一覧を使うため、確認済みのzstd Tabを閉じて戻す。
    await window.webContents.executeJavaScript(`new Promise((resolve) => {
        document.querySelector('button[aria-label="Close gem5-a.txt.zst"]')?.click();
        document.querySelector('button[aria-label="Close gem5-b.txt.zstd"]')?.click();
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`);

    // Custom編集画面でdrag、stage追加・削除、traceからのreset、即時再描画、保存まで確認する。
    const customColorState = await window.webContents.executeJavaScript(`(async () => {
        const nextFrame = () => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const color = document.querySelector('select[aria-label="Pipeline color scheme"]');
        if (!(color instanceof HTMLSelectElement)) {
            throw new Error("The pipeline color selector was not found.");
        }
        color.value = "Custom";
        color.dispatchEvent(new Event("change", {bubbles: true}));
        await nextFrame();
        const edit = [...document.querySelectorAll(".custom-color-control button")]
            .find((button) => button.textContent?.trim() === "Edit…");
        if (!(edit instanceof HTMLButtonElement)) {
            throw new Error("The custom color edit button was not found.");
        }
        edit.click();
        await nextFrame();

        const dialog = document.querySelector(".custom-color-dialog");
        const pipeline = document.querySelector(".pipeline-pane canvas");
        if (!(dialog instanceof HTMLElement) || !(pipeline instanceof HTMLCanvasElement)) {
            throw new Error("The custom color dialog was not found.");
        }
        const header = dialog.querySelector("header");
        if (!(header instanceof HTMLElement)) {
            throw new Error("The custom color dialog header was not found.");
        }
        // synthetic pointerにも製品コードと同じcapture寿命を与え、header dragを実座標で確認する。
        const captured = new Set();
        Object.defineProperties(header, {
            setPointerCapture: {configurable: true, value: (id) => captured.add(id)},
            hasPointerCapture: {configurable: true, value: (id) => captured.has(id)},
            releasePointerCapture: {configurable: true, value: (id) => captured.delete(id)}
        });
        const initialRect = dialog.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        const dispatchPointer = (type, x, y, buttons) => header.dispatchEvent(new PointerEvent(type, {
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: type === "pointerdown" ? 0 : -1,
            buttons,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true
        }));
        const dragX = headerRect.left + 80;
        const dragY = headerRect.top + headerRect.height / 2;
        dispatchPointer("pointerdown", dragX, dragY, 1);
        dispatchPointer("pointermove", dragX + 140, dragY + 70, 1);
        dispatchPointer("pointerup", dragX + 140, dragY + 70, 0);
        await nextFrame();
        const draggedRect = dialog.getBoundingClientRect();
        delete header.setPointerCapture;
        delete header.hasPointerCapture;
        delete header.releasePointerCapture;

        const initialRows = dialog.querySelectorAll("tbody tr").length;
        const addSelect = dialog.querySelector('select[aria-label="Stage to add"]');
        const addButton = [...dialog.querySelectorAll("button")]
            .find((button) => button.textContent?.trim() === "Add Stage");
        if (!(addSelect instanceof HTMLSelectElement) || !(addButton instanceof HTMLButtonElement)) {
            throw new Error("The custom color stage controls were not found.");
        }
        const missingBefore = addSelect.options.length;
        const addedLabel = addSelect.selectedOptions[0]?.textContent?.trim() ?? null;
        addButton.click();
        await nextFrame();
        const rowsAfterAdd = dialog.querySelectorAll("tbody tr").length;
        const missingAfterAdd = dialog.querySelector('select[aria-label="Stage to add"]')?.options.length ?? -1;
        const removeAdded = [...dialog.querySelectorAll('button[aria-label^="Remove Lane"]')]
            .find((button) => button.getAttribute("aria-label") === "Remove " + addedLabel);
        if (!(removeAdded instanceof HTMLButtonElement)) {
            throw new Error("The added custom color stage could not be removed.");
        }
        removeAdded.click();
        await nextFrame();
        const rowsAfterRemove = dialog.querySelectorAll("tbody tr").length;
        const missingAfterRemove = dialog.querySelector('select[aria-label="Stage to add"]')?.options.length ?? -1;

        const reset = [...dialog.querySelectorAll("footer button")]
            .find((button) => button.textContent?.trim() === "Reset from Trace");
        if (!(reset instanceof HTMLButtonElement)) {
            throw new Error("The custom color trace reset button was not found.");
        }
        reset.click();
        await nextFrame();
        const resetRows = dialog.querySelectorAll("tbody tr").length;
        const resetAddDisabled = dialog.querySelector('.custom-color-add button')?.disabled ?? null;
        const resetHue = document.querySelector('input[aria-label="Lane 0 / F hue"]')?.value ?? null;
        const resetAutomatic = document.querySelector(
            'input[aria-label="Use automatic Lane 0 / F saturation"]',
        )?.checked ?? null;

        const signature = () => {
            const pixels = pipeline.getContext("2d")?.getImageData(0, 0, pipeline.width, pipeline.height).data;
            if (pixels === undefined) {
                return null;
            }
            let value = 0;
            for (let index = 0; index < pixels.length; index += 16) {
                value = (value * 31 + pixels[index] + pixels[index + 1] * 3 + pixels[index + 2] * 7) >>> 0;
            }
            return value;
        };
        const beforeSignature = signature();
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        const setHue = async (value) => {
            const hue = document.querySelector('input[aria-label="Lane 0 / F hue"]');
            if (!(hue instanceof HTMLInputElement)) {
                throw new Error("The F stage hue input was not found.");
            }
            inputSetter?.call(hue, String(value));
            hue.dispatchEvent(new Event("input", {bubbles: true}));
            await nextFrame();
        };
        const setSaturation = async (value) => {
            const automatic = document.querySelector('input[aria-label="Use automatic Lane 0 / F saturation"]');
            if (!(automatic instanceof HTMLInputElement)) {
                throw new Error("The F stage automatic saturation control was not found.");
            }
            if (automatic.checked) {
                automatic.click();
                await nextFrame();
            }
            const saturation = document.querySelector('input[aria-label="Lane 0 / F saturation"]');
            if (!(saturation instanceof HTMLInputElement)) {
                throw new Error("The F stage saturation input was not found.");
            }
            inputSetter?.call(saturation, String(value));
            saturation.dispatchEvent(new Event("input", {bubbles: true}));
            await nextFrame();
        };

        await setHue(210);
        await setSaturation(25);
        const editedSignature = signature();
        const stored = JSON.parse(localStorage.getItem("konata.viewSettings") ?? "null");
        const storedStageCount = Object.entries(stored?.customColorScheme ?? {})
            .filter(([laneName]) => laneName !== "defaultColor")
            .reduce((count, [, stages]) => count + Object.keys(stages).length, 0);
        const preview = document.querySelector('[aria-label="Lane 0 / F color preview"]');
        const result = {
            title: dialog.querySelector("h2")?.textContent ?? null,
            closeIcon: dialog.querySelector('button[aria-label="Close custom colors"] svg') !== null,
            addIcon: addButton.querySelector("svg") !== null,
            removeIcon: removeAdded.querySelector("svg") !== null,
            resetIcon: reset.querySelector("svg") !== null,
            initialRows,
            missingBefore,
            rowsAfterAdd,
            missingAfterAdd,
            rowsAfterRemove,
            missingAfterRemove,
            resetRows,
            resetAddDisabled,
            storedStageCount,
            dragX: Math.round(draggedRect.left - initialRect.left),
            dragY: Math.round(draggedRect.top - initialRect.top),
            dragCaptures: captured.size,
            beforeSignature,
            editedSignature,
            resetHue,
            resetAutomatic,
            storedColor: stored?.customColorScheme?.["0"]?.F ?? null,
            previewColor: preview instanceof HTMLElement ? getComputedStyle(preview).backgroundColor : null
        };
        const close = [...dialog.querySelectorAll("footer button")]
            .find((button) => button.textContent?.trim() === "Close");
        close?.click();
        await nextFrame();
        color.value = "RoyalBlue";
        color.dispatchEvent(new Event("change", {bubbles: true}));
        await nextFrame();
        return {
            ...result,
            closed: document.querySelector(".custom-color-dialog") === null,
            editHidden: document.querySelector(".custom-color-control button") === null
        };
    })()`);
    if (customColorState.title !== "Custom Colors" ||
        !customColorState.closeIcon ||
        !customColorState.addIcon ||
        !customColorState.removeIcon ||
        !customColorState.resetIcon ||
        customColorState.initialRows !== 8 ||
        customColorState.missingBefore <= 0 ||
        customColorState.rowsAfterAdd !== customColorState.initialRows + 1 ||
        customColorState.missingAfterAdd !== customColorState.missingBefore - 1 ||
        customColorState.rowsAfterRemove !== customColorState.initialRows ||
        customColorState.missingAfterRemove !== customColorState.missingBefore ||
        customColorState.resetRows <= customColorState.initialRows ||
        !customColorState.resetAddDisabled ||
        customColorState.storedStageCount !== customColorState.resetRows - 1 ||
        customColorState.dragX < 100 ||
        customColorState.dragY < 50 ||
        customColorState.dragCaptures !== 0 ||
        customColorState.beforeSignature === customColorState.editedSignature ||
        customColorState.resetHue !== "0" ||
        !customColorState.resetAutomatic ||
        customColorState.storedColor?.h !== 210 ||
        customColorState.storedColor?.s !== 25 ||
        customColorState.storedColor?.l !== "auto" ||
        typeof customColorState.previewColor !== "string" ||
        customColorState.previewColor === "" ||
        !customColorState.closed ||
        !customColorState.editHidden) {
        throw new Error(`Custom color editor is incomplete: ${JSON.stringify(customColorState)}`);
    }

    // toolbar操作は即時に飛ばず、旧Rendererの1段階zoom（100%→200%）へ補間する。
    const zoomAnimationStart = await window.webContents.executeJavaScript(`(() => {
        const output = document.querySelector(".zoom-controls output");
        const before = output?.textContent ?? null;
        document.querySelector('button[aria-label="Zoom in"]')?.click();
        return {before, immediatelyAfter: output?.textContent ?? null};
    })()`);
    if (zoomAnimationStart.before !== "100%" || zoomAnimationStart.immediatelyAfter !== "100%") {
        throw new Error(`Zoom animation started incorrectly: ${JSON.stringify(zoomAnimationStart)}`);
    }
    const zoomAnimationMiddle = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
            resolve(document.querySelector(".zoom-controls output")?.textContent ?? null);
        })));
    })`);
    if (zoomAnimationMiddle === "100%" || zoomAnimationMiddle === "200%") {
        throw new Error(`Zoom animation has no visible middle frame: ${JSON.stringify(zoomAnimationMiddle)}`);
    }
    await waitForViewAnimation(window);
    const zoomedState = await readRenderedState(window);
    if (zoomedState.zoom !== "200%" || zoomedState.nonBackgroundPixels < 100) {
        throw new Error(`Zoom rendering is incomplete: ${JSON.stringify(zoomedState)}`);
    }

    // 非既定のthemeとWebGL設定を保存し、Tab表示だけのlane分割は保存値へ混ぜない。
    const viewSettingsSetupState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const theme = document.querySelector('select[aria-label="UI color theme"]');
        const split = document.querySelector('input[aria-label="Split lanes"]');
        const zoomSteps = document.querySelector('input[aria-label="Zoom steps per 2x"]');
        const webGL = document.querySelector('input[aria-label="WebGL rendering"]');
        const textCache = document.querySelector('input[aria-label="Text caching"]');
        const compatibility = document.querySelector(".compatibility-settings");
        if (!(theme instanceof HTMLSelectElement) ||
            !(split instanceof HTMLInputElement) ||
            !(zoomSteps instanceof HTMLInputElement) ||
            !(webGL instanceof HTMLInputElement) ||
            !(textCache instanceof HTMLInputElement) ||
            !(compatibility instanceof HTMLDetailsElement)) {
            throw new Error("The view settings controls were not found.");
        }
        theme.value = "light";
        theme.dispatchEvent(new Event("change", {bubbles: true}));
        split.click();
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        inputSetter?.call(zoomSteps, "2");
        zoomSteps.dispatchEvent(new Event("input", {bubbles: true}));
        webGL.click();
        textCache.click();
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const stored = JSON.parse(localStorage.getItem("konata.viewSettings") ?? "null");
            resolve({
                theme: document.querySelector(".trace-app")?.dataset.theme ?? null,
                split: split.checked,
                zoomSteps: zoomSteps.value,
                webGL: webGL.checked,
                textCache: textCache.checked,
                thresholdsAfterZoomSteps: zoomSteps.closest("label")?.nextElementSibling
                    ?.classList.contains("drawing-thresholds") === true,
                compatibilityAfterThresholds: compatibility.previousElementSibling
                    ?.classList.contains("drawing-thresholds") === true,
                compatibilityLast: compatibility === compatibility.parentElement?.lastElementChild,
                stored,
                storesSplitLanes: stored !== null && "splitLanes" in stored,
                storesLegacyLaneHeight: stored !== null && "drawTextThreshold" in stored
            });
        }));
    })`);
    if (viewSettingsSetupState.theme !== "light" ||
        !viewSettingsSetupState.split ||
        viewSettingsSetupState.zoomSteps !== "2" ||
        viewSettingsSetupState.webGL ||
        viewSettingsSetupState.textCache ||
        !viewSettingsSetupState.thresholdsAfterZoomSteps ||
        !viewSettingsSetupState.compatibilityAfterThresholds ||
        !viewSettingsSetupState.compatibilityLast ||
        viewSettingsSetupState.stored?.theme !== "light" ||
        viewSettingsSetupState.stored?.colorScheme !== "RoyalBlue" ||
        viewSettingsSetupState.stored?.splitterPosition !== 280 ||
        viewSettingsSetupState.stored?.dependencyArrowType !== "notShow" ||
        viewSettingsSetupState.stored?.textLabelMinimumLaneHeight !== 14 ||
        viewSettingsSetupState.stored?.drawZoomFactor !== 2 ||
        viewSettingsSetupState.stored?.webGLEnabled !== false ||
        viewSettingsSetupState.stored?.textCacheEnabled !== false ||
        viewSettingsSetupState.stored?.customColorScheme?.["0"]?.F?.h !== 210 ||
        viewSettingsSetupState.stored?.customColorScheme?.["0"]?.F?.s !== 25 ||
        viewSettingsSetupState.storesSplitLanes ||
        viewSettingsSetupState.storesLegacyLaneHeight) {
        throw new Error(`View settings setup is incomplete: ${JSON.stringify(viewSettingsSetupState)}`);
    }

    await window.loadFile(webFile);
    await dropFixture(window, plainFixture, "text/plain");
    const persistedViewSettingsState = await window.webContents.executeJavaScript(`(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const zoomIn = document.querySelector('button[aria-label="Zoom in"]');
        if (!(zoomIn instanceof HTMLButtonElement)) {
            throw new Error("The restored zoom control was not found.");
        }
        zoomIn.click();
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
            theme: document.querySelector(".trace-app")?.dataset.theme ?? null,
            split: document.querySelector('input[aria-label="Split lanes"]')?.checked ?? null,
            fixed: document.querySelector('input[aria-label="Fix op height"]')?.checked ?? null,
            arrows: document.querySelector('select[aria-label="Dependency arrow type"]')?.value ?? null,
            color: document.querySelector('select[aria-label="Pipeline color scheme"]')?.value ?? null,
            hideFlushed: document.querySelector('input[aria-label="Hide flushed ops"]')?.checked ?? null,
            webGL: document.querySelector('input[aria-label="WebGL rendering"]')?.checked ?? null,
            textCache: document.querySelector('input[aria-label="Text caching"]')?.checked ?? null,
            textThreshold: document.querySelector('input[aria-label="Text labels minimum lane height"]')?.value ?? null,
            zoomSteps: document.querySelector('input[aria-label="Zoom steps per 2x"]')?.value ?? null,
            zoom: document.querySelector(".zoom-controls output")?.textContent ?? null,
            labelWidth: Math.round(document.querySelector('.label-pane')?.getBoundingClientRect().width ?? -1),
            customColor: JSON.parse(localStorage.getItem("konata.viewSettings") ?? "null")
                ?.customColorScheme?.["0"]?.F ?? null
        };
    })()`);
    if (persistedViewSettingsState.theme !== "light" ||
        persistedViewSettingsState.split ||
        persistedViewSettingsState.fixed ||
        persistedViewSettingsState.arrows !== "notShow" ||
        persistedViewSettingsState.color !== "RoyalBlue" ||
        persistedViewSettingsState.hideFlushed ||
        persistedViewSettingsState.webGL ||
        persistedViewSettingsState.textCache ||
        persistedViewSettingsState.textThreshold !== "14" ||
        persistedViewSettingsState.zoomSteps !== "2" ||
        persistedViewSettingsState.zoom !== "141%" ||
        persistedViewSettingsState.labelWidth !== 280 ||
        persistedViewSettingsState.customColor?.h !== 210 ||
        persistedViewSettingsState.customColor?.s !== 25) {
        throw new Error(`View settings persistence is incomplete: ${JSON.stringify(persistedViewSettingsState)}`);
    }

    // 旧Webのthreshold名と新しい設定の欠落、Custom部分の破損が重なっても他の設定を維持する。
    await window.webContents.executeJavaScript(`(() => {
        const stored = JSON.parse(localStorage.getItem("konata.viewSettings") ?? "null");
        const renamedLaneHeights = [
            ["textLabelMinimumLaneHeight", "drawTextThreshold"],
            ["stageDetailMinimumLaneHeight", "drawDetailedlyThreshold"],
            ["dependencyArrowMinimumLaneHeight", "drawDependencyThreshold"],
            ["stageBorderMinimumLaneHeight", "drawFrameThreshold"]
        ];
        for (const [name, oldName] of renamedLaneHeights) {
            stored[oldName] = stored[name];
            delete stored[name];
        }
        delete stored.drawZoomFactor;
        delete stored.webGLEnabled;
        delete stored.textCacheEnabled;
        stored.customColorScheme.defaultColor.h = 999;
        localStorage.setItem("konata.viewSettings", JSON.stringify(stored));
    })()`);
    await window.loadFile(webFile);
    await dropFixture(window, plainFixture, "text/plain");
    const recoveredCustomColorState = await window.webContents.executeJavaScript(`(async () => {
        const nextFrame = () => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const color = document.querySelector('select[aria-label="Pipeline color scheme"]');
        if (!(color instanceof HTMLSelectElement)) {
            throw new Error("The pipeline color selector was not restored.");
        }
        const theme = document.querySelector(".trace-app")?.dataset.theme ?? null;
        color.value = "Custom";
        color.dispatchEvent(new Event("change", {bubbles: true}));
        await nextFrame();
        const edit = document.querySelector(".custom-color-control button");
        if (!(edit instanceof HTMLButtonElement)) {
            throw new Error("The restored custom color edit button was not found.");
        }
        edit.click();
        await nextFrame();
        const migrated = JSON.parse(localStorage.getItem("konata.viewSettings") ?? "null");
        const result = {
            theme,
            textMinimumLaneHeight: document.querySelector(
                'input[aria-label="Text labels minimum lane height"]',
            )?.value ?? null,
            zoomSteps: document.querySelector('input[aria-label="Zoom steps per 2x"]')?.value ?? null,
            webGL: document.querySelector('input[aria-label="WebGL rendering"]')?.checked ?? null,
            textCache: document.querySelector('input[aria-label="Text caching"]')?.checked ?? null,
            defaultHue: document.querySelector('input[aria-label="Default hue"]')?.value ?? null,
            fetchHue: document.querySelector('input[aria-label="Lane 0 / F hue"]')?.value ?? null,
            fetchAutomatic: document.querySelector(
                'input[aria-label="Use automatic Lane 0 / F saturation"]',
            )?.checked ?? null,
            migratedLaneHeight: migrated?.textLabelMinimumLaneHeight ?? null,
            removedLegacyLaneHeight: migrated !== null && !("drawTextThreshold" in migrated)
        };
        document.querySelector('.custom-color-dialog button[aria-label="Close custom colors"]')?.click();
        await nextFrame();
        color.value = "RoyalBlue";
        color.dispatchEvent(new Event("change", {bubbles: true}));
        await nextFrame();
        return result;
    })()`);
    if (recoveredCustomColorState.theme !== "light" ||
        recoveredCustomColorState.textMinimumLaneHeight !== "14" ||
        recoveredCustomColorState.zoomSteps !== "1" ||
        !recoveredCustomColorState.webGL ||
        !recoveredCustomColorState.textCache ||
        recoveredCustomColorState.defaultHue !== "100" ||
        recoveredCustomColorState.fetchHue !== "0" ||
        !recoveredCustomColorState.fetchAutomatic ||
        recoveredCustomColorState.migratedLaneHeight !== 14 ||
        !recoveredCustomColorState.removedLegacyLaneHeight) {
        throw new Error(`Custom color recovery is incomplete: ${JSON.stringify(recoveredCustomColorState)}`);
    }

    await window.webContents.executeJavaScript(
        `localStorage.setItem("konata.viewSettings", "{broken")`,
    );
    await window.loadFile(webFile);
    await dropFixture(window, plainFixture, "text/plain");
    const recoveredViewSettingsState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            theme: document.querySelector(".trace-app")?.dataset.theme ?? null,
            arrows: document.querySelector('select[aria-label="Dependency arrow type"]')?.value ?? null,
            color: document.querySelector('select[aria-label="Pipeline color scheme"]')?.value ?? null,
            textThreshold: document.querySelector('input[aria-label="Text labels minimum lane height"]')?.value ?? null,
            zoomSteps: document.querySelector('input[aria-label="Zoom steps per 2x"]')?.value ?? null,
            webGL: document.querySelector('input[aria-label="WebGL rendering"]')?.checked ?? null,
            textCache: document.querySelector('input[aria-label="Text caching"]')?.checked ?? null,
            labelWidth: Math.round(document.querySelector('.label-pane')?.getBoundingClientRect().width ?? -1)
        })));
    })`);
    if (recoveredViewSettingsState.theme !== "dark" ||
        recoveredViewSettingsState.arrows !== "insideLine" ||
        recoveredViewSettingsState.color !== "Auto" ||
        recoveredViewSettingsState.textThreshold !== "10" ||
        recoveredViewSettingsState.zoomSteps !== "1" ||
        !recoveredViewSettingsState.webGL ||
        !recoveredViewSettingsState.textCache ||
        recoveredViewSettingsState.labelWidth !== 450) {
        throw new Error(`View settings recovery is incomplete: ${JSON.stringify(recoveredViewSettingsState)}`);
    }

    const persistentFileState = await verifyPersistentFileWorkflow(window, webFile);
    if (persistentFileState.firstPage.changedRole !== "status" ||
        persistentFileState.firstPage.changedMessage !== "recent-reload-smoke.log changed on disk." ||
        !persistentFileState.firstPage.sameTab ||
        persistentFileState.firstPage.tabCount !== 1 ||
        persistentFileState.firstPage.opCount !== "3" ||
        persistentFileState.firstPage.recentName !== "recent-reload-smoke.log" ||
        !persistentFileState.firstPage.reloadEnabled ||
        !persistentFileState.firstPage.menuClosedAfterReload ||
        persistentFileState.secondPage.recentName !== "recent-reload-smoke.log" ||
        persistentFileState.secondPage.fileName !== "recent-reload-smoke.log" ||
        persistentFileState.secondPage.opCount !== "3" ||
        persistentFileState.secondPage.tabCount !== 1) {
        throw new Error(`Persistent file workflow is incomplete: ${JSON.stringify(persistentFileState)}`);
    }

    const remoteTraceState = await verifyRemoteTraceWorkflow(window, webFile);
    if (JSON.stringify(remoteTraceState.names) !== JSON.stringify(["remote-a.log", "remote-b.log"]) ||
        remoteTraceState.activeOpCount !== "1" ||
        !remoteTraceState.reloadEnabled ||
        !remoteTraceState.requests.includes("GET /trace1") ||
        !remoteTraceState.requests.includes("GET /trace2")) {
        throw new Error(`Remote trace workflow is incomplete: ${JSON.stringify(remoteTraceState)}`);
    }

    console.log(`Web smoke test passed: ${JSON.stringify({
        tileReuseState,
        textAtlasState,
        webGLState,
        persistentFileState,
        remoteTraceState,
    })}`);
    window.destroy();
}

app.whenReady()
    .then(run)
    .then(() => app.exit(0))
    .catch((error) => {
        console.error("Web smoke test failed:", error);
        app.exit(1);
    });
