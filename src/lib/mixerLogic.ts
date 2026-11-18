import type { ExpandedChannel, FixtureDetail } from "./oflBuilder";
import {
  computeOrderU,
  expandTargetRange,
  type OrderRuleStr,
  type ShowStateDto,
  type WhiteMode,
} from "./patchLogic";
import type { UniverseConfig } from "../store/useTaktStore";

export interface ColorPaletteDef {
  id: string;
  name: string;
  hex_start: string;
  hex_end: string;
}

export interface DimmerPaletteDef {
  id: string;
  name: string;
  value_start: number;
  value_end: number;
}

export type MergeOp = "htp" | "ltp" | "add" | "scale";

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

function linearChToSrgb(c: number): number {
  const x = clamp01(c);
  return x <= 0.0031308
    ? 12.92 * x
    : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
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

export function sampleOklabGradientLinear(
  hexStart: string,
  hexEnd: string,
  w: number,
): [number, number, number] {
  const labA = linearRgbToOklab(srgbHexToLinearRgb(hexStart));
  const labB = linearRgbToOklab(srgbHexToLinearRgb(hexEnd));
  const t = clamp01(w);
  return oklabToLinearRgb([
    labA[0] + t * (labB[0] - labA[0]),
    labA[1] + t * (labB[1] - labA[1]),
    labA[2] + t * (labB[2] - labA[2]),
  ]);
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

export function evaluateSimulationLayersToDmx(args: {
  show: ShowStateDto;
  fixtureDetailsCache: Record<string, FixtureDetail>;
  liveLayers: SmartControlLayer[];
  universes: UniverseConfig[];
  grandMaster: number;
  blackout: boolean;
  tSec: number;
}): { dmxByUniverse: Uint8Array[]; softwareStrobeClamped: boolean } {
  const {
    show,
    fixtureDetailsCache,
    liveLayers,
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

  show.patch.forEach((inst, fxIdx) => {
    const detail = fixtureDetailsCache[inst.profile];
    const mode = detail?.expanded_modes.find((m) => m.name === inst.mode);
    const count = mode?.cells.length ?? 1;
    fixtureCellStarts.push(totalCells);
    fixtureCellCounts.push(count);
    for (let i = 0; i < count; i++) cellToFixture.push(fxIdx);
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

  if (activeLayers.length === 0) {
    return { dmxByUniverse, softwareStrobeClamped: false };
  }

  const fxStates = show.patch.map(() => ({
    masterDimmer: 0,
    masterTouched: false,
    anyCellTouched: false,
    shutter: { kind: "open" } as ShutterState,
  }));
  const cellStates = Array.from({ length: totalCells }, () => ({
    dimmer: 0,
    color: [0, 0, 0] as [number, number, number],
  }));

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
        fxStates[cellToFixture[cellIdx]].anyCellTouched = true;
      }
    } else if (spec.trait_kind === "color") {
      const pal = spec.palette_ref
        ? show.color_palettes.find((p) => p.id === spec.palette_ref)
        : undefined;
      for (const [cellIdx, u] of cells) {
        const rgb = pal
          ? sampleOklabGradientLinear(pal.hex_start, pal.hex_end, u)
          : sampleOklabGradientLinear(spec.hex_start, spec.hex_end, u);
        cellStates[cellIdx].color = [
          applyScalarMerge(spec.op, cellStates[cellIdx].color[0], rgb[0], alpha),
          applyScalarMerge(spec.op, cellStates[cellIdx].color[1], rgb[1], alpha),
          applyScalarMerge(spec.op, cellStates[cellIdx].color[2], rgb[2], alpha),
        ];
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
    if (!fxSt.masterTouched && fxSt.anyCellTouched) fxSt.masterDimmer = 1;
    if (blackout) fxSt.masterDimmer = 0;
    else if (!fxSt.anyCellTouched && fxSt.masterTouched) {
      fxSt.masterDimmer = clamp01(fxSt.masterDimmer * clamp01(grandMaster));
    }
  }
  for (const cellSt of cellStates) {
    cellSt.dimmer = blackout ? 0 : clamp01(cellSt.dimmer * clamp01(grandMaster));
  }

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
        buf[addr - 1] = ch.default_value;
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

        const [rw, gw, bw, ww] = hasWhite
          ? extractRgbw(
              cellSt.color[0],
              cellSt.color[1],
              cellSt.color[2],
              cal.white_mode,
              cal.white_gain,
              cal.gamma,
            )
          : [cellSt.color[0], cellSt.color[1], cellSt.color[2], 0];

        let comp = 0;
        if (ch.role.color === "Red") comp = rw;
        else if (ch.role.color === "Green") comp = gw;
        else if (ch.role.color === "Blue") comp = bw;
        else if (["White", "Warm White", "Cold White"].includes(ch.role.color))
          comp = ww;
        else if (ch.role.color === "Amber")
          comp = Math.min(cellSt.color[0], cellSt.color[1] * 1.5);
        else if (ch.role.color === "Yellow")
          comp = Math.min(cellSt.color[0], cellSt.color[1]);
        else if (ch.role.color === "Cyan")
          comp = Math.min(cellSt.color[1], cellSt.color[2]);
        else if (ch.role.color === "Magenta")
          comp = Math.min(cellSt.color[0], cellSt.color[2]);

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
