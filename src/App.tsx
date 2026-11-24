import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { BottomNavBar } from "./components/BottomNavBar";
import { DmxMonitor } from "./components/DmxMonitor";
import { FixtureBuilder } from "./components/FixtureBuilder";
import { JitterHistogram } from "./components/JitterHistogram";
import { MissingAudioModal } from "./components/MissingAudioModal";
import { PatchView } from "./components/PatchView";
import { StudioWorkspace } from "./components/StudioWorkspace";
import { TopStatusBar } from "./components/TopStatusBar";
import { isTauriEnvironment, useTaktStore } from "./store/useTaktStore";

export function App() {
  const activeTab = useTaktStore((s) => s.activeTab);
  const histogramOpen = useTaktStore((s) => s.histogramOpen);
  const initEngineConnection = useTaktStore((s) => s.initEngineConnection);
  const closePromptOpen = useTaktStore((s) => s.closePromptOpen);
  const pendingUnsavedAction = useTaktStore((s) => s.pendingUnsavedAction);
  const cancelUnsavedAction = useTaktStore((s) => s.cancelUnsavedAction);
  const confirmUnsavedAction = useTaktStore((s) => s.confirmUnsavedAction);

  useEffect(() => {
    const disconnect = initEngineConnection();
    if (isTauriEnvironment()) {
      const raf = requestAnimationFrame(() => {
        void invoke("close_splashscreen").catch(() => undefined);
      });
      return () => {
        cancelAnimationFrame(raf);
        disconnect();
      };
    }
    return () => {
      disconnect();
    };
  }, [initEngineConnection]);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "TEXTAREA" || target.isContentEditable) {
          return;
        }
        if (tag === "INPUT") {
          const inputType = ((target as HTMLInputElement).type || "text").toLowerCase();
          if (
            inputType === "text" ||
            inputType === "number" ||
            inputType === "search" ||
            inputType === "url" ||
            inputType === "email" ||
            inputType === "password" ||
            inputType === "tel"
          ) {
            return;
          }
        }
      }
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const win = getCurrentWindow();
        const fn = await win.onCloseRequested((event) => {
          if (useTaktStore.getState().isDirty) {
            event.preventDefault();
            void useTaktStore
              .getState()
              .requestProjectAction({ type: "close_window" });
          }
        });
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      } catch {
        // Ignore outside full Tauri webview
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useTaktStore.getState().isDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const unsavedActionType = pendingUnsavedAction?.type ?? "close_window";
  const unsavedPromptBody =
    unsavedActionType === "new_project"
      ? "You have unsaved changes in your current project. Do you want to save before creating a new project?"
      : unsavedActionType === "open_project" || unsavedActionType === "open_recent"
        ? "You have unsaved changes in your current project. Do you want to save before opening another project?"
        : unsavedActionType === "close_project"
          ? "You have unsaved changes in your current project. Do you want to save before closing this project?"
          : "You have unsaved changes in your current project. Do you want to save before closing?";
  const unsavedSaveLabel =
    unsavedActionType === "new_project"
      ? "Save & New"
      : unsavedActionType === "open_project" || unsavedActionType === "open_recent"
        ? "Save & Open"
        : "Save & Close";

  const isStudio =
    activeTab === "studio" ||
    activeTab === "grid" ||
    activeTab === "palettes" ||
    activeTab === "scenes" ||
    activeTab === "timeline";

  return (
    <div
      className={
        isStudio
          ? "h-screen overflow-hidden bg-void text-mist font-sans flex flex-col"
          : "min-h-screen bg-void text-mist font-sans flex flex-col"
      }
    >
      <TopStatusBar />
      <main
        className={
          isStudio
            ? "flex-1 min-h-0 p-1.5 flex flex-col gap-1.5 w-full"
            : "flex-1 p-4 flex flex-col gap-4 max-w-[1920px] w-full mx-auto"
        }
      >
        {activeTab === "monitor" && (
          <>
            {histogramOpen && <JitterHistogram />}
            <DmxMonitor />
          </>
        )}
        {activeTab === "patch" && <PatchView />}
        {isStudio && <StudioWorkspace />}
        {activeTab === "fixtures" && <FixtureBuilder />}
      </main>
      <BottomNavBar />
      <MissingAudioModal />

      {closePromptOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Unsaved Show Changes"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
        >
          <div className="w-full max-w-md rounded-panel border border-steel bg-slate-dark p-4 shadow-2xl flex flex-col gap-3">
            <h2 className="font-sans text-sm font-semibold text-frost">
              Unsaved Show Changes
            </h2>
            <p className="text-xs text-mist leading-relaxed">
              {unsavedPromptBody}
            </p>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => cancelUnsavedAction()}
                className="px-3 py-1.5 rounded border border-steel bg-ink text-xs font-mono text-mist hover:border-fog"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void confirmUnsavedAction(false);
                }}
                className="px-3 py-1.5 rounded border border-signal/70 bg-signal/20 text-xs font-mono text-frost hover:bg-signal/35"
              >
                Don&apos;t Save
              </button>
              <button
                type="button"
                onClick={() => {
                  void confirmUnsavedAction(true);
                }}
                className="px-3 py-1.5 rounded bg-ember hover:bg-burnt text-xs font-mono font-semibold text-frost"
              >
                {unsavedSaveLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
