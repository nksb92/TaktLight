import type { UniverseConfig } from "../store/useTaktStore";
import type {
  ColorPaletteDef,
  DimmerPaletteDef,
  FxBlockDef,
  SceneDef,
} from "./mixerLogic";

export type WhiteMode = "replace" | "add" | "off";
export type OrderRuleStr =
  | "linear"
  | "reverse"
  | "center_out"
  | "mirror"
  | "odd_even"
  | `blocks(${number})`;

export interface GridPos {
  x: number;
  y: number;
  rotation: number;
  scale_x: number;
  scale_y: number;
}

export interface FixtureCalibration {
  gamma: number;
  min_dimmer_dmx: number;
  max_dimmer_dmx: number;
  white_mode: WhiteMode;
  white_gain: number;
}

export interface FixtureInstance {
  id: string;
  profile: string;
  mode: string;
  name: string;
  universe: number;
  address: number;
  channel_count: number;
  grid_pos: GridPos;
  calibration: FixtureCalibration;
}

export interface CompiledCell {
  fixture_index: number;
  fixture_id: string;
  cell_index: number;
  pixel_key: string;
  canvas_xy: [number, number];
}

export interface FixtureGroupDef {
  id: string;
  name: string;
  order: OrderRuleStr;
  targets: string[];
}

export interface ShowStateDto {
  version: string;
  name: string;
  bpm: number;
  read_only_newer_version: boolean;
  network_outputs: {
    frame_rate_hz: number;
    adapter: string;
    subnet: string | null;
    offline_fallback: boolean;
    artsync: boolean;
    universes: UniverseConfig[];
  };
  color_palettes: ColorPaletteDef[];
  dimmer_palettes: DimmerPaletteDef[];
  patch: FixtureInstance[];
  groups: FixtureGroupDef[];
  fx_library: FxBlockDef[];
  scenes: SceneDef[];
}

export interface UniverseSegment {
  universe: number;
  startAddress: number;
  endAddress: number;
  channelOffsetStart: number;
}

export interface PlacementPreview {
  universe: number;
  address: number;
  wasSplit: boolean;
  tailEndAddress: number | null;
  collidesDirectly: boolean;
  toastMessage: string;
  autoCreateUniverses: UniverseConfig[];
  crossProtocolWarning: boolean;
}

export function defaultCalibration(): FixtureCalibration {
  return {
    gamma: 2.2,
    min_dimmer_dmx: 0,
    max_dimmer_dmx: 255,
    white_mode: "replace",
    white_gain: 1.0,
  };
}

export function getFixtureFootprint(inst: FixtureInstance): {
  head: UniverseSegment;
  tail: UniverseSegment | null;
} {
  const count = Math.max(1, Math.min(512, inst.channel_count));
  const end = inst.address + count - 1;
  if (end <= 512) {
    return {
      head: {
        universe: inst.universe,
        startAddress: inst.address,
        endAddress: end,
        channelOffsetStart: 0,
      },
      tail: null,
    };
  }
  const headLen = 512 - inst.address + 1;
  const tailLen = count - headLen;
  return {
    head: {
      universe: inst.universe,
      startAddress: inst.address,
      endAddress: 512,
      channelOffsetStart: 0,
    },
    tail: {
      universe: inst.universe + 1,
      startAddress: 1,
      endAddress: tailLen,
      channelOffsetStart: headLen,
    },
  };
}

export function getUniverseOccupiedMask(
  instances: FixtureInstance[],
  universe: number,
  excludeFixtureId?: string,
): boolean[] {
  const mask = new Array<boolean>(512).fill(false);
  for (const inst of instances) {
    if (excludeFixtureId && inst.id === excludeFixtureId) continue;
    const fp = getFixtureFootprint(inst);
    if (fp.head.universe === universe) {
      for (let a = fp.head.startAddress; a <= fp.head.endAddress; a++) {
        mask[a - 1] = true;
      }
    }
    if (fp.tail && fp.tail.universe === universe) {
      for (let a = fp.tail.startAddress; a <= fp.tail.endAddress; a++) {
        mask[a - 1] = true;
      }
    }
  }
  return mask;
}

export function getUniverseFreeStats(
  instances: FixtureInstance[],
  universe: number,
): { freeChannels: number; largestBlock: number; occupied: boolean[] } {
  const occupied = getUniverseOccupiedMask(instances, universe);
  let freeChannels = 0;
  let largestBlock = 0;
  let run = 0;

  for (let i = 0; i < 512; i++) {
    if (!occupied[i]) {
      freeChannels += 1;
      run += 1;
      if (run > largestBlock) largestBlock = run;
    } else {
      run = 0;
    }
  }

  return { freeChannels, largestBlock, occupied };
}

export function inheritNextUniverse(
  prev: UniverseConfig,
  newId: number,
): UniverseConfig {
  if (prev.protocol.protocol === "art_net") {
    const portAddr =
      ((prev.protocol.net & 0x7f) << 8) |
      ((prev.protocol.subnet & 0x0f) << 4) |
      (prev.protocol.uni & 0x0f);
    const next = (portAddr + 1) & 0x7fff;
    return {
      id: newId,
      review_output: true,
      protocol: {
        protocol: "art_net",
        mode: prev.protocol.mode,
        net: (next >> 8) & 0x7f,
        subnet: (next >> 4) & 0x0f,
        uni: next & 0x0f,
      },
    };
  }
  const nextSacn =
    prev.protocol.sacn_universe >= 63999 ? 1 : prev.protocol.sacn_universe + 1;
  return {
    id: newId,
    review_output: true,
    protocol: {
      protocol: "sacn",
      mode: prev.protocol.mode,
      sacn_universe: nextSacn,
      priority: prev.protocol.priority,
    },
  };
}

export function hasCrossProtocolWarning(
  a: UniverseConfig,
  b: UniverseConfig,
): boolean {
  if (a.protocol.protocol !== b.protocol.protocol) return true;
  if (a.protocol.protocol === "art_net" && b.protocol.protocol === "art_net") {
    return JSON.stringify(a.protocol.mode) !== JSON.stringify(b.protocol.mode);
  }
  if (a.protocol.protocol === "sacn" && b.protocol.protocol === "sacn") {
    return JSON.stringify(a.protocol.mode) !== JSON.stringify(b.protocol.mode);
  }
  return false;
}

export function checkDirectCollision(
  instances: FixtureInstance[],
  universe: number,
  address: number,
  channelCount: number,
  excludeFixtureId?: string,
): boolean {
  if (address < 1 || address > 512) return true;
  const temp: FixtureInstance = {
    id: "__probe",
    profile: "",
    mode: "",
    name: "",
    universe,
    address,
    channel_count: channelCount,
    grid_pos: { x: 0.5, y: 0.5, rotation: 0, scale_x: 0.3, scale_y: 0.05 },
    calibration: defaultCalibration(),
  };
  const fp = getFixtureFootprint(temp);
  const occHead = getUniverseOccupiedMask(
    instances,
    fp.head.universe,
    excludeFixtureId,
  );
  for (let a = fp.head.startAddress; a <= fp.head.endAddress; a++) {
    if (occHead[a - 1]) return true;
  }
  if (fp.tail) {
    const occTail = getUniverseOccupiedMask(
      instances,
      fp.tail.universe,
      excludeFixtureId,
    );
    for (let a = fp.tail.startAddress; a <= fp.tail.endAddress; a++) {
      if (occTail[a - 1]) return true;
    }
  }
  return false;
}

function ensureUniverseMap(
  targetId: number,
  map: Map<number, UniverseConfig>,
  created: UniverseConfig[],
): UniverseConfig {
  const existing = map.get(targetId);
  if (existing) return existing;
  let cur = Math.max(0, ...map.keys());
  if (cur === 0) {
    const u1: UniverseConfig = {
      id: 1,
      review_output: true,
      protocol: {
        protocol: "art_net",
        mode: { mode: "broadcast" },
        net: 0,
        subnet: 0,
        uni: 0,
      },
    };
    map.set(1, u1);
    created.push(u1);
    cur = 1;
  }
  while (cur < targetId) {
    const prev = map.get(cur)!;
    const nextCfg = inheritNextUniverse(prev, cur + 1);
    map.set(cur + 1, nextCfg);
    created.push(nextCfg);
    cur += 1;
  }
  return map.get(targetId)!;
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

export function previewPlacement(
  instances: FixtureInstance[],
  universes: UniverseConfig[],
  fixtureName: string,
  startUniverse: number,
  requestedAddress: number,
  channelCount: number,
  rolloverOn: boolean,
  excludeFixtureId?: string,
): PlacementPreview {
  const collidesDirectly = checkDirectCollision(
    instances,
    startUniverse,
    requestedAddress,
    channelCount,
    excludeFixtureId,
  );

  const uniMap = new Map<number, UniverseConfig>(
    universes.map((u) => [u.id, u]),
  );
  const maxConfigured = Math.max(1, ...uniMap.keys());
  const scanLimit = Math.max(maxConfigured, startUniverse);

  for (let u = startUniverse; u <= scanLimit; u++) {
    const minAddr = u === startUniverse ? requestedAddress : 1;
    const occU = getUniverseOccupiedMask(instances, u, excludeFixtureId);

    let cursor = minAddr;
    while (cursor <= 512) {
      while (cursor <= 512 && occU[cursor - 1]) cursor++;
      if (cursor > 512) break;

      const runStart = cursor;
      while (cursor <= 512 && !occU[cursor - 1]) cursor++;
      const runEnd = cursor - 1;
      const runLen = runEnd - runStart + 1;

      if (runLen >= channelCount) {
        const autoCreated: UniverseConfig[] = [];
        ensureUniverseMap(u, uniMap, autoCreated);
        const moved = !(u === startUniverse && runStart === requestedAddress);
        return {
          universe: u,
          address: runStart,
          wasSplit: false,
          tailEndAddress: null,
          collidesDirectly,
          autoCreateUniverses: autoCreated,
          crossProtocolWarning: false,
          toastMessage: moved
            ? `${fixtureName} moved to U${u}.${pad3(runStart)}`
            : `${fixtureName} patched at U${u}.${pad3(runStart)}`,
        };
      }

      if (rolloverOn && runEnd === 512) {
        const tailLen = channelCount - runLen;
        const occNext = getUniverseOccupiedMask(
          instances,
          u + 1,
          excludeFixtureId,
        );
        const tailFits = occNext.slice(0, tailLen).every((occ) => !occ);
        if (tailFits) {
          const autoCreated: UniverseConfig[] = [];
          const cfgU = ensureUniverseMap(u, uniMap, autoCreated);
          const cfgNext = ensureUniverseMap(u + 1, uniMap, autoCreated);
          const crossWarning = hasCrossProtocolWarning(cfgU, cfgNext);
          return {
            universe: u,
            address: runStart,
            wasSplit: true,
            tailEndAddress: tailLen,
            collidesDirectly,
            autoCreateUniverses: autoCreated,
            crossProtocolWarning: crossWarning,
            toastMessage: `${fixtureName} split: U${u}.${pad3(runStart)} to U${u}.512 + U${u + 1}.001 to U${u + 1}.${pad3(tailLen)}`,
          };
        }
      }
    }
  }

  const newU = scanLimit + 1;
  const autoCreated: UniverseConfig[] = [];
  ensureUniverseMap(newU, uniMap, autoCreated);
  return {
    universe: newU,
    address: 1,
    wasSplit: false,
    tailEndAddress: null,
    collidesDirectly,
    autoCreateUniverses: autoCreated,
    crossProtocolWarning: false,
    toastMessage: `${fixtureName} moved to U${newU}.001`,
  };
}

export function computeOrderU(
  rule: OrderRuleStr,
  index: number,
  count: number,
): number {
  if (count <= 1 || index >= count) return 0;
  const maxIdx = count - 1;
  const c = maxIdx / 2;

  if (rule === "linear") return index / maxIdx;
  if (rule === "reverse") return 1 - index / maxIdx;
  if (rule === "center_out") return Math.abs(index - c) / c;
  if (rule === "mirror") return 1 - Math.abs(index - c) / c;
  if (rule === "odd_even") return index % 2;

  const match = rule.match(/^blocks\((\d+)\)$/);
  if (match) {
    const k = Math.max(1, Number(match[1]));
    const numBlocks = Math.ceil(count / k);
    if (numBlocks <= 1) return 0;
    return Math.floor(index / k) / (numBlocks - 1);
  }
  return index / maxIdx;
}

export function expandTargetRange(
  targetRef: string,
  cellCount: number,
): number[] {
  if (cellCount <= 0) return [];
  const trimmed = targetRef.trim();
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx === -1) {
    return Array.from({ length: cellCount }, (_, i) => i);
  }
  const rangePart = trimmed.slice(colonIdx + 1).trim();
  if (rangePart.includes("..")) {
    const [sStr, eStr] = rangePart.split("..");
    const start = Number(sStr);
    const end = Number(eStr);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
    const out: number[] = [];
    if (start <= end) {
      for (let i = start; i <= end; i++) {
        if (i >= 0 && i < cellCount) out.push(i);
      }
    } else {
      for (let i = start; i >= end; i--) {
        if (i >= 0 && i < cellCount) out.push(i);
      }
    }
    return out;
  }
  const single = Number(rangePart);
  return Number.isInteger(single) && single >= 0 && single < cellCount
    ? [single]
    : [];
}

export function transformCellUv(
  gridPos: GridPos,
  localUv: [number, number],
): [number, number] {
  const sx = localUv[0] * gridPos.scale_x;
  const sy = localUv[1] * gridPos.scale_y;
  const rad = (gridPos.rotation * Math.PI) / 180;
  const sinR = Math.sin(rad);
  const cosR = Math.cos(rad);
  const rx = sx * cosR - sy * sinR;
  const ry = sx * sinR + sy * cosR;
  return [
    Math.max(0, Math.min(1, gridPos.x + rx)),
    Math.max(0, Math.min(1, gridPos.y + ry)),
  ];
}
