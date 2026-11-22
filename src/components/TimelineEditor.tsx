import {
  AudioWaveform,
  Clock,
  Copy,
  Magnet,
  Maximize2,
  Minimize2,
  MoveHorizontal,
  Music,
  Pause,
  Play,
  Redo2,
  Repeat,
  Scissors,
  SkipBack,
  Sparkles,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  decodeAudioFile,
  getDecodedAudioAsset,
  timelineAudioPlayer,
} from "../lib/audioEngine";
import {
  type AudioAnalysisResult,
  type ClipDef,
  computeBeatGridMarkers,
  sampleOklabGradientHex,
  snapTimeSecToMarkers,
  type TimelineDef,
  type TrackDef,
  type TrackType,
} from "../lib/mixerLogic";
import {
  applySingleTrackOverwrite,
  clampTrimEndNonOverlapping,
  clampTrimStartNonOverlapping,
  computeEffectCycleBoundaries,
  computeSnapGridMarkers,
  computeTimelineContentDurationSec,
  computeTimelineViewportDurationSec,
  computeZoomAdaptiveRulerTicks,
  secToGridBeats,
  type SnapGridSubdivision,
} from "../lib/timelineLogic";
import { useTaktStore } from "../store/useTaktStore";
import { classifySceneMode } from "./SceneAndFxManager";

type DragMode =
  | "move"
  | "duplicate_move"
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
  naturalCycleSec?: number;
}

function ClipWaveformCanvas({
  audioFile,
  analysis,
  clipDurationSec,
  clipWidthPx,
  showTransients,
  testId,
}: {
  audioFile: string;
  analysis?: AudioAnalysisResult;
  clipDurationSec: number;
  clipWidthPx: number;
  showTransients: boolean;
  testId: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    const dpr =
      typeof window !== "undefined"
        ? Math.min(2, window.devicePixelRatio || 1)
        : 1;
    const cssW = Math.max(32, Math.round(clipWidthPx));
    const cssH = 48;
    const maxBackingW = 8192;
    const scaleX = Math.min(dpr, maxBackingW / cssW);
    const backingW = Math.max(32, Math.round(cssW * scaleX));
    const backingH = Math.round(cssH * dpr);

    if (canvas.width !== backingW) canvas.width = backingW;
    if (canvas.height !== backingH) canvas.height = backingH;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, backingW, backingH);

    const midY = backingH / 2;
    const halfH = backingH * 0.44;

    // Subtle center zero-crossing line
    ctx.fillStyle = "rgba(148, 163, 184, 0.22)";
    ctx.fillRect(0, Math.round(midY), backingW, Math.max(1, Math.round(dpr * 0.5)));

    const asset = getDecodedAudioAsset(audioFile);
    const monoPcm = asset?.monoPcm;

    if (monoPcm && monoPcm.length > 0 && asset.sampleRate > 0) {
      // Sample directly from decoded PCM at exact backing-pixel resolution (razor-sharp at any zoom!)
      const visibleSamples = Math.min(
        monoPcm.length,
        Math.max(1, Math.round(clipDurationSec * asset.sampleRate)),
      );
      const samplesPerCol = visibleSamples / backingW;

      // Outer peak envelope (min..max)
      ctx.fillStyle = "rgba(56, 189, 248, 0.48)";
      // Inner RMS energy body
      const rmsBars: Array<[number, number, number]> = [];

      for (let x = 0; x < backingW; x++) {
        const sStart = Math.floor(x * samplesPerCol);
        const sEnd = Math.min(
          visibleSamples,
          Math.max(sStart + 1, Math.floor((x + 1) * samplesPerCol)),
        );
        const stride = Math.max(1, Math.floor((sEnd - sStart) / 64));
        let min = 1;
        let max = -1;
        let sumSq = 0;
        let count = 0;
        for (let i = sStart; i < sEnd; i += stride) {
          const s = monoPcm[i];
          if (s < min) min = s;
          if (s > max) max = s;
          sumSq += s * s;
          count += 1;
        }
        if (count === 0) continue;
        const yTop = Math.floor(midY - Math.max(0, max) * halfH);
        const yBot = Math.ceil(midY - Math.min(0, min) * halfH);
        const h = Math.max(1, yBot - yTop);
        ctx.fillRect(x, yTop, 1, h);

        const rms = Math.sqrt(sumSq / count);
        const rmsH = Math.max(1, Math.round(rms * halfH * 2));
        rmsBars.push([x, Math.round(midY - rmsH / 2), rmsH]);
      }

      ctx.fillStyle = "rgba(125, 211, 252, 0.85)";
      for (const [x, y, h] of rmsBars) {
        ctx.fillRect(x, y, 1, h);
      }
    } else if (analysis && analysis.waveform_peaks.length > 0) {
      const peaks = analysis.waveform_peaks;
      const assetDur = Math.max(0.05, analysis.duration_sec || clipDurationSec);
      const visibleFrac = Math.min(1, clipDurationSec / assetDur);
      const visibleCount = Math.max(1, Math.floor(peaks.length * visibleFrac));

      ctx.fillStyle = "rgba(56, 189, 248, 0.65)";
      for (let x = 0; x < backingW; x++) {
        const pIdx = Math.min(
          visibleCount - 1,
          Math.floor((x / backingW) * visibleCount),
        );
        const pk = peaks[pIdx];
        if (!pk) continue;
        const yTop = Math.floor(midY - Math.max(0, pk.max) * halfH);
        const yBot = Math.ceil(midY - Math.min(0, pk.min) * halfH);
        ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
      }
    }

    // Crisp color-coded transient tick markers (Amber = Kick, Cyan = Snare)
    if (showTransients && analysis && analysis.transients.length > 0) {
      const pipH = Math.max(4, Math.round(backingH * 0.24));
      for (const m of analysis.transients) {
        if (m.time_sec > clipDurationSec) continue;
        const x = Math.round(
          (m.time_sec / Math.max(0.05, clipDurationSec)) * backingW,
        );
        if (m.band === "kick") {
          ctx.fillStyle = "rgba(245, 158, 11, 0.95)";
          ctx.fillRect(x, 0, Math.max(1, Math.round(scaleX)), pipH);
          ctx.fillRect(
            x,
            backingH - pipH,
            Math.max(1, Math.round(scaleX)),
            pipH,
          );
        } else {
          ctx.fillStyle = "rgba(34, 211, 238, 0.65)";
          ctx.fillRect(
            x,
            backingH - Math.round(pipH * 0.65),
            1,
            Math.round(pipH * 0.65),
          );
        }
      }
    }
  }, [audioFile, analysis, clipDurationSec, clipWidthPx, showTransients]);

  return (
    <canvas
      ref={canvasRef}
      data-testid={testId}
      className="pointer-events-none absolute inset-0 w-full h-full"
    />
  );
}

export function TimelineEditor({
  hideUndoRedo = false,
  timelineId,
  expanded = false,
  onToggleExpand,
}: {
  hideUndoRedo?: boolean;
  timelineId?: string;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const showState = useTaktStore((s) => s.showState);
  const activeTimelineId = useTaktStore((s) => s.activeTimelineId);
  const timelinePlaying = useTaktStore((s) => s.timelinePlaying);
  const timelinePlayheadSec = useTaktStore((s) => s.timelinePlayheadSec);
  const timelinePlayheadAnchorMs = useTaktStore(
    (s) => s.timelinePlayheadAnchorMs,
  );
  const audioAnalysisByClipKey = useTaktStore((s) => s.audioAnalysisByClipKey);
  const audioAnalysisByTimeline = useTaktStore(
    (s) => s.audioAnalysisByTimeline,
  );
  const selectedClip = useTaktStore((s) => s.selectedTimelineClip);
  const setSelectedClip = useTaktStore((s) => s.setSelectedTimelineClip);
  const timeUnit = useTaktStore((s) => s.timelineTimeUnit);
  const setTimeUnit = useTaktStore((s) => s.setTimelineTimeUnit);
  const sensitivity = useTaktStore((s) => s.timelineSensitivity);
  const showTransients = useTaktStore((s) => s.timelineShowTransients);
  const projectTransients = useTaktStore((s) => s.timelineProjectTransients);
  const canUndo = useTaktStore((s) => s.canUndo);
  const canRedo = useTaktStore((s) => s.canRedo);

  const upsertTimeline = useTaktStore((s) => s.upsertTimeline);
  const upsertFxBlock = useTaktStore((s) => s.upsertFxBlock);
  const upsertScene = useTaktStore((s) => s.upsertScene);
  const setTimelineTransport = useTaktStore((s) => s.setTimelineTransport);
  const setClipAudioAnalysis = useTaktStore((s) => s.setClipAudioAnalysis);
  const releaseScene = useTaktStore((s) => s.releaseScene);
  const undoShow = useTaktStore((s) => s.undoShow);
  const redoShow = useTaktStore((s) => s.redoShow);
  const draggingSceneId = useTaktStore((s) => s.draggingSceneId);
  const setDraggingSceneId = useTaktStore((s) => s.setDraggingSceneId);

  const [magneticSnap, setMagneticSnap] = useState(true);
  const [snapGrid, setSnapGrid] = useState<SnapGridSubdivision>("beat");
  const [stretchToolActive, setStretchToolActive] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(1.0);
  const [clipDragState, setClipDragState] = useState<ClipDragState | null>(
    null,
  );
  const [isFileDragOver, setIsFileDragOver] = useState(false);

  const [clipDurationSec] = useState(4.0);
  const [paletteSelectedSceneId, setPaletteSelectedSceneId] = useState(
    showState.scenes[0]?.id ?? "",
  );
  const [timelineNotice, setTimelineNotice] = useState<string | null>(null);
  const [trackContextMenu, setTrackContextMenu] = useState<{
    trackId: string;
    x: number;
    y: number;
  } | null>(null);
  const [displayPlayheadSec, setDisplayPlayheadSec] = useState(
    timelinePlayheadSec,
  );

  const musicInputRef = useRef<HTMLInputElement | null>(null);
  const lanesScrollRef = useRef<HTMLDivElement | null>(null);
  const lanesViewportRef = useRef<HTMLDivElement | null>(null);
  const localClipOverrideRef = useRef<{
    trackId: string;
    clipIndex: number;
    targetTrackId?: string;
    isDuplicate?: boolean;
    patch: Partial<ClipDef>;
  } | null>(null);
  // Hold optimistic clip override until store commits (prevents drop flicker!)
  const pendingCommitTimelineRef = useRef<TimelineDef | null>(null);
  const dragRafRef = useRef<number | null>(null);
  const scrubLastIpcMsRef = useRef<number>(0);
  const scrubLatestSecRef = useRef<number | null>(null);
  const audioPlayingStateRef = useRef<{
    playing: boolean;
    timelineId: string | null;
    anchorHeadSec: number;
    anchorMs: number;
  }>({ playing: false, timelineId: null, anchorHeadSec: 0, anchorMs: 0 });
  const [, setClipDragTick] = useState(0);

  const currentTimeline: TimelineDef | null = useMemo(() => {
    const preferredId = timelineId ?? activeTimelineId;
    if (preferredId) {
      const found = showState.timelines.find((t) => t.id === preferredId);
      if (found) return found;
    }
    return showState.timelines[0] ?? null;
  }, [timelineId, activeTimelineId, showState.timelines]);

  // Clear pending optimistic override once store commits the new timeline reference
  useEffect(() => {
    if (
      pendingCommitTimelineRef.current &&
      currentTimeline &&
      currentTimeline !== pendingCommitTimelineRef.current
    ) {
      pendingCommitTimelineRef.current = null;
      localClipOverrideRef.current = null;
      setClipDragTick((t) => t + 1);
    }
  }, [currentTimeline]);

  // Dynamic infinite-canvas duration
  const contentDurationSec = useMemo(
    () =>
      currentTimeline
        ? computeTimelineContentDurationSec(currentTimeline.tracks)
        : 0,
    [currentTimeline],
  );
  const viewportDurationSec = useMemo(
    () =>
      currentTimeline
        ? computeTimelineViewportDurationSec(currentTimeline.tracks, 32, 8)
        : 32,
    [currentTimeline],
  );
  const pxPerSec = 24 * timelineZoom;
  const viewportWidthPx = Math.max(640, Math.round(viewportDurationSec * pxPerSec));

  const effectiveBpm =
    currentTimeline?.tempo_map[0]?.bpm ?? (showState.bpm > 0 ? showState.bpm : 120);
  const gridOffsetSec = currentTimeline?.grid_offset_sec ?? 0;
  const secToBeats = useCallback(
    (sec: number) => secToGridBeats(sec, effectiveBpm, gridOffsetSec),
    [effectiveBpm, gridOffsetSec],
  );

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

  // Smooth 60fps playhead interpolation + auto-follow scroll
  useEffect(() => {
    if (
      !timelinePlaying ||
      !currentTimeline ||
      activeTimelineId !== currentTimeline.id
    ) {
      if (clipDragState?.mode !== "scrub") {
        setDisplayPlayheadSec(timelinePlayheadSec);
      }
      return;
    }

    let rafId: number | null = null;
    const step = () => {
      const nowMs =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      const elapsed = Math.max(0, (nowMs - timelinePlayheadAnchorMs) / 1000);
      const rawHead = timelinePlayheadSec + elapsed;

      if (contentDurationSec > 0 && rawHead >= contentDurationSec) {
        if (currentTimeline.loop_timeline) {
          const wrapped = rawHead % contentDurationSec;
          setDisplayPlayheadSec(wrapped);
          void setTimelineTransport(currentTimeline.id, true, wrapped);
          return;
        } else {
          setDisplayPlayheadSec(contentDurationSec);
          void setTimelineTransport(currentTimeline.id, false, contentDurationSec);
          const ownerScene = showState.scenes.find(
            (s) => s.timeline_ref === currentTimeline.id,
          );
          if (ownerScene) {
            void releaseScene(ownerScene.id);
          }
          return;
        }
      }

      setDisplayPlayheadSec(rawHead);

      // Auto-follow playhead so it stays inside the scrollable viewport
      const scroller = lanesScrollRef.current;
      if (scroller && scroller.clientWidth > 50) {
        const headX = (rawHead / Math.max(0.1, viewportDurationSec)) * viewportWidthPx;
        const leftEdge = scroller.scrollLeft;
        const rightEdge = leftEdge + scroller.clientWidth;
        const margin = Math.min(80, scroller.clientWidth * 0.15);
        if (headX > rightEdge - margin || headX < leftEdge) {
          scroller.scrollLeft = Math.max(0, headX - scroller.clientWidth * 0.25);
        }
      }

      if (typeof requestAnimationFrame === "function") {
        rafId = requestAnimationFrame(step);
      }
    };

    if (typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(step);
    } else {
      setDisplayPlayheadSec(timelinePlayheadSec);
    }

    return () => {
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
    };
  }, [
    activeTimelineId,
    clipDragState?.mode,
    contentDurationSec,
    currentTimeline,
    releaseScene,
    setTimelineTransport,
    showState.scenes,
    timelinePlayheadAnchorMs,
    timelinePlayheadSec,
    timelinePlaying,
    viewportDurationSec,
    viewportWidthPx,
  ]);

  // Sync Web Audio playback without double-start jitter:
  // only restart when play-state transitions, timeline changes, or playhead jumps > 150ms
  useEffect(() => {
    const prev = audioPlayingStateRef.current;
    const nowMs =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const shouldPlay = Boolean(
      currentTimeline && timelinePlaying && activeTimelineId === currentTimeline.id,
    );

    if (!shouldPlay || !currentTimeline) {
      if (prev.playing) {
        timelineAudioPlayer.stop();
      }
      audioPlayingStateRef.current = {
        playing: false,
        timelineId: currentTimeline?.id ?? null,
        anchorHeadSec: timelinePlayheadSec,
        anchorMs: nowMs,
      };
      return;
    }

    const predictedSec = prev.playing
      ? prev.anchorHeadSec + Math.max(0, (nowMs - prev.anchorMs) / 1000)
      : -1;
    const drift = Math.abs(predictedSec - timelinePlayheadSec);

    if (
      !prev.playing ||
      prev.timelineId !== currentTimeline.id ||
      drift > 0.15
    ) {
      timelineAudioPlayer.startFrom(timelinePlayheadSec, currentTimeline.tracks);
      audioPlayingStateRef.current = {
        playing: true,
        timelineId: currentTimeline.id,
        anchorHeadSec: timelinePlayheadSec,
        anchorMs: nowMs,
      };
    }
  }, [
    activeTimelineId,
    currentTimeline,
    timelinePlayheadSec,
    timelinePlaying,
  ]);

  useEffect(() => {
    return () => {
      timelineAudioPlayer.stop();
    };
  }, []);

  const effectiveBlockRef = useMemo(() => {
    if (resolvedSelectedClip?.clip.ref_block) {
      return resolvedSelectedClip.clip.ref_block;
    }
    const nonTlScene = showState.scenes.find(
      (s) => !s.timeline_ref && s.block_refs.length > 0,
    );
    return nonTlScene?.block_refs[0] ?? showState.fx_library[0]?.id ?? "";
  }, [resolvedSelectedClip, showState.fx_library, showState.scenes]);

  // Collect transients across music clips on this timeline (shifted by clip start_sec)
  const timelineTransients = useMemo(() => {
    if (!currentTimeline) return [];
    const markers: Array<{ time_sec: number; band: "kick" | "snare"; strength: number }> = [];
    for (const trk of currentTimeline.tracks) {
      for (const clip of trk.clips) {
        if (!clip.audio_file) continue;
        const clipAnalysis = audioAnalysisByClipKey[clip.audio_file];
        if (!clipAnalysis) continue;
        for (const m of clipAnalysis.transients) {
          if (m.time_sec <= clip.duration_sec) {
            markers.push({
              time_sec: Number((clip.start_sec + m.time_sec).toFixed(3)),
              band: m.band,
              strength: m.strength,
            });
          }
        }
      }
    }
    if (markers.length === 0) {
      const fallback = audioAnalysisByTimeline[currentTimeline.id];
      if (fallback) return fallback.transients;
    }
    return markers.sort((a, b) => a.time_sec - b.time_sec);
  }, [audioAnalysisByClipKey, audioAnalysisByTimeline, currentTimeline]);

  const beatGridMarkers = useMemo(() => {
    if (!currentTimeline) return [];
    return computeBeatGridMarkers({
      durationSec: viewportDurationSec,
      gridOffsetSec: currentTimeline.grid_offset_sec,
      tempoMap: currentTimeline.tempo_map,
      defaultBpm: showState.bpm || 120,
    });
  }, [currentTimeline, showState.bpm, viewportDurationSec]);

  const snapMarkers = useMemo(() => {
    const gridTargets = computeSnapGridMarkers(
      viewportDurationSec,
      effectiveBpm,
      gridOffsetSec,
      snapGrid,
    );
    const transientTimes = projectTransients
      ? timelineTransients.map((m) => m.time_sec)
      : [];
    const clipEdges: number[] = [];
    if (currentTimeline) {
      for (const trk of currentTimeline.tracks) {
        for (const c of trk.clips) {
          clipEdges.push(c.start_sec, c.start_sec + c.duration_sec);
        }
      }
    }
    return [...gridTargets, ...clipEdges, ...transientTimes];
  }, [
    currentTimeline,
    effectiveBpm,
    gridOffsetSec,
    projectTransients,
    snapGrid,
    timelineTransients,
    viewportDurationSec,
  ]);

  useEffect(() => {
    if (!trackContextMenu) return;
    const close = () => setTrackContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [trackContextMenu]);

  const getClipNaturalCycleSec = useCallback(
    (clip: ClipDef): number => {
      if (!clip.ref_block) return 0;
      const blk = showState.fx_library.find((b) => b.id === clip.ref_block);
      if (!blk) return 0;
      if (blk.duration_sec && blk.duration_sec > 0.05) return blk.duration_sec;
      return ((blk.duration_beats || 4) * 60) / Math.max(20, effectiveBpm);
    },
    [effectiveBpm, showState.fx_library],
  );

  const getClipEffectiveCycleSec = useCallback(
    (clip: ClipDef): number => {
      const nat = getClipNaturalCycleSec(clip);
      if (nat <= 0.05) return 0;
      if (
        clip.time_stretch &&
        clip.source_duration_sec &&
        clip.source_duration_sec > 1e-6 &&
        clip.duration_sec > 1e-6
      ) {
        const phaseScale = Math.max(
          0.01,
          clip.source_duration_sec / clip.duration_sec,
        );
        return nat / phaseScale;
      }
      return nat;
    },
    [getClipNaturalCycleSec],
  );

  const saveTimelineTracks = useCallback(
    async (
      nextTracks: TrackDef[],
      coalesceKey?: string,
      extraPatch?: Partial<TimelineDef>,
    ) => {
      if (!currentTimeline) return;
      const nextContentDur = computeTimelineContentDurationSec(nextTracks);
      await upsertTimeline(
        {
          ...currentTimeline,
          ...extraPatch,
          duration_sec: Math.max(32, nextContentDur),
          tracks: nextTracks,
        },
        coalesceKey,
      );
    },
    [currentTimeline, upsertTimeline],
  );

  const commitClipUpdate = useCallback(
    (
      trackId: string,
      clipIndex: number,
      updater: (clip: ClipDef) => ClipDef,
      coalesceKey?: string,
      targetTrackId?: string,
      isDuplicate = false,
    ) => {
      if (!currentTimeline) return;
      pendingCommitTimelineRef.current = currentTimeline;

      if (targetTrackId === "__new__") {
        const srcTrack = currentTimeline.tracks.find((t) => t.id === trackId);
        const srcClip = srcTrack?.clips[clipIndex];
        if (!srcTrack || !srcClip) return;
        const clipType: TrackType = srcClip.audio_file ? "music" : "effect";
        const movedClip = updater(srcClip);
        const safeStart = Math.max(0, Number(movedClip.start_sec.toFixed(3)));
        const newTrackId = `trk_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const newTrack: TrackDef = {
          id: newTrackId,
          name:
            clipType === "music"
              ? `Music ${currentTimeline.tracks.length + 1}`
              : `Track ${currentTimeline.tracks.length + 1}`,
          track_type: clipType,
          target_group: clipType === "music" ? null : "all",
          clips: [{ ...movedClip, start_sec: safeStart }],
        };
        const nextTracks = [
          ...currentTimeline.tracks.map((tr) =>
            tr.id === trackId && !isDuplicate
              ? { ...tr, clips: tr.clips.filter((_, idx) => idx !== clipIndex) }
              : tr,
          ),
          newTrack,
        ];
        void saveTimelineTracks(nextTracks, coalesceKey);
        setSelectedClip({ trackId: newTrackId, clipIndex: 0 });
        return;
      }

      if (targetTrackId && targetTrackId !== trackId) {
        const srcTrack = currentTimeline.tracks.find((t) => t.id === trackId);
        const dstTrack = currentTimeline.tracks.find((t) => t.id === targetTrackId);
        const srcClip = srcTrack?.clips[clipIndex];
        if (!srcTrack || !dstTrack || !srcClip) return;
        const clipType: TrackType = srcClip.audio_file ? "music" : "effect";
        const dstType: TrackType = dstTrack.track_type ?? "untyped";
        if (dstType !== "untyped" && dstType !== clipType) {
          setTimelineNotice(`Cannot move ${clipType} clip onto a ${dstType} track.`);
          pendingCommitTimelineRef.current = null;
          localClipOverrideRef.current = null;
          return;
        }
        const rawMoved = updater(srcClip);
        const { clips: overwrittenDst, insertedIndex } = applySingleTrackOverwrite(
          { ...rawMoved, start_sec: Math.max(0, rawMoved.start_sec) },
          dstTrack.clips,
        );
        const nextTracks = currentTimeline.tracks.map((tr) => {
          if (tr.id === trackId && !isDuplicate) {
            return { ...tr, clips: tr.clips.filter((_, idx) => idx !== clipIndex) };
          }
          if (tr.id === targetTrackId) {
            return {
              ...tr,
              track_type: dstType === "untyped" ? clipType : dstType,
              clips: overwrittenDst,
            };
          }
          return tr;
        });
        void saveTimelineTracks(nextTracks, coalesceKey);
        setSelectedClip({
          trackId: targetTrackId,
          clipIndex: insertedIndex,
        });
        return;
      }

      const srcTrack = currentTimeline.tracks.find((t) => t.id === trackId);
      const srcClip = srcTrack?.clips[clipIndex];
      if (!srcTrack || !srcClip) return;
      const otherClips = isDuplicate
        ? srcTrack.clips
        : srcTrack.clips.filter((_, idx) => idx !== clipIndex);
      const rawUpdated = updater(srcClip);
      const nextClip: ClipDef = {
        ...rawUpdated,
        start_sec: Math.max(0, rawUpdated.start_sec),
        duration_sec: Math.max(0.1, rawUpdated.duration_sec),
      };

      const startChanged = Math.abs(nextClip.start_sec - srcClip.start_sec) > 1e-4;
      const durChanged = Math.abs(nextClip.duration_sec - srcClip.duration_sec) > 1e-4;

      let nextTrackClips: ClipDef[];
      let nextSelectedIdx = clipIndex;

      if (isDuplicate || (startChanged && !durChanged)) {
        const { clips, insertedIndex } = applySingleTrackOverwrite(
          nextClip,
          otherClips,
        );
        nextTrackClips = clips;
        nextSelectedIdx = insertedIndex;
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
        const trimmed: ClipDef = {
          ...nextClip,
          duration_sec: safeDur,
          fade_in_sec: Math.min(nextClip.fade_in_sec, safeDur * 0.5),
          fade_out_sec: Math.min(nextClip.fade_out_sec, safeDur * 0.5),
        };
        nextTrackClips = srcTrack.clips.map((c, idx) =>
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
        nextTrackClips = srcTrack.clips.map((c, idx) =>
          idx === clipIndex ? trimmed : c,
        );
      } else {
        nextTrackClips = srcTrack.clips.map((c, idx) =>
          idx === clipIndex ? nextClip : c,
        );
      }

      const nextTracks = currentTimeline.tracks.map((tr) =>
        tr.id === trackId ? { ...tr, clips: nextTrackClips } : tr,
      );
      void saveTimelineTracks(nextTracks, coalesceKey);
      setSelectedClip({ trackId, clipIndex: nextSelectedIdx });
    },
    [currentTimeline, saveTimelineTracks, setSelectedClip],
  );

  // Global pointer drag handler (move, duplicate_move, trim_start, trim_end, fade_in, fade_out, scrub)
  useEffect(() => {
    if (!clipDragState || !currentTimeline) return;

    const getViewportWidth = () => {
      const rect = lanesViewportRef.current?.getBoundingClientRect();
      return rect && rect.width > 10 ? rect.width : viewportWidthPx;
    };

    let committed = false;

    const onPointerMove = (e: PointerEvent | globalThis.MouseEvent) => {
      if (committed) return;
      if (
        !Number.isFinite(e.clientX) ||
        !Number.isFinite(clipDragState.initialClientX)
      ) {
        return;
      }
      const vw = getViewportWidth();
      const dxSec =
        ((e.clientX - clipDragState.initialClientX) / vw) * viewportDurationSec;

      if (clipDragState.mode === "scrub") {
        const rect = lanesViewportRef.current?.getBoundingClientRect();
        const left = rect?.left ?? 0;
        const frac = Math.max(0, Math.min(1, (e.clientX - left) / vw));
        const rawSec = frac * viewportDurationSec;
        const sec = magneticSnap
          ? snapTimeSecToMarkers(rawSec, snapMarkers, 0.12)
          : Number(rawSec.toFixed(3));
        // Instant local update + throttled backend IPC (eliminates scrub lag!)
        setDisplayPlayheadSec(sec);
        scrubLatestSecRef.current = sec;
        const nowMs =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        if (nowMs - scrubLastIpcMsRef.current >= 35) {
          scrubLastIpcMsRef.current = nowMs;
          void setTimelineTransport(currentTimeline.id, timelinePlaying, sec);
        }
        return;
      }

      const { trackId, clipIndex } = clipDragState;
      if (!trackId || clipIndex === undefined) return;

      const scheduleClipOverride = (
        patch: Partial<ClipDef>,
        targetTrackId?: string,
        isDuplicate = false,
      ) => {
        localClipOverrideRef.current = {
          trackId,
          clipIndex,
          targetTrackId,
          isDuplicate,
          patch,
        };
        if (dragRafRef.current !== null) return;
        dragRafRef.current = requestAnimationFrame(() => {
          dragRafRef.current = null;
          setClipDragTick((t) => t + 1);
        });
      };

      if (
        clipDragState.mode === "move" ||
        clipDragState.mode === "duplicate_move"
      ) {
        const isDuplicate = clipDragState.mode === "duplicate_move";
        const rawStart = Math.max(0, clipDragState.initialStartSec + dxSec);
        const snappedStart = magneticSnap
          ? snapTimeSecToMarkers(rawStart, snapMarkers, 0.15)
          : Number(rawStart.toFixed(3));

        let hoveredTrackId = trackId;
        if (Number.isFinite(e.clientY)) {
          const laneEls = document.querySelectorAll<HTMLElement>(
            "[data-track-lane-id]",
          );
          laneEls.forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.height > 1 && e.clientY >= r.top && e.clientY <= r.bottom) {
              const tid = el.getAttribute("data-track-lane-id");
              if (tid) hoveredTrackId = tid;
            }
          });
          const newTrackZone = document.querySelector<HTMLElement>(
            '[data-testid="timeline-new-track-dropzone"]',
          );
          if (newTrackZone) {
            const zr = newTrackZone.getBoundingClientRect();
            if (zr.height > 1 && e.clientY >= zr.top && e.clientY <= zr.bottom + 40) {
              hoveredTrackId = "__new__";
            }
          }
        }

        let resolvedTarget = hoveredTrackId;
        if (hoveredTrackId !== "__new__") {
          const srcTrk = currentTimeline.tracks.find((t) => t.id === trackId);
          const srcClip = srcTrk?.clips[clipIndex];
          const clipType: TrackType = srcClip?.audio_file ? "music" : "effect";
          const targetTrk = currentTimeline.tracks.find(
            (t) => t.id === hoveredTrackId,
          );
          const dstType: TrackType = targetTrk?.track_type ?? "untyped";
          if (dstType !== "untyped" && dstType !== clipType) {
            resolvedTarget = trackId;
          }
        }

        scheduleClipOverride(
          { start_sec: Math.max(0, snappedStart) },
          resolvedTarget,
          isDuplicate,
        );
      } else if (clipDragState.mode === "trim_start") {
        const origEnd =
          clipDragState.initialStartSec + clipDragState.initialDurationSec;
        const srcTrk = currentTimeline.tracks.find((t) => t.id === trackId);
        const srcClip = srcTrk?.clips[clipIndex];
        const otherClips = srcTrk
          ? srcTrk.clips.filter((_, idx) => idx !== clipIndex)
          : [];
        const rawStart = Math.max(
          0,
          Math.min(origEnd - 0.1, clipDragState.initialStartSec + dxSec),
        );
        const snappedStart = magneticSnap
          ? snapTimeSecToMarkers(rawStart, snapMarkers, 0.15)
          : Number(rawStart.toFixed(6));
        const safeStart = clampTrimStartNonOverlapping(
          snappedStart,
          origEnd,
          otherClips,
        );
        const nextDur = Number(Math.max(0.1, origEnd - safeStart).toFixed(6));
        const isFxClip = Boolean(srcClip && !srcClip.audio_file);
        const prevCycleSec =
          clipDragState.naturalCycleSec || clipDragState.initialDurationSec;
        const baseNatSec = srcClip ? getClipNaturalCycleSec(srcClip) : prevCycleSec;
        let stretchPatch: Partial<ClipDef> = {};
        if (isFxClip && stretchToolActive && baseNatSec > 0.05) {
          // Rate-Stretch: scale cycle length proportionally with dragged clip length
          const stretchedCycle =
            prevCycleSec * (nextDur / Math.max(0.05, clipDragState.initialDurationSec));
          const phaseScale = baseNatSec / Math.max(0.05, stretchedCycle);
          stretchPatch = {
            time_stretch: true,
            source_duration_sec: Number((nextDur * phaseScale).toFixed(6)),
          };
        } else if (
          isFxClip &&
          srcClip?.time_stretch &&
          srcClip.source_duration_sec &&
          clipDragState.initialDurationSec > 0.05
        ) {
          // Normal Trim on a stretched clip: preserve stretched speed & loop cleanly
          const preservedPhaseScale =
            srcClip.source_duration_sec / clipDragState.initialDurationSec;
          stretchPatch = {
            time_stretch: true,
            source_duration_sec: Number((nextDur * preservedPhaseScale).toFixed(6)),
          };
        }
        scheduleClipOverride({
          start_sec: safeStart,
          duration_sec: nextDur,
          fade_in_sec: Math.min(clipDragState.initialFadeInSec, nextDur * 0.5),
          fade_out_sec: Math.min(clipDragState.initialFadeOutSec, nextDur * 0.5),
          ...stretchPatch,
        });
      } else if (clipDragState.mode === "trim_end") {
        const srcTrk = currentTimeline.tracks.find((t) => t.id === trackId);
        const srcClip = srcTrk?.clips[clipIndex];
        const otherClips = srcTrk
          ? srcTrk.clips.filter((_, idx) => idx !== clipIndex)
          : [];
        const rawEnd = Math.max(
          clipDragState.initialStartSec + 0.1,
          clipDragState.initialStartSec +
            clipDragState.initialDurationSec +
            dxSec,
        );
        const snappedEnd = magneticSnap
          ? snapTimeSecToMarkers(rawEnd, snapMarkers, 0.15)
          : Number(rawEnd.toFixed(6));
        const clampedEnd = clampTrimEndNonOverlapping(
          clipDragState.initialStartSec,
          snappedEnd,
          otherClips,
          Number.POSITIVE_INFINITY,
        );
        const nextDur = Number(
          Math.max(0.1, clampedEnd - clipDragState.initialStartSec).toFixed(6),
        );
        const isFxClip = Boolean(srcClip && !srcClip.audio_file);
        const prevCycleSec =
          clipDragState.naturalCycleSec || clipDragState.initialDurationSec;
        const baseNatSec = srcClip ? getClipNaturalCycleSec(srcClip) : prevCycleSec;
        let stretchPatch: Partial<ClipDef> = {};
        if (isFxClip && stretchToolActive && baseNatSec > 0.05) {
          // Rate-Stretch: scale cycle length proportionally with dragged clip length
          const stretchedCycle =
            prevCycleSec * (nextDur / Math.max(0.05, clipDragState.initialDurationSec));
          const phaseScale = baseNatSec / Math.max(0.05, stretchedCycle);
          stretchPatch = {
            time_stretch: true,
            source_duration_sec: Number((nextDur * phaseScale).toFixed(6)),
          };
        } else if (
          isFxClip &&
          srcClip?.time_stretch &&
          srcClip.source_duration_sec &&
          clipDragState.initialDurationSec > 0.05
        ) {
          // Normal Trim on a stretched clip: preserve stretched speed & loop cleanly
          const preservedPhaseScale =
            srcClip.source_duration_sec / clipDragState.initialDurationSec;
          stretchPatch = {
            time_stretch: true,
            source_duration_sec: Number((nextDur * preservedPhaseScale).toFixed(6)),
          };
        }
        scheduleClipOverride({
          duration_sec: nextDur,
          fade_in_sec: Math.min(clipDragState.initialFadeInSec, nextDur * 0.5),
          fade_out_sec: Math.min(clipDragState.initialFadeOutSec, nextDur * 0.5),
          ...stretchPatch,
        });
      } else if (clipDragState.mode === "fade_in") {
        const maxFade = Math.max(0, clipDragState.initialDurationSec - 0.05);
        const nextFade = Number(
          Math.max(
            0,
            Math.min(maxFade, clipDragState.initialFadeInSec + dxSec),
          ).toFixed(2),
        );
        scheduleClipOverride({ fade_in_sec: nextFade });
      } else if (clipDragState.mode === "fade_out") {
        const maxFade = Math.max(0, clipDragState.initialDurationSec - 0.05);
        const nextFade = Number(
          Math.max(
            0,
            Math.min(maxFade, clipDragState.initialFadeOutSec - dxSec),
          ).toFixed(2),
        );
        scheduleClipOverride({ fade_out_sec: nextFade });
      }
    };

    const onPointerUp = () => {
      if (committed) return;
      committed = true;

      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }

      if (clipDragState.mode === "scrub") {
        if (scrubLatestSecRef.current !== null) {
          void setTimelineTransport(
            currentTimeline.id,
            timelinePlaying,
            scrubLatestSecRef.current,
          );
          scrubLatestSecRef.current = null;
        }
        setClipDragState(null);
        return;
      }

      const ov = localClipOverrideRef.current;
      localClipOverrideRef.current = null;
      if (ov) {
        commitClipUpdate(
          ov.trackId,
          ov.clipIndex,
          (c) => ({
            ...c,
            ...ov.patch,
          }),
          undefined,
          ov.targetTrackId,
          Boolean(ov.isDuplicate),
        );
      }
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
    commitClipUpdate,
    currentTimeline,
    magneticSnap,
    setTimelineTransport,
    snapMarkers,
    stretchToolActive,
    timelinePlaying,
    viewportDurationSec,
    viewportWidthPx,
  ]);

  const handleToggleLoop = () => {
    if (!currentTimeline) return;
    void upsertTimeline({
      ...currentTimeline,
      loop_timeline: !currentTimeline.loop_timeline,
    });
  };

  const handleDeleteTrack = async (trackId: string) => {
    if (!currentTimeline) return;
    await saveTimelineTracks(
      currentTimeline.tracks.filter((tr) => tr.id !== trackId),
    );
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
      start_sec: Math.max(0, Number(snappedStart.toFixed(3))),
      duration_sec: Math.max(0.1, Number(durationSec.toFixed(3))),
      fade_in_sec: 0,
      fade_out_sec: 0,
      inline_fx: [],
    };
    const targetTrack =
      trackId === "__new__"
        ? null
        : currentTimeline.tracks.find((t) => t.id === trackId) ?? null;

    if (!targetTrack || (targetTrack.track_type ?? "untyped") === "music") {
      if (targetTrack && targetTrack.track_type === "music") {
        setTimelineNotice(
          "Music track cannot hold Effect clips; created a new Effect track.",
        );
      }
      const newTrackId = `trk_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const newTrack: TrackDef = {
        id: newTrackId,
        name: `Track ${currentTimeline.tracks.length + 1}`,
        track_type: "effect",
        target_group: "all",
        clips: [clip],
      };
      await saveTimelineTracks([...currentTimeline.tracks, newTrack]);
      setSelectedClip({ trackId: newTrackId, clipIndex: 0 });
      return;
    }

    const { clips: nextClips, insertedIndex } = applySingleTrackOverwrite(
      clip,
      targetTrack.clips,
    );
    await saveTimelineTracks(
      currentTimeline.tracks.map((tr) =>
        tr.id === targetTrack.id
          ? {
              ...tr,
              track_type:
                (tr.track_type ?? "untyped") === "untyped"
                  ? "effect"
                  : tr.track_type,
              clips: nextClips,
            }
          : tr,
      ),
    );
    setSelectedClip({ trackId: targetTrack.id, clipIndex: insertedIndex });
  };

  const dropAudioFileToTrack = async (
    file: File,
    trackId: string,
    atSec: number,
  ) => {
    if (!currentTimeline) return;
    setTimelineNotice(null);
    const { asset, analysis } = await decodeAudioFile(file, sensitivity);
    setClipAudioAnalysis(asset.key, analysis, currentTimeline.id);

    const hasExistingMusic = currentTimeline.tracks.some((tr) =>
      tr.clips.some((c) => Boolean(c.audio_file)),
    );
    const snappedStart = magneticSnap
      ? snapTimeSecToMarkers(atSec, snapMarkers, 0.15)
      : atSec;
    // Place the first song in an empty timeline cleanly at 0.0s
    const clipStart = !hasExistingMusic
      ? 0
      : Math.max(0, Number(snappedStart.toFixed(3)));
    const audioClip: ClipDef = {
      ref_block: null,
      start_sec: clipStart,
      duration_sec: asset.durationSec,
      fade_in_sec: 0,
      fade_out_sec: 0,
      inline_fx: [],
      audio_file: asset.key,
      source_duration_sec: asset.durationSec,
    };

    // Auto-sync Timeline BPM & beat-grid phase offset to the dropped song
    const syncedBpm = Math.max(
      20,
      Math.min(300, Math.round(analysis.estimated_bpm)),
    );
    const syncedOffset = Number(
      Math.max(0, clipStart + analysis.grid_offset_sec).toFixed(3),
    );
    const syncedTempoMap =
      currentTimeline.tempo_map.length > 0
        ? currentTimeline.tempo_map.map((pt, idx) =>
            idx === 0 ? { ...pt, bpm: syncedBpm } : pt,
          )
        : [{ at_sec: 0, bpm: syncedBpm }];

    const targetTrack =
      trackId === "__new__"
        ? null
        : currentTimeline.tracks.find((t) => t.id === trackId) ?? null;

    if (!targetTrack || (targetTrack.track_type ?? "untyped") === "effect") {
      if (targetTrack && targetTrack.track_type === "effect") {
        setTimelineNotice(
          "Effect track cannot hold Music clips; created a new Music track.",
        );
      }
      const newTrackId = `trk_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const newTrack: TrackDef = {
        id: newTrackId,
        name: `Music ${currentTimeline.tracks.length + 1}`,
        track_type: "music",
        target_group: null,
        clips: [audioClip],
      };
      await saveTimelineTracks([...currentTimeline.tracks, newTrack], undefined, {
        tempo_map: syncedTempoMap,
        grid_offset_sec: syncedOffset,
      });
      setSelectedClip({ trackId: newTrackId, clipIndex: 0 });
    } else {
      const { clips: nextClips, insertedIndex } = applySingleTrackOverwrite(
        audioClip,
        targetTrack.clips,
      );
      await saveTimelineTracks(
        currentTimeline.tracks.map((tr) =>
          tr.id === targetTrack.id
            ? { ...tr, track_type: "music", clips: nextClips }
            : tr,
        ),
        undefined,
        {
          tempo_map: syncedTempoMap,
          grid_offset_sec: syncedOffset,
        },
      );
      setSelectedClip({ trackId: targetTrack.id, clipIndex: insertedIndex });
    }
  };

  const switchTrackType = async (trackId: string, nextType: TrackType) => {
    if (!currentTimeline) return;
    const track = currentTimeline.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const curType: TrackType = track.track_type ?? "untyped";
    if (curType === nextType) return;
    if (track.clips.length > 0 && nextType !== "untyped") {
      const incompatible = track.clips.filter((c) =>
        nextType === "music" ? !c.audio_file : Boolean(c.audio_file),
      );
      if (incompatible.length > 0) {
        const ok = window.confirm(
          `Track "${track.name}" has ${incompatible.length} incompatible clip(s). Switching to ${nextType} will remove them. Continue?`,
        );
        if (!ok) return;
      }
    }
    await saveTimelineTracks(
      currentTimeline.tracks.map((tr) =>
        tr.id === trackId
          ? {
              ...tr,
              track_type: nextType,
              clips:
                nextType === "music"
                  ? tr.clips.filter((c) => Boolean(c.audio_file))
                  : nextType === "effect"
                    ? tr.clips.filter((c) => !c.audio_file)
                    : tr.clips,
            }
          : tr,
      ),
    );
  };

  const dropSceneToTrack = async (
    sceneId: string,
    trackId: string,
    atSec: number,
    durationSec = clipDurationSec,
  ) => {
    const scene = showState.scenes.find((s) => s.id === sceneId);
    if (scene?.timeline_ref) {
      setTimelineNotice("Cannot nest a Timeline Super-Scene inside another Timeline.");
      return;
    }
    let blockId = scene?.block_refs[0] ?? "";
    if (!blockId && scene) {
      blockId = `blk_scene_${scene.id}`;
      await upsertFxBlock({
        id: blockId,
        name: `${scene.name} Look`,
        target_group: scene.target_group ?? "all",
        duration_beats:
          scene.duration_unit === "seconds" ? 4 : (scene.duration_value ?? 4),
        duration_sec:
          scene.duration_unit === "seconds" ? (scene.duration_value ?? 2) : null,
        loop_block: true,
        elements: [],
      });
      await upsertScene({
        ...scene,
        block_refs: [blockId],
      });
    }
    if (!blockId) blockId = effectiveBlockRef;
    if (!blockId) return;
    setPaletteSelectedSceneId(sceneId);
    await handleAddClipAt(trackId, atSec, durationSec, blockId);
  };

  useEffect(() => {
    const onSceneDrop = (ev: Event) => {
      const ce = ev as CustomEvent<{
        sceneId: string;
        trackId: string;
        clientX: number;
      }>;
      if (!currentTimeline || !ce.detail?.sceneId) return;
      const targetEl = ev.target as HTMLElement | null;
      const rect = (
        lanesViewportRef.current ?? targetEl
      )?.getBoundingClientRect();
      const frac =
        rect && rect.width > 10 && Number.isFinite(ce.detail.clientX)
          ? Math.max(0, Math.min(1, (ce.detail.clientX - rect.left) / rect.width))
          : displayPlayheadSec / Math.max(0.1, viewportDurationSec);
      const dropSec = Number((frac * viewportDurationSec).toFixed(3));
      void dropSceneToTrack(ce.detail.sceneId, ce.detail.trackId, dropSec);
    };
    window.addEventListener("takt:scene-drop", onSceneDrop);
    return () => window.removeEventListener("takt:scene-drop", onSceneDrop);
  });

  const handleDeleteClip = async (trackId: string, clipIdx: number) => {
    if (!currentTimeline) return;
    await saveTimelineTracks(
      currentTimeline.tracks.map((tr) =>
        tr.id === trackId
          ? { ...tr, clips: tr.clips.filter((_, idx) => idx !== clipIdx) }
          : tr,
      ),
    );
    if (
      selectedClip?.trackId === trackId &&
      selectedClip?.clipIndex === clipIdx
    ) {
      setSelectedClip(null);
    }
  };

  const handleSplitClipAtPlayhead = async () => {
    if (!currentTimeline) return;
    const tSplit = displayPlayheadSec;

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

    await saveTimelineTracks(
      currentTimeline.tracks.map((tr) => {
        if (tr.id !== targetTrackId) return tr;
        const nextClips = [...tr.clips];
        nextClips.splice(targetClipIdx, 1, leftClip, rightClip);
        return { ...tr, clips: nextClips };
      }),
    );
    setSelectedClip({ trackId: targetTrackId, clipIndex: targetClipIdx + 1 });
  };

  const handleDuplicateSelectedClip = async () => {
    if (!currentTimeline || !resolvedSelectedClip) return;
    const { trackId, clip } = resolvedSelectedClip;
    const desiredStart = Number((clip.start_sec + clip.duration_sec).toFixed(3));
    const copy: ClipDef = {
      ...clip,
      start_sec: desiredStart,
    };
    const trk = currentTimeline.tracks.find((t) => t.id === trackId);
    if (!trk) return;
    const { clips: nextClips, insertedIndex } = applySingleTrackOverwrite(
      copy,
      trk.clips,
    );
    await saveTimelineTracks(
      currentTimeline.tracks.map((tr) =>
        tr.id === trackId ? { ...tr, clips: nextClips } : tr,
      ),
    );
    setSelectedClip({ trackId, clipIndex: insertedIndex });
  };

  const handleDeleteSelectedClip = useCallback(async () => {
    if (!currentTimeline || !resolvedSelectedClip) return;
    const { trackId, clipIndex } = resolvedSelectedClip;
    await saveTimelineTracks(
      currentTimeline.tracks.map((tr) =>
        tr.id === trackId
          ? { ...tr, clips: tr.clips.filter((_, idx) => idx !== clipIndex) }
          : tr,
      ),
    );
    setSelectedClip(null);
  }, [currentTimeline, resolvedSelectedClip, saveTimelineTracks, setSelectedClip]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (!currentTimeline) return;

      if (e.code === "Space") {
        e.preventDefault();
        void setTimelineTransport(currentTimeline.id, !timelinePlaying);
      } else if (e.key === "Home") {
        e.preventDefault();
        void setTimelineTransport(currentTimeline.id, false, 0);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (resolvedSelectedClip) {
          e.preventDefault();
          void handleDeleteSelectedClip();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        if (resolvedSelectedClip) {
          e.preventDefault();
          void handleDuplicateSelectedClip();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          void redoShow();
        } else {
          void undoShow();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void redoShow();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    currentTimeline,
    handleDeleteSelectedClip,
    redoShow,
    resolvedSelectedClip,
    setTimelineTransport,
    timelinePlaying,
    undoShow,
  ]);

  // Auto-Fill Kicks: places the selected FX scene on all strong detected Kick transients
  // across the full song on a dedicated FX track (no 32-clip cap!)
  const handleAutoPlaceOnKicks = async () => {
    if (!currentTimeline || !effectiveBlockRef) return;
    const allKicks = timelineTransients.filter((m) => m.band === "kick");
    const strongKicks = allKicks.filter((m) => m.strength >= 0.35);
    const chosenKicks = strongKicks.length > 0 ? strongKicks : allKicks;

    const times =
      chosenKicks.length > 0
        ? chosenKicks.map((k) => k.time_sec)
        : beatGridMarkers.filter((_, i) => i % 2 === 0);

    if (times.length === 0) {
      setTimelineNotice("No kick transients or beat markers available to fill.");
      return;
    }

    const hitDur = Number(
      Math.min(0.25, Math.max(0.1, (60 / Math.max(20, effectiveBpm)) * 0.45)).toFixed(3),
    );

    // Filter out hits closer than hitDur so they never collide
    const generated: ClipDef[] = [];
    let lastEnd = -1;
    for (const t of times) {
      if (t >= lastEnd - 1e-3) {
        generated.push({
          ref_block: effectiveBlockRef,
          start_sec: Number(Math.max(0, t).toFixed(3)),
          duration_sec: hitDur,
          fade_in_sec: 0,
          fade_out_sec: 0,
          inline_fx: [],
        });
        lastEnd = t + hitDur;
      }
    }

    const existingKickTrack = currentTimeline.tracks.find(
      (t) => t.name === "Kick Hits" && t.track_type === "effect",
    );
    if (existingKickTrack) {
      await saveTimelineTracks(
        currentTimeline.tracks.map((tr) =>
          tr.id === existingKickTrack.id ? { ...tr, clips: generated } : tr,
        ),
      );
      setSelectedClip({ trackId: existingKickTrack.id, clipIndex: 0 });
    } else {
      const newTrackId = `trk_kicks_${Date.now()}`;
      const newTrack: TrackDef = {
        id: newTrackId,
        name: "Kick Hits",
        track_type: "effect",
        target_group: "all",
        clips: generated,
      };
      await saveTimelineTracks([...currentTimeline.tracks, newTrack]);
      setSelectedClip({ trackId: newTrackId, clipIndex: 0 });
    }
    setTimelineNotice(null);
  };

  const handleViewportWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const scroller = lanesScrollRef.current;
    const rect = scroller?.getBoundingClientRect();
    const cursorOffsetX =
      rect && Number.isFinite(e.clientX) ? e.clientX - rect.left : 0;
    const prevScrollLeft = scroller?.scrollLeft ?? 0;
    const prevZoom = timelineZoom;
    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    const nextZoom = Math.max(
      0.2,
      Math.min(8.0, Number((prevZoom * factor).toFixed(2))),
    );
    if (nextZoom === prevZoom) return;
    setTimelineZoom(nextZoom);
    if (scroller) {
      const ratio = nextZoom / prevZoom;
      requestAnimationFrame(() => {
        scroller.scrollLeft = Math.max(
          0,
          (prevScrollLeft + cursorOffsetX) * ratio - cursorOffsetX,
        );
      });
    }
  };

  const scrubFromClientX = (clientX: number) => {
    if (!currentTimeline || !Number.isFinite(clientX)) return;
    const rect = lanesViewportRef.current?.getBoundingClientRect();
    const vw = rect && rect.width > 10 ? rect.width : viewportWidthPx;
    const left = rect?.left ?? 0;
    const frac = Math.max(0, Math.min(1, (clientX - left) / vw));
    const rawSec = frac * viewportDurationSec;
    const sec = magneticSnap
      ? snapTimeSecToMarkers(rawSec, snapMarkers, 0.12)
      : Number(rawSec.toFixed(3));
    setDisplayPlayheadSec(sec);
    scrubLatestSecRef.current = sec;
    void setTimelineTransport(currentTimeline.id, timelinePlaying, sec);
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

  const playheadPct = Math.max(
    0,
    Math.min(100, (displayPlayheadSec / Math.max(0.1, viewportDurationSec)) * 100),
  );

  // Zoom-adaptive ruler ticks (automatically switches between 30s/15s/10s/5s/2s/1s or bars/beats)
  const rulerTicks = useMemo(
    () =>
      computeZoomAdaptiveRulerTicks(
        viewportDurationSec,
        pxPerSec,
        timeUnit,
        effectiveBpm,
        currentTimeline?.grid_offset_sec ?? 0,
      ),
    [
      currentTimeline?.grid_offset_sec,
      effectiveBpm,
      pxPerSec,
      timeUnit,
      viewportDurationSec,
    ],
  );

  if (!currentTimeline) {
    return (
      <div className="bg-slate-dark border border-steel rounded p-4 font-mono text-xs text-fog h-full flex items-center justify-center">
        No Timeline selected. Pick TIMELINE in the FX Choice Matrix to convert a scene.
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-slate-dark border border-steel rounded overflow-hidden">
      {/* Slim Single NLE Transport & Tool Bar */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-1.5 bg-slate border-b border-steel px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <AudioWaveform className="w-3.5 h-3.5 text-cobalt shrink-0" />
          <h2 className="font-sans text-xs font-semibold text-frost truncate max-w-[140px]">
            {currentTimeline.name}
          </h2>
          <span
            data-testid="timeline-content-length"
            className="font-mono text-[10px] text-fog bg-pitch border border-steel rounded px-1.5 py-0.5 shrink-0"
            title="Dynamic timeline length (end of last clip)"
          >
            {contentDurationSec.toFixed(1)}s
          </span>
          <span
            data-testid="timeline-header-bpm"
            className="font-mono text-[10px] text-plum bg-pitch border border-steel rounded px-1.5 py-0.5 shrink-0"
            title="Current timeline tempo in BPM (edit in right-side Timeline Settings tab)"
          >
            {effectiveBpm} BPM
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() =>
              void setTimelineTransport(currentTimeline.id, false, 0)
            }
            title="Return to Start (Home)"
            aria-label="Return to Start"
            className="p-1 rounded border border-steel bg-ink hover:border-fog text-mist"
          >
            <SkipBack className="w-3 h-3" />
          </button>

          <button
            type="button"
            onClick={() =>
              void setTimelineTransport(
                currentTimeline.id,
                !timelinePlaying,
              )
            }
            title="Play or Pause Timeline (Space)"
            className="flex items-center gap-1 px-2 py-1 rounded bg-ember hover:bg-burnt text-frost font-mono text-[11px] font-semibold transition-colors"
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

          <button
            type="button"
            data-testid="timeline-loop-toggle"
            aria-pressed={Boolean(currentTimeline.loop_timeline)}
            onClick={handleToggleLoop}
            title={
              currentTimeline.loop_timeline
                ? "Loop Enabled: wraps back to 0s at end of last clip"
                : "One-Shot: stops and releases at end of last clip"
            }
            className={`flex items-center gap-1 px-1.5 py-1 rounded border font-mono text-[10px] transition-colors ${
              currentTimeline.loop_timeline
                ? "border-pine bg-pine/25 text-frost font-semibold"
                : "border-steel bg-ink text-fog hover:text-mist"
            }`}
          >
            <Repeat className="w-3 h-3" />
            <span>Loop</span>
          </button>

          <label
            className="flex items-center gap-1 bg-pitch border border-steel rounded px-1.5 py-0.5"
            title="Current playhead position in seconds"
          >
            <Clock className="w-3 h-3 text-ember" />
            <input
              aria-label="Timeline Playhead Sec"
              type="number"
              min={0}
              step={0.1}
              value={Number(displayPlayheadSec.toFixed(2))}
              onChange={(e) =>
                void setTimelineTransport(
                  currentTimeline.id,
                  timelinePlaying,
                  Number(e.target.value) || 0,
                )
              }
              className="w-12 bg-ink border border-steel rounded px-1 py-0.5 font-mono text-[10px] text-frost"
            />
          </label>

          <span className="h-4 w-px bg-steel/70 mx-0.5" />

          {/* Tools: Snap + Snap Grid Subdivision, Time-Stretch Mode, Beats/Sec */}
          <div className="flex items-center gap-0.5 rounded border border-steel bg-ink px-1 py-0.5 font-mono text-[10px] text-mist">
            <label
              className="flex items-center gap-1 cursor-pointer pr-1"
              title="Magnetically snap clips and playhead to the selected Beat Grid subdivision and clip edges"
            >
              <input
                aria-label="Magnetic Snap"
                type="checkbox"
                checked={magneticSnap}
                onChange={(e) => setMagneticSnap(e.target.checked)}
              />
              <Magnet className="w-3 h-3 text-plum" />
              <span>Snap</span>
            </label>
            <select
              aria-label="Snap Grid Subdivision"
              data-testid="timeline-snap-grid-select"
              disabled={!magneticSnap}
              value={snapGrid}
              onChange={(e) =>
                setSnapGrid(e.target.value as SnapGridSubdivision)
              }
              title="Snap grid resolution: Whole Beats (default), Bars (4 beats), 1/2 Beat, or 1/4 Beat"
              className="bg-pitch border border-steel/70 rounded px-1 py-0 text-[10px] text-frost disabled:opacity-40"
            >
              <option value="bar">Bar</option>
              <option value="beat">Beat</option>
              <option value="half">1/2</option>
              <option value="quarter">1/4</option>
            </select>
          </div>

          <button
            type="button"
            data-testid="timeline-stretch-tool-toggle"
            aria-pressed={stretchToolActive}
            onClick={() => setStretchToolActive((v) => !v)}
            title="Time-Stretch Tool: when active, dragging a clip's edges stretches or compresses its FX speed to fit instead of looping"
            className={`flex items-center gap-1 px-1.5 py-1 rounded border font-mono text-[10px] transition-colors ${
              stretchToolActive
                ? "border-ember bg-ember/25 text-frost font-semibold"
                : "border-steel bg-ink text-fog hover:text-mist"
            }`}
          >
            <MoveHorizontal className="w-3 h-3" />
            <span>Stretch</span>
          </button>

          <div
            className="flex items-center gap-0.5 bg-ink border border-steel rounded p-0.5 font-mono text-[10px]"
            title="Switch ruler and clip inspector between Beats and Seconds"
          >
            <button
              type="button"
              data-testid="timeline-unit-beats"
              aria-pressed={timeUnit === "beats"}
              onClick={() => setTimeUnit("beats")}
              className={`px-1.5 py-0.5 rounded ${
                timeUnit === "beats"
                  ? "bg-plum/30 text-frost font-semibold"
                  : "text-fog hover:text-mist"
              }`}
            >
              Beats
            </button>
            <button
              type="button"
              data-testid="timeline-unit-seconds"
              aria-pressed={timeUnit === "seconds"}
              onClick={() => setTimeUnit("seconds")}
              className={`px-1.5 py-0.5 rounded ${
                timeUnit === "seconds"
                  ? "bg-cobalt/30 text-frost font-semibold"
                  : "text-fog hover:text-mist"
              }`}
            >
              Sec
            </button>
          </div>

          <span className="h-4 w-px bg-steel/70 mx-0.5" />

          {/* Clip Actions */}
          <button
            type="button"
            data-testid="timeline-split-clip-btn"
            onClick={() => void handleSplitClipAtPlayhead()}
            title="Split selected or hovered clip at the playhead"
            className="flex items-center gap-1 px-1.5 py-1 rounded bg-ink border border-steel hover:border-ember font-mono text-[10px] text-frost"
          >
            <Scissors className="w-3 h-3 text-ember" />
            <span>Split</span>
          </button>

          <button
            type="button"
            data-testid="timeline-duplicate-clip-btn"
            disabled={!resolvedSelectedClip}
            onClick={() => void handleDuplicateSelectedClip()}
            title="Duplicate selected clip (Ctrl+D, or Alt+Drag any clip)"
            className="flex items-center gap-1 px-1.5 py-1 rounded bg-ink border border-steel hover:border-cobalt font-mono text-[10px] text-frost disabled:opacity-40"
          >
            <Copy className="w-3 h-3 text-cobalt" />
          </button>

          <button
            type="button"
            data-testid="timeline-auto-place-kicks-btn"
            onClick={() => void handleAutoPlaceOnKicks()}
            title="Automatically place the selected FX scene on all strong detected Kick transients across the song"
            className="flex items-center gap-1 px-1.5 py-1 rounded bg-plum/20 border border-plum hover:bg-plum/30 font-mono text-[10px] text-frost"
          >
            <Sparkles className="w-3 h-3 text-plum" />
            <span>Kicks</span>
          </button>

          <input
            ref={musicInputRef}
            type="file"
            accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a"
            aria-label="Add Music File"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                void dropAudioFileToTrack(file, "__new__", displayPlayheadSec);
              }
              e.target.value = "";
            }}
          />
          <button
            type="button"
            data-testid="timeline-add-music-btn"
            onClick={() => musicInputRef.current?.click()}
            title="Add Music Track from Audio File (or drag and drop MP3/WAV/OGG/FLAC onto any track)"
            className="flex items-center gap-1 px-1.5 py-1 rounded border border-steel bg-ink hover:border-cobalt font-mono text-[10px] text-frost"
          >
            <Music className="w-3 h-3 text-cobalt" />
            <span>Music</span>
          </button>

          {/* Zoom Controls */}
          <div
            className="flex items-center gap-0.5 bg-ink border border-steel rounded p-0.5 font-mono text-[10px]"
            title="Zoom timeline horizontally (or hold Ctrl + Mousewheel)"
          >
            <button
              type="button"
              data-testid="timeline-zoom-out"
              onClick={() =>
                setTimelineZoom((z) =>
                  Math.max(0.2, Number((z - 0.25).toFixed(2))),
                )
              }
              title="Zoom Out"
              className="p-0.5 text-mist hover:text-ember"
            >
              <ZoomOut className="w-3 h-3" />
            </button>
            <button
              type="button"
              data-testid="timeline-zoom-reset"
              onClick={() => setTimelineZoom(1.0)}
              title="Reset Zoom to 1.0x"
              className="px-1 text-frost"
            >
              {timelineZoom.toFixed(1)}×
            </button>
            <button
              type="button"
              data-testid="timeline-zoom-in"
              onClick={() =>
                setTimelineZoom((z) =>
                  Math.min(8.0, Number((z + 0.5).toFixed(2))),
                )
              }
              title="Zoom In"
              className="p-0.5 text-mist hover:text-ember"
            >
              <ZoomIn className="w-3 h-3" />
            </button>
          </div>

          {!hideUndoRedo && (
            <>
              <button
                type="button"
                disabled={!canUndo}
                onClick={() => void undoShow()}
                className="p-1 rounded border border-steel bg-ink text-mist disabled:opacity-40"
              >
                <Undo2 className="w-3 h-3" />
              </button>
              <button
                type="button"
                disabled={!canRedo}
                onClick={() => void redoShow()}
                className="p-1 rounded border border-steel bg-ink text-mist disabled:opacity-40"
              >
                <Redo2 className="w-3 h-3" />
              </button>
            </>
          )}

          {onToggleExpand && (
            <button
              type="button"
              data-testid="timeline-expand-toggle"
              aria-pressed={expanded}
              onClick={onToggleExpand}
              title={
                expanded
                  ? "Collapse Timeline to Bottom-Right Dock"
                  : "Expand Timeline to Full Bottom Width"
              }
              className="p-1 rounded border border-steel bg-ink text-mist hover:border-ember hover:text-frost"
            >
              {expanded ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Multi-Track Infinite-Canvas NLE Area */}
      <section
        onDragOver={(e: DragEvent<HTMLElement>) => {
          if (e.dataTransfer?.types?.includes("Files")) {
            e.preventDefault();
            setIsFileDragOver(true);
          }
        }}
        onDragLeave={() => setIsFileDragOver(false)}
        onDrop={() => setIsFileDragOver(false)}
        className={`flex-1 min-h-0 flex flex-col overflow-hidden transition-colors ${
          isFileDragOver ? "ring-2 ring-inset ring-cobalt" : ""
        }`}
      >
        {timelineNotice && (
          <div className="shrink-0 flex items-center justify-between gap-2 bg-amber-950/60 border-b border-amber-500/60 px-2.5 py-1 font-mono text-[10px] text-amber-200">
            <span>{timelineNotice}</span>
            <button
              type="button"
              onClick={() => setTimelineNotice(null)}
              className="text-amber-300 hover:text-frost"
            >
              ×
            </button>
          </div>
        )}

        <div className="flex-1 min-h-0 flex overflow-y-auto bg-pitch">
          {/* Left Sticky Track Header Column */}
          <div className="w-36 shrink-0 border-r border-steel bg-slate-dark flex flex-col">
            <div className="h-7 border-b border-steel px-2 flex items-center justify-between font-mono text-[9px] text-fog shrink-0">
              <span>
                {timeUnit === "beats"
                  ? `BARS (${Math.ceil(secToBeats(viewportDurationSec) / 4)})`
                  : `TIME (${viewportDurationSec}s)`}
              </span>
              <span>{effectiveBpm}</span>
            </div>

            {currentTimeline.tracks.map((track) => {
              const tType = track.track_type ?? "untyped";
              const typeBadge =
                tType === "music" ? "MUSIC" : tType === "effect" ? "FX" : "ANY";
              const typeClass =
                tType === "music"
                  ? "text-cobalt border-cobalt/60 bg-cobalt/15"
                  : tType === "effect"
                    ? "text-ember border-ember/60 bg-ember/15"
                    : "text-fog border-steel bg-ink";
              return (
                <div
                  key={track.id}
                  data-testid={`track-header-${track.id}`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setTrackContextMenu({
                      trackId: track.id,
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }}
                  title="Right-click to switch track type (Effect / Music / Untyped)"
                  className="h-14 shrink-0 border-b border-steel/70 px-2 py-1 flex items-center justify-between gap-1 cursor-context-menu"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="font-sans text-[11px] font-semibold text-frost truncate">
                        {track.name}
                      </span>
                      <span
                        className={`px-1 rounded border font-mono text-[8px] shrink-0 ${typeClass}`}
                      >
                        {typeBadge}
                      </span>
                    </div>
                    <div className="font-mono text-[9px] text-fog truncate">
                      {track.clips.length} clips
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
              );
            })}

            <div className="h-10 shrink-0 px-2 flex items-center font-mono text-[9px] text-fog">
              + Drop Scene / Music
            </div>
          </div>

          {/* Right Scrollable Infinite Time-Aligned Viewport (Ctrl+Wheel Zoom) */}
          <div
            ref={lanesScrollRef}
            onWheel={handleViewportWheel}
            className="flex-1 min-w-0 overflow-x-auto"
          >
            <div
              ref={lanesViewportRef}
              style={{ width: `${viewportWidthPx}px` }}
              className="relative flex flex-col min-w-full"
            >
              {/* Full-Height Vertical Playhead Cursor */}
              <div
                data-testid="nle-playhead-line"
                style={{ left: `${playheadPct}%` }}
                className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-ember z-20"
              />

              {/* Interactive Zoom-Adaptive Time Ruler */}
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
                className="relative h-7 shrink-0 border-b border-steel bg-ink cursor-ew-resize select-none"
              >
                {rulerTicks.map((tick, idx) => (
                  <div
                    key={`${tick.timeSec}-${idx}`}
                    data-testid="timeline-ruler-tick"
                    style={{ left: `${(tick.timeSec / viewportDurationSec) * 100}%` }}
                    className={`absolute top-0 bottom-0 pl-1 font-mono text-[9px] flex items-center whitespace-nowrap ${
                      tick.isMajor
                        ? "border-l border-fog/60 text-mist"
                        : "border-l border-steel/60 text-fog"
                    }`}
                  >
                    {tick.label}
                  </div>
                ))}
                <div
                  style={{ left: `${playheadPct}%` }}
                  className="absolute top-0 -translate-x-1/2 px-1 bg-ember text-void font-mono text-[9px] font-bold rounded-b whitespace-nowrap"
                >
                  {timeUnit === "beats"
                    ? `${secToBeats(displayPlayheadSec).toFixed(1)}b (${displayPlayheadSec.toFixed(2)}s)`
                    : `${displayPlayheadSec.toFixed(2)}s`}
                </div>
              </div>

              {/* Track Clip Lanes */}
              {currentTimeline.tracks.map((track) => (
                <div
                  key={track.id}
                  data-testid={`track-lane-${track.id}`}
                  data-track-lane-id={track.id}
                  onDragOver={(e: DragEvent<HTMLDivElement>) => {
                    e.preventDefault();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
                  }}
                  onDrop={(e: DragEvent<HTMLDivElement>) => {
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const vw = rect.width > 10 ? rect.width : viewportWidthPx;
                    const frac =
                      rect.width > 10 && Number.isFinite(e.clientX)
                        ? Math.max(0, Math.min(1, (e.clientX - rect.left) / vw))
                        : displayPlayheadSec / Math.max(0.1, viewportDurationSec);
                    const dropSec = Number((frac * viewportDurationSec).toFixed(3));

                    const droppedFile = e.dataTransfer?.files?.[0];
                    if (droppedFile) {
                      setDraggingSceneId(null);
                      void dropAudioFileToTrack(droppedFile, track.id, dropSec);
                      return;
                    }

                    const sid =
                      e.dataTransfer?.getData("text/takt-scene-id") ||
                      e.dataTransfer?.getData("text/plain") ||
                      draggingSceneId ||
                      paletteSelectedSceneId;
                    setDraggingSceneId(null);
                    if (!sid) return;
                    void dropSceneToTrack(sid, track.id, dropSec);
                  }}
                  className="relative h-14 shrink-0 border-b border-steel/70 bg-void overflow-hidden select-none"
                  title="Double-click or drop a Scene / Audio file here; drag clip to move, Alt+Drag to duplicate, or drag edges to trim/stretch"
                >
                  {/* Beat Grid Vertical Lines (Neutral slate/white: bold bars, subtle beats) */}
                  {beatGridMarkers.map((bt, bIdx) => {
                    const isBar = bIdx % 4 === 0;
                    if (!isBar && pxPerSec < 18) return null;
                    return (
                      <div
                        key={`bg-${bIdx}`}
                        data-testid={isBar ? "beat-grid-bar" : "beat-grid-sub"}
                        style={{ left: `${(bt / viewportDurationSec) * 100}%` }}
                        className={`pointer-events-none absolute top-0 bottom-0 ${
                          isBar
                            ? "border-l-2 border-frost/35"
                            : "border-l border-steel/45"
                        }`}
                      />
                    );
                  })}

                  {/* Optional Projected Transient Guidelines (Amber = Kick, Cyan = Snare) */}
                  {projectTransients &&
                    timelineTransients.map((m, mIdx) => (
                      <div
                        key={`tr-${mIdx}`}
                        style={{
                          left: `${(m.time_sec / viewportDurationSec) * 100}%`,
                        }}
                        className={`pointer-events-none absolute top-0 bottom-0 border-l ${
                          m.band === "kick"
                            ? "border-amber-400/55"
                            : "border-cyan-400/35"
                        }`}
                      />
                    ))}

                  {/* Interactive Clip Blocks */}
                  {track.clips.map((rawClip, idx) => {
                    const ov = localClipOverrideRef.current;
                    const isBeingDragged =
                      ov !== null &&
                      ov.trackId === track.id &&
                      ov.clipIndex === idx &&
                      !ov.isDuplicate;
                    if (
                      isBeingDragged &&
                      ov.targetTrackId &&
                      ov.targetTrackId !== track.id
                    ) {
                      return null;
                    }
                    const clip = isBeingDragged
                      ? { ...rawClip, ...ov.patch }
                      : rawClip;
                    const leftPct = (clip.start_sec / viewportDurationSec) * 100;
                    const widthPct =
                      (clip.duration_sec / viewportDurationSec) * 100;
                    const isSelected =
                      resolvedSelectedClip?.trackId === track.id &&
                      resolvedSelectedClip?.clipIndex === idx;
                    const isMusicClip = Boolean(clip.audio_file);
                    const clipAudioAnalysis = clip.audio_file
                      ? audioAnalysisByClipKey[clip.audio_file]
                      : undefined;
                    const colors = getBlockColors(clip.ref_block);
                    const fadeInPct = Math.min(
                      50,
                      (clip.fade_in_sec / Math.max(0.01, clip.duration_sec)) *
                        100,
                    );
                    const fadeOutPct = Math.min(
                      50,
                      (clip.fade_out_sec / Math.max(0.01, clip.duration_sec)) *
                        100,
                    );
                    const naturalCycleSec = isMusicClip
                      ? 0
                      : getClipNaturalCycleSec(clip);
                    const effectiveCycleSec = isMusicClip
                      ? 0
                      : getClipEffectiveCycleSec(clip);
                    const cycleBoundaries = isMusicClip
                      ? []
                      : computeEffectCycleBoundaries(
                          clip.duration_sec,
                          effectiveCycleSec,
                          false,
                        );

                    return (
                      <div
                        key={`${track.id}-clip-${idx}`}
                        data-testid={`timeline-clip-${track.id}-${idx}`}
                        style={{
                          left: `${Math.max(0, leftPct)}%`,
                          width: `${widthPct}%`,
                          minWidth: "4px",
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
                            ? "border-2 border-frost ring-2 ring-cyan-400 bg-slate shadow-[0_0_12px_rgba(34,211,238,0.45)] z-10"
                            : isMusicClip
                              ? "border-cobalt/80 bg-cobalt/15 hover:border-frost/70"
                              : "border-steel/80 bg-slate-dark/85 opacity-85 hover:opacity-100 hover:border-frost/70"
                        }`}
                      >
                        {/* Per-clip Audio Waveform for Music Clips */}
                        {isMusicClip && clip.audio_file && (
                          <ClipWaveformCanvas
                            audioFile={clip.audio_file}
                            analysis={clipAudioAnalysis}
                            clipDurationSec={clip.duration_sec}
                            clipWidthPx={(widthPct / 100) * viewportWidthPx}
                            showTransients={showTransients}
                            testId={`clip-waveform-${track.id}-${idx}`}
                          />
                        )}

                        {/* Alternating Cycle Shading + Crisp 2px Beat-Aligned Cycle Dividers inside FX Clips */}
                        {!isMusicClip &&
                          effectiveCycleSec > 0.05 &&
                          (() => {
                            const totalDur = Math.max(0.05, clip.duration_sec);
                            const segStarts = [0, ...cycleBoundaries];
                            return (
                              <>
                                {segStarts.map((segStart, sIdx) => {
                                  if (sIdx % 2 === 0) return null;
                                  const segEnd =
                                    segStarts[sIdx + 1] ?? totalDur;
                                  const segLeftPct =
                                    (segStart / totalDur) * 100;
                                  const segWidthPct =
                                    ((segEnd - segStart) / totalDur) * 100;
                                  return (
                                    <div
                                      key={`cyc-bg-${sIdx}`}
                                      style={{
                                        left: `${segLeftPct}%`,
                                        width: `${segWidthPct}%`,
                                      }}
                                      className="pointer-events-none absolute top-0 bottom-0 bg-white/[0.09] z-[5]"
                                    />
                                  );
                                })}
                                {cycleBoundaries.map((offsetSec, cIdx) => (
                                  <div
                                    key={`cyc-${cIdx}`}
                                    data-testid={`clip-cycle-notch-${track.id}-${idx}-${cIdx}`}
                                    style={{
                                      left: `${(offsetSec / totalDur) * 100}%`,
                                    }}
                                    className="pointer-events-none absolute top-0 bottom-0 border-l-2 border-frost/75 z-10"
                                  />
                                ))}
                              </>
                            );
                          })()}

                        {/* Visual Fade-In / Fade-Out Envelope SVG */}
                        {!isMusicClip && (
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
                        )}

                        {/* Left Trim / Stretch Handle */}
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
                              initialClientX: Number.isFinite(e.clientX)
                                ? e.clientX
                                : 0,
                              initialStartSec: clip.start_sec,
                              initialDurationSec: clip.duration_sec,
                              initialFadeInSec: clip.fade_in_sec,
                              initialFadeOutSec: clip.fade_out_sec,
                              naturalCycleSec: effectiveCycleSec,
                            });
                          }}
                          title={
                            stretchToolActive
                              ? "Drag to time-stretch clip start"
                              : "Drag to trim clip start"
                          }
                          className={`w-2 shrink-0 cursor-ew-resize z-10 ${
                            stretchToolActive
                              ? "bg-amber-400/80 hover:bg-amber-300"
                              : "bg-ember/60 hover:bg-ember"
                          }`}
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
                              initialClientX: Number.isFinite(e.clientX)
                                ? e.clientX
                                : 0,
                              initialStartSec: clip.start_sec,
                              initialDurationSec: clip.duration_sec,
                              initialFadeInSec: clip.fade_in_sec,
                              initialFadeOutSec: clip.fade_out_sec,
                            });
                          }}
                          title="Drag to adjust Fade In"
                          className="absolute top-0 left-2 w-2.5 h-2.5 bg-frost/80 hover:bg-ember rounded-br cursor-e-resize z-20"
                        />

                        {/* Draggable Clip Body (Alt+Drag duplicates!) */}
                        <div
                          data-testid={`clip-body-${track.id}-${idx}`}
                          onPointerDown={(e: ReactPointerEvent) => {
                            e.stopPropagation();
                            setSelectedClip({
                              trackId: track.id,
                              clipIndex: idx,
                            });
                            setClipDragState({
                              mode: e.altKey ? "duplicate_move" : "move",
                              trackId: track.id,
                              clipIndex: idx,
                              initialClientX: Number.isFinite(e.clientX)
                                ? e.clientX
                                : 0,
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
                              background: isMusicClip
                                ? "#38BDF8"
                                : colors
                                  ? `linear-gradient(90deg, ${colors[0]}, ${sampleOklabGradientHex(
                                      colors[0],
                                      colors[1],
                                      0.5,
                                    )}, ${colors[1]})`
                                  : "#2255AA",
                            }}
                          />
                          <div className="flex items-center justify-between gap-1 text-[10px] font-mono text-frost bg-void/60 rounded px-1">
                            {isMusicClip ? (
                              <span className="truncate">
                                [MUSIC] {clip.audio_file} (
                                {clip.duration_sec.toFixed(1)}s
                                {clipAudioAnalysis
                                  ? ` · ${Math.round(clipAudioAnalysis.estimated_bpm)} BPM`
                                  : ""}
                                )
                              </span>
                            ) : (
                              (() => {
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
                                const cycleBadge =
                                  clip.time_stretch && naturalCycleSec > 0.05
                                    ? `${(effectiveCycleSec / naturalCycleSec).toFixed(2)}× (${effectiveCycleSec.toFixed(1)}s/cyc)`
                                    : effectiveCycleSec > 0.05
                                      ? `${effectiveCycleSec.toFixed(1)}s/cyc`
                                      : `${clip.duration_sec.toFixed(1)}s`;
                                return (
                                  <span className="truncate">
                                    [{tag}] {label} ({cycleBadge})
                                  </span>
                                );
                              })()
                            )}
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
                              initialClientX: Number.isFinite(e.clientX)
                                ? e.clientX
                                : 0,
                              initialStartSec: clip.start_sec,
                              initialDurationSec: clip.duration_sec,
                              initialFadeInSec: clip.fade_in_sec,
                              initialFadeOutSec: clip.fade_out_sec,
                            });
                          }}
                          title="Drag to adjust Fade Out"
                          className="absolute top-0 right-2 w-2.5 h-2.5 bg-frost/80 hover:bg-ember rounded-bl cursor-w-resize z-20"
                        />

                        {/* Right Trim / Stretch Handle */}
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
                              initialClientX: Number.isFinite(e.clientX)
                                ? e.clientX
                                : 0,
                              initialStartSec: clip.start_sec,
                              initialDurationSec: clip.duration_sec,
                              initialFadeInSec: clip.fade_in_sec,
                              initialFadeOutSec: clip.fade_out_sec,
                              naturalCycleSec: effectiveCycleSec,
                            });
                          }}
                          title={
                            stretchToolActive
                              ? "Drag to time-stretch clip end"
                              : "Drag to trim clip end"
                          }
                          className={`w-2 shrink-0 cursor-ew-resize z-10 ${
                            stretchToolActive
                              ? "bg-amber-400/80 hover:bg-amber-300"
                              : "bg-ember/60 hover:bg-ember"
                          }`}
                        />
                      </div>
                    );
                  })}

                  {/* Live Cross-Track or Alt+Drag Duplicate Preview inside Target Lane */}
                  {(() => {
                    const ov = localClipOverrideRef.current;
                    if (!ov) return null;
                    const showPreviewHere =
                      (ov.isDuplicate && (ov.targetTrackId ?? ov.trackId) === track.id) ||
                      (!ov.isDuplicate &&
                        ov.targetTrackId === track.id &&
                        ov.trackId !== track.id);
                    if (!showPreviewHere) return null;
                    const srcClip = currentTimeline.tracks.find(
                      (t) => t.id === ov.trackId,
                    )?.clips[ov.clipIndex];
                    if (!srcClip) return null;
                    const clip = { ...srcClip, ...ov.patch };
                    const leftPct = (clip.start_sec / viewportDurationSec) * 100;
                    const widthPct =
                      (clip.duration_sec / viewportDurationSec) * 100;
                    const label =
                      clip.audio_file ??
                      showState.scenes.find(
                        (s) =>
                          clip.ref_block && s.block_refs.includes(clip.ref_block),
                      )?.name ??
                      clip.ref_block ??
                      "Clip";
                    return (
                      <div
                        data-testid="timeline-clip-drag-preview"
                        style={{
                          left: `${Math.max(0, leftPct)}%`,
                          width: `${widthPct}%`,
                          minWidth: "4px",
                        }}
                        className="pointer-events-none absolute top-1 bottom-1 rounded border-2 border-frost ring-2 ring-cyan-400 bg-slate/90 shadow-[0_0_12px_rgba(34,211,238,0.45)] px-1.5 py-0.5 flex items-center z-20"
                      >
                        <span className="truncate text-[10px] font-mono text-frost">
                          {ov.isDuplicate ? "+ Copy: " : ""}
                          {label} ({clip.start_sec.toFixed(2)}s ·{" "}
                          {clip.duration_sec.toFixed(2)}s)
                        </span>
                      </div>
                    );
                  })()}
                </div>
              ))}

              {/* Drop Zone Below Last Track */}
              <div
                data-testid="timeline-new-track-dropzone"
                onDragOver={(e: DragEvent<HTMLDivElement>) => {
                  e.preventDefault();
                  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(e: DragEvent<HTMLDivElement>) => {
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const vw = rect.width > 10 ? rect.width : viewportWidthPx;
                  const frac =
                    rect.width > 10 && Number.isFinite(e.clientX)
                      ? Math.max(0, Math.min(1, (e.clientX - rect.left) / vw))
                      : displayPlayheadSec / Math.max(0.1, viewportDurationSec);
                  const dropSec = Number((frac * viewportDurationSec).toFixed(3));

                  const droppedFile = e.dataTransfer?.files?.[0];
                  if (droppedFile) {
                    setDraggingSceneId(null);
                    void dropAudioFileToTrack(droppedFile, "__new__", dropSec);
                    return;
                  }
                  const sid =
                    e.dataTransfer?.getData("text/takt-scene-id") ||
                    e.dataTransfer?.getData("text/plain") ||
                    draggingSceneId ||
                    paletteSelectedSceneId;
                  setDraggingSceneId(null);
                  if (!sid) return;
                  void dropSceneToTrack(sid, "__new__", dropSec);
                }}
                className={`relative h-10 shrink-0 border-t border-dashed flex items-center justify-center font-mono text-[10px] overflow-hidden transition-colors ${
                  localClipOverrideRef.current?.targetTrackId === "__new__"
                    ? "border-ember bg-ember/15 text-frost font-semibold"
                    : "border-steel/60 bg-ink/40 text-fog hover:border-ember hover:text-mist"
                }`}
              >
                Drop Scene or Audio file (MP3, WAV, OGG, FLAC) here to create a new track
              </div>
            </div>
          </div>
        </div>
      </section>

      {trackContextMenu && (
        <div
          data-testid={`track-context-menu-${trackContextMenu.trackId}`}
          onClick={(e) => e.stopPropagation()}
          style={{ left: trackContextMenu.x, top: trackContextMenu.y }}
          className="fixed z-50 bg-slate-dark border border-steel rounded shadow-2xl py-1 min-w-[180px] font-mono text-xs"
        >
          <button
            type="button"
            onClick={() => {
              void switchTrackType(trackContextMenu.trackId, "effect");
              setTrackContextMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left text-mist hover:bg-ink"
          >
            Set Type: Effect Track
          </button>
          <button
            type="button"
            onClick={() => {
              void switchTrackType(trackContextMenu.trackId, "music");
              setTrackContextMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left text-mist hover:bg-ink"
          >
            Set Type: Music Track
          </button>
          <button
            type="button"
            onClick={() => {
              void switchTrackType(trackContextMenu.trackId, "untyped");
              setTrackContextMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left text-fog hover:bg-ink border-t border-steel/50"
          >
            Set Type: Untyped
          </button>
        </div>
      )}
    </div>
  );
}
