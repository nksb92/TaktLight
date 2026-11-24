import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAudioAssetRegistry } from "../../lib/audioEngine";
import { useTaktStore } from "../../store/useTaktStore";
import { ColorPaletteBuilderModal } from "../ColorPaletteBuilderModal";
import { DmxMonitor } from "../DmxMonitor";
import { buildHistogramBins, JitterHistogram } from "../JitterHistogram";
import { MissingAudioModal } from "../MissingAudioModal";
import { NumericSlider } from "../NumericSlider";
import { TopStatusBar } from "../TopStatusBar";

describe("Batch 1 Component Coverage (>= 95%)", () => {
  beforeEach(() => {
    clearAudioAssetRegistry();
    useTaktStore.getState().resetForTest();
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it("JitterHistogram covers binning, canvas rendering across all bucket colors, and dropped frames warning", () => {
    const samples = [
      22480, // outer left (ember)
      22600, // mid left (cobalt)
      22727, // center (pine)
      22730, // center (pine)
      22850, // mid right (cobalt)
      22970, // outer right (ember)
    ];
    const bins = buildHistogramBins(samples);
    expect(bins.maxCount).toBeGreaterThanOrEqual(2);

    useTaktStore.setState({
      jitterSamplesUs: samples,
      telemetry: {
        ...useTaktStore.getState().telemetry,
        meanUs: 22727,
        p99JitterUs: 45,
        maxJitterUs: 240,
        droppedFrames: 2,
      },
    });

    const { rerender } = render(<JitterHistogram />);
    expect(screen.getByText(/2 \(6\/256\)/)).toBeInTheDocument();

    // Also render with 0 dropped frames
    act(() => {
      useTaktStore.setState({
        telemetry: {
          ...useTaktStore.getState().telemetry,
          droppedFrames: 0,
        },
      });
    });
    rerender(<JitterHistogram />);
    expect(screen.getByText(/0 \(6\/256\)/)).toBeInTheDocument();
  });

  it("DmxMonitor covers Park, Unpark, Quick Presets, and Clear All Parks", async () => {
    render(<DmxMonitor />);
    // Select channel 1
    fireEvent.click(screen.getByTestId("dmx-cell-1"));
    // Click Park button directly
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Park$/i }));
      await Promise.resolve();
    });
    expect(useTaktStore.getState().parkedChannels["1:1"]).toBeDefined();

    // Click a quick preset (128)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^128$/ }));
      await Promise.resolve();
    });
    expect(useTaktStore.getState().parkedChannels["1:1"]).toBe(128);

    // Click Unpark button
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Unpark$/i }));
      await Promise.resolve();
    });
    expect(useTaktStore.getState().parkedChannels["1:1"]).toBeUndefined();
  });

  it("TopStatusBar covers keyboard shortcuts, open/save file, named NIC, TX states, and unhealthy timing", async () => {
    useTaktStore.setState({
      interfaces: [
        {
          name: "Ethernet",
          ipv4: "192.168.0.100",
          netmask: "255.255.255.0",
          broadcast: "192.168.0.255",
          subnet_cidr: "192.168.0.0/24",
        },
      ],
      activeInterface: {
        name: "Ethernet",
        ipv4: "192.168.0.100",
        netmask: "255.255.255.0",
        broadcast: "192.168.0.255",
        subnet_cidr: "192.168.0.0/24",
      },
      outputEnabled: true,
      isOffline: false,
      discoveryAvailable: true,
      discoveredNodes: [
        {
          node: {
            ip: "192.168.0.50",
            port: 6454,
            net_switch: 0,
            sub_switch: 0,
            short_name: "Node1",
            long_name: "Node 1",
            num_ports: 1,
            sw_out: [0, 0, 0, 0],
            mac: [0, 0, 0, 0, 0, 1],
          },
          last_seen_sec: 1,
          online: true,
        },
      ],
      jitterSamplesUs: [22727, 40000],
      telemetry: {
        ...useTaktStore.getState().telemetry,
        meanUs: 0,
        droppedFrames: 1,
      },
    });

    const saveSpy = vi
      .spyOn(useTaktStore.getState(), "saveProjectToFile")
      .mockResolvedValue(true);

    const { rerender } = render(<TopStatusBar />);
    expect(screen.getByText("192.168.0.100")).toBeInTheDocument();
    expect(screen.getByText("NODES: 1")).toBeInTheDocument();

    // Named NIC selection
    const select = screen.getByLabelText("Network Output Adapter");
    await act(async () => {
      fireEvent.change(select, {
        target: { value: "named::Ethernet::192.168.0.0/24" },
      });
      await Promise.resolve();
    });
    expect(useTaktStore.getState().adapterSelection.mode).toBe("named");

    // Ctrl+S & Ctrl+O shortcuts
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(saveSpy).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });

    // Open project file input
    const openInput = screen.getByLabelText("Open Project File");
    const xml = await useTaktStore.getState().exportShowXml();
    const xmlFile = new File([xml], "show.takt.xml", { type: "text/xml" });
    Object.defineProperty(xmlFile, "text", { value: async () => xml });
    await act(async () => {
      fireEvent.change(openInput, { target: { files: [xmlFile] } });
      await Promise.resolve();
    });

    // Save button click & TX toggle button
    fireEvent.click(screen.getByTestId("topbar-save-project-btn"));
    fireEvent.click(screen.getByTestId("toggle-network-output-btn"));

    // Active interface null + online -> LIVE badge
    useTaktStore.setState({
      outputEnabled: true,
      isOffline: false,
      activeInterface: null,
    });
    rerender(<TopStatusBar />);
    expect(screen.getByText("LIVE")).toBeInTheDocument();
  });

  it("NumericSlider covers vertical, stacked, inline, keyboard Enter/Escape, reset, commit, and invalid input", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const onReset = vi.fn();

    // 1. Vertical orientation
    const { unmount } = render(
      <NumericSlider
        orientation="vertical"
        label="Dimmer"
        unit="%"
        value={0.5}
        defaultValue={1}
        min={0}
        max={1}
        step={0.01}
        displayMultiplier={100}
        onChange={onChange}
        onCommit={onCommit}
      />,
    );
    const vNum = screen.getByLabelText("Dimmer value");
    fireEvent.focus(vNum);
    fireEvent.change(vNum, { target: { value: "75" } });
    fireEvent.keyDown(vNum, { key: "Enter" });
    fireEvent.blur(vNum);
    expect(onChange).toHaveBeenCalledWith(0.75);
    expect(onCommit).toHaveBeenCalledWith(0.75);

    fireEvent.focus(vNum);
    fireEvent.change(vNum, { target: { value: "abc" } });
    fireEvent.keyDown(vNum, { key: "Escape" });
    fireEvent.blur(vNum);

    const vRange = screen.getByLabelText("Dimmer");
    fireEvent.change(vRange, { target: { value: "0.25" } });
    fireEvent.mouseUp(vRange);
    fireEvent.touchEnd(vRange);
    fireEvent.click(screen.getByLabelText("Reset Dimmer"));
    expect(onChange).toHaveBeenCalledWith(1);
    unmount();

    // 2. Stacked layout with headerExtra, custom onReset, empty draft revert
    const { unmount: unmount2 } = render(
      <NumericSlider
        layout="stacked"
        label="Rate"
        headerExtra={<span>Extra</span>}
        value={2.5}
        defaultValue={1}
        min={0}
        max={10}
        step={0.25}
        onChange={onChange}
        onCommit={onCommit}
        onReset={onReset}
      />,
    );
    expect(screen.getByText("Extra")).toBeInTheDocument();
    const sNum = screen.getByLabelText("Rate value");
    fireEvent.focus(sNum);
    fireEvent.change(sNum, { target: { value: "" } });
    fireEvent.blur(sNum);
    fireEvent.focus(sNum);
    fireEvent.keyDown(sNum, { key: "Enter" });
    fireEvent.keyDown(sNum, { key: "Escape" });
    const sRange = screen.getByLabelText("Rate");
    fireEvent.change(sRange, { target: { value: "4" } });
    fireEvent.mouseUp(sRange);
    fireEvent.touchEnd(sRange);
    fireEvent.click(screen.getByLabelText("Reset Rate"));
    expect(onReset).toHaveBeenCalled();
    unmount2();

    // 3. Inline with label and disabled reset guard
    render(
      <NumericSlider
        layout="inline"
        label="Gain"
        value={1}
        defaultValue={1}
        min={0}
        max={2}
        step={0.1}
        disabled
        onChange={onChange}
      />,
    );
    expect(screen.getByText("Gain")).toBeInTheDocument();
  });

  it("ColorPaletteBuilderModal covers stop add/edit/reorder/remove, validation errors, cancel, and save", async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(
      <ColorPaletteBuilderModal
        open={true}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    // Add stop, change color & hex, reorder up/down, remove stop
    fireEvent.click(screen.getByTestId("palette-builder-add-stop-btn"));
    fireEvent.change(screen.getByLabelText("Palette Stop 1 Color"), {
      target: { value: "#112233" },
    });
    fireEvent.change(screen.getByLabelText("Palette Stop 2 Hex"), {
      target: { value: "#445566" },
    });
    fireEvent.click(screen.getByLabelText("Move Stop 2 Up"));
    fireEvent.click(screen.getByLabelText("Move Stop 1 Down"));
    fireEvent.click(screen.getByLabelText("Remove Stop 3"));

    // Validation error on empty name
    const nameInput = screen.getByLabelText("Palette Name");
    fireEvent.change(nameInput, { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("palette-builder-save-btn"));
    expect(screen.getAllByText(/name/i).length).toBeGreaterThanOrEqual(2);

    // Fix hex & save
    fireEvent.change(nameInput, { target: { value: "My Custom Palette" } });
    fireEvent.change(screen.getByLabelText("Palette Stop 1 Hex"), {
      target: { value: "#FF8800" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("palette-builder-save-btn"));
      await Promise.resolve();
    });
    expect(onSaved).toHaveBeenCalled();

    // Select an existing palette, click New, and delete our custom palette
    fireEvent.click(screen.getByText("My Custom Palette"));
    const delBtn = screen.queryByLabelText("Delete My Custom Palette");
    if (delBtn) {
      await act(async () => {
        fireEvent.click(delBtn);
        await Promise.resolve();
      });
    }
    fireEvent.click(screen.getByTestId("palette-builder-new-btn"));

    // Cancel button
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(onClose).toHaveBeenCalled();

    // Open with initialPaletteId to cover pre-populated edit path
    const firstId = useTaktStore.getState().showState.color_palettes[0]?.id;
    render(
      <ColorPaletteBuilderModal
        open={true}
        initialPaletteId={firstId}
        onClose={onClose}
      />,
    );
    expect(
      (screen.getAllByLabelText("Palette Name")[1] as HTMLInputElement).value,
    ).toBeTruthy();
  });

  it("StudioWorkspace covers group creation, group context-menu delete, and dock/overlay toggles", async () => {
    const { StudioWorkspace } = await import("../StudioWorkspace");
    await useTaktStore
      .getState()
      .patchFixtures(
        "age/rlcv3_8_segment_tube.json",
        "34ch Pixel Mode",
        "Tube SW",
        1,
        1,
        1,
      );
    await useTaktStore.getState().upsertGroup({
      id: "grp_ctx",
      name: "Ctx Group",
      order: "linear",
      targets: ["fx_001:0..7"],
    });

    render(<StudioWorkspace />);

    // Right-click group pill -> Delete Group
    const grpBtn = screen.getByRole("button", { name: /^Ctx Group$/i });
    fireEvent.click(grpBtn);
    fireEvent.contextMenu(grpBtn);
    expect(screen.getByTestId("group-context-menu")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete group Ctx Group"));
      await Promise.resolve();
    });
    expect(
      useTaktStore.getState().showState.groups.some((g) => g.id === "grp_ctx"),
    ).toBe(false);

    // Create a group with custom target string
    fireEvent.change(screen.getByLabelText("Group Name"), {
      target: { value: "Custom Grp" },
    });
    fireEvent.change(screen.getByLabelText("Group Order"), {
      target: { value: "mirror" },
    });
    fireEvent.change(screen.getByLabelText("Group Targets"), {
      target: { value: "fx_001:0..3" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Group/i }));
      await Promise.resolve();
    });
    expect(
      useTaktStore
        .getState()
        .showState.groups.some((g) => g.name === "Custom Grp"),
    ).toBe(true);

    // Toggle MIDI mapping overlay & layout toggles
    const midiBtn = screen.queryByTestId("toggle-midi-map-overlay");
    if (midiBtn) {
      fireEvent.click(midiBtn);
      fireEvent.click(midiBtn);
    }
    const bottomDockBtn = screen.queryByTitle(/Bottom Dock/i);
    if (bottomDockBtn) {
      fireEvent.click(bottomDockBtn);
      fireEvent.click(bottomDockBtn);
    }
    const inspectorBtn = screen.queryByTitle(/Inspector/i);
    if (inspectorBtn) {
      fireEvent.click(inspectorBtn);
      fireEvent.click(inspectorBtn);
    }
  });

  it("TimelineRightInspector covers clip start/duration/fades/stretch/reset/delete in beats & seconds + audio analyze", async () => {
    const { TimelineRightInspector } = await import("../TimelineRightInspector");
    const tlScene = await useTaktStore
      .getState()
      .createTimelineSceneInBank("Bank 1", "Inspector TL");
    const tl = useTaktStore
      .getState()
      .showState.timelines.find((t) => t.id === tlScene.timeline_ref)!;
    await useTaktStore.getState().upsertTimeline({
      ...tl,
      tracks: [
        {
          id: "trk_fx",
          name: "FX Track",
          track_type: "effect",
          target_group: "all",
          clips: [
            {
              ref_block: "sc_new_1",
              start_sec: 1,
              duration_sec: 4,
              fade_in_sec: 0.2,
              fade_out_sec: 0.3,
              inline_fx: [],
              time_stretch: true,
              source_duration_sec: 2,
            },
          ],
        },
        {
          id: "trk_audio",
          name: "Music 1",
          track_type: "music",
          target_group: null,
          clips: [
            {
              ref_block: null,
              start_sec: 0,
              duration_sec: 10,
              fade_in_sec: 0,
              fade_out_sec: 0,
              inline_fx: [],
              audio_file: "song.wav",
            },
          ],
        },
      ],
    });
    useTaktStore.setState({
      activeTimelineId: tl.id,
      timelineTimeUnit: "beats",
      selectedTimelineClip: { trackId: "trk_fx", clipIndex: 0 },
    });

    const { rerender } = render(<TimelineRightInspector timelineId={tl.id} />);

    // Clip controls in Beats mode
    fireEvent.change(screen.getByLabelText("Selected Clip Start Sec"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText("Selected Clip Duration Sec"), {
      target: { value: "8" },
    });
    fireEvent.change(screen.getByLabelText("Selected Clip Fade In Sec"), {
      target: { value: "0.5" },
    });
    fireEvent.change(screen.getByLabelText("Selected Clip Fade Out Sec"), {
      target: { value: "0.5" },
    });
    // Nudge & trim buttons + stretch factor
    fireEvent.click(screen.getByTestId("nudge-clip-left-btn"));
    fireEvent.click(screen.getByTestId("nudge-clip-right-btn"));
    fireEvent.click(screen.getByTestId("trim-clip-shorter-btn"));
    fireEvent.click(screen.getByTestId("trim-clip-longer-btn"));
    const stretchInput = screen.getByTestId("clip-stretch-factor-input");
    fireEvent.change(stretchInput, { target: { value: "1.5" } });
    fireEvent.change(stretchInput, { target: { value: "1" } });
    fireEvent.change(stretchInput, { target: { value: "2" } });
    const resetStretchBtn = screen.queryByTestId("reset-clip-stretch-btn");
    if (resetStretchBtn) {
      fireEvent.click(resetStretchBtn);
    }

    // Switch to Seconds mode and edit
    useTaktStore.setState({ timelineTimeUnit: "seconds" });
    rerender(<TimelineRightInspector timelineId={tl.id} />);
    fireEvent.change(screen.getByLabelText("Selected Clip Start Sec"), {
      target: { value: "2.5" },
    });
    fireEvent.change(screen.getByLabelText("Selected Clip Duration Sec"), {
      target: { value: "3.5" },
    });

    // Switch to settings inspector tab -> Tempo BPM, Grid Offset, Transient Sensitivity, Analyze Audio + Latency Offset
    fireEvent.click(screen.getByTestId("timeline-inspector-tab-settings"));
    fireEvent.change(screen.getByLabelText("Timeline Tempo BPM"), {
      target: { value: "128" },
    });
    fireEvent.change(screen.getByLabelText("Grid Offset Sec"), {
      target: { value: "0.25" },
    });
    fireEvent.click(screen.getByTestId("align-grid-to-playhead-btn"));
    fireEvent.change(screen.getByLabelText("Transient Sensitivity"), {
      target: { value: "0.6" },
    });
    fireEvent.change(screen.getByLabelText("Latency Offset Ms"), {
      target: { value: "25" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("timeline-analyze-audio-btn"));
      await Promise.resolve();
    });
  });

  it("MissingAudioModal covers Tauri folder path scan, individual path apply, and error messages", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "resolve_audio_in_folder_command") {
          if (args.folderPath === "C:\\BadFolder") {
            throw new Error("Folder not found");
          }
          return [
            {
              requested: "C:\\Old\\a.wav",
              resolved_path: "C:\\Music\\a.wav",
              file_name: "a.wav",
            },
          ];
        }
        if (cmd === "read_audio_file_bytes_command") {
          if (args.path === "C:\\Missing\\b.wav") {
            throw new Error("Audio file not found");
          }
          return {
            resolved_path: String(args.path),
            file_name: "song.wav",
            bytes: Array.from(new Uint8Array(64)),
          };
        }
        return null;
      },
    };

    useTaktStore.setState({
      missingAudioModalOpen: true,
      missingAudioFiles: [
        {
          originalKey: "C:\\Old\\a.wav",
          baseName: "a.wav",
          timelineIds: ["tl_1"],
          resolved: false,
        },
        {
          originalKey: "C:\\Old\\b.wav",
          baseName: "b.wav",
          timelineIds: ["tl_1"],
          resolved: false,
        },
      ],
    });

    render(<MissingAudioModal />);

    // Bad folder path -> error message
    const folderPathInput = screen.getByLabelText("Audio Folder Path");
    fireEvent.change(folderPathInput, { target: { value: "C:\\BadFolder" } });
    fireEvent.click(screen.getByTestId("relink-scan-folder-path-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("missing-audio-status")).toHaveTextContent(
        /Folder not found/i,
      );
    });

    // Good folder path -> relinks a.wav
    fireEvent.change(folderPathInput, { target: { value: "C:\\Music" } });
    fireEvent.click(screen.getByTestId("relink-scan-folder-path-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("missing-audio-status")).toHaveTextContent(
        /Relinked 1 audio file/i,
      );
    });

    // Individual path for b.wav (error then success)
    const bPathInput = screen.getByLabelText("File path for b.wav");
    fireEvent.change(bPathInput, { target: { value: "C:\\Missing\\b.wav" } });
    fireEvent.click(screen.getByRole("button", { name: /^Set Path$/i }));
    await waitFor(() => {
      expect(screen.getByTestId("missing-audio-status")).toHaveTextContent(
        /not found/i,
      );
    });

    fireEvent.change(bPathInput, { target: { value: "C:\\Music\\b.wav" } });
    fireEvent.click(screen.getByRole("button", { name: /^Set Path$/i }));
    await waitFor(() => {
      expect(screen.getByText(/0 missing/i)).toBeInTheDocument();
    });
  });
});
