import { useEffect } from "react";
import { DmxMonitor } from "./components/DmxMonitor";
import { FixtureBuilder } from "./components/FixtureBuilder";
import { FixtureGrid2D } from "./components/FixtureGrid2D";
import { JitterHistogram } from "./components/JitterHistogram";
import { PalettesAndControls } from "./components/PalettesAndControls";
import { PatchView } from "./components/PatchView";
import { SceneAndFxManager } from "./components/SceneAndFxManager";
import { TimelineEditor } from "./components/TimelineEditor";
import { TopStatusBar } from "./components/TopStatusBar";
import { useTaktStore } from "./store/useTaktStore";

export function App() {
  const activeTab = useTaktStore((s) => s.activeTab);
  const histogramOpen = useTaktStore((s) => s.histogramOpen);
  const initEngineConnection = useTaktStore((s) => s.initEngineConnection);

  useEffect(() => {
    const disconnect = initEngineConnection();
    return () => {
      disconnect();
    };
  }, [initEngineConnection]);

  return (
    <div className="min-h-screen bg-void text-mist font-sans flex flex-col">
      <TopStatusBar />
      <main className="flex-1 p-4 flex flex-col gap-4 max-w-[1920px] w-full mx-auto">
        {activeTab === "monitor" && (
          <>
            {histogramOpen && <JitterHistogram />}
            <DmxMonitor />
          </>
        )}
        {activeTab === "patch" && <PatchView />}
        {activeTab === "grid" && <FixtureGrid2D />}
        {activeTab === "palettes" && <PalettesAndControls />}
        {activeTab === "scenes" && <SceneAndFxManager />}
        {activeTab === "timeline" && <TimelineEditor />}
        {activeTab === "fixtures" && <FixtureBuilder />}
      </main>
    </div>
  );
}

export default App;
