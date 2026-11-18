import { describe, expect, it } from "vitest";
import {
  computeOrderU,
  expandTargetRange,
  FixtureInstance,
  getFixtureFootprint,
  getUniverseFreeStats,
  inheritNextUniverse,
  previewPlacement,
  transformCellUv,
} from "../patchLogic";
import type { UniverseConfig } from "../../store/useTaktStore";

const UNIVERSES: UniverseConfig[] = [
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
      protocol: "art_net",
      mode: { mode: "broadcast" },
      net: 0,
      subnet: 0,
      uni: 1,
    },
  },
];

function makeFixture(
  id: string,
  name: string,
  universe: number,
  address: number,
  channelCount: number,
): FixtureInstance {
  return {
    id,
    profile: "age/rlcv3_8_segment_tube.json",
    mode: "34ch Pixel Mode",
    name,
    universe,
    address,
    channel_count: channelCount,
    grid_pos: { x: 0.5, y: 0.5, rotation: 0, scale_x: 0.4, scale_y: 0.05 },
    calibration: {
      gamma: 2.2,
      min_dimmer_dmx: 0,
      max_dimmer_dmx: 255,
      white_mode: "replace",
      white_gain: 1.0,
    },
  };
}

describe("patchLogic", () => {
  it("computes split footprints and free space stats", () => {
    const f1 = makeFixture("fx_1", "Tube Left", 1, 505, 34);
    const fp = getFixtureFootprint(f1);
    expect(fp.head).toEqual({
      universe: 1,
      startAddress: 505,
      endAddress: 512,
      channelOffsetStart: 0,
    });
    expect(fp.tail).toEqual({
      universe: 2,
      startAddress: 1,
      endAddress: 26,
      channelOffsetStart: 8,
    });

    const stats1 = getUniverseFreeStats([f1], 1);
    expect(stats1.freeChannels).toBe(504);
    expect(stats1.largestBlock).toBe(504);

    const stats2 = getUniverseFreeStats([f1], 2);
    expect(stats2.freeChannels).toBe(486);
    expect(stats2.largestBlock).toBe(486);
  });

  it("previews rollover ON split vs rollover OFF move", () => {
    const split = previewPlacement(
      [],
      UNIVERSES,
      "Tube Left",
      1,
      505,
      34,
      true,
    );
    expect(split.universe).toBe(1);
    expect(split.address).toBe(505);
    expect(split.wasSplit).toBe(true);
    expect(split.tailEndAddress).toBe(26);
    expect(split.toastMessage).toBe(
      "Tube Left split: U1.505 to U1.512 + U2.001 to U2.026",
    );

    const whole = previewPlacement(
      [],
      UNIVERSES,
      "Tube Left",
      1,
      505,
      34,
      false,
    );
    expect(whole.universe).toBe(2);
    expect(whole.address).toBe(1);
    expect(whole.wasSplit).toBe(false);
    expect(whole.toastMessage).toBe("Tube Left moved to U2.001");
  });

  it("inherits ArtNet universe carry and computes 1D ordering / 2D cell transforms", () => {
    const u15: UniverseConfig = {
      id: 1,
      protocol: {
        protocol: "art_net",
        mode: { mode: "broadcast" },
        net: 0,
        subnet: 0,
        uni: 15,
      },
    };
    const next = inheritNextUniverse(u15, 2);
    expect(next.protocol).toEqual({
      protocol: "art_net",
      mode: { mode: "broadcast" },
      net: 0,
      subnet: 1,
      uni: 0,
    });

    expect(expandTargetRange("fx_201:7..0", 8)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(computeOrderU("center_out", 2, 5)).toBeCloseTo(0, 5);
    expect(computeOrderU("center_out", 0, 5)).toBeCloseTo(1, 5);
    const p = transformCellUv(
      { x: 0.5, y: 0.5, rotation: 90, scale_x: 0.4, scale_y: 0.2 },
      [0.5, 0],
    );
    expect(p[0]).toBeCloseTo(0.5, 4);
    expect(p[1]).toBeCloseTo(0.7, 4);
  });
});
