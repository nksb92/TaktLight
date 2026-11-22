import { evalBridge, expect, test } from "./tauri.fixture";

test.describe("TaktLight Real Tauri App E2E (WebView2 CDP)", () => {
  test("verifies live Tauri IPC connection, test bridge, and 44 Hz telemetry", async ({
    tauriPage,
  }) => {
    const status1 = await evalBridge(tauriPage, (b) => b.getStatus());
    expect(status1.isTauri).toBe(true);
    expect(status1.connectedMode).toBe("tauri");

    await tauriPage.waitForTimeout(400);
    const status2 = await evalBridge(tauriPage, (b) => b.getStatus());
    expect(status2.telemetry.tSec).toBeGreaterThan(status1.telemetry.tSec);
    expect(status2.telemetry.droppedFrames - status1.telemetry.droppedFrames).toBe(0);
    expect(status2.telemetry.p99JitterUs).toBeLessThan(5000);
  });

  test("DMX monitor parks channel through Rust engine and clears back to 0", async ({
    tauriPage,
  }) => {
    await tauriPage.getByRole("button", { name: /^Monitor$/i }).click();
    await tauriPage.getByTestId("universe-tab-1").click();
    await tauriPage.getByTestId("dmx-cell-1").click();

    const inspector = tauriPage.getByTestId("park-inspector");
    await expect(inspector).toBeVisible();
    await inspector.getByRole("button", { name: "192" }).click();

    await expect(tauriPage.getByTestId("topbar-park-override-badge")).toBeVisible();
    await expect
      .poll(async () => {
        const slice = await evalBridge(tauriPage, (b) => b.getDmxSlice(1, 1, 1));
        return slice[0]?.val ?? 0;
      })
      .toBe(192);

    await tauriPage.getByRole("button", { name: /Clear Parked/i }).click();

    await expect(tauriPage.getByTestId("topbar-park-override-badge")).toBeHidden();
    await expect
      .poll(async () => {
        const slice = await evalBridge(tauriPage, (b) => b.getDmxSlice(1, 1, 1));
        return slice[0]?.val ?? -1;
      })
      .toBe(0);
  });

  test("patches fixture via Rust backend, verifies canvas geometry, and undoes cleanly", async ({
    tauriPage,
  }) => {
    await tauriPage.getByRole("button", { name: /^Patch$/i }).click();
    const before = await evalBridge(tauriPage, (b) => b.getStatus().patchCount);

    await tauriPage.getByRole("button", { name: /Patch Fixture/i }).click();

    await expect
      .poll(async () => evalBridge(tauriPage, (b) => b.getStatus().patchCount))
      .toBe(before + 1);

    await tauriPage.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
    await expect(tauriPage.getByTestId("fixture-grid-canvas")).toBeVisible();

    const geom = await evalBridge(tauriPage, (b) => b.getCanvasGeometry());
    expect(geom).not.toBeNull();
    expect(geom!.fixtures.length).toBe(before + 1);

    // Undo patch to leave desktop state clean
    await tauriPage.getByRole("button", { name: /^Patch$/i }).click();
    await tauriPage.getByRole("button", { name: /^Undo$/i }).click();

    await expect
      .poll(async () => evalBridge(tauriPage, (b) => b.getStatus().patchCount))
      .toBe(before);
  });

  test("rapid scene color edit followed immediately by toggle off/on preserves value (TC-06 regression)", async ({
    tauriPage,
  }) => {
    await tauriPage.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
    await tauriPage.getByTestId("submode-builder").click();
    await tauriPage.locator("[data-testid^='scene-tile-']").first().click();

    await tauriPage.getByRole("button", { name: /^COLOR$/i }).click();
    const redInput = tauriPage.getByLabel("RED Channel Fader value");
    await expect(redInput).toBeVisible();
    await redInput.fill("128");
    await redInput.press("Enter");

    const toggleBtn = tauriPage.getByTestId("toggle-scene-controls-color");
    await expect(toggleBtn).toHaveAttribute("aria-pressed", "true");

    await toggleBtn.click();
    await expect(toggleBtn).toHaveAttribute("aria-pressed", "false");

    await toggleBtn.click();
    await expect(toggleBtn).toHaveAttribute("aria-pressed", "true");
    expect(Number(await redInput.inputValue())).toBe(128);
  });

  test("BLACKOUT overrides parked/active output and restores cleanly", async ({
    tauriPage,
  }) => {
    const blackoutBtn = tauriPage.getByRole("button", { name: /^BLACKOUT$/i });
    await blackoutBtn.click();
    await expect(blackoutBtn).toHaveAttribute("aria-pressed", "true");
    await expect(tauriPage.getByTestId("topbar-blackout-badge")).toBeVisible();
    const statusOn = await evalBridge(tauriPage, (b) => b.getStatus());
    expect(statusOn.blackout).toBe(true);

    await blackoutBtn.click();
    await expect(blackoutBtn).toHaveAttribute("aria-pressed", "false");
    await expect(tauriPage.getByTestId("topbar-blackout-badge")).toBeHidden();
    const statusOff = await evalBridge(tauriPage, (b) => b.getStatus());
    expect(statusOff.blackout).toBe(false);
  });

  test("creates CURVE FX scene with pulse waveform and outputs live Rust DMX", async ({
    tauriPage,
  }) => {
    await tauriPage.getByRole("button", { name: /^Patch$/i }).click();
    const initialPatch = await evalBridge(tauriPage, (b) => b.getStatus().patchCount);
    if (initialPatch === 0) {
      await tauriPage.getByRole("button", { name: /Patch Fixture/i }).click();
      await expect
        .poll(async () => evalBridge(tauriPage, (b) => b.getStatus().patchCount))
        .toBe(1);
    }

    await tauriPage.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
    await tauriPage.getByTestId("submode-builder").click();
    await tauriPage.getByTestId("quick-add-scene-Bank 1").click();

    await tauriPage.getByRole("button", { name: /^COLOR$/i }).click();
    const redInput = tauriPage.getByLabel("RED Channel Fader value");
    await redInput.fill("255");
    await redInput.press("Enter");

    await tauriPage.getByTestId("fx-picker-tile-curve_fx").click();
    await expect(tauriPage.getByTestId("fx-submenu-header-curve_fx")).toBeVisible();
    await tauriPage.getByLabel("FX Waveform").selectOption("pulse");
    await expect(tauriPage.getByLabel("Curve Duty Pct value")).toBeVisible();

    const scenes = await evalBridge(tauriPage, (b) => b.getScenes());
    const newest = scenes[scenes.length - 1];
    await tauriPage.getByTestId(`trigger-scene-${newest.id}`).click();
    await expect
      .poll(async () => {
        const slice = await evalBridge(tauriPage, (b) => b.getDmxSlice(1, 1, 1));
        return slice[0]?.val ?? 0;
      })
      .toBeGreaterThan(0);

    await tauriPage.getByRole("button", { name: /Release All Scenes/i }).click();
  });
});
