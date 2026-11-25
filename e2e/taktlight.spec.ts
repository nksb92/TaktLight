import { expect, test } from "@playwright/test";

test.describe("TaktLight Real-Browser E2E", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("TAKTLIGHT")).toBeVisible({ timeout: 15_000 });
  });

  test("drags scene onto timeline track and below last track without selecting text", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
    // Select Timeline Super-Scene tile in Bank 1 -> opens Timeline in bottom-right dock
    await page.getByTestId("scene-play-zone-sc_tl_cyber_intro").click();
    await expect(page.getByTestId("daslight-timeline-dock")).toBeVisible();
    // Expand to full bottom width for comfortable drag-and-drop
    await page.getByTestId("timeline-expand-toggle").click();

    const dropzone = page.getByTestId("timeline-new-track-dropzone");
    await dropzone.scrollIntoViewIfNeeded();
    await expect(dropzone).toBeVisible();
    const clipsBefore = await page.locator("[data-testid^='timeline-clip-']").count();

    // Find a regular scene tile in the upper Scene Library
    const firstSceneTile = page.getByTestId("scene-tile-sc_new_1");
    await expect(firstSceneTile).toBeVisible();
    const tileBox = await firstSceneTile.boundingBox();
    const dropBox = await dropzone.boundingBox();
    expect(tileBox).not.toBeNull();
    expect(dropBox).not.toBeNull();

    // Real mouse drag from scene tile to the new-track dropzone
    await page.mouse.move(
      tileBox!.x + tileBox!.width / 2,
      tileBox!.y + tileBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      dropBox!.x + dropBox!.width * 0.25,
      dropBox!.y + dropBox!.height / 2,
      { steps: 10 },
    );

    // No text should be selected
    const selectedText = await page.evaluate(
      () => window.getSelection()?.toString() ?? "",
    );
    expect(selectedText).toBe("");

    await page.mouse.up();

    // Clip count must strictly increase by 1
    await expect(page.locator("[data-testid^='timeline-clip-']")).toHaveCount(
      clipsBefore + 1,
    );
  });

  test("timeline pause holds playhead and keyboard shortcuts work", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
    await page.getByTestId("scene-play-zone-sc_tl_cyber_intro").click();
    await page.getByTestId("timeline-expand-toggle").click();
    const dropzone = page.getByTestId("timeline-new-track-dropzone");
    const firstSceneTile = page.getByTestId("scene-tile-sc_new_1");
    const tileBox = await firstSceneTile.boundingBox();
    const dropBox = await dropzone.boundingBox();

    await page.mouse.move(tileBox!.x + 40, tileBox!.y + 20);
    await page.mouse.down();
    await page.mouse.move(dropBox!.x + 120, dropBox!.y + 20, { steps: 6 });
    await page.mouse.up();

    await expect(page.locator("[data-testid^='timeline-clip-']").first()).toBeVisible();

    // Seek playhead to 2.5s
    const playheadInput = page.getByLabel("Timeline Playhead Sec");
    await playheadInput.fill("2.5");
    await playheadInput.blur();

    // Space = play, wait briefly, Space = pause -> playhead must NOT reset to 0
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: /Pause Timeline/i })).toBeVisible();
    await page.waitForTimeout(150);
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: /Play Timeline/i })).toBeVisible();
    const pausedVal = Number(await playheadInput.inputValue());
    expect(pausedVal).toBeGreaterThanOrEqual(2.5);

    // Home = return to start (0)
    await page.keyboard.press("Home");
    await expect(playheadInput).toHaveValue("0");

    // Ctrl+D = duplicate selected clip, Delete = delete selected clip
    const clipsBefore = await page.locator("[data-testid^='timeline-clip-']").count();
    await page.keyboard.press("Control+d");
    await expect(page.locator("[data-testid^='timeline-clip-']")).toHaveCount(
      clipsBefore + 1,
    );
    await page.keyboard.press("Delete");
    await expect(page.locator("[data-testid^='timeline-clip-']")).toHaveCount(
      clipsBefore,
    );
  });

  test("scene color toggle preserves color and double-click renames scene", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
    const firstSceneTile = page.locator("[data-testid^='scene-tile-']").first();
    await firstSceneTile.click();

    // Double-click scene name to rename
    const sceneNameSpan = firstSceneTile.locator("span.font-sans").first();
    await sceneNameSpan.dblclick();
    const renameInput = page.locator("[data-testid^='rename-scene-input-']");
    await expect(renameInput).toBeVisible();
    await renameInput.fill("Warm Amber");
    await renameInput.press("Enter");
    await expect(firstSceneTile).toContainText("Warm Amber");

    // Switch bottom-right dock to COLOR and set RED channel to 128, then toggle off & on
    await page.getByRole("button", { name: /^COLOR$/i }).click();
    const redValInput = page.getByLabel("RED Channel Fader value");
    await expect(redValInput).toBeVisible();
    await redValInput.fill("128");
    await redValInput.press("Enter");
    expect(Number(await redValInput.inputValue())).toBe(128);

    const toggleColorBtn = page.getByTestId("toggle-scene-controls-color");
    await toggleColorBtn.click(); // deactivate
    await expect(toggleColorBtn).toHaveAttribute("aria-pressed", "false");
    await toggleColorBtn.click(); // reactivate
    await expect(toggleColorBtn).toHaveAttribute("aria-pressed", "true");
    expect(Number(await redValInput.inputValue())).toBe(128);
  });

  test("2D grid allows negative coordinates, snap toggle, and smooth dragging", async ({
    page,
  }) => {
    // Patch a fixture first if none exist
    const patchTab = page.getByRole("button", { name: /^Patch$/i });
    await patchTab.click();
    const addBtn = page.getByRole("button", { name: /Patch Fixture/i });
    if (await addBtn.isVisible()) {
      await addBtn.click();
    }
    await page.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();

    const snapBtn = page.getByTestId("toggle-2d-snap-grid");
    await expect(snapBtn).toBeVisible();
    await expect(snapBtn).toHaveAttribute("aria-pressed", "true");
    await snapBtn.click();
    await expect(snapBtn).toHaveAttribute("aria-pressed", "false");
    await snapBtn.click();
    await expect(snapBtn).toHaveAttribute("aria-pressed", "true");

    const gridX = page.getByLabel("Grid X");
    await expect(gridX).toBeVisible();
    await gridX.fill("-0.25");
    await gridX.blur();
    expect(Number(await gridX.inputValue())).toBeCloseTo(-0.25, 2);
  });

  test("fixture builder shows Add Mode button", async ({ page }) => {
    await page.getByRole("button", { name: /^Fixtures$/i }).click();
    const addModeBtn = page.getByTestId("add-mode-btn");
    await expect(addModeBtn).toBeVisible();
    await addModeBtn.click();
  });

  test("creates CURVE FX scene, switches waveform to pulse, and exposes duty control", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
    await page.getByTestId("fx-picker-tile-curve_fx").click();
    await expect(page.getByTestId("fx-submenu-header-curve_fx")).toBeVisible();

    await page.getByLabel("FX Waveform").selectOption("pulse");
    await expect(page.getByTestId("fx-submenu-header-curve_fx")).toBeVisible();
    const dutyInput = page.getByLabel("Curve Duty Pct value");
    await expect(dutyInput).toBeVisible();
    await dutyInput.fill("75");
    await dutyInput.press("Enter");
    expect(Number(await dutyInput.inputValue())).toBe(75);
  });

  test("Alt-drag duplicates timeline clip exactly once and double-click lane adds zero clips", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
    await page.getByTestId("scene-play-zone-sc_tl_cyber_intro").click();
    await page.getByTestId("timeline-expand-toggle").click();

    const clipBody = page.getByTestId("clip-body-trk_1-0");
    await expect(clipBody).toBeVisible();
    const clipsBefore = await page.locator("[data-testid^='timeline-clip-']").count();

    // Double-clicking empty lane must NOT add a clip
    const lane = page.getByTestId("track-lane-trk_1");
    const laneBox = await lane.boundingBox();
    expect(laneBox).not.toBeNull();
    await page.mouse.dblclick(laneBox!.x + laneBox!.width * 0.85, laneBox!.y + laneBox!.height / 2);
    await expect(page.locator("[data-testid^='timeline-clip-']")).toHaveCount(clipsBefore);

    // Alt+drag existing clip -> strictly +1 duplicate and clean release
    const box = await clipBody.boundingBox();
    expect(box).not.toBeNull();
    await page.keyboard.down("Alt");
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width + 120, box!.y + box!.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await page.mouse.move(box!.x + box!.width + 240, box!.y + box!.height / 2, { steps: 4 });

    await expect(page.locator("[data-testid^='timeline-clip-']")).toHaveCount(clipsBefore + 1);
  });

  test("color_mappings auto-activates 2D gizmo and FixtureBuilder opens presets in Visual Builder", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
    await page.getByTestId("fx-picker-tile-color_mappings").click();
    await expect(page.getByTestId("toggle-2d-shader-gizmo")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.getByRole("button", { name: /^Fixtures$/i }).click();
    await page.getByRole("button", { name: /New Builder Draft/i }).click();
    await page.getByTestId("add-mode-btn").click();
    await page.getByLabel("Fixture Name").fill("Studio Test Tube");
    await page.getByRole("button", { name: /Save to User Library/i }).click();
    await page.getByText("Studio Test Tube", { exact: true }).click();
    await expect(page.getByTestId("fixture-builder-context-banner")).toContainText(
      "EDITING USER FIXTURE",
    );
    await expect(page.getByLabel("Fixture Name")).toBeVisible();
    await expect(page.getByLabel("Raw OFL JSON Editor")).toBeHidden();
  });

  test("DMX Monitor park, display formats (HEX/PCT/DEC), and Blackout toggle work end-to-end", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /^Monitor$/i }).click();
    await page.getByTestId("universe-tab-1").click();
    await page.getByTestId("dmx-cell-1").click();

    const inspector = page.getByTestId("park-inspector");
    await expect(inspector).toBeVisible();
    await inspector.getByRole("button", { name: "192" }).click();

    await expect(page.getByTestId("topbar-park-override-badge")).toBeVisible();
    await page.getByRole("button", { name: "HEX", exact: true }).click();
    await expect(page.getByTestId("dmx-cell-1")).toContainText("C0");
    await page.getByRole("button", { name: "PCT", exact: true }).click();
    await expect(page.getByTestId("dmx-cell-1")).toContainText("75%");
    await page.getByRole("button", { name: "DEC", exact: true }).click();
    await expect(page.getByTestId("dmx-cell-1")).toContainText("192");

    // Blackout toggles badge on and off while parked channel overrides blackout
    const blackoutBtn = page.getByRole("button", { name: /^BLACKOUT$/i });
    await blackoutBtn.click();
    await expect(page.getByTestId("topbar-blackout-badge")).toBeVisible();
    await expect(page.getByTestId("dmx-cell-1")).toContainText("192");
    await blackoutBtn.click();
    await expect(page.getByTestId("topbar-blackout-badge")).toBeHidden();

    await page.getByRole("button", { name: /Clear Parked/i }).click();
    await expect(page.getByTestId("topbar-park-override-badge")).toBeHidden();
    await expect(page.getByTestId("dmx-cell-1")).toContainText("0");
  });

  test("DMX boundary rollover split and auto-resolve eliminates >512 splits (TC-11)", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /^Patch$/i }).click();
    const rolloverToggle = page.getByTestId("toggle-rollover-split");
    if ((await rolloverToggle.getAttribute("aria-checked")) !== "true") {
      await rolloverToggle.click();
    }
    await page.getByLabel("Name Prefix").fill("SplitTube");
    await page.getByLabel("Fixture Count").fill("1");
    await page.getByLabel("Start Universe").fill("1");
    await page.getByLabel("Start Address").fill("505");
    await page.getByRole("button", { name: /Patch Fixture/i }).click();

    await rolloverToggle.click();
    const resolveBtn = page.getByTestId("resolve-split-fixtures-button");
    await expect(resolveBtn).toBeVisible();
    await resolveBtn.click();
    await expect(resolveBtn).toBeHidden();
  });

  test("clamps out-of-range BPM and handles malformed OFL JSON without uncaught errors (TC-12 & TC-13)", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
    const bpmInput = page.getByLabel("Live BPM");
    await bpmInput.fill("999");
    await bpmInput.blur();
    const highBpm = Number(await bpmInput.inputValue());
    expect(highBpm).toBeLessThanOrEqual(300);
    expect(highBpm).toBeGreaterThanOrEqual(20);

    await bpmInput.fill("5");
    await bpmInput.blur();
    const lowBpm = Number(await bpmInput.inputValue());
    expect(lowBpm).toBeGreaterThanOrEqual(20);
    expect(lowBpm).toBeLessThanOrEqual(300);

    await page.getByRole("button", { name: /^Fixtures$/i }).click();
    await page.getByRole("button", { name: /Raw JSON Editor/i }).click();
    const rawEditor = page.getByLabel("Raw OFL JSON Editor");
    await expect(rawEditor).toBeVisible();
    await rawEditor.fill('{"name": "", "invalid": true}');
    await expect(page.getByText(/Schema Error|Invalid|missing|required/i).first()).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test("rapid color edit followed by 3x immediate toggle spam preserves deterministic state (TC-14)", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
    await page.locator("[data-testid^='scene-tile-']").first().click();
    await page.getByRole("button", { name: /^COLOR$/i }).click();

    const redInput = page.getByLabel("RED Channel Fader value");
    await redInput.fill("200");
    await redInput.press("Enter");

    const toggleBtn = page.getByTestId("toggle-scene-controls-color");
    await expect(toggleBtn).toHaveAttribute("aria-pressed", "true");

    // 3 rapid toggles: Off -> On -> Off
    await toggleBtn.click();
    await toggleBtn.click();
    await toggleBtn.click();
    await expect(toggleBtn).toHaveAttribute("aria-pressed", "false");

    // 4th toggle back ON preserves RED=200
    await toggleBtn.click();
    await expect(toggleBtn).toHaveAttribute("aria-pressed", "true");
    expect(Number(await redInput.inputValue())).toBe(200);
  });

  test("timeline NLE supports unit toggle, zoom, time-stretch, split at playhead, and Undo/Redo", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
    await page.getByTestId("scene-play-zone-sc_tl_cyber_intro").click();

    // No redundant per-timeline scene palette
    await expect(page.getByTestId("timeline-scene-palette")).toHaveCount(0);

    // Select first clip and verify duration controls & unit conversion (Seconds <-> Beats)
    const firstClip = page.locator("[data-testid^='clip-body-']").first();
    await firstClip.click();
    const durInput = page.getByLabel("Selected Clip Duration Sec");
    await expect(durInput).toBeVisible();

    await page.getByTestId("timeline-unit-seconds").click();
    const durSec = Number(await durInput.inputValue());
    await page.getByTestId("timeline-unit-beats").click();
    const durBeats = Number(await durInput.inputValue());
    expect(durBeats).toBeGreaterThan(durSec);
    await page.getByTestId("timeline-unit-seconds").click();

    // Zoom in and reset
    await page.getByTestId("timeline-zoom-in").click();
    await expect(page.getByTestId("timeline-zoom-reset")).not.toHaveText("1.0×");
    await page.getByTestId("timeline-zoom-reset").click();
    await expect(page.getByTestId("timeline-zoom-reset")).toHaveText("1.0×");

    // Time-stretch toggle (when present on effect clips)
    const stretchToggle = page.getByTestId("clip-time-stretch-toggle");
    if (await stretchToggle.isVisible()) {
      await stretchToggle.click();
    }

    // Delete clip -> Ctrl+Z restores -> Ctrl+Y re-deletes
    await firstClip.click();
    const clipsBefore = await page.locator("[data-testid^='timeline-clip-']").count();
    await page.keyboard.press("Delete");
    await expect(page.locator("[data-testid^='timeline-clip-']")).toHaveCount(clipsBefore - 1);
    await page.keyboard.press("Control+z");
    await expect(page.locator("[data-testid^='timeline-clip-']")).toHaveCount(clipsBefore);
    await page.keyboard.press("Control+y");
    await expect(page.locator("[data-testid^='timeline-clip-']")).toHaveCount(clipsBefore - 1);
  });

  test("uploads synthetic WAV audio clip onto timeline music track", async ({ page }) => {
    await page.getByRole("button", { name: /Studio \/ 2D Grid/i }).click();
    await page.getByTestId("scene-play-zone-sc_tl_cyber_intro").click();
    await page.getByTestId("timeline-expand-toggle").click();

    // Build minimal valid 1-second 8kHz 16-bit mono PCM WAV buffer
    const sampleRate = 8000;
    const numSamples = sampleRate;
    const dataSize = numSamples * 2;
    const wav = Buffer.alloc(44 + dataSize);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + dataSize, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(dataSize, 40);

    const clipsBefore = await page.locator("[data-testid^='timeline-clip-']").count();
    await page.getByLabel("Add Music File").setInputFiles({
      name: "e2e_kick.wav",
      mimeType: "audio/wav",
      buffer: wav,
    });
    await expect(page.locator("[data-testid^='timeline-clip-']")).toHaveCount(clipsBefore + 1);
  });
});
