import { TraceViewer } from "./components/TraceViewer";

export function App() {
    // Reactがfile inputと2枚のcanvasを所有し、Rendererはcanvas内部だけを更新する。
    return <TraceViewer />;
}
