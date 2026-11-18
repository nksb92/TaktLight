import {
  Activity,
  AudioWaveform,
  Clock,
  Pause,
  Play,
  Plus,
  Redo2,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  computeBeatGridMarkers,
  snapTimeSecToMarkers,
  type ClipDef,
  type TimelineDef,
  type TrackDef,
} from "../lib/mixerLogic";
import { useTaktStore } from "../store/useTaktStore";

function slugId(prefix: string, name: string, existingIds: string[]): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = `${prefix}_${clean || "item"}`;
  if (!existingIds.includes(base)) return base;
  let suffix = 2;
  while (existingIds.includes(`${base}_${suffix}`)) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
}

export function TimelineEditor() {
  const showState = useTaktStore((s) => s.showState);
  const activeTimelineId = useTaktStore((s) => s.activeTimelineId);
  const timelinePlaying = useTaktStore((s) => s.timelinePlaying);
  const timelinePlayheadSec = useTaktStore((s) => s.timelinePlayheadSec);
  const latencyOffsetMs = useTaktStore((s) => s.latencyOffsetMs);
  const audioAnalysisByTimeline = useTaktStore(
    (s) => s.audioAnalysisByTimeline,
  );
  const compiledCells = useTaktStore((s) => s.compiledCells);
  const cellPreviewRgbd = useTaktStore((s) => s.cellPreviewRgbd);
  const canUndo = useTaktStore((s) => s.canUndo);
  const canRedo = useTaktStore((s) => s.canRedo);

  const upsertTimeline = useTaktStore((s) => s.upsertTimeline);
  const deleteTimeline = useTaktStore((s) => s.deleteTimeline);
  const setTimelineTransport = useTaktStore((s) => s.setTimelineTransport);
  const setLatencyOffsetMs = useTaktStore((s) => s.setLatencyOffsetMs);
  const analyzeTimelineAudio = useTaktStore((s) => s.analyzeTimelineAudio);
  const undoShow = useTaktStore((s) => s.undoShow);
  const redoShow = useTaktStore((s) => s.redoShow);

  const [selectedTimelineId, setSelectedTimelineId] = useState(
    activeTimelineId ?? showState.timelines[0]?.id ?? "",
  );
  const [magneticSnap, setMagneticSnap] = useState(true);
  const [newTrackName, setNewTrackName] = useState("Accent Track");
  const [newTrackTarget, setNewTrackTarget] = useState("all");
  const [clipTrackId, setClipTrackId] = useState("");
  const [clipBlockRef, setClipBlockRef] = useState(
    showState.fx_library[0]?.id ?? "",
  );
  const [clipStartSec, setClipStartSec] = useState(1.0);
  const [clipDurationSec, setClipDurationSec] = useState(4.0);
  const [clipFadeInSec, setClipFadeInSec] = useState(0.0);
  const [clipFadeOutSec, setClipFadeOutSec] = useState(0.5);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const currentTimeline: TimelineDef | null = useMemo(() => {
    const bySelected = showState.timelines.find(
      (t) => t.id === (activeTimelineId ?? selectedTimelineId),
    );
    return (
      bySelected ??
      showState.timelines.find((t) => t.id === selectedTimelineId) ??
      showState.timelines[0] ??
      null
    );
  }, [activeTimelineId, selectedTimelineId, showState.timelines]);

  const effectiveTrackId = useMemo(() => {
    if (!currentTimeline) return "";
    if (
      clipTrackId &&
      currentTimeline.tracks.some((tr) => tr.id === clipTrackId)
    ) {
      return clipTrackId;
    }
    return currentTimeline.tracks[0]?.id ?? "";
  }, [clipTrackId, currentTimeline]);

  const effectiveBlockRef = useMemo(() => {
    if (
      clipBlockRef &&
      showState.fx_library.some((b) => b.id === clipBlockRef)
    ) {
      return clipBlockRef;
    }
    return showState.fx_library[0]?.id ?? "";
  }, [clipBlockRef, showState.fx_library]);

  const analysis = currentTimeline
    ? audioAnalysisByTimeline[currentTimeline.id]
    : undefined;

  const beatGridMarkers = useMemo(() => {
    if (!currentTimeline) return [];
    return computeBeatGridMarkers({
      durationSec: currentTimeline.duration_sec,
      gridOffsetSec: currentTimeline.grid_offset_sec,
      tempoMap: currentTimeline.tempo_map,
      defaultBpm: showState.bpm || 120,
    });
  }, [currentTimeline, showState.bpm]);

  const snapMarkers = useMemo(() => {
    const transientTimes = analysis
      ? analysis.transients.map((m) => m.time_sec)
      : [];
    return [...beatGridMarkers, ...transientTimes];
  }, [analysis, beatGridMarkers]);

  const targetOptions = useMemo(() => {
    const opts = [{ value: "all", label: "All Patched Fixtures" }];
    for (const grp of showState.groups) {
      opts.push({ value: grp.id, label: `Group: ${grp.name} (${grp.id})` });
    }
    for (const fx of showState.patch) {
      opts.push({ value: fx.id, label: `Fixture: ${fx.name} (${fx.id})` });
    }
    return opts;
  }, [showState.groups, showState.patch]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !currentTimeline) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const dur = Math.max(0.1, currentTimeline.duration_sec);

    ctx.fillStyle = "#0D1117";
    ctx.fillRect(0, 0, w, h);

    // Beat grid lines in PLUM (#8833AA)
    ctx.strokeStyle = "rgba(136, 51, 170, 0.35)";
    ctx.lineWidth = 1;
    for (const beatT of beatGridMarkers) {
      const x = (beatT / dur) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Audio waveform peaks in COBALT (#2255AA)
    if (analysis && analysis.waveform_peaks.length > 0) {
      ctx.fillStyle = "#2255AA";
      const count = analysis.waveform_peaks.length;
      const barW = Math.max(1, w / count);
      const midY = h / 2;
      for (let i = 0; i < count; i++) {
        const pk = analysis.waveform_peaks[i];
        const amp = Math.max(Math.abs(pk.min), Math.abs(pk.max));
        const barH = Math.max(2, amp * (h * 0.8));
        ctx.fillRect((i / count) * w, midY - barH / 2, barW, barH);
      }

      // Transient markers in bright PLUM (#8833AA)
      ctx.strokeStyle = "#8833AA";
      ctx.lineWidth = 1.5;
      for (const m of analysis.transients) {
        const x = (m.time_sec / dur) * w;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }

    // Playhead cursor in EMBER (#FF5500)
    const playX = Math.max(0, Math.min(w, (timelinePlayheadSec / dur) * w));
    ctx.strokeStyle = "#FF5500";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX, h);
    ctx.stroke();
  }, [analysis, beatGridMarkers, currentTimeline, timelinePlayheadSec]);

  const handleSelectTimeline = (id: string) => {
    setSelectedTimelineId(id);
    if (id) {
      void setTimelineTransport(id, false, 0);
    }
  };

  const handleCreateTimeline = async () => {
    const id = slugId(
      "tl",
      "Timeline",
      showState.timelines.map((t) => t.id),
    );
    const created: TimelineDef = {
      id,
      name: `Show Timeline ${showState.timelines.length + 1}`,
      duration_sec: 32,
      grid_offset_sec: 0,
      tempo_map: [{ at_sec: 0, bpm: showState.bpm || 120 }],
      audio_track: {
        file: "audio/mix.wav",
        abs_fallback: null,
        sha256: null,
        offset_sec: 0,
        transient_sensitivity: 0.65,
      },
      tracks: [
        {
          id: "trk_1",
          name: "Base Track",
          target_group: "all",
          clips: [],
        },
      ],
    };
    await upsertTimeline(created);
    setSelectedTimelineId(id);
  };

  const handleUpdateGridOffset = (val: number) => {
    if (!currentTimeline || Number.isNaN(val)) return;
    void upsertTimeline(
      { ...currentTimeline, grid_offset_sec: Math.max(0, val) },
      `tl_grid_${currentTimeline.id}`,
    );
  };

  const handleUpdateTempoBpm = (bpm: number) => {
    if (!currentTimeline || Number.isNaN(bpm)) return;
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
  };

  const handleUpdateSensitivity = (sens: number) => {
    if (!currentTimeline || Number.isNaN(sens)) return;
    const clamped = Math.max(0, Math.min(1, sens));
    const nextAudio = currentTimeline.audio_track
      ? { ...currentTimeline.audio_track, transient_sensitivity: clamped }
      : {
          file: "audio/mix.wav",
          abs_fallback: null,
          sha256: null,
          offset_sec: 0,
          transient_sensitivity: clamped,
        };
    void upsertTimeline(
      { ...currentTimeline, audio_track: nextAudio },
      `tl_sens_${currentTimeline.id}`,
    );
  };

  const handleAddTrack = async () => {
    if (!currentTimeline) return;
    const id = slugId(
      "trk",
      newTrackName,
      currentTimeline.tracks.map((tr) => tr.id),
    );
    const nextTrack: TrackDef = {
      id,
      name: newTrackName.trim() || "Track",
      target_group: newTrackTarget || "all",
      clips: [],
    };
    await upsertTimeline({
      ...currentTimeline,
      tracks: [...currentTimeline.tracks, nextTrack],
    });
    setClipTrackId(id);
  };

  const handleDeleteTrack = async (trackId: string) => {
    if (!currentTimeline) return;
    await upsertTimeline({
      ...currentTimeline,
      tracks: currentTimeline.tracks.filter((tr) => tr.id !== trackId),
    });
  };

  const handleAddClip = async () => {
    if (!currentTimeline || !effectiveTrackId || !effectiveBlockRef) return;
    const snappedStart = magneticSnap
      ? snapTimeSecToMarkers(clipStartSec, snapMarkers, 0.15)
      : clipStartSec;
    const clip: ClipDef = {
      ref_block: effectiveBlockRef,
      start_sec: Math.max(0, snappedStart),
      duration_sec: Math.max(0.1, clipDurationSec),
      fade_in_sec: Math.max(0, clipFadeInSec),
      fade_out_sec: Math.max(0, clipFadeOutSec),
      inline_fx: [],
    };
    await upsertTimeline({
      ...currentTimeline,
      tracks: currentTimeline.tracks.map((tr) =>
        tr.id === effectiveTrackId
          ? { ...tr, clips: [...tr.clips, clip] }
          : tr,
      ),
    });
  };

  const handleDeleteClip = async (trackId: string, clipIdx: number) => {
    if (!currentTimeline) return;
    await upsertTimeline({
      ...currentTimeline,
      tracks: currentTimeline.tracks.map((tr) =>
        tr.id === trackId
          ? { ...tr, clips: tr.clips.filter((_, idx) => idx !== clipIdx) }
          : tr,
      ),
    });
  };

  const activeBpm =
    currentTimeline?.tempo_map[0]?.bpm ?? showState.bpm ?? 120;
  const activeSensitivity =
    currentTimeline?.audio_track?.transient_sensitivity ?? 0.65;

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Header Transport & Clock Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate border border-steel rounded-panel px-4 py-3">
        <div className="flex items-center gap-3">
          <AudioWaveform className="w-4 h-4 text-plum" />
          <div>
            <h2 className="font-sans text-sm font-semibold text-frost">
              Multi Track Audio Timeline
            </h2>
            <p className="font-mono text-xs text-fog">
              Interpolated Audio Clock | Spectral Flux Transients | Beat Grid Snap
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Active Timeline"
            value={currentTimeline?.id ?? ""}
            onChange={(e) => handleSelectTimeline(e.target.value)}
            className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
          >
            {showState.timelines.length === 0 ? (
              <option value="">No Timelines</option>
            ) : (
              showState.timelines.map((tl) => (
                <option key={tl.id} value={tl.id}>
                  {tl.name} ({tl.id})
                </option>
              ))
            )}
          </select>

          <button
            type="button"
            onClick={() => void handleCreateTimeline()}
            className="flex items-center gap-1 px-2.5 py-1 rounded border border-steel bg-ink hover:border-fog font-mono text-xs text-mist"
          >
            <Plus className="w-3 h-3" />
            <span>New Timeline</span>
          </button>

          {currentTimeline && (
            <>
              <button
                type="button"
                onClick={() =>
                  void setTimelineTransport(
                    currentTimeline.id,
                    !timelinePlaying,
                  )
                }
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-ember hover:bg-ember/90 text-frost font-mono text-xs font-semibold transition-colors"
              >
                {timelinePlaying ? (
                  <>
                    <Pause className="w-3 h-3" />
                    <span>Pause Timeline</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3 h-3" />
                    <span>Play Timeline</span>
                  </>
                )}
              </button>

              <label className="flex items-center gap-1.5 bg-pitch border border-steel rounded px-2 py-1">
                <Clock className="w-3 h-3 text-ember" />
                <span className="font-mono text-[11px] text-fog">Pos(s)</span>
                <input
                  aria-label="Timeline Playhead Sec"
                  type="number"
                  min={0}
                  step={0.1}
                  value={timelinePlayheadSec}
                  onChange={(e) =>
                    void setTimelineTransport(
                      currentTimeline.id,
                      timelinePlaying,
                      Number(e.target.value) || 0,
                    )
                  }
                  className="w-16 bg-ink border border-steel rounded px-1.5 py-0.5 font-mono text-xs text-frost"
                />
              </label>

              <label className="flex items-center gap-1.5 bg-pitch border border-steel rounded px-2 py-1">
                <span className="font-mono text-[11px] text-fog">
                  Offset(ms)
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
                  className="w-16 bg-ink border border-steel rounded px-1.5 py-0.5 font-mono text-xs text-frost"
                />
              </label>

              <button
                type="button"
                onClick={() => void analyzeTimelineAudio(currentTimeline.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-cobalt bg-cobalt/20 hover:bg-cobalt/30 font-mono text-xs font-medium text-frost transition-colors"
              >
                <Activity className="w-3.5 h-3.5" />
                <span>Analyze Audio</span>
              </button>

              <label className="flex items-center gap-1.5 px-2 py-1 rounded border border-steel bg-ink font-mono text-xs text-mist">
                <input
                  aria-label="Magnetic Snap"
                  type="checkbox"
                  checked={magneticSnap}
                  onChange={(e) => setMagneticSnap(e.target.checked)}
                />
                <span>Snap</span>
              </label>

              <button
                type="button"
                aria-label="Delete Timeline"
                onClick={() => void deleteTimeline(currentTimeline.id)}
                className="p-1.5 rounded border border-steel bg-ink text-signal hover:bg-slate-dark"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}

          <button
            type="button"
            disabled={!canUndo}
            onClick={() => void undoShow()}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-steel bg-ink font-mono text-xs text-mist disabled:opacity-40"
          >
            <Undo2 className="w-3.5 h-3.5" />
            <span>Undo</span>
          </button>

          <button
            type="button"
            disabled={!canRedo}
            onClick={() => void redoShow()}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-steel bg-ink font-mono text-xs text-mist disabled:opacity-40"
          >
            <Redo2 className="w-3.5 h-3.5" />
            <span>Redo</span>
          </button>
        </div>
      </div>

      {currentTimeline && (
        <>
          {/* Audio Waveform + PLUM Transient & Beat-Grid Lane */}
          <section className="bg-slate border border-steel rounded-panel p-3 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 bg-pitch border border-steel rounded px-2 py-1">
                  <span className="font-mono text-[11px] text-fog">
                    Tempo BPM
                  </span>
                  <input
                    aria-label="Timeline Tempo BPM"
                    type="number"
                    min={20}
                    max={300}
                    step={0.5}
                    value={activeBpm}
                    onChange={(e) =>
                      handleUpdateTempoBpm(Number(e.target.value))
                    }
                    className="w-16 bg-ink border border-steel rounded px-1.5 py-0.5 font-mono text-xs text-frost"
                  />
                </label>

                <label className="flex items-center gap-1.5 bg-pitch border border-steel rounded px-2 py-1">
                  <span className="font-mono text-[11px] text-fog">
                    Grid Offset (s)
                  </span>
                  <input
                    aria-label="Grid Offset Sec"
                    type="number"
                    min={0}
                    step={0.01}
                    value={currentTimeline.grid_offset_sec}
                    onChange={(e) =>
                      handleUpdateGridOffset(Number(e.target.value))
                    }
                    className="w-16 bg-ink border border-steel rounded px-1.5 py-0.5 font-mono text-xs text-frost"
                  />
                </label>

                <label className="flex items-center gap-1.5 bg-pitch border border-steel rounded px-2 py-1">
                  <span className="font-mono text-[11px] text-fog">
                    Sensitivity
                  </span>
                  <input
                    aria-label="Transient Sensitivity"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={activeSensitivity}
                    onChange={(e) =>
                      handleUpdateSensitivity(Number(e.target.value))
                    }
                    className="w-14 bg-ink border border-steel rounded px-1.5 py-0.5 font-mono text-xs text-frost"
                  />
                </label>
              </div>

              <div className="flex items-center gap-3 font-mono text-xs text-fog">
                <span>Duration: {currentTimeline.duration_sec}s</span>
                <span>Beats: {beatGridMarkers.length}</span>
                {analysis ? (
                  <span className="text-plum font-semibold">
                    Detected {analysis.estimated_bpm.toFixed(1)} BPM |{" "}
                    {analysis.transients.length} transients
                  </span>
                ) : (
                  <span>Click Analyze Audio for Kick &amp; Snare markers</span>
                )}
              </div>
            </div>

            <div
              data-testid="timeline-waveform-lane"
              className="flex flex-col gap-1.5 bg-pitch border border-steel rounded p-2"
            >
              <canvas
                ref={canvasRef}
                width={960}
                height={96}
                className="w-full h-24 rounded bg-pitch"
              />
              {analysis && (
                <div className="flex flex-wrap gap-1 font-mono text-[10px] text-mist">
                  {analysis.transients.slice(0, 12).map((m, idx) => (
                    <span
                      key={`${m.band}-${idx}`}
                      className="px-1.5 py-0.5 rounded border border-plum/60 bg-plum/15 text-frost"
                    >
                      {m.band.toUpperCase()} {m.time_sec.toFixed(2)}s
                    </span>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Multi-Track Composer & Clip Editor */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <section className="lg:col-span-2 bg-slate border border-steel rounded-panel p-3 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h3 className="font-sans text-sm font-semibold text-frost">
                  Tracks ({currentTimeline.tracks.length})
                </h3>
                <span className="font-mono text-xs text-fog">
                  Evaluated bottom to top | Later track wins on LTP
                </span>
              </div>

              {currentTimeline.tracks.length === 0 ? (
                <div className="bg-pitch border border-steel rounded p-3 font-mono text-xs text-fog">
                  No tracks yet. Add a track on the right to schedule FX clips.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {currentTimeline.tracks.map((track) => (
                    <div
                      key={track.id}
                      className="bg-pitch border border-steel rounded p-2.5 flex flex-col gap-2"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-sans text-xs font-semibold text-frost">
                            {track.name}
                          </span>{" "}
                          <span className="font-mono text-[11px] text-fog">
                            ({track.id}) | Target:{" "}
                            {track.target_group ?? "block default"}
                          </span>
                        </div>
                        <button
                          type="button"
                          aria-label={`Delete Track ${track.name}`}
                          onClick={() => void handleDeleteTrack(track.id)}
                          className="p-1 rounded border border-steel bg-ink text-signal hover:bg-slate-dark"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="relative h-12 bg-void border border-steel rounded overflow-hidden">
                        {track.clips.map((clip, idx) => {
                          const leftPct =
                            (clip.start_sec /
                              Math.max(0.1, currentTimeline.duration_sec)) *
                            100;
                          const widthPct =
                            (clip.duration_sec /
                              Math.max(0.1, currentTimeline.duration_sec)) *
                            100;
                          return (
                            <div
                              key={`${track.id}-clip-${idx}`}
                              style={{
                                left: `${Math.max(0, Math.min(98, leftPct))}%`,
                                width: `${Math.max(3, Math.min(100 - leftPct, widthPct))}%`,
                              }}
                              className="absolute top-1 bottom-1 bg-slate border border-ember/80 rounded px-1.5 flex items-center justify-between gap-1 text-[10px] font-mono text-frost overflow-hidden"
                            >
                              <span className="truncate">
                                {clip.ref_block ?? "Inline FX"} (
                                {clip.start_sec.toFixed(2)}s for{" "}
                                {clip.duration_sec.toFixed(1)}s)
                              </span>
                              <button
                                type="button"
                                aria-label={`Delete Clip ${idx + 1} on ${track.name}`}
                                onClick={() =>
                                  void handleDeleteClip(track.id, idx)
                                }
                                className="text-signal shrink-0"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="bg-slate border border-steel rounded-panel p-3 flex flex-col gap-3">
              <h3 className="font-sans text-sm font-semibold text-frost">
                Add Track &amp; Schedule Clip
              </h3>

              <div className="grid grid-cols-2 gap-2 bg-pitch border border-steel rounded p-2.5">
                <label className="flex flex-col gap-1 col-span-2">
                  <span className="font-mono text-[11px] text-fog">
                    Track Name
                  </span>
                  <input
                    aria-label="New Track Name"
                    type="text"
                    value={newTrackName}
                    onChange={(e) => setNewTrackName(e.target.value)}
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-sans text-frost"
                  />
                </label>

                <label className="flex flex-col gap-1 col-span-2">
                  <span className="font-mono text-[11px] text-fog">
                    Track Target
                  </span>
                  <select
                    aria-label="New Track Target"
                    value={newTrackTarget}
                    onChange={(e) => setNewTrackTarget(e.target.value)}
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  >
                    {targetOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  onClick={() => void handleAddTrack()}
                  className="col-span-2 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-cobalt hover:bg-cobalt/90 font-sans text-xs font-semibold text-frost"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Track</span>
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 bg-pitch border border-steel rounded p-2.5">
                <label className="flex flex-col gap-1 col-span-2">
                  <span className="font-mono text-[11px] text-fog">
                    Target Track
                  </span>
                  <select
                    aria-label="Clip Track"
                    value={effectiveTrackId}
                    onChange={(e) => setClipTrackId(e.target.value)}
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  >
                    {currentTimeline.tracks.map((tr) => (
                      <option key={tr.id} value={tr.id}>
                        {tr.name} ({tr.id})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 col-span-2">
                  <span className="font-mono text-[11px] text-fog">
                    FX Block Reference
                  </span>
                  <select
                    aria-label="Clip Block Ref"
                    value={effectiveBlockRef}
                    onChange={(e) => setClipBlockRef(e.target.value)}
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  >
                    {showState.fx_library.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.id})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Start (s)
                  </span>
                  <input
                    aria-label="Clip Start Sec"
                    type="number"
                    min={0}
                    step={0.05}
                    value={clipStartSec}
                    onChange={(e) =>
                      setClipStartSec(Number(e.target.value) || 0)
                    }
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Duration (s)
                  </span>
                  <input
                    aria-label="Clip Duration Sec"
                    type="number"
                    min={0.1}
                    step={0.25}
                    value={clipDurationSec}
                    onChange={(e) =>
                      setClipDurationSec(Number(e.target.value) || 1)
                    }
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Fade In (s)
                  </span>
                  <input
                    aria-label="Clip Fade In Sec"
                    type="number"
                    min={0}
                    step={0.1}
                    value={clipFadeInSec}
                    onChange={(e) =>
                      setClipFadeInSec(Number(e.target.value) || 0)
                    }
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-fog">
                    Fade Out (s)
                  </span>
                  <input
                    aria-label="Clip Fade Out Sec"
                    type="number"
                    min={0}
                    step={0.1}
                    value={clipFadeOutSec}
                    onChange={(e) =>
                      setClipFadeOutSec(Number(e.target.value) || 0)
                    }
                    className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => void handleAddClip()}
                  className="col-span-2 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-ember hover:bg-ember/90 font-sans text-xs font-semibold text-frost"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Clip</span>
                </button>
              </div>
            </section>
          </div>
        </>
      )}

      {/* Live Cell Preview */}
      <section className="bg-slate border border-steel rounded-panel p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="font-sans text-sm font-semibold text-frost">
            Live Evaluated Cell Output ({compiledCells.length} cells)
          </h3>
          <span className="font-mono text-[11px] text-fog">
            Timeline tracks + Active busk scenes merged live
          </span>
        </div>

        <div
          data-testid="timeline-live-cell-preview"
          className="flex flex-wrap gap-1.5 bg-void border border-steel rounded p-2.5"
        >
          {compiledCells.length === 0 ? (
            <span className="font-mono text-xs text-fog">
              Patch fixtures to inspect Timeline DMX evaluation across cells.
            </span>
          ) : (
            compiledCells.map((cell, idx) => {
              const base = idx * 4;
              const r = cellPreviewRgbd[base] ?? 0;
              const g = cellPreviewRgbd[base + 1] ?? 0;
              const b = cellPreviewRgbd[base + 2] ?? 0;
              const d = cellPreviewRgbd[base + 3] ?? 0;
              const scale = d / 255;
              const bg = `rgb(${Math.round(r * scale)}, ${Math.round(g * scale)}, ${Math.round(b * scale)})`;

              return (
                <div
                  key={`${cell.fixture_id}-${cell.cell_index}`}
                  title={`${cell.fixture_id}:${cell.cell_index} RGB(${r},${g},${b}) D=${d}`}
                  className="w-10 h-10 rounded border border-steel flex flex-col items-center justify-end p-0.5 font-mono text-[9px] text-frost"
                  style={{ backgroundColor: bg }}
                >
                  <span className="bg-void/70 px-1 rounded">
                    {cell.pixel_key}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
