import type { LoadState } from "./trace_sheet";

export interface TabBarItem {
    readonly id: number;
    readonly fileName: string;
    readonly loadState: LoadState;
}

interface TabBarProps {
    readonly tabs: readonly TabBarItem[];
    readonly activeTabID: number | null;
    readonly onActivate: (id: number) => void;
    readonly onClose: (id: number) => void;
}

// 旧app_tabbarと同じく、ファイル名による選択と明示的なcloseだけを担当する。
export function TabBar({ tabs, activeTabID, onActivate, onClose }: TabBarProps) {
    if (tabs.length === 0) {
        return null;
    }
    return (
        <nav className="tab-bar" aria-label="Open traces">
            <div role="tablist">
                {tabs.map((tab) => (
                    <div
                        className={`trace-tab${tab.id === activeTabID ? " is-active" : ""}`}
                        data-load-state={tab.loadState}
                        key={tab.id}
                    >
                        <button
                            className="trace-tab-activate"
                            type="button"
                            role="tab"
                            aria-selected={tab.id === activeTabID}
                            onClick={() => onActivate(tab.id)}
                        >
                            {tab.fileName}
                        </button>
                        <button
                            className="trace-tab-close"
                            type="button"
                            aria-label={`Close ${tab.fileName}`}
                            onClick={() => onClose(tab.id)}
                        >
                            ×
                        </button>
                    </div>
                ))}
            </div>
        </nav>
    );
}
