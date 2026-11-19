import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { BottomNavBar } from "./components/BottomNavBar";
import { DmxMonitor } from "./components/DmxMonitor";
import { FixtureBuilder } from "./components/FixtureBuilder";
import { JitterHistogram } from "./components/JitterHistogram";
import { PatchView } from "./components/PatchView";
import { StudioWorkspace } from "./components/StudioWorkspace";
import { TimelineEditor } from "./components/TimelineEditor";
import { TopStatusBar } from "./components/TopStatusBar";
import { isTauriEnvironment, useTaktStore } from "./store/useTaktStore";

export function App() {
  const activeTab = useTaktStore((s) => s.activeTab);
  const histogramOpen = useTaktStore((s) => s.histogramOpen);
  const initEngineConnection = useTaktStore((s) => s.initEngineConnection);
  const isDirty = useTaktStore((s) => s.isDirty);
  const closePromptOpen = useTaktStore((s) => s.closePromptOpen);
  const setClosePromptOpen = useTaktStore((s) => s.setClosePromptOpen);
  const saveProjectToFile = useTaktStore((s) => s.saveProjectToFile);

  useEffect(() => {
    const disconnect = initEngineConnection();
    return () => {
      disconnect();
    };
  }, [initEngineConnection]);

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
            useTaktStore.getState().setClosePromptOpen(true);
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

  const forceCloseWindow = async () => {
    if (isTauriEnvironment()) {
      try {
        await getCurrentWindow().destroy();
      } catch {
        // Ignore in tests
      }
    }
  };

  const isStudio =
    activeTab === "studio" ||
    activeTab === "grid" ||
    activeTab === "palettes" ||
    activeTab === "scenes";

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
        {activeTab === "timeline" && <TimelineEditor />}
        {activeTab === "fixtures" && <FixtureBuilder />}
      </main>
      <BottomNavBar />

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
              You have unsaved changes in your current project
              {isDirty ? "" : ""}. Do you want to save before closing?
            </p>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setClosePromptOpen(false)}
                className="px-3 py-1.5 rounded border border-steel bg-ink text-xs font-mono text-mist hover:border-fog"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setClosePromptOpen(false);
                  void forceCloseWindow();
                }}
                className="px-3 py-1.5 rounded border border-signal/70 bg-signal/20 text-xs font-mono text-frost hover:bg-signal/35"
              >
                Don&apos;t Save
              </button>
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const saved = await saveProjectToFile();
                    if (saved) {
                      setClosePromptOpen(false);
                      await forceCloseWindow();
                    }
                  })();
                }}
                className="px-3 py-1.5 rounded bg-ember hover:bg-burnt text-xs font-mono font-semibold text-frost"
              >
                Save &amp; Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
