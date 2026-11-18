import { describe, expect, it } from "vitest";
import {
  buildOflFixtureJson,
  createDefaultBuilderDraft,
  getDefaultShippedFixtures,
  validateAndExpandOflLocally,
} from "../oflBuilder";

describe("oflBuilder", () => {
  it("generates valid schema-compliant OFL JSON for multi-cell RGBW fixtures", () => {
    const draft = createDefaultBuilderDraft();
    const json = buildOflFixtureJson(draft);
    const res = validateAndExpandOflLocally(json);

    expect(res.valid).toBe(true);
    expect(res.issues).toEqual([]);
    expect(res.pixel_count).toBe(8);
    expect(res.expanded_modes[0].channel_count).toBe(34);
    expect(res.expanded_modes[0].cells).toHaveLength(8);
    expect(res.expanded_modes[0].channels[0].target).toEqual({
      scope: "fixture",
    });
    expect(res.expanded_modes[0].channels[2].target).toEqual({
      scope: "cell",
      cell_index: 0,
      pixel_key: "1",
    });
    expect(res.expanded_modes[0].channels[33].target).toEqual({
      scope: "cell",
      cell_index: 7,
      pixel_key: "8",
    });
  });

  it("supports 16-bit dimmer, color wheel slots, perChannel order, and custom default values", () => {
    const draft = createDefaultBuilderDraft();
    draft.isMatrix = false;
    draft.dimmer16Bit = true;
    draft.includeStrobe = false;
    draft.colorMode = "wheel";
    draft.customChannels = [{ name: "Macro Mode", defaultValue: 120 }];

    const json = buildOflFixtureJson(draft);
    const res = validateAndExpandOflLocally(json);
    expect(res.valid).toBe(true);

    const chs = res.expanded_modes[0].channels;
    expect(chs).toHaveLength(4);
    expect(chs[0].fine_channel_offset).toBe(1);
    expect(chs[1].role.kind).toBe("fine_alias");
    expect(chs[2].role.kind).toBe("wheel_slot");
    expect(chs[3].default_value).toBe(120);
  });

  it("rejects malformed or out-of-range OFL JSON with paths", () => {
    const draft = createDefaultBuilderDraft();
    const parsed = JSON.parse(buildOflFixtureJson(draft));
    parsed.availableChannels.Strobe.capabilities[0].dmxRange = [0, 999];
    const res = validateAndExpandOflLocally(JSON.stringify(parsed));
    expect(res.valid).toBe(false);
    expect(
      res.issues.some((i) => i.instance_path.includes("dmxRange")),
    ).toBe(true);
  });

  it("provides shipped RLCV3 and RLCV4 profiles offline", () => {
    const shipped = getDefaultShippedFixtures();
    expect(shipped).toHaveLength(2);
    expect(shipped[0].summary.pixel_count).toBe(8);
    expect(shipped[1].summary.pixel_count).toBe(16);
  });
});
