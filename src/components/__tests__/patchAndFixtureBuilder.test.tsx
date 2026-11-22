import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { useTaktStore } from "../../store/useTaktStore";

describe("PatchView & FixtureBuilder Normal Usage", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("bulk-patches fixtures, rejects colliding addresses, unpatches with Undo, and switches universe protocol", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Patch$/i }));

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
      fireEvent.click(screen.getByRole("button", { name: /Patch Fixtures/i }));
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
      fireEvent.click(screen.getByRole("button", { name: /Patch Fixtures/i }));
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
      fireEvent.click(screen.getByRole("button", { name: /^Undo$/i }));
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
  }, 15000);

  it("builds a multi-mode custom fixture in FixtureBuilder, saves to user library, and deletes it", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Fixtures$/i }));

    fireEvent.click(screen.getByRole("button", { name: /New Builder Draft/i }));
    fireEvent.change(screen.getByLabelText("Fixture Name"), {
      target: { value: "Custom Dual Mode Bar" },
    });

    // Add a second DMX mode via add-mode-btn
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
});
