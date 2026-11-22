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

  it("lands on Patch by default and renders Monitor status bar, 512 DMX channels, and jitter histogram panel", () => {
    render(<App />);

    expect(screen.getByText("TAKTLIGHT")).toBeInTheDocument();
    expect(screen.getByText(/44\.0 Hz/)).toBeInTheDocument();
    expect(screen.getByTestId("patch-universe-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Monitor$/i }));
    expect(
      screen.getByText("44 Hz Frame Timing & Jitter Histogram"),
    ).toBeInTheDocument();

    expect(screen.getByTestId("dmx-cell-1")).toBeInTheDocument();
    expect(screen.getByTestId("dmx-cell-512")).toBeInTheDocument();
  });

  it("selects a channel, parks it, displays SIGNAL warning, and overrides blackout", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Monitor$/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /^Monitor$/i }));
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

    // Switching away from Monitor hides the Jitter Histogram toggle completely
    fireEvent.click(screen.getByRole("button", { name: /^Patch$/i }));
    expect(
      screen.queryByRole("button", { name: /Jitter Histogram/i }),
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

    expect(useTaktStore.getState().showState.patch).toHaveLength(1);
    expect(useTaktStore.getState().showState.patch[0].address).toBe(505);
    // Latest-action patch toast banner was removed per usage notes (Item 3)
    expect(
      screen.queryByRole("button", { name: /Dismiss/i }),
    ).not.toBeInTheDocument();
    // Rollover active: no red cross-protocol warning shown
    expect(screen.queryByText(/CROSS PROTOCOL SPLIT/i)).not.toBeInTheDocument();

    // Switching Rollover OFF exposes the cross-protocol warning and one-click relocation button
    fireEvent.click(rolloverSwitch);
    expect(screen.getByText(/CROSS PROTOCOL SPLIT/i)).toBeInTheDocument();
    const resolveBtn = screen.getByTestId("resolve-split-fixtures-button");
    expect(resolveBtn).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(resolveBtn);
      await Promise.resolve();
    });
    expect(useTaktStore.getState().showState.patch[0].universe).toBe(2);
    expect(useTaktStore.getState().showState.patch[0].address).toBe(1);
    expect(screen.queryByText(/CROSS PROTOCOL SPLIT/i)).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Undo$/i }));
      await Promise.resolve();
    });
    expect(useTaktStore.getState().showState.patch[0].universe).toBe(1);
    expect(useTaktStore.getState().showState.patch[0].address).toBe(505);

    fireEvent.keyDown(window, { key: "r" });
    expect(screen.queryByText(/CROSS PROTOCOL SPLIT/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Undo$/i }));
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
  }, 15000);

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

    // Create a Scene in the "Bank 1" bank referencing the FX block + Undo/Redo
    fireEvent.change(screen.getByLabelText("Scene Name"), {
      target: { value: "Boost Wash" },
    });
    fireEvent.change(screen.getByLabelText("Scene Bank"), {
      target: { value: "Bank 1" },
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

    // Trigger blank starter scene -> stays dark (0 DMX, no auto dimmer/color)
    fireEvent.click(screen.getByTestId("trigger-scene-sc_new_1"));
    await Promise.resolve();
    expect(useTaktStore.getState().activeScenes).toHaveLength(1);
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(0);

    // Trigger Boost Wash in same "Bank 1" bank -> sc_new_1 enters release
    fireEvent.click(screen.getByTestId(`trigger-scene-${createdScene!.id}`));
    await Promise.resolve();
    const activeAfter = useTaktStore.getState().activeScenes;
    const starterInst = activeAfter.find((s) => s.scene_id === "sc_new_1");
    const boostInst = activeAfter.find((s) => s.scene_id === createdScene!.id);
    expect(starterInst?.release_t_sec).not.toBeNull();
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

  it("opens Timeline Super-Scene in bottom-right dock, expands full-width, drops real WAV music with exact duration & waveform, analyzes music clip, and outputs live DMX", async () => {
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

    // Open Studio: FX Choice Matrix includes TIMELINE tile, no separate bank timeline button
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));
    expect(screen.getByTestId("fx-picker-tile-timeline")).toBeInTheDocument();
    expect(screen.queryByTestId("quick-add-timeline-Bank 1")).not.toBeInTheDocument();

    // Select the starter Timeline Super-Scene tile in Bank 1
    fireEvent.click(screen.getByTestId("scene-play-zone-sc_tl_cyber_intro"));

    // Bottom-right dock shows TimelineEditor by default alongside 2D Grid; right rack hosts Clip/Timeline inspector
    expect(screen.getByTestId("daslight-bottom-dock")).toBeInTheDocument();
    expect(screen.getByTestId("daslight-timeline-dock")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-right-inspector")).toBeInTheDocument();
    // Timeline Super-Scene must NOT show Target Fixtures dropdown
    expect(screen.queryByTestId("scene-target-bar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("timeline-waveform-lane")).not.toBeInTheDocument();
    expect(screen.queryByTestId("timeline-live-cell-preview")).not.toBeInTheDocument();
    // Beat grid bar lines and FX cycle notches are visible
    expect(screen.getAllByTestId("beat-grid-bar").length).toBeGreaterThan(2);

    // Switch right inspector to Timeline Settings tab and click Analyze Audio before adding music
    fireEvent.click(screen.getByTestId("timeline-inspector-tab-settings"));
    fireEvent.click(screen.getByTestId("timeline-analyze-audio-btn"));
    expect(screen.getByText(/Drop or add a music file/i)).toBeInTheDocument();

    // Build a 22-second PCM WAV file (> 16s!) and drop onto new-track dropzone
    const sr = 8000;
    const durSec = 22;
    const numSamples = sr * durSec;
    const wavBuf = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(wavBuf);
    const wStr = (off: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    wStr(0, "RIFF");
    view.setUint32(4, 36 + numSamples * 2, true);
    wStr(8, "WAVE");
    wStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    wStr(36, "data");
    view.setUint32(40, numSamples * 2, true);
    for (let i = 0; i < numSamples; i++) {
      const t = i / sr;
      const dt = t % 0.5;
      const s = dt < 0.06 ? Math.exp(-dt / 0.02) * Math.sin(2 * Math.PI * 80 * dt) * 0.8 : 0;
      view.setInt16(44 + i * 2, Math.round(s * 32767), true);
    }
    const musicFile = new File([wavBuf], "intro_22s.wav", { type: "audio/wav" });

    const dropzone = screen.getByTestId("timeline-new-track-dropzone");
    Object.defineProperty(dropzone, "getBoundingClientRect", {
      value: () => ({ left: 0, width: 1000, top: 0, height: 40, right: 1000, bottom: 40 }),
    });
    // Drop at clientX = 500 on an empty-music timeline -> song must still be placed at 0.0s!
    const musicDropEvent = Object.assign(
      new Event("drop", { bubbles: true, cancelable: true }),
      {
        clientX: 500,
        dataTransfer: {
          getData: () => "",
          files: [musicFile],
        },
      },
    );
    await act(async () => {
      fireEvent(dropzone, musicDropEvent);
      await new Promise((r) => setTimeout(r, 20));
    });

    const musicTrack = useTaktStore
      .getState()
      .showState.timelines.find((t) => t.id === "tl_cyber_intro")
      ?.tracks.find((tr) => tr.track_type === "music");
    expect(musicTrack).toBeDefined();
    expect(musicTrack!.clips[0].audio_file).toBe("intro_22s.wav");
    expect(musicTrack!.clips[0].start_sec).toBe(0);
    // Exact decoded duration (22s), NOT hardcoded 16s!
    expect(musicTrack!.clips[0].duration_sec).toBeCloseTo(22.0, 1);
    // Waveform canvas rendered directly inside the music clip
    expect(screen.getByTestId(`clip-waveform-${musicTrack!.id}-0`)).toBeInTheDocument();
    // Snap grid selector defaults to whole beats ("beat") and marker legend is present in Settings
    expect(
      (screen.getByTestId("timeline-snap-grid-select") as HTMLSelectElement).value,
    ).toBe("beat");
    expect(screen.getByTestId("timeline-marker-legend")).toBeInTheDocument();

    // Analyze Audio in Settings tab analyzes the real music clip and syncs BPM/Grid
    await act(async () => {
      fireEvent.click(screen.getByTestId("timeline-analyze-audio-btn"));
      await Promise.resolve();
    });
    const clipAnalysis = useTaktStore.getState().audioAnalysisByClipKey["intro_22s.wav"];
    expect(clipAnalysis).toBeDefined();
    expect(clipAnalysis.waveform_peaks.length).toBeGreaterThan(20);
    expect(clipAnalysis.transients.length).toBeGreaterThan(2);

    // Update signed latency offset, grid offset, tempo, and loop toggle
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
      fireEvent.click(screen.getByTestId("timeline-loop-toggle"));
      await Promise.resolve();
    });
    expect(useTaktStore.getState().latencyOffsetMs).toBe(-10);
    expect(
      useTaktStore.getState().showState.timelines.find((t) => t.id === "tl_cyber_intro")
        ?.loop_timeline,
    ).toBe(true);

    // Expand toggle switches to full-width bottom Timeline dock
    fireEvent.click(screen.getByTestId("timeline-expand-toggle"));
    expect(screen.queryByTestId("daslight-bottom-dock")).not.toBeInTheDocument();
    expect(screen.getByTestId("daslight-timeline-dock")).toBeInTheDocument();

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
  });
});

describe("TaktLight Slice 7 UI Consolidation & Centered Bottom Navigation", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("moves workspace tabs to centered bottom dock without redundant Timeline tab and hosts consolidated Studio workspace", () => {
    render(<App />);

    const header = screen.getByRole("banner");
    expect(within(header).queryByRole("navigation")).not.toBeInTheDocument();

    const dock = screen.getByTestId("bottom-nav-dock");
    const nav = within(dock).getByRole("navigation", { name: /Workspace Views/i });

    expect(within(nav).getByRole("button", { name: /^Patch$/i })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /Studio \/ 2D Grid/i })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /^Timeline$/i })).not.toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /^Fixtures$/i })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /^Monitor$/i })).toBeInTheDocument();

    fireEvent.click(within(nav).getByRole("button", { name: /Studio \/ 2D Grid/i }));
    expect(screen.getByTestId("daslight-scene-banks")).toBeInTheDocument();
    expect(screen.getByTestId("daslight-fx-rack")).toBeInTheDocument();
    expect(screen.getByTestId("daslight-groups-bar")).toBeInTheDocument();
    expect(screen.getByTestId("daslight-bottom-dock")).toBeInTheDocument();
    expect(screen.getByTestId("fixture-grid-canvas")).toBeInTheDocument();
    expect(screen.queryByTestId("submode-timeline")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Undo$/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Redo$/i })).toHaveLength(1);
  });
});

describe("TaktLight Daslight 5 Scene-First UX, Bank Management & 2D Multi-Select", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("supports Bank management, 3-mode Scene Inspector (COLOR / COLOR ANIM / EFFECT), 2D multi-fixture grouping, and Timeline Scene layering", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube Stage",
        2,
        1,
        1,
      );

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    // 0. Clean Startup: 1 Bank ("Bank 1"), 1 Scene ("New Scene"), Choice Matrix visible, No Overlays column
    expect(
      screen.queryByTestId("active-editing-context-bar"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("bank-column-overlays"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("bank-column-Bank 1")).toBeInTheDocument();
    expect(screen.getByTestId("daslight-fx-picker-grid")).toBeInTheDocument();
    expect(screen.getByTestId("submode-builder")).toHaveTextContent(
      "EDIT: New Scene",
    );
    expect(screen.getByTestId("selected-fixture-banner")).toHaveTextContent(
      "Tube Stage 2 (fx_002)",
    );

    // 1. Network Output starts OFF by default (Item 7); inline 2D transform + Scene-bound Dimmer/Color controls present
    expect(screen.queryByTestId("output-mode-edit_preview")).not.toBeInTheDocument();
    expect(screen.getByTestId("grid-inline-transform-controls")).toBeInTheDocument();
    expect(screen.getByTestId("topbar-open-project-btn")).toBeInTheDocument();
    expect(screen.getByTestId("topbar-save-project-btn")).toBeInTheDocument();

    const txToggle = screen.getByTestId("toggle-network-output-btn");
    expect(txToggle).toHaveAttribute("aria-pressed", "false");
    expect(useTaktStore.getState().outputEnabled).toBe(false);
    fireEvent.click(txToggle);
    expect(useTaktStore.getState().outputEnabled).toBe(true);
    expect(txToggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(txToggle);
    expect(useTaktStore.getState().outputEnabled).toBe(false);

    // Scene-bound Dimmer (Segment + Master for RLCV3) & inline Color editing
    expect(screen.getByTestId("scene-master-dimmer-strip")).toBeInTheDocument();
    expect(screen.getByTestId("scene-segment-dimmer-strip")).toBeInTheDocument();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Channel Dimmer Fader value"), {
        target: { value: "60" },
      });
      await Promise.resolve();
    });
    const updatedBlk = useTaktStore
      .getState()
      .showState.fx_library.find((b) => b.id === "blk_scene_sc_new_1");
    const dimEl = updatedBlk?.elements.find((e) => e.trait === "dimmer");
    expect(dimEl?.kind === "static_trait" ? dimEl.value_start : null).toBeCloseTo(0.6);

    // 2. Bank Management: instant Bank creation + double-click rename + blank scene landing on Choice Matrix
    fireEvent.click(screen.getByTestId("open-add-bank-btn"));
    expect(screen.getByTestId("bank-column-Bank 2")).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByTestId("bank-name-Bank 2"));
    const renameB2 = screen.getByLabelText("Rename bank Bank 2");
    fireEvent.change(renameB2, { target: { value: "Colors" } });
    fireEvent.keyDown(renameB2, { key: "Enter" });
    expect(screen.getByTestId("bank-column-Colors")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("open-add-bank-btn"));
    expect(screen.getByTestId("bank-column-Bank 3")).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByTestId("bank-name-Bank 3"));
    const renameB3 = screen.getByLabelText("Rename bank Bank 3");
    fireEvent.change(renameB3, { target: { value: "Effects" } });
    fireEvent.keyDown(renameB3, { key: "Enter" });
    expect(screen.getByTestId("bank-column-Effects")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-add-scene-Colors"));
      await Promise.resolve();
    });
    const colorScene = useTaktStore
      .getState()
      .showState.scenes.find((s) => s.bank === "Colors")!;
    expect(colorScene).toBeDefined();
    expect(colorScene.block_refs).toEqual([]);

    // Blank scene lands on 6-tile Choice Matrix without STATIC COLOR
    fireEvent.click(screen.getByTestId(`scene-play-zone-${colorScene.id}`));
    expect(screen.getByTestId("daslight-fx-picker-grid")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^STATIC COLOR$/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("scene-mode-color")).not.toBeInTheDocument();

    // Pick COLOR FX -> locked COLOR FX submenu (no cross-type switcher)
    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-color_fx"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("fx-submenu-header-color_fx")).toBeInTheDocument();
    expect(screen.queryByLabelText("Color Animation Style")).not.toBeInTheDocument();
    const colorBlk = useTaktStore
      .getState()
      .showState.fx_library.find(
        (b) =>
          b.id ===
          useTaktStore
            .getState()
            .showState.scenes.find((s) => s.id === colorScene.id)?.block_refs[0],
      )!;
    expect(colorBlk.elements[0].trait).toBe("color");
    expect(colorBlk.elements[0].kind).toBe("curve_1d");

    // Add an Effect Scene in Effects bank -> lands on Choice Matrix -> pick CHASER FX
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-add-scene-Effects"));
      await Promise.resolve();
    });
    const effectScene = useTaktStore
      .getState()
      .showState.scenes.find((s) => s.bank === "Effects")!;
    expect(effectScene).toBeDefined();
    expect(screen.getByTestId("daslight-fx-picker-grid")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-chaser_fx"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("fx-submenu-header-chaser_fx")).toBeInTheDocument();
    expect(screen.queryByLabelText("Effect Style")).not.toBeInTheDocument();
    expect(screen.getByTestId("step-chase-preview-bar")).toBeInTheDocument();
    expect(screen.getByLabelText("Chaser Fading")).not.toBeChecked();

    // Right-click on Bank 1 header to enable Stackable / Overlay mode + momentary Flash on added scene
    const bank1Col = screen.getByTestId("bank-column-Bank 1");
    fireEvent.contextMenu(bank1Col.firstElementChild!);
    fireEvent.click(screen.getByTestId("bank-ctx-stackable-Bank 1"));
    expect(screen.getByTestId("bank-stack-badge-Bank 1")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-add-scene-Bank 1"));
      await Promise.resolve();
    });
    const flashScene = useTaktStore
      .getState()
      .showState.scenes.find(
        (s) => s.bank === "Bank 1" && s.id !== "sc_new_1" && !s.timeline_ref,
      )!;
    expect(flashScene.fade_in_sec).toBe(0);
    expect(flashScene.fade_out_sec).toBe(0);
    expect(flashScene.block_refs).toEqual([]);

    // Blank scene outputs nothing; raising dimmer in bottom dock + Flash outputs 255 / 0
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Channel Dimmer Fader value"), {
        target: { value: "100" },
      });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId(`toggle-flash-${flashScene.id}`));
    fireEvent.pointerDown(screen.getByTestId(`trigger-scene-${flashScene.id}`));
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(255);
    fireEvent.pointerUp(screen.getByTestId(`trigger-scene-${flashScene.id}`));
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(0);

    // 3. 2D Canvas Multi-Fixture Selection & 1-Click Grouping + Zoom/Rotate/Patterns
    expect(screen.getByTestId("selections-grouping-sidebar")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("toggle-select-fixture-fx_001"));
    fireEvent.click(screen.getByTestId("toggle-select-fixture-fx_002"));
    expect(useTaktStore.getState().selectedFixtureIds).toEqual([
      "fx_001",
      "fx_002",
    ]);

    fireEvent.change(screen.getByLabelText("Quick Selection Group Name"), {
      target: { value: "Both Tubes" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-group-from-fixtures-btn"));
      await Promise.resolve();
    });
    const createdGrp = useTaktStore
      .getState()
      .showState.groups.find((g) => g.name === "Both Tubes");
    expect(createdGrp?.targets).toEqual(["fx_001", "fx_002"]);

    fireEvent.click(screen.getByTestId("grid-zoom-in"));
    expect(screen.getByTestId("grid-zoom-value")).toHaveTextContent("125%");
    fireEvent.click(screen.getByTestId("grid-zoom-reset"));
    expect(screen.getByTestId("grid-zoom-value")).toHaveTextContent("100%");

    fireEvent.change(screen.getByLabelText("Grid Rotation"), {
      target: { value: "90" },
    });
    fireEvent.click(screen.getByTestId("reset-rotation-scale-btn"));
    expect(
      useTaktStore.getState().showState.patch[1].grid_pos.rotation,
    ).toBe(0);

    fireEvent.click(screen.getByTestId("pattern-filter-1/2"));
    expect(useTaktStore.getState().selectedCellIndices.length).toBeGreaterThan(
      0,
    );

    // Verify 2D Hue-Sat Color Picker inside COLOR trait tab (and no moving-light tabs)
    expect(screen.queryByTestId("trait-tab-position")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("trait-tab-color"));
    expect(screen.getByTestId("color-hs-square")).toBeInTheDocument();

    // 4. Key Mapping + Live Mixer
    fireEvent.click(screen.getByTestId("toggle-key-map-overlay"));
    expect(screen.getByTestId("mapping-overlay-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("scene-play-zone-sc_new_1"));
    fireEvent.keyDown(window, { key: "k" });
    expect(useTaktStore.getState().keyBindings["sc_new_1"]).toBe("K");
    fireEvent.click(screen.getByTestId("toggle-key-map-overlay"));

    fireEvent.click(screen.getByTestId("submode-live_busking"));
    expect(screen.getByTestId("live-mixer-console")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByTestId("mixer-flash-all"));
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(255);
    fireEvent.pointerUp(screen.getByTestId("mixer-flash-all"));
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBe(0);

    // 5. Timeline Super-Scene Dock & Layering Color Scene + Effect Scene onto Tracks
    fireEvent.click(screen.getByTestId("submode-builder"));
    fireEvent.click(screen.getByTestId("scene-play-zone-sc_tl_cyber_intro"));
    expect(screen.queryByTestId("timeline-scene-palette")).toBeNull();

    const tracksBefore = useTaktStore.getState().showState.timelines[0].tracks;
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Timeline Playhead Sec"), {
        target: { value: "9" },
      });
      await Promise.resolve();
    });
    const firstTrackLane = screen.getByTestId(`track-lane-${tracksBefore[0].id}`);
    await act(async () => {
      fireEvent.drop(firstTrackLane, {
        clientX: 450,
        dataTransfer: {
          getData: (type: string) =>
            type === "text/takt-scene-id" || type === "text/plain"
              ? colorScene.id
              : "",
          files: [],
        },
      });
      await Promise.resolve();
    });

    // Drop effectScene below the last track to auto-create the second track
    const dropzone2 = screen.getByTestId("timeline-new-track-dropzone");
    await act(async () => {
      fireEvent.drop(dropzone2, {
        clientX: 400,
        dataTransfer: {
          getData: (type: string) =>
            type === "text/takt-scene-id" || type === "text/plain"
              ? effectScene.id
              : "",
          files: [],
        },
      });
      await Promise.resolve();
    });

    const tracksAfter = useTaktStore.getState().showState.timelines[0].tracks;
    const trkEffectId = tracksAfter[tracksAfter.length - 1].id;

    expect(
      screen.getByTestId(`track-lane-${tracksBefore[0].id}`),
    ).toHaveTextContent(`[COLOR ANIM] ${colorScene.name}`);
    expect(
      screen.getByTestId(`track-lane-${trkEffectId}`),
    ).toHaveTextContent(`[EFFECT] ${effectScene.name}`);
  });
});

describe("TaktLight NLE Video-Editor Timeline", () => {
  beforeEach(() => {
    if (typeof window.PointerEvent === "undefined") {
      (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
        MouseEvent;
    }
    useTaktStore.getState().resetForTest();
  });

  it("supports NLE clip drag-move, left/right trimming, fades, split at playhead, duplicate, kick auto-fill, and zoom", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));
    fireEvent.click(screen.getByTestId("scene-play-zone-sc_tl_cyber_intro"));

    // Initial starter clip: start 0.0s, duration 8.0s on dynamic infinite-canvas timeline
    expect(screen.getByTestId("timeline-clip-trk_1-0")).toBeInTheDocument();
    expect(screen.getByTestId("nle-playhead-line")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-ruler")).toBeInTheDocument();
    expect(screen.queryByTestId("timeline-waveform-lane")).not.toBeInTheDocument();

    // Drag clip body right by 96px on 768px (32s * 24px/s) canvas => +4.0s
    fireEvent.pointerDown(screen.getByTestId("clip-body-trk_1-0"), { clientX: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 196 });
    fireEvent.pointerUp(window);

    let clip0 = useTaktStore.getState().showState.timelines[0].tracks[0].clips[0];
    expect(clip0.start_sec).toBeGreaterThan(2.0);

    // Nudge right (+0.25s) and trim via pointer handle + inspector
    fireEvent.click(screen.getByTestId("nudge-clip-right-btn"));
    clip0 = useTaktStore.getState().showState.timelines[0].tracks[0].clips[0];
    expect(clip0.start_sec).toBeGreaterThan(2.1);

    // Trim end handle shorter (-50px / 800px * 16s = -1.0s)
    fireEvent.pointerDown(screen.getByTestId("clip-trim-end-trk_1-0"), { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 350 });
    fireEvent.pointerUp(window);
    clip0 = useTaktStore.getState().showState.timelines[0].tracks[0].clips[0];
    expect(clip0.duration_sec).toBeLessThan(7.5);

    // Trim start handle right (+50px / 800px * 16s = +1.0s)
    const beforeTrimStart = clip0.start_sec;
    fireEvent.pointerDown(screen.getByTestId("clip-trim-start-trk_1-0"), { clientX: 150, button: 0 });
    fireEvent.pointerMove(window, { clientX: 200 });
    fireEvent.pointerUp(window);
    clip0 = useTaktStore.getState().showState.timelines[0].tracks[0].clips[0];
    expect(clip0.start_sec).toBeGreaterThan(beforeTrimStart);

    // Switch to Seconds mode and use Selected Clip Inspector numeric inputs + trim shorter button
    fireEvent.click(screen.getByTestId("timeline-unit-seconds"));
    fireEvent.change(screen.getByLabelText("Selected Clip Start Sec"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Selected Clip Duration Sec"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Selected Clip Fade In Sec"), { target: { value: "0.75" } });
    fireEvent.change(screen.getByLabelText("Selected Clip Fade Out Sec"), { target: { value: "1.25" } });
    fireEvent.click(screen.getByTestId("trim-clip-shorter-btn"));
    clip0 = useTaktStore.getState().showState.timelines[0].tracks[0].clips[0];
    expect(clip0.start_sec).toBeCloseTo(0, 2);
    expect(clip0.duration_sec).toBeCloseTo(7.5, 2);
    expect(clip0.fade_in_sec).toBeCloseTo(0.75, 2);
    expect(clip0.fade_out_sec).toBeCloseTo(1.25, 2);

    // Reset clip to 0..8 and split at playhead 4.0s
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Selected Clip Duration Sec"), { target: { value: "8" } });
      fireEvent.change(screen.getByLabelText("Timeline Playhead Sec"), { target: { value: "4" } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("timeline-split-clip-btn"));
      await Promise.resolve();
    });

    let trkClips = useTaktStore.getState().showState.timelines[0].tracks[0].clips;
    expect(trkClips.length).toBe(2);
    expect(trkClips[0].start_sec).toBeCloseTo(0, 2);
    expect(trkClips[0].duration_sec).toBeCloseTo(4, 2);
    expect(trkClips[1].start_sec).toBeCloseTo(4, 2);
    expect(trkClips[1].duration_sec).toBeCloseTo(4, 2);

    // Duplicate selected clip
    await act(async () => {
      fireEvent.click(screen.getByTestId("timeline-duplicate-clip-btn"));
      await Promise.resolve();
    });
    trkClips = useTaktStore.getState().showState.timelines[0].tracks[0].clips;
    expect(trkClips.length).toBe(3);

    // Zoom controls
    fireEvent.click(screen.getByTestId("timeline-zoom-in"));
    expect(screen.getByTestId("timeline-zoom-reset").textContent).not.toBe("1.0×");
    fireEvent.click(screen.getByTestId("timeline-zoom-reset"));
    expect(screen.getByTestId("timeline-zoom-reset").textContent).toBe("1.0×");

    // Auto-fill kicks creates a dedicated Kick Hits FX track populated with kick clips
    await act(async () => {
      fireEvent.click(screen.getByTestId("timeline-auto-place-kicks-btn"));
      await Promise.resolve();
      await Promise.resolve();
    });
    const kickTrack = useTaktStore
      .getState()
      .showState.timelines[0].tracks.find((tr) => tr.name === "Kick Hits");
    expect(kickTrack).toBeDefined();
    expect(kickTrack!.clips.length).toBeGreaterThan(2);

    // Global Time-Stretch tool toggle: stretch clip, turn off Stretch, verify cycle dividers remain & Reset 1.0x works
    const stretchToggle = screen.getByTestId("timeline-stretch-tool-toggle");
    expect(stretchToggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(stretchToggle);
    expect(stretchToggle).toHaveAttribute("aria-pressed", "true");

    // Stretch clip 0 on trk_1 longer, then disable Stretch mode
    fireEvent.pointerDown(screen.getByTestId("clip-trim-end-trk_1-0"), { clientX: 200, button: 0 });
    fireEvent.pointerMove(window, { clientX: 300 });
    fireEvent.pointerUp(window);
    fireEvent.click(stretchToggle);
    expect(stretchToggle).toHaveAttribute("aria-pressed", "false");

    // Reset 1.0x button is available in Clip Inspector and restores natural speed
    const resetStretchBtn = screen.getByTestId("reset-clip-stretch-btn");
    expect(resetStretchBtn).toBeInTheDocument();
    fireEvent.click(resetStretchBtn);
    expect(useTaktStore.getState().showState.timelines[0].tracks[0].clips[0].time_stretch).toBe(false);
  });
});

describe("TaktLight Usage Notes Regressions (Items 1-18)", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("renders unsaved-changes close modal when closing an unsaved project (Item 1)", () => {
    render(<App />);
    act(() => {
      useTaktStore.setState({ isDirty: true, closePromptOpen: true });
    });
    expect(screen.getByText(/Unsaved Show Changes/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save & Close/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Don't Save/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Cancel$/i })).toBeInTheDocument();
  });

  it("deletes custom control channels in FixtureBuilder (Item 4)", async () => {
    render(<App />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Fixtures$/i }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Add Control Channel/i }));
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Delete control channel Macro 1")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete control channel Macro 1"));
      await Promise.resolve();
    });
    expect(screen.queryByLabelText("Delete control channel Macro 1")).not.toBeInTheDocument();
  });

  it("supports typed numeric input + reset on sliders, Scene Duration Beats/Sec, and preserves Master/Segment dimmers when entering FX (Items 12, 13, 15, 17, 18)", async () => {
    await useTaktStore
      .getState()
      .patchFixtures("age/rlcv3_8_segment_tube.json", "34ch Pixel Mode", "Tube", 1, 1, 1);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    // Item 12 & 13: Grand Master accepts typed input and resets via reset button
    const gmInput = screen.getByLabelText("Grand Master value") as HTMLInputElement;
    fireEvent.change(gmInput, { target: { value: "42" } });
    fireEvent.blur(gmInput);
    expect(useTaktStore.getState().grandMaster).toBeCloseTo(0.42, 2);
    fireEvent.click(screen.getByLabelText("Reset Grand Master"));
    expect(useTaktStore.getState().grandMaster).toBe(1);

    // Item 17 & 18: Set both MASTER and SEGMENT dimmers to 100%, then enter CURVE FX
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Master Dimmer Fader value"), {
        target: { value: "100" },
      });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Channel Dimmer Fader value"), {
        target: { value: "100" },
      });
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-curve_fx"));
      await Promise.resolve();
    });

    const blk = useTaktStore
      .getState()
      .showState.fx_library.find((b) => b.id === "blk_scene_sc_new_1")!;
    const masterEl = blk.elements.find(
      (e) => e.kind === "static_trait" && e.trait === "master_dimmer",
    );
    const segEl = blk.elements.find(
      (e) => e.kind === "static_trait" && e.trait === "dimmer",
    );
    const curveEl = blk.elements.find((e) => e.kind === "curve_1d");
    expect(masterEl?.kind === "static_trait" ? masterEl.value_start : null).toBe(1);
    expect(segEl?.kind === "static_trait" ? segEl.value_start : null).toBe(1);
    expect(curveEl).toBeDefined();
    // Static dimmers do NOT appear as FX tabs in right FX rack
    const fxRack = screen.getByTestId("daslight-fx-rack");
    expect(within(fxRack).queryByRole("button", { name: /^DIMMER$/i })).not.toBeInTheDocument();
    expect(within(fxRack).getByTestId("fx-stack-tab-0")).toHaveTextContent("CURVE FX");
    expect(within(fxRack).queryByTestId("fx-stack-tab-1")).not.toBeInTheDocument();

    // Item 15: Scene Properties Duration (Beats / Sec toggle + numeric value) replaces Speed
    fireEvent.click(screen.getByTitle("Scene Properties"));
    expect(screen.queryByLabelText("Inspector Speed Mult")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId("scene-duration-unit-seconds"));
      fireEvent.change(screen.getByTestId("scene-duration-input"), {
        target: { value: "2.5" },
      });
      await Promise.resolve();
    });
    const sc = useTaktStore.getState().showState.scenes.find((s) => s.id === "sc_new_1")!;
    expect(sc.duration_unit).toBe("seconds");
    expect(sc.duration_value).toBeCloseTo(2.5, 2);
  });

  it("supports GM tooltip, Clr zero-selection, duplicate group rejection, Palette Builder, and dynamic FX Target Channel", async () => {
    render(<App />);

    // GM tooltip present in TopStatusBar
    expect(
      screen.getByText("GM").closest("[title]")?.getAttribute("title"),
    ).toMatch(/Grand Master/i);

    // Patch 2 fixtures and open Studio
    fireEvent.click(screen.getByRole("button", { name: /Patch Fixtures/i }));
    fireEvent.click(screen.getByRole("button", { name: /Patch Fixtures/i }));
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    // 2D Grid Clr leaves zero fixtures selected
    fireEvent.click(screen.getByTestId("clear-fixture-selection-btn"));
    expect(useTaktStore.getState().selectedFixtureIds).toEqual([]);
    expect(useTaktStore.getState().selectedFixtureInstanceId).toBeNull();
    expect(screen.getByTestId("toggle-select-fixture-fx_001")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // Duplicate group name rejection (case-insensitive)
    fireEvent.click(screen.getByTestId("select-all-fixtures-btn"));
    fireEvent.change(screen.getByLabelText("Quick Selection Group Name"), {
      target: { value: "Front Wash" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-group-from-fixtures-btn"));
      await Promise.resolve();
    });
    const countAfterFirst = useTaktStore.getState().showState.groups.length;
    fireEvent.change(screen.getByLabelText("Quick Selection Group Name"), {
      target: { value: "front wash" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-group-from-fixtures-btn"));
      await Promise.resolve();
    });
    expect(useTaktStore.getState().showState.groups.length).toBe(countAfterFirst);

    // Scene Duration input steps by 1 in Beats mode
    fireEvent.click(screen.getByTitle("Scene Properties"));
    expect(screen.getByTestId("scene-duration-input")).toHaveAttribute("step", "1");
    fireEvent.click(screen.getByTitle("FX Rack"));

    // Dynamic FX Target Channel selector in CURVE FX
    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-curve_fx"));
      await Promise.resolve();
    });
    const traitSelect = screen.getByTestId("fx-target-trait-select");
    expect(traitSelect).toBeInTheDocument();
    await act(async () => {
      fireEvent.change(traitSelect, { target: { value: "red" } });
      await Promise.resolve();
    });
    const curveBlk = useTaktStore
      .getState()
      .showState.fx_library.find((b) => b.id === "blk_scene_sc_new_1")!;
    expect(curveBlk.elements.find((e) => e.kind === "curve_1d")?.trait).toBe("red");

    // Color Palette Builder modal from COLOR dock
    fireEvent.click(screen.getByRole("button", { name: /^COLOR$/i }));
    fireEvent.click(screen.getByTestId("open-palette-builder-dock-btn"));
    expect(screen.getByTestId("color-palette-builder-modal")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("palette-builder-name-input"), {
      target: { value: "Aurora Mint" },
    });
    fireEvent.click(screen.getByTestId("palette-builder-add-stop-btn"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("palette-builder-save-btn"));
      await Promise.resolve();
    });
    expect(
      useTaktStore
        .getState()
        .showState.color_palettes.some((p) => p.name === "Aurora Mint"),
    ).toBe(true);
  });
});

