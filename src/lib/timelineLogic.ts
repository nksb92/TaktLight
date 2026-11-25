import type { TrackDef } from "./mixerLogic";

export interface TimeInterval {
  start_sec: number;
  duration_sec: number;
  fade_in_sec?: number;
  fade_out_sec?: number;
}

const EPS = 1e-4;

export function clipsOverlap(
  aStart: number,
  aDur: number,
  bStart: number,
  bDur: number,
): boolean {
  const aEnd = aStart + aDur;
  const bEnd = bStart + bDur;
  return aStart < bEnd - EPS && bStart < aEnd - EPS;
}

/**
 * Single-track NLE overwrite/trim resolution.
 * Places `incoming` onto a track containing `existingClips`:
 * - Non-overlapping clips remain untouched.
 * - Clips fully covered by `incoming` are removed.
 * - Clips partially overlapped at the start or end are trimmed cleanly.
 * - A clip completely encompassing `incoming` is split into left and right segments.
 * Returns the resulting sorted clip array with zero overlaps.
 */
export function applySingleTrackOverwrite<T extends TimeInterval>(
  incoming: T,
  existingClips: ReadonlyArray<T>,
  minDur = 0.05,
): { clips: T[]; insertedIndex: number } {
  const inStart = Number(Math.max(0, incoming.start_sec).toFixed(6));
  const inDur = Number(Math.max(minDur, incoming.duration_sec).toFixed(6));
  const inEnd = inStart + inDur;
  const normalizedIncoming: T = {
    ...incoming,
    start_sec: inStart,
    duration_sec: inDur,
  };

  const result: T[] = [];

  for (const clip of existingClips) {
    const cStart = Math.max(0, clip.start_sec);
    const cDur = Math.max(0, clip.duration_sec);
    const cEnd = cStart + cDur;

    // 1. No overlap
    if (cEnd <= inStart + EPS || cStart >= inEnd - EPS) {
      result.push(clip);
      continue;
    }

    // 2. Fully covered -> drop
    if (cStart >= inStart - EPS && cEnd <= inEnd + EPS) {
      continue;
    }

    // 3. Encompassing -> split into left + right segments
    if (cStart < inStart - EPS && cEnd > inEnd + EPS) {
      const leftDur = Number((inStart - cStart).toFixed(3));
      const rightDur = Number((cEnd - inEnd).toFixed(3));
      if (leftDur >= minDur) {
        result.push({
          ...clip,
          start_sec: Number(cStart.toFixed(3)),
          duration_sec: leftDur,
          ...(clip.fade_in_sec !== undefined
            ? { fade_in_sec: Math.min(clip.fade_in_sec, leftDur * 0.5) }
            : {}),
          ...(clip.fade_out_sec !== undefined ? { fade_out_sec: 0 } : {}),
        });
      }
      if (rightDur >= minDur) {
        result.push({
          ...clip,
          start_sec: Number(inEnd.toFixed(3)),
          duration_sec: rightDur,
          ...(clip.fade_in_sec !== undefined ? { fade_in_sec: 0 } : {}),
          ...(clip.fade_out_sec !== undefined
            ? { fade_out_sec: Math.min(clip.fade_out_sec, rightDur * 0.5) }
            : {}),
        });
      }
      continue;
    }

    // 4. Tail of existing clip overlapped -> trim end to inStart
    if (cStart < inStart - EPS && cEnd > inStart + EPS) {
      const nextDur = Number((inStart - cStart).toFixed(3));
      if (nextDur >= minDur) {
        result.push({
          ...clip,
          start_sec: Number(cStart.toFixed(3)),
          duration_sec: nextDur,
          ...(clip.fade_in_sec !== undefined
            ? { fade_in_sec: Math.min(clip.fade_in_sec, nextDur * 0.5) }
            : {}),
          ...(clip.fade_out_sec !== undefined
            ? { fade_out_sec: Math.min(clip.fade_out_sec, nextDur * 0.5) }
            : {}),
        });
      }
      continue;
    }

    // 5. Head of existing clip overlapped -> trim start to inEnd
    if (cStart < inEnd - EPS && cEnd > inEnd + EPS) {
      const nextDur = Number((cEnd - inEnd).toFixed(3));
      if (nextDur >= minDur) {
        result.push({
          ...clip,
          start_sec: Number(inEnd.toFixed(3)),
          duration_sec: nextDur,
          ...(clip.fade_in_sec !== undefined
            ? { fade_in_sec: Math.min(clip.fade_in_sec, nextDur * 0.5) }
            : {}),
          ...(clip.fade_out_sec !== undefined
            ? { fade_out_sec: Math.min(clip.fade_out_sec, nextDur * 0.5) }
            : {}),
        });
      }
    }
  }

  result.push(normalizedIncoming);
  result.sort((a, b) => a.start_sec - b.start_sec);
  const insertedIndex = result.indexOf(normalizedIncoming);
  return { clips: result, insertedIndex: Math.max(0, insertedIndex) };
}

/**
 * Computes the actual content duration of a timeline (end of the last clip across all tracks).
 */
export function computeTimelineContentDurationSec(
  tracks: ReadonlyArray<{ clips: ReadonlyArray<TimeInterval> }>,
): number {
  let maxEnd = 0;
  for (const trk of tracks) {
    for (const clip of trk.clips) {
      const end = Math.max(0, clip.start_sec) + Math.max(0, clip.duration_sec);
      if (end > maxEnd) maxEnd = end;
    }
  }
  return Number(maxEnd.toFixed(3));
}

/**
 * Computes the dynamic viewport duration for an infinite scrolling canvas:
 * always gives trailing breathing room past the last clip (minimum 32s).
 */
export function computeTimelineViewportDurationSec(
  tracks: ReadonlyArray<{ clips: ReadonlyArray<TimeInterval> }>,
  minSec = 32,
  tailPaddingSec = 8,
): number {
  const content = computeTimelineContentDurationSec(tracks);
  return Math.max(minSec, Math.ceil(content + tailPaddingSec));
}

export interface RulerTick {
  timeSec: number;
  label: string;
  isMajor: boolean;
}

/**
 * Computes zoom-adaptive ruler ticks based on pixels-per-second so zooming in/out
 * smoothly switches reference intervals (e.g. 30s -> 15s -> 10s -> 5s -> 2s -> 1s,
 * or 4 bars -> 2 bars -> 1 bar -> 1 beat).
 */
export function computeZoomAdaptiveRulerTicks(
  viewportDurationSec: number,
  pxPerSec: number,
  timeUnit: "beats" | "seconds",
  bpm: number,
  gridOffsetSec = 0,
  targetSpacingPx = 90,
): RulerTick[] {
  const safeDur = Math.max(0.1, viewportDurationSec);
  const safePxPerSec = Math.max(1, pxPerSec);
  const minSecStep = targetSpacingPx / safePxPerSec;

  if (timeUnit === "seconds") {
    const candidates = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const step =
      candidates.find((c) => c >= minSecStep) ??
      candidates[candidates.length - 1];
    const ticks: RulerTick[] = [];
    for (let t = 0; t <= safeDur + 1e-6; t += step) {
      const rounded = Number(t.toFixed(2));
      ticks.push({
        timeSec: rounded,
        label: rounded >= 60
          ? `${Math.floor(rounded / 60)}:${String(Math.round(rounded % 60)).padStart(2, "0")}`
          : `${rounded}s`,
        isMajor: true,
      });
    }
    return ticks;
  }

  const safeBpm = Math.max(20, bpm || 120);
  const secPerBeat = 60 / safeBpm;
  const beatCandidates = [1, 2, 4, 8, 16, 32, 64];
  const beatStep =
    beatCandidates.find((b) => b * secPerBeat >= minSecStep) ??
    beatCandidates[beatCandidates.length - 1];

  const ticks: RulerTick[] = [];
  const startBeat = Math.max(0, Math.floor((-gridOffsetSec) / secPerBeat));
  for (let b = startBeat; ; b += beatStep) {
    const t = gridOffsetSec + b * secPerBeat;
    if (t > safeDur + 1e-6) break;
    if (t < -1e-6) continue;
    const bar = Math.floor(b / 4) + 1;
    const beatInBar = (b % 4) + 1;
    const label = beatStep >= 4 ? `${bar}.1` : `${bar}.${beatInBar}`;
    ticks.push({
      timeSec: Number(Math.max(0, t).toFixed(6)),
      label,
      isMajor: Math.abs(b % 4) < 1e-4,
    });
  }
  return ticks;
}

/**
 * Computes relative cycle-repeat boundary offsets (in seconds from clip start)
 * for visualizing an FX scene's natural cycle duration inside a timeline clip.
 * Returns an empty array when timeStretch is enabled (1 stretched cycle fills the clip).
 */
export function computeEffectCycleBoundaries(
  clipDurationSec: number,
  naturalCycleSec: number,
  timeStretch: boolean,
): number[] {
  if (timeStretch || naturalCycleSec <= 0.05 || clipDurationSec <= naturalCycleSec + 1e-4) {
    return [];
  }
  const boundaries: number[] = [];
  const maxLines = 64;
  for (let t = naturalCycleSec; t < clipDurationSec - 1e-4; t += naturalCycleSec) {
    boundaries.push(t);
    if (boundaries.length >= maxLines) break;
  }
  return boundaries;
}

export type SnapGridSubdivision = "bar" | "beat" | "half" | "quarter";

/**
 * Eliminates floating-point rounding artifacts like 15.999 or 0.001 when converting
 * seconds back to musical beats (snapping within 0.005 beats of a 1/4-beat grid).
 */
export function cleanBeatValue(rawBeats: number): number {
  const nearestQuarter = Math.round(rawBeats * 4) / 4;
  if (Math.abs(rawBeats - nearestQuarter) < 0.005) {
    return Number(nearestQuarter.toFixed(2));
  }
  return Number(rawBeats.toFixed(3));
}

/**
 * Converts an absolute timeline timestamp (seconds) to beat position relative to
 * the timeline's beat-grid phase (`gridOffsetSec`), so Beat 0.0 === Bar 1.1 and
 * Beat 32.0 === Bar 9.1 pixel-for-pixel.
 */
export function secToGridBeats(
  sec: number,
  bpm: number,
  gridOffsetSec = 0,
): number {
  const safeBpm = Math.max(20, bpm || 120);
  return cleanBeatValue(((sec - gridOffsetSec) * safeBpm) / 60);
}

export function gridBeatsToSec(
  beats: number,
  bpm: number,
  gridOffsetSec = 0,
): number {
  const safeBpm = Math.max(20, bpm || 120);
  return Number(Math.max(0, gridOffsetSec + (beats * 60) / safeBpm).toFixed(6));
}

export function secToDurationBeats(sec: number, bpm: number): number {
  const safeBpm = Math.max(20, bpm || 120);
  return cleanBeatValue((sec * safeBpm) / 60);
}

export function durationBeatsToSec(beats: number, bpm: number): number {
  const safeBpm = Math.max(20, bpm || 120);
  return Number(Math.max(0.05, (beats * 60) / safeBpm).toFixed(6));
}

/**
 * Generates snap grid timestamps aligned to `gridOffsetSec` for the chosen
 * musical subdivision: Bar (4 beats), Beat (1 beat), 1/2 Beat, or 1/4 Beat.
 */
export function computeSnapGridMarkers(
  viewportDurationSec: number,
  bpm: number,
  gridOffsetSec = 0,
  subdivision: SnapGridSubdivision = "beat",
): number[] {
  const safeDur = Math.max(0.1, viewportDurationSec);
  const safeBpm = Math.max(20, bpm || 120);
  const secPerBeat = 60 / safeBpm;
  const mult =
    subdivision === "bar"
      ? 4
      : subdivision === "half"
        ? 0.5
        : subdivision === "quarter"
          ? 0.25
          : 1;
  const stepSec = secPerBeat * mult;
  const markers: number[] = [0];
  for (let t = Math.max(0, gridOffsetSec); t <= safeDur + 1e-6; t += stepSec) {
    markers.push(Number(t.toFixed(6)));
  }
  return markers;
}

/**
 * Finds the closest non-overlapping start time in [0, timelineDuration - duration]
 * for a clip of `duration` against `otherClips`.
 * Returns `null` if no free gap on the track can accommodate `duration`.
 */
export function resolveNonOverlappingStart(
  desiredStart: number,
  duration: number,
  otherClips: ReadonlyArray<TimeInterval>,
  timelineDuration: number,
): number | null {
  const safeDur = Math.max(0.1, duration);
  const maxStart = Math.max(0, timelineDuration - safeDur);
  const clampedDesired = Math.max(0, Math.min(maxStart, desiredStart));

  const sorted = otherClips
    .map((c) => ({
      start: Math.max(0, c.start_sec),
      end: Math.min(timelineDuration, c.start_sec + Math.max(0.05, c.duration_sec)),
    }))
    .filter((iv) => iv.end > iv.start + EPS)
    .sort((a, b) => a.start - b.start);

  const hasOverlap = sorted.some((iv) =>
    clipsOverlap(clampedDesired, safeDur, iv.start, iv.end - iv.start),
  );
  if (!hasOverlap) {
    return Number(clampedDesired.toFixed(3));
  }

  const merged: Array<{ start: number; end: number }> = [];
  for (const iv of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && iv.start <= prev.end + EPS) {
      prev.end = Math.max(prev.end, iv.end);
    } else {
      merged.push({ ...iv });
    }
  }

  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const iv of merged) {
    if (iv.start > cursor + EPS) {
      gaps.push({ start: cursor, end: iv.start });
    }
    cursor = Math.max(cursor, iv.end);
  }
  if (timelineDuration > cursor + EPS) {
    gaps.push({ start: cursor, end: timelineDuration });
  }

  let bestStart: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const gap of gaps) {
    if (gap.end - gap.start + EPS < safeDur) continue;
    const candidate = Math.max(
      gap.start,
      Math.min(gap.end - safeDur, clampedDesired),
    );
    const dist = Math.abs(candidate - clampedDesired);
    if (dist < bestDist - 1e-6) {
      bestDist = dist;
      bestStart = candidate;
    }
  }

  return bestStart === null ? null : Number(Math.max(0, bestStart).toFixed(3));
}

export function clampTrimStartNonOverlapping(
  desiredStart: number,
  fixedEnd: number,
  otherClips: ReadonlyArray<TimeInterval>,
  minDur = 0.1,
): number {
  let floorStart = 0;
  for (const c of otherClips) {
    const end = c.start_sec + c.duration_sec;
    if (end <= fixedEnd + EPS && end > floorStart) {
      floorStart = end;
    }
  }
  const maxAllowed = Math.max(floorStart, fixedEnd - minDur);
  return Number(
    Math.max(floorStart, Math.min(maxAllowed, desiredStart)).toFixed(6),
  );
}

export function clampTrimEndNonOverlapping(
  fixedStart: number,
  desiredEnd: number,
  otherClips: ReadonlyArray<TimeInterval>,
  maxEnd = Number.POSITIVE_INFINITY,
  minDur = 0.1,
): number {
  let ceilEnd = maxEnd;
  for (const c of otherClips) {
    if (c.start_sec >= fixedStart - EPS && c.start_sec < ceilEnd) {
      ceilEnd = c.start_sec;
    }
  }
  const minAllowed = Math.min(ceilEnd, fixedStart + minDur);
  return Number(
    Math.max(minAllowed, Math.min(ceilEnd, desiredEnd)).toFixed(6),
  );
}

/**
 * Ensures there is always at least one empty `untyped` track below the lowest
 * track that currently contains clips.
 */
export function ensureTrailingEmptyTrack(tracks: TrackDef[]): TrackDef[] {
  if (tracks.length === 0) {
    return [
      {
        id: "trk_1",
        name: "Track 1",
        track_type: "untyped",
        target_group: "all",
        clips: [],
      },
    ];
  }

  let lastUsedIdx = -1;
  for (let i = tracks.length - 1; i >= 0; i--) {
    if (tracks[i].clips.length > 0) {
      lastUsedIdx = i;
      break;
    }
  }
  if (lastUsedIdx === -1) {
    return tracks;
  }

  const hasFreeBelow = tracks
    .slice(lastUsedIdx + 1)
    .some(
      (t) =>
        t.clips.length === 0 && (t.track_type ?? "untyped") === "untyped",
    );
  if (hasFreeBelow) {
    return tracks;
  }

  let maxTrackNum = tracks.length;
  for (const tr of tracks) {
    const m = tr.name.match(/^Track\s+(\d+)$/i);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > maxTrackNum) maxTrackNum = n;
    }
  }
  const nextNum = maxTrackNum + 1;
  const candidateId = `trk_${nextNum}`;
  const id = tracks.some((t) => t.id === candidateId)
    ? `trk_${Date.now()}_${nextNum}`
    : candidateId;

  return [
    ...tracks,
    {
      id,
      name: `Track ${nextNum}`,
      track_type: "untyped",
      target_group: "all",
      clips: [],
    },
  ];
}

export type SnapTargetKind = "beat" | "kick" | "snare" | "clip";

export interface SnapTarget {
  time_sec: number;
  kind: SnapTargetKind;
}

const SNAP_KIND_PRIORITY: Record<SnapTargetKind, number> = {
  snare: 3,
  kick: 3,
  beat: 2,
  clip: 1,
};

export function computeSnapThresholdSec(
  pxPerSec: number,
  maxPx = 10,
): number {
  return Math.max(0.04, Math.min(0.22, maxPx / Math.max(1, pxPerSec)));
}

export function buildTimelineSnapTargets(args: {
  viewportDurationSec: number;
  effectiveBpm: number;
  gridOffsetSec: number;
  snapGrid: SnapGridSubdivision;
  showBeats: boolean;
  showKicks: boolean;
  showSnares: boolean;
  transients: ReadonlyArray<{ time_sec: number; band: "kick" | "snare" }>;
  tracks: ReadonlyArray<TrackDef>;
  excludeClip?: { trackId: string; clipIndex: number } | null;
}): SnapTarget[] {
  const targets: SnapTarget[] = [];

  if (args.showBeats) {
    const gridTimes = computeSnapGridMarkers(
      args.viewportDurationSec,
      args.effectiveBpm,
      args.gridOffsetSec,
      args.snapGrid,
    );
    for (const time_sec of gridTimes) {
      targets.push({ time_sec, kind: "beat" });
    }
  }

  for (const m of args.transients) {
    if ((m.band === "kick" && args.showKicks) || (m.band === "snare" && args.showSnares)) {
      targets.push({ time_sec: m.time_sec, kind: m.band });
    }
  }

  for (const trk of args.tracks) {
    for (let idx = 0; idx < trk.clips.length; idx++) {
      if (
        args.excludeClip &&
        trk.id === args.excludeClip.trackId &&
        idx === args.excludeClip.clipIndex
      ) {
        continue;
      }
      const c = trk.clips[idx];
      targets.push({ time_sec: c.start_sec, kind: "clip" });
      targets.push({ time_sec: c.start_sec + c.duration_sec, kind: "clip" });
    }
  }

  return targets;
}

export function snapTimeSecToTargets(
  timeSec: number,
  targets: ReadonlyArray<SnapTarget>,
  maxDistanceSec = 0.15,
): { time_sec: number; snappedTo: SnapTarget | null } {
  let bestTarget: SnapTarget | null = null;
  let bestDist = maxDistanceSec;

  for (const target of targets) {
    const dist = Math.abs(timeSec - target.time_sec);
    if (dist > bestDist + 1e-4) continue;
    if (dist <= bestDist - 1e-4) {
      bestDist = dist;
      bestTarget = target;
    } else if (dist <= maxDistanceSec) {
      const candPriority = SNAP_KIND_PRIORITY[target.kind];
      const bestPriority = bestTarget ? SNAP_KIND_PRIORITY[bestTarget.kind] : -1;
      if (!bestTarget || candPriority > bestPriority || (candPriority === bestPriority && dist < bestDist)) {
        bestDist = dist;
        bestTarget = target;
      }
    }
  }

  if (!bestTarget) {
    return {
      time_sec: Number(timeSec.toFixed(4)),
      snappedTo: null,
    };
  }

  return {
    time_sec: Number(bestTarget.time_sec.toFixed(4)),
    snappedTo: bestTarget,
  };
}

export type AutoFillCadence = 1 | 2 | 4;

/**
 * Selects non-overlapping auto-fill timestamps according to cadence (every 1st/2nd/4th hit)
 * and optional maximum hit count (when limited, counts forward from `startFromSec`).
 */
export function selectAutoFillHitTimes(args: {
  hitTimes: ReadonlyArray<number>;
  startFromSec: number;
  cadence: AutoFillCadence;
  offset?: number;
  maxCount: number | null;
  minGapSec: number;
}): number[] {
  const safeStart = Math.max(0, args.startFromSec);
  const safeGap = Math.max(0.01, args.minGapSec);
  const safeOffset = Math.max(0, Math.min(args.cadence - 1, Math.floor(args.offset ?? 0)));
  const sorted = [...args.hitTimes].sort((a, b) => a - b);

  const nonOverlapping: number[] = [];
  let lastEnd = -1;
  for (const t of sorted) {
    if (args.maxCount !== null && t < safeStart - 1e-3) continue;
    if (t >= lastEnd - 1e-3) {
      nonOverlapping.push(t);
      lastEnd = t + safeGap;
    }
  }

  const cadenced = nonOverlapping.filter((_, idx) => idx % args.cadence === safeOffset);
  if (args.maxCount !== null) {
    return cadenced.slice(0, Math.max(1, Math.floor(args.maxCount)));
  }
  return cadenced;
}
