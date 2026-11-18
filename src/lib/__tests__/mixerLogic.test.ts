import { describe, expect, it } from "vitest";
import {
  analyzeSyntheticTimelineAudio,
  applyScalarMerge,
  computeBeatGridMarkers,
  computeClipAlphaAt,
  evaluateCurve1DScalar,
  evaluateSpatialShader2D,
  evaluateStepChaseScalar,
  evalUnipolarWaveform,
  extractRgbw,
  integrateTempoMapBeats,
  linearRgbToOklab,
  quantizeChannelValue,
  sampleOklabGradientHex,
  sampleOklabGradientLinear,
  snapTimeSecToMarkers,
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
});
