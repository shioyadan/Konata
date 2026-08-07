export function App() {
    // Phase 1BではReactの境界だけを確立し、既存Riot UIやStoreはまだ接続しない。
    return (
        <main className="app-shell">
            <h1>Konata Web</h1>
            <p className="status">The React web shell is ready.</p>
            <p className="note">The Electron version remains available with make run during migration.</p>
        </main>
    );
}
