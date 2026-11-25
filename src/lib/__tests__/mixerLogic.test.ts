import { describe, expect, it } from "vitest";
import {
  amplitudeOffsetToRangePct,
  analyzeSyntheticTimelineAudio,
  applyScalarMerge,
  buildCurve1DSvgPreview,
  buildStepChasePreviewBlocks,
  computeBeatGridMarkers,
  computeClipAlphaAt,
  computeSceneSequenceDurationSec,
  DEFAULT_COLOR_PALETTES,
  dmxToPerceptualU8,
  evaluateCurve1DScalar,
  evaluateSimulationLayersToDmx,
  evaluateSpatialShader2D,
  evaluateStepChaseScalar,
  evalUnipolarWaveform,
  extractRgbw,
  getActiveSequenceStepAt,
  integrateTempoMapBeats,
  linearRgbToOklab,
  MERGE_OP_LABELS,
  patternScaleToBoxHalfNorm,
  patternScaleToSpatialFreq,
  quantizeChannelValue,
  rangePctToAmplitudeOffset,
  sampleOklabGradientHex,
  sampleOklabGradientLinear,
  sampleOklabStopsLinear,
  snapTimeSecToMarkers,
  spatialFreqToPatternScale,
  srgbHexToLinearRgb,
} from "../mixerLogic";

describe("mixerLogic", () => {
  it("interpolates OKLAB gradients preserving chroma between Red and Green", () => {
    const midHex = sampleOklabGradientHex("#FF0000", "#00FF00", 0.5);
    const midLin = sampleOklabGradientLinear("#FF0000", "#00FF00", 0.5);
    const midLab = linearRgbToOklab(midLin);
    const oliveLab = linearRgbToOklab(srgbHexToLinearRgb("#808000"));
    expect(midHex).toMatch(/^#[0-9A-F]{6}$/i);
    expect(midLab[0]).toBeGreaterThan(oliveLab[0] + 0.15);
  });

  it("applies htp, ltp, add, and scale merge operators with alpha and clamping", () => {
    expect(applyScalarMerge("htp", 0.3, 0.8, 0.5)).toBeCloseTo(0.4, 5);
    expect(applyScalarMerge("ltp", 0.2, 0.8, 0.25)).toBeCloseTo(0.35, 5);
    expect(applyScalarMerge("add", 0.7, -0.4, 0.5)).toBeCloseTo(0.5, 5);
    expect(applyScalarMerge("scale", 0.8, 0.5, 0.5)).toBeCloseTo(0.6, 5);
    expect(applyScalarMerge("add", 0.9, 0.5, 1.0)).toBe(1);
    expect(applyScalarMerge("add", 0.1, -0.5, 1.0)).toBe(0);
  });

  it("performs RGBW replace gamma luminance compensation and deadzone quantization", () => {
    const [r, g, b, w] = extractRgbw(0.8, 0.4, 0.4, "replace", 1.0, 2.2);
    expect(g).toBeCloseTo(0, 5);
    expect(b).toBeCloseTo(0, 5);
    expect(Math.pow(r, 2.2) + Math.pow(w, 2.2)).toBeCloseTo(
      Math.pow(0.8, 2.2),
      3,
    );

    expect(quantizeChannelValue(0, 2.2, 12, 240, true)).toBe(0);
    expect(quantizeChannelValue(0.01, 2.2, 12, 240, true)).toBeGreaterThanOrEqual(12);
    expect(quantizeChannelValue(1, 2.2, 12, 240, true)).toBe(240);
  });

  it("evaluates 1D waveforms, step chase trapezoids, and 2D spatial shaders", () => {
    expect(evalUnipolarWaveform("sine", 0.25)).toBeCloseTo(1.0, 5);
    expect(evalUnipolarWaveform("triangle", 0.5)).toBeCloseTo(1.0, 5);
    expect(evalUnipolarWaveform("saw", 0.75)).toBeCloseTo(0.75, 5);
    expect(evalUnipolarWaveform("square", 0.25)).toBe(1);
    expect(evalUnipolarWaveform("pulse", 0.19, 0.2)).toBe(1);

    expect(
      evaluateCurve1DScalar({
        waveform: "sine",
        bBlock: 0.75,
        tLocal: 0,
        u: 0,
        rateBeats: 1,
        speedHz: null,
        phaseSpreadDeg: 0,
        amplitude: 0.4,
        offset: 0,
        isBipolarAddDimmer: true,
      }),
    ).toBeCloseTo(-0.4, 5);

    expect(
      evaluateStepChaseScalar({
        bBlock: 0.5,
        tLocal: 0,
        u: 0.5,
        cellCount: 8,
        stepBeats: 1,
        speedHz: null,
        activeRatio: 0.4,
        fade: 0.5,
        amplitude: 1,
      }),
    ).toBeCloseTo(1, 5);

    const radial = evaluateSpatialShader2D({
      shader: "radial_wave",
      canvasXy: [0.8, 0.5],
      bBlock: 0.25,
      tLocal: 0,
      rateBeats: 2,
      speedHz: null,
      spatialFreq: 1.5,
      directionDeg: 45,
      centerX: 0.5,
      centerY: 0.5,
    });
    expect(radial).toBeGreaterThanOrEqual(0);
    expect(radial).toBeLessThanOrEqual(1);
  });

  it("integrates piecewise TempoMap beats, clip fade envelopes, beat-grid, and magnetic snap", () => {
    const tempoMap = [
      { at_sec: 0, bpm: 120 },
      { at_sec: 2, bpm: 150 },
    ];
    expect(integrateTempoMapBeats(tempoMap, 120, 0, 4)).toBeCloseTo(9.0, 6);

    const clip = {
      start_sec: 1.0,
      duration_sec: 4.0,
      fade_in_sec: 1.0,
      fade_out_sec: 1.0,
    };
    expect(computeClipAlphaAt(clip, 0.9)).toBe(0);
    expect(computeClipAlphaAt(clip, 1.5)).toBeCloseTo(0.5, 5);
    expect(computeClipAlphaAt(clip, 2.5)).toBe(1);
    expect(computeClipAlphaAt(clip, 4.5)).toBeCloseTo(0.5, 5);
    expect(computeClipAlphaAt(clip, 5.0)).toBe(0);

    const grid = computeBeatGridMarkers({
      durationSec: 2.0,
      gridOffsetSec: 0.1,
      tempoMap: [{ at_sec: 0, bpm: 120 }],
      defaultBpm: 120,
    });
    expect(grid[0]).toBeCloseTo(0.1, 4);
    expect(grid[1]).toBeCloseTo(0.6, 4);

    const analysis = analyzeSyntheticTimelineAudio({
      bpm: 128,
      durationSec: 8,
      gridOffsetSec: 0.12,
      sensitivity: 0.65,
    });
    expect(analysis.transients.length).toBeGreaterThan(4);
    const snapped = snapTimeSecToMarkers(
      analysis.transients[1].time_sec + 0.04,
      analysis.transients.map((t) => t.time_sec),
      0.15,
    );
    expect(snapped).toBeCloseTo(analysis.transients[1].time_sec, 4);
  });

  it("maps human-friendly blend modes, range inversion, pattern scale, SVG curves, and step-chase blocks", () => {
    expect(MERGE_OP_LABELS.scale.label).toBe("Multiply (×)");
    expect(MERGE_OP_LABELS.htp.label).toBe("Highest Wins (HTP)");

    const normal = rangePctToAmplitudeOffset(20, 80, false);
    expect(normal.offset).toBeCloseTo(0.2, 4);
    expect(normal.amplitude).toBeCloseTo(0.6, 4);
    expect(
      amplitudeOffsetToRangePct(normal.amplitude, normal.offset, false),
    ).toEqual({ minPct: 20, maxPct: 80, inverted: false });

    const inverted = rangePctToAmplitudeOffset(90, 10, false);
    expect(inverted.offset).toBeCloseTo(0.9, 4);
    expect(inverted.amplitude).toBeCloseTo(-0.8, 4);
    expect(
      amplitudeOffsetToRangePct(inverted.amplitude, inverted.offset, false).inverted,
    ).toBe(true);

    const freq = patternScaleToSpatialFreq(2.0);
    expect(freq).toBeCloseTo(0.5, 3);
    expect(spatialFreqToPatternScale(freq)).toBeCloseTo(2.0, 2);
    expect(patternScaleToBoxHalfNorm(1.0)).toBeCloseTo(0.2, 5);
    expect(patternScaleToBoxHalfNorm(3.0)).toBeCloseTo(0.6, 5);
    expect(patternScaleToBoxHalfNorm(10.0)).toBeCloseTo(2.0, 5);

    const svg = buildCurve1DSvgPreview({
      waveform: "sine",
      amplitude: 0.8,
      offset: 0.1,
      phaseSpreadDeg: 360,
      duty: 0.5,
      fixtureCount: 6,
      isBipolarAdd: false,
    });
    expect(svg.pathD.startsWith("M")).toBe(true);
    expect(svg.fixtureDots).toHaveLength(6);

    const chase = buildStepChasePreviewBlocks({
      cellCount: 8,
      activeRatio: 0.25,
      fade: 0.5,
      order: "center_out",
    });
    expect(chase.activePixelCount).toBe(2);
    expect(chase.blocks).toHaveLength(8);
  });

  it("layers independent Color scenes and Dimmer Effect scenes cleanly", () => {
    const show = {
      version: "1.0",
      name: "Layer Test",
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
      color_palettes: [
        { id: "pal_red", name: "Red", hex_start: "#FF0000", hex_end: "#FF0000" },
      ],
      dimmer_palettes: [],
      patch: [
        {
          id: "fx_1",
          name: "Par 1",
          profile: "par_rgb",
          mode: "4ch",
          universe: 1,
          address: 1,
          channel_count: 4,
          grid_pos: { x: 0.5, y: 0.5, rotation: 0, scale_x: 0.1, scale_y: 0.1 },
          calibration: { gamma: 1, white_mode: "off" as const, white_gain: 1, min_dimmer_dmx: 0, max_dimmer_dmx: 255 },
        },
      ],
      groups: [],
      fx_library: [
        {
          id: "blk_col",
          name: "Pure Red",
          target_group: "all",
          duration_beats: 4,
          loop_block: true,
          elements: [
            { kind: "static_trait" as const, trait: "color", op: "ltp" as const, palette_ref: "pal_red", value_start: 0, value_end: 0, order: null },
          ],
        },
        {
          id: "blk_eff",
          name: "Half Dim",
          target_group: "all",
          duration_beats: 4,
          loop_block: true,
          elements: [
            { kind: "static_trait" as const, trait: "dimmer", op: "htp" as const, palette_ref: null, value_start: 0.5, value_end: 0.5, order: null },
          ],
        },
      ],
      scenes: [
        { id: "sc_col", name: "Red", bank: "Colors", target_group: null, priority: 10, fade_in_sec: 0, fade_out_sec: 0, block_refs: ["blk_col"] },
        { id: "sc_eff", name: "Dim50", bank: "Effects", target_group: null, priority: 10, fade_in_sec: 0, fade_out_sec: 0, block_refs: ["blk_eff"] },
      ],
      timelines: [],
    };
    const cache = {
      par_rgb: {
        summary: {
          id: "par_rgb",
          name: "Par",
          short_name: "Par",
          origin: "user_local" as const,
          categories: ["Color"],
          pixel_count: 1,
          modes: [{ name: "4ch", short_name: "4ch", channel_count: 4, cell_count: 1 }],
        },
        raw_json: "",
        expanded_modes: [
          {
            name: "4ch",
            short_name: "4ch",
            channel_count: 4,
            cells: [{ cell_index: 0, pixel_key: "1", grid_xyz: [0, 0, 0] as [number, number, number], local_uv: [0, 0] as [number, number] }],
            channels: [
              { dmx_offset: 0, channel_number: 1, name: "Dim", role: { kind: "intensity" as const }, target: { scope: "fixture" as const }, default_value: 0, fine_channel_offset: null },
              { dmx_offset: 1, channel_number: 2, name: "R", role: { kind: "color_intensity" as const, color: "Red" }, target: { scope: "cell" as const, cell_index: 0, pixel_key: "1" }, default_value: 0, fine_channel_offset: null },
              { dmx_offset: 2, channel_number: 3, name: "G", role: { kind: "color_intensity" as const, color: "Green" }, target: { scope: "cell" as const, cell_index: 0, pixel_key: "1" }, default_value: 0, fine_channel_offset: null },
              { dmx_offset: 3, channel_number: 4, name: "B", role: { kind: "color_intensity" as const, color: "Blue" }, target: { scope: "cell" as const, cell_index: 0, pixel_key: "1" }, default_value: 0, fine_channel_offset: null },
            ],
          },
        ],
      },
    };
    const uni = [{ id: 1, review_output: false, protocol: { protocol: "art_net" as const, mode: { mode: "broadcast" as const }, net: 0, subnet: 0, uni: 0 } }];

    // Strict A2: Color scene alone without dimmer/master dimmer leaves intensity at 0 (fixture dark)
    const colorOnly = evaluateSimulationLayersToDmx({
      show,
      fixtureDetailsCache: cache,
      liveLayers: [],
      activeScenes: [{ scene_id: "sc_col", bank: "Colors", trigger_t_sec: 0, trigger_beat: 0, trigger_order: 1, fade_in_sec: 0, fade_out_sec: 0, release_t_sec: null, release_start_alpha: 1 }],
      universes: uni,
      grandMaster: 1,
      blackout: false,
      tSec: 1,
    });
    expect(colorOnly.dmxByUniverse[0][0]).toBe(0);

    // Effect scene alone -> half dimmer (~128) & no implied white mix (0,0,0)
    const effOnly = evaluateSimulationLayersToDmx({
      show,
      fixtureDetailsCache: cache,
      liveLayers: [],
      activeScenes: [{ scene_id: "sc_eff", bank: "Effects", trigger_t_sec: 0, trigger_beat: 0, trigger_order: 1, fade_in_sec: 0, fade_out_sec: 0, release_t_sec: null, release_start_alpha: 1 }],
      universes: uni,
      grandMaster: 1,
      blackout: false,
      tSec: 1,
    });
    expect(effOnly.dmxByUniverse[0][0]).toBeGreaterThan(120);
    expect(effOnly.dmxByUniverse[0][0]).toBeLessThan(135);
    expect(effOnly.dmxByUniverse[0][1]).toBe(0);
    expect(effOnly.dmxByUniverse[0][3]).toBe(0);

    // Layered Color + Effect scenes -> half dimmer (~128) & Red (255,0,0)
    const layered = evaluateSimulationLayersToDmx({
      show,
      fixtureDetailsCache: cache,
      liveLayers: [],
      activeScenes: [
        { scene_id: "sc_col", bank: "Colors", trigger_t_sec: 0, trigger_beat: 0, trigger_order: 1, fade_in_sec: 0, fade_out_sec: 0, release_t_sec: null, release_start_alpha: 1 },
        { scene_id: "sc_eff", bank: "Effects", trigger_t_sec: 0, trigger_beat: 0, trigger_order: 2, fade_in_sec: 0, fade_out_sec: 0, release_t_sec: null, release_start_alpha: 1 },
      ],
      universes: uni,
      grandMaster: 1,
      blackout: false,
      tSec: 1,
    });
    expect(layered.dmxByUniverse[0][0]).toBeGreaterThan(120);
    expect(layered.dmxByUniverse[0][0]).toBeLessThan(135);
    expect(layered.dmxByUniverse[0][1]).toBe(255);
    expect(layered.dmxByUniverse[0][2]).toBe(0);
    expect(layered.dmxByUniverse[0][3]).toBe(0);
  });

  it("uses single-gamma quantization and inverse-gamma 2D preview round-trip", () => {
    const cache = {
      par_rgb: {
        summary: {
          id: "par_rgb",
          name: "Par",
          short_name: "Par",
          origin: "user_local" as const,
          categories: ["Color"],
          pixel_count: 1,
          modes: [{ name: "4ch", short_name: "4ch", channel_count: 4, cell_count: 1 }],
        },
        raw_json: "",
        expanded_modes: [
          {
            name: "4ch",
            short_name: "4ch",
            channel_count: 4,
            cells: [{ cell_index: 0, pixel_key: "1", grid_xyz: [0, 0, 0] as [number, number, number], local_uv: [0, 0] as [number, number] }],
            channels: [
              { dmx_offset: 0, channel_number: 1, name: "Dim", role: { kind: "intensity" as const }, target: { scope: "fixture" as const }, default_value: 0, fine_channel_offset: null },
              { dmx_offset: 1, channel_number: 2, name: "R", role: { kind: "color_intensity" as const, color: "Red" }, target: { scope: "cell" as const, cell_index: 0, pixel_key: "1" }, default_value: 0, fine_channel_offset: null },
              { dmx_offset: 2, channel_number: 3, name: "G", role: { kind: "color_intensity" as const, color: "Green" }, target: { scope: "cell" as const, cell_index: 0, pixel_key: "1" }, default_value: 0, fine_channel_offset: null },
              { dmx_offset: 3, channel_number: 4, name: "B", role: { kind: "color_intensity" as const, color: "Blue" }, target: { scope: "cell" as const, cell_index: 0, pixel_key: "1" }, default_value: 0, fine_channel_offset: null },
            ],
          },
        ],
      },
    };
    const show = {
      version: "1.0",
      name: "Orange Test",
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
      dimmer_palettes: [],
      color_palettes: [],
      patch: [
        {
          id: "fx_1",
          name: "Par 1",
          profile: "par_rgb",
          mode: "4ch",
          universe: 1,
          address: 1,
          channel_count: 4,
          grid_pos: { x: 0.5, y: 0.5, rotation: 0, scale_x: 1, scale_y: 1 },
          calibration: { gamma: 2.2, min_dimmer_dmx: 0, max_dimmer_dmx: 255, white_gain: 1, white_mode: "replace" as const },
        },
      ],
      groups: [],
      fx_library: [
        {
          id: "blk_orange",
          name: "Orange",
          target_group: "all",
          duration_beats: 4,
          loop_block: true,
          elements: [
            { kind: "static_trait" as const, trait: "dimmer", op: "ltp" as const, palette_ref: null, value_start: 1, value_end: 1, order: null },
            { kind: "static_trait" as const, trait: "color", op: "ltp" as const, palette_ref: null, hex_start: "#FF5500", hex_end: "#FF5500", value_start: 0, value_end: 0, order: null },
          ],
        },
      ],
      scenes: [
        { id: "sc_orange", name: "Orange", bank: "Bank 1", target_group: null, priority: 10, fade_in_sec: 0, fade_out_sec: 0, duration_value: 4, duration_unit: "beats" as const, block_refs: ["blk_orange"] },
      ],
      timelines: [],
    };
    const uni = [{ id: 1, review_output: false, protocol: { protocol: "art_net" as const, mode: { mode: "broadcast" as const }, net: 0, subnet: 0, uni: 0 } }];
    const out = evaluateSimulationLayersToDmx({
      show,
      fixtureDetailsCache: cache,
      liveLayers: [],
      activeScenes: [{ scene_id: "sc_orange", bank: "Bank 1", trigger_t_sec: 0, trigger_beat: 0, trigger_order: 1, fade_in_sec: 0, fade_out_sec: 0, release_t_sec: null, release_start_alpha: 1 }],
      universes: uni,
      grandMaster: 1,
      blackout: false,
      tSec: 0,
    });
    const r = out.dmxByUniverse[0][1];
    const g = out.dmxByUniverse[0][2];
    const b = out.dmxByUniverse[0][3];
    expect(r).toBe(255);
    expect(g).toBeGreaterThanOrEqual(20);
    expect(g).toBeLessThanOrEqual(35);
    expect(b).toBe(0);
    expect(Math.abs(dmxToPerceptualU8(g, 2.2) - 0x55)).toBeLessThanOrEqual(4);
  });

  it("normalizes 2D spatial shaders to target cells bounding box and honors Beats vs Seconds scene duration", () => {
    const cells = [0, 1, 2, 3].map((idx) => ({
      cell_index: idx,
      pixel_key: String(idx + 1),
      grid_xyz: [idx / 3, 0, 0] as [number, number, number],
      local_uv: [idx / 3, 0.5] as [number, number],
    }));
    const channels = [
      { dmx_offset: 0, channel_number: 1, name: "Master", role: { kind: "intensity" as const }, target: { scope: "fixture" as const }, default_value: 0, fine_channel_offset: null },
      ...cells.flatMap((_, idx) => [
        { dmx_offset: 1 + idx * 3, channel_number: 2 + idx * 3, name: `R${idx}`, role: { kind: "color_intensity" as const, color: "Red" }, target: { scope: "cell" as const, cell_index: idx, pixel_key: String(idx + 1) }, default_value: 0, fine_channel_offset: null },
        { dmx_offset: 2 + idx * 3, channel_number: 3 + idx * 3, name: `G${idx}`, role: { kind: "color_intensity" as const, color: "Green" }, target: { scope: "cell" as const, cell_index: idx, pixel_key: String(idx + 1) }, default_value: 0, fine_channel_offset: null },
        { dmx_offset: 3 + idx * 3, channel_number: 4 + idx * 3, name: `B${idx}`, role: { kind: "color_intensity" as const, color: "Blue" }, target: { scope: "cell" as const, cell_index: idx, pixel_key: String(idx + 1) }, default_value: 0, fine_channel_offset: null },
      ]),
    ];
    const cache = {
      bar4: {
        summary: { id: "bar4", name: "Bar4", short_name: "Bar4", origin: "user_local" as const, categories: ["PixelBar"], pixel_count: 4, modes: [{ name: "13ch", short_name: "13ch", channel_count: 13, cell_count: 4 }] },
        raw_json: "",
        expanded_modes: [{ name: "13ch", short_name: "13ch", channel_count: 13, cells, channels }],
      },
    };
    const show = {
      version: "1.0",
      name: "BBox & Duration Test",
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
      dimmer_palettes: [],
      color_palettes: DEFAULT_COLOR_PALETTES,
      patch: [
        {
          id: "fx_bar",
          name: "Bar",
          profile: "bar4",
          mode: "13ch",
          universe: 1,
          address: 1,
          channel_count: 13,
          grid_pos: { x: 0.5, y: 0.5, rotation: 0, scale_x: 0.2, scale_y: 0.2 },
          calibration: { gamma: 2.2, min_dimmer_dmx: 0, max_dimmer_dmx: 255, white_gain: 1, white_mode: "replace" as const },
        },
      ],
      groups: [],
      fx_library: [
        {
          id: "blk_map",
          name: "Color Map",
          target_group: "all",
          duration_beats: 4,
          loop_block: true,
          elements: [
            { kind: "static_trait" as const, trait: "master_dimmer", op: "ltp" as const, palette_ref: null, value_start: 1, value_end: 1, order: null },
            { kind: "spatial_shader_2d" as const, trait: "color", op: "ltp" as const, shader: "linear_sweep" as const, palette_ref: "pal_rainbow", inline_colors: DEFAULT_COLOR_PALETTES[0].colors, rate_beats: null, speed_hz: null, rate_cycles: 1, spatial_freq: 1, direction_deg: 0, center_x: 0.5, center_y: 0.5 },
          ],
        },
        {
          id: "blk_sec",
          name: "Curve",
          target_group: "all",
          duration_beats: 4,
          duration_sec: 2,
          loop_block: true,
          elements: [
            { kind: "curve_1d" as const, trait: "dimmer", op: "ltp" as const, waveform: "saw" as const, amplitude: 1, offset: 0, rate_beats: null, speed_hz: null, rate_cycles: 1, phase_spread_deg: 0, duty: null, palette_ref: null, order: null },
          ],
        },
      ],
      scenes: [
        { id: "sc_map", name: "Map", bank: "Bank 1", target_group: null, priority: 10, fade_in_sec: 0, fade_out_sec: 0, duration_value: 4, duration_unit: "beats" as const, block_refs: ["blk_map"] },
        { id: "sc_sec", name: "Sec", bank: "Bank 1", target_group: null, priority: 10, fade_in_sec: 0, fade_out_sec: 0, duration_value: 2, duration_unit: "seconds" as const, block_refs: ["blk_sec"] },
      ],
      timelines: [],
    };
    const uni = [{ id: 1, review_output: false, protocol: { protocol: "art_net" as const, mode: { mode: "broadcast" as const }, net: 0, subnet: 0, uni: 0 } }];
    const mapOut = evaluateSimulationLayersToDmx({
      show,
      fixtureDetailsCache: cache,
      liveLayers: [],
      activeScenes: [{ scene_id: "sc_map", bank: "Bank 1", trigger_t_sec: 0, trigger_beat: 0, trigger_order: 1, fade_in_sec: 0, fade_out_sec: 0, release_t_sec: null, release_start_alpha: 1 }],
      universes: uni,
      grandMaster: 1,
      blackout: false,
      tSec: 0,
    });
    // Distinct colors along the 4 cells (bbox normalized to [0..1], not compressed to [0.4..0.6])
    const cell0 = [mapOut.dmxByUniverse[0][1], mapOut.dmxByUniverse[0][2], mapOut.dmxByUniverse[0][3]];
    const cell2 = [mapOut.dmxByUniverse[0][7], mapOut.dmxByUniverse[0][8], mapOut.dmxByUniverse[0][9]];
    expect(cell0).not.toEqual(cell2);

    // Seconds duration is BPM-independent
    const secBpm120 = evaluateSimulationLayersToDmx({
      show,
      fixtureDetailsCache: cache,
      liveLayers: [],
      activeScenes: [{ scene_id: "sc_sec", bank: "Bank 1", trigger_t_sec: 0, trigger_beat: 0, trigger_order: 1, fade_in_sec: 0, fade_out_sec: 0, release_t_sec: null, release_start_alpha: 1 }],
      beatClock: { bpm: 120, t_anchor_sec: 0, beat_anchor: 0 },
      universes: uni,
      grandMaster: 1,
      blackout: false,
      tSec: 0.5,
    });
    const secBpm60 = evaluateSimulationLayersToDmx({
      show,
      fixtureDetailsCache: cache,
      liveLayers: [],
      activeScenes: [{ scene_id: "sc_sec", bank: "Bank 1", trigger_t_sec: 0, trigger_beat: 0, trigger_order: 1, fade_in_sec: 0, fade_out_sec: 0, release_t_sec: null, release_start_alpha: 1 }],
      beatClock: { bpm: 60, t_anchor_sec: 0, beat_anchor: 0 },
      universes: uni,
      grandMaster: 1,
      blackout: false,
      tSec: 0.5,
    });
    expect(secBpm120.dmxByUniverse[0][0]).toBe(secBpm60.dmxByUniverse[0][0]);

    // Multi-stop palettes
    expect(DEFAULT_COLOR_PALETTES.length).toBeGreaterThanOrEqual(12);
    const midTri = sampleOklabStopsLinear(["#FF0000", "#00FF00", "#0000FF"], 0.5, 1, false, false);
    expect(midTri[1]).toBeGreaterThan(midTri[0]);
    expect(midTri[1]).toBeGreaterThan(midTri[2]);
  });

  it("strictly bounds spatial_shader_2d to its gizmo rectangle and supports scalar red trait", () => {
    const cells = [{ cell_index: 0, pixel_key: "1", grid_xyz: [0, 0, 0] as [number, number, number], local_uv: [0.5, 0.5] as [number, number] }];
    const channels = [
      { dmx_offset: 0, channel_number: 1, name: "Master", default_value: 0, target: { scope: "fixture" as const }, role: { kind: "intensity" as const }, fine_channel_offset: null },
      { dmx_offset: 1, channel_number: 2, name: "R1", default_value: 0, target: { scope: "cell" as const, cell_index: 0, pixel_key: "1" }, role: { kind: "color_intensity" as const, color: "Red" }, fine_channel_offset: null },
      { dmx_offset: 2, channel_number: 3, name: "G1", default_value: 0, target: { scope: "cell" as const, cell_index: 0, pixel_key: "1" }, role: { kind: "color_intensity" as const, color: "Green" }, fine_channel_offset: null },
      { dmx_offset: 3, channel_number: 4, name: "B1", default_value: 0, target: { scope: "cell" as const, cell_index: 0, pixel_key: "1" }, role: { kind: "color_intensity" as const, color: "Blue" }, fine_channel_offset: null },
    ];
    const cache = {
      par1: {
        summary: { id: "par1", name: "Par1", short_name: "Par1", origin: "user_local" as const, categories: ["Color Changer"], pixel_count: 1, modes: [{ name: "4ch", short_name: "4ch", channel_count: 4, cell_count: 1 }] },
        raw_json: "",
        expanded_modes: [{ name: "4ch", short_name: "4ch", channel_count: 4, cells, channels }],
      },
    };
    const show = {
      version: "1.0",
      name: "Bounds Test",
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
      patch: [
        {
          id: "fx_in",
          name: "Inside Par",
          profile: "par1",
          mode: "4ch",
          universe: 1,
          address: 1,
          channel_count: 4,
          grid_pos: { x: 0.5, y: 0.5, rotation: 0, scale_x: 0.1, scale_y: 0.1 },
          calibration: { gamma: 2.2, min_dimmer_dmx: 0, max_dimmer_dmx: 255, white_gain: 1, white_mode: "replace" as const },
        },
        {
          id: "fx_out",
          name: "Outside Par",
          profile: "par1",
          mode: "4ch",
          universe: 1,
          address: 50,
          channel_count: 4,
          grid_pos: { x: 0.95, y: 0.95, rotation: 0, scale_x: 0.05, scale_y: 0.05 },
          calibration: { gamma: 2.2, min_dimmer_dmx: 0, max_dimmer_dmx: 255, white_gain: 1, white_mode: "replace" as const },
        },
      ],
      color_palettes: DEFAULT_COLOR_PALETTES,
      dimmer_palettes: [],
      groups: [],
      fx_library: [
        {
          id: "blk_bounded",
          name: "Bounded Map",
          target_group: "all",
          duration_beats: 4,
          loop_block: true,
          elements: [
            { kind: "static_trait" as const, trait: "master_dimmer", op: "ltp" as const, palette_ref: null, value_start: 1, value_end: 1, order: null },
            { kind: "spatial_shader_2d" as const, trait: "color", op: "ltp" as const, shader: "linear_sweep" as const, palette_ref: "pal_fire", inline_colors: ["#FF0000", "#FF8800"], rate_beats: null, speed_hz: null, rate_cycles: 1, spatial_freq: 1, direction_deg: 0, center_x: 0.5, center_y: 0.5 },
          ],
        },
        {
          id: "blk_red_curve",
          name: "Red Curve",
          target_group: "fx_in",
          duration_beats: 4,
          loop_block: true,
          elements: [
            { kind: "static_trait" as const, trait: "master_dimmer", op: "ltp" as const, palette_ref: null, value_start: 1, value_end: 1, order: null },
            { kind: "curve_1d" as const, trait: "red", op: "ltp" as const, waveform: "square" as const, amplitude: 1, offset: 0, rate_beats: null, speed_hz: null, rate_cycles: 1, phase_spread_deg: 0, duty: null, palette_ref: null, order: null },
          ],
        },
      ],
      scenes: [
        { id: "sc_bounded", name: "Bounded", bank: "Bank 1", target_group: null, priority: 10, fade_in_sec: 0, fade_out_sec: 0, duration_value: 4, duration_unit: "beats" as const, block_refs: ["blk_bounded"] },
        { id: "sc_red", name: "Red", bank: "Bank 1", target_group: null, priority: 10, fade_in_sec: 0, fade_out_sec: 0, duration_value: 4, duration_unit: "beats" as const, block_refs: ["blk_red_curve"] },
      ],
      timelines: [],
    };
    const uni = [{ id: 1, review_output: false, protocol: { protocol: "art_net" as const, mode: { mode: "broadcast" as const }, net: 0, subnet: 0, uni: 0 } }];
    const out = evaluateSimulationLayersToDmx({
      show,
      fixtureDetailsCache: cache,
      liveLayers: [],
      activeScenes: [{ scene_id: "sc_bounded", bank: "Bank 1", trigger_t_sec: 0, trigger_beat: 0, trigger_order: 1, fade_in_sec: 0, fade_out_sec: 0, release_t_sec: null, release_start_alpha: 1 }],
      universes: uni,
      grandMaster: 1,
      blackout: false,
      tSec: 0,
    });
    // Fixture inside gizmo [0.3..0.7] gets lit red; fixture at 0.95 stays dark
    expect(out.dmxByUniverse[0][1]).toBeGreaterThan(0);
    expect(out.dmxByUniverse[0][50]).toBe(0);
    expect(out.dmxByUniverse[0][51]).toBe(0);

    // Scalar "red" curve writes only to Red channel (not Green/Blue)
    const redOut = evaluateSimulationLayersToDmx({
      show,
      fixtureDetailsCache: cache,
      liveLayers: [],
      activeScenes: [{ scene_id: "sc_red", bank: "Bank 1", trigger_t_sec: 0, trigger_beat: 0, trigger_order: 1, fade_in_sec: 0, fade_out_sec: 0, release_t_sec: null, release_start_alpha: 1 }],
      universes: uni,
      grandMaster: 1,
      blackout: false,
      tSec: 0,
    });
    expect(redOut.dmxByUniverse[0][1]).toBe(255);
    expect(redOut.dmxByUniverse[0][2]).toBe(0);
    expect(redOut.dmxByUniverse[0][3]).toBe(0);
  });

  it("computes SceneSequence duration and active step across empty, mixed units, crossfade, and playback modes", () => {
    expect(computeSceneSequenceDurationSec([], 120)).toBe(0);
    expect(getActiveSequenceStepAt([], "loop", 0.5, 120)).toBeNull();

    const steps = [
      { scene_id: "sc_1", duration_value: 2, duration_unit: "beats" as const, fade_sec: 0.5 }, // 1.0s at 120 BPM
      { scene_id: "sc_2", duration_value: 1.5, duration_unit: "seconds" as const, fade_sec: 0.5 }, // 1.5s
      { scene_id: "sc_3", duration_value: 1, duration_unit: "seconds" as const, fade_sec: 0 }, // 1.0s
    ];
    expect(computeSceneSequenceDurationSec(steps, 120)).toBeCloseTo(3.5, 5);

    // Loop mode: t=1.25s is 0.25s into step 1 (fade_sec=0.5 -> fadeAlpha=0.5, prevIndex=0)
    const loopMid = getActiveSequenceStepAt(steps, "loop", 1.25, 120)!;
    expect(loopMid.activeIndex).toBe(1);
    expect(loopMid.prevIndex).toBe(0);
    expect(loopMid.fadeAlpha).toBeCloseTo(0.5, 5);

    // Loop wrap: t=3.75s wraps to 0.25s into step 0 with prevIndex=2
    const loopWrap = getActiveSequenceStepAt(steps, "loop", 3.75, 120)!;
    expect(loopWrap.activeIndex).toBe(0);
    expect(loopWrap.prevIndex).toBe(2);
    expect(loopWrap.fadeAlpha).toBeCloseTo(0.5, 5);

    // One-shot holds final step past total duration
    const oneShotEnd = getActiveSequenceStepAt(steps, "one_shot", 10.0, 120)!;
    expect(oneShotEnd.activeIndex).toBe(2);
    expect(oneShotEnd.prevIndex).toBeNull();
    expect(oneShotEnd.fadeAlpha).toBe(1);

    // Bounce: order [0, 1, 2, 1] -> total bounce cycle = 1.0 + 1.5 + 1.0 + 1.5 = 5.0s
    // At t=4.0s -> 0.5s into returning step 1, prevIndex=2
    const bounceRet = getActiveSequenceStepAt(steps, "bounce", 4.0, 120)!;
    expect(bounceRet.activeIndex).toBe(1);
    expect(bounceRet.prevIndex).toBe(2);
    expect(bounceRet.stepLocalSec).toBeCloseTo(0.5, 5);
  });
});
