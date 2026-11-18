import { Plus, Redo2, Sliders, Trash2, Undo2, Users } from "lucide-react";
import { useState } from "react";
import type { OrderRuleStr } from "../lib/patchLogic";
import { useTaktStore } from "../store/useTaktStore";
import { FixtureGrid2D } from "./FixtureGrid2D";
import { PalettesAndControls } from "./PalettesAndControls";
import { SceneAndFxManager } from "./SceneAndFxManager";

function slugGroupId(name: string, existingIds: string[]): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = `grp_${clean || "group"}`;
  if (!existingIds.includes(base)) return base;
  let suffix = 2;
  while (existingIds.includes(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

export function StudioWorkspace() {
  const showState = useTaktStore((s) => s.showState);
  const canUndo = useTaktStore((s) => s.canUndo);
  const canRedo = useTaktStore((s) => s.canRedo);
  const undoShow = useTaktStore((s) => s.undoShow);
  const redoShow = useTaktStore((s) => s.redoShow);
  const upsertGroup = useTaktStore((s) => s.upsertGroup);
  const deleteGroup = useTaktStore((s) => s.deleteGroup);

  const [selectedGroupId, setSelectedGroupId] = useState<string>("all");
  const [groupName, setGroupName] = useState("Stage Front");
  const [groupOrder, setGroupOrder] = useState<OrderRuleStr>("center_out");
  const [groupTargets, setGroupTargets] = useState(
    showState.patch[0]?.id ?? "fx_001",
  );

  const handleSaveGroup = async () => {
    const id = slugGroupId(
      groupName,
      showState.groups.map((g) => g.id),
    );
    const targets = groupTargets
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await upsertGroup({
      id,
      name: groupName.trim() || "Group",
      order: groupOrder,
      targets,
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Slim Daslight Workspace Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate border border-steel rounded-panel px-3 py-2">
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-ember" />
          <h2 className="font-sans text-sm font-semibold text-frost">
            Control Studio
          </h2>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!canUndo}
            onClick={() => void undoShow()}
            className="flex items-center gap-1 px-2.5 py-1 rounded border border-steel bg-ink font-mono text-xs text-mist hover:border-ember disabled:opacity-40"
          >
            <Undo2 className="w-3.5 h-3.5" />
            <span>Undo</span>
          </button>

          <button
            type="button"
            disabled={!canRedo}
            onClick={() => void redoShow()}
            className="flex items-center gap-1 px-2.5 py-1 rounded border border-steel bg-ink font-mono text-xs text-mist hover:border-ember disabled:opacity-40"
          >
            <Redo2 className="w-3.5 h-3.5" />
            <span>Redo</span>
          </button>
        </div>
      </div>

      {/* Upper Daslight Layout: Left = Banks & Scenes, Right = FX Tiles & Block Rack */}
      <SceneAndFxManager hideUndoRedo daslightUpper />

      {/* Middle Horizontal GROUPS Strip (Daslight style) */}
      <section
        data-testid="daslight-groups-bar"
        className="bg-slate border border-steel rounded-panel px-3 py-2 flex flex-wrap items-center justify-between gap-3"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1 font-mono text-[11px] uppercase text-fog mr-1">
            <Users className="w-3.5 h-3.5 text-plum" />
            <span>GROUPS</span>
          </span>
          <button
            type="button"
            aria-pressed={selectedGroupId === "all"}
            onClick={() => setSelectedGroupId("all")}
            className={`px-2.5 py-1 rounded border font-mono text-xs transition-colors ${
              selectedGroupId === "all"
                ? "bg-frost text-void border-frost font-semibold"
                : "bg-ink text-mist border-steel hover:border-fog"
            }`}
          >
            All
          </button>
          {showState.groups.map((grp) => (
            <div
              key={grp.id}
              className={`flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded border font-mono text-xs ${
                selectedGroupId === grp.id
                  ? "bg-plum/25 border-plum text-frost"
                  : "bg-ink border-steel text-mist"
              }`}
            >
              <button
                type="button"
                onClick={() => setSelectedGroupId(grp.id)}
                className="truncate max-w-[140px]"
                title={`${grp.order}: ${grp.targets.join(", ")}`}
              >
                {grp.name}
              </button>
              <button
                type="button"
                aria-label={`Delete group ${grp.name}`}
                onClick={() => void deleteGroup(grp.id)}
                className="p-0.5 text-signal hover:text-frost"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <input
            aria-label="Group Name"
            type="text"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Group Name"
            className="w-28 bg-ink border border-steel rounded px-2 py-1 text-xs text-frost"
          />
          <select
            aria-label="Group Order"
            value={groupOrder}
            onChange={(e) => setGroupOrder(e.target.value as OrderRuleStr)}
            className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
          >
            <option value="linear">Linear</option>
            <option value="reverse">Reverse</option>
            <option value="center_out">Center Out</option>
            <option value="mirror">Mirror</option>
            <option value="odd_even">Odd Even</option>
            <option value="blocks(2)">Blocks (2)</option>
          </select>
          <input
            aria-label="Group Targets"
            type="text"
            value={groupTargets}
            onChange={(e) => setGroupTargets(e.target.value)}
            placeholder="fx_001:0..7"
            className="w-32 bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
          />
          <button
            type="button"
            onClick={() => void handleSaveGroup()}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-ink border border-plum hover:bg-plum/20 text-frost text-xs font-semibold"
          >
            <Plus className="w-3 h-3 text-plum" />
            <span>Save Group</span>
          </button>
        </div>
      </section>

      {/* Bottom Split Dock: Left = 2D Grid + Selections, Right = EDIT / LIVE Trait & Palette Dock */}
      <div
        data-testid="daslight-bottom-dock"
        className="grid grid-cols-1 xl:grid-cols-12 gap-3 items-start"
      >
        <div className="xl:col-span-6">
          <FixtureGrid2D hideUndoRedo compact />
        </div>
        <div className="xl:col-span-6">
          <PalettesAndControls hideUndoRedo hideGroups daslightDock />
        </div>
      </div>
    </div>
  );
}
