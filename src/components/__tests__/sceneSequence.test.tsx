import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { useTaktStore } from "../../store/useTaktStore";

describe("Scene Sequence UI & Timeline Integration", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  it("handles takt:scene-sequence-drop, rejects self-drop and timeline scenes, and sizes timeline clips to summed duration", async () => {
    const store = useTaktStore.getState();

    // Create two regular scenes (2 beats = 1.0s at 120 BPM, and 1.5 seconds)
    await store.upsertFxBlock({
      id: "blk_red",
      name: "Red Look",
      target_group: "all",
      duration_beats: 2,
      loop_block: true,
      elements: [
        {
          kind: "static_trait",
          trait: "color",
          op: "ltp",
          palette_ref: null,
          value_start: 0,
          value_end: 1,
          hex_start: "#FF0000",
          hex_end: "#FF0000",
          order: null,
        },
      ],
    });
    await store.upsertScene({
      id: "sc_red",
      name: "Red Look",
      bank: "Bank 1",
      target_group: "all",
      priority: 10,
      fade_in_sec: 0,
      fade_out_sec: 0,
      duration_value: 2,
      duration_unit: "beats",
      block_refs: ["blk_red"],
    });

    await store.upsertFxBlock({
      id: "blk_blue",
      name: "Blue Look",
      target_group: "all",
      duration_beats: 4,
      duration_sec: 1.5,
      loop_block: true,
      elements: [
        {
          kind: "static_trait",
          trait: "color",
          op: "ltp",
          palette_ref: null,
          value_start: 0,
          value_end: 1,
          hex_start: "#0044FF",
          hex_end: "#0044FF",
          order: null,
        },
      ],
    });
    await store.upsertScene({
      id: "sc_blue",
      name: "Blue Look",
      bank: "Bank 1",
      target_group: "all",
      priority: 10,
      fade_in_sec: 0,
      fade_out_sec: 0,
      duration_value: 1.5,
      duration_unit: "seconds",
      block_refs: ["blk_blue"],
    });

    // Also add a Timeline Super-Scene to test rejection
    await store.upsertTimeline({
      id: "tl_main",
      name: "Main Timeline",
      duration_sec: 32,
      grid_offset_sec: 0,
      tempo_map: [{ at_sec: 0, bpm: 120 }],
      audio_track: null,
      tracks: [
        {
          id: "trk_1",
          name: "Track 1",
          track_type: "effect",
          target_group: "all",
          clips: [],
        },
      ],
    });
    await store.upsertScene({
      id: "sc_tl_super",
      name: "Super Timeline",
      bank: "Bank 1",
      target_group: "all",
      priority: 10,
      fade_in_sec: 0,
      fade_out_sec: 0,
      duration_value: 4,
      duration_unit: "beats",
      block_refs: [],
      timeline_ref: "tl_main",
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Studio \/ 2D Grid/i }));

    // Create a fresh scene and convert it to a Scene Sequence
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-add-scene-Bank 1"));
      await Promise.resolve();
    });
    const scenesAfterAdd = useTaktStore.getState().showState.scenes;
    const seqScene = scenesAfterAdd[scenesAfterAdd.length - 1];
    fireEvent.click(screen.getByTestId(`scene-play-zone-${seqScene.id}`));

    await act(async () => {
      fireEvent.click(screen.getByTestId("fx-picker-tile-scene_sequence"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("scene-sequence-editor")).toBeInTheDocument();
    const dropzone = screen.getByTestId("scene-sequence-dropzone");
    const targetBlockId = dropzone.getAttribute("data-target-block-id") ?? "";
    expect(targetBlockId).not.toBe("");

    // Drop sc_red and sc_blue via takt:scene-sequence-drop
    await act(async () => {
      dropzone.dispatchEvent(
        new CustomEvent("takt:scene-sequence-drop", {
          bubbles: true,
          detail: { sceneId: "sc_red", targetBlockId },
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      dropzone.dispatchEvent(
        new CustomEvent("takt:scene-sequence-drop", {
          bubbles: true,
          detail: { sceneId: "sc_blue", targetBlockId },
        }),
      );
      await Promise.resolve();
    });

    // Reject self-drop
    await act(async () => {
      dropzone.dispatchEvent(
        new CustomEvent("takt:scene-sequence-drop", {
          bubbles: true,
          detail: { sceneId: seqScene.id, targetBlockId },
        }),
      );
      await Promise.resolve();
    });
    expect(screen.getByTestId("seq-drop-notice").textContent).toMatch(/itself/i);

    // Reject timeline super-scene drop
    await act(async () => {
      dropzone.dispatchEvent(
        new CustomEvent("takt:scene-sequence-drop", {
          bubbles: true,
          detail: { sceneId: "sc_tl_super", targetBlockId },
        }),
      );
      await Promise.resolve();
    });
    expect(screen.getByTestId("seq-drop-notice").textContent).toMatch(/Timeline/i);

    // Verify only the 2 valid steps were added (1.0s + 1.5s = 2.5s)
    const seqBlock = useTaktStore
      .getState()
      .showState.fx_library.find((b) => b.id === targetBlockId);
    const seqElem = seqBlock?.elements.find((e) => e.kind === "scene_sequence");
    expect(seqElem?.kind === "scene_sequence" ? seqElem.steps.length : 0).toBe(2);
    expect(screen.getByTestId("seq-total-duration").textContent).toBe("2.50s");

    // Select the Timeline Super-Scene to open TimelineEditor and drop the sequence scene onto Track 1
    await act(async () => {
      fireEvent.click(screen.getByTestId("scene-play-zone-sc_tl_super"));
      await Promise.resolve();
    });
    const lane = screen.getByTestId("track-lane-trk_1");
    await act(async () => {
      lane.dispatchEvent(
        new CustomEvent("takt:scene-drop", {
          bubbles: true,
          detail: { sceneId: seqScene.id, trackId: "trk_1", clientX: 100 },
        }),
      );
      await Promise.resolve();
    });

    const tl = useTaktStore
      .getState()
      .showState.timelines.find((t) => t.id === "tl_main")!;
    const clip = tl.tracks[0].clips[0];
    expect(clip).toBeDefined();
    expect(clip.ref_block).toBe(targetBlockId);
    expect(clip.duration_sec).toBeCloseTo(2.5, 3);
    expect(clip.source_duration_sec).toBeCloseTo(2.5, 3);

    // Step boundary & labels rendered inside the sequence clip
    expect(screen.getByTestId("clip-seq-overlay-trk_1-0")).toBeInTheDocument();
    expect(
      screen.getByTestId("clip-seq-step-boundary-trk_1-0-1"),
    ).toBeInTheDocument();
  });
});
