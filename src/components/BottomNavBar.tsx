import { Cable, Layers, LayoutGrid, Monitor } from "lucide-react";
import { useTaktStore } from "../store/useTaktStore";

export function BottomNavBar() {
  const activeTab = useTaktStore((s) => s.activeTab);
  const setActiveTab = useTaktStore((s) => s.setActiveTab);

  const isStudio =
    activeTab === "studio" ||
    activeTab === "grid" ||
    activeTab === "palettes" ||
    activeTab === "scenes" ||
    activeTab === "timeline";

  return (
    <footer
      data-testid="bottom-nav-dock"
      className="sticky bottom-0 z-30 bg-slate-dark/95 backdrop-blur border-t-[1.5px] border-steel px-4 py-2 flex justify-center"
    >
      <nav
        aria-label="Workspace Views"
        className="flex flex-wrap items-center justify-center gap-1.5 bg-ink border border-steel rounded-panel p-1 shadow-lg"
      >
        <button
          type="button"
          aria-pressed={activeTab === "patch"}
          onClick={() => setActiveTab("patch")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-sans text-xs font-medium transition-colors ${
            activeTab === "patch"
              ? "bg-ember text-frost"
              : "text-fog hover:text-mist"
          }`}
        >
          <Cable className="w-3.5 h-3.5" />
          <span>Patch</span>
        </button>

        <button
          type="button"
          aria-pressed={isStudio}
          onClick={() => setActiveTab("studio")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-sans text-xs font-medium transition-colors ${
            isStudio ? "bg-ember text-frost" : "text-fog hover:text-mist"
          }`}
        >
          <LayoutGrid className="w-3.5 h-3.5" />
          <span>Studio / 2D Grid</span>
        </button>

        <button
          type="button"
          aria-pressed={activeTab === "fixtures"}
          onClick={() => setActiveTab("fixtures")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-sans text-xs font-medium transition-colors ${
            activeTab === "fixtures"
              ? "bg-ember text-frost"
              : "text-fog hover:text-mist"
          }`}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>Fixtures</span>
        </button>

        <button
          type="button"
          aria-pressed={activeTab === "monitor"}
          onClick={() => setActiveTab("monitor")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-sans text-xs font-medium transition-colors ${
            activeTab === "monitor"
              ? "bg-ember text-frost"
              : "text-fog hover:text-mist"
          }`}
        >
          <Monitor className="w-3.5 h-3.5" />
          <span>Monitor</span>
        </button>
      </nav>
    </footer>
  );
}
