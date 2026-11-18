import { describe, expect, it } from "vitest";
import {
  applyScalarMerge,
  extractRgbw,
  linearRgbToOklab,
  quantizeChannelValue,
  sampleOklabGradientHex,
  sampleOklabGradientLinear,
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
});
