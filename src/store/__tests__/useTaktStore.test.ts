import { beforeEach, describe, expect, it } from "vitest";
import { encodeBinaryFrame } from "../../lib/frameDecoder";
import {
  buildOflFixtureJson,
  createDefaultBuilderDraft,
} from "../../lib/oflBuilder";
import { parkKey, useTaktStore } from "../useTaktStore";

describe("useTaktStore", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("applies decoded binary frames to universe DMX buffers and telemetry", () => {
    const u1 = new Uint8Array(512);
    u1[0] = 240;
    const u2 = new Uint8Array(512);
    u2[9] = 155;

    const frame = encodeBinaryFrame({
      revision: 42n,
      tSec: 3.5,
      cellCount: 0,
      droppedFrames: 1,
      meanUs: 22728.5,
      maxJitterUs: 38.2,
      p99JitterUs: 29.4,
      universes: [u1, u2],
      cellPreviewRgbd: new Uint8Array(0),
    });

    useTaktStore.getState().applyBinaryFrame(frame);

    const state = useTaktStore.getState();
    expect(state.dmxByUniverse[1][0]).toBe(240);
    expect(state.dmxByUniverse[2][9]).toBe(155);
    expect(state.telemetry.revision).toBe(42n);
    expect(state.telemetry.meanUs).toBeCloseTo(22728.5, 2);
    expect(state.telemetry.p99JitterUs).toBeCloseTo(29.4, 2);
    expect(state.telemetry.droppedFrames).toBe(1);
  });

  it("parks, overrides blackout, and clears channels in simulation mode", async () => {
    await useTaktStore.getState().setChannelPark(1, 5, 200);
    await useTaktStore.getState().setBlackout(true);

    let state = useTaktStore.getState();
    expect(state.parkedChannels[parkKey(1, 5)]).toBe(200);
    expect(state.blackout).toBe(true);
    expect(state.dmxByUniverse[1][4]).toBe(200);

    await useTaktStore.getState().setChannelPark(2, 12, 128);
    expect(useTaktStore.getState().dmxByUniverse[2][11]).toBe(128);

    await useTaktStore.getState().clearAllParked(1);
    state = useTaktStore.getState();
    expect(state.parkedChannels[parkKey(1, 5)]).toBeUndefined();
    expect(state.dmxByUniverse[1][4]).toBe(0);
    expect(state.parkedChannels[parkKey(2, 12)]).toBe(128);

    await useTaktStore.getState().clearAllParked();
    expect(Object.keys(useTaktStore.getState().parkedChannels)).toHaveLength(0);
  });

  it("clamps grand master and switches network adapter offline", async () => {
    await useTaktStore.getState().setGrandMaster(1.8);
    expect(useTaktStore.getState().grandMaster).toBe(1);

    await useTaktStore.getState().setGrandMaster(-0.5);
    expect(useTaktStore.getState().grandMaster).toBe(0);

    await useTaktStore.getState().setNetworkAdapter({ mode: "offline" });
    expect(useTaktStore.getState().isOffline).toBe(true);
    expect(useTaktStore.getState().adapterSelection).toEqual({
      mode: "offline",
    });
  });

  it("loads shipped OFL fixtures, validates, saves, and deletes user fixtures", async () => {
    await useTaktStore.getState().loadFixtures();
    expect(useTaktStore.getState().fixtureSummaries).toHaveLength(2);

    const draft = createDefaultBuilderDraft();
    draft.name = "Bench Test Bar";
    const validJson = buildOflFixtureJson(draft);
    const saveRes = await useTaktStore
      .getState()
      .saveUserFixture("Bench Test Bar", validJson);
    expect(saveRes.ok).toBe(true);
    expect(useTaktStore.getState().fixtureSummaries).toHaveLength(3);

    const badSave = await useTaktStore
      .getState()
      .saveUserFixture("Broken", "{\"name\": \"\"}");
    expect(badSave.ok).toBe(false);

    await useTaktStore
      .getState()
      .deleteUserFixture("user/bench_test_bar.json");
    expect(useTaktStore.getState().fixtureSummaries).toHaveLength(2);
  });

  it("patches split fixtures, undoes/redoes, coalesces grid drags, and exports/imports XML", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube Left",
        1,
        1,
        505,
      );

    let state = useTaktStore.getState();
    expect(state.showState.patch).toHaveLength(1);
    expect(state.compiledCells).toHaveLength(8);
    expect(state.crossProtocolWarning).toBe(true);
    expect(state.patchToast).toBe(
      "Tube Left split: U1.505 to U1.512 + U2.001 to U2.026",
    );

    const fxId = state.showState.patch[0].id;
    const basePos = state.showState.patch[0].grid_pos;

    await useTaktStore
      .getState()
      .updateFixtureGridPos(fxId, { ...basePos, x: 0.3 }, "drag_fx");
    await useTaktStore
      .getState()
      .updateFixtureGridPos(fxId, { ...basePos, x: 0.7 }, "drag_fx");

    // Undo should revert the entire coalesced drag back to basePos.x
    await useTaktStore.getState().undoShow();
    expect(useTaktStore.getState().showState.patch[0].grid_pos.x).toBeCloseTo(
      basePos.x,
      4,
    );

    await useTaktStore.getState().redoShow();
    expect(useTaktStore.getState().showState.patch[0].grid_pos.x).toBeCloseTo(
      0.7,
      4,
    );

    const xml = await useTaktStore.getState().exportShowXml();
    expect(xml).toContain("<TaktLightShow");
    expect(xml).toContain("Tube Left");

    await useTaktStore.getState().unpatchFixture(fxId);
    expect(useTaktStore.getState().showState.patch).toHaveLength(0);

    await useTaktStore.getState().importShowXml(xml);
    expect(useTaktStore.getState().showState.patch).toHaveLength(1);
  });
});
