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
    // Configure Universe 2 as sACN to verify cross-protocol split warning
    const curShow = useTaktStore.getState().showState;
    const unisWithSacnU2 = curShow.network_outputs.universes.map((u) =>
      u.id === 2
        ? {
            id: 2,
            review_output: false,
            protocol: {
              protocol: "sacn" as const,
              mode: { mode: "multicast" as const },
              sacn_universe: 2,
              priority: 100,
            },
          }
        : u,
    );
    useTaktStore.setState({
      showState: {
        ...curShow,
        network_outputs: {
          ...curShow.network_outputs,
          universes: unisWithSacnU2,
        },
      },
      universes: unisWithSacnU2,
    });

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

  it("manages referenceable palettes, groups, and live layers with quantized DMX + XML round-trip", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube Live",
        1,
        1,
        1,
      );

    await useTaktStore.getState().upsertColorPalette({
      id: "pal_pure_white",
      name: "Pure White",
      hex_start: "#FFFFFF",
      hex_end: "#FFFFFF",
    });
    expect(useTaktStore.getState().showState.color_palettes).toHaveLength(13);

    await useTaktStore.getState().undoShow();
    expect(useTaktStore.getState().showState.color_palettes).toHaveLength(12);
    await useTaktStore.getState().redoShow();
    expect(useTaktStore.getState().showState.color_palettes).toHaveLength(13);

    await useTaktStore.getState().upsertGroup({
      id: "grp_tube",
      name: "Tube Group",
      order: "mirror",
      targets: ["fx_001:0..7"],
    });

    await useTaktStore.getState().setLiveLayers([
      {
        id: "l_dim",
        name: "Dim",
        enabled: true,
        priority: 1,
        trigger_order: 1,
        alpha: 1,
        target: "grp_tube",
        order_override: null,
        trait_spec: {
          trait_kind: "dimmer",
          op: "htp",
          palette_ref: "dim_full",
          value_start: 1,
          value_end: 1,
        },
      },
      {
        id: "l_col",
        name: "Col",
        enabled: true,
        priority: 1,
        trigger_order: 2,
        alpha: 1,
        target: "grp_tube",
        order_override: null,
        trait_spec: {
          trait_kind: "color",
          op: "ltp",
          palette_ref: "pal_pure_white",
          hex_start: "#000000",
          hex_end: "#000000",
        },
      },
    ]);

    const state = useTaktStore.getState();
    // Ch 1 = Master Dimmer (255 untouched fallback), Ch 6 = Pixel 1 White (255 in replace mode)
    expect(state.dmxByUniverse[1][0]).toBe(255);
    expect(state.dmxByUniverse[1][5]).toBe(255);
    expect(state.cellPreviewRgbd[0]).toBe(255);

    const xml = await state.exportShowXml();
    expect(xml).toContain('id="pal_pure_white"');
    expect(xml).toContain('id="grp_tube"');
  });

  it("triggers scenes with bank exclusivity, phase-continuous tap tempo, and FX block CRUD", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube FX",
        1,
        1,
        1,
      );

    await useTaktStore.getState().upsertFxBlock({
      id: "blk_pulse",
      name: "Pulse",
      target_group: "all",
      duration_beats: 4,
      loop_block: true,
      elements: [
        {
          kind: "curve_1d",
          trait: "dimmer",
          op: "htp",
          waveform: "sine",
          amplitude: 1,
          offset: 0,
          rate_beats: 2,
          speed_hz: null,
          phase_spread_deg: 360,
          duty: 0.5,
          palette_ref: null,
          order: null,
        },
      ],
    });

    await useTaktStore.getState().upsertScene({
      id: "sc_pulse",
      name: "Pulse Scene",
      bank: "Bank 1",
      target_group: null,
      priority: 15,
      fade_in_sec: 0,
      fade_out_sec: 1,
      block_refs: ["blk_pulse"],
    });

    await useTaktStore.getState().upsertScene({
      id: "sc_cyber_wave",
      name: "Cyber Wave",
      bank: "Bank 1",
      target_group: null,
      priority: 10,
      fade_in_sec: 0,
      fade_out_sec: 0,
      block_refs: ["blk_cyber_wave"],
    });

    await useTaktStore.getState().triggerScene("sc_cyber_wave", 0);
    expect(useTaktStore.getState().activeScenes).toHaveLength(1);
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(255);

    await useTaktStore.getState().triggerScene("sc_pulse", 1);
    const active = useTaktStore.getState().activeScenes;
    expect(active).toHaveLength(2);
    expect(active.find((s) => s.scene_id === "sc_cyber_wave")?.release_t_sec).toBe(1);

    await useTaktStore.getState().tapTempo(5.0);
    await useTaktStore.getState().tapTempo(5.4);
    expect(useTaktStore.getState().liveBpm).toBeCloseTo(150, 1);

    await useTaktStore.getState().releaseAllScenes(2.0);
    expect(
      useTaktStore
        .getState()
        .activeScenes.every((s) => s.release_t_sec === 2.0),
    ).toBe(true);
  });

  it("manages multi-track timelines with Undo/Redo, XML round-trip, audio analysis, and scene busking overlay", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube TL",
        1,
        1,
        1,
      );

    await useTaktStore.getState().upsertTimeline({
      id: "tl_custom",
      name: "Custom Track Show",
      duration_sec: 12,
      grid_offset_sec: 0.12,
      tempo_map: [
        { at_sec: 0, bpm: 120 },
        { at_sec: 4, bpm: 140 },
      ],
      audio_track: {
        file: "audio/track.wav",
        abs_fallback: null,
        sha256: null,
        offset_sec: 0,
        transient_sensitivity: 0.7,
      },
      tracks: [
        {
          id: "trk_base",
          name: "Base Wave",
          target_group: "all",
          clips: [
            {
              ref_block: "blk_cyber_wave",
              start_sec: 1.0,
              duration_sec: 6.0,
              fade_in_sec: 0.0,
              fade_out_sec: 0.5,
              inline_fx: [],
            },
          ],
        },
      ],
    });
    expect(
      useTaktStore.getState().showState.timelines.some((t) => t.id === "tl_custom"),
    ).toBe(true);

    await useTaktStore.getState().undoShow();
    expect(
      useTaktStore.getState().showState.timelines.some((t) => t.id === "tl_custom"),
    ).toBe(false);
    await useTaktStore.getState().redoShow();
    expect(
      useTaktStore.getState().showState.timelines.some((t) => t.id === "tl_custom"),
    ).toBe(true);

    // Before clip starts (playhead = 0.2s): DMX Master Ch1 = 0
    await useTaktStore.getState().setTimelineTransport("tl_custom", false, 0.2, 0);
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(0);

    // Inside clip (playhead = 2.0s): DMX Master Ch1 = 255
    await useTaktStore.getState().setTimelineTransport("tl_custom", false, 2.0, 0);
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(255);

    // Latency offset adjustment updates state cleanly
    await useTaktStore.getState().setLatencyOffsetMs(-15);
    expect(useTaktStore.getState().latencyOffsetMs).toBe(-15);

    // Audio analysis populates transients + BPM
    const res = await useTaktStore
      .getState()
      .analyzeTimelineAudio("tl_custom", undefined, 128, 8, 0.65);
    expect(res.transients.length).toBeGreaterThan(0);
    expect(useTaktStore.getState().audioAnalysisByTimeline["tl_custom"]).toBeDefined();

    // XML export + import round-trip preserves <Timelines>
    const xml = await useTaktStore.getState().exportShowXml();
    expect(xml).toContain('id="tl_custom"');
    await useTaktStore.getState().deleteTimeline("tl_custom");
    expect(
      useTaktStore.getState().showState.timelines.some((t) => t.id === "tl_custom"),
    ).toBe(false);
    await useTaktStore.getState().importShowXml(xml);
    expect(
      useTaktStore.getState().showState.timelines.some((t) => t.id === "tl_custom"),
    ).toBe(true);
  });

  it("moves split fixtures to valid unsplit addresses when rollover is off with Undo support", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Split Tube",
        1,
        1,
        505,
      );

    expect(useTaktStore.getState().showState.patch[0].universe).toBe(1);
    expect(useTaktStore.getState().showState.patch[0].address).toBe(505);

    await useTaktStore.getState().setRolloverEnabled(false);
    await useTaktStore.getState().resolveSplitFixtures();

    const moved = useTaktStore.getState().showState.patch[0];
    expect(moved.universe).toBe(2);
    expect(moved.address).toBe(1);

    await useTaktStore.getState().undoShow();
    const restored = useTaktStore.getState().showState.patch[0];
    expect(restored.universe).toBe(1);
    expect(restored.address).toBe(505);
  });

  it("supports EDIT Preview vs BLIND vs LIVE output isolation, quick scenes, unique FX blocks, pattern selection, and group mixer", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube UX",
        1,
        1,
        1,
      );

    // Initial blank starter scene outputs 0 DMX in EDIT Preview (no auto dimmer/color)
    expect(useTaktStore.getState().studioOutputMode).toBe("live");
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(0);
    useTaktStore.getState().selectSceneForEdit("sc_new_1");
    useTaktStore.getState().setStudioOutputMode("edit_preview");
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(0);

    // Seed a lit scene referencing blk_cyber_wave to verify EDIT Preview vs BLIND vs LIVE
    await useTaktStore.getState().upsertScene({
      id: "sc_cyber_wave",
      name: "Cyberpunk Wave",
      bank: "Bank 1",
      target_group: null,
      priority: 10,
      fade_in_sec: 0,
      fade_out_sec: 0,
      block_refs: ["blk_cyber_wave"],
    });
    useTaktStore.getState().setStudioOutputMode("live");

    // EDIT Preview outputs selected scene immediately to DMX and 2D preview
    useTaktStore.getState().selectSceneForEdit("sc_cyber_wave");
    useTaktStore.getState().setStudioOutputMode("edit_preview");
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(255);
    expect(useTaktStore.getState().cellPreviewRgbd[0]).toBeGreaterThan(0);

    // BLIND mode keeps DMX isolated (0) while updating 2D preview
    useTaktStore.getState().setStudioOutputMode("blind");
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(0);
    expect(useTaktStore.getState().cellPreviewRgbd[0]).toBeGreaterThan(0);

    // Bank & quick-scene creation defaults (0 fade, blank block_refs unless bank default overridden)
    expect(useTaktStore.getState().sceneBanks).toEqual(["Bank 1"]);
    const quickBlank = await useTaktStore.getState().createQuickSceneInBank("Bank 1");
    expect(quickBlank.fade_in_sec).toBe(0);
    expect(quickBlank.fade_out_sec).toBe(0);
    expect(quickBlank.block_refs).toEqual([]);

    // Bank default fade inheritance & instant quick scene creation
    useTaktStore.getState().setBankDefaultFade("Bank 1", 1.5, 2.0);
    const created = await useTaktStore.getState().createQuickSceneInBank("Bank 1");
    expect(created.fade_in_sec).toBe(1.5);
    expect(created.fade_out_sec).toBe(2.0);
    await useTaktStore.getState().upsertScene({
      ...created,
      block_refs: ["blk_cyber_wave"],
    });

    // Duplicate & Make Unique FX Block protection
    const dup = await useTaktStore.getState().duplicateScene(created.id);
    expect(dup).not.toBeNull();
    const uniqueBlock = await useTaktStore
      .getState()
      .makeFxBlockUniqueForScene(dup!.id, dup!.block_refs[0]);
    expect(uniqueBlock).not.toBeNull();
    expect(uniqueBlock!.id).not.toBe("blk_cyber_wave");

    // 2D Quick-Pattern Selection Filters
    useTaktStore.getState().applyCellSelectionPattern("1/2");
    expect(useTaktStore.getState().selectedCellIndices).toEqual([0, 2, 4, 6]);
    useTaktStore.getState().applyCellSelectionPattern("shift_right");
    expect(useTaktStore.getState().selectedCellIndices).toEqual([1, 3, 5, 7]);
    useTaktStore.getState().applyCellSelectionPattern("invert");
    expect(useTaktStore.getState().selectedCellIndices).toEqual([0, 2, 4, 6]);

    // Group Mixer Flash -> turns on DMX in LIVE mode
    useTaktStore.getState().setStudioOutputMode("live");
    useTaktStore.getState().updateGroupMixerStrip("all", { flashActive: true });
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(255);
    useTaktStore.getState().updateGroupMixerStrip("all", { flashActive: false });
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(0);

    // Right-click stackable bank mode allows multiple active scenes in same bank
    useTaktStore.getState().toggleBankStackable("Bank 1");
    await useTaktStore.getState().triggerScene("sc_cyber_wave", 0);
    await useTaktStore.getState().triggerScene(created.id, 0.5);
    expect(
      useTaktStore
        .getState()
        .activeScenes.every((s) => s.release_t_sec === null),
    ).toBe(true);
    await useTaktStore.getState().releaseAllScenes(1);
    useTaktStore.getState().toggleBankStackable("Bank 1");

    // Live Snapshot capture
    const snapScene = await useTaktStore
      .getState()
      .captureLiveSnapshotToScene("Captured Look");
    expect(snapScene.name).toBe("Captured Look");
  });

  it("enforces TX OFF default, zero fades, blank starter scene, 12+ palettes, dirty tracking, and custom master dimmer fixture loading", async () => {
    const initial = useTaktStore.getState();
    expect(initial.outputEnabled).toBe(false);
    expect(initial.isDirty).toBe(false);
    expect(initial.showState.color_palettes.length).toBeGreaterThanOrEqual(12);
    expect(initial.showState.scenes).toHaveLength(2);
    expect(initial.showState.scenes[0]).toMatchObject({
      id: "sc_new_1",
      fade_in_sec: 0,
      fade_out_sec: 0,
      duration_value: 4,
      duration_unit: "beats",
      block_refs: [],
    });
    expect(initial.showState.scenes[1]).toMatchObject({
      id: "sc_tl_cyber_intro",
      timeline_ref: "tl_cyber_intro",
    });

    // Creating a Timeline Super-Scene in a bank adds both SceneDef(timeline_ref) and TimelineDef
    const tlScene = await useTaktStore
      .getState()
      .createTimelineSceneInBank("Bank 1", "Intro Show");
    expect(tlScene.timeline_ref).toBeTruthy();
    await useTaktStore.getState().triggerScene(tlScene.id, 0);
    expect(useTaktStore.getState().activeTimelineId).toBe(tlScene.timeline_ref);
    expect(useTaktStore.getState().timelinePlaying).toBe(true);
    await useTaktStore.getState().releaseScene(tlScene.id, 1);
    expect(useTaktStore.getState().timelinePlaying).toBe(false);

    await initial.upsertScene({
      ...initial.showState.scenes[0],
      name: "Edited Name",
    });
    expect(useTaktStore.getState().isDirty).toBe(true);
    useTaktStore.getState().markShowSaved();
    expect(useTaktStore.getState().isDirty).toBe(false);

    // Custom fixture with Master Dimmer + pixels populates fixtureDetailsCache automatically
    const draft = createDefaultBuilderDraft();
    draft.name = "Master Pixel Bar";
    draft.shortName = "MPBar";
    draft.includeMasterDimmer = true;
    draft.isMatrix = true;
    draft.pixelCountX = 4;
    const saved = await useTaktStore
      .getState()
      .saveUserFixture("Master Pixel Bar", buildOflFixtureJson(draft));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    await useTaktStore
      .getState()
      .patchFixtures(saved.detail.summary.id, draft.modeName, "Master Bar", 1, 1, 1);
    await useTaktStore.getState().ensureFixtureDetailsLoaded([saved.detail.summary.id]);
    const cached = useTaktStore.getState().fixtureDetailsCache[saved.detail.summary.id];
    expect(cached).toBeDefined();
    expect(
      cached.expanded_modes[0].channels.some(
        (c) => c.target.scope === "fixture" && c.role.kind === "intensity",
      ),
    ).toBe(true);
  });

  it("deep-clones FX blocks and timelines when duplicating a scene so edits stay independent", async () => {
    await useTaktStore.getState().upsertFxBlock({
      id: "blk_orig",
      name: "Orig Block",
      target_group: "all",
      duration_beats: 4,
      loop_block: true,
      elements: [
        {
          kind: "static_trait",
          trait: "color",
          op: "ltp",
          palette_ref: null,
          value_start: null,
          value_end: null,
          hex_start: "#FF0000",
          hex_end: "#FF0000",
          order: null,
        },
      ],
    });
    await useTaktStore.getState().upsertScene({
      id: "sc_orig",
      name: "Orig Scene",
      bank: "Bank 1",
      target_group: null,
      priority: 10,
      fade_in_sec: 0,
      fade_out_sec: 0,
      block_refs: ["blk_orig"],
    });

    const copy = await useTaktStore.getState().duplicateScene("sc_orig");
    expect(copy).not.toBeNull();
    expect(copy!.block_refs).toHaveLength(1);
    expect(copy!.block_refs[0]).not.toBe("blk_orig");

    // Mutate the copied scene's FX block -> original scene's block must remain unchanged
    const copiedBlock = useTaktStore
      .getState()
      .showState.fx_library.find((b) => b.id === copy!.block_refs[0])!;
    await useTaktStore.getState().upsertFxBlock({
      ...copiedBlock,
      elements: [
        {
          kind: "static_trait",
          trait: "color",
          op: "ltp",
          palette_ref: null,
          value_start: null,
          value_end: null,
          hex_start: "#0000FF",
          hex_end: "#0000FF",
          order: null,
        },
      ],
    });

    const origBlockAfter = useTaktStore
      .getState()
      .showState.fx_library.find((b) => b.id === "blk_orig")!;
    expect(origBlockAfter.elements[0].kind).toBe("static_trait");
    if (origBlockAfter.elements[0].kind === "static_trait") {
      expect(origBlockAfter.elements[0].hex_start).toBe("#FF0000");
    }

    // Timeline scene duplication also deep-clones the referenced timeline
    const tlScene = await useTaktStore
      .getState()
      .createTimelineSceneInBank("Bank 1", "Orig TL");
    const tlCopy = await useTaktStore.getState().duplicateScene(tlScene.id);
    expect(tlCopy).not.toBeNull();
    expect(tlCopy!.timeline_ref).toBeTruthy();
    expect(tlCopy!.timeline_ref).not.toBe(tlScene.timeline_ref);
  });

  it("reorders scene banks cleanly from left to right and right to left", () => {
    useTaktStore.getState().createSceneBank("Bank 2");
    useTaktStore.getState().createSceneBank("Bank 3");
    expect(useTaktStore.getState().sceneBanks).toEqual([
      "Bank 1",
      "Bank 2",
      "Bank 3",
    ]);

    useTaktStore.getState().reorderSceneBanks("Bank 1", "Bank 3");
    expect(useTaktStore.getState().sceneBanks).toEqual([
      "Bank 2",
      "Bank 3",
      "Bank 1",
    ]);

    useTaktStore.getState().reorderSceneBanks("Bank 1", "Bank 2");
    expect(useTaktStore.getState().sceneBanks).toEqual([
      "Bank 1",
      "Bank 2",
      "Bank 3",
    ]);
  });

  it("reuses cached file handle on subsequent saves without re-opening Save As dialog and uses valid .xml picker extension", async () => {
    const writes: string[] = [];
    const showSaveFilePicker = vi.fn(async (_opts: unknown) => ({
      createWritable: async () => ({
        write: async (data: string) => {
          writes.push(data);
        },
        close: async () => {},
      }),
    }));
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker =
      showSaveFilePicker;

    const ok1 = await useTaktStore.getState().saveProjectToFile();
    expect(ok1).toBe(true);
    expect(showSaveFilePicker).toHaveBeenCalledTimes(1);
    const pickerOpts = showSaveFilePicker.mock.calls[0][0] as {
      types: Array<{ accept: Record<string, string[]> }>;
    };
    expect(pickerOpts.types[0].accept["application/xml"]).toEqual([".xml"]);

    const ok2 = await useTaktStore.getState().saveProjectToFile();
    expect(ok2).toBe(true);
    expect(showSaveFilePicker).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(2);

    const xml = await useTaktStore.getState().exportShowXml();
    await useTaktStore.getState().importShowXml(xml);
    const ok3 = await useTaktStore.getState().saveProjectToFile();
    expect(ok3).toBe(true);
    expect(showSaveFilePicker).toHaveBeenCalledTimes(2);

    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  it("updates opened project file in place on Ctrl+S / saveProjectToFile without opening Save As dialog", async () => {
    const initialXml = await useTaktStore.getState().exportShowXml();
    const writes: string[] = [];
    const queryPermission = vi.fn(async () => "prompt");
    const requestPermission = vi.fn(async () => "granted");
    const openedHandle = {
      getFile: async () => ({
        text: async () => initialXml,
      }),
      queryPermission,
      requestPermission,
      createWritable: async () => ({
        write: async (data: string) => {
          writes.push(data);
        },
        close: async () => {},
      }),
    };

    const showOpenFilePicker = vi.fn(async () => [openedHandle]);
    const showSaveFilePicker = vi.fn(async () => {
      throw new Error("Save As dialog should not open for an already opened project");
    });

    const win = window as unknown as {
      showOpenFilePicker?: unknown;
      showSaveFilePicker?: unknown;
    };
    win.showOpenFilePicker = showOpenFilePicker;
    win.showSaveFilePicker = showSaveFilePicker;

    try {
      const openResult = await useTaktStore.getState().openProjectFromFile();
      expect(openResult).toBe("opened");
      expect(showOpenFilePicker).toHaveBeenCalledTimes(1);
      expect(useTaktStore.getState().isDirty).toBe(false);

      // Edit the opened project
      await useTaktStore
        .getState()
        .patchFixtures(
          "age/rlcv3_8_segment_tube.json",
          "34ch Pixel Mode",
          "Edited Tube",
          1,
          1,
          1,
        );
      expect(useTaktStore.getState().isDirty).toBe(true);

      // Save should write directly to the opened file handle without Save As
      const saved = await useTaktStore.getState().saveProjectToFile();
      expect(saved).toBe(true);
      expect(showSaveFilePicker).not.toHaveBeenCalled();
      expect(queryPermission).toHaveBeenCalledWith({ mode: "readwrite" });
      expect(requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("Edited Tube");
      expect(useTaktStore.getState().isDirty).toBe(false);
    } finally {
      delete win.showOpenFilePicker;
      delete win.showSaveFilePicker;
    }
  });

  it("replaces blank project Bank 1 on project open and round-trips bank colors in XML", async () => {
    const store = useTaktStore.getState();
    await store.renameSceneBank("Bank 1", "Dimmer");
    store.setBankColor("Dimmer", "#3B82F6");
    store.setBankColor("Colors Tubes", "#A855F7");

    const xml = await useTaktStore.getState().exportShowXml();
    expect(xml).toContain("<BankColors>");
    expect(xml).toContain('bank="Dimmer" color="#3B82F6"');
    expect(xml).toContain('bank="Colors Tubes" color="#A855F7"');

    // Reset to fresh blank project that starts with "Bank 1" and empty bankColors
    useTaktStore.getState().resetForTest();
    expect(useTaktStore.getState().sceneBanks).toEqual(["Bank 1"]);
    expect(useTaktStore.getState().bankColors).toEqual({});

    // Import saved XML -> "Bank 1" must NOT remain, and bank colors must be restored
    await useTaktStore.getState().importShowXml(xml);
    expect(useTaktStore.getState().sceneBanks).toEqual(["Dimmer"]);
    expect(useTaktStore.getState().sceneBanks).not.toContain("Bank 1");
    expect(useTaktStore.getState().bankColors).toEqual({
      Dimmer: "#3B82F6",
      "Colors Tubes": "#A855F7",
    });
  });
});
