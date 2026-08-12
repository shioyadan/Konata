import { BsX } from "react-icons/bs";

import type { LoadState } from "../store";

interface TraceTabBarItem {
    readonly id: number;
    readonly kind: "trace";
    readonly fileName: string;
    readonly loadState: LoadState;
}

interface ComparisonTabBarItem {
    readonly id: number;
    readonly kind: "comparison";
    readonly fileName: string;
    readonly baselineFileName: string;
    readonly candidateFileName: string;
    readonly loadState: LoadState;
}

export type TabBarItem = TraceTabBarItem | ComparisonTabBarItem;

interface TabBarProps {
    readonly tabs: readonly TabBarItem[];
    readonly activeTabID: number | null;
    readonly onActivate: (id: number) => void;
    readonly onClose: (id: number) => void;
}

// 旧app_tabbarと同じくファイル名で選択し、×または一般的なmiddle clickで閉じる。
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
                        data-tab-kind={tab.kind}
                        data-load-state={tab.loadState}
                        key={tab.id}
                        onMouseDown={(event) => {
                            if (event.button === 1) {
                                // middle clickのauto-scrollを開始せず、mouseup後のauxclickだけで閉じる。
                                event.preventDefault();
                            }
                        }}
                        onAuxClick={(event) => {
                            if (event.button === 1) {
                                event.preventDefault();
                                onClose(tab.id);
                            }
                        }}
                    >
                        <button
                            className="trace-tab-activate"
                            type="button"
                            role="tab"
                            aria-selected={tab.id === activeTabID}
                            title={tab.kind === "comparison"
                                ? `A: ${tab.baselineFileName}\nB: ${tab.candidateFileName}`
                                : tab.fileName}
                            onClick={() => onActivate(tab.id)}
                        >
                            {tab.fileName}
                        </button>
                        <button
                            className="trace-tab-close"
                            type="button"
                            aria-label={`Close ${tab.fileName}`}
                            title={`Close ${tab.fileName}`}
                            onClick={() => onClose(tab.id)}
                        >
                            <BsX aria-hidden="true" />
                        </button>
                    </div>
                ))}
            </div>
        </nav>
    );
}
