import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { PatchView } from "../PatchView";
import { useTaktStore } from "../../store/useTaktStore";

describe("PatchView & FixtureBuilder Normal Usage", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("bulk-patches fixtures, rejects colliding addresses, unpatches with Undo, and switches universe protocol", async () => {
    render(<PatchView />);

    // Bulk patch 3 tubes starting at U1.001 (34ch each -> 1..34, 35..68, 69..102)
    fireEvent.change(screen.getByLabelText("Name Prefix"), {
      target: { value: "Stage Tube" },
    });
    fireEvent.change(screen.getByLabelText("Fixture Count"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText("Start Address"), {
      target: { value: "1" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/Patch Fixtures/i));
      await Promise.resolve();
    });
    expect(useTaktStore.getState().showState.patch).toHaveLength(3);
    expect(useTaktStore.getState().showState.patch[1].address).toBe(35);
    expect(useTaktStore.getState().showState.patch[2].address).toBe(69);

    // Attempt to patch on occupied address U1.010 -> auto-advances past collision to U1.103 (zero overlap)
    fireEvent.change(screen.getByLabelText("Fixture Count"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Start Address"), {
      target: { value: "10" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/Patch Fixtures/i));
      await Promise.resolve();
    });
    const afterCollisionPatch = useTaktStore.getState().showState.patch;
    expect(afterCollisionPatch).toHaveLength(4);
    expect(afterCollisionPatch[3].address).toBe(103);

    // Unpatch first fixture and Undo restores it
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Unpatch Stage Tube 1"));
      await Promise.resolve();
    });
    expect(useTaktStore.getState().showState.patch).toHaveLength(3);
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Undo"));
      await Promise.resolve();
    });
    expect(useTaktStore.getState().showState.patch).toHaveLength(4);

    // Switch Universe 1 protocol from Art-Net to sACN and update sACN Universe + Priority
    fireEvent.click(screen.getByTestId("universe-protocol-btn-1"));
    expect(screen.getByTestId("universe-protocol-popover-1")).toBeInTheDocument();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Universe 1 Protocol"), {
        target: { value: "sacn" },
      });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Universe 1 sACN Universe"), {
        target: { value: "5" },
      });
      fireEvent.change(screen.getByLabelText("Universe 1 sACN Priority"), {
        target: { value: "150" },
      });
      await Promise.resolve();
    });
    const u1Proto = useTaktStore
      .getState()
      .showState.network_outputs.universes.find((u) => u.id === 1)?.protocol;
    expect(u1Proto?.protocol).toBe("sacn");
    if (u1Proto?.protocol === "sacn") {
      expect(u1Proto.sacn_universe).toBe(5);
      expect(u1Proto.priority).toBe(150);
    }
  }, 60000);

  it("builds a multi-mode custom fixture in FixtureBuilder, saves to user library, and deletes it", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Fixtures$/i }));

    fireEvent.click(screen.getByRole("button", { name: /New Builder Draft/i }));
    // Starts with 0 modes (no automatic mode created)
    expect(screen.getByText(/Modes \(0\)/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Fixture Name"), {
      target: { value: "Custom Dual Mode Bar" },
    });

    // Add two DMX modes via add-mode-btn
    fireEvent.click(screen.getByTestId("add-mode-btn"));
    fireEvent.click(screen.getByTestId("add-mode-btn"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save to User Library/i }));
      await Promise.resolve();
    });

    const saved = useTaktStore
      .getState()
      .fixtureSummaries.find((f) => f.name === "Custom Dual Mode Bar");
    expect(saved).toBeDefined();
    expect(saved!.modes.length).toBeGreaterThanOrEqual(2);

    // Delete the custom user fixture cleanly
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete Custom Dual Mode Bar"));
      await Promise.resolve();
    });
    expect(
      useTaktStore
        .getState()
        .fixtureSummaries.some((f) => f.name === "Custom Dual Mode Bar"),
    ).toBe(false);
  });

  it("keeps Red-Green-Blue channel order when adding a mode to a fixture with alphabetically sorted templateChannels", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Fixtures$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Raw JSON Editor/i }));

    const alphabeticalJson = JSON.stringify(
      {
        $schema:
          "https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/fixture.json",
        name: "Alpha Keys Tube",
        shortName: "AlphaTube",
        categories: ["Pixel Bar"],
        meta: {
          authors: ["Test"],
          createDate: "2026-11-23",
          lastModifyDate: "2026-11-23",
        },
        matrix: { pixelCount: [4, 1, 1] },
        availableChannels: {
          "Master Dimmer": {
            defaultValue: 0,
            capability: { type: "Intensity" },
          },
        },
        templateChannels: {
          "Blue $pixelKey": {
            defaultValue: 0,
            capability: { type: "ColorIntensity", color: "Blue" },
          },
          "Green $pixelKey": {
            defaultValue: 0,
            capability: { type: "ColorIntensity", color: "Green" },
          },
          "Red $pixelKey": {
            defaultValue: 0,
            capability: { type: "ColorIntensity", color: "Red" },
          },
        },
        modes: [
          {
            name: "Mode 1",
            shortName: "M1",
            channels: [
              "Master Dimmer",
              {
                insert: "matrixChannels",
                repeatFor: "eachPixelABC",
                channelOrder: "perPixel",
                templateChannels: [
                  "Red $pixelKey",
                  "Green $pixelKey",
                  "Blue $pixelKey",
                ],
              },
            ],
          },
        ],
      },
      null,
      2,
    );

    const textarea = screen.getByLabelText("Raw OFL JSON Editor") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: alphabeticalJson } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("add-mode-btn"));
      await Promise.resolve();
    });

    const updated = JSON.parse(textarea.value) as {
      modes: Array<{
        channels: Array<string | { insert?: string; templateChannels?: string[] }>;
      }>;
    };
    expect(updated.modes).toHaveLength(2);
    const matrixInsert = updated.modes[1].channels.find(
      (c): c is { insert?: string; templateChannels?: string[] } =>
        typeof c === "object" && c !== null && c.insert === "matrixChannels",
    );
    expect(matrixInsert?.templateChannels).toEqual([
      "Red $pixelKey",
      "Green $pixelKey",
      "Blue $pixelKey",
    ]);
  });

  it("lets the user select RGB order and white/CCT mode independently in Visual Builder", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Fixtures$/i }));
    fireEvent.click(screen.getByRole("button", { name: /New Builder Draft/i }));

    fireEvent.change(screen.getByLabelText("RGB Color Order"), {
      target: { value: "GRB" },
    });
    fireEvent.change(screen.getByLabelText("White Channel Mode"), {
      target: { value: "ww_cw" },
    });
    fireEvent.change(screen.getByLabelText("White Channel Position"), {
      target: { value: "before" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("add-mode-btn"));
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /Raw JSON Editor/i }));
    const textarea = screen.getByLabelText(
      "Raw OFL JSON Editor",
    ) as HTMLTextAreaElement;
    const parsed = JSON.parse(textarea.value) as {
      modes: Array<{
        channels: Array<string | { insert?: string; templateChannels?: string[] }>;
      }>;
    };
    const matrixInsert = parsed.modes[0].channels.find(
      (c): c is { insert?: string; templateChannels?: string[] } =>
        typeof c === "object" && c !== null && c.insert === "matrixChannels",
    );
    expect(matrixInsert?.templateChannels).toEqual([
      "Warm White $pixelKey",
      "Cold White $pixelKey",
      "Green $pixelKey",
      "Red $pixelKey",
      "Blue $pixelKey",
    ]);
  });
});
