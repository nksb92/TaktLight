import { Activity, AudioWaveform, Crosshair, Settings, Sliders } from "lucide-react";
import { useMemo, useState } from "react";
import { reanalyzeAudioClip } from "../lib/audioEngine";
import type { ClipDef, TimelineDef } from "../lib/mixerLogic";
import {
  applySingleTrackOverwrite,
  clampTrimEndNonOverlapping,
  clampTrimStartNonOverlapping,
  computeTimelineContentDurationSec,
  durationBeatsToSec,
  gridBeatsToSec,
  secToDurationBeats,
  secToGridBeats,
} from "../lib/timelineLogic";
import { useTaktStore } from "../store/useTaktStore";
import { HelpTooltip } from "./HelpTooltip";

export function TimelineRightInspector({
  timelineId,
}: {
  timelineId: string;
}) {
  const showState = useTaktStore((s) => s.showState);
  const selectedTimelineClip = useTaktStore((s) => s.selectedTimelineClip);
  const setSelectedTimelineClip = useTaktStore((s) => s.setSelectedTimelineClip);
  const timelineTimeUnit = useTaktStore((s) => s.timelineTimeUnit);
  const timelineSensitivity = useTaktStore((s) => s.timelineSensitivity);
  const setTimelineSensitivity = useTaktStore((s) => s.setTimelineSensitivity);
  const timelineShowTransients = useTaktStore((s) => s.timelineShowTransients);
  const setTimelineShowTransients = useTaktStore(
    (s) => s.setTimelineShowTransients,
  );
  const timelineProjectTransients = useTaktStore(
    (s) => s.timelineProjectTransients,
  );
  const setTimelineProjectTransients = useTaktStore(
    (s) => s.setTimelineProjectTransients,
  );
  const timelineShowBeats = useTaktStore((s) => s.timelineShowBeats);
  const setTimelineShowBeats = useTaktStore((s) => s.setTimelineShowBeats);
  const timelineShowKicks = useTaktStore((s) => s.timelineShowKicks);
  const setTimelineShowKicks = useTaktStore((s) => s.setTimelineShowKicks);
  const timelineShowSnares = useTaktStore((s) => s.timelineShowSnares);
  const setTimelineShowSnares = useTaktStore((s) => s.setTimelineShowSnares);
  const latencyOffsetMs = useTaktStore((s) => s.latencyOffsetMs);
  const setLatencyOffsetMs = useTaktStore((s) => s.setLatencyOffsetMs);
  const timelinePlayheadSec = useTaktStore((s) => s.timelinePlayheadSec);
  const upsertTimeline = useTaktStore((s) => s.upsertTimeline);
  const setClipAudioAnalysis = useTaktStore((s) => s.setClipAudioAnalysis);

  const [tab, setTab] = useState<"clip" | "settings">("clip");
  const [notice, setNotice] = useState<string | null>(null);

  const currentTimeline: TimelineDef | null = useMemo(
    () => showState.timelines.find((t) => t.id === timelineId) ?? null,
    [showState.timelines, timelineId],
  );

  const resolvedClip = useMemo(() => {
    if (!currentTimeline || !selectedTimelineClip) return null;
    const trk = currentTimeline.tracks.find(
      (t) => t.id === selectedTimelineClip.trackId,
    );
    const clip = trk?.clips[selectedTimelineClip.clipIndex];
    if (trk && clip) {
      return {
        trackId: trk.id,
        clipIndex: selectedTimelineClip.clipIndex,
        track: trk,
        clip,
      };
    }
    return null;
  }, [currentTimeline, selectedTimelineClip]);

  if (!currentTimeline) return null;

  const effectiveBpm =
    currentTimeline.tempo_map[0]?.bpm ?? (showState.bpm > 0 ? showState.bpm : 120);
  const gridOffsetSec = currentTimeline.grid_offset_sec ?? 0;
  const secToPosBeats = (sec: number) =>
    secToGridBeats(sec, effectiveBpm, gridOffsetSec);
  const posBeatsToSec = (beats: number) =>
    gridBeatsToSec(beats, effectiveBpm, gridOffsetSec);
  const secToDurBeats = (sec: number) => secToDurationBeats(sec, effectiveBpm);
  const durBeatsToSec = (beats: number) =>
    durationBeatsToSec(beats, effectiveBpm);

  const updateSelectedClip = (updater: (clip: ClipDef) => ClipDef) => {
    if (!resolvedClip) return;
    const { trackId, clipIndex, track, clip: srcClip } = resolvedClip;
    const otherClips = track.clips.filter((_, idx) => idx !== clipIndex);
    const raw = updater(srcClip);
    const nextClip: ClipDef = {
      ...raw,
      start_sec: Math.max(0, raw.start_sec),
      duration_sec: Math.max(0.1, raw.duration_sec),
    };

    const startChanged = Math.abs(nextClip.start_sec - srcClip.start_sec) > 1e-4;
    const durChanged = Math.abs(nextClip.duration_sec - srcClip.duration_sec) > 1e-4;

    let nextTrackClips: ClipDef[];
    let nextIdx = clipIndex;

    if (startChanged && !durChanged) {
      const res = applySingleTrackOverwrite(nextClip, otherClips);
      nextTrackClips = res.clips;
      nextIdx = res.insertedIndex;
    } else if (durChanged && !startChanged) {
      const clampedEnd = clampTrimEndNonOverlapping(
        nextClip.start_sec,
        nextClip.start_sec + nextClip.duration_sec,
        otherClips,
        Number.POSITIVE_INFINITY,
      );
      const safeDur = Number(
        Math.max(0.1, clampedEnd - nextClip.start_sec).toFixed(6),
      );
      const preservedStretch =
        srcClip.time_stretch &&
        srcClip.source_duration_sec &&
        srcClip.duration_sec > 0.05
          ? {
              source_duration_sec: Number(
                (safeDur * (srcClip.source_duration_sec / srcClip.duration_sec)).toFixed(6),
              ),
            }
          : {};
      const trimmed: ClipDef = {
        ...nextClip,
        duration_sec: safeDur,
        fade_in_sec: Math.min(nextClip.fade_in_sec, safeDur * 0.5),
        fade_out_sec: Math.min(nextClip.fade_out_sec, safeDur * 0.5),
        ...preservedStretch,
      };
      nextTrackClips = track.clips.map((c, idx) =>
        idx === clipIndex ? trimmed : c,
      );
    } else if (startChanged && durChanged) {
      const origEnd = srcClip.start_sec + srcClip.duration_sec;
      const safeStart = clampTrimStartNonOverlapping(
        nextClip.start_sec,
        origEnd,
        otherClips,
      );
      const safeDur = Number(Math.max(0.1, origEnd - safeStart).toFixed(6));
      const trimmed: ClipDef = {
        ...nextClip,
        start_sec: safeStart,
        duration_sec: safeDur,
        fade_in_sec: Math.min(nextClip.fade_in_sec, safeDur * 0.5),
        fade_out_sec: Math.min(nextClip.fade_out_sec, safeDur * 0.5),
      };
      nextTrackClips = track.clips.map((c, idx) =>
        idx === clipIndex ? trimmed : c,
      );
    } else {
      nextTrackClips = track.clips.map((c, idx) =>
        idx === clipIndex ? nextClip : c,
      );
    }

    const nextTracks = currentTimeline.tracks.map((tr) =>
      tr.id === trackId ? { ...tr, clips: nextTrackClips } : tr,
    );
    const contentDur = computeTimelineContentDurationSec(nextTracks);
    void upsertTimeline({
      ...currentTimeline,
      duration_sec: Math.max(32, contentDur),
      tracks: nextTracks,
    });
    setSelectedTimelineClip({ trackId, clipIndex: nextIdx });
  };

  const handleAnalyzeMusic = () => {
    const selectedAudioKey = resolvedClip?.clip.audio_file ?? null;
    const audioKeys: string[] = selectedAudioKey
      ? [selectedAudioKey]
      : Array.from(
          new Set(
            currentTimeline.tracks.flatMap((tr) =>
              tr.clips
                .map((c) => c.audio_file)
                .filter((k): k is string => Boolean(k)),
            ),
          ),
        );

    if (audioKeys.length === 0) {
      setNotice("Drop or add a music file onto the timeline first.");
      return;
    }

    let firstRes = null;
    let firstClipStart = 0;
    for (const key of audioKeys) {
      const res = reanalyzeAudioClip(key, timelineSensitivity);
      if (res) {
        setClipAudioAnalysis(key, res, currentTimeline.id);
        if (!firstRes) {
          firstRes = res;
          for (const tr of currentTimeline.tracks) {
            const c = tr.clips.find((cl) => cl.audio_file === key);
            if (c) {
              firstClipStart = c.start_sec;
              break;
            }
          }
        }
      }
    }

    if (!firstRes) {
      setNotice("Audio buffer not in memory. Re-drop the music file.");
      return;
    }

    // Auto-sync BPM and beat grid phase to analyzed song
    const syncedBpm = Math.max(20, Math.min(300, Math.round(firstRes.estimated_bpm)));
    const syncedOffset = Number(
      Math.max(0, firstClipStart + firstRes.grid_offset_sec).toFixed(3),
    );
    const nextMap =
      currentTimeline.tempo_map.length > 0
        ? currentTimeline.tempo_map.map((pt, idx) =>
            idx === 0 ? { ...pt, bpm: syncedBpm } : pt,
          )
        : [{ at_sec: 0, bpm: syncedBpm }];

    void upsertTimeline({
      ...currentTimeline,
      tempo_map: nextMap,
      grid_offset_sec: syncedOffset,
    });
    setNotice(null);
  };

  return (
    <div
      data-testid="timeline-right-inspector"
      className="flex-1 min-h-0 flex flex-col gap-2"
    >
      {/* Compact Tab Switcher: Clip Inspector | Timeline Settings */}
      <div className="flex items-center gap-1 bg-pitch border border-steel rounded p-0.5 font-mono text-[10px]">
        <button
          type="button"
          data-testid="timeline-inspector-tab-clip"
          aria-pressed={tab === "clip"}
          onClick={() => setTab("clip")}
          className={`flex-1 flex items-center justify-center gap-1 py-1 rounded transition-colors ${
            tab === "clip"
              ? "bg-slate text-frost font-semibold border border-steel"
              : "text-fog hover:text-mist"
          }`}
        >
          <Sliders className="w-3 h-3" />
          <span>Clip</span>
        </button>
        <button
          type="button"
          data-testid="timeline-inspector-tab-settings"
          aria-pressed={tab === "settings"}
          onClick={() => setTab("settings")}
          className={`flex-1 flex items-center justify-center gap-1 py-1 rounded transition-colors ${
            tab === "settings"
              ? "bg-slate text-frost font-semibold border border-steel"
              : "text-fog hover:text-mist"
          }`}
        >
          <Settings className="w-3 h-3" />
          <span>Timeline</span>
        </button>
      </div>

      {notice && (
        <div className="flex items-center justify-between gap-1 bg-amber-950/50 border border-amber-500/60 rounded px-2 py-1 font-mono text-[10px] text-amber-200">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-amber-300 hover:text-frost"
          >
            ×
          </button>
        </div>
      )}

      {tab === "clip" ? (
        <section
          data-testid="selected-clip-inspector"
          className="flex flex-col gap-2 font-mono text-[10px]"
        >
          {!resolvedClip ? (
            <p className="text-fog leading-relaxed">
              Click a clip on any timeline track (or drop a Scene / Audio file) to inspect its timing and fades.
            </p>
          ) : (
            <>
              <div className="text-ember truncate">
                {resolvedClip.track.name} • Clip #{resolvedClip.clipIndex + 1}
              </div>

              {!resolvedClip.clip.audio_file ? (
                <label
                  className="flex flex-col gap-1"
                  title="FX Block or Scene Look played by this timeline clip"
                >
                  <span className="text-fog">FX Block</span>
                  <select
                    aria-label="Selected Clip Block Ref"
                    value={resolvedClip.clip.ref_block ?? ""}
                    onChange={(e) =>
                      updateSelectedClip((c) => ({
                        ...c,
                        ref_block: e.target.value || null,
                      }))
                    }
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs text-frost"
                  >
                    {showState.fx_library.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div
                  className="flex flex-col gap-1"
                  title={resolvedClip.clip.audio_file}
                >
                  <span className="text-fog">Audio File</span>
                  <div
                    className="bg-pitch border border-cobalt/50 rounded px-2 py-1 text-xs text-frost truncate"
                    title={resolvedClip.clip.audio_file}
                  >
                    {resolvedClip.clip.audio_file}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-1.5">
                <label
                  className="flex flex-col gap-1"
                  title="Clip start position on the timeline (arrows step by whole beats; type decimals for 1/2 or 1/4 beats)"
                >
                  <span className="text-fog">
                    {timelineTimeUnit === "beats" ? "Start (beats)" : "Start (s)"}
                  </span>
                  <input
                    aria-label="Selected Clip Start Sec"
                    type="number"
                    min={0}
                    step={timelineTimeUnit === "beats" ? 1 : 0.05}
                    value={
                      timelineTimeUnit === "beats"
                        ? secToPosBeats(resolvedClip.clip.start_sec)
                        : resolvedClip.clip.start_sec
                    }
                    onChange={(e) => {
                      const raw = Math.max(0, Number(e.target.value) || 0);
                      const nextSec =
                        timelineTimeUnit === "beats" ? posBeatsToSec(raw) : raw;
                      updateSelectedClip((c) => ({
                        ...c,
                        start_sec: Math.max(0, nextSec),
                      }));
                    }}
                    className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                  />
                </label>

                <label
                  className="flex flex-col gap-1"
                  title="Clip duration on the timeline (arrows step by whole beats; type decimals for 1/2 or 1/4 beats)"
                >
                  <span className="text-fog">
                    {timelineTimeUnit === "beats"
                      ? "Duration (beats)"
                      : "Duration (s)"}
                  </span>
                  <input
                    aria-label="Selected Clip Duration Sec"
                    type="number"
                    min={timelineTimeUnit === "beats" ? 1 : 0.1}
                    step={timelineTimeUnit === "beats" ? 1 : 0.05}
                    value={
                      timelineTimeUnit === "beats"
                        ? Math.max(
                            1,
                            Math.round(
                              secToDurBeats(resolvedClip.clip.duration_sec),
                            ),
                          )
                        : resolvedClip.clip.duration_sec
                    }
                    onChange={(e) => {
                      const parsed = Number(e.target.value);
                      const raw =
                        timelineTimeUnit === "beats"
                          ? Math.max(1, Math.round(parsed || 1))
                          : Math.max(0.1, parsed || 0.1);
                      const nextSec =
                        timelineTimeUnit === "beats" ? durBeatsToSec(raw) : raw;
                      updateSelectedClip((c) => ({
                        ...c,
                        duration_sec: Math.max(0.1, nextSec),
                      }));
                    }}
                    className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                  />
                </label>

                <label
                  className="flex flex-col gap-1"
                  title="Fade-in duration at the start of the clip in seconds"
                >
                  <span className="text-fog">Fade In (s)</span>
                  <input
                    aria-label="Selected Clip Fade In Sec"
                    type="number"
                    min={0}
                    step={0.05}
                    value={resolvedClip.clip.fade_in_sec}
                    onChange={(e) =>
                      updateSelectedClip((c) => ({
                        ...c,
                        fade_in_sec: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                  />
                </label>

                <label
                  className="flex flex-col gap-1"
                  title="Fade-out duration at the end of the clip in seconds"
                >
                  <span className="text-fog">Fade Out (s)</span>
                  <input
                    aria-label="Selected Clip Fade Out Sec"
                    type="number"
                    min={0}
                    step={0.05}
                    value={resolvedClip.clip.fade_out_sec}
                    onChange={(e) =>
                      updateSelectedClip((c) => ({
                        ...c,
                        fade_out_sec: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-1 pt-1 border-t border-steel/50">
                <span className="text-fog">Move:</span>
                <button
                  type="button"
                  data-testid="nudge-clip-left-btn"
                  title="Nudge clip earlier by 0.25s"
                  onClick={() =>
                    updateSelectedClip((c) => ({
                      ...c,
                      start_sec: Math.max(
                        0,
                        Number((c.start_sec - 0.25).toFixed(3)),
                      ),
                    }))
                  }
                  className="px-1.5 py-0.5 rounded bg-ink border border-steel text-mist hover:border-ember"
                >
                  -0.25s
                </button>
                <button
                  type="button"
                  data-testid="nudge-clip-right-btn"
                  title="Nudge clip later by 0.25s"
                  onClick={() =>
                    updateSelectedClip((c) => ({
                      ...c,
                      start_sec: Number((c.start_sec + 0.25).toFixed(3)),
                    }))
                  }
                  className="px-1.5 py-0.5 rounded bg-ink border border-steel text-mist hover:border-ember"
                >
                  +0.25s
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1">
                <span className="text-fog">Trim:</span>
                <button
                  type="button"
                  data-testid="trim-clip-shorter-btn"
                  title="Shorten clip duration by 0.5s"
                  onClick={() =>
                    updateSelectedClip((c) => ({
                      ...c,
                      duration_sec: Math.max(
                        0.1,
                        Number((c.duration_sec - 0.5).toFixed(3)),
                      ),
                    }))
                  }
                  className="px-1.5 py-0.5 rounded bg-ink border border-steel text-mist hover:border-cobalt"
                >
                  -0.5s
                </button>
                <button
                  type="button"
                  data-testid="trim-clip-longer-btn"
                  title="Extend clip duration by 0.5s"
                  onClick={() =>
                    updateSelectedClip((c) => ({
                      ...c,
                      duration_sec: Number((c.duration_sec + 0.5).toFixed(3)),
                    }))
                  }
                  className="px-1.5 py-0.5 rounded bg-ink border border-steel text-mist hover:border-cobalt"
                >
                  +0.5s
                </button>
              </div>

              {!resolvedClip.clip.audio_file && (
                <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-steel/40">
                  <label
                    className="flex items-center gap-1.5"
                    title="Time-stretch factor for this clip's effect cycle (1.0 = natural speed, 2.0 = half speed / 2x longer cycle). Adjustable even when Stretch mode is off."
                  >
                    <span className="text-fog">Stretch (×)</span>
                    <input
                      aria-label="Clip Stretch Factor"
                      data-testid="clip-stretch-factor-input"
                      type="number"
                      min={0.1}
                      max={16}
                      step={0.1}
                      value={
                        resolvedClip.clip.time_stretch &&
                        resolvedClip.clip.source_duration_sec &&
                        resolvedClip.clip.source_duration_sec > 1e-6 &&
                        resolvedClip.clip.duration_sec > 1e-6
                          ? Number(
                              (
                                resolvedClip.clip.duration_sec /
                                resolvedClip.clip.source_duration_sec
                              ).toFixed(2),
                            )
                          : 1
                      }
                      onChange={(e) => {
                        const factor = Number(e.target.value);
                        if (Number.isNaN(factor) || factor <= 0.05) return;
                        const clamped = Math.max(0.1, Math.min(16, factor));
                        if (Math.abs(clamped - 1) < 0.005) {
                          updateSelectedClip((c) => ({
                            ...c,
                            time_stretch: false,
                            source_duration_sec: null,
                          }));
                        } else {
                          updateSelectedClip((c) => ({
                            ...c,
                            time_stretch: true,
                            source_duration_sec: Number(
                              (c.duration_sec / clamped).toFixed(6),
                            ),
                          }));
                        }
                      }}
                      className="w-16 bg-ink border border-steel rounded px-1.5 py-0.5 text-xs text-frost"
                    />
                  </label>
                  {resolvedClip.clip.time_stretch && (
                    <button
                      type="button"
                      data-testid="reset-clip-stretch-btn"
                      title="Reset clip speed back to its natural 1.0x cycle duration"
                      onClick={() =>
                        updateSelectedClip((c) => ({
                          ...c,
                          time_stretch: false,
                          source_duration_sec: null,
                        }))
                      }
                      className="px-1.5 py-0.5 rounded bg-ink border border-amber-400/70 text-amber-200 hover:bg-amber-500/20"
                    >
                      Reset 1.0×
                    </button>
                  )}
                </div>
              )}

              <div className="text-fog pt-1 border-t border-steel/40">
                {resolvedClip.clip.start_sec.toFixed(2)}s •{" "}
                {resolvedClip.clip.duration_sec.toFixed(2)}s (
                {secToDurBeats(resolvedClip.clip.duration_sec).toFixed(1)}b)
              </div>
            </>
          )}
        </section>
      ) : (
        <section
          data-testid="timeline-settings-inspector"
          className="flex flex-col gap-2 font-mono text-[10px]"
        >
          <label
            className="flex flex-col gap-1"
            title="Master tempo in beats per minute for the beat grid and synced FX; auto-synced when a music file is dropped"
          >
            <span className="text-fog">Tempo (BPM)</span>
            <input
              aria-label="Timeline Tempo BPM"
              type="number"
              min={20}
              max={300}
              step={0.5}
              value={effectiveBpm}
              onChange={(e) => {
                const bpm = Number(e.target.value);
                if (Number.isNaN(bpm)) return;
                const clamped = Math.max(20, Math.min(300, bpm));
                const nextMap =
                  currentTimeline.tempo_map.length > 0
                    ? currentTimeline.tempo_map.map((pt, idx) =>
                        idx === 0 ? { ...pt, bpm: clamped } : pt,
                      )
                    : [{ at_sec: 0, bpm: clamped }];
                void upsertTimeline(
                  { ...currentTimeline, tempo_map: nextMap },
                  `tl_bpm_${currentTimeline.id}`,
                );
              }}
              className="bg-ink border border-steel rounded px-2 py-1 text-xs text-frost"
            />
          </label>

          <label
            className="flex flex-col gap-1"
            title="Shifts Beat 1.1 in seconds to align the beat grid with the song's first downbeat"
          >
            <span className="text-fog">Beat Grid Offset (s)</span>
            <input
              aria-label="Grid Offset Sec"
              type="number"
              min={0}
              step={0.01}
              value={currentTimeline.grid_offset_sec}
              onChange={(e) => {
                const val = Number(e.target.value);
                if (Number.isNaN(val)) return;
                void upsertTimeline(
                  { ...currentTimeline, grid_offset_sec: Math.max(0, val) },
                  `tl_grid_${currentTimeline.id}`,
                );
              }}
              className="bg-ink border border-steel rounded px-2 py-1 text-xs text-frost"
            />
          </label>

          <button
            type="button"
            data-testid="align-grid-to-playhead-btn"
            title="Set Beat 1.1 of the beat grid to the current playhead position"
            onClick={() =>
              void upsertTimeline({
                ...currentTimeline,
                grid_offset_sec: Number(Math.max(0, timelinePlayheadSec).toFixed(3)),
              })
            }
            className="flex items-center justify-center gap-1.5 px-2 py-1 rounded border border-plum/70 bg-plum/15 hover:bg-plum/30 text-frost"
          >
            <Crosshair className="w-3 h-3 text-plum" />
            <span>Align Grid to Playhead</span>
          </button>

          <label className="flex flex-col gap-1">
            <span className="text-fog flex items-center gap-1">
              <span>Transient Sensitivity (0–1)</span>
              <HelpTooltip text="Audio beat/transient detection threshold (0.0 = loudest peaks only, 1.0 = detects softer hits). Re-run Analyze Audio to apply." />
            </span>
            <input
              aria-label="Transient Sensitivity"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={timelineSensitivity}
              onChange={(e) =>
                setTimelineSensitivity(Number(e.target.value) || 0)
              }
              className="bg-ink border border-steel rounded px-2 py-1 text-xs text-frost"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-fog flex items-center gap-1">
              <span>Audio Latency Offset (ms)</span>
              <HelpTooltip text="Compensates for audio output vs DMX network latency (-500 to +500 ms)." />
            </span>
            <input
              aria-label="Latency Offset Ms"
              type="number"
              min={-500}
              max={500}
              step={1}
              value={latencyOffsetMs}
              onChange={(e) =>
                void setLatencyOffsetMs(Number(e.target.value) || 0)
              }
              className="bg-ink border border-steel rounded px-2 py-1 text-xs text-frost"
            />
          </label>

          <div className="grid grid-cols-3 gap-1">
            <label className="flex items-center gap-1 px-1.5 py-1 rounded bg-pitch border border-steel text-mist cursor-pointer">
              <input
                type="checkbox"
                checked={timelineShowBeats}
                onChange={(e) => setTimelineShowBeats(e.target.checked)}
                className="accent-frost"
              />
              <span>Beats</span>
            </label>
            <label className="flex items-center gap-1 px-1.5 py-1 rounded bg-pitch border border-steel text-amber-300 cursor-pointer">
              <input
                type="checkbox"
                checked={timelineShowKicks}
                onChange={(e) => setTimelineShowKicks(e.target.checked)}
                className="accent-amber-400"
              />
              <span>Kicks</span>
            </label>
            <label className="flex items-center gap-1 px-1.5 py-1 rounded bg-pitch border border-steel text-cyan-300 cursor-pointer">
              <input
                type="checkbox"
                checked={timelineShowSnares}
                onChange={(e) => setTimelineShowSnares(e.target.checked)}
                className="accent-cyan-400"
              />
              <span>Snares</span>
            </label>
          </div>

          <label
            className="flex items-center gap-2 px-2 py-1 rounded bg-pitch border border-steel text-mist cursor-pointer"
            title="Show or hide detected Kick and Snare transient markers inside music clips"
          >
            <input
              type="checkbox"
              data-testid="toggle-show-transients"
              checked={timelineShowTransients}
              onChange={(e) => setTimelineShowTransients(e.target.checked)}
              className="accent-amber-400"
            />
            <span>Show Transients in Music</span>
          </label>

          <label
            className="flex items-center gap-2 px-2 py-1 rounded bg-pitch border border-steel text-mist cursor-pointer"
            title="Project enabled Kick and Snare transient markers vertically across all lighting tracks"
          >
            <input
              type="checkbox"
              data-testid="toggle-project-transients"
              checked={timelineProjectTransients}
              onChange={(e) => setTimelineProjectTransients(e.target.checked)}
              className="accent-amber-400"
            />
            <span>Project Transients to FX</span>
          </label>

          {/* Compact Color Legend for Beat Grid vs Transients */}
          <div
            data-testid="timeline-marker-legend"
            className="flex flex-wrap items-center gap-2 px-2 py-1 rounded bg-ink border border-steel/70 text-[9px] text-fog"
          >
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-frost/60 inline-block" />
              Bar
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-steel inline-block" />
              Beat
            </span>
            <span className="inline-flex items-center gap-1 text-amber-300">
              <span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />
              Kick
            </span>
            <span className="inline-flex items-center gap-1 text-cyan-300">
              <span className="w-2 h-2 rounded-sm bg-cyan-400 inline-block" />
              Snare
            </span>
          </div>

          <button
            type="button"
            data-testid="timeline-analyze-audio-btn"
            title="Re-analyze the selected music clip (or all music clips) using current Transient Sensitivity and sync BPM & Beat Grid"
            onClick={handleAnalyzeMusic}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border border-cobalt bg-cobalt/20 hover:bg-cobalt/35 text-frost font-semibold"
          >
            <Activity className="w-3.5 h-3.5 text-cobalt" />
            <span>Analyze Audio &amp; Sync BPM</span>
          </button>

          <div className="flex items-center gap-1 text-[9px] text-fog pt-1 border-t border-steel/40">
            <AudioWaveform className="w-3 h-3 text-cobalt shrink-0" />
            <span>Shortcuts: Ctrl+Wheel zoom, Alt+Drag duplicate</span>
          </div>
        </section>
      )}
    </div>
  );
}
