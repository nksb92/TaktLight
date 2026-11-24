import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { DEFAULT_STUDIO_LAYOUT, useTaktStore } from "../../store/useTaktStore";

describe("Usage Notes V2 — Full Feature & UX Verification", () => {
  beforeEach(() => {
    if (typeof window.PointerEvent === "undefined") {
      (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
        MouseEvent;
    }
    useTaktStore.getState().resetForTest();
  });

  it("1 & 3: File menu (New/Open/Last/Save/Save As/Close), View > Reset Layout, and dirty-state unsaved guard", async () => {
    render(<App />);

    // Open File menu and verify items
    fireEvent.click(screen.getByTestId("menu-file-btn"));
    expect(screen.getByTestId("menu-file-new")).toBeInTheDocument();
    expect(screen.getByTestId("menu-file-open")).toBeInTheDocument();
    expect(screen.getByTestId("menu-file-open-last")).toBeInTheDocument();
    expect(screen.getByTestId("menu-file-recent-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("menu-file-save")).toBeInTheDocument();
    expect(screen.getByTestId("menu-file-save-as")).toBeInTheDocument();
    expect(screen.getByTestId("menu-file-close")).toBeInTheDocument();

    // Make project dirty by patching a fixture
    await act(async () => {
      await useTaktStore
        .getState()
        .patchFixtures(
          "age/rlcv3_8_segment_tube.json",
          "34ch Pixel Mode",
          "GuardTube",
          1,
          1,
          1,
        );
    });
    expect(useTaktStore.getState().isDirty).toBe(true);

    // Attempt File > New Project -> Unsaved Changes guard must intercept instead of wiping
    fireEvent.click(screen.getByTestId("menu-file-new"));
    expect(screen.getByRole("dialog", { name: "Unsaved Show Changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save & New" })).toBeInTheDocument();
    expect(useTaktStore.getState().showState.patch).toHaveLength(1);

    // Cancel keeps dirty state and patch intact
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Unsaved Show Changes" })).not.toBeInTheDocument();
    expect(useTaktStore.getState().showState.patch).toHaveLength(1);

    // Attempt Open Project while dirty -> Unsaved Changes guard prompts "Save & Open"
    fireEvent.click(screen.getByTestId("topbar-open-project-btn"));
    expect(screen.getByRole("button", { name: "Save & Open" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Attempt File > Close Project while dirty -> Don't Save resets cleanly
    fireEvent.click(screen.getByTestId("menu-file-btn"));
    fireEvent.click(screen.getByTestId("menu-file-close"));
    expect(screen.getByRole("button", { name: "Save & Close" })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Don't Save" }));
      await Promise.resolve();
    });
    expect(useTaktStore.getState().showState.patch).toHaveLength(0);
    expect(useTaktStore.getState().isDirty).toBe(false);
  });

  it("2: Resizable Studio sub-windows persist to localStorage and View > Reset Layout restores defaults", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    const verticalHandle = screen.getByTestId("split-studio-vertical");
    fireEvent.pointerDown(verticalHandle, { clientY: 400, button: 0 });
    fireEvent.pointerMove(window, { clientY: 320 });
    fireEvent.pointerUp(window);

    const movedPct = useTaktStore.getState().studioLayout.bottomDockPct;
    expect(movedPct).toBeGreaterThan(DEFAULT_STUDIO_LAYOUT.bottomDockPct);

    const inspectorHandle = screen.getByTestId("split-scene-inspector");
    fireEvent.pointerDown(inspectorHandle, { clientX: 900, button: 0 });
    fireEvent.pointerMove(window, { clientX: 830 });
    fireEvent.pointerUp(window);
    expect(useTaktStore.getState().studioLayout.inspectorWidthPx).toBeGreaterThan(
      DEFAULT_STUDIO_LAYOUT.inspectorWidthPx,
    );

    // View > Reset Layout restores defaults
    fireEvent.click(screen.getByTestId("menu-view-btn"));
    fireEvent.click(screen.getByTestId("menu-reset-layout-btn"));
    expect(useTaktStore.getState().studioLayout).toEqual(DEFAULT_STUDIO_LAYOUT);
  });

  it("4: Fixture Calibration Inspector renders hover/focus help tooltips", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "CalTube",
        1,
        1,
        1,
      );
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Patch$/i }));

    const gammaHelp = screen.getByTestId("cal-help-gamma");
    fireEvent.focus(gammaHelp);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/Perceptual dimming curve/i);
    fireEvent.blur(gammaHelp);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    const whiteModeHelp = screen.getByTestId("cal-help-white-mode");
    fireEvent.focus(whiteModeHelp);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/RGBW/i);
  });

  it("5: Suppresses generic browser right-click menu on app chrome, allows on text inputs", () => {
    render(<App />);
    const headerBrand = screen.getByText("TAKTLIGHT");
    const nonInputEvt = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    headerBrand.dispatchEvent(nonInputEvt);
    expect(nonInputEvt.defaultPrevented).toBe(true);

    // Switch to Studio so text input (Group Name) is mounted
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));
    const groupInput = screen.getByLabelText("Quick Selection Group Name");
    const inputEvt = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    groupInput.dispatchEvent(inputEvt);
    expect(inputEvt.defaultPrevented).toBe(false);
  });

  it("6: Scene inspector consolidates to a single top Target dropdown without duplicate Beams select", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "TargetTube",
        1,
        1,
        1,
      );
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-curve_fx"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("scene-target-select")).toBeInTheDocument();
    expect(screen.getByTestId("scene-target-beam-count")).toHaveTextContent("8b");
    expect(screen.queryByLabelText("Inspector Target Group")).not.toBeInTheDocument();
  });

  it("7: 2D shader gizmo Fit & Auto-Fit update when fixtures move and pause when manually dragged", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "GizmoTube",
        1,
        1,
        1,
      );
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-color_mappings"));
      await Promise.resolve();
    });

    const getShaderEl = () => {
      const blk = useTaktStore
        .getState()
        .showState.fx_library.find((b) =>
          b.elements.some((el) => el.kind === "spatial_shader_2d"),
        );
      return blk?.elements.find((el) => el.kind === "spatial_shader_2d");
    };

    const before = getShaderEl();
    expect(before?.kind).toBe("spatial_shader_2d");
    const fxId = useTaktStore.getState().showState.patch[0].id;

    // Move fixture via Grid X -> Auto-Fit refits shader center_x
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Grid X"), {
        target: { value: "0.75" },
      });
      await Promise.resolve();
    });
    const afterMove = getShaderEl();
    if (afterMove?.kind === "spatial_shader_2d" && before?.kind === "spatial_shader_2d") {
      expect(afterMove.center_x).not.toBeCloseTo(before.center_x, 2);
    }

    // Toggle Auto-Fit off, move fixture again, then click Fit manually
    fireEvent.click(screen.getByTestId("gizmo-autofit-toggle"));
    expect(useTaktStore.getState().gizmoAutoFit).toBe(false);

    await act(async () => {
      await useTaktStore.getState().updateFixtureGridPos(fxId, {
        x: 0.2,
        y: 0.3,
        rotation: 0,
        scale_x: 0.3,
        scale_y: 0.05,
      });
    });
    const whilePaused = getShaderEl();
    if (whilePaused?.kind === "spatial_shader_2d" && afterMove?.kind === "spatial_shader_2d") {
      expect(whilePaused.center_x).toBeCloseTo(afterMove.center_x, 3);
    }

    await act(async () => {
      fireEvent.click(screen.getByTestId("gizmo-fit-btn"));
      await Promise.resolve();
    });
    const afterFit = getShaderEl();
    if (afterFit?.kind === "spatial_shader_2d") {
      expect(afterFit.center_x).toBeLessThan(0.45);
    }
  });

  it("8, 9, 10, 11: Timeline 2-row toolbar, independent Beats/Kicks/Snares toggles, Kicks popover, and playhead cursor", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    // Create a non-timeline FX scene so Kicks popover has an explicit scene to pick
    await act(async () => {
      const fxSc = await useTaktStore
        .getState()
        .createQuickSceneInBank("Bank 1", "effect");
      await useTaktStore.getState().upsertFxBlock({
        id: `blk_${fxSc.id}`,
        name: "Kick Flash",
        target_group: "all",
        duration_beats: 1,
        loop_block: false,
        elements: [
          {
            kind: "static_trait",
            trait: "dimmer",
            op: "ltp",
            palette_ref: null,
            value_start: 1,
            value_end: 1,
            order: "linear",
          },
        ],
      });
      await useTaktStore
        .getState()
        .upsertScene({ ...fxSc, name: "Kick Flash", block_refs: [`blk_${fxSc.id}`] });
      const tlScene = await useTaktStore
        .getState()
        .createTimelineSceneInBank("Bank 1", "Show TL");
      useTaktStore.getState().selectSceneForEdit(tlScene.id);
    });

    const tlList = useTaktStore.getState().showState.timelines;
    const tlId = tlList[tlList.length - 1].id;
    // Seed kick + snare transients for the timeline
    await act(async () => {
      useTaktStore.getState().setClipAudioAnalysis(
        "demo.wav",
        {
          sha256: "abc",
          duration_sec: 8,
          sample_rate: 44100,
          estimated_bpm: 120,
          grid_offset_sec: 0,
          waveform_peaks: [{ min: -0.5, max: 0.5 }],
          transients: [
            { time_sec: 0.5, band: "kick", strength: 0.9 },
            { time_sec: 1.0, band: "snare", strength: 0.8 },
            { time_sec: 1.5, band: "kick", strength: 0.85 },
          ],
        },
        tlId,
      );
      useTaktStore.getState().setTimelineProjectTransients(true);
      await Promise.resolve();
    });

    expect(screen.getByTestId("timeline-toolbar-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-toolbar-row-2")).toBeInTheDocument();

    // Ruler has cursor-pointer while playhead pill handle has cursor-ew-resize
    const ruler = screen.getByTestId("timeline-ruler");
    const playheadHandle = screen.getByTestId("timeline-playhead-handle");
    expect(ruler.className).toContain("cursor-pointer");
    expect(ruler.className).not.toContain("cursor-ew-resize");
    expect(playheadHandle.className).toContain("cursor-ew-resize");

    // Independent Beats / Kicks / Snares toggles
    expect(screen.getAllByTestId("projected-transient-kick").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("projected-transient-snare").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("beat-grid-bar").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("timeline-toggle-kicks"));
    expect(screen.queryByTestId("projected-transient-kick")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("projected-transient-snare").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("timeline-toggle-snares"));
    expect(screen.queryByTestId("projected-transient-snare")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("timeline-toggle-beats"));
    expect(screen.queryByTestId("beat-grid-bar")).not.toBeInTheDocument();

    // Re-enable kicks and open Kicks popover to pick scene & fill
    fireEvent.click(screen.getByTestId("timeline-toggle-kicks"));
    fireEvent.click(screen.getByTestId("timeline-auto-place-kicks-btn"));
    const popover = screen.getByTestId("timeline-kicks-popover");
    expect(popover).toBeInTheDocument();

    const sceneSelect = screen.getByLabelText("Auto-Fill Scene");
    expect(sceneSelect).toHaveTextContent(/Kick Flash/);
    await act(async () => {
      fireEvent.click(screen.getByTestId("timeline-kicks-confirm-btn"));
      await Promise.resolve();
    });

    const kickTrack = useTaktStore
      .getState()
      .showState.timelines.find((t) => t.id === tlId)
      ?.tracks.find((t) => t.name === "Kick Hits");
    expect(kickTrack).toBeDefined();
    expect(kickTrack?.clips.length).toBe(2);
  });

  it("12 & 13: Clr clears 1/4 pattern selection, and Cells mode selects partial-fixture cells into a group", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "CellTube",
        1,
        1,
        1,
      );
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    // 1/4 selects indices [0, 4]
    fireEvent.click(screen.getByTestId("pattern-filter-1/4"));
    expect(useTaktStore.getState().selectedCellIndices).toEqual([0, 4]);

    // Clr clears BOTH fixture and cell/pattern selections
    fireEvent.click(screen.getByTestId("clear-fixture-selection-btn"));
    expect(useTaktStore.getState().selectedCellIndices).toEqual([]);

    // Pattern rail None clears as well
    fireEvent.click(screen.getByTestId("pattern-filter-1/3"));
    expect(useTaktStore.getState().selectedCellIndices).toEqual([0, 3, 6]);
    fireEvent.click(screen.getByTestId("pattern-filter-none"));
    expect(useTaktStore.getState().selectedCellIndices).toEqual([]);

    // Switch to Cells mode and select partial cells (0, 1, 2)
    fireEvent.click(screen.getByTestId("grid-select-mode-cells"));
    act(() => {
      useTaktStore.getState().setSelectedFixtureIds(["fx_001"]);
      useTaktStore.getState().setSelectedCellIndices([0, 1, 2]);
    });

    expect(screen.getByTestId("selected-cells-group-badge")).toHaveTextContent("3c");
    fireEvent.change(screen.getByLabelText("Quick Selection Group Name"), {
      target: { value: "Left Tip" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-group-from-fixtures-btn"));
      await Promise.resolve();
    });

    const createdGroup = useTaktStore
      .getState()
      .showState.groups.find((g) => g.name === "Left Tip");
    expect(createdGroup).toBeDefined();
    expect(createdGroup?.targets).toEqual(["fx_001:0..2"]);
  });

  it("14: DMX Monitor navigates to Universe 3+ preview and auto-creates U3 when parking a channel", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Monitor$/i }));

    expect(useTaktStore.getState().universes.map((u) => u.id)).toEqual([1, 2]);
    fireEvent.click(screen.getByTestId("monitor-next-universe")); // -> U2
    fireEvent.click(screen.getByTestId("monitor-next-universe")); // -> U3 (preview)

    expect(useTaktStore.getState().selectedUniverseId).toBe(3);
    expect(screen.getByTestId("monitor-preview-universe-badge")).toBeInTheDocument();

    // Select channel 1 and click Park preset 255 -> auto-creates U3 in universes
    fireEvent.click(screen.getByTestId("dmx-cell-1"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "255" }));
      await Promise.resolve();
    });

    expect(useTaktStore.getState().universes.some((u) => u.id === 3)).toBe(true);
    expect(screen.getByTestId("universe-tab-3")).toBeInTheDocument();
    expect(screen.queryByTestId("monitor-preview-universe-badge")).not.toBeInTheDocument();
  });

  it("15: Always creates one free empty track below the lowest used track when adding music or scenes", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    // Create a fresh timeline (starts with Track 1 empty)
    let tlId = "";
    await act(async () => {
      const tlScene = await useTaktStore
        .getState()
        .createTimelineSceneInBank("Bank 1", "AutoTrack TL");
      useTaktStore.getState().selectSceneForEdit(tlScene.id);
      tlId = tlScene.timeline_ref!;
    });

    const getTracks = () =>
      useTaktStore.getState().showState.timelines.find((t) => t.id === tlId)!
        .tracks;

    expect(getTracks()).toHaveLength(1);
    expect(getTracks()[0].name).toBe("Track 1");

    // Drag music onto Track 1 -> creates empty untyped Track 2 below it
    const track1Lane = screen.getByTestId("track-lane-trk_1");
    const audioFile = new File([new Uint8Array([0, 1, 2, 3])], "beat.wav", {
      type: "audio/wav",
    });
    fireEvent.drop(track1Lane, {
      clientX: 100,
      dataTransfer: {
        files: [audioFile],
        getData: () => "",
      },
    });

    await waitFor(() => {
      expect(getTracks()).toHaveLength(2);
    });
    expect(getTracks()[0].track_type).toBe("music");
    expect(getTracks()[0].clips).toHaveLength(1);
    expect(getTracks()[1].name).toBe("Track 2");
    expect(getTracks()[1].track_type).toBe("untyped");
    expect(getTracks()[1].clips).toHaveLength(0);

    // Drag a scene onto Track 2 -> creates empty untyped Track 3 below it
    const track2Lane = screen.getByTestId(`track-lane-${getTracks()[1].id}`);
    fireEvent.drop(track2Lane, {
      clientX: 120,
      dataTransfer: {
        files: [],
        getData: (k: string) =>
          k === "text/takt-scene-id" ? "sc_new_1" : "",
      },
    });

    await waitFor(() => {
      expect(getTracks()).toHaveLength(3);
    });
    expect(getTracks()[1].track_type).toBe("effect");
    expect(getTracks()[1].clips).toHaveLength(1);
    expect(getTracks()[2].name).toBe("Track 3");
    expect(getTracks()[2].track_type).toBe("untyped");
    expect(getTracks()[2].clips).toHaveLength(0);

    // Dropping a second scene onto Track 2 keeps Track 3 as the single free track below (no Track 4)
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Timeline Playhead Sec"), {
        target: { value: "12" },
      });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.drop(screen.getByTestId(`track-lane-${getTracks()[1].id}`), {
        dataTransfer: {
          files: [],
          getData: (k: string) =>
            k === "text/takt-scene-id" ? "sc_new_1" : "",
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getTracks()[1].clips.length).toBeGreaterThanOrEqual(2);
    });
    expect(getTracks()).toHaveLength(3);
  });

  it("16: Snaps clips only to active Beats/Kicks/Snares toggles even without Project Transients enabled", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    await act(async () => {
      const fxSc = await useTaktStore
        .getState()
        .createQuickSceneInBank("Bank 1", "effect");
      await useTaktStore.getState().upsertFxBlock({
        id: `blk_${fxSc.id}`,
        name: "Snare Look",
        target_group: "all",
        duration_beats: 1,
        duration_sec: 0.4,
        loop_block: false,
        elements: [
          {
            kind: "static_trait",
            trait: "dimmer",
            op: "ltp",
            palette_ref: null,
            value_start: 1,
            value_end: 1,
            order: "linear",
          },
        ],
      });
      await useTaktStore
        .getState()
        .upsertScene({ ...fxSc, name: "Snare Flash", block_refs: [`blk_${fxSc.id}`] });
      const tlScene = await useTaktStore
        .getState()
        .createTimelineSceneInBank("Bank 1", "Snap Verify TL");
      useTaktStore.getState().selectSceneForEdit(tlScene.id);
    });

    const tlList = useTaktStore.getState().showState.timelines;
    const tlId = tlList[tlList.length - 1].id;
    await act(async () => {
      useTaktStore.getState().setClipAudioAnalysis(
        "snare_track.wav",
        {
          sha256: "snare_sha",
          duration_sec: 16,
          sample_rate: 44100,
          estimated_bpm: 120,
          grid_offset_sec: 0,
          waveform_peaks: [{ min: -0.5, max: 0.5 }],
          transients: [
            { time_sec: 0.5, band: "kick", strength: 0.9 },
            { time_sec: 1.23, band: "snare", strength: 0.85 },
            { time_sec: 1.5, band: "kick", strength: 0.9 },
            { time_sec: 2.37, band: "snare", strength: 0.85 },
          ],
        },
        tlId,
      );
      // Confirm Project Transients defaults to false (should NOT be required for snapping)
      useTaktStore.getState().setTimelineProjectTransients(false);
      await Promise.resolve();
    });

    // Disable Beats and Kicks -> only Snares remain active
    fireEvent.click(screen.getByTestId("timeline-toggle-beats"));
    fireEvent.click(screen.getByTestId("timeline-toggle-kicks"));

    expect(
      (screen.getByTestId("timeline-snap-grid-select") as HTMLSelectElement).disabled,
    ).toBe(true);

    // Place a scene at 1.16s (close to both 1.0s beat if Beats were on, and 1.23s snare)
    const snareScene = useTaktStore
      .getState()
      .showState.scenes.find((s) => s.name === "Snare Flash")!;
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Timeline Playhead Sec"), {
        target: { value: "1.16" },
      });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.drop(screen.getByTestId("track-lane-trk_1"), {
        dataTransfer: {
          files: [],
          getData: (k: string) =>
            k === "text/takt-scene-id" ? snareScene.id : "",
        },
      });
      await Promise.resolve();
    });

    const getTrk1Clips = () =>
      useTaktStore
        .getState()
        .showState.timelines.find((t) => t.id === tlId)!
        .tracks[0].clips;

    await waitFor(() => {
      expect(getTrk1Clips()).toHaveLength(1);
    });
    // Snapped to 1.23s Snare instead of 1.0s Beat
    expect(getTrk1Clips()[0].start_sec).toBeCloseTo(1.23, 3);

    // Drag the placed clip toward 2.30s -> should snap to 2.37s Snare (not 2.0s or 2.5s beat, nor stuck on 1.23s)
    // Wait: at default 1x zoom (32s viewport / 768px = 24 px/sec), dx = 1.07s * 24px/s ≈ 26px (landing near 2.30s -> within 0.22s threshold of 2.37s)
    const clipBody = screen.getByTestId("clip-body-trk_1-0");
    await act(async () => {
      fireEvent.pointerDown(clipBody, { clientX: 100, button: 0 });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 126 });
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(screen.getByTestId("timeline-active-snap-guide")).toHaveAttribute(
      "data-snap-kind",
      "snare",
    );
    await act(async () => {
      fireEvent.pointerUp(window);
      await Promise.resolve();
    });
    expect(screen.queryByTestId("timeline-active-snap-guide")).not.toBeInTheDocument();
    expect(getTrk1Clips()[0].start_sec).toBeCloseTo(2.37, 3);
  });

  it("17: Kicks auto-fill supports cadence and hit count limits counted forward from playhead", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    await act(async () => {
      const fxSc = await useTaktStore
        .getState()
        .createQuickSceneInBank("Bank 1", "effect");
      await useTaktStore.getState().upsertFxBlock({
        id: `blk_${fxSc.id}`,
        name: "Kick Count Flash",
        target_group: "all",
        duration_beats: 1,
        loop_block: false,
        elements: [
          {
            kind: "static_trait",
            trait: "dimmer",
            op: "ltp",
            palette_ref: null,
            value_start: 1,
            value_end: 1,
            order: "linear",
          },
        ],
      });
      await useTaktStore
        .getState()
        .upsertScene({ ...fxSc, name: "Kick Count Flash", block_refs: [`blk_${fxSc.id}`] });
      const tlScene = await useTaktStore
        .getState()
        .createTimelineSceneInBank("Bank 1", "Kicks Count TL");
      useTaktStore.getState().selectSceneForEdit(tlScene.id);
    });

    const tlList = useTaktStore.getState().showState.timelines;
    const tlId = tlList[tlList.length - 1].id;
    await act(async () => {
      useTaktStore.getState().setClipAudioAnalysis(
        "eight_kicks.wav",
        {
          sha256: "kicks_8",
          duration_sec: 8,
          sample_rate: 44100,
          estimated_bpm: 120,
          grid_offset_sec: 0,
          waveform_peaks: [{ min: -0.5, max: 0.5 }],
          transients: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0].map((time_sec) => ({
            time_sec,
            band: "kick" as const,
            strength: 0.9,
          })),
        },
        tlId,
      );
      await Promise.resolve();
    });

    const getKickTrack = () =>
      useTaktStore
        .getState()
        .showState.timelines.find((t) => t.id === tlId)
        ?.tracks.find((t) => t.name === "Kick Hits");

    // Move playhead to 1.5s, choose Every 2nd + Custom count 2 -> places 1.5s and 2.5s
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Timeline Playhead Sec"), {
        target: { value: "1.5" },
      });
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTestId("timeline-auto-place-kicks-btn"));
    const cadenceSelect = screen.getByTestId("timeline-kicks-cadence-select");
    expect(cadenceSelect).toHaveTextContent("Every Hit");
    expect(cadenceSelect).toHaveTextContent("Every 2nd (1 of 2)");
    expect(cadenceSelect).toHaveTextContent("Every 4th (1 of 4)");
    fireEvent.change(cadenceSelect, {
      target: { value: "2" },
    });
    expect(screen.getByTestId("timeline-kicks-offset-select")).toHaveTextContent(
      "2nd of 2",
    );
    fireEvent.change(screen.getByTestId("timeline-kicks-count-select"), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByTestId("timeline-kicks-custom-count-input"), {
      target: { value: "2" },
    });

    expect(screen.getByTestId("timeline-kicks-confirm-btn")).toHaveTextContent(
      "Fill 2 Hits",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("timeline-kicks-confirm-btn"));
      await Promise.resolve();
    });

    expect(getKickTrack()?.clips.map((c) => c.start_sec)).toEqual([1.5, 2.5]);

    // Move playhead to 3.5s, choose Every 1st + 4 hits -> merges 3.5s and 4.0s while preserving 1.5s and 2.5s
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Timeline Playhead Sec"), {
        target: { value: "3.5" },
      });
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTestId("timeline-auto-place-kicks-btn"));
    fireEvent.change(screen.getByTestId("timeline-kicks-cadence-select"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByTestId("timeline-kicks-count-select"), {
      target: { value: "4" },
    });

    expect(screen.getByTestId("timeline-kicks-confirm-btn")).toHaveTextContent(
      "Fill 2 Hits",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("timeline-kicks-confirm-btn"));
      await Promise.resolve();
    });

    expect(getKickTrack()?.clips.map((c) => c.start_sec)).toEqual([
      1.5, 2.5, 3.5, 4.0,
    ]);
  });
});
