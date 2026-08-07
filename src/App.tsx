export function App() {
    // Phase 1BではReactの境界だけを確立し、既存Riot UIやStoreはまだ接続しない。
    return (
        <main className="app-shell">
            <h1>Konata Web</h1>
            <p className="status">React版の最小画面を準備しました。</p>
            <p className="note">移行中もElectron版は make run で起動できます。</p>
        </main>
    );
}
