import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { useTaktStore } from "../../store/useTaktStore";

describe("2D Grid, Timeline Inspector & TopStatusBar Normal Usage", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("toggles 2D shader gizmo, accepts negative GridPos, and resets rotation/scale", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube Grid",
        1,
        1,
        1,
      );
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    // Add a 2D spatial shader so the gizmo toggle is active
    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-color_mappings"));
      await Promise.resolve();
    });

    const gizmoBtn = screen.getByTestId("toggle-2d-shader-gizmo");
    // Auto-activated when color_mappings is selected; manual toggle hides and shows it
    expect(gizmoBtn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(gizmoBtn);
    expect(gizmoBtn).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(gizmoBtn);
    expect(gizmoBtn).toHaveAttribute("aria-pressed", "true");

    // Negative Grid X & Y accepted without clamping to 0
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Grid X"), { target: { value: "-0.3" } });
      fireEvent.blur(screen.getByLabelText("Grid X"));
      fireEvent.change(screen.getByLabelText("Grid Y"), { target: { value: "-0.15" } });
      fireEvent.blur(screen.getByLabelText("Grid Y"));
      await Promise.resolve();
    });
    const gp = useTaktStore.getState().showState.patch[0].grid_pos;
    expect(gp.x).toBeCloseTo(-0.3, 2);
    expect(gp.y).toBeCloseTo(-0.15, 2);

    // Rotate and reset
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Grid Rotation"), { target: { value: "60" } });
      await Promise.resolve();
    });
    expect(useTaktStore.getState().showState.patch[0].grid_pos.rotation).toBeCloseTo(60, 1);
    fireEvent.click(screen.getByTestId("reset-rotation-scale-btn"));
    expect(useTaktStore.getState().showState.patch[0].grid_pos.rotation).toBe(0);
  });

  it("updates TimelineRightInspector settings (tempo, grid offset, align to playhead, transient toggles, stretch factor)", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));
    fireEvent.click(screen.getByTestId("scene-play-zone-sc_tl_cyber_intro"));

    // Clip tab: select first clip, then update stretch factor & reset
    fireEvent.pointerDown(screen.getByTestId("clip-body-trk_1-0"), { clientX: 50, button: 0 });
    fireEvent.pointerUp(window);
    expect(screen.getByTestId("selected-clip-inspector")).toBeInTheDocument();
    await act(async () => {
      const stretchInput = screen.getByTestId("clip-stretch-factor-input");
      fireEvent.change(stretchInput, { target: { value: "1.5" } });
      fireEvent.blur(stretchInput);
      await Promise.resolve();
    });
    const clipAfterStretch =
      useTaktStore.getState().showState.timelines[0].tracks[0].clips[0];
    expect(clipAfterStretch.time_stretch).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("reset-clip-stretch-btn"));
      await Promise.resolve();
    });
    expect(
      useTaktStore.getState().showState.timelines[0].tracks[0].clips[0].time_stretch,
    ).toBe(false);

    // Settings tab: seek playhead to 1.25s, click Align Grid to Playhead, toggle transients
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Timeline Playhead Sec"), {
        target: { value: "1.25" },
      });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId("timeline-inspector-tab-settings"));
    expect(screen.getByTestId("timeline-settings-inspector")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("align-grid-to-playhead-btn"));
      await Promise.resolve();
    });
    expect(useTaktStore.getState().showState.timelines[0].grid_offset_sec).toBeCloseTo(
      1.25,
      2,
    );

    const showTransCheckbox = screen.getByTestId(
      "toggle-show-transients",
    ) as HTMLInputElement;
    const beforeShow = showTransCheckbox.checked;
    fireEvent.click(showTransCheckbox);
    expect(showTransCheckbox.checked).toBe(!beforeShow);
  });

  it("switches network adapter offline/auto, tracks dirty state dot, and triggers scene via keyboard binding", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube Keys",
        1,
        1,
        1,
      );
    render(<App />);

    // Switch network adapter to offline and back to auto
    const adapterSelect = screen.getByLabelText("Network Output Adapter");
    await act(async () => {
      fireEvent.change(adapterSelect, { target: { value: "offline" } });
      await Promise.resolve();
    });
    expect(useTaktStore.getState().isOffline).toBe(true);
    await act(async () => {
      fireEvent.change(adapterSelect, { target: { value: "auto" } });
      await Promise.resolve();
    });
    expect(useTaktStore.getState().isOffline).toBe(false);

    // Unsaved dirty dot appears after mutation and clears on markShowSaved
    expect(screen.getByTestId("topbar-unsaved-dot")).toBeInTheDocument();
    act(() => {
      useTaktStore.getState().markShowSaved();
    });
    expect(screen.queryByTestId("topbar-unsaved-dot")).not.toBeInTheDocument();

    // Assign key binding 'M' to sc_new_1 and trigger it via keyboard press
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));
    fireEvent.click(screen.getByTestId("toggle-key-map-overlay"));
    fireEvent.click(screen.getByTestId("scene-play-zone-sc_new_1"));
    fireEvent.keyDown(window, { key: "m" });
    expect(useTaktStore.getState().keyBindings["sc_new_1"]).toBe("M");
    fireEvent.click(screen.getByTestId("toggle-key-map-overlay"));

    await act(async () => {
      fireEvent.keyDown(window, { key: "m" });
      await Promise.resolve();
    });
    expect(
      useTaktStore
        .getState()
        .activeScenes.some((s) => s.scene_id === "sc_new_1" && s.release_t_sec === null),
    ).toBe(true);
  });
});
