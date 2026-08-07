import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

const root = document.querySelector<HTMLElement>("#konata-root");

if (root === null) {
    throw new Error("Konata Webのマウント先が見つかりません。");
}

// 段階移植中の副作用を早期に検出できるよう、開発時からStrictModeを有効にしておく。
createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
