import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TimelineEditor } from "../TimelineEditor";
import { useTaktStore } from "../../store/useTaktStore";
import * as audioEngine from "../../lib/audioEngine";
import { timelineAudioPlayer } from "../../lib/audioEngine";

function ptr(
  target: Window | Document | Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  opts: MouseEventInit = {},
) {
  fireEvent(target, new MouseEvent(type, { bubbles: true, button: 0, ...opts }));
}

function seedTimelineState() {
  const s = useTaktStore.getState();
  useTaktStore.setState({
    showState: {
      ...s.showState,
      bpm: 120,
      fx_library: [
        {
          id: "blk_fx_1",
          name: "Rainbow Pulse",
          target_group: "all",
          duration_beats: 4,
          duration_sec: null,
          loop_block: true,
          elements: [
            {
              kind: "static_trait",
              trait: "color",
              op: "ltp",
              palette_ref: null,
              value_start: 0,
              value_end: 0,
              hex_start: "#FF5500",
              hex_end: "#2255AA",
              order: null,
            },
          ],
        },
        {
          id: "blk_fx_2",
          name: "Strobe Hit",
          target_group: "all",
          duration_beats: 2,
          duration_sec: null,
          loop_block: true,
          elements: [
            {
              kind: "curve_1d",
              trait: "dimmer",
              op: "htp",
              palette_ref: null,
              waveform: "sine",
              amplitude: 0.5,
              offset: 0.5,
              rate_beats: null,
              speed_hz: null,
              rate_cycles: 1,
              phase_deg: 0,
              phase_spread_deg: 0,
              duty: 0.5,
              order: "linear",
            },
          ],
        },
      ],
      scenes: [
        {
          id: "scn_fx",
          name: "Rainbow Scene",
          bank: "Bank 1",
          priority: 2,
          fade_in_sec: 0,
          fade_out_sec: 0,
          block_refs: ["blk_fx_1"],
          timeline_ref: null,
          duration_value: 4,
          duration_unit: "beats",
          target_group: null,
        },
        {
          id: "scn_blank",
          name: "Blank Scene",
          bank: "Bank 1",
          priority: 2,
          fade_in_sec: 0,
          fade_out_sec: 0,
          block_refs: [],
          timeline_ref: null,
          duration_value: 4,
          duration_unit: "beats",
          target_group: null,
        },
        {
          id: "scn_tl",
          name: "Main Timeline Scene",
          bank: "Bank 1",
          priority: 2,
          fade_in_sec: 0,
          fade_out_sec: 0,
          block_refs: [],
          timeline_ref: "tl_1",
          duration_value: 16,
          duration_unit: "beats",
          target_group: null,
        },
      ],
      timelines: [
        {
          id: "tl_1",
          name: "Main Timeline",
          duration_sec: 8,
          grid_offset_sec: 0,
          loop_timeline: true,
          tempo_map: [{ at_sec: 0, bpm: 120 }],
          audio_track: null,
          tracks: [
            {
              id: "trk_fx_1",
              name: "FX Track 1",
              track_type: "effect",
              target_group: "all",
              clips: [
                {
                  ref_block: "blk_fx_1",
                  start_sec: 0,
                  duration_sec: 4,
                  fade_in_sec: 0.2,
                  fade_out_sec: 0.2,
                  inline_fx: [],
                },
              ],
            },
            {
              id: "trk_untyped",
              name: "Any Track",
              track_type: "untyped",
              target_group: "all",
              clips: [],
            },
            {
              id: "trk_music",
              name: "Music Track",
              track_type: "music",
              target_group: null,
              clips: [
                {
                  ref_block: null,
                  audio_file: "track.wav",
                  start_sec: 0,
                  duration_sec: 8,
                  fade_in_sec: 0,
                  fade_out_sec: 0,
                  inline_fx: [],
                },
              ],
            },
          ],
        },
      ],
    },
    activeTimelineId: "tl_1",
    selectedTimelineClip: { trackId: "trk_fx_1", clipIndex: 0 },
    timelinePlaying: false,
    timelinePlayheadSec: 2,
    timelinePlayheadAnchorMs: performance.now(),
    canUndo: true,
    canRedo: true,
  });
}

describe("Batch 4 Coverage — TimelineEditor", () => {
  beforeEach(() => {
    seedTimelineState();
    vi.spyOn(timelineAudioPlayer, "startFrom").mockImplementation(() => {});
    vi.spyOn(timelineAudioPlayer, "stop").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("covers clip move, cross-track move, new-track drop, Alt-duplicate, trim, rate-stretch, fades, and ruler scrub", async () => {
    const onToggleExpand = vi.fn();
    render(
      <TimelineEditor
        timelineId="tl_1"
        hideUndoRedo={false}
        expanded={true}
        onToggleExpand={onToggleExpand}
      />,
    );

    const lane1 = screen.getByTestId("track-lane-trk_fx_1");
    const lane2 = screen.getByTestId("track-lane-trk_untyped");
    const laneMusic = screen.getByTestId("track-lane-trk_music");
    const newZone = screen.getByTestId("timeline-new-track-dropzone");
    const ruler = screen.getByTestId("timeline-ruler");

    // Mock bounding rects for viewport, lanes, and new-track dropzone
    const viewport = ruler.parentElement!;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 300,
      right: 800,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(lane1, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 30,
      width: 800,
      height: 56,
      right: 800,
      bottom: 86,
      x: 0,
      y: 30,
      toJSON: () => ({}),
    });
    vi.spyOn(lane2, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 86,
      width: 800,
      height: 56,
      right: 800,
      bottom: 142,
      x: 0,
      y: 86,
      toJSON: () => ({}),
    });
    vi.spyOn(laneMusic, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 142,
      width: 800,
      height: 56,
      right: 800,
      bottom: 198,
      x: 0,
      y: 142,
      toJSON: () => ({}),
    });
    vi.spyOn(newZone, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 198,
      width: 800,
      height: 40,
      right: 800,
      bottom: 238,
      x: 0,
      y: 198,
      toJSON: () => ({}),
    });

    // 1. Scrub ruler
    ptr(ruler, "pointerdown", { clientX: 200 });
    ptr(window, "pointermove", { clientX: 300 });
    ptr(window, "pointerup", { clientX: 300 });

    // 2. Fade-in and Fade-out drags
    ptr(screen.getByTestId("clip-fade-in-trk_fx_1-0"), "pointerdown", { clientX: 100 });
    ptr(window, "pointermove", { clientX: 140 });
    ptr(window, "pointerup");

    ptr(screen.getByTestId("clip-fade-out-trk_fx_1-0"), "pointerdown", { clientX: 400 });
    ptr(window, "pointermove", { clientX: 360 });
    ptr(window, "pointerup");

    // 3. Left trim & Right trim (normal)
    ptr(screen.getByTestId("clip-trim-start-trk_fx_1-0"), "pointerdown", { clientX: 50 });
    ptr(window, "pointermove", { clientX: 100 });
    ptr(window, "pointerup");

    ptr(screen.getByTestId("clip-trim-end-trk_fx_1-0"), "pointerdown", { clientX: 400 });
    ptr(window, "pointermove", { clientX: 450 });
    ptr(window, "pointerup");

    // 4. Enable Rate-Stretch tool -> trim_start & trim_end -> disable -> normal trim on stretched clip
    const stretchBtn = screen.queryByTestId("timeline-stretch-tool-toggle") ??
      screen.queryByRole("button", { name: /Stretch/i });
    if (stretchBtn) {
      fireEvent.click(stretchBtn);
      ptr(screen.getByTestId("clip-trim-start-trk_fx_1-0"), "pointerdown", { clientX: 100 });
      ptr(window, "pointermove", { clientX: 130 });
      ptr(window, "pointerup");

      ptr(screen.getByTestId("clip-trim-end-trk_fx_1-0"), "pointerdown", { clientX: 450 });
      ptr(window, "pointermove", { clientX: 500 });
      ptr(window, "pointerup");

      // Turn stretch OFF and trim stretched clip to preserve speed
      fireEvent.click(stretchBtn);
      ptr(screen.getByTestId("clip-trim-start-trk_fx_1-0"), "pointerdown", { clientX: 130 });
      ptr(window, "pointermove", { clientX: 120 });
      ptr(window, "pointerup");
      ptr(screen.getByTestId("clip-trim-end-trk_fx_1-0"), "pointerdown", { clientX: 500 });
      ptr(window, "pointermove", { clientX: 480 });
      ptr(window, "pointerup");
    }

    // 5. Alt+Drag duplicate onto same track
    ptr(screen.getByTestId("clip-body-trk_fx_1-0"), "pointerdown", {
      clientX: 150,
      altKey: true,
    });
    ptr(window, "pointermove", { clientX: 350, clientY: 50 });
    ptr(window, "pointerup");

    // 6. Cross-track move from trk_fx_1 to trk_untyped (clientY=100), and test hover over incompatible music track (clientY=160)
    ptr(screen.getByTestId("clip-body-trk_fx_1-0"), "pointerdown", { clientX: 150 });
    ptr(window, "pointermove", { clientX: 200, clientY: 160 }); // music track rejected
    ptr(window, "pointermove", { clientX: 200, clientY: 100 }); // untyped accepted
    ptr(window, "pointerup");

    // 7. Drag onto new-track dropzone (clientY=215 -> "__new__")
    await waitFor(() => {
      expect(screen.getByTestId("clip-body-trk_untyped-0")).toBeInTheDocument();
    });
    ptr(screen.getByTestId("clip-body-trk_untyped-0"), "pointerdown", { clientX: 200 });
    ptr(window, "pointermove", { clientX: 250, clientY: 215 });
    ptr(window, "pointerup");

    // Click clip & click empty lane to deselect
    fireEvent.click(lane1);
    expect(useTaktStore.getState().selectedTimelineClip).toBeNull();

    // Expand toggle + Undo / Redo buttons
    fireEvent.click(screen.getByTestId("timeline-expand-toggle"));
    expect(onToggleExpand).toHaveBeenCalled();
  });

  it("covers playback RAF loop, keyboard shortcuts, split, duplicate, delete, auto-fill kicks, track context menu, drops, and zoom", async () => {
    vi.spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    // Trigger RAF playback interpolation (loop=true -> wraps; loop=false -> stops & releases)
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    useTaktStore.setState({
      timelinePlaying: true,
      timelinePlayheadSec: 9.0, // >= contentDurationSec (8s) -> triggers wrap/stop
      timelinePlayheadAnchorMs: performance.now() - 100,
    });

    const { rerender } = render(<TimelineEditor timelineId="tl_1" hideUndoRedo={false} />);

    // Execute queued RAF step (loop_timeline=true -> wraps)
    for (const cb of rafCallbacks.splice(0)) cb(performance.now());

    // Switch loop_timeline=false and re-run RAF step to hit releaseScene branch
    useTaktStore.setState((s) => ({
      showState: {
        ...s.showState,
        timelines: s.showState.timelines.map((t) =>
          t.id === "tl_1" ? { ...t, loop_timeline: false } : t,
        ),
      },
      timelinePlaying: true,
      timelinePlayheadSec: 9.0,
    }));
    rerender(<TimelineEditor timelineId="tl_1" hideUndoRedo={false} />);
    for (const cb of rafCallbacks.splice(0)) cb(performance.now());

    // Stop playing & set playhead inside clip (2.0s)
    useTaktStore.setState({
      timelinePlaying: false,
      timelinePlayheadSec: 2.0,
      selectedTimelineClip: { trackId: "trk_fx_1", clipIndex: 0 },
    });
    rerender(<TimelineEditor timelineId="tl_1" hideUndoRedo={false} />);

    // Zoom buttons + Ctrl+Wheel
    fireEvent.click(screen.getByTestId("timeline-zoom-in"));
    fireEvent.click(screen.getByTestId("timeline-zoom-out"));
    fireEvent.click(screen.getByTestId("timeline-zoom-reset"));
    const scroller = screen.getByTestId("timeline-scroll-container");
    fireEvent.wheel(scroller, { deltaY: -100, ctrlKey: true, clientX: 200 });
    fireEvent.wheel(scroller, { deltaY: 100, ctrlKey: true, clientX: 200 });

    // Split at playhead button
    const splitBtn = screen.queryByTestId("timeline-split-clip-btn") ??
      screen.queryByRole("button", { name: /Split/i });
    if (splitBtn) {
      fireEvent.click(splitBtn);
    }

    // Keyboard shortcuts: Space, Home, Ctrl+D, Delete, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y
    fireEvent.keyDown(window, { code: "Space", key: " " });
    fireEvent.keyDown(window, { key: "Home" });
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });

    // Auto-Fill Kicks (run twice to hit both new track and update existing Kick Hits track)
    const kickBtn = screen.getByTestId("timeline-auto-place-kicks-btn");
    fireEvent.click(kickBtn);
    fireEvent.click(screen.getByTestId("timeline-kicks-confirm-btn"));
    await waitFor(() => {
      expect(
        useTaktStore
          .getState()
          .showState.timelines[0]?.tracks.some((t) => t.name === "Kick Hits"),
      ).toBe(true);
    });
    fireEvent.click(kickBtn);
    fireEvent.click(screen.getByTestId("timeline-kicks-confirm-btn"));

    // Track context menu: switch track type (music cancel -> music confirm -> effect -> untyped)
    const header = screen.getByTestId("track-header-trk_fx_1");
    fireEvent.contextMenu(header, { clientX: 30, clientY: 30 });
    fireEvent.click(screen.getByRole("button", { name: "Set Type: Music Track" }));

    fireEvent.contextMenu(header, { clientX: 30, clientY: 30 });
    fireEvent.click(screen.getByRole("button", { name: "Set Type: Music Track" }));

    fireEvent.contextMenu(header, { clientX: 30, clientY: 30 });
    fireEvent.click(screen.getByRole("button", { name: "Set Type: Effect Track" }));

    fireEvent.contextMenu(header, { clientX: 30, clientY: 30 });
    fireEvent.click(screen.getByRole("button", { name: "Set Type: Untyped" }));

    // Drag/drop scene onto lane & new-track dropzone, plus nested timeline scene (notice banner)
    const lane2 = screen.getByTestId("track-lane-trk_untyped");
    const makeDt = (sceneId: string) => ({
      types: ["text/takt-scene-id"],
      files: [],
      dropEffect: "none",
      getData: (k: string) => (k === "text/takt-scene-id" ? sceneId : ""),
    });
    // Nested timeline scene -> triggers notice banner -> dismiss ×
    fireEvent.drop(lane2, { dataTransfer: makeDt("scn_tl"), clientX: 100 });
    const noticeSpan = await screen.findByText(/Cannot nest a Timeline Super-Scene/i);
    const dismissBtn = noticeSpan.parentElement?.querySelector("button");
    if (dismissBtn) fireEvent.click(dismissBtn);

    fireEvent.dragOver(lane2, { dataTransfer: makeDt("scn_blank") });
    fireEvent.drop(lane2, { dataTransfer: makeDt("scn_blank"), clientX: 100 });

    const newZone = screen.getByTestId("timeline-new-track-dropzone");
    fireEvent.dragOver(newZone, { dataTransfer: makeDt("scn_fx") });
    fireEvent.drop(newZone, { dataTransfer: makeDt("scn_fx"), clientX: 150 });

    // Delete a clip button
    const delClipBtns = screen.queryAllByRole("button", { name: /Delete Clip/i });
    if (delClipBtns.length > 0) {
      fireEvent.click(delClipBtns[0]);
    }
  });

  it("covers waveform PCM & peaks rendering, audio file drops, scene_sequence clip overlays, takt:scene-drop, and toolbar toggles", async () => {
    const pcm = new Float32Array(2000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i * 0.1) * 0.7;

    vi.spyOn(audioEngine, "decodeAudioFile").mockResolvedValue({
      asset: {
        key: "dropped_song.wav",
        name: "dropped_song.wav",
        durationSec: 12,
        sampleRate: 1000,
        monoPcm: pcm,
        audioBuffer: null,
        rawBytes: null,
      } as never,
      analysis: {
        sha256: "mock_dropped",
        sample_rate: 44100,
        duration_sec: 12,
        estimated_bpm: 126,
        grid_offset_sec: 0.1,
        waveform_peaks: [
          { min: -0.6, max: 0.7 },
          { min: -0.9, max: 0.8 },
        ],
        transients: [
          { time_sec: 0.5, band: "kick", strength: 0.9 },
          { time_sec: 1.0, band: "snare", strength: 0.6 },
        ],
      },
    });

    // Add a scene_sequence block + clip to trk_fx_1 and populate audioAnalysisByClipKey
    useTaktStore.setState((s) => ({
      audioAnalysisByClipKey: {
        "track.wav": {
          sha256: "mock_track",
          sample_rate: 44100,
          duration_sec: 8,
          estimated_bpm: 120,
          grid_offset_sec: 0,
          waveform_peaks: [
            { min: -0.5, max: 0.6 },
            { min: -0.8, max: 0.9 },
          ],
          transients: [
            { time_sec: 0.5, band: "kick", strength: 0.9 },
            { time_sec: 1.0, band: "snare", strength: 0.7 },
          ],
        },
      },
      showState: {
        ...s.showState,
        fx_library: [
          ...s.showState.fx_library,
          {
            id: "blk_seq",
            name: "Bounce Seq",
            target_group: "all",
            duration_beats: 6,
            duration_sec: null,
            loop_block: true,
            elements: [
              {
                kind: "scene_sequence",
                playback_mode: "bounce",
                steps: [
                  {
                    scene_id: "scn_fx",
                    duration_value: 2,
                    duration_unit: "beats",
                    fade_sec: 0,
                  },
                  {
                    scene_id: "scn_blank",
                    duration_value: 1,
                    duration_unit: "seconds",
                    fade_sec: 0,
                  },
                ],
              },
            ],
          },
        ],
        timelines: s.showState.timelines.map((tl) =>
          tl.id === "tl_1"
            ? {
                ...tl,
                tracks: tl.tracks.map((tr) =>
                  tr.id === "trk_fx_1"
                    ? {
                        ...tr,
                        clips: [
                          ...tr.clips,
                          {
                            ref_block: "blk_seq",
                            start_sec: 4,
                            duration_sec: 4,
                            fade_in_sec: 0,
                            fade_out_sec: 0,
                            time_stretch: true,
                            source_duration_sec: 3,
                            inline_fx: [],
                          },
                        ],
                      }
                    : tr,
                ),
              }
            : tl,
        ),
      },
    }));

    // First render: peaks fallback (getDecodedAudioAsset returns undefined)
    const getDecodedSpy = vi.spyOn(audioEngine, "getDecodedAudioAsset").mockReturnValue(undefined);
    const { rerender } = render(<TimelineEditor timelineId="tl_1" hideUndoRedo={false} />);

    // Second render: decoded PCM path
    getDecodedSpy.mockReturnValue({
      key: "track.wav",
      name: "track.wav",
      durationSec: 8,
      sampleRate: 1000,
      monoPcm: pcm,
      audioBuffer: null,
      rawBytes: null,
    } as never);
    rerender(<TimelineEditor timelineId="tl_1" hideUndoRedo={false} expanded={false} onToggleExpand={() => {}} />);

    // Click clip directly (selects clip)
    fireEvent.click(screen.getByTestId("timeline-clip-trk_fx_1-1"));

    // Toggle Beats/Seconds and Project Transients and Magnetic Snap
    const unitBtn = screen.queryByTestId("timeline-unit-toggle");
    if (unitBtn) fireEvent.click(unitBtn);
    const projBtn = screen.queryByTestId("timeline-project-transients-toggle");
    if (projBtn) fireEvent.click(projBtn);
    const snapBtn = screen.queryByTestId("timeline-snap-toggle");
    if (snapBtn) fireEvent.click(snapBtn);

    // Trigger Add Music File input
    const audioFile = new File([new Uint8Array([0, 1, 2])], "dropped_song.wav", {
      type: "audio/wav",
    });
    const musicInput = screen.getByLabelText("Add Music File");
    fireEvent.change(musicInput, { target: { files: [audioFile] } });
    await waitFor(() => {
      expect(
        useTaktStore
          .getState()
          .showState.timelines[0]?.tracks.some((t) =>
            t.clips.some((c) => c.audio_file === "dropped_song.wav"),
          ),
      ).toBe(true);
    });

    // Drop audio file onto Effect track (triggers notice) and onto Music track
    const fileDt = {
      types: ["Files"],
      files: [audioFile],
      dropEffect: "copy",
      getData: () => "",
    };
    const laneFx = screen.getByTestId("track-lane-trk_fx_1");
    fireEvent.dragOver(laneFx.parentElement!.parentElement!.parentElement!, {
      dataTransfer: fileDt,
    });
    fireEvent.drop(laneFx, { dataTransfer: fileDt, clientX: 50 });

    const laneMusic = screen.getByTestId("track-lane-trk_music");
    fireEvent.drop(laneMusic, { dataTransfer: fileDt, clientX: 100 });

    const newZone = screen.getByTestId("timeline-new-track-dropzone");
    fireEvent.drop(newZone, { dataTransfer: fileDt, clientX: 100 });

    // Dispatch takt:scene-drop custom event
    window.dispatchEvent(
      new CustomEvent("takt:scene-drop", {
        detail: { sceneId: "scn_fx", trackId: "trk_untyped", clientX: 200 },
      }),
    );

    // Split clip with no selection (auto-finds clip under playhead)
    useTaktStore.setState({ selectedTimelineClip: null, timelinePlayheadSec: 1.5 });
    const splitBtn = screen.queryByTestId("timeline-split-clip-btn") ??
      screen.queryByRole("button", { name: /Split/i });
    if (splitBtn) fireEvent.click(splitBtn);
  });

  it("colors timeline clips using their owner scene's bank color", () => {
    useTaktStore.setState({ selectedTimelineClip: null });
    useTaktStore.getState().setBankColor("Bank 1", "#A855F7");
    render(<TimelineEditor />);

    const clipEl = screen.getByTestId("timeline-clip-trk_fx_1-0");
    expect(clipEl.style.borderColor).toBe("rgb(168, 85, 247)");
    expect(clipEl.style.backgroundColor).toBe("rgba(168, 85, 247, 0.125)");
  });

  it("activates the viewed timeline immediately on mount so it outputs at the playhead before Play is pressed", async () => {
    useTaktStore.setState({
      activeTimelineId: null,
      timelinePlaying: false,
      timelinePlayheadSec: 1.0,
    });
    render(<TimelineEditor />);

    await waitFor(() => {
      expect(useTaktStore.getState().activeTimelineId).toBe("tl_1");
      expect(useTaktStore.getState().timelinePlaying).toBe(false);
    });
  });

  it("does not restart music from the beginning when adjusting a clip while the timeline is playing", async () => {
    const startFromSpy = vi.spyOn(audioEngine.timelineAudioPlayer, "startFrom");
    const nowMs = performance.now();
    useTaktStore.setState({
      activeTimelineId: "tl_1",
      timelinePlaying: true,
      timelinePlayheadSec: 0,
      timelinePlayheadAnchorMs: nowMs - 2000,
    });
    render(<TimelineEditor />);

    expect(startFromSpy).toHaveBeenCalledTimes(1);
    startFromSpy.mockClear();

    // Adjust a color/FX clip while playing
    const tl = useTaktStore.getState().showState.timelines[0]!;
    await useTaktStore.getState().upsertTimeline({
      ...tl,
      tracks: tl.tracks.map((tr) =>
        tr.id === "trk_fx_1"
          ? {
              ...tr,
              clips: tr.clips.map((c, idx) =>
                idx === 0 ? { ...c, duration_sec: 3.5 } : c,
              ),
            }
          : tr,
      ),
    });

    expect(startFromSpy).not.toHaveBeenCalled();
  });

  it("synchronously anchors scrollLeft on Ctrl+Wheel zoom without requestAnimationFrame delay and prevents default browser zoom", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    render(<TimelineEditor />);

    const viewport = screen.getByTestId("timeline-ruler").parentElement as HTMLDivElement;
    const scroller = screen.getByTestId("timeline-scroll-container") as HTMLDivElement;

    // Seed a scrolled viewport (default 1.0x zoom -> 32s * 24px = 768px)
    Object.defineProperty(scroller, "clientWidth", { value: 400, configurable: true });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 0,
      left: 100,
      top: 0,
      right: 500,
      bottom: 200,
      width: 400,
      height: 200,
      toJSON: () => ({}),
    });
    scroller.scrollLeft = 200;

    // Cursor is at clientX = 300 => cursorOffsetX = 200px from scroller left.
    // At 1.0x (viewportWidth = 768px), cursor points to x = 400px (time = 400/768 * 32s).
    const wheelEv = new WheelEvent("wheel", {
      deltaY: -100,
      ctrlKey: true,
      clientX: 300,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      scroller.dispatchEvent(wheelEv);
    });

    // Native non-passive wheel listener must prevent default WebView/browser zoom
    expect(wheelEv.defaultPrevented).toBe(true);

    // Zoom updated to 1.25x (viewportWidth = 32 * 24 * 1.25 = 960px)
    expect(screen.getByTestId("timeline-zoom-reset")).toHaveTextContent("1.3×");
    expect(viewport.style.width).toBe("960px");

    // scrollLeft must ALREADY be adjusted synchronously via useLayoutEffect (before any RAF runs):
    // targetScrollLeft = (400 / 768) * 960 - 200 = 500 - 200 = 300
    expect(rafSpy).not.toHaveBeenCalled();
    expect(scroller.scrollLeft).toBeCloseTo(300, 1);

    // Zooming back out returns to the exact same anchor synchronously
    const wheelOutEv = new WheelEvent("wheel", {
      deltaY: 100,
      ctrlKey: true,
      clientX: 300,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      scroller.dispatchEvent(wheelOutEv);
    });
    expect(wheelOutEv.defaultPrevented).toBe(true);
    expect(viewport.style.width).toBe("768px");
    expect(scroller.scrollLeft).toBeCloseTo(200, 1);
  });

  it("quantizes music clip waveform canvas backing width to power-of-2 buckets so minor zoom steps do not wipe/reallocate the canvas", () => {
    const clearRectSpy = vi.fn();
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(function (this: HTMLCanvasElement, type: string) {
        const ctx = origGetContext.call(this, type as "2d");
        if (ctx && "clearRect" in ctx) {
          ctx.clearRect = clearRectSpy;
        }
        return ctx;
      } as typeof HTMLCanvasElement.prototype.getContext);

    try {
      render(<TimelineEditor />);
      const canvas = screen.getByTestId("clip-waveform-trk_music-0") as HTMLCanvasElement;
      const initialWidth = canvas.width;
      // 8s music clip at 1.0x (24px/s) = 192px -> quantized power-of-2 bucket = 256
      expect(initialWidth).toBe(256);
      expect(clearRectSpy).toHaveBeenCalledTimes(1);

      // Zoom out to 0.8x (153.6px) -> still in the 256px bucket, so canvas must NOT wipe/redraw
      const scroller = screen.getByTestId("timeline-scroll-container");
      act(() => {
        scroller.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: 100,
            ctrlKey: true,
            clientX: 200,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(canvas.width).toBe(256);
      expect(clearRectSpy).toHaveBeenCalledTimes(1);

      // Zoom in to 1.3x (249.6px) -> still in the 256px bucket, still no wipe/redraw
      fireEvent.click(screen.getByTestId("timeline-zoom-in"));
      expect(canvas.width).toBe(256);
      expect(clearRectSpy).toHaveBeenCalledTimes(1);

      // Zoom in to 1.8x (345.6px) -> crosses 256 into 512px bucket and redraws once cleanly
      fireEvent.click(screen.getByTestId("timeline-zoom-in"));
      expect(canvas.width).toBe(512);
      expect(clearRectSpy).toHaveBeenCalledTimes(2);
    } finally {
      getContextSpy.mockRestore();
    }
  });
});
