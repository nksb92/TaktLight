import {
  Crosshair,
  Magnet,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { type PointerEvent, type WheelEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  computeTargetGizmoBounds,
  DEFAULT_COLOR_PALETTES,
  evaluateSpatialShader2DPhase,
  getPaletteColors,
  linearRgbToSrgbHex,
  resolveGizmoHalfExtents,
  sampleOklabStopsLinear,
} from "../lib/mixerLogic";
import {
  computeOrderU,
  expandTargetRange,
  type GridPos,
  type OrderRuleStr,
} from "../lib/patchLogic";
import { registerCanvasGeometry } from "../lib/testBridge";
import { type CellSelectionPattern, useTaktStore } from "../store/useTaktStore";
import { HelpTooltip } from "./HelpTooltip";
import { NumericSlider } from "./NumericSlider";

const CANVAS_WIDTH = 840;
const CANVAS_HEIGHT = 480;
const VIEW_FIT = 0.84;
const ROTATION_HANDLE_NORM_RADIUS = 0.115;

const GRID_SNAP_PRESETS: Array<{ value: number; label: string }> = [
  { value: 0.01, label: "1% (Fine)" },
  { value: 0.025, label: "2.5%" },
  { value: 0.05, label: "5%" },
  { value: 0.1, label: "10%" },
  { value: 0.2, label: "20% (Coarse)" },
];

/**
 * Compute the rendered bitmap rectangle inside an `object-contain` canvas so
 * pointer coordinates and geometry exports match the visible pixels.
 */
function getCanvasContentRect(canvas: HTMLCanvasElement): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  const scale = Math.min(rect.width / CANVAS_WIDTH, rect.height / CANVAS_HEIGHT);
  const width = CANVAS_WIDTH * scale;
  const height = CANVAS_HEIGHT * scale;
  return {
    left: rect.left + (rect.width - width) * 0.5,
    top: rect.top + (rect.height - height) * 0.5,
    width,
    height,
  };
}

const PATTERN_FILTERS: Array<{
  pattern: CellSelectionPattern;
  label: string;
}> = [
  { pattern: "all", label: "All" },
  { pattern: "1/2", label: "1/2" },
  { pattern: "1/3", label: "1/3" },
  { pattern: "1/4", label: "1/4" },
  { pattern: "invert", label: "Invert" },
  { pattern: "shift_left", label: "Shift ◂" },
  { pattern: "shift_right", label: "Shift ▸" },
];

export function FixtureGrid2D({
  hideUndoRedo = false,
  compact: _compact = false,
}: {
  hideUndoRedo?: boolean;
  compact?: boolean;
}) {
  const showState = useTaktStore((s) => s.showState);
  const compiledCells = useTaktStore((s) => s.compiledCells);
  const cellPreviewRgbd = useTaktStore((s) => s.cellPreviewRgbd);
  const fixtureDetailsCache = useTaktStore((s) => s.fixtureDetailsCache);
  const selectedFixtureInstanceId = useTaktStore(
    (s) => s.selectedFixtureInstanceId,
  );
  const selectedFixtureIds = useTaktStore((s) => s.selectedFixtureIds);
  const selectedSceneId = useTaktStore((s) => s.selectedSceneId);
  const selectedCellIndices = useTaktStore((s) => s.selectedCellIndices);
  const activeGroupFilterId = useTaktStore((s) => s.activeGroupFilterId);
  const canvasOrderRule = useTaktStore((s) => s.canvasOrderRule);
  const activeShaderGizmoBlockId = useTaktStore(
    (s) => s.activeShaderGizmoBlockId,
  );
  const activeScenes = useTaktStore((s) => s.activeScenes);
  const canUndo = useTaktStore((s) => s.canUndo);
  const canRedo = useTaktStore((s) => s.canRedo);

  const toggleSelectFixtureInstance = useTaktStore(
    (s) => s.toggleSelectFixtureInstance,
  );
  const setSelectedFixtureIds = useTaktStore((s) => s.setSelectedFixtureIds);
  const createGroupFromSelectedFixtures = useTaktStore(
    (s) => s.createGroupFromSelectedFixtures,
  );
  const updateFixtureGridPos = useTaktStore((s) => s.updateFixtureGridPos);
  const upsertFxBlock = useTaktStore((s) => s.upsertFxBlock);
  const applyCellSelectionPattern = useTaktStore(
    (s) => s.applyCellSelectionPattern,
  );
  const setSelectedCellIndices = useTaktStore(
    (s) => s.setSelectedCellIndices,
  );
  const toggleCellSelection = useTaktStore((s) => s.toggleCellSelection);
  const clearSelections = useTaktStore((s) => s.clearSelections);
  const gizmoAutoFit = useTaktStore((s) => s.gizmoAutoFit);
  const setGizmoAutoFit = useTaktStore((s) => s.setGizmoAutoFit);
  const setCanvasOrderRule = useTaktStore((s) => s.setCanvasOrderRule);
  const undoShow = useTaktStore((s) => s.undoShow);
  const redoShow = useTaktStore((s) => s.redoShow);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [zoom, setZoom] = useState<number>(1.0);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [snapToGrid, setSnapToGrid] = useState<boolean>(true);
  const [snapStep, setSnapStep] = useState<number>(0.05);
  const [selectionMode, setSelectionMode] = useState<"fixtures" | "cells">(
    "fixtures",
  );
  const [shaderGizmoActive, setShaderGizmoActive] = useState<boolean>(false);
  const [quickGroupName, setQuickGroupName] = useState<string>("Stage Group");
  const [dragRenderTick, setDragRenderTick] = useState<number>(0);
  const dragOverridesRef = useRef<Record<string, GridPos>>({});
  const rafIdRef = useRef<number | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);

  const [gizmoState, setGizmoState] = useState<{
    centerX: number;
    centerY: number;
    directionDeg: number;
    spatialFreq: number;
    boxHalfX: number;
    boxHalfY: number;
  }>({
    centerX: 0.5,
    centerY: 0.5,
    directionDeg: 45,
    spatialFreq: 1.0,
    boxHalfX: 0.2,
    boxHalfY: 0.2,
  });

  const [dragState, setDragState] = useState<
    | {
        fixtureId: string;
        mode: "move" | "rotate";
        startPos: { x: number; y: number };
        initialGridPositions: Record<string, GridPos>;
      }
    | {
        mode: "pan";
        startClient: { x: number; y: number };
        startPan: { x: number; y: number };
      }
    | { mode: "marquee"; startPos: { x: number; y: number } }
    | {
        mode:
          | "shader_center"
          | "shader_angle"
          | "shader_scale"
          | "shader_scale_x"
          | "shader_scale_y";
      }
    | null
  >(null);

  const activeShaderBlock = useMemo(() => {
    const hasShader = (b: { elements: { kind: string }[] } | undefined | null) =>
      Boolean(b && b.elements.some((el) => el.kind === "spatial_shader_2d"));
    if (selectedSceneId) {
      const selScene = showState.scenes.find((s) => s.id === selectedSceneId);
      for (const refId of selScene?.block_refs ?? []) {
        const blk = showState.fx_library.find((b) => b.id === refId);
        if (hasShader(blk)) return blk!;
      }
    }
    if (activeShaderGizmoBlockId) {
      const found = showState.fx_library.find(
        (b) => b.id === activeShaderGizmoBlockId,
      );
      if (hasShader(found)) return found!;
    }
    for (const inst of activeScenes) {
      const actScene = showState.scenes.find((s) => s.id === inst.scene_id);
      for (const refId of actScene?.block_refs ?? []) {
        const blk = showState.fx_library.find((b) => b.id === refId);
        if (hasShader(blk)) return blk!;
      }
    }
    return (
      showState.fx_library.find((b) =>
        b.elements.some((el) => el.kind === "spatial_shader_2d"),
      ) ?? null
    );
  }, [
    activeScenes,
    activeShaderGizmoBlockId,
    selectedSceneId,
    showState.fx_library,
    showState.scenes,
  ]);

  const lastAutoGizmoBlockIdRef = useRef<string | null>(null);
  useEffect(() => {
    const shaderEl = activeShaderBlock?.elements.find(
      (el) => el.kind === "spatial_shader_2d",
    );
    if (shaderEl && shaderEl.kind === "spatial_shader_2d") {
      const [boxHalfX, boxHalfY] = resolveGizmoHalfExtents(
        shaderEl.spatial_freq,
        shaderEl.box_half_x,
        shaderEl.box_half_y,
      );
      setGizmoState({
        centerX: shaderEl.center_x,
        centerY: shaderEl.center_y,
        directionDeg: shaderEl.direction_deg,
        spatialFreq: shaderEl.spatial_freq,
        boxHalfX,
        boxHalfY,
      });
      if (activeShaderBlock && lastAutoGizmoBlockIdRef.current !== activeShaderBlock.id) {
        lastAutoGizmoBlockIdRef.current = activeShaderBlock.id;
        setShaderGizmoActive(true);
      }
    } else {
      lastAutoGizmoBlockIdRef.current = null;
    }
  }, [activeShaderBlock]);

  const selectedFixture = useMemo(
    () =>
      showState.patch.find((f) => f.id === selectedFixtureInstanceId) ??
      null,
    [selectedFixtureInstanceId, showState.patch],
  );

  const fixtureHasColorById = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const fx of showState.patch) {
      const detail = fixtureDetailsCache[fx.profile];
      const mode = detail?.expanded_modes.find((m) => m.name === fx.mode);
      const hasColorCh = mode
        ? mode.channels.some((ch) => ch.role.kind === "color_intensity")
        : true;
      map.set(fx.id, hasColorCh);
    }
    return map;
  }, [fixtureDetailsCache, showState.patch]);

  const selectedFixtureSet = useMemo(
    () => new Set(selectedFixtureIds),
    [selectedFixtureIds],
  );

  const [orderRule, setOrderRule] = useState<OrderRuleStr>(canvasOrderRule);
  const [targetRefInput, setTargetRefInput] = useState<string>(
    selectedFixture ? `${selectedFixture.id}:0..7` : "fx_001:0..7",
  );
  const [hasCustomTargetRef, setHasCustomTargetRef] = useState<boolean>(false);

  const handleOrderChange = (nextRule: OrderRuleStr) => {
    setOrderRule(nextRule);
    setCanvasOrderRule(nextRule);
  };

  useEffect(() => {
    if (!hasCustomTargetRef && selectedFixture) {
      const detail = fixtureDetailsCache[selectedFixture.profile];
      const mode = detail?.expanded_modes.find(
        (m) => m.name === selectedFixture.mode,
      );
      const count = mode?.cells.length ?? 1;
      const last = Math.max(0, count - 1);
      setTargetRefInput(
        last > 0
          ? `${selectedFixture.id}:0..${last}`
          : selectedFixture.id,
      );
    }
  }, [fixtureDetailsCache, hasCustomTargetRef, selectedFixture]);

  const toScreenPx = (nx: number, ny: number, w: number, h: number) => {
    const unit = Math.min(w, h) * zoom * VIEW_FIT;
    return {
      sx: (nx - 0.5 - pan.x) * unit + w * 0.5,
      sy: (ny - 0.5 - pan.y) * unit + h * 0.5,
    };
  };

  const activeGroupCellKeys = useMemo(() => {
    const keys = new Set<string>();
    if (activeGroupFilterId === "all") return keys;
    const grp = showState.groups.find((g) => g.id === activeGroupFilterId);
    if (!grp) return keys;
    for (const targetRef of grp.targets) {
      const trimmed = targetRef.trim();
      const colonIdx = trimmed.indexOf(":");
      const fxId = colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx).trim();
      const fx = showState.patch.find((f) => f.id === fxId);
      if (!fx) continue;
      const detail = fixtureDetailsCache[fx.profile];
      const mode = detail?.expanded_modes.find((m) => m.name === fx.mode);
      const cellCount = mode?.cells.length ?? 1;
      for (const cIdx of expandTargetRange(trimmed, cellCount)) {
        keys.add(`${fxId}:${cIdx}`);
      }
    }
    return keys;
  }, [
    activeGroupFilterId,
    fixtureDetailsCache,
    showState.groups,
    showState.patch,
  ]);

  const selectedScene = useMemo(
    () =>
      showState.scenes.find((s) => s.id === selectedSceneId) ??
      showState.scenes[0] ??
      null,
    [selectedSceneId, showState.scenes],
  );

  const sceneAffected = useMemo(() => {
    const fixtureIds = new Set<string>();
    const cellKeys = new Set<string>();
    if (!selectedScene) return { fixtureIds, cellKeys, isSubset: false };
    const blk = selectedScene.block_refs[0]
      ? showState.fx_library.find((b) => b.id === selectedScene.block_refs[0])
      : null;
    const rawTarget = (
      selectedScene.target_group ??
      blk?.target_group ??
      "all"
    ).trim();
    if (!rawTarget || rawTarget === "all") {
      for (const fx of showState.patch) {
        fixtureIds.add(fx.id);
      }
      for (const cell of compiledCells) {
        cellKeys.add(`${cell.fixture_id}:${cell.cell_index}`);
      }
      return { fixtureIds, cellKeys, isSubset: false };
    }
    const grp = showState.groups.find((g) => g.id === rawTarget);
    const refs = grp ? grp.targets : [rawTarget];
    for (const targetRef of refs) {
      const trimmed = targetRef.trim();
      const colonIdx = trimmed.indexOf(":");
      const fxId = colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx).trim();
      const fx = showState.patch.find((f) => f.id === fxId);
      if (!fx) continue;
      fixtureIds.add(fx.id);
      const detail = fixtureDetailsCache[fx.profile];
      const mode = detail?.expanded_modes.find((m) => m.name === fx.mode);
      const cellCount = mode?.cells.length ?? 1;
      for (const cIdx of expandTargetRange(trimmed, cellCount)) {
        cellKeys.add(`${fxId}:${cIdx}`);
      }
    }
    return { fixtureIds, cellKeys, isSubset: true };
  }, [
    compiledCells,
    fixtureDetailsCache,
    selectedScene,
    showState.fx_library,
    showState.groups,
    showState.patch,
  ]);

  const cellBadgeNumbers = useMemo(() => {
    const n = compiledCells.length;
    if (n === 0) return [];
    const pairs = compiledCells.map((_, idx) => ({
      idx,
      u: computeOrderU(orderRule, idx, n),
    }));
    const sorted = [...pairs].sort((a, b) => a.u - b.u || a.idx - b.idx);
    const rankByIdx = new Array<number>(n).fill(1);
    sorted.forEach((p, rank) => {
      rankByIdx[p.idx] = rank + 1;
    });
    return rankByIdx;
  }, [compiledCells, orderRule]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = "#0A0F18";
    ctx.fillRect(0, 0, w, h);

    // Background grid scaled to snapStep (auto-coarsened if lines would be < 6px apart)
    const unitPx = Math.min(w, h) * zoom * VIEW_FIT;
    let gridStep = snapStep;
    while (gridStep * unitPx < 6) {
      gridStep *= 2;
    }
    const minNx = (0 - w * 0.5) / unitPx + 0.5 + pan.x;
    const maxNx = (w - w * 0.5) / unitPx + 0.5 + pan.x;
    const minNy = (0 - h * 0.5) / unitPx + 0.5 + pan.y;
    const maxNy = (h - h * 0.5) / unitPx + 0.5 + pan.y;
    const startIx = Math.floor(minNx / gridStep);
    const endIx = Math.ceil(maxNx / gridStep);
    const startIy = Math.floor(minNy / gridStep);
    const endIy = Math.ceil(maxNy / gridStep);

    ctx.strokeStyle = "#162030";
    ctx.lineWidth = 1;
    for (let i = startIx; i <= endIx; i++) {
      const pX = toScreenPx(i * gridStep, 0, w, h).sx;
      if (pX >= 0 && pX <= w) {
        ctx.beginPath();
        ctx.moveTo(pX, 0);
        ctx.lineTo(pX, h);
        ctx.stroke();
      }
    }
    for (let i = startIy; i <= endIy; i++) {
      const pY = toScreenPx(0, i * gridStep, w, h).sy;
      if (pY >= 0 && pY <= h) {
        ctx.beginPath();
        ctx.moveTo(0, pY);
        ctx.lineTo(w, pY);
        ctx.stroke();
      }
    }

    // [0..1] Stage Boundary Box
    const stageTL = toScreenPx(0, 0, w, h);
    const stageBR = toScreenPx(1, 1, w, h);
    ctx.strokeStyle = "#2A3A4E";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      stageTL.sx,
      stageTL.sy,
      stageBR.sx - stageTL.sx,
      stageBR.sy - stageTL.sy,
    );

    const centerPx = toScreenPx(0.5, 0.5, w, h);
    ctx.strokeStyle = "#2A374C";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(centerPx.sx, 0);
    ctx.lineTo(centerPx.sx, h);
    ctx.moveTo(0, centerPx.sy);
    ctx.lineTo(w, centerPx.sy);
    ctx.stroke();
    ctx.setLineDash([]);

    const selectedCellSet = new Set(selectedCellIndices);
    const overrides = dragOverridesRef.current;
    const fxPatchById = new Map(showState.patch.map((f) => [f.id, f]));

    // Live semi-transparent animated 2D shader preview directly inside the gizmo rectangle (behind fixtures)
    if (shaderGizmoActive && activeShaderBlock) {
      const shaderEl = activeShaderBlock.elements.find(
        (el) => el.kind === "spatial_shader_2d",
      );
      if (shaderEl && shaderEl.kind === "spatial_shader_2d") {
        const minNx = gizmoState.centerX - gizmoState.boxHalfX;
        const minNy = gizmoState.centerY - gizmoState.boxHalfY;
        const boxSpanX = gizmoState.boxHalfX * 2;
        const boxSpanY = gizmoState.boxHalfY * 2;
        const gridRes = 18;
        const activePal = showState.color_palettes.find(
          (p) => p.id === shaderEl.palette_ref,
        );
        const stops =
          shaderEl.inline_colors && shaderEl.inline_colors.length > 0
            ? shaderEl.inline_colors
            : activePal
              ? getPaletteColors(activePal)
              : getPaletteColors(DEFAULT_COLOR_PALETTES[0]);
        const isColor = shaderEl.trait === "color";
        const nowSec = performance.now() / 1000;
        const bpm = showState.bpm || 120;
        const phaseOffset = shaderEl.phase_offset ?? 0;
        let basePhaseCycles: number;
        if (shaderEl.speed_hz && shaderEl.speed_hz > 0) {
          basePhaseCycles = nowSec * shaderEl.speed_hz + phaseOffset;
        } else if (shaderEl.rate_beats && shaderEl.rate_beats > 0) {
          basePhaseCycles =
            ((nowSec * bpm) / 60) / Math.max(0.1, shaderEl.rate_beats) +
            phaseOffset;
        } else if (shaderEl.rate_cycles === 0) {
          basePhaseCycles = phaseOffset;
        } else {
          const durBeats = Math.max(0.05, activeShaderBlock.duration_beats || 4);
          basePhaseCycles =
            (((nowSec * bpm) / 60) / durBeats) * (shaderEl.rate_cycles ?? 1) +
            phaseOffset;
        }

        ctx.save();
        ctx.globalAlpha = 0.34;
        for (let gy = 0; gy < gridRes; gy++) {
          for (let gx = 0; gx < gridRes; gx++) {
            const nx0 = minNx + (gx / gridRes) * boxSpanX;
            const ny0 = minNy + (gy / gridRes) * boxSpanY;
            const nx1 = minNx + ((gx + 1) / gridRes) * boxSpanX;
            const ny1 = minNy + ((gy + 1) / gridRes) * boxSpanY;
            const sampleNx = (nx0 + nx1) * 0.5;
            const sampleNy = (ny0 + ny1) * 0.5;
            const s = evaluateSpatialShader2DPhase({
              shader: shaderEl.shader,
              normXy: [sampleNx, sampleNy],
              basePhaseCycles,
              spatialFreq: gizmoState.spatialFreq,
              colorWidth: shaderEl.color_width ?? 1,
              directionDeg: gizmoState.directionDeg,
              centerX: gizmoState.centerX,
              centerY: gizmoState.centerY,
              transform: shaderEl.transform,
            });
            if (isColor) {
              const linRgb = sampleOklabStopsLinear(
                stops,
                s,
                shaderEl.gradient ?? 1,
                shaderEl.grayscale ?? false,
                true,
              );
              ctx.fillStyle = linearRgbToSrgbHex(linRgb);
            } else {
              const v = Math.round(Math.max(0, Math.min(1, s)) * 235);
              ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
            }
            const p0 = toScreenPx(nx0, ny0, w, h);
            const p1 = toScreenPx(nx1, ny1, w, h);
            ctx.fillRect(
              p0.sx,
              p0.sy,
              Math.max(1, p1.sx - p0.sx + 0.5),
              Math.max(1, p1.sy - p0.sy + 0.5),
            );
          }
        }
        ctx.restore();
      }
    }

    // Compute per-fixture adaptive cell size so multi-segment tubes never appear cramped
    const defaultCellSize = Math.round(16 * Math.min(1.5, Math.max(0.75, zoom)));
    const fixtureScreenCoords = new Map<string, Array<[number, number]>>();
    const cellScreenCoords: Array<[number, number]> = compiledCells.map((cell) => {
      const baseFx = fxPatchById.get(cell.fixture_id);
      const ov = overrides[cell.fixture_id];
      let cellX = cell.canvas_xy[0];
      let cellY = cell.canvas_xy[1];
      if (baseFx && ov) {
        if (ov.rotation !== baseFx.grid_pos.rotation) {
          const dx = cellX - baseFx.grid_pos.x;
          const dy = cellY - baseFx.grid_pos.y;
          const dRad = ((ov.rotation - baseFx.grid_pos.rotation) * Math.PI) / 180;
          const cosD = Math.cos(dRad);
          const sinD = Math.sin(dRad);
          cellX = ov.x + (dx * cosD - dy * sinD);
          cellY = ov.y + (dx * sinD + dy * cosD);
        } else {
          cellX += ov.x - baseFx.grid_pos.x;
          cellY += ov.y - baseFx.grid_pos.y;
        }
      }
      const { sx, sy } = toScreenPx(cellX, cellY, w, h);
      const list = fixtureScreenCoords.get(cell.fixture_id);
      if (list) list.push([sx, sy]);
      else fixtureScreenCoords.set(cell.fixture_id, [[sx, sy]]);
      return [sx, sy];
    });
    const fixtureCellSizeById = new Map<string, number>();
    for (const [fxId, pts] of fixtureScreenCoords.entries()) {
      if (pts.length < 2) {
        fixtureCellSizeById.set(fxId, defaultCellSize);
        continue;
      }
      let minDist = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const dist = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (dist > 0.5 && dist < minDist) minDist = dist;
      }
      const adaptive = Number.isFinite(minDist)
        ? Math.max(9, Math.min(defaultCellSize, Math.floor(minDist - 3)))
        : defaultCellSize;
      fixtureCellSizeById.set(fxId, adaptive);
    }

    // Draw lighting cells as crisp Daslight-style numbered squares
    compiledCells.forEach((cell, idx) => {
      const [cx, cy] = cellScreenCoords[idx];
      const base = idx * 4;
      const r = cellPreviewRgbd[base] ?? 0;
      const g = cellPreviewRgbd[base + 1] ?? 0;
      const b = cellPreviewRgbd[base + 2] ?? 0;
      const d = cellPreviewRgbd[base + 3] ?? 0;

      const scale = d / 255;
      const hasColor = r + g + b > 0;
      const isColorCapable = fixtureHasColorById.get(cell.fixture_id) ?? true;
      const litR = hasColor
        ? Math.round(r * scale)
        : !isColorCapable
          ? Math.round(210 * scale)
          : 0;
      const litG = hasColor
        ? Math.round(g * scale)
        : !isColorCapable
          ? Math.round(218 * scale)
          : 0;
      const litB = hasColor
        ? Math.round(b * scale)
        : !isColorCapable
          ? Math.round(228 * scale)
          : 0;
      const hasOutput = hasColor
        ? litR + litG + litB > 0
        : !isColorCapable && d > 0;
      const isSelected =
        selectedFixture?.id === cell.fixture_id ||
        selectedFixtureSet.has(cell.fixture_id);
      const isPatternSelected = selectedCellSet.has(idx);
      const isGroupHighlighted = activeGroupCellKeys.has(
        `${cell.fixture_id}:${cell.cell_index}`,
      );
      const isSceneTargeted =
        sceneAffected.isSubset &&
        sceneAffected.cellKeys.has(`${cell.fixture_id}:${cell.cell_index}`);
      const cellSize = fixtureCellSizeById.get(cell.fixture_id) ?? defaultCellSize;
      const half = cellSize / 2;

      if (isGroupHighlighted || isSceneTargeted) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = isGroupHighlighted ? "#8833AA" : "#10B981";
        ctx.strokeRect(
          cx - half - 3,
          cy - half - 3,
          cellSize + 6,
          cellSize + 6,
        );
      }

      ctx.fillStyle = hasOutput
        ? `rgb(${litR}, ${litG}, ${litB})`
        : "#0D1117";
      ctx.fillRect(cx - half, cy - half, cellSize, cellSize);

      ctx.lineWidth = isPatternSelected ? 2 : isSelected ? 1.5 : 1;
      ctx.strokeStyle = isPatternSelected
        ? "#F2F6FB"
        : isSelected
          ? "#FF5500"
          : "#8898A8";
      ctx.strokeRect(cx - half, cy - half, cellSize, cellSize);

      if (cellSize >= 14) {
        const badgeNum = cellBadgeNumbers[idx] ?? idx + 1;
        const luminance = 0.299 * litR + 0.587 * litG + 0.114 * litB;
        ctx.font = "9px monospace";
        ctx.fillStyle = hasOutput && luminance > 140 ? "#0A0F18" : "#F2F6FB";
        ctx.textAlign = "center";
        ctx.fillText(String(badgeNum), cx, cy + 3);
        ctx.textAlign = "left";
      }
    });

    // Draw fixture anchors & selection rings
    for (const fx of showState.patch) {
      const effPos = overrides[fx.id] ?? fx.grid_pos;
      const { sx: fxX, sy: fxY } = toScreenPx(effPos.x, effPos.y, w, h);
      const isPrimary = selectedFixture?.id === fx.id;
      const isMulti = selectedFixtureSet.has(fx.id);

      if (isMulti || isPrimary) {
        ctx.strokeStyle = "#FF6B2B";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(fxX, fxY, 12, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = isPrimary || isMulti ? "#FF6B2B" : "#E2E8F0";
      ctx.beginPath();
      ctx.arc(fxX, fxY, 3, 0, Math.PI * 2);
      ctx.fill();

      if (isPrimary) {
        const rad = (effPos.rotation * Math.PI) / 180;
        const unit = Math.min(w, h) * zoom * VIEW_FIT;
        const hx = fxX + Math.cos(rad) * (ROTATION_HANDLE_NORM_RADIUS * unit);
        const hy = fxY + Math.sin(rad) * (ROTATION_HANDLE_NORM_RADIUS * unit);
        ctx.strokeStyle = "#FF5500";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(fxX, fxY);
        ctx.lineTo(hx, hy);
        ctx.stroke();

        ctx.fillStyle = "#FF5500";
        ctx.beginPath();
        ctx.arc(hx, hy, 5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.font = "11px monospace";
      ctx.fillStyle = isPrimary || isMulti ? "#FF6B2B" : "#94A3B8";
      ctx.fillText(fx.name, Math.min(w - 90, fxX + 10), Math.max(14, fxY - 8));
    }

    // Marquee Rubber-Band Selection Box
    if (marqueeRect) {
      const p0 = toScreenPx(marqueeRect.x0, marqueeRect.y0, w, h);
      const p1 = toScreenPx(marqueeRect.x1, marqueeRect.y1, w, h);
      const rx = Math.min(p0.sx, p1.sx);
      const ry = Math.min(p0.sy, p1.sy);
      const rw = Math.abs(p1.sx - p0.sx);
      const rh = Math.abs(p1.sy - p0.sy);
      ctx.fillStyle = "rgba(56, 189, 248, 0.14)";
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = "#38BDF8";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
    }

    // Interactive 2D Shader Gizmo
    if (shaderGizmoActive) {
      const tl = toScreenPx(
        gizmoState.centerX - gizmoState.boxHalfX,
        gizmoState.centerY - gizmoState.boxHalfY,
        w,
        h,
      );
      const br = toScreenPx(
        gizmoState.centerX + gizmoState.boxHalfX,
        gizmoState.centerY + gizmoState.boxHalfY,
        w,
        h,
      );
      const cPx = toScreenPx(gizmoState.centerX, gizmoState.centerY, w, h);

      ctx.strokeStyle = "#EC4899";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(tl.sx, tl.sy, br.sx - tl.sx, br.sy - tl.sy);
      ctx.setLineDash([]);
      ctx.fillStyle = "#EC4899";
      ctx.fillRect(br.sx - 5, br.sy - 5, 10, 10);
      ctx.fillRect(br.sx - 4, cPx.sy - 4, 8, 8);
      ctx.fillRect(cPx.sx - 4, br.sy - 4, 8, 8);

      ctx.strokeStyle = "#38BDF8";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cPx.sx - 8, cPx.sy);
      ctx.lineTo(cPx.sx + 8, cPx.sy);
      ctx.moveTo(cPx.sx, cPx.sy - 8);
      ctx.lineTo(cPx.sx, cPx.sy + 8);
      ctx.stroke();

      const angRad = (gizmoState.directionDeg * Math.PI) / 180;
      const ax = cPx.sx + Math.cos(angRad) * 42;
      const ay = cPx.sy + Math.sin(angRad) * 42;
      ctx.strokeStyle = "#38BDF8";
      ctx.beginPath();
      ctx.moveTo(cPx.sx, cPx.sy);
      ctx.lineTo(ax, ay);
      ctx.stroke();
      ctx.fillStyle = "#38BDF8";
      ctx.beginPath();
      ctx.arc(ax, ay, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [
    activeGroupCellKeys,
    activeShaderBlock,
    cellBadgeNumbers,
    cellPreviewRgbd,
    compiledCells,
    fixtureHasColorById,
    gizmoState,
    marqueeRect,
    sceneAffected,
    selectedCellIndices,
    selectedFixture,
    selectedFixtureSet,
    shaderGizmoActive,
    showState.bpm,
    showState.color_palettes,
    showState.patch,
    snapStep,
    zoom,
    pan,
    dragRenderTick,
  ]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    registerCanvasGeometry(() => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = getCanvasContentRect(canvas);
      if (rect.width <= 0 || rect.height <= 0) return null;

      const unit = Math.min(rect.width, rect.height) * zoom * VIEW_FIT;
      const toClient = (nx: number, ny: number) => ({
        x: Number(
          (rect.left + rect.width * 0.5 + (nx - 0.5 - pan.x) * unit).toFixed(1),
        ),
        y: Number(
          (rect.top + rect.height * 0.5 + (ny - 0.5 - pan.y) * unit).toFixed(1),
        ),
      });

      const overrides = dragOverridesRef.current;
      const fixtures = showState.patch.map((fx) => {
        const eff = overrides[fx.id] ?? fx.grid_pos;
        const center = toClient(eff.x, eff.y);
        const rad = (eff.rotation * Math.PI) / 180;
        const handle = toClient(
          eff.x + Math.cos(rad) * ROTATION_HANDLE_NORM_RADIUS,
          eff.y + Math.sin(rad) * ROTATION_HANDLE_NORM_RADIUS,
        );
        return {
          id: fx.id,
          name: fx.name,
          gridX: eff.x,
          gridY: eff.y,
          rotation: eff.rotation,
          clientX: center.x,
          clientY: center.y,
          rotationHandleX: handle.x,
          rotationHandleY: handle.y,
        };
      });

      let shaderGizmo = null;
      if (shaderGizmoActive) {
        const center = toClient(gizmoState.centerX, gizmoState.centerY);
        const scaleHandle = toClient(
          gizmoState.centerX + gizmoState.boxHalfX,
          gizmoState.centerY + gizmoState.boxHalfY,
        );
        const angRad = (gizmoState.directionDeg * Math.PI) / 180;
        const unitCanvas = Math.min(CANVAS_WIDTH, CANVAS_HEIGHT) * zoom * VIEW_FIT;
        const angleHandle = toClient(
          gizmoState.centerX + (Math.cos(angRad) * 42) / unitCanvas,
          gizmoState.centerY + (Math.sin(angRad) * 42) / unitCanvas,
        );
        shaderGizmo = {
          active: true,
          blockId: activeShaderBlock?.id ?? null,
          centerNormX: gizmoState.centerX,
          centerNormY: gizmoState.centerY,
          directionDeg: gizmoState.directionDeg,
          spatialFreq: gizmoState.spatialFreq,
          centerClientX: center.x,
          centerClientY: center.y,
          angleHandleClientX: angleHandle.x,
          angleHandleClientY: angleHandle.y,
          scaleHandleClientX: scaleHandle.x,
          scaleHandleClientY: scaleHandle.y,
        };
      }

      return {
        canvasRect: {
          left: Number(rect.left.toFixed(1)),
          top: Number(rect.top.toFixed(1)),
          width: Number(rect.width.toFixed(1)),
          height: Number(rect.height.toFixed(1)),
        },
        zoom,
        pan: { ...pan },
        fixtures,
        shaderGizmo,
      };
    });
    return () => registerCanvasGeometry(null);
  }, [activeShaderBlock, gizmoState, pan, shaderGizmoActive, showState.patch, zoom]);

  const toNormalizedCanvasPos = (
    e: PointerEvent<HTMLCanvasElement>,
  ): { x: number; y: number } => {
    const rect = getCanvasContentRect(e.currentTarget);
    if (rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
    const unit = Math.min(rect.width, rect.height) * zoom * VIEW_FIT;
    const nx = (e.clientX - (rect.left + rect.width * 0.5)) / unit + 0.5 + pan.x;
    const ny = (e.clientY - (rect.top + rect.height * 0.5)) / unit + 0.5 + pan.y;
    return { x: Number(nx.toFixed(3)), y: Number(ny.toFixed(3)) };
  };

  const commitShaderGizmoUpdate = (next: typeof gizmoState) => {
    setGizmoState(next);
    if (!activeShaderBlock) return;
    const updatedElements = activeShaderBlock.elements.map((el) =>
      el.kind === "spatial_shader_2d"
        ? {
            ...el,
            center_x: next.centerX,
            center_y: next.centerY,
            direction_deg: next.directionDeg,
            spatial_freq: next.spatialFreq,
            box_half_x: next.boxHalfX,
            box_half_y: next.boxHalfY,
          }
        : el,
    );
    void upsertFxBlock({ ...activeShaderBlock, elements: updatedElements });
  };

  const fitActiveGizmoToTargets = () => {
    if (!activeShaderBlock) return;
    const bounds = computeTargetGizmoBounds({
      compiledCells,
      patch: showState.patch,
      groups: showState.groups,
      targetGroup: selectedScene?.target_group ?? activeShaderBlock.target_group,
      fallbackFixtureIds: selectedFixtureIds,
    });
    commitShaderGizmoUpdate({
      ...gizmoState,
      centerX: bounds.centerX,
      centerY: bounds.centerY,
      boxHalfX: bounds.boxHalfX,
      boxHalfY: bounds.boxHalfY,
      spatialFreq: bounds.spatialFreq,
    });
  };

  const lastPatchPosSigRef = useRef<string>("");
  useEffect(() => {
    const posSig = showState.patch
      .map(
        (f) =>
          `${f.id}:${f.grid_pos.x.toFixed(3)},${f.grid_pos.y.toFixed(3)},${f.grid_pos.rotation.toFixed(1)},${f.grid_pos.scale_x.toFixed(3)},${f.grid_pos.scale_y.toFixed(3)}`,
      )
      .join("|");
    if (!lastPatchPosSigRef.current) {
      lastPatchPosSigRef.current = posSig;
      return;
    }
    if (posSig === lastPatchPosSigRef.current) return;
    lastPatchPosSigRef.current = posSig;

    if (!gizmoAutoFit || !activeShaderBlock || dragState) return;
    const bounds = computeTargetGizmoBounds({
      compiledCells,
      patch: showState.patch,
      groups: showState.groups,
      targetGroup: selectedScene?.target_group ?? activeShaderBlock.target_group,
      fallbackFixtureIds: selectedFixtureIds,
    });
    const shaderEl = activeShaderBlock.elements.find(
      (el) => el.kind === "spatial_shader_2d",
    );
    if (!shaderEl || shaderEl.kind !== "spatial_shader_2d") return;
    const diff =
      Math.abs(shaderEl.center_x - bounds.centerX) +
      Math.abs(shaderEl.center_y - bounds.centerY) +
      Math.abs((shaderEl.box_half_x ?? bounds.boxHalfX) - bounds.boxHalfX) +
      Math.abs((shaderEl.box_half_y ?? bounds.boxHalfY) - bounds.boxHalfY);
    if (diff > 0.004) {
      commitShaderGizmoUpdate({
        centerX: bounds.centerX,
        centerY: bounds.centerY,
        directionDeg: shaderEl.direction_deg,
        spatialFreq: bounds.spatialFreq,
        boxHalfX: bounds.boxHalfX,
        boxHalfY: bounds.boxHalfY,
      });
    }
  }, [
    activeShaderBlock,
    compiledCells,
    dragState,
    gizmoAutoFit,
    selectedFixtureIds,
    selectedScene?.target_group,
    showState.groups,
    showState.patch,
  ]);

  const handlePointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      setDragState({
        mode: "pan",
        startClient: { x: e.clientX, y: e.clientY },
        startPan: { ...pan },
      });
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return;
    }

    const pos = toNormalizedCanvasPos(e);

    if (shaderGizmoActive) {
      const scaleHandleX = gizmoState.centerX + gizmoState.boxHalfX;
      const scaleHandleY = gizmoState.centerY + gizmoState.boxHalfY;
      const angRad = (gizmoState.directionDeg * Math.PI) / 180;
      const unitCanvas = Math.min(CANVAS_WIDTH, CANVAS_HEIGHT) * zoom * VIEW_FIT;
      const angHandleX =
        gizmoState.centerX + (Math.cos(angRad) * 42) / unitCanvas;
      const angHandleY =
        gizmoState.centerY + (Math.sin(angRad) * 42) / unitCanvas;

      if (Math.hypot(scaleHandleX - pos.x, scaleHandleY - pos.y) < 0.05) {
        setGizmoAutoFit(false);
        setDragState({ mode: "shader_scale" });
        e.currentTarget.setPointerCapture?.(e.pointerId);
        return;
      }
      if (Math.hypot(scaleHandleX - pos.x, gizmoState.centerY - pos.y) < 0.05) {
        setGizmoAutoFit(false);
        setDragState({ mode: "shader_scale_x" });
        e.currentTarget.setPointerCapture?.(e.pointerId);
        return;
      }
      if (Math.hypot(gizmoState.centerX - pos.x, scaleHandleY - pos.y) < 0.05) {
        setGizmoAutoFit(false);
        setDragState({ mode: "shader_scale_y" });
        e.currentTarget.setPointerCapture?.(e.pointerId);
        return;
      }
      if (Math.hypot(angHandleX - pos.x, angHandleY - pos.y) < 0.05) {
        setDragState({ mode: "shader_angle" });
        e.currentTarget.setPointerCapture?.(e.pointerId);
        return;
      }
      if (
        Math.hypot(gizmoState.centerX - pos.x, gizmoState.centerY - pos.y) <
        0.06
      ) {
        setGizmoAutoFit(false);
        setDragState({ mode: "shader_center" });
        e.currentTarget.setPointerCapture?.(e.pointerId);
        return;
      }
    }

    if (selectionMode === "cells") {
      let closestCellIdx: number | null = null;
      let bestCellDist = 0.045;
      compiledCells.forEach((cell, idx) => {
        const dist = Math.hypot(
          cell.canvas_xy[0] - pos.x,
          cell.canvas_xy[1] - pos.y,
        );
        if (dist < bestCellDist) {
          bestCellDist = dist;
          closestCellIdx = idx;
        }
      });
      if (closestCellIdx !== null) {
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        toggleCellSelection(closestCellIdx, additive);
      } else {
        setDragState({ mode: "marquee", startPos: pos });
        setMarqueeRect({ x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y });
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
      return;
    }

    if (selectedFixture) {
      const rad = (selectedFixture.grid_pos.rotation * Math.PI) / 180;
      const hx =
        selectedFixture.grid_pos.x +
        Math.cos(rad) * ROTATION_HANDLE_NORM_RADIUS;
      const hy =
        selectedFixture.grid_pos.y +
        Math.sin(rad) * ROTATION_HANDLE_NORM_RADIUS;
      if (Math.hypot(hx - pos.x, hy - pos.y) < 0.028) {
        setDragState({
          fixtureId: selectedFixture.id,
          mode: "rotate",
          startPos: pos,
          initialGridPositions: {
            [selectedFixture.id]: { ...selectedFixture.grid_pos },
          },
        });
        e.currentTarget.setPointerCapture?.(e.pointerId);
        return;
      }
    }

    let closestId: string | null = null;
    let bestDist = 0.09;

    for (const fx of showState.patch) {
      const dist = Math.hypot(fx.grid_pos.x - pos.x, fx.grid_pos.y - pos.y);
      if (dist < bestDist) {
        bestDist = dist;
        closestId = fx.id;
      }
    }
    if (!closestId) {
      for (const cell of compiledCells) {
        const dist = Math.hypot(
          cell.canvas_xy[0] - pos.x,
          cell.canvas_xy[1] - pos.y,
        );
        if (dist < bestDist) {
          bestDist = dist;
          closestId = cell.fixture_id;
        }
      }
    }

    if (closestId) {
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      const moveIds =
        !additive && selectedFixtureSet.has(closestId) && selectedFixtureSet.size > 1
          ? Array.from(selectedFixtureSet)
          : additive
            ? Array.from(new Set([...selectedFixtureIds, closestId]))
            : [closestId];
      if (!(!additive && selectedFixtureSet.has(closestId) && selectedFixtureSet.size > 1)) {
        toggleSelectFixtureInstance(closestId, additive);
      }
      const initialGridPositions: Record<string, GridPos> = {};
      for (const fx of showState.patch) {
        if (moveIds.includes(fx.id)) {
          initialGridPositions[fx.id] = { ...fx.grid_pos };
        }
      }
      setDragState({
        fixtureId: closestId,
        mode: "move",
        startPos: pos,
        initialGridPositions,
      });
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } else {
      setDragState({ mode: "marquee", startPos: pos });
      setMarqueeRect({ x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y });
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
  };

  const handlePointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!dragState) return;

    if (dragState.mode === "pan") {
      const rect = getCanvasContentRect(e.currentTarget);
      if (rect.width > 0 && rect.height > 0) {
        const unit = Math.min(rect.width, rect.height) * zoom * VIEW_FIT;
        const dxNorm = (e.clientX - dragState.startClient.x) / unit;
        const dyNorm = (e.clientY - dragState.startClient.y) / unit;
        setPan({
          x: Number((dragState.startPan.x - dxNorm).toFixed(3)),
          y: Number((dragState.startPan.y - dyNorm).toFixed(3)),
        });
      }
      return;
    }

    const pos = toNormalizedCanvasPos(e);

    if (dragState.mode === "marquee") {
      const rect = {
        x0: dragState.startPos.x,
        y0: dragState.startPos.y,
        x1: pos.x,
        y1: pos.y,
      };
      setMarqueeRect(rect);
      const minX = Math.min(rect.x0, rect.x1);
      const maxX = Math.max(rect.x0, rect.x1);
      const minY = Math.min(rect.y0, rect.y1);
      const maxY = Math.max(rect.y0, rect.y1);
      if (selectionMode === "cells") {
        const hitCells: number[] = [];
        compiledCells.forEach((cell, idx) => {
          if (
            cell.canvas_xy[0] >= minX &&
            cell.canvas_xy[0] <= maxX &&
            cell.canvas_xy[1] >= minY &&
            cell.canvas_xy[1] <= maxY
          ) {
            hitCells.push(idx);
          }
        });
        setSelectedCellIndices(hitCells);
        return;
      }
      const hitSet = new Set<string>();
      for (const fx of showState.patch) {
        if (
          fx.grid_pos.x >= minX &&
          fx.grid_pos.x <= maxX &&
          fx.grid_pos.y >= minY &&
          fx.grid_pos.y <= maxY
        ) {
          hitSet.add(fx.id);
        }
      }
      for (const cell of compiledCells) {
        if (
          cell.canvas_xy[0] >= minX &&
          cell.canvas_xy[0] <= maxX &&
          cell.canvas_xy[1] >= minY &&
          cell.canvas_xy[1] <= maxY
        ) {
          hitSet.add(cell.fixture_id);
        }
      }
      setSelectedFixtureIds(Array.from(hitSet));
      return;
    }

    if (dragState.mode === "shader_center") {
      commitShaderGizmoUpdate({
        ...gizmoState,
        centerX: pos.x,
        centerY: pos.y,
      });
      return;
    }
    if (dragState.mode === "shader_angle") {
      const rawDeg =
        (Math.atan2(pos.y - gizmoState.centerY, pos.x - gizmoState.centerX) *
          180) /
        Math.PI;
      let deg = Math.round(((rawDeg % 360) + 360) % 360);
      for (const snap of [0, 45, 90, 135, 180, 225, 270, 315, 360]) {
        if (Math.abs(deg - snap) <= 5) {
          deg = snap % 360;
          break;
        }
      }
      commitShaderGizmoUpdate({ ...gizmoState, directionDeg: deg });
      return;
    }
    if (dragState.mode === "shader_scale") {
      const nextX = Number(
        Math.min(2.0, Math.max(0.05, Math.abs(pos.x - gizmoState.centerX))).toFixed(3),
      );
      const nextY = Number(
        Math.min(2.0, Math.max(0.05, Math.abs(pos.y - gizmoState.centerY))).toFixed(3),
      );
      commitShaderGizmoUpdate({
        ...gizmoState,
        boxHalfX: nextX,
        boxHalfY: nextY,
      });
      return;
    }
    if (dragState.mode === "shader_scale_x") {
      const nextX = Number(
        Math.min(2.0, Math.max(0.05, Math.abs(pos.x - gizmoState.centerX))).toFixed(3),
      );
      commitShaderGizmoUpdate({ ...gizmoState, boxHalfX: nextX });
      return;
    }
    if (dragState.mode === "shader_scale_y") {
      const nextY = Number(
        Math.min(2.0, Math.max(0.05, Math.abs(pos.y - gizmoState.centerY))).toFixed(3),
      );
      commitShaderGizmoUpdate({ ...gizmoState, boxHalfY: nextY });
      return;
    }

    if (!("fixtureId" in dragState)) return;
    const fxId = dragState.fixtureId;
    const initPos = dragState.initialGridPositions[fxId];
    if (!initPos) return;

    const scheduleRafRender = () => {
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        setDragRenderTick((t) => t + 1);
      });
    };

    if (dragState.mode === "rotate") {
      const rawDeg =
        (Math.atan2(pos.y - initPos.y, pos.x - initPos.x) * 180) / Math.PI;
      const unwrappedDeg = ((rawDeg % 360) + 360) % 360;
      const normalizedDeg = snapToGrid
        ? Number(((Math.round(unwrappedDeg / 22.5) * 22.5) % 360).toFixed(1))
        : Math.round(unwrappedDeg);
      dragOverridesRef.current[fxId] = {
        ...initPos,
        rotation: normalizedDeg,
      };
      scheduleRafRender();
      return;
    }

    const dx = pos.x - dragState.startPos.x;
    const dy = pos.y - dragState.startPos.y;
    const snapVal = (v: number) =>
      snapToGrid ? Number((Math.round(v / snapStep) * snapStep).toFixed(3)) : Number(v.toFixed(3));

    for (const [id, basePos] of Object.entries(dragState.initialGridPositions)) {
      dragOverridesRef.current[id] = {
        ...basePos,
        x: snapVal(basePos.x + dx),
        y: snapVal(basePos.y + dy),
      };
    }
    scheduleRafRender();
  };

  const handlePointerUp = () => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const pending = dragOverridesRef.current;
    const entries = Object.entries(pending);
    dragOverridesRef.current = {};
    if (entries.length > 0) {
      const multi = entries.length > 1;
      for (const [fxId, nextPos] of entries) {
        void updateFixtureGridPos(
          fxId,
          nextPos,
          multi ? "grid_multi" : `grid_${fxId}`,
        );
      }
      setDragRenderTick((t) => t + 1);
    }
    setDragState(null);
    setMarqueeRect(null);
  };

  const handleCanvasWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 1) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom((z) => Math.max(0.3, Math.min(4.0, Number((z * factor).toFixed(2)))));
  };

  const updateGridField = (patch: Partial<GridPos>) => {
    if (!selectedFixture) return;
    void updateFixtureGridPos(
      selectedFixture.id,
      { ...selectedFixture.grid_pos, ...patch },
      `grid_${selectedFixture.id}`,
    );
  };

  const resetRotationAndScale = () => {
    if (!selectedFixture) return;
    void updateFixtureGridPos(
      selectedFixture.id,
      {
        ...selectedFixture.grid_pos,
        rotation: 0,
        scale_x: 0.3,
        scale_y: 0.05,
      },
      `grid_reset_${selectedFixture.id}`,
    );
  };

  const orderPreviewItems = useMemo(() => {
    const trimmed = targetRefInput.trim();
    const colonIdx = trimmed.indexOf(":");
    const targetFixtureId =
      colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx).trim();
    const matchedFixture = showState.patch.find(
      (f) => f.id === targetFixtureId,
    );
    if (!matchedFixture) return { fixture: null, items: [] };

    const detail = fixtureDetailsCache[matchedFixture.profile];
    const mode = detail?.expanded_modes.find(
      (m) => m.name === matchedFixture.mode,
    );
    const cellCount = mode?.cells.length ?? 1;
    const indices = expandTargetRange(trimmed, cellCount);
    return {
      fixture: matchedFixture,
      items: indices.map((cellIndex, orderIdx) => ({
        orderIdx,
        cellIndex,
        u: computeOrderU(orderRule, orderIdx, indices.length),
      })),
    };
  }, [fixtureDetailsCache, orderRule, showState.patch, targetRefInput]);

  const selectionCountForGroup =
    selectedFixtureIds.length ||
    selectedCellIndices.length ||
    (selectedFixture ? 1 : 0);

  return (
    <div className="h-full min-h-0 flex flex-col">
      <section className="h-full min-h-0 bg-slate-dark border border-steel rounded p-1.5 flex flex-col gap-1.5">
        {/* Slim Daslight 2D View Top Toolbar */}
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-1.5 bg-slate border border-steel/70 rounded px-2 py-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-frost">
              2D View
            </span>
            <div className="flex items-center gap-0.5 bg-ink border border-steel rounded px-1 py-0.5 font-mono text-[10px]">
              <button
                type="button"
                data-testid="grid-zoom-out"
                onClick={() =>
                  setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))
                }
                title="Zoom Out"
                className="p-0.5 text-mist hover:text-ember"
              >
                <ZoomOut className="w-3 h-3" />
              </button>
              <NumericSlider
                ariaLabel="2D Grid Zoom Slider"
                value={zoom}
                defaultValue={1.0}
                min={0.5}
                max={2.5}
                step={0.05}
                displayMultiplier={100}
                unit="%"
                precision={0}
                onChange={(val) => setZoom(val)}
                className="hidden sm:flex w-36"
                sliderClassName="w-14 accent-ember"
                inputClassName="w-11 text-[10px]"
              />
              <button
                type="button"
                data-testid="grid-zoom-reset"
                onClick={() => {
                  setZoom(1.0);
                  setPan({ x: 0, y: 0 });
                }}
                title="Reset Zoom & Pan (100%)"
                className="px-1 text-frost hover:text-ember"
              >
                <span data-testid="grid-zoom-value">
                  {Math.round(zoom * 100)}%
                </span>
              </button>
              <button
                type="button"
                data-testid="grid-zoom-in"
                onClick={() =>
                  setZoom((z) => Math.min(4.0, Number((z + 0.25).toFixed(2))))
                }
                title="Zoom In"
                className="p-0.5 text-mist hover:text-ember"
              >
                <ZoomIn className="w-3 h-3" />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {/* Selection Mode: Whole Fixtures vs Individual Cells */}
            <HelpTooltip text="Fixtures mode selects & moves whole fixtures; Cells mode clicks or marquees individual segments for partial-fixture groups.">
              <div className="flex items-center gap-0.5 bg-ink border border-steel rounded p-0.5 font-mono text-[10px]">
                <button
                  type="button"
                  data-testid="grid-select-mode-fixtures"
                  aria-pressed={selectionMode === "fixtures"}
                  onClick={() => setSelectionMode("fixtures")}
                  className={`px-1.5 py-0.2 rounded transition-colors ${
                    selectionMode === "fixtures"
                      ? "bg-ember text-frost font-semibold"
                      : "text-fog hover:text-mist"
                  }`}
                >
                  Fixtures
                </button>
                <button
                  type="button"
                  data-testid="grid-select-mode-cells"
                  aria-pressed={selectionMode === "cells"}
                  onClick={() => setSelectionMode("cells")}
                  className={`px-1.5 py-0.2 rounded transition-colors ${
                    selectionMode === "cells"
                      ? "bg-plum text-frost font-semibold"
                      : "text-fog hover:text-mist"
                  }`}
                >
                  Cells
                </button>
              </div>
            </HelpTooltip>

            <div className="flex items-center gap-0.5">
              <HelpTooltip
                text={`Snap fixtures to ${Math.round(snapStep * 1000) / 10}% grid when dragging`}
              >
                <button
                  type="button"
                  data-testid="toggle-2d-snap-grid"
                  aria-pressed={snapToGrid}
                  onClick={() => setSnapToGrid((v) => !v)}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[10px] transition-colors ${
                    snapToGrid
                      ? "bg-cobalt/30 border-cobalt text-frost font-semibold"
                      : "bg-ink border-steel text-fog hover:text-mist"
                  }`}
                >
                  <Magnet className="w-3 h-3" />
                  <span>Snap</span>
                </button>
              </HelpTooltip>
              <select
                aria-label="Grid Snap Size"
                data-testid="grid-snap-step-select"
                value={snapStep}
                onChange={(e) => setSnapStep(Number(e.target.value))}
                disabled={!snapToGrid}
                title="Grid snap & visual grid spacing (% of stage)"
                className="bg-ink border border-steel rounded px-1 py-0.5 font-mono text-[10px] text-frost disabled:opacity-40"
              >
                {GRID_SNAP_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <HelpTooltip text="Toggle 2D Shader FX Gizmo overlay for spatial mappings.">
              <button
                type="button"
                data-testid="toggle-2d-shader-gizmo"
                aria-pressed={shaderGizmoActive}
                onClick={() => setShaderGizmoActive((v) => !v)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[10px] transition-colors ${
                  shaderGizmoActive
                    ? "bg-plum/30 border-plum text-frost font-semibold"
                    : "bg-ink border-steel text-fog hover:text-mist"
                }`}
              >
                <Crosshair className="w-3 h-3" />
                <span>FX</span>
              </button>
            </HelpTooltip>

            {activeShaderBlock && (
              <div className="flex items-center gap-0.5">
                <HelpTooltip text="Fit 2D shader gizmo center and size to the scene's targeted fixtures or cells.">
                  <button
                    type="button"
                    data-testid="gizmo-fit-btn"
                    onClick={fitActiveGizmoToTargets}
                    className="px-1.5 py-0.5 rounded border border-cobalt bg-cobalt/20 hover:bg-cobalt/35 font-mono text-[10px] text-frost font-semibold transition-colors"
                  >
                    Fit
                  </button>
                </HelpTooltip>
                <HelpTooltip text="Auto-Fit: refit the 2D shader gizmo whenever targeted fixtures move or rotate. Pauses automatically if you drag gizmo handles manually.">
                  <button
                    type="button"
                    data-testid="gizmo-autofit-toggle"
                    aria-pressed={gizmoAutoFit}
                    onClick={() => setGizmoAutoFit(!gizmoAutoFit)}
                    className={`px-1.5 py-0.5 rounded border font-mono text-[10px] transition-colors ${
                      gizmoAutoFit
                        ? "bg-plum/25 border-plum text-frost font-semibold"
                        : "bg-ink border-steel text-fog hover:text-mist"
                    }`}
                  >
                    Auto
                  </button>
                </HelpTooltip>
              </div>
            )}

            {/* Always-Visible Position & Rotation Controls */}
            {selectedFixture && (
              <div
                data-testid="grid-inline-transform-controls"
                className="flex flex-wrap items-center gap-1 bg-ink border border-steel rounded px-1.5 py-0.5 font-mono text-[10px]"
              >
                <span
                  data-testid="selected-fixture-banner"
                  className="text-ember font-semibold max-w-[140px] truncate"
                  title={`${selectedFixture.name} (${selectedFixture.id})`}
                >
                  {selectedFixture.name} ({selectedFixture.id})
                </span>
                <label className="flex items-center gap-0.5 text-fog">
                  <span>X</span>
                  <input
                    id="grid-x"
                    aria-label="Grid X"
                    type="number"
                    min={-4}
                    max={5}
                    step={0.01}
                    value={selectedFixture.grid_pos.x}
                    onChange={(e) =>
                      updateGridField({
                        x: Number((Number(e.target.value) || 0).toFixed(3)),
                      })
                    }
                    className="w-14 bg-pitch border border-steel rounded px-1 py-0.2 text-[10px] text-frost"
                  />
                </label>
                <label className="flex items-center gap-0.5 text-fog">
                  <span>Y</span>
                  <input
                    id="grid-y"
                    aria-label="Grid Y"
                    type="number"
                    min={-4}
                    max={5}
                    step={0.01}
                    value={selectedFixture.grid_pos.y}
                    onChange={(e) =>
                      updateGridField({
                        y: Number((Number(e.target.value) || 0).toFixed(3)),
                      })
                    }
                    className="w-14 bg-pitch border border-steel rounded px-1 py-0.2 text-[10px] text-frost"
                  />
                </label>
                <label className="flex items-center gap-0.5 text-fog">
                  <span>R</span>
                  <input
                    id="grid-rotation"
                    aria-label="Grid Rotation"
                    type="number"
                    min={0}
                    max={360}
                    step={1}
                    value={selectedFixture.grid_pos.rotation}
                    onChange={(e) =>
                      updateGridField({
                        rotation: Number(e.target.value) || 0,
                      })
                    }
                    className="w-11 bg-pitch border border-steel rounded px-1 py-0.2 text-[10px] text-frost"
                  />
                </label>
                <button
                  type="button"
                  aria-label="Rotate 90 Degrees"
                  title="Rotate +90°"
                  onClick={() =>
                    updateGridField({
                      rotation:
                        (((selectedFixture.grid_pos.rotation + 90) % 360) +
                          360) %
                        360,
                    })
                  }
                  className="p-0.5 rounded bg-pitch border border-steel text-mist hover:border-ember"
                >
                  <RotateCw className="w-3 h-3 text-ember" />
                </button>
                <button
                  type="button"
                  data-testid="reset-rotation-scale-btn"
                  aria-label="Reset Rotation and Scale"
                  title="Reset Rotation & Scale"
                  onClick={resetRotationAndScale}
                  className="p-0.5 rounded bg-pitch border border-steel text-mist hover:border-ember"
                >
                  <RotateCcw className="w-3 h-3 text-ember" />
                </button>
              </div>
            )}

            {!hideUndoRedo && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={!canUndo}
                  onClick={() => void undoShow()}
                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-ink border border-steel text-[10px] text-mist hover:border-ember disabled:opacity-40"
                >
                  <Undo2 className="w-3 h-3" />
                  <span>Undo</span>
                </button>
                <button
                  type="button"
                  disabled={!canRedo}
                  onClick={() => void redoShow()}
                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-ink border border-steel text-[10px] text-mist hover:border-ember disabled:opacity-40"
                >
                  <Redo2 className="w-3 h-3" />
                  <span>Redo</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Daslight 5 2D Grid Split: Left Vertical Pattern Rail | Center Canvas | Right SELECTIONS */}
        <div className="flex-1 min-h-0 flex gap-1.5 items-stretch">
          {/* Left Vertical Pixel Sub-Selection Rail */}
          <div className="w-9 shrink-0 bg-pitch border border-steel rounded py-1 px-0.5 flex flex-col items-center gap-1 font-mono text-[9px] overflow-y-auto">
            {PATTERN_FILTERS.map((f) => (
              <button
                key={f.pattern}
                type="button"
                data-testid={`pattern-filter-${f.pattern}`}
                onClick={() =>
                  applyCellSelectionPattern(f.pattern, activeGroupFilterId)
                }
                title={`Select ${f.label}`}
                className="w-full py-1 rounded bg-ink border border-steel/70 text-mist hover:border-ember hover:text-frost text-center leading-none"
              >
                {f.pattern === "shift_left"
                  ? "◂"
                  : f.pattern === "shift_right"
                    ? "▸"
                    : f.pattern === "invert"
                      ? "⇄"
                      : f.label}
              </button>
            ))}
            <button
              type="button"
              data-testid="pattern-filter-none"
              onClick={() =>
                applyCellSelectionPattern("none", activeGroupFilterId)
              }
              title="Clear pixel pattern selection"
              className="w-full py-1 rounded bg-ink border border-steel/70 text-fog hover:border-signal hover:text-frost text-center leading-none mt-auto"
            >
              None
            </button>
          </div>

          {/* Center 2D Grid Canvas */}
          <div className="flex-1 min-w-0 min-h-0 relative bg-void border border-steel rounded overflow-hidden flex items-center justify-center p-1">
            <canvas
              ref={canvasRef}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              data-testid="fixture-grid-canvas"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onWheel={handleCanvasWheel}
              className="w-full h-full object-contain cursor-crosshair"
            />
          </div>

          {/* Right SELECTIONS Sidebar */}
          <div
            data-testid="selections-grouping-sidebar"
            className="w-44 sm:w-48 shrink-0 bg-pitch border border-steel rounded p-1.5 flex flex-col justify-between gap-1.5 min-h-0"
          >
            <div className="flex-1 min-h-0 flex flex-col gap-1">
              <div className="flex items-center justify-between gap-1 border-b border-steel/60 pb-1 shrink-0">
                <span className="font-mono text-[10px] font-bold uppercase text-frost">
                  SELECTIONS
                </span>
                <div className="flex items-center gap-1 font-mono text-[9px]">
                  <button
                    type="button"
                    data-testid="select-all-fixtures-btn"
                    onClick={() =>
                      setSelectedFixtureIds(showState.patch.map((f) => f.id))
                    }
                    className="px-1 py-0.2 rounded bg-ink border border-steel text-mist hover:border-cobalt"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    data-testid="clear-fixture-selection-btn"
                    onClick={() => clearSelections()}
                    title="Clear all selected fixtures and pixel/pattern selections"
                    className="px-1 py-0.2 rounded bg-ink border border-steel text-fog hover:text-mist"
                  >
                    Clr
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1">
                {showState.patch.length === 0 ? (
                  <span className="font-mono text-[10px] text-fog py-4 text-center">
                    No fixtures patched
                  </span>
                ) : (
                  showState.patch.map((fx) => {
                    const isChecked =
                      selectedFixtureSet.has(fx.id) ||
                      (selectedFixtureSet.size === 0 &&
                        selectedFixture?.id === fx.id);
                    const isAffectedByScene = sceneAffected.fixtureIds.has(
                      fx.id,
                    );
                    return (
                      <button
                        key={fx.id}
                        type="button"
                        data-testid={`toggle-select-fixture-${fx.id}`}
                        aria-pressed={isChecked}
                        onClick={() => toggleSelectFixtureInstance(fx.id, true)}
                        title={
                          isAffectedByScene && selectedScene
                            ? `Affected by scene: ${selectedScene.name}`
                            : fx.name
                        }
                        className={`flex items-center justify-between gap-1 px-1.5 py-1 rounded border font-mono text-[11px] text-left transition-colors ${
                          isChecked
                            ? "bg-ember/20 border-ember text-frost font-semibold"
                            : "bg-ink border-steel text-mist hover:border-fog"
                        }`}
                      >
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span
                            data-testid={`scene-affected-dot-${fx.id}`}
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                              isAffectedByScene
                                ? "bg-pine"
                                : "bg-steel/50"
                            }`}
                          />
                          <span className="truncate">{fx.name}</span>
                        </span>
                        <span className="text-[9px] text-fog shrink-0">
                          {isChecked ? "✓" : fx.id}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Compact Footer: Save Selection as Group */}
            <div className="shrink-0 flex items-center gap-1 border-t border-steel/60 pt-1">
              <input
                aria-label="Quick Selection Group Name"
                type="text"
                value={quickGroupName}
                onChange={(e) => setQuickGroupName(e.target.value)}
                placeholder="Group..."
                className="w-full min-w-0 bg-ink border border-steel rounded px-1.5 py-0.5 text-[11px] font-sans text-frost"
              />
              <button
                type="button"
                data-testid="create-group-from-fixtures-btn"
                disabled={showState.patch.length === 0}
                onClick={() =>
                  void createGroupFromSelectedFixtures(quickGroupName)
                }
                title={
                  selectedCellIndices.length > 0
                    ? `Save ${selectedCellIndices.length} selected cell(s) as Group`
                    : `Save Selection (${selectionCountForGroup}) as Group`
                }
                className="px-1.5 py-1 rounded bg-plum hover:bg-plum/90 text-frost disabled:opacity-40 shrink-0 flex items-center gap-0.5 font-mono text-[10px]"
              >
                <Plus className="w-3.5 h-3.5" />
                {selectedCellIndices.length > 0 && (
                  <span data-testid="selected-cells-group-badge">
                    {selectedCellIndices.length}c
                  </span>
                )}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Backward-Compatible Legacy Transform / 1D OrderRule Test Bridge */}
      <div className="sr-only">
        {selectedFixture && (
          <>
            <input
              aria-label="Grid Scale X"
              type="number"
              value={selectedFixture.grid_pos.scale_x}
              onChange={(e) =>
                updateGridField({
                  scale_x: Math.max(0.01, Number(e.target.value) || 0.01),
                })
              }
            />
            <input
              aria-label="Grid Scale Y"
              type="number"
              value={selectedFixture.grid_pos.scale_y}
              onChange={(e) =>
                updateGridField({
                  scale_y: Math.max(0.01, Number(e.target.value) || 0.01),
                })
              }
            />
          </>
        )}
        <select
          aria-label="Order Rule"
          value={orderRule}
          onChange={(e) => handleOrderChange(e.target.value as OrderRuleStr)}
        >
          <option value="linear">Linear</option>
          <option value="reverse">Reverse</option>
          <option value="center_out">Center Out</option>
          <option value="mirror">Mirror</option>
          <option value="odd_even">Odd Even</option>
          <option value="blocks(2)">Blocks (2)</option>
          <option value="blocks(4)">Blocks (4)</option>
        </select>
        <input
          aria-label="Target Reference"
          type="text"
          value={targetRefInput}
          onChange={(e) => {
            setHasCustomTargetRef(true);
            setTargetRefInput(e.target.value);
          }}
        />
        <div data-testid="order-rule-preview">
          {orderPreviewItems.items.map((item) => (
            <div key={`${item.orderIdx}-${item.cellIndex}`}>
              <span>Cell {item.cellIndex}</span>
              <span>u={item.u.toFixed(2)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
