import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";

const root = document.querySelector<HTMLElement>("#konata-root");

if (root === null) {
    throw new Error("The Konata mount point was not found.");
}

// 段階移植中の副作用を早期に検出できるよう、開発時からStrictModeを有効にしておく。
createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
