import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { useTaktStore } from "./store/useTaktStore";

describe("TaktLight Slice 1 Studio UI", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("renders status bar, 512 DMX channels, and jitter histogram panel", () => {
    render(<App />);

    expect(screen.getByText("TAKTLIGHT")).toBeInTheDocument();
    expect(screen.getByText(/44\.0 Hz/)).toBeInTheDocument();
    expect(
      screen.getByText("44 Hz Frame Timing & Jitter Histogram"),
    ).toBeInTheDocument();

    expect(screen.getByTestId("dmx-cell-1")).toBeInTheDocument();
    expect(screen.getByTestId("dmx-cell-512")).toBeInTheDocument();
  });

  it("selects a channel, parks it, displays SIGNAL warning, and overrides blackout", () => {
    render(<App />);

    fireEvent.click(screen.getByTestId("dmx-cell-17"));
    expect(screen.getByTestId("park-inspector")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "255" }));
    expect(screen.getByText("PARK OVERRIDE: 1 CH")).toBeInTheDocument();
    expect(screen.getByTestId("dmx-cell-17")).toHaveTextContent("255");

    fireEvent.click(screen.getByRole("button", { name: /BLACKOUT/i }));
    expect(screen.getByText("BLACKOUT ACTIVE")).toBeInTheDocument();
    expect(screen.getByTestId("dmx-cell-17")).toHaveTextContent("255");

    fireEvent.click(screen.getByRole("button", { name: "HEX" }));
    expect(screen.getByTestId("dmx-cell-17")).toHaveTextContent("FF");

    fireEvent.click(screen.getByRole("button", { name: /Clear Parked/i }));
    expect(screen.queryByText(/PARK OVERRIDE:/)).not.toBeInTheDocument();
    expect(screen.getByTestId("dmx-cell-17")).toHaveTextContent("00");
  });

  it("switches universes and toggles jitter histogram visibility", () => {
    render(<App />);

    fireEvent.click(screen.getByTestId("universe-tab-2"));
    expect(screen.getByTestId("universe-tab-2")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const toggleBtn = screen.getByRole("button", { name: /Jitter Histogram/i });
    fireEvent.click(toggleBtn);
    expect(
      screen.queryByText("44 Hz Frame Timing & Jitter Histogram"),
    ).not.toBeInTheDocument();
  });

  it("switches to Fixture Builder, inspects RLCV3, builds a custom fixture, and flags invalid JSON paths", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Fixture Builder/i }));
    expect(screen.getByText("Local OFL Fixture Library")).toBeInTheDocument();
    expect(screen.getByText("RLCV3 8-Segment RGBW Tube")).toBeInTheDocument();
    expect(screen.getByText("RLCV4 16-Segment RGBW Tube")).toBeInTheDocument();

    // Start new custom fixture draft, edit name, and save to user library
    fireEvent.click(screen.getByRole("button", { name: /New Builder Draft/i }));
    const nameInput = screen.getByLabelText("Fixture Name");
    fireEvent.change(nameInput, { target: { value: "Studio Neon Bar" } });

    fireEvent.click(
      screen.getByRole("button", { name: /Save to User Library/i }),
    );
    expect(
      await screen.findByText("Studio Neon Bar"),
    ).toBeInTheDocument();

    // Switch to Raw JSON Editor and introduce invalid JSON / schema error
    fireEvent.click(screen.getByRole("button", { name: /Raw JSON Editor/i }));
    const editor = screen.getByLabelText("Raw OFL JSON Editor");
    fireEvent.change(editor, {
      target: {
        value: JSON.stringify({
          name: "",
          categories: ["Color Changer"],
          meta: {
            authors: ["Test"],
            createDate: "2026-11-18",
            lastModifyDate: "2026-11-18",
          },
          availableChannels: {
            Dimmer: { capability: { type: "Intensity" } },
          },
          modes: [{ name: "1ch", channels: ["Dimmer"] }],
        }),
      },
    });

    expect(await screen.findByText("SCHEMA INVALID")).toBeInTheDocument();
    expect(await screen.findByText(/\/name/)).toBeInTheDocument();
  });
});
