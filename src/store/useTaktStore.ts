import { Channel, invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  decodeBinaryFrame,
  DMX_UNIVERSE_CHANNELS,
  encodeBinaryFrame,
  normalizeFramePayload,
} from "../lib/frameDecoder";

export type DisplayFormat = "DEC" | "HEX" | "PCT";

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

export interface TelemetrySummary {
  revision: bigint;
  tSec: number;
  meanUs: number;
  maxJitterUs: number;
  p99JitterUs: number;
  droppedFrames: number;
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
    protocol: {
      protocol: "sacn",
      mode: { mode: "multicast" },
      sacn_universe: 2,
      priority: 100,
    },
  },
];

function createInitialDmxMap(
  universes: UniverseConfig[],
): Record<number, Uint8Array> {
  const map: Record<number, Uint8Array> = {};
  for (const u of universes) {
    map[u.id] = new Uint8Array(DMX_UNIVERSE_CHANNELS);
  }
  return map;
}

function createInitialState() {
  return {
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
  };
}

function synthesizeSimulationBuffer(state: {
  universes: UniverseConfig[];
  parkedChannels: Record<string, number>;
  telemetry: TelemetrySummary;
  jitterSamplesUs: number[];
}): ArrayBuffer {
  const universeBuffers = state.universes.map((uni) => {
    const dmx = new Uint8Array(DMX_UNIVERSE_CHANNELS);
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
    cellCount: 0,
    droppedFrames: 0,
    meanUs,
    maxJitterUs,
    p99JitterUs,
    universes: universeBuffers,
    cellPreviewRgbd: new Uint8Array(0),
  });
}

export interface TaktStoreState {
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

  applyBinaryFrame: (buffer: ArrayBuffer) => void;
  applyEngineSnapshot: (snapshot: EngineSnapshotDto) => void;
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
  resetForTest: () => void;
}

export const useTaktStore = create<TaktStoreState>((set, get) => ({
  ...createInitialState(),

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

    // Browser / offline UI dev simulation at ~44 Hz
    let tick = 0;
    const simTimer = setInterval(() => {
      const state = get();
      // Deterministic tiny ±15 us pseudo-jitter for visual histogram preview
      const pseudoJitter = Math.sin(tick * 1.7) * 14.0 + Math.cos(tick * 0.9) * 6.0;
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

  resetForTest: () => set(createInitialState()),
}));
