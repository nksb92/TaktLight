import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import {
  buildOflFixtureJson,
  createDefaultBuilderDraft,
} from "./lib/oflBuilder";
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

    fireEvent.click(screen.getByRole("button", { name: /^Fixtures$/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /^Patch$/i }));

    expect(screen.getByTestId("patch-universe-1")).toBeInTheDocument();
    expect(screen.getByTestId("patch-universe-2")).toBeInTheDocument();
    expect(screen.getAllByText(/512 free \| largest block 512/)).toHaveLength(2);

    const rolloverSwitch = screen.getByRole("switch", { name: /Rollover/i });
    expect(rolloverSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(rolloverSwitch);
    expect(rolloverSwitch).toHaveAttribute("aria-checked", "false");

    fireEvent.keyDown(window, { key: "r" });
    expect(rolloverSwitch).toHaveAttribute("aria-checked", "true");

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
    // Rollover active: no red cross-protocol warning shown
    expect(screen.queryByText(/CROSS PROTOCOL SPLIT/i)).not.toBeInTheDocument();

    // Switching Rollover OFF exposes the cross-protocol warning
    fireEvent.click(rolloverSwitch);
    expect(screen.getByText(/CROSS PROTOCOL SPLIT/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "r" });
    expect(screen.queryByText(/CROSS PROTOCOL SPLIT/i)).not.toBeInTheDocument();

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

    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

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

    fireEvent.click(
      screen.getByRole("button", { name: /Rotate 90 Degrees/i }),
    );
    expect(
      useTaktStore.getState().showState.patch[0].grid_pos.rotation,
    ).toBeCloseTo(135);

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

describe("TaktLight Slice 4 Palettes & Smart Controls UI", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("creates referenceable palettes with Undo/Redo, stacks live layers, and quantizes RGBW DMX output", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube Stage",
        1,
        1,
        1,
      );

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    // Create Color Palette (#FFFFFF .. #FFFFFF)
    fireEvent.change(screen.getByLabelText("Color Palette Name"), {
      target: { value: "Studio Pure White" },
    });
    fireEvent.change(screen.getByLabelText("Color Start Hex"), {
      target: { value: "#FFFFFF" },
    });
    fireEvent.change(screen.getByLabelText("Color End Hex"), {
      target: { value: "#FFFFFF" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Save Color Palette/i }),
    );
    expect(screen.getByText("Studio Pure White")).toBeInTheDocument();

    // Create Dimmer Palette (0.5 .. 0.5) and verify Undo / Redo
    fireEvent.change(screen.getByLabelText("Dimmer Palette Name"), {
      target: { value: "Half Intensity" },
    });
    fireEvent.change(screen.getByLabelText("Dimmer Start Value"), {
      target: { value: "0.5" },
    });
    fireEvent.change(screen.getByLabelText("Dimmer End Value"), {
      target: { value: "0.5" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Save Dimmer Palette/i }),
    );
    expect(screen.getByText("Half Intensity")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Undo$/i }));
    expect(screen.queryByText("Half Intensity")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Redo$/i }));
    expect(screen.getByText("Half Intensity")).toBeInTheDocument();

    const createdColorPal = useTaktStore
      .getState()
      .showState.color_palettes.find((p) => p.name === "Studio Pure White")!;
    const createdDimPal = useTaktStore
      .getState()
      .showState.dimmer_palettes.find((p) => p.name === "Half Intensity")!;

    // Stack Dimmer HTP layer + Color LTP layer
    fireEvent.click(screen.getByRole("button", { name: /Add Dimmer Layer/i }));
    fireEvent.change(screen.getByLabelText("Layer 1 Palette"), {
      target: { value: createdDimPal.id },
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Color Layer/i }));
    fireEvent.change(screen.getByLabelText("Layer 2 Palette"), {
      target: { value: createdColorPal.id },
    });
    fireEvent.change(screen.getByLabelText("Layer 2 Order"), {
      target: { value: "mirror" },
    });

    const dmx = useTaktStore.getState().dmxByUniverse[1];
    // Master Dimmer Ch1 falls back to 255; Cell 1 White Ch6 receives quantized RGBW Replace White > 0
    expect(dmx[0]).toBe(255);
    expect(dmx[2]).toBe(0);
    expect(dmx[5]).toBeGreaterThan(0);
    expect(useTaktStore.getState().cellPreviewRgbd[0]).toBeGreaterThan(0);
    expect(screen.getByTestId("live-cell-preview")).toBeInTheDocument();
  });

  it("flags software strobe cap warning when requesting > 11 Hz on a fixture without hardware ShutterStrobe", async () => {
    const draft = createDefaultBuilderDraft();
    draft.name = "Basic RGB Par";
    draft.shortName = "RGBPar";
    draft.includeStrobe = false;
    draft.isMatrix = false;
    draft.colorMode = "rgb";
    draft.modeName = "4ch Par";
    const res = await useTaktStore
      .getState()
      .saveUserFixture("Basic RGB Par", buildOflFixtureJson(draft));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    await useTaktStore
      .getState()
      .patchFixtures(res.detail.summary.id, "4ch Par", "Par 1", 1, 1, 1);

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Add Shutter Layer/i }),
    );

    fireEvent.change(screen.getByLabelText("Layer 1 Shutter Mode"), {
      target: { value: "strobe_hz" },
    });
    fireEvent.change(screen.getByLabelText("Layer 1 Strobe Hz"), {
      target: { value: "16" },
    });

    expect(
      screen.getByText(/SOFTWARE STROBE CAPPED AT 11 HZ/i),
    ).toBeInTheDocument();
  });
});

describe("TaktLight Slice 5 Scenes & FX Engine UI", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("manages FX blocks, scenes with Undo/Redo, bank exclusivity, tap tempo, and live DMX output", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube Stage",
        1,
        1,
        1,
      );

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    // Tempo controls
    fireEvent.change(screen.getByLabelText("Live BPM"), {
      target: { value: "140" },
    });
    await Promise.resolve();
    expect(useTaktStore.getState().liveBpm).toBe(140);

    fireEvent.click(screen.getByRole("button", { name: /Tap Tempo/i }));
    await Promise.resolve();

    // Create an FX Block
    fireEvent.change(screen.getByLabelText("FX Block Name"), {
      target: { value: "Sine Wave Boost" },
    });
    fireEvent.change(screen.getByLabelText("FX Block Target Group"), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByLabelText("FX Block Duration Beats"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText("FX Generator Kind"), {
      target: { value: "curve_1d" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save FX Block/i }));
      await Promise.resolve();
    });

    const createdBlock = useTaktStore
      .getState()
      .showState.fx_library.find((b) => b.name === "Sine Wave Boost");
    expect(createdBlock).toBeDefined();
    expect(screen.getByText("Sine Wave Boost")).toBeInTheDocument();

    // Create a Scene in the "main" bank referencing the FX block + Undo/Redo
    fireEvent.change(screen.getByLabelText("Scene Name"), {
      target: { value: "Boost Wash" },
    });
    fireEvent.change(screen.getByLabelText("Scene Bank"), {
      target: { value: "main" },
    });
    fireEvent.change(screen.getByLabelText("Scene Priority"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText("Scene Fade In"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText("Scene Fade Out"), {
      target: { value: "0.5" },
    });
    fireEvent.change(screen.getByLabelText("Scene Block Ref"), {
      target: { value: createdBlock!.id },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Scene/i }));
    await Promise.resolve();

    expect(
      useTaktStore.getState().showState.scenes.some((s) => s.name === "Boost Wash"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^Undo$/i }));
    await Promise.resolve();
    expect(
      useTaktStore.getState().showState.scenes.some((s) => s.name === "Boost Wash"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /^Redo$/i }));
    await Promise.resolve();
    const createdScene = useTaktStore
      .getState()
      .showState.scenes.find((s) => s.name === "Boost Wash");
    expect(createdScene).toBeDefined();

    // Trigger starter Cyberpunk Wave scene -> outputs DMX Ch1 = 255
    fireEvent.click(screen.getByTestId("trigger-scene-sc_cyber_wave"));
    await Promise.resolve();
    expect(useTaktStore.getState().activeScenes).toHaveLength(1);
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(255);

    // Trigger Boost Wash in same "main" bank -> sc_cyber_wave enters release
    fireEvent.click(screen.getByTestId(`trigger-scene-${createdScene!.id}`));
    await Promise.resolve();
    const activeAfter = useTaktStore.getState().activeScenes;
    const cyberInst = activeAfter.find((s) => s.scene_id === "sc_cyber_wave");
    const boostInst = activeAfter.find((s) => s.scene_id === createdScene!.id);
    expect(cyberInst?.release_t_sec).not.toBeNull();
    expect(boostInst?.release_t_sec).toBeNull();

    // Release All Scenes
    fireEvent.click(
      screen.getByRole("button", { name: /Release All Scenes/i }),
    );
    await Promise.resolve();
    expect(
      useTaktStore
        .getState()
        .activeScenes.every((s) => s.release_t_sec !== null),
    ).toBe(true);

    expect(screen.getByTestId("scene-live-cell-preview")).toBeInTheDocument();
  });
});

describe("TaktLight Slice 6 Multi-Track Timeline & Transient Snap UI", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("analyzes audio transients, updates tempo/latency, snaps clips with Undo/Redo, and outputs live DMX", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube Stage",
        1,
        1,
        1,
      );

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Timeline$/i }));

    // Run audio analysis and inspect waveform/transient lane
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Analyze Audio/i }));
      await Promise.resolve();
    });

    const analysis =
      useTaktStore.getState().audioAnalysisByTimeline["tl_cyber_intro"];
    expect(analysis).toBeDefined();
    expect(analysis.transients.length).toBeGreaterThan(2);
    expect(screen.getByTestId("timeline-waveform-lane")).toBeInTheDocument();

    // Update signed latency offset and grid offset
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Latency Offset Ms"), {
        target: { value: "-10" },
      });
      fireEvent.change(screen.getByLabelText("Grid Offset Sec"), {
        target: { value: "0.12" },
      });
      fireEvent.change(screen.getByLabelText("Timeline Tempo BPM"), {
        target: { value: "120" },
      });
      await Promise.resolve();
    });
    expect(useTaktStore.getState().latencyOffsetMs).toBe(-10);

    // Add a Track and verify Undo / Redo
    fireEvent.change(screen.getByLabelText("New Track Name"), {
      target: { value: "Strobe Accent" },
    });
    fireEvent.change(screen.getByLabelText("New Track Target"), {
      target: { value: "all" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Add Track/i }));
      await Promise.resolve();
    });

    const getAccentTrack = () =>
      useTaktStore
        .getState()
        .showState.timelines.find((t) => t.id === "tl_cyber_intro")
        ?.tracks.find((tr) => tr.name === "Strobe Accent");
    expect(getAccentTrack()).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Undo$/i }));
      await Promise.resolve();
    });
    expect(getAccentTrack()).toBeUndefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Redo$/i }));
      await Promise.resolve();
    });
    const accentTrack = getAccentTrack()!;
    expect(accentTrack).toBeDefined();

    // Magnetic Snap is enabled: adding near 1.12s snaps to transient/grid ~1.12s
    const snapCheckbox = screen.getByLabelText(
      "Magnetic Snap",
    ) as HTMLInputElement;
    expect(snapCheckbox.checked).toBe(true);

    fireEvent.change(screen.getByLabelText("Clip Track"), {
      target: { value: accentTrack.id },
    });
    fireEvent.change(screen.getByLabelText("Clip Block Ref"), {
      target: { value: "blk_cyber_wave" },
    });
    fireEvent.change(screen.getByLabelText("Clip Start Sec"), {
      target: { value: "1.17" },
    });
    fireEvent.change(screen.getByLabelText("Clip Duration Sec"), {
      target: { value: "4.0" },
    });
    fireEvent.change(screen.getByLabelText("Clip Fade In Sec"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText("Clip Fade Out Sec"), {
      target: { value: "0.5" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Add Clip/i }));
      await Promise.resolve();
    });

    const addedClip = getAccentTrack()!.clips[0];
    expect(addedClip).toBeDefined();
    expect(addedClip.start_sec).not.toBe(1.17);
    expect(addedClip.start_sec).toBeCloseTo(1.12, 2);

    // Play / seek timeline -> outputs quantized DMX
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Timeline Playhead Sec"), {
        target: { value: "2.0" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Play Timeline/i }));
      await Promise.resolve();
    });

    expect(useTaktStore.getState().timelinePlaying).toBe(true);
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(255);
    expect(screen.getByTestId("timeline-live-cell-preview")).toBeInTheDocument();
  });
});

describe("TaktLight Slice 7 UI Consolidation & Centered Bottom Navigation", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("moves workspace tabs to centered bottom dock and hosts consolidated Studio workspace", () => {
    render(<App />);

    const header = screen.getByRole("banner");
    expect(within(header).queryByRole("navigation")).not.toBeInTheDocument();

    const dock = screen.getByTestId("bottom-nav-dock");
    const nav = within(dock).getByRole("navigation", { name: /Workspace Views/i });

    expect(within(nav).getByRole("button", { name: /^Patch$/i })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /Studio \/ 2D Grid/i })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /^Timeline$/i })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /^Fixtures$/i })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /^Monitor$/i })).toBeInTheDocument();

    fireEvent.click(within(nav).getByRole("button", { name: /Studio \/ 2D Grid/i }));
    expect(screen.getByTestId("fixture-grid-canvas")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Undo$/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Redo$/i })).toHaveLength(1);
  });
});
