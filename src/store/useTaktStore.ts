import { Channel, invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  decodeBinaryFrame,
  DMX_UNIVERSE_CHANNELS,
  encodeBinaryFrame,
  normalizeFramePayload,
} from "../lib/frameDecoder";
import {
  FixtureDetail,
  FixtureSummary,
  FixtureValidationResult,
  getDefaultShippedFixtures,
  sanitizeSlug,
  SchemaValidationIssue,
  validateAndExpandOflLocally,
} from "../lib/oflBuilder";
import {
  type ActiveSceneInstance,
  analyzeSyntheticTimelineAudio,
  type AudioAnalysisResult,
  type AudioTrackDef,
  type BeatClockAnchor,
  type ClipDef,
  ColorPaletteDef,
  computeBeatAt,
  computeSceneAlphaAt,
  DEFAULT_COLOR_PALETTES,
  DimmerPaletteDef,
  dmxToPerceptualU8,
  type DurationUnit,
  evaluateSimulationLayersToDmx,
  type FxBlockDef,
  type FxElementDef,
  type FxKindTag,
  type MergeOp,
  type SceneDef,
  type Shader2DKind,
  SmartControlLayer,
  type TempoPointDef,
  type TimelineDef,
  type TrackDef,
  type TrackType,
  type Waveform1D,
} from "../lib/mixerLogic";
import { computeTimelineContentDurationSec } from "../lib/timelineLogic";
import {
  CompiledCell,
  defaultCalibration,
  FixtureCalibration,
  FixtureGroupDef,
  FixtureInstance,
  getFixtureFootprint,
  GridPos,
  OrderRuleStr,
  previewPlacement,
  ShowStateDto,
  transformCellUv,
} from "../lib/patchLogic";

export type DisplayFormat = "DEC" | "HEX" | "PCT";
export type StudioOutputMode = "edit_preview" | "blind" | "live";
export type StudioSubMode = "builder" | "live_busking" | "timeline";
export type MappingOverlayMode = "off" | "key" | "midi";

export interface BankDefaultFade {
  fadeInSec: number;
  fadeOutSec: number;
}

export interface GroupMixerStripState {
  dimmer: number;
  hueShiftDeg: number;
  saturation: number;
  strobeEnabled: boolean;
  strobeHz: number;
  mode: "normal" | "full" | "exclusive_full" | "blackout";
  flashActive: boolean;
  exclusiveFlashActive: boolean;
}

export type CellSelectionPattern =
  | "all"
  | "1/2"
  | "1/3"
  | "1/4"
  | "invert"
  | "shift_left"
  | "shift_right";

export type WorkspaceTab =
  | "monitor"
  | "patch"
  | "studio"
  | "grid"
  | "palettes"
  | "scenes"
  | "timeline"
  | "fixtures";

export type ArtNetOutputMode =
  | { mode: "broadcast" }
  | { mode: "unicast"; target_ip: string };

export type SacnOutputMode =
  | { mode: "multicast" }
  | { mode: "unicast"; target_ip: string };

export type ProtocolKind =
  | {
      protocol: "art_net";
      mode: ArtNetOutputMode;
      net: number;
      subnet: number;
      uni: number;
    }
  | {
      protocol: "sacn";
      mode: SacnOutputMode;
      sacn_universe: number;
      priority: number;
    };

export interface UniverseConfig {
  id: number;
  protocol: ProtocolKind;
  review_output?: boolean;
}

export interface NetworkInterfaceInfo {
  name: string;
  ipv4: string;
  netmask: string;
  broadcast: string;
  subnet_cidr: string;
}

export type AdapterSelection =
  | { mode: "auto" }
  | { mode: "offline" }
  | { mode: "named"; name: string; subnet_cidr: string };

export interface ArtPollReplyNode {
  ip: string;
  port: number;
  net_switch: number;
  sub_switch: number;
  short_name: string;
  long_name: string;
  num_ports: number;
  sw_out: number[];
  mac: number[];
}

export interface TrackedArtNetNode {
  node: ArtPollReplyNode;
  last_seen_sec: number;
  online: boolean;
}

export interface ParkedChannelDto {
  universe: number;
  channel: number;
  value: number;
}

export interface JitterStatsDto {
  mean_us: number;
  max_jitter_us: number;
  p99_jitter_us: number;
  dropped_frames: number;
  sample_count: number;
}

export interface EngineSnapshotDto {
  grand_master: number;
  blackout: boolean;
  parked_channels: ParkedChannelDto[];
  live_layers: SmartControlLayer[];
  active_scenes: ActiveSceneInstance[];
  live_bpm: number;
  active_timeline_id: string | null;
  timeline_playing: boolean;
  timeline_playhead_sec: number;
  latency_offset_ms: number;
  universes: UniverseConfig[];
  interfaces: NetworkInterfaceInfo[];
  adapter_selection: AdapterSelection;
  is_offline: boolean;
  output_enabled?: boolean;
  discovery_available: boolean;
  active_interface: NetworkInterfaceInfo | null;
  discovered_nodes: TrackedArtNetNode[];
  jitter_stats: JitterStatsDto;
  jitter_samples_us: number[];
}

export interface ShowSnapshotDto {
  revision: number;
  show: ShowStateDto;
  compiled_cells: CompiledCell[];
  can_undo: boolean;
  can_redo: boolean;
  rollover_enabled: boolean;
  toast: string | null;
  cross_protocol_warning: boolean;
}

export interface TelemetrySummary {
  revision: bigint;
  tSec: number;
  meanUs: number;
  maxJitterUs: number;
  p99JitterUs: number;
  droppedFrames: number;
}

interface SimUndoEntry {
  show: ShowStateDto;
  coalesceKey: string | null;
}

export function parkKey(universe: number, channel: number): string {
  return `${universe}:${channel}`;
}

export function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const DEFAULT_UNIVERSES: UniverseConfig[] = [
  {
    id: 1,
    review_output: false,
    protocol: {
      protocol: "art_net",
      mode: { mode: "broadcast" },
      net: 0,
      subnet: 0,
      uni: 0,
    },
  },
  {
    id: 2,
    review_output: false,
    protocol: {
      protocol: "sacn",
      mode: { mode: "multicast" },
      sacn_universe: 2,
      priority: 100,
    },
  },
];

function createInitialShowState(): ShowStateDto {
  return {
    version: "1.0",
    name: "Untitled Show",
    bpm: 120.0,
    read_only_newer_version: false,
    network_outputs: {
      frame_rate_hz: 44,
      adapter: "auto",
      subnet: null,
      offline_fallback: true,
      artsync: true,
      universes: DEFAULT_UNIVERSES,
    },
    color_palettes: structuredClone(DEFAULT_COLOR_PALETTES),
    dimmer_palettes: [
      {
        id: "dim_full",
        name: "Full Intensity",
        value_start: 1.0,
        value_end: 1.0,
      },
    ],
    patch: [],
    groups: [],
    fx_library: [
      {
        id: "blk_cyber_wave",
        name: "Cyberpunk Wave",
        target_group: "all",
        duration_beats: 4,
        duration_sec: null,
        loop_block: true,
        elements: [
          {
            kind: "static_trait",
            trait: "dimmer",
            op: "htp",
            palette_ref: "dim_full",
            value_start: null,
            value_end: null,
            order: null,
          },
          {
            kind: "static_trait",
            trait: "color",
            op: "ltp",
            palette_ref: "pal_cyber",
            value_start: null,
            value_end: null,
            order: "mirror",
          },
        ],
      },
    ],
    scenes: [
      {
        id: "sc_new_1",
        name: "New Scene",
        bank: "Bank 1",
        target_group: null,
        priority: 10,
        fade_in_sec: 0,
        fade_out_sec: 0,
        duration_value: 4,
        duration_unit: "beats",
        block_refs: [],
      },
      {
        id: "sc_tl_cyber_intro",
        name: "Cyber Intro",
        bank: "Bank 1",
        target_group: null,
        priority: 10,
        fade_in_sec: 0,
        fade_out_sec: 0,
        duration_value: 16,
        duration_unit: "seconds",
        block_refs: [],
        timeline_ref: "tl_cyber_intro",
      },
    ],
    timelines: [
      {
        id: "tl_cyber_intro",
        name: "Cyber Intro",
        duration_sec: 16.0,
        grid_offset_sec: 0.0,
        tempo_map: [{ at_sec: 0.0, bpm: 120.0 }],
        audio_track: null,
        loop_timeline: false,
        tracks: [
          {
            id: "trk_1",
            name: "Tube Wave",
            track_type: "effect",
            target_group: "all",
            clips: [
              {
                ref_block: "blk_cyber_wave",
                start_sec: 0.0,
                duration_sec: 8.0,
                fade_in_sec: 0.0,
                fade_out_sec: 0.0,
                inline_fx: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

function createInitialDmxMap(
  universes: UniverseConfig[],
): Record<number, Uint8Array> {
  const map: Record<number, Uint8Array> = {};
  for (const u of universes) {
    map[u.id] = new Uint8Array(DMX_UNIVERSE_CHANNELS);
  }
  return map;
}

function compileCellsLocally(
  patch: FixtureInstance[],
  cache: Record<string, FixtureDetail>,
): CompiledCell[] {
  const cells: CompiledCell[] = [];
  patch.forEach((inst, fxIdx) => {
    const detail = cache[inst.profile];
    const mode = detail?.expanded_modes.find((m) => m.name === inst.mode);
    const modeCells = mode?.cells ?? [
      { cell_index: 0, pixel_key: "1", grid_xyz: [0, 0, 0], local_uv: [0, 0] },
    ];
    for (const c of modeCells) {
      cells.push({
        fixture_index: fxIdx,
        fixture_id: inst.id,
        cell_index: c.cell_index,
        pixel_key: c.pixel_key,
        canvas_xy: transformCellUv(inst.grid_pos, c.local_uv),
      });
    }
  });
  return cells;
}

function createInitialState() {
  const shipped = getDefaultShippedFixtures();
  const detailsCache: Record<string, FixtureDetail> = {};
  for (const item of shipped) {
    detailsCache[item.summary.id] = item;
  }

  return {
    activeTab: "patch" as WorkspaceTab,
    selectedUniverseId: 1,
    universes: DEFAULT_UNIVERSES,
    dmxByUniverse: createInitialDmxMap(DEFAULT_UNIVERSES),
    parkedChannels: {} as Record<string, number>,
    blackout: false,
    grandMaster: 1.0,
    displayFormat: "DEC" as DisplayFormat,
    adapterSelection: { mode: "auto" } as AdapterSelection,
    interfaces: [] as NetworkInterfaceInfo[],
    isOffline: true,
    discoveryAvailable: false,
    activeInterface: null as NetworkInterfaceInfo | null,
    discoveredNodes: [] as TrackedArtNetNode[],
    telemetry: {
      revision: 0n,
      tSec: 0,
      meanUs: 22727.0,
      maxJitterUs: 0.0,
      p99JitterUs: 0.0,
      droppedFrames: 0,
    },
    jitterSamplesUs: [] as number[],
    histogramOpen: true,
    selectedChannel: null as number | null,
    connectedMode: isTauriEnvironment()
      ? ("tauri" as const)
      : ("simulation" as const),
    fixtureSummaries: shipped.map((d) => d.summary),
    fixtureDetailsCache: detailsCache,
    selectedFixtureId: shipped[0]?.summary.id ?? null,

    showState: createInitialShowState(),
    liveLayers: [] as SmartControlLayer[],
    activeScenes: [] as ActiveSceneInstance[],
    liveBpm: 120,
    activeTimelineId: null as string | null,
    timelinePlaying: false,
    timelinePlayheadSec: 0,
    timelinePlayheadAnchorMs: typeof performance !== "undefined" ? performance.now() : 0,
    latencyOffsetMs: 0,
    _simTimelineAnchorTSec: 0,
    audioAnalysisByTimeline: {} as Record<string, AudioAnalysisResult>,
    audioAnalysisByClipKey: {} as Record<string, AudioAnalysisResult>,
    selectedTimelineClip: null as { trackId: string; clipIndex: number } | null,
    timelineTimeUnit: "beats" as "beats" | "seconds",
    timelineSensitivity: 0.65,
    timelineShowTransients: true,
    timelineProjectTransients: false,
    compiledCells: [] as CompiledCell[],
    cellPreviewRgbd: new Uint8Array(0),
    canUndo: false,
    canRedo: false,
    rolloverEnabled: true,
    patchToast: null as string | null,
    crossProtocolWarning: false,
    selectedFixtureInstanceId: null as string | null,
    selectedFixtureIds: [] as string[],
    sceneBanks: ["Bank 1"],
    stackableBanks: {} as Record<string, boolean>,
    focusedPatchUniverse: 1,
    outputEnabled: false,
    showRevision: 0,
    savedRevision: 0,
    isDirty: false,
    closePromptOpen: false,

    studioOutputMode: "live" as StudioOutputMode,
    studioSubMode: "builder" as StudioSubMode,
    selectedSceneId: "sc_new_1" as string | null,
    multiSelectedSceneIds: [] as string[],
    bankDefaultFades: {
      "Bank 1": { fadeInSec: 0, fadeOutSec: 0 },
    } as Record<string, BankDefaultFade>,
    flashSceneIds: {} as Record<string, boolean>,
    groupMixerStrips: {} as Record<string, GroupMixerStripState>,
    mappingOverlayMode: "off" as MappingOverlayMode,
    selectedMappingTarget: null as string | null,
    keyBindings: { sc_new_1: "1" } as Record<string, string>,
    midiBindings: { sc_new_1: "Note 36" } as Record<string, string>,
    selectedCellIndices: [] as number[],
    activeGroupFilterId: "all",
    canvasOrderRule: "linear" as OrderRuleStr,
    activeShaderGizmoBlockId: null as string | null,
  draggingSceneId: null as string | null,

    _simUndo: [] as SimUndoEntry[],
    _simRedo: [] as SimUndoEntry[],
    _simNextSeq: 1,
    _simSceneSeq: 1,
    _simBeatClock: { bpm: 120, t_anchor_sec: 0, beat_anchor: 0 } as BeatClockAnchor,
    _simTapHistory: [] as number[],
  };
}

function hsvToHex(hueDeg: number, sat: number, val = 1): string {
  const h = (((hueDeg % 360) + 360) % 360) / 60;
  const s = Math.max(0, Math.min(1, sat));
  const v = Math.max(0, Math.min(1, val));
  const c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 1) [r, g, b] = [c, x, 0];
  else if (h < 2) [r, g, b] = [x, c, 0];
  else if (h < 3) [r, g, b] = [0, c, x];
  else if (h < 4) [r, g, b] = [0, x, c];
  else if (h < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toByte = (n: number) =>
    Math.round(Math.max(0, Math.min(1, n + m)) * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

function buildGroupMixerOverlayLayers(
  strips: Record<string, GroupMixerStripState>,
  hasLiveOrSceneBase: boolean,
): SmartControlLayer[] {
  const entries = Object.entries(strips);
  if (entries.length === 0) return [];
  const layers: SmartControlLayer[] = [];
  let seq = 10000;

  const exclusiveTargets = entries
    .filter(([, st]) => st.exclusiveFlashActive || st.mode === "exclusive_full")
    .map(([id]) => id);

  if (exclusiveTargets.length > 0) {
    layers.push({
      id: "_gm_excl_blackout",
      name: "Exclusive Blackout",
      enabled: true,
      priority: 900,
      trigger_order: seq++,
      alpha: 1,
      target: "all",
      order_override: null,
      trait_spec: {
        trait_kind: "dimmer",
        op: "ltp",
        palette_ref: null,
        value_start: 0,
        value_end: 0,
      },
    });
  }

  for (const [targetId, st] of entries) {
    const isBoost =
      st.exclusiveFlashActive ||
      st.flashActive ||
      st.mode === "full" ||
      st.mode === "exclusive_full";
    const isBlackout = st.mode === "blackout" && !st.flashActive && !st.exclusiveFlashActive;

    if (isBlackout) {
      layers.push({
        id: `_gm_bo_${targetId}`,
        name: `Blackout ${targetId}`,
        enabled: true,
        priority: 910,
        trigger_order: seq++,
        alpha: 1,
        target: targetId,
        order_override: null,
        trait_spec: {
          trait_kind: "dimmer",
          op: "ltp",
          palette_ref: null,
          value_start: 0,
          value_end: 0,
        },
      });
    } else if (isBoost) {
      layers.push({
        id: `_gm_boost_${targetId}`,
        name: `Full ${targetId}`,
        enabled: true,
        priority: 915,
        trigger_order: seq++,
        alpha: 1,
        target: targetId,
        order_override: null,
        trait_spec: {
          trait_kind: "dimmer",
          op: "htp",
          palette_ref: null,
          value_start: 1,
          value_end: 1,
        },
      });
      if (!hasLiveOrSceneBase && st.hueShiftDeg === 0 && st.saturation >= 0.99) {
        layers.push({
          id: `_gm_boost_col_${targetId}`,
          name: `Full White ${targetId}`,
          enabled: true,
          priority: 914,
          trigger_order: seq++,
          alpha: 1,
          target: targetId,
          order_override: null,
          trait_spec: {
            trait_kind: "color",
            op: "htp",
            palette_ref: null,
            hex_start: "#FFFFFF",
            hex_end: "#FFFFFF",
          },
        });
      }
    } else if (st.dimmer < 0.999) {
      layers.push({
        id: `_gm_dim_${targetId}`,
        name: `Dimmer ${targetId}`,
        enabled: true,
        priority: 912,
        trigger_order: seq++,
        alpha: 1,
        target: targetId,
        order_override: null,
        trait_spec: {
          trait_kind: "dimmer",
          op: "scale",
          palette_ref: null,
          value_start: st.dimmer,
          value_end: st.dimmer,
        },
      });
    }

    if (st.hueShiftDeg !== 0 || st.saturation < 0.99) {
      const hex = hsvToHex(st.hueShiftDeg, st.saturation, 1);
      layers.push({
        id: `_gm_col_${targetId}`,
        name: `Color ${targetId}`,
        enabled: true,
        priority: 918,
        trigger_order: seq++,
        alpha: 1,
        target: targetId,
        order_override: null,
        trait_spec: {
          trait_kind: "color",
          op: "ltp",
          palette_ref: null,
          hex_start: hex,
          hex_end: hex,
        },
      });
    }

    if (st.strobeEnabled) {
      layers.push({
        id: `_gm_shutter_${targetId}`,
        name: `Strobe ${targetId}`,
        enabled: true,
        priority: 920,
        trigger_order: seq++,
        alpha: 1,
        target: targetId,
        order_override: null,
        trait_spec: {
          trait_kind: "shutter",
          state: { kind: "strobe_hz", hz: st.strobeHz },
        },
      });
    }
  }

  return layers;
}

function computeCellPreviewRgbdFromDmx(
  show: ShowStateDto,
  fixtureDetailsCache: Record<string, FixtureDetail>,
  universes: UniverseConfig[],
  universeBuffers: Uint8Array[],
  cellCountTotal: number,
): Uint8Array {
  const uniLookup = new Map<number, Uint8Array>();
  universes.forEach((u, idx) => uniLookup.set(u.id, universeBuffers[idx]));

  const cellPreviewRgbd = new Uint8Array(cellCountTotal * 4);
  let cellOffset = 0;
  for (const inst of show.patch) {
    const detail = fixtureDetailsCache[inst.profile];
    const mode = detail?.expanded_modes.find((m) => m.name === inst.mode);
    const cellCount = mode?.cells.length ?? 1;
    const channels = mode?.channels ?? [];

    let masterDimmer: number | null = null;
    for (const ch of channels) {
      if (ch.target.scope === "fixture" && ch.role.kind === "intensity") {
        const linear = inst.address + ch.dmx_offset;
        const uId = linear <= 512 ? inst.universe : inst.universe + 1;
        const addr = linear <= 512 ? linear : linear - 512;
        const rawMaster = uniLookup.get(uId)?.[addr - 1] ?? 0;
        masterDimmer = dmxToPerceptualU8(rawMaster, inst.calibration.gamma);
      }
    }

    for (let lc = 0; lc < cellCount; lc++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let w = 0;
      let cellDim: number | null = null;
      for (const ch of channels) {
        if (ch.target.scope !== "cell" || ch.target.cell_index !== lc) continue;
        const linear = inst.address + ch.dmx_offset;
        const uId = linear <= 512 ? inst.universe : inst.universe + 1;
        const addr = linear <= 512 ? linear : linear - 512;
        const val = uniLookup.get(uId)?.[addr - 1] ?? 0;
        if (ch.role.kind === "intensity") {
          cellDim = dmxToPerceptualU8(val, inst.calibration.gamma);
        }
        if (ch.role.kind === "color_intensity") {
          if (ch.role.color === "Red") r = Math.max(r, val);
          if (ch.role.color === "Green") g = Math.max(g, val);
          if (ch.role.color === "Blue") b = Math.max(b, val);
          if (ch.role.color === "White") w = Math.max(w, val);
        }
      }
      const rr = dmxToPerceptualU8(Math.min(255, r + w), inst.calibration.gamma);
      const gg = dmxToPerceptualU8(Math.min(255, g + w), inst.calibration.gamma);
      const bb = dmxToPerceptualU8(Math.min(255, b + w), inst.calibration.gamma);
      const eff =
        cellDim !== null && masterDimmer !== null
          ? Math.floor((cellDim * masterDimmer) / 255)
          : cellDim ?? masterDimmer ?? (rr > 0 || gg > 0 || bb > 0 ? 255 : 0);
      const base = (cellOffset + lc) * 4;
      if (base + 3 < cellPreviewRgbd.length) {
        cellPreviewRgbd[base] = rr;
        cellPreviewRgbd[base + 1] = gg;
        cellPreviewRgbd[base + 2] = bb;
        cellPreviewRgbd[base + 3] = eff;
      }
    }
    cellOffset += cellCount;
  }
  return cellPreviewRgbd;
}

function synthesizeSimulationBuffer(state: {
  universes: UniverseConfig[];
  parkedChannels: Record<string, number>;
  grandMaster: number;
  blackout: boolean;
  liveLayers: SmartControlLayer[];
  activeScenes: ActiveSceneInstance[];
  studioOutputMode: StudioOutputMode;
  selectedSceneId: string | null;
  groupMixerStrips: Record<string, GroupMixerStripState>;
  _simBeatClock: BeatClockAnchor;
  activeTimelineId: string | null;
  timelinePlaying: boolean;
  timelinePlayheadSec: number;
  _simTimelineAnchorTSec: number;
  latencyOffsetMs: number;
  telemetry: TelemetrySummary;
  jitterSamplesUs: number[];
  showState: ShowStateDto;
  compiledCells: CompiledCell[];
  fixtureDetailsCache: Record<string, FixtureDetail>;
}): ArrayBuffer {
  const hasBase =
    state.activeScenes.length > 0 ||
    state.liveLayers.length > 0 ||
    state.activeTimelineId !== null;
  const mixerLayers = buildGroupMixerOverlayLayers(
    state.groupMixerStrips,
    hasBase,
  );
  const combinedLiveLayers = [...state.liveLayers, ...mixerLayers];

  const previewSceneDef =
    state.selectedSceneId && state.studioOutputMode !== "live"
      ? state.showState.scenes.find((s) => s.id === state.selectedSceneId) ?? null
      : null;

  const scenesWithPreview = (() => {
    if (!previewSceneDef) return state.activeScenes;
    const tNow = state.telemetry.tSec;
    const filtered = state.activeScenes.filter(
      (inst) => inst.scene_id !== previewSceneDef.id,
    );
    const previewInst: ActiveSceneInstance = {
      scene_id: previewSceneDef.id,
      bank: previewSceneDef.bank,
      trigger_t_sec: tNow,
      trigger_beat: computeBeatAt(state._simBeatClock, tNow),
      trigger_order: 999999,
      fade_in_sec: 0,
      fade_out_sec: 0,
      release_t_sec: null,
      release_start_alpha: 1,
    };
    return [...filtered, previewInst];
  })();

  const dmxScenes =
    state.studioOutputMode === "edit_preview"
      ? scenesWithPreview
      : state.activeScenes;

  const simOut = evaluateSimulationLayersToDmx({
    show: state.showState,
    fixtureDetailsCache: state.fixtureDetailsCache,
    liveLayers: combinedLiveLayers,
    activeScenes: dmxScenes,
    beatClock: state._simBeatClock,
    timelineState: {
      activeTimelineId: state.activeTimelineId,
      playing: state.timelinePlaying,
      playheadSec: state.timelinePlayheadSec,
      startAnchorTSec: state._simTimelineAnchorTSec,
      latencyOffsetMs: state.latencyOffsetMs,
    },
    universes: state.universes,
    grandMaster: state.grandMaster,
    blackout: state.blackout,
    tSec: state.telemetry.tSec,
  });

  const universeBuffers = state.universes.map((uni, idx) => {
    const dmx = simOut.dmxByUniverse[idx] ?? new Uint8Array(DMX_UNIVERSE_CHANNELS);
    for (const [key, val] of Object.entries(state.parkedChannels)) {
      const [uStr, chStr] = key.split(":");
      const uId = Number(uStr);
      const ch = Number(chStr);
      if (uId === uni.id && ch >= 1 && ch <= 512) {
        dmx[ch - 1] = val;
      }
    }
    return dmx;
  });

  let cellPreviewBuffers = universeBuffers;
  if (state.studioOutputMode === "blind" && previewSceneDef) {
    const blindOut = evaluateSimulationLayersToDmx({
      show: state.showState,
      fixtureDetailsCache: state.fixtureDetailsCache,
      liveLayers: combinedLiveLayers,
      activeScenes: scenesWithPreview,
      beatClock: state._simBeatClock,
      timelineState: {
        activeTimelineId: state.activeTimelineId,
        playing: state.timelinePlaying,
        playheadSec: state.timelinePlayheadSec,
        startAnchorTSec: state._simTimelineAnchorTSec,
        latencyOffsetMs: state.latencyOffsetMs,
      },
      universes: state.universes,
      grandMaster: state.grandMaster,
      blackout: state.blackout,
      tSec: state.telemetry.tSec,
    });
    cellPreviewBuffers = blindOut.dmxByUniverse;
  }

  const cellPreviewRgbd = computeCellPreviewRgbdFromDmx(
    state.showState,
    state.fixtureDetailsCache,
    state.universes,
    cellPreviewBuffers,
    state.compiledCells.length,
  );

  const samples = state.jitterSamplesUs;
  let meanUs = 22727.0;
  let maxJitterUs = 0.0;
  let p99JitterUs = 0.0;
  if (samples.length > 0) {
    meanUs = samples.reduce((acc, s) => acc + s, 0) / samples.length;
    const absJitters = samples
      .map((s) => Math.abs(s - 22727.0))
      .sort((a, b) => a - b);
    maxJitterUs = absJitters[absJitters.length - 1] ?? 0;
    const p99Idx = Math.max(
      0,
      Math.min(
        absJitters.length - 1,
        Math.ceil(0.99 * absJitters.length) - 1,
      ),
    );
    p99JitterUs = absJitters[p99Idx] ?? 0;
  }

  return encodeBinaryFrame({
    revision: state.telemetry.revision + 1n,
    tSec: state.telemetry.tSec + 0.022727,
    cellCount: state.compiledCells.length,
    droppedFrames: 0,
    meanUs,
    maxJitterUs,
    p99JitterUs,
    universes: universeBuffers,
    cellPreviewRgbd,
  });
}

function serializeShowXmlLocally(show: ShowStateDto): string {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const uniLines = show.network_outputs.universes
    .map((u) => {
      if (u.protocol.protocol === "art_net") {
        const mode = u.protocol.mode.mode;
        const target =
          u.protocol.mode.mode === "unicast"
            ? ` target_ip="${esc(u.protocol.mode.target_ip)}"`
            : "";
        return `    <Universe id="${u.id}" protocol="artnet" mode="${mode}"${target} net="${u.protocol.net}" subnet="${u.protocol.subnet}" uni="${u.protocol.uni}" />`;
      }
      const mode = u.protocol.mode.mode;
      const target =
        u.protocol.mode.mode === "unicast"
          ? ` target_ip="${esc(u.protocol.mode.target_ip)}"`
          : "";
      return `    <Universe id="${u.id}" protocol="sacn" mode="${mode}"${target} sacn_universe="${u.protocol.sacn_universe}" priority="${u.protocol.priority}" />`;
    })
    .join("\n");

  const paletteLines = [
    ...show.color_palettes.map((p) => {
      const cols =
        p.colors && p.colors.length >= 2
          ? ` colors="${esc(p.colors.join(","))}"`
          : "";
      return `    <ColorPalette id="${esc(p.id)}" name="${esc(p.name)}" hex_start="${esc(p.hex_start)}" hex_end="${esc(p.hex_end)}"${cols} />`;
    }),
    ...show.dimmer_palettes.map(
      (d) =>
        `    <DimmerPalette id="${esc(d.id)}" name="${esc(d.name)}" value_start="${d.value_start}" value_end="${d.value_end}" />`,
    ),
  ].join("\n");

  const patchLines = show.patch
    .map(
      (fx) => `    <FixtureInstance id="${esc(fx.id)}" profile="${esc(fx.profile)}" mode="${esc(fx.mode)}" name="${esc(fx.name)}" universe="${fx.universe}" address="${fx.address}" channel_count="${fx.channel_count}">
      <GridPos x="${fx.grid_pos.x}" y="${fx.grid_pos.y}" rotation="${fx.grid_pos.rotation}" scale_x="${fx.grid_pos.scale_x}" scale_y="${fx.grid_pos.scale_y}" />
      <Calibration gamma="${fx.calibration.gamma}" min_dimmer_dmx="${fx.calibration.min_dimmer_dmx}" max_dimmer_dmx="${fx.calibration.max_dimmer_dmx}" white_mode="${fx.calibration.white_mode}" white_gain="${fx.calibration.white_gain}" />
    </FixtureInstance>`,
    )
    .join("\n");

  const groupLines = show.groups
    .map((g) => {
      const targetLines = g.targets
        .map((t) => `      <Target ref="${esc(t)}" />`)
        .join("\n");
      return `    <Group id="${esc(g.id)}" name="${esc(g.name)}" order="${esc(g.order)}">\n${targetLines}\n    </Group>`;
    })
    .join("\n");

  const serializeFxElementsXml = (
    elements: FxElementDef[],
    indent: string,
    escFn: (s: string) => string,
  ): string =>
    elements
      .map((el) => {
        if (el.kind === "static_trait") {
          const pr = el.palette_ref ? ` palette_ref="${escFn(el.palette_ref)}"` : "";
          const vs = el.value_start !== null ? ` value_start="${el.value_start}"` : "";
          const ve = el.value_end !== null ? ` value_end="${el.value_end}"` : "";
          const ord = el.order ? ` order="${escFn(el.order)}"` : "";
          return `${indent}<StaticTrait trait="${escFn(el.trait)}" op="${escFn(el.op)}"${pr}${vs}${ve}${ord} />`;
        }
        if (el.kind === "curve_1d") {
          const rb = el.rate_beats !== null ? ` rate_beats="${el.rate_beats}"` : "";
          const sh = el.speed_hz !== null ? ` speed_hz="${el.speed_hz}"` : "";
          const rc = el.rate_cycles != null ? ` rate_cycles="${el.rate_cycles}"` : "";
          const pd = el.phase_deg ? ` phase_deg="${el.phase_deg}"` : "";
          const dy = el.duty !== null ? ` duty="${el.duty}"` : "";
          const gs = el.grayscale ? ` grayscale="true"` : "";
          const cw = el.color_width !== undefined && el.color_width !== 1 ? ` color_width="${el.color_width}"` : "";
          const gr = el.gradient !== undefined && el.gradient !== 1 ? ` gradient="${el.gradient}"` : "";
          const ang = el.angle_deg ? ` angle_deg="${el.angle_deg}"` : "";
          const tagAttr = el.fx_kind_tag ? ` fx_kind_tag="${escFn(el.fx_kind_tag)}"` : "";
          const ic = el.inline_colors && el.inline_colors.length > 0 ? ` inline_colors="${escFn(el.inline_colors.join(","))}"` : "";
          const vs = el.value_stops && el.value_stops.length > 0 ? ` value_stops="${el.value_stops.join(",")}"` : "";
          const pr = el.palette_ref ? ` palette_ref="${escFn(el.palette_ref)}"` : "";
          const ord = el.order ? ` order="${escFn(el.order)}"` : "";
          return `${indent}<Curve1D trait="${escFn(el.trait)}" op="${escFn(el.op)}" waveform="${escFn(el.waveform)}" amplitude="${el.amplitude}" offset="${el.offset}"${rb}${sh}${rc}${pd} phase_spread_deg="${el.phase_spread_deg}"${dy}${gs}${cw}${gr}${ang}${tagAttr}${ic}${vs}${pr}${ord} />`;
        }
        if (el.kind === "step_chase") {
          const sb = el.step_beats !== null ? ` step_beats="${el.step_beats}"` : "";
          const sh = el.speed_hz !== null ? ` speed_hz="${el.speed_hz}"` : "";
          const rc = el.rate_cycles != null ? ` rate_cycles="${el.rate_cycles}"` : "";
          const ow = el.one_way === false ? ` one_way="false"` : "";
          const px = el.pixels_on != null ? ` pixels_on="${el.pixels_on}"` : "";
          const ar = el.active_ratio !== null ? ` active_ratio="${el.active_ratio}"` : "";
          const pr = el.palette_ref ? ` palette_ref="${escFn(el.palette_ref)}"` : "";
          const ord = el.order ? ` order="${escFn(el.order)}"` : "";
          return `${indent}<StepChase trait="${escFn(el.trait)}" op="${escFn(el.op)}"${sb}${sh}${rc}${ow}${px}${ar} fade="${el.fade}" amplitude="${el.amplitude}"${pr}${ord} />`;
        }
        const rb = el.rate_beats !== null ? ` rate_beats="${el.rate_beats}"` : "";
        const sh = el.speed_hz !== null ? ` speed_hz="${el.speed_hz}"` : "";
        const rc = el.rate_cycles != null ? ` rate_cycles="${el.rate_cycles}"` : "";
        const cw = el.color_width !== undefined && el.color_width !== 1 ? ` color_width="${el.color_width}"` : "";
        const gr = el.gradient !== undefined && el.gradient !== 1 ? ` gradient="${el.gradient}"` : "";
        const gs = el.grayscale ? ` grayscale="true"` : "";
        const tr = el.transform ? ` transform="${escFn(el.transform)}"` : "";
        const ic = el.inline_colors && el.inline_colors.length > 0 ? ` inline_colors="${escFn(el.inline_colors.join(","))}"` : "";
        const vs = el.value_stops && el.value_stops.length > 0 ? ` value_stops="${el.value_stops.join(",")}"` : "";
        const pr = el.palette_ref ? ` palette_ref="${escFn(el.palette_ref)}"` : "";
        return `${indent}<SpatialShader2D trait="${escFn(el.trait)}" op="${escFn(el.op)}" shader="${escFn(el.shader)}"${pr}${rb}${sh}${rc} spatial_freq="${el.spatial_freq}"${cw}${gr}${gs}${tr}${ic}${vs} direction_deg="${el.direction_deg}" center_x="${el.center_x}" center_y="${el.center_y}" />`;
      })
      .join("\n");

  const fxLines = show.fx_library
    .map((b) => {
      const elemLines = serializeFxElementsXml(b.elements, "      ", esc);
      const tg = b.target_group ? ` target_group="${esc(b.target_group)}"` : "";
      const ds = b.duration_sec != null ? ` duration_sec="${b.duration_sec}"` : "";
      return `    <FxBlock id="${esc(b.id)}" name="${esc(b.name)}"${tg} duration_beats="${b.duration_beats}"${ds} loop="${b.loop_block}">\n${elemLines}\n    </FxBlock>`;
    })
    .join("\n");

  const sceneLines = show.scenes
    .map((sc) => {
      const bStr = sc.bank ? ` bank="${esc(sc.bank)}"` : "";
      const tg = sc.target_group ? ` target_group="${esc(sc.target_group)}"` : "";
      const dv = sc.duration_value ?? 4;
      const du = sc.duration_unit ?? "beats";
      const tr = sc.timeline_ref ? ` timeline_ref="${esc(sc.timeline_ref)}"` : "";
      const refs = sc.block_refs
        .map((r) => `      <BlockRef ref="${esc(r)}" />`)
        .join("\n");
      return `    <Scene id="${esc(sc.id)}" name="${esc(sc.name)}"${bStr}${tg} priority="${sc.priority}" fade_in_sec="${sc.fade_in_sec}" fade_out_sec="${sc.fade_out_sec}" duration_value="${dv}" duration_unit="${du}"${tr}>\n${refs}\n    </Scene>`;
    })
    .join("\n");

  const timelineLines = show.timelines
    .map((tl) => {
      const tempoLines = tl.tempo_map
        .map((pt) => `        <Tempo at_sec="${pt.at_sec}" bpm="${pt.bpm}" />`)
        .join("\n");
      const audioLine = tl.audio_track
        ? `      <AudioTrack file="${esc(tl.audio_track.file)}"${tl.audio_track.abs_fallback ? ` abs_fallback="${esc(tl.audio_track.abs_fallback)}"` : ""}${tl.audio_track.sha256 ? ` sha256="${esc(tl.audio_track.sha256)}"` : ""} offset_sec="${tl.audio_track.offset_sec}" transient_sensitivity="${tl.audio_track.transient_sensitivity}" />\n`
        : "";
      const trackLines = tl.tracks
        .map((trk) => {
          const tg = trk.target_group ? ` target_group="${esc(trk.target_group)}"` : "";
          const tt = trk.track_type ? ` track_type="${esc(trk.track_type)}"` : "";
          const clipLines = trk.clips
            .map((clip) => {
              const rb = clip.ref_block ? ` ref_block="${esc(clip.ref_block)}"` : "";
              const af = clip.audio_file ? ` audio_file="${esc(clip.audio_file)}"` : "";
              if (clip.inline_fx.length === 0) {
                return `        <Clip${rb}${af} start_sec="${clip.start_sec}" duration_sec="${clip.duration_sec}" fade_in_sec="${clip.fade_in_sec}" fade_out_sec="${clip.fade_out_sec}" />`;
              }
              const inlineXml = serializeFxElementsXml(clip.inline_fx, "          ", esc);
              return `        <Clip${rb}${af} start_sec="${clip.start_sec}" duration_sec="${clip.duration_sec}" fade_in_sec="${clip.fade_in_sec}" fade_out_sec="${clip.fade_out_sec}">\n${inlineXml}\n        </Clip>`;
            })
            .join("\n");
          return `      <Track id="${esc(trk.id)}" name="${esc(trk.name)}"${tt}${tg}>\n${clipLines}\n      </Track>`;
        })
        .join("\n");
      const lp = tl.loop_timeline ? ` loop_timeline="true"` : "";
      return `    <Timeline id="${esc(tl.id)}" name="${esc(tl.name)}" duration_sec="${tl.duration_sec}" grid_offset_sec="${tl.grid_offset_sec}"${lp}>\n      <TempoMap>\n${tempoLines}\n      </TempoMap>\n${audioLine}${trackLines}\n    </Timeline>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<TaktLightShow version="1.0" name="${esc(show.name)}" bpm="${show.bpm}">
  <NetworkOutputs frame_rate_hz="${show.network_outputs.frame_rate_hz}" adapter="${esc(show.network_outputs.adapter)}" offline_fallback="${show.network_outputs.offline_fallback}" artsync="${show.network_outputs.artsync}">
${uniLines}
  </NetworkOutputs>
  <Palettes>
${paletteLines}
  </Palettes>
  <Patch>
${patchLines}
  </Patch>
  <Groups>
${groupLines}
  </Groups>
  <FxLibrary>
${fxLines}
  </FxLibrary>
  <Scenes>
${sceneLines}
  </Scenes>
  <Timelines>
${timelineLines}
  </Timelines>
</TaktLightShow>
`;
}

function parseShowXmlLocally(
  xmlStr: string,
  cache: Record<string, FixtureDetail>,
): ShowStateDto {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, "application/xml");
  const root = doc.querySelector("TaktLightShow");
  if (!root) {
    throw new Error("Missing <TaktLightShow> root element");
  }
  const version = root.getAttribute("version") ?? "1.0";
  const name = root.getAttribute("name") ?? "Imported Show";
  const bpm = Number(root.getAttribute("bpm") ?? "120");

  const universes: UniverseConfig[] = [];
  root.querySelectorAll("NetworkOutputs > Universe").forEach((el) => {
    const id = Number(el.getAttribute("id") ?? "1");
    const proto = el.getAttribute("protocol") ?? "artnet";
    const mode = el.getAttribute("mode") ?? "broadcast";
    const targetIp = el.getAttribute("target_ip") ?? "127.0.0.1";
    if (proto === "sacn") {
      universes.push({
        id,
        review_output: false,
        protocol: {
          protocol: "sacn",
          mode:
            mode === "unicast"
              ? { mode: "unicast", target_ip: targetIp }
              : { mode: "multicast" },
          sacn_universe: Number(el.getAttribute("sacn_universe") ?? id),
          priority: Number(el.getAttribute("priority") ?? 100),
        },
      });
    } else {
      universes.push({
        id,
        review_output: false,
        protocol: {
          protocol: "art_net",
          mode:
            mode === "unicast"
              ? { mode: "unicast", target_ip: targetIp }
              : { mode: "broadcast" },
          net: Number(el.getAttribute("net") ?? 0),
          subnet: Number(el.getAttribute("subnet") ?? 0),
          uni: Number(el.getAttribute("uni") ?? 0),
        },
      });
    }
  });

  const patch: FixtureInstance[] = [];
  root.querySelectorAll("Patch > FixtureInstance").forEach((el) => {
    const profile = el.getAttribute("profile") ?? "";
    const mode = el.getAttribute("mode") ?? "";
    const detail = cache[profile];
    const modeInfo = detail?.expanded_modes.find((m) => m.name === mode);
    const channelCount =
      Number(el.getAttribute("channel_count")) || modeInfo?.channel_count || 1;
    const gpEl = el.querySelector("GridPos");
    const calEl = el.querySelector("Calibration");
    patch.push({
      id: el.getAttribute("id") ?? `fx_${patch.length + 1}`,
      profile,
      mode,
      name: el.getAttribute("name") ?? "Fixture",
      universe: Number(el.getAttribute("universe") ?? 1),
      address: Number(el.getAttribute("address") ?? 1),
      channel_count: channelCount,
      grid_pos: {
        x: Number(gpEl?.getAttribute("x") ?? 0.5),
        y: Number(gpEl?.getAttribute("y") ?? 0.5),
        rotation: Number(gpEl?.getAttribute("rotation") ?? 0),
        scale_x: Number(gpEl?.getAttribute("scale_x") ?? 0.3),
        scale_y: Number(gpEl?.getAttribute("scale_y") ?? 0.05),
      },
      calibration: {
        gamma: Number(calEl?.getAttribute("gamma") ?? 2.2),
        min_dimmer_dmx: Number(calEl?.getAttribute("min_dimmer_dmx") ?? 0),
        max_dimmer_dmx: Number(calEl?.getAttribute("max_dimmer_dmx") ?? 255),
        white_mode:
          (calEl?.getAttribute("white_mode") as "replace" | "add" | "off") ??
          "replace",
        white_gain: Number(calEl?.getAttribute("white_gain") ?? 1.0),
      },
    });
  });

  const color_palettes: ColorPaletteDef[] = [];
  root.querySelectorAll("Palettes > ColorPalette").forEach((el) => {
    const rawColors = el.getAttribute("colors");
    const parsedColors = rawColors
      ? rawColors
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    color_palettes.push({
      id: el.getAttribute("id") ?? `pal_${color_palettes.length + 1}`,
      name: el.getAttribute("name") ?? "Color Palette",
      hex_start: el.getAttribute("hex_start") ?? "#FF5500",
      hex_end: el.getAttribute("hex_end") ?? "#2255AA",
      ...(parsedColors && parsedColors.length > 0 ? { colors: parsedColors } : {}),
    });
  });

  const dimmer_palettes: DimmerPaletteDef[] = [];
  root.querySelectorAll("Palettes > DimmerPalette").forEach((el) => {
    dimmer_palettes.push({
      id: el.getAttribute("id") ?? `dim_${dimmer_palettes.length + 1}`,
      name: el.getAttribute("name") ?? "Dimmer Palette",
      value_start: Number(el.getAttribute("value_start") ?? 1),
      value_end: Number(el.getAttribute("value_end") ?? 1),
    });
  });

  const groups: FixtureGroupDef[] = [];
  root.querySelectorAll("Groups > Group").forEach((el) => {
    const targets: string[] = [];
    el.querySelectorAll("Target").forEach((tEl) => {
      const ref = tEl.getAttribute("ref");
      if (ref) targets.push(ref);
    });
    groups.push({
      id: el.getAttribute("id") ?? `grp_${groups.length + 1}`,
      name: el.getAttribute("name") ?? "Group",
      order: (el.getAttribute("order") as OrderRuleStr) ?? "linear",
      targets,
    });
  });

  const parseFxElementsXml = (parentEl: Element): FxElementDef[] => {
    const elements: FxElementDef[] = [];
    Array.from(parentEl.children).forEach((child) => {
      const tag = child.tagName;
      const trait = child.getAttribute("trait") ?? "dimmer";
      const op = (child.getAttribute("op") as MergeOp) ?? "htp";
      const palette_ref = child.getAttribute("palette_ref");
      if (tag === "StaticTrait") {
        elements.push({
          kind: "static_trait",
          trait,
          op,
          palette_ref,
          value_start: child.getAttribute("value_start")
            ? Number(child.getAttribute("value_start"))
            : null,
          value_end: child.getAttribute("value_end")
            ? Number(child.getAttribute("value_end"))
            : null,
          order: (child.getAttribute("order") as OrderRuleStr) ?? null,
        });
      } else if (tag === "Curve1D") {
        const icAttr = child.getAttribute("inline_colors");
        const vsAttr = child.getAttribute("value_stops");
        elements.push({
          kind: "curve_1d",
          trait,
          op,
          waveform: (child.getAttribute("waveform") as Waveform1D) ?? "sine",
          amplitude: Number(child.getAttribute("amplitude") ?? 1),
          offset: Number(child.getAttribute("offset") ?? 0),
          rate_beats: child.getAttribute("rate_beats")
            ? Number(child.getAttribute("rate_beats"))
            : null,
          speed_hz: child.getAttribute("speed_hz")
            ? Number(child.getAttribute("speed_hz"))
            : null,
          rate_cycles: child.getAttribute("rate_cycles")
            ? Number(child.getAttribute("rate_cycles"))
            : null,
          phase_deg: Number(child.getAttribute("phase_deg") ?? 0),
          phase_spread_deg: Number(child.getAttribute("phase_spread_deg") ?? 0),
          duty: child.getAttribute("duty")
            ? Number(child.getAttribute("duty"))
            : null,
          grayscale: child.getAttribute("grayscale") === "true",
          color_width: child.getAttribute("color_width")
            ? Number(child.getAttribute("color_width"))
            : 1,
          gradient: child.getAttribute("gradient")
            ? Number(child.getAttribute("gradient"))
            : 1,
          angle_deg: Number(child.getAttribute("angle_deg") ?? 0),
          fx_kind_tag: (child.getAttribute("fx_kind_tag") as FxKindTag | null) ?? null,
          inline_colors: icAttr
            ? icAttr.split(",").map((s) => s.trim()).filter(Boolean)
            : [],
          value_stops: vsAttr
            ? vsAttr.split(",").map(Number).filter((n) => !Number.isNaN(n))
            : [],
          palette_ref,
          order: (child.getAttribute("order") as OrderRuleStr) ?? null,
        });
      } else if (tag === "StepChase") {
        elements.push({
          kind: "step_chase",
          trait,
          op,
          step_beats: child.getAttribute("step_beats")
            ? Number(child.getAttribute("step_beats"))
            : null,
          speed_hz: child.getAttribute("speed_hz")
            ? Number(child.getAttribute("speed_hz"))
            : null,
          rate_cycles: child.getAttribute("rate_cycles")
            ? Number(child.getAttribute("rate_cycles"))
            : null,
          one_way: child.getAttribute("one_way") !== "false",
          pixels_on: child.getAttribute("pixels_on")
            ? Number(child.getAttribute("pixels_on"))
            : null,
          active_ratio: child.getAttribute("active_ratio")
            ? Number(child.getAttribute("active_ratio"))
            : null,
          fade: Number(child.getAttribute("fade") ?? 0),
          amplitude: Number(child.getAttribute("amplitude") ?? 1),
          palette_ref,
          order: (child.getAttribute("order") as OrderRuleStr) ?? null,
        });
      } else if (tag === "SpatialShader2D") {
        const icAttr = child.getAttribute("inline_colors");
        const vsAttr = child.getAttribute("value_stops");
        elements.push({
          kind: "spatial_shader_2d",
          trait,
          op,
          shader:
            (child.getAttribute("shader") as Shader2DKind) ?? "linear_sweep",
          palette_ref,
          rate_beats: child.getAttribute("rate_beats")
            ? Number(child.getAttribute("rate_beats"))
            : null,
          speed_hz: child.getAttribute("speed_hz")
            ? Number(child.getAttribute("speed_hz"))
            : null,
          rate_cycles: child.getAttribute("rate_cycles")
            ? Number(child.getAttribute("rate_cycles"))
            : null,
          spatial_freq: Number(child.getAttribute("spatial_freq") ?? 1),
          color_width: child.getAttribute("color_width")
            ? Number(child.getAttribute("color_width"))
            : 1,
          gradient: child.getAttribute("gradient")
            ? Number(child.getAttribute("gradient"))
            : 1,
          grayscale: child.getAttribute("grayscale") === "true",
          transform: child.getAttribute("transform") ?? null,
          inline_colors: icAttr
            ? icAttr.split(",").map((s) => s.trim()).filter(Boolean)
            : [],
          value_stops: vsAttr
            ? vsAttr.split(",").map(Number).filter((n) => !Number.isNaN(n))
            : [],
          direction_deg: Number(child.getAttribute("direction_deg") ?? 0),
          center_x: Number(child.getAttribute("center_x") ?? 0.5),
          center_y: Number(child.getAttribute("center_y") ?? 0.5),
        });
      }
    });
    return elements;
  };

  const fx_library: FxBlockDef[] = [];
  root.querySelectorAll("FxLibrary > FxBlock").forEach((el) => {
    fx_library.push({
      id: el.getAttribute("id") ?? `blk_${fx_library.length + 1}`,
      name: el.getAttribute("name") ?? "FX Block",
      target_group: el.getAttribute("target_group"),
      duration_beats: Number(el.getAttribute("duration_beats") ?? 4),
      duration_sec: el.getAttribute("duration_sec")
        ? Number(el.getAttribute("duration_sec"))
        : null,
      loop_block: el.getAttribute("loop") !== "false",
      elements: parseFxElementsXml(el),
    });
  });

  const scenes: SceneDef[] = [];
  root.querySelectorAll("Scenes > Scene").forEach((el) => {
    const block_refs: string[] = [];
    el.querySelectorAll("BlockRef").forEach((bEl) => {
      const ref = bEl.getAttribute("ref");
      if (ref) block_refs.push(ref);
    });
    const rawUnit = el.getAttribute("duration_unit")?.trim().toLowerCase();
    const duration_unit: DurationUnit =
      rawUnit === "seconds" || rawUnit === "sec" || rawUnit === "s"
        ? "seconds"
        : "beats";
    scenes.push({
      id: el.getAttribute("id") ?? `sc_${scenes.length + 1}`,
      name: el.getAttribute("name") ?? "Scene",
      bank: el.getAttribute("bank"),
      target_group: el.getAttribute("target_group"),
      priority: Number(el.getAttribute("priority") ?? 10),
      fade_in_sec: Number(el.getAttribute("fade_in_sec") ?? 0),
      fade_out_sec: Number(el.getAttribute("fade_out_sec") ?? 0),
      duration_value: Number(el.getAttribute("duration_value") ?? 4),
      duration_unit,
      block_refs,
      timeline_ref: el.getAttribute("timeline_ref") || null,
    });
  });

  const timelines: TimelineDef[] = [];
  root.querySelectorAll("Timelines > Timeline").forEach((el) => {
    const tempo_map: TempoPointDef[] = [];
    el.querySelectorAll("TempoMap > Tempo").forEach((tEl) => {
      tempo_map.push({
        at_sec: Number(tEl.getAttribute("at_sec") ?? 0),
        bpm: Number(tEl.getAttribute("bpm") ?? bpm),
      });
    });
    const audioEl = el.querySelector(":scope > AudioTrack");
    const audio_track: AudioTrackDef | null = audioEl
      ? {
          file: audioEl.getAttribute("file") ?? "",
          abs_fallback: audioEl.getAttribute("abs_fallback"),
          sha256: audioEl.getAttribute("sha256"),
          offset_sec: Number(audioEl.getAttribute("offset_sec") ?? 0),
          transient_sensitivity: Number(
            audioEl.getAttribute("transient_sensitivity") ?? 0.65,
          ),
        }
      : null;

    const tracks: TrackDef[] = [];
    el.querySelectorAll(":scope > Track").forEach((trkEl) => {
      const clips: ClipDef[] = [];
      trkEl.querySelectorAll(":scope > Clip").forEach((cEl) => {
        clips.push({
          ref_block: cEl.getAttribute("ref_block"),
          start_sec: Number(cEl.getAttribute("start_sec") ?? 0),
          duration_sec: Number(cEl.getAttribute("duration_sec") ?? 1),
          fade_in_sec: Number(cEl.getAttribute("fade_in_sec") ?? 0),
          fade_out_sec: Number(cEl.getAttribute("fade_out_sec") ?? 0),
          inline_fx: parseFxElementsXml(cEl),
          audio_file: cEl.getAttribute("audio_file") || null,
        });
      });
      tracks.push({
        id: trkEl.getAttribute("id") ?? `trk_${tracks.length + 1}`,
        name: trkEl.getAttribute("name") ?? "Track",
        track_type: (trkEl.getAttribute("track_type") as TrackType) ?? undefined,
        target_group: trkEl.getAttribute("target_group"),
        clips,
      });
    });

    timelines.push({
      id: el.getAttribute("id") ?? `tl_${timelines.length + 1}`,
      name: el.getAttribute("name") ?? "Timeline",
      duration_sec: Number(el.getAttribute("duration_sec") ?? 30),
      grid_offset_sec: Number(el.getAttribute("grid_offset_sec") ?? 0),
      tempo_map,
      audio_track,
      loop_timeline: el.getAttribute("loop_timeline") === "true",
      tracks,
    });
  });

  return {
    version,
    name,
    bpm,
    read_only_newer_version: false,
    network_outputs: {
      frame_rate_hz: 44,
      adapter: "auto",
      subnet: null,
      offline_fallback: true,
      artsync: true,
      universes: universes.length > 0 ? universes : DEFAULT_UNIVERSES,
    },
    color_palettes,
    dimmer_palettes,
    patch,
    groups,
    fx_library,
    scenes,
    timelines,
  };
}

export interface TaktStoreState {
  activeTab: WorkspaceTab;
  selectedUniverseId: number;
  universes: UniverseConfig[];
  dmxByUniverse: Record<number, Uint8Array>;
  parkedChannels: Record<string, number>;
  blackout: boolean;
  grandMaster: number;
  displayFormat: DisplayFormat;
  adapterSelection: AdapterSelection;
  interfaces: NetworkInterfaceInfo[];
  isOffline: boolean;
  discoveryAvailable: boolean;
  activeInterface: NetworkInterfaceInfo | null;
  discoveredNodes: TrackedArtNetNode[];
  telemetry: TelemetrySummary;
  jitterSamplesUs: number[];
  histogramOpen: boolean;
  selectedChannel: number | null;
  connectedMode: "tauri" | "simulation";
  fixtureSummaries: FixtureSummary[];
  fixtureDetailsCache: Record<string, FixtureDetail>;
  selectedFixtureId: string | null;

  showState: ShowStateDto;
  liveLayers: SmartControlLayer[];
  activeScenes: ActiveSceneInstance[];
  liveBpm: number;
  activeTimelineId: string | null;
  timelinePlaying: boolean;
  timelinePlayheadSec: number;
  timelinePlayheadAnchorMs: number;
  latencyOffsetMs: number;
  _simTimelineAnchorTSec: number;
  audioAnalysisByTimeline: Record<string, AudioAnalysisResult>;
  audioAnalysisByClipKey: Record<string, AudioAnalysisResult>;
  selectedTimelineClip: { trackId: string; clipIndex: number } | null;
  timelineTimeUnit: "beats" | "seconds";
  timelineSensitivity: number;
  timelineShowTransients: boolean;
  timelineProjectTransients: boolean;
  compiledCells: CompiledCell[];
  cellPreviewRgbd: Uint8Array;
  canUndo: boolean;
  canRedo: boolean;
  rolloverEnabled: boolean;
  patchToast: string | null;
  crossProtocolWarning: boolean;
  selectedFixtureInstanceId: string | null;
  selectedFixtureIds: string[];
  sceneBanks: string[];
  stackableBanks: Record<string, boolean>;
  focusedPatchUniverse: number;
  outputEnabled: boolean;
  showRevision: number;
  savedRevision: number;
  isDirty: boolean;
  closePromptOpen: boolean;
  studioOutputMode: StudioOutputMode;
  studioSubMode: StudioSubMode;
  selectedSceneId: string | null;
  multiSelectedSceneIds: string[];
  bankDefaultFades: Record<string, BankDefaultFade>;
  flashSceneIds: Record<string, boolean>;
  groupMixerStrips: Record<string, GroupMixerStripState>;
  mappingOverlayMode: MappingOverlayMode;
  selectedMappingTarget: string | null;
  keyBindings: Record<string, string>;
  midiBindings: Record<string, string>;
  selectedCellIndices: number[];
  activeGroupFilterId: string;
  canvasOrderRule: OrderRuleStr;
  activeShaderGizmoBlockId: string | null;
  draggingSceneId: string | null;
  _simUndo: SimUndoEntry[];
  _simRedo: SimUndoEntry[];
  _simNextSeq: number;
  _simSceneSeq: number;
  _simBeatClock: BeatClockAnchor;
  _simTapHistory: number[];

  setActiveTab: (tab: WorkspaceTab) => void;
  applyBinaryFrame: (buffer: ArrayBuffer) => void;
  applyEngineSnapshot: (snapshot: EngineSnapshotDto) => void;
  applyShowSnapshot: (
    snapshot: ShowSnapshotDto,
    options?: { markClean?: boolean },
  ) => void;
  ensureFixtureDetailsLoaded: (profiles: string[]) => Promise<void>;
  setClosePromptOpen: (open: boolean) => void;
  markShowSaved: () => void;
  saveProjectToFile: () => Promise<boolean>;
  setSelectedUniverse: (universeId: number) => void;
  setDisplayFormat: (format: DisplayFormat) => void;
  selectChannel: (channel: number | null) => void;
  setChannelPark: (
    universe: number,
    channel: number,
    value: number | null,
  ) => Promise<void>;
  clearAllParked: (universe?: number) => Promise<void>;
  setBlackout: (active: boolean) => Promise<void>;
  setGrandMaster: (value: number) => Promise<void>;
  setNetworkAdapter: (selection: AdapterSelection) => Promise<void>;
  setOutputEnabled: (enabled: boolean) => Promise<void>;
  configureUniverse: (config: UniverseConfig) => Promise<void>;
  toggleHistogram: () => void;
  refreshSnapshot: () => Promise<void>;
  initEngineConnection: () => () => void;
  loadFixtures: () => Promise<void>;
  selectFixture: (id: string | null) => Promise<FixtureDetail | null>;
  validateFixtureJson: (rawJson: string) => Promise<FixtureValidationResult>;
  saveUserFixture: (
    slug: string,
    rawJson: string,
  ) => Promise<
    | { ok: true; detail: FixtureDetail }
    | { ok: false; issues: SchemaValidationIssue[] }
  >;
  deleteUserFixture: (id: string) => Promise<void>;
  loadShowSnapshot: () => Promise<void>;
  patchFixtures: (
    profileId: string,
    modeName: string,
    namePrefix: string,
    count: number,
    universe: number,
    address: number,
  ) => Promise<void>;
  moveFixturePatch: (
    fixtureId: string,
    universe: number,
    address: number,
  ) => Promise<void>;
  unpatchFixture: (fixtureId: string) => Promise<void>;
  updateFixtureGridPos: (
    fixtureId: string,
    gridPos: GridPos,
    coalesceKey?: string,
  ) => Promise<void>;
  updateFixtureCalibration: (
    fixtureId: string,
    calibration: FixtureCalibration,
    coalesceKey?: string,
  ) => Promise<void>;
  setRolloverEnabled: (enabled: boolean) => Promise<void>;
  markUniverseReviewed: (universeId: number) => Promise<void>;
  undoShow: () => Promise<void>;
  redoShow: () => Promise<void>;
  exportShowXml: () => Promise<string>;
  importShowXml: (xmlStr: string) => Promise<void>;
  upsertColorPalette: (palette: ColorPaletteDef) => Promise<void>;
  deleteColorPalette: (id: string) => Promise<void>;
  upsertDimmerPalette: (palette: DimmerPaletteDef) => Promise<void>;
  deleteDimmerPalette: (id: string) => Promise<void>;
  upsertGroup: (group: FixtureGroupDef) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  setLiveLayers: (layers: SmartControlLayer[]) => Promise<void>;
  upsertFxBlock: (block: FxBlockDef) => Promise<void>;
  deleteFxBlock: (id: string) => Promise<void>;
  upsertScene: (scene: SceneDef) => Promise<void>;
  deleteScene: (id: string) => Promise<void>;
  triggerScene: (sceneId: string, tSec?: number) => Promise<void>;
  releaseScene: (sceneId: string, tSec?: number) => Promise<void>;
  releaseAllScenes: (tSec?: number) => Promise<void>;
  setLiveBpm: (bpm: number, tSec?: number) => Promise<void>;
  tapTempo: (tSec?: number) => Promise<void>;
  upsertTimeline: (timeline: TimelineDef, coalesceKey?: string) => Promise<void>;
  deleteTimeline: (id: string) => Promise<void>;
  setTimelineTransport: (
    timelineId: string | null,
    playing: boolean,
    playheadSec?: number,
    tSec?: number,
  ) => Promise<void>;
  setLatencyOffsetMs: (offsetMs: number) => Promise<void>;
  analyzeTimelineAudio: (
    timelineId: string,
    wavPath?: string,
    bpmHint?: number,
    durationSec?: number,
    sensitivity?: number,
  ) => Promise<AudioAnalysisResult>;
  setClipAudioAnalysis: (
    clipKey: string,
    result: AudioAnalysisResult,
    timelineId?: string,
  ) => void;
  createTimelineSceneInBank: (
    bank: string | null,
    name?: string,
  ) => Promise<SceneDef>;
  convertSceneToTimeline: (sceneId: string) => Promise<string | null>;
  setSelectedTimelineClip: (
    clip: { trackId: string; clipIndex: number } | null,
  ) => void;
  setTimelineTimeUnit: (unit: "beats" | "seconds") => void;
  setTimelineSensitivity: (sens: number) => void;
  setTimelineShowTransients: (enabled: boolean) => void;
  setTimelineProjectTransients: (enabled: boolean) => void;
  resolveSplitFixtures: () => Promise<void>;
  selectFixtureInstance: (id: string | null) => void;
  setFocusedPatchUniverse: (universeId: number) => void;
  setStudioOutputMode: (mode: StudioOutputMode) => void;
  setStudioSubMode: (mode: StudioSubMode) => void;
  selectSceneForEdit: (sceneId: string | null, multiSelect?: boolean) => void;
  setBankDefaultFade: (
    bank: string,
    fadeInSec: number,
    fadeOutSec: number,
  ) => void;
  createQuickSceneInBank: (
    bank: string | null,
    presetMode?: "color" | "color_anim" | "effect",
  ) => Promise<SceneDef>;
  createSceneBank: (bankName: string) => void;
  renameSceneBank: (oldName: string, newName: string) => Promise<void>;
  deleteSceneBank: (bankName: string) => Promise<void>;
  toggleBankStackable: (bankName: string) => void;
  releaseBankScenes: (bankName: string, tSec?: number) => Promise<void>;
  toggleSelectFixtureInstance: (id: string, additive?: boolean) => void;
  setSelectedFixtureIds: (ids: string[]) => void;
  createGroupFromSelectedFixtures: (groupName: string) => Promise<void>;
  duplicateScene: (sceneId: string) => Promise<SceneDef | null>;
  batchUpdateSelectedScenes: (patch: {
    fade_in_sec?: number;
    fade_out_sec?: number;
    priority?: number;
    bank?: string | null;
  }) => Promise<void>;
  toggleSceneFlashMode: (sceneId: string) => void;
  makeFxBlockUniqueForScene: (
    sceneId: string,
    blockId: string,
  ) => Promise<FxBlockDef | null>;
  updateGroupMixerStrip: (
    groupId: string,
    patch: Partial<GroupMixerStripState>,
  ) => void;
  captureLiveSnapshotToScene: (
    name?: string,
    bank?: string | null,
  ) => Promise<SceneDef>;
  setMappingOverlayMode: (mode: MappingOverlayMode) => void;
  setSelectedMappingTarget: (targetId: string | null) => void;
  bindKeyToTarget: (targetId: string, key: string) => void;
  bindMidiToTarget: (targetId: string, midiLabel: string) => void;
  applyCellSelectionPattern: (
    pattern: CellSelectionPattern,
    groupFilterId?: string,
  ) => void;
  setSelectedCellIndices: (indices: number[]) => void;
  setActiveGroupFilterId: (groupId: string) => void;
  setCanvasOrderRule: (rule: OrderRuleStr) => void;
  setActiveShaderGizmoBlockId: (blockId: string | null) => void;
  setDraggingSceneId: (sceneId: string | null) => void;
  dismissToast: () => void;
  resetForTest: () => void;
}

export const useTaktStore = create<TaktStoreState>((set, get) => ({
  ...createInitialState(),

  setActiveTab: (tab) =>
    set((state) => {
      if (tab === "timeline") {
        const tlScene = state.showState.scenes.find((s) => Boolean(s.timeline_ref));
        return {
          activeTab: "studio",
          studioSubMode: "builder",
          ...(tlScene
            ? {
                selectedSceneId: tlScene.id,
                multiSelectedSceneIds: [tlScene.id],
                activeTimelineId: tlScene.timeline_ref ?? state.activeTimelineId,
              }
            : {}),
        };
      }
      return {
        activeTab: tab,
        studioSubMode:
          state.studioSubMode === "timeline" &&
          (tab === "studio" || tab === "scenes" || tab === "grid" || tab === "palettes")
            ? "builder"
            : state.studioSubMode,
      };
    }),

  applyBinaryFrame: (buffer) => {
    const decoded = decodeBinaryFrame(buffer);
    set((state) => {
      const nextDmx: Record<number, Uint8Array> = { ...state.dmxByUniverse };
      decoded.universes.forEach((uData, idx) => {
        const uniId = state.universes[idx]?.id ?? idx + 1;
        nextDmx[uniId] = uData;
      });
      const nextActiveScenes = state.activeScenes.filter(
        (inst) =>
          !(
            inst.release_t_sec !== null &&
            decoded.tSec >= inst.release_t_sec &&
            computeSceneAlphaAt(inst, decoded.tSec) <= 1e-6
          ),
      );
      return {
        dmxByUniverse: nextDmx,
        cellPreviewRgbd: decoded.cellPreviewRgbd,
        activeScenes:
          nextActiveScenes.length === state.activeScenes.length
            ? state.activeScenes
            : nextActiveScenes,
        telemetry: {
          revision: decoded.revision,
          tSec: decoded.tSec,
          meanUs: decoded.meanUs,
          maxJitterUs: decoded.maxJitterUs,
          p99JitterUs: decoded.p99JitterUs,
          droppedFrames: decoded.droppedFrames,
        },
      };
    });
  },

  applyEngineSnapshot: (snapshot) => {
    const parked: Record<string, number> = {};
    for (const p of snapshot.parked_channels) {
      parked[parkKey(p.universe, p.channel)] = p.value;
    }

    set((state) => {
      const nextDmx: Record<number, Uint8Array> = {};
      for (const u of snapshot.universes) {
        nextDmx[u.id] =
          state.dmxByUniverse[u.id] ?? new Uint8Array(DMX_UNIVERSE_CHANNELS);
      }

      return {
        grandMaster: snapshot.grand_master,
        blackout: snapshot.blackout,
        parkedChannels: parked,
        liveLayers: snapshot.live_layers ?? state.liveLayers,
        activeScenes: snapshot.active_scenes ?? state.activeScenes,
        liveBpm: snapshot.live_bpm ?? state.liveBpm,
        activeTimelineId:
          snapshot.active_timeline_id !== undefined
            ? snapshot.active_timeline_id
            : state.activeTimelineId,
        timelinePlaying:
          snapshot.timeline_playing !== undefined
            ? snapshot.timeline_playing
            : state.timelinePlaying,
        ...(() => {
          const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
          const nextPlaying =
            snapshot.timeline_playing !== undefined
              ? snapshot.timeline_playing
              : state.timelinePlaying;
          const snapHead = snapshot.timeline_playhead_sec;
          if (snapHead === undefined) {
            return {
              timelinePlayheadSec: state.timelinePlayheadSec,
              timelinePlayheadAnchorMs: state.timelinePlayheadAnchorMs,
            };
          }
          if (nextPlaying && state.timelinePlaying) {
            const predicted =
              state.timelinePlayheadSec +
              Math.max(0, (nowMs - state.timelinePlayheadAnchorMs) / 1000);
            if (Math.abs(predicted - snapHead) < 0.12) {
              return {
                timelinePlayheadSec: state.timelinePlayheadSec,
                timelinePlayheadAnchorMs: state.timelinePlayheadAnchorMs,
              };
            }
          }
          return {
            timelinePlayheadSec: snapHead,
            timelinePlayheadAnchorMs: nowMs,
          };
        })(),
        latencyOffsetMs:
          snapshot.latency_offset_ms !== undefined
            ? snapshot.latency_offset_ms
            : state.latencyOffsetMs,
        universes: snapshot.universes,
        dmxByUniverse: nextDmx,
        interfaces: snapshot.interfaces,
        adapterSelection: snapshot.adapter_selection,
        isOffline: snapshot.is_offline,
        outputEnabled: snapshot.output_enabled ?? state.outputEnabled,
        discoveryAvailable: snapshot.discovery_available,
        activeInterface: snapshot.active_interface,
        discoveredNodes: snapshot.discovered_nodes,
        jitterSamplesUs: snapshot.jitter_samples_us,
        telemetry: {
          ...state.telemetry,
          meanUs: snapshot.jitter_stats.mean_us,
          maxJitterUs: snapshot.jitter_stats.max_jitter_us,
          p99JitterUs: snapshot.jitter_stats.p99_jitter_us,
          droppedFrames: snapshot.jitter_stats.dropped_frames,
        },
      };
    });
  },

  applyShowSnapshot: (snapshot, options) => {
    set((state) => {
      const nextUniverses = snapshot.show.network_outputs.universes;
      const nextDmx: Record<number, Uint8Array> = {};
      for (const u of nextUniverses) {
        nextDmx[u.id] =
          state.dmxByUniverse[u.id] ?? new Uint8Array(DMX_UNIVERSE_CHANNELS);
      }
      const hasSelected =
        state.selectedSceneId !== null &&
        snapshot.show.scenes.some((s) => s.id === state.selectedSceneId);
      const nextSelectedSceneId = hasSelected
        ? state.selectedSceneId
        : (snapshot.show.scenes[0]?.id ?? null);
      const nextBanks = [...state.sceneBanks];
      for (const sc of snapshot.show.scenes) {
        const b = sc.bank?.trim();
        if (b && !nextBanks.includes(b)) {
          nextBanks.push(b);
        }
      }
      const nextRev = snapshot.revision;
      const markClean = Boolean(options?.markClean);
      const nextSavedRev = markClean ? nextRev : state.savedRevision;
      return {
        showState: snapshot.show,
        universes: nextUniverses,
        dmxByUniverse: nextDmx,
        compiledCells: snapshot.compiled_cells,
        canUndo: snapshot.can_undo,
        canRedo: snapshot.can_redo,
        rolloverEnabled: snapshot.rollover_enabled,
        patchToast: snapshot.toast ?? state.patchToast,
        crossProtocolWarning: snapshot.cross_protocol_warning,
        selectedSceneId: nextSelectedSceneId,
        sceneBanks: nextBanks.length > 0 ? nextBanks : ["Bank 1"],
        showRevision: nextRev,
        savedRevision: nextSavedRev,
        isDirty: nextRev !== nextSavedRev,
      };
    });
    const profiles = snapshot.show.patch.map((f) => f.profile);
    if (profiles.length > 0) {
      void get().ensureFixtureDetailsLoaded(profiles);
    }
  },

  setClosePromptOpen: (open) => set({ closePromptOpen: open }),

  markShowSaved: () =>
    set((state) => ({
      savedRevision: state.showRevision,
      isDirty: false,
    })),

  saveProjectToFile: async () => {
    const xml = await get().exportShowXml();
    const cleanName =
      get()
        .showState.name.trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "_") || "taktlight_show";
    const fileName = cleanName.endsWith(".takt.xml")
      ? cleanName
      : `${cleanName}.takt.xml`;

    if (typeof window !== "undefined") {
      const pickerWin = window as unknown as {
        showSaveFilePicker?: (opts: unknown) => Promise<{
          createWritable: () => Promise<{
            write: (data: string) => Promise<void>;
            close: () => Promise<void>;
          }>;
        }>;
      };
      if (typeof pickerWin.showSaveFilePicker === "function") {
        try {
          const handle = await pickerWin.showSaveFilePicker({
            suggestedName: fileName,
            types: [
              {
                description: "TaktLight Show XML",
                accept: { "application/xml": [".takt.xml", ".xml"] },
              },
            ],
          });
          const writable = await handle.createWritable();
          await writable.write(xml);
          await writable.close();
          get().markShowSaved();
          return true;
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            return false;
          }
        }
      }
      if (typeof document !== "undefined" && typeof URL.createObjectURL === "function") {
        const blob = new Blob([xml], { type: "application/xml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      }
    }
    get().markShowSaved();
    return true;
  },

  setSelectedUniverse: (universeId) => set({ selectedUniverseId: universeId }),

  setDisplayFormat: (format) => set({ displayFormat: format }),

  selectChannel: (channel) => set({ selectedChannel: channel }),

  setChannelPark: async (universe, channel, value) => {
    if (channel < 1 || channel > 512) return;
    const clamped =
      value === null ? null : Math.max(0, Math.min(255, Math.round(value)));

    set((state) => {
      const nextParked = { ...state.parkedChannels };
      const key = parkKey(universe, channel);
      if (clamped === null) {
        delete nextParked[key];
      } else {
        nextParked[key] = clamped;
      }
      return { parkedChannels: nextParked };
    });

    if (isTauriEnvironment()) {
      await invoke("set_channel_park", { universe, channel, value: clamped });
    } else {
      get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
    }
  },

  clearAllParked: async (universe) => {
    set((state) => {
      if (universe === undefined) {
        return { parkedChannels: {} };
      }
      const nextParked: Record<string, number> = {};
      const prefix = `${universe}:`;
      for (const [k, v] of Object.entries(state.parkedChannels)) {
        if (!k.startsWith(prefix)) {
          nextParked[k] = v;
        }
      }
      return { parkedChannels: nextParked };
    });

    if (isTauriEnvironment()) {
      await invoke("clear_all_parked_channels", { universe: universe ?? null });
    } else {
      get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
    }
  },

  setBlackout: async (active) => {
    set({ blackout: active });
    if (isTauriEnvironment()) {
      await invoke("set_blackout", { active });
    } else {
      get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
    }
  },

  setGrandMaster: async (value) => {
    const clamped = Number.isNaN(value) ? 1.0 : Math.max(0, Math.min(1, value));
    set({ grandMaster: clamped });
    if (isTauriEnvironment()) {
      await invoke("set_grand_master", { value: clamped });
    } else {
      get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
    }
  },

  setNetworkAdapter: async (selection) => {
    set({
      adapterSelection: selection,
      isOffline: selection.mode === "offline",
    });
    if (isTauriEnvironment()) {
      const snapshot = await invoke<EngineSnapshotDto>("set_network_adapter", {
        selection,
      });
      get().applyEngineSnapshot(snapshot);
    }
  },

  setOutputEnabled: async (enabled) => {
    set({ outputEnabled: enabled });
    if (isTauriEnvironment()) {
      const snapshot = await invoke<EngineSnapshotDto>(
        "set_output_enabled_command",
        { enabled },
      );
      get().applyEngineSnapshot(snapshot);
    }
  },

  configureUniverse: async (config) => {
    if (isTauriEnvironment()) {
      const snap = await invoke<ShowSnapshotDto>("configure_universe_command", {
        config,
      });
      get().applyShowSnapshot(snap);
      return;
    }
    const state = get();
    const prevShow = state.showState;
    const exists = prevShow.network_outputs.universes.some(
      (u) => u.id === config.id,
    );
    const nextUnis = exists
      ? prevShow.network_outputs.universes.map((u) =>
          u.id === config.id ? config : u,
        )
      : [...prevShow.network_outputs.universes, config].sort(
          (a, b) => a.id - b.id,
        );
    const nextShow: ShowStateDto = {
      ...prevShow,
      network_outputs: {
        ...prevShow.network_outputs,
        universes: nextUnis,
      },
    };
    const nextDmx: Record<number, Uint8Array> = { ...state.dmxByUniverse };
    if (!nextDmx[config.id]) {
      nextDmx[config.id] = new Uint8Array(DMX_UNIVERSE_CHANNELS);
    }
    const nextUndo = [...state._simUndo, { show: prevShow, coalesceKey: null }];
    set({
      showState: nextShow,
      universes: nextUnis,
      dmxByUniverse: nextDmx,
      _simUndo: nextUndo,
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
      patchToast: `Configured Universe ${config.id}`,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  toggleHistogram: () =>
    set((state) => ({ histogramOpen: !state.histogramOpen })),

  refreshSnapshot: async () => {
    if (!isTauriEnvironment()) return;
    const snapshot = await invoke<EngineSnapshotDto>("get_engine_snapshot");
    get().applyEngineSnapshot(snapshot);
  },

  initEngineConnection: () => {
    if (isTauriEnvironment()) {
      let active = true;
      let rafId: number | null = null;
      let ackScheduled = false;

      const scheduleAck = () => {
        if (ackScheduled || !active) return;
        ackScheduled = true;
        const ackCb = () => {
          ackScheduled = false;
          if (active) {
            void invoke("ack_frame");
          }
        };
        if (typeof requestAnimationFrame === "function") {
          rafId = requestAnimationFrame(ackCb);
        } else {
          setTimeout(ackCb, 0);
        }
      };

      const channel = new Channel<ArrayBuffer | Uint8Array | number[]>();
      channel.onmessage = (payload) => {
        if (!active) return;
        try {
          const buf = normalizeFramePayload(payload);
          get().applyBinaryFrame(buf);
        } finally {
          scheduleAck();
        }
      };

      void get().refreshSnapshot();
      void get().loadFixtures();
      void get().loadShowSnapshot();
      void invoke("subscribe_frames", { channel });

      const pollTimer = setInterval(() => {
        if (active) {
          void get().refreshSnapshot();
        }
      }, 250);

      return () => {
        active = false;
        clearInterval(pollTimer);
        if (rafId !== null && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(rafId);
        }
      };
    }

    let tick = 0;
    const simTimer = setInterval(() => {
      const state = get();
      const pseudoJitter =
        Math.sin(tick * 1.7) * 14.0 + Math.cos(tick * 0.9) * 6.0;
      const sample = 22727.0 + pseudoJitter;
      const nextSamples =
        state.jitterSamplesUs.length >= 256
          ? [...state.jitterSamplesUs.slice(1), sample]
          : [...state.jitterSamplesUs, sample];

      if (state.timelinePlaying && state.activeTimelineId) {
        const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
        const tl = state.showState.timelines.find((t) => t.id === state.activeTimelineId);
        const contentDur = tl ? computeTimelineContentDurationSec(tl.tracks) : 0;
        const elapsed = Math.max(0, (nowMs - state.timelinePlayheadAnchorMs) / 1000);
        const rawHead = state.timelinePlayheadSec + elapsed;
        if (contentDur > 0 && rawHead >= contentDur) {
          if (tl?.loop_timeline) {
            const wrapped = rawHead % contentDur;
            set({
              jitterSamplesUs: nextSamples,
              timelinePlayheadSec: wrapped,
              timelinePlayheadAnchorMs: nowMs,
              _simTimelineAnchorTSec: state.telemetry.tSec,
            });
          } else {
            const ownerScene = state.showState.scenes.find(
              (s) => s.timeline_ref === state.activeTimelineId,
            );
            set({
              jitterSamplesUs: nextSamples,
              timelinePlaying: false,
              timelinePlayheadSec: contentDur,
              timelinePlayheadAnchorMs: nowMs,
              activeScenes: ownerScene
                ? state.activeScenes.filter((a) => a.scene_id !== ownerScene.id)
                : state.activeScenes,
            });
          }
        } else {
          set({ jitterSamplesUs: nextSamples });
        }
      } else {
        set({ jitterSamplesUs: nextSamples });
      }

      get().applyBinaryFrame(
        synthesizeSimulationBuffer({
          ...get(),
          jitterSamplesUs: nextSamples,
        }),
      );
      tick += 1;
    }, 23);

    return () => {
      clearInterval(simTimer);
    };
  },

  loadFixtures: async () => {
    if (isTauriEnvironment()) {
      const summaries = await invoke<FixtureSummary[]>("list_fixtures");
      set({ fixtureSummaries: summaries });
      await get().ensureFixtureDetailsLoaded(summaries.map((s) => s.id));
      return;
    }
    const cache = get().fixtureDetailsCache;
    set({
      fixtureSummaries: Object.values(cache)
        .map((d) => d.summary)
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
  },

  ensureFixtureDetailsLoaded: async (profiles) => {
    if (!isTauriEnvironment() || profiles.length === 0) return;
    const unique = Array.from(new Set(profiles)).filter(
      (id) => Boolean(id) && !get().fixtureDetailsCache[id],
    );
    if (unique.length === 0) return;
    const settled = await Promise.allSettled(
      unique.map(async (id) => ({
        id,
        detail: await invoke<FixtureDetail>("get_fixture_detail", { id }),
      })),
    );
    const additions: Record<string, FixtureDetail> = {};
    for (const res of settled) {
      if (res.status === "fulfilled" && res.value.detail) {
        additions[res.value.id] = res.value.detail;
      }
    }
    if (Object.keys(additions).length > 0) {
      set((state) => ({
        fixtureDetailsCache: {
          ...state.fixtureDetailsCache,
          ...additions,
        },
      }));
    }
  },

  selectFixture: async (id) => {
    set({ selectedFixtureId: id });
    if (!id) return null;

    if (isTauriEnvironment()) {
      const detail = await invoke<FixtureDetail>("get_fixture_detail", { id });
      set((state) => ({
        fixtureDetailsCache: {
          ...state.fixtureDetailsCache,
          [id]: detail,
        },
      }));
      return detail;
    }

    return get().fixtureDetailsCache[id] ?? null;
  },

  validateFixtureJson: async (rawJson) => {
    if (isTauriEnvironment()) {
      return await invoke<FixtureValidationResult>("validate_fixture_json", {
        rawJson,
      });
    }
    return validateAndExpandOflLocally(rawJson);
  },

  saveUserFixture: async (slug, rawJson) => {
    if (isTauriEnvironment()) {
      try {
        const detail = await invoke<FixtureDetail>("save_user_fixture", {
          slug,
          rawJson,
        });
        set((state) => {
          const nextCache = {
            ...state.fixtureDetailsCache,
            [detail.summary.id]: detail,
          };
          const filtered = state.fixtureSummaries.filter(
            (s) => s.id !== detail.summary.id,
          );
          return {
            fixtureDetailsCache: nextCache,
            fixtureSummaries: [...filtered, detail.summary].sort((a, b) =>
              a.id.localeCompare(b.id),
            ),
            selectedFixtureId: detail.summary.id,
          };
        });
        return { ok: true, detail };
      } catch (err) {
        const issues = Array.isArray(err)
          ? (err as SchemaValidationIssue[])
          : [
              {
                instance_path: "/",
                schema_path: "",
                message: String(err),
              },
            ];
        return { ok: false, issues };
      }
    }

    const clean = sanitizeSlug(slug);
    if (!clean) {
      return {
        ok: false,
        issues: [
          {
            instance_path: "/name",
            schema_path: "",
            message: "Fixture name/slug cannot be empty",
          },
        ],
      };
    }

    const validation = validateAndExpandOflLocally(rawJson);
    if (!validation.valid) {
      return { ok: false, issues: validation.issues };
    }

    const parsed = JSON.parse(rawJson) as {
      name: string;
      shortName?: string;
      categories: string[];
    };
    const id = `user/${clean}.json`;
    const detail: FixtureDetail = {
      summary: {
        id,
        name: parsed.name,
        short_name: parsed.shortName ?? parsed.name,
        origin: "user_local",
        categories: parsed.categories,
        pixel_count: validation.pixel_count,
        modes: validation.expanded_modes.map((m) => ({
          name: m.name,
          short_name: m.short_name,
          channel_count: m.channel_count,
          cell_count: m.cells.length,
        })),
      },
      raw_json: JSON.stringify(parsed, null, 2),
      expanded_modes: validation.expanded_modes,
    };

    set((state) => {
      const nextCache = { ...state.fixtureDetailsCache, [id]: detail };
      const nextSummaries = Object.values(nextCache)
        .map((d) => d.summary)
        .sort((a, b) => a.id.localeCompare(b.id));
      return {
        fixtureDetailsCache: nextCache,
        fixtureSummaries: nextSummaries,
        selectedFixtureId: id,
      };
    });

    return { ok: true, detail };
  },

  deleteUserFixture: async (id) => {
    if (isTauriEnvironment()) {
      await invoke("delete_user_fixture", { id });
    }
    set((state) => {
      const nextCache = { ...state.fixtureDetailsCache };
      delete nextCache[id];
      const nextSummaries = state.fixtureSummaries.filter((s) => s.id !== id);
      return {
        fixtureDetailsCache: nextCache,
        fixtureSummaries: nextSummaries,
        selectedFixtureId:
          state.selectedFixtureId === id
            ? (nextSummaries[0]?.id ?? null)
            : state.selectedFixtureId,
      };
    });
  },

  loadShowSnapshot: async () => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>("get_show_snapshot");
      get().applyShowSnapshot(snapshot, { markClean: true });
    }
  },

  patchFixtures: async (
    profileId,
    modeName,
    namePrefix,
    count,
    universe,
    address,
  ) => {
    const rolloverSplit = get().rolloverEnabled;
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>("patch_fixtures_command", {
        profileId,
        modeName,
        namePrefix,
        count,
        universe,
        address,
        rolloverSplit,
      });
      get().applyShowSnapshot(snapshot);
      return;
    }

    const state = get();
    const detail = state.fixtureDetailsCache[profileId];
    const modeInfo = detail?.expanded_modes.find((m) => m.name === modeName);
    const channelCount = modeInfo?.channel_count ?? 1;

    const prevShow = structuredClone(state.showState);
    const workingPatch = [...prevShow.patch];
    const workingUnis = [...prevShow.network_outputs.universes];
    let curUni = universe;
    let curAddr = address;
    let seq = state._simNextSeq;
    let toast: string | null = null;
    let crossWarn = false;
    let lastAddedId: string | null = null;

    for (let i = 0; i < count; i++) {
      const name = count === 1 ? namePrefix.trim() : `${namePrefix.trim()} ${i + 1}`;
      const outcome = previewPlacement(
        workingPatch,
        workingUnis,
        name,
        curUni,
        curAddr,
        channelCount,
        rolloverSplit,
      );
      for (const u of outcome.autoCreateUniverses) {
        if (!workingUnis.some((e) => e.id === u.id)) workingUnis.push(u);
      }
      workingUnis.sort((a, b) => a.id - b.id);
      if (outcome.crossProtocolWarning) crossWarn = true;
      if (i === 0) toast = outcome.toastMessage;

      const idx = workingPatch.length;
      const inst: FixtureInstance = {
        id: `fx_${String(seq++).padStart(3, "0")}`,
        profile: profileId,
        mode: modeName,
        name,
        universe: outcome.universe,
        address: outcome.address,
        channel_count: channelCount,
        grid_pos: {
          x: Math.min(0.85, 0.25 + Math.floor(idx / 6) * 0.25),
          y: Math.min(0.88, 0.15 + (idx % 6) * 0.14),
          rotation: 0,
          scale_x: 0.3,
          scale_y: 0.05,
        },
        calibration: defaultCalibration(),
      };
      lastAddedId = inst.id;
      workingPatch.push(inst);
      const fp = getFixtureFootprint(inst);
      const endU = fp.tail ? fp.tail.universe : fp.head.universe;
      const endA = fp.tail ? fp.tail.endAddress : fp.head.endAddress;
      if (endA >= 512) {
        curUni = endU + 1;
        curAddr = 1;
      } else {
        curUni = endU;
        curAddr = endA + 1;
      }
    }

    if (count > 1 && toast) {
      toast = `Patched ${count} fixtures starting at U${workingPatch[workingPatch.length - count].universe}.${String(workingPatch[workingPatch.length - count].address).padStart(3, "0")}`;
    }

    const nextShow: ShowStateDto = {
      ...prevShow,
      network_outputs: { ...prevShow.network_outputs, universes: workingUnis },
      patch: workingPatch,
    };
    const nextCells = compileCellsLocally(
      nextShow.patch,
      state.fixtureDetailsCache,
    );
    set({
      showState: nextShow,
      universes: workingUnis,
      compiledCells: nextCells,
      patchToast: toast,
      crossProtocolWarning: crossWarn,
      selectedFixtureInstanceId: lastAddedId ?? state.selectedFixtureInstanceId,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      _simNextSeq: seq,
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  moveFixturePatch: async (fixtureId, universe, address) => {
    const rolloverSplit = get().rolloverEnabled;
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>(
        "move_fixture_patch_command",
        { fixtureId, universe, address, rolloverSplit },
      );
      get().applyShowSnapshot(snapshot);
      return;
    }

    const state = get();
    const prevShow = structuredClone(state.showState);
    const fx = prevShow.patch.find((f) => f.id === fixtureId);
    if (!fx) return;

    const outcome = previewPlacement(
      prevShow.patch,
      prevShow.network_outputs.universes,
      fx.name,
      universe,
      address,
      fx.channel_count,
      rolloverSplit,
      fixtureId,
    );
    const nextUnis = [...prevShow.network_outputs.universes];
    for (const u of outcome.autoCreateUniverses) {
      if (!nextUnis.some((e) => e.id === u.id)) nextUnis.push(u);
    }
    nextUnis.sort((a, b) => a.id - b.id);

    const nextPatch = prevShow.patch.map((f) =>
      f.id === fixtureId
        ? { ...f, universe: outcome.universe, address: outcome.address }
        : f,
    );
    const nextShow: ShowStateDto = {
      ...prevShow,
      network_outputs: { ...prevShow.network_outputs, universes: nextUnis },
      patch: nextPatch,
    };
    set({
      showState: nextShow,
      universes: nextUnis,
      compiledCells: compileCellsLocally(nextPatch, state.fixtureDetailsCache),
      patchToast: outcome.toastMessage,
      crossProtocolWarning: outcome.crossProtocolWarning,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  unpatchFixture: async (fixtureId) => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>("unpatch_fixture_command", {
        fixtureId,
      });
      get().applyShowSnapshot(snapshot);
      return;
    }

    const state = get();
    const prevShow = structuredClone(state.showState);
    const removed = prevShow.patch.find((f) => f.id === fixtureId);
    if (!removed) return;
    const nextPatch = prevShow.patch.filter((f) => f.id !== fixtureId);
    const nextShow: ShowStateDto = { ...prevShow, patch: nextPatch };
    set({
      showState: nextShow,
      compiledCells: compileCellsLocally(nextPatch, state.fixtureDetailsCache),
      patchToast: `Removed ${removed.name} from patch`,
      selectedFixtureInstanceId:
        state.selectedFixtureInstanceId === fixtureId
          ? null
          : state.selectedFixtureInstanceId,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  updateFixtureGridPos: async (fixtureId, gridPos, coalesceKey) => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>(
        "update_fixture_grid_pos_command",
        { fixtureId, gridPos, coalesceKey: coalesceKey ?? null },
      );
      get().applyShowSnapshot(snapshot);
      return;
    }

    const state = get();
    const prevShow = structuredClone(state.showState);
    const nextPatch = prevShow.patch.map((f) =>
      f.id === fixtureId ? { ...f, grid_pos: gridPos } : f,
    );
    const nextShow: ShowStateDto = { ...prevShow, patch: nextPatch };
    const top = state._simUndo[state._simUndo.length - 1];
    const nextUndo =
      coalesceKey && top && top.coalesceKey === coalesceKey
        ? state._simUndo
        : [...state._simUndo, { show: prevShow, coalesceKey: coalesceKey ?? null }];

    set({
      showState: nextShow,
      compiledCells: compileCellsLocally(nextPatch, state.fixtureDetailsCache),
      _simUndo: nextUndo,
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: nextUndo.length > 0,
      canRedo: false,
    });
  },

  updateFixtureCalibration: async (fixtureId, calibration, coalesceKey) => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>(
        "update_fixture_calibration_command",
        { fixtureId, calibration, coalesceKey: coalesceKey ?? null },
      );
      get().applyShowSnapshot(snapshot);
      return;
    }

    const state = get();
    const prevShow = structuredClone(state.showState);
    const nextPatch = prevShow.patch.map((f) =>
      f.id === fixtureId ? { ...f, calibration } : f,
    );
    const nextShow: ShowStateDto = { ...prevShow, patch: nextPatch };
    const top = state._simUndo[state._simUndo.length - 1];
    const nextUndo =
      coalesceKey && top && top.coalesceKey === coalesceKey
        ? state._simUndo
        : [...state._simUndo, { show: prevShow, coalesceKey: coalesceKey ?? null }];

    set({
      showState: nextShow,
      _simUndo: nextUndo,
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: nextUndo.length > 0,
      canRedo: false,
    });
  },

  setRolloverEnabled: async (enabled) => {
    set({ rolloverEnabled: enabled });
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>(
        "set_rollover_enabled_command",
        { enabled },
      );
      get().applyShowSnapshot(snapshot);
    }
  },

  markUniverseReviewed: async (universeId) => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>(
        "mark_universe_reviewed_command",
        { universeId },
      );
      get().applyShowSnapshot(snapshot);
      return;
    }
    set((state) => {
      const nextUnis = state.showState.network_outputs.universes.map((u) =>
        u.id === universeId ? { ...u, review_output: false } : u,
      );
      return {
        universes: nextUnis,
        showState: {
          ...state.showState,
          network_outputs: {
            ...state.showState.network_outputs,
            universes: nextUnis,
          },
        },
      };
    });
  },

  undoShow: async () => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>("undo_command");
      get().applyShowSnapshot(snapshot);
      return;
    }

    const state = get();
    if (state._simUndo.length === 0) return;
    const entry = state._simUndo[state._simUndo.length - 1];
    const current = structuredClone(state.showState);
    const nextUndo = state._simUndo.slice(0, -1);
    const nextRedo = [
      ...state._simRedo,
      { show: current, coalesceKey: null },
    ];
    set({
      showState: entry.show,
      universes: entry.show.network_outputs.universes,
      compiledCells: compileCellsLocally(
        entry.show.patch,
        state.fixtureDetailsCache,
      ),
      patchToast: "Undid last change",
      _simUndo: nextUndo,
      _simRedo: nextRedo,
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: nextUndo.length > 0,
      canRedo: nextRedo.length > 0,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  redoShow: async () => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>("redo_command");
      get().applyShowSnapshot(snapshot);
      return;
    }

    const state = get();
    if (state._simRedo.length === 0) return;
    const entry = state._simRedo[state._simRedo.length - 1];
    const current = structuredClone(state.showState);
    const nextRedo = state._simRedo.slice(0, -1);
    const nextUndo = [
      ...state._simUndo,
      { show: current, coalesceKey: null },
    ];
    set({
      showState: entry.show,
      universes: entry.show.network_outputs.universes,
      compiledCells: compileCellsLocally(
        entry.show.patch,
        state.fixtureDetailsCache,
      ),
      patchToast: "Redid change",
      _simUndo: nextUndo,
      _simRedo: nextRedo,
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: nextUndo.length > 0,
      canRedo: nextRedo.length > 0,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  exportShowXml: async () => {
    if (isTauriEnvironment()) {
      return await invoke<string>("export_show_xml_command");
    }
    return serializeShowXmlLocally(get().showState);
  },

  importShowXml: async (xmlStr) => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>("import_show_xml_command", {
        xmlStr,
      });
      get().applyShowSnapshot(snapshot, { markClean: true });
      return;
    }

    const state = get();
    const prevShow = structuredClone(state.showState);
    const imported = parseShowXmlLocally(xmlStr, state.fixtureDetailsCache);
    const nextRev = state.showRevision + 1;
    set({
      showState: imported,
      universes: imported.network_outputs.universes,
      compiledCells: compileCellsLocally(
        imported.patch,
        state.fixtureDetailsCache,
      ),
      patchToast: "Imported .takt.xml show",
      showRevision: nextRev,
      savedRevision: nextRev,
      isDirty: false,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  upsertColorPalette: async (palette) => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>(
        "upsert_color_palette_command",
        { palette },
      );
      get().applyShowSnapshot(snapshot);
      return;
    }
    const state = get();
    const prevShow = structuredClone(state.showState);
    const exists = prevShow.color_palettes.some((p) => p.id === palette.id);
    const nextPalettes = exists
      ? prevShow.color_palettes.map((p) => (p.id === palette.id ? palette : p))
      : [...prevShow.color_palettes, palette];
    set({
      showState: { ...prevShow, color_palettes: nextPalettes },
      patchToast: `Saved color palette ${palette.name}`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  deleteColorPalette: async (id) => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>(
        "delete_color_palette_command",
        { id },
      );
      get().applyShowSnapshot(snapshot);
      return;
    }
    const state = get();
    const prevShow = structuredClone(state.showState);
    set({
      showState: {
        ...prevShow,
        color_palettes: prevShow.color_palettes.filter((p) => p.id !== id),
      },
      patchToast: `Deleted color palette ${id}`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  upsertDimmerPalette: async (palette) => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>(
        "upsert_dimmer_palette_command",
        { palette },
      );
      get().applyShowSnapshot(snapshot);
      return;
    }
    const state = get();
    const prevShow = structuredClone(state.showState);
    const exists = prevShow.dimmer_palettes.some((p) => p.id === palette.id);
    const nextPalettes = exists
      ? prevShow.dimmer_palettes.map((p) => (p.id === palette.id ? palette : p))
      : [...prevShow.dimmer_palettes, palette];
    set({
      showState: { ...prevShow, dimmer_palettes: nextPalettes },
      patchToast: `Saved dimmer palette ${palette.name}`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  deleteDimmerPalette: async (id) => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>(
        "delete_dimmer_palette_command",
        { id },
      );
      get().applyShowSnapshot(snapshot);
      return;
    }
    const state = get();
    const prevShow = structuredClone(state.showState);
    set({
      showState: {
        ...prevShow,
        dimmer_palettes: prevShow.dimmer_palettes.filter((p) => p.id !== id),
      },
      patchToast: `Deleted dimmer palette ${id}`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  upsertGroup: async (group) => {
    const cleanName = group.name.trim();
    const existingGroups = get().showState.groups;
    const duplicate = existingGroups.find(
      (g) =>
        g.id !== group.id &&
        g.name.trim().toLowerCase() === cleanName.toLowerCase(),
    );
    if (duplicate) {
      set({
        patchToast: `Group "${cleanName}" already exists. Choose a unique group name.`,
      });
      return;
    }
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>("upsert_group_command", {
        group,
      });
      get().applyShowSnapshot(snapshot);
      return;
    }
    const state = get();
    const prevShow = structuredClone(state.showState);
    const exists = prevShow.groups.some((g) => g.id === group.id);
    const nextGroups = exists
      ? prevShow.groups.map((g) => (g.id === group.id ? group : g))
      : [...prevShow.groups, group];
    set({
      showState: { ...prevShow, groups: nextGroups },
      patchToast: `Saved group ${group.name}`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  deleteGroup: async (id) => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>("delete_group_command", {
        id,
      });
      get().applyShowSnapshot(snapshot);
      return;
    }
    const state = get();
    const prevShow = structuredClone(state.showState);
    set({
      showState: {
        ...prevShow,
        groups: prevShow.groups.filter((g) => g.id !== id),
      },
      patchToast: `Deleted group ${id}`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  setLiveLayers: async (layers) => {
    set({ liveLayers: layers });
    if (isTauriEnvironment()) {
      const snap = await invoke<EngineSnapshotDto>("set_live_layers_command", {
        layers,
      });
      get().applyEngineSnapshot(snap);
    } else {
      get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
    }
  },

  upsertFxBlock: async (block) => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>(
        "upsert_fx_block_command",
        { block },
      );
      get().applyShowSnapshot(snapshot);
      return;
    }
    const state = get();
    const prevShow = structuredClone(state.showState);
    const exists = prevShow.fx_library.some((b) => b.id === block.id);
    const nextBlocks = exists
      ? prevShow.fx_library.map((b) => (b.id === block.id ? block : b))
      : [...prevShow.fx_library, block];
    set({
      showState: { ...prevShow, fx_library: nextBlocks },
      patchToast: `Saved FX block ${block.name}`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  deleteFxBlock: async (id) => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>(
        "delete_fx_block_command",
        { id },
      );
      get().applyShowSnapshot(snapshot);
      return;
    }
    const state = get();
    const prevShow = structuredClone(state.showState);
    set({
      showState: {
        ...prevShow,
        fx_library: prevShow.fx_library.filter((b) => b.id !== id),
      },
      patchToast: `Deleted FX block ${id}`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  upsertScene: async (scene) => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>("upsert_scene_command", {
        scene,
      });
      get().applyShowSnapshot(snapshot);
      return;
    }
    const state = get();
    const prevShow = structuredClone(state.showState);
    const exists = prevShow.scenes.some((s) => s.id === scene.id);
    const nextScenes = exists
      ? prevShow.scenes.map((s) => (s.id === scene.id ? scene : s))
      : [...prevShow.scenes, scene];
    set({
      showState: { ...prevShow, scenes: nextScenes },
      selectedSceneId: exists ? state.selectedSceneId : scene.id,
      patchToast: `Saved scene ${scene.name}`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  deleteScene: async (id) => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>("delete_scene_command", {
        id,
      });
      get().applyShowSnapshot(snapshot);
      return;
    }
    const state = get();
    const prevShow = structuredClone(state.showState);
    const nextScenes = prevShow.scenes.filter((s) => s.id !== id);
    set({
      showState: {
        ...prevShow,
        scenes: nextScenes,
      },
      selectedSceneId:
        state.selectedSceneId === id
          ? (nextScenes[0]?.id ?? null)
          : state.selectedSceneId,
      multiSelectedSceneIds: state.multiSelectedSceneIds.filter(
        (sid) => sid !== id,
      ),
      patchToast: `Deleted scene ${id}`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  triggerScene: async (sceneId, tSec) => {
    const stateBefore = get();
    const targetScene = stateBefore.showState.scenes.find((s) => s.id === sceneId);
    if (isTauriEnvironment()) {
      const snap = await invoke<EngineSnapshotDto>("trigger_scene_command", {
        sceneId,
        tSec: tSec ?? null,
      });
      get().applyEngineSnapshot(snap);
      if (targetScene?.timeline_ref) {
        await get().setTimelineTransport(targetScene.timeline_ref, true, 0, tSec);
      }
      return;
    }
    const state = get();
    const scene = state.showState.scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    const tNow = tSec ?? state.telemetry.tSec;
    const normBank = scene.bank?.trim() ? scene.bank.trim() : null;
    const isStackable = Boolean(normBank && state.stackableBanks[normBank]);

    let releasedTimelineRef: string | null = null;
    const remaining = state.activeScenes
      .filter((inst) => {
        const a = computeSceneAlphaAt(inst, tNow);
        return !(inst.release_t_sec !== null && a <= 1e-6);
      })
      .filter((inst) => inst.scene_id !== sceneId)
      .map((inst) => {
        if (
          normBank &&
          !isStackable &&
          inst.bank === normBank &&
          inst.release_t_sec === null
        ) {
          const prevScene = state.showState.scenes.find((s) => s.id === inst.scene_id);
          if (prevScene?.timeline_ref) {
            releasedTimelineRef = prevScene.timeline_ref;
          }
          return {
            ...inst,
            release_start_alpha: computeSceneAlphaAt(inst, tNow),
            release_t_sec: tNow,
          };
        }
        return inst;
      });

    const seq = state._simSceneSeq;
    const triggerBeat = computeBeatAt(state._simBeatClock, tNow);
    const nextInst: ActiveSceneInstance = {
      scene_id: scene.id,
      bank: normBank,
      trigger_t_sec: tNow,
      trigger_beat: triggerBeat,
      trigger_order: seq,
      fade_in_sec: Math.max(0, scene.fade_in_sec),
      fade_out_sec: Math.max(0, scene.fade_out_sec),
      release_t_sec: null,
      release_start_alpha: 1,
    };

    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (scene.timeline_ref) {
      set({
        activeScenes: [...remaining, nextInst],
        _simSceneSeq: seq + 1,
        activeTimelineId: scene.timeline_ref,
        timelinePlaying: true,
        timelinePlayheadSec: 0,
        timelinePlayheadAnchorMs: nowMs,
        _simTimelineAnchorTSec: tNow,
      });
    } else if (releasedTimelineRef && state.activeTimelineId === releasedTimelineRef) {
      set({
        activeScenes: [...remaining, nextInst],
        _simSceneSeq: seq + 1,
        timelinePlaying: false,
        timelinePlayheadAnchorMs: nowMs,
      });
    } else {
      set({
        activeScenes: [...remaining, nextInst],
        _simSceneSeq: seq + 1,
      });
    }
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  releaseScene: async (sceneId, tSec) => {
    const targetScene = get().showState.scenes.find((s) => s.id === sceneId);
    if (isTauriEnvironment()) {
      const snap = await invoke<EngineSnapshotDto>("release_scene_command", {
        sceneId,
        tSec: tSec ?? null,
      });
      get().applyEngineSnapshot(snap);
      if (targetScene?.timeline_ref && get().activeTimelineId === targetScene.timeline_ref) {
        await get().setTimelineTransport(targetScene.timeline_ref, false, undefined, tSec);
      }
      return;
    }
    const state = get();
    const tNow = tSec ?? state.telemetry.tSec;
    const updated = state.activeScenes
      .map((inst) =>
        inst.scene_id === sceneId && inst.release_t_sec === null
          ? {
              ...inst,
              release_start_alpha: computeSceneAlphaAt(inst, tNow),
              release_t_sec: tNow,
            }
          : inst,
      )
      .filter(
        (inst) =>
          !(inst.release_t_sec !== null && computeSceneAlphaAt(inst, tNow) <= 1e-6),
      );
    const stopTl = Boolean(
      targetScene?.timeline_ref && state.activeTimelineId === targetScene.timeline_ref,
    );
    set({
      activeScenes: updated,
      ...(stopTl ? { timelinePlaying: false } : {}),
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  releaseAllScenes: async (tSec) => {
    if (isTauriEnvironment()) {
      const snap = await invoke<EngineSnapshotDto>(
        "release_all_scenes_command",
        { tSec: tSec ?? null },
      );
      get().applyEngineSnapshot(snap);
      if (get().timelinePlaying) {
        await get().setTimelineTransport(get().activeTimelineId, false, undefined, tSec);
      }
      return;
    }
    const state = get();
    const tNow = tSec ?? state.telemetry.tSec;
    const updated = state.activeScenes
      .map((inst) =>
        inst.release_t_sec === null
          ? {
              ...inst,
              release_start_alpha: computeSceneAlphaAt(inst, tNow),
              release_t_sec: tNow,
            }
          : inst,
      )
      .filter(
        (inst) =>
          !(inst.release_t_sec !== null && computeSceneAlphaAt(inst, tNow) <= 1e-6),
      );
    set({ activeScenes: updated, timelinePlaying: false });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  setLiveBpm: async (bpm, tSec) => {
    const clampedBpm = Number.isNaN(bpm)
      ? 120
      : Math.max(20, Math.min(300, bpm));
    if (isTauriEnvironment()) {
      const snap = await invoke<EngineSnapshotDto>("set_live_bpm_command", {
        bpm: clampedBpm,
        tSec: tSec ?? null,
      });
      get().applyEngineSnapshot(snap);
      return;
    }
    const state = get();
    const tNow = tSec ?? state.telemetry.tSec;
    const nextAnchor: BeatClockAnchor = {
      bpm: clampedBpm,
      t_anchor_sec: tNow,
      beat_anchor: computeBeatAt(state._simBeatClock, tNow),
    };
    set({
      liveBpm: clampedBpm,
      _simBeatClock: nextAnchor,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  tapTempo: async (tSec) => {
    if (isTauriEnvironment()) {
      const snap = await invoke<EngineSnapshotDto>("tap_tempo_command", {
        tSec: tSec ?? null,
      });
      get().applyEngineSnapshot(snap);
      return;
    }
    const state = get();
    const tNow = tSec ?? Date.now() / 1000;
    const prev = state._simTapHistory;
    const last = prev[prev.length - 1];
    const baseHistory =
      last !== undefined && (Math.abs(tNow - last) > 3 || tNow < last)
        ? []
        : prev;
    const nextHistory = [...baseHistory, tNow].slice(-8);
    set({ _simTapHistory: nextHistory });
    if (nextHistory.length >= 2) {
      const span = nextHistory[nextHistory.length - 1] - nextHistory[0];
      const intervals = nextHistory.length - 1;
      if (span > 1e-4) {
        await get().setLiveBpm((60 * intervals) / span, tNow);
      }
    }
  },

  selectFixtureInstance: (id) => set({ selectedFixtureInstanceId: id }),

  resolveSplitFixtures: async () => {
    if (isTauriEnvironment()) {
      const snapshot = await invoke<ShowSnapshotDto>(
        "resolve_split_fixtures_command",
      );
      get().applyShowSnapshot(snapshot);
      return;
    }

    const state = get();
    const prevShow = structuredClone(state.showState);
    const workingPatch = structuredClone(prevShow.patch);
    const workingUnis = [...prevShow.network_outputs.universes];
    let movedCount = 0;

    for (let i = 0; i < workingPatch.length; i++) {
      const fx = workingPatch[i];
      if (fx.address + fx.channel_count - 1 <= 512) continue;

      const outcome = previewPlacement(
        workingPatch,
        workingUnis,
        fx.name,
        fx.universe,
        fx.address,
        fx.channel_count,
        false,
        fx.id,
      );
      for (const u of outcome.autoCreateUniverses) {
        if (!workingUnis.some((existing) => existing.id === u.id)) {
          workingUnis.push(u);
        }
      }
      workingUnis.sort((a, b) => a.id - b.id);
      workingPatch[i] = {
        ...fx,
        universe: outcome.universe,
        address: outcome.address,
      };
      movedCount += 1;
    }

    if (movedCount === 0) return;

    const nextShow: ShowStateDto = {
      ...prevShow,
      network_outputs: { ...prevShow.network_outputs, universes: workingUnis },
      patch: workingPatch,
    };
    const nextUndo = [...state._simUndo, { show: prevShow, coalesceKey: null }];
    set({
      showState: nextShow,
      universes: workingUnis,
      compiledCells: compileCellsLocally(
        nextShow.patch,
        state.fixtureDetailsCache,
      ),
      patchToast: `Moved ${movedCount} split fixture(s) to valid addresses`,
      crossProtocolWarning: false,
      _simUndo: nextUndo,
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  upsertTimeline: async (timeline, coalesceKey) => {
    if (isTauriEnvironment()) {
      const snap = await invoke<ShowSnapshotDto>("upsert_timeline_command", {
        timeline,
        coalesceKey: coalesceKey ?? null,
      });
      get().applyShowSnapshot(snap);
      return;
    }
    const state = get();
    const prevShow = structuredClone(state.showState);
    const exists = prevShow.timelines.some((t) => t.id === timeline.id);
    const nextTimelines = exists
      ? prevShow.timelines.map((t) => (t.id === timeline.id ? timeline : t))
      : [...prevShow.timelines, timeline];
    const nextShow: ShowStateDto = { ...prevShow, timelines: nextTimelines };
    const top = state._simUndo[state._simUndo.length - 1];
    const nextUndo =
      coalesceKey && top && top.coalesceKey === coalesceKey
        ? state._simUndo
        : [...state._simUndo, { show: prevShow, coalesceKey: coalesceKey ?? null }];
    set({
      showState: nextShow,
      _simUndo: nextUndo,
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: nextUndo.length > 0,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  deleteTimeline: async (id) => {
    if (isTauriEnvironment()) {
      const snap = await invoke<ShowSnapshotDto>("delete_timeline_command", {
        id,
      });
      get().applyShowSnapshot(snap);
      return;
    }
    const state = get();
    const prevShow = structuredClone(state.showState);
    const nextTimelines = prevShow.timelines.filter((t) => t.id !== id);
    const nextUndo = [...state._simUndo, { show: prevShow, coalesceKey: null }];
    set({
      showState: { ...prevShow, timelines: nextTimelines },
      activeTimelineId: state.activeTimelineId === id ? null : state.activeTimelineId,
      timelinePlaying: state.activeTimelineId === id ? false : state.timelinePlaying,
      _simUndo: nextUndo,
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: nextUndo.length > 0,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  setTimelineTransport: async (timelineId, playing, playheadSec, tSec) => {
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (isTauriEnvironment()) {
      const snap = await invoke<EngineSnapshotDto>(
        "set_timeline_transport_command",
        {
          timelineId,
          playing,
          playheadSec: playheadSec ?? null,
          tSec: tSec ?? null,
        },
      );
      get().applyEngineSnapshot(snap);
      set({ timelinePlayheadAnchorMs: nowMs });
      return;
    }
    const state = get();
    const tNow = tSec ?? state.telemetry.tSec;
    const normId = timelineId && timelineId.trim() ? timelineId.trim() : null;
    if (!normId) {
      set({
        activeTimelineId: null,
        timelinePlaying: false,
        timelinePlayheadSec: 0,
        timelinePlayheadAnchorMs: nowMs,
        _simTimelineAnchorTSec: tNow,
      });
    } else {
      const currentEffectiveHead = state.timelinePlaying
        ? state.timelinePlayheadSec +
          Math.max(0, (nowMs - state.timelinePlayheadAnchorMs) / 1000)
        : state.timelinePlayheadSec;
      const nextHead =
        playheadSec !== undefined && !Number.isNaN(playheadSec)
          ? Math.max(0, playheadSec)
          : currentEffectiveHead;
      set({
        activeTimelineId: normId,
        timelinePlaying: playing,
        timelinePlayheadSec: nextHead,
        timelinePlayheadAnchorMs: nowMs,
        _simTimelineAnchorTSec: tNow,
      });
    }
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  setLatencyOffsetMs: async (offsetMs) => {
    const clamped = Number.isNaN(offsetMs)
      ? 0
      : Math.max(-500, Math.min(500, offsetMs));
    if (isTauriEnvironment()) {
      const snap = await invoke<EngineSnapshotDto>(
        "set_latency_offset_ms_command",
        { offsetMs: clamped },
      );
      get().applyEngineSnapshot(snap);
      return;
    }
    set({ latencyOffsetMs: clamped });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  analyzeTimelineAudio: async (
    timelineId,
    wavPath,
    bpmHint,
    durationSec,
    sensitivity,
  ) => {
    const tl = get().showState.timelines.find((t) => t.id === timelineId);
    const sens = Math.max(
      0,
      Math.min(1, sensitivity ?? tl?.audio_track?.transient_sensitivity ?? 0.65),
    );
    const bpm = bpmHint ?? tl?.tempo_map[0]?.bpm ?? get().showState.bpm ?? 120;
    const dur = durationSec ?? tl?.duration_sec ?? 16;

    const result = isTauriEnvironment()
      ? await invoke<AudioAnalysisResult>("analyze_audio_command", {
          wavPath: wavPath ?? null,
          syntheticBpm: bpm,
          syntheticDurationSec: dur,
          transientSensitivity: sens,
        })
      : analyzeSyntheticTimelineAudio({
          bpm,
          durationSec: dur,
          gridOffsetSec: tl?.grid_offset_sec ?? 0.12,
          sensitivity: sens,
        });

    set((state) => ({
      audioAnalysisByTimeline: {
        ...state.audioAnalysisByTimeline,
        [timelineId]: result,
      },
    }));
    return result;
  },

  setClipAudioAnalysis: (clipKey, result, timelineId) => {
    set((state) => ({
      audioAnalysisByClipKey: {
        ...state.audioAnalysisByClipKey,
        [clipKey]: result,
      },
      ...(timelineId
        ? {
            audioAnalysisByTimeline: {
              ...state.audioAnalysisByTimeline,
              [timelineId]: result,
            },
          }
        : {}),
    }));
  },

  createTimelineSceneInBank: async (bank, customName) => {
    const state = get();
    const normBank = bank && bank.trim() ? bank.trim() : null;
    if (normBank && !state.sceneBanks.includes(normBank)) {
      set({ sceneBanks: [...state.sceneBanks, normBank] });
    }
    const defaults = normBank
      ? (state.bankDefaultFades[normBank] ?? { fadeInSec: 0, fadeOutSec: 0 })
      : { fadeInSec: 0, fadeOutSec: 0 };

    let seq = state.showState.timelines.length + 1;
    while (
      state.showState.timelines.some((t) => t.id === `tl_show_${seq}`) ||
      state.showState.scenes.some((s) => s.id === `sc_tl_${seq}`)
    ) {
      seq += 1;
    }
    const timelineId = `tl_show_${seq}`;
    const sceneId = `sc_tl_${seq}`;
    const tlName = customName?.trim() || `Timeline ${seq}`;

    const newTimeline: TimelineDef = {
      id: timelineId,
      name: tlName,
      duration_sec: 32,
      grid_offset_sec: 0,
      tempo_map: [{ at_sec: 0, bpm: state.showState.bpm || 120 }],
      audio_track: null,
      loop_timeline: false,
      tracks: [
        {
          id: "trk_1",
          name: "Track 1",
          track_type: "untyped",
          target_group: "all",
          clips: [],
        },
      ],
    };

    const newScene: SceneDef = {
      id: sceneId,
      name: tlName,
      bank: normBank,
      target_group: null,
      priority: normBank ? 10 : 25,
      fade_in_sec: defaults.fadeInSec,
      fade_out_sec: defaults.fadeOutSec,
      duration_value: 32,
      duration_unit: "seconds",
      block_refs: [],
      timeline_ref: timelineId,
    };

    await get().upsertTimeline(newTimeline);
    await get().upsertScene(newScene);
    set({
      selectedSceneId: sceneId,
      multiSelectedSceneIds: [sceneId],
      activeTimelineId: timelineId,
      studioSubMode: "builder",
    });
    return newScene;
  },

  convertSceneToTimeline: async (sceneId) => {
    const state = get();
    const scene = state.showState.scenes.find((s) => s.id === sceneId);
    if (!scene) return null;
    if (scene.timeline_ref) {
      set({ activeTimelineId: scene.timeline_ref, studioSubMode: "builder" });
      return scene.timeline_ref;
    }

    let seq = state.showState.timelines.length + 1;
    while (state.showState.timelines.some((t) => t.id === `tl_show_${seq}`)) {
      seq += 1;
    }
    const timelineId = `tl_show_${seq}`;
    const newTimeline: TimelineDef = {
      id: timelineId,
      name: scene.name,
      duration_sec: 32,
      grid_offset_sec: 0,
      tempo_map: [{ at_sec: 0, bpm: state.showState.bpm || 120 }],
      audio_track: null,
      loop_timeline: false,
      tracks: [
        {
          id: "trk_1",
          name: "Track 1",
          track_type: "untyped",
          target_group: "all",
          clips: [],
        },
      ],
    };

    await get().upsertTimeline(newTimeline);
    await get().upsertScene({
      ...scene,
      block_refs: [],
      timeline_ref: timelineId,
    });
    set({
      selectedSceneId: scene.id,
      multiSelectedSceneIds: [scene.id],
      activeTimelineId: timelineId,
      studioSubMode: "builder",
    });
    return timelineId;
  },

  setSelectedTimelineClip: (clip) => set({ selectedTimelineClip: clip }),
  setTimelineTimeUnit: (unit) => set({ timelineTimeUnit: unit }),
  setTimelineSensitivity: (sens) =>
    set({ timelineSensitivity: Math.max(0, Math.min(1, sens)) }),
  setTimelineShowTransients: (enabled) =>
    set({ timelineShowTransients: enabled }),
  setTimelineProjectTransients: (enabled) =>
    set({ timelineProjectTransients: enabled }),

  setFocusedPatchUniverse: (universeId) =>
    set({ focusedPatchUniverse: Math.max(1, universeId) }),

  setStudioOutputMode: (mode) => {
    set({ studioOutputMode: mode });
    if (!isTauriEnvironment()) {
      get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
    }
  },

  setStudioSubMode: (mode) => set({ studioSubMode: mode }),

  selectSceneForEdit: (sceneId, multiSelect = false) => {
    const prev = get();
    const target = sceneId
      ? prev.showState.scenes.find((s) => s.id === sceneId) ?? null
      : null;
    const clearingPausedTimeline =
      Boolean(prev.activeTimelineId) &&
      !prev.timelinePlaying &&
      !target?.timeline_ref;

    set((state) => {
      const nextTimelineId = target?.timeline_ref
        ? target.timeline_ref
        : clearingPausedTimeline
          ? null
          : state.activeTimelineId;
      if (!multiSelect || !sceneId) {
        return {
          selectedSceneId: sceneId,
          multiSelectedSceneIds: sceneId ? [sceneId] : [],
          activeTimelineId: nextTimelineId,
        };
      }
      const exists = state.multiSelectedSceneIds.includes(sceneId);
      const nextMulti = exists
        ? state.multiSelectedSceneIds.filter((id) => id !== sceneId)
        : [...state.multiSelectedSceneIds, sceneId];
      return {
        selectedSceneId: sceneId,
        multiSelectedSceneIds: nextMulti,
        activeTimelineId: nextTimelineId,
      };
    });
    if (clearingPausedTimeline && isTauriEnvironment()) {
      void get().setTimelineTransport(null, false, 0);
    }
    if (!isTauriEnvironment()) {
      get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
    }
  },

  setBankDefaultFade: (bank, fadeInSec, fadeOutSec) => {
    const key = bank.trim();
    set((state) => ({
      bankDefaultFades: {
        ...state.bankDefaultFades,
        [key]: {
          fadeInSec: Math.max(0, fadeInSec),
          fadeOutSec: Math.max(0, fadeOutSec),
        },
      },
    }));
  },

  createSceneBank: (bankName) => {
    const clean = bankName.trim();
    if (!clean) return;
    set((state) => ({
      sceneBanks: state.sceneBanks.includes(clean)
        ? state.sceneBanks
        : [...state.sceneBanks, clean],
    }));
  },

  renameSceneBank: async (oldName, newName) => {
    const from = oldName.trim();
    const to = newName.trim();
    if (!from || !to || from === to) return;
    const state = get();
    const nextBanks = Array.from(
      new Set(state.sceneBanks.map((b) => (b === from ? to : b))),
    );
    const nextStackable = { ...state.stackableBanks };
    if (from in nextStackable) {
      nextStackable[to] = nextStackable[from];
      delete nextStackable[from];
    }
    const nextFades = { ...state.bankDefaultFades };
    if (from in nextFades) {
      nextFades[to] = nextFades[from];
      delete nextFades[from];
    }

    if (isTauriEnvironment()) {
      set({
        sceneBanks: nextBanks,
        stackableBanks: nextStackable,
        bankDefaultFades: nextFades,
      });
      const snap = await invoke<ShowSnapshotDto>("rename_scene_bank_command", {
        oldName: from,
        newName: to,
      });
      get().applyShowSnapshot(snap);
      set((s) => ({
        sceneBanks: Array.from(
          new Set(
            s.sceneBanks
              .filter((b) => b !== from)
              .concat(nextBanks.includes(to) ? [] : [to]),
          ),
        ),
      }));
      return;
    }

    const prevShow = state.showState;
    const hasAffected = prevShow.scenes.some(
      (s) => s.bank?.trim() === from,
    );
    if (!hasAffected) {
      set({
        sceneBanks: nextBanks,
        stackableBanks: nextStackable,
        bankDefaultFades: nextFades,
      });
      return;
    }
    const nextShow: ShowStateDto = {
      ...prevShow,
      scenes: prevShow.scenes.map((sc) =>
        sc.bank?.trim() === from ? { ...sc, bank: to } : sc,
      ),
    };
    const nextUndo = [...state._simUndo, { show: prevShow, coalesceKey: null }];
    set({
      showState: nextShow,
      sceneBanks: nextBanks,
      stackableBanks: nextStackable,
      bankDefaultFades: nextFades,
      _simUndo: nextUndo,
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  deleteSceneBank: async (bankName) => {
    const target = bankName.trim();
    if (!target) return;
    const state = get();
    const remainingBanks = state.sceneBanks.filter((b) => b !== target);
    const nextBanks = remainingBanks.length > 0 ? remainingBanks : ["Bank 1"];
    const toRemove = state.showState.scenes.filter(
      (s) => s.bank?.trim() === target,
    );
    for (const sc of toRemove) {
      await get().deleteScene(sc.id);
    }
    set({
      sceneBanks: nextBanks,
    });
  },

  toggleBankStackable: (bankName) => {
    const target = bankName.trim();
    if (!target) return;
    set((state) => ({
      stackableBanks: {
        ...state.stackableBanks,
        [target]: !state.stackableBanks[target],
      },
    }));
  },

  releaseBankScenes: async (bankName, tSec) => {
    const target = bankName.trim();
    if (!target) return;
    const scenesInBank = get().showState.scenes.filter(
      (s) => s.bank === target,
    );
    for (const sc of scenesInBank) {
      const isActive = get().activeScenes.some(
        (a) => a.scene_id === sc.id && a.release_t_sec === null,
      );
      if (isActive) {
        await get().releaseScene(sc.id, tSec);
      }
    }
  },

  toggleSelectFixtureInstance: (id, additive = true) => {
    set((state) => {
      if (!additive) {
        return {
          selectedFixtureIds: [id],
          selectedFixtureInstanceId: id,
        };
      }
      const exists = state.selectedFixtureIds.includes(id);
      const nextIds = exists
        ? state.selectedFixtureIds.filter((x) => x !== id)
        : [...state.selectedFixtureIds, id];
      return {
        selectedFixtureIds: nextIds,
        selectedFixtureInstanceId:
          nextIds.length > 0 ? nextIds[nextIds.length - 1] : null,
      };
    });
  },

  setSelectedFixtureIds: (ids) =>
    set({
      selectedFixtureIds: ids,
      selectedFixtureInstanceId: ids[0] ?? null,
    }),

  createGroupFromSelectedFixtures: async (groupName) => {
    const state = get();
    const clean = groupName.trim() || `Group ${state.showState.groups.length + 1}`;
    const duplicate = state.showState.groups.find(
      (g) => g.name.trim().toLowerCase() === clean.toLowerCase(),
    );
    if (duplicate) {
      set({
        patchToast: `Group "${clean}" already exists. Choose a unique group name.`,
      });
      return;
    }
    const slugBase = `grp_${clean.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "group"}`;
    let gid = slugBase;
    let suffix = 2;
    while (state.showState.groups.some((g) => g.id === gid)) {
      gid = `${slugBase}_${suffix}`;
      suffix += 1;
    }

    let targets: string[] = [];
    if (state.selectedFixtureIds.length > 0) {
      targets = [...state.selectedFixtureIds];
    } else if (state.selectedCellIndices.length > 0) {
      targets = Array.from(
        new Set(
          state.selectedCellIndices
            .map((idx) => state.compiledCells[idx])
            .filter((c): c is NonNullable<typeof c> => Boolean(c))
            .map((c) => `${c.fixture_id}:${c.cell_index}`),
        ),
      );
    } else if (state.selectedFixtureInstanceId) {
      targets = [state.selectedFixtureInstanceId];
    } else {
      targets = state.showState.patch.map((f) => f.id);
    }

    await get().upsertGroup({
      id: gid,
      name: clean,
      order: state.canvasOrderRule,
      targets,
    });
    set({ activeGroupFilterId: gid });
  },

  createQuickSceneInBank: async (bank) => {
    const state = get();
    const normBank = bank && bank.trim() ? bank.trim() : null;
    if (normBank && !state.sceneBanks.includes(normBank)) {
      set({ sceneBanks: [...state.sceneBanks, normBank] });
    }
    const defaults = normBank
      ? (state.bankDefaultFades[normBank] ?? { fadeInSec: 0, fadeOutSec: 0 })
      : { fadeInSec: 0, fadeOutSec: 0 };

    let seq = state.showState.scenes.length + 1;
    while (state.showState.scenes.some((s) => s.id === `sc_scene_${seq}`)) {
      seq += 1;
    }
    const sceneId = `sc_scene_${seq}`;
    const sceneName = normBank ? `Scene ${seq}` : `Overlay ${seq}`;

    const newScene: SceneDef = {
      id: sceneId,
      name: sceneName,
      bank: normBank,
      target_group: null,
      priority: normBank ? 10 : 25,
      fade_in_sec: defaults.fadeInSec,
      fade_out_sec: defaults.fadeOutSec,
      duration_value: 4,
      duration_unit: "beats",
      block_refs: [],
    };

    const shouldClearTimeline =
      Boolean(state.activeTimelineId) && !state.timelinePlaying;

    if (isTauriEnvironment()) {
      await get().upsertScene(newScene);
      if (shouldClearTimeline) {
        await get().setTimelineTransport(null, false, 0);
      }
      set({
        selectedSceneId: sceneId,
        multiSelectedSceneIds: [sceneId],
      });
      return newScene;
    }

    const prevShow = structuredClone(state.showState);
    const nextShow: ShowStateDto = {
      ...prevShow,
      scenes: [...prevShow.scenes, newScene],
    };
    const nextRev = state.showRevision + 1;
    set({
      showState: nextShow,
      ...(shouldClearTimeline ? { activeTimelineId: null } : {}),
      selectedSceneId: sceneId,
      multiSelectedSceneIds: [sceneId],
      patchToast: `Created ${sceneName}`,
      showRevision: nextRev,
      isDirty: nextRev !== state.savedRevision,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
    return newScene;
  },

  duplicateScene: async (sceneId) => {
    const state = get();
    const src = state.showState.scenes.find((s) => s.id === sceneId);
    if (!src) return null;
    let suffix = 2;
    while (state.showState.scenes.some((s) => s.id === `${src.id}_copy_${suffix}`)) {
      suffix += 1;
    }
    const copy: SceneDef = {
      ...structuredClone(src),
      id: `${src.id}_copy_${suffix}`,
      name: `${src.name} Copy`,
    };
    await get().upsertScene(copy);
    set({
      selectedSceneId: copy.id,
      multiSelectedSceneIds: [copy.id],
    });
    return copy;
  },

  batchUpdateSelectedScenes: async (patch) => {
    const state = get();
    const ids = new Set(state.multiSelectedSceneIds);
    if (ids.size === 0) return;

    if (isTauriEnvironment()) {
      for (const sc of state.showState.scenes) {
        if (!ids.has(sc.id)) continue;
        await get().upsertScene({
          ...sc,
          fade_in_sec: patch.fade_in_sec ?? sc.fade_in_sec,
          fade_out_sec: patch.fade_out_sec ?? sc.fade_out_sec,
          priority: patch.priority ?? sc.priority,
          bank: patch.bank !== undefined ? patch.bank : sc.bank,
        });
      }
      return;
    }

    const prevShow = structuredClone(state.showState);
    const nextScenes = prevShow.scenes.map((sc) =>
      ids.has(sc.id)
        ? {
            ...sc,
            fade_in_sec:
              patch.fade_in_sec !== undefined
                ? Math.max(0, patch.fade_in_sec)
                : sc.fade_in_sec,
            fade_out_sec:
              patch.fade_out_sec !== undefined
                ? Math.max(0, patch.fade_out_sec)
                : sc.fade_out_sec,
            priority:
              patch.priority !== undefined
                ? Math.max(0, Math.round(patch.priority))
                : sc.priority,
            bank: patch.bank !== undefined ? patch.bank : sc.bank,
          }
        : sc,
    );
    set({
      showState: { ...prevShow, scenes: nextScenes },
      patchToast: `Updated ${ids.size} scene(s)`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  toggleSceneFlashMode: (sceneId) => {
    set((state) => ({
      flashSceneIds: {
        ...state.flashSceneIds,
        [sceneId]: !state.flashSceneIds[sceneId],
      },
    }));
  },

  makeFxBlockUniqueForScene: async (sceneId, blockId) => {
    const state = get();
    const scene = state.showState.scenes.find((s) => s.id === sceneId);
    const block = state.showState.fx_library.find((b) => b.id === blockId);
    if (!scene || !block) return null;

    let idx = 2;
    while (state.showState.fx_library.some((b) => b.id === `${block.id}_u${idx}`)) {
      idx += 1;
    }
    const uniqueBlock: FxBlockDef = {
      ...structuredClone(block),
      id: `${block.id}_u${idx}`,
      name: `${block.name} (Unique)`,
    };
    const updatedScene: SceneDef = {
      ...scene,
      block_refs: scene.block_refs.map((r) => (r === blockId ? uniqueBlock.id : r)),
    };

    if (isTauriEnvironment()) {
      await get().upsertFxBlock(uniqueBlock);
      await get().upsertScene(updatedScene);
      return uniqueBlock;
    }

    const prevShow = structuredClone(state.showState);
    const nextShow: ShowStateDto = {
      ...prevShow,
      fx_library: [...prevShow.fx_library, uniqueBlock],
      scenes: prevShow.scenes.map((s) => (s.id === sceneId ? updatedScene : s)),
    };
    set({
      showState: nextShow,
      patchToast: `Created unique FX block ${uniqueBlock.name}`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
    return uniqueBlock;
  },

  updateGroupMixerStrip: (groupId, patch) => {
    set((state) => {
      const prev: GroupMixerStripState = state.groupMixerStrips[groupId] ?? {
        dimmer: 1.0,
        hueShiftDeg: 0,
        saturation: 1.0,
        strobeEnabled: false,
        strobeHz: 8,
        mode: "normal",
        flashActive: false,
        exclusiveFlashActive: false,
      };
      const nextStrips = { ...state.groupMixerStrips };
      if (patch.exclusiveFlashActive) {
        for (const key of Object.keys(nextStrips)) {
          if (key !== groupId) {
            nextStrips[key] = { ...nextStrips[key], exclusiveFlashActive: false };
          }
        }
      }
      if (patch.mode === "exclusive_full") {
        for (const key of Object.keys(nextStrips)) {
          if (key !== groupId && nextStrips[key].mode === "exclusive_full") {
            nextStrips[key] = { ...nextStrips[key], mode: "normal" };
          }
        }
      }
      nextStrips[groupId] = { ...prev, ...patch };
      return { groupMixerStrips: nextStrips };
    });
    if (!isTauriEnvironment()) {
      get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
    }
  },

  captureLiveSnapshotToScene: async (name, bank = null) => {
    const state = get();
    let seq = state.showState.scenes.length + 1;
    while (state.showState.scenes.some((s) => s.id === `sc_snap_${seq}`)) {
      seq += 1;
    }
    const sceneId = `sc_snap_${seq}`;
    const sceneName = name?.trim() || `Live Snapshot ${seq}`;

    // Gather active block refs or convert live layers into static elements
    const activeBlockRefs: string[] = [];
    for (const inst of state.activeScenes) {
      if (inst.release_t_sec !== null) continue;
      const sc = state.showState.scenes.find((s) => s.id === inst.scene_id);
      if (sc) {
        for (const br of sc.block_refs) {
          if (!activeBlockRefs.includes(br)) activeBlockRefs.push(br);
        }
      }
    }

    let blkSeq = state.showState.fx_library.length + 1;
    while (state.showState.fx_library.some((b) => b.id === `blk_snap_${blkSeq}`)) {
      blkSeq += 1;
    }
    const snapBlockId = `blk_snap_${blkSeq}`;
    const elementsFromLive: FxElementDef[] = [];

    for (const layer of state.liveLayers) {
      if (!layer.enabled || layer.alpha <= 0) continue;
      const spec = layer.trait_spec;
      if (spec.trait_kind === "dimmer") {
        elementsFromLive.push({
          kind: "static_trait",
          trait: "dimmer",
          op: spec.op,
          palette_ref: spec.palette_ref,
          value_start: spec.value_start,
          value_end: spec.value_end,
          order: layer.order_override,
        });
      } else if (spec.trait_kind === "color") {
        elementsFromLive.push({
          kind: "static_trait",
          trait: "color",
          op: spec.op,
          palette_ref: spec.palette_ref,
          value_start: 0,
          value_end: 1,
          order: layer.order_override,
        });
      } else if (spec.trait_kind === "master_dimmer") {
        elementsFromLive.push({
          kind: "static_trait",
          trait: "master_dimmer",
          op: spec.op,
          palette_ref: null,
          value_start: spec.value,
          value_end: spec.value,
          order: layer.order_override,
        });
      }
    }

    if (elementsFromLive.length === 0 && activeBlockRefs.length === 0) {
      elementsFromLive.push({
        kind: "static_trait",
        trait: "dimmer",
        op: "htp",
        palette_ref: null,
        value_start: 1,
        value_end: 1,
        order: null,
      });
    }

    const addedBlocks: FxBlockDef[] = [];
    if (elementsFromLive.length > 0) {
      addedBlocks.push({
        id: snapBlockId,
        name: `${sceneName} Look`,
        target_group: "all",
        duration_beats: 4,
        loop_block: true,
        elements: elementsFromLive,
      });
      activeBlockRefs.push(snapBlockId);
    }

    const newScene: SceneDef = {
      id: sceneId,
      name: sceneName,
      bank: bank && bank.trim() ? bank.trim() : null,
      target_group: null,
      priority: 20,
      fade_in_sec: 0,
      fade_out_sec: 0,
      duration_value: 4,
      duration_unit: "beats",
      block_refs: activeBlockRefs,
    };

    if (isTauriEnvironment()) {
      for (const blk of addedBlocks) await get().upsertFxBlock(blk);
      await get().upsertScene(newScene);
      set({ selectedSceneId: sceneId, multiSelectedSceneIds: [sceneId] });
      return newScene;
    }

    const prevShow = structuredClone(state.showState);
    set({
      showState: {
        ...prevShow,
        fx_library: [...prevShow.fx_library, ...addedBlocks],
        scenes: [...prevShow.scenes, newScene],
      },
      selectedSceneId: sceneId,
      multiSelectedSceneIds: [sceneId],
      patchToast: `Captured ${sceneName}`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      showRevision: state.showRevision + 1,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    });
    return newScene;
  },

  setMappingOverlayMode: (mode) =>
    set({ mappingOverlayMode: mode, selectedMappingTarget: null }),

  setSelectedMappingTarget: (targetId) =>
    set({ selectedMappingTarget: targetId }),

  bindKeyToTarget: (targetId, key) =>
    set((state) => ({
      keyBindings: { ...state.keyBindings, [targetId]: key },
      selectedMappingTarget: null,
    })),

  bindMidiToTarget: (targetId, midiLabel) =>
    set((state) => ({
      midiBindings: { ...state.midiBindings, [targetId]: midiLabel },
      selectedMappingTarget: null,
    })),

  applyCellSelectionPattern: (pattern, groupFilterId) => {
    const state = get();
    const total = state.compiledCells.length;
    if (total === 0) {
      set({ selectedCellIndices: [] });
      return;
    }
    const candidateIndices: number[] = [];
    const targetGrp =
      groupFilterId && groupFilterId !== "all"
        ? state.showState.groups.find((g) => g.id === groupFilterId) ?? null
        : null;
    if (targetGrp) {
      state.compiledCells.forEach((c, idx) => {
        const matches = targetGrp.targets.some(
          (t) => t === c.fixture_id || t.startsWith(`${c.fixture_id}:`),
        );
        if (matches) candidateIndices.push(idx);
      });
    } else {
      for (let i = 0; i < total; i++) candidateIndices.push(i);
    }

    if (candidateIndices.length === 0) {
      set({ selectedCellIndices: [] });
      return;
    }

    let next: number[] = [];
    if (pattern === "all") {
      next = [...candidateIndices];
    } else if (pattern === "1/2") {
      next = candidateIndices.filter((_, pos) => pos % 2 === 0);
    } else if (pattern === "1/3") {
      next = candidateIndices.filter((_, pos) => pos % 3 === 0);
    } else if (pattern === "1/4") {
      next = candidateIndices.filter((_, pos) => pos % 4 === 0);
    } else if (pattern === "invert") {
      const curSet = new Set(state.selectedCellIndices);
      next = candidateIndices.filter((idx) => !curSet.has(idx));
    } else if (pattern === "shift_left" || pattern === "shift_right") {
      const curSet = new Set(
        state.selectedCellIndices.length > 0
          ? state.selectedCellIndices
          : [candidateIndices[0]],
      );
      const delta = pattern === "shift_right" ? 1 : -1;
      const len = candidateIndices.length;
      const shiftedPositions = new Set<number>();
      candidateIndices.forEach((cellIdx, pos) => {
        if (curSet.has(cellIdx)) {
          shiftedPositions.add(((pos + delta) % len + len) % len);
        }
      });
      next = candidateIndices.filter((_, pos) => shiftedPositions.has(pos));
    }

    set({ selectedCellIndices: next });
  },

  setSelectedCellIndices: (indices) => set({ selectedCellIndices: indices }),

  setActiveGroupFilterId: (groupId) => set({ activeGroupFilterId: groupId }),

  setCanvasOrderRule: (rule) => set({ canvasOrderRule: rule }),

  setActiveShaderGizmoBlockId: (blockId) =>
    set({ activeShaderGizmoBlockId: blockId }),
  setDraggingSceneId: (sceneId) => set({ draggingSceneId: sceneId }),

  dismissToast: () => set({ patchToast: null }),

  resetForTest: () => set(createInitialState()),
}));
