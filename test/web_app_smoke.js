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

// browser内の描画回数を計測する各検査で、prototypeの差し替えと復元を共有する。
const METHOD_OBSERVER_HELPER = `
    const observedMethodRestorers = [];
    const observeMethod = (target, name, observer) => {
        const original = target[name];
        if (typeof original !== "function") {
            throw new Error("The observed method was not found: " + name);
        }
        target[name] = function(...args) {
            const result = Reflect.apply(original, this, args);
            observer.call(this, args, result);
            return result;
        };
        observedMethodRestorers.push(() => {
            target[name] = original;
        });
    };
    const restoreObservedMethods = () => {
        for (const restore of observedMethodRestorers.reverse()) {
            restore();
        }
    };
`;

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
                            await new Promise((resolve) => setTimeout(resolve, 1000));
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
            // CIで最初のReact描画が遅れても、1秒停止中のprogressを十分観測できるようにする。
            const deadline = performance.now() + 2000;
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
                        // 2本のload progressを同時にDOM上で観測してから入力を再開する。
                        await new Promise((resolve) => setTimeout(resolve, 100));
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
        let stackedProgress = null;
        while (performance.now() < deadline) {
            const tabs = [...document.querySelectorAll(".trace-tab")].filter((tab) =>
                names.includes(tab.querySelector('[role="tab"]')?.textContent?.trim() ?? ""));
            const stack = document.querySelector(".operation-progress-stack");
            const bars = [...document.querySelectorAll(".operation-progress")];
            if (stackedProgress === null && stack instanceof HTMLElement && bars.length >= 2) {
                stackedProgress = {
                    count: bars.length,
                    zIndex: getComputedStyle(stack).zIndex,
                    tops: bars.map((bar) => bar.getBoundingClientRect().top),
                    colors: bars.map((bar) => getComputedStyle(bar.firstElementChild).backgroundColor)
                };
            }
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
                return {names, startedStreams, stackedProgress};
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
        let partialToolState = null;
        let partialNavigator = null;
        let navigatorRequested = false;
        let finishing = false;
        const check = () => {
            const root = document.querySelector(".trace-app");
            const state = root?.dataset.loadState;
            const opCount = Number(root?.dataset.opCount ?? -1);
            if (state === "loading" && opCount === 1) {
                const navigatorToggle = document.querySelector('input[aria-label="Trace navigator"]');
                if (!navigatorRequested && navigatorToggle instanceof HTMLInputElement &&
                    !navigatorToggle.disabled) {
                    navigatorRequested = true;
                    navigatorToggle.click();
                }
                const navigatorPane = document.querySelector(".trace-navigator-cycle-pane");
                const navigatorStatus = navigatorPane?.querySelector(".trace-navigator-cycle-status");
                if (navigatorToggle instanceof HTMLInputElement && navigatorToggle.checked &&
                    navigatorPane instanceof HTMLElement && navigatorStatus instanceof HTMLElement) {
                    partialNavigator = {
                        visible: true,
                        status: navigatorStatus.textContent ?? ""
                    };
                }
                const searchButton = document.querySelector('button[aria-label="Search trace"]');
                const statsButton = [...document.querySelectorAll(".app-toolbar button")]
                    .find((candidate) => candidate.textContent?.trim() === "Stats");
                partialToolState ??= {
                    searchEnabled: searchButton instanceof HTMLButtonElement && !searchButton.disabled,
                    statsEnabled: statsButton instanceof HTMLButtonElement && !statsButton.disabled
                };
                const canvas = document.querySelector(".pipeline-pane canvas");
                const toolbar = document.querySelector(".app-toolbar");
                const progress = document.querySelector(".operation-progress");
                const progressStack = document.querySelector(".operation-progress-stack");
                const splitter = document.querySelector(".pane-splitter");
                const status = document.querySelector(".status-loading");
                const dots = status?.querySelector(".status-loading-dots");
                loadingStatus = {
                    text: status?.textContent ?? null,
                    hasIndicator: dots !== null,
                    role: status?.getAttribute("role") ?? null
                };
                if (toolbar instanceof HTMLElement &&
                    progress instanceof HTMLElement &&
                    progressStack instanceof HTMLElement &&
                    splitter instanceof HTMLElement) {
                    // progressはtoolbarの下端からviewerへ3px重なるため、splitterより上の階層を維持する。
                    progressLayers = {
                        toolbar: getComputedStyle(toolbar).zIndex,
                        progress: getComputedStyle(progressStack).zIndex,
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
            if (!finishing && state === "ready" && opCount === 2 && partialNavigator !== null) {
                finishing = true;
                const navigatorToggle = document.querySelector('input[aria-label="Trace navigator"]');
                if (navigatorToggle instanceof HTMLInputElement && navigatorToggle.checked) {
                    navigatorToggle.click();
                }
                requestAnimationFrame(() => resolve({
                    partialPixels,
                    finalOpCount: opCount,
                    partialToolState,
                    partialNavigator,
                    progressLayers,
                    loadingStatus
                }));
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

async function moveSplitter(window, position, pointerType = "mouse") {
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
        // synthetic pointerにも製品コードと同じcapture寿命を与え、mouseとtouchを同じ経路で確認する。
        const captured = new Set();
        Object.defineProperties(splitter, {
            setPointerCapture: {configurable: true, value: (id) => captured.add(id)},
            hasPointerCapture: {configurable: true, value: (id) => captured.has(id)},
            releasePointerCapture: {configurable: true, value: (id) => captured.delete(id)}
        });
        const dispatchPointer = (type, clientX, buttons) => splitter.dispatchEvent(new PointerEvent(type, {
            pointerId: 1,
            pointerType: ${JSON.stringify(pointerType)},
            isPrimary: true,
            bubbles: true,
            cancelable: true,
            button: type === "pointerdown" ? 0 : -1,
            buttons,
            clientX
        }));
        dispatchPointer("pointerdown", splitterRect.left + splitterRect.width / 2, 1);
        dispatchPointer("pointermove", viewerRect.left + ${position}, 1);
        dispatchPointer("pointerup", viewerRect.left + ${position}, 0);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const result = {
                initialLabelWidth,
                viewerWidth: Math.round(viewer.getBoundingClientRect().width),
                labelWidth: Math.round(label.getBoundingClientRect().width),
                splitterWidth: Math.round(splitter.getBoundingClientRect().width),
                pipelineWidth: Math.round(pipeline.getBoundingClientRect().width),
                position: splitter.getAttribute("aria-valuenow"),
                cursor: getComputedStyle(splitter).cursor,
                capturedPointers: captured.size
            };
            delete splitter.setPointerCapture;
            delete splitter.hasPointerCapture;
            delete splitter.releasePointerCapture;
            resolve(result);
        }));
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
            authors: about?.querySelector(".about-authors")?.textContent?.trim() ?? null,
            values: [...(about?.querySelectorAll(".build-details dd") ?? [])]
                .map((value) => value.textContent?.trim() ?? ""),
            githubHref: about?.querySelector('.about-links a')?.getAttribute("href") ?? null
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
            hasNotices: licenseText.includes("react") && licenseText.includes("For Zstandard software")
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
                rootChildCount: document.querySelector("#konata-root")?.childElementCount ?? 0,
                paneTitleCount: document.querySelectorAll(".pane-title").length,
                openButtonText: document.querySelector(".primary-button")?.textContent?.trim() ?? null,
                openPanelTopLevel:
                    document.querySelector(".app-toolbar > .open-controls > .open-controls-panel") !== null,
                reloadDisabledWithoutHandle: reloadButton?.disabled ?? null,
                recentFilesEmpty: document.querySelector(".recent-files-empty")?.textContent ?? null,
                toolbarSequence,
                zoomLabels: [...document.querySelectorAll(".zoom-controls .icon-button")]
                    .map((button) => button.getAttribute("aria-label")),
                bookmarkPanelTopLevel:
                    document.querySelector(".app-toolbar > .bookmark-controls > .bookmark-controls-panel") !== null,
                bookmarkInViewPanel: document.querySelector(".view-controls-panel .bookmark-controls") !== null,
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
        initialState.rootChildCount !== 1 ||
        initialState.paneTitleCount !== 0 ||
        initialState.openButtonText !== "Open" ||
        !initialState.openPanelTopLevel ||
        !initialState.reloadDisabledWithoutHandle ||
        initialState.recentFilesEmpty !== "No recent files" ||
        JSON.stringify(initialState.toolbarSequence) !==
            JSON.stringify(["Open", "Search", "Bookmark", "Compare", "Stats", "View", "Zoom", "Menu"]) ||
        JSON.stringify(initialState.zoomLabels) !==
            JSON.stringify(["Zoom out", "Zoom in", "Adjust position", "Reset view"]) ||
        !initialState.bookmarkPanelTopLevel ||
        initialState.bookmarkInViewPanel ||
        !initialState.applicationMenuRightmost ||
        initialState.canvasCount !== 2 ||
        initialState.splitterCount !== 0 ||
        initialState.labelWidth !== 0 ||
        initialState.pipelineWidth !== initialState.viewerWidth ||
        !/^[0-9a-f]+$/.test(initialState.commit ?? "") ||
        !/^\d{4}-\d{2}-\d{2}$/.test(initialState.date ?? "") ||
        initialState.buildInfoText !==
            `Version ${initialState.version} · Commit ${initialState.commit} · ${initialState.date}`) {
        throw new Error(`React initialization is incomplete: ${JSON.stringify(initialState)}`);
    }

    const applicationMenuState = await verifyApplicationMenu(window);
    const shortcutText = applicationMenuState.shortcutState.entries.flat().join(" ");
    if (JSON.stringify(applicationMenuState.menuItems) !== JSON.stringify([
        "Application log",
        "Keyboard shortcuts",
        "About Konata"
    ]) ||
        applicationMenuState.menuVersion !== `Version ${initialState.version}` ||
        !applicationMenuState.menuPanelOnTop ||
        applicationMenuState.aboutState.title !== "About Konata" ||
        applicationMenuState.aboutState.authors !== "Ryota Shioya and Kojiro Izuoka" ||
        JSON.stringify(applicationMenuState.aboutState.values) !==
            JSON.stringify([initialState.version, initialState.commit, initialState.date]) ||
        applicationMenuState.aboutState.githubHref !== "https://github.com/shioyadan/Konata" ||
        applicationMenuState.mainLicenseState.title !== "Konata License" ||
        !applicationMenuState.mainLicenseState.hasCopyright ||
        applicationMenuState.licensesState.title !== "Third-Party Licenses" ||
        !applicationMenuState.licensesState.hasNotices ||
        applicationMenuState.shortcutState.title !== "Keyboard Shortcuts" ||
        applicationMenuState.shortcutState.entries.length < 10 ||
        !shortcutText.includes("Double-click") ||
        !shortcutText.includes("Esc") ||
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
        logPaneState.restoredViewerHeight !== logPaneState.initialViewerHeight ||
        !logPaneState.closed) {
        throw new Error(`Application log pane is incomplete: ${JSON.stringify(logPaneState)}`);
    }

    const incrementalState = await verifyIncrementalRendering(window);
    if (incrementalState.partialPixels < 100 ||
        incrementalState.finalOpCount !== 2 ||
        !incrementalState.partialToolState?.searchEnabled ||
        !incrementalState.partialToolState?.statsEnabled ||
        !incrementalState.partialNavigator?.visible ||
        !incrementalState.partialNavigator?.status?.startsWith("Collecting pipeline sample…") ||
        !incrementalState.loadingStatus?.text?.startsWith("Loading incremental.log…") ||
        !incrementalState.loadingStatus?.hasIndicator ||
        incrementalState.loadingStatus?.role !== "status" ||
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

    // trackpad pinchは小数倍率へ、物理Ctrl+wheelは40 msの回転量に応じた最大2段へ畳む。
    const wheelZoomState = await window.webContents.executeJavaScript(`(async () => {
        const viewer = document.querySelector(".viewer");
        const toolbar = document.querySelector(".app-toolbar");
        const reset = [...document.querySelectorAll(".zoom-controls button")]
            .find((button) => button.textContent?.trim() === "Reset");
        const output = document.querySelector(".zoom-controls output");
        if (!(viewer instanceof HTMLElement) || !(toolbar instanceof HTMLElement) ||
            !(reset instanceof HTMLButtonElement)) {
            throw new Error("The viewer zoom controls were not found.");
        }
        const rect = viewer.getBoundingClientRect();
        const before = output?.textContent ?? null;
        const trackpadEvents = Array.from({length: 20}, () => new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            deltaY: -10,
            clientX: rect.left + 400,
            clientY: rect.top + 200
        }));
        const trackpadDispatched = trackpadEvents.map((event) => viewer.dispatchEvent(event));
        const trackpadImmediatelyAfter = output?.textContent ?? null;
        await new Promise((resolve) => requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const trackpadZoom = output?.textContent ?? null;
        reset.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) => requestAnimationFrame(resolve));

        document.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Control",
            ctrlKey: true,
            bubbles: true
        }));
        const wheelEvents = Array.from({length: 3}, () => new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            deltaY: 120,
            clientX: rect.left + 400,
            clientY: rect.top + 200
        }));
        const wheelDispatched = wheelEvents.map((event) => viewer.dispatchEvent(event));
        const wheelImmediatelyAfter = output?.textContent ?? null;
        await new Promise((resolve) => setTimeout(resolve, 50));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const wheelTarget = output?.textContent ?? null;
        const cooledWheelEvent = new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            deltaY: 120,
            clientX: rect.left + 400,
            clientY: rect.top + 200
        });
        const cooledWheelDispatched = viewer.dispatchEvent(cooledWheelEvent);
        document.dispatchEvent(new KeyboardEvent("keyup", {
            key: "Control",
            bubbles: true
        }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const cooledWheelTarget = output?.textContent ?? null;
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const wheelZoom = output?.textContent ?? null;
        reset.click();
        const resetImmediatelyAfter = output?.textContent ?? null;
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const toolbarEvents = Array.from({length: 20}, () => new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            deltaY: -10,
            clientX: rect.left + 400,
            clientY: rect.top - 20
        }));
        const toolbarDispatched = toolbarEvents.map((event) => toolbar.dispatchEvent(event));
        await new Promise((resolve) => requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const toolbarZoom = output?.textContent ?? null;
        reset.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
            trackpadCanceled: trackpadDispatched.every((value, index) =>
                !value && trackpadEvents[index].defaultPrevented),
            wheelCanceled: wheelDispatched.every((value, index) =>
                !value && wheelEvents[index].defaultPrevented) &&
                !cooledWheelDispatched && cooledWheelEvent.defaultPrevented,
            before,
            trackpadImmediatelyAfter,
            trackpadZoom,
            wheelImmediatelyAfter,
            wheelTarget,
            cooledWheelTarget,
            wheelZoom,
            resetImmediatelyAfter,
            toolbarCanceled: toolbarDispatched.every((value, index) =>
                !value && toolbarEvents[index].defaultPrevented),
            toolbarZoom,
            resetZoom: output?.textContent ?? null
        };
    })()`);
    if (!wheelZoomState.trackpadCanceled || !wheelZoomState.wheelCanceled ||
        !wheelZoomState.toolbarCanceled ||
        wheelZoomState.before !== "100%" ||
        wheelZoomState.trackpadImmediatelyAfter !== "100%" ||
        wheelZoomState.trackpadZoom !== "119%" ||
        wheelZoomState.wheelImmediatelyAfter !== "100%" ||
        wheelZoomState.wheelTarget !== "50%" ||
        wheelZoomState.cooledWheelTarget !== "35.4%" ||
        wheelZoomState.wheelZoom !== "35.4%" ||
        wheelZoomState.resetImmediatelyAfter !== "35.4%" ||
        wheelZoomState.toolbarZoom !== "119%" ||
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
        // 拡大上限の200%から離し、4連打の2ペアを50%から100%まで観測する。
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
        // sendInputEventはmain processから非同期配送されるため、送信直後の倍率は検査しない。
        const deadline = performance.now() + 2000;
        while (output?.textContent !== "100%" && performance.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const zoom = output?.textContent ?? null;
        reset.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
            zoom,
            resetZoom: output?.textContent ?? null
        };
    })()`);
    if (doubleClickSetup.zoom !== "50%" ||
        doubleClickZoomState.zoom !== "100%" ||
        doubleClickZoomState.resetZoom !== "100%") {
        throw new Error(`Double click zoom is incomplete: ${JSON.stringify(doubleClickZoomState)}`);
    }

    // shortcut一覧に示すCtrl/Command+上下が、browser scrollではなくKonataのzoomになることを確認する。
    const keyboardZoomState = await window.webContents.executeJavaScript(`(async () => {
        const output = document.querySelector(".zoom-controls output");
        const zoom = (key, repeat = false) => {
            const event = new KeyboardEvent("keydown", {
                key,
                ctrlKey: true,
                repeat,
                bubbles: true,
                cancelable: true
            });
            const dispatched = document.dispatchEvent(event);
            return !dispatched && event.defaultPrevented;
        };
        const firstCanceled = zoom("ArrowDown");
        const repeatedCanceled = Array.from({length: 6}, () => zoom("ArrowDown", true))
            .every(Boolean);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const duringCooldown = output?.textContent ?? null;
        await new Promise((resolve) => setTimeout(resolve, 50));
        const cooledCanceled = zoom("ArrowDown", true);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const afterCooldown = output?.textContent ?? null;
        const reversedCanceled = zoom("ArrowUp", true);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const reversed = output?.textContent ?? null;
        const restoredCanceled = zoom("ArrowUp");
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
            firstCanceled,
            repeatedCanceled,
            cooledCanceled,
            reversedCanceled,
            restoredCanceled,
            duringCooldown,
            afterCooldown,
            reversed,
            restored: output?.textContent ?? null,
        };
    })()`);
    if (!keyboardZoomState.firstCanceled || !keyboardZoomState.repeatedCanceled ||
        !keyboardZoomState.cooledCanceled || !keyboardZoomState.reversedCanceled ||
        !keyboardZoomState.restoredCanceled ||
        keyboardZoomState.duringCooldown !== "70.7%" ||
        keyboardZoomState.afterCooldown !== "50%" || keyboardZoomState.reversed !== "70.7%" ||
        keyboardZoomState.restored !== "100%") {
        throw new Error(`Keyboard zoom is incomplete: ${JSON.stringify(keyboardZoomState)}`);
    }

    // 通常wheelを素早く3回送ると、目標へ18cycle分を積み上げる。
    // 補間の中間値は時刻を制御したunit testで固定し、実画面では最終位置だけを確認する。
    // CIのrequestAnimationFrameが100 ms以上遅れると、中間frameを観測できないためである。
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
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const finalCycle = await readCycle();
        adjust.click();
        await new Promise((resolve) => setTimeout(resolve, 220));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const adjustedFinalCycle = await readCycle();
        reset.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
            canceled: dispatched.every((value, index) => !value && events[index].defaultPrevented),
            finalCycle,
            adjustedFinalCycle
        };
    })()`);
    if (!wheelScrollState.canceled ||
        wheelScrollState.finalCycle !== 18 ||
        wheelScrollState.adjustedFinalCycle !== 0) {
        throw new Error(`Wheel scroll animation is incomplete: ${JSON.stringify(wheelScrollState)}`);
    }

    // touch画面では2 pointer間の距離比を連続倍率へ変換し、browser gestureに渡さずzoomする。
    const pinchZoomState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        ${METHOD_OBSERVER_HELPER}
        const viewer = document.querySelector(".viewer");
        const pipeline = document.querySelector(".pipeline-pane");
        const pipelineCanvas = document.querySelector(".pipeline-pane canvas");
        const reset = [...document.querySelectorAll(".zoom-controls button")]
            .find((button) => button.textContent?.trim() === "Reset");
        if (!(viewer instanceof HTMLElement) ||
            !(pipeline instanceof HTMLElement) ||
            !(pipelineCanvas instanceof HTMLCanvasElement) ||
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
        const prototype = CanvasRenderingContext2D.prototype;
        const tileBackingSize = Math.round(256 * devicePixelRatio);
        let generatedTiles = 0;
        let scaledTileBlits = 0;
        observeMethod(prototype, "fillRect", function() {
            if (this.canvas instanceof HTMLCanvasElement && !this.canvas.isConnected &&
                this.canvas.width === tileBackingSize && this.canvas.height === tileBackingSize) {
                generatedTiles++;
            }
        });
        observeMethod(prototype, "drawImage", function(args) {
            const source = args[0];
            if (this.canvas === pipelineCanvas && this.imageSmoothingEnabled &&
                source instanceof HTMLCanvasElement && !source.isConnected &&
                source.width === tileBackingSize && source.height === tileBackingSize) {
                scaledTileBlits++;
            }
        });
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
                touchAction: getComputedStyle(viewer).touchAction,
                generatedTiles,
                scaledTileBlits
            };
            restoreObservedMethods();
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
        pinchZoomState.touchAction !== "none" ||
        pinchZoomState.generatedTiles !== 0 ||
        pinchZoomState.scaledTileBlits < 1) {
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
        !bookmarkZoomState.slot.endsWith("zoom:-0.5") ||
        bookmarkZoomState.zoom !== "141%") {
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
        !persistedBookmarkState.slot3.endsWith("zoom:-0.5")) {
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
        firstSplitterState.cursor !== "col-resize" ||
        firstSplitterState.capturedPointers !== 0) {
        throw new Error(`Trace pane splitter is incomplete: ${JSON.stringify(firstSplitterState)}`);
    }

    // 狭い画面ではdesktop用の保存幅を維持しながらlabelを40%までに抑え、touchでも調整できる。
    window.setContentSize(390, 700);
    const narrowPaneState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const viewer = document.querySelector(".viewer")?.getBoundingClientRect();
            const label = document.querySelector(".label-pane")?.getBoundingClientRect();
            const pipeline = document.querySelector(".pipeline-pane")?.getBoundingClientRect();
            resolve({
                viewerWidth: Math.round(viewer?.width ?? -1),
                labelWidth: Math.round(label?.width ?? -1),
                pipelineWidth: Math.round(pipeline?.width ?? -1),
                position: document.querySelector(".pane-splitter")?.getAttribute("aria-valuenow") ?? null
            });
        }));
    })`);
    if (narrowPaneState.labelWidth > narrowPaneState.viewerWidth * 0.4 + 1 ||
        narrowPaneState.pipelineWidth < narrowPaneState.viewerWidth * 0.55 ||
        narrowPaneState.position !== "320") {
        throw new Error(`Narrow trace panes are incomplete: ${JSON.stringify(narrowPaneState)}`);
    }
    const narrowToolbarState = await window.webContents.executeJavaScript(`(async () => {
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const toolbar = document.querySelector(".app-toolbar");
        const menu = document.querySelector(".application-menu");
        const menuSummary = menu?.querySelector(":scope > summary");
        if (!(toolbar instanceof HTMLElement) ||
            !(menu instanceof HTMLDetailsElement) ||
            !(menuSummary instanceof HTMLElement)) {
            throw new Error("The narrow toolbar was not found.");
        }
        const visibleActions = [...toolbar.querySelectorAll(".toolbar-action")]
            .filter((element) => element.getClientRects().length > 0);
        menuSummary.click();
        await nextFrame();
        const menuActions = [...menu.querySelectorAll(".mobile-menu-actions button")]
            .filter((element) => element.getClientRects().length > 0);
        const status = toolbar.querySelector(".status")?.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        const result = {
            toolbarHeight: Math.round(toolbarRect.height),
            actionRows: new Set(visibleActions.map((element) =>
                Math.round(element.getBoundingClientRect().top))).size,
            actions: visibleActions.map((element) => element.getAttribute("aria-label")),
            menuActions: menuActions.map((element) => element.textContent?.trim() ?? ""),
            compareDisabled: menu.querySelector('.mobile-menu-actions button')?.disabled ?? null,
            zoomHidden: document.querySelector(".zoom-controls")?.getClientRects().length === 0,
            statusBelowToolbar: status === undefined || status.top >= toolbarRect.bottom
        };
        menu.removeAttribute("open");
        await nextFrame();
        return result;
    })()`);
    if (narrowToolbarState.toolbarHeight > 44 ||
        narrowToolbarState.actionRows !== 1 ||
        JSON.stringify(narrowToolbarState.actions.slice(0, 4)) !== JSON.stringify([
            "Open files", "Search trace", "Bookmarks", "View settings"
        ]) ||
        !narrowToolbarState.actions[4]?.startsWith("Application menu") ||
        JSON.stringify(narrowToolbarState.menuActions) !== JSON.stringify([
            "Compare", "Stats", "Adjust position", "Reset view"
        ]) ||
        !narrowToolbarState.compareDisabled ||
        !narrowToolbarState.zoomHidden ||
        !narrowToolbarState.statusBelowToolbar) {
        throw new Error(`Narrow toolbar is incomplete: ${JSON.stringify(narrowToolbarState)}`);
    }

    // 各buttonから開くpanelも320px幅ではtoolbar全体を基準にし、横へ隠れた操作を残さない。
    window.setContentSize(320, 568);
    const narrowPanelState = await window.webContents.executeJavaScript(`(async () => {
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const measurePanel = async (detailsSelector, panelSelector) => {
            const details = document.querySelector(detailsSelector);
            const summary = details?.querySelector(":scope > summary");
            if (!(details instanceof HTMLDetailsElement) ||
                !(summary instanceof HTMLElement)) {
                throw new Error("A narrow screen panel was not found: " + panelSelector);
            }
            summary.click();
            await nextFrame();
            const panel = details.querySelector(panelSelector);
            if (!(panel instanceof HTMLElement)) {
                throw new Error("A narrow screen panel did not open: " + panelSelector);
            }
            const rect = panel.getBoundingClientRect();
            const controls = [...panel.querySelectorAll("button, select, input")]
                .filter((element) => element.getClientRects().length > 0);
            panel.scrollTop = panel.scrollHeight;
            await nextFrame();
            const lastControl = controls.at(-1)?.getBoundingClientRect();
            const result = {
                selector: panelSelector,
                insideViewport: rect.left >= 0 && rect.right <= innerWidth + 1 &&
                    rect.top >= 0 && rect.bottom <= innerHeight + 1,
                noHorizontalOverflow: panel.scrollWidth <= panel.clientWidth + 1,
                lastControlReachable: lastControl === undefined ||
                    (lastControl.top >= 0 && lastControl.bottom <= innerHeight + 1)
            };
            details.removeAttribute("open");
            await nextFrame();
            return result;
        };
        const panels = [];
        for (const [detailsSelector, panelSelector] of [
            [".open-controls", ".open-controls-panel"],
            [".bookmark-controls", ".bookmark-controls-panel"],
            [".view-controls", ".view-controls-panel"],
            [".application-menu", ".application-menu-panel"]
        ]) {
            panels.push(await measurePanel(detailsSelector, panelSelector));
        }

        const menu = document.querySelector(".application-menu");
        const menuSummary = menu?.querySelector(":scope > summary");
        if (!(menu instanceof HTMLDetailsElement) || !(menuSummary instanceof HTMLElement)) {
            throw new Error("The application menu was not found for the narrow dialog test.");
        }
        menuSummary.click();
        await nextFrame();
        const shortcuts = [...menu.querySelectorAll(".application-menu-panel button")]
            .find((button) => button.textContent?.includes("Keyboard shortcuts"));
        shortcuts?.click();
        await nextFrame();
        const dialog = document.querySelector(".application-dialog");
        const close = dialog?.querySelector('button[aria-label^="Close"]');
        const dialogRect = dialog?.getBoundingClientRect();
        const closeRect = close?.getBoundingClientRect();
        const dialogFits = dialog instanceof HTMLElement && dialogRect !== undefined &&
            dialogRect.left >= 0 && dialogRect.right <= innerWidth + 1 &&
            dialogRect.top >= 0 && dialogRect.bottom <= innerHeight + 1 &&
            dialog.scrollWidth <= dialog.clientWidth + 1;
        const closeReachable = closeRect !== undefined &&
            closeRect.left >= 0 && closeRect.right <= innerWidth + 1 &&
            closeRect.top >= 0 && closeRect.bottom <= innerHeight + 1;
        if (close instanceof HTMLElement) {
            close.click();
            await nextFrame();
        }
        return {panels, dialogFits, closeReachable};
    })()`);
    if (narrowPanelState.panels.some((panel) =>
        !panel.insideViewport || !panel.noHorizontalOverflow || !panel.lastControlReachable) ||
        !narrowPanelState.dialogFits || !narrowPanelState.closeReachable) {
        throw new Error(`Narrow panels are incomplete: ${JSON.stringify(narrowPanelState)}`);
    }
    window.setContentSize(390, 700);
    const touchSplitterState = await moveSplitter(window, 120, "touch");
    if (touchSplitterState.labelWidth !== 120 ||
        touchSplitterState.pipelineWidth !== touchSplitterState.viewerWidth - 130 ||
        touchSplitterState.position !== "120" ||
        touchSplitterState.capturedPointers !== 0) {
        throw new Error(`Touch splitter is incomplete: ${JSON.stringify(touchSplitterState)}`);
    }
    const recappedPaneState = await moveSplitter(window, 320, "touch");
    if (recappedPaneState.labelWidth > recappedPaneState.viewerWidth * 0.4 + 1 ||
        recappedPaneState.position !== "320" ||
        recappedPaneState.capturedPointers !== 0) {
        throw new Error(`Narrow pane cap is incomplete: ${JSON.stringify(recappedPaneState)}`);
    }
    window.setContentSize(1100, 700);
    const restoredPaneState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            labelWidth: Math.round(document.querySelector(".label-pane")?.getBoundingClientRect().width ?? -1),
            position: document.querySelector(".pane-splitter")?.getAttribute("aria-valuenow") ?? null
        })));
    })`);
    if (restoredPaneState.labelWidth !== 320 || restoredPaneState.position !== "320") {
        throw new Error(`Desktop pane width was not restored: ${JSON.stringify(restoredPaneState)}`);
    }

    // 明示的に有効化した時だけ下部へTop-down-like表示を作り、上のcycle幅と揃える。
    const navigatorState = await window.webContents.executeJavaScript(`(async () => {
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const toggle = document.querySelector('input[aria-label="Trace navigator"]');
        const initialPipelineHeight = document.querySelector(".pipeline-pane")?.getBoundingClientRect().height ?? -1;
        if (!(toggle instanceof HTMLInputElement) || toggle.disabled || toggle.checked) {
            throw new Error("The trace navigator control was not ready.");
        }
        toggle.click();
        const deadline = performance.now() + 2000;
        while (performance.now() < deadline) {
            const canvas = document.querySelector('canvas[aria-label="Cycle navigator canvas"]');
            const status = document.querySelector(".trace-navigator-cycle-status");
            if (canvas instanceof HTMLCanvasElement && status === null && canvas.width > 1) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await nextFrame();
        const viewer = document.querySelector(".viewer");
        const pipeline = document.querySelector(".pipeline-pane");
        const labelCanvas = document.querySelector('canvas[aria-label="Cycle navigator labels canvas"]');
        const navigatorCanvas = document.querySelector('canvas[aria-label="Cycle navigator canvas"]');
        const navigatorMode = document.querySelector('select[aria-label="Cycle navigator mode"]');
        const navigatorRange = document.querySelector('[aria-label="Navigator range"]');
        const followRange = [...(navigatorRange?.querySelectorAll("button") ?? [])]
            .find((button) => button.textContent?.trim() === "Follow");
        const overviewRange = [...(navigatorRange?.querySelectorAll("button") ?? [])]
            .find((button) => button.textContent?.trim() === "Overview");
        const resizer = document.querySelector('[role="separator"][aria-label="Resize trace navigator"]');
        const reset = [...document.querySelectorAll(".zoom-controls button")]
            .find((button) => button.textContent?.trim() === "Reset");
        const zoomOutput = document.querySelector(".zoom-controls output");
        if (!(viewer instanceof HTMLElement) || !(pipeline instanceof HTMLElement) ||
            !(labelCanvas instanceof HTMLCanvasElement) ||
            !(navigatorCanvas instanceof HTMLCanvasElement) ||
            !(navigatorMode instanceof HTMLSelectElement) || !(resizer instanceof HTMLElement) ||
            !(followRange instanceof HTMLButtonElement) ||
            !(overviewRange instanceof HTMLButtonElement) ||
            !(reset instanceof HTMLButtonElement)) {
            throw new Error("The trace navigator pane was not created.");
        }
        const defaultRange = overviewRange.getAttribute("aria-pressed");
        followRange.click();
        await nextFrame();
        const followSelected = followRange.getAttribute("aria-pressed");
        overviewRange.click();
        await nextFrame();
        navigatorMode.value = "commit";
        navigatorMode.dispatchEvent(new Event("change", {bubbles: true}));
        await nextFrame();
        await nextFrame();
        reset.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const navigatorRect = navigatorCanvas.getBoundingClientRect();
        const zoomEvents = Array.from({length: 20}, () => new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            deltaY: -10,
            clientX: navigatorRect.left + navigatorRect.width / 2,
            clientY: navigatorRect.top + navigatorRect.height / 2
        }));
        const zoomDispatched = zoomEvents.map((event) => navigatorCanvas.dispatchEvent(event));
        await new Promise((resolve) => requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const navigatorZoom = zoomOutput?.textContent ?? null;
        reset.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const result = {
            checked: toggle.checked,
            hasClass: viewer.classList.contains("has-trace-navigator"),
            paneHeight: Math.round(navigatorCanvas.getBoundingClientRect().height),
            labelAligned: Math.round(labelCanvas.getBoundingClientRect().width) ===
                Math.round(document.querySelector(".label-pane")?.getBoundingClientRect().width ?? -1),
            navigatorAligned: Math.round(navigatorCanvas.getBoundingClientRect().width) ===
                Math.round(pipeline.getBoundingClientRect().width),
            pipelineHeightReduction: Math.round(initialPipelineHeight - pipeline.getBoundingClientRect().height),
            mode: navigatorMode.value,
            modeOptions: [...navigatorMode.options].map((option) => option.value),
            defaultRange,
            followSelected,
            overviewSelected: overviewRange.getAttribute("aria-pressed"),
            overviewCursor: getComputedStyle(navigatorCanvas).cursor,
            zoomCanceled: zoomDispatched.every((value, index) =>
                !value && zoomEvents[index].defaultPrevented),
            navigatorZoom
        };
        // 境界へ重ねたseparatorをdragし、上下Canvasのlayoutとbacking storeが追従することを確認する。
        const captured = new Set();
        Object.defineProperties(resizer, {
            setPointerCapture: {configurable: true, value: (id) => captured.add(id)},
            hasPointerCapture: {configurable: true, value: (id) => captured.has(id)},
            releasePointerCapture: {configurable: true, value: (id) => captured.delete(id)}
        });
        const viewerRect = viewer.getBoundingClientRect();
        const resizerRect = resizer.getBoundingClientRect();
        const dispatchPointer = (type, clientY, buttons) => resizer.dispatchEvent(new PointerEvent(type, {
            pointerId: 2,
            pointerType: "mouse",
            isPrimary: true,
            bubbles: true,
            cancelable: true,
            button: type === "pointerdown" ? 0 : -1,
            buttons,
            clientY
        }));
        dispatchPointer("pointerdown", resizerRect.top + resizerRect.height / 2, 1);
        dispatchPointer("pointermove", viewerRect.bottom - 180, 1);
        dispatchPointer("pointerup", viewerRect.bottom - 180, 0);
        await nextFrame();
        await nextFrame();
        const resized = {
            paneHeight: Math.round(navigatorCanvas.getBoundingClientRect().height),
            pipelineHeightReduction: Math.round(initialPipelineHeight - pipeline.getBoundingClientRect().height),
            canvasHeight: navigatorCanvas.height,
            separatorHeight: Math.round(resizer.getBoundingClientRect().height),
            position: resizer.getAttribute("aria-valuenow"),
            cursor: getComputedStyle(resizer).cursor,
            capturedPointers: captured.size
        };
        delete resizer.setPointerCapture;
        delete resizer.hasPointerCapture;
        delete resizer.releasePointerCapture;
        toggle.click();
        await nextFrame();
        return {
            ...result,
            resized,
            removed: document.querySelector(".trace-navigator-pane") === null
        };
    })()`);
    if (!navigatorState.checked || !navigatorState.hasClass ||
        navigatorState.paneHeight < 63 || navigatorState.paneHeight > 64 ||
        !navigatorState.labelAligned ||
        !navigatorState.navigatorAligned || navigatorState.pipelineHeightReduction !== 64 ||
        navigatorState.mode !== "commit" ||
        navigatorState.modeOptions?.join(",") !== "top-down,fetch,issue,commit,flush,latency" ||
        navigatorState.defaultRange !== "true" ||
        navigatorState.followSelected !== "true" ||
        navigatorState.overviewSelected !== "true" ||
        navigatorState.overviewCursor !== "grab" ||
        !navigatorState.zoomCanceled || navigatorState.navigatorZoom !== "119%" ||
        navigatorState.resized?.paneHeight < 179 || navigatorState.resized.paneHeight > 180 ||
        navigatorState.resized.pipelineHeightReduction !== 180 ||
        navigatorState.resized.canvasHeight < 179 ||
        navigatorState.resized.separatorHeight !== 10 ||
        navigatorState.resized.position !== "180" ||
        navigatorState.resized.cursor !== "row-resize" ||
        navigatorState.resized.capturedPointers !== 0 ||
        !navigatorState.removed) {
        throw new Error(`Trace navigator is incomplete: ${JSON.stringify(navigatorState)}`);
    }

    // Webでは旧native menuの代わりにView panelからRendererの表示modeを変更する。
    const viewControlState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const viewControls = document.querySelector(".view-controls");
        const viewPanel = document.querySelector(".view-controls-panel");
        const hideFlushed = document.querySelector('input[aria-label="Hide flushed ops"]');
        const split = document.querySelector('input[aria-label="Split lanes"]');
        const fixed = document.querySelector('input[aria-label="Fix op height"]');
        const navigator = document.querySelector('input[aria-label="Trace navigator"]');
        const arrows = document.querySelector('select[aria-label="Dependency arrow type"]');
        const theme = document.querySelector('select[aria-label="UI color theme"]');
        const color = document.querySelector('select[aria-label="Pipeline color scheme"]');
        const zoomSpeed = document.querySelector('select[aria-label="Zoom speed"]');
        const webGL = document.querySelector('input[aria-label="WebGL rendering"]');
        const tiledRendering = document.querySelector('input[aria-label="Tiled rendering"]');
        const compatibility = document.querySelector(".compatibility-settings");
        const textVisibility = document.querySelector('input[aria-label="Text labels visibility level"]');
        if (!(viewControls instanceof HTMLDetailsElement) ||
            !(viewPanel instanceof HTMLElement) ||
            !(hideFlushed instanceof HTMLInputElement) ||
            !(split instanceof HTMLInputElement) ||
            !(fixed instanceof HTMLInputElement) ||
            !(navigator instanceof HTMLInputElement) ||
            !(arrows instanceof HTMLSelectElement) ||
            !(theme instanceof HTMLSelectElement) ||
            !(color instanceof HTMLSelectElement) ||
            !(zoomSpeed instanceof HTMLSelectElement) ||
            !(webGL instanceof HTMLInputElement) ||
            !(tiledRendering instanceof HTMLInputElement) ||
            !(compatibility instanceof HTMLDetailsElement) ||
            !(textVisibility instanceof HTMLInputElement)) {
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
        inputSetter?.call(textVisibility, "4");
        textVisibility.dispatchEvent(new Event("input", {bubbles: true}));
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            staysOpenAfterInsideClick,
            closesAfterOutsideClick,
            split: split.checked,
            fixEnabled: !fixed.disabled,
            arrows: arrows.value,
            theme: document.querySelector(".trace-app")?.dataset.theme ?? null,
            color: color.value,
            webGL: webGL.checked,
            tiledRendering: tiledRendering.checked,
            compatibilityOpen: compatibility.open,
            textVisibility: textVisibility.value,
            checkboxesOnRight: [hideFlushed, split, fixed, navigator, webGL, tiledRendering]
                .every((control) => control.closest("label")?.lastElementChild === control)
        })));
    })`);
    if (!viewControlState.split ||
        !viewControlState.fixEnabled ||
        viewControlState.arrows !== "leftSideCurve" ||
        viewControlState.theme !== "light" ||
        viewControlState.color !== "Custom" ||
        !viewControlState.webGL ||
        !viewControlState.tiledRendering ||
        viewControlState.compatibilityOpen ||
        viewControlState.textVisibility !== "4" ||
        !viewControlState.checkboxesOnRight ||
        !viewControlState.staysOpenAfterInsideClick ||
        !viewControlState.closesAfterOutsideClick) {
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
        secondSplitterState.position !== "280" ||
        secondSplitterState.capturedPointers !== 0) {
        throw new Error(`Second tab splitter is incomplete: ${JSON.stringify(secondSplitterState)}`);
    }

    // 2枚を開いた後で、全Tab共通設定とgem5だけの設定を異なる値へ変更する。
    const secondTabSettingsState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const split = document.querySelector('input[aria-label="Split lanes"]');
        const arrows = document.querySelector('select[aria-label="Dependency arrow type"]');
        const theme = document.querySelector('select[aria-label="UI color theme"]');
        const color = document.querySelector('select[aria-label="Pipeline color scheme"]');
        const hideFlushed = document.querySelector('input[aria-label="Hide flushed ops"]');
        const textVisibility = document.querySelector('input[aria-label="Text labels visibility level"]');
        if (!(split instanceof HTMLInputElement) ||
            !(arrows instanceof HTMLSelectElement) ||
            !(theme instanceof HTMLSelectElement) ||
            !(color instanceof HTMLSelectElement) ||
            !(hideFlushed instanceof HTMLInputElement) ||
            !(textVisibility instanceof HTMLInputElement)) {
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
        inputSetter?.call(textVisibility, "6");
        textVisibility.dispatchEvent(new Event("input", {bubbles: true}));
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            split: split.checked,
            arrows: arrows.value,
            theme: document.querySelector(".trace-app")?.dataset.theme ?? null,
            color: color.value,
            hideFlushed: hideFlushed.checked,
            textVisibility: textVisibility.value
        })));
    })`);
    if (secondTabSettingsState.split ||
        secondTabSettingsState.arrows !== "notShow" ||
        secondTabSettingsState.theme !== "dark" ||
        secondTabSettingsState.color !== "RoyalBlue" ||
        !secondTabSettingsState.hideFlushed ||
        secondTabSettingsState.textVisibility !== "6") {
        throw new Error(`Second tab settings are incomplete: ${JSON.stringify(secondTabSettingsState)}`);
    }

    // 比較Tabは元の2つを残し、同じ表示領域をA・overlay・Bで切り替える。
    const comparisonState = await window.webContents.executeJavaScript(`(async () => {
        ${METHOD_OBSERVER_HELPER}
        const nextFrame = () => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let comparisonLayerCompositions = [];
        observeMethod(CanvasRenderingContext2D.prototype, "drawImage", function(args) {
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
        });
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
        restoreObservedMethods();
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
            const textVisibility = document.querySelector('input[aria-label="Text labels visibility level"]');
            const switched = {
                closeHasIcon: closePlain.querySelector("svg") !== null,
                fileName: root?.dataset.fileName ?? null,
                opCount: Number(root?.dataset.opCount ?? -1),
                theme: root?.dataset.theme ?? null,
                split: split instanceof HTMLInputElement && split.checked,
                arrows: arrows instanceof HTMLSelectElement ? arrows.value : null,
                color: color instanceof HTMLSelectElement ? color.value : null,
                hideFlushed: hideFlushed instanceof HTMLInputElement && hideFlushed.checked,
                textVisibility: textVisibility instanceof HTMLInputElement ? textVisibility.value : null,
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
                    remainingTextVisibility: document.querySelector('input[aria-label="Text labels visibility level"]')?.value ?? null,
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
        tabState.switched.textVisibility !== "6" ||
        tabState.switched.zoom !== "141%" ||
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
        tabState.remainingTextVisibility !== "6" ||
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
        ${METHOD_OBSERVER_HELPER}
        const prototype = CanvasRenderingContext2D.prototype;
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
        let alignedTileBlits = 0;
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
        observeMethod(prototype, "drawImage", function(args) {
            const source = args[0];
            if (this.canvas === pipeline && source instanceof HTMLCanvasElement &&
                !source.isConnected) {
                if (source.width === tileBackingSize && source.height === tileBackingSize) {
                    tileBlits++;
                    const edges = [args[1], args[2], args[1] + args[3], args[2] + args[4]];
                    if (edges.every((value) => {
                        const devicePixel = value * devicePixelRatio;
                        return Math.abs(devicePixel - Math.round(devicePixel)) < 0.000001;
                    })) {
                        alignedTileBlits++;
                    }
                    firstTileBlitOrder ??= ++operationOrder;
                }
                if (source.width === pipeline.width && source.height === pipeline.height) {
                    previousFrameBlits++;
                }
            }
        });
        observeMethod(prototype, "fillRect", function() {
            if (this.canvas instanceof HTMLCanvasElement && !this.canvas.isConnected &&
                this.canvas.width === tileBackingSize && this.canvas.height === tileBackingSize) {
                firstNewTileRenderOrder ??= ++operationOrder;
                const canvases = renderedTilesByFrame.get(frameIndex) ?? new Set();
                canvases.add(this.canvas);
                renderedTilesByFrame.set(frameIndex, canvases);
            }
        });
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
                alignedTileBlits,
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
            restoreObservedMethods();
            reset.click();
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    })()`);
    if (tileReuseState.tileBlits < 1 ||
        tileReuseState.alignedTileBlits !== tileReuseState.tileBlits ||
        tileReuseState.previousFrameBlits < 1 ||
        tileReuseState.firstTileBlitOrder === null ||
        tileReuseState.firstNewTileRenderOrder === null ||
        tileReuseState.firstTileBlitOrder >= tileReuseState.firstNewTileRenderOrder ||
        tileReuseState.maxNewTilesPerFrame < 1 ||
        tileReuseState.maxNewTilesPerFrame > 2) {
        throw new Error(`Pipeline tiles were not reused while scrolling: ${JSON.stringify(tileReuseState)}`);
    }

    // key repeatやResetで倍率差が広がっても、旧倍率の空tile座標を画面全体について探索しない。
    const extremeResetState = await window.webContents.executeJavaScript(`(async () => {
        ${METHOD_OBSERVER_HELPER}
        const prototype = CanvasRenderingContext2D.prototype;
        const pipeline = document.querySelector('.pipeline-pane canvas');
        const zoomSpeed = document.querySelector('select[aria-label="Zoom speed"]');
        const zoomOut = document.querySelector('button[aria-label="Zoom out"]');
        const reset = document.querySelector('button[aria-label="Reset view"]');
        const output = document.querySelector('.zoom-controls output');
        if (!(pipeline instanceof HTMLCanvasElement) || !(zoomSpeed instanceof HTMLSelectElement) ||
            !(zoomOut instanceof HTMLButtonElement) ||
            !(reset instanceof HTMLButtonElement) || !(output instanceof HTMLOutputElement)) {
            throw new Error("The extreme zoom reset controls were not found.");
        }
        const originalZoomSpeed = zoomSpeed.value;
        const tileBackingSize = Math.round(256 * devicePixelRatio);
        let overlappedTileBlits = 0;
        let observing = true;
        let previousFrame = performance.now();
        let maximumFrameGap = 0;
        const observeFrame = (time) => {
            maximumFrameGap = Math.max(maximumFrameGap, time - previousFrame);
            previousFrame = time;
            if (observing) requestAnimationFrame(observeFrame);
        };
        requestAnimationFrame(observeFrame);
        observeMethod(prototype, "drawImage", function(args) {
            const source = args[0];
            if (this.canvas === pipeline && source instanceof HTMLCanvasElement &&
                !source.isConnected && source.width === tileBackingSize &&
                source.height === tileBackingSize && args[3] > 256 && args[4] > 256) {
                overlappedTileBlits++;
            }
        });
        try {
            // animation途中のfallback tileを連続して再投影する。
            zoomSpeed.value = "fast";
            zoomSpeed.dispatchEvent(new Event("change", {bubbles: true}));
            reset.click();
            await new Promise((resolve) => setTimeout(resolve, 250));
            maximumFrameGap = 0;
            previousFrame = performance.now();
            const repeatBegin = performance.now();
            for (let index = 0; index < 10; index++) {
                zoomOut.click();
                await new Promise((resolve) => setTimeout(resolve, 33));
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
            const repeatedZoom = output.textContent;
            const repeatedZoomDuration = performance.now() - repeatBegin;
            const repeatedZoomMaximumFrameGap = maximumFrameGap;

            reset.click();
            await new Promise((resolve) => setTimeout(resolve, 250));
            overlappedTileBlits = 0;
            zoomSpeed.value = "normal";
            zoomSpeed.dispatchEvent(new Event("change", {bubbles: true}));
            for (let index = 0; index < 23; index++) {
                zoomOut.click();
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
            const zoomBeforeReset = output.textContent;
            const overlappedBeforeReset = overlappedTileBlits;
            const begin = performance.now();
            reset.click();
            const resetClickDuration = performance.now() - begin;
            await new Promise((resolve) => setTimeout(resolve, 300));
            return {
                zoomBeforeReset,
                zoomAfterReset: output.textContent,
                resetClickDuration,
                overlappedBeforeReset,
                repeatedZoom,
                repeatedZoomDuration,
                repeatedZoomMaximumFrameGap,
            };
        }
        finally {
            observing = false;
            restoreObservedMethods();
            zoomSpeed.value = originalZoomSpeed;
            zoomSpeed.dispatchEvent(new Event("change", {bubbles: true}));
            reset.click();
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    })()`);
    if (extremeResetState.zoomBeforeReset !== "0.0345%" ||
        extremeResetState.zoomAfterReset !== "100%" ||
        extremeResetState.overlappedBeforeReset < 1 ||
        extremeResetState.repeatedZoom !== "0.0977%" ||
        extremeResetState.repeatedZoomDuration >= 2000 ||
        extremeResetState.repeatedZoomMaximumFrameGap >= 1000 ||
        extremeResetState.resetClickDuration >= 1000) {
        throw new Error(`Extreme zoom reset stalled: ${JSON.stringify(extremeResetState)}`);
    }

    // 互換設定でタイリングを切ると、tile jobを止めて表示Canvasへ直接描画する。
    const tiledRenderingToggleState = await window.webContents.executeJavaScript(`(async () => {
        ${METHOD_OBSERVER_HELPER}
        const prototype = CanvasRenderingContext2D.prototype;
        const pipeline = document.querySelector('.pipeline-pane canvas');
        const viewer = document.querySelector('.viewer');
        const reset = document.querySelector('button[aria-label="Reset view"]');
        const webGL = document.querySelector('input[aria-label="WebGL rendering"]');
        const tiledRendering = document.querySelector('input[aria-label="Tiled rendering"]');
        if (!(pipeline instanceof HTMLCanvasElement) || !(viewer instanceof HTMLElement) ||
            !(reset instanceof HTMLButtonElement) || !(webGL instanceof HTMLInputElement) ||
            !(tiledRendering instanceof HTMLInputElement)) {
            throw new Error("The tiled rendering compatibility control was not found.");
        }
        const originalWebGL = webGL.checked;
        const originalTiledRendering = tiledRendering.checked;
        if (!originalTiledRendering) {
            throw new Error("Tiled rendering was not enabled by default.");
        }
        if (webGL.checked) {
            webGL.click();
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        const tileBackingSize = Math.round(256 * devicePixelRatio);
        let tileRenders = 0;
        let tileBlits = 0;
        let directFills = 0;
        observeMethod(prototype, "fillRect", function() {
            if (this.canvas === pipeline) {
                directFills++;
            }
            else if (this.canvas instanceof HTMLCanvasElement && !this.canvas.isConnected &&
                this.canvas.width === tileBackingSize && this.canvas.height === tileBackingSize) {
                tileRenders++;
            }
        });
        observeMethod(prototype, "drawImage", function(args) {
            const source = args[0];
            if (this.canvas === pipeline && source instanceof HTMLCanvasElement &&
                !source.isConnected && source.width === tileBackingSize && source.height === tileBackingSize) {
                tileBlits++;
            }
        });
        try {
            tiledRendering.click();
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const disabled = {
                enabled: tiledRendering.checked,
                directFills,
                tileRenders,
                tileBlits,
            };
            viewer.dispatchEvent(new WheelEvent("wheel", {
                deltaX: 100,
                deltaY: 0,
                bubbles: true,
                cancelable: true,
            }));
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const scrolled = {directFills, tileRenders, tileBlits};
            tiledRendering.click();
            await new Promise((resolve) => setTimeout(resolve, 500));
            return {
                disabled,
                scrolled,
                reenabled: {
                    enabled: tiledRendering.checked,
                    directFills,
                    tileRenders,
                    tileBlits,
                },
            };
        }
        finally {
            restoreObservedMethods();
            if (tiledRendering.checked !== originalTiledRendering) {
                tiledRendering.click();
            }
            if (webGL.checked !== originalWebGL) {
                webGL.click();
            }
            reset.click();
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    })()`);
    if (tiledRenderingToggleState.disabled.enabled ||
        tiledRenderingToggleState.disabled.directFills < 1 ||
        tiledRenderingToggleState.disabled.tileRenders !== 0 ||
        tiledRenderingToggleState.disabled.tileBlits !== 0 ||
        tiledRenderingToggleState.scrolled.directFills <= tiledRenderingToggleState.disabled.directFills ||
        tiledRenderingToggleState.scrolled.tileRenders !== 0 ||
        tiledRenderingToggleState.scrolled.tileBlits !== 0 ||
        !tiledRenderingToggleState.reenabled.enabled ||
        tiledRenderingToggleState.reenabled.tileRenders < 1 ||
        tiledRenderingToggleState.reenabled.tileBlits < 1) {
        throw new Error(
            `Tiled rendering compatibility setting is incomplete: ${JSON.stringify(tiledRenderingToggleState)}`,
        );
    }

    // stage名と経過cycle数は最初の描画だけoffscreenへ描き、次の描画ではBLTだけになる。
    const textAtlasState = await window.webContents.executeJavaScript(`(async () => {
        ${METHOD_OBSERVER_HELPER}
        const prototype = CanvasRenderingContext2D.prototype;
        const pipeline = document.querySelector('.pipeline-pane canvas');
        const theme = document.querySelector('select[aria-label="UI color theme"]');
        const colorScheme = document.querySelector('select[aria-label="Pipeline color scheme"]');
        const zoomSpeed = document.querySelector('select[aria-label="Zoom speed"]');
        const webGL = document.querySelector('input[aria-label="WebGL rendering"]');
        const zoomOut = document.querySelector('button[aria-label="Zoom out"]');
        const reset = document.querySelector('button[aria-label="Reset view"]');
        if (!(pipeline instanceof HTMLCanvasElement) ||
            !(theme instanceof HTMLSelectElement) ||
            !(colorScheme instanceof HTMLSelectElement) ||
            !(zoomSpeed instanceof HTMLSelectElement) ||
            !(webGL instanceof HTMLInputElement) ||
            !(zoomOut instanceof HTMLButtonElement) ||
            !(reset instanceof HTMLButtonElement)) {
            throw new Error("The text atlas controls were not found.");
        }
        const originalTheme = theme.value;
        const originalColorScheme = colorScheme.value;
        const originalZoomSpeed = zoomSpeed.value;
        const originalWebGL = webGL.checked;
        zoomSpeed.value = "normal";
        zoomSpeed.dispatchEvent(new Event("change", {bubbles: true}));
        // Canvas fallbackでも文字atlasのBLTを維持する。
        if (webGL.checked) {
            webGL.click();
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        let atlasFillTexts = 0;
        let pipelineFillTexts = 0;
        let pipelineBlits = 0;
        let smoothedPipelineBlits = 0;
        let unsmoothedPipelineBlits = 0;
        const generatedTileCanvases = new Set();
        const tileBackingSize = Math.round(256 * devicePixelRatio);
        const blitScales = [];
        observeMethod(prototype, "fillText", function() {
            if (this.canvas === pipeline) {
                pipelineFillTexts++;
            }
            else if (this.canvas instanceof HTMLCanvasElement && !this.canvas.isConnected) {
                atlasFillTexts++;
            }
        });
        observeMethod(prototype, "fillRect", function() {
            if (this.canvas instanceof HTMLCanvasElement && !this.canvas.isConnected &&
                this.canvas.width === tileBackingSize && this.canvas.height === tileBackingSize) {
                generatedTileCanvases.add(this.canvas);
            }
        });
        observeMethod(prototype, "drawImage", function(args) {
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
        });
        const nextFrame = () => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)));
        try {
            theme.value = "light";
            theme.dispatchEvent(new Event("change", {bubbles: true}));
            await new Promise((resolve) => setTimeout(resolve, 700));
            await nextFrame();
            const first = {
                atlasFillTexts,
                pipelineFillTexts,
                pipelineBlits,
                smoothedPipelineBlits,
                unsmoothedPipelineBlits,
                generatedTileCanvases: generatedTileCanvases.size,
                fullRingTileCount:
                    (Math.ceil(pipeline.clientWidth / 256) + 2) *
                    (Math.ceil(pipeline.clientHeight / 256) + 2),
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
            return {first, scaled, recolored};
        }
        finally {
            restoreObservedMethods();
            theme.value = originalTheme;
            theme.dispatchEvent(new Event("change", {bubbles: true}));
            colorScheme.value = originalColorScheme;
            colorScheme.dispatchEvent(new Event("change", {bubbles: true}));
            if (webGL.checked !== originalWebGL) {
                webGL.click();
            }
            zoomSpeed.value = originalZoomSpeed;
            zoomSpeed.dispatchEvent(new Event("change", {bubbles: true}));
            reset.click();
            await new Promise((resolve) => setTimeout(resolve, 250));
            await nextFrame();
        }
    })()`);
    if (textAtlasState.first.atlasFillTexts < 1 ||
        textAtlasState.first.generatedTileCanvases < 1 ||
        textAtlasState.first.generatedTileCanvases >= textAtlasState.first.fullRingTileCount ||
        textAtlasState.first.pipelineFillTexts !== 0 ||
        textAtlasState.first.pipelineBlits <= textAtlasState.first.atlasFillTexts ||
        textAtlasState.first.smoothedPipelineBlits !== 0 ||
        textAtlasState.first.unsmoothedPipelineBlits !== textAtlasState.first.pipelineBlits ||
        textAtlasState.scaled.atlasFillTexts < textAtlasState.first.atlasFillTexts ||
        textAtlasState.scaled.pipelineFillTexts !== 0 ||
        textAtlasState.scaled.pipelineBlits <= textAtlasState.first.pipelineBlits ||
        textAtlasState.scaled.smoothedPipelineBlits <= textAtlasState.first.smoothedPipelineBlits ||
        // zoom前／後のtileは中間倍率へ再投影するため、最終倍率70.7%までの縮小を許容する。
        textAtlasState.scaled.minimumBlitScale < 0.7 ||
        textAtlasState.scaled.minimumBlitScale >= 1 ||
        textAtlasState.scaled.zoom !== "70.7%" ||
        textAtlasState.recolored.atlasFillTexts !== textAtlasState.scaled.atlasFillTexts ||
        textAtlasState.recolored.pipelineFillTexts !== 0 ||
        textAtlasState.recolored.pipelineBlits <= textAtlasState.scaled.pipelineBlits) {
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
        ${METHOD_OBSERVER_HELPER}
        const glPrototype = globalThis.WebGL2RenderingContext?.prototype;
        const canvasPrototype = HTMLCanvasElement.prototype;
        const theme = document.querySelector('select[aria-label="UI color theme"]');
        const colorScheme = document.querySelector('select[aria-label="Pipeline color scheme"]');
        const dependencyType = document.querySelector('select[aria-label="Dependency arrow type"]');
        const webGLToggle = document.querySelector('input[aria-label="WebGL rendering"]');
        const zoomSpeed = document.querySelector('select[aria-label="Zoom speed"]');
        const zoomOut = document.querySelector('button[aria-label="Zoom out"]');
        const reset = document.querySelector('button[aria-label="Reset view"]');
        const pipeline = document.querySelector('.pipeline-pane canvas');
        if (glPrototype === undefined || !(theme instanceof HTMLSelectElement) ||
            !(colorScheme instanceof HTMLSelectElement) ||
            !(dependencyType instanceof HTMLSelectElement) ||
            !(webGLToggle instanceof HTMLInputElement) ||
            !(zoomSpeed instanceof HTMLSelectElement) ||
            !(zoomOut instanceof HTMLButtonElement) ||
            !(reset instanceof HTMLButtonElement) || !(pipeline instanceof HTMLCanvasElement)) {
            throw new Error("The WebGL2 simplified rendering controls were not found.");
        }
        const contextPrototype = CanvasRenderingContext2D.prototype;
        const originalTheme = theme.value;
        const originalColorScheme = colorScheme.value;
        const originalDependencyType = dependencyType.value;
        const originalWebGLEnabled = webGLToggle.checked;
        const originalZoomSpeed = zoomSpeed.value;
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
        observeMethod(canvasPrototype, "getContext", function(args, context) {
            const type = args[0];
            if (type === "webgl2") {
                webGLRequests++;
            }
            if (type === "webgl2" && context !== null) {
                webGLContexts++;
                acceleratedContext = context;
            }
        });
        observeMethod(glPrototype, "drawArraysInstanced", function(args) {
            acceleratedContext = this;
            drawCalls++;
            instances += args[3];
            maximumInstances = Math.max(maximumInstances, args[3]);
            if (args[0] === this.TRIANGLE_STRIP && args[2] === 72) {
                arrowDrawCalls++;
                arrowInstances += args[3];
            }
        });
        observeMethod(contextPrototype, "bezierCurveTo", function() {
            canvasBezierCurveCalls++;
        });
        observeMethod(glPrototype, "bufferData", function(args) {
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
        });
        observeMethod(glPrototype, "texImage2D", function(args) {
            const source = args.at(-1);
            if (source instanceof HTMLCanvasElement && source.width === 1024 && source.height === 512) {
                atlasUploads++;
            }
        });
        zoomSpeed.value = "normal";
        zoomSpeed.dispatchEvent(new Event("change", {bubbles: true}));
        theme.value = "light";
        theme.dispatchEvent(new Event("change", {bubbles: true}));
        colorScheme.value = "Depth";
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
        if (pixels !== undefined && fallbackPixels !== undefined && pixels.length === fallbackPixels.length) {
            for (let index = 0; index < pixels.length; index += 4) {
                let pixelDiffers = false;
                let pixelDifference = 0;
                for (let component = 0; component < 4; component++) {
                    const difference = Math.abs(pixels[index + component] - fallbackPixels[index + component]);
                    if (difference !== 0) {
                        pixelDiffers = true;
                        pixelDifference = Math.max(pixelDifference, difference);
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
        }
        const fallbackDrawCalls = drawCalls - drawCallsBeforeFallback;
        const fallbackBezierCurveCalls = canvasBezierCurveCalls - bezierCurveCallsBeforeFallback;
        loseContext.restoreContext();
        restoreObservedMethods();
        theme.value = originalTheme;
        theme.dispatchEvent(new Event("change", {bubbles: true}));
        colorScheme.value = originalColorScheme;
        colorScheme.dispatchEvent(new Event("change", {bubbles: true}));
        dependencyType.value = originalDependencyType;
        dependencyType.dispatchEvent(new Event("change", {bubbles: true}));
        if (webGLToggle.checked !== originalWebGLEnabled) {
            webGLToggle.click();
        }
        zoomSpeed.value = originalZoomSpeed;
        zoomSpeed.dispatchEvent(new Event("change", {bubbles: true}));
        reset.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {drawCalls, instances, maximumInstances, gradientInstances, strokeInstances,
            textInstances, interleavedText, atlasUploads, arrowDrawCalls, arrowInstances,
            enabledBezierCurveCalls, disabledBezierCurveCalls, fallbackBezierCurveCalls,
            opaquePixels, colorfulPixels,
            disabledOpaquePixels, disabledColorfulPixels, disabledDrawCalls,
            disabledWebGLRequests, reenabledDrawCalls,
            fallbackOpaquePixels, fallbackColorfulPixels, fallbackDrawCalls,
            differingPixels, noticeablyDifferingPixels, zoom,
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
        // native Canvasのrasterizerごとに文字と矢印edgeのcoverageは変わるため、
        // 単一画素の最大差ではなく、差のある面積だけで大きな形状崩れを検出する。
        webGLState.noticeablyDifferingPixels > webGLState.opaquePixels * 0.015 ||
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
        concurrentZstdState.stackedProgress?.count !== 2 ||
        concurrentZstdState.stackedProgress?.zIndex !== "100" ||
        concurrentZstdState.stackedProgress?.tops[1] -
            concurrentZstdState.stackedProgress?.tops[0] !== 3 ||
        !concurrentZstdState.stackedProgress?.colors.includes("rgb(180, 180, 180)") ||
        !concurrentZstdState.stackedProgress?.colors.includes("rgb(77, 136, 255)") ||
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
        const result = {
            title: dialog.querySelector("h2")?.textContent ?? null,
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
            storedColor: stored?.customColorScheme?.["0"]?.F ?? null
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
        customColorState.initialRows <= 0 ||
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
        customColorState.storedColor?.h !== 210 ||
        customColorState.storedColor?.s !== 25 ||
        customColorState.storedColor?.l !== "auto" ||
        !customColorState.closed ||
        !customColorState.editHidden) {
        throw new Error(`Custom color editor is incomplete: ${JSON.stringify(customColorState)}`);
    }

    // toolbarの外側状態は最終倍率へ進み、Canvasは旧倍率tileを拡縮しながら最終tileを先行生成する。
    const zoomAnimationState = await window.webContents.executeJavaScript(`(async () => {
        ${METHOD_OBSERVER_HELPER}
        const prototype = CanvasRenderingContext2D.prototype;
        const pipeline = document.querySelector('.pipeline-pane canvas');
        const output = document.querySelector(".zoom-controls output");
        const tiledRendering = document.querySelector('input[aria-label="Tiled rendering"]');
        if (!(pipeline instanceof HTMLCanvasElement) || !(tiledRendering instanceof HTMLInputElement)) {
            throw new Error("The animated tiled zoom controls were not found.");
        }
        // 旧倍率だけを完成状態にし、最終倍率が既存cacheへ当たらない条件を作る。
        tiledRendering.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        tiledRendering.click();
        await new Promise((resolve) => setTimeout(resolve, 700));
        const tileBackingSize = Math.round(256 * devicePixelRatio);
        let generatedTargetTiles = 0;
        let scaledTileBlits = 0;
        observeMethod(prototype, "fillRect", function() {
            if (this.canvas instanceof HTMLCanvasElement && !this.canvas.isConnected &&
                this.canvas.width === tileBackingSize && this.canvas.height === tileBackingSize) {
                generatedTargetTiles++;
            }
        });
        observeMethod(prototype, "drawImage", function(args) {
            const source = args[0];
            if (this.canvas === pipeline && this.imageSmoothingEnabled &&
                source instanceof HTMLCanvasElement && !source.isConnected &&
                source.width === tileBackingSize && source.height === tileBackingSize) {
                scaledTileBlits++;
            }
        });
        const before = output?.textContent ?? null;
        try {
            document.querySelector('button[aria-label="Zoom in"]')?.click();
            const immediatelyAfter = output?.textContent ?? null;
            await new Promise((resolve) => requestAnimationFrame(() =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))));
            return {
                before,
                immediatelyAfter,
                middle: output?.textContent ?? null,
                generatedTargetTiles,
                scaledTileBlits,
            };
        }
        finally {
            restoreObservedMethods();
        }
    })()`);
    if (zoomAnimationState.before !== "100%" || zoomAnimationState.immediatelyAfter !== "100%" ||
        zoomAnimationState.middle !== "141%" ||
        zoomAnimationState.generatedTargetTiles < 1 || zoomAnimationState.scaledTileBlits < 1) {
        throw new Error(`Zoom animation tiling is incomplete: ${JSON.stringify(zoomAnimationState)}`);
    }
    await waitForViewAnimation(window);
    const zoomedState = await readRenderedState(window);
    if (zoomedState.zoom !== "141%" || zoomedState.nonBackgroundPixels < 100) {
        throw new Error(`Zoom rendering is incomplete: ${JSON.stringify(zoomedState)}`);
    }

    // 非既定のthemeとWebGL設定を保存し、Tab表示だけのlane分割は保存値へ混ぜない。
    const viewSettingsSetupState = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const theme = document.querySelector('select[aria-label="UI color theme"]');
        const split = document.querySelector('input[aria-label="Split lanes"]');
        const zoomSpeed = document.querySelector('select[aria-label="Zoom speed"]');
        const webGL = document.querySelector('input[aria-label="WebGL rendering"]');
        const tiledRendering = document.querySelector('input[aria-label="Tiled rendering"]');
        if (!(theme instanceof HTMLSelectElement) ||
            !(split instanceof HTMLInputElement) ||
            !(zoomSpeed instanceof HTMLSelectElement) ||
            !(webGL instanceof HTMLInputElement) ||
            !(tiledRendering instanceof HTMLInputElement)) {
            throw new Error("The view settings controls were not found.");
        }
        theme.value = "light";
        theme.dispatchEvent(new Event("change", {bubbles: true}));
        split.click();
        zoomSpeed.value = "normal";
        zoomSpeed.dispatchEvent(new Event("change", {bubbles: true}));
        webGL.click();
        tiledRendering.click();
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const stored = JSON.parse(localStorage.getItem("konata.viewSettings") ?? "null");
            resolve({
                theme: document.querySelector(".trace-app")?.dataset.theme ?? null,
                split: split.checked,
                zoomSpeed: zoomSpeed.value,
                webGL: webGL.checked,
                tiledRendering: tiledRendering.checked,
                stored,
                storesSplitLanes: stored !== null && "splitLanes" in stored,
                storesLegacyLaneHeight: stored !== null && "drawTextThreshold" in stored
            });
        }));
    })`);
    if (viewSettingsSetupState.theme !== "light" ||
        !viewSettingsSetupState.split ||
        viewSettingsSetupState.zoomSpeed !== "normal" ||
        viewSettingsSetupState.webGL ||
        viewSettingsSetupState.tiledRendering ||
        viewSettingsSetupState.stored?.theme !== "light" ||
        viewSettingsSetupState.stored?.drawZoomFactor !== 2 ||
        viewSettingsSetupState.stored?.webGLEnabled !== false ||
        viewSettingsSetupState.stored?.tiledRenderingEnabled !== false ||
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
            webGL: document.querySelector('input[aria-label="WebGL rendering"]')?.checked ?? null,
            tiledRendering: document.querySelector('input[aria-label="Tiled rendering"]')?.checked ?? null,
            textVisibility: document.querySelector('input[aria-label="Text labels visibility level"]')?.value ?? null,
            zoomSpeed: document.querySelector('select[aria-label="Zoom speed"]')?.value ?? null,
            zoom: document.querySelector(".zoom-controls output")?.textContent ?? null
        };
    })()`);
    if (persistedViewSettingsState.theme !== "light" ||
        persistedViewSettingsState.split ||
        persistedViewSettingsState.webGL ||
        persistedViewSettingsState.tiledRendering ||
        persistedViewSettingsState.textVisibility !== "6" ||
        persistedViewSettingsState.zoomSpeed !== "normal" ||
        persistedViewSettingsState.zoom !== "141%") {
        throw new Error(`View settings persistence is incomplete: ${JSON.stringify(persistedViewSettingsState)}`);
    }

    // 旧Webのthreshold名と新しい設定の欠落、Custom部分の破損が重なっても他の設定を維持する。
    await window.webContents.executeJavaScript(`(() => {
        const stored = JSON.parse(localStorage.getItem("konata.viewSettings") ?? "null");
        stored.drawTextThreshold = stored.textLabelMinimumLaneHeight;
        delete stored.textLabelMinimumLaneHeight;
        delete stored.drawZoomFactor;
        delete stored.webGLEnabled;
        delete stored.tiledRenderingEnabled;
        stored.colorScheme = "Auto";
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
        const restoredColor = color.value;
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
            restoredColor,
            textVisibility: document.querySelector(
                'input[aria-label="Text labels visibility level"]',
            )?.value ?? null,
            zoomSpeed: document.querySelector('select[aria-label="Zoom speed"]')?.value ?? null,
            webGL: document.querySelector('input[aria-label="WebGL rendering"]')?.checked ?? null,
            tiledRendering: document.querySelector('input[aria-label="Tiled rendering"]')?.checked ?? null,
            defaultHue: document.querySelector('input[aria-label="Default hue"]')?.value ?? null,
            migratedLaneHeight: migrated?.textLabelMinimumLaneHeight ?? null,
            removedLegacyLaneHeight: migrated !== null && !("drawTextThreshold" in migrated)
        };
        document.querySelector('.custom-color-dialog button[aria-label="Close custom colors"]')?.click();
        await nextFrame();
        return result;
    })()`);
    if (recoveredCustomColorState.theme !== "light" ||
        recoveredCustomColorState.restoredColor !== "Depth" ||
        recoveredCustomColorState.textVisibility !== "6" ||
        recoveredCustomColorState.zoomSpeed !== "normal" ||
        !recoveredCustomColorState.webGL ||
        !recoveredCustomColorState.tiledRendering ||
        recoveredCustomColorState.defaultHue !== "100" ||
        recoveredCustomColorState.migratedLaneHeight !== 3 ||
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
            textVisibility: document.querySelector('input[aria-label="Text labels visibility level"]')?.value ?? null,
            zoomSpeed: document.querySelector('select[aria-label="Zoom speed"]')?.value ?? null,
            webGL: document.querySelector('input[aria-label="WebGL rendering"]')?.checked ?? null,
            tiledRendering: document.querySelector('input[aria-label="Tiled rendering"]')?.checked ?? null,
            labelWidth: Math.round(document.querySelector('.label-pane')?.getBoundingClientRect().width ?? -1)
        })));
    })`);
    if (recoveredViewSettingsState.theme !== "dark" ||
        recoveredViewSettingsState.arrows !== "insideLine" ||
        recoveredViewSettingsState.color !== "Unique" ||
        recoveredViewSettingsState.textVisibility !== "3" ||
        recoveredViewSettingsState.zoomSpeed !== "normal" ||
        !recoveredViewSettingsState.webGL ||
        !recoveredViewSettingsState.tiledRendering ||
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
}

app.whenReady()
    .then(run)
    .then(() => app.exit(0))
    .catch((error) => {
        console.error("Web smoke test failed:", error);
        app.exit(1);
    });
