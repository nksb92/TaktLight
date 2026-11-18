import { Undo2, Redo2 } from "lucide-react";
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  computeOrderU,
  expandTargetRange,
  type GridPos,
  type OrderRuleStr,
} from "../lib/patchLogic";
import { useTaktStore } from "../store/useTaktStore";

const CANVAS_WIDTH = 720;
const CANVAS_HEIGHT = 420;

export function FixtureGrid2D() {
  const showState = useTaktStore((s) => s.showState);
  const compiledCells = useTaktStore((s) => s.compiledCells);
  const cellPreviewRgbd = useTaktStore((s) => s.cellPreviewRgbd);
  const fixtureDetailsCache = useTaktStore((s) => s.fixtureDetailsCache);
  const selectedFixtureInstanceId = useTaktStore(
    (s) => s.selectedFixtureInstanceId,
  );
  const canUndo = useTaktStore((s) => s.canUndo);
  const canRedo = useTaktStore((s) => s.canRedo);

  const selectFixtureInstance = useTaktStore((s) => s.selectFixtureInstance);
  const updateFixtureGridPos = useTaktStore((s) => s.updateFixtureGridPos);
  const undoShow = useTaktStore((s) => s.undoShow);
  const redoShow = useTaktStore((s) => s.redoShow);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const selectedFixture = useMemo(
    () =>
      showState.patch.find((f) => f.id === selectedFixtureInstanceId) ??
      showState.patch[0] ??
      null,
    [selectedFixtureInstanceId, showState.patch],
  );

  const [orderRule, setOrderRule] = useState<OrderRuleStr>("linear");
  const [targetRefInput, setTargetRefInput] = useState<string>(
    selectedFixture ? `${selectedFixture.id}:0..7` : "fx_001:0..7",
  );
  const [hasCustomTargetRef, setHasCustomTargetRef] = useState<boolean>(false);

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    // Background in VOID
    ctx.fillStyle = "#0A0F18";
    ctx.fillRect(0, 0, w, h);

    // Subtle 10x10 spatial grid in STEEL
    ctx.strokeStyle = "#1F2A3C";
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const gx = (i / 10) * w;
      const gy = (i / 10) * h;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    // Center crosshair axes
    ctx.strokeStyle = "#2A374C";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw compiled spatial cells with live RGBD preview
    compiledCells.forEach((cell, idx) => {
      const cx = cell.canvas_xy[0] * w;
      const cy = cell.canvas_xy[1] * h;
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
      const isSelected = selectedFixture?.id === cell.fixture_id;

      ctx.beginPath();
      ctx.arc(cx, cy, isSelected ? 6 : 5, 0, Math.PI * 2);
      ctx.fillStyle = hasOutput
        ? `rgb(${litR}, ${litG}, ${litB})`
        : "rgba(56, 189, 248, 0.25)";
      ctx.fill();

      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.strokeStyle = isSelected ? "#FF6B2B" : "#38BDF8";
      ctx.stroke();
    });

    // Draw fixture anchor markers and labels
    for (const fx of showState.patch) {
      const fxX = fx.grid_pos.x * w;
      const fxY = fx.grid_pos.y * h;
      const isSelected = selectedFixture?.id === fx.id;

      ctx.fillStyle = isSelected ? "#FF6B2B" : "#E2E8F0";
      ctx.beginPath();
      ctx.arc(fxX, fxY, 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = "11px monospace";
      ctx.fillStyle = isSelected ? "#FF6B2B" : "#94A3B8";
      ctx.fillText(fx.name, Math.min(w - 90, fxX + 8), Math.max(14, fxY - 8));
    }
  }, [cellPreviewRgbd, compiledCells, selectedFixture, showState.patch]);

  const toNormalizedCanvasPos = (
    e: PointerEvent<HTMLCanvasElement>,
  ): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return { x: Number(nx.toFixed(3)), y: Number(ny.toFixed(3)) };
  };

  const handlePointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const pos = toNormalizedCanvasPos(e);
    let closestId: string | null = null;
    let bestDist = 0.12;

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
      selectFixtureInstance(closestId);
      setDraggingId(closestId);
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
  };

  const handlePointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!draggingId) return;
    const fx = showState.patch.find((f) => f.id === draggingId);
    if (!fx) return;
    const pos = toNormalizedCanvasPos(e);
    void updateFixtureGridPos(
      fx.id,
      { ...fx.grid_pos, x: pos.x, y: pos.y },
      `grid_${fx.id}`,
    );
  };

  const handlePointerUp = () => {
    setDraggingId(null);
  };

  const updateGridField = (patch: Partial<GridPos>) => {
    if (!selectedFixture) return;
    void updateFixtureGridPos(
      selectedFixture.id,
      { ...selectedFixture.grid_pos, ...patch },
      `grid_${selectedFixture.id}`,
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

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
      {/* Left 2 Columns: Interactive 2D Normalized Layout Canvas */}
      <section className="xl:col-span-2 bg-slate border border-steel rounded-panel p-3 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-sans text-sm font-semibold text-frost">
              2D Spatial Fixture Canvas
            </h2>
            <p className="font-mono text-[11px] text-fog">
              Normalized stage coordinates [0.0..1.0]. Drag fixtures on canvas or tune transform values.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!canUndo}
              onClick={() => void undoShow()}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-ink border border-steel text-xs text-mist hover:border-ember disabled:opacity-40"
            >
              <Undo2 className="w-3.5 h-3.5" />
              <span>Undo</span>
            </button>
            <button
              type="button"
              disabled={!canRedo}
              onClick={() => void redoShow()}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-ink border border-steel text-xs text-mist hover:border-ember disabled:opacity-40"
            >
              <Redo2 className="w-3.5 h-3.5" />
              <span>Redo</span>
            </button>
          </div>
        </div>

        <div className="bg-void border border-steel rounded overflow-hidden flex items-center justify-center p-2">
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            data-testid="fixture-grid-canvas"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className="w-full max-w-[720px] aspect-[12/7] cursor-crosshair rounded border border-steel/60"
          />
        </div>

        {/* Patched Fixture Chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          {showState.patch.length === 0 ? (
            <span className="font-mono text-xs text-fog">
              No fixtures patched yet. Add fixtures in Patch View first.
            </span>
          ) : (
            showState.patch.map((fx) => {
              const isSelected = selectedFixture?.id === fx.id;
              return (
                <button
                  key={fx.id}
                  type="button"
                  onClick={() => selectFixtureInstance(fx.id)}
                  className={`px-2.5 py-1 rounded border font-mono text-xs transition-colors ${
                    isSelected
                      ? "bg-ember/20 border-ember text-frost"
                      : "bg-ink border-steel text-mist hover:border-fog"
                  }`}
                >
                  <span>{fx.name}</span>{" "}
                  <span className="text-fog">({fx.id})</span>
                </button>
              );
            })
          )}
        </div>
      </section>

      {/* Right Column: GridPos Inspector & 1D OrderRule Preview */}
      <section className="flex flex-col gap-4">
        <div className="bg-slate border border-steel rounded-panel p-3 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-sans text-sm font-semibold text-frost">
              Fixture Spatial Transform
            </h2>
            {selectedFixture && (
              <span className="font-mono text-xs text-ember">
                {selectedFixture.id}
              </span>
            )}
          </div>

          {!selectedFixture ? (
            <p className="font-mono text-xs text-fog">
              Select a patched fixture to edit GridPos coordinates.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="grid-x"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  Grid X
                </label>
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
                      x: Math.max(0, Math.min(1, Number(e.target.value) || 0)),
                    })
                  }
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost focus:outline-none focus:border-ember"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="grid-y"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  Grid Y
                </label>
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
                      y: Math.max(0, Math.min(1, Number(e.target.value) || 0)),
                    })
                  }
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost focus:outline-none focus:border-ember"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="grid-rotation"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  Grid Rotation (deg)
                </label>
                <input
                  id="grid-rotation"
                  aria-label="Grid Rotation"
                  type="number"
                  min={0}
                  max={360}
                  step={1}
                  value={selectedFixture.grid_pos.rotation}
                  onChange={(e) =>
                    updateGridField({ rotation: Number(e.target.value) || 0 })
                  }
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost focus:outline-none focus:border-ember"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="grid-scale-x"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  Grid Scale X
                </label>
                <input
                  id="grid-scale-x"
                  aria-label="Grid Scale X"
                  type="number"
                  min={0.01}
                  max={1}
                  step={0.01}
                  value={selectedFixture.grid_pos.scale_x}
                  onChange={(e) =>
                    updateGridField({
                      scale_x: Math.max(0.01, Number(e.target.value) || 0.01),
                    })
                  }
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost focus:outline-none focus:border-ember"
                />
              </div>

              <div className="flex flex-col gap-1 col-span-2">
                <label
                  htmlFor="grid-scale-y"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  Grid Scale Y
                </label>
                <input
                  id="grid-scale-y"
                  aria-label="Grid Scale Y"
                  type="number"
                  min={0.01}
                  max={1}
                  step={0.01}
                  value={selectedFixture.grid_pos.scale_y}
                  onChange={(e) =>
                    updateGridField({
                      scale_y: Math.max(0.01, Number(e.target.value) || 0.01),
                    })
                  }
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost focus:outline-none focus:border-ember"
                />
              </div>
            </div>
          )}
        </div>

        {/* 1D OrderRule & TargetRef Preview */}
        <div className="bg-slate border border-steel rounded-panel p-3 flex flex-col gap-3">
          <h2 className="font-sans text-sm font-semibold text-frost">
            1D OrderRule &amp; TargetRef Preview
          </h2>

          <div className="grid grid-cols-1 gap-2.5">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="order-rule-select"
                className="text-[11px] font-mono uppercase text-fog"
              >
                Order Rule
              </label>
              <select
                id="order-rule-select"
                aria-label="Order Rule"
                value={orderRule}
                onChange={(e) => setOrderRule(e.target.value as OrderRuleStr)}
                className="bg-ink border border-steel rounded px-2.5 py-1.5 text-xs font-mono text-frost focus:outline-none focus:border-ember"
              >
                <option value="linear">Linear</option>
                <option value="reverse">Reverse</option>
                <option value="center_out">Center Out</option>
                <option value="mirror">Mirror</option>
                <option value="odd_even">Odd Even</option>
                <option value="blocks(2)">Blocks (2)</option>
                <option value="blocks(4)">Blocks (4)</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="target-ref-input"
                className="text-[11px] font-mono uppercase text-fog"
              >
                Target Reference
              </label>
              <input
                id="target-ref-input"
                aria-label="Target Reference"
                type="text"
                value={targetRefInput}
                onChange={(e) => {
                  setHasCustomTargetRef(true);
                  setTargetRefInput(e.target.value);
                }}
                placeholder="fx_001:0..7"
                className="bg-ink border border-steel rounded px-2.5 py-1.5 text-xs font-mono text-frost focus:outline-none focus:border-ember"
              />
            </div>
          </div>

          <div
            data-testid="order-rule-preview"
            className="bg-void border border-steel rounded p-2 flex flex-col gap-1.5"
          >
            {!orderPreviewItems.fixture ||
            orderPreviewItems.items.length === 0 ? (
              <span className="font-mono text-xs text-fog">
                No valid target cells matched. Format example: fx_001 or fx_001:7..0.
              </span>
            ) : (
              orderPreviewItems.items.map((item) => (
                <div
                  key={`${item.orderIdx}-${item.cellIndex}`}
                  className="flex items-center justify-between gap-2 text-[11px] font-mono"
                >
                  <span className="text-mist w-20">Cell {item.cellIndex}</span>
                  <div className="flex-1 h-2 bg-ink rounded overflow-hidden border border-steel/60">
                    <div
                      className="h-full bg-ember"
                      style={{ width: `${Math.round(item.u * 100)}%` }}
                    />
                  </div>
                  <span className="text-cobalt w-14 text-right">
                    u={item.u.toFixed(2)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
