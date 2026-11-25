import { describe, expect, it } from "vitest";
import {
  buildOflFixtureJson,
  createDefaultBuilderDraft,
  getDefaultShippedFixtures,
  parseOflJsonToDraft,
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

  it("ships with the standard RLCV3 fixture profile", () => {
    const shipped = getDefaultShippedFixtures();
    expect(shipped).toHaveLength(1);
    expect(shipped[0].summary.id).toBe("standard/rlcv3.json");
    expect(shipped[0].summary.name).toBe("RLCV3");
    expect(shipped[0].summary.origin).toBe("standard");
    expect(shipped[0].summary.pixel_count).toBe(24);
  });

  it("supports custom RGB orders, white/WW+CW modes, white position, and round-trips via parseOflJsonToDraft", () => {
    const draft = createDefaultBuilderDraft();
    draft.includeMasterDimmer = false;
    draft.includeStrobe = false;
    draft.isMatrix = true;
    draft.pixelCountX = 2;
    draft.rgbOrder = "GRB";
    draft.whiteMode = "ww_cw";
    draft.whitePosition = "before";

    const json = buildOflFixtureJson(draft);
    const res = validateAndExpandOflLocally(json);
    expect(res.valid).toBe(true);
    expect(res.expanded_modes[0].channel_count).toBe(10);
    expect(
      res.expanded_modes[0].channels.slice(0, 5).map((c) => c.name),
    ).toEqual([
      "Warm White 1",
      "Cold White 1",
      "Green 1",
      "Red 1",
      "Blue 1",
    ]);

    const parsedBack = parseOflJsonToDraft(json);
    expect(parsedBack).not.toBeNull();
    expect(parsedBack?.rgbOrder).toBe("GRB");
    expect(parsedBack?.whiteMode).toBe("ww_cw");
    expect(parsedBack?.whitePosition).toBe("before");
  });

  it("handles parseOflJsonToDraft edge cases, single-pixel white/RGB modes, and schema rejections", () => {
    expect(parseOflJsonToDraft("{ invalid")).toBeNull();
    expect(parseOflJsonToDraft(JSON.stringify({ name: "" }))?.name).toBe(
      "Studio RGBW Pixel Bar",
    );

    const invalidSyntax = validateAndExpandOflLocally("{ broken");
    expect(invalidSyntax.valid).toBe(false);
    expect(invalidSyntax.issues.length).toBeGreaterThan(0);

    const emptyObj = validateAndExpandOflLocally("{}");
    expect(emptyObj.valid).toBe(false);

    const singleRgb = createDefaultBuilderDraft();
    singleRgb.isMatrix = false;
    singleRgb.colorMode = "rgb";
    singleRgb.whiteMode = "none";
    singleRgb.includeMasterDimmer = true;
    singleRgb.includeStrobe = true;
    const singleJson = buildOflFixtureJson(singleRgb);
    const singleRes = validateAndExpandOflLocally(singleJson);
    expect(singleRes.valid).toBe(true);
    expect(singleRes.pixel_count).toBe(1);

    const parsedSingle = parseOflJsonToDraft(singleJson);
    expect(parsedSingle).not.toBeNull();
    expect(parsedSingle?.isMatrix).toBe(false);

    const wheelOnly = createDefaultBuilderDraft();
    wheelOnly.isMatrix = false;
    wheelOnly.colorMode = "wheel";
    wheelOnly.includeMasterDimmer = false;
    wheelOnly.includeStrobe = false;
    const wheelRes = validateAndExpandOflLocally(buildOflFixtureJson(wheelOnly));
    expect(wheelRes.valid).toBe(true);
    expect(wheelRes.expanded_modes[0].channel_count).toBe(1);
  });
});
