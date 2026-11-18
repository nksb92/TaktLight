import {
  AlertTriangle,
  Palette,
  Plus,
  Redo2,
  Sliders,
  SunMedium,
  Trash2,
  Undo2,
  Users,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  hasSoftwareStrobeOverCap,
  type MergeOp,
  sampleOklabGradientHex,
  type ShutterState,
  type SmartControlLayer,
} from "../lib/mixerLogic";
import type { OrderRuleStr } from "../lib/patchLogic";
import { useTaktStore } from "../store/useTaktStore";

function slugId(prefix: string, name: string, existingIds: string[]): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = `${prefix}_${clean || "item"}`;
  if (!existingIds.includes(base)) return base;
  let suffix = 2;
  while (existingIds.includes(`${base}_${suffix}`)) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
}

const OKLAB_STOPS = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];

export function PalettesAndControls({
  hideUndoRedo = false,
  hideGroups = false,
  daslightDock = false,
}: {
  hideUndoRedo?: boolean;
  hideGroups?: boolean;
  daslightDock?: boolean;
}) {
  const showState = useTaktStore((s) => s.showState);
  const liveLayers = useTaktStore((s) => s.liveLayers);
  const compiledCells = useTaktStore((s) => s.compiledCells);
  const cellPreviewRgbd = useTaktStore((s) => s.cellPreviewRgbd);
  const fixtureDetailsCache = useTaktStore((s) => s.fixtureDetailsCache);
  const canUndo = useTaktStore((s) => s.canUndo);
  const canRedo = useTaktStore((s) => s.canRedo);

  const upsertColorPalette = useTaktStore((s) => s.upsertColorPalette);
  const deleteColorPalette = useTaktStore((s) => s.deleteColorPalette);
  const upsertDimmerPalette = useTaktStore((s) => s.upsertDimmerPalette);
  const deleteDimmerPalette = useTaktStore((s) => s.deleteDimmerPalette);
  const upsertGroup = useTaktStore((s) => s.upsertGroup);
  const deleteGroup = useTaktStore((s) => s.deleteGroup);
  const setLiveLayers = useTaktStore((s) => s.setLiveLayers);
  const undoShow = useTaktStore((s) => s.undoShow);
  const redoShow = useTaktStore((s) => s.redoShow);

  const [colorName, setColorName] = useState("Neon Sunset");
  const [colorStartHex, setColorStartHex] = useState("#FF5500");
  const [colorEndHex, setColorEndHex] = useState("#2255AA");

  const [dimmerName, setDimmerName] = useState("Studio 75%");
  const [dimmerStart, setDimmerStart] = useState(0.75);
  const [dimmerEnd, setDimmerEnd] = useState(0.75);

  const [groupName, setGroupName] = useState("Stage Front");
  const [groupOrder, setGroupOrder] = useState<OrderRuleStr>("center_out");
  const [groupTargets, setGroupTargets] = useState(
    showState.patch[0]?.id ?? "fx_001",
  );

  const [layerSeq, setLayerSeq] = useState(1);
  const [dockFilter, setDockFilter] = useState<
    "all" | "dimmer" | "color" | "shutter" | "palettes"
  >("all");

  const softwareStrobeWarning = useMemo(
    () => hasSoftwareStrobeOverCap(liveLayers, showState, fixtureDetailsCache),
    [fixtureDetailsCache, liveLayers, showState],
  );

  const targetOptions = useMemo(() => {
    const opts = [{ value: "all", label: "All Patched Fixtures" }];
    for (const grp of showState.groups) {
      opts.push({ value: grp.id, label: `Group: ${grp.name} (${grp.id})` });
    }
    for (const fx of showState.patch) {
      opts.push({ value: fx.id, label: `Fixture: ${fx.name} (${fx.id})` });
    }
    return opts;
  }, [showState.groups, showState.patch]);

  const handleSaveColorPalette = async () => {
    const id = slugId(
      "pal",
      colorName,
      showState.color_palettes.map((p) => p.id),
    );
    await upsertColorPalette({
      id,
      name: colorName.trim() || "Color Palette",
      hex_start: colorStartHex,
      hex_end: colorEndHex,
    });
  };

  const handleSaveDimmerPalette = async () => {
    const id = slugId(
      "dim",
      dimmerName,
      showState.dimmer_palettes.map((d) => d.id),
    );
    await upsertDimmerPalette({
      id,
      name: dimmerName.trim() || "Dimmer Palette",
      value_start: Math.max(0, Math.min(1, dimmerStart)),
      value_end: Math.max(0, Math.min(1, dimmerEnd)),
    });
  };

  const handleSaveGroup = async () => {
    const id = slugId(
      "grp",
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

  const addLayer = (kind: "dimmer" | "color" | "master_dimmer" | "shutter") => {
    const nextTrigger =
      liveLayers.reduce((m, l) => Math.max(m, l.trigger_order), 0) + 1;
    const seq = layerSeq;
    setLayerSeq(seq + 1);
    const defaultColorPal = showState.color_palettes[0]?.id ?? null;
    const defaultDimPal = showState.dimmer_palettes[0]?.id ?? null;

    let newLayer: SmartControlLayer;
    if (kind === "dimmer") {
      newLayer = {
        id: `layer_${seq}`,
        name: `Dimmer ${seq}`,
        enabled: true,
        priority: 1,
        trigger_order: nextTrigger,
        alpha: 1.0,
        target: "all",
        order_override: null,
        trait_spec: {
          trait_kind: "dimmer",
          op: "htp",
          palette_ref: defaultDimPal,
          value_start: 1.0,
          value_end: 1.0,
        },
      };
    } else if (kind === "color") {
      newLayer = {
        id: `layer_${seq}`,
        name: `Color ${seq}`,
        enabled: true,
        priority: 1,
        trigger_order: nextTrigger,
        alpha: 1.0,
        target: "all",
        order_override: null,
        trait_spec: {
          trait_kind: "color",
          op: "ltp",
          palette_ref: defaultColorPal,
          hex_start: "#FF5500",
          hex_end: "#2255AA",
        },
      };
    } else if (kind === "master_dimmer") {
      newLayer = {
        id: `layer_${seq}`,
        name: `Master ${seq}`,
        enabled: true,
        priority: 2,
        trigger_order: nextTrigger,
        alpha: 1.0,
        target: "all",
        order_override: null,
        trait_spec: {
          trait_kind: "master_dimmer",
          op: "ltp",
          value: 1.0,
        },
      };
    } else {
      newLayer = {
        id: `layer_${seq}`,
        name: `Shutter ${seq}`,
        enabled: true,
        priority: 3,
        trigger_order: nextTrigger,
        alpha: 1.0,
        target: "all",
        order_override: null,
        trait_spec: {
          trait_kind: "shutter",
          state: { kind: "open" },
        },
      };
    }

    void setLiveLayers([...liveLayers, newLayer]);
  };

  const updateLayer = (
    layerId: string,
    updater: (layer: SmartControlLayer) => SmartControlLayer,
  ) => {
    void setLiveLayers(
      liveLayers.map((l) => (l.id === layerId ? updater(l) : l)),
    );
  };

  const removeLayer = (layerId: string) => {
    void setLiveLayers(liveLayers.filter((l) => l.id !== layerId));
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Header Bar (omitted inside unified Daslight dock when host handles Undo/Redo) */}
      {!hideUndoRedo && (
        <section className="bg-slate border border-steel rounded-panel p-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="font-sans text-sm font-semibold text-frost">
              Trait Space Mixer &amp; Referenceable Palettes
            </h2>
            {softwareStrobeWarning && (
              <span className="px-2.5 py-1 rounded bg-signal/15 border border-signal text-signal font-mono text-xs font-semibold flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>SOFTWARE STROBE CAPPED AT 11 HZ</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!canUndo}
              onClick={() => void undoShow()}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-ink border border-steel text-xs font-sans text-mist hover:border-ember disabled:opacity-40"
            >
              <Undo2 className="w-3.5 h-3.5" />
              <span>Undo</span>
            </button>
            <button
              type="button"
              disabled={!canRedo}
              onClick={() => void redoShow()}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-ink border border-steel text-xs font-sans text-mist hover:border-ember disabled:opacity-40"
            >
              <Redo2 className="w-3.5 h-3.5" />
              <span>Redo</span>
            </button>
          </div>
        </section>
      )}

      {hideUndoRedo && softwareStrobeWarning && (
        <div className="px-2.5 py-1 rounded bg-signal/15 border border-signal text-signal font-mono text-xs font-semibold flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>SOFTWARE STROBE CAPPED AT 11 HZ</span>
        </div>
      )}

      {/* Daslight EDIT / LIVE Trait Dock */}
      <div
        className={
          daslightDock
            ? "flex flex-col sm:flex-row gap-2.5 bg-slate border border-steel rounded-panel p-2.5"
            : "flex flex-col gap-4"
        }
      >
        {daslightDock && (
          <div className="flex sm:flex-col gap-1 sm:w-24 shrink-0 bg-ink border border-steel rounded p-1 font-mono text-[10px]">
            {(
              [
                { id: "all", label: "EDIT | ALL" },
                { id: "dimmer", label: "DIMMER" },
                { id: "color", label: "COLOR" },
                { id: "shutter", label: "SHUTTER" },
                { id: "palettes", label: "PALETTES" },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={dockFilter === item.id}
                onClick={() => setDockFilter(item.id)}
                className={`px-2 py-1.5 rounded text-left transition-colors ${
                  dockFilter === item.id
                    ? "bg-ember text-frost font-semibold"
                    : "text-fog hover:text-mist"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 min-w-0 flex flex-col gap-3">
          {/* Palettes & Optional Groups Row */}
          {(dockFilter === "all" || dockFilter === "palettes") && (
            <section
              className={`grid grid-cols-1 ${hideGroups ? "lg:grid-cols-2" : "lg:grid-cols-3"} gap-3`}
            >
        {/* Color Palettes */}
        <div className="bg-slate border border-steel rounded-panel p-3 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Palette className="w-4 h-4 text-ember" />
            <h3 className="font-sans text-sm font-semibold text-frost">
              Color Palettes (OKLAB)
            </h3>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2 flex flex-col gap-1">
              <label
                htmlFor="cp-name"
                className="text-[11px] font-mono uppercase text-fog"
              >
                Color Palette Name
              </label>
              <input
                id="cp-name"
                aria-label="Color Palette Name"
                type="text"
                value={colorName}
                onChange={(e) => setColorName(e.target.value)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs text-frost"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="cp-start"
                className="text-[11px] font-mono uppercase text-fog"
              >
                Color Start Hex
              </label>
              <input
                id="cp-start"
                aria-label="Color Start Hex"
                type="text"
                value={colorStartHex}
                onChange={(e) => setColorStartHex(e.target.value)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="cp-end"
                className="text-[11px] font-mono uppercase text-fog"
              >
                Color End Hex
              </label>
              <input
                id="cp-end"
                aria-label="Color End Hex"
                type="text"
                value={colorEndHex}
                onChange={(e) => setColorEndHex(e.target.value)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              />
            </div>
          </div>

          <div className="flex h-3 rounded overflow-hidden border border-steel">
            {OKLAB_STOPS.map((w) => (
              <div
                key={w}
                className="flex-1"
                style={{
                  backgroundColor: sampleOklabGradientHex(
                    colorStartHex,
                    colorEndHex,
                    w,
                  ),
                }}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={() => void handleSaveColorPalette()}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-ember hover:bg-burnt text-frost text-xs font-semibold"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Save Color Palette</span>
          </button>

          <div className="flex flex-col gap-1.5">
            {showState.color_palettes.map((pal) => (
              <div
                key={pal.id}
                className="bg-ink border border-steel rounded px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs"
              >
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-sans font-medium text-frost truncate">
                      {pal.name}
                    </span>
                    <span className="font-mono text-[10px] text-fog">
                      {pal.id}
                    </span>
                  </div>
                  <div className="flex h-2 rounded overflow-hidden border border-steel/60">
                    {OKLAB_STOPS.map((w) => (
                      <div
                        key={w}
                        className="flex-1"
                        style={{
                          backgroundColor: sampleOklabGradientHex(
                            pal.hex_start,
                            pal.hex_end,
                            w,
                          ),
                        }}
                      />
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Delete palette ${pal.name}`}
                  onClick={() => void deleteColorPalette(pal.id)}
                  className="p-1 text-signal hover:bg-slate-dark rounded"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Dimmer Palettes */}
        <div className="bg-slate border border-steel rounded-panel p-3 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <SunMedium className="w-4 h-4 text-cobalt" />
            <h3 className="font-sans text-sm font-semibold text-frost">
              Dimmer Palettes (Linear)
            </h3>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2 flex flex-col gap-1">
              <label
                htmlFor="dp-name"
                className="text-[11px] font-mono uppercase text-fog"
              >
                Dimmer Palette Name
              </label>
              <input
                id="dp-name"
                aria-label="Dimmer Palette Name"
                type="text"
                value={dimmerName}
                onChange={(e) => setDimmerName(e.target.value)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs text-frost"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="dp-start"
                className="text-[11px] font-mono uppercase text-fog"
              >
                Dimmer Start Value
              </label>
              <input
                id="dp-start"
                aria-label="Dimmer Start Value"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={dimmerStart}
                onChange={(e) => setDimmerStart(Number(e.target.value) || 0)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="dp-end"
                className="text-[11px] font-mono uppercase text-fog"
              >
                Dimmer End Value
              </label>
              <input
                id="dp-end"
                aria-label="Dimmer End Value"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={dimmerEnd}
                onChange={(e) => setDimmerEnd(Number(e.target.value) || 0)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleSaveDimmerPalette()}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-cobalt hover:bg-cobalt/80 text-void text-xs font-semibold"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Save Dimmer Palette</span>
          </button>

          <div className="flex flex-col gap-1.5">
            {showState.dimmer_palettes.map((dim) => (
              <div
                key={dim.id}
                className="bg-ink border border-steel rounded px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs"
              >
                <div className="flex flex-col min-w-0">
                  <span className="font-sans font-medium text-frost truncate">
                    {dim.name}
                  </span>
                  <span className="font-mono text-[10px] text-fog">
                    {Math.round(dim.value_start * 100)}% to{" "}
                    {Math.round(dim.value_end * 100)}% ({dim.id})
                  </span>
                </div>
                <button
                  type="button"
                  aria-label={`Delete dimmer ${dim.name}`}
                  onClick={() => void deleteDimmerPalette(dim.id)}
                  className="p-1 text-signal hover:bg-slate-dark rounded"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Target Groups */}
        {!hideGroups && (
          <div className="bg-slate border border-steel rounded-panel p-3 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-plum" />
            <h3 className="font-sans text-sm font-semibold text-frost">
              Target Groups
            </h3>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="grp-name"
                className="text-[11px] font-mono uppercase text-fog"
              >
                Group Name
              </label>
              <input
                id="grp-name"
                aria-label="Group Name"
                type="text"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs text-frost"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="grp-order"
                className="text-[11px] font-mono uppercase text-fog"
              >
                Group Order
              </label>
              <select
                id="grp-order"
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
            </div>

            <div className="col-span-2 flex flex-col gap-1">
              <label
                htmlFor="grp-targets"
                className="text-[11px] font-mono uppercase text-fog"
              >
                Group Targets
              </label>
              <input
                id="grp-targets"
                aria-label="Group Targets"
                type="text"
                value={groupTargets}
                onChange={(e) => setGroupTargets(e.target.value)}
                placeholder="fx_001:0..7"
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleSaveGroup()}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-ink border border-plum hover:bg-plum/20 text-frost text-xs font-semibold"
          >
            <Plus className="w-3.5 h-3.5 text-plum" />
            <span>Save Group</span>
          </button>

          <div className="flex flex-col gap-1.5">
            {showState.groups.map((grp) => (
              <div
                key={grp.id}
                className="bg-ink border border-steel rounded px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs"
              >
                <div className="flex flex-col min-w-0">
                  <span className="font-sans font-medium text-frost truncate">
                    {grp.name} ({grp.order})
                  </span>
                  <span className="font-mono text-[10px] text-fog truncate">
                    {grp.targets.join(", ")} | {grp.id}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label={`Delete group ${grp.name}`}
                  onClick={() => void deleteGroup(grp.id)}
                  className="p-1 text-signal hover:bg-slate-dark rounded"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
        )}
      </section>
          )}

      {/* Priority Layer Stack & Smart Controls */}
      {dockFilter !== "palettes" && (
      <section className="bg-pitch border border-steel rounded-panel p-2.5 flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-ember" />
            <h3 className="font-sans text-sm font-semibold text-frost">
              Priority Layer Stack &amp; Smart Controls
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => addLayer("dimmer")}
              className="px-2.5 py-1 rounded bg-ink border border-steel hover:border-cobalt text-xs font-mono text-frost"
            >
              Add Dimmer Layer
            </button>
            <button
              type="button"
              onClick={() => addLayer("color")}
              className="px-2.5 py-1 rounded bg-ink border border-steel hover:border-ember text-xs font-mono text-frost"
            >
              Add Color Layer
            </button>
            <button
              type="button"
              onClick={() => addLayer("master_dimmer")}
              className="px-2.5 py-1 rounded bg-ink border border-steel hover:border-pine text-xs font-mono text-frost"
            >
              Add Master Layer
            </button>
            <button
              type="button"
              onClick={() => addLayer("shutter")}
              className="px-2.5 py-1 rounded bg-ink border border-steel hover:border-signal text-xs font-mono text-frost flex items-center gap-1"
            >
              <Zap className="w-3 h-3 text-signal" />
              <span>Add Shutter Layer</span>
            </button>
          </div>
        </div>

        {liveLayers.length === 0 ? (
          <p className="font-mono text-xs text-fog">
            No active layers.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {liveLayers.map((layer, idx) => {
              const num = idx + 1;
              const spec = layer.trait_spec;

              return (
                <div
                  key={layer.id}
                  className="bg-ink border border-steel rounded p-2.5 flex flex-wrap items-end gap-2.5"
                >
                  <div className="flex items-center gap-2 mr-1">
                    <input
                      type="checkbox"
                      aria-label={`Layer ${num} Enabled`}
                      checked={layer.enabled}
                      onChange={(e) =>
                        updateLayer(layer.id, (l) => ({
                          ...l,
                          enabled: e.target.checked,
                        }))
                      }
                    />
                    <span className="font-mono text-xs font-semibold text-ember">
                      Layer {num}
                    </span>
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <label className="text-[10px] font-mono uppercase text-fog">
                      Priority
                    </label>
                    <input
                      aria-label={`Layer ${num} Priority`}
                      type="number"
                      value={layer.priority}
                      onChange={(e) =>
                        updateLayer(layer.id, (l) => ({
                          ...l,
                          priority: Number(e.target.value) || 0,
                        }))
                      }
                      className="w-16 bg-pitch border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                    />
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <label className="text-[10px] font-mono uppercase text-fog">
                      Alpha
                    </label>
                    <input
                      aria-label={`Layer ${num} Alpha`}
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={layer.alpha}
                      onChange={(e) =>
                        updateLayer(layer.id, (l) => ({
                          ...l,
                          alpha: Math.max(
                            0,
                            Math.min(1, Number(e.target.value) || 0),
                          ),
                        }))
                      }
                      className="w-16 bg-pitch border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                    />
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <label className="text-[10px] font-mono uppercase text-fog">
                      Target
                    </label>
                    <select
                      aria-label={`Layer ${num} Target`}
                      value={layer.target}
                      onChange={(e) =>
                        updateLayer(layer.id, (l) => ({
                          ...l,
                          target: e.target.value,
                        }))
                      }
                      className="bg-pitch border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                    >
                      {targetOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <label className="text-[10px] font-mono uppercase text-fog">
                      Order
                    </label>
                    <select
                      aria-label={`Layer ${num} Order`}
                      value={layer.order_override ?? ""}
                      onChange={(e) =>
                        updateLayer(layer.id, (l) => ({
                          ...l,
                          order_override: e.target.value
                            ? (e.target.value as OrderRuleStr)
                            : null,
                        }))
                      }
                      className="bg-pitch border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                    >
                      <option value="">Group Default</option>
                      <option value="linear">Linear</option>
                      <option value="reverse">Reverse</option>
                      <option value="center_out">Center Out</option>
                      <option value="mirror">Mirror</option>
                      <option value="odd_even">Odd Even</option>
                      <option value="blocks(2)">Blocks (2)</option>
                    </select>
                  </div>

                  {spec.trait_kind === "dimmer" && (
                    <>
                      <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-mono uppercase text-fog">
                          Op
                        </label>
                        <select
                          aria-label={`Layer ${num} Op`}
                          value={spec.op}
                          onChange={(e) =>
                            updateLayer(layer.id, (l) => ({
                              ...l,
                              trait_spec: {
                                ...spec,
                                op: e.target.value as MergeOp,
                              },
                            }))
                          }
                          className="bg-pitch border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                        >
                          <option value="htp">HTP</option>
                          <option value="ltp">LTP</option>
                          <option value="add">ADD</option>
                          <option value="scale">SCALE</option>
                        </select>
                      </div>

                      <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-mono uppercase text-fog">
                          Palette
                        </label>
                        <select
                          aria-label={`Layer ${num} Palette`}
                          value={spec.palette_ref ?? ""}
                          onChange={(e) =>
                            updateLayer(layer.id, (l) => ({
                              ...l,
                              trait_spec: {
                                ...spec,
                                palette_ref: e.target.value || null,
                              },
                            }))
                          }
                          className="bg-pitch border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                        >
                          <option value="">Inline Range</option>
                          {showState.dimmer_palettes.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  )}

                  {spec.trait_kind === "color" && (
                    <>
                      <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-mono uppercase text-fog">
                          Op
                        </label>
                        <select
                          aria-label={`Layer ${num} Op`}
                          value={spec.op}
                          onChange={(e) =>
                            updateLayer(layer.id, (l) => ({
                              ...l,
                              trait_spec: {
                                ...spec,
                                op: e.target.value as MergeOp,
                              },
                            }))
                          }
                          className="bg-pitch border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                        >
                          <option value="ltp">LTP</option>
                          <option value="htp">HTP</option>
                          <option value="add">ADD</option>
                          <option value="scale">SCALE</option>
                        </select>
                      </div>

                      <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-mono uppercase text-fog">
                          Palette
                        </label>
                        <select
                          aria-label={`Layer ${num} Palette`}
                          value={spec.palette_ref ?? ""}
                          onChange={(e) =>
                            updateLayer(layer.id, (l) => ({
                              ...l,
                              trait_spec: {
                                ...spec,
                                palette_ref: e.target.value || null,
                              },
                            }))
                          }
                          className="bg-pitch border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                        >
                          <option value="">Inline Hex</option>
                          {showState.color_palettes.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  )}

                  {spec.trait_kind === "master_dimmer" && (
                    <>
                      <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-mono uppercase text-fog">
                          Op
                        </label>
                        <select
                          aria-label={`Layer ${num} Op`}
                          value={spec.op}
                          onChange={(e) =>
                            updateLayer(layer.id, (l) => ({
                              ...l,
                              trait_spec: {
                                ...spec,
                                op: e.target.value as MergeOp,
                              },
                            }))
                          }
                          className="bg-pitch border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                        >
                          <option value="ltp">LTP</option>
                          <option value="htp">HTP</option>
                        </select>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-mono uppercase text-fog">
                          Master Value
                        </label>
                        <input
                          aria-label={`Layer ${num} Master Value`}
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={spec.value}
                          onChange={(e) =>
                            updateLayer(layer.id, (l) => ({
                              ...l,
                              trait_spec: {
                                ...spec,
                                value: Math.max(
                                  0,
                                  Math.min(1, Number(e.target.value) || 0),
                                ),
                              },
                            }))
                          }
                          className="w-20 bg-pitch border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                        />
                      </div>
                    </>
                  )}

                  {spec.trait_kind === "shutter" && (
                    <>
                      <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-mono uppercase text-fog">
                          Shutter Mode
                        </label>
                        <select
                          aria-label={`Layer ${num} Shutter Mode`}
                          value={spec.state.kind}
                          onChange={(e) => {
                            const kind = e.target.value as ShutterState["kind"];
                            let nextState: ShutterState = { kind: "open" };
                            if (kind === "closed") nextState = { kind: "closed" };
                            else if (kind === "strobe_hz")
                              nextState = { kind: "strobe_hz", hz: 6 };
                            else if (kind === "random_strobe")
                              nextState = { kind: "random_strobe", hz: 6 };
                            updateLayer(layer.id, (l) => ({
                              ...l,
                              trait_spec: {
                                trait_kind: "shutter",
                                state: nextState,
                              },
                            }));
                          }}
                          className="bg-pitch border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                        >
                          <option value="open">Open</option>
                          <option value="closed">Closed</option>
                          <option value="strobe_hz">Strobe Hz</option>
                          <option value="random_strobe">Random Strobe</option>
                        </select>
                      </div>

                      {(spec.state.kind === "strobe_hz" ||
                        spec.state.kind === "random_strobe") && (
                        <div className="flex flex-col gap-0.5">
                          <label className="text-[10px] font-mono uppercase text-fog">
                            Strobe Hz
                          </label>
                          <input
                            aria-label={`Layer ${num} Strobe Hz`}
                            type="number"
                            min={0.5}
                            max={25}
                            step={0.5}
                            value={spec.state.hz}
                            onChange={(e) => {
                              const hz = Math.max(
                                0.5,
                                Math.min(25, Number(e.target.value) || 1),
                              );
                              const kind = spec.state.kind;
                              updateLayer(layer.id, (l) => ({
                                ...l,
                                trait_spec: {
                                  trait_kind: "shutter",
                                  state:
                                    kind === "random_strobe"
                                      ? { kind: "random_strobe", hz }
                                      : { kind: "strobe_hz", hz },
                                },
                              }));
                            }}
                            className="w-20 bg-pitch border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                          />
                        </div>
                      )}
                    </>
                  )}

                  <button
                    type="button"
                    aria-label={`Remove Layer ${num}`}
                    onClick={() => removeLayer(layer.id)}
                    className="ml-auto p-1.5 text-signal hover:bg-slate-dark rounded border border-steel"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
      )}
        </div>
      </div>

      {/* Live Cell Output Strip */}
      <section
        data-testid="scene-live-cell-preview"
        className="bg-slate border border-steel rounded-panel p-2.5 flex flex-col gap-2"
      >
        <div className="flex items-center justify-between">
          <h3 className="font-sans text-sm font-semibold text-frost">
            Live Evaluated Cell Output ({compiledCells.length} cells)
          </h3>
        </div>

        <div
          data-testid="live-cell-preview"
          className="flex flex-wrap gap-1.5 bg-void border border-steel rounded p-2.5"
        >
          {compiledCells.length === 0 ? (
            <span className="font-mono text-xs text-fog">
              No patched cells.
            </span>
          ) : (
            compiledCells.map((cell, idx) => {
              const base = idx * 4;
              const r = cellPreviewRgbd[base] ?? 0;
              const g = cellPreviewRgbd[base + 1] ?? 0;
              const b = cellPreviewRgbd[base + 2] ?? 0;
              const d = cellPreviewRgbd[base + 3] ?? 0;
              const scale = d / 255;
              const bg = `rgb(${Math.round(r * scale)}, ${Math.round(g * scale)}, ${Math.round(b * scale)})`;

              return (
                <div
                  key={`${cell.fixture_id}-${cell.cell_index}`}
                  title={`${cell.fixture_id}:${cell.cell_index} RGB(${r},${g},${b}) D=${d}`}
                  className="w-10 h-10 rounded border border-steel flex flex-col items-center justify-end p-0.5 font-mono text-[9px] text-frost"
                  style={{ backgroundColor: bg }}
                >
                  <span className="bg-void/70 px-1 rounded">
                    {cell.pixel_key}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
