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
  DimmerPaletteDef,
  evaluateSimulationLayersToDmx,
  type FxBlockDef,
  type FxElementDef,
  type MergeOp,
  type SceneDef,
  type Shader2DKind,
  SmartControlLayer,
  type TempoPointDef,
  type TimelineDef,
  type TrackDef,
  type Waveform1D,
} from "../lib/mixerLogic";
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
export type WorkspaceTab =
  | "monitor"
  | "patch"
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
    color_palettes: [
      {
        id: "pal_cyber",
        name: "Cyberpunk Dual",
        hex_start: "#FF5500",
        hex_end: "#2255AA",
      },
      {
        id: "pal_warm",
        name: "Warm Tungsten",
        hex_start: "#FFAA44",
        hex_end: "#FF8822",
      },
    ],
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
        id: "sc_cyber_wave",
        name: "Cyberpunk Wave",
        bank: "main",
        target_group: null,
        priority: 10,
        fade_in_sec: 0,
        fade_out_sec: 0.5,
        block_refs: ["blk_cyber_wave"],
      },
    ],
    timelines: [
      {
        id: "tl_cyber_intro",
        name: "Cyber Intro",
        duration_sec: 16.0,
        grid_offset_sec: 0.0,
        tempo_map: [{ at_sec: 0.0, bpm: 120.0 }],
        audio_track: {
          file: "audio/cyber_intro.wav",
          abs_fallback: null,
          sha256: null,
          offset_sec: 0.0,
          transient_sensitivity: 0.65,
        },
        tracks: [
          {
            id: "trk_1",
            name: "Tube Wave",
            target_group: "all",
            clips: [
              {
                ref_block: "blk_cyber_wave",
                start_sec: 0.0,
                duration_sec: 8.0,
                fade_in_sec: 0.0,
                fade_out_sec: 0.5,
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
    activeTab: "monitor" as WorkspaceTab,
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
    latencyOffsetMs: 0,
    _simTimelineAnchorTSec: 0,
    audioAnalysisByTimeline: {} as Record<string, AudioAnalysisResult>,
    compiledCells: [] as CompiledCell[],
    cellPreviewRgbd: new Uint8Array(0),
    canUndo: false,
    canRedo: false,
    rolloverEnabled: true,
    patchToast: null as string | null,
    crossProtocolWarning: false,
    selectedFixtureInstanceId: null as string | null,
    focusedPatchUniverse: 1,
    _simUndo: [] as SimUndoEntry[],
    _simRedo: [] as SimUndoEntry[],
    _simNextSeq: 1,
    _simSceneSeq: 1,
    _simBeatClock: { bpm: 120, t_anchor_sec: 0, beat_anchor: 0 } as BeatClockAnchor,
    _simTapHistory: [] as number[],
  };
}

function synthesizeSimulationBuffer(state: {
  universes: UniverseConfig[];
  parkedChannels: Record<string, number>;
  grandMaster: number;
  blackout: boolean;
  liveLayers: SmartControlLayer[];
  activeScenes: ActiveSceneInstance[];
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
  const simOut = evaluateSimulationLayersToDmx({
    show: state.showState,
    fixtureDetailsCache: state.fixtureDetailsCache,
    liveLayers: state.liveLayers,
    activeScenes: state.activeScenes,
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

  const uniLookup = new Map<number, Uint8Array>();
  state.universes.forEach((u, idx) => uniLookup.set(u.id, universeBuffers[idx]));

  const cellPreviewRgbd = new Uint8Array(state.compiledCells.length * 4);
  let cellOffset = 0;
  for (const inst of state.showState.patch) {
    const detail = state.fixtureDetailsCache[inst.profile];
    const mode = detail?.expanded_modes.find((m) => m.name === inst.mode);
    const cellCount = mode?.cells.length ?? 1;
    const channels = mode?.channels ?? [];

    let masterDimmer: number | null = null;
    for (const ch of channels) {
      if (ch.target.scope === "fixture" && ch.role.kind === "intensity") {
        const linear = inst.address + ch.dmx_offset;
        const uId = linear <= 512 ? inst.universe : inst.universe + 1;
        const addr = linear <= 512 ? linear : linear - 512;
        masterDimmer = uniLookup.get(uId)?.[addr - 1] ?? 0;
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
        if (ch.role.kind === "intensity") cellDim = val;
        if (ch.role.kind === "color_intensity") {
          if (ch.role.color === "Red") r = Math.max(r, val);
          if (ch.role.color === "Green") g = Math.max(g, val);
          if (ch.role.color === "Blue") b = Math.max(b, val);
          if (ch.role.color === "White") w = Math.max(w, val);
        }
      }
      const rr = Math.min(255, r + w);
      const gg = Math.min(255, g + w);
      const bb = Math.min(255, b + w);
      let eff =
        cellDim !== null && masterDimmer !== null
          ? Math.floor((cellDim * masterDimmer) / 255)
          : cellDim ?? masterDimmer ?? (rr > 0 || gg > 0 || bb > 0 ? 255 : 0);
      if (eff === 0 && (rr > 0 || gg > 0 || bb > 0)) {
        eff = Math.floor(Math.max(rr, gg, bb) / 2);
      }
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
    ...show.color_palettes.map(
      (p) =>
        `    <ColorPalette id="${esc(p.id)}" name="${esc(p.name)}" hex_start="${esc(p.hex_start)}" hex_end="${esc(p.hex_end)}" />`,
    ),
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
          const pr = el.palette_ref ? ` palette_ref="${escFn(el.palette_ref)}"` : "";
          const ord = el.order ? ` order="${escFn(el.order)}"` : "";
          return `${indent}<Curve1D trait="${escFn(el.trait)}" op="${escFn(el.op)}" waveform="${escFn(el.waveform)}" amplitude="${el.amplitude}" offset="${el.offset}"${rb}${sh} phase_spread_deg="${el.phase_spread_deg}"${pr}${ord} />`;
        }
        if (el.kind === "step_chase") {
          const sb = el.step_beats !== null ? ` step_beats="${el.step_beats}"` : "";
          const ar = el.active_ratio !== null ? ` active_ratio="${el.active_ratio}"` : "";
          const pr = el.palette_ref ? ` palette_ref="${escFn(el.palette_ref)}"` : "";
          const ord = el.order ? ` order="${escFn(el.order)}"` : "";
          return `${indent}<StepChase trait="${escFn(el.trait)}" op="${escFn(el.op)}"${sb}${ar} fade="${el.fade}" amplitude="${el.amplitude}"${pr}${ord} />`;
        }
        const rb = el.rate_beats !== null ? ` rate_beats="${el.rate_beats}"` : "";
        const pr = el.palette_ref ? ` palette_ref="${escFn(el.palette_ref)}"` : "";
        return `${indent}<SpatialShader2D trait="${escFn(el.trait)}" op="${escFn(el.op)}" shader="${escFn(el.shader)}"${pr}${rb} spatial_freq="${el.spatial_freq}" direction_deg="${el.direction_deg}" center_x="${el.center_x}" center_y="${el.center_y}" />`;
      })
      .join("\n");

  const fxLines = show.fx_library
    .map((b) => {
      const elemLines = serializeFxElementsXml(b.elements, "      ", esc);
      const tg = b.target_group ? ` target_group="${esc(b.target_group)}"` : "";
      return `    <FxBlock id="${esc(b.id)}" name="${esc(b.name)}"${tg} duration_beats="${b.duration_beats}" loop="${b.loop_block}">\n${elemLines}\n    </FxBlock>`;
    })
    .join("\n");

  const sceneLines = show.scenes
    .map((sc) => {
      const bStr = sc.bank ? ` bank="${esc(sc.bank)}"` : "";
      const tg = sc.target_group ? ` target_group="${esc(sc.target_group)}"` : "";
      const refs = sc.block_refs
        .map((r) => `      <BlockRef ref="${esc(r)}" />`)
        .join("\n");
      return `    <Scene id="${esc(sc.id)}" name="${esc(sc.name)}"${bStr}${tg} priority="${sc.priority}" fade_in_sec="${sc.fade_in_sec}" fade_out_sec="${sc.fade_out_sec}">\n${refs}\n    </Scene>`;
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
          const clipLines = trk.clips
            .map((clip) => {
              const rb = clip.ref_block ? ` ref_block="${esc(clip.ref_block)}"` : "";
              if (clip.inline_fx.length === 0) {
                return `        <Clip${rb} start_sec="${clip.start_sec}" duration_sec="${clip.duration_sec}" fade_in_sec="${clip.fade_in_sec}" fade_out_sec="${clip.fade_out_sec}" />`;
              }
              const inlineXml = serializeFxElementsXml(clip.inline_fx, "          ", esc);
              return `        <Clip${rb} start_sec="${clip.start_sec}" duration_sec="${clip.duration_sec}" fade_in_sec="${clip.fade_in_sec}" fade_out_sec="${clip.fade_out_sec}">\n${inlineXml}\n        </Clip>`;
            })
            .join("\n");
          return `      <Track id="${esc(trk.id)}" name="${esc(trk.name)}"${tg}>\n${clipLines}\n      </Track>`;
        })
        .join("\n");
      return `    <Timeline id="${esc(tl.id)}" name="${esc(tl.name)}" duration_sec="${tl.duration_sec}" grid_offset_sec="${tl.grid_offset_sec}">\n      <TempoMap>\n${tempoLines}\n      </TempoMap>\n${audioLine}${trackLines}\n    </Timeline>`;
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
    color_palettes.push({
      id: el.getAttribute("id") ?? `pal_${color_palettes.length + 1}`,
      name: el.getAttribute("name") ?? "Color Palette",
      hex_start: el.getAttribute("hex_start") ?? "#FF5500",
      hex_end: el.getAttribute("hex_end") ?? "#2255AA",
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
          phase_spread_deg: Number(child.getAttribute("phase_spread_deg") ?? 0),
          duty: child.getAttribute("duty")
            ? Number(child.getAttribute("duty"))
            : null,
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
          active_ratio: child.getAttribute("active_ratio")
            ? Number(child.getAttribute("active_ratio"))
            : null,
          fade: Number(child.getAttribute("fade") ?? 0),
          amplitude: Number(child.getAttribute("amplitude") ?? 1),
          palette_ref,
          order: (child.getAttribute("order") as OrderRuleStr) ?? null,
        });
      } else if (tag === "SpatialShader2D") {
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
          spatial_freq: Number(child.getAttribute("spatial_freq") ?? 1),
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
    scenes.push({
      id: el.getAttribute("id") ?? `sc_${scenes.length + 1}`,
      name: el.getAttribute("name") ?? "Scene",
      bank: el.getAttribute("bank"),
      target_group: el.getAttribute("target_group"),
      priority: Number(el.getAttribute("priority") ?? 10),
      fade_in_sec: Number(el.getAttribute("fade_in_sec") ?? 0),
      fade_out_sec: Number(el.getAttribute("fade_out_sec") ?? 0.5),
      block_refs,
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
        });
      });
      tracks.push({
        id: trkEl.getAttribute("id") ?? `trk_${tracks.length + 1}`,
        name: trkEl.getAttribute("name") ?? "Track",
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
  latencyOffsetMs: number;
  _simTimelineAnchorTSec: number;
  audioAnalysisByTimeline: Record<string, AudioAnalysisResult>;
  compiledCells: CompiledCell[];
  cellPreviewRgbd: Uint8Array;
  canUndo: boolean;
  canRedo: boolean;
  rolloverEnabled: boolean;
  patchToast: string | null;
  crossProtocolWarning: boolean;
  selectedFixtureInstanceId: string | null;
  focusedPatchUniverse: number;
  _simUndo: SimUndoEntry[];
  _simRedo: SimUndoEntry[];
  _simNextSeq: number;
  _simSceneSeq: number;
  _simBeatClock: BeatClockAnchor;
  _simTapHistory: number[];

  setActiveTab: (tab: WorkspaceTab) => void;
  applyBinaryFrame: (buffer: ArrayBuffer) => void;
  applyEngineSnapshot: (snapshot: EngineSnapshotDto) => void;
  applyShowSnapshot: (snapshot: ShowSnapshotDto) => void;
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
  selectFixtureInstance: (id: string | null) => void;
  setFocusedPatchUniverse: (universeId: number) => void;
  dismissToast: () => void;
  resetForTest: () => void;
}

export const useTaktStore = create<TaktStoreState>((set, get) => ({
  ...createInitialState(),

  setActiveTab: (tab) => set({ activeTab: tab }),

  applyBinaryFrame: (buffer) => {
    const decoded = decodeBinaryFrame(buffer);
    set((state) => {
      const nextDmx: Record<number, Uint8Array> = { ...state.dmxByUniverse };
      decoded.universes.forEach((uData, idx) => {
        const uniId = state.universes[idx]?.id ?? idx + 1;
        nextDmx[uniId] = uData;
      });
      return {
        dmxByUniverse: nextDmx,
        cellPreviewRgbd: decoded.cellPreviewRgbd,
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
        timelinePlayheadSec:
          snapshot.timeline_playhead_sec !== undefined
            ? snapshot.timeline_playhead_sec
            : state.timelinePlayheadSec,
        latencyOffsetMs:
          snapshot.latency_offset_ms !== undefined
            ? snapshot.latency_offset_ms
            : state.latencyOffsetMs,
        universes: snapshot.universes,
        dmxByUniverse: nextDmx,
        interfaces: snapshot.interfaces,
        adapterSelection: snapshot.adapter_selection,
        isOffline: snapshot.is_offline,
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

  applyShowSnapshot: (snapshot) => {
    set((state) => {
      const nextUniverses = snapshot.show.network_outputs.universes;
      const nextDmx: Record<number, Uint8Array> = {};
      for (const u of nextUniverses) {
        nextDmx[u.id] =
          state.dmxByUniverse[u.id] ?? new Uint8Array(DMX_UNIVERSE_CHANNELS);
      }
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
      };
    });
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
      set({ jitterSamplesUs: nextSamples });
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
      return;
    }
    const cache = get().fixtureDetailsCache;
    set({
      fixtureSummaries: Object.values(cache)
        .map((d) => d.summary)
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
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
      get().applyShowSnapshot(snapshot);
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
      get().applyShowSnapshot(snapshot);
      return;
    }

    const state = get();
    const prevShow = structuredClone(state.showState);
    const imported = parseShowXmlLocally(xmlStr, state.fixtureDetailsCache);
    set({
      showState: imported,
      universes: imported.network_outputs.universes,
      compiledCells: compileCellsLocally(
        imported.patch,
        state.fixtureDetailsCache,
      ),
      patchToast: "Imported .takt.xml show",
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
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  upsertGroup: async (group) => {
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
      patchToast: `Saved scene ${scene.name}`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
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
    set({
      showState: {
        ...prevShow,
        scenes: prevShow.scenes.filter((s) => s.id !== id),
      },
      patchToast: `Deleted scene ${id}`,
      _simUndo: [...state._simUndo, { show: prevShow, coalesceKey: null }],
      _simRedo: [],
      canUndo: true,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  triggerScene: async (sceneId, tSec) => {
    if (isTauriEnvironment()) {
      const snap = await invoke<EngineSnapshotDto>("trigger_scene_command", {
        sceneId,
        tSec: tSec ?? null,
      });
      get().applyEngineSnapshot(snap);
      return;
    }
    const state = get();
    const scene = state.showState.scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    const tNow = tSec ?? state.telemetry.tSec;
    const normBank = scene.bank?.trim() ? scene.bank.trim() : null;

    const remaining = state.activeScenes
      .filter((inst) => {
        const a = computeSceneAlphaAt(inst, tNow);
        return !(inst.release_t_sec !== null && a <= 1e-6);
      })
      .filter((inst) => inst.scene_id !== sceneId)
      .map((inst) => {
        if (
          normBank &&
          inst.bank === normBank &&
          inst.release_t_sec === null
        ) {
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

    set({
      activeScenes: [...remaining, nextInst],
      _simSceneSeq: seq + 1,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  releaseScene: async (sceneId, tSec) => {
    if (isTauriEnvironment()) {
      const snap = await invoke<EngineSnapshotDto>("release_scene_command", {
        sceneId,
        tSec: tSec ?? null,
      });
      get().applyEngineSnapshot(snap);
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
    set({ activeScenes: updated });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  releaseAllScenes: async (tSec) => {
    if (isTauriEnvironment()) {
      const snap = await invoke<EngineSnapshotDto>(
        "release_all_scenes_command",
        { tSec: tSec ?? null },
      );
      get().applyEngineSnapshot(snap);
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
    set({ activeScenes: updated });
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
      canUndo: nextUndo.length > 0,
      canRedo: false,
    });
    get().applyBinaryFrame(synthesizeSimulationBuffer(get()));
  },

  setTimelineTransport: async (timelineId, playing, playheadSec, tSec) => {
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
        _simTimelineAnchorTSec: tNow,
      });
    } else {
      const nextHead =
        playheadSec !== undefined && !Number.isNaN(playheadSec)
          ? Math.max(0, playheadSec)
          : state.timelinePlayheadSec;
      set({
        activeTimelineId: normId,
        timelinePlaying: playing,
        timelinePlayheadSec: nextHead,
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

  setFocusedPatchUniverse: (universeId) =>
    set({ focusedPatchUniverse: Math.max(1, universeId) }),

  dismissToast: () => set({ patchToast: null }),

  resetForTest: () => set(createInitialState()),
}));
