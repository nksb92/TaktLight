import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FixtureGrid2D } from "../FixtureGrid2D";
import { PalettesAndControls } from "../PalettesAndControls";
import { useTaktStore } from "../../store/useTaktStore";
import { createTestBridge } from "../../lib/testBridge";

function ptr(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointerleave",
  opts: MouseEventInit = {},
) {
  fireEvent(target, new MouseEvent(type, { bubbles: true, button: 0, ...opts }));
}

async function setupStudioFixtures() {
  const s = useTaktStore.getState();
  useTaktStore.setState({
    showState: {
      ...s.showState,
      patch: [],
      groups: [],
      fx_library: [],
      scenes: [
        {
          id: "scn_1",
          name: "Scene One",
          bank: "Bank 1",
          priority: 2,
          fade_in_sec: 0,
          fade_out_sec: 0,
          block_refs: [],
          timeline_ref: null,
          duration_value: 4,
          duration_unit: "beats",
          target_group: null,
        },
      ],
    },
    selectedSceneId: "scn_1",
    selectedFixtureInstanceId: null,
    selectedFixtureIds: [],
    selectedCellIndices: [],
    activeGroupFilterId: "all",
    activeShaderGizmoBlockId: null,
    liveLayers: [],
  });
  await useTaktStore.getState().loadFixtures();
  const summaries = useTaktStore.getState().fixtureSummaries;
  const tube = summaries[0]!;
  await useTaktStore.getState().patchFixtures(
    tube.id,
    tube.modes[0].name,
    "Tube",
    2,
    1,
    1,
  );
  // Position two fixtures nicely on canvas
  const patched = useTaktStore.getState().showState.patch;
  if (patched[0]) {
    await useTaktStore.getState().updateFixtureGridPos(
      patched[0].id,
      { x: 0.3, y: 0.4, rotation: 0, scale_x: 0.25, scale_y: 0.05 },
      "init_0",
    );
  }
  if (patched[1]) {
    await useTaktStore.getState().updateFixtureGridPos(
      patched[1].id,
      { x: 0.7, y: 0.6, rotation: 45, scale_x: 0.25, scale_y: 0.05 },
      "init_1",
    );
  }
}

describe("Batch 3 Coverage — FixtureGrid2D", () => {
  beforeEach(async () => {
    await setupStudioFixtures();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("covers canvas rendering, shader gizmo drags, pan, marquee, move, rotate, zoom, patterns, and selections", async () => {
    const fx0 = useTaktStore.getState().showState.patch[0]!;
    const fx1 = useTaktStore.getState().showState.patch[1]!;

    // Add a group and a 2D spatial shader block linked to scn_1
    await useTaktStore.getState().upsertGroup({
      id: "grp_front",
      name: "Front",
      order: "linear",
      targets: [`${fx0.id}:0..3`],
    });
    await useTaktStore.getState().upsertFxBlock({
      id: "blk_shader_2d",
      name: "2D Plasma",
      target_group: "grp_front",
      duration_beats: 4,
      duration_sec: null,
      loop_block: true,
      elements: [
        {
          kind: "spatial_shader_2d",
          trait: "color",
          shader: "linear_sweep",
          op: "ltp",
          palette_ref: null,
          inline_colors: ["#FF0000", "#0000FF"],
          direction_deg: 45,
          center_x: 0.5,
          center_y: 0.5,
          spatial_freq: 1.0,
          speed_hz: 0.5,
          rate_beats: null,
          rate_cycles: 1,
          phase_offset: 0,
          color_width: 1,
          gradient: 1,
          grayscale: false,
          transform: "",
        },
      ],
    });
    const curScene = useTaktStore.getState().showState.scenes[0]!;
    await useTaktStore.getState().upsertScene({
      ...curScene,
      block_refs: ["blk_shader_2d"],
      target_group: "grp_front",
    });

    // Populate live cell preview RGBD values (some bright, some dark)
    const nCells = useTaktStore.getState().compiledCells.length;
    const rgbd = new Uint8Array(nCells * 4);
    for (let i = 0; i < nCells; i++) {
      rgbd[i * 4] = i % 2 === 0 ? 255 : 0;
      rgbd[i * 4 + 1] = i % 2 === 0 ? 220 : 0;
      rgbd[i * 4 + 2] = i % 2 === 0 ? 180 : 0;
      rgbd[i * 4 + 3] = 255;
    }
    useTaktStore.setState({
      cellPreviewRgbd: rgbd,
      activeGroupFilterId: "grp_front",
      selectedFixtureInstanceId: fx0.id,
      selectedFixtureIds: [fx0.id],
      canUndo: true,
      canRedo: true,
    });

    render(<FixtureGrid2D hideUndoRedo={false} />);

    const canvas = screen.getByTestId("fixture-grid-canvas") as HTMLCanvasElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 840,
      height: 480,
      right: 840,
      bottom: 480,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    // Helper: normalized canvas coords -> client coords at zoom=1, pan=0, VIEW_FIT=0.84 (isotropic unit = 480 * 0.84)
    const toClient = (nx: number, ny: number) => ({
      clientX: 420 + (nx - 0.5) * 480 * 0.84,
      clientY: 240 + (ny - 0.5) * 480 * 0.84,
    });

    // Exercise registerCanvasGeometry test bridge callback
    const bridge = createTestBridge();
    const geom = bridge.getCanvasGeometry();
    expect(geom?.fixtures.length).toBe(2);
    expect(geom?.shaderGizmo?.active).toBe(true);

    // 1. Shader gizmo drags (auto-activated by activeShaderBlock):
    // Center handle at (0.5, 0.5)
    const cPt = toClient(0.5, 0.5);
    ptr(canvas, "pointerdown", cPt);
    ptr(canvas, "pointermove", toClient(0.55, 0.52));
    ptr(canvas, "pointerup");

    // Angle handle near (0.55 + cos(45)*42/840, 0.52 + sin(45)*42/480)
    const angRad = (45 * Math.PI) / 180;
    const unitCanvas = 480 * 0.84;
    const aPt = toClient(
      0.55 + (Math.cos(angRad) * 42) / unitCanvas,
      0.52 + (Math.sin(angRad) * 42) / unitCanvas,
    );
    ptr(canvas, "pointerdown", aPt);
    ptr(canvas, "pointermove", toClient(0.7, 0.52)); // snaps near 0 deg
    ptr(canvas, "pointerup");

    // Scale handle near (centerX + 0.2, centerY + 0.2)
    const sPt = toClient(0.75, 0.72);
    ptr(canvas, "pointerdown", sPt);
    ptr(canvas, "pointermove", toClient(0.85, 0.82));
    ptr(canvas, "pointerup");

    // Toggle shader gizmo OFF so fixture clicks aren't intercepted
    fireEvent.click(screen.getByTestId("toggle-2d-shader-gizmo"));

    // 2. Pan via Alt+drag
    ptr(canvas, "pointerdown", { altKey: true, clientX: 400, clientY: 240 });
    ptr(canvas, "pointermove", { clientX: 440, clientY: 260 });
    ptr(canvas, "pointerup");

    // Reset zoom & pan
    fireEvent.click(screen.getByTestId("grid-zoom-in"));
    fireEvent.click(screen.getByTestId("grid-zoom-out"));
    fireEvent.wheel(canvas, { deltaY: -100, ctrlKey: true });
    fireEvent.wheel(canvas, { deltaY: 100, ctrlKey: true });
    fireEvent.click(screen.getByTestId("grid-zoom-reset"));

    // 3. Fixture move drag (with snap ON at 10% preset and then snap OFF)
    fireEvent.change(screen.getByTestId("grid-snap-step-select"), {
      target: { value: "0.1" },
    });
    const fx0Pt = toClient(0.3, 0.4);
    ptr(canvas, "pointerdown", fx0Pt);
    ptr(canvas, "pointermove", toClient(0.37, 0.48));
    ptr(canvas, "pointerup");
    const snappedFx0 = useTaktStore.getState().showState.patch.find((f) => f.id === fx0.id)!;
    expect(snappedFx0.grid_pos.x).toBeCloseTo(0.4, 2);
    expect(snappedFx0.grid_pos.y).toBeCloseTo(0.5, 2);

    // Toggle snap OFF and drag rotation handle of fx0 (at x + 0.115, y)
    fireEvent.click(screen.getByTestId("toggle-2d-snap-grid"));
    const curFx0 = useTaktStore.getState().showState.patch.find((f) => f.id === fx0.id)!;
    const rotRad = (curFx0.grid_pos.rotation * Math.PI) / 180;
    const rotHandlePt = toClient(
      curFx0.grid_pos.x + Math.cos(rotRad) * 0.115,
      curFx0.grid_pos.y + Math.sin(rotRad) * 0.115,
    );
    ptr(canvas, "pointerdown", rotHandlePt);
    ptr(canvas, "pointermove", toClient(curFx0.grid_pos.x, curFx0.grid_pos.y + 0.15));
    ptr(canvas, "pointerup");

    // 4. Marquee drag on empty space covering both fixtures
    ptr(canvas, "pointerdown", toClient(0.05, 0.05));
    ptr(canvas, "pointermove", toClient(0.95, 0.95));
    ptr(canvas, "pointerup");

    // Multi-select drag of fx1
    const fx1Pt = toClient(0.7, 0.6);
    ptr(canvas, "pointerdown", fx1Pt);
    ptr(canvas, "pointermove", toClient(0.72, 0.62));
    ptr(canvas, "pointerup");

    // 5. Inline transform inputs & buttons + sr-only order rule bridge
    useTaktStore.getState().selectFixtureInstance(fx0.id);
    await waitFor(() => {
      expect(screen.getByLabelText("Grid X")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Grid X"), { target: { value: "0.42" } });
    fireEvent.change(screen.getByLabelText("Grid Y"), { target: { value: "0.48" } });
    fireEvent.change(screen.getByLabelText("Grid Rotation"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Rotate 90 Degrees" }));
    fireEvent.click(screen.getByTestId("reset-rotation-scale-btn"));
    fireEvent.change(screen.getByLabelText("Grid Scale X"), { target: { value: "0.4" } });
    fireEvent.change(screen.getByLabelText("Grid Scale Y"), { target: { value: "0.1" } });
    fireEvent.change(screen.getByLabelText("Order Rule"), { target: { value: "center_out" } });
    fireEvent.change(screen.getByLabelText("Target Reference"), {
      target: { value: `${fx0.id}:0..3` },
    });

    // 6. Pattern selection buttons
    for (const pat of ["all", "1/2", "1/3", "1/4", "invert", "shift_left", "shift_right"]) {
      fireEvent.click(screen.getByTestId(`pattern-filter-${pat}`));
    }

    // 7. Right SELECTIONS sidebar & quick group creation
    fireEvent.click(screen.getByTestId("select-all-fixtures-btn"));
    fireEvent.click(screen.getByTestId(`toggle-select-fixture-${fx1.id}`));
    fireEvent.change(screen.getByLabelText("Quick Selection Group Name"), {
      target: { value: "Selected Tubes" },
    });
    fireEvent.click(screen.getByTestId("create-group-from-fixtures-btn"));
    fireEvent.click(screen.getByTestId("clear-fixture-selection-btn"));

    // 8. Undo / Redo buttons
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));

    // 9. Switch shader to dimmer trait with rate_beats to exercise remaining shader render branches
    await useTaktStore.getState().upsertFxBlock({
      id: "blk_shader_2d",
      name: "2D Dimmer",
      target_group: "all",
      duration_beats: 4,
      duration_sec: null,
      loop_block: true,
      elements: [
        {
          kind: "spatial_shader_2d",
          trait: "dimmer",
          shader: "radial_wave",
          op: "htp",
          palette_ref: null,
          inline_colors: undefined,
          direction_deg: 0,
          center_x: 0.5,
          center_y: 0.5,
          spatial_freq: 1.0,
          speed_hz: null,
          rate_beats: 2,
          rate_cycles: 1,
          phase_offset: 0,
          color_width: 1,
          gradient: 1,
          grayscale: false,
          transform: "",
        },
      ],
    });
    fireEvent.click(screen.getByTestId("toggle-2d-shader-gizmo"));
  });

  it("maps pointer coordinates accurately inside an object-contain letterboxed canvas and scales gizmo beyond 0.45", async () => {
    await useTaktStore.getState().upsertFxBlock({
      id: "blk_shader_letterbox",
      name: "2D Letterbox",
      target_group: "all",
      duration_beats: 4,
      duration_sec: null,
      loop_block: true,
      elements: [
        {
          kind: "spatial_shader_2d",
          trait: "color",
          shader: "linear_sweep",
          op: "ltp",
          palette_ref: "pal_rgb",
          direction_deg: 0,
          center_x: 0.5,
          center_y: 0.5,
          spatial_freq: 1.0,
          speed_hz: null,
          rate_beats: null,
          rate_cycles: 1,
          phase_offset: 0,
          color_width: 1,
          gradient: 1,
          grayscale: false,
          transform: "",
        },
      ],
    });

    render(<FixtureGrid2D />);
    const canvas = screen.getByTestId("fixture-grid-canvas") as HTMLCanvasElement;
    // 1000x400 container for 840x480 canvas => scale = 400/480, drawn width = 700, left offset = 150
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 1000,
      height: 400,
      right: 1000,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const toLetterboxedClient = (nx: number, ny: number) => ({
      clientX: 150 + 350 + (nx - 0.5) * 400 * 0.84,
      clientY: 200 + (ny - 0.5) * 400 * 0.84,
    });

    const bridge = createTestBridge();
    const geom = bridge.getCanvasGeometry();
    expect(geom?.canvasRect.left).toBe(150);
    expect(geom?.canvasRect.width).toBe(700);

    // Drag corner handle from (0.7, 0.7) to (1.1, 0.9) => rectangular boxHalfX = 0.6, boxHalfY = 0.4
    const startPt = toLetterboxedClient(0.7, 0.7);
    const endPt = toLetterboxedClient(1.1, 0.9);
    ptr(canvas, "pointerdown", startPt);
    ptr(canvas, "pointermove", endPt);
    ptr(canvas, "pointerup");

    await waitFor(() => {
      const blk = useTaktStore.getState().showState.fx_library.find((b) => b.id === "blk_shader_letterbox");
      const el = blk?.elements[0];
      expect(el?.kind === "spatial_shader_2d" ? el.box_half_x : 0).toBeCloseTo(0.6, 2);
      expect(el?.kind === "spatial_shader_2d" ? el.box_half_y : 0).toBeCloseTo(0.4, 2);
    });
  });

  it("renders empty patch state cleanly", () => {
    useTaktStore.setState((s) => ({
      showState: { ...s.showState, patch: [] },
      compiledCells: [],
      selectedFixtureInstanceId: null,
      selectedFixtureIds: [],
    }));
    render(<FixtureGrid2D />);
    expect(screen.getByText(/No fixtures patched/i)).toBeInTheDocument();
  });
});

describe("Batch 3 Coverage — PalettesAndControls", () => {
  beforeEach(async () => {
    await setupStudioFixtures();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("covers standalone (daslightDock=false) palette CRUD, groups, layers, undo/redo, and software strobe cap", async () => {
    useTaktStore.setState({
      canUndo: true,
      canRedo: true,
      liveLayers: [
        {
          id: "layer_strobe_hi",
          name: "Fast Strobe",
          enabled: true,
          priority: 3,
          trigger_order: 1,
          alpha: 1,
          target: "all",
          order_override: null,
          trait_spec: {
            trait_kind: "shutter",
            state: { kind: "strobe_hz", hz: 18 },
          },
        },
      ],
    });

    render(<PalettesAndControls daslightDock={false} hideUndoRedo={false} hideGroups={false} />);

    // Color palette CRUD (save twice to cover slugId collision suffix)
    fireEvent.change(screen.getByLabelText("Color Palette Name"), {
      target: { value: "Warm Sunset" },
    });
    fireEvent.change(screen.getByLabelText("Color Start Hex"), {
      target: { value: "#FF4400" },
    });
    fireEvent.change(screen.getByLabelText("Color End Hex"), {
      target: { value: "#3300FF" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Color Palette" }));
    await waitFor(() => {
      expect(
        useTaktStore.getState().showState.color_palettes.some((p) => p.name === "Warm Sunset"),
      ).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Color Palette" }));

    // Link color palette twice (creates layer, then updates existing layer)
    const pal = useTaktStore.getState().showState.color_palettes[0]!;
    fireEvent.click(screen.getByTestId(`link-palette-${pal.id}`));
    fireEvent.click(screen.getByTestId(`link-palette-${pal.id}`));

    // Delete color palette
    fireEvent.click(screen.getByRole("button", { name: `Delete palette ${pal.name}` }));

    // Dimmer palette CRUD
    fireEvent.change(screen.getByLabelText("Dimmer Palette Name"), {
      target: { value: "Half Dim" },
    });
    fireEvent.change(screen.getByLabelText("Dimmer Start Value"), {
      target: { value: "0.5" },
    });
    fireEvent.change(screen.getByLabelText("Dimmer End Value"), {
      target: { value: "0.8" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Dimmer Palette" }));

    // Group creation
    fireEvent.change(screen.getByLabelText("Group Name"), {
      target: { value: "Back Wash" },
    });
    fireEvent.change(screen.getByLabelText("Group Order"), {
      target: { value: "linear" },
    });
    fireEvent.change(screen.getByLabelText("Group Targets"), {
      target: { value: useTaktStore.getState().showState.patch[0]?.id ?? "fx_001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Group" }));

    // Add dimmer & color layers
    fireEvent.click(screen.getByRole("button", { name: "Add Dimmer Layer" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Color Layer" }));

    // Undo / Redo
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  });

  it("covers daslightDock=true across DIMMER, COLOR, BEAM, and FADER tabs", async () => {
    // Seed a dimmer palette so dimmer palette dropdown & delete work
    await useTaktStore.getState().upsertDimmerPalette({
      id: "dim_full",
      name: "Full 100%",
      value_start: 1,
      value_end: 1,
    });

    render(<PalettesAndControls daslightDock={true} />);

    // 1. DIMMER tab (Master Dimmer + Segment Dimmer)
    if (screen.queryByTestId("toggle-scene-controls-master-dimmer")) {
      fireEvent.click(screen.getByTestId("toggle-scene-controls-master-dimmer"));
      await waitFor(() => {
        expect(screen.getByTestId("toggle-scene-controls-master-dimmer")).toHaveAttribute(
          "aria-pressed",
          "true",
        );
      });
      fireEvent.click(screen.getByTitle("Toggle Master Full / Off"));
      fireEvent.click(screen.getByTitle("Master 0%"));
      fireEvent.click(screen.getByTitle("Master 100%"));
      const masterSlider = screen.getByLabelText("Master Dimmer Fader");
      fireEvent.change(masterSlider, { target: { value: "0.6" } });
      fireEvent.click(screen.getByTestId("toggle-scene-controls-master-dimmer"));
      await waitFor(() => {
        expect(screen.getByTestId("toggle-scene-controls-master-dimmer")).toHaveAttribute(
          "aria-pressed",
          "false",
        );
      });
      fireEvent.click(screen.getByTitle("Reset Master Dimmer (remove from scene)"));
    }

    fireEvent.click(screen.getByTestId("toggle-scene-controls-dimmer"));
    await waitFor(() => {
      expect(screen.getByTestId("toggle-scene-controls-dimmer")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    fireEvent.click(screen.getByTitle("Toggle Full / Off"));
    fireEvent.click(screen.getByTitle("Off (0%)"));
    fireEvent.click(screen.getByTitle("Full (100%)"));
    fireEvent.change(screen.getByLabelText("Channel Dimmer Fader"), {
      target: { value: "0.75" },
    });
    // Toggle off & back on to exercise savedSceneTraitsRef save/restore
    fireEvent.click(screen.getByTestId("toggle-scene-controls-dimmer"));
    await waitFor(() => {
      expect(screen.getByTestId("toggle-scene-controls-dimmer")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
    fireEvent.click(screen.getByTestId("toggle-scene-controls-dimmer"));
    await waitFor(() => {
      expect(screen.getByTestId("toggle-scene-controls-dimmer")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    fireEvent.click(screen.getByTitle("Reset Dimmer (remove from scene)"));

    // 2. COLOR tab
    fireEvent.click(screen.getByTestId("trait-tab-color"));
    fireEvent.click(screen.getByTestId("toggle-scene-controls-color"));
    fireEvent.click(screen.getByTestId("toggle-scene-controls-color"));
    fireEvent.click(screen.getByTestId("toggle-scene-controls-color"));

    // Auto white checkbox
    fireEvent.click(screen.getByLabelText(/Auto white/i));

    // HS color square pointer drag
    const hsSquare = screen.getByTestId("color-hs-square");
    vi.spyOn(hsSquare, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(hsSquare, { clientX: 60, clientY: 20 });
    fireEvent.pointerMove(hsSquare, { clientX: 120, clientY: 40 });
    fireEvent.pointerUp(hsSquare);
    fireEvent.pointerLeave(hsSquare);

    // Click favorite swatch & palette & open palette builder modal
    fireEvent.click(screen.getByTitle("#00FF00"));
    const firstPal = useTaktStore.getState().showState.color_palettes[0];
    if (firstPal) {
      fireEvent.click(screen.getByTestId(`link-palette-${firstPal.id}`));
    }
    fireEvent.click(screen.getByTestId("open-palette-builder-dock-btn"));
    expect(screen.getByTestId("color-palette-builder-modal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // RGB vertical sliders & zero buttons
    fireEvent.change(screen.getByLabelText("RED Channel Fader"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("GREEN Channel Fader"), { target: { value: "80" } });
    fireEvent.change(screen.getByLabelText("BLUE Channel Fader"), { target: { value: "200" } });
    const powerBtns = screen
      .getAllByRole("button")
      .filter((b) => b.querySelector("svg.lucide-power"));
    for (const pb of powerBtns) {
      fireEvent.click(pb);
    }

    // 3. BEAM tab
    fireEvent.click(screen.getByTestId("trait-tab-beam"));
    fireEvent.change(screen.getByLabelText("Beam Strobe Hz"), { target: { value: "14" } });
    // Toggle shutter button
    const beamButtons = screen.getAllByRole("button");
    const shutterBtn = beamButtons.find((b) => b.querySelector("svg.lucide-zap"));
    if (shutterBtn) {
      fireEvent.click(shutterBtn);
      fireEvent.click(shutterBtn);
    }

    // 4. FADER tab
    fireEvent.click(screen.getByTestId("trait-tab-fader"));
    fireEvent.click(screen.getByRole("button", { name: "Add Dimmer Layer" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Color Layer" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Master Layer" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Shutter Layer" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Layer 1 Enabled")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Layer 1 Enabled"));
    fireEvent.change(screen.getByLabelText("Layer 1 Target"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Layer 1 Order"), { target: { value: "mirror" } });
    fireEvent.change(screen.getByLabelText("Layer 1 Order"), { target: { value: "" } });

    // Shutter layer mode & Hz edits
    const shutterModeSelects = screen.getAllByLabelText(/Layer \d+ Shutter Mode/);
    const lastShutterMode = shutterModeSelects[shutterModeSelects.length - 1];
    fireEvent.change(lastShutterMode, { target: { value: "closed" } });
    fireEvent.change(lastShutterMode, { target: { value: "strobe_hz" } });
    fireEvent.change(lastShutterMode, { target: { value: "random_strobe" } });
    const hzInputs = screen.getAllByLabelText(/Layer \d+ Strobe Hz/);
    fireEvent.change(hzInputs[hzInputs.length - 1], { target: { value: "12" } });

    // Dimmer & Color layer palette selectors
    const palSelects = screen.getAllByLabelText(/Layer \d+ Palette/);
    for (const sel of palSelects) {
      fireEvent.change(sel, { target: { value: "" } });
    }

    // Quick palette creators & delete dimmer palette in FADER tab
    fireEvent.change(screen.getByLabelText("Color Palette Name"), { target: { value: "Dock Pal" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Color Palette" }));
    fireEvent.change(screen.getByLabelText("Dimmer Palette Name"), { target: { value: "Dock Dim" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Dimmer Palette" }));
    fireEvent.click(screen.getByRole("button", { name: /Delete dimmer Full 100%/i }));

    // Remove a layer
    fireEvent.click(screen.getByRole("button", { name: "Remove Layer 1" }));

    // Switch back to DIMMER tab so sr-only layer controls render & exercise them
    fireEvent.click(screen.getByTestId("trait-tab-dimmer"));
    const srOrderSelects = screen.queryAllByLabelText(/Layer \d+ Order/);
    if (srOrderSelects.length > 0) {
      fireEvent.change(srOrderSelects[0], { target: { value: "mirror" } });
    }
    const srPalSelects = screen.queryAllByLabelText(/Layer \d+ Palette/);
    if (srPalSelects.length > 0) {
      fireEvent.change(srPalSelects[0], { target: { value: "" } });
    }
    const srShutterSelects = screen.queryAllByLabelText(/Layer \d+ Shutter Mode/);
    if (srShutterSelects.length > 0) {
      fireEvent.change(srShutterSelects[0], { target: { value: "strobe_hz" } });
    }
    const srHzInputs = screen.queryAllByLabelText(/Layer \d+ Strobe Hz/);
    if (srHzInputs.length > 0) {
      fireEvent.change(srHzInputs[0], { target: { value: "10" } });
    }
  });
});
