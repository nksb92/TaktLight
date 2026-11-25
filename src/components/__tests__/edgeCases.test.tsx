import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { buildOflFixtureJson, createDefaultBuilderDraft } from "../../lib/oflBuilder";
import { useTaktStore } from "../../store/useTaktStore";
import {
  seedTestFixturesInStore,
  TEST_TUBE_8SEG_ID,
  TEST_TUBE_16SEG_ID,
} from "../../test/testFixtures";

describe("TaktLight Edge-Case Coverage (Areas 1–5)", () => {
  beforeEach(() => {
    if (typeof window.PointerEvent === "undefined") {
      (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
        MouseEvent;
    }
    useTaktStore.getState().resetForTest();
    seedTestFixturesInStore();
  });

  it("Area 1: stacks multiple FX elements on one scene, isolates shared blocks via Make Unique, and survives dangling refs", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        TEST_TUBE_8SEG_ID,
        "34ch Pixel Mode",
        "Tube Edge",
        1,
        1,
        1,
      );

    await useTaktStore.getState().upsertGroup({
      id: "grp_temp",
      name: "Temp Group",
      order: "linear",
      targets: ["fx_001:0..7"],
    });

    // Stack color_fx + chaser_fx inside one FX block
    await useTaktStore.getState().upsertFxBlock({
      id: "blk_stacked",
      name: "Stacked Color + Chase",
      target_group: "grp_temp",
      duration_beats: 4,
      loop_block: true,
      elements: [
        {
          kind: "curve_1d",
          trait: "color",
          op: "ltp",
          fx_kind_tag: "color_fx",
          waveform: "saw",
          amplitude: 1,
          offset: 0,
          rate_beats: null,
          speed_hz: null,
          rate_cycles: 1,
          phase_deg: 0,
          phase_spread_deg: 360,
          duty: null,
          grayscale: false,
          color_width: 1,
          gradient: 1,
          angle_deg: 0,
          palette_ref: null,
          inline_colors: ["#FF0000", "#0000FF"],
          order: "linear",
        },
        {
          kind: "step_chase",
          trait: "dimmer",
          op: "htp",
          step_beats: null,
          speed_hz: null,
          rate_cycles: 1,
          one_way: true,
          pixels_on: 4,
          active_ratio: null,
          fade: 0,
          amplitude: 1,
          palette_ref: null,
          order: "linear",
        },
      ],
    });
    await useTaktStore.getState().upsertScene({
      id: "sc_stacked",
      name: "Stacked Scene",
      bank: "Bank 1",
      target_group: null,
      priority: 10,
      fade_in_sec: 0,
      fade_out_sec: 0,
      duration_value: 4,
      duration_unit: "beats",
      block_refs: ["blk_stacked"],
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));
    fireEvent.click(screen.getByTestId("scene-play-zone-sc_stacked"));

    // Both FX stack tabs exist and can be switched cleanly
    expect(screen.getByTestId("fx-stack-tab-0")).toHaveTextContent("COLOR FX");
    expect(screen.getByTestId("fx-stack-tab-1")).toHaveTextContent("CHASER FX");
    fireEvent.click(screen.getByTestId("fx-stack-tab-1"));
    expect(screen.getByTestId("fx-submenu-header-chaser_fx")).toBeInTheDocument();

    // Duplicate scene -> immediately deep-clones block IDs for independence
    const dup = await useTaktStore.getState().duplicateScene("sc_stacked");
    expect(dup).not.toBeNull();
    expect(dup!.block_refs[0]).not.toBe("blk_stacked");

    // Make Unique isolates a manually shared block ID
    await useTaktStore.getState().upsertScene({
      id: "sc_shared",
      name: "Shared Block Scene",
      bank: "Bank 1",
      target_group: null,
      priority: 10,
      fade_in_sec: 0,
      fade_out_sec: 0,
      block_refs: ["blk_stacked"],
    });
    const uniqueBlk = await useTaktStore
      .getState()
      .makeFxBlockUniqueForScene("sc_shared", "blk_stacked");
    expect(uniqueBlk).not.toBeNull();
    expect(uniqueBlk!.id).not.toBe("blk_stacked");

    // Trigger scene then delete its referenced group while playing -> zero crash, valid finite DMX
    await useTaktStore.getState().triggerScene("sc_stacked", 0);
    await useTaktStore.getState().deleteGroup("grp_temp");
    const u1 = useTaktStore.getState().dmxByUniverse[1];
    expect(u1.every((v) => Number.isFinite(v) && v >= 0 && v <= 255)).toBe(true);
  });

  it("Area 2: handles 0-fixture, 1-cell Par, split 16-segment RLCV4, and extreme numeric inputs without NaN", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    // 0-fixture show: creating and triggering FX scenes stays safe
    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-color_fx"));
      await Promise.resolve();
    });
    await useTaktStore.getState().triggerScene("sc_new_1", 0);
    expect(useTaktStore.getState().dmxByUniverse[1].every((v) => v === 0)).toBe(true);

    // Extreme BPM and Grand Master inputs are clamped cleanly
    const bpmInput = screen.getByLabelText("Live BPM");
    fireEvent.change(bpmInput, { target: { value: "99999" } });
    fireEvent.blur(bpmInput);
    expect(useTaktStore.getState().liveBpm).toBeLessThanOrEqual(300);
    fireEvent.change(bpmInput, { target: { value: "-50" } });
    fireEvent.blur(bpmInput);
    expect(useTaktStore.getState().liveBpm).toBeGreaterThanOrEqual(20);

    const gmInput = screen.getByLabelText("Grand Master value");
    fireEvent.change(gmInput, { target: { value: "999" } });
    fireEvent.blur(gmInput);
    expect(useTaktStore.getState().grandMaster).toBeLessThanOrEqual(1);
    fireEvent.change(gmInput, { target: { value: "-20" } });
    fireEvent.blur(gmInput);
    expect(useTaktStore.getState().grandMaster).toBeGreaterThanOrEqual(0);
    await useTaktStore.getState().setGrandMaster(1);

    // 1-cell custom RGB Par fixture
    const draft = createDefaultBuilderDraft();
    draft.name = "Single Cell Par";
    draft.shortName = "Par1";
    draft.isMatrix = false;
    draft.colorMode = "rgb";
    draft.modeName = "5ch Par";
    const saved = await useTaktStore
      .getState()
      .saveUserFixture("Single Cell Par", buildOflFixtureJson(draft));
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      await useTaktStore
        .getState()
        .patchFixtures(saved.detail.summary.id, "5ch Par", "Par 1", 1, 1, 1);
    }

    // Split 16-segment RLCV4 across U1.490 -> U2
    await useTaktStore
      .getState()
      .patchFixtures(
        TEST_TUBE_16SEG_ID,
        "66ch Pixel Mode",
        "Split RLCV4",
        1,
        1,
        490,
      );
    await useTaktStore.getState().upsertFxBlock({
      id: "blk_split_all",
      name: "Split Chase",
      target_group: "all",
      duration_beats: 4,
      loop_block: true,
      elements: [
        {
          kind: "static_trait",
          trait: "color",
          op: "ltp",
          palette_ref: null,
          hex_start: "#FF0000",
          hex_end: "#FF0000",
          value_start: 0,
          value_end: 0,
          order: null,
        },
        {
          kind: "step_chase",
          trait: "dimmer",
          op: "ltp",
          step_beats: null,
          speed_hz: null,
          rate_cycles: 1,
          one_way: true,
          pixels_on: 99,
          active_ratio: null,
          fade: 0,
          amplitude: 1,
          palette_ref: null,
          order: "linear",
        },
      ],
    });
    await useTaktStore.getState().upsertScene({
      id: "sc_split_all",
      name: "Split All",
      bank: "Bank 1",
      target_group: null,
      priority: 10,
      fade_in_sec: 0,
      fade_out_sec: 0,
      duration_value: 4,
      duration_unit: "beats",
      block_refs: ["blk_split_all"],
    });
    await useTaktStore.getState().triggerScene("sc_split_all", 0);
    // Both U1 tail (ch 490..512) and U2 head (ch 1..43) receive non-zero DMX
    const u1 = useTaktStore.getState().dmxByUniverse[1];
    const u2 = useTaktStore.getState().dmxByUniverse[2];
    expect(Array.from(u1.slice(489, 512)).some((v) => v > 0)).toBe(true);
    expect(Array.from(u2.slice(0, 43)).some((v) => v > 0)).toBe(true);
  });

  it("Area 3: enforces timeline clip boundaries (t >= 0, min duration 0.1s) and survives 0-byte audio drop", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));
    fireEvent.click(screen.getByTestId("scene-play-zone-sc_tl_cyber_intro"));

    // Drag clip far left past t=0 -> clamped to start_sec === 0
    const clipBody = screen.getByTestId("clip-body-trk_1-0");
    fireEvent.pointerDown(clipBody, { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: -500 });
    fireEvent.pointerUp(window);
    expect(
      useTaktStore.getState().showState.timelines[0].tracks[0].clips[0].start_sec,
    ).toBeGreaterThanOrEqual(0);

    // Trim end handle way past start -> clamped to duration_sec >= 0.1
    const trimEnd = screen.getByTestId("clip-trim-end-trk_1-0");
    fireEvent.pointerDown(trimEnd, { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: -500 });
    fireEvent.pointerUp(window);
    expect(
      useTaktStore.getState().showState.timelines[0].tracks[0].clips[0].duration_sec,
    ).toBeGreaterThanOrEqual(0.1);

    // Dropping a 0-byte corrupted audio file on new-track dropzone does not crash
    const badFile = new File([], "empty_broken.wav", { type: "audio/wav" });
    const dropzone = screen.getByTestId("timeline-new-track-dropzone");
    const dropEvt = Object.assign(
      new Event("drop", { bubbles: true, cancelable: true }),
      {
        clientX: 100,
        dataTransfer: { getData: () => "", files: [badFile] },
      },
    );
    await act(async () => {
      fireEvent(dropzone, dropEvt);
      await Promise.resolve();
    });
    expect(screen.getByTestId("daslight-timeline-dock")).toBeInTheDocument();
  });

  it("Area 4: preserves DMX across full XML round-trip and supports multi-step Undo/Redo across FX edits", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        TEST_TUBE_8SEG_ID,
        "34ch Pixel Mode",
        "Tube XML",
        1,
        1,
        1,
      );
    await useTaktStore.getState().upsertFxBlock({
      id: "blk_xml_fx",
      name: "XML Color FX",
      target_group: "all",
      duration_beats: 4,
      loop_block: true,
      elements: [
        {
          kind: "static_trait",
          trait: "dimmer",
          op: "ltp",
          palette_ref: null,
          value_start: 1,
          value_end: 1,
          order: null,
        },
        {
          kind: "curve_1d",
          trait: "color",
          op: "ltp",
          fx_kind_tag: "color_fx",
          waveform: "saw",
          amplitude: 1,
          offset: 0,
          rate_beats: null,
          speed_hz: null,
          rate_cycles: 1,
          phase_deg: 0,
          phase_spread_deg: 360,
          duty: null,
          grayscale: false,
          color_width: 1.5,
          gradient: 1,
          angle_deg: 180,
          palette_ref: null,
          inline_colors: ["#FF0000", "#00FF00", "#0000FF"],
          order: "linear",
        },
      ],
    });
    await useTaktStore.getState().upsertScene({
      id: "sc_xml_fx",
      name: "XML Scene",
      bank: "Bank 1",
      target_group: null,
      priority: 10,
      fade_in_sec: 0,
      fade_out_sec: 0,
      duration_value: 4,
      duration_unit: "beats",
      block_refs: ["blk_xml_fx"],
    });
    const tBefore = useTaktStore.getState().telemetry.tSec;
    await useTaktStore.getState().triggerScene("sc_xml_fx", tBefore);
    const dmxBefore = Array.from(useTaktStore.getState().dmxByUniverse[1].slice(0, 34));

    const xml = await useTaktStore.getState().exportShowXml();
    await useTaktStore.getState().importShowXml(xml);
    const tAfter = useTaktStore.getState().telemetry.tSec;
    await useTaktStore.getState().triggerScene("sc_xml_fx", tAfter);
    const dmxAfter = Array.from(useTaktStore.getState().dmxByUniverse[1].slice(0, 34));
    expect(dmxAfter).toEqual(dmxBefore);

    // Multi-step Undo/Redo symmetry
    const blk0 = useTaktStore
      .getState()
      .showState.fx_library.find((b) => b.id === "blk_xml_fx")!;
    await useTaktStore.getState().upsertFxBlock({ ...blk0, name: "Step 1" });
    await useTaktStore.getState().upsertFxBlock({ ...blk0, name: "Step 2" });
    await useTaktStore.getState().undoShow();
    expect(
      useTaktStore.getState().showState.fx_library.find((b) => b.id === "blk_xml_fx")?.name,
    ).toBe("Step 1");
    await useTaktStore.getState().undoShow();
    expect(
      useTaktStore.getState().showState.fx_library.find((b) => b.id === "blk_xml_fx")?.name,
    ).toBe("XML Color FX");
    await useTaktStore.getState().redoShow();
    expect(
      useTaktStore.getState().showState.fx_library.find((b) => b.id === "blk_xml_fx")?.name,
    ).toBe("Step 1");
  });

  it("Area 5: FixtureBuilder preserves added modes during Visual Builder edits and handles broken Raw JSON gracefully", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Fixtures$/i }));
    fireEvent.click(screen.getByRole("button", { name: /New Builder Draft/i }));
    // Clear NEW DRAFT context banner & starts with 0 modes (no automatically created mode)
    expect(screen.getByTestId("fixture-builder-context-banner")).toHaveTextContent(
      /NEW DRAFT/i,
    );
    expect(screen.getByText(/Modes \(0\)/)).toBeInTheDocument();

    // Add 1st and 2nd modes via Add Mode button -> Mode 2 also includes Pixel Matrix toggle
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-mode-btn"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-mode-btn"));
      await Promise.resolve();
    });
    expect(screen.getByText(/Modes \(2\)/)).toBeInTheDocument();
    expect(screen.getByTestId("mode-ch-toggle-matrix")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Configure Mode 2 to 4 segments (on the 8-pixel default draft) via Mode Segments selector
    await act(async () => {
      fireEvent.change(screen.getByTestId("mode-segment-count-select"), {
        target: { value: "4" },
      });
      await Promise.resolve();
    });
    expect(screen.getByText(/Mode 2 \(18ch\)/)).toBeInTheDocument();
    expect(screen.queryByText("SCHEMA INVALID")).not.toBeInTheDocument();

    // Edit Fixture Name in Visual Builder -> 2nd mode MUST be preserved (not wiped!)
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Fixture Name"), {
        target: { value: "Multi Mode Preserved" },
      });
      await Promise.resolve();
    });
    expect(screen.getByText(/Modes \(2\)/)).toBeInTheDocument();

    // Mode 2 includes Strobe by default; unchecking Hardware Strobe in Visual Builder
    // must prune dangling 'Strobe' ref from Mode 2 and stay SCHEMA VALID
    expect(screen.getByTestId("mode-ch-toggle-Strobe")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Hardware Strobe"));
      await Promise.resolve();
    });
    expect(screen.queryByText("SCHEMA INVALID")).not.toBeInTheDocument();
    expect(screen.getByText(/Modes \(2\)/)).toBeInTheDocument();

    // Switch to Raw JSON Editor, break syntax, click Add Mode -> graceful error message, zero crash
    fireEvent.click(screen.getByRole("button", { name: /Raw JSON Editor/i }));
    fireEvent.change(screen.getByLabelText("Raw OFL JSON Editor"), {
      target: { value: "{ broken json" },
    });
    fireEvent.click(screen.getByTestId("add-mode-btn"));
    expect(screen.getByText(/Cannot add mode/i)).toBeInTheDocument();
  });
});
