import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SceneAndFxManager } from "../SceneAndFxManager";
import { useTaktStore } from "../../store/useTaktStore";
import { seedTestFixturesInStore } from "../../test/testFixtures";

async function seedSceneFxState() {
  const s = useTaktStore.getState();
  useTaktStore.setState({
    showState: {
      ...s.showState,
      bpm: 120,
      fx_library: [
        {
          id: "blk_color_1",
          name: "Color Wave",
          target_group: "all",
          duration_beats: 4,
          duration_sec: null,
          loop_block: true,
          elements: [
            {
              kind: "curve_1d",
              trait: "color",
              op: "ltp",
              waveform: "sine",
              amplitude: 1,
              offset: 0,
              rate_cycles: 1,
              rate_beats: null,
              speed_hz: null,
              phase_deg: 0,
              phase_spread_deg: 90,
              duty: 0.5,
              palette_ref: null,
              inline_colors: ["#FF0000", "#0000FF"],
              color_width: 1,
              gradient: 1,
              grayscale: false,
              order: "linear",
            },
          ],
        },
        {
          id: "blk_seq_1",
          name: "Step Seq",
          target_group: "all",
          duration_beats: 4,
          duration_sec: null,
          loop_block: true,
          elements: [
            {
              kind: "scene_sequence",
              playback_mode: "loop",
              steps: [
                {
                  scene_id: "scn_1",
                  duration_value: 2,
                  duration_unit: "beats",
                  fade_sec: 0.2,
                },
                {
                  scene_id: "scn_2",
                  duration_value: 4,
                  duration_unit: "beats",
                  fade_sec: 0,
                },
              ],
            },
          ],
        },
      ],
      scenes: [
        {
          id: "scn_1",
          name: "Scene One",
          bank: "Bank 1",
          priority: 2,
          fade_in_sec: 0,
          fade_out_sec: 0,
          block_refs: ["blk_color_1"],
          timeline_ref: null,
          duration_value: 4,
          duration_unit: "beats",
          target_group: null,
        },
        {
          id: "scn_2",
          name: "Scene Two",
          bank: "Bank 1",
          priority: 2,
          fade_in_sec: 0,
          fade_out_sec: 0,
          block_refs: ["blk_seq_1"],
          timeline_ref: null,
          duration_value: 4,
          duration_unit: "beats",
          target_group: null,
        },
        {
          id: "scn_tl",
          name: "Timeline Scene",
          bank: "Bank 1",
          priority: 2,
          fade_in_sec: 0,
          fade_out_sec: 0,
          block_refs: [],
          timeline_ref: "tl_scene_1",
          duration_value: 8,
          duration_unit: "beats",
          target_group: null,
        },
      ],
      timelines: [
        {
          id: "tl_scene_1",
          name: "Timeline 1",
          duration_sec: 8,
          grid_offset_sec: 0,
          loop_timeline: true,
          tempo_map: [{ at_sec: 0, bpm: 120 }],
          audio_track: null,
          tracks: [
            {
              id: "trk_1",
              name: "Track 1",
              track_type: "effect",
              target_group: "all",
              clips: [
                {
                  ref_block: "blk_color_1",
                  start_sec: 0,
                  duration_sec: 6,
                  fade_in_sec: 0,
                  fade_out_sec: 0,
                  inline_fx: [],
                },
              ],
            },
          ],
        },
      ],
    },
    sceneBanks: ["Bank 1"],
    stackableBanks: {},
    selectedSceneId: "scn_1",
    multiSelectedSceneIds: ["scn_1", "scn_2"],
    canUndo: true,
    canRedo: true,
  });
  seedTestFixturesInStore();
  await useTaktStore.getState().loadFixtures();
  const prof = useTaktStore.getState().fixtureSummaries[0];
  if (prof && useTaktStore.getState().showState.patch.length === 0) {
    await useTaktStore.getState().patchFixtures(
      prof.id,
      prof.modes[0].name,
      "Tube",
      1,
      1,
      1,
    );
  }
}

describe("Batch 4 Coverage — SceneAndFxManager", () => {
  beforeEach(async () => {
    await seedSceneFxState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("covers standalone header, bank CRUD & drag-reorder, batch edit toolbar, context menus, and cell preview", async () => {
    render(<SceneAndFxManager daslightUpper={false} hideUndoRedo={false} />);

    // Standalone header controls: Live BPM, Tap Tempo, Release All Scenes, Undo, Redo
    fireEvent.change(screen.getByLabelText("Live BPM"), { target: { value: "128" } });
    fireEvent.click(screen.getByRole("button", { name: "Tap Tempo" }));
    fireEvent.click(screen.getByRole("button", { name: "Release All Scenes" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));

    // Standalone live cell preview rendered
    expect(screen.getByTestId("scene-live-cell-preview")).toBeInTheDocument();

    // Multi-select batch edit toolbar
    expect(screen.getByTestId("batch-scene-toolbar")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Batch Fade In"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("Batch Fade Out"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("Batch Priority"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("apply-batch-scene-btn"));

    // Create Bank 2
    fireEvent.click(screen.getByTestId("open-add-bank-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("bank-tab-Bank 2")).toBeInTheDocument();
    });

    // Filter bank tabs
    fireEvent.click(screen.getByTestId("bank-tab-Bank 1"));
    fireEvent.click(screen.getByRole("button", { name: /All \(2\)/i }));

    // Drag-and-drop reorder via bank tabs
    const makeBankDt = (b: string) => ({
      types: ["application/x-taktlight-bank"],
      effectAllowed: "move",
      dropEffect: "move",
      setData: vi.fn(),
      getData: () => b,
    });
    const tab1 = screen.getByTestId("bank-tab-Bank 1");
    const tab2 = screen.getByTestId("bank-tab-Bank 2");
    fireEvent.dragStart(tab1, { dataTransfer: makeBankDt("Bank 1") });
    fireEvent.dragOver(tab2, { dataTransfer: makeBankDt("Bank 1") });
    fireEvent.dragLeave(tab2);
    fireEvent.dragOver(tab2, { dataTransfer: makeBankDt("Bank 1") });
    fireEvent.drop(tab2, { dataTransfer: makeBankDt("Bank 1") });
    fireEvent.dragEnd(tab1);

    // Drag-and-drop reorder via bank header -> bank column
    const hdr2 = screen.getByTestId("bank-header-Bank 2");
    const col1 = screen.getByTestId("bank-column-Bank 1");
    fireEvent.dragStart(hdr2, { dataTransfer: makeBankDt("Bank 2") });
    fireEvent.dragOver(col1, { dataTransfer: makeBankDt("Bank 2") });
    fireEvent.dragLeave(col1);
    fireEvent.dragOver(col1, { dataTransfer: makeBankDt("Bank 2") });
    fireEvent.drop(col1, { dataTransfer: makeBankDt("Bank 2") });
    fireEvent.dragEnd(hdr2);

    // Double-click inline rename Bank 2 -> Escape -> double-click -> Enter
    fireEvent.doubleClick(screen.getByTestId("bank-name-Bank 2"));
    const renameInput = screen.getByLabelText("Rename bank Bank 2");
    fireEvent.change(renameInput, { target: { value: "Chorus" } });
    fireEvent.keyDown(renameInput, { key: "Escape" });

    fireEvent.doubleClick(screen.getByTestId("bank-name-Bank 2"));
    const renameInput2 = screen.getByLabelText("Rename bank Bank 2");
    fireEvent.change(renameInput2, { target: { value: "Chorus" } });
    fireEvent.keyDown(renameInput2, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("bank-header-Chorus")).toBeInTheDocument();
    });

    // Bank context menu: Stackable ON, Rename Bank, Delete Bank
    fireEvent.contextMenu(screen.getByTestId("bank-header-Chorus"), { clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByTestId("bank-ctx-stackable-Chorus"));
    expect(screen.getByTestId("bank-stack-badge-Chorus")).toBeInTheDocument();

    fireEvent.contextMenu(screen.getByTestId("bank-header-Chorus"), { clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByRole("button", { name: "Rename Bank" }));
    fireEvent.blur(screen.getByLabelText("Rename bank Chorus"));

    fireEvent.contextMenu(screen.getByTestId("bank-header-Chorus"), { clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByTestId("delete-bank-Chorus"));

    // Scene context menu: Rename, Momentary Flash, Duplicate, Delete
    const sceneTile = screen.getByTestId("scene-tile-scn_1");
    fireEvent.contextMenu(sceneTile, { clientX: 60, clientY: 60 });
    fireEvent.click(screen.getByRole("button", { name: "Rename Scene" }));

    fireEvent.contextMenu(sceneTile, { clientX: 60, clientY: 60 });
    fireEvent.click(screen.getByRole("button", { name: /Momentary Flash/i }));

    fireEvent.contextMenu(sceneTile, { clientX: 60, clientY: 60 });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Scene" }));

    fireEvent.contextMenu(screen.getByTestId("scene-tile-scn_2"), { clientX: 60, clientY: 60 });
    fireEvent.click(screen.getByRole("button", { name: "Delete Scene" }));
  });

  it("covers Inspector Rail tabs (FX stack, Color stops, Sequence steps, Properties, Settings) and legacy bridge", async () => {
    render(<SceneAndFxManager daslightUpper={true} />);

    // 1. FX Rack tab: Color preset, color stop edit/add/remove, grayscale, transform, palette builder modal
    if (screen.queryByTestId("fx-picker-tile-color_fx")) {
      fireEvent.click(screen.getByTestId("fx-picker-tile-color_fx"));
    }
    const presetSel = await screen.findByLabelText("Color Preset");
    const opts = presetSel.querySelectorAll("option");
    if (opts.length > 0) {
      fireEvent.change(presetSel, { target: { value: opts[0].value } });
    }
    fireEvent.change(screen.getByLabelText("Color Stop 1"), { target: { value: "#00FF00" } });
    fireEvent.click(screen.getByTestId("add-color-stop-btn"));
    fireEvent.click(screen.getByLabelText("Remove Color Stop 1"));
    fireEvent.click(screen.getByLabelText("Grayscale"));
    fireEvent.change(screen.getByLabelText("Color FX Transform"), { target: { value: "reverse" } });

    // Palette builder modal save callback
    fireEvent.click(screen.getByTestId("open-palette-builder-fx-btn"));
    expect(screen.getByTestId("color-palette-builder-modal")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("palette-builder-save-btn"));
    await waitFor(() => {
      expect(screen.queryByTestId("color-palette-builder-modal")).not.toBeInTheDocument();
    });

    // Add second FX layer to stack (+ -> Cancel -> + -> pick curve_fx -> move up/down -> remove)
    fireEvent.click(screen.getByTitle("Add FX Layer to Scene"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByTitle("Add FX Layer to Scene"));
    fireEvent.click(screen.getByTestId("fx-picker-tile-curve_fx"));
    await waitFor(() => {
      expect(screen.getByTestId("fx-stack-tab-1")).toBeInTheDocument();
    });

    // Change FX Target Channel on curve_fx
    const traitSel = screen.getByTestId("fx-target-trait-select");
    fireEvent.change(traitSel, { target: { value: "dimmer" } });

    // Move FX Up / Down & Remove Active FX Layer
    fireEvent.click(screen.getByTitle("Move FX Up"));
    fireEvent.click(screen.getByTitle("Move FX Down"));
    fireEvent.click(screen.getByTitle("Remove Active FX Layer"));

    // Remove remaining FX via X button -> back to picker -> click TIMELINE tile
    fireEvent.click(screen.getByTestId("toggle-fx-picker-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("fx-picker-tile-timeline")).toBeInTheDocument();
    });

    // 2. Select Scene Two (sequence steps): edit duration, toggle unit beats <-> sec, edit fade
    fireEvent.click(screen.getByText("Scene Two"));
    if (screen.queryByTestId("fx-stack-tab-0")) {
      fireEvent.click(screen.getByTestId("fx-stack-tab-0"));
    }
    await waitFor(() => {
      expect(screen.getByTestId("seq-step-duration-0")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("seq-step-duration-0"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("seq-step-unit-0")); // beats -> sec
    fireEvent.change(screen.getByTestId("seq-step-duration-0"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByTestId("seq-step-unit-0")); // sec -> beats
    fireEvent.change(screen.getByTestId("seq-step-fade-0"), { target: { value: "0.4" } });

    // 3. Switch to Inspector Rail: Scene Properties tab
    fireEvent.click(screen.getByTitle("Scene Properties"));
    fireEvent.change(screen.getByLabelText("Inspector Scene Name"), {
      target: { value: "Renamed Seq" },
    });
    fireEvent.change(screen.getByLabelText("Inspector Scene Bank"), {
      target: { value: "Bank 1" },
    });
    fireEvent.change(screen.getByLabelText("Inspector Fade Sec"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByTestId("scene-duration-input"), {
      target: { value: "8" },
    });
    fireEvent.click(screen.getByTestId("scene-duration-unit-seconds"));
    fireEvent.click(screen.getByTestId("scene-duration-unit-beats"));
    fireEvent.click(screen.getByTestId("scene-duration-reset"));
    fireEvent.click(screen.getByTestId("toggle-flash-scn_2"));

    // Select Timeline scene on Properties tab to cover Dynamic duration readout
    useTaktStore.setState({ selectedSceneId: "scn_tl" });
    await waitFor(() => {
      expect(screen.getByTestId("timeline-dynamic-duration-readout")).toBeInTheDocument();
    });

    // 4. Switch to Inspector Rail: Scene Settings & Triggers tab
    fireEvent.click(screen.getByTitle("Scene Settings & Triggers"));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    // Switch back to FX Rack tab & exercise sr-only bridge (Save FX Block, Save Scene)
    fireEvent.click(screen.getByTitle("FX Rack"));
    fireEvent.change(screen.getByLabelText("FX Block Name"), { target: { value: "Bridge FX" } });
    fireEvent.change(screen.getByLabelText("FX Block Duration Beats"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("FX Generator Kind"), { target: { value: "step_chase" } });
    fireEvent.change(screen.getByLabelText("FX Merge Op"), { target: { value: "htp" } });
    fireEvent.click(screen.getByRole("button", { name: "Save FX Block" }));

    fireEvent.change(screen.getByLabelText("Scene Name"), { target: { value: "Bridge Scene" } });
    fireEvent.change(screen.getByLabelText("Scene Bank"), { target: { value: "Bridge Bank" } });
    fireEvent.change(screen.getByLabelText("Scene Priority"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Scene Fade In"), { target: { value: "0.2" } });
    fireEvent.change(screen.getByLabelText("Scene Fade Out"), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Scene" }));

    // Trigger convertSceneToTimeline via fx-picker-tile-timeline
    useTaktStore.setState({ selectedSceneId: "scn_1" });
    const tlTile = screen.queryByTestId("fx-picker-tile-timeline");
    if (tlTile) {
      fireEvent.click(tlTile);
    }
  });

  it("covers all 6 FX submenu controls, sequence step reorder/add/drop/remove, and scene target/transport", async () => {
    // Add a second scene sharing blk_color_1 so Make Unique button appears, plus a group
    await useTaktStore.getState().upsertGroup({
      id: "grp_1",
      name: "Stage",
      order: "linear",
      targets: [useTaktStore.getState().showState.patch[0]?.id ?? "fx_001"],
    });
    render(<SceneAndFxManager daslightUpper={true} />);

    // Scene Target selector & Play/Stop Selected Scene button
    fireEvent.change(screen.getByTestId("scene-target-select"), { target: { value: "grp_1" } });
    fireEvent.change(screen.getByTestId("scene-target-select"), { target: { value: "all" } });
    fireEvent.click(screen.getByTitle("Play Selected Scene"));
    await waitFor(() => {
      expect(screen.getByTitle("Stop Selected Scene")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTitle("Stop Selected Scene"));

    // Helper: pick an FX tile cleanly
    const pickFx = async (tileId: string) => {
      if (screen.queryByTestId("toggle-fx-picker-btn")) {
        fireEvent.click(screen.getByTestId("toggle-fx-picker-btn"));
      }
      const tile = await screen.findByTestId(`fx-picker-tile-${tileId}`);
      fireEvent.click(tile);
      await waitFor(() => {
        expect(screen.getByTestId(`fx-submenu-header-${tileId}`)).toBeInTheDocument();
      });
    };

    // 1. COLOR MAPPINGS sliders: Rotation, Color Width, Pattern Scale, Gradient, Rate, Phase Offset, Target Group
    await pickFx("color_mappings");
    fireEvent.change(screen.getByLabelText("Mapping Rotation"), { target: { value: "90" } });
    fireEvent.change(screen.getByLabelText("Color Width"), { target: { value: "1.5" } });
    fireEvent.change(screen.getByLabelText("Pattern Scale Slider"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Gradient"), { target: { value: "70" } });
    fireEvent.change(screen.getByLabelText("FX Rate Cycles"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Spatial Phase Offset"), { target: { value: "25" } });
    fireEvent.change(screen.getByTestId("scene-target-select"), { target: { value: "grp_1" } });

    // 2. CHASER FX sliders: Fading + Step Softness Pct, Rate, Target Group
    await pickFx("chaser_fx");
    fireEvent.click(screen.getByLabelText("Chaser Fading"));
    fireEvent.change(screen.getByLabelText("Step Softness Pct"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("FX Rate Cycles"), { target: { value: "2" } });
    fireEvent.change(screen.getByTestId("scene-target-select"), { target: { value: "all" } });

    // 3. VALUE FX sliders: Add/Select/Edit/Remove Value Stop, Order, Rate, Phase, Gradient, Target Group
    await pickFx("value_fx");
    fireEvent.click(screen.getByTestId("add-value-stop-btn"));
    fireEvent.change(screen.getByLabelText("Value Stop Level"), { target: { value: "60" } });
    const valRemoveBtns = screen.queryAllByLabelText(/Remove Value Stop/i);
    if (valRemoveBtns.length > 0) fireEvent.click(valRemoveBtns[0]);
    fireEvent.change(screen.getByLabelText("Effect Run Order"), { target: { value: "mirror" } });
    fireEvent.change(screen.getByLabelText("FX Rate Cycles"), { target: { value: "1.5" } });
    fireEvent.change(screen.getByLabelText("FX Phase"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("Gradient"), { target: { value: "80" } });
    fireEvent.change(screen.getByTestId("scene-target-select"), { target: { value: "grp_1" } });

    // 4. CURVE FX sliders: Rate, Size (Output Max), Phase, Offset (Output Min), Attribute Value Mode, Order, Target Group
    await pickFx("curve_fx");
    fireEvent.change(screen.getByLabelText("FX Rate Cycles"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Curve Output Max Pct"), { target: { value: "80" } });
    fireEvent.change(screen.getByLabelText("Curve Phase"), { target: { value: "90" } });
    fireEvent.change(screen.getByLabelText("Curve Output Min Pct"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Attribute Value Mode"), { target: { value: "htp" } });
    fireEvent.change(screen.getByLabelText("Effect Run Order"), { target: { value: "center_out" } });
    fireEvent.change(screen.getByTestId("scene-target-select"), { target: { value: "all" } });

    // 5. MAPPINGS (2D dimmer) sliders: Add/Edit/Remove Value Stop, Rotation, Width, Scale, Gradient, Static toggle, Rate, Phase Offset, Target Group
    await pickFx("mappings");
    fireEvent.click(screen.getByTestId("add-value-stop-btn"));
    fireEvent.change(screen.getByLabelText("Value Stop Level"), { target: { value: "75" } });
    const mapRemoveBtns = screen.queryAllByLabelText(/Remove Value Stop/i);
    if (mapRemoveBtns.length > 0) fireEvent.click(mapRemoveBtns[0]);
    fireEvent.change(screen.getByLabelText("Mapping Rotation"), { target: { value: "135" } });
    fireEvent.change(screen.getByLabelText("Color Width"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Pattern Scale Slider"), { target: { value: "1.5" } });
    fireEvent.change(screen.getByLabelText("Gradient"), { target: { value: "60" } });
    fireEvent.click(screen.getByTestId("spatial-static-toggle"));
    fireEvent.click(screen.getByTestId("spatial-static-toggle"));
    fireEvent.change(screen.getByLabelText("FX Rate Cycles"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Spatial Phase Offset"), { target: { value: "50" } });
    fireEvent.change(screen.getByTestId("scene-target-select"), { target: { value: "grp_1" } });

    // 6. SCENE SEQUENCE: playback mode, dropzone drop, add scene dropdown + button, step up/down/remove
    fireEvent.click(screen.getByText("Scene Two"));
    await waitFor(() => {
      expect(screen.getByTestId("scene-sequence-editor")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("seq-playback-mode-select"), {
      target: { value: "bounce" },
    });
    const dz = screen.getByTestId("scene-sequence-dropzone");
    fireEvent.dragOver(dz);
    fireEvent.drop(dz, {
      dataTransfer: { getData: (k: string) => (k === "text/takt-scene" ? "scn_1" : "") },
    });
    fireEvent.change(screen.getByTestId("seq-add-scene-select"), {
      target: { value: "scn_1" },
    });
    fireEvent.click(screen.getByTestId("seq-add-scene-btn"));
    fireEvent.click(screen.getByTestId("seq-step-down-0"));
    fireEvent.click(screen.getByTestId("seq-step-up-1"));
    fireEvent.click(screen.getByTestId("seq-step-remove-0"));
  });

  it("recolors banks via context menu, applies color scheme to scenes inside, preserves color on rename, and resets", async () => {
    render(<SceneAndFxManager daslightUpper={true} />);

    // Open bank context menu via menu button on Bank 1
    fireEvent.click(screen.getByTestId("bank-menu-btn-Bank 1"));
    expect(screen.getByTestId("bank-context-menu-Bank 1")).toBeInTheDocument();

    // Select Blue preset swatch (#3B82F6)
    fireEvent.click(screen.getByTestId("bank-color-swatch-Bank 1-#3B82F6"));
    expect(useTaktStore.getState().bankColors["Bank 1"]).toBe("#3B82F6");

    // Bank column, header dot, and scene tiles inside Bank 1 follow the color scheme
    const bankCol = screen.getByTestId("bank-column-Bank 1");
    expect(bankCol.style.borderTopColor).toBe("rgb(59, 130, 246)");
    expect(screen.getByTestId("bank-color-dot-Bank 1")).toBeInTheDocument();

    const sceneTile = screen.getByTestId("scene-tile-scn_1");
    expect(sceneTile.style.borderColor).toBe("rgb(59, 130, 246)");

    // Renaming Bank 1 preserves its color
    await useTaktStore.getState().renameSceneBank("Bank 1", "Stage Left");
    expect(useTaktStore.getState().bankColors["Stage Left"]).toBe("#3B82F6");
    expect(useTaktStore.getState().bankColors["Bank 1"]).toBeUndefined();

    // Custom color picker and reset on renamed bank
    fireEvent.contextMenu(screen.getByTestId("bank-tab-Stage Left"));
    fireEvent.change(screen.getByTestId("bank-color-picker-Stage Left"), {
      target: { value: "#22c55e" },
    });
    expect(useTaktStore.getState().bankColors["Stage Left"]).toBe("#22c55e");

    fireEvent.click(screen.getByTestId("bank-color-reset-Stage Left"));
    expect(useTaktStore.getState().bankColors["Stage Left"]).toBeUndefined();
    expect(screen.queryByTestId("bank-color-dot-Stage Left")).not.toBeInTheDocument();
  });

  it("drags a scene across banks and moves it into the target bank", async () => {
    useTaktStore.getState().createSceneBank("Bank 2");
    render(<SceneAndFxManager daslightUpper={true} />);

    const sceneTile = screen.getByTestId("scene-tile-scn_1");
    const targetBankCol = screen.getByTestId("bank-column-Bank 2");

    const origElementsFromPoint = document.elementsFromPoint;
    document.elementsFromPoint = () => [targetBankCol];
    try {
      fireEvent(
        sceneTile,
        new MouseEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 10,
          clientY: 10,
        }),
      );
      fireEvent(
        window,
        new MouseEvent("pointermove", {
          bubbles: true,
          clientX: 80,
          clientY: 80,
        }),
      );
      fireEvent(
        window,
        new MouseEvent("pointerup", {
          bubbles: true,
          clientX: 80,
          clientY: 80,
        }),
      );
    } finally {
      document.elementsFromPoint = origElementsFromPoint;
    }

    await waitFor(() => {
      const moved = useTaktStore
        .getState()
        .showState.scenes.find((s) => s.id === "scn_1");
      expect(moved?.bank).toBe("Bank 2");
    });
    expect(targetBankCol).toContainElement(
      screen.getByTestId("scene-tile-scn_1"),
    );
  });
});
