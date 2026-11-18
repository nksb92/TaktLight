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

describe("TaktLight Slice 3 Patch View & 2D Grid UI", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("supports dual-universe patching, rollover split toast + Undo/Redo, calibration, and .takt.xml export", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Patch View/i }));

    expect(screen.getByTestId("patch-universe-1")).toBeInTheDocument();
    expect(screen.getByTestId("patch-universe-2")).toBeInTheDocument();
    expect(screen.getAllByText(/512 free \| largest block 512/)).toHaveLength(2);

    const rolloverBtn = screen.getByRole("button", { name: /Rollover: ON/i });
    fireEvent.click(rolloverBtn);
    expect(
      screen.getByRole("button", { name: /Rollover: OFF/i }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "r" });
    expect(
      screen.getByRole("button", { name: /Rollover: ON/i }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name Prefix"), {
      target: { value: "Tube Left" },
    });
    fireEvent.change(screen.getByLabelText("Start Address"), {
      target: { value: "505" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Patch Fixtures/i }));

    expect(
      await screen.findByText(
        "Tube Left split: U1.505 to U1.512 + U2.001 to U2.026",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/CROSS PROTOCOL SPLIT/i)).toBeInTheDocument();

    const toastUndo = screen.getByTestId("toast-undo-button");
    fireEvent.click(toastUndo);
    expect(useTaktStore.getState().showState.patch).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /^Redo$/i }));
    expect(useTaktStore.getState().showState.patch).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Gamma"), {
      target: { value: "2.6" },
    });
    fireEvent.change(screen.getByLabelText("Min Dimmer DMX"), {
      target: { value: "12" },
    });
    fireEvent.change(screen.getByLabelText("White Mode"), {
      target: { value: "add" },
    });

    const cal = useTaktStore.getState().showState.patch[0].calibration;
    expect(cal.gamma).toBeCloseTo(2.6);
    expect(cal.min_dimmer_dmx).toBe(12);
    expect(cal.white_mode).toBe("add");

    fireEvent.click(screen.getByRole("button", { name: /Export .takt.xml/i }));
    const xmlPreview = await screen.findByTestId("show-xml-preview");
    expect(xmlPreview).toHaveTextContent('<TaktLightShow version="1.0"');
    expect(xmlPreview).toHaveTextContent('profile="age/rlcv3_8_segment_tube.json"');
  });

  it("renders 2D Fixture Grid, updates GridPos, and previews 1D OrderRule & TargetRef mapping", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube A",
        1,
        1,
        1,
      );

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /2D Grid/i }));

    expect(screen.getByTestId("fixture-grid-canvas")).toBeInTheDocument();
    expect(screen.getByText("Tube A")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Grid X"), {
      target: { value: "0.35" },
    });
    fireEvent.change(screen.getByLabelText("Grid Rotation"), {
      target: { value: "45" },
    });

    const pos = useTaktStore.getState().showState.patch[0].grid_pos;
    expect(pos.x).toBeCloseTo(0.35);
    expect(pos.rotation).toBeCloseTo(45);

    fireEvent.change(screen.getByLabelText("Order Rule"), {
      target: { value: "center_out" },
    });
    fireEvent.change(screen.getByLabelText("Target Reference"), {
      target: { value: "fx_001:7..0" },
    });

    const preview = screen.getByTestId("order-rule-preview");
    expect(preview).toHaveTextContent("Cell 7");
    expect(preview).toHaveTextContent("Cell 0");
    expect(preview).toHaveTextContent("u=1.00");
  });
});
