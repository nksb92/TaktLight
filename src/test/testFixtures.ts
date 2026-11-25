import {
  type FixtureDetail,
  validateAndExpandOflLocally,
} from "../lib/oflBuilder";
import { useTaktStore } from "../store/useTaktStore";

export const TEST_TUBE_8SEG_ID = "user/test_tube_08seg.json";
export const TEST_TUBE_16SEG_ID = "user/test_tube_16seg.json";

const TEST_TUBE_8SEG_OBJ = {
  $schema:
    "https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/fixture.json",
  name: "Test 8-Segment RGBW Tube",
  shortName: "Test-8Px",
  categories: ["Pixel Bar", "Color Changer"],
  meta: {
    authors: ["Test Suite"],
    createDate: "2026-11-17",
    lastModifyDate: "2026-11-18",
  },
  matrix: {
    pixelCount: [8, 1, 1],
    pixelGroups: { All: "all" },
  },
  availableChannels: {
    "Master Dimmer": {
      defaultValue: 0,
      capability: { type: "Intensity" },
    },
    Strobe: {
      defaultValue: 0,
      capabilities: [
        { dmxRange: [0, 7], type: "ShutterStrobe", shutterEffect: "Closed" },
        { dmxRange: [8, 15], type: "ShutterStrobe", shutterEffect: "Open" },
        {
          dmxRange: [16, 200],
          type: "ShutterStrobe",
          shutterEffect: "Strobe",
          speedStart: "1Hz",
          speedEnd: "20Hz",
        },
        {
          dmxRange: [201, 255],
          type: "ShutterStrobe",
          shutterEffect: "Strobe",
          randomTiming: true,
          speedStart: "1Hz",
          speedEnd: "20Hz",
        },
      ],
    },
    Red: { defaultValue: 0, capability: { type: "ColorIntensity", color: "Red" } },
    Green: { defaultValue: 0, capability: { type: "ColorIntensity", color: "Green" } },
    Blue: { defaultValue: 0, capability: { type: "ColorIntensity", color: "Blue" } },
    White: { defaultValue: 0, capability: { type: "ColorIntensity", color: "White" } },
  },
  templateChannels: {
    "Red $pixelKey": {
      defaultValue: 0,
      capability: { type: "ColorIntensity", color: "Red" },
    },
    "Green $pixelKey": {
      defaultValue: 0,
      capability: { type: "ColorIntensity", color: "Green" },
    },
    "Blue $pixelKey": {
      defaultValue: 0,
      capability: { type: "ColorIntensity", color: "Blue" },
    },
    "White $pixelKey": {
      defaultValue: 0,
      capability: { type: "ColorIntensity", color: "White" },
    },
  },
  modes: [
    {
      name: "34ch Pixel Mode",
      shortName: "34ch",
      channels: [
        "Master Dimmer",
        "Strobe",
        {
          insert: "matrixChannels",
          repeatFor: "eachPixelABC",
          channelOrder: "perPixel",
          templateChannels: [
            "Red $pixelKey",
            "Green $pixelKey",
            "Blue $pixelKey",
            "White $pixelKey",
          ],
        },
      ],
    },
    {
      name: "6ch Basic Mode",
      shortName: "6ch",
      channels: ["Master Dimmer", "Strobe", "Red", "Green", "Blue", "White"],
    },
  ],
};

const TEST_TUBE_16SEG_OBJ = {
  ...TEST_TUBE_8SEG_OBJ,
  name: "Test 16-Segment RGBW Tube",
  shortName: "Test-16Px",
  matrix: {
    pixelCount: [16, 1, 1],
    pixelGroups: { All: "all" },
  },
  modes: [
    {
      name: "66ch Pixel Mode",
      shortName: "66ch",
      channels: [
        "Master Dimmer",
        "Strobe",
        {
          insert: "matrixChannels",
          repeatFor: "eachPixelABC",
          channelOrder: "perPixel",
          templateChannels: [
            "Red $pixelKey",
            "Green $pixelKey",
            "Blue $pixelKey",
            "White $pixelKey",
          ],
        },
      ],
    },
    {
      name: "6ch Basic Mode",
      shortName: "6ch",
      channels: ["Master Dimmer", "Strobe", "Red", "Green", "Blue", "White"],
    },
  ],
};

function buildTestDetail(id: string, rawObj: typeof TEST_TUBE_8SEG_OBJ): FixtureDetail {
  const raw_json = JSON.stringify(rawObj, null, 2);
  const validation = validateAndExpandOflLocally(raw_json);
  return {
    summary: {
      id,
      name: rawObj.name,
      short_name: rawObj.shortName,
      origin: "user_local",
      categories: rawObj.categories,
      pixel_count: validation.pixel_count,
      modes: validation.expanded_modes.map((m) => ({
        name: m.name,
        short_name: m.short_name,
        channel_count: m.channel_count,
        cell_count: m.cells.length,
      })),
    },
    raw_json,
    expanded_modes: validation.expanded_modes,
  };
}

export function getTestFixtures(): FixtureDetail[] {
  return [
    buildTestDetail(TEST_TUBE_8SEG_ID, TEST_TUBE_8SEG_OBJ),
    buildTestDetail(TEST_TUBE_16SEG_ID, TEST_TUBE_16SEG_OBJ),
  ];
}

export function getTestFixtureCache(): Record<string, FixtureDetail> {
  return Object.fromEntries(getTestFixtures().map((f) => [f.summary.id, f]));
}

export function seedTestFixturesInStore(): void {
  const fixtures = getTestFixtures();
  const cache = Object.fromEntries(fixtures.map((f) => [f.summary.id, f]));
  useTaktStore.setState({
    fixtureSummaries: fixtures.map((f) => f.summary),
    fixtureDetailsCache: cache,
    selectedFixtureId: fixtures[0]?.summary.id ?? null,
  });
}
