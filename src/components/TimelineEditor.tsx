import {
  Activity,
  AudioWaveform,
  Clock,
  Copy,
  Magnet,
  Pause,
  Play,
  Plus,
  Redo2,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type DragEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ClipDef,
  computeBeatGridMarkers,
  sampleOklabGradientHex,
  snapTimeSecToMarkers,
  type TimelineDef,
  type TrackDef,
} from "../lib/mixerLogic";
import { useTaktStore } from "../store/useTaktStore";
import { classifySceneMode } from "./SceneAndFxManager";

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

type DragMode =
  | "move"
  | "trim_start"
  | "trim_end"
  | "fade_in"
  | "fade_out"
  | "scrub";

interface ClipDragState {
  mode: DragMode;
  trackId?: string;
  clipIndex?: number;
  initialClientX: number;
  initialStartSec: number;
  initialDurationSec: number;
  initialFadeInSec: number;
  initialFadeOutSec: number;
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
  const [timelineZoom, setTimelineZoom] = useState(1.0);
  const [selectedClip, setSelectedClip] = useState<{
    trackId: string;
    clipIndex: number;
  } | null>(null);
  const [clipDragState, setClipDragState] = useState<ClipDragState | null>(
    null,
  );

  const [newTrackName, setNewTrackName] = useState("Accent Track");
  const [newTrackTarget, setNewTrackTarget] = useState("all");
  const [clipTrackId, setClipTrackId] = useState("");
  const [clipBlockRef, setClipBlockRef] = useState(
    showState.fx_library[0]?.id ?? "",
  );
  const [clipStartSec, setClipStartSec] = useState(1.0);
  const [clipDurationSec, setClipDurationSec] = useState(4.0);
  const [clipFadeInSec, setClipFadeInSec] = useState(0.0);
  const [clipFadeOutSec, setClipFadeOutSec] = useState(0.0);
  const [paletteSelectedSceneId, setPaletteSelectedSceneId] = useState(
    showState.scenes[0]?.id ?? "",
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lanesViewportRef = useRef<HTMLDivElement | null>(null);

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

  // Keep selectedClip valid or auto-select first available clip
  const resolvedSelectedClip = useMemo(() => {
    if (!currentTimeline) return null;
    if (selectedClip) {
      const trk = currentTimeline.tracks.find(
        (t) => t.id === selectedClip.trackId,
      );
      const clp = trk?.clips[selectedClip.clipIndex];
      if (trk && clp) {
        return {
          trackId: trk.id,
          clipIndex: selectedClip.clipIndex,
          clip: clp,
          track: trk,
        };
      }
    }
    for (const trk of currentTimeline.tracks) {
      if (trk.clips.length > 0) {
        return {
          trackId: trk.id,
          clipIndex: 0,
          clip: trk.clips[0],
          track: trk,
        };
      }
    }
    return null;
  }, [currentTimeline, selectedClip]);

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
    const clipEdges: number[] = [];
    if (currentTimeline) {
      for (const trk of currentTimeline.tracks) {
        for (const c of trk.clips) {
          clipEdges.push(c.start_sec, c.start_sec + c.duration_sec);
        }
      }
    }
    return [...beatGridMarkers, ...transientTimes, timelinePlayheadSec, ...clipEdges];
  }, [analysis, beatGridMarkers, currentTimeline, timelinePlayheadSec]);

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

  const updateClipInTrack = useCallback(
    (
      trackId: string,
      clipIndex: number,
      updater: (clip: ClipDef) => ClipDef,
      coalesceKey?: string,
    ) => {
      if (!currentTimeline) return;
      const nextTracks = currentTimeline.tracks.map((tr) =>
        tr.id === trackId
          ? {
              ...tr,
              clips: tr.clips.map((c, idx) =>
                idx === clipIndex ? updater(c) : c,
              ),
            }
          : tr,
      );
      void upsertTimeline(
        { ...currentTimeline, tracks: nextTracks },
        coalesceKey,
      );
    },
    [currentTimeline, upsertTimeline],
  );

  // Global pointer drag handler for NLE move, trim_start, trim_end, fade_in, fade_out, scrub
  useEffect(() => {
    if (!clipDragState || !currentTimeline) return;

    const dur = Math.max(0.1, currentTimeline.duration_sec);
    const getViewportWidth = () => {
      const rect = lanesViewportRef.current?.getBoundingClientRect();
      return rect && rect.width > 10 ? rect.width : 800;
    };

    const onPointerMove = (e: PointerEvent | globalThis.MouseEvent) => {
      if (
        !Number.isFinite(e.clientX) ||
        !Number.isFinite(clipDragState.initialClientX)
      ) {
        return;
      }
      const vw = getViewportWidth();
      const dxSec = ((e.clientX - clipDragState.initialClientX) / vw) * dur;

      if (clipDragState.mode === "scrub") {
        const rect = lanesViewportRef.current?.getBoundingClientRect();
        const left = rect?.left ?? 0;
        const frac = Math.max(0, Math.min(1, (e.clientX - left) / vw));
        const rawSec = frac * dur;
        const sec = magneticSnap
          ? snapTimeSecToMarkers(rawSec, snapMarkers, 0.12)
          : Number(rawSec.toFixed(3));
        void setTimelineTransport(currentTimeline.id, timelinePlaying, sec);
        return;
      }

      const { trackId, clipIndex } = clipDragState;
      if (!trackId || clipIndex === undefined) return;

      if (clipDragState.mode === "move") {
        const rawStart = Math.max(
          0,
          Math.min(
            dur - clipDragState.initialDurationSec,
            clipDragState.initialStartSec + dxSec,
          ),
        );
        const snappedStart = magneticSnap
          ? snapTimeSecToMarkers(rawStart, snapMarkers, 0.15)
          : Number(rawStart.toFixed(3));
        updateClipInTrack(
          trackId,
          clipIndex,
          (c) => ({ ...c, start_sec: Math.max(0, snappedStart) }),
          `clip_move_${trackId}_${clipIndex}`,
        );
      } else if (clipDragState.mode === "trim_start") {
        const origEnd =
          clipDragState.initialStartSec + clipDragState.initialDurationSec;
        const rawStart = Math.max(
          0,
          Math.min(origEnd - 0.1, clipDragState.initialStartSec + dxSec),
        );
        const snappedStart = magneticSnap
          ? snapTimeSecToMarkers(rawStart, snapMarkers, 0.15)
          : Number(rawStart.toFixed(3));
        const safeStart = Math.max(0, Math.min(origEnd - 0.1, snappedStart));
        const nextDur = Number(Math.max(0.1, origEnd - safeStart).toFixed(3));
        updateClipInTrack(
          trackId,
          clipIndex,
          (c) => ({
            ...c,
            start_sec: safeStart,
            duration_sec: nextDur,
            fade_in_sec: Math.min(c.fade_in_sec, nextDur * 0.5),
            fade_out_sec: Math.min(c.fade_out_sec, nextDur * 0.5),
          }),
          `clip_trim_start_${trackId}_${clipIndex}`,
        );
      } else if (clipDragState.mode === "trim_end") {
        const rawEnd = Math.max(
          clipDragState.initialStartSec + 0.1,
          Math.min(
            dur,
            clipDragState.initialStartSec +
              clipDragState.initialDurationSec +
              dxSec,
          ),
        );
        const snappedEnd = magneticSnap
          ? snapTimeSecToMarkers(rawEnd, snapMarkers, 0.15)
          : Number(rawEnd.toFixed(3));
        const nextDur = Number(
          Math.max(0.1, snappedEnd - clipDragState.initialStartSec).toFixed(3),
        );
        updateClipInTrack(
          trackId,
          clipIndex,
          (c) => ({
            ...c,
            duration_sec: nextDur,
            fade_in_sec: Math.min(c.fade_in_sec, nextDur * 0.5),
            fade_out_sec: Math.min(c.fade_out_sec, nextDur * 0.5),
          }),
          `clip_trim_end_${trackId}_${clipIndex}`,
        );
      } else if (clipDragState.mode === "fade_in") {
        const maxFade = Math.max(0, clipDragState.initialDurationSec - 0.05);
        const nextFade = Number(
          Math.max(
            0,
            Math.min(maxFade, clipDragState.initialFadeInSec + dxSec),
          ).toFixed(2),
        );
        updateClipInTrack(
          trackId,
          clipIndex,
          (c) => ({ ...c, fade_in_sec: nextFade }),
          `clip_fade_in_${trackId}_${clipIndex}`,
        );
      } else if (clipDragState.mode === "fade_out") {
        const maxFade = Math.max(0, clipDragState.initialDurationSec - 0.05);
        const nextFade = Number(
          Math.max(
            0,
            Math.min(maxFade, clipDragState.initialFadeOutSec - dxSec),
          ).toFixed(2),
        );
        updateClipInTrack(
          trackId,
          clipIndex,
          (c) => ({ ...c, fade_out_sec: nextFade }),
          `clip_fade_out_${trackId}_${clipIndex}`,
        );
      }
    };

    const onPointerUp = () => {
      setClipDragState(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
    };
  }, [
    clipDragState,
    currentTimeline,
    magneticSnap,
    setTimelineTransport,
    snapMarkers,
    timelinePlaying,
    updateClipInTrack,
  ]);

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

  const handleAddClipAt = async (
    trackId: string,
    startSec: number,
    durationSec = clipDurationSec,
    overrideBlockRef?: string,
  ) => {
    const blockToUse = overrideBlockRef || effectiveBlockRef;
    if (!currentTimeline || !trackId || !blockToUse) return;
    const snappedStart = magneticSnap
      ? snapTimeSecToMarkers(startSec, snapMarkers, 0.15)
      : startSec;
    const clip: ClipDef = {
      ref_block: blockToUse,
      start_sec: Math.max(0, snappedStart),
      duration_sec: Math.max(0.1, durationSec),
      fade_in_sec: Math.max(0, clipFadeInSec),
      fade_out_sec: Math.max(0, clipFadeOutSec),
      inline_fx: [],
    };
    const trk = currentTimeline.tracks.find((t) => t.id === trackId);
    const nextIdx = trk ? trk.clips.length : 0;
    await upsertTimeline({
      ...currentTimeline,
      tracks: currentTimeline.tracks.map((tr) =>
        tr.id === trackId ? { ...tr, clips: [...tr.clips, clip] } : tr,
      ),
    });
    setSelectedClip({ trackId, clipIndex: nextIdx });
  };

  const dropSceneToTrack = async (
    sceneId: string,
    trackId: string,
    atSec: number,
    durationSec = clipDurationSec,
  ) => {
    const scene = showState.scenes.find((s) => s.id === sceneId);
    const blockId = scene?.block_refs[0] ?? effectiveBlockRef;
    if (!blockId) return;
    setPaletteSelectedSceneId(sceneId);
    await handleAddClipAt(trackId, atSec, durationSec, blockId);
  };

  const handleAddClip = async () => {
    await handleAddClipAt(effectiveTrackId, clipStartSec, clipDurationSec);
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
    if (
      selectedClip?.trackId === trackId &&
      selectedClip?.clipIndex === clipIdx
    ) {
      setSelectedClip(null);
    }
  };

  const handleSplitClipAtPlayhead = async () => {
    if (!currentTimeline) return;
    const tSplit = timelinePlayheadSec;

    // Prefer selected clip if playhead falls inside it; else find any clip spanning playhead
    let targetTrackId = resolvedSelectedClip?.trackId ?? "";
    let targetClipIdx = resolvedSelectedClip?.clipIndex ?? -1;
    let targetClip = resolvedSelectedClip?.clip ?? null;

    if (
      !targetClip ||
      tSplit <= targetClip.start_sec + 0.05 ||
      tSplit >= targetClip.start_sec + targetClip.duration_sec - 0.05
    ) {
      targetClip = null;
      for (const trk of currentTimeline.tracks) {
        const idx = trk.clips.findIndex(
          (c) =>
            tSplit > c.start_sec + 0.05 &&
            tSplit < c.start_sec + c.duration_sec - 0.05,
        );
        if (idx !== -1) {
          targetTrackId = trk.id;
          targetClipIdx = idx;
          targetClip = trk.clips[idx];
          break;
        }
      }
    }

    if (!targetClip || targetClipIdx < 0) return;

    const leftDur = Number((tSplit - targetClip.start_sec).toFixed(3));
    const rightDur = Number(
      (targetClip.start_sec + targetClip.duration_sec - tSplit).toFixed(3),
    );
    const leftClip: ClipDef = {
      ...targetClip,
      duration_sec: leftDur,
      fade_in_sec: Math.min(targetClip.fade_in_sec, leftDur),
      fade_out_sec: 0,
    };
    const rightClip: ClipDef = {
      ...targetClip,
      start_sec: Number(tSplit.toFixed(3)),
      duration_sec: rightDur,
      fade_in_sec: 0,
      fade_out_sec: Math.min(targetClip.fade_out_sec, rightDur),
    };

    await upsertTimeline({
      ...currentTimeline,
      tracks: currentTimeline.tracks.map((tr) => {
        if (tr.id !== targetTrackId) return tr;
        const nextClips = [...tr.clips];
        nextClips.splice(targetClipIdx, 1, leftClip, rightClip);
        return { ...tr, clips: nextClips };
      }),
    });
    setSelectedClip({ trackId: targetTrackId, clipIndex: targetClipIdx + 1 });
  };

  const handleDuplicateSelectedClip = async () => {
    if (!currentTimeline || !resolvedSelectedClip) return;
    const { trackId, clip } = resolvedSelectedClip;
    const nextStart = Number(
      Math.min(
        Math.max(0, currentTimeline.duration_sec - 0.1),
        clip.start_sec + clip.duration_sec,
      ).toFixed(3),
    );
    const copy: ClipDef = {
      ...clip,
      start_sec: nextStart,
      duration_sec: Math.min(
        clip.duration_sec,
        Math.max(0.1, currentTimeline.duration_sec - nextStart),
      ),
    };
    const trk = currentTimeline.tracks.find((t) => t.id === trackId);
    const nextIdx = trk ? trk.clips.length : 0;
    await upsertTimeline({
      ...currentTimeline,
      tracks: currentTimeline.tracks.map((tr) =>
        tr.id === trackId ? { ...tr, clips: [...tr.clips, copy] } : tr,
      ),
    });
    setSelectedClip({ trackId, clipIndex: nextIdx });
  };

  const handleSnapSelectedClip = async () => {
    if (!currentTimeline || !resolvedSelectedClip) return;
    const { trackId, clipIndex, clip } = resolvedSelectedClip;
    const snappedStart = snapTimeSecToMarkers(clip.start_sec, snapMarkers, 0.5);
    const snappedEnd = snapTimeSecToMarkers(
      clip.start_sec + clip.duration_sec,
      snapMarkers,
      0.5,
    );
    const nextDur = Math.max(0.1, Number((snappedEnd - snappedStart).toFixed(3)));
    updateClipInTrack(trackId, clipIndex, (c) => ({
      ...c,
      start_sec: snappedStart,
      duration_sec: nextDur,
    }));
  };

  const handleAutoPlaceOnKicks = async () => {
    if (!currentTimeline || !effectiveTrackId || !effectiveBlockRef) return;
    let res = analysis;
    if (!res) {
      res = await analyzeTimelineAudio(currentTimeline.id);
    }
    const kicks = res.transients.filter((m) => m.band === "kick");
    const times =
      kicks.length > 0
        ? kicks.map((k) => k.time_sec)
        : beatGridMarkers.filter((_, i) => i % 2 === 0);

    const generated: ClipDef[] = times.slice(0, 32).map((t) => ({
      ref_block: effectiveBlockRef,
      start_sec: t,
      duration_sec: 0.25,
      fade_in_sec: 0,
      fade_out_sec: 0,
      inline_fx: [],
    }));
    await upsertTimeline({
      ...currentTimeline,
      tracks: currentTimeline.tracks.map((tr) =>
        tr.id === effectiveTrackId
          ? { ...tr, clips: [...tr.clips, ...generated] }
          : tr,
      ),
    });
  };

  const scrubFromClientX = (clientX: number) => {
    if (!currentTimeline || !Number.isFinite(clientX)) return;
    const rect = lanesViewportRef.current?.getBoundingClientRect();
    const vw = rect && rect.width > 10 ? rect.width : 800;
    const left = rect?.left ?? 0;
    const dur = Math.max(0.1, currentTimeline.duration_sec);
    const frac = Math.max(0, Math.min(1, (clientX - left) / vw));
    const rawSec = frac * dur;
    const sec = magneticSnap
      ? snapTimeSecToMarkers(rawSec, snapMarkers, 0.12)
      : Number(rawSec.toFixed(3));
    void setTimelineTransport(currentTimeline.id, timelinePlaying, sec);
  };

  const handleLaneDoubleClick = (
    e: MouseEvent<HTMLDivElement>,
    trackId: string,
  ) => {
    if (!currentTimeline) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const vw = rect.width > 10 ? rect.width : 800;
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / vw));
    const sec = Number((frac * currentTimeline.duration_sec).toFixed(3));
    void handleAddClipAt(trackId, sec, Math.min(2.0, clipDurationSec));
  };

  const getBlockColors = (blockId: string | null): [string, string] | null => {
    if (!blockId) return null;
    const blk = showState.fx_library.find((b) => b.id === blockId);
    if (!blk) return null;
    for (const el of blk.elements) {
      if (el.palette_ref) {
        const pal = showState.color_palettes.find((p) => p.id === el.palette_ref);
        if (pal) return [pal.hex_start, pal.hex_end];
      }
    }
    return null;
  };

  const activeBpm =
    currentTimeline?.tempo_map[0]?.bpm ?? showState.bpm ?? 120;
  const activeSensitivity =
    currentTimeline?.audio_track?.transient_sensitivity ?? 0.65;

  const durationSec = Math.max(0.1, currentTimeline?.duration_sec ?? 16);
  const playheadPct = Math.max(
    0,
    Math.min(100, (timelinePlayheadSec / durationSec) * 100),
  );
  const rulerTicks = useMemo(() => {
    const step = durationSec > 40 ? 5 : durationSec > 16 ? 2 : 1;
    const ticks: number[] = [];
    for (let t = 0; t <= durationSec + 1e-6; t += step) {
      ticks.push(Number(t.toFixed(2)));
    }
    return ticks;
  }, [durationSec]);

  return (
    <div className="flex flex-col gap-3">
      {/* Unified NLE Transport, Audio & Clip Action Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate border border-steel rounded-panel px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <AudioWaveform className="w-4 h-4 text-plum" />
          <h2 className="font-sans text-sm font-semibold text-frost">
            NLE Audio &amp; Lighting Timeline
          </h2>

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
            className="flex items-center gap-1 px-2 py-1 rounded border border-steel bg-ink hover:border-fog font-mono text-xs text-mist"
          >
            <Plus className="w-3 h-3" />
            <span>New Timeline</span>
          </button>
        </div>

        {currentTimeline && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                void setTimelineTransport(
                  currentTimeline.id,
                  !timelinePlaying,
                )
              }
              className="flex items-center gap-1 px-3 py-1 rounded bg-ember hover:bg-burnt text-frost font-mono text-xs font-semibold transition-colors"
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

            <label className="flex items-center gap-1 bg-pitch border border-steel rounded px-2 py-1">
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
                className="w-14 bg-ink border border-steel rounded px-1 py-0.5 font-mono text-xs text-frost"
              />
            </label>

            <button
              type="button"
              onClick={() => void analyzeTimelineAudio(currentTimeline.id)}
              className="flex items-center gap-1 px-2.5 py-1 rounded border border-cobalt bg-cobalt/20 hover:bg-cobalt/30 font-mono text-xs font-medium text-frost transition-colors"
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Analyze Audio</span>
            </button>

            <label className="flex items-center gap-1 px-2 py-1 rounded border border-steel bg-ink font-mono text-xs text-mist">
              <input
                aria-label="Magnetic Snap"
                type="checkbox"
                checked={magneticSnap}
                onChange={(e) => setMagneticSnap(e.target.checked)}
              />
              <Magnet className="w-3 h-3 text-plum" />
              <span>Snap</span>
            </label>

            {/* NLE Timeline Zoom Controls */}
            <div className="flex items-center gap-0.5 bg-ink border border-steel rounded p-0.5 font-mono text-[10px]">
              <button
                type="button"
                data-testid="timeline-zoom-out"
                onClick={() =>
                  setTimelineZoom((z) =>
                    Math.max(1.0, Number((z - 0.5).toFixed(1))),
                  )
                }
                title="Zoom Out Timeline"
                className="p-1 text-mist hover:text-ember"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                data-testid="timeline-zoom-reset"
                onClick={() => setTimelineZoom(1.0)}
                className="px-1.5 text-frost"
              >
                {timelineZoom.toFixed(1)}×
              </button>
              <button
                type="button"
                data-testid="timeline-zoom-in"
                onClick={() =>
                  setTimelineZoom((z) =>
                    Math.min(4.0, Number((z + 0.5).toFixed(1))),
                  )
                }
                title="Zoom In Timeline"
                className="p-1 text-mist hover:text-ember"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>

            <button
              type="button"
              disabled={!canUndo}
              onClick={() => void undoShow()}
              className="flex items-center gap-1 px-2 py-1 rounded border border-steel bg-ink font-mono text-xs text-mist disabled:opacity-40"
            >
              <Undo2 className="w-3.5 h-3.5" />
              <span>Undo</span>
            </button>

            <button
              type="button"
              disabled={!canRedo}
              onClick={() => void redoShow()}
              className="flex items-center gap-1 px-2 py-1 rounded border border-steel bg-ink font-mono text-xs text-mist disabled:opacity-40"
            >
              <Redo2 className="w-3.5 h-3.5" />
              <span>Redo</span>
            </button>

            <button
              type="button"
              aria-label="Delete Timeline"
              onClick={() => void deleteTimeline(currentTimeline.id)}
              className="p-1.5 rounded border border-steel bg-ink text-signal hover:bg-slate-dark"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {currentTimeline && (
        <>
          {/* NLE Video-Editor Action Bar + Beat Grid Settings */}
          <div className="bg-slate border border-steel rounded-panel px-3 py-2 flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                data-testid="timeline-split-clip-btn"
                onClick={() => void handleSplitClipAtPlayhead()}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-ink border border-steel hover:border-ember text-frost"
                title="Split selected or hovered clip at current playhead position"
              >
                <Scissors className="w-3.5 h-3.5 text-ember" />
                <span>Split at Playhead</span>
              </button>

              <button
                type="button"
                data-testid="timeline-duplicate-clip-btn"
                disabled={!resolvedSelectedClip}
                onClick={() => void handleDuplicateSelectedClip()}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-ink border border-steel hover:border-cobalt text-frost disabled:opacity-40"
              >
                <Copy className="w-3.5 h-3.5 text-cobalt" />
                <span>Duplicate Clip</span>
              </button>

              <button
                type="button"
                data-testid="timeline-snap-clip-btn"
                disabled={!resolvedSelectedClip}
                onClick={() => void handleSnapSelectedClip()}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-ink border border-steel hover:border-plum text-frost disabled:opacity-40"
              >
                <Magnet className="w-3.5 h-3.5 text-plum" />
                <span>Snap Clip</span>
              </button>

              <button
                type="button"
                data-testid="timeline-auto-place-kicks-btn"
                onClick={() => void handleAutoPlaceOnKicks()}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-plum/20 border border-plum hover:bg-plum/30 text-frost"
                title="Automatically place beat-synced light hits on detected Kick transients"
              >
                <Sparkles className="w-3.5 h-3.5 text-plum" />
                <span>Auto-Fill Kicks</span>
              </button>
            </div>

            {/* Compact Tempo, Grid Offset, Latency & Sensitivity Controls */}
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <label className="flex items-center gap-1 bg-pitch border border-steel rounded px-2 py-0.5">
                <span className="text-fog">BPM</span>
                <input
                  aria-label="Timeline Tempo BPM"
                  type="number"
                  min={20}
                  max={300}
                  step={0.5}
                  value={activeBpm}
                  onChange={(e) => handleUpdateTempoBpm(Number(e.target.value))}
                  className="w-14 bg-ink border border-steel rounded px-1 text-frost"
                />
              </label>

              <label className="flex items-center gap-1 bg-pitch border border-steel rounded px-2 py-0.5">
                <span className="text-fog">Grid(s)</span>
                <input
                  aria-label="Grid Offset Sec"
                  type="number"
                  min={0}
                  step={0.01}
                  value={currentTimeline.grid_offset_sec}
                  onChange={(e) =>
                    handleUpdateGridOffset(Number(e.target.value))
                  }
                  className="w-14 bg-ink border border-steel rounded px-1 text-frost"
                />
              </label>

              <label className="flex items-center gap-1 bg-pitch border border-steel rounded px-2 py-0.5">
                <span className="text-fog">Sens</span>
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
                  className="w-12 bg-ink border border-steel rounded px-1 text-frost"
                />
              </label>

              <label className="flex items-center gap-1 bg-pitch border border-steel rounded px-2 py-0.5">
                <span className="text-fog">Offset(ms)</span>
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
                  className="w-12 bg-ink border border-steel rounded px-1 text-frost"
                />
              </label>
            </div>
          </div>

          {/* Draggable Scene Palette Bar (Drag Scenes onto any Track to Layer Colors + Effects) */}
          <section
            data-testid="timeline-scene-palette"
            className="bg-slate border border-steel rounded-panel p-2.5 flex flex-col gap-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px]">
              <span className="font-semibold uppercase text-frost">
                Scenes (Drag onto a Track below, or click + Drop to Layer Color &amp; Effect Tracks)
              </span>
              <span className="text-fog">
                Target Drop Track:{" "}
                <strong className="text-ember">
                  {currentTimeline.tracks.find((t) => t.id === effectiveTrackId)
                    ?.name ?? "None"}
                </strong>
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {showState.scenes.map((scene) => {
                const mode = classifySceneMode(scene, showState.fx_library);
                const badge =
                  mode === "color"
                    ? "COLOR"
                    : mode === "color_anim"
                      ? "COLOR ANIM"
                      : "EFFECT";
                const badgeStyle =
                  mode === "color"
                    ? "bg-plum/25 text-plum border-plum/60"
                    : mode === "color_anim"
                      ? "bg-cobalt/25 text-cobalt border-cobalt/60"
                      : "bg-ember/20 text-ember border-ember/60";
                const colors = scene.block_refs[0]
                  ? getBlockColors(scene.block_refs[0])
                  : null;
                return (
                  <div
                    key={scene.id}
                    data-testid={`draggable-scene-${scene.id}`}
                    draggable
                    onDragStart={(e) => {
                      setPaletteSelectedSceneId(scene.id);
                      e.dataTransfer?.setData("text/takt-scene-id", scene.id);
                      e.dataTransfer?.setData("text/plain", scene.id);
                    }}
                    className="flex items-center gap-2 bg-pitch border border-steel hover:border-ember rounded px-2 py-1 cursor-grab active:cursor-grabbing"
                  >
                    <span
                      className="w-4 h-2.5 rounded-sm border border-steel/60 shrink-0"
                      style={{
                        background: colors
                          ? `linear-gradient(90deg, ${colors[0]}, ${colors[1]})`
                          : "#4A5A6A",
                      }}
                    />
                    <span className="font-sans text-xs font-semibold text-frost">
                      {scene.name}
                    </span>
                    <span
                      className={`px-1 py-0.2 rounded border font-mono text-[9px] ${badgeStyle}`}
                    >
                      {badge}
                    </span>
                    <span className="font-mono text-[9px] text-fog">
                      ({scene.bank ?? "Overlay"})
                    </span>
                    <button
                      type="button"
                      data-testid={`drop-scene-to-timeline-${scene.id}`}
                      onClick={() =>
                        void dropSceneToTrack(
                          scene.id,
                          effectiveTrackId,
                          timelinePlayheadSec,
                        )
                      }
                      className="px-1.5 py-0.5 rounded bg-ink border border-steel hover:border-ember font-mono text-[10px] text-frost"
                      title={`Drop ${scene.name} at playhead onto ${
                        currentTimeline.tracks.find(
                          (t) => t.id === effectiveTrackId,
                        )?.name ?? "track"
                      }`}
                    >
                      + Drop
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Synchronized Multi-Track NLE Timeline Area (Left Headers + Shared Horizontal Time Axis) */}
          <section className="bg-slate border border-steel rounded-panel p-2.5 flex flex-col gap-2">
            <div className="flex overflow-x-auto border border-steel rounded bg-pitch">
              {/* Left Sticky Track Header Column */}
              <div className="w-44 shrink-0 border-r border-steel bg-slate-dark flex flex-col">
                <div className="h-7 border-b border-steel px-2 flex items-center justify-between font-mono text-[10px] text-fog">
                  <span>TIME ({durationSec}s)</span>
                  <span>{beatGridMarkers.length} beats</span>
                </div>
                <div className="h-24 border-b border-steel px-2 py-1.5 flex flex-col justify-between">
                  <div className="flex items-center gap-1.5 font-sans text-xs font-semibold text-frost">
                    <AudioWaveform className="w-3.5 h-3.5 text-cobalt" />
                    <span>Audio Master</span>
                  </div>
                  <span className="font-mono text-[10px] text-plum">
                    {analysis
                      ? `${analysis.estimated_bpm.toFixed(0)} BPM • ${analysis.transients.length} hits`
                      : "Analyze for transients"}
                  </span>
                </div>
                {currentTimeline.tracks.map((track) => (
                  <div
                    key={track.id}
                    className="h-14 border-b border-steel/70 last:border-b-0 px-2 py-1 flex items-center justify-between gap-1"
                  >
                    <div className="min-w-0">
                      <div className="font-sans text-xs font-semibold text-frost truncate">
                        {track.name}
                      </div>
                      <div className="font-mono text-[9px] text-fog truncate">
                        {track.target_group ?? "block"} • {track.clips.length}{" "}
                        clips
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label={`Delete Track ${track.name}`}
                      onClick={() => void handleDeleteTrack(track.id)}
                      className="p-1 rounded border border-steel bg-ink text-signal hover:bg-slate-dark shrink-0"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>

              {/* Right Scrollable Time-Aligned Viewport */}
              <div className="flex-1 min-w-0 overflow-x-auto">
                <div
                  ref={lanesViewportRef}
                  style={{ width: `${timelineZoom * 100}%` }}
                  className="relative flex flex-col min-w-full"
                >
                  {/* Full-Height Vertical Playhead Cursor */}
                  <div
                    data-testid="nle-playhead-line"
                    style={{ left: `${playheadPct}%` }}
                    className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-ember z-20"
                  />

                  {/* Interactive Time Ruler */}
                  <div
                    data-testid="timeline-ruler"
                    onPointerDown={(e) => {
                      scrubFromClientX(e.clientX);
                      setClipDragState({
                        mode: "scrub",
                        initialClientX: Number.isFinite(e.clientX) ? e.clientX : 0,
                        initialStartSec: 0,
                        initialDurationSec: 0,
                        initialFadeInSec: 0,
                        initialFadeOutSec: 0,
                      });
                    }}
                    className="relative h-7 border-b border-steel bg-ink cursor-ew-resize select-none"
                  >
                    {rulerTicks.map((sec) => (
                      <div
                        key={sec}
                        style={{ left: `${(sec / durationSec) * 100}%` }}
                        className="absolute top-0 bottom-0 border-l border-steel/70 pl-1 font-mono text-[9px] text-fog flex items-center"
                      >
                        {sec}s
                      </div>
                    ))}
                    <div
                      style={{ left: `${playheadPct}%` }}
                      className="absolute top-0 -translate-x-1/2 px-1 bg-ember text-void font-mono text-[9px] font-bold rounded-b"
                    >
                      {timelinePlayheadSec.toFixed(2)}s
                    </div>
                  </div>

                  {/* Audio Waveform + Transient Lane */}
                  <div
                    data-testid="timeline-waveform-lane"
                    onPointerDown={(e) => {
                      scrubFromClientX(e.clientX);
                      setClipDragState({
                        mode: "scrub",
                        initialClientX: Number.isFinite(e.clientX) ? e.clientX : 0,
                        initialStartSec: 0,
                        initialDurationSec: 0,
                        initialFadeInSec: 0,
                        initialFadeOutSec: 0,
                      });
                    }}
                    className="relative h-24 border-b border-steel bg-pitch cursor-pointer"
                  >
                    <canvas
                      ref={canvasRef}
                      width={960}
                      height={96}
                      className="w-full h-24 block"
                    />
                  </div>

                  {/* Lighting Track Clip Lanes (Double-click to add clip, Drag Scene to drop, Edges to trim) */}
                  {currentTimeline.tracks.map((track) => (
                    <div
                      key={track.id}
                      data-testid={`track-lane-${track.id}`}
                      onDoubleClick={(e) => handleLaneDoubleClick(e, track.id)}
                      onDragOver={(e: DragEvent<HTMLDivElement>) =>
                        e.preventDefault()
                      }
                      onDrop={(e: DragEvent<HTMLDivElement>) => {
                        e.preventDefault();
                        const sid =
                          e.dataTransfer?.getData("text/takt-scene-id") ||
                          e.dataTransfer?.getData("text/plain") ||
                          paletteSelectedSceneId;
                        if (!sid) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        const vw = rect.width > 10 ? rect.width : 800;
                        const frac =
                          rect.width > 10 && Number.isFinite(e.clientX)
                            ? Math.max(
                                0,
                                Math.min(1, (e.clientX - rect.left) / vw),
                              )
                            : timelinePlayheadSec / Math.max(0.1, durationSec);
                        const dropSec = Number(
                          (frac * durationSec).toFixed(3),
                        );
                        void dropSceneToTrack(sid, track.id, dropSec);
                      }}
                      className="relative h-14 border-b border-steel/70 last:border-b-0 bg-void overflow-hidden select-none"
                      title="Double-click or drop a Scene here; drag clip body to move or edges to trim"
                    >
                      {/* Beat Grid Vertical Lines */}
                      {beatGridMarkers.map((bt, bIdx) => (
                        <div
                          key={`bg-${bIdx}`}
                          style={{ left: `${(bt / durationSec) * 100}%` }}
                          className="pointer-events-none absolute top-0 bottom-0 border-l border-plum/20"
                        />
                      ))}
                      {/* Audio Transient Snap Guidelines */}
                      {analysis?.transients.map((m, mIdx) => (
                        <div
                          key={`tr-${mIdx}`}
                          style={{
                            left: `${(m.time_sec / durationSec) * 100}%`,
                          }}
                          className={`pointer-events-none absolute top-0 bottom-0 border-l ${
                            m.band === "kick"
                              ? "border-plum/50"
                              : "border-cobalt/35"
                          }`}
                        />
                      ))}

                      {/* Interactive Clip Blocks */}
                      {track.clips.map((clip, idx) => {
                        const leftPct = (clip.start_sec / durationSec) * 100;
                        const widthPct = (clip.duration_sec / durationSec) * 100;
                        const isSelected =
                          resolvedSelectedClip?.trackId === track.id &&
                          resolvedSelectedClip?.clipIndex === idx;
                        const colors = getBlockColors(clip.ref_block);
                        const fadeInPct = Math.min(
                          50,
                          (clip.fade_in_sec / Math.max(0.01, clip.duration_sec)) *
                            100,
                        );
                        const fadeOutPct = Math.min(
                          50,
                          (clip.fade_out_sec /
                            Math.max(0.01, clip.duration_sec)) *
                            100,
                        );

                        return (
                          <div
                            key={`${track.id}-clip-${idx}`}
                            data-testid={`timeline-clip-${track.id}-${idx}`}
                            style={{
                              left: `${Math.max(0, Math.min(99, leftPct))}%`,
                              width: `${Math.max(1.5, Math.min(100 - leftPct, widthPct))}%`,
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedClip({
                                trackId: track.id,
                                clipIndex: idx,
                              });
                            }}
                            className={`absolute top-1 bottom-1 rounded border flex items-stretch overflow-hidden transition-shadow ${
                              isSelected
                                ? "border-ember ring-1 ring-ember bg-slate"
                                : "border-cobalt/80 bg-slate-dark hover:border-frost"
                            }`}
                          >
                            {/* Visual Fade-In / Fade-Out Envelope SVG */}
                            <svg
                              viewBox="0 0 100 100"
                              preserveAspectRatio="none"
                              className="pointer-events-none absolute inset-0 w-full h-full opacity-35"
                            >
                              <polygon
                                points={`0,100 ${fadeInPct},0 ${100 - fadeOutPct},0 100,100`}
                                fill="#FF5500"
                              />
                            </svg>

                            {/* Left Trim Handle */}
                            <div
                              data-testid={`clip-trim-start-${track.id}-${idx}`}
                              onPointerDown={(e: ReactPointerEvent) => {
                                e.stopPropagation();
                                setSelectedClip({
                                  trackId: track.id,
                                  clipIndex: idx,
                                });
                                setClipDragState({
                                  mode: "trim_start",
                                  trackId: track.id,
                                  clipIndex: idx,
                                  initialClientX: Number.isFinite(e.clientX) ? e.clientX : 0,
                                  initialStartSec: clip.start_sec,
                                  initialDurationSec: clip.duration_sec,
                                  initialFadeInSec: clip.fade_in_sec,
                                  initialFadeOutSec: clip.fade_out_sec,
                                });
                              }}
                              title="Drag to trim clip start"
                              className="w-2 shrink-0 bg-ember/60 hover:bg-ember cursor-ew-resize z-10"
                            />

                            {/* Top-Left Fade-In Handle */}
                            <div
                              data-testid={`clip-fade-in-${track.id}-${idx}`}
                              onPointerDown={(e: ReactPointerEvent) => {
                                e.stopPropagation();
                                setSelectedClip({
                                  trackId: track.id,
                                  clipIndex: idx,
                                });
                                setClipDragState({
                                  mode: "fade_in",
                                  trackId: track.id,
                                  clipIndex: idx,
                                  initialClientX: Number.isFinite(e.clientX) ? e.clientX : 0,
                                  initialStartSec: clip.start_sec,
                                  initialDurationSec: clip.duration_sec,
                                  initialFadeInSec: clip.fade_in_sec,
                                  initialFadeOutSec: clip.fade_out_sec,
                                });
                              }}
                              title="Drag to adjust Fade In"
                              className="absolute top-0 left-2 w-2.5 h-2.5 bg-frost/80 hover:bg-ember rounded-br cursor-e-resize z-20"
                            />

                            {/* Draggable Clip Body */}
                            <div
                              data-testid={`clip-body-${track.id}-${idx}`}
                              onPointerDown={(e: ReactPointerEvent) => {
                                e.stopPropagation();
                                setSelectedClip({
                                  trackId: track.id,
                                  clipIndex: idx,
                                });
                                setClipDragState({
                                  mode: "move",
                                  trackId: track.id,
                                  clipIndex: idx,
                                  initialClientX: Number.isFinite(e.clientX) ? e.clientX : 0,
                                  initialStartSec: clip.start_sec,
                                  initialDurationSec: clip.duration_sec,
                                  initialFadeInSec: clip.fade_in_sec,
                                  initialFadeOutSec: clip.fade_out_sec,
                                });
                              }}
                              className="relative flex-1 min-w-0 px-1.5 py-0.5 flex flex-col justify-between cursor-grab active:cursor-grabbing z-10"
                            >
                              <div
                                className="h-1 w-full rounded-sm"
                                style={{
                                  background: colors
                                    ? `linear-gradient(90deg, ${colors[0]}, ${sampleOklabGradientHex(
                                        colors[0],
                                        colors[1],
                                        0.5,
                                      )}, ${colors[1]})`
                                    : "#2255AA",
                                }}
                              />
                              <div className="flex items-center justify-between gap-1 text-[10px] font-mono text-frost">
                                {(() => {
                                  const ownerScene = showState.scenes.find(
                                    (s) =>
                                      clip.ref_block &&
                                      s.block_refs.includes(clip.ref_block),
                                  );
                                  const clipBlock = clip.ref_block
                                    ? showState.fx_library.find(
                                        (b) => b.id === clip.ref_block,
                                      )
                                    : null;
                                  const mode = ownerScene
                                    ? classifySceneMode(
                                        ownerScene,
                                        showState.fx_library,
                                      )
                                    : clipBlock?.elements[0]?.trait === "color"
                                      ? clipBlock.elements[0].kind ===
                                        "static_trait"
                                        ? "color"
                                        : "color_anim"
                                      : "effect";
                                  const tag =
                                    mode === "color"
                                      ? "COLOR"
                                      : mode === "color_anim"
                                        ? "COLOR ANIM"
                                        : "EFFECT";
                                  const label =
                                    ownerScene?.name ??
                                    clipBlock?.name ??
                                    clip.ref_block ??
                                    "Inline";
                                  return (
                                    <span className="truncate">
                                      [{tag}] {label} (
                                      {clip.start_sec.toFixed(2)}s ·{" "}
                                      {clip.duration_sec.toFixed(2)}s)
                                    </span>
                                  );
                                })()}
                                <button
                                  type="button"
                                  aria-label={`Delete Clip ${idx + 1} on ${track.name}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleDeleteClip(track.id, idx);
                                  }}
                                  className="text-signal hover:text-frost shrink-0"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            </div>

                            {/* Top-Right Fade-Out Handle */}
                            <div
                              data-testid={`clip-fade-out-${track.id}-${idx}`}
                              onPointerDown={(e: ReactPointerEvent) => {
                                e.stopPropagation();
                                setSelectedClip({
                                  trackId: track.id,
                                  clipIndex: idx,
                                });
                                setClipDragState({
                                  mode: "fade_out",
                                  trackId: track.id,
                                  clipIndex: idx,
                                  initialClientX: Number.isFinite(e.clientX) ? e.clientX : 0,
                                  initialStartSec: clip.start_sec,
                                  initialDurationSec: clip.duration_sec,
                                  initialFadeInSec: clip.fade_in_sec,
                                  initialFadeOutSec: clip.fade_out_sec,
                                });
                              }}
                              title="Drag to adjust Fade Out"
                              className="absolute top-0 right-2 w-2.5 h-2.5 bg-frost/80 hover:bg-ember rounded-bl cursor-w-resize z-20"
                            />

                            {/* Right Trim Handle */}
                            <div
                              data-testid={`clip-trim-end-${track.id}-${idx}`}
                              onPointerDown={(e: ReactPointerEvent) => {
                                e.stopPropagation();
                                setSelectedClip({
                                  trackId: track.id,
                                  clipIndex: idx,
                                });
                                setClipDragState({
                                  mode: "trim_end",
                                  trackId: track.id,
                                  clipIndex: idx,
                                  initialClientX: Number.isFinite(e.clientX) ? e.clientX : 0,
                                  initialStartSec: clip.start_sec,
                                  initialDurationSec: clip.duration_sec,
                                  initialFadeInSec: clip.fade_in_sec,
                                  initialFadeOutSec: clip.fade_out_sec,
                                });
                              }}
                              title="Drag to trim clip end"
                              className="w-2 shrink-0 bg-ember/60 hover:bg-ember cursor-ew-resize z-10"
                            />
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* Bottom Split: Left = Selected Clip Inspector, Right = Add Track & Clip */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
            {/* Selected Clip Inspector (Live Move, Trim, Fade & FX Reassignment) */}
            <section
              data-testid="selected-clip-inspector"
              className="lg:col-span-6 bg-slate border border-steel rounded-panel p-3 flex flex-col gap-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-sans text-sm font-semibold text-frost">
                  Selected Clip Inspector
                </h3>
                {resolvedSelectedClip && (
                  <span className="font-mono text-xs text-ember">
                    {resolvedSelectedClip.track.name} • Clip #
                    {resolvedSelectedClip.clipIndex + 1}
                  </span>
                )}
              </div>

              {!resolvedSelectedClip ? (
                <p className="font-mono text-xs text-fog">
                  Click a clip on any track (or double-click a track lane) to move, trim, or fade it.
                </p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    <label className="flex flex-col gap-1 sm:col-span-2">
                      <span className="font-mono text-[10px] text-fog">
                        FX Block
                      </span>
                      <select
                        aria-label="Selected Clip Block Ref"
                        value={resolvedSelectedClip.clip.ref_block ?? ""}
                        onChange={(e) =>
                          updateClipInTrack(
                            resolvedSelectedClip.trackId,
                            resolvedSelectedClip.clipIndex,
                            (c) => ({
                              ...c,
                              ref_block: e.target.value || null,
                            }),
                          )
                        }
                        className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                      >
                        {showState.fx_library.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="font-mono text-[10px] text-fog">
                        Start (s)
                      </span>
                      <input
                        aria-label="Selected Clip Start Sec"
                        type="number"
                        min={0}
                        step={0.05}
                        value={resolvedSelectedClip.clip.start_sec}
                        onChange={(e) =>
                          updateClipInTrack(
                            resolvedSelectedClip.trackId,
                            resolvedSelectedClip.clipIndex,
                            (c) => ({
                              ...c,
                              start_sec: Math.max(
                                0,
                                Number(e.target.value) || 0,
                              ),
                            }),
                          )
                        }
                        className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                      />
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="font-mono text-[10px] text-fog">
                        Duration (s)
                      </span>
                      <input
                        aria-label="Selected Clip Duration Sec"
                        type="number"
                        min={0.1}
                        step={0.05}
                        value={resolvedSelectedClip.clip.duration_sec}
                        onChange={(e) =>
                          updateClipInTrack(
                            resolvedSelectedClip.trackId,
                            resolvedSelectedClip.clipIndex,
                            (c) => ({
                              ...c,
                              duration_sec: Math.max(
                                0.1,
                                Number(e.target.value) || 0.1,
                              ),
                            }),
                          )
                        }
                        className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
                      />
                    </label>

                    <div className="grid grid-cols-2 gap-1">
                      <label className="flex flex-col gap-1">
                        <span className="font-mono text-[10px] text-fog">
                          In(s)
                        </span>
                        <input
                          aria-label="Selected Clip Fade In Sec"
                          type="number"
                          min={0}
                          step={0.05}
                          value={resolvedSelectedClip.clip.fade_in_sec}
                          onChange={(e) =>
                            updateClipInTrack(
                              resolvedSelectedClip.trackId,
                              resolvedSelectedClip.clipIndex,
                              (c) => ({
                                ...c,
                                fade_in_sec: Math.max(
                                  0,
                                  Number(e.target.value) || 0,
                                ),
                              }),
                            )
                          }
                          className="bg-ink border border-steel rounded px-1.5 py-1 text-xs font-mono text-frost"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="font-mono text-[10px] text-fog">
                          Out(s)
                        </span>
                        <input
                          aria-label="Selected Clip Fade Out Sec"
                          type="number"
                          min={0}
                          step={0.05}
                          value={resolvedSelectedClip.clip.fade_out_sec}
                          onChange={(e) =>
                            updateClipInTrack(
                              resolvedSelectedClip.trackId,
                              resolvedSelectedClip.clipIndex,
                              (c) => ({
                                ...c,
                                fade_out_sec: Math.max(
                                  0,
                                  Number(e.target.value) || 0,
                                ),
                              }),
                            )
                          }
                          className="bg-ink border border-steel rounded px-1.5 py-1 text-xs font-mono text-frost"
                        />
                      </label>
                    </div>
                  </div>

                  {/* Quick Nudge & Trim Buttons */}
                  <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                    <span className="text-fog">Move:</span>
                    <button
                      type="button"
                      data-testid="nudge-clip-left-btn"
                      onClick={() =>
                        updateClipInTrack(
                          resolvedSelectedClip.trackId,
                          resolvedSelectedClip.clipIndex,
                          (c) => ({
                            ...c,
                            start_sec: Math.max(
                              0,
                              Number((c.start_sec - 0.25).toFixed(3)),
                            ),
                          }),
                        )
                      }
                      className="px-2 py-0.5 rounded bg-ink border border-steel text-mist hover:border-ember"
                    >
                      -0.25s
                    </button>
                    <button
                      type="button"
                      data-testid="nudge-clip-right-btn"
                      onClick={() =>
                        updateClipInTrack(
                          resolvedSelectedClip.trackId,
                          resolvedSelectedClip.clipIndex,
                          (c) => ({
                            ...c,
                            start_sec: Number((c.start_sec + 0.25).toFixed(3)),
                          }),
                        )
                      }
                      className="px-2 py-0.5 rounded bg-ink border border-steel text-mist hover:border-ember"
                    >
                      +0.25s
                    </button>

                    <span className="text-fog ml-2">Trim Length:</span>
                    <button
                      type="button"
                      data-testid="trim-clip-shorter-btn"
                      onClick={() =>
                        updateClipInTrack(
                          resolvedSelectedClip.trackId,
                          resolvedSelectedClip.clipIndex,
                          (c) => ({
                            ...c,
                            duration_sec: Math.max(
                              0.1,
                              Number((c.duration_sec - 0.5).toFixed(3)),
                            ),
                          }),
                        )
                      }
                      className="px-2 py-0.5 rounded bg-ink border border-steel text-mist hover:border-cobalt"
                    >
                      -0.5s
                    </button>
                    <button
                      type="button"
                      data-testid="trim-clip-longer-btn"
                      onClick={() =>
                        updateClipInTrack(
                          resolvedSelectedClip.trackId,
                          resolvedSelectedClip.clipIndex,
                          (c) => ({
                            ...c,
                            duration_sec: Number(
                              (c.duration_sec + 0.5).toFixed(3),
                            ),
                          }),
                        )
                      }
                      className="px-2 py-0.5 rounded bg-ink border border-steel text-mist hover:border-cobalt"
                    >
                      +0.5s
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* Add Track & Schedule Clip */}
            <section className="lg:col-span-6 bg-slate border border-steel rounded-panel p-3 flex flex-col gap-2.5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <div className="grid grid-cols-2 gap-1.5 bg-pitch border border-steel rounded p-2">
                  <label className="flex flex-col gap-0.5 col-span-2">
                    <span className="font-mono text-[10px] text-fog">
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

                  <label className="flex flex-col gap-0.5 col-span-2">
                    <span className="font-mono text-[10px] text-fog">
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
                    className="col-span-2 flex items-center justify-center gap-1 px-2.5 py-1 rounded bg-cobalt hover:bg-cobalt/90 font-sans text-xs font-semibold text-frost"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Track</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-1.5 bg-pitch border border-steel rounded p-2">
                  <label className="flex flex-col gap-0.5">
                    <span className="font-mono text-[10px] text-fog">Track</span>
                    <select
                      aria-label="Clip Track"
                      value={effectiveTrackId}
                      onChange={(e) => setClipTrackId(e.target.value)}
                      className="bg-ink border border-steel rounded px-1.5 py-1 text-xs font-mono text-frost"
                    >
                      {currentTimeline.tracks.map((tr) => (
                        <option key={tr.id} value={tr.id}>
                          {tr.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-0.5 col-span-2">
                    <span className="font-mono text-[10px] text-fog">
                      Scene (sets Effect / Color)
                    </span>
                    <select
                      aria-label="Timeline Drop Scene"
                      value={paletteSelectedSceneId}
                      onChange={(e) => {
                        const sid = e.target.value;
                        setPaletteSelectedSceneId(sid);
                        const sc = showState.scenes.find((s) => s.id === sid);
                        if (sc?.block_refs[0]) setClipBlockRef(sc.block_refs[0]);
                      }}
                      className="bg-ink border border-steel rounded px-1.5 py-1 text-xs font-sans text-frost"
                    >
                      {showState.scenes.map((sc) => (
                        <option key={sc.id} value={sc.id}>
                          {sc.name} ({sc.bank ?? "Overlay"})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-0.5">
                    <span className="font-mono text-[10px] text-fog">
                      FX Block
                    </span>
                    <select
                      aria-label="Clip Block Ref"
                      value={effectiveBlockRef}
                      onChange={(e) => setClipBlockRef(e.target.value)}
                      className="bg-ink border border-steel rounded px-1.5 py-1 text-xs font-mono text-frost"
                    >
                      {showState.fx_library.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-0.5">
                    <span className="font-mono text-[10px] text-fog">
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
                      className="bg-ink border border-steel rounded px-1.5 py-1 text-xs font-mono text-frost"
                    />
                  </label>

                  <label className="flex flex-col gap-0.5">
                    <span className="font-mono text-[10px] text-fog">
                      Dur (s)
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
                      className="bg-ink border border-steel rounded px-1.5 py-1 text-xs font-mono text-frost"
                    />
                  </label>

                  <label className="flex flex-col gap-0.5">
                    <span className="font-mono text-[10px] text-fog">
                      In (s)
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
                      className="bg-ink border border-steel rounded px-1.5 py-1 text-xs font-mono text-frost"
                    />
                  </label>

                  <label className="flex flex-col gap-0.5">
                    <span className="font-mono text-[10px] text-fog">
                      Out (s)
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
                      className="bg-ink border border-steel rounded px-1.5 py-1 text-xs font-mono text-frost"
                    />
                  </label>

                  <button
                    type="button"
                    onClick={() => void handleAddClip()}
                    className="col-span-2 flex items-center justify-center gap-1 px-2.5 py-1 rounded bg-ember hover:bg-burnt font-sans text-xs font-semibold text-frost"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Clip</span>
                  </button>
                </div>
              </div>
            </section>
          </div>
        </>
      )}

      {/* Live Cell Preview */}
      <details className="bg-slate border border-steel rounded-panel p-2.5">
        <summary className="cursor-pointer font-sans text-xs font-semibold text-fog hover:text-frost">
          Live Evaluated Cell Output ({compiledCells.length} cells)
        </summary>

        <div
          data-testid="timeline-live-cell-preview"
          className="mt-2 flex flex-wrap gap-1.5 bg-void border border-steel rounded p-2.5"
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
      </details>
    </div>
  );
}
