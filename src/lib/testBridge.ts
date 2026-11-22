import { isTauriEnvironment, useTaktStore } from "../store/useTaktStore";

export interface CanvasFixturePoint {
  id: string;
  name: string;
  gridX: number;
  gridY: number;
  rotation: number;
  clientX: number;
  clientY: number;
  rotationHandleX: number;
  rotationHandleY: number;
}

export interface CanvasShaderGizmoPoints {
  active: boolean;
  blockId: string | null;
  centerNormX: number;
  centerNormY: number;
  directionDeg: number;
  spatialFreq: number;
  centerClientX: number;
  centerClientY: number;
  angleHandleClientX: number;
  angleHandleClientY: number;
  scaleHandleClientX: number;
  scaleHandleClientY: number;
}

export interface CanvasGeometrySnapshot {
  canvasRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  zoom: number;
  pan: { x: number; y: number };
  fixtures: CanvasFixturePoint[];
  shaderGizmo: CanvasShaderGizmoPoints | null;
}

export interface TaktLightTestBridge {
  version: string;
  getStatus: () => {
    connectedMode: "tauri" | "simulation";
    isTauri: boolean;
    activeTab: string;
    studioSubMode: string;
    outputEnabled: boolean;
    isOffline: boolean;
    blackout: boolean;
    grandMaster: number;
    liveBpm: number;
    timelinePlaying: boolean;
    timelinePlayheadSec: number;
    canUndo: boolean;
    canRedo: boolean;
    isDirty: boolean;
    patchCount: number;
    compiledCellCount: number;
    sceneCount: number;
    fxBlockCount: number;
    timelineCount: number;
    activeSceneIds: string[];
    parkedChannels: Record<string, number>;
    activeInterface: {
      name: string;
      ipv4: string;
      broadcast: string;
      subnet_cidr: string;
    } | null;
    telemetry: {
      revision: string;
      tSec: number;
      meanUs: number;
      maxJitterUs: number;
      p99JitterUs: number;
      droppedFrames: number;
    };
  };
  getDmxUniverse: (universeId?: number) => number[];
  getDmxSlice: (
    universeId: number,
    startChannel1Indexed: number,
    count: number,
  ) => Array<{ ch: number; val: number }>;
  getNonZeroDmx: (universeId?: number) => Array<{ ch: number; val: number }>;
  getPatch: () => Array<{
    id: string;
    name: string;
    profile: string;
    mode: string;
    universe: number;
    address: number;
    channel_count: number;
    grid_pos: {
      x: number;
      y: number;
      rotation: number;
      scale_x: number;
      scale_y: number;
    };
  }>;
  getScenes: () => Array<{
    id: string;
    name: string;
    bank: string | null;
    block_refs: string[];
  }>;
  getFxBlocks: () => Array<{
    id: string;
    name: string;
    elementCount: number;
    elementKinds: string[];
  }>;
  getTimelines: () => Array<{
    id: string;
    name: string;
    duration_sec: number;
    trackCount: number;
    clipCount: number;
    tracks: Array<{
      id: string;
      name: string;
      track_type: string;
      clips: Array<{
        start_sec: number;
        duration_sec: number;
        fade_in_sec: number;
        fade_out_sec: number;
        ref_block: string | null;
        audio_file: string | null;
        time_stretch: boolean;
      }>;
    }>;
  }>;
  getCellPreviews: () => Array<{
    index: number;
    fixture_id: string;
    cell_index: number;
    canvas_xy: [number, number];
    r: number;
    g: number;
    b: number;
    d: number;
  }>;
  getCanvasGeometry: () => CanvasGeometrySnapshot | null;
}

declare global {
  interface Window {
    __TAKTLIGHT_TEST__?: TaktLightTestBridge;
  }
}

let canvasGeometryGetter: (() => CanvasGeometrySnapshot | null) | null = null;

export function registerCanvasGeometry(
  getter: (() => CanvasGeometrySnapshot | null) | null,
): void {
  canvasGeometryGetter = getter;
}

export function createTestBridge(): TaktLightTestBridge {
  return {
    version: "1.0",
    getStatus() {
      const s = useTaktStore.getState();
      return {
        connectedMode: s.connectedMode,
        isTauri: isTauriEnvironment(),
        activeTab: s.activeTab,
        studioSubMode: s.studioSubMode,
        outputEnabled: s.outputEnabled,
        isOffline: s.isOffline,
        blackout: s.blackout,
        grandMaster: s.grandMaster,
        liveBpm: s.liveBpm,
        timelinePlaying: s.timelinePlaying,
        timelinePlayheadSec: s.timelinePlayheadSec,
        canUndo: s.canUndo,
        canRedo: s.canRedo,
        isDirty: s.isDirty,
        patchCount: s.showState.patch.length,
        compiledCellCount: s.compiledCells.length,
        sceneCount: s.showState.scenes.length,
        fxBlockCount: s.showState.fx_library.length,
        timelineCount: s.showState.timelines.length,
        activeSceneIds: s.activeScenes
          .filter((inst) => inst.release_t_sec === null)
          .map((inst) => inst.scene_id),
        parkedChannels: { ...s.parkedChannels },
        activeInterface: s.activeInterface
          ? {
              name: s.activeInterface.name,
              ipv4: s.activeInterface.ipv4,
              broadcast: s.activeInterface.broadcast,
              subnet_cidr: s.activeInterface.subnet_cidr,
            }
          : null,
        telemetry: {
          revision: String(s.telemetry.revision),
          tSec: s.telemetry.tSec,
          meanUs: s.telemetry.meanUs,
          maxJitterUs: s.telemetry.maxJitterUs,
          p99JitterUs: s.telemetry.p99JitterUs,
          droppedFrames: s.telemetry.droppedFrames,
        },
      };
    },
    getDmxUniverse(universeId = 1) {
      const buf = useTaktStore.getState().dmxByUniverse[universeId];
      return buf ? Array.from(buf) : new Array<number>(512).fill(0);
    },
    getDmxSlice(universeId, startChannel1Indexed, count) {
      const buf = useTaktStore.getState().dmxByUniverse[universeId];
      const start = Math.max(1, Math.min(512, Math.floor(startChannel1Indexed)));
      const len = Math.max(0, Math.min(512 - start + 1, Math.floor(count)));
      const out: Array<{ ch: number; val: number }> = [];
      for (let i = 0; i < len; i++) {
        const ch = start + i;
        out.push({ ch, val: buf ? (buf[ch - 1] ?? 0) : 0 });
      }
      return out;
    },
    getNonZeroDmx(universeId = 1) {
      const buf = useTaktStore.getState().dmxByUniverse[universeId];
      if (!buf) return [];
      const out: Array<{ ch: number; val: number }> = [];
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] > 0) {
          out.push({ ch: i + 1, val: buf[i] });
        }
      }
      return out;
    },
    getPatch() {
      return useTaktStore.getState().showState.patch.map((fx) => ({
        id: fx.id,
        name: fx.name,
        profile: fx.profile,
        mode: fx.mode,
        universe: fx.universe,
        address: fx.address,
        channel_count: fx.channel_count,
        grid_pos: { ...fx.grid_pos },
      }));
    },
    getScenes() {
      return useTaktStore.getState().showState.scenes.map((sc) => ({
        id: sc.id,
        name: sc.name,
        bank: sc.bank,
        block_refs: [...sc.block_refs],
      }));
    },
    getFxBlocks() {
      return useTaktStore.getState().showState.fx_library.map((blk) => ({
        id: blk.id,
        name: blk.name,
        elementCount: blk.elements.length,
        elementKinds: blk.elements.map((el) => el.kind),
      }));
    },
    getTimelines() {
      return useTaktStore.getState().showState.timelines.map((tl) => ({
        id: tl.id,
        name: tl.name,
        duration_sec: tl.duration_sec,
        trackCount: tl.tracks.length,
        clipCount: tl.tracks.reduce((acc, trk) => acc + trk.clips.length, 0),
        tracks: tl.tracks.map((trk) => ({
          id: trk.id,
          name: trk.name,
          track_type: trk.track_type ?? "untyped",
          clips: trk.clips.map((c) => ({
            start_sec: c.start_sec,
            duration_sec: c.duration_sec,
            fade_in_sec: c.fade_in_sec,
            fade_out_sec: c.fade_out_sec,
            ref_block: c.ref_block ?? null,
            audio_file: c.audio_file ?? null,
            time_stretch: Boolean(c.time_stretch),
          })),
        })),
      }));
    },
    getCellPreviews() {
      const { compiledCells, cellPreviewRgbd } = useTaktStore.getState();
      return compiledCells.map((cell, idx) => {
        const base = idx * 4;
        return {
          index: idx,
          fixture_id: cell.fixture_id,
          cell_index: cell.cell_index,
          canvas_xy: [cell.canvas_xy[0], cell.canvas_xy[1]],
          r: cellPreviewRgbd[base] ?? 0,
          g: cellPreviewRgbd[base + 1] ?? 0,
          b: cellPreviewRgbd[base + 2] ?? 0,
          d: cellPreviewRgbd[base + 3] ?? 0,
        };
      });
    },
    getCanvasGeometry() {
      return canvasGeometryGetter ? canvasGeometryGetter() : null;
    },
  };
}

export function installTestBridge(): TaktLightTestBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = createTestBridge();
  window.__TAKTLIGHT_TEST__ = bridge;
  return bridge;
}
