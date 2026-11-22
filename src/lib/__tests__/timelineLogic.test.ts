import { describe, expect, it } from "vitest";
import {
  applySingleTrackOverwrite,
  clampTrimEndNonOverlapping,
  clampTrimStartNonOverlapping,
  cleanBeatValue,
  clipsOverlap,
  computeEffectCycleBoundaries,
  computeSnapGridMarkers,
  computeTimelineContentDurationSec,
  computeTimelineViewportDurationSec,
  computeZoomAdaptiveRulerTicks,
  durationBeatsToSec,
  gridBeatsToSec,
  resolveNonOverlappingStart,
  secToDurationBeats,
  secToGridBeats,
} from "../timelineLogic";

describe("timelineLogic", () => {
  it("detects clip overlaps accurately with boundary tolerance", () => {
    expect(clipsOverlap(0, 4, 4, 4)).toBe(false);
    expect(clipsOverlap(0, 4, 3.9, 4)).toBe(true);
    expect(clipsOverlap(2, 2, 0, 1)).toBe(false);
  });

  it("overwrites, trims, deletes, and splits underlying clips on single-track drop/move", () => {
    // 1. Tail & head trim
    const existing = [
      { id: "a", start_sec: 0, duration_sec: 6, fade_in_sec: 0.5, fade_out_sec: 0.5 },
      { id: "b", start_sec: 8, duration_sec: 6, fade_in_sec: 0.5, fade_out_sec: 0.5 },
    ];
    const incoming = { id: "c", start_sec: 4, duration_sec: 6, fade_in_sec: 0, fade_out_sec: 0 };
    const { clips, insertedIndex } = applySingleTrackOverwrite(incoming, existing);
    expect(clips.map((c) => [c.id, c.start_sec, c.duration_sec])).toEqual([
      ["a", 0, 4],
      ["c", 4, 6],
      ["b", 10, 4],
    ]);
    expect(insertedIndex).toBe(1);

    // 2. Fully covered clip is deleted
    const covered = [{ id: "small", start_sec: 5, duration_sec: 2 }];
    const big = { id: "big", start_sec: 2, duration_sec: 8 };
    const resCovered = applySingleTrackOverwrite(big, covered);
    expect(resCovered.clips).toEqual([big]);

    // 3. Encompassing clip is split into left and right segments
    const wide = [{ id: "wide", start_sec: 0, duration_sec: 12, fade_in_sec: 1, fade_out_sec: 1 }];
    const mid = { id: "mid", start_sec: 4, duration_sec: 3, fade_in_sec: 0, fade_out_sec: 0 };
    const resSplit = applySingleTrackOverwrite(mid, wide);
    expect(resSplit.clips.map((c) => [c.id, c.start_sec, c.duration_sec])).toEqual([
      ["wide", 0, 4],
      ["mid", 4, 3],
      ["wide", 7, 5],
    ]);
    expect(resSplit.clips[0].fade_out_sec).toBe(0);
    expect(resSplit.clips[2].fade_in_sec).toBe(0);
  });

  it("computes dynamic content duration and infinite-canvas viewport duration beyond 32s", () => {
    expect(computeTimelineContentDurationSec([])).toBe(0);
    expect(computeTimelineViewportDurationSec([], 32, 8)).toBe(32);

    const longTracks = [
      { clips: [{ start_sec: 0, duration_sec: 10 }] },
      { clips: [{ start_sec: 5, duration_sec: 42.5 }] },
    ];
    expect(computeTimelineContentDurationSec(longTracks)).toBe(47.5);
    expect(computeTimelineViewportDurationSec(longTracks, 32, 8)).toBe(56);
  });

  it("clamps dragged clip to nearest non-overlapping edge and jumps across when closer", () => {
    const others = [{ start_sec: 4, duration_sec: 4 }];
    expect(resolveNonOverlappingStart(3.2, 2, others, 16)).toBe(2);
    expect(resolveNonOverlappingStart(6.8, 2, others, 16)).toBe(8);
    expect(resolveNonOverlappingStart(10, 2, others, 16)).toBe(10);
  });

  it("returns null when no gap on the track fits the clip duration", () => {
    const others = [
      { start_sec: 0, duration_sec: 6 },
      { start_sec: 7, duration_sec: 9 },
    ];
    expect(resolveNonOverlappingStart(2, 4, others, 16)).toBeNull();
  });

  it("clamps trim start and trim end at adjacent clip boundaries", () => {
    const others = [
      { start_sec: 0, duration_sec: 2 },
      { start_sec: 8, duration_sec: 4 },
    ];
    expect(clampTrimStartNonOverlapping(1.0, 6.0, others)).toBe(2);
    expect(clampTrimEndNonOverlapping(4.0, 10.0, others, 16)).toBe(8);
  });

  it("adapts ruler tick spacing dynamically as zoom (pxPerSec) changes", () => {
    const zoomedOut = computeZoomAdaptiveRulerTicks(180, 6, "seconds", 120, 0);
    const zoomedMid = computeZoomAdaptiveRulerTicks(180, 24, "seconds", 120, 0);
    const zoomedIn = computeZoomAdaptiveRulerTicks(180, 120, "seconds", 120, 0);
    expect(zoomedOut[1].timeSec - zoomedOut[0].timeSec).toBe(15);
    expect(zoomedMid[1].timeSec - zoomedMid[0].timeSec).toBe(5);
    expect(zoomedIn[1].timeSec - zoomedIn[0].timeSec).toBe(1);

    const beatTicks = computeZoomAdaptiveRulerTicks(32, 60, "beats", 120, 0.25);
    expect(beatTicks[0].timeSec).toBeCloseTo(0.25, 2);
    expect(beatTicks[0].label).toBe("1.1");
    expect(beatTicks[0].isMajor).toBe(true);
  });

  it("computes effect cycle-repeat boundaries and suppresses them in time-stretch mode", () => {
    expect(computeEffectCycleBoundaries(8, 2, false)).toEqual([2, 4, 6]);
    expect(computeEffectCycleBoundaries(8, 2, true)).toEqual([]);
  });

  it("aligns beat positions with gridOffsetSec so 32.0b matches bar 9.1 exactly and snaps to whole beats", () => {
    const bpm = 130;
    const gridOffsetSec = 0.35;
    // Beat 0 = 0.35s (Bar 1.1); Beat 32 = 0.35 + 32*60/130 = 15.119s (Bar 9.1)
    const bar9Sec = gridBeatsToSec(32, bpm, gridOffsetSec);
    expect(bar9Sec).toBeCloseTo(gridOffsetSec + (32 * 60) / bpm, 2);
    expect(secToGridBeats(bar9Sec, bpm, gridOffsetSec)).toBeCloseTo(32, 2);

    const ruler = computeZoomAdaptiveRulerTicks(20, 60, "beats", bpm, gridOffsetSec);
    const bar9Tick = ruler.find((t) => t.label === "9.1");
    expect(bar9Tick).toBeDefined();
    expect(bar9Tick!.timeSec).toBeCloseTo(bar9Sec, 2);

    const wholeBeatSnaps = computeSnapGridMarkers(10, 120, 0.2, "beat");
    expect(wholeBeatSnaps.slice(0, 4)).toEqual([0, 0.2, 0.7, 1.2]);
    const barSnaps = computeSnapGridMarkers(10, 120, 0.2, "bar");
    expect(barSnaps.slice(0, 4)).toEqual([0, 0.2, 2.2, 4.2]);

    // Exact beat round-trip at non-integer BPM (130 BPM) with zero 15.999 artifacts
    const dur16Sec = durationBeatsToSec(16, 130);
    expect(secToDurationBeats(dur16Sec, 130)).toBe(16);
    expect(cleanBeatValue(15.9987)).toBe(16);
    expect(cleanBeatValue(0.0012)).toBe(0);
  });
});
