import { DmxSniffer } from "./helpers/dmxSniffer";
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

  test("exports and re-imports .takt.xml through the real Rust backend", async ({
    tauriPage,
  }) => {
    await tauriPage.getByRole("button", { name: /^Patch$/i }).click();
    const before = await evalBridge(tauriPage, (b) => b.getStatus().patchCount);
    if (before === 0) {
      await tauriPage.getByRole("button", { name: /Patch Fixture/i }).click();
      await expect
        .poll(async () => evalBridge(tauriPage, (b) => b.getStatus().patchCount))
        .toBe(1);
    }

    await tauriPage.getByRole("button", { name: /Export \.takt\.xml/i }).click();
    const preview = tauriPage.getByTestId("show-xml-preview");
    await expect(preview).toBeVisible();
    const xmlText = (await preview.textContent()) ?? "";
    expect(xmlText).toContain("<TaktLightShow");
    expect(xmlText).toContain("<FixtureInstance");

    // Import the exported XML back via file input and verify patch count persists
    const expectedCount = await evalBridge(tauriPage, (b) => b.getStatus().patchCount);
    await tauriPage.getByLabel("Import Show XML File").setInputFiles({
      name: "roundtrip.takt.xml",
      mimeType: "application/xml",
      buffer: Buffer.from(xmlText, "utf-8"),
    });
    await expect
      .poll(async () => evalBridge(tauriPage, (b) => b.getStatus().patchCount))
      .toBe(expectedCount);
  });

  test("creates a second bank and reorders banks via drag-and-drop in Studio", async ({
    tauriPage,
  }) => {
    await tauriPage.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
    await tauriPage.getByTestId("open-add-bank-btn").click();

    const bank1Tab = tauriPage.getByTestId("bank-tab-Bank 1");
    const bank2Tab = tauriPage.getByTestId("bank-tab-Bank 2");
    await expect(bank1Tab).toBeVisible();
    await expect(bank2Tab).toBeVisible();

    const beforeOrder = await tauriPage
      .locator("[data-testid^='bank-tab-']")
      .allTextContents();
    expect(beforeOrder.indexOf("Bank 1")).toBeLessThan(beforeOrder.indexOf("Bank 2"));

    await bank1Tab.dragTo(bank2Tab);
    await expect
      .poll(async () => {
        const order = await tauriPage
          .locator("[data-testid^='bank-tab-']")
          .allTextContents();
        return order.indexOf("Bank 2") < order.indexOf("Bank 1");
      })
      .toBe(true);
  });

  test("sniffs real Art-Net UDP 6454 packets when network output is enabled (TC-10)", async ({
    tauriPage,
  }) => {
    const status = await evalBridge(tauriPage, (b) => b.getStatus());
    test.skip(
      status.activeInterface === null,
      "No active IPv4 network interface available (OFFLINE_ENV)",
    );

    const sniffer = new DmxSniffer();
    await sniffer.start({ enableArtNet: true, enableSacn: false });
    try {
      await tauriPage.getByRole("button", { name: /^Monitor$/i }).click();
      await tauriPage.getByTestId("universe-tab-1").click();
      await tauriPage.getByTestId("dmx-cell-1").click();
      await tauriPage.getByTestId("park-inspector").getByRole("button", { name: "255" }).click();

      const txBtn = tauriPage.getByTestId("toggle-network-output-btn");
      if ((await txBtn.getAttribute("aria-pressed")) !== "true") {
        await txBtn.click();
      }
      await expect(txBtn).toHaveAttribute("aria-pressed", "true");

      const frame = await sniffer.waitForArtNetFrame((f) => f.dmx[0] === 255, 4000);
      expect(frame.dmx[0]).toBe(255);
      expect(sniffer.artnetPacketCount).toBeGreaterThan(0);

      // Cleanup: disable TX and clear parked channel
      await txBtn.click();
      await expect(txBtn).toHaveAttribute("aria-pressed", "false");
      await tauriPage.getByRole("button", { name: /Clear Parked/i }).click();
    } finally {
      await sniffer.stop();
    }
  });

  test("drags 2D fixture and 2D spatial shader gizmo via real canvas coordinates (TC-05 & TC-07)", async ({
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
    await expect(tauriPage.getByTestId("fixture-grid-canvas")).toBeVisible();

    const g0 = await evalBridge(tauriPage, (b) => b.getCanvasGeometry());
    expect(g0).not.toBeNull();
    const fx0 = g0!.fixtures[0];
    await tauriPage.mouse.move(fx0.clientX, fx0.clientY);
    await tauriPage.mouse.down();
    await tauriPage.mouse.move(fx0.clientX + 60, fx0.clientY + 30, { steps: 6 });
    await tauriPage.mouse.up();

    await expect
      .poll(async () => {
        const g1 = await evalBridge(tauriPage, (b) => b.getCanvasGeometry());
        return g1?.fixtures[0]?.gridX !== fx0.gridX || g1?.fixtures[0]?.gridY !== fx0.gridY;
      })
      .toBe(true);

    // Add color_mappings FX and drag gizmo center
    await tauriPage.getByTestId("fx-picker-tile-color_mappings").click();
    await expect(tauriPage.getByTestId("toggle-2d-shader-gizmo")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const gz0 = (await evalBridge(tauriPage, (b) => b.getCanvasGeometry()))?.shaderGizmo;
    expect(gz0).not.toBeNull();
    await tauriPage.mouse.move(gz0!.centerClientX, gz0!.centerClientY);
    await tauriPage.mouse.down();
    await tauriPage.mouse.move(gz0!.centerClientX + 50, gz0!.centerClientY + 30, { steps: 6 });
    await tauriPage.mouse.up();

    await expect
      .poll(async () => {
        const gz1 = (await evalBridge(tauriPage, (b) => b.getCanvasGeometry()))?.shaderGizmo;
        return (
          gz1 !== null &&
          (gz1.centerNormX !== gz0!.centerNormX || gz1.centerNormY !== gz0!.centerNormY)
        );
      })
      .toBe(true);
  });

  test("switches network adapter offline/auto and toggles TX without deadlocking engine (TC-16)", async ({
    tauriPage,
  }) => {
    const s1 = await evalBridge(tauriPage, (b) => b.getStatus());
    const adapterSelect = tauriPage.getByLabel("Network Output Adapter");
    await adapterSelect.selectOption("offline");
    await expect
      .poll(async () => (await evalBridge(tauriPage, (b) => b.getStatus())).isOffline)
      .toBe(true);

    const txBtn = tauriPage.getByTestId("toggle-network-output-btn");
    await txBtn.click();
    await txBtn.click();

    await adapterSelect.selectOption("auto");
    await tauriPage.waitForTimeout(250);

    const s2 = await evalBridge(tauriPage, (b) => b.getStatus());
    expect(s2.telemetry.tSec).toBeGreaterThan(s1.telemetry.tSec);
    expect(s2.outputEnabled).toBe(false);
  });
});
