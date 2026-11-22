import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLOR_PALETTES,
  evaluateSimulationLayersToDmx,
  type FxElementDef,
} from "../mixerLogic";
import { getDefaultShippedFixtures } from "../oflBuilder";

const FIXTURE_CACHE = Object.fromEntries(
  getDefaultShippedFixtures().map((f) => [f.summary.id, f]),
);
const UNIVERSES = [
  {
    id: 1,
    review_output: false,
    protocol: {
      protocol: "art_net" as const,
      mode: { mode: "broadcast" as const },
      net: 0,
      subnet: 0,
      uni: 0,
    },
  },
];

function buildTubeShow(elements: FxElementDef[], gamma = 1.0, whiteMode: "off" | "replace" = "off") {
  return {
    version: "1.0",
    name: "FX Plausibility Test",
    bpm: 120,
    read_only_newer_version: false,
    network_outputs: {
      frame_rate_hz: 44,
      adapter: "auto",
      subnet: null,
      offline_fallback: true,
      artsync: true,
      universes: [],
    },
    color_palettes: DEFAULT_COLOR_PALETTES,
    dimmer_palettes: [],
    patch: [
      {
        id: "fx_tube",
        name: "Tube 8-Seg",
        profile: "age/rlcv3_8_segment_tube.json",
        mode: "34ch Pixel Mode",
        universe: 1,
        address: 1,
        channel_count: 34,
        grid_pos: { x: 0.5, y: 0.5, rotation: 0, scale_x: 0.3, scale_y: 0.05 },
        calibration: {
          gamma,
          min_dimmer_dmx: 0,
          max_dimmer_dmx: 255,
          white_gain: 1,
          white_mode: whiteMode,
        },
      },
    ],
    groups: [],
    fx_library: [
      {
        id: "blk_fx",
        name: "Test FX Block",
        target_group: "all",
        duration_beats: 4,
        loop_block: true,
        elements,
      },
    ],
    scenes: [
      {
        id: "sc_fx",
        name: "Test FX Scene",
        bank: "Bank 1",
        target_group: null,
        priority: 10,
        fade_in_sec: 0,
        fade_out_sec: 0,
        duration_value: 4,
        duration_unit: "beats" as const,
        block_refs: ["blk_fx"],
      },
    ],
    timelines: [],
  };
}

function evalAt(
  elements: FxElementDef[],
  tSec: number,
  opts?: { gamma?: number; whiteMode?: "off" | "replace" },
) {
  const show = buildTubeShow(elements, opts?.gamma ?? 1.0, opts?.whiteMode ?? "off");
  const res = evaluateSimulationLayersToDmx({
    show,
    fixtureDetailsCache: FIXTURE_CACHE,
    liveLayers: [],
    activeScenes: [
      {
        scene_id: "sc_fx",
        bank: "Bank 1",
        trigger_t_sec: 0,
        trigger_beat: 0,
        trigger_order: 1,
        fade_in_sec: 0,
        fade_out_sec: 0,
        release_t_sec: null,
        release_start_alpha: 1,
      },
    ],
    beatClock: { bpm: 120, t_anchor_sec: 0, beat_anchor: 0 },
    universes: UNIVERSES,
    grandMaster: 1,
    blackout: false,
    tSec,
  });
  const u1 = res.dmxByUniverse[0];
  // RLCV3 34ch: ch1(idx 0)=Master, ch2(idx 1)=Strobe, cells 0..7 => idx 2 + i*4 .. +3 (R,G,B,W)
  const cells = Array.from({ length: 8 }, (_, i) => ({
    r: u1[2 + i * 4],
    g: u1[3 + i * 4],
    b: u1[4 + i * 4],
    w: u1[5 + i * 4],
  }));
  return { master: u1[0], cells };
}

const STATIC_FULL_DIMMER: FxElementDef = {
  kind: "static_trait",
  trait: "dimmer",
  op: "ltp",
  palette_ref: null,
  value_start: 1,
  value_end: 1,
  order: null,
};

const STATIC_WHITE_COLOR: FxElementDef = {
  kind: "static_trait",
  trait: "color",
  op: "ltp",
  palette_ref: null,
  hex_start: "#FFFFFF",
  hex_end: "#FFFFFF",
  value_start: 0,
  value_end: 0,
  order: null,
};

describe("FX Scene Types Plausibility (TS Simulation Mixer)", () => {
  it("FX-01 color_fx: spreads colors across cells, evolves over time, desaturates on grayscale, and reverses on angle_deg=180", () => {
    const baseColorFx: FxElementDef = {
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
      palette_ref: null,
      inline_colors: ["#FF0000", "#00FF00", "#0000FF"],
      order: "linear",
    };

    const f0 = evalAt([STATIC_FULL_DIMMER, baseColorFx], 0.0);
    const fHalf = evalAt([STATIC_FULL_DIMMER, baseColorFx], 0.5);
    expect(f0.master).toBe(255);
    // Distinct colors across tube at t=0
    expect(f0.cells[0]).not.toEqual(f0.cells[3]);
    expect(f0.cells[0].r).toBeGreaterThan(200);
    // Evolves over time
    expect(f0.cells).not.toEqual(fHalf.cells);

    // Grayscale removes chroma: R == G == B for every cell (whiteMode = "off")
    const grayFx: FxElementDef = { ...baseColorFx, grayscale: true };
    const fGray = evalAt([STATIC_FULL_DIMMER, grayFx], 0.25);
    for (const c of fGray.cells) {
      expect(Math.abs(c.r - c.g)).toBeLessThanOrEqual(2);
      expect(Math.abs(c.g - c.b)).toBeLessThanOrEqual(2);
      expect(c.r).toBeGreaterThan(0);
    }

    // Reversing direction (angle_deg=180) produces opposite phase shift at t=0.25s (1/8 cycle)
    const revFx: FxElementDef = { ...baseColorFx, angle_deg: 180 };
    const fFwd = evalAt([STATIC_FULL_DIMMER, baseColorFx], 0.25);
    const fRev = evalAt([STATIC_FULL_DIMMER, revFx], 0.25);
    expect(fFwd.cells[0]).not.toEqual(fRev.cells[0]);
  });

  it("FX-02 color_mappings: evaluates all 4 shaders, respects gizmo bounds, mirrors on transform, and desaturates on grayscale", () => {
    const baseMap = (
      overrides: Partial<Extract<FxElementDef, { kind: "spatial_shader_2d" }>> = {},
    ): FxElementDef => ({
      kind: "spatial_shader_2d",
      trait: "color",
      op: "ltp",
      shader: "linear_sweep",
      palette_ref: null,
      inline_colors: ["#FF0000", "#00FF00", "#0000FF"],
      rate_beats: null,
      speed_hz: null,
      rate_cycles: 1,
      spatial_freq: 1,
      color_width: 1,
      gradient: 1,
      grayscale: false,
      transform: null,
      direction_deg: 0,
      center_x: 0.5,
      center_y: 0.5,
      ...overrides,
    });

    for (const shader of ["linear_sweep", "radial_wave", "pinwheel", "plasma"] as const) {
      const f0 = evalAt([STATIC_FULL_DIMMER, baseMap({ shader })], 0.0);
      const f1 = evalAt([STATIC_FULL_DIMMER, baseMap({ shader })], 0.5);
      const totalEnergy = f0.cells.reduce((acc, c) => acc + c.r + c.g + c.b, 0);
      expect(totalEnergy).toBeGreaterThan(0);
      expect(f0.cells).not.toEqual(f1.cells);
    }

    // Out-of-bounds gizmo center darkens all cells
    const fOut = evalAt([STATIC_FULL_DIMMER, baseMap({ center_x: 0.99, center_y: 0.99 })], 0.0);
    expect(fOut.cells.every((c) => c.r === 0 && c.g === 0 && c.b === 0)).toBe(true);

    // Mirror X changes spatial distribution across horizontal tube
    const fNorm = evalAt([STATIC_FULL_DIMMER, baseMap({ transform: null })], 0.0);
    const fMirr = evalAt([STATIC_FULL_DIMMER, baseMap({ transform: "mirror_x" })], 0.0);
    expect(fNorm.cells[0]).not.toEqual(fMirr.cells[0]);

    // Grayscale removes chroma
    const fGray = evalAt([STATIC_FULL_DIMMER, baseMap({ grayscale: true })], 0.0);
    for (const c of fGray.cells) {
      expect(Math.abs(c.r - c.g)).toBeLessThanOrEqual(2);
      expect(Math.abs(c.g - c.b)).toBeLessThanOrEqual(2);
    }
  });

  it("FX-03 chaser_fx: respects pixels_on count, advances over time, bounces when one_way=false, softens with fade, and reverses order", () => {
    const makeChase = (
      overrides: Partial<Extract<FxElementDef, { kind: "step_chase" }>> = {},
    ): FxElementDef => ({
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
      ...overrides,
    });

    const f1px = evalAt([STATIC_WHITE_COLOR, makeChase({ pixels_on: 1 })], 0.5);
    const f3px = evalAt([STATIC_WHITE_COLOR, makeChase({ pixels_on: 3 })], 0.5);
    const lit1 = f1px.cells.filter((c) => c.r > 0).length;
    const lit3 = f3px.cells.filter((c) => c.r > 0).length;
    expect(lit1).toBeGreaterThanOrEqual(1);
    expect(lit3).toBeGreaterThan(lit1);

    // Advances over time
    const fStart = evalAt([STATIC_WHITE_COLOR, makeChase({ pixels_on: 1 })], 0.0);
    const fMid = evalAt([STATIC_WHITE_COLOR, makeChase({ pixels_on: 1 })], 1.0);
    expect(fStart.cells.map((c) => c.r)).not.toEqual(fMid.cells.map((c) => c.r));

    // Bounce (one_way=false): phase 0.25 (t=0.5s) matches phase 0.75 (t=1.5s) at 120 BPM, 4-beat cycle (2s)
    const bounce = makeChase({ one_way: false, pixels_on: 2 });
    const fQ1 = evalAt([STATIC_WHITE_COLOR, bounce], 0.5);
    const fQ3 = evalAt([STATIC_WHITE_COLOR, bounce], 1.5);
    expect(fQ1.cells.map((c) => c.r)).toEqual(fQ3.cells.map((c) => c.r));

    // Fade softens edges (produces intermediate non-0, non-255 values)
    const fSoft = evalAt([STATIC_WHITE_COLOR, makeChase({ pixels_on: 4, fade: 0.9 })], 0.5);
    expect(fSoft.cells.some((c) => c.r > 0 && c.r < 255)).toBe(true);

    // Reverse order mirrors cell intensities
    const fLin = evalAt([STATIC_WHITE_COLOR, makeChase({ pixels_on: 1, order: "linear" })], 0.25);
    const fRev = evalAt([STATIC_WHITE_COLOR, makeChase({ pixels_on: 1, order: "reverse" })], 0.25);
    expect(fLin.cells.map((c) => c.r)).toEqual([...fRev.cells.map((c) => c.r)].reverse());
  });

  it("FX-04 value_fx: modulates dimmer from value_stops, syncs at phase_spread_deg=0, and quantizes when gradient=0", () => {
    const makeValFx = (
      overrides: Partial<Extract<FxElementDef, { kind: "curve_1d" }>> = {},
    ): FxElementDef => ({
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
      ...overrides,
    });

    const fSpread = evalAt([STATIC_WHITE_COLOR, makeValFx()], 0.0);
    const vals = fSpread.cells.map((c) => c.r);
    expect(Math.max(...vals)).toBe(255);
    expect(Math.min(...vals)).toBeLessThan(100);

    // Zero phase spread -> all cells identical
    const fSync = evalAt([STATIC_WHITE_COLOR, makeValFx({ phase_spread_deg: 0 })], 0.0);
    expect(new Set(fSync.cells.map((c) => c.r)).size).toBe(1);

    // Hard steps (gradient = 0) with [1, 0] produces strictly 0 or 255
    const fStep = evalAt(
      [STATIC_WHITE_COLOR, makeValFx({ value_stops: [1, 0], gradient: 0 })],
      0.0,
    );
    expect(fStep.cells.every((c) => c.r === 0 || c.r === 255)).toBe(true);
    expect(fStep.cells.some((c) => c.r === 255)).toBe(true);
    expect(fStep.cells.some((c) => c.r === 0)).toBe(true);

    // Adapting value_stops floor raises minimum DMX output
    const fHighFloor = evalAt(
      [STATIC_WHITE_COLOR, makeValFx({ value_stops: [0.5, 1.0] })],
      0.0,
    );
    expect(Math.min(...fHighFloor.cells.map((c) => c.r))).toBeGreaterThanOrEqual(125);
  });

  it("FX-05 curve_fx: adapts waveform, pulse duty, amplitude/offset bounds, and scalar channel trait", () => {
    const makeCurve = (
      overrides: Partial<Extract<FxElementDef, { kind: "curve_1d" }>> = {},
    ): FxElementDef => ({
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
      phase_spread_deg: 0,
      duty: 0.5,
      palette_ref: null,
      order: "linear",
      ...overrides,
    });

    // Pulse duty adaptation at phase=0.5 (t=1.0s of 2.0s cycle)
    const fNarrow = evalAt(
      [STATIC_WHITE_COLOR, makeCurve({ waveform: "pulse", duty: 0.25 })],
      1.0,
    );
    const fWide = evalAt(
      [STATIC_WHITE_COLOR, makeCurve({ waveform: "pulse", duty: 0.75 })],
      1.0,
    );
    expect(fNarrow.cells[0].r).toBe(0);
    expect(fWide.cells[0].r).toBe(255);

    // Amplitude/offset clamping [0.2 .. 0.6] -> DMX [51 .. 153]
    const fBounded = evalAt(
      [
        STATIC_WHITE_COLOR,
        makeCurve({ waveform: "sine", amplitude: 0.4, offset: 0.2, phase_spread_deg: 360 }),
      ],
      0.0,
    );
    for (const c of fBounded.cells) {
      expect(c.r).toBeGreaterThanOrEqual(50);
      expect(c.r).toBeLessThanOrEqual(155);
    }

    // Target trait = "red" only drives Red channels
    const fRedOnly = evalAt(
      [
        {
          kind: "static_trait",
          trait: "master_dimmer",
          op: "ltp",
          palette_ref: null,
          value_start: 1,
          value_end: 1,
          order: null,
        },
        makeCurve({ trait: "red", waveform: "square" }),
      ],
      0.0,
    );
    expect(fRedOnly.cells[0].r).toBe(255);
    expect(fRedOnly.cells[0].g).toBe(0);
    expect(fRedOnly.cells[0].b).toBe(0);
  });

  it("FX-06 mappings: modulates dimmer via 2D shaders, respects value_stops, mirror_x, and gizmo bounds", () => {
    const makeDimMap = (
      overrides: Partial<Extract<FxElementDef, { kind: "spatial_shader_2d" }>> = {},
    ): FxElementDef => ({
      kind: "spatial_shader_2d",
      trait: "dimmer",
      op: "ltp",
      shader: "linear_sweep",
      palette_ref: null,
      rate_beats: null,
      speed_hz: null,
      rate_cycles: 1,
      spatial_freq: 1,
      color_width: 1,
      gradient: 1,
      transform: null,
      value_stops: [1, 0],
      direction_deg: 0,
      center_x: 0.5,
      center_y: 0.5,
      ...overrides,
    });

    for (const shader of ["linear_sweep", "radial_wave", "pinwheel", "plasma"] as const) {
      const f0 = evalAt([STATIC_WHITE_COLOR, makeDimMap({ shader })], 0.0);
      const f1 = evalAt([STATIC_WHITE_COLOR, makeDimMap({ shader })], 0.5);
      expect(f0.cells.some((c) => c.r > 0)).toBe(true);
      expect(f0.cells.map((c) => c.r)).not.toEqual(f1.cells.map((c) => c.r));
    }

    // Constant value_stops [0.5, 0.5] holds all in-bounds cells near 128
    const fHalf = evalAt([STATIC_WHITE_COLOR, makeDimMap({ value_stops: [0.5, 0.5] })], 0.0);
    for (const c of fHalf.cells) {
      expect(c.r).toBeGreaterThanOrEqual(125);
      expect(c.r).toBeLessThanOrEqual(130);
    }

    // Mirror X flips spatial intensity pattern
    const fNorm = evalAt(
      [STATIC_WHITE_COLOR, makeDimMap({ value_stops: [1, 0.2, 0], transform: null })],
      0.0,
    );
    const fMirr = evalAt(
      [STATIC_WHITE_COLOR, makeDimMap({ value_stops: [1, 0.2, 0], transform: "mirror_x" })],
      0.0,
    );
    expect(fNorm.cells[0].r).not.toEqual(fMirr.cells[0].r);

    // Out-of-bounds gizmo zeroes output
    const fOut = evalAt([STATIC_WHITE_COLOR, makeDimMap({ center_x: 0.99, center_y: 0.99 })], 0.0);
    expect(fOut.cells.every((c) => c.r === 0)).toBe(true);
  });
});
