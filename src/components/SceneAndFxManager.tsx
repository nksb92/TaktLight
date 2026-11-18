import {
  Activity,
  Layers,
  Play,
  Plus,
  Redo2,
  Sparkles,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  FxBlockDef,
  FxElementDef,
  MergeOp,
  SceneDef,
  Shader2DKind,
  Waveform1D,
} from "../lib/mixerLogic";
import type { OrderRuleStr } from "../lib/patchLogic";
import { useTaktStore } from "../store/useTaktStore";

type GeneratorKind = FxElementDef["kind"];

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

function buildElementFromForm(params: {
  kind: GeneratorKind;
  trait: string;
  op: MergeOp;
  waveform: Waveform1D;
  amplitude: number;
  offset: number;
  rateBeats: number;
  phaseSpreadDeg: number;
  duty: number;
  stepBeats: number;
  activeRatio: number;
  fade: number;
  shader: Shader2DKind;
  spatialFreq: number;
  directionDeg: number;
  centerX: number;
  centerY: number;
  paletteRef: string;
  staticStart: number;
  staticEnd: number;
  order: OrderRuleStr;
}): FxElementDef {
  const paletteRef = params.paletteRef.trim() ? params.paletteRef.trim() : null;
  switch (params.kind) {
    case "curve_1d":
      return {
        kind: "curve_1d",
        trait: params.trait,
        op: params.op,
        waveform: params.waveform,
        amplitude: params.amplitude,
        offset: params.offset,
        rate_beats: params.rateBeats,
        speed_hz: null,
        phase_spread_deg: params.phaseSpreadDeg,
        duty: params.waveform === "pulse" ? params.duty : null,
        palette_ref: paletteRef,
        order: params.order,
      };
    case "static_trait":
      return {
        kind: "static_trait",
        trait: params.trait === "color" ? "color" : "dimmer",
        op: params.op,
        palette_ref: paletteRef,
        value_start: params.staticStart,
        value_end: params.staticEnd,
        order: params.order,
      };
    case "step_chase":
      return {
        kind: "step_chase",
        trait: params.trait,
        op: params.op,
        step_beats: params.stepBeats,
        speed_hz: null,
        active_ratio: params.activeRatio,
        fade: params.fade,
        amplitude: params.amplitude,
        palette_ref: paletteRef,
        order: params.order,
      };
    case "spatial_shader_2d":
      return {
        kind: "spatial_shader_2d",
        trait: params.trait === "color" ? "color" : "dimmer",
        op: params.op,
        shader: params.shader,
        palette_ref: paletteRef,
        rate_beats: params.rateBeats,
        speed_hz: null,
        spatial_freq: params.spatialFreq,
        direction_deg: params.directionDeg,
        center_x: params.centerX,
        center_y: params.centerY,
      };
  }
}

export function SceneAndFxManager({
  hideUndoRedo = false,
  daslightUpper = false,
}: {
  hideUndoRedo?: boolean;
  daslightUpper?: boolean;
}) {
  const showState = useTaktStore((s) => s.showState);
  const activeScenes = useTaktStore((s) => s.activeScenes);
  const liveBpm = useTaktStore((s) => s.liveBpm);
  const compiledCells = useTaktStore((s) => s.compiledCells);
  const cellPreviewRgbd = useTaktStore((s) => s.cellPreviewRgbd);
  const canUndo = useTaktStore((s) => s.canUndo);
  const canRedo = useTaktStore((s) => s.canRedo);

  const upsertFxBlock = useTaktStore((s) => s.upsertFxBlock);
  const deleteFxBlock = useTaktStore((s) => s.deleteFxBlock);
  const upsertScene = useTaktStore((s) => s.upsertScene);
  const deleteScene = useTaktStore((s) => s.deleteScene);
  const triggerScene = useTaktStore((s) => s.triggerScene);
  const releaseScene = useTaktStore((s) => s.releaseScene);
  const releaseAllScenes = useTaktStore((s) => s.releaseAllScenes);
  const setLiveBpm = useTaktStore((s) => s.setLiveBpm);
  const tapTempo = useTaktStore((s) => s.tapTempo);
  const undoShow = useTaktStore((s) => s.undoShow);
  const redoShow = useTaktStore((s) => s.redoShow);

  // FX Block Builder state
  const [fxName, setFxName] = useState("Pulse Wave");
  const [fxTargetGroup, setFxTargetGroup] = useState("all");
  const [fxDurationBeats, setFxDurationBeats] = useState(4);
  const [fxLoop, setFxLoop] = useState(true);
  const [fxKind, setFxKind] = useState<GeneratorKind>("curve_1d");
  const [fxTrait, setFxTrait] = useState("dimmer");
  const [fxOp, setFxOp] = useState<MergeOp>("htp");
  const [fxWaveform, setFxWaveform] = useState<Waveform1D>("sine");
  const [fxAmplitude, setFxAmplitude] = useState(1.0);
  const [fxOffset, setFxOffset] = useState(0.0);
  const [fxRateBeats, setFxRateBeats] = useState(2.0);
  const [fxPhaseSpreadDeg, setFxPhaseSpreadDeg] = useState(360);
  const [fxDuty, setFxDuty] = useState(0.5);
  const [fxStepBeats, setFxStepBeats] = useState(1.0);
  const [fxActiveRatio, setFxActiveRatio] = useState(0.25);
  const [fxFade, setFxFade] = useState(0.25);
  const [fxShader, setFxShader] = useState<Shader2DKind>("linear_sweep");
  const [fxSpatialFreq, setFxSpatialFreq] = useState(1.0);
  const [fxDirectionDeg, setFxDirectionDeg] = useState(0);
  const [fxCenterX, setFxCenterX] = useState(0.5);
  const [fxCenterY, setFxCenterY] = useState(0.5);
  const [fxPaletteRef, setFxPaletteRef] = useState(
    showState.color_palettes[0]?.id ?? "",
  );
  const [fxStaticStart, setFxStaticStart] = useState(1.0);
  const [fxStaticEnd, setFxStaticEnd] = useState(1.0);
  const [fxOrder, setFxOrder] = useState<OrderRuleStr>("linear");

  // Scene Builder state
  const [sceneName, setSceneName] = useState("Main Wash");
  const [sceneBank, setSceneBank] = useState("main");
  const [scenePriority, setScenePriority] = useState(15);
  const [sceneFadeIn, setSceneFadeIn] = useState(0);
  const [sceneFadeOut, setSceneFadeOut] = useState(0.5);
  const [sceneTargetOverride, setSceneTargetOverride] = useState("");
  const [sceneBlockRef, setSceneBlockRef] = useState(
    showState.fx_library[0]?.id ?? "",
  );
  const [selectedBank, setSelectedBank] = useState<string>("all");

  const bankNames = useMemo(() => {
    const set = new Set<string>();
    for (const sc of showState.scenes) {
      set.add(sc.bank?.trim() || "standalone");
    }
    return Array.from(set);
  }, [showState.scenes]);

  const visibleScenes = useMemo(() => {
    if (selectedBank === "all") return showState.scenes;
    return showState.scenes.filter(
      (sc) => (sc.bank?.trim() || "standalone") === selectedBank,
    );
  }, [selectedBank, showState.scenes]);

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

  const effectiveBlockRef = useMemo(() => {
    if (
      sceneBlockRef &&
      showState.fx_library.some((b) => b.id === sceneBlockRef)
    ) {
      return sceneBlockRef;
    }
    return showState.fx_library[0]?.id ?? "";
  }, [sceneBlockRef, showState.fx_library]);

  const activeById = useMemo(() => {
    const map = new Map(activeScenes.map((s) => [s.scene_id, s]));
    return map;
  }, [activeScenes]);

  const handleSaveFxBlock = async () => {
    const id = slugId(
      "blk",
      fxName,
      showState.fx_library.map((b) => b.id),
    );
    const element = buildElementFromForm({
      kind: fxKind,
      trait: fxTrait,
      op: fxOp,
      waveform: fxWaveform,
      amplitude: fxAmplitude,
      offset: fxOffset,
      rateBeats: fxRateBeats,
      phaseSpreadDeg: fxPhaseSpreadDeg,
      duty: fxDuty,
      stepBeats: fxStepBeats,
      activeRatio: fxActiveRatio,
      fade: fxFade,
      shader: fxShader,
      spatialFreq: fxSpatialFreq,
      directionDeg: fxDirectionDeg,
      centerX: fxCenterX,
      centerY: fxCenterY,
      paletteRef: fxKind === "curve_1d" || fxKind === "step_chase" ? "" : fxPaletteRef,
      staticStart: fxStaticStart,
      staticEnd: fxStaticEnd,
      order: fxOrder,
    });

    const block: FxBlockDef = {
      id,
      name: fxName.trim() || "FX Block",
      target_group: fxTargetGroup,
      duration_beats: Math.max(0.25, fxDurationBeats),
      loop_block: fxLoop,
      elements: [element],
    };

    await upsertFxBlock(block);
    setSceneBlockRef(id);
  };

  const handleSaveScene = async () => {
    const id = slugId(
      "sc",
      sceneName,
      showState.scenes.map((s) => s.id),
    );
    const trimmedBank = sceneBank.trim();
    const trimmedTarget = sceneTargetOverride.trim();
    const blockRefs = effectiveBlockRef ? [effectiveBlockRef] : [];

    const scene: SceneDef = {
      id,
      name: sceneName.trim() || "Scene",
      bank: trimmedBank ? trimmedBank : null,
      target_group: trimmedTarget ? trimmedTarget : null,
      priority: Math.max(0, Math.round(scenePriority)),
      fade_in_sec: Math.max(0, sceneFadeIn),
      fade_out_sec: Math.max(0, sceneFadeOut),
      block_refs: blockRefs,
    };

    await upsertScene(scene);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Header Tempo & Transport Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate border border-steel rounded-panel px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Sparkles className="w-4 h-4 text-ember" />
          <h2 className="font-sans text-sm font-semibold text-frost">
            Scenes &amp; Procedural FX Engine
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 bg-pitch border border-steel rounded px-2.5 py-1">
            <Activity className="w-3.5 h-3.5 text-pine" />
            <span className="font-mono text-xs text-fog">BPM</span>
            <input
              aria-label="Live BPM"
              type="number"
              min={20}
              max={300}
              step={1}
              value={liveBpm}
              onChange={(e) => {
                const parsed = Number(e.target.value);
                if (!Number.isNaN(parsed)) {
                  void setLiveBpm(parsed);
                }
              }}
              className="w-16 bg-ink border border-steel rounded px-1.5 py-0.5 font-mono text-xs text-frost"
            />
          </label>

          <button
            type="button"
            onClick={() => void tapTempo()}
            className="px-3 py-1.5 rounded border border-cobalt bg-cobalt/20 hover:bg-cobalt/30 font-mono text-xs font-medium text-frost transition-colors"
          >
            Tap Tempo
          </button>

          <button
            type="button"
            onClick={() => void releaseAllScenes()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-signal/70 bg-signal/15 hover:bg-signal/25 font-mono text-xs font-medium text-frost transition-colors"
          >
            <Square className="w-3 h-3" />
            <span>Release All Scenes</span>
          </button>

          {!hideUndoRedo && (
            <>
              <button
                type="button"
                disabled={!canUndo}
                onClick={() => void undoShow()}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-steel bg-ink font-mono text-xs text-mist disabled:opacity-40"
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span>Undo</span>
              </button>

              <button
                type="button"
                disabled={!canRedo}
                onClick={() => void redoShow()}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-steel bg-ink font-mono text-xs text-mist disabled:opacity-40"
              >
                <Redo2 className="w-3.5 h-3.5" />
                <span>Redo</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Upper Split Workspace: Left = Banks & Scenes (Daslight style), Right = FX Rack */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-3 items-start">
        {/* Left 8 Cols: Bank Tabs + Scene Pads + Scene Composer */}
        <section
          data-testid="daslight-scene-banks"
          className="xl:col-span-8 bg-slate border border-steel rounded-panel p-3 flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1 bg-ink border border-steel rounded p-0.5 font-mono text-[11px]">
              <button
                type="button"
                aria-pressed={selectedBank === "all"}
                onClick={() => setSelectedBank("all")}
                className={`px-2 py-0.5 rounded transition-colors ${
                  selectedBank === "all"
                    ? "bg-ember text-frost font-semibold"
                    : "text-fog hover:text-mist"
                }`}
              >
                All Banks ({showState.scenes.length})
              </button>
              {bankNames.map((bank) => (
                <button
                  key={bank}
                  type="button"
                  aria-pressed={selectedBank === bank}
                  onClick={() => setSelectedBank(bank)}
                  className={`px-2 py-0.5 rounded transition-colors ${
                    selectedBank === bank
                      ? "bg-ember text-frost font-semibold"
                      : "text-fog hover:text-mist"
                  }`}
                >
                  {bank}
                </button>
              ))}
            </div>
            <span className="font-mono text-[11px] text-fog">
              Active: {activeScenes.length}
            </span>
          </div>

          {visibleScenes.length === 0 ? (
            <div className="bg-pitch border border-steel rounded p-4 font-mono text-xs text-fog">
              No scenes defined.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 bg-pitch border border-steel rounded p-2.5">
              {visibleScenes.map((scene) => {
                const inst = activeById.get(scene.id);
                const isActive = inst && inst.release_t_sec === null;
                const isReleasing = inst && inst.release_t_sec !== null;
                const borderClass = isActive
                  ? "border-ember bg-ember/15"
                  : isReleasing
                    ? "border-signal/70 bg-signal/10"
                    : "border-steel bg-ink";

                return (
                  <div
                    key={scene.id}
                    className={`relative flex flex-col gap-1.5 rounded border p-2.5 pr-3.5 transition-colors overflow-hidden ${borderClass}`}
                  >
                    <div
                      className={`absolute top-0 right-0 bottom-0 w-1.5 ${
                        isActive
                          ? "bg-ember"
                          : isReleasing
                            ? "bg-signal"
                            : "bg-steel/40"
                      }`}
                    />
                    <div className="flex items-start justify-between gap-1">
                      <div className="font-sans text-xs font-semibold text-frost truncate">
                        {scene.name}
                      </div>
                      <span
                        className={`px-1.5 py-0.5 rounded font-mono text-[9px] font-semibold shrink-0 ${
                          isActive
                            ? "bg-ember text-frost"
                            : isReleasing
                              ? "bg-signal text-void"
                              : "bg-pitch text-fog border border-steel"
                        }`}
                      >
                        {isActive ? "ACTIVE" : isReleasing ? "RELEASING" : "IDLE"}
                      </span>
                    </div>

                    <div className="font-mono text-[10px] text-fog truncate">
                      {scene.bank ?? "standalone"} | P{scene.priority} | {scene.fade_in_sec}s/{scene.fade_out_sec}s
                    </div>

                    <div className="flex items-center gap-1 pt-0.5">
                      <button
                        type="button"
                        data-testid={`trigger-scene-${scene.id}`}
                        onClick={() => void triggerScene(scene.id)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded bg-ember hover:bg-burnt text-frost font-mono text-[11px] font-medium transition-colors"
                      >
                        <Play className="w-2.5 h-2.5" />
                        <span>Trigger</span>
                      </button>

                      <button
                        type="button"
                        data-testid={`release-scene-${scene.id}`}
                        onClick={() => void releaseScene(scene.id)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded border border-steel bg-pitch hover:border-fog text-mist font-mono text-[11px] transition-colors"
                      >
                        <Square className="w-2.5 h-2.5" />
                        <span>Release</span>
                      </button>

                      <button
                        type="button"
                        aria-label={`Delete Scene ${scene.name}`}
                        onClick={() => void deleteScene(scene.id)}
                        className="ml-auto p-1 rounded border border-steel bg-pitch text-signal hover:bg-slate-dark transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Compact Inline Scene Composer */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 bg-pitch border border-steel rounded p-2 items-end">
            <label className="flex flex-col gap-1 lg:col-span-2">
              <span className="font-mono text-[10px] text-fog">Scene Name</span>
              <input
                aria-label="Scene Name"
                type="text"
                value={sceneName}
                onChange={(e) => setSceneName(e.target.value)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-sans text-frost"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-fog">Bank</span>
              <input
                aria-label="Scene Bank"
                type="text"
                value={sceneBank}
                onChange={(e) => setSceneBank(e.target.value)}
                placeholder="main"
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-fog">Priority</span>
              <input
                aria-label="Scene Priority"
                type="number"
                min={0}
                max={255}
                value={scenePriority}
                onChange={(e) => setScenePriority(Number(e.target.value) || 0)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-fog">Fade In</span>
              <input
                aria-label="Scene Fade In"
                type="number"
                min={0}
                step={0.1}
                value={sceneFadeIn}
                onChange={(e) => setSceneFadeIn(Number(e.target.value) || 0)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-fog">Fade Out</span>
              <input
                aria-label="Scene Fade Out"
                type="number"
                min={0}
                step={0.1}
                value={sceneFadeOut}
                onChange={(e) => setSceneFadeOut(Number(e.target.value) || 0)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-fog">FX Block</span>
              <select
                aria-label="Scene Block Ref"
                value={effectiveBlockRef}
                onChange={(e) => setSceneBlockRef(e.target.value)}
                className="bg-ink border border-steel rounded px-1.5 py-1 text-xs font-mono text-frost"
              >
                {showState.fx_library.length === 0 ? (
                  <option value="">None</option>
                ) : (
                  showState.fx_library.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.id})
                    </option>
                  ))
                )}
              </select>
            </label>

            <button
              type="button"
              onClick={() => void handleSaveScene()}
              className="flex items-center justify-center gap-1 px-2.5 py-1 rounded bg-plum hover:bg-plum/90 font-sans text-xs font-semibold text-frost transition-colors h-[26px]"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Save Scene</span>
            </button>

            <label className="flex flex-col gap-1 col-span-2 sm:col-span-4 lg:col-span-8">
              <select
                aria-label="Scene Target Override"
                value={sceneTargetOverride}
                onChange={(e) => setSceneTargetOverride(e.target.value)}
                className="bg-ink border border-steel rounded px-2 py-1 text-[11px] font-mono text-fog"
              >
                <option value="">Target Override: Block Default</option>
                {targetOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        {/* Right 4 Cols: Daslight FX Type Tiles & FX Block Library */}
        <section
          data-testid="daslight-fx-rack"
          className="xl:col-span-4 bg-slate border border-steel rounded-panel p-3 flex flex-col gap-2.5"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-cobalt" />
              <h3 className="font-sans text-sm font-semibold text-frost">
                FX Engine ({showState.fx_library.length})
              </h3>
            </div>
          </div>

          {/* Daslight 2x2 Effect Type Tile Matrix */}
          <div className="grid grid-cols-2 gap-1.5 font-mono text-[11px]">
            {(
              [
                { kind: "curve_1d", label: "CURVE FX" },
                { kind: "step_chase", label: "CHASER FX" },
                { kind: "spatial_shader_2d", label: "2D SHADER" },
                { kind: "static_trait", label: "STATIC FX" },
              ] as const
            ).map((tile) => (
              <button
                key={tile.kind}
                type="button"
                aria-pressed={fxKind === tile.kind}
                onClick={() => setFxKind(tile.kind)}
                className={`py-2 px-2 rounded border text-center font-semibold tracking-wider transition-colors ${
                  fxKind === tile.kind
                    ? "bg-cobalt/30 border-cobalt text-frost"
                    : "bg-pitch border-steel text-fog hover:text-mist"
                }`}
              >
                {tile.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 bg-pitch border border-steel rounded p-2.5">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] text-fog">Block Name</span>
              <input
                aria-label="FX Block Name"
                type="text"
                value={fxName}
                onChange={(e) => setFxName(e.target.value)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-sans text-frost"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] text-fog">
                Target Group / Fixture
              </span>
              <select
                aria-label="FX Block Target Group"
                value={fxTargetGroup}
                onChange={(e) => setFxTargetGroup(e.target.value)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              >
                {targetOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] text-fog">
                Duration (Beats)
              </span>
              <input
                aria-label="FX Block Duration Beats"
                type="number"
                min={0.25}
                step={0.25}
                value={fxDurationBeats}
                onChange={(e) => setFxDurationBeats(Number(e.target.value) || 4)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] text-fog">
                Generator Kind
              </span>
              <select
                aria-label="FX Generator Kind"
                value={fxKind}
                onChange={(e) => setFxKind(e.target.value as GeneratorKind)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              >
                <option value="curve_1d">1D Curve Oscillator</option>
                <option value="step_chase">1D Step Chase</option>
                <option value="spatial_shader_2d">2D Spatial Shader</option>
                <option value="static_trait">Static Palette Trait</option>
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] text-fog">Trait Target</span>
              <select
                aria-label="FX Trait"
                value={fxTrait}
                onChange={(e) => setFxTrait(e.target.value)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              >
                <option value="dimmer">dimmer</option>
                {(fxKind === "static_trait" ||
                  fxKind === "spatial_shader_2d") && (
                  <option value="color">color</option>
                )}
                {(fxKind === "curve_1d" || fxKind === "step_chase") && (
                  <>
                    <option value="red">red</option>
                    <option value="green">green</option>
                    <option value="blue">blue</option>
                    <option value="white">white</option>
                    <option value="hue_shift">hue_shift</option>
                  </>
                )}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] text-fog">Merge Op</span>
              <select
                aria-label="FX Merge Op"
                value={fxOp}
                onChange={(e) => setFxOp(e.target.value as MergeOp)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              >
                <option value="htp">HTP</option>
                <option value="ltp">LTP</option>
                <option value="add">ADD (Bipolar)</option>
                <option value="scale">SCALE</option>
              </select>
            </label>

            {fxKind === "curve_1d" && (
              <>
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">Waveform</span>
                  <select
                    aria-label="FX Waveform"
                    value={fxWaveform}
                    onChange={(e) =>
                      setFxWaveform(e.target.value as Waveform1D)
                    }
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  >
                    <option value="sine">sine</option>
                    <option value="triangle">triangle</option>
                    <option value="saw">saw</option>
                    <option value="square">square</option>
                    <option value="pulse">pulse</option>
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Rate (Beats)
                  </span>
                  <input
                    aria-label="FX Rate Beats"
                    type="number"
                    min={0.125}
                    step={0.25}
                    value={fxRateBeats}
                    onChange={(e) => setFxRateBeats(Number(e.target.value) || 1)}
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Amplitude
                  </span>
                  <input
                    aria-label="FX Amplitude"
                    type="number"
                    step={0.1}
                    value={fxAmplitude}
                    onChange={(e) => setFxAmplitude(Number(e.target.value) || 0)}
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">Offset</span>
                  <input
                    aria-label="FX Offset"
                    type="number"
                    step={0.1}
                    value={fxOffset}
                    onChange={(e) => setFxOffset(Number(e.target.value) || 0)}
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Phase Spread (Deg)
                  </span>
                  <input
                    aria-label="FX Phase Spread"
                    type="number"
                    step={15}
                    value={fxPhaseSpreadDeg}
                    onChange={(e) =>
                      setFxPhaseSpreadDeg(Number(e.target.value) || 0)
                    }
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>

                {fxWaveform === "pulse" && (
                  <label className="flex flex-col gap-1">
                    <span className="font-mono text-[11px] text-fog">
                      Duty Cycle
                    </span>
                    <input
                      aria-label="FX Duty"
                      type="number"
                      min={0.05}
                      max={0.95}
                      step={0.05}
                      value={fxDuty}
                      onChange={(e) => setFxDuty(Number(e.target.value) || 0.5)}
                      className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                    />
                  </label>
                )}
              </>
            )}

            {fxKind === "step_chase" && (
              <>
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Step Beats
                  </span>
                  <input
                    aria-label="FX Step Beats"
                    type="number"
                    min={0.125}
                    step={0.25}
                    value={fxStepBeats}
                    onChange={(e) => setFxStepBeats(Number(e.target.value) || 1)}
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Active Ratio
                  </span>
                  <input
                    aria-label="FX Active Ratio"
                    type="number"
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={fxActiveRatio}
                    onChange={(e) =>
                      setFxActiveRatio(Number(e.target.value) || 0.25)
                    }
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">Fade</span>
                  <input
                    aria-label="FX Chase Fade"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={fxFade}
                    onChange={(e) => setFxFade(Number(e.target.value) || 0)}
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Amplitude
                  </span>
                  <input
                    aria-label="FX Chase Amplitude"
                    type="number"
                    step={0.1}
                    value={fxAmplitude}
                    onChange={(e) => setFxAmplitude(Number(e.target.value) || 0)}
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>
              </>
            )}

            {fxKind === "spatial_shader_2d" && (
              <>
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    2D Shader
                  </span>
                  <select
                    aria-label="FX Shader Kind"
                    value={fxShader}
                    onChange={(e) =>
                      setFxShader(e.target.value as Shader2DKind)
                    }
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  >
                    <option value="linear_sweep">linear_sweep</option>
                    <option value="radial_wave">radial_wave</option>
                    <option value="pinwheel">pinwheel</option>
                    <option value="plasma">plasma</option>
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Color Palette
                  </span>
                  <select
                    aria-label="FX Palette Ref"
                    value={fxPaletteRef}
                    onChange={(e) => setFxPaletteRef(e.target.value)}
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  >
                    <option value="">None</option>
                    {showState.color_palettes.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.id})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Spatial Freq
                  </span>
                  <input
                    aria-label="FX Spatial Freq"
                    type="number"
                    min={0.1}
                    step={0.25}
                    value={fxSpatialFreq}
                    onChange={(e) =>
                      setFxSpatialFreq(Number(e.target.value) || 1)
                    }
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Direction (Deg)
                  </span>
                  <input
                    aria-label="FX Direction Deg"
                    type="number"
                    step={15}
                    value={fxDirectionDeg}
                    onChange={(e) =>
                      setFxDirectionDeg(Number(e.target.value) || 0)
                    }
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Center X
                  </span>
                  <input
                    aria-label="FX Center X"
                    type="number"
                    step={0.1}
                    value={fxCenterX}
                    onChange={(e) => setFxCenterX(Number(e.target.value) || 0)}
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Center Y
                  </span>
                  <input
                    aria-label="FX Center Y"
                    type="number"
                    step={0.1}
                    value={fxCenterY}
                    onChange={(e) => setFxCenterY(Number(e.target.value) || 0)}
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>
              </>
            )}

            {fxKind === "static_trait" && (
              <>
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Palette Ref
                  </span>
                  <select
                    aria-label="FX Static Palette Ref"
                    value={fxPaletteRef}
                    onChange={(e) => setFxPaletteRef(e.target.value)}
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  >
                    <option value="">Manual Scalar</option>
                    {showState.color_palettes.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.id})
                      </option>
                    ))}
                    {showState.dimmer_palettes.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.id})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Start / End
                  </span>
                  <div className="flex gap-1">
                    <input
                      aria-label="FX Static Start"
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={fxStaticStart}
                      onChange={(e) =>
                        setFxStaticStart(Number(e.target.value) || 0)
                      }
                      className="w-full bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                    />
                    <input
                      aria-label="FX Static End"
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={fxStaticEnd}
                      onChange={(e) =>
                        setFxStaticEnd(Number(e.target.value) || 0)
                      }
                      className="w-full bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                    />
                  </div>
                </label>
              </>
            )}

            {fxKind !== "spatial_shader_2d" && (
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[11px] text-fog">Order</span>
                <select
                  aria-label="FX Order Rule"
                  value={fxOrder}
                  onChange={(e) => setFxOrder(e.target.value as OrderRuleStr)}
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                >
                  <option value="linear">linear</option>
                  <option value="reverse">reverse</option>
                  <option value="center_out">center_out</option>
                  <option value="mirror">mirror</option>
                  <option value="odd_even">odd_even</option>
                  <option value="blocks(2)">blocks(2)</option>
                  <option value="blocks(4)">blocks(4)</option>
                </select>
              </label>
            )}

            <label className="flex items-center gap-2 col-span-2 pt-1">
              <input
                aria-label="FX Block Loop"
                type="checkbox"
                checked={fxLoop}
                onChange={(e) => setFxLoop(e.target.checked)}
              />
              <span className="font-mono text-xs text-mist">
                Loop block modulo duration beats
              </span>
            </label>

            <button
              type="button"
              onClick={() => void handleSaveFxBlock()}
              className="col-span-2 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-cobalt hover:bg-cobalt/90 font-sans text-xs font-semibold text-frost transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Save FX Block</span>
            </button>
          </div>

          <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto">
            {showState.fx_library.map((blk) => (
              <div
                key={blk.id}
                className="flex items-center justify-between gap-2 bg-pitch border border-steel rounded px-2.5 py-2"
              >
                <div className="min-w-0">
                  <div className="font-sans text-xs font-semibold text-frost truncate">
                    {blk.name}
                  </div>
                  <div className="font-mono text-[11px] text-fog truncate">
                    {blk.id} | Target: {blk.target_group ?? "all"} |{" "}
                    {blk.duration_beats} beats |{" "}
                    {blk.elements.map((el) => el.kind).join(", ")}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Delete FX Block ${blk.name}`}
                  onClick={() => void deleteFxBlock(blk.id)}
                  className="p-1 rounded border border-steel bg-ink text-signal hover:bg-slate-dark"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Live Evaluated Cell Preview (rendered directly when standalone; unified in bottom dock when in Studio) */}
      {!daslightUpper && (
        <section className="bg-slate border border-steel rounded-panel p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="font-sans text-sm font-semibold text-frost">
              Live Evaluated Cell Output ({compiledCells.length} cells)
            </h3>
          </div>

          <div
            data-testid="scene-live-cell-preview"
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
      )}
    </div>
  );
}
