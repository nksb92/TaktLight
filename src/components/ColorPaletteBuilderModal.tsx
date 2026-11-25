import { ArrowDown, ArrowUp, Palette, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type ColorPaletteDef,
  DEFAULT_COLOR_PALETTES,
  getPaletteColors,
  linearRgbToSrgbHex,
  sampleOklabStopsLinear,
} from "../lib/mixerLogic";
import { useTaktStore } from "../store/useTaktStore";

function slugPaletteId(name: string, existingIds: string[]): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = `pal_${clean || "custom"}`;
  if (!existingIds.includes(base)) return base;
  let suffix = 2;
  while (existingIds.includes(`${base}_${suffix}`)) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
}

export function ColorPaletteBuilderModal({
  open,
  initialPaletteId,
  onClose,
  onSaved,
}: {
  open: boolean;
  initialPaletteId?: string | null;
  onClose: () => void;
  onSaved?: (palette: ColorPaletteDef) => void;
}) {
  const showState = useTaktStore((s) => s.showState);
  const upsertColorPalette = useTaktStore((s) => s.upsertColorPalette);
  const deleteColorPalette = useTaktStore((s) => s.deleteColorPalette);

  const palettes =
    showState.color_palettes.length > 0
      ? showState.color_palettes
      : DEFAULT_COLOR_PALETTES;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState<string>("Custom Palette");
  const [stops, setStops] = useState<string[]>(["#FF5500", "#2255AA"]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    if (initialPaletteId) {
      const found = palettes.find((p) => p.id === initialPaletteId);
      if (found) {
        setEditingId(found.id);
        setName(found.name);
        setStops([...getPaletteColors(found)]);
        return;
      }
    }
    setEditingId(null);
    setName(`Custom Palette ${palettes.length + 1}`);
    setStops(["#FF5500", "#00E5FF"]);
  }, [open, initialPaletteId]);

  if (!open) return null;

  const selectPaletteToEdit = (pal: ColorPaletteDef) => {
    setEditingId(pal.id);
    setName(pal.name);
    setStops([...getPaletteColors(pal)]);
    setErrorMsg(null);
  };

  const startNewPalette = () => {
    setEditingId(null);
    setName(`Custom Palette ${palettes.length + 1}`);
    setStops(["#FF2E63", "#FFD166", "#00E5FF"]);
    setErrorMsg(null);
  };

  const moveStop = (idx: number, delta: -1 | 1) => {
    const target = idx + delta;
    if (target < 0 || target >= stops.length) return;
    const next = [...stops];
    const [moved] = next.splice(idx, 1);
    next.splice(target, 0, moved);
    setStops(next);
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setErrorMsg("Palette name cannot be empty.");
      return;
    }
    const cleanStops = stops.length > 0 ? stops : ["#FF5500", "#2255AA"];
    const id =
      editingId ??
      slugPaletteId(
        trimmed,
        showState.color_palettes.map((p) => p.id),
      );
    const nextPal: ColorPaletteDef = {
      id,
      name: trimmed,
      hex_start: cleanStops[0],
      hex_end: cleanStops[cleanStops.length - 1],
      colors: cleanStops,
    };
    await upsertColorPalette(nextPal);
    onSaved?.(nextPal);
    onClose();
  };

  const handleDelete = async (id: string) => {
    await deleteColorPalette(id);
    if (editingId === id) {
      startNewPalette();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Color Palette Builder"
      data-testid="color-palette-builder-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-panel border border-steel bg-slate-dark shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 bg-pitch border-b border-steel">
          <div className="flex items-center gap-2">
            <Palette className="w-4 h-4 text-ember" />
            <h2 className="font-sans text-sm font-semibold text-frost">
              Color Palette Builder
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close Color Palette Builder"
            onClick={onClose}
            className="p-1 rounded text-fog hover:text-frost hover:bg-ink"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-12 min-h-[300px]">
          {/* Left Saved Palettes List */}
          <div className="sm:col-span-5 border-b sm:border-b-0 sm:border-r border-steel bg-pitch/60 p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase text-fog">
                Show Palettes ({showState.color_palettes.length})
              </span>
              <button
                type="button"
                data-testid="palette-builder-new-btn"
                onClick={startNewPalette}
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-ember text-pitch font-mono text-[10px] font-semibold hover:bg-ember/90"
              >
                <Plus className="w-3 h-3" /> New
              </button>
            </div>
            <div className="flex-1 max-h-64 overflow-y-auto flex flex-col gap-1 pr-0.5">
              {showState.color_palettes.map((pal) => {
                const palStops = getPaletteColors(pal);
                const isSelected = editingId === pal.id;
                return (
                  <div
                    key={pal.id}
                    className={`flex items-center justify-between gap-1.5 px-2 py-1.5 rounded border transition-colors ${
                      isSelected
                        ? "bg-ink border-ember text-frost"
                        : "bg-ink/60 border-steel text-mist hover:border-fog"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => selectPaletteToEdit(pal)}
                      className="flex-1 min-w-0 flex flex-col gap-1 text-left"
                    >
                      <span className="font-sans text-xs truncate">
                        {pal.name}
                      </span>
                      <span
                        className="h-2 w-full rounded-sm border border-steel/60"
                        style={{
                          background: `linear-gradient(90deg, ${palStops.join(", ")})`,
                        }}
                      />
                    </button>
                    {showState.color_palettes.length > 1 && (
                      <button
                        type="button"
                        aria-label={`Delete palette ${pal.name}`}
                        data-testid={`palette-builder-delete-${pal.id}`}
                        onClick={() => void handleDelete(pal.id)}
                        className="p-1 rounded text-fog hover:text-signal shrink-0"
                        title="Delete Palette"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Palette Editor */}
          <div className="sm:col-span-7 p-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase text-fog">
                Palette Name
              </span>
              <input
                type="text"
                aria-label="Palette Builder Name"
                data-testid="palette-builder-name-input"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setErrorMsg(null);
                }}
                className="bg-ink border border-steel rounded px-2.5 py-1.5 font-sans text-xs text-frost focus:border-ember focus:outline-none"
              />
            </label>

            {/* Live OKLab Gradient Preview */}
            <div className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase text-fog">
                OKLab Gradient Preview
              </span>
              <div className="flex h-7 w-full rounded overflow-hidden border border-steel">
                {Array.from({ length: 24 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex-1"
                    style={{
                      backgroundColor: linearRgbToSrgbHex(
                        sampleOklabStopsLinear(
                          stops.length > 0 ? stops : ["#FF5500", "#2255AA"],
                          i / 23,
                          1,
                          false,
                          false,
                        ),
                      ),
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Color Stops List */}
            <div className="flex flex-col gap-1.5 flex-1 min-h-0">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase text-fog">
                  Color Stops ({stops.length})
                </span>
                <button
                  type="button"
                  data-testid="palette-builder-add-stop-btn"
                  onClick={() => setStops((prev) => [...prev, "#FFFFFF"])}
                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-ink border border-steel text-mist hover:border-ember font-mono text-[10px]"
                >
                  <Plus className="w-3 h-3" /> Add Stop
                </button>
              </div>
              <div className="max-h-40 overflow-y-auto flex flex-col gap-1.5 pr-1">
                {stops.map((hex, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2 bg-pitch border border-steel rounded px-2 py-1"
                  >
                    <span className="font-mono text-[10px] text-fog w-5">
                      #{idx + 1}
                    </span>
                    <input
                      type="color"
                      aria-label={`Palette Stop ${idx + 1} Color`}
                      value={hex}
                      onChange={(e) => {
                        const val = e.target.value.toUpperCase();
                        setStops((prev) =>
                          prev.map((c, i) => (i === idx ? val : c)),
                        );
                      }}
                      className="w-6 h-6 rounded border border-steel bg-ink p-0 cursor-pointer"
                    />
                    <input
                      type="text"
                      aria-label={`Palette Stop ${idx + 1} Hex`}
                      value={hex}
                      onChange={(e) => {
                        const val = e.target.value;
                        setStops((prev) =>
                          prev.map((c, i) => (i === idx ? val : c)),
                        );
                      }}
                      className="w-24 bg-ink border border-steel rounded px-1.5 py-0.5 font-mono text-[11px] text-frost"
                    />
                    <div className="ml-auto flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Move Stop ${idx + 1} Up`}
                        disabled={idx === 0}
                        onClick={() => moveStop(idx, -1)}
                        className="p-0.5 rounded bg-ink border border-steel text-fog hover:text-frost disabled:opacity-30"
                      >
                        <ArrowUp className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move Stop ${idx + 1} Down`}
                        disabled={idx === stops.length - 1}
                        onClick={() => moveStop(idx, 1)}
                        className="p-0.5 rounded bg-ink border border-steel text-fog hover:text-frost disabled:opacity-30"
                      >
                        <ArrowDown className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove Stop ${idx + 1}`}
                        disabled={stops.length <= 1}
                        onClick={() =>
                          setStops((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="p-0.5 rounded bg-ink border border-steel text-fog hover:text-signal disabled:opacity-30"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {errorMsg && (
              <div className="font-mono text-[11px] text-signal">
                {errorMsg}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-steel">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded border border-steel bg-ink text-xs font-sans text-mist hover:text-frost"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="palette-builder-save-btn"
                onClick={() => void handleSave()}
                className="px-3 py-1.5 rounded bg-ember hover:bg-ember/90 text-pitch text-xs font-sans font-semibold"
              >
                {editingId ? "Update Palette" : "Save Palette"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
