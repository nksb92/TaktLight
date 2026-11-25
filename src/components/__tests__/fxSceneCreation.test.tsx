import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { useTaktStore } from "../../store/useTaktStore";
import { seedTestFixturesInStore, TEST_TUBE_8SEG_ID } from "../../test/testFixtures";

async function setupStudioWithTube() {
  seedTestFixturesInStore();
  await useTaktStore
    .getState()
    .patchFixtures(
      TEST_TUBE_8SEG_ID,
      "34ch Pixel Mode",
      "Tube FX",
      1,
      1,
      1,
    );
  const fxId = useTaktStore.getState().showState.patch[0].id;
  await useTaktStore.getState().updateFixtureGridPos(fxId, {
    x: 0.5,
    y: 0.5,
    rotation: 0,
    scale_x: 0.3,
    scale_y: 0.05,
  });
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));
}

async function createAndSelectFreshScene() {
  await act(async () => {
    fireEvent.click(screen.getByTestId("quick-add-scene-Bank 1"));
    await Promise.resolve();
  });
  const scenes = useTaktStore.getState().showState.scenes;
  const newest = scenes[scenes.length - 1];
  fireEvent.click(screen.getByTestId(`scene-play-zone-${newest.id}`));
  return newest.id;
}

async function setStaticDockDimmerFull() {
  fireEvent.click(screen.getByRole("button", { name: /^DIMMER$/i }));
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Channel Dimmer Fader value"), {
      target: { value: "100" },
    });
    fireEvent.blur(screen.getByLabelText("Channel Dimmer Fader value"));
    await Promise.resolve();
  });
}

async function setStaticDockColorWhite() {
  fireEvent.click(screen.getByRole("button", { name: /^COLOR$/i }));
  for (const label of [
    "RED Channel Fader value",
    "GREEN Channel Fader value",
    "BLUE Channel Fader value",
  ]) {
    await act(async () => {
      fireEvent.change(screen.getByLabelText(label), { target: { value: "255" } });
      fireEvent.blur(screen.getByLabelText(label));
      await Promise.resolve();
    });
  }
}

function getTubeCellRgbw() {
  const u1 = useTaktStore.getState().dmxByUniverse[1];
  return Array.from({ length: 8 }, (_, i) => ({
    r: u1[2 + i * 4],
    g: u1[3 + i * 4],
    b: u1[4 + i * 4],
    w: u1[5 + i * 4],
  }));
}

function getActiveSceneElements(sceneId: string) {
  const st = useTaktStore.getState().showState;
  const sc = st.scenes.find((s) => s.id === sceneId)!;
  const blk = st.fx_library.find((b) => b.id === sc.block_refs[0])!;
  return blk.elements;
}

describe("FX Scene Creation, Parameter Adaptation & DMX Plausibility (All 6 UI Types)", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("FX-01: creates COLOR FX, adapts grayscale/width/angle, and outputs plausible DMX", async () => {
    await setupStudioWithTube();
    const scId = await createAndSelectFreshScene();
    await setStaticDockDimmerFull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-color_fx"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("fx-submenu-header-color_fx")).toBeInTheDocument();

    // Adapt Color Width and Angle
    await act(async () => {
      const widthInput = screen.getByLabelText("Color Width value");
      fireEvent.change(widthInput, { target: { value: "2" } });
      fireEvent.blur(widthInput);
      const angleInput = screen.getByLabelText("Color FX Angle value");
      fireEvent.change(angleInput, { target: { value: "180" } });
      fireEvent.blur(angleInput);
      await Promise.resolve();
    });

    // Trigger scene and verify lit, colorful DMX output
    await act(async () => {
      fireEvent.click(screen.getByTestId(`trigger-scene-${scId}`));
      await Promise.resolve();
    });
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(255);
    const colorCells = getTubeCellRgbw();
    expect(colorCells.some((c) => c.r > 0 || c.g > 0 || c.b > 0 || c.w > 0)).toBe(true);

    // Enable Grayscale -> RGBW replace mode drives pure White (R=G=B=0, W>0)
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Grayscale"));
      await Promise.resolve();
    });
    const el = getActiveSceneElements(scId).find((e) => e.kind === "curve_1d");
    expect(el?.kind === "curve_1d" ? el.grayscale : false).toBe(true);
    expect(el?.kind === "curve_1d" ? el.color_width : 0).toBeCloseTo(2, 1);
    expect(el?.kind === "curve_1d" ? el.angle_deg : 0).toBeCloseTo(180, 1);

    const grayCells = getTubeCellRgbw();
    expect(grayCells.some((c) => c.w > 0)).toBe(true);
    expect(grayCells.every((c) => c.r === 0 && c.g === 0 && c.b === 0)).toBe(true);
  });

  it("FX-02: creates COLOR MAPPINGS, adapts shader/transform/grayscale, and outputs plausible DMX", async () => {
    await setupStudioWithTube();
    const scId = await createAndSelectFreshScene();
    await setStaticDockDimmerFull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-color_mappings"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("fx-submenu-header-color_mappings")).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("FX Shader Kind"), {
        target: { value: "radial_wave" },
      });
      fireEvent.change(screen.getByLabelText("Mapping Transform"), {
        target: { value: "mirror_x" },
      });
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId(`trigger-scene-${scId}`));
      await Promise.resolve();
    });

    const el = getActiveSceneElements(scId).find((e) => e.kind === "spatial_shader_2d");
    expect(el?.kind === "spatial_shader_2d" ? el.shader : null).toBe("radial_wave");
    expect(el?.kind === "spatial_shader_2d" ? el.transform : null).toBe("mirror_x");

    const cells = getTubeCellRgbw();
    expect(cells.some((c) => c.r > 0 || c.g > 0 || c.b > 0 || c.w > 0)).toBe(true);

    // Toggle Grayscale -> zero chromatic RGB, positive White channel
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Grayscale"));
      await Promise.resolve();
    });
    const grayCells = getTubeCellRgbw();
    expect(grayCells.some((c) => c.w > 0)).toBe(true);
    expect(grayCells.every((c) => c.r === 0 && c.g === 0 && c.b === 0)).toBe(true);
  });

  it("FX-03: creates CHASER FX, adapts pixels_on/one_way/fading/order, and increases lit DMX cells", async () => {
    await setupStudioWithTube();
    const scId = await createAndSelectFreshScene();
    await setStaticDockColorWhite();

    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-chaser_fx"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("fx-submenu-header-chaser_fx")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId(`trigger-scene-${scId}`));
      await Promise.resolve();
    });
    const litBefore = getTubeCellRgbw().filter((c) => c.w > 0 || c.r > 0).length;
    expect(litBefore).toBeGreaterThanOrEqual(1);

    // Increase Nb pixels on -> 4, disable One Way Only, enable Chaser Fading, set order to reverse
    await act(async () => {
      const pxInput = screen.getByLabelText("Nb pixels on value");
      fireEvent.change(pxInput, { target: { value: "4" } });
      fireEvent.blur(pxInput);
      fireEvent.click(screen.getByLabelText("One Way Only"));
      fireEvent.click(screen.getByLabelText("Chaser Fading"));
      fireEvent.change(screen.getByLabelText("Effect Run Order"), {
        target: { value: "reverse" },
      });
      await Promise.resolve();
    });

    const el = getActiveSceneElements(scId).find((e) => e.kind === "step_chase");
    expect(el?.kind === "step_chase" ? el.pixels_on : 0).toBe(4);
    expect(el?.kind === "step_chase" ? el.one_way : true).toBe(false);
    expect(el?.kind === "step_chase" ? el.fade : 0).toBeGreaterThan(0);
    expect(el?.kind === "step_chase" ? el.order : null).toBe("reverse");

    const litAfter = getTubeCellRgbw().filter((c) => c.w > 0 || c.r > 0).length;
    expect(litAfter).toBeGreaterThan(litBefore);
  });

  it("FX-04: creates VALUE FX, adds value stop, collapses phasing to 0, and syncs all tube cells", async () => {
    await setupStudioWithTube();
    const scId = await createAndSelectFreshScene();
    await setStaticDockColorWhite();

    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-value_fx"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("fx-submenu-header-value_fx")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId(`trigger-scene-${scId}`));
      await Promise.resolve();
    });

    // Default phasing=360 spreads values across cells
    const spreadW = getTubeCellRgbw().map((c) => c.w);
    expect(new Set(spreadW).size).toBeGreaterThan(1);

    // Add a value stop and set Phasing to 0 -> all cells synchronize to same DMX level
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-value-stop-btn"));
      await Promise.resolve();
    });
    await act(async () => {
      const phasingInput = screen.getByLabelText("Curve Phasing value");
      fireEvent.change(phasingInput, { target: { value: "0" } });
      fireEvent.blur(phasingInput);
      await Promise.resolve();
    });

    const el = getActiveSceneElements(scId).find((e) => e.kind === "curve_1d");
    expect(el?.kind === "curve_1d" ? el.fx_kind_tag : null).toBe("value_fx");
    expect(el?.kind === "curve_1d" ? el.value_stops?.length : 0).toBe(4);
    expect(el?.kind === "curve_1d" ? el.phase_spread_deg : -1).toBe(0);

    const syncW = getTubeCellRgbw().map((c) => c.w);
    expect(new Set(syncW).size).toBe(1);
    expect(syncW[0]).toBeGreaterThan(0);
  });

  it("FX-05: creates CURVE FX, adapts waveform/duty/target channel, and outputs plausible DMX", async () => {
    await setupStudioWithTube();
    const scId = await createAndSelectFreshScene();
    await setStaticDockColorWhite();

    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-curve_fx"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("fx-submenu-header-curve_fx")).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("FX Waveform"), {
        target: { value: "pulse" },
      });
      await Promise.resolve();
    });
    await act(async () => {
      const dutyInput = screen.getByLabelText("Curve Duty Pct value");
      fireEvent.change(dutyInput, { target: { value: "75" } });
      fireEvent.blur(dutyInput);
      const phasingInput = screen.getByLabelText("Curve Phasing value");
      fireEvent.change(phasingInput, { target: { value: "0" } });
      fireEvent.blur(phasingInput);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId(`trigger-scene-${scId}`));
      await Promise.resolve();
    });

    const el = getActiveSceneElements(scId).find((e) => e.kind === "curve_1d");
    expect(el?.kind === "curve_1d" ? el.waveform : null).toBe("pulse");
    expect(el?.kind === "curve_1d" ? el.duty : 0).toBeCloseTo(0.75, 2);

    // At t=0, pulse wave (duty=0.75) is HIGH -> all cells at 255
    const pulseW = getTubeCellRgbw().map((c) => c.w);
    expect(pulseW.every((w) => w === 255)).toBe(true);
  });

  it("FX-06: creates MAPPINGS (dimmer 2D shader), adapts shader/transform/value stop, and outputs plausible DMX", async () => {
    await setupStudioWithTube();
    const scId = await createAndSelectFreshScene();
    await setStaticDockColorWhite();

    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-mappings"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("fx-submenu-header-mappings")).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("FX Shader Kind"), {
        target: { value: "plasma" },
      });
      fireEvent.change(screen.getByLabelText("Mapping Transform"), {
        target: { value: "invert" },
      });
      fireEvent.click(screen.getByTestId("add-value-stop-btn"));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId(`trigger-scene-${scId}`));
      await Promise.resolve();
    });

    const el = getActiveSceneElements(scId).find((e) => e.kind === "spatial_shader_2d");
    expect(el?.kind === "spatial_shader_2d" ? el.trait : null).toBe("dimmer");
    expect(el?.kind === "spatial_shader_2d" ? el.shader : null).toBe("plasma");
    expect(el?.kind === "spatial_shader_2d" ? el.transform : null).toBe("invert");
    expect(el?.kind === "spatial_shader_2d" ? el.value_stops?.length : 0).toBe(3);

    const cells = getTubeCellRgbw();
    expect(cells.some((c) => c.w > 0)).toBe(true);
  });

  it("supports Static toggle (rate_cycles=0) and Phase Offset on color_mappings and mappings", async () => {
    await setupStudioWithTube();
    const scId = await createAndSelectFreshScene();
    await setStaticDockDimmerFull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-color_mappings"));
      await Promise.resolve();
    });

    // Toggle Static on -> rate_cycles becomes 0
    await act(async () => {
      fireEvent.click(screen.getByTestId("spatial-static-toggle"));
      await Promise.resolve();
    });

    let el = getActiveSceneElements(scId).find((e) => e.kind === "spatial_shader_2d");
    expect(el?.kind === "spatial_shader_2d" ? el.rate_cycles : null).toBe(0);

    // Adjust Phase Offset slider -> phase_offset updates
    await act(async () => {
      const phaseInput = screen.getByLabelText("Spatial Phase Offset value");
      fireEvent.change(phaseInput, { target: { value: "50" } });
      fireEvent.blur(phaseInput);
      await Promise.resolve();
    });

    el = getActiveSceneElements(scId).find((e) => e.kind === "spatial_shader_2d");
    expect(el?.kind === "spatial_shader_2d" ? el.phase_offset : null).toBeCloseTo(0.5, 2);

    // Toggle Static off -> restores previous non-zero rate
    await act(async () => {
      fireEvent.click(screen.getByTestId("spatial-static-toggle"));
      await Promise.resolve();
    });

    el = getActiveSceneElements(scId).find((e) => e.kind === "spatial_shader_2d");
    expect(el?.kind === "spatial_shader_2d" ? el.rate_cycles : null).toBe(1);
  });
});
