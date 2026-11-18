import { Redo2, Sliders, Undo2 } from "lucide-react";
import { useState } from "react";
import { useTaktStore } from "../store/useTaktStore";
import { FixtureGrid2D } from "./FixtureGrid2D";
import { PalettesAndControls } from "./PalettesAndControls";
import { SceneAndFxManager } from "./SceneAndFxManager";

type StudioSectionFilter = "all" | "grid" | "scenes" | "palettes";

export function StudioWorkspace() {
  const canUndo = useTaktStore((s) => s.canUndo);
  const canRedo = useTaktStore((s) => s.canRedo);
  const undoShow = useTaktStore((s) => s.undoShow);
  const redoShow = useTaktStore((s) => s.redoShow);

  const [section, setSection] = useState<StudioSectionFilter>("all");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate border border-steel rounded-panel px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <Sliders className="w-4 h-4 text-ember" />
          <h2 className="font-sans text-sm font-semibold text-frost">
            Studio Workspace
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-ink border border-steel rounded p-0.5 font-mono text-xs">
            {(
              [
                { id: "all", label: "All" },
                { id: "grid", label: "2D Grid" },
                { id: "scenes", label: "Scenes & FX" },
                { id: "palettes", label: "Palettes" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={section === opt.id}
                onClick={() => setSection(opt.id)}
                className={`px-2.5 py-1 rounded transition-colors ${
                  section === opt.id
                    ? "bg-ember text-frost font-semibold"
                    : "text-fog hover:text-mist"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={!canUndo}
            onClick={() => void undoShow()}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-steel bg-ink font-mono text-xs text-mist hover:border-ember disabled:opacity-40"
          >
            <Undo2 className="w-3.5 h-3.5" />
            <span>Undo</span>
          </button>

          <button
            type="button"
            disabled={!canRedo}
            onClick={() => void redoShow()}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-steel bg-ink font-mono text-xs text-mist hover:border-ember disabled:opacity-40"
          >
            <Redo2 className="w-3.5 h-3.5" />
            <span>Redo</span>
          </button>
        </div>
      </div>

      {(section === "all" || section === "grid") && (
        <FixtureGrid2D hideUndoRedo />
      )}
      {(section === "all" || section === "scenes") && (
        <SceneAndFxManager hideUndoRedo />
      )}
      {(section === "all" || section === "palettes") && (
        <PalettesAndControls hideUndoRedo />
      )}
    </div>
  );
}
