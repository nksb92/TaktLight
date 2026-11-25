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
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type DecodedAudioAsset,
  decodeAudioFile,
  extractAudioFileName,
  getDecodedAudioAsset,
  timelineAudioPlayer,
} from "../lib/audioEngine";
import {
  type AudioAnalysisResult,
  type ClipDef,
  computeBeatGridMarkers,
  computeSceneSequenceDurationSec,
  type FxElementDef,
  sampleOklabGradientHex,
  type TimelineDef,
  type TrackDef,
  type TrackType,
} from "../lib/mixerLogic";
import {
  applySingleTrackOverwrite,
  type AutoFillCadence,
  buildTimelineSnapTargets,
  clampTrimEndNonOverlapping,
  clampTrimStartNonOverlapping,
  computeEffectCycleBoundaries,
  computeSnapThresholdSec,
  computeTimelineContentDurationSec,
  computeTimelineViewportDurationSec,
  computeZoomAdaptiveRulerTicks,
  ensureTrailingEmptyTrack,
  secToGridBeats,
  selectAutoFillHitTimes,
  type SnapGridSubdivision,
  type SnapTarget,
  snapTimeSecToTargets,
} from "../lib/timelineLogic";
import { isTauriEnvironment, useTaktStore } from "../store/useTaktStore";
import { HelpTooltip } from "./HelpTooltip";
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

function quantizeWaveformBackingWidth(clipWidthPx: number, dpr: number): number {
  const safeWidth = Number.isFinite(clipWidthPx) ? clipWidthPx : 64;
  const desired = Math.max(64, Math.round(safeWidth * dpr));
  // Power-of-2 buckets (256..8192) let the GPU scale smoothly during zooming
  // without wiping/reallocating the canvas texture on every single zoom step.
  const pow2 = 1 << Math.ceil(Math.log2(desired));
  return Math.min(8192, Math.max(256, pow2));
}

const ClipWaveformCanvas = memo(function ClipWaveformCanvas({
  audioFile,
  analysis,
  clipDurationSec,
  backingWidthPx,
  showTransients,
  showKicks = true,
  showSnares = true,
  testId,
}: {
  audioFile: string;
  analysis?: AudioAnalysisResult;
  clipDurationSec: number;
  backingWidthPx: number;
  showTransients: boolean;
  showKicks?: boolean;
  showSnares?: boolean;
  testId: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
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
    const cssH = 48;
    const backingW = Math.max(32, Math.min(8192, Math.round(backingWidthPx)));
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
      // Sample directly from decoded PCM at quantized backing-pixel resolution (batched path fills)
      const visibleSamples = Math.min(
        monoPcm.length,
        Math.max(1, Math.round(clipDurationSec * asset.sampleRate)),
      );
      const samplesPerCol = visibleSamples / backingW;

      const rmsBars: Array<[number, number, number]> = [];

      ctx.fillStyle = "rgba(56, 189, 248, 0.48)";
      ctx.beginPath();
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
        ctx.rect(x, yTop, 1, h);

        const rms = Math.sqrt(sumSq / count);
        const rmsH = Math.max(1, Math.round(rms * halfH * 2));
        rmsBars.push([x, Math.round(midY - rmsH / 2), rmsH]);
      }
      ctx.fill();

      ctx.fillStyle = "rgba(125, 211, 252, 0.85)";
      ctx.beginPath();
      for (const [x, y, h] of rmsBars) {
        ctx.rect(x, y, 1, h);
      }
      ctx.fill();
    } else if (analysis && analysis.waveform_peaks.length > 0) {
      const peaks = analysis.waveform_peaks;
      const assetDur = Math.max(0.05, analysis.duration_sec || clipDurationSec);
      const visibleFrac = Math.min(1, clipDurationSec / assetDur);
      const visibleCount = Math.max(1, Math.floor(peaks.length * visibleFrac));

      ctx.fillStyle = "rgba(56, 189, 248, 0.65)";
      ctx.beginPath();
      for (let x = 0; x < backingW; x++) {
        const pIdx = Math.min(
          visibleCount - 1,
          Math.floor((x / backingW) * visibleCount),
        );
        const pk = peaks[pIdx];
        if (!pk) continue;
        const yTop = Math.floor(midY - Math.max(0, pk.max) * halfH);
        const yBot = Math.ceil(midY - Math.min(0, pk.min) * halfH);
        ctx.rect(x, yTop, 1, Math.max(1, yBot - yTop));
      }
      ctx.fill();
    }

    // Crisp color-coded transient tick markers (Amber = Kick, Cyan = Snare)
    if (showTransients && analysis && analysis.transients.length > 0) {
      const pipH = Math.max(4, Math.round(backingH * 0.24));
      const kickW = Math.max(1, Math.round(dpr));
      const snareH = Math.round(pipH * 0.65);

      if (showKicks) {
        ctx.fillStyle = "rgba(245, 158, 11, 0.95)";
        ctx.beginPath();
        for (const m of analysis.transients) {
          if (m.band !== "kick" || m.time_sec > clipDurationSec) continue;
          const x = Math.round(
            (m.time_sec / Math.max(0.05, clipDurationSec)) * backingW,
          );
          ctx.rect(x, 0, kickW, pipH);
          ctx.rect(x, backingH - pipH, kickW, pipH);
        }
        ctx.fill();
      }

      if (showSnares) {
        ctx.fillStyle = "rgba(34, 211, 238, 0.65)";
        ctx.beginPath();
        for (const m of analysis.transients) {
          if (m.band !== "snare" || m.time_sec > clipDurationSec) continue;
          const x = Math.round(
            (m.time_sec / Math.max(0.05, clipDurationSec)) * backingW,
          );
          ctx.rect(x, backingH - snareH, 1, snareH);
        }
        ctx.fill();
      }
    }
  }, [
    audioFile,
    analysis,
    clipDurationSec,
    backingWidthPx,
    showTransients,
    showKicks,
    showSnares,
  ]);

  return (
    <canvas
      ref={canvasRef}
      data-testid={testId}
      className="pointer-events-none absolute inset-0 w-full h-full"
    />
  );
});

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
  const bankColors = useTaktStore((s) => s.bankColors);
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
  const showBeats = useTaktStore((s) => s.timelineShowBeats);
  const setShowBeats = useTaktStore((s) => s.setTimelineShowBeats);
  const showKicks = useTaktStore((s) => s.timelineShowKicks);
  const setShowKicks = useTaktStore((s) => s.setTimelineShowKicks);
  const showSnares = useTaktStore((s) => s.timelineShowSnares);
  const setShowSnares = useTaktStore((s) => s.setTimelineShowSnares);
  const canUndo = useTaktStore((s) => s.canUndo);
  const canRedo = useTaktStore((s) => s.canRedo);

  const upsertTimeline = useTaktStore((s) => s.upsertTimeline);
  const upsertFxBlock = useTaktStore((s) => s.upsertFxBlock);
  const upsertScene = useTaktStore((s) => s.upsertScene);
  const setTimelineTransport = useTaktStore((s) => s.setTimelineTransport);
  const setClipAudioAnalysis = useTaktStore((s) => s.setClipAudioAnalysis);
  const pickNativeAudioFile = useTaktStore((s) => s.pickNativeAudioFile);
  const loadAudioFileFromPath = useTaktStore((s) => s.loadAudioFileFromPath);
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
  const [kicksPopoverOpen, setKicksPopoverOpen] = useState(false);
  const [kicksSelectedBlockId, setKicksSelectedBlockId] = useState<string>("");
  const [kicksTriggerBand, setKicksTriggerBand] = useState<
    "kick" | "snare" | "beat"
  >("kick");
  const [kicksAutoDuration, setKicksAutoDuration] = useState(true);
  const [kicksCustomDurationSec, setKicksCustomDurationSec] = useState(0.2);
  const [kicksTrackMode, setKicksTrackMode] = useState<"update" | "new">(
    "update",
  );
  const [kicksCadence, setKicksCadence] = useState<AutoFillCadence>(1);
  const [kicksCadenceOffset, setKicksCadenceOffset] = useState<number>(0);
  const [kicksCountMode, setKicksCountMode] = useState<
    "all" | "4" | "8" | "16" | "32" | "custom"
  >("all");
  const [kicksCustomCount, setKicksCustomCount] = useState<number>(8);
  const kicksPopoverRef = useRef<HTMLDivElement | null>(null);
  const [timelineNotice, setTimelineNotice] = useState<string | null>(null);
  const [trackContextMenu, setTrackContextMenu] = useState<{
    trackId: string;
    x: number;
    y: number;
  } | null>(null);
  const [displayPlayheadSec, setDisplayPlayheadSec] = useState(
    timelinePlayheadSec,
  );
  const livePlayheadSecRef = useRef<number>(timelinePlayheadSec);
  livePlayheadSecRef.current = timelinePlaying
    ? livePlayheadSecRef.current
    : displayPlayheadSec;

  const musicInputRef = useRef<HTMLInputElement | null>(null);
  const lanesScrollRef = useRef<HTMLDivElement | null>(null);
  const trackHeaderColRef = useRef<HTMLDivElement | null>(null);
  const lanesViewportRef = useRef<HTMLDivElement | null>(null);
  const playheadLineRef = useRef<HTMLDivElement | null>(null);
  const playheadHitboxRef = useRef<HTMLDivElement | null>(null);
  const playheadHandleRef = useRef<HTMLDivElement | null>(null);
  const playheadInputRef = useRef<HTMLInputElement | null>(null);
  const lastPlayheadInputSyncMsRef = useRef<number>(0);
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
  const activeSnapGuideRef = useRef<SnapTarget | null>(null);
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

  // Activate the viewed timeline immediately on mount or switch so it outputs at the playhead before Play is pressed
  useEffect(() => {
    if (!currentTimeline) return;
    const state = useTaktStore.getState();
    if (state.activeTimelineId !== currentTimeline.id && !state.timelinePlaying) {
      void setTimelineTransport(
        currentTimeline.id,
        false,
        state.activeTimelineId === null ? state.timelinePlayheadSec : 0,
      );
    }
  }, [currentTimeline?.id, setTimelineTransport]);

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
  const timelineZoomRef = useRef(timelineZoom);
  timelineZoomRef.current = timelineZoom;
  const viewportDurationSecRef = useRef(viewportDurationSec);
  viewportDurationSecRef.current = viewportDurationSec;
  const viewportWidthPxRef = useRef(viewportWidthPx);
  viewportWidthPxRef.current = viewportWidthPx;
  const pendingZoomAnchorRef = useRef<{
    timeSec: number;
    anchorOffsetX: number;
  } | null>(null);

  const effectiveBpm =
    currentTimeline?.tempo_map[0]?.bpm ?? (showState.bpm > 0 ? showState.bpm : 120);
  const gridOffsetSec = currentTimeline?.grid_offset_sec ?? 0;
  const secToBeats = useCallback(
    (sec: number) => secToGridBeats(sec, effectiveBpm, gridOffsetSec),
    [effectiveBpm, gridOffsetSec],
  );

  // Keep selectedClip valid when set; null means explicitly deselected (no clip highlighted)
  const resolvedSelectedClip = useMemo(() => {
    if (!currentTimeline || !selectedClip) return null;
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
    return null;
  }, [currentTimeline, selectedClip]);

  // Smooth 60fps playhead interpolation + auto-follow scroll (direct DOM ref updates: 0 React re-renders during playback)
  useEffect(() => {
    const syncPlayheadDom = (sec: number, nowMs: number, forceInput: boolean) => {
      livePlayheadSecRef.current = sec;
      const pct = Math.max(
        0,
        Math.min(100, (sec / Math.max(0.1, viewportDurationSec)) * 100),
      );
      const leftCss = `${pct}%`;
      if (playheadLineRef.current) {
        playheadLineRef.current.style.left = leftCss;
      }
      if (playheadHitboxRef.current) {
        playheadHitboxRef.current.style.left = leftCss;
      }
      if (playheadHandleRef.current) {
        playheadHandleRef.current.style.left = leftCss;
        const gridOff = currentTimeline?.grid_offset_sec ?? 0;
        const bpm = currentTimeline?.tempo_map[0]?.bpm ?? showState.bpm ?? 120;
        playheadHandleRef.current.textContent =
          timeUnit === "beats"
            ? `${secToGridBeats(sec, bpm, gridOff).toFixed(1)}b (${sec.toFixed(2)}s)`
            : `${sec.toFixed(2)}s`;
      }
      if (
        playheadInputRef.current &&
        document.activeElement !== playheadInputRef.current &&
        (forceInput || nowMs - lastPlayheadInputSyncMsRef.current >= 100)
      ) {
        lastPlayheadInputSyncMsRef.current = nowMs;
        playheadInputRef.current.value = String(Number(sec.toFixed(2)));
      }
    };

    if (
      !timelinePlaying ||
      !currentTimeline ||
      activeTimelineId !== currentTimeline.id
    ) {
      if (clipDragState?.mode !== "scrub") {
        livePlayheadSecRef.current = timelinePlayheadSec;
        setDisplayPlayheadSec(timelinePlayheadSec);
        syncPlayheadDom(timelinePlayheadSec, 0, true);
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
          syncPlayheadDom(wrapped, nowMs, true);
          setDisplayPlayheadSec(wrapped);
          void setTimelineTransport(currentTimeline.id, true, wrapped);
          return;
        } else {
          syncPlayheadDom(contentDurationSec, nowMs, true);
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

      syncPlayheadDom(rawHead, nowMs, false);

      // Auto-follow playhead so it stays inside the scrollable viewport
      const scroller = lanesScrollRef.current;
      const headerWidth = trackHeaderColRef.current?.offsetWidth ?? 0;
      const visibleLanesW = scroller ? scroller.clientWidth - headerWidth : 0;
      if (scroller && visibleLanesW > 50) {
        const headX =
          (rawHead / Math.max(0.1, viewportDurationSec)) *
          viewportWidthPxRef.current;
        const leftEdge = scroller.scrollLeft;
        const rightEdge = leftEdge + visibleLanesW;
        const margin = Math.min(80, visibleLanesW * 0.15);
        if (headX > rightEdge - margin || headX < leftEdge) {
          scroller.scrollLeft = Math.max(0, headX - visibleLanesW * 0.25);
        }
      }

      if (typeof requestAnimationFrame === "function") {
        rafId = requestAnimationFrame(step);
      }
    };

    if (typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(step);
    } else {
      syncPlayheadDom(timelinePlayheadSec, 0, true);
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
    showState.bpm,
    showState.scenes,
    timeUnit,
    timelinePlayheadAnchorMs,
    timelinePlayheadSec,
    timelinePlaying,
    viewportDurationSec,
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

    const expectedStoreHead =
      timelinePlayheadSec + Math.max(0, (nowMs - timelinePlayheadAnchorMs) / 1000);
    const predictedSec = prev.playing
      ? prev.anchorHeadSec + Math.max(0, (nowMs - prev.anchorMs) / 1000)
      : -1;
    const drift = Math.abs(predictedSec - expectedStoreHead);

    if (
      !prev.playing ||
      prev.timelineId !== currentTimeline.id ||
      drift > 0.15
    ) {
      timelineAudioPlayer.startFrom(expectedStoreHead, currentTimeline.tracks);
      audioPlayingStateRef.current = {
        playing: true,
        timelineId: currentTimeline.id,
        anchorHeadSec: expectedStoreHead,
        anchorMs: nowMs,
      };
    }
  }, [
    activeTimelineId,
    currentTimeline,
    timelinePlayheadAnchorMs,
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

  const snapThresholdSec = computeSnapThresholdSec(pxPerSec, 10);
  const scrubSnapThresholdSec = computeSnapThresholdSec(pxPerSec, 8);

  const baseSnapTargets = useMemo(() => {
    return buildTimelineSnapTargets({
      viewportDurationSec,
      effectiveBpm,
      gridOffsetSec,
      snapGrid,
      showBeats,
      showKicks,
      showSnares,
      transients: timelineTransients,
      tracks: currentTimeline?.tracks ?? [],
      excludeClip: null,
    });
  }, [
    currentTimeline,
    effectiveBpm,
    gridOffsetSec,
    showBeats,
    showKicks,
    showSnares,
    snapGrid,
    timelineTransients,
    viewportDurationSec,
  ]);

  const excludeDraggedClip = useMemo(() => {
    if (
      !clipDragState ||
      !clipDragState.trackId ||
      clipDragState.clipIndex === undefined
    ) {
      return null;
    }
    if (
      clipDragState.mode === "move" ||
      clipDragState.mode === "trim_start" ||
      clipDragState.mode === "trim_end"
    ) {
      return {
        trackId: clipDragState.trackId,
        clipIndex: clipDragState.clipIndex,
      };
    }
    return null;
  }, [clipDragState]);

  const dragSnapTargets = useMemo(() => {
    if (!excludeDraggedClip) return baseSnapTargets;
    return buildTimelineSnapTargets({
      viewportDurationSec,
      effectiveBpm,
      gridOffsetSec,
      snapGrid,
      showBeats,
      showKicks,
      showSnares,
      transients: timelineTransients,
      tracks: currentTimeline?.tracks ?? [],
      excludeClip: excludeDraggedClip,
    });
  }, [
    baseSnapTargets,
    currentTimeline,
    effectiveBpm,
    excludeDraggedClip,
    gridOffsetSec,
    showBeats,
    showKicks,
    showSnares,
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
      const seqEl = blk.elements.find(
        (el): el is Extract<FxElementDef, { kind: "scene_sequence" }> =>
          el.kind === "scene_sequence",
      );
      if (seqEl && seqEl.steps.length > 0) {
        return computeSceneSequenceDurationSec(seqEl.steps, effectiveBpm);
      }
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
      ensureFreeTrackBelow = false,
    ) => {
      if (!currentTimeline) return;
      const finalTracks = ensureFreeTrackBelow
        ? ensureTrailingEmptyTrack(nextTracks)
        : nextTracks;
      const nextContentDur = computeTimelineContentDurationSec(finalTracks);
      await upsertTimeline(
        {
          ...currentTimeline,
          ...extraPatch,
          duration_sec: Math.max(32, nextContentDur),
          tracks: finalTracks,
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
        const lastTrack = currentTimeline.tracks[currentTimeline.tracks.length - 1];
        const trailingEmptyTrack =
          lastTrack &&
          lastTrack.id !== trackId &&
          lastTrack.clips.length === 0 &&
          (lastTrack.track_type ?? "untyped") === "untyped"
            ? lastTrack
            : null;
        if (trailingEmptyTrack) {
          const nextTracks = currentTimeline.tracks.map((tr) => {
            if (tr.id === trackId && !isDuplicate) {
              return { ...tr, clips: tr.clips.filter((_, idx) => idx !== clipIndex) };
            }
            if (tr.id === trailingEmptyTrack.id) {
              return {
                ...tr,
                track_type: clipType,
                target_group: clipType === "music" ? null : "all",
                clips: [{ ...movedClip, start_sec: safeStart }],
              };
            }
            return tr;
          });
          void saveTimelineTracks(nextTracks, coalesceKey, undefined, true);
          setSelectedClip({ trackId: trailingEmptyTrack.id, clipIndex: 0 });
          return;
        }
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
        void saveTimelineTracks(nextTracks, coalesceKey, undefined, true);
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
        void saveTimelineTracks(nextTracks, coalesceKey, undefined, true);
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
        const snapRes = magneticSnap
          ? snapTimeSecToTargets(rawSec, baseSnapTargets, scrubSnapThresholdSec)
          : { time_sec: Number(rawSec.toFixed(3)), snappedTo: null };
        activeSnapGuideRef.current = snapRes.snappedTo;
        const sec = snapRes.time_sec;
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
        const snapRes = magneticSnap
          ? snapTimeSecToTargets(rawStart, dragSnapTargets, snapThresholdSec)
          : { time_sec: Number(rawStart.toFixed(3)), snappedTo: null };
        activeSnapGuideRef.current = snapRes.snappedTo;
        const snappedStart = snapRes.time_sec;

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
        const snapRes = magneticSnap
          ? snapTimeSecToTargets(rawStart, dragSnapTargets, snapThresholdSec)
          : { time_sec: Number(rawStart.toFixed(6)), snappedTo: null };
        activeSnapGuideRef.current = snapRes.snappedTo;
        const snappedStart = snapRes.time_sec;
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
        const snapRes = magneticSnap
          ? snapTimeSecToTargets(rawEnd, dragSnapTargets, snapThresholdSec)
          : { time_sec: Number(rawEnd.toFixed(6)), snappedTo: null };
        activeSnapGuideRef.current = snapRes.snappedTo;
        const snappedEnd = snapRes.time_sec;
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
      activeSnapGuideRef.current = null;

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
      if (ov) {
        // Hold optimistic override until store commits the new timeline (prevents drop flicker)
        pendingCommitTimelineRef.current = currentTimeline;
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
      activeSnapGuideRef.current = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
    };
  }, [
    baseSnapTargets,
    clipDragState,
    commitClipUpdate,
    currentTimeline,
    dragSnapTargets,
    magneticSnap,
    scrubSnapThresholdSec,
    setTimelineTransport,
    snapThresholdSec,
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
    sourceDurationSec?: number,
  ) => {
    const blockToUse = overrideBlockRef || effectiveBlockRef;
    if (!currentTimeline || !trackId || !blockToUse) return;
    const snappedStart = magneticSnap
      ? snapTimeSecToTargets(startSec, baseSnapTargets, snapThresholdSec).time_sec
      : startSec;
    const clip: ClipDef = {
      ref_block: blockToUse,
      start_sec: Math.max(0, Number(snappedStart.toFixed(3))),
      duration_sec: Math.max(0.1, Number(durationSec.toFixed(3))),
      fade_in_sec: 0,
      fade_out_sec: 0,
      inline_fx: [],
      ...(sourceDurationSec !== undefined
        ? { source_duration_sec: Number(sourceDurationSec.toFixed(6)) }
        : {}),
    };
    const lastTrack = currentTimeline.tracks[currentTimeline.tracks.length - 1];
    const trailingEmptyTrack =
      lastTrack &&
      lastTrack.clips.length === 0 &&
      (lastTrack.track_type ?? "untyped") === "untyped"
        ? lastTrack
        : null;
    const targetTrack =
      trackId === "__new__"
        ? trailingEmptyTrack
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
      await saveTimelineTracks(
        [...currentTimeline.tracks, newTrack],
        undefined,
        undefined,
        true,
      );
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
      undefined,
      undefined,
      true,
    );
    setSelectedClip({ trackId: targetTrack.id, clipIndex: insertedIndex });
  };

  const insertDecodedAudioClip = async (
    asset: DecodedAudioAsset,
    analysis: AudioAnalysisResult,
    trackId: string,
    atSec: number,
  ) => {
    if (!currentTimeline) return;
    setClipAudioAnalysis(asset.key, analysis, currentTimeline.id);

    const hasExistingMusic = currentTimeline.tracks.some((tr) =>
      tr.clips.some((c) => Boolean(c.audio_file)),
    );
    const snappedStart = magneticSnap
      ? snapTimeSecToTargets(atSec, baseSnapTargets, snapThresholdSec).time_sec
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

    const lastTrack = currentTimeline.tracks[currentTimeline.tracks.length - 1];
    const trailingEmptyTrack =
      lastTrack &&
      lastTrack.clips.length === 0 &&
      (lastTrack.track_type ?? "untyped") === "untyped"
        ? lastTrack
        : null;
    const targetTrack =
      trackId === "__new__"
        ? trailingEmptyTrack
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
      await saveTimelineTracks(
        [...currentTimeline.tracks, newTrack],
        undefined,
        {
          tempo_map: syncedTempoMap,
          grid_offset_sec: syncedOffset,
        },
        true,
      );
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
        true,
      );
      setSelectedClip({ trackId: targetTrack.id, clipIndex: insertedIndex });
    }
  };

  const dropAudioFileToTrack = async (
    file: File,
    trackId: string,
    atSec: number,
  ) => {
    if (!currentTimeline) return;
    setTimelineNotice(null);
    const { asset, analysis } = await decodeAudioFile(file, sensitivity);
    await insertDecodedAudioClip(asset, analysis, trackId, atSec);
  };

  const handleAddMusicClick = async () => {
    if (!currentTimeline) return;
    if (isTauriEnvironment()) {
      setTimelineNotice(null);
      const pickedPath = await pickNativeAudioFile("Select Music File");
      if (!pickedPath) return;
      try {
        const { asset, analysis } = await loadAudioFileFromPath(
          pickedPath,
          sensitivity,
        );
        await insertDecodedAudioClip(
          asset,
          analysis,
          "__new__",
          displayPlayheadSec,
        );
      } catch (err) {
        setTimelineNotice(
          err instanceof Error
            ? err.message
            : "Failed to load selected audio file.",
        );
      }
      return;
    }
    musicInputRef.current?.click();
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
    durationSec?: number,
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
    const blockDef = showState.fx_library.find((b) => b.id === blockId);
    const seqElem = blockDef?.elements.find(
      (el): el is Extract<FxElementDef, { kind: "scene_sequence" }> =>
        el.kind === "scene_sequence",
    );
    const seqNaturalSec =
      seqElem && seqElem.steps.length > 0
        ? computeSceneSequenceDurationSec(seqElem.steps, effectiveBpm)
        : undefined;
    const resolvedDurationSec =
      durationSec ?? (seqNaturalSec && seqNaturalSec > 0.05 ? seqNaturalSec : clipDurationSec);
    setPaletteSelectedSceneId(sceneId);
    await handleAddClipAt(
      trackId,
      atSec,
      resolvedDurationSec,
      blockId,
      seqNaturalSec && seqNaturalSec > 0.05 ? seqNaturalSec : undefined,
    );
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
    const tSplit = livePlayheadSecRef.current;

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
        setDisplayPlayheadSec(0);
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

  useEffect(() => {
    if (!kicksPopoverOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (
        kicksPopoverRef.current &&
        !kicksPopoverRef.current.contains(e.target as Node)
      ) {
        setKicksPopoverOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setKicksPopoverOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [kicksPopoverOpen]);

  const autoFillSceneOptions = useMemo(() => {
    const opts: Array<{ blockId: string; label: string }> = [];
    const seen = new Set<string>();
    for (const sc of showState.scenes) {
      if (sc.timeline_ref || sc.block_refs.length === 0) continue;
      const blkId = sc.block_refs[0];
      if (!blkId || seen.has(blkId)) continue;
      seen.add(blkId);
      opts.push({
        blockId: blkId,
        label: sc.bank ? `${sc.name} (${sc.bank})` : sc.name,
      });
    }
    for (const blk of showState.fx_library) {
      if (seen.has(blk.id)) continue;
      if (blk.elements.some((el) => el.kind === "scene_sequence")) continue;
      seen.add(blk.id);
      opts.push({ blockId: blk.id, label: blk.name });
    }
    return opts;
  }, [showState.fx_library, showState.scenes]);

  const resolvedKicksBlockId = useMemo(() => {
    if (
      kicksSelectedBlockId &&
      autoFillSceneOptions.some((o) => o.blockId === kicksSelectedBlockId)
    ) {
      return kicksSelectedBlockId;
    }
    if (
      resolvedSelectedClip?.clip.ref_block &&
      autoFillSceneOptions.some(
        (o) => o.blockId === resolvedSelectedClip.clip.ref_block,
      )
    ) {
      return resolvedSelectedClip.clip.ref_block;
    }
    return autoFillSceneOptions[0]?.blockId ?? effectiveBlockRef;
  }, [
    autoFillSceneOptions,
    effectiveBlockRef,
    kicksSelectedBlockId,
    resolvedSelectedClip,
  ]);

  const kicksPreviewTimes = useMemo(() => {
    if (kicksTriggerBand === "beat") {
      return beatGridMarkers;
    }
    const allBand = timelineTransients.filter(
      (m) => m.band === kicksTriggerBand,
    );
    const strong = allBand.filter((m) => m.strength >= 0.35);
    const chosen = strong.length > 0 ? strong : allBand;
    if (chosen.length > 0) {
      return chosen.map((m) => m.time_sec);
    }
    return kicksTriggerBand === "kick"
      ? beatGridMarkers.filter((_, i) => i % 2 === 0)
      : [];
  }, [beatGridMarkers, kicksTriggerBand, timelineTransients]);

  const resolvedKicksMaxCount =
    kicksCountMode === "all"
      ? null
      : kicksCountMode === "custom"
        ? Math.max(1, Math.floor(kicksCustomCount) || 1)
        : Number(kicksCountMode);

  const resolvedKicksHitDur = kicksAutoDuration
    ? Number(
        Math.min(0.25, Math.max(0.1, (60 / Math.max(20, effectiveBpm)) * 0.45)).toFixed(3),
      )
    : Math.max(0.05, Number(kicksCustomDurationSec) || 0.2);

  const resolvedKicksOffset = Math.max(
    0,
    Math.min(kicksCadence - 1, kicksCadenceOffset),
  );

  const kicksFillTimes = useMemo(() => {
    return selectAutoFillHitTimes({
      hitTimes: kicksPreviewTimes,
      startFromSec: displayPlayheadSec,
      cadence: kicksCadence,
      offset: resolvedKicksOffset,
      maxCount: resolvedKicksMaxCount,
      minGapSec: resolvedKicksHitDur,
    });
  }, [
    displayPlayheadSec,
    kicksCadence,
    kicksPreviewTimes,
    resolvedKicksHitDur,
    resolvedKicksMaxCount,
    resolvedKicksOffset,
  ]);

  // Auto-Fill Kicks/Snares/Beats: places the chosen FX scene on detected hits
  const handleAutoPlaceOnKicks = async () => {
    const targetBlockId = resolvedKicksBlockId;
    if (!currentTimeline || !targetBlockId) {
      setTimelineNotice("Create or select an FX scene before filling hits.");
      return;
    }
    if (kicksFillTimes.length === 0) {
      setTimelineNotice(
        kicksPreviewTimes.length === 0
          ? `No ${kicksTriggerBand} markers available. Add/analyze audio or choose Beats.`
          : `No ${kicksTriggerBand} markers found at or after playhead (${displayPlayheadSec.toFixed(2)}s).`,
      );
      return;
    }

    const generated: ClipDef[] = kicksFillTimes.map((t) => ({
      ref_block: targetBlockId,
      start_sec: Number(Math.max(0, t).toFixed(3)),
      duration_sec: resolvedKicksHitDur,
      fade_in_sec: 0,
      fade_out_sec: 0,
      inline_fx: [],
    }));

    const defaultTrackName =
      kicksTriggerBand === "snare"
        ? "Snare Hits"
        : kicksTriggerBand === "beat"
          ? "Beat Hits"
          : "Kick Hits";

    const existingTrack =
      kicksTrackMode === "update"
        ? currentTimeline.tracks.find(
            (t) => t.name === defaultTrackName && t.track_type === "effect",
          )
        : undefined;

    if (existingTrack) {
      let nextTrackClips: ClipDef[];
      if (resolvedKicksMaxCount === null) {
        nextTrackClips = generated;
      } else {
        nextTrackClips = [...existingTrack.clips];
        for (const clip of generated) {
          nextTrackClips = applySingleTrackOverwrite(clip, nextTrackClips).clips;
        }
      }
      await saveTimelineTracks(
        currentTimeline.tracks.map((tr) =>
          tr.id === existingTrack.id ? { ...tr, clips: nextTrackClips } : tr,
        ),
        undefined,
        undefined,
        true,
      );
      setSelectedClip({ trackId: existingTrack.id, clipIndex: 0 });
    } else {
      const newTrackId = `trk_${kicksTriggerBand}_${Date.now()}`;
      const newTrack: TrackDef = {
        id: newTrackId,
        name: defaultTrackName,
        track_type: "effect",
        target_group: "all",
        clips: generated,
      };
      await saveTimelineTracks(
        [...currentTimeline.tracks, newTrack],
        undefined,
        undefined,
        true,
      );
      setSelectedClip({ trackId: newTrackId, clipIndex: 0 });
    }
    setKicksPopoverOpen(false);
    setTimelineNotice(null);
  };

  const requestZoomChange = useCallback(
    (computeNextZoom: (prevZoom: number) => number, anchorOffsetX?: number) => {
      const prevZoom = timelineZoomRef.current;
      const nextZoom = Math.max(
        0.2,
        Math.min(8.0, Number(computeNextZoom(prevZoom).toFixed(2))),
      );
      if (nextZoom === prevZoom) return;

      const scroller = lanesScrollRef.current;
      const viewportEl = lanesViewportRef.current;
      if (scroller) {
        const headerWidth = trackHeaderColRef.current?.offsetWidth ?? 0;
        const visibleLanesW = Math.max(0, scroller.clientWidth - headerWidth);
        const resolvedOffsetX =
          anchorOffsetX !== undefined && Number.isFinite(anchorOffsetX)
            ? anchorOffsetX
            : visibleLanesW / 2;
        const measuredViewportW = viewportEl?.getBoundingClientRect().width ?? 0;
        const curViewportW =
          measuredViewportW > 10
            ? measuredViewportW
            : Math.max(visibleLanesW, viewportWidthPxRef.current);
        const curDur = Math.max(0.1, viewportDurationSecRef.current);
        const timeSec =
          ((scroller.scrollLeft + resolvedOffsetX) / Math.max(1, curViewportW)) *
          curDur;
        pendingZoomAnchorRef.current = {
          timeSec,
          anchorOffsetX: resolvedOffsetX,
        };
      }

      timelineZoomRef.current = nextZoom;
      setTimelineZoom(nextZoom);
    },
    [],
  );

  // Synchronously adjust scrollLeft before browser paint so zooming never flashes 1 frame at the old scroll offset
  useLayoutEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    if (!anchor) return;
    pendingZoomAnchorRef.current = null;

    const scroller = lanesScrollRef.current;
    if (!scroller) return;
    const headerWidth = trackHeaderColRef.current?.offsetWidth ?? 0;
    const visibleLanesW = Math.max(0, scroller.clientWidth - headerWidth);
    const viewportEl = lanesViewportRef.current;
    const measuredW = viewportEl?.getBoundingClientRect().width ?? 0;
    const nextViewportW =
      measuredW > 10 ? measuredW : Math.max(visibleLanesW, viewportWidthPx);
    const curDur = Math.max(0.1, viewportDurationSec);
    scroller.scrollLeft = Math.max(
      0,
      (anchor.timeSec / curDur) * nextViewportW - anchor.anchorOffsetX,
    );
  }, [timelineZoom, viewportWidthPx, viewportDurationSec]);

  // Attach a non-passive wheel listener so Ctrl/Cmd+Wheel cleanly prevents native WebView/browser zoom
  const hasCurrentTimeline = Boolean(currentTimeline);
  useEffect(() => {
    const scroller = lanesScrollRef.current;
    if (!scroller) return;

    const onWheel = (e: globalThis.WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      const rect = scroller.getBoundingClientRect();
      const headerWidth = trackHeaderColRef.current?.offsetWidth ?? 0;
      const visibleLanesW = Math.max(0, scroller.clientWidth - headerWidth);
      const cursorOffsetX = Number.isFinite(e.clientX)
        ? e.clientX - (rect.left + headerWidth)
        : visibleLanesW / 2;
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      requestZoomChange((prevZoom) => prevZoom * factor, cursorOffsetX);
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      scroller.removeEventListener("wheel", onWheel);
    };
  }, [hasCurrentTimeline, requestZoomChange]);

  const scrubFromClientX = (clientX: number) => {
    if (!currentTimeline || !Number.isFinite(clientX)) return;
    const rect = lanesViewportRef.current?.getBoundingClientRect();
    const vw = rect && rect.width > 10 ? rect.width : viewportWidthPx;
    const left = rect?.left ?? 0;
    const frac = Math.max(0, Math.min(1, (clientX - left) / vw));
    const rawSec = frac * viewportDurationSec;
    const sec = magneticSnap
      ? snapTimeSecToTargets(rawSec, baseSnapTargets, scrubSnapThresholdSec).time_sec
      : Number(rawSec.toFixed(3));
    setDisplayPlayheadSec(sec);
    scrubLatestSecRef.current = sec;
    void setTimelineTransport(currentTimeline.id, timelinePlaying, sec);
  };

  const blockColorsById = useMemo(() => {
    const palById = new Map(showState.color_palettes.map((p) => [p.id, p]));
    const map = new Map<string, [string, string]>();
    for (const blk of showState.fx_library) {
      for (const el of blk.elements) {
        if (el.kind === "scene_sequence") continue;
        if (el.palette_ref) {
          const pal = palById.get(el.palette_ref);
          if (pal) {
            map.set(blk.id, [pal.hex_start, pal.hex_end]);
            break;
          }
        }
        if (el.kind === "static_trait" && el.trait === "color" && el.hex_start) {
          map.set(blk.id, [el.hex_start, el.hex_end ?? el.hex_start]);
          break;
        }
      }
    }
    return map;
  }, [showState.color_palettes, showState.fx_library]);

  const ownerSceneByBlockId = useMemo(() => {
    const map = new Map<string, (typeof showState.scenes)[number]>();
    for (const sc of showState.scenes) {
      for (const ref of sc.block_refs) {
        if (!map.has(ref)) {
          map.set(ref, sc);
        }
      }
    }
    return map;
  }, [showState.scenes]);

  const getBlockColors = (blockId: string | null): [string, string] | null => {
    if (!blockId) return null;
    return blockColorsById.get(blockId) ?? null;
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
      {/* Two-Row NLE Toolbar: Row 1 = Transport & View Settings, Row 2 = Editing Tools & Guide Toggles */}
      <div className="shrink-0 bg-slate border-b border-steel flex flex-col">
        {/* Row 1: Identity & Transport (Left) + Display/Zoom/Expand Settings (Right) */}
        <div
          data-testid="timeline-toolbar-row-1"
          className="flex flex-wrap items-center justify-between gap-1.5 px-2.5 py-1 border-b border-steel/60"
        >
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
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

            <span className="h-4 w-px bg-steel/70 mx-0.5" />

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
                ref={playheadInputRef}
                aria-label="Timeline Playhead Sec"
                type="number"
                min={0}
                step={0.1}
                value={Number(displayPlayheadSec.toFixed(2))}
                onChange={(e) => {
                  const next = Number(e.target.value) || 0;
                  livePlayheadSecRef.current = next;
                  setDisplayPlayheadSec(next);
                  void setTimelineTransport(
                    currentTimeline.id,
                    timelinePlaying,
                    next,
                  );
                }}
                className="w-12 bg-ink border border-steel rounded px-1 py-0.5 font-mono text-[10px] text-frost"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-1">
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

            {/* Zoom Controls */}
            <div
              className="flex items-center gap-0.5 bg-ink border border-steel rounded p-0.5 font-mono text-[10px]"
              title="Zoom timeline horizontally (or hold Ctrl + Mousewheel)"
            >
              <button
                type="button"
                data-testid="timeline-zoom-out"
                onClick={() => requestZoomChange((z) => z - 0.25)}
                title="Zoom Out"
                className="p-0.5 text-mist hover:text-ember"
              >
                <ZoomOut className="w-3 h-3" />
              </button>
              <button
                type="button"
                data-testid="timeline-zoom-reset"
                onClick={() => requestZoomChange(() => 1.0)}
                title="Reset Zoom to 1.0x"
                className="px-1 text-frost"
              >
                {timelineZoom.toFixed(1)}×
              </button>
              <button
                type="button"
                data-testid="timeline-zoom-in"
                onClick={() => requestZoomChange((z) => z + 0.5)}
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

        {/* Row 2: Editing Tools (Left) + Independent Guide/Transient Toggles (Right) */}
        <div
          data-testid="timeline-toolbar-row-2"
          className="flex flex-wrap items-center justify-between gap-1.5 px-2.5 py-1 bg-pitch/60"
        >
          <div className="flex flex-wrap items-center gap-1">
            {/* Snap + Snap Grid Subdivision */}
            <div className="flex items-center gap-0.5 rounded border border-steel bg-ink px-1 py-0.5 font-mono text-[10px] text-mist">
              <HelpTooltip text="Magnetically snap clips and playhead to enabled Beat/Transient guides and clip edges.">
                <label className="flex items-center gap-1 cursor-pointer pr-1">
                  <input
                    aria-label="Magnetic Snap"
                    type="checkbox"
                    checked={magneticSnap}
                    onChange={(e) => setMagneticSnap(e.target.checked)}
                  />
                  <Magnet className="w-3 h-3 text-plum" />
                  <span>Snap</span>
                </label>
              </HelpTooltip>
              <select
                aria-label="Snap Grid Subdivision"
                data-testid="timeline-snap-grid-select"
                disabled={!magneticSnap || !showBeats}
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

            <HelpTooltip text="Time-Stretch Tool: dragging a clip's edges stretches or compresses its FX speed to fit instead of looping.">
              <button
                type="button"
                data-testid="timeline-stretch-tool-toggle"
                aria-pressed={stretchToolActive}
                onClick={() => setStretchToolActive((v) => !v)}
                className={`flex items-center gap-1 px-1.5 py-1 rounded border font-mono text-[10px] transition-colors ${
                  stretchToolActive
                    ? "border-ember bg-ember/25 text-frost font-semibold"
                    : "border-steel bg-ink text-fog hover:text-mist"
                }`}
              >
                <MoveHorizontal className="w-3 h-3" />
                <span>Stretch</span>
              </button>
            </HelpTooltip>

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

            {/* Kicks / Auto-Fill Popover */}
            <div ref={kicksPopoverRef} className="relative">
              <button
                type="button"
                data-testid="timeline-auto-place-kicks-btn"
                aria-expanded={kicksPopoverOpen}
                onClick={() => {
                  if (!kicksPopoverOpen && resolvedSelectedClip?.clip.ref_block) {
                    setKicksSelectedBlockId(resolvedSelectedClip.clip.ref_block);
                  }
                  setKicksPopoverOpen((v) => !v);
                }}
                title="Auto-place a chosen Scene/FX on detected Kicks, Snares, or Beats"
                className={`flex items-center gap-1 px-1.5 py-1 rounded border font-mono text-[10px] transition-colors ${
                  kicksPopoverOpen
                    ? "bg-plum/35 border-plum text-frost font-semibold"
                    : "bg-plum/20 border-plum text-frost hover:bg-plum/30"
                }`}
              >
                <Sparkles className="w-3 h-3 text-plum" />
                <span>Kicks ▾</span>
              </button>

              {kicksPopoverOpen && (
                <div
                  data-testid="timeline-kicks-popover"
                  className="absolute left-0 top-full mt-1 z-40 w-72 rounded-md border border-steel bg-slate-dark p-2.5 shadow-2xl font-mono text-[10px] flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between text-frost font-semibold border-b border-steel/60 pb-1">
                    <span>Auto-Fill Hits</span>
                    <span className="text-[9px] text-fog">
                      {kicksFillTimes.length} / {kicksPreviewTimes.length} hits
                    </span>
                  </div>

                  <label className="flex flex-col gap-0.5">
                    <span className="text-fog">Scene / FX Clip</span>
                    <select
                      aria-label="Auto-Fill Scene"
                      value={resolvedKicksBlockId}
                      onChange={(e) => setKicksSelectedBlockId(e.target.value)}
                      className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                    >
                      {autoFillSceneOptions.length === 0 ? (
                        <option value="">No FX scenes available</option>
                      ) : (
                        autoFillSceneOptions.map((opt) => (
                          <option key={opt.blockId} value={opt.blockId}>
                            {opt.label}
                          </option>
                        ))
                      )}
                    </select>
                  </label>

                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="flex flex-col gap-0.5">
                      <span className="text-fog">Trigger On</span>
                      <select
                        aria-label="Auto-Fill Trigger"
                        value={kicksTriggerBand}
                        onChange={(e) =>
                          setKicksTriggerBand(
                            e.target.value as "kick" | "snare" | "beat",
                          )
                        }
                        className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                      >
                        <option value="kick">Kicks</option>
                        <option value="snare">Snares</option>
                        <option value="beat">Beats</option>
                      </select>
                    </label>

                    <label className="flex flex-col gap-0.5">
                      <span className="text-fog">Track Mode</span>
                      <select
                        aria-label="Auto-Fill Track Mode"
                        value={kicksTrackMode}
                        onChange={(e) =>
                          setKicksTrackMode(
                            e.target.value as "update" | "new",
                          )
                        }
                        className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                      >
                        <option value="update">Update Track</option>
                        <option value="new">New Track</option>
                      </select>
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="flex flex-col gap-0.5">
                      <span className="text-fog">Cadence</span>
                      <select
                        aria-label="Auto-Fill Cadence"
                        data-testid="timeline-kicks-cadence-select"
                        value={String(kicksCadence)}
                        onChange={(e) =>
                          setKicksCadence(
                            (Number(e.target.value) as AutoFillCadence) || 1,
                          )
                        }
                        className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                      >
                        <option value="1">Every Hit</option>
                        <option value="2">Every 2nd (1 of 2)</option>
                        <option value="4">Every 4th (1 of 4)</option>
                      </select>
                    </label>

                    <label className="flex flex-col gap-0.5">
                      <span className="text-fog">Fill Count</span>
                      <select
                        aria-label="Auto-Fill Count"
                        data-testid="timeline-kicks-count-select"
                        value={kicksCountMode}
                        onChange={(e) =>
                          setKicksCountMode(
                            e.target.value as
                              | "all"
                              | "4"
                              | "8"
                              | "16"
                              | "32"
                              | "custom",
                          )
                        }
                        className="bg-ink border border-steel rounded px-1.5 py-1 text-xs text-frost"
                      >
                        <option value="all">All</option>
                        <option value="4">4 hits</option>
                        <option value="8">8 hits</option>
                        <option value="16">16 hits</option>
                        <option value="32">32 hits</option>
                        <option value="custom">Custom…</option>
                      </select>
                    </label>
                  </div>

                  {kicksCadence > 1 && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-mist">Hit Position</span>
                      <select
                        aria-label="Auto-Fill Hit Offset"
                        data-testid="timeline-kicks-offset-select"
                        value={String(resolvedKicksOffset)}
                        onChange={(e) =>
                          setKicksCadenceOffset(
                            Math.max(0, Math.floor(Number(e.target.value) || 0)),
                          )
                        }
                        className="w-28 bg-ink border border-steel rounded px-1.5 py-0.5 text-xs text-frost"
                      >
                        {Array.from({ length: kicksCadence }, (_, idx) => {
                          const ord =
                            idx === 0
                              ? "1st"
                              : idx === 1
                                ? "2nd"
                                : idx === 2
                                  ? "3rd"
                                  : "4th";
                          return (
                            <option key={idx} value={String(idx)}>
                              {ord} of {kicksCadence}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  )}

                  {kicksCountMode === "custom" && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-mist">Custom Count</span>
                      <input
                        aria-label="Auto-Fill Custom Count"
                        data-testid="timeline-kicks-custom-count-input"
                        type="number"
                        min={1}
                        max={512}
                        step={1}
                        value={kicksCustomCount}
                        onChange={(e) =>
                          setKicksCustomCount(
                            Math.max(1, Math.floor(Number(e.target.value) || 1)),
                          )
                        }
                        className="w-20 bg-ink border border-steel rounded px-1.5 py-0.5 text-xs text-frost"
                      />
                    </div>
                  )}

                  {resolvedKicksMaxCount !== null && (
                    <div className="text-[9px] text-fog">
                      Counting from playhead ({displayPlayheadSec.toFixed(2)}s) forward
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-1 text-mist cursor-pointer">
                      <input
                        type="checkbox"
                        checked={kicksAutoDuration}
                        onChange={(e) =>
                          setKicksAutoDuration(e.target.checked)
                        }
                        className="accent-plum"
                      />
                      <span>Auto Dur</span>
                    </label>
                    <input
                      aria-label="Auto-Fill Duration"
                      type="number"
                      min={0.05}
                      max={4}
                      step={0.05}
                      disabled={kicksAutoDuration}
                      value={kicksCustomDurationSec}
                      onChange={(e) =>
                        setKicksCustomDurationSec(
                          Math.max(0.05, Number(e.target.value) || 0.2),
                        )
                      }
                      className="w-20 bg-ink border border-steel rounded px-1.5 py-0.5 text-xs text-frost disabled:opacity-40"
                    />
                  </div>

                  <button
                    type="button"
                    data-testid="timeline-kicks-confirm-btn"
                    disabled={
                      !resolvedKicksBlockId || kicksFillTimes.length === 0
                    }
                    onClick={() => void handleAutoPlaceOnKicks()}
                    className="w-full py-1.5 rounded bg-plum hover:bg-plum/90 text-frost font-semibold disabled:opacity-40 transition-colors"
                  >
                    Fill {kicksFillTimes.length}{" "}
                    {kicksFillTimes.length === 1 ? "Hit" : "Hits"}
                  </button>
                </div>
              )}
            </div>

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
              onClick={() => void handleAddMusicClick()}
              title="Add Music Track from Audio File (or drag and drop MP3/WAV/OGG/FLAC onto any track)"
              className="flex items-center gap-1 px-1.5 py-1 rounded border border-steel bg-ink hover:border-cobalt font-mono text-[10px] text-frost"
            >
              <Music className="w-3 h-3 text-cobalt" />
              <span>Music</span>
            </button>
          </div>

          {/* Right: Independent Beat / Kick / Snare Visual & Snap Toggles */}
          <div className="flex items-center gap-1 font-mono text-[10px]">
            <HelpTooltip text="Toggle beat grid lines and beat snapping on/off independently.">
              <button
                type="button"
                data-testid="timeline-toggle-beats"
                aria-pressed={showBeats}
                onClick={() => setShowBeats(!showBeats)}
                className={`px-1.5 py-0.5 rounded border transition-colors ${
                  showBeats
                    ? "bg-slate-dark border-frost/70 text-frost font-semibold"
                    : "bg-ink border-steel text-fog hover:text-mist"
                }`}
              >
                Beats
              </button>
            </HelpTooltip>
            <HelpTooltip text="Toggle Kick transient markers & Kick snapping independently.">
              <button
                type="button"
                data-testid="timeline-toggle-kicks"
                aria-pressed={showKicks}
                onClick={() => setShowKicks(!showKicks)}
                className={`px-1.5 py-0.5 rounded border transition-colors ${
                  showKicks
                    ? "bg-amber-500/20 border-amber-400 text-amber-300 font-semibold"
                    : "bg-ink border-steel text-fog hover:text-mist"
                }`}
              >
                Kicks
              </button>
            </HelpTooltip>
            <HelpTooltip text="Toggle Snare transient markers & Snare snapping independently.">
              <button
                type="button"
                data-testid="timeline-toggle-snares"
                aria-pressed={showSnares}
                onClick={() => setShowSnares(!showSnares)}
                className={`px-1.5 py-0.5 rounded border transition-colors ${
                  showSnares
                    ? "bg-cyan-500/20 border-cyan-400 text-cyan-300 font-semibold"
                    : "bg-ink border-steel text-fog hover:text-mist"
                }`}
              >
                Snares
              </button>
            </HelpTooltip>
          </div>
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

        {/* Single Unified 2D Scroll Viewport (Sticky Track Headers + Sticky Ruler) */}
        <div
          ref={lanesScrollRef}
          data-testid="timeline-scroll-container"
          className="flex-1 min-h-0 overflow-auto bg-pitch"
        >
          <div className="flex min-w-full min-h-full w-max">
            {/* Left Sticky Track Header Column */}
            <div
              ref={trackHeaderColRef}
              className="sticky left-0 z-30 w-36 shrink-0 border-r border-steel bg-slate-dark flex flex-col"
            >
              <div className="sticky top-0 z-40 h-7 border-b border-steel bg-slate-dark px-2 flex items-center justify-between font-mono text-[9px] text-fog shrink-0">
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

          {/* Right Time-Aligned Viewport (Ctrl+Wheel Zoom) */}
          <div
            ref={lanesViewportRef}
            style={{
              width: `${viewportWidthPx}px`,
              minWidth: `${viewportWidthPx}px`,
            }}
            className="relative grow shrink-0 flex flex-col"
          >
              {/* Full-Height Vertical Playhead Cursor */}
              <div
                ref={playheadLineRef}
                data-testid="nle-playhead-line"
                style={{ left: `${playheadPct}%` }}
                className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-ember z-20"
              />

              {/* Active Magnetic Snap Guide Line */}
              {activeSnapGuideRef.current && (
                <div
                  data-testid="timeline-active-snap-guide"
                  data-snap-kind={activeSnapGuideRef.current.kind}
                  style={{
                    left: `${(activeSnapGuideRef.current.time_sec / viewportDurationSec) * 100}%`,
                  }}
                  className={`pointer-events-none absolute top-0 bottom-0 w-0.5 z-30 ${
                    activeSnapGuideRef.current.kind === "snare"
                      ? "bg-cyan-400"
                      : activeSnapGuideRef.current.kind === "kick"
                        ? "bg-amber-400"
                        : activeSnapGuideRef.current.kind === "beat"
                          ? "bg-frost/80"
                          : "bg-plum"
                  }`}
                />
              )}

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
                className={`sticky top-0 z-[25] h-7 shrink-0 border-b border-steel bg-ink select-none ${
                  clipDragState?.mode === "scrub"
                    ? "cursor-ew-resize"
                    : "cursor-pointer"
                }`}
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
                  ref={playheadHitboxRef}
                  style={{ left: `${playheadPct}%` }}
                  className="absolute top-0 bottom-0 w-3 -translate-x-1/2 cursor-ew-resize z-10"
                />
                <div
                  ref={playheadHandleRef}
                  data-testid="timeline-playhead-handle"
                  style={{ left: `${playheadPct}%` }}
                  className="absolute top-0 -translate-x-1/2 px-1 bg-ember text-void font-mono text-[9px] font-bold rounded-b whitespace-nowrap cursor-ew-resize z-20"
                >
                  {timeUnit === "beats"
                    ? `${secToBeats(displayPlayheadSec).toFixed(1)}b (${displayPlayheadSec.toFixed(2)}s)`
                    : `${displayPlayheadSec.toFixed(2)}s`}
                </div>
              </div>

              {/* Track Clip Lanes + Shared Full-Height Beat & Transient Backdrop */}
              <div className="relative flex flex-col bg-void">
                {(showBeats || projectTransients) && (
                  <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
                    {/* Beat Grid Vertical Lines (rendered once across all tracks) */}
                    {showBeats &&
                      beatGridMarkers.map((bt, bIdx) => {
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
                      timelineTransients
                        .filter((m) =>
                          m.band === "kick" ? showKicks : showSnares,
                        )
                        .map((m, mIdx) => (
                          <div
                            key={`tr-${mIdx}`}
                            data-testid={`projected-transient-${m.band}`}
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
                  </div>
                )}

                {currentTimeline.tracks.map((track) => (
                <div
                  key={track.id}
                  data-testid={`track-lane-${track.id}`}
                  data-track-lane-id={track.id}
                  onClick={(e) => {
                    if (e.target === e.currentTarget) {
                      setSelectedClip(null);
                    }
                  }}
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
                        : livePlayheadSecRef.current / Math.max(0.1, viewportDurationSec);
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
                  className="relative z-[1] h-14 shrink-0 border-b border-steel/70 bg-transparent overflow-hidden select-none"
                  title="Double-click or drop a Scene / Audio file here; drag clip to move, Alt+Drag to duplicate, or drag edges to trim/stretch"
                >
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
                    const ownerScene =
                      !isMusicClip && clip.ref_block
                        ? ownerSceneByBlockId.get(clip.ref_block)
                        : undefined;
                    const bankColor = ownerScene?.bank
                      ? bankColors[ownerScene.bank.trim()]
                      : undefined;
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
                          ...(!isMusicClip && bankColor
                            ? {
                                ...(isSelected ? {} : { borderColor: bankColor }),
                                backgroundColor: isSelected
                                  ? `${bankColor}33`
                                  : `${bankColor}20`,
                              }
                            : {}),
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
                            backingWidthPx={quantizeWaveformBackingWidth(
                              (widthPct / 100) * viewportWidthPx,
                              typeof window !== "undefined"
                                ? Math.min(2, window.devicePixelRatio || 1)
                                : 1,
                            )}
                            showTransients={showTransients}
                            showKicks={showKicks}
                            showSnares={showSnares}
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

                        {/* Scene Sequence Step Boundaries, Colors & Labels */}
                        {!isMusicClip &&
                          clip.ref_block &&
                          (() => {
                            const blk = showState.fx_library.find(
                              (b) => b.id === clip.ref_block,
                            );
                            const seqEl = blk?.elements.find(
                              (
                                el,
                              ): el is Extract<
                                FxElementDef,
                                { kind: "scene_sequence" }
                              > => el.kind === "scene_sequence",
                            );
                            if (!seqEl || seqEl.steps.length === 0) return null;
                            const totalDur = Math.max(0.05, clip.duration_sec);
                            const phaseScale =
                              clip.time_stretch &&
                              clip.source_duration_sec &&
                              clip.source_duration_sec > 1e-6 &&
                              clip.duration_sec > 1e-6
                                ? Math.max(
                                    0.01,
                                    clip.source_duration_sec / clip.duration_sec,
                                  )
                                : 1;
                            const secPerBeat = 60 / Math.max(20, effectiveBpm);
                            const stepDurs = seqEl.steps.map((st) =>
                              (st.duration_unit === "seconds"
                                ? Math.max(0.05, st.duration_value)
                                : Math.max(0.05, st.duration_value) *
                                  secPerBeat) / phaseScale,
                            );
                            const order: number[] = [];
                            const n = seqEl.steps.length;
                            if (seqEl.playback_mode === "bounce" && n >= 2) {
                              for (let i = 0; i < n; i++) order.push(i);
                              for (let i = n - 2; i >= 1; i--) order.push(i);
                            } else {
                              for (let i = 0; i < n; i++) order.push(i);
                            }
                            const segments: Array<{
                              startSec: number;
                              endSec: number;
                              stepIdx: number;
                              name: string;
                              color: string;
                            }> = [];
                            let cursor = 0;
                            let ordPos = 0;
                            while (cursor < totalDur - 1e-4 && segments.length < 64) {
                              const stepIdx = order[ordPos];
                              const dur = stepDurs[stepIdx];
                              const segEnd = Math.min(totalDur, cursor + dur);
                              const refScene = showState.scenes.find(
                                (s) => s.id === seqEl.steps[stepIdx].scene_id,
                              );
                              const stColors = refScene?.block_refs[0]
                                ? getBlockColors(refScene.block_refs[0])
                                : null;
                              segments.push({
                                startSec: cursor,
                                endSec: segEnd,
                                stepIdx,
                                name:
                                  refScene?.name ?? seqEl.steps[stepIdx].scene_id,
                                color: stColors ? stColors[0] : "#FF5500",
                              });
                              cursor = segEnd;
                              ordPos += 1;
                              if (ordPos >= order.length) {
                                if (seqEl.playback_mode === "one_shot") break;
                                ordPos = 0;
                              }
                            }
                            return (
                              <div
                                data-testid={`clip-seq-overlay-${track.id}-${idx}`}
                                className="pointer-events-none absolute inset-0 z-[8]"
                              >
                                {segments.map((seg, sIdx) => {
                                  const leftP = (seg.startSec / totalDur) * 100;
                                  const widthP =
                                    ((seg.endSec - seg.startSec) / totalDur) *
                                    100;
                                  return (
                                    <div
                                      key={`seq-seg-${sIdx}`}
                                      style={{
                                        left: `${leftP}%`,
                                        width: `${widthP}%`,
                                      }}
                                      className="absolute top-0 bottom-0 overflow-hidden"
                                    >
                                      <div
                                        className="h-1.5 w-full opacity-90"
                                        style={{ backgroundColor: seg.color }}
                                      />
                                      {sIdx > 0 && (
                                        <div
                                          data-testid={`clip-seq-step-boundary-${track.id}-${idx}-${sIdx}`}
                                          className="absolute left-0 top-0 bottom-0 border-l border-amber-300/80"
                                        />
                                      )}
                                      {widthP >= 10 && (
                                        <span
                                          data-testid={`clip-seq-step-label-${track.id}-${idx}-${sIdx}`}
                                          className="absolute bottom-0.5 left-1 right-1 truncate font-mono text-[8px] text-frost/85 drop-shadow"
                                        >
                                          {seg.name}
                                        </span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
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
                              fill={bankColor ?? "#FF5500"}
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
                          style={
                            !stretchToolActive && !isMusicClip && bankColor
                              ? { backgroundColor: `${bankColor}99` }
                              : undefined
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
                                  : (bankColor ?? "#2255AA"),
                            }}
                          />
                          <div className="flex items-center justify-between gap-1 text-[10px] font-mono text-frost bg-void/60 rounded px-1">
                            {isMusicClip ? (
                              <span
                                className="truncate"
                                title={clip.audio_file ?? undefined}
                              >
                                [MUSIC]{" "}
                                {extractAudioFileName(clip.audio_file ?? "")} (
                                {clip.duration_sec.toFixed(1)}s
                                {clipAudioAnalysis
                                  ? ` · ${Math.round(clipAudioAnalysis.estimated_bpm)} BPM`
                                  : ""}
                                )
                              </span>
                            ) : (
                              (() => {
                                const clipBlock = clip.ref_block
                                  ? showState.fx_library.find(
                                      (b) => b.id === clip.ref_block,
                                    )
                                  : null;
                                const isSequenceBlock = Boolean(
                                  clipBlock?.elements.some(
                                    (e) => e.kind === "scene_sequence",
                                  ),
                                );
                                const firstEl = clipBlock?.elements[0];
                                const mode = isSequenceBlock
                                  ? "sequence"
                                  : ownerScene
                                    ? classifySceneMode(
                                        ownerScene,
                                        showState.fx_library,
                                      )
                                    : firstEl &&
                                        firstEl.kind !== "scene_sequence" &&
                                        firstEl.trait === "color"
                                      ? firstEl.kind === "static_trait"
                                        ? "color"
                                        : "color_anim"
                                      : "effect";
                                const tag =
                                  mode === "sequence"
                                    ? "SEQUENCE"
                                    : mode === "color"
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
                          style={
                            !stretchToolActive && !isMusicClip && bankColor
                              ? { backgroundColor: `${bankColor}99` }
                              : undefined
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
              </div>

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
