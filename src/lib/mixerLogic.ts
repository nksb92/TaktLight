import type { ExpandedChannel, FixtureDetail } from "./oflBuilder";
import {
  type CompiledCell,
  computeOrderU,
  expandTargetRange,
  type FixtureGroupDef,
  type FixtureInstance,
  type OrderRuleStr,
  type ShowStateDto,
  transformCellUv,
  type WhiteMode,
} from "./patchLogic";
import type { UniverseConfig } from "../store/useTaktStore";

export type Waveform1D = "sine" | "triangle" | "saw" | "square" | "pulse";
export type Shader2DKind =
  | "linear_sweep"
  | "radial_wave"
  | "pinwheel"
  | "plasma";
export type DurationUnit = "beats" | "seconds";
export type FxKindTag = "color_fx" | "value_fx" | "curve_fx";
export type SequencePlaybackMode = "loop" | "one_shot" | "bounce";

export interface SceneSequenceStepDef {
  scene_id: string;
  duration_value: number;
  duration_unit: DurationUnit;
  fade_sec: number;
}

export type FxElementDef =
  | {
      kind: "static_trait";
      trait: string;
      op: MergeOp;
      palette_ref: string | null;
      value_start: number | null;
      value_end: number | null;
      hex_start?: string | null;
      hex_end?: string | null;
      order: OrderRuleStr | null;
    }
  | {
      kind: "curve_1d";
      trait: string;
      op: MergeOp;
      waveform: Waveform1D;
      amplitude: number;
      offset: number;
      rate_beats: number | null;
      speed_hz: number | null;
      rate_cycles?: number | null;
      phase_deg?: number;
      phase_spread_deg: number;
      duty: number | null;
      grayscale?: boolean;
      color_width?: number;
      gradient?: number;
      angle_deg?: number;
      fx_kind_tag?: FxKindTag | null;
      inline_colors?: string[];
      value_stops?: number[];
      palette_ref: string | null;
      order: OrderRuleStr | null;
    }
  | {
      kind: "step_chase";
      trait: string;
      op: MergeOp;
      step_beats: number | null;
      speed_hz: number | null;
      rate_cycles?: number | null;
      one_way?: boolean;
      pixels_on?: number | null;
      active_ratio: number | null;
      fade: number;
      amplitude: number;
      palette_ref: string | null;
      order: OrderRuleStr | null;
    }
  | {
      kind: "spatial_shader_2d";
      trait: string;
      op: MergeOp;
      shader: Shader2DKind;
      palette_ref: string | null;
      rate_beats: number | null;
      speed_hz: number | null;
      rate_cycles?: number | null;
      phase_offset?: number | null;
      spatial_freq: number;
      color_width?: number;
      gradient?: number;
      grayscale?: boolean;
      transform?: string | null;
      inline_colors?: string[];
      value_stops?: number[];
      direction_deg: number;
      center_x: number;
      center_y: number;
      box_half_x?: number | null;
      box_half_y?: number | null;
    }
  | {
      kind: "scene_sequence";
      playback_mode: SequencePlaybackMode;
      steps: SceneSequenceStepDef[];
    };

export function computeSceneSequenceDurationSec(
  steps: SceneSequenceStepDef[],
  bpm: number,
): number {
  const safeBpm = Math.max(1, Number.isFinite(bpm) ? bpm : 120);
  const secPerBeat = 60 / safeBpm;
  let total = 0;
  for (const st of steps) {
    const val = Math.max(0.05, Number.isFinite(st.duration_value) ? st.duration_value : 0.05);
    total += st.duration_unit === "seconds" ? val : val * secPerBeat;
  }
  return total;
}

export interface ActiveSequenceStepInfo {
  activeIndex: number;
  prevIndex: number | null;
  stepLocalSec: number;
  stepDurationSec: number;
  fadeAlpha: number;
}

export function getActiveSequenceStepAt(
  steps: SceneSequenceStepDef[],
  playbackMode: SequencePlaybackMode,
  tSec: number,
  bpm: number,
): ActiveSequenceStepInfo | null {
  const n = steps.length;
  if (n === 0) return null;
  const safeBpm = Math.max(1, Number.isFinite(bpm) ? bpm : 120);
  const secPerBeat = 60 / safeBpm;
  const stepDurs = steps.map((st) => {
    const val = Math.max(0.05, Number.isFinite(st.duration_value) ? st.duration_value : 0.05);
    return st.duration_unit === "seconds" ? val : val * secPerBeat;
  });
  const totalLinearDur = stepDurs.reduce((a, b) => a + b, 0);
  if (totalLinearDur <= 1e-9) return null;

  const tClamped = Math.max(0, Number.isFinite(tSec) ? tSec : 0);
  let activeIndex = 0;
  let prevIndex: number | null = null;
  let stepLocalSec = 0;

  if (playbackMode === "loop") {
    const tMod = remEuclid(tClamped, totalLinearDur);
    let acc = 0;
    activeIndex = n - 1;
    for (let i = 0; i < n; i++) {
      if (tMod < acc + stepDurs[i] || i === n - 1) {
        activeIndex = i;
        stepLocalSec = Math.max(0, tMod - acc);
        break;
      }
      acc += stepDurs[i];
    }
    if (n > 1 && (activeIndex > 0 || tClamped >= stepDurs[0])) {
      prevIndex = (activeIndex + n - 1) % n;
    }
  } else if (playbackMode === "one_shot") {
    if (tClamped >= totalLinearDur) {
      activeIndex = n - 1;
      stepLocalSec = stepDurs[n - 1];
      prevIndex = null;
    } else {
      let acc = 0;
      activeIndex = n - 1;
      for (let i = 0; i < n; i++) {
        if (tClamped < acc + stepDurs[i] || i === n - 1) {
          activeIndex = i;
          stepLocalSec = Math.max(0, tClamped - acc);
          break;
        }
        acc += stepDurs[i];
      }
      if (activeIndex > 0) {
        prevIndex = activeIndex - 1;
      }
    }
  } else {
    // bounce
    if (n === 1) {
      activeIndex = 0;
      stepLocalSec = remEuclid(tClamped, stepDurs[0]);
      prevIndex = null;
    } else {
      const order: number[] = [];
      for (let i = 0; i < n; i++) order.push(i);
      for (let i = n - 2; i >= 1; i--) order.push(i);
      const cycleDur = order.reduce((sum, idx) => sum + stepDurs[idx], 0);
      const tMod = remEuclid(tClamped, cycleDur);
      let acc = 0;
      let foundPos = order.length - 1;
      for (let pos = 0; pos < order.length; pos++) {
        const dur = stepDurs[order[pos]];
        if (tMod < acc + dur || pos === order.length - 1) {
          foundPos = pos;
          stepLocalSec = Math.max(0, tMod - acc);
          break;
        }
        acc += dur;
      }
      activeIndex = order[foundPos];
      if (foundPos > 0 || tClamped >= stepDurs[order[0]]) {
        prevIndex = order[(foundPos + order.length - 1) % order.length];
      }
    }
  }

  const stepDurationSec = stepDurs[activeIndex];
  const fadeSec = Math.min(
    stepDurationSec,
    Math.max(0, steps[activeIndex].fade_sec || 0),
  );
  const fadeAlpha =
    fadeSec > 1e-6 &&
    stepLocalSec < fadeSec &&
    prevIndex !== null &&
    prevIndex !== activeIndex
      ? clamp01(stepLocalSec / fadeSec)
      : 1;

  return {
    activeIndex,
    prevIndex,
    stepLocalSec,
    stepDurationSec,
    fadeAlpha,
  };
}

export interface FxBlockDef {
  id: string;
  name: string;
  target_group: string | null;
  duration_beats: number;
  duration_sec?: number | null;
  loop_block: boolean;
  elements: FxElementDef[];
}

export interface SceneDef {
  id: string;
  name: string;
  bank: string | null;
  target_group: string | null;
  priority: number;
  fade_in_sec: number;
  fade_out_sec: number;
  duration_value?: number;
  duration_unit?: DurationUnit;
  block_refs: string[];
  timeline_ref?: string | null;
}

export interface BeatClockAnchor {
  bpm: number;
  t_anchor_sec: number;
  beat_anchor: number;
}

export interface ActiveSceneInstance {
  scene_id: string;
  bank: string | null;
  trigger_t_sec: number;
  trigger_beat: number;
  trigger_order: number;
  fade_in_sec: number;
  fade_out_sec: number;
  release_t_sec: number | null;
  release_start_alpha: number;
}

export interface TempoPointDef {
  at_sec: number;
  bpm: number;
}

export interface AudioTrackDef {
  file: string;
  abs_fallback: string | null;
  sha256: string | null;
  offset_sec: number;
  transient_sensitivity: number;
}

export type TrackType = "untyped" | "effect" | "music";

export interface ClipDef {
  ref_block: string | null;
  start_sec: number;
  duration_sec: number;
  fade_in_sec: number;
  fade_out_sec: number;
  inline_fx: FxElementDef[];
  audio_file?: string | null;
  time_stretch?: boolean;
  source_duration_sec?: number | null;
}

export interface TrackDef {
  id: string;
  name: string;
  track_type?: TrackType;
  target_group: string | null;
  clips: ClipDef[];
}

export interface TimelineDef {
  id: string;
  name: string;
  duration_sec: number;
  grid_offset_sec: number;
  tempo_map: TempoPointDef[];
  audio_track: AudioTrackDef | null;
  loop_timeline?: boolean;
  tracks: TrackDef[];
}

export type TransientBand = "kick" | "snare";

export interface TransientMarker {
  time_sec: number;
  band: TransientBand;
  strength: number;
}

export interface WaveformPeak {
  min: number;
  max: number;
}

export interface AudioAnalysisResult {
  sha256: string;
  sample_rate: number;
  duration_sec: number;
  estimated_bpm: number;
  grid_offset_sec: number;
  transients: TransientMarker[];
  waveform_peaks: WaveformPeak[];
}

export interface ColorPaletteDef {
  id: string;
  name: string;
  hex_start: string;
  hex_end: string;
  colors?: string[];
}

export const DEFAULT_COLOR_PALETTES: ColorPaletteDef[] = [
  {
    id: "pal_rainbow",
    name: "Rainbow",
    hex_start: "#FF0000",
    hex_end: "#AA00FF",
    colors: ["#FF0000", "#FF8800", "#FFFF00", "#00FF00", "#00CCFF", "#0044FF", "#AA00FF"],
  },
  {
    id: "pal_cyber",
    name: "Cyberpunk Dual",
    hex_start: "#FF5500",
    hex_end: "#2255AA",
    colors: ["#FF5500", "#2255AA"],
  },
  {
    id: "pal_warm",
    name: "Warm Tungsten",
    hex_start: "#FFCC66",
    hex_end: "#CC4400",
    colors: ["#FFCC66", "#FF8822", "#CC4400"],
  },
  {
    id: "pal_fire",
    name: "Fire & Ember",
    hex_start: "#FF1100",
    hex_end: "#FFCC00",
    colors: ["#FF1100", "#FF6600", "#FFCC00"],
  },
  {
    id: "pal_ocean",
    name: "Ocean Ice",
    hex_start: "#001F66",
    hex_end: "#CCF9FF",
    colors: ["#001F66", "#0077CC", "#00EEFF", "#CCF9FF"],
  },
  {
    id: "pal_synthwave",
    name: "Neon Synthwave",
    hex_start: "#FF00AA",
    hex_end: "#00E5FF",
    colors: ["#FF00AA", "#8800FF", "#00E5FF"],
  },
  {
    id: "pal_sunset",
    name: "Sunset Glow",
    hex_start: "#FF2E63",
    hex_end: "#5E2BFF",
    colors: ["#FF2E63", "#FF7B25", "#FFD166", "#5E2BFF"],
  },
  {
    id: "pal_forest",
    name: "Forest Emerald",
    hex_start: "#004D25",
    hex_end: "#AEEA00",
    colors: ["#004D25", "#00C853", "#AEEA00"],
  },
  {
    id: "pal_police",
    name: "Emergency Red Blue",
    hex_start: "#FF0000",
    hex_end: "#0033FF",
    colors: ["#FF0000", "#0033FF"],
  },
  {
    id: "pal_uv",
    name: "UV Violet",
    hex_start: "#3A0088",
    hex_end: "#FF4DFF",
    colors: ["#3A0088", "#9D00FF", "#FF4DFF"],
  },
  {
    id: "pal_rgb",
    name: "RGB Primary",
    hex_start: "#FF0000",
    hex_end: "#0000FF",
    colors: ["#FF0000", "#00FF00", "#0000FF"],
  },
  {
    id: "pal_white_temp",
    name: "Warm to Cool White",
    hex_start: "#FFD28A",
    hex_end: "#B8DCFF",
    colors: ["#FFD28A", "#FFFFFF", "#B8DCFF"],
  },
];

export function getPaletteColors(pal: ColorPaletteDef): string[] {
  return pal.colors && pal.colors.length > 0 ? pal.colors : [pal.hex_start, pal.hex_end];
}

export interface DimmerPaletteDef {
  id: string;
  name: string;
  value_start: number;
  value_end: number;
}

export type MergeOp = "htp" | "ltp" | "add" | "scale";

export const MERGE_OP_LABELS: Record<
  MergeOp,
  { label: string; short: string; tooltip: string }
> = {
  htp: {
    label: "Highest Wins (HTP)",
    short: "Highest (HTP)",
    tooltip: "Takes the brighter value when overlapping scenes run.",
  },
  ltp: {
    label: "Override (LTP)",
    short: "Override (LTP)",
    tooltip: "Latest triggered or higher-priority layer replaces lower layers.",
  },
  add: {
    label: "Add (+/−)",
    short: "Add (+/−)",
    tooltip: "Adds or subtracts modulation around the underlying look.",
  },
  scale: {
    label: "Multiply (×)",
    short: "Multiply (×)",
    tooltip: "Proportionally scales underlying dimmer waves or chases.",
  },
};

export function rangePctToAmplitudeOffset(
  minPct: number,
  maxPct: number,
  isBipolarAdd: boolean,
): { amplitude: number; offset: number } {
  const minV = Math.max(0, Math.min(100, minPct)) / 100;
  const maxV = Math.max(0, Math.min(100, maxPct)) / 100;
  if (isBipolarAdd) {
    const halfSpan = (maxV - minV) / 2;
    const mid = (maxV + minV) / 2;
    return {
      amplitude: Number(halfSpan.toFixed(4)),
      offset: Number((mid - 0.5).toFixed(4)),
    };
  }
  return {
    amplitude: Number((maxV - minV).toFixed(4)),
    offset: Number(minV.toFixed(4)),
  };
}

export function amplitudeOffsetToRangePct(
  amplitude: number,
  offset: number,
  isBipolarAdd: boolean,
): { minPct: number; maxPct: number; inverted: boolean } {
  if (isBipolarAdd) {
    const vAtMinus = offset - amplitude + 0.5;
    const vAtPlus = offset + amplitude + 0.5;
    return {
      minPct: Math.round(Math.max(0, Math.min(1, vAtMinus)) * 100),
      maxPct: Math.round(Math.max(0, Math.min(1, vAtPlus)) * 100),
      inverted: amplitude < 0,
    };
  }
  const minV = Math.max(0, Math.min(1, offset));
  const maxV = Math.max(0, Math.min(1, offset + amplitude));
  return {
    minPct: Math.round(minV * 100),
    maxPct: Math.round(maxV * 100),
    inverted: amplitude < 0,
  };
}

export function patternScaleToSpatialFreq(scale: number): number {
  const clamped = Math.max(0.25, Math.min(10.0, scale || 1));
  return Number((1 / clamped).toFixed(3));
}

export function spatialFreqToPatternScale(freq: number): number {
  const clampedFreq = Math.max(0.05, freq || 1);
  return Number(Math.max(0.25, Math.min(10.0, 1 / clampedFreq)).toFixed(2));
}

/** Convert pattern scale (0.25..10.0) to normalized gizmo half-extent (0.08..2.0). */
export function patternScaleToBoxHalfNorm(patternScale: number): number {
  return Math.min(2.0, Math.max(0.08, 0.2 * patternScale));
}

/** Resolve independent `[boxHalfX, boxHalfY]` gizmo bounds, falling back to `spatialFreq`. */
export function resolveGizmoHalfExtents(
  spatialFreq: number,
  boxHalfX?: number | null,
  boxHalfY?: number | null,
): [number, number] {
  const fallback = patternScaleToBoxHalfNorm(spatialFreqToPatternScale(spatialFreq));
  const hx = Math.min(2.0, Math.max(0.05, boxHalfX ?? fallback));
  const hy = Math.min(2.0, Math.max(0.05, boxHalfY ?? fallback));
  return [hx, hy];
}

export interface TargetGizmoBounds {
  centerX: number;
  centerY: number;
  spatialFreq: number;
  boxHalfX: number;
  boxHalfY: number;
}

/**
 * Compute bounding-box gizmo parameters covering the targeted cells/fixtures
 * (or fallback fixture IDs / all patched fixtures).
 */
export function computeTargetGizmoBounds(params: {
  compiledCells: CompiledCell[];
  patch: FixtureInstance[];
  groups: FixtureGroupDef[];
  targetGroup?: string | null;
  fallbackFixtureIds?: string[];
}): TargetGizmoBounds {
  const { compiledCells, patch, groups, targetGroup, fallbackFixtureIds } = params;
  const rawTarget = (targetGroup ?? "").trim();

  const cellKeyFilter = new Set<string>();
  const fixtureIdFilter = new Set<string>();

  if (rawTarget && rawTarget !== "all" && rawTarget !== "*") {
    const grp = groups.find((g) => g.id === rawTarget);
    const refs = grp ? grp.targets : [rawTarget];
    for (const ref of refs) {
      const trimmed = ref.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(":");
      const fxId = colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx).trim();
      if (!fxId) continue;
      fixtureIdFilter.add(fxId);
      const fxCells = compiledCells.filter((c) => c.fixture_id === fxId);
      const cellCount = fxCells.length > 0 ? Math.max(...fxCells.map((c) => c.cell_index)) + 1 : 1;
      for (const cIdx of expandTargetRange(trimmed, cellCount)) {
        cellKeyFilter.add(`${fxId}:${cIdx}`);
      }
    }
  } else if (fallbackFixtureIds && fallbackFixtureIds.length > 0) {
    for (const id of fallbackFixtureIds) fixtureIdFilter.add(id);
  } else {
    for (const fx of patch) fixtureIdFilter.add(fx.id);
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const cell of compiledCells) {
    if (cellKeyFilter.size > 0) {
      if (!cellKeyFilter.has(`${cell.fixture_id}:${cell.cell_index}`)) continue;
    } else if (!fixtureIdFilter.has(cell.fixture_id)) {
      continue;
    }
    minX = Math.min(minX, cell.canvas_xy[0]);
    maxX = Math.max(maxX, cell.canvas_xy[0]);
    minY = Math.min(minY, cell.canvas_xy[1]);
    maxY = Math.max(maxY, cell.canvas_xy[1]);
  }

  if (!Number.isFinite(minX)) {
    for (const fx of patch) {
      if (!fixtureIdFilter.has(fx.id)) continue;
      const hx = Math.max(0.02, fx.grid_pos.scale_x * 0.5);
      const hy = Math.max(0.02, fx.grid_pos.scale_y * 0.5);
      minX = Math.min(minX, fx.grid_pos.x - hx);
      maxX = Math.max(maxX, fx.grid_pos.x + hx);
      minY = Math.min(minY, fx.grid_pos.y - hy);
      maxY = Math.max(maxY, fx.grid_pos.y + hy);
    }
  }

  if (!Number.isFinite(minX)) {
    return {
      centerX: 0.5,
      centerY: 0.5,
      spatialFreq: 1.0,
      boxHalfX: 0.2,
      boxHalfY: 0.2,
    };
  }

  const centerX = Number(((minX + maxX) * 0.5).toFixed(3));
  const centerY = Number(((minY + maxY) * 0.5).toFixed(3));
  const boxHalfX = Number(
    Math.min(2.0, Math.max(0.08, (maxX - minX) * 0.5 + 0.03)).toFixed(3),
  );
  const boxHalfY = Number(
    Math.min(2.0, Math.max(0.08, (maxY - minY) * 0.5 + 0.03)).toFixed(3),
  );
  const neededHalf = Math.max(boxHalfX, boxHalfY);
  const patternScale = Math.min(10.0, Math.max(0.4, neededHalf / 0.2));
  const spatialFreq = Number(patternScaleToSpatialFreq(patternScale).toFixed(3));
  return { centerX, centerY, spatialFreq, boxHalfX, boxHalfY };
}

export function buildCurve1DSvgPreview(params: {
  waveform: Waveform1D;
  amplitude: number;
  offset: number;
  phaseSpreadDeg: number;
  duty: number | null;
  fixtureCount: number;
  isBipolarAdd: boolean;
  width?: number;
  height?: number;
}): {
  pathD: string;
  baselineY: number;
  minY: number;
  maxY: number;
  fixtureDots: Array<{ index: number; x: number; y: number; u: number }>;
} {
  const width = params.width ?? 260;
  const height = params.height ?? 72;
  const padX = 8;
  const padY = 8;
  const plotW = Math.max(10, width - padX * 2);
  const plotH = Math.max(10, height - padY * 2);
  const samples = 64;

  const evalNormalizedY = (phi: number): number => {
    const wUni = evalUnipolarWaveform(params.waveform, phi, params.duty);
    const w = params.isBipolarAdd ? 2 * wUni - 1 : wUni;
    const raw = params.offset + params.amplitude * w;
    const norm = params.isBipolarAdd ? clamp01(0.5 + raw * 0.5) : clamp01(raw);
    return padY + (1 - norm) * plotH;
  };

  let pathD = "";
  for (let i = 0; i <= samples; i++) {
    const phi = i / samples;
    const x = padX + phi * plotW;
    const y = evalNormalizedY(phi);
    pathD += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)} `;
  }

  const count = Math.max(1, Math.min(32, params.fixtureCount || 8));
  const fixtureDots: Array<{ index: number; x: number; y: number; u: number }> = [];
  for (let i = 0; i < count; i++) {
    const u = count <= 1 ? 0 : i / (count - 1);
    const phi = remEuclid((u * params.phaseSpreadDeg) / 360, 1);
    const x = padX + phi * plotW;
    const y = evalNormalizedY(phi);
    fixtureDots.push({ index: i + 1, x, y, u });
  }

  const range = amplitudeOffsetToRangePct(
    params.amplitude,
    params.offset,
    params.isBipolarAdd,
  );
  const loPct = Math.min(range.minPct, range.maxPct) / 100;
  const hiPct = Math.max(range.minPct, range.maxPct) / 100;

  return {
    pathD: pathD.trim(),
    baselineY: padY + plotH * 0.5,
    minY: padY + (1 - loPct) * plotH,
    maxY: padY + (1 - hiPct) * plotH,
    fixtureDots,
  };
}

export function buildStepChasePreviewBlocks(params: {
  cellCount: number;
  activeRatio: number;
  fade: number;
  order: OrderRuleStr;
  phase?: number;
}): {
  activePixelCount: number;
  blocks: Array<{ index: number; level: number; u: number }>;
} {
  const n = Math.max(1, Math.min(32, params.cellCount || 8));
  const ratio = Math.max(1e-4, Math.min(1, params.activeRatio || 1 / n));
  const activePixelCount = Math.max(1, Math.round(ratio * n));
  const phase = params.phase ?? 0.25;
  const blocks: Array<{ index: number; level: number; u: number }> = [];

  for (let i = 0; i < n; i++) {
    const u = computeOrderU(params.order, i, n);
    const level = clamp01(
      evaluateStepChaseScalar({
        bBlock: phase,
        tLocal: 0,
        u,
        cellCount: n,
        stepBeats: 1,
        speedHz: null,
        activeRatio: ratio,
        fade: params.fade,
        amplitude: 1,
      }),
    );
    blocks.push({ index: i + 1, level, u });
  }
  return { activePixelCount, blocks };
}

export type ShutterState =
  | { kind: "open" }
  | { kind: "closed" }
  | { kind: "strobe_hz"; hz: number }
  | { kind: "random_strobe"; hz: number };

export type SmartLayerTrait =
  | {
      trait_kind: "dimmer";
      op: MergeOp;
      palette_ref: string | null;
      value_start: number;
      value_end: number;
    }
  | {
      trait_kind: "color";
      op: MergeOp;
      palette_ref: string | null;
      hex_start: string;
      hex_end: string;
    }
  | {
      trait_kind: "master_dimmer";
      op: MergeOp;
      value: number;
    }
  | {
      trait_kind: "shutter";
      state: ShutterState;
    };

export interface SmartControlLayer {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  trigger_order: number;
  alpha: number;
  target: string;
  order_override: OrderRuleStr | null;
  trait_spec: SmartLayerTrait;
}

export const SOFTWARE_STROBE_MAX_HZ = 11.0;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function srgbChToLinear(c: number): number {
  const x = clamp01(c);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

export function linearChToSrgb(c: number): number {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c <= 0.0031308
    ? 12.92 * c
    : Math.min(1, 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

export function dmxToPerceptualU8(val: number, gamma: number): number {
  if (val <= 0) return 0;
  if (val >= 255) return 255;
  const invG = 1 / Math.max(0.1, gamma || 2.2);
  return Math.round(Math.max(0, Math.min(255, Math.pow(val / 255, invG) * 255)));
}

export function srgbHexToLinearRgb(hex: string): [number, number, number] {
  const cleaned = hex.trim().replace(/^#/, "");
  let r = 0;
  let g = 0;
  let b = 0;
  if (cleaned.length === 6) {
    r = parseInt(cleaned.slice(0, 2), 16) || 0;
    g = parseInt(cleaned.slice(2, 4), 16) || 0;
    b = parseInt(cleaned.slice(4, 6), 16) || 0;
  } else if (cleaned.length === 3) {
    r = (parseInt(cleaned.slice(0, 1), 16) || 0) * 17;
    g = (parseInt(cleaned.slice(1, 2), 16) || 0) * 17;
    b = (parseInt(cleaned.slice(2, 3), 16) || 0) * 17;
  }
  return [
    srgbChToLinear(r / 255),
    srgbChToLinear(g / 255),
    srgbChToLinear(b / 255),
  ];
}

export function linearRgbToOklab(
  rgb: [number, number, number],
): [number, number, number] {
  const r = Math.max(0, rgb[0]);
  const g = Math.max(0, rgb[1]);
  const b = Math.max(0, rgb[2]);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(Math.max(0, l));
  const m_ = Math.cbrt(Math.max(0, m));
  const s_ = Math.cbrt(Math.max(0, s));

  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

export function oklabToLinearRgb(
  lab: [number, number, number],
): [number, number, number] {
  const l_ = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
  const m_ = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
  const s_ = lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2];

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

export function linearRgbToSrgbHex(rgb: [number, number, number]): string {
  const bytes = rgb.map((c) =>
    Math.round(clamp01(linearChToSrgb(c)) * 255)
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${bytes[0]}${bytes[1]}${bytes[2]}`.toUpperCase();
}

export function sampleOklabStopsLinear(
  hexStops: string[],
  w: number,
  gradient = 1,
  grayscale = false,
  cyclic = false,
): [number, number, number] {
  let rgb: [number, number, number] = [0, 0, 0];
  if (hexStops.length === 1) {
    rgb = srgbHexToLinearRgb(hexStops[0]);
  } else if (hexStops.length >= 2) {
    const g = clamp01(gradient);
    const n = hexStops.length;
    let idx = 0;
    let next = 1;
    let frac = 0;
    if (cyclic) {
      const t = remEuclid(w, 1);
      const pos = t * n;
      idx = Math.floor(pos) % n;
      next = (idx + 1) % n;
      frac = clamp01(pos - Math.floor(pos));
    } else {
      const t = clamp01(w);
      const pos = t * (n - 1);
      idx = Math.min(n - 2, Math.floor(pos));
      next = idx + 1;
      frac = clamp01(pos - idx);
    }
    const effFrac =
      g <= 1e-4 ? 0 : g >= 0.9999 ? frac : clamp01((frac - (1 - g)) / g);
    const labA = linearRgbToOklab(srgbHexToLinearRgb(hexStops[idx]));
    const labB = linearRgbToOklab(srgbHexToLinearRgb(hexStops[next]));
    rgb = oklabToLinearRgb([
      labA[0] + effFrac * (labB[0] - labA[0]),
      labA[1] + effFrac * (labB[1] - labA[1]),
      labA[2] + effFrac * (labB[2] - labA[2]),
    ]);
  }
  if (grayscale) {
    const y = clamp01(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]);
    return [y, y, y];
  }
  return rgb;
}

export function sampleValueStops(
  stops: number[],
  w: number,
  gradient = 1,
  cyclic = false,
): number {
  if (stops.length === 0) return 0;
  if (stops.length === 1) return clamp01(stops[0]);
  const g = clamp01(gradient);
  const n = stops.length;
  let idx = 0;
  let next = 1;
  let frac = 0;
  if (cyclic) {
    const t = remEuclid(w, 1);
    const pos = t * n;
    idx = Math.floor(pos) % n;
    next = (idx + 1) % n;
    frac = clamp01(pos - Math.floor(pos));
  } else {
    const t = clamp01(w);
    const pos = t * (n - 1);
    idx = Math.min(n - 2, Math.floor(pos));
    next = idx + 1;
    frac = clamp01(pos - idx);
  }
  const effFrac =
    g <= 1e-4 ? 0 : g >= 0.9999 ? frac : clamp01((frac - (1 - g)) / g);
  const a = clamp01(stops[idx]);
  const b = clamp01(stops[next]);
  return clamp01(a + effFrac * (b - a));
}

export function sampleOklabGradientLinear(
  hexStart: string,
  hexEnd: string,
  w: number,
): [number, number, number] {
  return sampleOklabStopsLinear([hexStart, hexEnd], w, 1, false, false);
}

export function sampleOklabGradientHex(
  hexStart: string,
  hexEnd: string,
  w: number,
): string {
  return linearRgbToSrgbHex(sampleOklabGradientLinear(hexStart, hexEnd, w));
}

export function applyScalarMerge(
  op: MergeOp,
  current: number,
  layerVal: number,
  alpha: number,
): number {
  const a = clamp01(alpha);
  if (op === "htp") return clamp01(Math.max(current, a * layerVal));
  if (op === "ltp") return clamp01((1 - a) * current + a * layerVal);
  if (op === "add") return clamp01(current + a * layerVal);
  return clamp01(current * (1 - a + a * layerVal));
}

export function extractRgbw(
  r: number,
  g: number,
  b: number,
  whiteMode: WhiteMode,
  whiteGain: number,
  gamma: number,
): [number, number, number, number] {
  const rc = clamp01(r);
  const gc = clamp01(g);
  const bc = clamp01(b);
  const wRaw = Math.min(rc, gc, bc);
  const gain = Math.max(0, Math.min(2, whiteGain));

  if (whiteMode === "off") return [rc, gc, bc, 0];
  if (whiteMode === "add") return [rc, gc, bc, clamp01(wRaw * gain)];

  if (wRaw <= 1e-6) return [rc, gc, bc, 0];
  const r0 = Math.max(0, rc - wRaw);
  const g0 = Math.max(0, gc - wRaw);
  const b0 = Math.max(0, bc - wRaw);
  const m = Math.max(rc, gc, bc);
  if (m - wRaw <= 1e-6) {
    return [0, 0, 0, clamp01(wRaw * gain)];
  }
  const gExp = Math.max(0.1, gamma);
  const denom = Math.pow(m - wRaw, gExp) + Math.pow(wRaw, gExp);
  const k = denom > 1e-9 ? Math.pow(Math.pow(m, gExp) / denom, 1 / gExp) : 1;
  return [
    clamp01(r0 * k),
    clamp01(g0 * k),
    clamp01(b0 * k),
    clamp01(wRaw * k * gain),
  ];
}

export function quantizeChannelValue(
  v: number,
  gamma: number,
  minDmx: number,
  maxDmx: number,
  applyDeadzone: boolean,
): number {
  const vc = clamp01(v);
  if (vc <= 0) return 0;
  const vg = Math.pow(vc, Math.max(0.1, gamma));
  if (applyDeadzone) {
    const lo = Math.max(0, Math.min(254, minDmx));
    const hi = Math.max(lo, Math.min(255, maxDmx));
    return Math.round(lo + vg * (hi - lo));
  }
  return Math.round(vg * 255);
}

function remEuclid(val: number, modulus: number): number {
  return ((val % modulus) + modulus) % modulus;
}

export function evalUnipolarWaveform(
  waveform: Waveform1D,
  phi: number,
  duty?: number | null,
): number {
  const p = remEuclid(phi, 1);
  if (waveform === "sine") {
    return clamp01(0.5 + 0.5 * Math.sin(Math.PI * 2 * p));
  }
  if (waveform === "triangle") {
    return clamp01(1 - Math.abs(2 * p - 1));
  }
  if (waveform === "saw") return clamp01(p);
  if (waveform === "square") return p < 0.5 ? 1 : 0;
  const d = Math.max(0.01, Math.min(0.99, duty ?? 0.2));
  return p < d ? 1 : 0;
}

export function evaluateCurve1DPhase(args: {
  waveform: Waveform1D;
  basePhaseCycles: number;
  u: number;
  phaseDeg?: number;
  phaseSpreadDeg: number;
  duty?: number | null;
  amplitude: number;
  offset: number;
  isBipolarAddDimmer: boolean;
}): number {
  const {
    waveform,
    basePhaseCycles,
    u,
    phaseDeg = 0,
    phaseSpreadDeg,
    duty,
    amplitude,
    offset,
    isBipolarAddDimmer,
  } = args;
  const phi = remEuclid(
    basePhaseCycles + phaseDeg / 360 + (u * phaseSpreadDeg) / 360,
    1,
  );
  const wUni = evalUnipolarWaveform(waveform, phi, duty);
  const w = isBipolarAddDimmer ? 2 * wUni - 1 : wUni;
  return offset + amplitude * w;
}

export function evaluateCurve1DScalar(args: {
  waveform: Waveform1D;
  bBlock: number;
  tLocal: number;
  u: number;
  rateBeats?: number | null;
  speedHz?: number | null;
  phaseSpreadDeg: number;
  duty?: number | null;
  amplitude: number;
  offset: number;
  isBipolarAddDimmer: boolean;
}): number {
  const basePhaseCycles =
    args.speedHz && args.speedHz > 0
      ? args.tLocal * args.speedHz
      : args.bBlock / Math.max(1e-4, args.rateBeats ?? 1);
  return evaluateCurve1DPhase({
    waveform: args.waveform,
    basePhaseCycles,
    u: args.u,
    phaseDeg: 0,
    phaseSpreadDeg: args.phaseSpreadDeg,
    duty: args.duty,
    amplitude: args.amplitude,
    offset: args.offset,
    isBipolarAddDimmer: args.isBipolarAddDimmer,
  });
}

export function evaluateStepChasePhase(args: {
  basePhaseCycles: number;
  u: number;
  cellCount: number;
  activeRatio?: number | null;
  pixelsOn?: number | null;
  oneWay?: boolean;
  fade: number;
  amplitude: number;
}): number {
  const {
    basePhaseCycles,
    u,
    cellCount,
    activeRatio,
    pixelsOn,
    oneWay = true,
    fade,
    amplitude,
  } = args;
  const p = remEuclid(basePhaseCycles, 1);
  const absD = oneWay
    ? Math.abs(remEuclid(u - p + 0.5, 1) - 0.5)
    : Math.abs(u - (p < 0.5 ? p * 2 : (1 - p) * 2));
  const ratio =
    pixelsOn !== undefined && pixelsOn !== null && cellCount > 0
      ? Math.max(1e-4, Math.min(1, Math.max(1, pixelsOn) / cellCount))
      : Math.max(1e-4, Math.min(1, activeRatio ?? 1 / Math.max(1, cellCount)));
  const halfW = 0.5 * ratio;
  const rampW = clamp01(fade) * halfW;
  const flatHalf = halfW - rampW;
  let window = 0;
  if (absD <= flatHalf + 1e-6) window = 1;
  else if (absD < halfW && rampW > 1e-6) window = clamp01((halfW - absD) / rampW);
  return window * amplitude;
}

export function evaluateStepChaseScalar(args: {
  bBlock: number;
  tLocal: number;
  u: number;
  cellCount: number;
  stepBeats?: number | null;
  speedHz?: number | null;
  activeRatio?: number | null;
  fade: number;
  amplitude: number;
}): number {
  const basePhaseCycles =
    args.speedHz && args.speedHz > 0
      ? args.tLocal * args.speedHz
      : args.bBlock / Math.max(1e-4, args.stepBeats ?? 1);
  return evaluateStepChasePhase({
    basePhaseCycles,
    u: args.u,
    cellCount: args.cellCount,
    activeRatio: args.activeRatio,
    fade: args.fade,
    amplitude: args.amplitude,
  });
}

export function evaluateSpatialShader2DPhase(args: {
  shader: Shader2DKind;
  normXy: [number, number];
  basePhaseCycles: number;
  spatialFreq: number;
  colorWidth?: number;
  directionDeg: number;
  centerX: number;
  centerY: number;
  transform?: string | null;
}): number {
  const {
    shader,
    normXy,
    basePhaseCycles,
    spatialFreq,
    colorWidth = 1,
    directionDeg,
    centerX,
    centerY,
    transform,
  } = args;
  const patternScale = Math.min(10, Math.max(0.25, 1 / Math.max(0.05, spatialFreq)));
  const boxHalfNorm = patternScaleToBoxHalfNorm(patternScale);
  let dx = normXy[0] - centerX;
  let dy = normXy[1] - centerY;
  if (transform === "mirror_x") {
    dx = Math.abs(dx) - 0.5 * boxHalfNorm;
  } else if (transform === "mirror_y") {
    dy = Math.abs(dy) - 0.5 * boxHalfNorm;
  } else if (transform === "invert") {
    dx = -dx;
    dy = -dy;
  }
  const phi = remEuclid(basePhaseCycles, 1);
  const k = spatialFreq / Math.max(0.1, Math.min(4, colorWidth || 1));
  const theta = (directionDeg * Math.PI) / 180;

  if (shader === "linear_sweep") {
    return clamp01(remEuclid(k * (dx * Math.cos(theta) + dy * Math.sin(theta)) - phi, 1));
  }
  if (shader === "radial_wave") {
    const base =
      0.5 + 0.5 * Math.sin(Math.PI * 2 * (k * Math.hypot(dx, dy) - phi));
    return clamp01(transform === "invert" ? 1 - base : base);
  }
  if (shader === "pinwheel") {
    return clamp01(
      remEuclid(
        (Math.atan2(dy, dx) / (Math.PI * 2)) * Math.max(1, Math.round(k)) - phi,
        1,
      ),
    );
  }
  return clamp01(
    0.5 +
      0.25 *
        (Math.sin(Math.PI * 2 * (k * dx + phi)) +
          Math.sin(Math.PI * 2 * (k * dy - phi))),
  );
}

export function evaluateSpatialShader2D(args: {
  shader: Shader2DKind;
  canvasXy: [number, number];
  bBlock: number;
  tLocal: number;
  rateBeats?: number | null;
  speedHz?: number | null;
  spatialFreq: number;
  directionDeg: number;
  centerX: number;
  centerY: number;
}): number {
  const basePhaseCycles =
    args.speedHz && args.speedHz > 0
      ? args.tLocal * args.speedHz
      : args.bBlock / Math.max(1e-4, args.rateBeats ?? 1);
  return evaluateSpatialShader2DPhase({
    shader: args.shader,
    normXy: args.canvasXy,
    basePhaseCycles,
    spatialFreq: args.spatialFreq,
    directionDeg: args.directionDeg,
    centerX: args.centerX,
    centerY: args.centerY,
  });
}

export function computeBeatAt(clock: BeatClockAnchor, tSec: number): number {
  return clock.beat_anchor + (tSec - clock.t_anchor_sec) * (clock.bpm / 60);
}

export function computeSceneAlphaAt(
  inst: ActiveSceneInstance,
  tNowSec: number,
): number {
  if (tNowSec < inst.trigger_t_sec) return 0;
  const dtIn = Math.max(0, tNowSec - inst.trigger_t_sec);
  const inAlpha =
    inst.fade_in_sec <= 1e-6 ? 1 : clamp01(dtIn / inst.fade_in_sec);
  if (inst.release_t_sec !== null) {
    const dtOut = Math.max(0, tNowSec - inst.release_t_sec);
    const outFactor =
      inst.fade_out_sec <= 1e-6 ? 0 : clamp01(1 - dtOut / inst.fade_out_sec);
    return clamp01(inst.release_start_alpha * outFactor);
  }
  return inAlpha;
}

function resolveTarget(
  target: string,
  orderOverride: OrderRuleStr | null,
  show: ShowStateDto,
  fixtureCellStarts: number[],
  fixtureCellCounts: number[],
  cellToFixture: number[],
  totalCells: number,
): { cells: Array<[number, number]>; fixtures: number[] } {
  const trimmed = target.trim();
  if (trimmed.toLowerCase() === "all" || trimmed === "*") {
    const rule = orderOverride ?? "linear";
    return {
      cells: Array.from({ length: totalCells }, (_, i) => [
        i,
        computeOrderU(rule, i, totalCells),
      ]),
      fixtures: show.patch.map((_, idx) => idx),
    };
  }

  const group = show.groups.find((g) => g.id === trimmed);
  if (group) {
    const rawCells: number[] = [];
    const fxSet = new Set<number>();
    for (const targetStr of group.targets) {
      const colonIdx = targetStr.indexOf(":");
      const fxId =
        colonIdx === -1 ? targetStr.trim() : targetStr.slice(0, colonIdx).trim();
      const fxIdx = show.patch.findIndex((f) => f.id === fxId);
      if (fxIdx === -1) continue;
      const cellCount = fixtureCellCounts[fxIdx] ?? 1;
      const start = fixtureCellStarts[fxIdx] ?? 0;
      for (const localIdx of expandTargetRange(targetStr, cellCount)) {
        const globalIdx = start + localIdx;
        if (globalIdx < totalCells) {
          rawCells.push(globalIdx);
          fxSet.add(fxIdx);
        }
      }
    }
    const rule = orderOverride ?? group.order;
    return {
      cells: rawCells.map((cIdx, pos) => [
        cIdx,
        computeOrderU(rule, pos, rawCells.length),
      ]),
      fixtures: Array.from(fxSet.values()),
    };
  }

  const colonIdx = trimmed.indexOf(":");
  const fxId = colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx).trim();
  const fxIdx = show.patch.findIndex((f) => f.id === fxId);
  if (fxIdx !== -1) {
    const cellCount = fixtureCellCounts[fxIdx] ?? 1;
    const start = fixtureCellStarts[fxIdx] ?? 0;
    const locals = expandTargetRange(trimmed, cellCount);
    const rule = orderOverride ?? "linear";
    return {
      cells: locals
        .map((localIdx, pos): [number, number] => [
          start + localIdx,
          computeOrderU(rule, pos, locals.length),
        ])
        .filter(([idx]) => idx < totalCells),
      fixtures: [fxIdx],
    };
  }

  void cellToFixture;
  return { cells: [], fixtures: [] };
}

export function hasSoftwareStrobeOverCap(
  layers: SmartControlLayer[],
  show: ShowStateDto,
  cache: Record<string, FixtureDetail>,
): boolean {
  if (show.patch.length === 0) return false;
  let totalCells = 0;
  const fixtureCellStarts: number[] = [];
  const fixtureCellCounts: number[] = [];
  const cellToFixture: number[] = [];
  const hasHardwareShutter: boolean[] = [];

  show.patch.forEach((inst, fxIdx) => {
    const detail = cache[inst.profile];
    const mode = detail?.expanded_modes.find((m) => m.name === inst.mode);
    const count = mode?.cells.length ?? 1;
    fixtureCellStarts.push(totalCells);
    fixtureCellCounts.push(count);
    for (let i = 0; i < count; i++) cellToFixture.push(fxIdx);
    totalCells += count;
    hasHardwareShutter.push(
      Boolean(mode?.channels.some((c) => c.role.kind === "shutter_strobe")),
    );
  });

  for (const layer of layers) {
    if (!layer.enabled || layer.alpha <= 0.5) continue;
    if (layer.trait_spec.trait_kind !== "shutter") continue;
    const st = layer.trait_spec.state;
    if (
      (st.kind === "strobe_hz" || st.kind === "random_strobe") &&
      st.hz > SOFTWARE_STROBE_MAX_HZ
    ) {
      const { fixtures } = resolveTarget(
        layer.target,
        layer.order_override,
        show,
        fixtureCellStarts,
        fixtureCellCounts,
        cellToFixture,
        totalCells,
      );
      if (fixtures.some((fxIdx) => !hasHardwareShutter[fxIdx])) {
        return true;
      }
    }
  }
  return false;
}

function softwareStrobeGateTs(
  shutter: ShutterState,
  tSec: number,
  fixtureIdx: number,
): [number, boolean] {
  if (shutter.kind === "open") return [1, false];
  if (shutter.kind === "closed") return [0, false];
  const clamped = shutter.hz > SOFTWARE_STROBE_MAX_HZ;
  const hz = Math.max(0.1, Math.min(SOFTWARE_STROBE_MAX_HZ, shutter.hz));
  if (shutter.kind === "strobe_hz") {
    const phase = (tSec * hz) % 1;
    return [phase < 0.5 ? 1 : 0, clamped];
  }
  const tick = Math.floor(tSec * hz * 2);
  const hash = (Math.imul(tick ^ (fixtureIdx * 2654435761), 1597334677) >>> 0) % 2;
  return [hash === 0 ? 1 : 0, clamped];
}

function mapShutterChannelTs(
  shutter: ShutterState,
  ch: ExpandedChannel,
): number {
  if (ch.role.kind !== "shutter_strobe") return ch.default_value;
  const caps = ch.role.capabilities;
  if (shutter.kind === "open") {
    const openCap = caps.find((c) => c.effect === "Open");
    return openCap
      ? Math.floor((openCap.dmx_range[0] + openCap.dmx_range[1]) / 2)
      : ch.default_value;
  }
  if (shutter.kind === "closed") {
    const closedCap = caps.find((c) => c.effect === "Closed");
    return closedCap
      ? Math.floor((closedCap.dmx_range[0] + closedCap.dmx_range[1]) / 2)
      : 0;
  }
  const isRand = shutter.kind === "random_strobe";
  const cap =
    caps.find(
      (c) =>
        c.effect !== "Open" &&
        c.effect !== "Closed" &&
        c.random_timing === isRand,
    ) ?? caps.find((c) => c.effect !== "Open" && c.effect !== "Closed");
  if (!cap) return ch.default_value;
  const f0 = cap.speed_start_hz ?? 1;
  const f1 = cap.speed_end_hz ?? 20;
  const d0 = cap.dmx_range[0];
  const d1 = cap.dmx_range[1];
  if (Math.abs(f1 - f0) < 1e-6) return Math.round((d0 + d1) / 2);
  const hzClamped = Math.max(Math.min(f0, f1), Math.min(Math.max(f0, f1), shutter.hz));
  const t = clamp01((hzClamped - f0) / (f1 - f0));
  return Math.round(d0 + t * (d1 - d0));
}

export function integrateTempoMapBeats(
  tempoMap: TempoPointDef[],
  defaultBpm: number,
  tStartSec: number,
  tEndSec: number,
): number {
  if (tEndSec <= tStartSec) return 0;
  const fallback = Math.max(20, Math.min(300, defaultBpm || 120));
  if (tempoMap.length === 0) {
    return ((tEndSec - tStartSec) * fallback) / 60;
  }

  const points = [...tempoMap].sort((a, b) => a.at_sec - b.at_sec);
  const bpmAt = (t: number): number => {
    let active = fallback;
    for (const pt of points) {
      if (pt.at_sec <= t) active = Math.max(20, Math.min(300, pt.bpm));
      else break;
    }
    return active;
  };

  let cur = tStartSec;
  let beats = 0;
  for (const pt of points) {
    if (pt.at_sec > cur && pt.at_sec < tEndSec) {
      beats += ((pt.at_sec - cur) * bpmAt(cur)) / 60;
      cur = pt.at_sec;
    }
  }
  if (tEndSec > cur) {
    beats += ((tEndSec - cur) * bpmAt(cur)) / 60;
  }
  return beats;
}

export function computeClipAlphaAt(
  clip: Pick<ClipDef, "start_sec" | "duration_sec" | "fade_in_sec" | "fade_out_sec">,
  tTimelineSec: number,
): number {
  if (clip.duration_sec <= 0) return 0;
  const clipEnd = clip.start_sec + clip.duration_sec;
  if (tTimelineSec < clip.start_sec || tTimelineSec >= clipEnd) return 0;
  const dtIn = Math.max(0, tTimelineSec - clip.start_sec);
  const dtRem = Math.max(0, clipEnd - tTimelineSec);
  const inAlpha = clip.fade_in_sec <= 1e-6 ? 1 : clamp01(dtIn / clip.fade_in_sec);
  const outAlpha = clip.fade_out_sec <= 1e-6 ? 1 : clamp01(dtRem / clip.fade_out_sec);
  return Math.min(inAlpha, outAlpha);
}

export function computeBeatGridMarkers(args: {
  durationSec: number;
  gridOffsetSec: number;
  tempoMap: TempoPointDef[];
  defaultBpm: number;
}): number[] {
  const { durationSec, gridOffsetSec, tempoMap, defaultBpm } = args;
  const markers: number[] = [];
  const points = [...tempoMap].sort((a, b) => a.at_sec - b.at_sec);
  let t = Math.max(0, gridOffsetSec);
  let safety = 0;
  while (t <= durationSec + 1e-6 && safety < 4096) {
    markers.push(Number(t.toFixed(4)));
    let activeBpm = Math.max(20, Math.min(300, defaultBpm || 120));
    for (const pt of points) {
      if (pt.at_sec <= t + 1e-6) activeBpm = Math.max(20, Math.min(300, pt.bpm));
      else break;
    }
    t += 60 / activeBpm;
    safety += 1;
  }
  return markers;
}

export function snapTimeSecToMarkers(
  timeSec: number,
  markersSec: number[],
  maxDistanceSec = 0.15,
): number {
  let best = timeSec;
  let bestDist = maxDistanceSec;
  for (const m of markersSec) {
    const dist = Math.abs(timeSec - m);
    if (dist <= bestDist) {
      bestDist = dist;
      best = m;
    }
  }
  return Number(best.toFixed(4));
}

export function analyzeSyntheticTimelineAudio(args: {
  bpm: number;
  durationSec: number;
  gridOffsetSec: number;
  sensitivity?: number;
}): AudioAnalysisResult {
  const bpm = Math.max(60, Math.min(180, args.bpm || 120));
  const durationSec = Math.max(2, args.durationSec || 16);
  const offset = Math.max(0, args.gridOffsetSec || 0);
  const sens = clamp01(args.sensitivity ?? 0.65);
  const beatSec = 60 / bpm;

  const transients: TransientMarker[] = [];
  let idx = 0;
  for (let t = offset; t < durationSec - 0.05; t += beatSec) {
    const band: TransientBand = idx % 2 === 0 ? "kick" : "snare";
    const strength = band === "kick" ? 0.92 : Math.max(0.4, 0.7 + (sens - 0.5) * 0.2);
    if (strength >= 0.95 - sens * 0.6) {
      transients.push({
        time_sec: Number(t.toFixed(4)),
        band,
        strength,
      });
    }
    idx += 1;
  }

  const peakCount = Math.max(20, Math.min(800, Math.round(durationSec * 20)));
  const waveform_peaks: WaveformPeak[] = [];
  for (let i = 0; i < peakCount; i++) {
    const t = (i / peakCount) * durationSec;
    const hitDist = transients.reduce(
      (min, m) => Math.min(min, Math.abs(t - m.time_sec)),
      1,
    );
    const amp = hitDist < 0.08 ? 0.9 : 0.12 + 0.08 * Math.sin(i * 0.7);
    waveform_peaks.push({ min: -amp, max: amp });
  }

  return {
    sha256: `sim_${bpm.toFixed(1)}_${durationSec.toFixed(1)}`,
    sample_rate: 44100,
    duration_sec: durationSec,
    estimated_bpm: bpm,
    grid_offset_sec: transients.find((m) => m.band === "kick")?.time_sec ?? offset,
    transients,
    waveform_peaks,
  };
}

export function evaluateSimulationLayersToDmx(args: {
  show: ShowStateDto;
  fixtureDetailsCache: Record<string, FixtureDetail>;
  liveLayers: SmartControlLayer[];
  activeScenes?: ActiveSceneInstance[];
  beatClock?: BeatClockAnchor;
  timelineState?: {
    activeTimelineId: string | null;
    playing: boolean;
    playheadSec: number;
    startAnchorTSec: number;
    latencyOffsetMs: number;
  };
  universes: UniverseConfig[];
  grandMaster: number;
  blackout: boolean;
  tSec: number;
}): { dmxByUniverse: Uint8Array[]; softwareStrobeClamped: boolean } {
  const {
    show,
    fixtureDetailsCache,
    liveLayers,
    activeScenes = [],
    beatClock = { bpm: show.bpm || 120, t_anchor_sec: 0, beat_anchor: 0 },
    timelineState,
    universes,
    grandMaster,
    blackout,
    tSec,
  } = args;

  const dmxByUniverse = universes.map(() => new Uint8Array(512));
  const uniMap = new Map<number, Uint8Array>();
  universes.forEach((u, idx) => uniMap.set(u.id, dmxByUniverse[idx]));

  if (show.patch.length === 0) {
    return { dmxByUniverse, softwareStrobeClamped: false };
  }

  let totalCells = 0;
  const fixtureCellStarts: number[] = [];
  const fixtureCellCounts: number[] = [];
  const cellToFixture: number[] = [];
  const cellCanvasXy: Array<[number, number]> = [];

  show.patch.forEach((inst, fxIdx) => {
    const detail = fixtureDetailsCache[inst.profile];
    const mode = detail?.expanded_modes.find((m) => m.name === inst.mode);
    const cells = mode?.cells ?? [
      { cell_index: 0, pixel_key: "1", grid_xyz: [0, 0, 0], local_uv: [0, 0] as [number, number] },
    ];
    const count = cells.length;
    fixtureCellStarts.push(totalCells);
    fixtureCellCounts.push(count);
    for (let i = 0; i < count; i++) {
      cellToFixture.push(fxIdx);
      cellCanvasXy.push(transformCellUv(inst.grid_pos, cells[i].local_uv));
    }
    totalCells += count;

    // Seed defaults before evaluating active layers
    for (const ch of mode?.channels ?? []) {
      const linear = inst.address + ch.dmx_offset;
      const uId = linear <= 512 ? inst.universe : inst.universe + 1;
      const addr = linear <= 512 ? linear : linear - 512;
      const buf = uniMap.get(uId);
      if (buf && addr >= 1 && addr <= 512 && ch.default_value > 0 && !blackout) {
        buf[addr - 1] = Math.round(ch.default_value * clamp01(grandMaster));
      }
    }
  });

  const activeLayers = liveLayers
    .filter((l) => l.enabled && l.alpha > 0)
    .sort(
      (a, b) =>
        a.priority - b.priority || a.trigger_order - b.trigger_order,
    );

  const runningScenes = activeScenes
    .map((inst) => ({
      inst,
      def: show.scenes.find((s) => s.id === inst.scene_id),
      alpha: computeSceneAlphaAt(inst, tSec),
    }))
    .filter(
      (item): item is { inst: ActiveSceneInstance; def: SceneDef; alpha: number } =>
        Boolean(item.def) && item.alpha > 0,
    )
    .sort(
      (a, b) =>
        a.def.priority - b.def.priority ||
        a.inst.trigger_order - b.inst.trigger_order,
    );

  const activeTimeline =
    timelineState?.activeTimelineId
      ? show.timelines.find((t) => t.id === timelineState.activeTimelineId) ?? null
      : null;

  const effectiveTimelineSec = activeTimeline
    ? Math.max(
        0,
        (timelineState!.playing
          ? timelineState!.playheadSec +
            Math.max(0, tSec - timelineState!.startAnchorTSec)
          : timelineState!.playheadSec) +
          timelineState!.latencyOffsetMs / 1000,
      )
    : null;

  if (
    activeLayers.length === 0 &&
    runningScenes.length === 0 &&
    activeTimeline === null
  ) {
    return { dmxByUniverse, softwareStrobeClamped: false };
  }

  const fxStates = show.patch.map(() => ({
    masterDimmer: 0,
    masterTouched: false,
    anyCellTouched: false,
    anyCellDimmerTouched: false,
    shutter: { kind: "open" } as ShutterState,
    customChannels: {} as Record<string, number>,
  }));
  const cellStates = Array.from({ length: totalCells }, () => ({
    dimmer: 0,
    color: [0, 0, 0] as [number, number, number],
    dimmerTouched: false,
    colorTouched: false,
  }));

  const sampleColorPal = (
    palId: string | null,
    w: number,
    inlineColors?: string[],
    gradient = 1,
    grayscale = false,
    cyclic = false,
  ): [number, number, number] => {
    if (inlineColors && inlineColors.length > 0) {
      return sampleOklabStopsLinear(inlineColors, w, gradient, grayscale, cyclic);
    }
    const pal = palId
      ? show.color_palettes.find((p) => p.id === palId)
      : undefined;
    if (pal) {
      return sampleOklabStopsLinear(
        getPaletteColors(pal),
        w,
        gradient,
        grayscale,
        cyclic,
      );
    }
    const clamped = cyclic ? remEuclid(w, 1) : clamp01(w);
    return [clamped, clamped, clamped];
  };

  const resolveBasePhase = (
    bBlock: number,
    tLocal: number,
    cycleCycles: number,
    legacyBeats: number | null,
    speedHz: number | null,
    rateCycles?: number | null,
  ): number => {
    if (speedHz && speedHz > 0) return tLocal * speedHz;
    if (legacyBeats && legacyBeats > 0) return bBlock / legacyBeats;
    if (rateCycles !== undefined && rateCycles !== null) {
      if (rateCycles <= 0) return 0;
      return cycleCycles * rateCycles;
    }
    return cycleCycles;
  };

  const applyScalarTraitToCell = (
    trait: string,
    op: MergeOp,
    cellIdx: number,
    scalar: number,
    alpha: number,
  ) => {
    const fxIdx = cellToFixture[cellIdx];
    const t = trait.toLowerCase();
    if (t === "red") {
      cellStates[cellIdx].color[0] = applyScalarMerge(
        op,
        cellStates[cellIdx].color[0],
        scalar,
        alpha,
      );
      cellStates[cellIdx].colorTouched = true;
      fxStates[fxIdx].anyCellTouched = true;
    } else if (t === "green") {
      cellStates[cellIdx].color[1] = applyScalarMerge(
        op,
        cellStates[cellIdx].color[1],
        scalar,
        alpha,
      );
      cellStates[cellIdx].colorTouched = true;
      fxStates[fxIdx].anyCellTouched = true;
    } else if (t === "blue") {
      cellStates[cellIdx].color[2] = applyScalarMerge(
        op,
        cellStates[cellIdx].color[2],
        scalar,
        alpha,
      );
      cellStates[cellIdx].colorTouched = true;
      fxStates[fxIdx].anyCellTouched = true;
    } else if (t === "white") {
      cellStates[cellIdx].color = [
        applyScalarMerge(op, cellStates[cellIdx].color[0], scalar, alpha),
        applyScalarMerge(op, cellStates[cellIdx].color[1], scalar, alpha),
        applyScalarMerge(op, cellStates[cellIdx].color[2], scalar, alpha),
      ];
      cellStates[cellIdx].colorTouched = true;
      fxStates[fxIdx].anyCellTouched = true;
    } else if (t === "strobe") {
      if (alpha > 0.1) {
        fxStates[fxIdx].shutter =
          scalar > 0.05
            ? { kind: "strobe_hz", hz: 1 + clamp01(scalar) * 19 }
            : { kind: "open" };
      }
    } else if (t === "pan" || t === "tilt" || t.startsWith("channel:")) {
      const key = t.startsWith("channel:") ? t.slice("channel:".length) : t;
      const cur = fxStates[fxIdx].customChannels[key] ?? 0;
      fxStates[fxIdx].customChannels[key] = applyScalarMerge(
        op,
        cur,
        scalar,
        alpha,
      );
    } else {
      cellStates[cellIdx].dimmer = applyScalarMerge(
        op,
        cellStates[cellIdx].dimmer,
        scalar,
        alpha,
      );
      cellStates[cellIdx].dimmerTouched = true;
      fxStates[fxIdx].anyCellTouched = true;
      fxStates[fxIdx].anyCellDimmerTouched = true;
    }
  };

  const foldFxBlock = (
    block: FxBlockDef,
    targetGroup: string,
    alpha: number,
    tLocal: number,
    bLocal: number,
    sceneDuration?: { value: number; unit: DurationUnit },
    depth = 0,
  ) => {
    const durBeats = Math.max(
      0.05,
      sceneDuration?.unit === "beats"
        ? sceneDuration.value
        : block.duration_beats,
    );
    const bBlock = block.loop_block
      ? remEuclid(bLocal, durBeats)
      : Math.min(durBeats, bLocal);
    let cycleCycles = 0;
    if (sceneDuration?.unit === "seconds") {
      const durSec = Math.max(0.05, sceneDuration.value);
      cycleCycles = block.loop_block
        ? tLocal / durSec
        : Math.min(1, tLocal / durSec);
    } else if (block.duration_sec && block.duration_sec > 0) {
      const durSec = Math.max(0.05, block.duration_sec);
      cycleCycles = block.loop_block
        ? tLocal / durSec
        : Math.min(1, tLocal / durSec);
    } else {
      cycleCycles = block.loop_block
        ? bLocal / durBeats
        : Math.min(1, bLocal / durBeats);
    }

    for (const elem of block.elements) {
      if (elem.kind === "scene_sequence") {
        if (depth >= 4 || elem.steps.length === 0 || alpha <= 0) continue;
        const secPerBeat =
          tLocal > 1e-6 && bLocal > 1e-6
            ? Math.max(0.05, Math.min(10, tLocal / bLocal))
            : 60 / Math.max(1, show.bpm || 120);
        const effBpm = 60 / secPerBeat;
        const info = getActiveSequenceStepAt(
          elem.steps,
          elem.playback_mode,
          tLocal,
          effBpm,
        );
        if (!info) continue;
        const honorStepTargets =
          !targetGroup.trim() || targetGroup.trim().toLowerCase() === "all";

        const evalStep = (
          stepIdx: number,
          weightAlpha: number,
          localTSec: number,
        ) => {
          if (weightAlpha <= 1e-6) return;
          const stepScene = show.scenes.find(
            (s) => s.id === elem.steps[stepIdx].scene_id,
          );
          if (!stepScene || stepScene.timeline_ref) return;
          const stepBLocal = localTSec / secPerBeat;
          const stepDur =
            stepScene.duration_value !== undefined
              ? {
                  value: stepScene.duration_value,
                  unit: stepScene.duration_unit ?? ("beats" as DurationUnit),
                }
              : undefined;
          for (const blockId of stepScene.block_refs) {
            if (block.id && blockId === block.id) continue;
            const stepBlock = show.fx_library.find((b) => b.id === blockId);
            if (!stepBlock) continue;
            const resolvedTarget = honorStepTargets
              ? stepScene.target_group?.trim() ||
                stepBlock.target_group?.trim() ||
                targetGroup
              : targetGroup;
            foldFxBlock(
              stepBlock,
              resolvedTarget,
              weightAlpha,
              localTSec,
              stepBLocal,
              stepDur,
              depth + 1,
            );
          }
        };

        if (
          info.fadeAlpha < 1 &&
          info.prevIndex !== null &&
          info.prevIndex !== info.activeIndex
        ) {
          const prevStep = elem.steps[info.prevIndex];
          const prevDurSec =
            prevStep.duration_unit === "seconds"
              ? Math.max(0.05, prevStep.duration_value)
              : Math.max(0.05, prevStep.duration_value) * secPerBeat;
          evalStep(
            info.prevIndex,
            alpha * (1 - info.fadeAlpha),
            prevDurSec + info.stepLocalSec,
          );
          evalStep(info.activeIndex, alpha * info.fadeAlpha, info.stepLocalSec);
        } else {
          evalStep(info.activeIndex, alpha, info.stepLocalSec);
        }
        continue;
      }

      const orderOverride = "order" in elem ? elem.order : null;
      const { cells, fixtures } = resolveTarget(
        targetGroup,
        orderOverride,
        show,
        fixtureCellStarts,
        fixtureCellCounts,
        cellToFixture,
        totalCells,
      );

      if (elem.kind === "static_trait") {
        if (elem.trait === "master_dimmer") {
          const val = elem.value_start ?? 1;
          for (const fxIdx of fixtures) {
            fxStates[fxIdx].masterDimmer = applyScalarMerge(
              elem.op,
              fxStates[fxIdx].masterDimmer,
              val,
              alpha,
            );
            fxStates[fxIdx].masterTouched = true;
          }
        } else if (elem.trait === "color") {
          const v0 = elem.value_start ?? 0;
          const v1 = elem.value_end ?? 1;
          for (const [cellIdx, u] of cells) {
            const w = v0 + u * (v1 - v0);
            const rgb = elem.palette_ref
              ? sampleColorPal(elem.palette_ref, w)
              : elem.hex_start
                ? sampleOklabGradientLinear(
                    elem.hex_start,
                    elem.hex_end ?? elem.hex_start,
                    clamp01(w),
                  )
                : sampleColorPal(null, w);
            cellStates[cellIdx].color = [
              applyScalarMerge(elem.op, cellStates[cellIdx].color[0], rgb[0], alpha),
              applyScalarMerge(elem.op, cellStates[cellIdx].color[1], rgb[1], alpha),
              applyScalarMerge(elem.op, cellStates[cellIdx].color[2], rgb[2], alpha),
            ];
            cellStates[cellIdx].colorTouched = true;
            fxStates[cellToFixture[cellIdx]].anyCellTouched = true;
          }
        } else {
          const pal = elem.palette_ref
            ? show.dimmer_palettes.find((p) => p.id === elem.palette_ref)
            : undefined;
          const v0 = elem.value_start ?? 1;
          const v1 = elem.value_end ?? v0;
          for (const [cellIdx, u] of cells) {
            const val = pal
              ? clamp01(pal.value_start + u * (pal.value_end - pal.value_start))
              : v0 + u * (v1 - v0);
            cellStates[cellIdx].dimmer = applyScalarMerge(
              elem.op,
              cellStates[cellIdx].dimmer,
              val,
              alpha,
            );
            cellStates[cellIdx].dimmerTouched = true;
            fxStates[cellToFixture[cellIdx]].anyCellTouched = true;
            fxStates[cellToFixture[cellIdx]].anyCellDimmerTouched = true;
          }
        }
      } else if (elem.kind === "curve_1d") {
        const basePhase = resolveBasePhase(
          bBlock,
          tLocal,
          cycleCycles,
          elem.rate_beats,
          elem.speed_hz,
          elem.rate_cycles,
        );
        const phaseDeg = elem.phase_deg ?? 0;
        const gradient = elem.gradient ?? 1;
        const grayscale = elem.grayscale ?? false;
        const colorWidth = Math.max(0.1, Math.min(4, elem.color_width ?? 1));
        const angleDeg = elem.angle_deg ?? 0;
        if (elem.trait === "master_dimmer") {
          const val = evaluateCurve1DPhase({
            waveform: elem.waveform,
            basePhaseCycles: basePhase,
            u: 0,
            phaseDeg,
            phaseSpreadDeg: elem.phase_spread_deg,
            duty: elem.duty,
            amplitude: elem.amplitude,
            offset: elem.offset,
            isBipolarAddDimmer: elem.op === "add",
          });
          for (const fxIdx of fixtures) {
            fxStates[fxIdx].masterDimmer = applyScalarMerge(
              elem.op,
              fxStates[fxIdx].masterDimmer,
              val,
              alpha,
            );
            fxStates[fxIdx].masterTouched = true;
          }
        } else if (elem.trait === "color") {
          const isColorFx = elem.fx_kind_tag === "color_fx";
          const dirSign = remEuclid(angleDeg, 360) >= 180 ? -1 : 1;
          for (const [cellIdx, u] of cells) {
            let rgb: [number, number, number];
            if (isColorFx) {
              const phi = remEuclid(
                basePhase * dirSign +
                  phaseDeg / 360 +
                  ((u * elem.phase_spread_deg) / 360) / colorWidth,
                1,
              );
              rgb = sampleColorPal(
                elem.palette_ref,
                phi,
                elem.inline_colors,
                gradient,
                grayscale,
                true,
              );
            } else {
              const scalar = evaluateCurve1DPhase({
                waveform: elem.waveform,
                basePhaseCycles: basePhase,
                u,
                phaseDeg,
                phaseSpreadDeg: elem.phase_spread_deg,
                duty: elem.duty,
                amplitude: elem.amplitude,
                offset: elem.offset,
                isBipolarAddDimmer: false,
              });
              rgb = sampleColorPal(
                elem.palette_ref,
                scalar,
                elem.inline_colors,
                gradient,
                grayscale,
                false,
              );
            }
            cellStates[cellIdx].color = [
              applyScalarMerge(elem.op, cellStates[cellIdx].color[0], rgb[0], alpha),
              applyScalarMerge(elem.op, cellStates[cellIdx].color[1], rgb[1], alpha),
              applyScalarMerge(elem.op, cellStates[cellIdx].color[2], rgb[2], alpha),
            ];
            cellStates[cellIdx].colorTouched = true;
            fxStates[cellToFixture[cellIdx]].anyCellTouched = true;
          }
        } else {
          const isValueFx =
            elem.fx_kind_tag === "value_fx" &&
            Boolean(elem.value_stops && elem.value_stops.length > 0);
          for (const [cellIdx, u] of cells) {
            const scalar = isValueFx
              ? elem.offset +
                elem.amplitude *
                  sampleValueStops(
                    elem.value_stops!,
                    remEuclid(
                      basePhase + phaseDeg / 360 + (u * elem.phase_spread_deg) / 360,
                      1,
                    ),
                    gradient,
                    true,
                  )
              : evaluateCurve1DPhase({
                  waveform: elem.waveform,
                  basePhaseCycles: basePhase,
                  u,
                  phaseDeg,
                  phaseSpreadDeg: elem.phase_spread_deg,
                  duty: elem.duty,
                  amplitude: elem.amplitude,
                  offset: elem.offset,
                  isBipolarAddDimmer: elem.op === "add",
                });
            applyScalarTraitToCell(elem.trait, elem.op, cellIdx, scalar, alpha);
          }
        }
      } else if (elem.kind === "step_chase") {
        const isColor = elem.trait === "color";
        const basePhase = resolveBasePhase(
          bBlock,
          tLocal,
          cycleCycles,
          elem.step_beats,
          elem.speed_hz,
          elem.rate_cycles,
        );
        if (elem.trait === "master_dimmer") {
          const val = evaluateStepChasePhase({
            basePhaseCycles: basePhase,
            u: 0,
            cellCount: Math.max(1, fixtures.length),
            activeRatio: elem.active_ratio,
            pixelsOn: elem.pixels_on,
            oneWay: elem.one_way ?? true,
            fade: elem.fade,
            amplitude: elem.amplitude,
          });
          for (const fxIdx of fixtures) {
            fxStates[fxIdx].masterDimmer = applyScalarMerge(
              elem.op,
              fxStates[fxIdx].masterDimmer,
              val,
              alpha,
            );
            fxStates[fxIdx].masterTouched = true;
          }
        } else {
          for (const [cellIdx, u] of cells) {
            const val = evaluateStepChasePhase({
              basePhaseCycles: basePhase,
              u,
              cellCount: cells.length,
              activeRatio: elem.active_ratio,
              pixelsOn: elem.pixels_on,
              oneWay: elem.one_way ?? true,
              fade: elem.fade,
              amplitude: elem.amplitude,
            });
            if (isColor) {
              const rgb = sampleColorPal(elem.palette_ref, val);
              cellStates[cellIdx].color = [
                applyScalarMerge(elem.op, cellStates[cellIdx].color[0], rgb[0], alpha),
                applyScalarMerge(elem.op, cellStates[cellIdx].color[1], rgb[1], alpha),
                applyScalarMerge(elem.op, cellStates[cellIdx].color[2], rgb[2], alpha),
              ];
              cellStates[cellIdx].colorTouched = true;
              fxStates[cellToFixture[cellIdx]].anyCellTouched = true;
            } else {
              applyScalarTraitToCell(elem.trait, elem.op, cellIdx, val, alpha);
            }
          }
        }
      } else if (elem.kind === "spatial_shader_2d") {
        const isColor = elem.trait === "color";
        const basePhase =
          resolveBasePhase(
            bBlock,
            tLocal,
            cycleCycles,
            elem.rate_beats,
            elem.speed_hz,
            elem.rate_cycles,
          ) + (elem.phase_offset ?? 0);
        const gradient = elem.gradient ?? 1;
        const grayscale = elem.grayscale ?? false;
        const colorWidth = elem.color_width ?? 1;
        const [boxHalfX, boxHalfY] = resolveGizmoHalfExtents(
          elem.spatial_freq,
          elem.box_half_x,
          elem.box_half_y,
        );

        for (const [cellIdx] of cells) {
          const xy = cellCanvasXy[cellIdx] ?? [0.5, 0.5];
          if (
            Math.abs(xy[0] - elem.center_x) > boxHalfX + 1e-6 ||
            Math.abs(xy[1] - elem.center_y) > boxHalfY + 1e-6
          ) {
            continue;
          }
          const s = evaluateSpatialShader2DPhase({
            shader: elem.shader,
            normXy: [xy[0], xy[1]],
            basePhaseCycles: basePhase,
            spatialFreq: elem.spatial_freq,
            colorWidth,
            directionDeg: elem.direction_deg,
            centerX: elem.center_x,
            centerY: elem.center_y,
            transform: elem.transform,
          });
          if (isColor) {
            const rgb = sampleColorPal(
              elem.palette_ref,
              s,
              elem.inline_colors,
              gradient,
              grayscale,
              true,
            );
            cellStates[cellIdx].color = [
              applyScalarMerge(elem.op, cellStates[cellIdx].color[0], rgb[0], alpha),
              applyScalarMerge(elem.op, cellStates[cellIdx].color[1], rgb[1], alpha),
              applyScalarMerge(elem.op, cellStates[cellIdx].color[2], rgb[2], alpha),
            ];
            cellStates[cellIdx].colorTouched = true;
          } else {
            const val =
              elem.value_stops && elem.value_stops.length > 0
                ? sampleValueStops(elem.value_stops, s, gradient, true)
                : gradient < 0.01
                  ? Math.floor(s * 4) / 4
                  : s;
            if (elem.trait === "master_dimmer") {
              const fxIdx = cellToFixture[cellIdx];
              fxStates[fxIdx].masterDimmer = applyScalarMerge(
                elem.op,
                fxStates[fxIdx].masterDimmer,
                val,
                alpha,
              );
              fxStates[fxIdx].masterTouched = true;
            } else {
              applyScalarTraitToCell(elem.trait, elem.op, cellIdx, val, alpha);
            }
          }
          fxStates[cellToFixture[cellIdx]].anyCellTouched = true;
        }
      }
    }
  };

  // Stage 1.1: Timeline tracks evaluated bottom-to-top below live Scenes
  if (activeTimeline && effectiveTimelineSec !== null) {
    for (const track of activeTimeline.tracks) {
      const trackTarget = track.target_group?.trim() || "";
      for (const clip of track.clips) {
        const clipAlpha = computeClipAlphaAt(clip, effectiveTimelineSec);
        if (clipAlpha <= 0) continue;
        const tLocal = Math.max(0, effectiveTimelineSec - clip.start_sec);
        const bLocal = integrateTempoMapBeats(
          activeTimeline.tempo_map,
          show.bpm || 120,
          clip.start_sec,
          effectiveTimelineSec,
        );
        if (clip.ref_block) {
          const block = show.fx_library.find((b) => b.id === clip.ref_block);
          if (!block) continue;
          const targetGroup = trackTarget || block.target_group?.trim() || "";
          if (!targetGroup) continue;
          const seqElem = block.elements.find(
            (el): el is Extract<FxElementDef, { kind: "scene_sequence" }> =>
              el.kind === "scene_sequence",
          );
          const seqDurSec =
            seqElem && seqElem.steps.length > 0
              ? computeSceneSequenceDurationSec(seqElem.steps, show.bpm || 120)
              : null;
          const phaseScale =
            clip.time_stretch && clip.duration_sec > 1e-6
              ? Math.max(
                  0.01,
                  (clip.source_duration_sec ??
                    seqDurSec ??
                    block.duration_sec ??
                    Math.max(0.25, block.duration_beats) *
                      (60 / Math.max(1, show.bpm || 120))) / clip.duration_sec,
                )
              : 1;
          foldFxBlock(
            block,
            targetGroup,
            clipAlpha,
            tLocal * phaseScale,
            bLocal * phaseScale,
          );
        } else if (clip.inline_fx.length > 0) {
          const targetGroup = trackTarget || "all";
          const clipBeats = Math.max(
            0.25,
            integrateTempoMapBeats(
              activeTimeline.tempo_map,
              show.bpm || 120,
              clip.start_sec,
              clip.start_sec + clip.duration_sec,
            ),
          );
          foldFxBlock(
            {
              id: "_inline",
              name: "_inline",
              target_group: targetGroup,
              duration_beats: clipBeats,
              loop_block: true,
              elements: clip.inline_fx,
            },
            targetGroup,
            clipAlpha,
            tLocal,
            bLocal,
          );
        }
      }
    }
  }

  // Stage 1.2 + Stage 2: Active Scenes -> FxBlocks
  const bNow = computeBeatAt(beatClock, tSec);
  for (const { inst, def, alpha } of runningScenes) {
    const tLocal = Math.max(0, tSec - inst.trigger_t_sec);
    const bLocal = Math.max(0, bNow - inst.trigger_beat);
    const sceneDur =
      def.duration_value !== undefined
        ? {
            value: def.duration_value,
            unit: def.duration_unit ?? ("beats" as DurationUnit),
          }
        : undefined;
    for (const blockId of def.block_refs) {
      const block = show.fx_library.find((b) => b.id === blockId);
      if (!block) continue;
      const targetGroup =
        def.target_group?.trim() || block.target_group?.trim() || "";
      if (!targetGroup) continue;
      foldFxBlock(block, targetGroup, alpha, tLocal, bLocal, sceneDur);
    }
  }

  for (const layer of activeLayers) {
    const alpha = clamp01(layer.alpha);
    const { cells, fixtures } = resolveTarget(
      layer.target,
      layer.order_override,
      show,
      fixtureCellStarts,
      fixtureCellCounts,
      cellToFixture,
      totalCells,
    );
    const spec = layer.trait_spec;

    if (spec.trait_kind === "dimmer") {
      const pal = spec.palette_ref
        ? show.dimmer_palettes.find((p) => p.id === spec.palette_ref)
        : undefined;
      for (const [cellIdx, u] of cells) {
        const val = pal
          ? clamp01(pal.value_start + u * (pal.value_end - pal.value_start))
          : spec.value_start + u * (spec.value_end - spec.value_start);
        cellStates[cellIdx].dimmer = applyScalarMerge(
          spec.op,
          cellStates[cellIdx].dimmer,
          val,
          alpha,
        );
        cellStates[cellIdx].dimmerTouched = true;
        fxStates[cellToFixture[cellIdx]].anyCellTouched = true;
        fxStates[cellToFixture[cellIdx]].anyCellDimmerTouched = true;
      }
    } else if (spec.trait_kind === "color") {
      const pal = spec.palette_ref
        ? show.color_palettes.find((p) => p.id === spec.palette_ref)
        : undefined;
      for (const [cellIdx, u] of cells) {
        const rgb = pal
          ? sampleOklabStopsLinear(getPaletteColors(pal), u, 1, false, false)
          : sampleOklabGradientLinear(spec.hex_start, spec.hex_end, u);
        cellStates[cellIdx].color = [
          applyScalarMerge(spec.op, cellStates[cellIdx].color[0], rgb[0], alpha),
          applyScalarMerge(spec.op, cellStates[cellIdx].color[1], rgb[1], alpha),
          applyScalarMerge(spec.op, cellStates[cellIdx].color[2], rgb[2], alpha),
        ];
        cellStates[cellIdx].colorTouched = true;
        fxStates[cellToFixture[cellIdx]].anyCellTouched = true;
      }
    } else if (spec.trait_kind === "master_dimmer") {
      for (const fxIdx of fixtures) {
        fxStates[fxIdx].masterDimmer = applyScalarMerge(
          spec.op,
          fxStates[fxIdx].masterDimmer,
          spec.value,
          alpha,
        );
        fxStates[fxIdx].masterTouched = true;
      }
    } else if (spec.trait_kind === "shutter" && alpha > 0.5) {
      for (const fxIdx of fixtures) {
        fxStates[fxIdx].shutter = spec.state;
      }
    }
  }

  for (const fxSt of fxStates) {
    if (!fxSt.masterTouched && fxSt.anyCellDimmerTouched) fxSt.masterDimmer = 1;
    if (blackout) fxSt.masterDimmer = 0;
    else if (!fxSt.anyCellDimmerTouched && fxSt.masterTouched) {
      fxSt.masterDimmer = clamp01(fxSt.masterDimmer * clamp01(grandMaster));
    }
  }
  const gmClamped = clamp01(grandMaster);
  cellStates.forEach((cellSt, cellIdx) => {
    if (blackout) {
      cellSt.dimmer = 0;
      return;
    }
    const fxSt = fxStates[cellToFixture[cellIdx]];
    if (cellSt.dimmerTouched) {
      cellSt.dimmer = clamp01(cellSt.dimmer * gmClamped);
    } else if (
      fxSt &&
      fxSt.masterTouched &&
      !fxSt.anyCellDimmerTouched &&
      fxSt.masterDimmer > 0
    ) {
      cellSt.dimmer = 1.0;
    } else {
      cellSt.dimmer = 0;
    }
  });

  let softwareStrobeClamped = false;

  show.patch.forEach((inst, fxIdx) => {
    const detail = fixtureDetailsCache[inst.profile];
    const mode = detail?.expanded_modes.find((m) => m.name === inst.mode);
    const channels = mode?.channels ?? [];
    const cellStart = fixtureCellStarts[fxIdx] ?? 0;
    const cellCount = fixtureCellCounts[fxIdx] ?? 1;
    const fxSt = fxStates[fxIdx];
    const cal = inst.calibration;

    const hasHwShutter = channels.some((c) => c.role.kind === "shutter_strobe");
    const [strobeGate, clamped] = hasHwShutter
      ? [1, false]
      : softwareStrobeGateTs(fxSt.shutter, tSec, fxIdx);
    if (clamped) softwareStrobeClamped = true;

    const hasMasterInt = channels.some(
      (c) => c.target.scope === "fixture" && c.role.kind === "intensity",
    );
    const hasWhite = channels.some(
      (c) =>
        c.role.kind === "color_intensity" &&
        ["White", "Warm White", "Cold White"].includes(c.role.color),
    );

    for (const ch of channels) {
      const linear = inst.address + ch.dmx_offset;
      const uId = linear <= 512 ? inst.universe : inst.universe + 1;
      const addr = linear <= 512 ? linear : linear - 512;
      const buf = uniMap.get(uId);
      if (!buf || addr < 1 || addr > 512) continue;

      if (ch.role.kind === "fine_alias") continue;
      if (ch.role.kind === "unmapped") {
        const lowerName = ch.name.toLowerCase();
        const customVal =
          fxSt.customChannels[lowerName] ??
          (lowerName.includes("pan") ? fxSt.customChannels["pan"] : undefined) ??
          (lowerName.includes("tilt") ? fxSt.customChannels["tilt"] : undefined);
        buf[addr - 1] =
          customVal !== undefined
            ? Math.round(clamp01(customVal) * 255)
            : ch.default_value;
        continue;
      }
      if (ch.role.kind === "shutter_strobe") {
        buf[addr - 1] = mapShutterChannelTs(fxSt.shutter, ch);
        continue;
      }
      if (ch.role.kind === "intensity") {
        if (ch.target.scope === "fixture") {
          const val =
            cellCount <= 1
              ? clamp01(
                  (cellStates[cellStart]?.dimmer ?? 1) *
                    fxSt.masterDimmer *
                    strobeGate,
                )
              : clamp01(fxSt.masterDimmer * strobeGate);
          buf[addr - 1] = quantizeChannelValue(
            val,
            cal.gamma,
            cal.min_dimmer_dmx,
            cal.max_dimmer_dmx,
            true,
          );
        } else {
          const val = clamp01(
            (cellStates[cellStart + ch.target.cell_index]?.dimmer ?? 0) *
              strobeGate,
          );
          buf[addr - 1] = quantizeChannelValue(
            val,
            cal.gamma,
            cal.min_dimmer_dmx,
            cal.max_dimmer_dmx,
            true,
          );
        }
        continue;
      }
      if (ch.role.kind === "color_intensity") {
        const localIdx = ch.target.scope === "cell" ? ch.target.cell_index : 0;
        const cellSt = cellStates[cellStart + localIdx] ?? {
          dimmer: 0,
          color: [0, 0, 0] as [number, number, number],
        };
        const cellHasDedicatedInt =
          channels.some(
            (c) =>
              c.target.scope === "cell" &&
              c.target.cell_index === localIdx &&
              c.role.kind === "intensity",
          ) || (cellCount === 1 && hasMasterInt);

        const perceptualRgb: [number, number, number] = [
          linearChToSrgb(cellSt.color[0]),
          linearChToSrgb(cellSt.color[1]),
          linearChToSrgb(cellSt.color[2]),
        ];

        const [rw, gw, bw, ww] = hasWhite
          ? extractRgbw(
              perceptualRgb[0],
              perceptualRgb[1],
              perceptualRgb[2],
              cal.white_mode,
              cal.white_gain,
              cal.gamma,
            )
          : [perceptualRgb[0], perceptualRgb[1], perceptualRgb[2], 0];

        let comp = 0;
        if (ch.role.color === "Red") comp = rw;
        else if (ch.role.color === "Green") comp = gw;
        else if (ch.role.color === "Blue") comp = bw;
        else if (["White", "Warm White", "Cold White"].includes(ch.role.color))
          comp = ww;
        else if (ch.role.color === "Amber")
          comp = Math.min(perceptualRgb[0], perceptualRgb[1] * 1.5);
        else if (ch.role.color === "Yellow")
          comp = Math.min(perceptualRgb[0], perceptualRgb[1]);
        else if (ch.role.color === "Cyan")
          comp = Math.min(perceptualRgb[1], perceptualRgb[2]);
        else if (ch.role.color === "Magenta")
          comp = Math.min(perceptualRgb[0], perceptualRgb[2]);

        if (cellHasDedicatedInt) {
          buf[addr - 1] = quantizeChannelValue(
            comp,
            cal.gamma,
            cal.min_dimmer_dmx,
            cal.max_dimmer_dmx,
            false,
          );
        } else {
          buf[addr - 1] = quantizeChannelValue(
            clamp01(comp * cellSt.dimmer * strobeGate),
            cal.gamma,
            cal.min_dimmer_dmx,
            cal.max_dimmer_dmx,
            true,
          );
        }
      }
    }
  });

  return { dmxByUniverse, softwareStrobeClamped };
}
