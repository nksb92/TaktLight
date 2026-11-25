import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { useTaktStore } from "../../store/useTaktStore";
import { seedTestFixturesInStore, TEST_TUBE_8SEG_ID } from "../../test/testFixtures";

async function mountStudioWithTube() {
  await useTaktStore
    .getState()
    .patchFixtures(
      TEST_TUBE_8SEG_ID,
      "34ch Pixel Mode",
      "Tube Dock",
      1,
      1,
      1,
    );
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));
}

describe("Palettes, Static Dock Controls & Live Mixer Normal Usage", () => {
  beforeEach(() => {
    if (typeof window.PointerEvent === "undefined") {
      (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
        MouseEvent;
    }
    useTaktStore.getState().resetForTest();
    seedTestFixturesInStore();
  });

  it("edits RGB channels, preserves color across toggle off/on, and picks color via HS square", async () => {
    await mountStudioWithTube();

    // Raise dimmer so color DMX is visible when triggered
    fireEvent.click(screen.getByTestId("trait-tab-dimmer"));
    await act(async () => {
      const dim = screen.getByLabelText("Channel Dimmer Fader value");
      fireEvent.change(dim, { target: { value: "100" } });
      fireEvent.blur(dim);
      await Promise.resolve();
    });

    // Switch to COLOR tab, set RED=200, GREEN=64, BLUE=16
    fireEvent.click(screen.getByTestId("trait-tab-color"));
    await act(async () => {
      const r = screen.getByLabelText("RED Channel Fader value");
      fireEvent.change(r, { target: { value: "200" } });
      fireEvent.blur(r);
      const g = screen.getByLabelText("GREEN Channel Fader value");
      fireEvent.change(g, { target: { value: "64" } });
      fireEvent.blur(g);
      await Promise.resolve();
    });

    const toggleColor = screen.getByTestId("toggle-scene-controls-color");
    expect(toggleColor).toHaveAttribute("aria-pressed", "true");

    // Toggle OFF then ON -> RED value preserved
    await act(async () => {
      fireEvent.click(toggleColor);
      await Promise.resolve();
    });
    expect(toggleColor).toHaveAttribute("aria-pressed", "false");
    await act(async () => {
      fireEvent.click(toggleColor);
      await Promise.resolve();
    });
    expect(toggleColor).toHaveAttribute("aria-pressed", "true");
    expect(
      Number((screen.getByLabelText("RED Channel Fader value") as HTMLInputElement).value),
    ).toBe(200);

    // Click inside 2D HS color square -> updates color channels
    const hsSquare = screen.getByTestId("color-hs-square");
    Object.defineProperty(hsSquare, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }),
    });
    await act(async () => {
      fireEvent.pointerDown(hsSquare, { clientX: 66, clientY: 10, pointerId: 1 });
      fireEvent.pointerUp(hsSquare, { clientX: 66, clientY: 10, pointerId: 1 });
      await Promise.resolve();
    });
    const blueAfterPick = Number(
      (screen.getByLabelText("BLUE Channel Fader value") as HTMLInputElement).value,
    );
    expect(blueAfterPick).toBeGreaterThan(150);
  });

  it("links a saved color palette directly onto the active scene from the COLOR dock", async () => {
    await mountStudioWithTube();

    fireEvent.click(screen.getByTestId("trait-tab-color"));
    const firstPal = useTaktStore.getState().showState.color_palettes[0];
    await act(async () => {
      fireEvent.click(screen.getByTestId(`link-palette-${firstPal.id}`));
      await Promise.resolve();
    });

    const blk = useTaktStore
      .getState()
      .showState.fx_library.find((b) => b.id === "blk_scene_sc_new_1");
    expect(blk?.elements.some((e) => e.kind !== "scene_sequence" && e.trait === "color")).toBe(true);
  });
});
