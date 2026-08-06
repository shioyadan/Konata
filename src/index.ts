import "./styles.css";

const root = document.querySelector<HTMLElement>("#konata-root");

if (root === null) {
    throw new Error("Konata Webのマウント先が見つかりません。");
}

// Phase 1Aではビルド基盤とReact導入を切り分けるため、DOM APIだけで最小画面を作る。
// この部分はPhase 1Bで同じ表示内容を持つReact rootへ置き換える。
const main = document.createElement("main");
main.className = "app-shell";

const heading = document.createElement("h1");
heading.textContent = "Konata Web";

const status = document.createElement("p");
status.className = "status";
status.textContent = "Web版のビルド基盤を準備しました。";

const note = document.createElement("p");
note.className = "note";
note.textContent = "移行中もElectron版は make run で起動できます。";

main.append(heading, status, note);
root.append(main);
