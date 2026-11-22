import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { evaluateSpatialShader2DPhase } from "../../lib/mixerLogic";
import { useTaktStore } from "../../store/useTaktStore";

describe("Usage Notes Automated Regressions (docs/usage_notes.md)", () => {
  beforeEach(() => {
    if (typeof window.PointerEvent === "undefined") {
      (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
        MouseEvent;
    }
    useTaktStore.getState().resetForTest();
  });

  it("L2: hides 2D viewer cell numbers when fixture is too small so text does not overlap", async () => {
    const fillTextCalls: string[] = [];
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    const mockCtx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      arc: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn((text: string) => {
        fillTextCalls.push(String(text));
      }),
      font: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      textAlign: "left",
    };
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => mockCtx as unknown as CanvasRenderingContext2D,
    ) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    try {
      await useTaktStore
        .getState()
        .patchFixtures(
          "age/rlcv3_8_segment_tube.json",
          "34ch Pixel Mode",
          "Tiny Tube",
          1,
          1,
          1,
        );
      const fxId = useTaktStore.getState().showState.patch[0].id;
      // Make fixture tiny so cellSize < 14px
      await useTaktStore.getState().updateFixtureGridPos(fxId, {
        x: 0.5,
        y: 0.5,
        rotation: 0,
        scale_x: 0.03,
        scale_y: 0.01,
      });

      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

      // Fixture name may be drawn, but numeric cell badges ("1".."8") must NOT be drawn
      const numericBadgeCalls = fillTextCalls.filter((t) => /^[1-8]$/.test(t));
      expect(numericBadgeCalls).toHaveLength(0);
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetContext;
    }
  });

  it("L3: Alt-dragging a timeline clip creates exactly 1 copy (not 2) and releases cleanly", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));
    fireEvent.click(screen.getByTestId("scene-play-zone-sc_tl_cyber_intro"));

    const beforeCount =
      useTaktStore.getState().showState.timelines[0].tracks[0].clips.length;

    const clipBody = screen.getByTestId("clip-body-trk_1-0");
    fireEvent.pointerDown(clipBody, { clientX: 100, button: 0, altKey: true });
    fireEvent.pointerMove(window, { clientX: 220 });
    // Simulate real browser firing BOTH pointerup and mouseup synchronously
    fireEvent.pointerUp(window);
    fireEvent.mouseUp(window);
    // Moving mouse afterwards must not move or spawn additional clips
    fireEvent.pointerMove(window, { clientX: 340 });
    fireEvent.mouseMove(window, { clientX: 400 });

    const afterCount =
      useTaktStore.getState().showState.timelines[0].tracks[0].clips.length;
    expect(afterCount).toBe(beforeCount + 1);
  });

  it("L4: changing Phase on CURVE FX keeps CURVE FX active (never flips to VALUE FX)", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube Curve",
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
    expect(screen.getByTestId("fx-submenu-header-curve_fx")).toBeInTheDocument();

    await act(async () => {
      const phaseInput = screen.getByLabelText("Curve Phase value");
      fireEvent.change(phaseInput, { target: { value: "90" } });
      fireEvent.blur(phaseInput);
      await Promise.resolve();
    });

    expect(screen.getByTestId("fx-submenu-header-curve_fx")).toBeInTheDocument();
    expect(screen.queryByTestId("fx-submenu-header-value_fx")).not.toBeInTheDocument();
  });

  it("L5: double-clicking a timeline track lane does NOT add a new clip or scene", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));
    fireEvent.click(screen.getByTestId("scene-play-zone-sc_tl_cyber_intro"));

    const scenesBefore = useTaktStore.getState().showState.scenes.length;
    const clipsBefore =
      useTaktStore.getState().showState.timelines[0].tracks[0].clips.length;

    const lane = screen.getByTestId("track-lane-trk_1");
    await act(async () => {
      fireEvent.doubleClick(lane, { clientX: 400 });
      await Promise.resolve();
    });

    expect(useTaktStore.getState().showState.scenes.length).toBe(scenesBefore);
    expect(
      useTaktStore.getState().showState.timelines[0].tracks[0].clips.length,
    ).toBe(clipsBefore);
  });

  it("L6 & L7: selecting color_mappings auto-activates 2D FX overlay and changing pattern preserves gizmo position", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube Map",
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

    // L6: 2D shader gizmo overlay automatically activates
    expect(screen.getByTestId("toggle-2d-shader-gizmo")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Move gizmo center in store (simulating drag on 2D viewer)
    const blk = useTaktStore
      .getState()
      .showState.fx_library.find((b) => b.id === "blk_scene_sc_new_1")!;
    await act(async () => {
      await useTaktStore.getState().upsertFxBlock({
        ...blk,
        elements: blk.elements.map((el) =>
          el.kind === "spatial_shader_2d"
            ? { ...el, center_x: 0.72, center_y: 0.31 }
            : el,
        ),
      });
      await Promise.resolve();
    });

    // L7: Change 2D pattern (linear_sweep -> radial_wave) -> center_x/center_y MUST be preserved
    await act(async () => {
      fireEvent.change(screen.getByLabelText("FX Shader Kind"), {
        target: { value: "radial_wave" },
      });
      await Promise.resolve();
    });

    const updatedBlk = useTaktStore
      .getState()
      .showState.fx_library.find((b) => b.id === "blk_scene_sc_new_1")!;
    const shaderEl = updatedBlk.elements.find((e) => e.kind === "spatial_shader_2d");
    expect(shaderEl?.kind === "spatial_shader_2d" ? shaderEl.shader : null).toBe(
      "radial_wave",
    );
    expect(shaderEl?.kind === "spatial_shader_2d" ? shaderEl.center_x : 0).toBeCloseTo(
      0.72,
      2,
    );
    expect(shaderEl?.kind === "spatial_shader_2d" ? shaderEl.center_y : 0).toBeCloseTo(
      0.31,
      2,
    );
  });

  it("L8: color_mappings mirror_x, mirror_y, and invert transform around gizmo center on all shaders", () => {
    // Off-center gizmo at (0.3, 0.4), sample point at (0.4, 0.55) => dx=+0.1, dy=+0.15
    const baseArgs = {
      normXy: [0.4, 0.55] as [number, number],
      basePhaseCycles: 0.1,
      spatialFreq: 1.0,
      colorWidth: 1,
      directionDeg: 45,
      centerX: 0.3,
      centerY: 0.4,
    };

    for (const shader of ["linear_sweep", "pinwheel", "plasma"] as const) {
      const sNone = evaluateSpatialShader2DPhase({ ...baseArgs, shader, transform: null });
      const sMx = evaluateSpatialShader2DPhase({ ...baseArgs, shader, transform: "mirror_x" });
      const sMy = evaluateSpatialShader2DPhase({ ...baseArgs, shader, transform: "mirror_y" });
      const sInv = evaluateSpatialShader2DPhase({ ...baseArgs, shader, transform: "invert" });
      expect(sMx).not.toBeCloseTo(sNone, 3);
      expect(sMy).not.toBeCloseTo(sNone, 3);
      expect(sInv).not.toBeCloseTo(sNone, 3);
    }

    // Radial wave invert flips value cleanly
    const rNone = evaluateSpatialShader2DPhase({
      ...baseArgs,
      shader: "radial_wave",
      transform: null,
    });
    const rInv = evaluateSpatialShader2DPhase({
      ...baseArgs,
      shader: "radial_wave",
      transform: "invert",
    });
    expect(rNone + rInv).toBeCloseTo(1.0, 4);
  });

  it("L9 & L10: selecting a FixtureBuilder preset stays in Visual Builder and added modes are visually configurable", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Fixtures$/i }));

    // L9: Clicking a preset keeps Visual Builder open (Raw JSON Editor not forced)
    await act(async () => {
      fireEvent.click(screen.getByText("RLCV3 8-Segment RGBW Tube"));
      await Promise.resolve();
    });
    expect(screen.queryByLabelText("Raw OFL JSON Editor")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Fixture Name")).toBeInTheDocument();

    // L10: Add a mode and configure its name + channels visually
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-mode-btn"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("visual-mode-config")).toBeInTheDocument();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Selected Mode Name"), {
        target: { value: "Compact 2ch" },
      });
      await Promise.resolve();
    });
    expect(
      (screen.getByLabelText("Selected Mode Name") as HTMLInputElement).value,
    ).toBe("Compact 2ch");
  });
});
