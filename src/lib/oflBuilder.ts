import rlcv3Profile from "../../fixtures/age/rlcv3_8_segment_tube.json";
import rlcv4Profile from "../../fixtures/age/rlcv4_16_segment_tube.json";

export type FixtureOrigin = "age_built_in" | "user_local";

export interface SchemaValidationIssue {
  instance_path: string;
  schema_path: string;
  message: string;
}

export interface MatrixCell {
  cell_index: number;
  pixel_key: string;
  grid_xyz: [number, number, number];
  local_uv: [number, number];
}

export interface StrobeRange {
  dmx_range: [number, number];
  effect: string;
  random_timing: boolean;
  speed_start_hz: number | null;
  speed_end_hz: number | null;
}

export interface ResolvedWheelSlot {
  slot_number: number;
  dmx_range: [number, number];
  name: string | null;
  colors_hex: string[];
}

export type ChannelRole =
  | { kind: "intensity" }
  | { kind: "color_intensity"; color: string }
  | { kind: "shutter_strobe"; capabilities: StrobeRange[] }
  | {
      kind: "wheel_slot";
      wheel_name: string | null;
      slots: ResolvedWheelSlot[];
    }
  | {
      kind: "fine_alias";
      parent_channel_name: string;
      parent_offset: number;
      resolution_byte_index: number;
    }
  | { kind: "unmapped"; capability_type: string };

export type ChannelTarget =
  | { scope: "fixture" }
  | { scope: "cell"; cell_index: number; pixel_key: string };

export interface ExpandedChannel {
  dmx_offset: number;
  channel_number: number;
  name: string;
  default_value: number;
  target: ChannelTarget;
  role: ChannelRole;
  fine_channel_offset: number | null;
}

export interface ExpandedFixtureMode {
  name: string;
  short_name: string;
  channel_count: number;
  cells: MatrixCell[];
  channels: ExpandedChannel[];
}

export interface FixtureModeSummary {
  name: string;
  short_name: string;
  channel_count: number;
  cell_count: number;
}

export interface FixtureSummary {
  id: string;
  name: string;
  short_name: string;
  origin: FixtureOrigin;
  categories: string[];
  pixel_count: number;
  modes: FixtureModeSummary[];
}

export interface FixtureDetail {
  summary: FixtureSummary;
  raw_json: string;
  expanded_modes: ExpandedFixtureMode[];
}

export interface FixtureValidationResult {
  valid: boolean;
  issues: SchemaValidationIssue[];
  expanded_modes: ExpandedFixtureMode[];
  pixel_count: number;
}

export interface WheelSlotDraft {
  type: "Open" | "Color";
  name: string;
  colorHex: string;
}

export interface CustomMacroChannelDraft {
  name: string;
  defaultValue: number;
}

export interface FixtureBuilderDraft {
  name: string;
  shortName: string;
  category: string;
  author: string;
  modeName: string;
  includeMasterDimmer: boolean;
  dimmer16Bit: boolean;
  includeStrobe: boolean;
  strobeRandom: boolean;
  strobeMinHz: number;
  strobeMaxHz: number;
  colorMode: "rgb" | "rgbw" | "wheel";
  wheelSlots: WheelSlotDraft[];
  isMatrix: boolean;
  pixelCountX: number;
  pixelCountY: number;
  pixelCountZ: number;
  channelOrder: "perPixel" | "perChannel";
  customChannels: CustomMacroChannelDraft[];
}

const VALID_OFL_COLORS = new Set([
  "Red",
  "Green",
  "Blue",
  "Cyan",
  "Magenta",
  "Yellow",
  "Amber",
  "White",
  "Warm White",
  "Cold White",
  "UV",
  "Lime",
  "Indigo",
]);

const VALID_SHUTTER_EFFECTS = new Set([
  "Open",
  "Closed",
  "Strobe",
  "Pulse",
  "RampUp",
  "RampDown",
  "RampUpDown",
  "Lightning",
  "Spikes",
  "Burst",
]);

export function createDefaultBuilderDraft(): FixtureBuilderDraft {
  return {
    name: "Studio RGBW Pixel Bar",
    shortName: "StudioBar8",
    category: "Pixel Bar",
    author: "Another German Engineer",
    modeName: "34ch Pixel Mode",
    includeMasterDimmer: true,
    dimmer16Bit: false,
    includeStrobe: true,
    strobeRandom: true,
    strobeMinHz: 1,
    strobeMaxHz: 20,
    colorMode: "rgbw",
    wheelSlots: [
      { type: "Open", name: "Open White", colorHex: "#FFFFFF" },
      { type: "Color", name: "Amber", colorHex: "#FF5500" },
      { type: "Color", name: "Cobalt", colorHex: "#2255AA" },
    ],
    isMatrix: true,
    pixelCountX: 8,
    pixelCountY: 1,
    pixelCountZ: 1,
    channelOrder: "perPixel",
    customChannels: [],
  };
}

export function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function parseOflJsonToDraft(rawJson: string): FixtureBuilderDraft | null {
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const base = createDefaultBuilderDraft();
    const avail = (parsed.availableChannels ?? {}) as Record<string, Record<string, unknown>>;
    const tmpl = (parsed.templateChannels ?? {}) as Record<string, Record<string, unknown>>;
    const modes = Array.isArray(parsed.modes)
      ? (parsed.modes as { name?: string; channels?: unknown[] }[])
      : [];
    const matrix = parsed.matrix as { pixelCount?: number[] } | undefined;
    const pixelCount = Array.isArray(matrix?.pixelCount) ? matrix.pixelCount : null;
    const isMatrix = Boolean(pixelCount && pixelCount.length >= 2);

    const allChKeys = [...Object.keys(avail), ...Object.keys(tmpl)].map((k) =>
      k.toLowerCase(),
    );
    const hasWhite = allChKeys.some((k) => k.includes("white"));
    const hasWheel = allChKeys.some((k) => k.includes("wheel"));
    const colorMode: FixtureBuilderDraft["colorMode"] = hasWheel
      ? "wheel"
      : hasWhite
        ? "rgbw"
        : "rgb";

    const includeMasterDimmer = Object.keys(avail).some((k) =>
      k.toLowerCase().includes("dimmer"),
    );
    const includeStrobe = Object.keys(avail).some(
      (k) => k.toLowerCase().includes("strobe") || k.toLowerCase().includes("shutter"),
    );

    const categories = Array.isArray(parsed.categories) ? parsed.categories : [];
    const meta = parsed.meta as { authors?: string[] } | undefined;

    return {
      ...base,
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : base.name,
      shortName:
        typeof parsed.shortName === "string" && parsed.shortName.trim()
          ? parsed.shortName
          : base.shortName,
      category: typeof categories[0] === "string" ? categories[0] : base.category,
      author:
        Array.isArray(meta?.authors) && typeof meta.authors[0] === "string"
          ? meta.authors[0]
          : base.author,
      modeName: modes[0]?.name ?? base.modeName,
      includeMasterDimmer,
      includeStrobe,
      colorMode,
      isMatrix,
      pixelCountX: isMatrix && pixelCount ? Math.max(1, Number(pixelCount[0]) || 1) : 1,
      pixelCountY: isMatrix && pixelCount ? Math.max(1, Number(pixelCount[1]) || 1) : 1,
      pixelCountZ: isMatrix && pixelCount ? Math.max(1, Number(pixelCount[2]) || 1) : 1,
    };
  } catch {
    return null;
  }
}

function buildStrobeCapabilities(
  minHz: number,
  maxHz: number,
  includeRandom: boolean,
): Record<string, unknown>[] {
  const safeMin = Math.max(0.1, minHz);
  const safeMax = Math.max(safeMin, maxHz);
  const startStr = `${safeMin}Hz`;
  const endStr = `${safeMax}Hz`;

  if (includeRandom) {
    return [
      { dmxRange: [0, 7], type: "ShutterStrobe", shutterEffect: "Closed" },
      { dmxRange: [8, 15], type: "ShutterStrobe", shutterEffect: "Open" },
      {
        dmxRange: [16, 200],
        type: "ShutterStrobe",
        shutterEffect: "Strobe",
        speedStart: startStr,
        speedEnd: endStr,
      },
      {
        dmxRange: [201, 255],
        type: "ShutterStrobe",
        shutterEffect: "Strobe",
        randomTiming: true,
        speedStart: startStr,
        speedEnd: endStr,
      },
    ];
  }

  return [
    { dmxRange: [0, 7], type: "ShutterStrobe", shutterEffect: "Closed" },
    { dmxRange: [8, 15], type: "ShutterStrobe", shutterEffect: "Open" },
    {
      dmxRange: [16, 255],
      type: "ShutterStrobe",
      shutterEffect: "Strobe",
      speedStart: startStr,
      speedEnd: endStr,
    },
  ];
}

export function buildOflFixtureJson(draft: FixtureBuilderDraft): string {
  const today = new Date().toISOString().slice(0, 10);
  const availableChannels: Record<string, unknown> = {};
  const templateChannels: Record<string, unknown> = {};
  const wheels: Record<string, unknown> = {};
  const modeChannels: unknown[] = [];

  if (draft.includeMasterDimmer) {
    const dimmerDef: Record<string, unknown> = {
      defaultValue: 0,
      capability: { type: "Intensity" },
    };
    if (draft.dimmer16Bit) {
      dimmerDef.fineChannelAliases = ["Master Dimmer fine"];
    }
    availableChannels["Master Dimmer"] = dimmerDef;
    modeChannels.push("Master Dimmer");
    if (draft.dimmer16Bit) {
      modeChannels.push("Master Dimmer fine");
    }
  }

  if (draft.includeStrobe) {
    availableChannels["Strobe"] = {
      defaultValue: 0,
      capabilities: buildStrobeCapabilities(
        draft.strobeMinHz,
        draft.strobeMaxHz,
        draft.strobeRandom,
      ),
    };
    modeChannels.push("Strobe");
  }

  const colorNames =
    draft.colorMode === "rgbw"
      ? ["Red", "Green", "Blue", "White"]
      : draft.colorMode === "rgb"
        ? ["Red", "Green", "Blue"]
        : [];

  if (draft.colorMode === "wheel") {
    const slots =
      draft.wheelSlots.length > 0
        ? draft.wheelSlots
        : [{ type: "Open" as const, name: "Open White", colorHex: "#FFFFFF" }];
    wheels["Color Wheel"] = {
      slots: slots.map((slot) =>
        slot.type === "Open"
          ? { type: "Open", name: slot.name || "Open" }
          : {
              type: "Color",
              name: slot.name || "Color",
              colors: [
                /^#[0-9a-fA-F]{6}$/.test(slot.colorHex)
                  ? slot.colorHex.toUpperCase()
                  : "#FFFFFF",
              ],
            },
      ),
    };

    const slotCount = slots.length;
    const step = Math.floor(256 / slotCount);
    const wheelCaps = slots.map((_s, idx) => {
      const start = idx * step;
      const end = idx === slotCount - 1 ? 255 : (idx + 1) * step - 1;
      return {
        dmxRange: [start, end],
        type: "WheelSlot",
        wheel: "Color Wheel",
        slotNumber: idx + 1,
      };
    });

    availableChannels["Color Wheel"] = {
      defaultValue: 0,
      capabilities: wheelCaps,
    };
    modeChannels.push("Color Wheel");
  } else if (draft.isMatrix) {
    const tplNames: string[] = [];
    for (const c of colorNames) {
      const tpl = `${c} $pixelKey`;
      templateChannels[tpl] = {
        defaultValue: 0,
        capability: { type: "ColorIntensity", color: c },
      };
      tplNames.push(tpl);
    }
    modeChannels.push({
      insert: "matrixChannels",
      repeatFor: "eachPixelABC",
      channelOrder: draft.channelOrder,
      templateChannels: tplNames,
    });
  } else {
    for (const c of colorNames) {
      availableChannels[c] = {
        defaultValue: 0,
        capability: { type: "ColorIntensity", color: c },
      };
      modeChannels.push(c);
    }
  }

  for (const custom of draft.customChannels) {
    const chName = custom.name.trim();
    if (!chName) continue;
    const defVal = Math.max(0, Math.min(255, Math.round(custom.defaultValue)));
    availableChannels[chName] = {
      defaultValue: defVal,
      capability: { type: "NoFunction" },
    };
    modeChannels.push(chName);
  }

  const root: Record<string, unknown> = {
    $schema:
      "https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/fixture.json",
    name: draft.name.trim() || "Custom Fixture",
    shortName: draft.shortName.trim() || "Custom",
    categories: [draft.category || "Color Changer"],
    meta: {
      authors: [draft.author.trim() || "Another German Engineer"],
      createDate: today,
      lastModifyDate: today,
    },
  };

  if (draft.isMatrix && draft.colorMode !== "wheel") {
    root.matrix = {
      pixelCount: [
        Math.max(1, Math.round(draft.pixelCountX)),
        Math.max(1, Math.round(draft.pixelCountY)),
        Math.max(1, Math.round(draft.pixelCountZ)),
      ],
      pixelGroups: { All: "all" },
    };
  }

  if (Object.keys(wheels).length > 0) {
    root.wheels = wheels;
  }
  if (Object.keys(availableChannels).length > 0) {
    root.availableChannels = availableChannels;
  }
  if (Object.keys(templateChannels).length > 0) {
    root.templateChannels = templateChannels;
  }

  const expandedCountPreview = computeDraftChannelCount(draft);
  root.modes = [
    {
      name: draft.modeName.trim() || `${expandedCountPreview}ch Mode`,
      shortName: `${expandedCountPreview}ch`,
      channels: modeChannels,
    },
  ];

  return JSON.stringify(root, null, 2);
}

function computeDraftChannelCount(draft: FixtureBuilderDraft): number {
  let count = 0;
  if (draft.includeMasterDimmer) count += draft.dimmer16Bit ? 2 : 1;
  if (draft.includeStrobe) count += 1;
  if (draft.colorMode === "wheel") {
    count += 1;
  } else {
    const colorCh = draft.colorMode === "rgbw" ? 4 : 3;
    const pixels = draft.isMatrix
      ? Math.max(1, draft.pixelCountX) *
        Math.max(1, draft.pixelCountY) *
        Math.max(1, draft.pixelCountZ)
      : 1;
    count += colorCh * pixels;
  }
  count += draft.customChannels.filter((c) => c.name.trim().length > 0).length;
  return Math.max(1, count);
}

function parseFreqHz(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const match = raw.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*hz$/i);
  return match ? Number(match[1]) : null;
}

function axisUv(idx: number, count: number): number {
  return count <= 1 ? 0 : idx / (count - 1) - 0.5;
}

function formatPixelKey(
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
): string {
  if (nx <= 1 && ny <= 1 && nz <= 1) return "1";
  if (ny === 1 && nz === 1) return `${x + 1}`;
  if (nx === 1 && nz === 1) return `${y + 1}`;
  if (nx === 1 && ny === 1) return `${z + 1}`;
  if (nz === 1) return `${x + 1}-${y + 1}`;
  return `${x + 1}-${y + 1}-${z + 1}`;
}

function validateChannelObj(
  chObj: Record<string, unknown>,
  basePath: string,
  issues: SchemaValidationIssue[],
) {
  const hasSingle = "capability" in chObj;
  const hasMulti = "capabilities" in chObj;
  if (hasSingle === hasMulti) {
    issues.push({
      instance_path: basePath,
      schema_path: "#/oneOf",
      message: "channel must define exactly one of capability or capabilities",
    });
    return;
  }
  const caps = hasSingle
    ? [chObj.capability]
    : Array.isArray(chObj.capabilities)
      ? chObj.capabilities
      : [];
  if (caps.length === 0) {
    issues.push({
      instance_path: `${basePath}/capabilities`,
      schema_path: "#/minItems",
      message: "capabilities array cannot be empty",
    });
  }

  caps.forEach((cap, idx) => {
    const capPath = hasSingle ? `${basePath}/capability` : `${basePath}/capabilities/${idx}`;
    if (!cap || typeof cap !== "object") {
      issues.push({
        instance_path: capPath,
        schema_path: "#/type",
        message: "capability must be an object",
      });
      return;
    }
    const c = cap as Record<string, unknown>;
    if (typeof c.type !== "string" || !c.type) {
      issues.push({
        instance_path: `${capPath}/type`,
        schema_path: "#/required",
        message: "capability type is required",
      });
    }
    if (c.type === "ColorIntensity" && !VALID_OFL_COLORS.has(String(c.color))) {
      issues.push({
        instance_path: `${capPath}/color`,
        schema_path: "#/enum",
        message: `invalid ColorIntensity color: ${String(c.color)}`,
      });
    }
    if (
      c.type === "ShutterStrobe" &&
      !VALID_SHUTTER_EFFECTS.has(String(c.shutterEffect))
    ) {
      issues.push({
        instance_path: `${capPath}/shutterEffect`,
        schema_path: "#/enum",
        message: `invalid shutterEffect: ${String(c.shutterEffect)}`,
      });
    }
    if (hasMulti) {
      if (!Array.isArray(c.dmxRange) || c.dmxRange.length !== 2) {
        issues.push({
          instance_path: `${capPath}/dmxRange`,
          schema_path: "#/required",
          message: "dmxRange [min, max] is required",
        });
      } else {
        c.dmxRange.forEach((val, rIdx) => {
          if (
            typeof val !== "number" ||
            !Number.isInteger(val) ||
            val < 0 ||
            val > 255
          ) {
            issues.push({
              instance_path: `${capPath}/dmxRange/${rIdx}`,
              schema_path: "#/maximum",
              message: `DMX value ${String(val)} must be integer 0..255`,
            });
          }
        });
      }
    }
  });
}

export function validateAndExpandOflLocally(
  rawJson: string,
): FixtureValidationResult {
  const issues: SchemaValidationIssue[] = [];
  let doc: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        valid: false,
        issues: [
          {
            instance_path: "/",
            schema_path: "#/type",
            message: "root value must be a JSON object",
          },
        ],
        expanded_modes: [],
        pixel_count: 0,
      };
    }
    doc = parsed as Record<string, unknown>;
  } catch (err) {
    return {
      valid: false,
      issues: [
        {
          instance_path: "/",
          schema_path: "",
          message: err instanceof Error ? err.message : "Invalid JSON",
        },
      ],
      expanded_modes: [],
      pixel_count: 0,
    };
  }

  if (typeof doc.name !== "string" || doc.name.trim().length === 0) {
    issues.push({
      instance_path: "/name",
      schema_path: "#/required",
      message: "name must be a non-empty string",
    });
  }
  if (!Array.isArray(doc.categories) || doc.categories.length === 0) {
    issues.push({
      instance_path: "/categories",
      schema_path: "#/required",
      message: "categories must be a non-empty array",
    });
  }
  if (!doc.meta || typeof doc.meta !== "object") {
    issues.push({
      instance_path: "/meta",
      schema_path: "#/required",
      message: "meta object is required",
    });
  }

  const avail = (doc.availableChannels ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const templates = (doc.templateChannels ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  if (Object.keys(avail).length === 0 && Object.keys(templates).length === 0) {
    issues.push({
      instance_path: "/availableChannels",
      schema_path: "#/anyOf",
      message: "availableChannels or templateChannels is required",
    });
  }
  for (const [k, v] of Object.entries(avail)) {
    validateChannelObj(v, `/availableChannels/${k}`, issues);
  }
  for (const [k, v] of Object.entries(templates)) {
    validateChannelObj(v, `/templateChannels/${k}`, issues);
  }

  if (!Array.isArray(doc.modes) || doc.modes.length === 0) {
    issues.push({
      instance_path: "/modes",
      schema_path: "#/required",
      message: "at least one mode is required",
    });
  }

  if (issues.length > 0) {
    return {
      valid: false,
      issues,
      expanded_modes: [],
      pixel_count: 0,
    };
  }

  // Expand cells
  const matrix = doc.matrix as
    | { pixelCount?: [number, number, number] }
    | undefined;
  const isMultiCell = Boolean(matrix);
  let canonicalCells: MatrixCell[] = [
    { cell_index: 0, pixel_key: "1", grid_xyz: [0, 0, 0], local_uv: [0, 0] },
  ];
  if (matrix?.pixelCount) {
    const [nx, ny, nz] = matrix.pixelCount;
    canonicalCells = [];
    let idx = 0;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          canonicalCells.push({
            cell_index: idx++,
            pixel_key: formatPixelKey(x, y, z, nx, ny, nz),
            grid_xyz: [x, y, z],
            local_uv: [axisUv(x, nx), axisUv(y, ny)],
          });
        }
      }
    }
  }

  const wheels = (doc.wheels ?? {}) as Record<
    string,
    { slots?: Array<{ type: string; name?: string; colors?: string[] }> }
  >;

  const fineMap = new Map<string, { parent: string; byteIdx: number }>();
  for (const [name, ch] of Object.entries(avail)) {
    const aliases = ch.fineChannelAliases;
    if (Array.isArray(aliases)) {
      aliases.forEach((a, i) => {
        if (typeof a === "string") fineMap.set(a, { parent: name, byteIdx: i + 1 });
      });
    }
  }

  const classify = (ch: Record<string, unknown>): ChannelRole => {
    const single = ch.capability as Record<string, unknown> | undefined;
    const multi = ch.capabilities as Record<string, unknown>[] | undefined;
    const caps = single ? [single] : (multi ?? []);
    if (caps.length === 0) {
      return { kind: "unmapped", capability_type: "NoFunction" };
    }
    if (caps.length === 1) {
      if (caps[0].type === "Intensity") return { kind: "intensity" };
      if (caps[0].type === "ColorIntensity" && typeof caps[0].color === "string") {
        return { kind: "color_intensity", color: caps[0].color };
      }
    }
    const strobes = caps.filter((c) => c.type === "ShutterStrobe");
    if (strobes.length > 0) {
      return {
        kind: "shutter_strobe",
        capabilities: strobes.map((c) => ({
          dmx_range: (c.dmxRange as [number, number]) ?? [0, 255],
          effect: String(c.shutterEffect ?? "Strobe"),
          random_timing: Boolean(c.randomTiming),
          speed_start_hz: parseFreqHz(c.speedStart),
          speed_end_hz: parseFreqHz(c.speedEnd),
        })),
      };
    }
    const wheelCaps = caps.filter((c) => c.type === "WheelSlot");
    if (wheelCaps.length > 0) {
      const wheelName =
        typeof wheelCaps[0].wheel === "string" ? wheelCaps[0].wheel : null;
      const wheelSlots = wheelName ? (wheels[wheelName]?.slots ?? []) : [];
      return {
        kind: "wheel_slot",
        wheel_name: wheelName,
        slots: wheelCaps.map((c) => {
          const slotNum = Math.max(1, Math.round(Number(c.slotNumber ?? 1)));
          const defSlot = wheelSlots[slotNum - 1];
          return {
            slot_number: slotNum,
            dmx_range: (c.dmxRange as [number, number]) ?? [0, 255],
            name: defSlot?.name ?? null,
            colors_hex: defSlot?.colors ?? [],
          };
        }),
      };
    }
    return {
      kind: "unmapped",
      capability_type: String(caps[0].type ?? "NoFunction"),
    };
  };

  const expandedModes: ExpandedFixtureMode[] = [];
  for (const rawMode of doc.modes as Array<{
    name: string;
    shortName?: string;
    channels: unknown[];
  }>) {
    if (!Array.isArray(rawMode.channels) || rawMode.channels.length === 0) {
      issues.push({
        instance_path: "/modes",
        schema_path: "#/minItems",
        message: "mode channels cannot be empty",
      });
      continue;
    }

    const pending: Array<{
      name: string;
      def: Record<string, unknown> | null;
      target: ChannelTarget;
    }> = [];

    for (const entry of rawMode.channels) {
      if (entry === null) {
        pending.push({
          name: "NoFunction",
          def: null,
          target: { scope: "fixture" },
        });
      } else if (typeof entry === "string") {
        if (fineMap.has(entry)) {
          pending.push({
            name: entry,
            def: null,
            target: { scope: "fixture" },
          });
        } else {
          const def = avail[entry];
          if (!def) {
            issues.push({
              instance_path: "/modes",
              schema_path: "",
              message: `channel '${entry}' not found in availableChannels`,
            });
            continue;
          }
          const rolePreview = classify(def);
          const target: ChannelTarget =
            !isMultiCell &&
            (rolePreview.kind === "color_intensity" ||
              rolePreview.kind === "wheel_slot")
              ? { scope: "cell", cell_index: 0, pixel_key: "1" }
              : { scope: "fixture" };
          pending.push({ name: entry, def, target });
        }
      } else if (entry && typeof entry === "object") {
        const ins = entry as {
          insert?: string;
          channelOrder?: "perPixel" | "perChannel";
          templateChannels?: string[];
        };
        if (!isMultiCell) {
          issues.push({
            instance_path: "/modes",
            schema_path: "",
            message: "matrixChannels insert requires matrix definition",
          });
          continue;
        }
        const tplList = ins.templateChannels ?? [];
        if (ins.channelOrder === "perChannel") {
          for (const tpl of tplList) {
            const def = templates[tpl];
            if (!def) {
              issues.push({
                instance_path: "/modes",
                schema_path: "",
                message: `template channel '${tpl}' not found`,
              });
              continue;
            }
            for (const cell of canonicalCells) {
              pending.push({
                name: tpl.replace("$pixelKey", cell.pixel_key),
                def,
                target: {
                  scope: "cell",
                  cell_index: cell.cell_index,
                  pixel_key: cell.pixel_key,
                },
              });
            }
          }
        } else {
          for (const cell of canonicalCells) {
            for (const tpl of tplList) {
              const def = templates[tpl];
              if (!def) {
                issues.push({
                  instance_path: "/modes",
                  schema_path: "",
                  message: `template channel '${tpl}' not found`,
                });
                continue;
              }
              pending.push({
                name: tpl.replace("$pixelKey", cell.pixel_key),
                def,
                target: {
                  scope: "cell",
                  cell_index: cell.cell_index,
                  pixel_key: cell.pixel_key,
                },
              });
            }
          }
        }
      }
    }

    const offsetMap = new Map<string, number>();
    pending.forEach((p, idx) => offsetMap.set(p.name, idx));

    const channels: ExpandedChannel[] = pending.map((p, idx) => {
      const fineInfo = fineMap.get(p.name);
      if (fineInfo) {
        return {
          dmx_offset: idx,
          channel_number: idx + 1,
          name: p.name,
          default_value: 0,
          target: p.target,
          role: {
            kind: "fine_alias",
            parent_channel_name: fineInfo.parent,
            parent_offset: offsetMap.get(fineInfo.parent) ?? idx,
            resolution_byte_index: fineInfo.byteIdx,
          },
          fine_channel_offset: null,
        };
      }
      if (p.def) {
        const aliases = p.def.fineChannelAliases as string[] | undefined;
        const fineOffset =
          aliases && aliases.length > 0 ? (offsetMap.get(aliases[0]) ?? null) : null;
        return {
          dmx_offset: idx,
          channel_number: idx + 1,
          name: p.name,
          default_value: Number(p.def.defaultValue ?? 0),
          target: p.target,
          role: classify(p.def),
          fine_channel_offset: fineOffset,
        };
      }
      return {
        dmx_offset: idx,
        channel_number: idx + 1,
        name: p.name,
        default_value: 0,
        target: p.target,
        role: { kind: "unmapped", capability_type: "NoFunction" },
        fine_channel_offset: null,
      };
    });

    expandedModes.push({
      name: rawMode.name,
      short_name: rawMode.shortName ?? `${channels.length}ch`,
      channel_count: channels.length,
      cells: canonicalCells,
      channels,
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    expanded_modes: issues.length === 0 ? expandedModes : [],
    pixel_count: issues.length === 0 ? canonicalCells.length : 0,
  };
}

function buildDetailFromJson(
  id: string,
  origin: FixtureOrigin,
  rawJsonObj: unknown,
): FixtureDetail {
  const raw_json = JSON.stringify(rawJsonObj, null, 2);
  const parsed = rawJsonObj as {
    name: string;
    shortName?: string;
    categories: string[];
  };
  const validation = validateAndExpandOflLocally(raw_json);
  return {
    summary: {
      id,
      name: parsed.name,
      short_name: parsed.shortName ?? parsed.name,
      origin,
      categories: parsed.categories,
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

export function getDefaultShippedFixtures(): FixtureDetail[] {
  return [
    buildDetailFromJson(
      "age/rlcv3_8_segment_tube.json",
      "age_built_in",
      rlcv3Profile,
    ),
    buildDetailFromJson(
      "age/rlcv4_16_segment_tube.json",
      "age_built_in",
      rlcv4Profile,
    ),
  ];
}
