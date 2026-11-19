import {
  Crosshair,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  patternScaleToSpatialFreq,
  spatialFreqToPatternScale,
} from "../lib/mixerLogic";
import {
  computeOrderU,
  expandTargetRange,
  type GridPos,
  type OrderRuleStr,
} from "../lib/patchLogic";
import { type CellSelectionPattern, useTaktStore } from "../store/useTaktStore";
import { NumericSlider } from "./NumericSlider";

const CANVAS_WIDTH = 720;
const CANVAS_HEIGHT = 420;
const ROTATION_HANDLE_NORM_RADIUS = 0.065;

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
  const setCanvasOrderRule = useTaktStore((s) => s.setCanvasOrderRule);
  const undoShow = useTaktStore((s) => s.undoShow);
  const redoShow = useTaktStore((s) => s.redoShow);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [zoom, setZoom] = useState<number>(1.0);
  const [shaderGizmoActive, setShaderGizmoActive] = useState<boolean>(false);
  const [quickGroupName, setQuickGroupName] = useState<string>("Stage Group");
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
  }>({
    centerX: 0.5,
    centerY: 0.5,
    directionDeg: 45,
    spatialFreq: 1.0,
  });

  const [dragState, setDragState] = useState<
    | {
        fixtureId: string;
        mode: "move" | "rotate";
        lastPos: { x: number; y: number };
      }
    | { mode: "marquee"; startPos: { x: number; y: number } }
    | { mode: "shader_center" | "shader_angle" | "shader_scale" }
    | null
  >(null);

  const activeShaderBlock = useMemo(() => {
    if (activeShaderGizmoBlockId) {
      const found = showState.fx_library.find(
        (b) => b.id === activeShaderGizmoBlockId,
      );
      if (found) return found;
    }
    return (
      showState.fx_library.find((b) =>
        b.elements.some((el) => el.kind === "spatial_shader_2d"),
      ) ?? null
    );
  }, [activeShaderGizmoBlockId, showState.fx_library]);

  useEffect(() => {
    const shaderEl = activeShaderBlock?.elements.find(
      (el) => el.kind === "spatial_shader_2d",
    );
    if (shaderEl && shaderEl.kind === "spatial_shader_2d") {
      setGizmoState({
        centerX: shaderEl.center_x,
        centerY: shaderEl.center_y,
        directionDeg: shaderEl.direction_deg,
        spatialFreq: shaderEl.spatial_freq,
      });
    }
  }, [activeShaderBlock]);

  const selectedFixture = useMemo(
    () =>
      showState.patch.find((f) => f.id === selectedFixtureInstanceId) ??
      showState.patch[0] ??
      null,
    [selectedFixtureInstanceId, showState.patch],
  );

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

  const toScreenPx = (nx: number, ny: number, w: number, h: number) => ({
    sx: ((nx - 0.5) * zoom + 0.5) * w,
    sy: ((ny - 0.5) * zoom + 0.5) * h,
  });

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

    // 10x10 Grid
    ctx.strokeStyle = "#1F2A3C";
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const pX = toScreenPx(i / 10, 0, w, h).sx;
      const pY = toScreenPx(0, i / 10, w, h).sy;
      ctx.beginPath();
      ctx.moveTo(pX, 0);
      ctx.lineTo(pX, h);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, pY);
      ctx.lineTo(w, pY);
      ctx.stroke();
    }

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

    // Draw lighting cells as crisp Daslight-style numbered squares
    compiledCells.forEach((cell, idx) => {
      const { sx: cx, sy: cy } = toScreenPx(
        cell.canvas_xy[0],
        cell.canvas_xy[1],
        w,
        h,
      );
      const base = idx * 4;
      const r = cellPreviewRgbd[base] ?? 0;
      const g = cellPreviewRgbd[base + 1] ?? 0;
      const b = cellPreviewRgbd[base + 2] ?? 0;
      const d = cellPreviewRgbd[base + 3] ?? 0;

      const scale = d / 255;
      const litR = Math.round(r * scale);
      const litG = Math.round(g * scale);
      const litB = Math.round(b * scale);
      const hasOutput = litR + litG + litB > 0;
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
      const cellSize = Math.round(16 * Math.min(1.5, Math.max(0.75, zoom)));
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

      const badgeNum = cellBadgeNumbers[idx] ?? idx + 1;
      const luminance = 0.299 * litR + 0.587 * litG + 0.114 * litB;
      ctx.font = "9px monospace";
      ctx.fillStyle = hasOutput && luminance > 140 ? "#0A0F18" : "#F2F6FB";
      ctx.textAlign = "center";
      ctx.fillText(String(badgeNum), cx, cy + 3);
      ctx.textAlign = "left";
    });

    // Draw fixture anchors & selection rings
    for (const fx of showState.patch) {
      const { sx: fxX, sy: fxY } = toScreenPx(
        fx.grid_pos.x,
        fx.grid_pos.y,
        w,
        h,
      );
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
        const rad = (fx.grid_pos.rotation * Math.PI) / 180;
        const hx =
          fxX + Math.cos(rad) * (ROTATION_HANDLE_NORM_RADIUS * zoom * w);
        const hy =
          fxY + Math.sin(rad) * (ROTATION_HANDLE_NORM_RADIUS * zoom * h);
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
      const patternScale = spatialFreqToPatternScale(gizmoState.spatialFreq);
      const boxHalfNorm = Math.min(0.45, Math.max(0.08, 0.2 * patternScale));
      const tl = toScreenPx(
        gizmoState.centerX - boxHalfNorm,
        gizmoState.centerY - boxHalfNorm,
        w,
        h,
      );
      const br = toScreenPx(
        gizmoState.centerX + boxHalfNorm,
        gizmoState.centerY + boxHalfNorm,
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
    cellBadgeNumbers,
    cellPreviewRgbd,
    compiledCells,
    gizmoState,
    marqueeRect,
    sceneAffected,
    selectedCellIndices,
    selectedFixture,
    selectedFixtureSet,
    shaderGizmoActive,
    showState.patch,
    zoom,
  ]);

  const toNormalizedCanvasPos = (
    e: PointerEvent<HTMLCanvasElement>,
  ): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
    const viewX = (e.clientX - rect.left) / rect.width;
    const viewY = (e.clientY - rect.top) / rect.height;
    const nx = Math.max(0, Math.min(1, (viewX - 0.5) / zoom + 0.5));
    const ny = Math.max(0, Math.min(1, (viewY - 0.5) / zoom + 0.5));
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
          }
        : el,
    );
    void upsertFxBlock({ ...activeShaderBlock, elements: updatedElements });
  };

  const handlePointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const pos = toNormalizedCanvasPos(e);

    if (shaderGizmoActive) {
      const patternScale = spatialFreqToPatternScale(gizmoState.spatialFreq);
      const boxHalfNorm = Math.min(0.45, Math.max(0.08, 0.2 * patternScale));
      const scaleHandleX = gizmoState.centerX + boxHalfNorm;
      const scaleHandleY = gizmoState.centerY + boxHalfNorm;
      const angRad = (gizmoState.directionDeg * Math.PI) / 180;
      const angHandleX =
        gizmoState.centerX + (Math.cos(angRad) * 42) / (CANVAS_WIDTH * zoom);
      const angHandleY =
        gizmoState.centerY + (Math.sin(angRad) * 42) / (CANVAS_HEIGHT * zoom);

      if (Math.hypot(scaleHandleX - pos.x, scaleHandleY - pos.y) < 0.05) {
        setDragState({ mode: "shader_scale" });
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
        setDragState({ mode: "shader_center" });
        e.currentTarget.setPointerCapture?.(e.pointerId);
        return;
      }
    }

    if (selectedFixture) {
      const rad = (selectedFixture.grid_pos.rotation * Math.PI) / 180;
      const hx =
        selectedFixture.grid_pos.x +
        Math.cos(rad) * ROTATION_HANDLE_NORM_RADIUS;
      const hy =
        selectedFixture.grid_pos.y +
        Math.sin(rad) * ROTATION_HANDLE_NORM_RADIUS;
      if (Math.hypot(hx - pos.x, hy - pos.y) < 0.05) {
        setDragState({
          fixtureId: selectedFixture.id,
          mode: "rotate",
          lastPos: pos,
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
      // Preserve multi-selection when grabbing an already-selected fixture cleanly
      if (!additive && selectedFixtureSet.has(closestId) && selectedFixtureSet.size > 1) {
        setDragState({ fixtureId: closestId, mode: "move", lastPos: pos });
      } else {
        toggleSelectFixtureInstance(closestId, additive);
        setDragState({ fixtureId: closestId, mode: "move", lastPos: pos });
      }
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } else {
      setDragState({ mode: "marquee", startPos: pos });
      setMarqueeRect({ x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y });
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
  };

  const handlePointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!dragState) return;
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
      const boxHalf = Math.max(
        0.05,
        Math.max(
          Math.abs(pos.x - gizmoState.centerX),
          Math.abs(pos.y - gizmoState.centerY),
        ),
      );
      const scale = Math.max(0.25, Math.min(4.0, boxHalf / 0.2));
      commitShaderGizmoUpdate({
        ...gizmoState,
        spatialFreq: patternScaleToSpatialFreq(scale),
      });
      return;
    }

    if (!("fixtureId" in dragState)) return;
    const fxId = dragState.fixtureId;
    const fx = showState.patch.find((f) => f.id === fxId);
    if (!fx) return;

    if (dragState.mode === "rotate") {
      const rawDeg =
        (Math.atan2(pos.y - fx.grid_pos.y, pos.x - fx.grid_pos.x) * 180) /
        Math.PI;
      const normalizedDeg = Math.round(((rawDeg % 360) + 360) % 360);
      void updateFixtureGridPos(
        fx.id,
        { ...fx.grid_pos, rotation: normalizedDeg },
        `grid_${fx.id}`,
      );
      return;
    }

    // Move all selected fixtures together when multi-selected
    const dx = pos.x - dragState.lastPos.x;
    const dy = pos.y - dragState.lastPos.y;
    const targets =
      selectedFixtureIds.length > 1 && selectedFixtureIds.includes(fxId)
        ? showState.patch.filter((f) => selectedFixtureIds.includes(f.id))
        : [fx];

    for (const targetFx of targets) {
      void updateFixtureGridPos(
        targetFx.id,
        {
          ...targetFx.grid_pos,
          x: Number(
            Math.max(0, Math.min(1, targetFx.grid_pos.x + dx)).toFixed(3),
          ),
          y: Number(
            Math.max(0, Math.min(1, targetFx.grid_pos.y + dy)).toFixed(3),
          ),
        },
        targets.length > 1 ? "grid_multi" : `grid_${targetFx.id}`,
      );
    }
    setDragState({ ...dragState, lastPos: pos });
  };

  const handlePointerUp = () => {
    setDragState(null);
    setMarqueeRect(null);
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
                onClick={() => setZoom(1.0)}
                title="Reset Zoom 100%"
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
                  setZoom((z) => Math.min(2.5, Number((z + 0.25).toFixed(2))))
                }
                title="Zoom In"
                className="p-0.5 text-mist hover:text-ember"
              >
                <ZoomIn className="w-3 h-3" />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
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
              title="Toggle 2D Shader FX Gizmo"
            >
              <Crosshair className="w-3 h-3" />
              <span>FX</span>
            </button>

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
                    min={0}
                    max={1}
                    step={0.01}
                    value={selectedFixture.grid_pos.x}
                    onChange={(e) =>
                      updateGridField({
                        x: Math.max(
                          0,
                          Math.min(1, Number(e.target.value) || 0),
                        ),
                      })
                    }
                    className="w-12 bg-pitch border border-steel rounded px-1 py-0.2 text-[10px] text-frost"
                  />
                </label>
                <label className="flex items-center gap-0.5 text-fog">
                  <span>Y</span>
                  <input
                    id="grid-y"
                    aria-label="Grid Y"
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={selectedFixture.grid_pos.y}
                    onChange={(e) =>
                      updateGridField({
                        y: Math.max(
                          0,
                          Math.min(1, Number(e.target.value) || 0),
                        ),
                      })
                    }
                    className="w-12 bg-pitch border border-steel rounded px-1 py-0.2 text-[10px] text-frost"
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
                    onClick={() => setSelectedFixtureIds([])}
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
                title={`Save Selection (${selectionCountForGroup}) as Group`}
                className="p-1 rounded bg-plum hover:bg-plum/90 text-frost disabled:opacity-40 shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
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
