import {
  Activity,
  ArrowDown,
  ArrowUp,
  AudioWaveform,
  ChevronDown,
  Copy,
  Layers,
  Link2,
  Pause,
  Pencil,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { startScenePointerDrag } from "../lib/sceneDrag";
import {
  amplitudeOffsetToRangePct,
  buildCurve1DSvgPreview,
  buildStepChasePreviewBlocks,
  computeSceneSequenceDurationSec,
  computeTargetGizmoBounds,
  DEFAULT_COLOR_PALETTES,
  type DurationUnit,
  type FxBlockDef,
  type FxElementDef,
  type FxKindTag,
  linearRgbToSrgbHex,
  type MergeOp,
  patternScaleToSpatialFreq,
  rangePctToAmplitudeOffset,
  sampleOklabStopsLinear,
  sampleValueStops,
  type SceneDef,
  type SceneSequenceStepDef,
  type SequencePlaybackMode,
  type Shader2DKind,
  spatialFreqToPatternScale,
  type Waveform1D,
} from "../lib/mixerLogic";
import { expandTargetRange, type OrderRuleStr } from "../lib/patchLogic";
import { DEFAULT_STUDIO_LAYOUT, useTaktStore } from "../store/useTaktStore";
import { HelpTooltip } from "./HelpTooltip";
import { SplitHandle } from "./SplitHandle";

const BANK_COLOR_PRESETS = [
  "#FBBF24", // Amber
  "#FF5500", // Ember
  "#EF4444", // Red
  "#EC4899", // Pink
  "#A855F7", // Purple
  "#3B82F6", // Blue
  "#06B6D4", // Cyan
  "#22C55E", // Green
  "#84CC16", // Lime
  "#94A3B8", // Slate
] as const;
import { ColorPaletteBuilderModal } from "./ColorPaletteBuilderModal";
import { NumericSlider } from "./NumericSlider";
import { TimelineRightInspector } from "./TimelineRightInspector";

type GeneratorKind = FxElementDef["kind"];
type SceneMode = "color" | "color_anim" | "effect";
type DaslightFxSubmenu =
  | "color_fx"
  | "color_mappings"
  | "chaser_fx"
  | "value_fx"
  | "curve_fx"
  | "mappings"
  | "scene_sequence";
type InspectorRailTab = "fx" | "properties" | "settings";

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

export function classifySceneMode(
  scene: SceneDef | null,
  fxLibrary: FxBlockDef[],
): SceneMode {
  if (!scene) return "effect";
  const blk = scene.block_refs[0]
    ? fxLibrary.find((b) => b.id === scene.block_refs[0])
    : null;
  if (!blk || blk.elements.length === 0) return "effect";
  const primary =
    blk.elements.length === 1
      ? blk.elements[0]
      : (blk.elements.find(
          (e) => e.kind === "scene_sequence" || e.trait !== "dimmer",
        ) ?? blk.elements[0]);
  if (primary.kind === "scene_sequence") return "effect";
  if (primary.trait === "color") {
    if (primary.kind === "static_trait") return "color";
    if (primary.kind === "spatial_shader_2d" && primary.rate_cycles === 0) {
      return "color";
    }
    return "color_anim";
  }
  return "effect";
}

function isStaticDockElement(el: FxElementDef): boolean {
  return (
    el.kind === "static_trait" &&
    (el.trait === "dimmer" ||
      el.trait === "master_dimmer" ||
      el.trait === "color")
  );
}

function classifyElementSubmenu(el: FxElementDef | undefined): DaslightFxSubmenu {
  if (!el) return "curve_fx";
  if (el.kind === "scene_sequence") {
    return "scene_sequence";
  }
  if (el.kind === "spatial_shader_2d") {
    return el.trait === "color" ? "color_mappings" : "mappings";
  }
  if (el.kind === "step_chase") {
    return "chaser_fx";
  }
  if (el.kind === "curve_1d") {
    if (el.trait === "color") return "color_fx";
    if (
      el.fx_kind_tag === "value_fx" ||
      (el.value_stops && el.value_stops.length > 0)
    ) {
      return "value_fx";
    }
    return "curve_fx";
  }
  return "curve_fx";
}

function describeElementShort(el: FxElementDef | undefined): string {
  if (!el) return "BLANK";
  if (el.kind === "static_trait") {
    if (el.trait === "color") return "STATIC COLOR";
    return "DIMMER";
  }
  switch (classifyElementSubmenu(el)) {
    case "color_fx":
      return "COLOR FX";
    case "color_mappings":
      return "COLOR MAPPINGS";
    case "chaser_fx":
      return "CHASER FX";
    case "value_fx":
      return "VALUE FX";
    case "curve_fx":
      return "CURVE FX";
    case "mappings":
      return "MAPPINGS";
    case "scene_sequence":
      return "SEQUENCE";
  }
}

function submenuLabel(submenu: DaslightFxSubmenu): string {
  switch (submenu) {
    case "color_fx":
      return "COLOR FX";
    case "color_mappings":
      return "COLOR MAPPINGS";
    case "chaser_fx":
      return "CHASER FX";
    case "value_fx":
      return "VALUE FX";
    case "curve_fx":
      return "CURVE FX";
    case "mappings":
      return "MAPPINGS";
    case "scene_sequence":
      return "SCENE SEQUENCE";
  }
}

function buildElementFromForm(params: {
  kind: GeneratorKind;
  trait: string;
  op: MergeOp;
  waveform: Waveform1D;
  amplitude: number;
  offset: number;
  timingMode: "cycles" | "beats" | "hz";
  rateCycles: number;
  phaseOffset?: number;
  rateBeats: number;
  speedHz: number;
  phaseDeg: number;
  phaseSpreadDeg: number;
  duty: number;
  stepBeats: number;
  oneWay: boolean;
  pixelsOn: number;
  activeRatio: number;
  fade: number;
  shader: Shader2DKind;
  spatialFreq: number;
  directionDeg: number;
  centerX: number;
  centerY: number;
  boxHalfX?: number | null;
  boxHalfY?: number | null;
  paletteRef: string;
  inlineColors: string[];
  valueStops: number[];
  grayscale: boolean;
  colorWidth: number;
  gradient: number;
  angleDeg: number;
  fxKindTag: FxKindTag | null;
  transform: string;
  staticStart: number;
  staticEnd: number;
  order: OrderRuleStr;
  sequencePlaybackMode?: SequencePlaybackMode;
  sequenceSteps?: SceneSequenceStepDef[];
}): FxElementDef {
  const paletteRef = params.paletteRef.trim() ? params.paletteRef.trim() : null;
  const useHz = params.timingMode === "hz";
  const useBeats = params.timingMode === "beats";
  const rateCycles = Math.max(0.1, params.rateCycles || 1);
  const spatialRateCycles = Math.max(0, params.rateCycles ?? 1);
  switch (params.kind) {
    case "curve_1d":
      return {
        kind: "curve_1d",
        trait: params.trait,
        op: params.op,
        waveform: params.waveform,
        amplitude: params.amplitude,
        offset: params.offset,
        rate_beats: useBeats ? params.rateBeats : null,
        speed_hz: useHz ? params.speedHz : null,
        rate_cycles: !useHz && !useBeats ? rateCycles : null,
        phase_deg: params.phaseDeg,
        phase_spread_deg: params.phaseSpreadDeg,
        duty:
          params.waveform === "pulse" || params.waveform === "square"
            ? params.duty
            : null,
        grayscale: params.grayscale,
        color_width: params.colorWidth,
        gradient: params.gradient,
        angle_deg: params.angleDeg,
        fx_kind_tag: params.fxKindTag,
        inline_colors:
          params.trait === "color" && params.inlineColors.length > 0
            ? params.inlineColors
            : undefined,
        value_stops:
          params.fxKindTag === "value_fx" && params.valueStops.length > 0
            ? params.valueStops
            : undefined,
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
        step_beats: useBeats ? params.stepBeats : null,
        speed_hz: useHz ? params.speedHz : null,
        rate_cycles: !useHz && !useBeats ? rateCycles : null,
        one_way: params.oneWay,
        pixels_on: Math.max(1, Math.round(params.pixelsOn || 1)),
        active_ratio: null,
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
        rate_beats: useBeats ? params.rateBeats : null,
        speed_hz: useHz ? params.speedHz : null,
        rate_cycles: !useHz && !useBeats ? spatialRateCycles : null,
        phase_offset: params.phaseOffset ?? 0,
        spatial_freq: params.spatialFreq,
        color_width: params.colorWidth,
        gradient: params.gradient,
        grayscale: params.grayscale,
        transform: params.transform ? params.transform : null,
        inline_colors: params.inlineColors.length > 0 ? params.inlineColors : undefined,
        value_stops: params.valueStops.length > 0 ? params.valueStops : undefined,
        direction_deg: params.directionDeg,
        center_x: params.centerX,
        center_y: params.centerY,
        ...(params.boxHalfX != null ? { box_half_x: params.boxHalfX } : {}),
        ...(params.boxHalfY != null ? { box_half_y: params.boxHalfY } : {}),
      };
    case "scene_sequence":
      return {
        kind: "scene_sequence",
        playback_mode: params.sequencePlaybackMode ?? "loop",
        steps: params.sequenceSteps ?? [],
      };
  }
}

function SceneLiveCellPreview() {
  const compiledCells = useTaktStore((s) => s.compiledCells);
  const cellPreviewRgbd = useTaktStore((s) => s.cellPreviewRgbd);
  return (
    <section
      data-testid="scene-live-cell-preview"
      className="bg-slate border border-steel rounded-panel p-3 flex flex-wrap gap-1.5"
    >
      {compiledCells.map((cell, idx) => {
        const base = idx * 4;
        const r = cellPreviewRgbd[base] ?? 0;
        const g = cellPreviewRgbd[base + 1] ?? 0;
        const b = cellPreviewRgbd[base + 2] ?? 0;
        const d = cellPreviewRgbd[base + 3] ?? 0;
        const scale = d / 255;
        return (
          <div
            key={`${cell.fixture_id}-${cell.cell_index}`}
            className="w-8 h-8 rounded border border-steel"
            style={{
              backgroundColor: `rgb(${Math.round(r * scale)}, ${Math.round(g * scale)}, ${Math.round(b * scale)})`,
            }}
          />
        );
      })}
    </section>
  );
}

export function SceneAndFxManager({
  hideUndoRedo = false,
  daslightUpper = false,
  liveBuskingMode = false,
  showInspector = true,
}: {
  hideUndoRedo?: boolean;
  daslightUpper?: boolean;
  liveBuskingMode?: boolean;
  showInspector?: boolean;
}) {
  const showState = useTaktStore((s) => s.showState);
  const fixtureDetailsCache = useTaktStore((s) => s.fixtureDetailsCache);
  const activeScenes = useTaktStore((s) => s.activeScenes);
  const liveBpm = useTaktStore((s) => s.liveBpm);
  const compiledCells = useTaktStore((s) => s.compiledCells);
  const canUndo = useTaktStore((s) => s.canUndo);
  const canRedo = useTaktStore((s) => s.canRedo);
  const selectedSceneId = useTaktStore((s) => s.selectedSceneId);
  const multiSelectedSceneIds = useTaktStore((s) => s.multiSelectedSceneIds);
  const sceneBanks = useTaktStore((s) => s.sceneBanks);
  const stackableBanks = useTaktStore((s) => s.stackableBanks);
  const bankColors = useTaktStore((s) => s.bankColors);
  const flashSceneIds = useTaktStore((s) => s.flashSceneIds);
  const mappingOverlayMode = useTaktStore((s) => s.mappingOverlayMode);
  const draggingSceneId = useTaktStore((s) => s.draggingSceneId);
  const keyBindings = useTaktStore((s) => s.keyBindings);
  const midiBindings = useTaktStore((s) => s.midiBindings);

  const upsertFxBlock = useTaktStore((s) => s.upsertFxBlock);
  const upsertScene = useTaktStore((s) => s.upsertScene);
  const deleteScene = useTaktStore((s) => s.deleteScene);
  const triggerScene = useTaktStore((s) => s.triggerScene);
  const releaseScene = useTaktStore((s) => s.releaseScene);
  const releaseBankScenes = useTaktStore((s) => s.releaseBankScenes);
  const releaseAllScenes = useTaktStore((s) => s.releaseAllScenes);
  const setLiveBpm = useTaktStore((s) => s.setLiveBpm);
  const tapTempo = useTaktStore((s) => s.tapTempo);
  const undoShow = useTaktStore((s) => s.undoShow);
  const redoShow = useTaktStore((s) => s.redoShow);
  const selectSceneForEdit = useTaktStore((s) => s.selectSceneForEdit);
  const createQuickSceneInBank = useTaktStore(
    (s) => s.createQuickSceneInBank,
  );
  const convertSceneToTimeline = useTaktStore(
    (s) => s.convertSceneToTimeline,
  );
  const createSceneBank = useTaktStore((s) => s.createSceneBank);
  const reorderSceneBanks = useTaktStore((s) => s.reorderSceneBanks);
  const renameSceneBank = useTaktStore((s) => s.renameSceneBank);
  const deleteSceneBank = useTaktStore((s) => s.deleteSceneBank);
  const toggleBankStackable = useTaktStore((s) => s.toggleBankStackable);
  const setBankColor = useTaktStore((s) => s.setBankColor);
  const duplicateScene = useTaktStore((s) => s.duplicateScene);
  const batchUpdateSelectedScenes = useTaktStore(
    (s) => s.batchUpdateSelectedScenes,
  );
  const toggleSceneFlashMode = useTaktStore((s) => s.toggleSceneFlashMode);
  const makeFxBlockUniqueForScene = useTaktStore(
    (s) => s.makeFxBlockUniqueForScene,
  );
  const setSelectedMappingTarget = useTaktStore(
    (s) => s.setSelectedMappingTarget,
  );
  const setActiveShaderGizmoBlockId = useTaktStore(
    (s) => s.setActiveShaderGizmoBlockId,
  );
  const studioLayout = useTaktStore((s) => s.studioLayout);
  const setStudioLayout = useTaktStore((s) => s.setStudioLayout);
  const gizmoAutoFit = useTaktStore((s) => s.gizmoAutoFit);
  const setGizmoAutoFit = useTaktStore((s) => s.setGizmoAutoFit);

  // Bank UI state
  const [selectedBankFilter, setSelectedBankFilter] = useState<string>("all");
  const [paletteBuilderOpen, setPaletteBuilderOpen] = useState<boolean>(false);
  const [renamingBank, setRenamingBank] = useState<string | null>(null);
  const [renameBankValue, setRenameBankValue] = useState("");
  const [draggingBank, setDraggingBank] = useState<string | null>(null);
  const [dragOverBank, setDragOverBank] = useState<string | null>(null);
  const [dragOverSceneBank, setDragOverSceneBank] = useState<string | null>(null);
  const [renamingSceneId, setRenamingSceneId] = useState<string | null>(null);
  const [renameSceneValue, setRenameSceneValue] = useState("");
  const [bankContextMenu, setBankContextMenu] = useState<{
    bank: string;
    x: number;
    y: number;
  } | null>(null);
  const [sceneContextMenu, setSceneContextMenu] = useState<{
    sceneId: string;
    x: number;
    y: number;
  } | null>(null);

  // Right Inspector state (lands on Choice Matrix matching Daslight 5)
  const [inspectorRailTab, setInspectorRailTab] =
    useState<InspectorRailTab>("fx");
  const [fxPickerMode, setFxPickerMode] = useState<boolean>(true);
  const [fxAppendMode, setFxAppendMode] = useState<boolean>(false);
  const [activeElementIdx, setActiveElementIdx] = useState<number>(0);

  // Scene-first Inspector state (syncs to active procedural element in selectedScene's backing block)
  const [fxName, setFxName] = useState("Pulse Wave");
  const [fxTargetGroup, setFxTargetGroup] = useState("all");
  const [fxDurationBeats, setFxDurationBeats] = useState(4);
  const [fxLoop, setFxLoop] = useState(true);
  const [fxKind, setFxKind] = useState<GeneratorKind>("curve_1d");
  const [fxTrait, setFxTrait] = useState("dimmer");
  const [fxOp, setFxOp] = useState<MergeOp>("ltp");
  const [fxKindTag, setFxKindTag] = useState<FxKindTag | null>("curve_fx");
  const [fxWaveform, setFxWaveform] = useState<Waveform1D>("sine");
  const [fxAmplitude, setFxAmplitude] = useState(1.0);
  const [fxOffset, setFxOffset] = useState(0.0);
  const [fxTimingMode, setFxTimingMode] = useState<"cycles" | "beats" | "hz">(
    "cycles",
  );
  const [fxRateCycles, setFxRateCycles] = useState(1.0);
  const [fxPhaseOffset, setFxPhaseOffset] = useState(0.0);
  const lastNonZeroRateRef = useRef(1.0);
  const [fxRateBeats, setFxRateBeats] = useState(2.0);
  const [fxSpeedHz, setFxSpeedHz] = useState(1.0);
  const [fxPhaseDeg, setFxPhaseDeg] = useState(0);
  const [fxPhaseSpreadDeg, setFxPhaseSpreadDeg] = useState(360);
  const [fxDuty, setFxDuty] = useState(0.5);
  const [fxStepBeats, setFxStepBeats] = useState(1.0);
  const [fxOneWay, setFxOneWay] = useState(true);
  const [fxPixelsOn, setFxPixelsOn] = useState(1);
  const [fxActiveRatio, setFxActiveRatio] = useState(0.25);
  const [fxFade, setFxFade] = useState(0);
  const [fxShader, setFxShader] = useState<Shader2DKind>("linear_sweep");
  const [fxSpatialFreq, setFxSpatialFreq] = useState(1.0);
  const [fxDirectionDeg, setFxDirectionDeg] = useState(0);
  const [fxCenterX, setFxCenterX] = useState(0.5);
  const [fxCenterY, setFxCenterY] = useState(0.5);
  const [fxPaletteRef, setFxPaletteRef] = useState(
    showState.color_palettes[0]?.id ?? DEFAULT_COLOR_PALETTES[0].id,
  );
  const [fxInlineColors, setFxInlineColors] = useState<string[]>(
    showState.color_palettes[0]?.colors ?? DEFAULT_COLOR_PALETTES[0].colors ?? ["#FF0000", "#0044FF"],
  );
  const [fxValueStops, setFxValueStops] = useState<number[]>([1, 0.5, 0]);
  const [selectedValueStopIdx, setSelectedValueStopIdx] = useState<number>(0);
  const [fxGrayscale, setFxGrayscale] = useState<boolean>(false);
  const [fxColorWidth, setFxColorWidth] = useState<number>(1.0);
  const [fxGradient, setFxGradient] = useState<number>(1.0);
  const [fxAngleDeg, setFxAngleDeg] = useState<number>(0);
  const [fxTransform, setFxTransform] = useState<string>("");
  const [fxStaticStart, setFxStaticStart] = useState(0.0);
  const [fxStaticEnd, setFxStaticEnd] = useState(1.0);
  const [fxOrder, setFxOrder] = useState<OrderRuleStr>("linear");
  const [fxSeqPlaybackMode, setFxSeqPlaybackMode] =
    useState<SequencePlaybackMode>("loop");
  const [fxSeqSteps, setFxSeqSteps] = useState<SceneSequenceStepDef[]>([]);
  const [seqDropNotice, setSeqDropNotice] = useState<string | null>(null);
  const [seqAddSceneId, setSeqAddSceneId] = useState<string>("");

  // Legacy Slice 5 programmatic form state (zero fades by default)
  const [sceneName, setSceneName] = useState("Main Wash");
  const [sceneBank, setSceneBank] = useState("Bank 1");
  const [scenePriority, setScenePriority] = useState(15);
  const [sceneFadeIn, setSceneFadeIn] = useState(0);
  const [sceneFadeOut, setSceneFadeOut] = useState(0);
  const [sceneBlockRef, setSceneBlockRef] = useState(
    showState.fx_library[0]?.id ?? "",
  );

  // Batch edit state (zero fades by default)
  const [batchFadeIn, setBatchFadeIn] = useState(0);
  const [batchFadeOut, setBatchFadeOut] = useState(0);
  const [batchPriority, setBatchPriority] = useState(10);

  // Close context menus on global click/escape
  useEffect(() => {
    if (!bankContextMenu && !sceneContextMenu) return;
    const close = () => {
      setBankContextMenu(null);
      setSceneContextMenu(null);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [bankContextMenu, sceneContextMenu]);

  useEffect(() => {
    if (!draggingSceneId) {
      setDragOverSceneBank(null);
    }
  }, [draggingSceneId]);

  useEffect(() => {
    const onSceneBankDrop = (e: Event) => {
      const detail = (
        e as CustomEvent<{ sceneId: string; targetBank: string }>
      ).detail;
      if (!detail?.sceneId || !detail?.targetBank) return;
      setDragOverSceneBank(null);
      const target = showState.scenes.find((s) => s.id === detail.sceneId);
      if (!target) return;
      const nextBank = detail.targetBank.trim();
      if (!nextBank || target.bank?.trim() === nextBank) return;
      void upsertScene({ ...target, bank: nextBank });
    };
    window.addEventListener("takt:scene-bank-drop", onSceneBankDrop);
    return () => {
      window.removeEventListener("takt:scene-bank-drop", onSceneBankDrop);
    };
  }, [showState.scenes, upsertScene]);

  const selectedScene = useMemo(
    () =>
      showState.scenes.find((s) => s.id === selectedSceneId) ??
      showState.scenes[0] ??
      null,
    [selectedSceneId, showState.scenes],
  );

  const selectedScenePrimaryBlock = useMemo(() => {
    if (!selectedScene) return null;
    const refId = selectedScene.block_refs[0];
    return showState.fx_library.find((b) => b.id === refId) ?? null;
  }, [selectedScene, showState.fx_library]);

  const proceduralElements = useMemo(
    () =>
      (selectedScenePrimaryBlock?.elements ?? []).filter(
        (el) => !isStaticDockElement(el),
      ),
    [selectedScenePrimaryBlock],
  );

  const availableFxTraitOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [
      { value: "dimmer", label: "Segment Dimmer" },
    ];
    const seen = new Set<string>(["dimmer"]);
    const addOpt = (value: string, label: string) => {
      if (seen.has(value)) return;
      seen.add(value);
      opts.push({ value, label });
    };

    const rawTarget = (fxTargetGroup || "all").trim();
    let targetFixtures = showState.patch;
    if (rawTarget && rawTarget !== "all" && rawTarget !== "*") {
      const grp = showState.groups.find((g) => g.id === rawTarget);
      const refs = grp ? grp.targets : [rawTarget];
      const fxIds = new Set(
        refs.map((r) => {
          const t = r.trim();
          const colon = t.indexOf(":");
          return colon === -1 ? t : t.slice(0, colon).trim();
        }),
      );
      const filtered = showState.patch.filter((f) => fxIds.has(f.id));
      if (filtered.length > 0) targetFixtures = filtered;
    }

    let hasMaster = false;
    let hasRed = false;
    let hasGreen = false;
    let hasBlue = false;
    let hasWhite = false;
    let hasStrobe = false;
    let hasPan = false;
    let hasTilt = false;
    const customNames: string[] = [];

    for (const fx of targetFixtures) {
      const detail = fixtureDetailsCache[fx.profile];
      const mode = detail?.expanded_modes.find((m) => m.name === fx.mode);
      for (const ch of mode?.channels ?? []) {
        if (ch.role.kind === "intensity" && ch.target.scope === "fixture") {
          hasMaster = true;
        } else if (ch.role.kind === "color_intensity") {
          const c = ch.role.color.toLowerCase();
          if (c.includes("red")) hasRed = true;
          else if (c.includes("green")) hasGreen = true;
          else if (c.includes("blue")) hasBlue = true;
          else if (c.includes("white")) hasWhite = true;
        } else if (ch.role.kind === "shutter_strobe") {
          hasStrobe = true;
        } else if (ch.role.kind === "unmapped") {
          const lower = ch.name.toLowerCase();
          if (lower.includes("pan")) hasPan = true;
          else if (lower.includes("tilt")) hasTilt = true;
          else if (!customNames.includes(ch.name)) customNames.push(ch.name);
        }
      }
    }

    if (hasMaster) addOpt("master_dimmer", "Master Dimmer");
    if (hasRed) addOpt("red", "Red");
    if (hasGreen) addOpt("green", "Green");
    if (hasBlue) addOpt("blue", "Blue");
    if (hasWhite) addOpt("white", "White");
    if (hasStrobe) addOpt("strobe", "Strobe");
    if (hasPan) addOpt("pan", "Pan");
    if (hasTilt) addOpt("tilt", "Tilt");
    for (const cName of customNames) {
      addOpt(`channel:${cName.toLowerCase()}`, cName);
    }
    if (fxTrait && !seen.has(fxTrait) && fxTrait !== "color") {
      addOpt(fxTrait, fxTrait);
    }
    return opts;
  }, [fixtureDetailsCache, fxTargetGroup, fxTrait, showState.groups, showState.patch]);

  const activeProceduralElement =
    proceduralElements[
      Math.max(0, Math.min(activeElementIdx, proceduralElements.length - 1))
    ];

  const activeSubmenu: DaslightFxSubmenu = useMemo(
    () => classifyElementSubmenu(activeProceduralElement),
    [activeProceduralElement],
  );

  const blockUsageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const sc of showState.scenes) {
      for (const refId of sc.block_refs) {
        counts[refId] = (counts[refId] ?? 0) + 1;
      }
    }
    return counts;
  }, [showState.scenes]);

  const allBanks = useMemo(() => {
    const ordered: string[] = [];
    for (const b of sceneBanks) {
      if (b.trim() && !ordered.includes(b.trim())) ordered.push(b.trim());
    }
    for (const sc of showState.scenes) {
      const b = sc.bank?.trim();
      if (b && !ordered.includes(b)) ordered.push(b);
    }
    if (ordered.length === 0) ordered.push("Bank 1");
    return ordered;
  }, [sceneBanks, showState.scenes]);

  const targetOptions = useMemo(() => {
    const opts = [{ value: "all", label: "All Fixtures" }];
    for (const grp of showState.groups) {
      opts.push({ value: grp.id, label: `Group: ${grp.name}` });
    }
    for (const fx of showState.patch) {
      opts.push({ value: fx.id, label: `Fixture: ${fx.name}` });
    }
    return opts;
  }, [showState.groups, showState.patch]);

  const targetBeamCount = useMemo(() => {
    const rawTarget = (
      selectedScene?.target_group ??
      selectedScenePrimaryBlock?.target_group ??
      "all"
    ).trim();
    if (!rawTarget || rawTarget === "all" || rawTarget === "*") {
      return compiledCells.length;
    }
    const grp = showState.groups.find((g) => g.id === rawTarget);
    const refs = grp ? grp.targets : [rawTarget];
    const keys = new Set<string>();
    for (const ref of refs) {
      const trimmed = ref.trim();
      const colonIdx = trimmed.indexOf(":");
      const fxId = colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx).trim();
      const fx = showState.patch.find((f) => f.id === fxId);
      if (!fx) continue;
      const detail = fixtureDetailsCache[fx.profile];
      const mode = detail?.expanded_modes.find((m) => m.name === fx.mode);
      const cellCount = mode?.cells.length ?? 1;
      for (const cIdx of expandTargetRange(trimmed, cellCount)) {
        keys.add(`${fxId}:${cIdx}`);
      }
    }
    return keys.size;
  }, [
    compiledCells.length,
    fixtureDetailsCache,
    selectedScene,
    selectedScenePrimaryBlock,
    showState.groups,
    showState.patch,
  ]);

  const effectiveBlockRef = useMemo(() => {
    if (
      sceneBlockRef &&
      showState.fx_library.some((b) => b.id === sceneBlockRef)
    ) {
      return sceneBlockRef;
    }
    return showState.fx_library[0]?.id ?? "";
  }, [sceneBlockRef, showState.fx_library]);

  const activeById = useMemo(
    () => new Map(activeScenes.map((s) => [s.scene_id, s])),
    [activeScenes],
  );

  const loadElementIntoEditor = (blk: FxBlockDef, procElemIdx: number) => {
    setFxName(blk.name);
    setFxTargetGroup(blk.target_group ?? "all");
    setFxDurationBeats(blk.duration_beats);
    setFxLoop(blk.loop_block);
    const procEls = blk.elements.filter((el) => !isStaticDockElement(el));
    if (procEls.length === 0) return;
    const clampedIdx = Math.max(0, Math.min(procElemIdx, procEls.length - 1));
    const el = procEls[clampedIdx];
    if (!el) return;
    setFxKind(el.kind);
    if (el.kind === "scene_sequence") {
      setFxSeqPlaybackMode(el.playback_mode ?? "loop");
      setFxSeqSteps(el.steps ?? []);
      setSeqDropNotice(null);
      return;
    }
    setFxTrait(el.trait);
    setFxOp(el.op);
    if (el.palette_ref) {
      setFxPaletteRef(el.palette_ref);
      const pal = showState.color_palettes.find((p) => p.id === el.palette_ref);
      if (pal) {
        setFxInlineColors(pal.colors ?? [pal.hex_start, pal.hex_end]);
      }
    }
    if (el.kind === "curve_1d") {
      setFxKindTag(el.fx_kind_tag ?? (el.trait === "color" ? "color_fx" : "curve_fx"));
      setFxWaveform(el.waveform);
      setFxAmplitude(el.amplitude);
      setFxOffset(el.offset);
      setFxPhaseDeg(el.phase_deg ?? 0);
      setFxPhaseSpreadDeg(el.phase_spread_deg);
      setFxDuty(el.duty ?? 0.5);
      setFxGrayscale(el.grayscale ?? false);
      setFxColorWidth(el.color_width ?? 1);
      setFxGradient(el.gradient ?? 1);
      setFxAngleDeg(el.angle_deg ?? 0);
      if (el.inline_colors && el.inline_colors.length > 0) {
        setFxInlineColors(el.inline_colors);
      }
      if (el.value_stops && el.value_stops.length > 0) {
        setFxValueStops(el.value_stops);
        setSelectedValueStopIdx(0);
      } else if (el.fx_kind_tag === "value_fx") {
        setFxValueStops([1, 0.5, 0]);
        setSelectedValueStopIdx(0);
      }
      if (el.speed_hz && el.speed_hz > 0) {
        setFxTimingMode("hz");
        setFxSpeedHz(el.speed_hz);
        setFxRateCycles(el.rate_cycles ?? 1);
      } else if (el.rate_beats && el.rate_beats > 0) {
        setFxTimingMode("beats");
        setFxRateBeats(el.rate_beats);
        setFxRateCycles(el.rate_cycles ?? 1);
      } else {
        setFxTimingMode("cycles");
        setFxRateCycles(el.rate_cycles ?? 1);
      }
      if (el.order) setFxOrder(el.order);
    } else if (el.kind === "step_chase") {
      setFxKindTag(null);
      setFxOneWay(el.one_way ?? true);
      setFxPixelsOn(el.pixels_on ?? 1);
      setFxActiveRatio(el.active_ratio ?? 0.25);
      setFxFade(el.fade ?? 0);
      setFxAmplitude(el.amplitude);
      if (el.speed_hz && el.speed_hz > 0) {
        setFxTimingMode("hz");
        setFxSpeedHz(el.speed_hz);
        setFxRateCycles(el.rate_cycles ?? 1);
      } else if (el.step_beats && el.step_beats > 0) {
        setFxTimingMode("beats");
        setFxStepBeats(el.step_beats);
        setFxRateCycles(el.rate_cycles ?? 1);
      } else {
        setFxTimingMode("cycles");
        setFxRateCycles(el.rate_cycles ?? 1);
      }
      if (el.order) setFxOrder(el.order);
    } else if (el.kind === "spatial_shader_2d") {
      setFxKindTag(null);
      setFxShader(el.shader);
      setFxSpatialFreq(el.spatial_freq);
      setFxColorWidth(el.color_width ?? 1);
      setFxGradient(el.gradient ?? 1);
      setFxGrayscale(el.grayscale ?? false);
      setFxTransform(el.transform ?? "");
      setFxDirectionDeg(el.direction_deg);
      setFxCenterX(el.center_x);
      setFxCenterY(el.center_y);
      setFxPhaseOffset(el.phase_offset ?? 0);
      if ((el.rate_cycles ?? 1) > 0) {
        lastNonZeroRateRef.current = el.rate_cycles ?? 1;
      }
      if (el.inline_colors && el.inline_colors.length > 0) {
        setFxInlineColors(el.inline_colors);
      }
      if (el.value_stops && el.value_stops.length > 0) {
        setFxValueStops(el.value_stops);
        setSelectedValueStopIdx(0);
      } else {
        setFxValueStops([1, 0]);
        setSelectedValueStopIdx(0);
      }
      if (el.speed_hz && el.speed_hz > 0) {
        setFxTimingMode("hz");
        setFxSpeedHz(el.speed_hz);
        setFxRateCycles(el.rate_cycles ?? 1);
      } else if (el.rate_beats && el.rate_beats > 0) {
        setFxTimingMode("beats");
        setFxRateBeats(el.rate_beats);
        setFxRateCycles(el.rate_cycles ?? 1);
      } else {
        setFxTimingMode("cycles");
        setFxRateCycles(el.rate_cycles ?? 1);
      }
      setActiveShaderGizmoBlockId(blk.id);
    } else if (el.kind === "static_trait") {
      setFxStaticStart(el.value_start ?? 0);
      setFxStaticEnd(el.value_end ?? 1);
      if (el.order) setFxOrder(el.order);
    }
  };

  const selectedPrimaryBlockId = selectedScenePrimaryBlock?.id ?? null;
  const prevSceneIdRef = useRef<string | null>(selectedScene?.id ?? null);
  useEffect(() => {
    const nextSceneId = selectedScene?.id ?? null;
    const sceneChanged = prevSceneIdRef.current !== nextSceneId;
    prevSceneIdRef.current = nextSceneId;
    const procEls = (selectedScenePrimaryBlock?.elements ?? []).filter(
      (el) => !isStaticDockElement(el),
    );
    if (procEls.length === 0) {
      setActiveElementIdx(0);
      setFxPickerMode(true);
    } else if (selectedScenePrimaryBlock) {
      const clamped = sceneChanged
        ? 0
        : Math.min(activeElementIdx, procEls.length - 1);
      setActiveElementIdx(clamped);
      loadElementIntoEditor(selectedScenePrimaryBlock, clamped);
      if (sceneChanged) {
        setFxPickerMode(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedScene?.id, selectedPrimaryBlockId]);

  type FxParamOverrides = Partial<{
    kind: GeneratorKind;
    trait: string;
    op: MergeOp;
    fxKindTag: FxKindTag | null;
    waveform: Waveform1D;
    amplitude: number;
    offset: number;
    timingMode: "cycles" | "beats" | "hz";
    rateCycles: number;
    phaseOffset: number;
    rateBeats: number;
    speedHz: number;
    phaseDeg: number;
    phaseSpreadDeg: number;
    duty: number;
    stepBeats: number;
    oneWay: boolean;
    pixelsOn: number;
    activeRatio: number;
    fade: number;
    shader: Shader2DKind;
    spatialFreq: number;
    directionDeg: number;
    centerX: number;
    centerY: number;
    boxHalfX: number | null;
    boxHalfY: number | null;
    paletteRef: string;
    inlineColors: string[];
    valueStops: number[];
    grayscale: boolean;
    colorWidth: number;
    gradient: number;
    angleDeg: number;
    transform: string;
    staticStart: number;
    staticEnd: number;
    order: OrderRuleStr;
    targetGroup: string;
    durationBeats: number;
    loopBlock: boolean;
    sequencePlaybackMode: SequencePlaybackMode;
    sequenceSteps: SceneSequenceStepDef[];
  }>;

  const getSceneBlockDurationFields = (sc: SceneDef, fallbackBeats: number) => {
    const unit: DurationUnit = sc.duration_unit ?? "beats";
    const val = Math.max(0.05, sc.duration_value ?? fallbackBeats ?? 4);
    return {
      duration_beats: unit === "beats" ? val : Math.max(0.25, fallbackBeats),
      duration_sec: unit === "seconds" ? val : null,
    };
  };

  // Keep local gizmo spatial state synchronized when FixtureGrid2D drags/rotates/scales the gizmo
  const liveShaderEl = selectedScenePrimaryBlock?.elements.find(
    (el): el is Extract<FxElementDef, { kind: "spatial_shader_2d" }> =>
      el.kind === "spatial_shader_2d",
  );
  useEffect(() => {
    if (!liveShaderEl) return;
    setFxCenterX(liveShaderEl.center_x);
    setFxCenterY(liveShaderEl.center_y);
    setFxDirectionDeg(liveShaderEl.direction_deg);
    setFxSpatialFreq(liveShaderEl.spatial_freq);
  }, [
    liveShaderEl?.center_x,
    liveShaderEl?.center_y,
    liveShaderEl?.direction_deg,
    liveShaderEl?.spatial_freq,
  ]);

  const syncSelectedSceneBlock = async (
    overrides: FxParamOverrides,
    targetProcIndex = activeElementIdx,
  ) => {
    if (!selectedScene) return;
    const liveProc = selectedScenePrimaryBlock?.elements.filter(
      (el) => !isStaticDockElement(el),
    );
    const liveEl = liveProc?.[targetProcIndex];
    const liveSpatial =
      liveEl && liveEl.kind === "spatial_shader_2d" ? liveEl : null;
    const snap = {
      kind: overrides.kind ?? fxKind,
      trait: overrides.trait ?? fxTrait,
      op: overrides.op ?? fxOp,
      fxKindTag:
        overrides.fxKindTag !== undefined ? overrides.fxKindTag : fxKindTag,
      waveform: overrides.waveform ?? fxWaveform,
      amplitude: overrides.amplitude ?? fxAmplitude,
      offset: overrides.offset ?? fxOffset,
      timingMode: overrides.timingMode ?? fxTimingMode,
      rateCycles: overrides.rateCycles ?? fxRateCycles,
      phaseOffset: overrides.phaseOffset ?? fxPhaseOffset,
      rateBeats: overrides.rateBeats ?? fxRateBeats,
      speedHz: overrides.speedHz ?? fxSpeedHz,
      phaseDeg: overrides.phaseDeg ?? fxPhaseDeg,
      phaseSpreadDeg: overrides.phaseSpreadDeg ?? fxPhaseSpreadDeg,
      duty: overrides.duty ?? fxDuty,
      stepBeats: overrides.stepBeats ?? fxStepBeats,
      oneWay: overrides.oneWay !== undefined ? overrides.oneWay : fxOneWay,
      pixelsOn: overrides.pixelsOn ?? fxPixelsOn,
      activeRatio: overrides.activeRatio ?? fxActiveRatio,
      fade: overrides.fade ?? fxFade,
      shader: overrides.shader ?? fxShader,
      spatialFreq:
        overrides.spatialFreq ?? liveSpatial?.spatial_freq ?? fxSpatialFreq,
      directionDeg:
        overrides.directionDeg ?? liveSpatial?.direction_deg ?? fxDirectionDeg,
      centerX: overrides.centerX ?? liveSpatial?.center_x ?? fxCenterX,
      centerY: overrides.centerY ?? liveSpatial?.center_y ?? fxCenterY,
      boxHalfX:
        overrides.boxHalfX !== undefined
          ? overrides.boxHalfX
          : (liveSpatial?.box_half_x ?? null),
      boxHalfY:
        overrides.boxHalfY !== undefined
          ? overrides.boxHalfY
          : (liveSpatial?.box_half_y ?? null),
      paletteRef:
        overrides.paletteRef !== undefined
          ? overrides.paletteRef
          : fxPaletteRef,
      inlineColors:
        overrides.inlineColors !== undefined
          ? overrides.inlineColors
          : fxInlineColors,
      valueStops:
        overrides.valueStops !== undefined
          ? overrides.valueStops
          : fxValueStops,
      grayscale:
        overrides.grayscale !== undefined ? overrides.grayscale : fxGrayscale,
      colorWidth: overrides.colorWidth ?? fxColorWidth,
      gradient: overrides.gradient ?? fxGradient,
      angleDeg: overrides.angleDeg ?? fxAngleDeg,
      transform:
        overrides.transform !== undefined ? overrides.transform : fxTransform,
      staticStart: overrides.staticStart ?? fxStaticStart,
      staticEnd: overrides.staticEnd ?? fxStaticEnd,
      order: overrides.order ?? fxOrder,
      targetGroup: overrides.targetGroup ?? fxTargetGroup,
      durationBeats: overrides.durationBeats ?? fxDurationBeats,
      loopBlock:
        overrides.loopBlock !== undefined ? overrides.loopBlock : fxLoop,
      sequencePlaybackMode:
        overrides.sequencePlaybackMode ?? fxSeqPlaybackMode,
      sequenceSteps: overrides.sequenceSteps ?? fxSeqSteps,
    };

    const isColorTarget = snap.trait === "color";
    const element = buildElementFromForm({
      ...snap,
      paletteRef:
        isColorTarget || snap.kind === "static_trait" ? snap.paletteRef : "",
      inlineColors: isColorTarget ? snap.inlineColors : [],
      valueStops: !isColorTarget ? snap.valueStops : [],
    });

    const targetBlockId =
      selectedScenePrimaryBlock?.id ?? `blk_scene_${selectedScene.id}`;
    const blockName =
      selectedScenePrimaryBlock?.name ?? `${selectedScene.name} Look`;

    const existingStatic = (selectedScenePrimaryBlock?.elements ?? []).filter(
      isStaticDockElement,
    );
    const existingProc = (selectedScenePrimaryBlock?.elements ?? []).filter(
      (el) => !isStaticDockElement(el),
    );
    const nextProc =
      existingProc.length === 0
        ? [element]
        : existingProc.map((el, i) => (i === targetProcIndex ? element : el));
    const nextElements = [...existingStatic, ...nextProc];

    const durFields = getSceneBlockDurationFields(
      selectedScene,
      snap.durationBeats,
    );

    await upsertFxBlock({
      id: targetBlockId,
      name: blockName,
      target_group: snap.targetGroup,
      duration_beats: durFields.duration_beats,
      duration_sec: durFields.duration_sec,
      loop_block: snap.loopBlock,
      elements: nextElements,
    });

    if (!selectedScene.block_refs.includes(targetBlockId)) {
      await upsertScene({
        ...selectedScene,
        block_refs: [targetBlockId],
      });
    }
  };

  const addFxElementToScene = async (element: FxElementDef) => {
    if (!selectedScene) return;
    const targetBlockId =
      selectedScenePrimaryBlock?.id ?? `blk_scene_${selectedScene.id}`;
    const blockName =
      selectedScenePrimaryBlock?.name ?? `${selectedScene.name} Look`;
    const prevStatic = (selectedScenePrimaryBlock?.elements ?? []).filter(
      isStaticDockElement,
    );
    const prevProc = (selectedScenePrimaryBlock?.elements ?? []).filter(
      (el) => !isStaticDockElement(el),
    );
    const nextProc = [...prevProc, element];
    const nextProcIdx = nextProc.length - 1;
    const durFields = getSceneBlockDurationFields(selectedScene, fxDurationBeats);
    const updatedBlk: FxBlockDef = {
      id: targetBlockId,
      name: blockName,
      target_group: fxTargetGroup,
      duration_beats: durFields.duration_beats,
      duration_sec: durFields.duration_sec,
      loop_block: fxLoop,
      elements: [...prevStatic, ...nextProc],
    };
    await upsertFxBlock(updatedBlk);
    if (!selectedScene.block_refs.includes(targetBlockId)) {
      await upsertScene({
        ...selectedScene,
        block_refs: [targetBlockId],
      });
    }
    setActiveElementIdx(nextProcIdx);
    loadElementIntoEditor(updatedBlk, nextProcIdx);
    setFxPickerMode(false);
    setFxAppendMode(false);
  };

  const removeActiveFxElement = async () => {
    if (!selectedScene || !selectedScenePrimaryBlock) return;
    const prevStatic = selectedScenePrimaryBlock.elements.filter(
      isStaticDockElement,
    );
    const prevProc = selectedScenePrimaryBlock.elements.filter(
      (el) => !isStaticDockElement(el),
    );
    if (prevProc.length === 0) return;
    const nextProc = prevProc.filter((_, i) => i !== activeElementIdx);
    const updatedBlk: FxBlockDef = {
      ...selectedScenePrimaryBlock,
      elements: [...prevStatic, ...nextProc],
    };
    await upsertFxBlock(updatedBlk);
    if (nextProc.length === 0) {
      setFxPickerMode(true);
      setActiveElementIdx(0);
    } else {
      const nextIdx = Math.min(activeElementIdx, nextProc.length - 1);
      setActiveElementIdx(nextIdx);
      loadElementIntoEditor(updatedBlk, nextIdx);
    }
  };

  const moveActiveFxElement = async (delta: -1 | 1) => {
    if (!selectedScenePrimaryBlock) return;
    const prevStatic = selectedScenePrimaryBlock.elements.filter(
      isStaticDockElement,
    );
    const prevProc = selectedScenePrimaryBlock.elements.filter(
      (el) => !isStaticDockElement(el),
    );
    const target = activeElementIdx + delta;
    if (target < 0 || target >= prevProc.length) return;
    const [item] = prevProc.splice(activeElementIdx, 1);
    prevProc.splice(target, 0, item);
    const updatedBlk: FxBlockDef = {
      ...selectedScenePrimaryBlock,
      elements: [...prevStatic, ...prevProc],
    };
    await upsertFxBlock(updatedBlk);
    setActiveElementIdx(target);
  };

  const pickDaslightFxTile = async (
    tile: DaslightFxSubmenu,
    appendMode: boolean,
  ) => {
    const firstPal =
      showState.color_palettes.find((p) => p.id === fxPaletteRef) ??
      showState.color_palettes[0] ??
      DEFAULT_COLOR_PALETTES[0];
    const palId = firstPal.id;
    const palStops = [
      ...(firstPal.colors ?? [firstPal.hex_start, firstPal.hex_end]),
    ];

    const computeInitialGizmoBounds = (targetOverride?: string) => {
      const st = useTaktStore.getState();
      return computeTargetGizmoBounds({
        compiledCells: st.compiledCells,
        patch: st.showState.patch,
        groups: st.showState.groups,
        targetGroup:
          targetOverride ?? selectedScene?.target_group ?? fxTargetGroup,
        fallbackFixtureIds: st.selectedFixtureIds,
      });
    };

    let elem: FxElementDef;
    switch (tile) {
      case "color_fx":
        elem = {
          kind: "curve_1d",
          trait: "color",
          op: "ltp",
          fx_kind_tag: "color_fx",
          waveform: "saw",
          amplitude: 1,
          offset: 0,
          rate_beats: null,
          speed_hz: null,
          rate_cycles: 1,
          phase_deg: 0,
          phase_spread_deg: 360,
          duty: null,
          grayscale: false,
          color_width: 1,
          gradient: 1,
          angle_deg: 0,
          palette_ref: palId,
          inline_colors: palStops,
          order: "linear",
        };
        break;
      case "chaser_fx":
        elem = {
          kind: "step_chase",
          trait: "dimmer",
          op: "ltp",
          step_beats: null,
          speed_hz: null,
          rate_cycles: 1,
          one_way: true,
          pixels_on: 1,
          active_ratio: null,
          fade: 0,
          amplitude: 1,
          palette_ref: null,
          order: "linear",
        };
        break;
      case "value_fx":
        elem = {
          kind: "curve_1d",
          trait: "dimmer",
          op: "ltp",
          fx_kind_tag: "value_fx",
          waveform: "saw",
          amplitude: 1,
          offset: 0,
          rate_beats: null,
          speed_hz: null,
          rate_cycles: 1,
          phase_deg: 0,
          phase_spread_deg: 360,
          duty: null,
          gradient: 1,
          value_stops: [1, 0.5, 0],
          palette_ref: null,
          order: "linear",
        };
        break;
      case "curve_fx":
        elem = {
          kind: "curve_1d",
          trait: "dimmer",
          op: "ltp",
          fx_kind_tag: "curve_fx",
          waveform: "sine",
          amplitude: 1,
          offset: 0,
          rate_beats: null,
          speed_hz: null,
          rate_cycles: 1,
          phase_deg: 0,
          phase_spread_deg: 360,
          duty: null,
          palette_ref: null,
          order: "linear",
        };
        break;
      case "mappings": {
        const bounds = computeInitialGizmoBounds();
        elem = {
          kind: "spatial_shader_2d",
          trait: "dimmer",
          op: "ltp",
          shader: "linear_sweep",
          palette_ref: null,
          rate_beats: null,
          speed_hz: null,
          rate_cycles: 1,
          spatial_freq: bounds.spatialFreq,
          color_width: 1,
          gradient: 1,
          transform: null,
          value_stops: [1, 0],
          direction_deg: 0,
          center_x: bounds.centerX,
          center_y: bounds.centerY,
          box_half_x: bounds.boxHalfX,
          box_half_y: bounds.boxHalfY,
        };
        break;
      }
      case "color_mappings": {
        const bounds = computeInitialGizmoBounds();
        elem = {
          kind: "spatial_shader_2d",
          trait: "color",
          op: "ltp",
          shader: "linear_sweep",
          palette_ref: palId,
          inline_colors: palStops,
          rate_beats: null,
          speed_hz: null,
          rate_cycles: 1,
          spatial_freq: bounds.spatialFreq,
          color_width: 1,
          gradient: 1,
          grayscale: false,
          transform: null,
          direction_deg: 0,
          center_x: bounds.centerX,
          center_y: bounds.centerY,
          box_half_x: bounds.boxHalfX,
          box_half_y: bounds.boxHalfY,
        };
        break;
      }
      case "scene_sequence": {
        elem = {
          kind: "scene_sequence",
          playback_mode: "loop",
          steps: [],
        };
        break;
      }
    }

    if (
      appendMode &&
      selectedScenePrimaryBlock &&
      proceduralElements.length > 0
    ) {
      await addFxElementToScene(elem);
    } else if (selectedScene) {
      const targetBlockId =
        selectedScenePrimaryBlock?.id ?? `blk_scene_${selectedScene.id}`;
      const blockName =
        selectedScenePrimaryBlock?.name ?? `${selectedScene.name} Look`;
      const preservedStatic = (
        selectedScenePrimaryBlock?.elements ?? []
      ).filter(isStaticDockElement);
      const durFields = getSceneBlockDurationFields(
        selectedScene,
        fxDurationBeats,
      );
      const updatedBlk: FxBlockDef = {
        id: targetBlockId,
        name: blockName,
        target_group: fxTargetGroup,
        duration_beats: durFields.duration_beats,
        duration_sec: durFields.duration_sec,
        loop_block: fxLoop,
        elements: [...preservedStatic, elem],
      };
      await upsertFxBlock(updatedBlk);
      if (!selectedScene.block_refs.includes(targetBlockId)) {
        await upsertScene({
          ...selectedScene,
          block_refs: [targetBlockId],
        });
      }
      if (elem.kind === "spatial_shader_2d") {
        setActiveShaderGizmoBlockId(targetBlockId);
      }
      setActiveElementIdx(0);
      loadElementIntoEditor(updatedBlk, 0);
      setFxPickerMode(false);
      setFxAppendMode(false);
    } else {
      const created = await createQuickSceneInBank(allBanks[0] ?? "Bank 1");
      const targetBlockId = created.block_refs[0] ?? `blk_scene_${created.id}`;
      const durFields = getSceneBlockDurationFields(created, fxDurationBeats);
      const updatedBlk: FxBlockDef = {
        id: targetBlockId,
        name: `${created.name} Look`,
        target_group: fxTargetGroup,
        duration_beats: durFields.duration_beats,
        duration_sec: durFields.duration_sec,
        loop_block: fxLoop,
        elements: [elem],
      };
      await upsertFxBlock(updatedBlk);
      if (!created.block_refs.includes(targetBlockId)) {
        await upsertScene({
          ...created,
          block_refs: [targetBlockId],
        });
      }
      setActiveElementIdx(0);
      loadElementIntoEditor(updatedBlk, 0);
      setFxPickerMode(false);
      setFxAppendMode(false);
    }
  };

  const commitSequenceSteps = async (
    nextSteps: SceneSequenceStepDef[],
    nextMode: SequencePlaybackMode = fxSeqPlaybackMode,
    explicitBlockId?: string,
  ) => {
    const targetBlock = explicitBlockId
      ? showState.fx_library.find((b) => b.id === explicitBlockId) ??
        selectedScenePrimaryBlock
      : selectedScenePrimaryBlock;
    setFxSeqSteps(nextSteps);
    setFxSeqPlaybackMode(nextMode);
    if (!targetBlock) {
      await syncSelectedSceneBlock({
        kind: "scene_sequence",
        sequencePlaybackMode: nextMode,
        sequenceSteps: nextSteps,
      });
      return;
    }
    const existingStatic = targetBlock.elements.filter(isStaticDockElement);
    const existingProc = targetBlock.elements.filter(
      (el) => !isStaticDockElement(el),
    );
    const seqElem: FxElementDef = {
      kind: "scene_sequence",
      playback_mode: nextMode,
      steps: nextSteps,
    };
    const seqIdx = existingProc.findIndex((el) => el.kind === "scene_sequence");
    const nextProc =
      seqIdx >= 0
        ? existingProc.map((el, i) => (i === seqIdx ? seqElem : el))
        : [...existingProc, seqElem];
    await upsertFxBlock({
      ...targetBlock,
      elements: [...existingStatic, ...nextProc],
    });
  };

  const addSceneStepToSequence = async (
    sceneId: string,
    targetBlockId?: string,
    insertIndex?: number,
  ) => {
    const droppedScene = showState.scenes.find((s) => s.id === sceneId);
    if (!droppedScene) return;
    if (droppedScene.timeline_ref) {
      setSeqDropNotice(
        "Cannot add a Timeline Super-Scene into a Scene Sequence.",
      );
      return;
    }
    const effectiveBlockId =
      targetBlockId || selectedScenePrimaryBlock?.id || "";
    if (
      (selectedScene && droppedScene.id === selectedScene.id) ||
      (effectiveBlockId && droppedScene.block_refs.includes(effectiveBlockId))
    ) {
      setSeqDropNotice("Cannot drop a Scene Sequence onto itself.");
      return;
    }
    setSeqDropNotice(null);
    const blk = effectiveBlockId
      ? showState.fx_library.find((b) => b.id === effectiveBlockId) ??
        selectedScenePrimaryBlock
      : selectedScenePrimaryBlock;
    const seqEl = blk?.elements.find(
      (el): el is Extract<FxElementDef, { kind: "scene_sequence" }> =>
        el.kind === "scene_sequence",
    );
    const baseSteps = seqEl ? [...seqEl.steps] : [...fxSeqSteps];
    const baseMode = seqEl?.playback_mode ?? fxSeqPlaybackMode;
    const newStep: SceneSequenceStepDef = {
      scene_id: droppedScene.id,
      duration_value: Math.max(0.05, droppedScene.duration_value ?? 4),
      duration_unit: droppedScene.duration_unit ?? "beats",
      fade_sec: 0,
    };
    if (
      insertIndex !== undefined &&
      insertIndex >= 0 &&
      insertIndex <= baseSteps.length
    ) {
      baseSteps.splice(insertIndex, 0, newStep);
    } else {
      baseSteps.push(newStep);
    }
    await commitSequenceSteps(baseSteps, baseMode, effectiveBlockId || undefined);
  };

  useEffect(() => {
    const onSequenceDrop = (ev: Event) => {
      const ce = ev as CustomEvent<{
        sceneId: string;
        targetBlockId?: string;
        insertIndex?: number;
      }>;
      if (!ce.detail?.sceneId) return;
      void addSceneStepToSequence(
        ce.detail.sceneId,
        ce.detail.targetBlockId,
        ce.detail.insertIndex,
      );
    };
    window.addEventListener("takt:scene-sequence-drop", onSequenceDrop);
    return () =>
      window.removeEventListener("takt:scene-sequence-drop", onSequenceDrop);
  });

  // Legacy Slice 5 programmatic save handlers
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
      fxKindTag,
      waveform: fxWaveform,
      amplitude: fxAmplitude,
      offset: fxOffset,
      timingMode: fxTimingMode,
      rateCycles: fxRateCycles,
      phaseOffset: fxPhaseOffset,
      rateBeats: fxRateBeats,
      speedHz: fxSpeedHz,
      phaseDeg: fxPhaseDeg,
      phaseSpreadDeg: fxPhaseSpreadDeg,
      duty: fxDuty,
      stepBeats: fxStepBeats,
      oneWay: fxOneWay,
      pixelsOn: fxPixelsOn,
      activeRatio: fxActiveRatio,
      fade: fxFade,
      shader: fxShader,
      spatialFreq: fxSpatialFreq,
      directionDeg: fxDirectionDeg,
      centerX: fxCenterX,
      centerY: fxCenterY,
      paletteRef:
        fxKind === "curve_1d" || fxKind === "step_chase"
          ? fxTrait === "color"
            ? fxPaletteRef
            : ""
          : fxPaletteRef,
      inlineColors: fxTrait === "color" ? fxInlineColors : [],
      valueStops: fxTrait !== "color" ? fxValueStops : [],
      grayscale: fxGrayscale,
      colorWidth: fxColorWidth,
      gradient: fxGradient,
      angleDeg: fxAngleDeg,
      transform: fxTransform,
      staticStart: fxStaticStart,
      staticEnd: fxStaticEnd,
      order: fxOrder,
    });

    const block: FxBlockDef = {
      id,
      name: fxName.trim() || "FX Block",
      target_group: fxTargetGroup,
      duration_beats: Math.max(0.25, fxDurationBeats),
      duration_sec: null,
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
    if (trimmedBank) createSceneBank(trimmedBank);
    const blockRefs = effectiveBlockRef ? [effectiveBlockRef] : [];

    const scene: SceneDef = {
      id,
      name: sceneName.trim() || "Scene",
      bank: trimmedBank ? trimmedBank : null,
      target_group: null,
      priority: Math.max(0, Math.round(scenePriority)),
      fade_in_sec: Math.max(0, sceneFadeIn),
      fade_out_sec: Math.max(0, sceneFadeOut),
      duration_value: 4,
      duration_unit: "beats",
      block_refs: blockRefs,
    };

    await upsertScene(scene);
  };

  const getScenePaletteColors = (sc: SceneDef): [string, string] | null => {
    for (const bid of sc.block_refs) {
      const blk = showState.fx_library.find((b) => b.id === bid);
      if (!blk) continue;
      for (const el of blk.elements) {
        if (
          "inline_colors" in el &&
          el.inline_colors &&
          el.inline_colors.length > 0
        ) {
          return [
            el.inline_colors[0],
            el.inline_colors[el.inline_colors.length - 1],
          ];
        }
        if (el.kind === "scene_sequence") {
          for (const st of el.steps) {
            const stScene = showState.scenes.find((s) => s.id === st.scene_id);
            if (!stScene || stScene.id === sc.id) continue;
            const stBlk = stScene.block_refs[0]
              ? showState.fx_library.find((b) => b.id === stScene.block_refs[0])
              : null;
            if (!stBlk) continue;
            for (const subEl of stBlk.elements) {
              if (subEl.kind === "scene_sequence") continue;
              if (
                "inline_colors" in subEl &&
                subEl.inline_colors &&
                subEl.inline_colors.length >= 2
              ) {
                return [
                  subEl.inline_colors[0],
                  subEl.inline_colors[subEl.inline_colors.length - 1],
                ];
              }
              if (subEl.palette_ref) {
                const cp = showState.color_palettes.find(
                  (p) => p.id === subEl.palette_ref,
                );
                if (cp) return [cp.hex_start, cp.hex_end];
              }
              if (
                subEl.kind === "static_trait" &&
                subEl.trait === "color" &&
                subEl.hex_start
              ) {
                return [subEl.hex_start, subEl.hex_end ?? subEl.hex_start];
              }
            }
          }
          continue;
        }
        if (el.palette_ref) {
          const cp = showState.color_palettes.find(
            (p) => p.id === el.palette_ref,
          );
          if (cp) return [cp.hex_start, cp.hex_end];
        }
        if (el.kind === "static_trait" && el.trait === "color" && el.hex_start) {
          return [el.hex_start, el.hex_end ?? el.hex_start];
        }
      }
    }
    return null;
  };

  const isBipolarAdd = fxTrait !== "color" && fxOp === "add";
  const curveRange = amplitudeOffsetToRangePct(
    fxAmplitude,
    fxOffset,
    isBipolarAdd,
  );
  const curveSvg = buildCurve1DSvgPreview({
    waveform: fxWaveform,
    amplitude: fxAmplitude,
    offset: fxOffset,
    phaseSpreadDeg: fxPhaseSpreadDeg,
    duty: fxDuty,
    fixtureCount: Math.max(4, Math.min(12, compiledCells.length || 8)),
    isBipolarAdd,
  });

  const stepCellCount = Math.max(4, Math.min(16, compiledCells.length || 8));
  const stepPreview = buildStepChasePreviewBlocks({
    cellCount: stepCellCount,
    activeRatio: Math.max(
      1e-4,
      Math.min(1, (fxPixelsOn || 1) / stepCellCount),
    ),
    fade: fxFade,
    order: fxOrder,
  });

  const patternScaleValue = spatialFreqToPatternScale(fxSpatialFreq);

  const renderSceneTile = (scene: SceneDef, bankColor?: string) => {
    const inst = activeById.get(scene.id);
    const isActive = Boolean(inst && inst.release_t_sec === null);
    const isSelected = selectedScene?.id === scene.id;
    const isMultiSelected = multiSelectedSceneIds.includes(scene.id);
    const isFlash = Boolean(flashSceneIds[scene.id]);
    const colors = getScenePaletteColors(scene);
    const blk = scene.block_refs[0]
      ? showState.fx_library.find((b) => b.id === scene.block_refs[0])
      : null;
    const procInBlk = blk
      ? blk.elements.filter((e) => !isStaticDockElement(e))
      : [];
    const primaryEl =
      procInBlk[0] ??
      (blk && blk.elements.length > 0
        ? (blk.elements.find(
            (e) => e.kind !== "scene_sequence" && e.trait === "color",
          ) ?? blk.elements[0])
        : undefined);
    const typeLabel = describeElementShort(primaryEl);
    const keyBind = keyBindings[scene.id];
    const midiBind = midiBindings[scene.id];

    const borderClass = isSelected
      ? "border-ember/90 bg-slate"
      : isActive
        ? "border-pine bg-pine/15"
        : "border-steel bg-ink hover:border-fog";

    const tileThemeStyle = bankColor
      ? {
          borderColor: isSelected || isActive ? bankColor : `${bankColor}66`,
          backgroundColor: isActive
            ? `${bankColor}30`
            : isSelected
              ? `${bankColor}24`
              : `${bankColor}12`,
        }
      : undefined;

    const mappingActiveRing =
      mappingOverlayMode === "key"
        ? "ring-2 ring-signal/80"
        : mappingOverlayMode === "midi"
          ? "ring-2 ring-plum/80"
          : "";

    const accentColor = colors
      ? colors[0]
      : bankColor
        ? bankColor
        : isActive
          ? "#FF5500"
          : isSelected
            ? "#EAB308"
            : "#4A5A6A";

    return (
      <div
        key={scene.id}
        data-testid={`scene-tile-${scene.id}`}
        style={tileThemeStyle}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const target = e.target as HTMLElement | null;
          if (target?.closest("button, input")) return;
          e.preventDefault();
          startScenePointerDrag(scene.id, scene.name, e.clientX, e.clientY);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setSceneContextMenu({
            sceneId: scene.id,
            x: e.clientX,
            y: e.clientY,
          });
        }}
        className={`relative flex items-stretch rounded border transition-colors overflow-hidden min-h-[44px] select-none ${borderClass} ${mappingActiveRing} ${
          isMultiSelected && multiSelectedSceneIds.length > 1
            ? "ring-2 ring-frost"
            : ""
        } ${draggingSceneId === scene.id ? "opacity-50" : ""}`}
      >
        {/* Minimalist Play / Stop / Flash Trigger Pill */}
        <div className="flex items-center pl-1.5 shrink-0">
          {isFlash ? (
            <button
              type="button"
              data-testid={`trigger-scene-${scene.id}`}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => {
                e.stopPropagation();
                void triggerScene(scene.id);
              }}
              onPointerUp={(e) => {
                e.stopPropagation();
                void releaseScene(scene.id);
              }}
              onPointerLeave={() => {
                if (isActive) void releaseScene(scene.id);
              }}
              title="Momentary Flash"
              className="w-6 h-6 rounded flex items-center justify-center bg-amber-500 hover:bg-amber-400 text-void"
            >
              <Zap className="w-3 h-3" />
            </button>
          ) : (
            <button
              type="button"
              data-testid={`trigger-scene-${scene.id}`}
              onClick={(e) => {
                e.stopPropagation();
                if (isActive) {
                  void releaseScene(scene.id);
                } else {
                  void triggerScene(scene.id);
                }
              }}
              title={isActive ? "Stop Scene" : "Play Scene"}
              style={
                !isActive && bankColor
                  ? { borderColor: `${bankColor}77` }
                  : undefined
              }
              className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
                isActive
                  ? "bg-signal hover:bg-signal/85 text-frost"
                  : "bg-pitch border border-steel text-fog hover:text-frost hover:border-ember"
              }`}
            >
              {isActive ? (
                <Square className="w-2.5 h-2.5" />
              ) : (
                <Play className="w-2.5 h-2.5" />
              )}
            </button>
          )}
        </div>

        {/* Main Clickable Area -> Select Scene for Editing */}
        <div
          data-testid={`scene-play-zone-${scene.id}`}
          onClick={(e) => {
            if (mappingOverlayMode !== "off") {
              setSelectedMappingTarget(scene.id);
            }
            selectSceneForEdit(scene.id, e.shiftKey || e.ctrlKey || e.metaKey);
            if (blk) {
              const procEls = blk.elements.filter(
                (el) => !isStaticDockElement(el),
              );
              if (procEls.length === 0) {
                setActiveElementIdx(0);
                setFxPickerMode(true);
              } else {
                setActiveElementIdx(0);
                loadElementIntoEditor(blk, 0);
                setFxPickerMode(false);
              }
            } else {
              setActiveElementIdx(0);
              setFxPickerMode(true);
            }
          }}
          title="Click to edit · Right-click for Flash / Duplicate / Delete"
          className="flex-1 px-2 py-1.5 flex flex-col justify-center min-w-0 cursor-pointer"
        >
          <div className="flex items-center justify-between gap-1">
            {renamingSceneId === scene.id ? (
              <input
                type="text"
                autoFocus
                data-testid={`rename-scene-input-${scene.id}`}
                value={renameSceneValue}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenameSceneValue(e.target.value)}
                onBlur={() => {
                  const trimmed = renameSceneValue.trim();
                  if (trimmed && trimmed !== scene.name) {
                    void upsertScene({ ...scene, name: trimmed });
                  }
                  setRenamingSceneId(null);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    const trimmed = renameSceneValue.trim();
                    if (trimmed && trimmed !== scene.name) {
                      void upsertScene({ ...scene, name: trimmed });
                    }
                    setRenamingSceneId(null);
                  } else if (e.key === "Escape") {
                    setRenamingSceneId(null);
                  }
                }}
                className="w-full px-1 py-0.5 rounded bg-pitch border border-ember font-sans text-xs font-semibold text-frost outline-none"
              />
            ) : (
              <span
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setRenamingSceneId(scene.id);
                  setRenameSceneValue(scene.name);
                }}
                title="Double-click to rename scene"
                className="font-sans text-xs font-semibold text-frost truncate"
              >
                {scene.name}
              </span>
            )}
            {((mappingOverlayMode !== "off" && (keyBind || midiBind)) ||
              keyBind) && (
              <span className="px-1 py-0.2 rounded bg-pitch border border-steel font-mono text-[9px] text-frost shrink-0">
                {mappingOverlayMode === "midi"
                  ? (midiBind ?? "MIDI")
                  : (keyBind ?? midiBind)}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between gap-1 font-mono text-[9px] text-fog">
            {scene.timeline_ref ? (
              <span className="inline-flex items-center gap-1 text-cobalt font-semibold">
                <AudioWaveform className="w-2.5 h-2.5" />
                <span>TIMELINE</span>
              </span>
            ) : (
              <span>{typeLabel}</span>
            )}
          </div>
        </div>

        {/* Daslight Right-Edge Vertical Color / Live Accent Bar */}
        <div
          className="w-2 shrink-0 relative bg-pitch border-l border-steel/40"
          data-testid={`scene-color-bar-${scene.id}`}
        >
          <div
            className="absolute inset-0 transition-opacity"
            style={{
              background: colors
                ? `linear-gradient(180deg, ${colors[0]}, ${colors[1]})`
                : accentColor,
              opacity: isActive || isSelected ? 1 : 0.45,
            }}
          />
        </div>
      </div>
    );
  };

  const bankedColumns = useMemo(() => {
    const visibleBanks =
      selectedBankFilter === "all"
        ? allBanks
        : allBanks.filter((b) => b === selectedBankFilter);
    const groups = new Map<string, SceneDef[]>();
    for (const b of visibleBanks) {
      groups.set(b, []);
    }
    const unassigned: SceneDef[] = [];
    for (const sc of showState.scenes) {
      const b = sc.bank?.trim();
      if (b && groups.has(b)) {
        groups.get(b)!.push(sc);
      } else if (!b && visibleBanks.length > 0) {
        unassigned.push(sc);
      }
    }
    if (unassigned.length > 0 && visibleBanks.length > 0) {
      const firstKey = visibleBanks[0];
      groups.get(firstKey)?.push(...unassigned);
    }
    return Array.from(groups.entries());
  }, [allBanks, selectedBankFilter, showState.scenes]);

  const showRightInspector = showInspector && !liveBuskingMode;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      {/* Standalone Header Tempo & Transport Controls (when used outside StudioWorkspace) */}
      {!daslightUpper && (
        <div className="flex flex-wrap items-center justify-between gap-3 bg-slate border border-steel rounded-panel px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-4 h-4 text-ember" />
            <h2 className="font-sans text-sm font-semibold text-frost">
              Scenes &amp; Banks
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
                  if (!Number.isNaN(parsed)) void setLiveBpm(parsed);
                }}
                className="w-16 bg-ink border border-steel rounded px-1.5 py-0.5 font-mono text-xs text-frost"
              />
            </label>

            <button
              type="button"
              onClick={() => void tapTempo()}
              className="px-3 py-1.5 rounded border border-cobalt bg-cobalt/20 hover:bg-cobalt/30 font-mono text-xs font-medium text-frost"
            >
              Tap Tempo
            </button>

            <button
              type="button"
              onClick={() => void releaseAllScenes()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-signal/70 bg-signal/15 hover:bg-signal/25 font-mono text-xs font-medium text-frost"
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
      )}

      {/* Daslight 5 Upper Split: Left = Bank Tabs + Columns (~80%), Right = FX Inspector + Tool Rail (~20%) */}
      <div className="flex-1 min-h-0 flex flex-col xl:flex-row gap-1.5 xl:gap-0 items-stretch">
        {/* LEFT: BANK TABS & BANK COLUMNS */}
        <section
          data-testid="daslight-scene-banks"
          className="flex-1 min-w-0 bg-slate-dark border border-steel rounded flex flex-col min-h-0 overflow-hidden"
        >
          {/* Daslight Bank Tabs Strip */}
          <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 bg-pitch border-b border-steel px-2 py-1">
            <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
              <button
                type="button"
                aria-pressed={selectedBankFilter === "all"}
                onClick={() => setSelectedBankFilter("all")}
                className={`px-2 py-0.5 rounded border transition-colors ${
                  selectedBankFilter === "all"
                    ? "bg-ink text-frost border-amber-400/80 font-semibold"
                    : "bg-slate-dark text-fog border-steel hover:text-mist"
                }`}
              >
                All ({allBanks.length})
              </button>
              {allBanks.map((b) => {
                const tabColor = bankColors[b];
                return (
                <button
                  key={b}
                  type="button"
                  data-testid={`bank-tab-${b}`}
                  data-bank-drop-target={b}
                  draggable
                  onPointerEnter={() => {
                    if (draggingSceneId) setDragOverSceneBank(b);
                  }}
                  onPointerLeave={(e) => {
                    if (
                      dragOverSceneBank === b &&
                      !e.currentTarget.contains(e.relatedTarget as Node | null)
                    ) {
                      setDragOverSceneBank(null);
                    }
                  }}
                  onDragStart={(e) => {
                    setDraggingBank(b);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("application/x-taktlight-bank", b);
                  }}
                  onDragOver={(e) => {
                    if (
                      draggingBank ||
                      e.dataTransfer.types.includes(
                        "application/x-taktlight-bank",
                      )
                    ) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dragOverBank !== b) setDragOverBank(b);
                    }
                  }}
                  onDragLeave={() => {
                    if (dragOverBank === b) setDragOverBank(null);
                  }}
                  onDrop={(e) => {
                    const srcBank =
                      draggingBank ||
                      e.dataTransfer.getData("application/x-taktlight-bank");
                    if (srcBank) {
                      e.preventDefault();
                      e.stopPropagation();
                      reorderSceneBanks(srcBank, b);
                    }
                    setDraggingBank(null);
                    setDragOverBank(null);
                  }}
                  onDragEnd={() => {
                    setDraggingBank(null);
                    setDragOverBank(null);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setBankContextMenu({
                      bank: b,
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }}
                  aria-pressed={selectedBankFilter === b}
                  onClick={() => setSelectedBankFilter(b)}
                  title={`Filter by ${b} (drag to reorder · right-click for options)`}
                  style={
                    tabColor
                      ? {
                          borderColor:
                            selectedBankFilter === b ? tabColor : `${tabColor}77`,
                          backgroundColor:
                            selectedBankFilter === b ? `${tabColor}24` : undefined,
                        }
                      : undefined
                  }
                  className={`px-2.5 py-0.5 rounded border transition-colors flex items-center gap-1.5 cursor-grab active:cursor-grabbing ${
                    selectedBankFilter === b
                      ? "bg-ink text-frost border-amber-400 font-semibold"
                      : "bg-slate-dark text-mist border-steel hover:border-fog"
                  } ${
                    (dragOverBank === b && draggingBank !== b) ||
                    (draggingSceneId && dragOverSceneBank === b)
                      ? "ring-2 ring-ember border-ember"
                      : ""
                  } ${draggingBank === b ? "opacity-50" : ""}`}
                >
                  {tabColor && (
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: tabColor }}
                    />
                  )}
                  <span>{b}</span>
                  {stackableBanks[b] && (
                    <Layers className="w-2.5 h-2.5 text-plum" />
                  )}
                </button>
                );
              })}

              {/* Compact + Button to Instantly Create New Bank */}
              <button
                type="button"
                data-testid="open-add-bank-btn"
                onClick={() => {
                  let n = allBanks.length + 1;
                  while (allBanks.includes(`Bank ${n}`)) n += 1;
                  createSceneBank(`Bank ${n}`);
                }}
                title="Add Bank (double-click bank name to rename)"
                className="px-1.5 py-0.5 rounded border border-steel bg-ink text-mist hover:border-ember"
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Multi-Select Batch Edit Toolbar */}
          {multiSelectedSceneIds.length > 1 && (
            <div
              data-testid="batch-scene-toolbar"
              className="shrink-0 bg-cobalt/15 border-b border-cobalt px-2.5 py-1.5 flex flex-wrap items-center gap-2 text-xs font-mono"
            >
              <span className="text-frost font-semibold">
                {multiSelectedSceneIds.length} Selected:
              </span>
              <label className="flex items-center gap-1 text-fog">
                <span>In</span>
                <input
                  aria-label="Batch Fade In"
                  type="number"
                  min={0}
                  step={0.1}
                  value={batchFadeIn}
                  onChange={(e) => setBatchFadeIn(Number(e.target.value) || 0)}
                  className="w-14 bg-ink border border-steel rounded px-1.5 py-0.5 text-frost"
                />
              </label>
              <label className="flex items-center gap-1 text-fog">
                <span>Out</span>
                <input
                  aria-label="Batch Fade Out"
                  type="number"
                  min={0}
                  step={0.1}
                  value={batchFadeOut}
                  onChange={(e) => setBatchFadeOut(Number(e.target.value) || 0)}
                  className="w-14 bg-ink border border-steel rounded px-1.5 py-0.5 text-frost"
                />
              </label>
              <label className="flex items-center gap-1 text-fog">
                <span>Priority</span>
                <input
                  aria-label="Batch Priority"
                  type="number"
                  min={0}
                  max={255}
                  value={batchPriority}
                  onChange={(e) =>
                    setBatchPriority(Number(e.target.value) || 0)
                  }
                  className="w-14 bg-ink border border-steel rounded px-1.5 py-0.5 text-frost"
                />
              </label>
              <button
                type="button"
                data-testid="apply-batch-scene-btn"
                onClick={() =>
                  void batchUpdateSelectedScenes({
                    fade_in_sec: batchFadeIn,
                    fade_out_sec: batchFadeOut,
                    priority: batchPriority,
                  })
                }
                className="px-2.5 py-0.5 rounded bg-cobalt text-frost font-semibold"
              >
                Apply
              </button>
            </div>
          )}

          {/* Horizontal Bank Columns Canvas (No Separate Overlays Column) */}
          <div className="flex-1 min-h-0 overflow-auto p-2 flex flex-wrap items-start gap-2 bg-pitch">
            {bankedColumns.map(([bName, scenesInBank]) => {
              const isStackable = Boolean(stackableBanks[bName]);
              const bankColor = bankColors[bName];
              return (
                <div
                  key={bName}
                  data-testid={`bank-column-${bName}`}
                  data-bank-drop-target={bName}
                  onPointerEnter={() => {
                    if (draggingSceneId) setDragOverSceneBank(bName);
                  }}
                  style={
                    bankColor
                      ? {
                          borderColor: `${bankColor}55`,
                          borderTopColor: bankColor,
                        }
                      : undefined
                  }
                  onDragOver={(e) => {
                    if (
                      draggingBank ||
                      e.dataTransfer.types.includes(
                        "application/x-taktlight-bank",
                      )
                    ) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dragOverBank !== bName) setDragOverBank(bName);
                    }
                  }}
                  onDragLeave={(e) => {
                    if (
                      !e.currentTarget.contains(e.relatedTarget as Node | null) &&
                      dragOverBank === bName
                    ) {
                      setDragOverBank(null);
                    }
                  }}
                  onPointerLeave={(e) => {
                    if (
                      dragOverSceneBank === bName &&
                      !e.currentTarget.contains(e.relatedTarget as Node | null)
                    ) {
                      setDragOverSceneBank(null);
                    }
                  }}
                  onDrop={(e) => {
                    const srcBank =
                      draggingBank ||
                      e.dataTransfer.getData("application/x-taktlight-bank");
                    if (srcBank) {
                      e.preventDefault();
                      e.stopPropagation();
                      reorderSceneBanks(srcBank, bName);
                    }
                    setDraggingBank(null);
                    setDragOverBank(null);
                  }}
                  className={`w-[165px] min-h-[150px] bg-slate-dark border border-steel border-t-2 border-t-amber-400/90 rounded flex flex-col overflow-hidden shrink-0 transition-opacity ${
                    (dragOverBank === bName && draggingBank !== bName) ||
                    (draggingSceneId && dragOverSceneBank === bName)
                      ? "ring-2 ring-ember border-ember"
                      : ""
                  } ${draggingBank === bName ? "opacity-50" : ""}`}
                >
                  {/* Bank Header (Drag to reorder · Right-click for Stackable / Rename / Delete) */}
                  <div
                    data-testid={`bank-header-${bName}`}
                    draggable={renamingBank !== bName}
                    onDragStart={(e) => {
                      if (renamingBank === bName) {
                        e.preventDefault();
                        return;
                      }
                      setDraggingBank(bName);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData(
                        "application/x-taktlight-bank",
                        bName,
                      );
                    }}
                    onDragEnd={() => {
                      setDraggingBank(null);
                      setDragOverBank(null);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setBankContextMenu({
                        bank: bName,
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }}
                    title="Drag to reorder bank · Right-click for Bank Options"
                    style={
                      bankColor
                        ? {
                            backgroundColor: `${bankColor}1A`,
                            borderBottomColor: `${bankColor}44`,
                          }
                        : undefined
                    }
                    className="bg-slate border-b border-steel/70 px-2 py-1 flex flex-col gap-1 cursor-grab active:cursor-grabbing"
                  >
                    <div className="flex items-center justify-between gap-1">
                      {renamingBank === bName ? (
                        <input
                          aria-label={`Rename bank ${bName}`}
                          type="text"
                          value={renameBankValue}
                          onChange={(e) => setRenameBankValue(e.target.value)}
                          onBlur={() => {
                            void renameSceneBank(bName, renameBankValue);
                            setRenamingBank(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              void renameSceneBank(bName, renameBankValue);
                              setRenamingBank(null);
                            } else if (e.key === "Escape") {
                              setRenamingBank(null);
                            }
                          }}
                          autoFocus
                          className="w-full bg-ink border border-ember rounded px-1 py-0.5 text-xs font-mono text-frost"
                        />
                      ) : (
                        <div className="flex items-center gap-1 min-w-0">
                          {bankColor && (
                            <span
                              data-testid={`bank-color-dot-${bName}`}
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: bankColor }}
                            />
                          )}
                          <span
                            data-testid={`bank-name-${bName}`}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              setRenamingBank(bName);
                              setRenameBankValue(bName);
                            }}
                            title="Double-click to rename bank"
                            className="font-sans text-xs font-semibold text-frost truncate cursor-text"
                          >
                            {bName}
                          </span>
                          {isStackable && (
                            <span
                              data-testid={`bank-stack-badge-${bName}`}
                              className="px-1 py-0.2 rounded bg-plum/25 border border-plum/60 font-mono text-[8px] text-plum shrink-0"
                            >
                              STACK
                            </span>
                          )}
                        </div>
                      )}
                      <button
                        type="button"
                        data-testid={`bank-menu-btn-${bName}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          setBankContextMenu({
                            bank: bName,
                            x: rect.left,
                            y: rect.bottom + 4,
                          });
                        }}
                        title="Bank Options (Recolor, Stackable, Rename, Delete)"
                        className="p-0.5 rounded text-fog hover:text-frost hover:bg-ink shrink-0"
                      >
                        <ChevronDown className="w-3 h-3" />
                      </button>
                    </div>

                    {/* Mini Bank Transport Strip: Pause/Stop All + Quick Add Scene */}
                    <div className="flex items-center justify-between gap-1 pt-0.5 border-t border-steel/40">
                      <button
                        type="button"
                        onClick={() => void releaseBankScenes(bName)}
                        title={`Stop active scenes in ${bName}`}
                        className="p-0.5 rounded text-fog hover:text-frost hover:bg-ink"
                      >
                        <Pause className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        data-testid={`quick-add-scene-${bName}`}
                        onClick={() => void createQuickSceneInBank(bName)}
                        title={`Add Scene to ${bName}`}
                        className="p-0.5 rounded text-fog hover:text-ember hover:bg-ink"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Scene Tiles List */}
                  <div className="p-1.5 flex flex-col gap-1.5">
                    {scenesInBank.length === 0 ? (
                      <div className="font-mono text-[10px] text-fog py-4 text-center">
                        Empty bank. Click +
                      </div>
                    ) : (
                      scenesInBank.map((sc) => renderSceneTile(sc, bankColor))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* RIGHT: DASLIGHT 5 SCENE / FX INSPECTOR + FAR-RIGHT TOOL RAIL */}
        {showRightInspector && (
          <>
            <SplitHandle
              orientation="vertical"
              testId="split-scene-inspector"
              ariaLabel="Resize Scene Banks and FX Inspector"
              className="hidden xl:flex"
              onDragDelta={(deltaPx) =>
                setStudioLayout({
                  inspectorWidthPx:
                    useTaktStore.getState().studioLayout.inspectorWidthPx -
                    deltaPx,
                })
              }
              onDoubleClick={() =>
                setStudioLayout({
                  inspectorWidthPx: DEFAULT_STUDIO_LAYOUT.inspectorWidthPx,
                })
              }
            />
            <section
              data-testid="daslight-fx-rack"
              style={{
                ["--inspector-w" as string]: `${studioLayout.inspectorWidthPx}px`,
              }}
              className="w-full xl:w-[var(--inspector-w)] shrink-0 bg-slate-dark border border-steel rounded flex min-h-0 overflow-hidden"
            >
            {/* Inspector Main Body */}
            <div className="flex-1 min-w-0 flex flex-col min-h-0">
              {/* Inspector Top Scene Header */}
              <div className="shrink-0 bg-slate border-b border-steel px-2.5 py-1.5 flex items-center justify-between gap-2">
                <span className="font-sans text-xs font-semibold text-amber-400 truncate">
                  {selectedScene ? selectedScene.name : "No Scene Selected"}
                </span>

                <div className="flex items-center gap-1 shrink-0">
                  {selectedScene &&
                    selectedScenePrimaryBlock &&
                    (blockUsageCounts[selectedScenePrimaryBlock.id] ?? 1) >
                      1 && (
                      <button
                        type="button"
                        data-testid="make-fx-block-unique-btn"
                        onClick={() =>
                          void makeFxBlockUniqueForScene(
                            selectedScene.id,
                            selectedScenePrimaryBlock.id,
                          )
                        }
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-ink border border-pine text-pine font-mono text-[10px]"
                        title="Make FX Block Unique to this Scene"
                      >
                        <Link2 className="w-3 h-3" />
                        <span>Unique</span>
                      </button>
                    )}

                  {selectedScene && (() => {
                    const selInst = activeById.get(selectedScene.id);
                    const isRun = Boolean(selInst && selInst.release_t_sec === null);
                    return (
                      <button
                        type="button"
                        onClick={() => {
                          if (isRun) void releaseScene(selectedScene.id);
                          else void triggerScene(selectedScene.id);
                        }}
                        title={isRun ? "Stop Selected Scene" : "Play Selected Scene"}
                        className="p-1 rounded bg-ink border border-steel text-mist hover:border-ember"
                      >
                        {isRun ? (
                          <Square className="w-3 h-3 text-signal" />
                        ) : (
                          <Play className="w-3 h-3" />
                        )}
                      </button>
                    );
                  })()}
                </div>
              </div>

              {/* Always-Visible Scene Target Selector (hidden for Timeline Super-Scenes, whose child scenes handle targets) */}
              {selectedScene && !selectedScene.timeline_ref && (
                <div
                  data-testid="scene-target-bar"
                  className="shrink-0 bg-pitch border-b border-steel/70 px-2.5 py-1 flex items-center justify-between gap-2 font-mono text-[10px]"
                >
                  <span className="text-fog uppercase shrink-0 flex items-center gap-1">
                    <span>Target</span>
                    <HelpTooltip text="Selects which fixtures or group this scene drives. Updates both the Scene and its FX block." />
                  </span>
                  <select
                    aria-label="Scene Target"
                    data-testid="scene-target-select"
                    value={
                      selectedScene.target_group ??
                      selectedScenePrimaryBlock?.target_group ??
                      "all"
                    }
                    onChange={(e) => {
                      const nextTarget = e.target.value || "all";
                      setFxTargetGroup(nextTarget);
                      void upsertScene({
                        ...selectedScene,
                        target_group: nextTarget === "all" ? null : nextTarget,
                      });
                      if (selectedScenePrimaryBlock) {
                        const st = useTaktStore.getState();
                        const nextElements = st.gizmoAutoFit
                          ? selectedScenePrimaryBlock.elements.map((el) => {
                              if (el.kind !== "spatial_shader_2d") return el;
                              const b = computeTargetGizmoBounds({
                                compiledCells: st.compiledCells,
                                patch: st.showState.patch,
                                groups: st.showState.groups,
                                targetGroup: nextTarget,
                                fallbackFixtureIds: st.selectedFixtureIds,
                              });
                              return {
                                ...el,
                                center_x: b.centerX,
                                center_y: b.centerY,
                                box_half_x: b.boxHalfX,
                                box_half_y: b.boxHalfY,
                                spatial_freq: b.spatialFreq,
                              };
                            })
                          : selectedScenePrimaryBlock.elements;
                        void upsertFxBlock({
                          ...selectedScenePrimaryBlock,
                          target_group: nextTarget,
                          elements: nextElements,
                        });
                      }
                    }}
                    className="flex-1 min-w-0 bg-ink border border-steel rounded px-1.5 py-0.5 text-[10px] text-frost focus:outline-none focus:border-ember"
                  >
                    {targetOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <span
                    data-testid="scene-target-beam-count"
                    className="text-fog shrink-0"
                  >
                    {targetBeamCount}b
                  </span>
                </div>
              )}

              {/* Scrollable Inspector Content */}
              <div className="flex-1 min-h-0 overflow-y-auto p-2.5 flex flex-col gap-2">
                {selectedScene?.timeline_ref && inspectorRailTab === "fx" ? (
                  <TimelineRightInspector timelineId={selectedScene.timeline_ref} />
                ) : !selectedScene?.timeline_ref && (selectedScene || fxPickerMode) && inspectorRailTab === "fx" && (
                  <>
                    {/* DASLIGHT 5 CLEAN 2-COLUMN CHOICE MATRIX (6 FX TILES + TIMELINE) */}
                    {fxPickerMode ? (
                      <div className="flex flex-col gap-2 pt-1">
                        <div
                          data-testid="daslight-fx-picker-grid"
                          className="grid grid-cols-2 gap-2"
                        >
                          <button
                            type="button"
                            data-testid="fx-picker-tile-color_fx"
                            onClick={() =>
                              void pickDaslightFxTile("color_fx", fxAppendMode)
                            }
                            className="h-14 rounded bg-ink border border-steel hover:border-cobalt font-mono text-[11px] font-semibold text-mist flex items-center justify-center text-center px-1"
                          >
                            COLOR FX
                          </button>
                          <button
                            type="button"
                            data-testid="fx-picker-tile-color_mappings"
                            onClick={() =>
                              void pickDaslightFxTile(
                                "color_mappings",
                                fxAppendMode,
                              )
                            }
                            className="h-14 rounded bg-ink border border-steel hover:border-cobalt font-mono text-[11px] font-semibold text-mist flex items-center justify-center text-center px-1"
                          >
                            COLOR MAPPINGS
                          </button>
                          <button
                            type="button"
                            data-testid="fx-picker-tile-chaser_fx"
                            onClick={() =>
                              void pickDaslightFxTile("chaser_fx", fxAppendMode)
                            }
                            className="h-14 rounded bg-ink border border-steel hover:border-ember font-mono text-[11px] font-semibold text-mist flex items-center justify-center text-center px-1"
                          >
                            CHASER FX
                          </button>
                          <button
                            type="button"
                            data-testid="fx-picker-tile-value_fx"
                            onClick={() =>
                              void pickDaslightFxTile("value_fx", fxAppendMode)
                            }
                            className="h-14 rounded bg-ink border border-steel hover:border-ember font-mono text-[11px] font-semibold text-mist flex items-center justify-center text-center px-1"
                          >
                            VALUE FX
                          </button>
                          <button
                            type="button"
                            data-testid="fx-picker-tile-curve_fx"
                            onClick={() =>
                              void pickDaslightFxTile("curve_fx", fxAppendMode)
                            }
                            className="h-14 rounded bg-ink border border-steel hover:border-ember font-mono text-[11px] font-semibold text-mist flex items-center justify-center text-center px-1"
                          >
                            CURVE FX
                          </button>
                          <button
                            type="button"
                            data-testid="fx-picker-tile-mappings"
                            onClick={() =>
                              void pickDaslightFxTile("mappings", fxAppendMode)
                            }
                            className="h-14 rounded bg-ink border border-steel hover:border-cobalt font-mono text-[11px] font-semibold text-mist flex items-center justify-center text-center px-1"
                          >
                            MAPPINGS
                          </button>
                          <button
                            type="button"
                            data-testid="fx-picker-tile-scene_sequence"
                            title="Chain existing scenes into a timeline-compatible step sequence"
                            onClick={() =>
                              void pickDaslightFxTile(
                                "scene_sequence",
                                fxAppendMode,
                              )
                            }
                            className="col-span-2 h-11 rounded bg-ember/15 border border-ember/60 hover:border-ember hover:bg-ember/25 font-mono text-[11px] font-semibold text-frost flex items-center justify-center gap-1.5 px-2 transition-colors"
                          >
                            <Layers className="w-3.5 h-3.5 text-ember" />
                            <span>SCENE SEQUENCE</span>
                          </button>
                          {!fxAppendMode && (
                            <button
                              type="button"
                              data-testid="fx-picker-tile-timeline"
                              title="Convert this scene into a multi-track audio and lighting Timeline"
                              onClick={() => {
                                void (async () => {
                                  const sc =
                                    selectedScene ??
                                    (await createQuickSceneInBank(
                                      allBanks[0] ?? "Bank 1",
                                    ));
                                  await convertSceneToTimeline(sc.id);
                                })();
                              }}
                              className="col-span-2 h-11 rounded bg-cobalt/15 border border-cobalt/60 hover:border-cobalt hover:bg-cobalt/25 font-mono text-[11px] font-semibold text-frost flex items-center justify-center gap-1.5 px-2 transition-colors"
                            >
                              <AudioWaveform className="w-3.5 h-3.5 text-cobalt" />
                              <span>TIMELINE</span>
                            </button>
                          )}
                        </div>

                        {fxAppendMode && proceduralElements.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              setFxAppendMode(false);
                              setFxPickerMode(false);
                            }}
                            className="py-1 rounded border border-steel bg-pitch font-mono text-[10px] text-fog hover:text-frost"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    ) : (
                      <>
                        {/* Sub-header: Procedural FX Stack Tabs + Choice Matrix Return */}
                        <div className="flex items-center justify-between gap-1 border-b border-steel/60 pb-1.5">
                          <div className="flex items-center gap-1 overflow-x-auto">
                            {selectedScenePrimaryBlock &&
                              proceduralElements.map((el, idx) => (
                                <button
                                  key={`${el.kind}-${"trait" in el ? el.trait : "seq"}-${idx}`}
                                  type="button"
                                  data-testid={`fx-stack-tab-${idx}`}
                                  onClick={() => {
                                    setActiveElementIdx(idx);
                                    loadElementIntoEditor(
                                      selectedScenePrimaryBlock,
                                      idx,
                                    );
                                    setFxPickerMode(false);
                                  }}
                                  className={`px-2 py-0.5 rounded font-mono text-[10px] border shrink-0 ${
                                    activeElementIdx === idx
                                      ? "bg-ink border-ember text-frost font-semibold"
                                      : "bg-pitch border-steel text-fog hover:text-mist"
                                  }`}
                                >
                                  {describeElementShort(el)}
                                </button>
                              ))}
                          </div>

                          <button
                            type="button"
                            data-testid="toggle-fx-picker-btn"
                            aria-label="Remove FX"
                            onClick={() => {
                              void (async () => {
                                await removeActiveFxElement();
                                setFxAppendMode(false);
                                setFxPickerMode(true);
                              })();
                            }}
                            title="Remove FX & Back to FX Choice Matrix"
                            className="p-1 rounded text-fog hover:text-frost hover:bg-ink shrink-0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {/* Locked FX Submenu Header */}
                        <div
                          data-testid={`fx-submenu-header-${activeSubmenu}`}
                          className="font-mono text-[10px] font-semibold tracking-wider text-amber-400 px-0.5"
                        >
                          {submenuLabel(activeSubmenu)}
                        </div>

                        {/* Dynamic Target Channel / Trait Selector for Scalar FX & Mappings */}
                        {(activeSubmenu === "curve_fx" ||
                          activeSubmenu === "chaser_fx" ||
                          activeSubmenu === "value_fx" ||
                          activeSubmenu === "mappings") && (
                          <div className="bg-pitch border border-steel rounded px-2 py-1.5 flex items-center justify-between gap-2 font-mono text-[10px]">
                            <span
                              className="text-fog shrink-0"
                              title="Choose which fixture channel or trait this effect modulates"
                            >
                              Target Channel
                            </span>
                            <select
                              aria-label="FX Target Channel"
                              data-testid="fx-target-trait-select"
                              value={fxTrait}
                              onChange={(e) => {
                                const tr = e.target.value;
                                setFxTrait(tr);
                                void syncSelectedSceneBlock({ trait: tr });
                              }}
                              className="flex-1 min-w-0 bg-ink border border-steel rounded px-1.5 py-0.5 text-xs text-frost"
                            >
                              {availableFxTraitOptions.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        {/* SHARED MULTI-STOP COLOR EDITOR FOR COLOR FX & COLOR MAPPINGS */}
                        {(activeSubmenu === "color_fx" ||
                          activeSubmenu === "color_mappings") && (
                          <div className="bg-pitch border border-steel rounded p-2 flex flex-col gap-2 font-mono text-[10px]">
                            <div className="flex flex-col gap-0.5">
                              <div className="flex items-center justify-between">
                                <span className="text-fog">Color Preset</span>
                                <button
                                  type="button"
                                  data-testid="open-palette-builder-fx-btn"
                                  onClick={() => setPaletteBuilderOpen(true)}
                                  title="Create or edit multi-stop color palettes"
                                  className="px-1.5 py-0.5 rounded bg-ink border border-steel hover:border-ember text-[9px] text-mist hover:text-frost"
                                >
                                  + Palette Builder
                                </button>
                              </div>
                              <select
                                aria-label="Color Preset"
                                value={fxPaletteRef}
                                onChange={(e) => {
                                  const pool =
                                    showState.color_palettes.length > 0
                                      ? showState.color_palettes
                                      : DEFAULT_COLOR_PALETTES;
                                  const pal = pool.find(
                                    (p) => p.id === e.target.value,
                                  );
                                  if (!pal) return;
                                  const stops = [
                                    ...(pal.colors ?? [
                                      pal.hex_start,
                                      pal.hex_end,
                                    ]),
                                  ];
                                  setFxPaletteRef(pal.id);
                                  setFxInlineColors(stops);
                                  void syncSelectedSceneBlock({
                                    paletteRef: pal.id,
                                    inlineColors: stops,
                                  });
                                }}
                                className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                              >
                                {(showState.color_palettes.length > 0
                                  ? showState.color_palettes
                                  : DEFAULT_COLOR_PALETTES
                                ).map((pal) => (
                                  <option key={pal.id} value={pal.id}>
                                    {pal.name}
                                  </option>
                                ))}
                              </select>
                            </div>

                            {(() => {
                              const stops =
                                fxInlineColors.length > 0
                                  ? fxInlineColors
                                  : ["#FF0000", "#0044FF"];
                              return (
                                <>
                                  <div className="flex h-4 w-full rounded overflow-hidden border border-steel">
                                    {Array.from({ length: 16 }).map((_, i) => (
                                      <div
                                        key={i}
                                        className="flex-1 border-r border-pitch/40 last:border-r-0"
                                        style={{
                                          backgroundColor: linearRgbToSrgbHex(
                                            sampleOklabStopsLinear(
                                              stops,
                                              i / 15,
                                              fxGradient,
                                              fxGrayscale,
                                              true,
                                            ),
                                          ),
                                        }}
                                      />
                                    ))}
                                  </div>

                                  <div className="flex flex-wrap items-center gap-1">
                                    <span className="text-fog mr-1">
                                      Color Palette
                                    </span>
                                    {stops.map((hex, idx) => (
                                      <div
                                        key={`${idx}-${hex}`}
                                        className="relative flex items-center"
                                      >
                                        <input
                                          type="color"
                                          aria-label={`Color Stop ${idx + 1}`}
                                          value={hex}
                                          onChange={(e) => {
                                            const next = stops.map((c, i) =>
                                              i === idx ? e.target.value : c,
                                            );
                                            setFxInlineColors(next);
                                            void syncSelectedSceneBlock({
                                              inlineColors: next,
                                            });
                                          }}
                                          className="w-5 h-5 rounded border border-steel bg-ink p-0 cursor-pointer"
                                        />
                                        {stops.length > 1 && (
                                          <button
                                            type="button"
                                            aria-label={`Remove Color Stop ${idx + 1}`}
                                            onClick={() => {
                                              const next = stops.filter(
                                                (_, i) => i !== idx,
                                              );
                                              setFxInlineColors(next);
                                              void syncSelectedSceneBlock({
                                                inlineColors: next,
                                              });
                                            }}
                                            className="ml-0.5 text-[9px] text-fog hover:text-signal"
                                            title="Remove Color Stop"
                                          >
                                            ×
                                          </button>
                                        )}
                                      </div>
                                    ))}
                                    <button
                                      type="button"
                                      data-testid="add-color-stop-btn"
                                      aria-label="Add Color Stop"
                                      onClick={() => {
                                        const next = [...stops, "#FFFFFF"];
                                        setFxInlineColors(next);
                                        void syncSelectedSceneBlock({
                                          inlineColors: next,
                                        });
                                      }}
                                      className="w-5 h-5 rounded border border-steel bg-ink text-mist hover:border-ember flex items-center justify-center"
                                      title="Add Color Stop"
                                    >
                                      +
                                    </button>
                                  </div>
                                </>
                              );
                            })()}

                            <label className="flex items-center justify-between gap-2">
                              <span className="text-fog">Grayscale</span>
                              <input
                                type="checkbox"
                                aria-label="Grayscale"
                                checked={fxGrayscale}
                                onChange={(e) => {
                                  const gs = e.target.checked;
                                  setFxGrayscale(gs);
                                  void syncSelectedSceneBlock({
                                    grayscale: gs,
                                  });
                                }}
                                className="accent-cobalt"
                              />
                            </label>

                            {activeSubmenu === "color_fx" && (
                              <>
                                <label className="flex flex-col gap-0.5">
                                  <span className="text-fog">Transform</span>
                                  <select
                                    aria-label="Color FX Transform"
                                    value={fxOrder}
                                    onChange={(e) => {
                                      const ord = e.target
                                        .value as OrderRuleStr;
                                      setFxOrder(ord);
                                      void syncSelectedSceneBlock({
                                        order: ord,
                                      });
                                    }}
                                    className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                                  >
                                    <option value="linear">None (1→N)</option>
                                    <option value="reverse">Reverse (N→1)</option>
                                    <option value="center_out">
                                      Center Out
                                    </option>
                                    <option value="mirror">Mirror</option>
                                    <option value="odd_even">
                                      Odd / Even
                                    </option>
                                    <option value="blocks(2)">
                                      Blocks (2)
                                    </option>
                                  </select>
                                </label>

                                <NumericSlider
                                  layout="stacked"
                                  label="Color Width"
                                  ariaLabel="Color Width"
                                  value={fxColorWidth}
                                  defaultValue={1}
                                  min={0.1}
                                  max={4}
                                  step={0.05}
                                  precision={2}
                                  onChange={(cw) => {
                                    setFxColorWidth(cw);
                                    void syncSelectedSceneBlock({
                                      colorWidth: cw,
                                    });
                                  }}
                                />

                                <NumericSlider
                                  layout="stacked"
                                  label="Angle"
                                  ariaLabel="Color FX Angle"
                                  value={fxAngleDeg}
                                  defaultValue={0}
                                  min={0}
                                  max={360}
                                  step={5}
                                  unit="°"
                                  precision={0}
                                  onChange={(deg) => {
                                    setFxAngleDeg(deg);
                                    void syncSelectedSceneBlock({
                                      angleDeg: deg,
                                    });
                                  }}
                                />
                              </>
                            )}

                            {activeSubmenu === "color_mappings" && (
                              <>
                                <div className="grid grid-cols-2 gap-1.5">
                                  <label className="flex flex-col gap-0.5">
                                    <span className="text-fog">2D Pattern</span>
                                    <select
                                      aria-label="FX Shader Kind"
                                      value={fxShader}
                                      onChange={(e) => {
                                        const sh = e.target
                                          .value as Shader2DKind;
                                        setFxShader(sh);
                                        void syncSelectedSceneBlock({
                                          shader: sh,
                                        });
                                      }}
                                      className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                                    >
                                      <option value="linear_sweep">
                                        Linear Sweep
                                      </option>
                                      <option value="radial_wave">
                                        Radial Wave
                                      </option>
                                      <option value="pinwheel">Pinwheel</option>
                                      <option value="plasma">Plasma</option>
                                    </select>
                                  </label>

                                  <label className="flex flex-col gap-0.5">
                                    <span className="text-fog">Transform</span>
                                    <select
                                      aria-label="Mapping Transform"
                                      value={fxTransform}
                                      onChange={(e) => {
                                        const tr = e.target.value;
                                        setFxTransform(tr);
                                        void syncSelectedSceneBlock({
                                          transform: tr,
                                        });
                                      }}
                                      className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                                    >
                                      <option value="">None</option>
                                      <option value="mirror_x">Mirror X</option>
                                      <option value="mirror_y">Mirror Y</option>
                                      <option value="invert">Invert</option>
                                    </select>
                                  </label>
                                </div>

                                <NumericSlider
                                  layout="stacked"
                                  label="Rotation"
                                  ariaLabel="Mapping Rotation"
                                  value={fxDirectionDeg}
                                  defaultValue={0}
                                  min={0}
                                  max={360}
                                  step={5}
                                  unit="°"
                                  precision={0}
                                  onChange={(deg) => {
                                    setFxDirectionDeg(deg);
                                    void syncSelectedSceneBlock({
                                      directionDeg: deg,
                                    });
                                  }}
                                />

                                <NumericSlider
                                  layout="stacked"
                                  label="Color Width"
                                  ariaLabel="Color Width"
                                  value={fxColorWidth}
                                  defaultValue={1}
                                  min={0.1}
                                  max={4}
                                  step={0.05}
                                  precision={2}
                                  onChange={(cw) => {
                                    setFxColorWidth(cw);
                                    void syncSelectedSceneBlock({
                                      colorWidth: cw,
                                    });
                                  }}
                                />

                                <NumericSlider
                                  layout="stacked"
                                  label="Scale"
                                  ariaLabel="Pattern Scale Slider"
                                  value={patternScaleValue}
                                  defaultValue={1}
                                  min={0.25}
                                  max={10}
                                  step={0.05}
                                  unit="×"
                                  precision={2}
                                  onChange={(ps) => {
                                    const sf = patternScaleToSpatialFreq(ps);
                                    setFxSpatialFreq(sf);
                                    void syncSelectedSceneBlock({
                                      spatialFreq: sf,
                                    });
                                  }}
                                />
                              </>
                            )}

                            <NumericSlider
                              layout="stacked"
                              label="Gradient"
                              ariaLabel="Gradient"
                              value={Math.round(fxGradient * 100)}
                              defaultValue={100}
                              min={0}
                              max={100}
                              step={1}
                              unit="%"
                              precision={0}
                              onChange={(pct) => {
                                const gr = pct / 100;
                                setFxGradient(gr);
                                void syncSelectedSceneBlock({ gradient: gr });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Rate"
                              ariaLabel="FX Rate Cycles"
                              value={fxRateCycles}
                              defaultValue={1}
                              min={0}
                              max={8}
                              step={0.25}
                              unit="×"
                              precision={2}
                              headerExtra={
                                <button
                                  type="button"
                                  data-testid="spatial-static-toggle"
                                  aria-pressed={fxRateCycles === 0}
                                  onClick={() => {
                                    const nextRate =
                                      fxRateCycles === 0
                                        ? Math.max(0.25, lastNonZeroRateRef.current || 1)
                                        : 0;
                                    if (fxRateCycles > 0) {
                                      lastNonZeroRateRef.current = fxRateCycles;
                                    }
                                    setFxTimingMode("cycles");
                                    setFxRateCycles(nextRate);
                                    void syncSelectedSceneBlock({
                                      timingMode: "cycles",
                                      rateCycles: nextRate,
                                    });
                                  }}
                                  className={`px-1.5 py-0.5 rounded border text-[9px] font-mono shrink-0 ${
                                    fxRateCycles === 0
                                      ? "bg-amber/20 border-amber text-amber"
                                      : "bg-ink border-steel text-fog hover:text-frost"
                                  }`}
                                >
                                  Static
                                </button>
                              }
                              onChange={(rc) => {
                                if (rc > 0) {
                                  lastNonZeroRateRef.current = rc;
                                }
                                setFxTimingMode("cycles");
                                setFxRateCycles(rc);
                                void syncSelectedSceneBlock({
                                  timingMode: "cycles",
                                  rateCycles: rc,
                                });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Phase Offset"
                              ariaLabel="Spatial Phase Offset"
                              value={Math.round(fxPhaseOffset * 100)}
                              defaultValue={0}
                              min={0}
                              max={100}
                              step={1}
                              unit="%"
                              precision={0}
                              onChange={(pct) => {
                                const po = pct / 100;
                                setFxPhaseOffset(po);
                                void syncSelectedSceneBlock({
                                  phaseOffset: po,
                                });
                              }}
                            />

                            <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-steel/40">
                              <button
                                type="button"
                                data-testid="inspector-gizmo-fit-btn"
                                onClick={() => {
                                  if (!selectedScenePrimaryBlock) return;
                                  const st = useTaktStore.getState();
                                  const b = computeTargetGizmoBounds({
                                    compiledCells: st.compiledCells,
                                    patch: st.showState.patch,
                                    groups: st.showState.groups,
                                    targetGroup:
                                      selectedScene?.target_group ??
                                      selectedScenePrimaryBlock.target_group ??
                                      fxTargetGroup,
                                    fallbackFixtureIds: st.selectedFixtureIds,
                                  });
                                  setFxCenterX(b.centerX);
                                  setFxCenterY(b.centerY);
                                  setFxSpatialFreq(b.spatialFreq);
                                  void syncSelectedSceneBlock({
                                    centerX: b.centerX,
                                    centerY: b.centerY,
                                    boxHalfX: b.boxHalfX,
                                    boxHalfY: b.boxHalfY,
                                    spatialFreq: b.spatialFreq,
                                  });
                                }}
                                title="Resize and center the 2D shader gizmo around the targeted fixtures"
                                className="flex-1 py-1 rounded border border-cobalt bg-cobalt/15 hover:bg-cobalt/30 text-frost font-semibold"
                              >
                                Fit Gizmo to Targets
                              </button>
                              <button
                                type="button"
                                aria-pressed={gizmoAutoFit}
                                onClick={() => setGizmoAutoFit(!gizmoAutoFit)}
                                title="Automatically refit the 2D gizmo whenever targeted fixtures move"
                                className={`px-2 py-1 rounded border ${
                                  gizmoAutoFit
                                    ? "border-plum bg-plum/25 text-frost font-semibold"
                                    : "border-steel bg-ink text-fog hover:text-mist"
                                }`}
                              >
                                Auto
                              </button>
                            </div>
                          </div>
                        )}

                        {/* LOCKED SUBMENU 3: CHASER FX */}
                        {activeSubmenu === "chaser_fx" && (
                          <div className="bg-pitch border border-steel rounded p-2 flex flex-col gap-2 font-mono text-[10px]">
                            <div
                              data-testid="step-chase-preview-bar"
                              className="flex gap-1 bg-void p-1 rounded border border-steel/60"
                            >
                              {stepPreview.blocks.map((blk) => (
                                <div
                                  key={blk.index}
                                  className="flex-1 h-5 rounded-sm border border-steel/60 flex items-center justify-center font-mono text-[9px] text-frost"
                                  style={{
                                    backgroundColor: `rgba(255, 85, 0, ${0.12 + blk.level * 0.88})`,
                                  }}
                                >
                                  {blk.index}
                                </div>
                              ))}
                            </div>

                            <label className="flex items-center justify-between gap-2">
                              <span className="text-fog">One Way Only</span>
                              <input
                                type="checkbox"
                                aria-label="One Way Only"
                                checked={fxOneWay}
                                onChange={(e) => {
                                  const ow = e.target.checked;
                                  setFxOneWay(ow);
                                  void syncSelectedSceneBlock({ oneWay: ow });
                                }}
                                className="accent-ember"
                              />
                            </label>

                            <label className="flex items-center justify-between gap-2">
                              <span className="text-fog">Fading</span>
                              <input
                                type="checkbox"
                                aria-label="Chaser Fading"
                                checked={fxFade > 0}
                                onChange={(e) => {
                                  const nextFade = e.target.checked ? 0.5 : 0;
                                  setFxFade(nextFade);
                                  void syncSelectedSceneBlock({
                                    fade: nextFade,
                                  });
                                }}
                                className="accent-cobalt"
                              />
                            </label>

                            {fxFade > 0 && (
                              <NumericSlider
                                layout="stacked"
                                label="Fade"
                                ariaLabel="Step Softness Pct"
                                value={Math.round(fxFade * 100)}
                                defaultValue={0}
                                min={0}
                                max={100}
                                step={5}
                                unit="%"
                                precision={0}
                                onChange={(pct) => {
                                  const fd = pct / 100;
                                  setFxFade(fd);
                                  void syncSelectedSceneBlock({ fade: fd });
                                }}
                              />
                            )}

                            <NumericSlider
                              layout="stacked"
                              label="Nb pixels on"
                              ariaLabel="Nb pixels on"
                              value={fxPixelsOn}
                              defaultValue={1}
                              min={1}
                              max={Math.max(1, compiledCells.length || 8)}
                              step={1}
                              precision={0}
                              onChange={(px) => {
                                const clamped = Math.max(1, Math.round(px));
                                setFxPixelsOn(clamped);
                                void syncSelectedSceneBlock({
                                  pixelsOn: clamped,
                                });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Rate"
                              ariaLabel="FX Rate Cycles"
                              value={fxRateCycles}
                              defaultValue={1}
                              min={0.25}
                              max={8}
                              step={0.25}
                              unit="×"
                              precision={2}
                              onChange={(rc) => {
                                setFxTimingMode("cycles");
                                setFxRateCycles(rc);
                                void syncSelectedSceneBlock({
                                  timingMode: "cycles",
                                  rateCycles: rc,
                                });
                              }}
                            />

                            <div className="grid grid-cols-2 gap-1.5">
                              <label className="flex flex-col gap-0.5">
                                <span className="text-fog">Order</span>
                                <select
                                  aria-label="Effect Run Order"
                                  value={fxOrder}
                                  onChange={(e) => {
                                    const ord = e.target.value as OrderRuleStr;
                                    setFxOrder(ord);
                                    void syncSelectedSceneBlock({ order: ord });
                                  }}
                                  className="bg-ink border border-steel rounded px-1.5 py-0.5 text-xs text-frost"
                                >
                                  <option value="linear">1→N Forward</option>
                                  <option value="reverse">N→1 Reverse</option>
                                  <option value="center_out">Center Out</option>
                                  <option value="mirror">Mirror</option>
                                  <option value="odd_even">Odd / Even</option>
                                  <option value="blocks(2)">Blocks (2)</option>
                                </select>
                              </label>
                            </div>
                          </div>
                        )}

                        {/* LOCKED SUBMENU 4: VALUE FX */}
                        {activeSubmenu === "value_fx" && (
                          <div className="bg-pitch border border-steel rounded p-2 flex flex-col gap-2 font-mono text-[10px]">
                            {(() => {
                              const stops =
                                fxValueStops.length > 0
                                  ? fxValueStops
                                  : [1, 0.5, 0];
                              const safeIdx = Math.max(
                                0,
                                Math.min(
                                  selectedValueStopIdx,
                                  stops.length - 1,
                                ),
                              );
                              return (
                                <>
                                  <div className="flex h-4 w-full rounded overflow-hidden border border-steel">
                                    {Array.from({ length: 16 }).map((_, i) => {
                                      const v = sampleValueStops(
                                        stops,
                                        i / 15,
                                        fxGradient,
                                        true,
                                      );
                                      const ch = Math.round(v * 255);
                                      return (
                                        <div
                                          key={i}
                                          className="flex-1 border-r border-pitch/40 last:border-r-0"
                                          style={{
                                            backgroundColor: `rgb(${ch}, ${ch}, ${ch})`,
                                          }}
                                        />
                                      );
                                    })}
                                  </div>

                                  <div className="flex flex-wrap items-center gap-1">
                                    <span className="text-fog mr-1">
                                      Values
                                    </span>
                                    {stops.map((val, idx) => {
                                      const ch = Math.round(val * 255);
                                      return (
                                        <div
                                          key={`${idx}-${val}`}
                                          className="flex items-center"
                                        >
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setSelectedValueStopIdx(idx)
                                            }
                                            className={`px-1.5 h-5 rounded border text-[9px] font-semibold ${
                                              safeIdx === idx
                                                ? "border-ember ring-1 ring-ember"
                                                : "border-steel"
                                            }`}
                                            style={{
                                              backgroundColor: `rgb(${ch}, ${ch}, ${ch})`,
                                              color:
                                                val > 0.5
                                                  ? "#111827"
                                                  : "#F2F6FB",
                                            }}
                                          >
                                            {Math.round(val * 100)}
                                          </button>
                                          {stops.length > 2 && (
                                            <button
                                              type="button"
                                              aria-label={`Remove Value Stop ${idx + 1}`}
                                              onClick={() => {
                                                const next = stops.filter(
                                                  (_, i) => i !== idx,
                                                );
                                                setFxValueStops(next);
                                                setSelectedValueStopIdx(
                                                  Math.max(0, safeIdx - 1),
                                                );
                                                void syncSelectedSceneBlock({
                                                  valueStops: next,
                                                });
                                              }}
                                              className="ml-0.5 text-[9px] text-fog hover:text-signal"
                                            >
                                              ×
                                            </button>
                                          )}
                                        </div>
                                      );
                                    })}
                                    <button
                                      type="button"
                                      data-testid="add-value-stop-btn"
                                      aria-label="Add Value Stop"
                                      onClick={() => {
                                        const next = [...stops, 0.5];
                                        setFxValueStops(next);
                                        setSelectedValueStopIdx(
                                          next.length - 1,
                                        );
                                        void syncSelectedSceneBlock({
                                          valueStops: next,
                                        });
                                      }}
                                      className="w-5 h-5 rounded border border-steel bg-ink text-mist hover:border-ember flex items-center justify-center"
                                    >
                                      +
                                    </button>
                                  </div>

                                  <NumericSlider
                                    layout="stacked"
                                    label="Stop Level"
                                    ariaLabel="Value Stop Level"
                                    value={Math.round(stops[safeIdx] * 100)}
                                    defaultValue={100}
                                    min={0}
                                    max={100}
                                    step={1}
                                    unit="%"
                                    precision={0}
                                    onChange={(pct) => {
                                      const next = stops.map((v, i) =>
                                        i === safeIdx
                                          ? Math.max(0, Math.min(1, pct / 100))
                                          : v,
                                      );
                                      setFxValueStops(next);
                                      void syncSelectedSceneBlock({
                                        valueStops: next,
                                      });
                                    }}
                                  />
                                </>
                              );
                            })()}

                            <label className="flex flex-col gap-0.5">
                              <span className="text-fog">Transform</span>
                              <select
                                aria-label="Effect Run Order"
                                value={fxOrder}
                                onChange={(e) => {
                                  const ord = e.target.value as OrderRuleStr;
                                  setFxOrder(ord);
                                  void syncSelectedSceneBlock({ order: ord });
                                }}
                                className="bg-ink border border-steel rounded px-1.5 py-0.5 text-xs text-frost"
                              >
                                <option value="linear">None (1→N)</option>
                                <option value="reverse">Reverse (N→1)</option>
                                <option value="center_out">Center Out</option>
                                <option value="mirror">Mirror</option>
                                <option value="odd_even">Odd / Even</option>
                                <option value="blocks(2)">Blocks (2)</option>
                              </select>
                            </label>

                            <NumericSlider
                              layout="stacked"
                              label="Rate"
                              ariaLabel="FX Rate Cycles"
                              value={fxRateCycles}
                              defaultValue={1}
                              min={0.25}
                              max={8}
                              step={0.25}
                              unit="×"
                              precision={2}
                              onChange={(rc) => {
                                setFxTimingMode("cycles");
                                setFxRateCycles(rc);
                                void syncSelectedSceneBlock({
                                  timingMode: "cycles",
                                  rateCycles: rc,
                                });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Phase"
                              ariaLabel="FX Phase"
                              value={fxPhaseDeg}
                              defaultValue={0}
                              min={0}
                              max={360}
                              step={5}
                              unit="°"
                              precision={0}
                              onChange={(ph) => {
                                setFxPhaseDeg(ph);
                                void syncSelectedSceneBlock({ phaseDeg: ph });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Phasing"
                              ariaLabel="Curve Phasing"
                              value={fxPhaseSpreadDeg}
                              defaultValue={360}
                              min={0}
                              max={720}
                              step={15}
                              unit="°"
                              precision={0}
                              onChange={(deg) => {
                                setFxPhaseSpreadDeg(deg);
                                void syncSelectedSceneBlock({
                                  phaseSpreadDeg: deg,
                                });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Gradient"
                              ariaLabel="Gradient"
                              value={Math.round(fxGradient * 100)}
                              defaultValue={100}
                              min={0}
                              max={100}
                              step={1}
                              unit="%"
                              precision={0}
                              onChange={(pct) => {
                                const gr = pct / 100;
                                setFxGradient(gr);
                                void syncSelectedSceneBlock({ gradient: gr });
                              }}
                            />
                          </div>
                        )}

                        {/* LOCKED SUBMENU 5: CURVE FX */}
                        {activeSubmenu === "curve_fx" && (
                          <div className="bg-pitch border border-steel rounded p-2 flex flex-col gap-2 font-mono text-[10px]">
                            <label className="flex flex-col gap-0.5">
                              <span className="text-fog">Wave</span>
                              <select
                                aria-label="FX Waveform"
                                value={fxWaveform}
                                onChange={(e) => {
                                  const wf = e.target.value as Waveform1D;
                                  setFxWaveform(wf);
                                  void syncSelectedSceneBlock({ waveform: wf });
                                }}
                                className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                              >
                                <option value="sine">Sinus</option>
                                <option value="triangle">Triangle</option>
                                <option value="saw">Saw</option>
                                <option value="square">Square</option>
                                <option value="pulse">Strobe Pulse</option>
                              </select>
                            </label>

                            <svg
                              data-testid="curve-1d-svg-preview"
                              viewBox="0 0 260 64"
                              className="w-full h-16 bg-void rounded border border-steel/60"
                            >
                              <line
                                x1="8"
                                y1={curveSvg.baselineY}
                                x2="252"
                                y2={curveSvg.baselineY}
                                stroke="#2A374C"
                                strokeDasharray="3 3"
                              />
                              <path
                                d={curveSvg.pathD}
                                fill="none"
                                stroke="#FF5500"
                                strokeWidth="2.5"
                              />
                              {curveSvg.fixtureDots.map((dot) => (
                                <circle
                                  key={dot.index}
                                  cx={dot.x}
                                  cy={dot.y}
                                  r="4"
                                  fill="#2255AA"
                                  stroke="#F2F6FB"
                                  strokeWidth="1"
                                />
                              ))}
                            </svg>

                            <NumericSlider
                              layout="stacked"
                              label="Rate"
                              ariaLabel="FX Rate Cycles"
                              value={fxRateCycles}
                              defaultValue={1}
                              min={0.25}
                              max={8}
                              step={0.25}
                              unit="×"
                              precision={2}
                              onChange={(rc) => {
                                setFxTimingMode("cycles");
                                setFxRateCycles(rc);
                                void syncSelectedSceneBlock({
                                  timingMode: "cycles",
                                  rateCycles: rc,
                                });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Size"
                              ariaLabel="Curve Output Max Pct"
                              value={curveRange.maxPct}
                              defaultValue={100}
                              min={0}
                              max={100}
                              step={1}
                              unit="%"
                              precision={0}
                              onChange={(maxPct) => {
                                const { amplitude, offset } =
                                  rangePctToAmplitudeOffset(
                                    curveRange.minPct,
                                    maxPct,
                                    isBipolarAdd,
                                  );
                                setFxAmplitude(amplitude);
                                setFxOffset(offset);
                                void syncSelectedSceneBlock({
                                  amplitude,
                                  offset,
                                });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Phase"
                              ariaLabel="Curve Phase"
                              value={fxPhaseDeg}
                              defaultValue={0}
                              min={0}
                              max={360}
                              step={5}
                              unit="°"
                              precision={0}
                              onChange={(ph) => {
                                setFxPhaseDeg(ph);
                                void syncSelectedSceneBlock({ phaseDeg: ph });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Offset"
                              ariaLabel="Curve Output Min Pct"
                              value={curveRange.minPct}
                              defaultValue={0}
                              min={0}
                              max={100}
                              step={1}
                              unit="%"
                              precision={0}
                              onChange={(minPct) => {
                                const { amplitude, offset } =
                                  rangePctToAmplitudeOffset(
                                    minPct,
                                    curveRange.maxPct,
                                    isBipolarAdd,
                                  );
                                setFxAmplitude(amplitude);
                                setFxOffset(offset);
                                void syncSelectedSceneBlock({
                                  amplitude,
                                  offset,
                                });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Phasing"
                              ariaLabel="Curve Phasing"
                              value={fxPhaseSpreadDeg}
                              defaultValue={360}
                              min={0}
                              max={720}
                              step={15}
                              unit="°"
                              precision={0}
                              onChange={(deg) => {
                                setFxPhaseSpreadDeg(deg);
                                void syncSelectedSceneBlock({
                                  phaseSpreadDeg: deg,
                                });
                              }}
                            />

                            {(fxWaveform === "pulse" ||
                              fxWaveform === "square") && (
                              <NumericSlider
                                layout="stacked"
                                label="Duty"
                                ariaLabel="Curve Duty Pct"
                                value={Math.round(fxDuty * 100)}
                                defaultValue={50}
                                min={5}
                                max={95}
                                step={5}
                                unit="%"
                                precision={0}
                                onChange={(pct) => {
                                  const dt = pct / 100;
                                  setFxDuty(dt);
                                  void syncSelectedSceneBlock({ duty: dt });
                                }}
                              />
                            )}

                            <div className="grid grid-cols-2 gap-1.5">
                              <label className="flex flex-col gap-0.5">
                                <span className="text-fog">
                                  Attribute value
                                </span>
                                <select
                                  aria-label="Attribute Value Mode"
                                  value={fxOp}
                                  onChange={(e) => {
                                    const op = e.target.value as MergeOp;
                                    setFxOp(op);
                                    void syncSelectedSceneBlock({ op });
                                  }}
                                  className="bg-ink border border-steel rounded px-1.5 py-0.5 text-xs text-frost"
                                >
                                  <option value="ltp">Absolute</option>
                                  <option value="htp">HTP</option>
                                  <option value="add">Relative</option>
                                </select>
                              </label>

                              <label className="flex flex-col gap-0.5">
                                <span className="text-fog">Order</span>
                                <select
                                  aria-label="Effect Run Order"
                                  value={fxOrder}
                                  onChange={(e) => {
                                    const ord = e.target.value as OrderRuleStr;
                                    setFxOrder(ord);
                                    void syncSelectedSceneBlock({ order: ord });
                                  }}
                                  className="bg-ink border border-steel rounded px-1.5 py-0.5 text-xs text-frost"
                                >
                                  <option value="linear">1→N Forward</option>
                                  <option value="reverse">N→1 Reverse</option>
                                  <option value="center_out">Center Out</option>
                                  <option value="mirror">Mirror</option>
                                  <option value="odd_even">Odd / Even</option>
                                  <option value="blocks(2)">Blocks (2)</option>
                                </select>
                              </label>
                            </div>
                          </div>
                        )}

                        {/* LOCKED SUBMENU 6: MAPPINGS (2D GRAYSCALE / DIMMER) */}
                        {activeSubmenu === "mappings" && (
                          <div className="bg-pitch border border-steel rounded p-2 flex flex-col gap-2 font-mono text-[10px]">
                            {(() => {
                              const stops =
                                fxValueStops.length > 0 ? fxValueStops : [1, 0];
                              const safeIdx = Math.max(
                                0,
                                Math.min(
                                  selectedValueStopIdx,
                                  stops.length - 1,
                                ),
                              );
                              return (
                                <>
                                  <div className="flex h-4 w-full rounded overflow-hidden border border-steel">
                                    {Array.from({ length: 16 }).map((_, i) => {
                                      const v = sampleValueStops(
                                        stops,
                                        i / 15,
                                        fxGradient,
                                        false,
                                      );
                                      const ch = Math.round(v * 255);
                                      return (
                                        <div
                                          key={i}
                                          className="flex-1 border-r border-pitch/40 last:border-r-0"
                                          style={{
                                            backgroundColor: `rgb(${ch}, ${ch}, ${ch})`,
                                          }}
                                        />
                                      );
                                    })}
                                  </div>

                                  <div className="flex flex-wrap items-center gap-1">
                                    <span className="text-fog mr-1">
                                      Values
                                    </span>
                                    {stops.map((val, idx) => {
                                      const ch = Math.round(val * 255);
                                      return (
                                        <div
                                          key={`${idx}-${val}`}
                                          className="flex items-center"
                                        >
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setSelectedValueStopIdx(idx)
                                            }
                                            className={`px-1.5 h-5 rounded border text-[9px] font-semibold ${
                                              safeIdx === idx
                                                ? "border-ember ring-1 ring-ember"
                                                : "border-steel"
                                            }`}
                                            style={{
                                              backgroundColor: `rgb(${ch}, ${ch}, ${ch})`,
                                              color:
                                                val > 0.5
                                                  ? "#111827"
                                                  : "#F2F6FB",
                                            }}
                                          >
                                            {Math.round(val * 100)}
                                          </button>
                                          {stops.length > 2 && (
                                            <button
                                              type="button"
                                              aria-label={`Remove Value Stop ${idx + 1}`}
                                              onClick={() => {
                                                const next = stops.filter(
                                                  (_, i) => i !== idx,
                                                );
                                                setFxValueStops(next);
                                                setSelectedValueStopIdx(
                                                  Math.max(0, safeIdx - 1),
                                                );
                                                void syncSelectedSceneBlock({
                                                  valueStops: next,
                                                });
                                              }}
                                              className="ml-0.5 text-[9px] text-fog hover:text-signal"
                                            >
                                              ×
                                            </button>
                                          )}
                                        </div>
                                      );
                                    })}
                                    <button
                                      type="button"
                                      data-testid="add-value-stop-btn"
                                      aria-label="Add Value Stop"
                                      onClick={() => {
                                        const next = [...stops, 0.5];
                                        setFxValueStops(next);
                                        setSelectedValueStopIdx(
                                          next.length - 1,
                                        );
                                        void syncSelectedSceneBlock({
                                          valueStops: next,
                                        });
                                      }}
                                      className="w-5 h-5 rounded border border-steel bg-ink text-mist hover:border-ember flex items-center justify-center"
                                    >
                                      +
                                    </button>
                                  </div>

                                  <NumericSlider
                                    layout="stacked"
                                    label="Stop Level"
                                    ariaLabel="Value Stop Level"
                                    value={Math.round(stops[safeIdx] * 100)}
                                    defaultValue={100}
                                    min={0}
                                    max={100}
                                    step={1}
                                    unit="%"
                                    precision={0}
                                    onChange={(pct) => {
                                      const next = stops.map((v, i) =>
                                        i === safeIdx
                                          ? Math.max(0, Math.min(1, pct / 100))
                                          : v,
                                      );
                                      setFxValueStops(next);
                                      void syncSelectedSceneBlock({
                                        valueStops: next,
                                      });
                                    }}
                                  />
                                </>
                              );
                            })()}

                            <div className="grid grid-cols-2 gap-1.5">
                              <label className="flex flex-col gap-0.5">
                                <span className="text-fog">2D Pattern</span>
                                <select
                                  aria-label="FX Shader Kind"
                                  value={fxShader}
                                  onChange={(e) => {
                                    const sh = e.target.value as Shader2DKind;
                                    setFxShader(sh);
                                    void syncSelectedSceneBlock({ shader: sh });
                                  }}
                                  className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                                >
                                  <option value="linear_sweep">
                                    Linear Sweep
                                  </option>
                                  <option value="radial_wave">
                                    Radial Wave
                                  </option>
                                  <option value="pinwheel">Pinwheel</option>
                                  <option value="plasma">Plasma</option>
                                </select>
                              </label>

                              <label className="flex flex-col gap-0.5">
                                <span className="text-fog">Transform</span>
                                <select
                                  aria-label="Mapping Transform"
                                  value={fxTransform}
                                  onChange={(e) => {
                                    const tr = e.target.value;
                                    setFxTransform(tr);
                                    void syncSelectedSceneBlock({
                                      transform: tr,
                                    });
                                  }}
                                  className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                                >
                                  <option value="">None</option>
                                  <option value="mirror_x">Mirror X</option>
                                  <option value="mirror_y">Mirror Y</option>
                                  <option value="invert">Invert</option>
                                </select>
                              </label>
                            </div>

                            <NumericSlider
                              layout="stacked"
                              label="Rotation"
                              ariaLabel="Mapping Rotation"
                              value={fxDirectionDeg}
                              defaultValue={0}
                              min={0}
                              max={360}
                              step={5}
                              unit="°"
                              precision={0}
                              onChange={(deg) => {
                                setFxDirectionDeg(deg);
                                void syncSelectedSceneBlock({
                                  directionDeg: deg,
                                });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Width"
                              ariaLabel="Color Width"
                              value={fxColorWidth}
                              defaultValue={1}
                              min={0.1}
                              max={4}
                              step={0.05}
                              precision={2}
                              onChange={(cw) => {
                                setFxColorWidth(cw);
                                void syncSelectedSceneBlock({ colorWidth: cw });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Scale"
                              ariaLabel="Pattern Scale Slider"
                              value={patternScaleValue}
                              defaultValue={1}
                              min={0.25}
                              max={10}
                              step={0.05}
                              unit="×"
                              precision={2}
                              onChange={(ps) => {
                                const sf = patternScaleToSpatialFreq(ps);
                                setFxSpatialFreq(sf);
                                void syncSelectedSceneBlock({
                                  spatialFreq: sf,
                                });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Gradient"
                              ariaLabel="Gradient"
                              value={Math.round(fxGradient * 100)}
                              defaultValue={100}
                              min={0}
                              max={100}
                              step={1}
                              unit="%"
                              precision={0}
                              onChange={(pct) => {
                                const gr = pct / 100;
                                setFxGradient(gr);
                                void syncSelectedSceneBlock({ gradient: gr });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Rate"
                              ariaLabel="FX Rate Cycles"
                              value={fxRateCycles}
                              defaultValue={1}
                              min={0}
                              max={8}
                              step={0.25}
                              unit="×"
                              precision={2}
                              headerExtra={
                                <button
                                  type="button"
                                  data-testid="spatial-static-toggle"
                                  aria-pressed={fxRateCycles === 0}
                                  onClick={() => {
                                    const nextRate =
                                      fxRateCycles === 0
                                        ? Math.max(0.25, lastNonZeroRateRef.current || 1)
                                        : 0;
                                    if (fxRateCycles > 0) {
                                      lastNonZeroRateRef.current = fxRateCycles;
                                    }
                                    setFxTimingMode("cycles");
                                    setFxRateCycles(nextRate);
                                    void syncSelectedSceneBlock({
                                      timingMode: "cycles",
                                      rateCycles: nextRate,
                                    });
                                  }}
                                  className={`px-1.5 py-0.5 rounded border text-[9px] font-mono shrink-0 ${
                                    fxRateCycles === 0
                                      ? "bg-amber/20 border-amber text-amber"
                                      : "bg-ink border-steel text-fog hover:text-frost"
                                  }`}
                                >
                                  Static
                                </button>
                              }
                              onChange={(rc) => {
                                if (rc > 0) {
                                  lastNonZeroRateRef.current = rc;
                                }
                                setFxTimingMode("cycles");
                                setFxRateCycles(rc);
                                void syncSelectedSceneBlock({
                                  timingMode: "cycles",
                                  rateCycles: rc,
                                });
                              }}
                            />

                            <NumericSlider
                              layout="stacked"
                              label="Phase Offset"
                              ariaLabel="Spatial Phase Offset"
                              value={Math.round(fxPhaseOffset * 100)}
                              defaultValue={0}
                              min={0}
                              max={100}
                              step={1}
                              unit="%"
                              precision={0}
                              onChange={(pct) => {
                                const po = pct / 100;
                                setFxPhaseOffset(po);
                                void syncSelectedSceneBlock({
                                  phaseOffset: po,
                                });
                              }}
                            />

                            <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-steel/40">
                              <button
                                type="button"
                                data-testid="inspector-gizmo-fit-btn"
                                onClick={() => {
                                  if (!selectedScenePrimaryBlock) return;
                                  const st = useTaktStore.getState();
                                  const b = computeTargetGizmoBounds({
                                    compiledCells: st.compiledCells,
                                    patch: st.showState.patch,
                                    groups: st.showState.groups,
                                    targetGroup:
                                      selectedScene?.target_group ??
                                      selectedScenePrimaryBlock.target_group ??
                                      fxTargetGroup,
                                    fallbackFixtureIds: st.selectedFixtureIds,
                                  });
                                  setFxCenterX(b.centerX);
                                  setFxCenterY(b.centerY);
                                  setFxSpatialFreq(b.spatialFreq);
                                  void syncSelectedSceneBlock({
                                    centerX: b.centerX,
                                    centerY: b.centerY,
                                    boxHalfX: b.boxHalfX,
                                    boxHalfY: b.boxHalfY,
                                    spatialFreq: b.spatialFreq,
                                  });
                                }}
                                title="Resize and center the 2D shader gizmo around the targeted fixtures"
                                className="flex-1 py-1 rounded border border-cobalt bg-cobalt/15 hover:bg-cobalt/30 text-frost font-semibold"
                              >
                                Fit Gizmo to Targets
                              </button>
                              <button
                                type="button"
                                aria-pressed={gizmoAutoFit}
                                onClick={() => setGizmoAutoFit(!gizmoAutoFit)}
                                title="Automatically refit the 2D gizmo whenever targeted fixtures move"
                                className={`px-2 py-1 rounded border ${
                                  gizmoAutoFit
                                    ? "border-plum bg-plum/25 text-frost font-semibold"
                                    : "border-steel bg-ink text-fog hover:text-mist"
                                }`}
                              >
                                Auto
                              </button>
                            </div>
                          </div>
                        )}

                        {activeSubmenu === "scene_sequence" && (
                          <div
                            data-testid="scene-sequence-editor"
                            className="bg-pitch border border-steel rounded p-2 flex flex-col gap-2 font-mono text-[10px]"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <label className="flex items-center gap-1.5 flex-1 min-w-0">
                                <span className="text-fog shrink-0">Mode</span>
                                <select
                                  aria-label="Sequence Playback Mode"
                                  data-testid="seq-playback-mode-select"
                                  value={fxSeqPlaybackMode}
                                  onChange={(e) => {
                                    const mode = e.target
                                      .value as SequencePlaybackMode;
                                    void commitSequenceSteps(fxSeqSteps, mode);
                                  }}
                                  className="flex-1 min-w-0 bg-ink border border-steel rounded px-1.5 py-0.5 text-xs text-frost"
                                >
                                  <option value="loop">Loop</option>
                                  <option value="one_shot">One-Shot</option>
                                  <option value="bounce">Bounce</option>
                                </select>
                              </label>
                              <span
                                data-testid="seq-total-duration"
                                className="text-fog shrink-0"
                              >
                                {computeSceneSequenceDurationSec(
                                  fxSeqSteps,
                                  liveBpm || showState.bpm || 120,
                                ).toFixed(2)}
                                s
                              </span>
                            </div>

                            {seqDropNotice && (
                              <div
                                data-testid="seq-drop-notice"
                                className="px-2 py-1 rounded bg-signal/15 border border-signal/60 text-signal text-[10px]"
                              >
                                {seqDropNotice}
                              </div>
                            )}

                            {/* Drag-and-Drop Dropzone */}
                            <div
                              data-scene-sequence-dropzone="true"
                              data-target-block-id={
                                selectedScenePrimaryBlock?.id ?? ""
                              }
                              data-testid="scene-sequence-dropzone"
                              onDragOver={(e) => {
                                e.preventDefault();
                              }}
                              onDrop={(e) => {
                                e.preventDefault();
                                const sid =
                                  e.dataTransfer.getData("text/takt-scene") ||
                                  e.dataTransfer.getData("text/plain");
                                if (sid) {
                                  void addSceneStepToSequence(
                                    sid,
                                    selectedScenePrimaryBlock?.id,
                                  );
                                }
                              }}
                              className={`rounded border border-dashed px-2 py-2 text-center transition-colors ${
                                draggingSceneId
                                  ? "border-ember bg-ember/15 text-frost"
                                  : "border-steel/80 bg-ink/60 text-fog"
                              }`}
                            >
                              {draggingSceneId
                                ? "Drop scene here to append step"
                                : "Drag scenes from the Scene List here"}
                            </div>

                            {/* Quick Add Scene Dropdown */}
                            <div className="flex items-center gap-1">
                              <select
                                aria-label="Add Scene to Sequence"
                                data-testid="seq-add-scene-select"
                                value={seqAddSceneId}
                                onChange={(e) =>
                                  setSeqAddSceneId(e.target.value)
                                }
                                className="flex-1 min-w-0 bg-ink border border-steel rounded px-1.5 py-0.5 text-xs text-frost"
                              >
                                <option value="">Select scene to add…</option>
                                {showState.scenes
                                  .filter(
                                    (s) =>
                                      !s.timeline_ref &&
                                      s.id !== selectedScene?.id,
                                  )
                                  .map((s) => (
                                    <option key={s.id} value={s.id}>
                                      {s.name}
                                    </option>
                                  ))}
                              </select>
                              <button
                                type="button"
                                data-testid="seq-add-scene-btn"
                                disabled={!seqAddSceneId}
                                onClick={() => {
                                  if (!seqAddSceneId) return;
                                  void addSceneStepToSequence(
                                    seqAddSceneId,
                                    selectedScenePrimaryBlock?.id,
                                  );
                                }}
                                className="px-2 py-0.5 rounded bg-ink border border-steel hover:border-ember text-frost disabled:opacity-40"
                              >
                                + Add
                              </button>
                            </div>

                            {/* Ordered Step List */}
                            <div className="flex flex-col gap-1">
                              {fxSeqSteps.length === 0 ? (
                                <div className="text-fog text-center py-2">
                                  No steps yet. Drag a scene above or use + Add.
                                </div>
                              ) : (
                                fxSeqSteps.map((step, stepIdx) => {
                                  const refScene = showState.scenes.find(
                                    (s) => s.id === step.scene_id,
                                  );
                                  const swatchColors = refScene
                                    ? getScenePaletteColors(refScene)
                                    : null;
                                  const swatchHex = swatchColors
                                    ? swatchColors[0]
                                    : "#FF5500";
                                  return (
                                    <div
                                      key={`${step.scene_id}-${stepIdx}`}
                                      data-testid={`seq-step-row-${stepIdx}`}
                                      data-scene-sequence-dropzone="true"
                                      data-target-block-id={
                                        selectedScenePrimaryBlock?.id ?? ""
                                      }
                                      data-insert-index={stepIdx}
                                      className="bg-ink border border-steel/80 rounded px-1.5 py-1 flex flex-col gap-1"
                                    >
                                      <div className="flex items-center justify-between gap-1">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                          <span className="text-fog shrink-0">
                                            #{stepIdx + 1}
                                          </span>
                                          <span
                                            className="w-2.5 h-2.5 rounded-sm shrink-0 border border-frost/30"
                                            style={{ backgroundColor: swatchHex }}
                                          />
                                          <span className="text-frost truncate font-semibold">
                                            {refScene?.name ?? step.scene_id}
                                          </span>
                                        </div>
                                        <div className="flex items-center gap-0.5 shrink-0">
                                          <button
                                            type="button"
                                            aria-label={`Move step ${stepIdx + 1} up`}
                                            data-testid={`seq-step-up-${stepIdx}`}
                                            disabled={stepIdx === 0}
                                            onClick={() => {
                                              if (stepIdx === 0) return;
                                              const next = [...fxSeqSteps];
                                              const [item] = next.splice(
                                                stepIdx,
                                                1,
                                              );
                                              next.splice(stepIdx - 1, 0, item);
                                              void commitSequenceSteps(next);
                                            }}
                                            className="p-0.5 rounded text-fog hover:text-frost disabled:opacity-30"
                                          >
                                            <ArrowUp className="w-3 h-3" />
                                          </button>
                                          <button
                                            type="button"
                                            aria-label={`Move step ${stepIdx + 1} down`}
                                            data-testid={`seq-step-down-${stepIdx}`}
                                            disabled={
                                              stepIdx === fxSeqSteps.length - 1
                                            }
                                            onClick={() => {
                                              if (
                                                stepIdx ===
                                                fxSeqSteps.length - 1
                                              )
                                                return;
                                              const next = [...fxSeqSteps];
                                              const [item] = next.splice(
                                                stepIdx,
                                                1,
                                              );
                                              next.splice(stepIdx + 1, 0, item);
                                              void commitSequenceSteps(next);
                                            }}
                                            className="p-0.5 rounded text-fog hover:text-frost disabled:opacity-30"
                                          >
                                            <ArrowDown className="w-3 h-3" />
                                          </button>
                                          <button
                                            type="button"
                                            aria-label={`Remove step ${stepIdx + 1}`}
                                            data-testid={`seq-step-remove-${stepIdx}`}
                                            onClick={() => {
                                              const next = fxSeqSteps.filter(
                                                (_, i) => i !== stepIdx,
                                              );
                                              void commitSequenceSteps(next);
                                            }}
                                            className="p-0.5 rounded text-signal/80 hover:text-signal"
                                          >
                                            <Trash2 className="w-3 h-3" />
                                          </button>
                                        </div>
                                      </div>

                                      <div className="flex items-center gap-1.5">
                                        <label className="flex items-center gap-1">
                                          <span className="text-fog">Dur</span>
                                          <input
                                            type="number"
                                            min={
                                              step.duration_unit === "beats"
                                                ? 1
                                                : 0.05
                                            }
                                            step={
                                              step.duration_unit === "beats"
                                                ? 1
                                                : 0.25
                                            }
                                            aria-label={`Step ${stepIdx + 1} duration`}
                                            data-testid={`seq-step-duration-${stepIdx}`}
                                            value={
                                              step.duration_unit === "beats"
                                                ? Math.max(
                                                    1,
                                                    Math.round(
                                                      step.duration_value,
                                                    ),
                                                  )
                                                : step.duration_value
                                            }
                                            onChange={(e) => {
                                              const parsed = Number(
                                                e.target.value,
                                              );
                                              const v =
                                                step.duration_unit === "beats"
                                                  ? Math.max(
                                                      1,
                                                      Math.round(parsed || 1),
                                                    )
                                                  : Math.max(
                                                      0.05,
                                                      parsed || 0.05,
                                                    );
                                              const next = fxSeqSteps.map(
                                                (st, i) =>
                                                  i === stepIdx
                                                    ? {
                                                        ...st,
                                                        duration_value: v,
                                                      }
                                                    : st,
                                              );
                                              void commitSequenceSteps(next);
                                            }}
                                            className="w-12 bg-pitch border border-steel rounded px-1 py-0.5 text-[10px] text-frost"
                                          />
                                        </label>
                                        <button
                                          type="button"
                                          data-testid={`seq-step-unit-${stepIdx}`}
                                          onClick={() => {
                                            const nextUnit: DurationUnit =
                                              step.duration_unit === "beats"
                                                ? "seconds"
                                                : "beats";
                                            const next = fxSeqSteps.map(
                                              (st, i) =>
                                                i === stepIdx
                                                  ? {
                                                      ...st,
                                                      duration_unit: nextUnit,
                                                      duration_value:
                                                        nextUnit === "beats"
                                                          ? Math.max(
                                                              1,
                                                              Math.round(
                                                                st.duration_value,
                                                              ),
                                                            )
                                                          : st.duration_value,
                                                    }
                                                  : st,
                                            );
                                            void commitSequenceSteps(next);
                                          }}
                                          className="px-1.5 py-0.5 rounded bg-pitch border border-steel hover:border-ember text-[9px] text-mist"
                                        >
                                          {step.duration_unit === "beats"
                                            ? "beats"
                                            : "sec"}
                                        </button>
                                        <label className="flex items-center gap-1 ml-auto">
                                          <span className="text-fog">Fade</span>
                                          <input
                                            type="number"
                                            min={0}
                                            step={0.1}
                                            aria-label={`Step ${stepIdx + 1} crossfade seconds`}
                                            data-testid={`seq-step-fade-${stepIdx}`}
                                            value={step.fade_sec}
                                            onChange={(e) => {
                                              const v = Math.max(
                                                0,
                                                Number(e.target.value) || 0,
                                              );
                                              const next = fxSeqSteps.map(
                                                (st, i) =>
                                                  i === stepIdx
                                                    ? { ...st, fade_sec: v }
                                                    : st,
                                              );
                                              void commitSequenceSteps(next);
                                            }}
                                            className="w-11 bg-pitch border border-steel rounded px-1 py-0.5 text-[10px] text-frost"
                                          />
                                          <span className="text-fog">s</span>
                                        </label>
                                      </div>
                                    </div>
                                  );
                                })
                              )}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}

                {/* RAIL TAB 2: SCENE PROPERTIES */}
                {selectedScene && inspectorRailTab === "properties" && (
                  <div className="bg-pitch border border-steel rounded p-2.5 flex flex-col gap-2 font-mono text-[10px]">
                    <label className="flex flex-col gap-0.5">
                      <span className="text-fog">Scene Name</span>
                      <input
                        aria-label="Inspector Scene Name"
                        type="text"
                        value={selectedScene.name}
                        onChange={(e) =>
                          void upsertScene({
                            ...selectedScene,
                            name: e.target.value,
                          })
                        }
                        className="bg-ink border border-steel rounded px-2 py-1 text-xs font-sans text-frost"
                      />
                    </label>

                    <div className="grid grid-cols-2 gap-1.5">
                      <label className="flex flex-col gap-0.5">
                        <span className="text-fog">Bank</span>
                        <select
                          aria-label="Inspector Scene Bank"
                          value={selectedScene.bank ?? allBanks[0]}
                          onChange={(e) =>
                            void upsertScene({
                              ...selectedScene,
                              bank: e.target.value || allBanks[0],
                            })
                          }
                          className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                        >
                          {allBanks.map((b) => (
                            <option key={b} value={b}>
                              {b}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="flex flex-col gap-0.5">
                        <span className="text-fog">Fade</span>
                        <select
                          aria-label="Inspector Fade Sec"
                          value={String(selectedScene.fade_in_sec)}
                          onChange={(e) => {
                            const sec = Number(e.target.value) || 0;
                            void upsertScene({
                              ...selectedScene,
                              fade_in_sec: sec,
                              fade_out_sec: sec,
                            });
                          }}
                          className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                        >
                          <option value="0">0s Snap</option>
                          <option value="0.5">0.5s</option>
                          <option value="1">1s</option>
                          <option value="2">2s</option>
                        </select>
                      </label>
                    </div>

                    {(() => {
                      const curDurVal = selectedScene.duration_value ?? 4;
                      const curDurUnit: DurationUnit =
                        selectedScene.duration_unit ?? "beats";
                      const applyDuration = (
                        val?: number,
                        unit?: DurationUnit,
                      ) => {
                        const latestScene =
                          useTaktStore
                            .getState()
                            .showState.scenes.find(
                              (s) => s.id === selectedScene.id,
                            ) ?? selectedScene;
                        const nextUnit: DurationUnit =
                          unit ?? latestScene.duration_unit ?? "beats";
                        const rawNextVal =
                          val ?? latestScene.duration_value ?? 4;
                        const nextVal =
                          nextUnit === "beats"
                            ? Math.max(1, Math.round(rawNextVal))
                            : Math.max(0.1, rawNextVal);
                        void upsertScene({
                          ...latestScene,
                          duration_value: nextVal,
                          duration_unit: nextUnit,
                        });
                        const blkRefId = latestScene.block_refs[0];
                        const latestBlock = blkRefId
                          ? useTaktStore
                              .getState()
                              .showState.fx_library.find(
                                (b) => b.id === blkRefId,
                              )
                          : selectedScenePrimaryBlock;
                        if (latestBlock) {
                          void upsertFxBlock({
                            ...latestBlock,
                            duration_beats:
                              nextUnit === "beats"
                                ? nextVal
                                : latestBlock.duration_beats,
                            duration_sec:
                              nextUnit === "seconds" ? nextVal : null,
                          });
                        }
                      };
                      if (selectedScene.timeline_ref) {
                        const linkedTl = showState.timelines.find(
                          (t) => t.id === selectedScene.timeline_ref,
                        );
                        const dynLen = linkedTl
                          ? linkedTl.tracks.reduce(
                              (acc, tr) =>
                                Math.max(
                                  acc,
                                  ...tr.clips.map((c) => c.start_sec + c.duration_sec),
                                ),
                              0,
                            )
                          : 0;
                        return (
                          <div className="flex flex-col gap-1">
                            <span className="text-fog">Duration</span>
                            <div
                              data-testid="timeline-dynamic-duration-readout"
                              className="bg-ink border border-steel/70 rounded px-2 py-1 text-xs text-mist"
                              title="Timeline length is calculated dynamically from the end of its last clip"
                            >
                              Dynamic ({dynLen.toFixed(1)}s)
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div className="flex flex-col gap-1">
                          <span className="text-fog">Duration</span>
                          <div className="flex items-center gap-1">
                            <input
                              aria-label="Scene Duration Value"
                              data-testid="scene-duration-input"
                              type="number"
                              min={curDurUnit === "beats" ? 1 : 0.1}
                              step={curDurUnit === "beats" ? 1 : 0.1}
                              value={
                                curDurUnit === "beats"
                                  ? Math.max(1, Math.round(curDurVal))
                                  : curDurVal
                              }
                              onChange={(e) => {
                                const parsed = Number(e.target.value);
                                if (!Number.isNaN(parsed) && parsed > 0) {
                                  applyDuration(parsed, undefined);
                                }
                              }}
                              className="w-16 bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                            />
                            <button
                              type="button"
                              data-testid="scene-duration-unit-beats"
                              aria-pressed={curDurUnit === "beats"}
                              onClick={() => applyDuration(undefined, "beats")}
                              className={`px-2 py-1 rounded border text-[10px] font-semibold ${
                                curDurUnit === "beats"
                                  ? "bg-cobalt text-frost border-cobalt"
                                  : "bg-ink border-steel text-fog hover:text-mist"
                              }`}
                            >
                              Beats
                            </button>
                            <button
                              type="button"
                              data-testid="scene-duration-unit-seconds"
                              aria-pressed={curDurUnit === "seconds"}
                              onClick={() =>
                                applyDuration(undefined, "seconds")
                              }
                              className={`px-2 py-1 rounded border text-[10px] font-semibold ${
                                curDurUnit === "seconds"
                                  ? "bg-cobalt text-frost border-cobalt"
                                  : "bg-ink border-steel text-fog hover:text-mist"
                              }`}
                            >
                              Sec
                            </button>
                            <button
                              type="button"
                              data-testid="scene-duration-reset"
                              aria-label="Reset Scene Duration"
                              title="Reset to 4 Beats"
                              onClick={() => applyDuration(4, "beats")}
                              className="p-1 rounded border border-steel bg-ink text-fog hover:text-amber-400"
                            >
                              <RotateCcw className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })()}

                    <div className="flex flex-col gap-0.5 justify-end">
                      <button
                        type="button"
                        data-testid={`toggle-flash-${selectedScene.id}`}
                        aria-pressed={Boolean(flashSceneIds[selectedScene.id])}
                        onClick={() => toggleSceneFlashMode(selectedScene.id)}
                        className={`px-2 py-1 rounded border text-xs font-semibold flex items-center justify-center gap-1 ${
                          flashSceneIds[selectedScene.id]
                            ? "bg-amber-500/25 border-amber-500 text-amber-300"
                            : "bg-ink border-steel text-fog hover:text-mist"
                        }`}
                      >
                        <Zap className="w-3 h-3" />
                        <span>Flash Mode</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* RAIL TAB 3: SETTINGS */}
                {selectedScene && inspectorRailTab === "settings" && (
                  <div className="bg-pitch border border-steel rounded p-2.5 flex flex-col gap-2 font-mono text-[10px]">
                    <div className="flex items-center justify-between text-fog">
                      <span>Key Trigger</span>
                      <span className="text-frost">
                        {keyBindings[selectedScene.id] ?? "None"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-fog">
                      <span>MIDI Trigger</span>
                      <span className="text-frost">
                        {midiBindings[selectedScene.id] ?? "None"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 pt-2 border-t border-steel/60">
                      <button
                        type="button"
                        onClick={() => void duplicateScene(selectedScene.id)}
                        className="flex-1 flex items-center justify-center gap-1 py-1 rounded bg-ink border border-steel text-mist hover:border-cobalt"
                      >
                        <Copy className="w-3 h-3" />
                        <span>Duplicate</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteScene(selectedScene.id)}
                        className="flex-1 flex items-center justify-center gap-1 py-1 rounded bg-ink border border-steel text-signal hover:border-signal"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>Delete</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Daslight Bottom FX Rack Footer (+, Delete, Move Down, Move Up) */}
              {selectedScene && inspectorRailTab === "fx" && !fxPickerMode && (
                <div className="shrink-0 bg-slate border-t border-steel px-2 py-1 flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setFxAppendMode(true);
                      setFxPickerMode(true);
                    }}
                    title="Add FX Layer to Scene"
                    className="p-1 rounded text-fog hover:text-frost hover:bg-ink"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeActiveFxElement()}
                    title="Remove Active FX Layer"
                    className="p-1 rounded text-fog hover:text-signal hover:bg-ink"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void moveActiveFxElement(1)}
                    title="Move FX Down"
                    className="p-1 rounded text-fog hover:text-frost hover:bg-ink"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void moveActiveFxElement(-1)}
                    title="Move FX Up"
                    className="p-1 rounded text-fog hover:text-frost hover:bg-ink"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* Far-Right Vertical Icon Rail (Daslight 5 style) */}
            <div className="w-8 shrink-0 bg-pitch border-l border-steel flex flex-col items-center py-1.5 gap-2">
              <button
                type="button"
                onClick={() => setInspectorRailTab("fx")}
                title="FX Rack"
                className={`p-1.5 rounded transition-colors ${
                  inspectorRailTab === "fx"
                    ? "bg-ink text-frost border border-steel"
                    : "text-fog hover:text-mist"
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setInspectorRailTab("properties")}
                title="Scene Properties"
                className={`p-1.5 rounded transition-colors ${
                  inspectorRailTab === "properties"
                    ? "bg-ink text-frost border border-steel"
                    : "text-fog hover:text-mist"
                }`}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setInspectorRailTab("settings")}
                title="Scene Settings & Triggers"
                className={`p-1.5 rounded transition-colors ${
                  inspectorRailTab === "settings"
                    ? "bg-ink text-frost border border-steel"
                    : "text-fog hover:text-mist"
                }`}
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Backward-Compatible Screen-Reader-Only Test Bridge for Slice 5 & Inspector Fields */}
            <div className="sr-only">
              <input
                aria-label="FX Block Name"
                type="text"
                value={fxName}
                onChange={(e) => setFxName(e.target.value)}
              />
              <select
                aria-label="FX Block Target Group"
                value={fxTargetGroup}
                onChange={(e) => setFxTargetGroup(e.target.value)}
              >
                {targetOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <input
                aria-label="FX Block Duration Beats"
                type="number"
                value={fxDurationBeats}
                onChange={(e) =>
                  setFxDurationBeats(Number(e.target.value) || 4)
                }
              />
              <select
                aria-label="FX Generator Kind"
                value={fxKind}
                onChange={(e) => setFxKind(e.target.value as GeneratorKind)}
              >
                <option value="curve_1d">curve_1d</option>
                <option value="step_chase">step_chase</option>
                <option value="spatial_shader_2d">spatial_shader_2d</option>
                <option value="static_trait">static_trait</option>
              </select>
              <select
                aria-label="FX Merge Op"
                value={fxOp}
                onChange={(e) => setFxOp(e.target.value as MergeOp)}
              >
                <option value="htp">htp</option>
                <option value="ltp">ltp</option>
                <option value="add">add</option>
                <option value="scale">scale</option>
              </select>
              <button type="button" onClick={() => void handleSaveFxBlock()}>
                Save FX Block
              </button>

              {showState.fx_library.map((blk) => (
                <div key={blk.id}>{blk.name}</div>
              ))}

              <input
                aria-label="Scene Name"
                type="text"
                value={sceneName}
                onChange={(e) => setSceneName(e.target.value)}
              />
              <input
                aria-label="Scene Bank"
                type="text"
                value={sceneBank}
                onChange={(e) => setSceneBank(e.target.value)}
              />
              <input
                aria-label="Scene Priority"
                type="number"
                value={scenePriority}
                onChange={(e) => setScenePriority(Number(e.target.value) || 0)}
              />
              <input
                aria-label="Scene Fade In"
                type="number"
                value={sceneFadeIn}
                onChange={(e) => setSceneFadeIn(Number(e.target.value) || 0)}
              />
              <input
                aria-label="Scene Fade Out"
                type="number"
                value={sceneFadeOut}
                onChange={(e) => setSceneFadeOut(Number(e.target.value) || 0)}
              />
              <select
                aria-label="Scene Block Ref"
                value={effectiveBlockRef}
                onChange={(e) => setSceneBlockRef(e.target.value)}
              >
                {showState.fx_library.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.id})
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void handleSaveScene()}>
                Save Scene
              </button>
              {selectedScene && inspectorRailTab !== "properties" && (
                <>
                  <select
                    aria-label="Inspector Fade Sec"
                    value={String(selectedScene.fade_in_sec)}
                    onChange={(e) => {
                      const sec = Number(e.target.value) || 0;
                      void upsertScene({
                        ...selectedScene,
                        fade_in_sec: sec,
                        fade_out_sec: sec,
                      });
                    }}
                  >
                    <option value="0">0s</option>
                    <option value="0.5">0.5s</option>
                    <option value="1">1s</option>
                    <option value="2">2s</option>
                  </select>
                  <button
                    type="button"
                    data-testid={`toggle-flash-${selectedScene.id}`}
                    onClick={() => toggleSceneFlashMode(selectedScene.id)}
                  >
                    Flash
                  </button>
                </>
              )}
            </div>
          </section>
          </>
        )}
      </div>

      {/* Right-Click Context Menu: Bank Options (Stackable / Rename / Delete) */}
      {bankContextMenu && (
        <div
          data-testid={`bank-context-menu-${bankContextMenu.bank}`}
          onClick={(e) => e.stopPropagation()}
          style={{ left: bankContextMenu.x, top: bankContextMenu.y }}
          className="fixed z-50 bg-slate-dark border border-steel rounded shadow-2xl py-1 min-w-[220px] font-mono text-xs"
        >
          <button
            type="button"
            data-testid={`bank-ctx-stackable-${bankContextMenu.bank}`}
            onClick={() => {
              toggleBankStackable(bankContextMenu.bank);
              setBankContextMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center justify-between gap-2 text-mist hover:bg-ink"
          >
            <span>Allow Multiple / Stackable</span>
            <span
              className={`px-1.5 py-0.2 rounded text-[10px] ${
                stackableBanks[bankContextMenu.bank]
                  ? "bg-plum text-frost"
                  : "bg-pitch text-fog"
              }`}
            >
              {stackableBanks[bankContextMenu.bank] ? "ON" : "OFF"}
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setRenamingBank(bankContextMenu.bank);
              setRenameBankValue(bankContextMenu.bank);
              setBankContextMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left text-mist hover:bg-ink"
          >
            Rename Bank
          </button>
          <div className="px-3 py-1.5 border-t border-steel/50 flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-fog">Bank Color</span>
              {bankColors[bankContextMenu.bank] && (
                <button
                  type="button"
                  data-testid={`bank-color-reset-${bankContextMenu.bank}`}
                  onClick={() => {
                    setBankColor(bankContextMenu.bank, null);
                  }}
                  className="text-[10px] text-fog hover:text-frost underline"
                >
                  Reset
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {BANK_COLOR_PRESETS.map((hex) => {
                const isSelected =
                  bankColors[bankContextMenu.bank]?.toLowerCase() ===
                  hex.toLowerCase();
                return (
                  <button
                    key={hex}
                    type="button"
                    data-testid={`bank-color-swatch-${bankContextMenu.bank}-${hex}`}
                    onClick={() => {
                      setBankColor(bankContextMenu.bank, hex);
                      setBankContextMenu(null);
                    }}
                    title={`Set bank color ${hex}`}
                    style={{ backgroundColor: hex }}
                    className={`w-4 h-4 rounded-sm border transition-transform hover:scale-110 ${
                      isSelected
                        ? "border-frost ring-1 ring-frost"
                        : "border-pitch"
                    }`}
                  />
                );
              })}
              <label
                title="Custom Bank Color"
                className="w-4 h-4 rounded-sm border border-steel bg-ink flex items-center justify-center cursor-pointer overflow-hidden hover:border-frost"
              >
                <input
                  type="color"
                  aria-label={`Custom color for ${bankContextMenu.bank}`}
                  data-testid={`bank-color-picker-${bankContextMenu.bank}`}
                  value={bankColors[bankContextMenu.bank] ?? "#FBBF24"}
                  onChange={(e) => {
                    setBankColor(bankContextMenu.bank, e.target.value);
                  }}
                  className="w-6 h-6 cursor-pointer border-0 bg-transparent p-0"
                />
              </label>
            </div>
          </div>
          <button
            type="button"
            data-testid={`delete-bank-${bankContextMenu.bank}`}
            onClick={() => {
              void deleteSceneBank(bankContextMenu.bank);
              setBankContextMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left text-signal hover:bg-ink border-t border-steel/50"
          >
            Delete Bank
          </button>
        </div>
      )}

      {/* Right-Click Context Menu: Scene Options */}
      {sceneContextMenu && (
        <div
          data-testid={`scene-context-menu-${sceneContextMenu.sceneId}`}
          onClick={(e) => e.stopPropagation()}
          style={{ left: sceneContextMenu.x, top: sceneContextMenu.y }}
          className="fixed z-50 bg-slate-dark border border-steel rounded shadow-2xl py-1 min-w-[180px] font-mono text-xs"
        >
          <button
            type="button"
            onClick={() => {
              const target = showState.scenes.find(
                (s) => s.id === sceneContextMenu.sceneId,
              );
              if (target) {
                setRenamingSceneId(target.id);
                setRenameSceneValue(target.name);
              }
              setSceneContextMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left text-mist hover:bg-ink"
          >
            Rename Scene
          </button>
          <button
            type="button"
            onClick={() => {
              toggleSceneFlashMode(sceneContextMenu.sceneId);
              setSceneContextMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center justify-between text-mist hover:bg-ink"
          >
            <span>Momentary Flash</span>
            <span className="text-[10px] text-amber-400">
              {flashSceneIds[sceneContextMenu.sceneId] ? "ON" : "OFF"}
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              void duplicateScene(sceneContextMenu.sceneId);
              setSceneContextMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left text-mist hover:bg-ink"
          >
            Duplicate Scene
          </button>
          <button
            type="button"
            onClick={() => {
              void deleteScene(sceneContextMenu.sceneId);
              setSceneContextMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left text-signal hover:bg-ink border-t border-steel/50"
          >
            Delete Scene
          </button>
        </div>
      )}

      {/* Standalone Cell Preview (when not in StudioWorkspace) */}
      {!daslightUpper && <SceneLiveCellPreview />}
      <ColorPaletteBuilderModal
        open={paletteBuilderOpen}
        initialPaletteId={fxPaletteRef}
        onClose={() => setPaletteBuilderOpen(false)}
        onSaved={(pal) => {
          const stops = [...(pal.colors ?? [pal.hex_start, pal.hex_end])];
          setFxPaletteRef(pal.id);
          setFxInlineColors(stops);
          void syncSelectedSceneBlock({
            paletteRef: pal.id,
            inlineColors: stops,
          });
        }}
      />
    </div>
  );
}
