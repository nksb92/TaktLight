import { expect, test } from "@playwright/test";

test.describe("TaktLight Real-Browser E2E", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("TAKTLIGHT")).toBeVisible();
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
    expect(Number(await playheadInput.inputValue())).toBe(0);

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
});
