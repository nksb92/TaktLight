import { useEffect } from "react";
import { BottomNavBar } from "./components/BottomNavBar";
import { DmxMonitor } from "./components/DmxMonitor";
import { FixtureBuilder } from "./components/FixtureBuilder";
import { JitterHistogram } from "./components/JitterHistogram";
import { PatchView } from "./components/PatchView";
import { StudioWorkspace } from "./components/StudioWorkspace";
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

  const isStudio =
    activeTab === "studio" ||
    activeTab === "grid" ||
    activeTab === "palettes" ||
    activeTab === "scenes";

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
        {isStudio && <StudioWorkspace />}
        {activeTab === "timeline" && <TimelineEditor />}
        {activeTab === "fixtures" && <FixtureBuilder />}
      </main>
      <BottomNavBar />
    </div>
  );
}

export default App;
