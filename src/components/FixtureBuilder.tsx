import { ChangeEvent, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Code2,
  Download,
  FilePlus2,
  FolderUp,
  Layers,
  Plus,
  Save,
  ShieldAlert,
  Trash2,
  Wrench,
} from "lucide-react";
import {
  buildOflFixtureJson,
  ChannelRole,
  createDefaultBuilderDraft,
  FixtureBuilderDraft,
  FixtureValidationResult,
  sanitizeSlug,
} from "../lib/oflBuilder";
import { useTaktStore } from "../store/useTaktStore";

const CATEGORIES = [
  "Pixel Bar",
  "Color Changer",
  "LED Tube",
  "Strobe",
  "Dimmer",
];

function describeRole(role: ChannelRole): string {
  switch (role.kind) {
    case "intensity":
      return "Intensity";
    case "color_intensity":
      return `Color: ${role.color}`;
    case "shutter_strobe":
      return `ShutterStrobe (${role.capabilities.length} ranges)`;
    case "wheel_slot":
      return `WheelSlot (${role.slots.length} slots)`;
    case "fine_alias":
      return `16 Bit Fine (${role.parent_channel_name})`;
    case "unmapped":
      return `Unmapped (${role.capability_type})`;
  }
}

export function FixtureBuilder() {
  const fixtureSummaries = useTaktStore((s) => s.fixtureSummaries);
  const fixtureDetailsCache = useTaktStore((s) => s.fixtureDetailsCache);
  const selectedFixtureId = useTaktStore((s) => s.selectedFixtureId);

  const loadFixtures = useTaktStore((s) => s.loadFixtures);
  const selectFixture = useTaktStore((s) => s.selectFixture);
  const validateFixtureJson = useTaktStore((s) => s.validateFixtureJson);
  const saveUserFixture = useTaktStore((s) => s.saveUserFixture);
  const deleteUserFixture = useTaktStore((s) => s.deleteUserFixture);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [editorMode, setEditorMode] = useState<"builder" | "raw">("builder");
  const [draft, setDraft] = useState<FixtureBuilderDraft>(
    createDefaultBuilderDraft,
  );
  const [rawJson, setRawJson] = useState<string>(() => {
    const initial =
      selectedFixtureId && fixtureDetailsCache[selectedFixtureId]
        ? fixtureDetailsCache[selectedFixtureId].raw_json
        : buildOflFixtureJson(createDefaultBuilderDraft());
    return initial;
  });
  const [validation, setValidation] = useState<FixtureValidationResult | null>(
    null,
  );
  const [selectedModeIdx, setSelectedModeIdx] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [saveSlug, setSaveSlug] = useState<string>("studio_rgbw_pixel_bar");

  useEffect(() => {
    void loadFixtures();
  }, [loadFixtures]);

  useEffect(() => {
    let cancelled = false;
    void validateFixtureJson(rawJson).then((res) => {
      if (!cancelled) {
        setValidation(res);
        setSelectedModeIdx((prev) =>
          prev < res.expanded_modes.length ? prev : 0,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [rawJson, validateFixtureJson]);

  const updateDraft = (updater: (prev: FixtureBuilderDraft) => FixtureBuilderDraft) => {
    setDraft((prev) => {
      const next = updater(prev);
      setRawJson(buildOflFixtureJson(next));
      setSaveSlug(sanitizeSlug(next.name) || "custom_fixture");
      setStatusMessage(null);
      return next;
    });
  };

  const handleSelectFixture = async (id: string) => {
    const detail = await selectFixture(id);
    if (detail) {
      setRawJson(detail.raw_json);
      setSelectedModeIdx(0);
      setSaveSlug(sanitizeSlug(detail.summary.name) || "custom_fixture");
      setStatusMessage(null);
      setEditorMode("raw");
    }
  };

  const handleNewDraft = () => {
    const fresh = createDefaultBuilderDraft();
    setDraft(fresh);
    setRawJson(buildOflFixtureJson(fresh));
    setSaveSlug(sanitizeSlug(fresh.name) || "custom_fixture");
    setSelectedModeIdx(0);
    setEditorMode("builder");
    setStatusMessage(null);
  };

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRawJson(text);
    setEditorMode("raw");
    const slug = sanitizeSlug(file.name.replace(/\.json$/i, "")) || "imported_fixture";
    setSaveSlug(slug);
    const res = await saveUserFixture(slug, text);
    if (res.ok) {
      setStatusMessage(`Imported ${res.detail.summary.name} into local library`);
    } else {
      setStatusMessage("Imported file failed OFL schema validation");
    }
    e.target.value = "";
  };

  const handleSave = async () => {
    let slug = saveSlug;
    try {
      const parsed = JSON.parse(rawJson) as { name?: string };
      if (parsed.name && editorMode === "builder") {
        slug = sanitizeSlug(parsed.name) || slug;
      } else if (parsed.name && !slug) {
        slug = sanitizeSlug(parsed.name) || "custom_fixture";
      }
    } catch {
      // Let backend / validator report invalid JSON
    }
    const res = await saveUserFixture(slug, rawJson);
    if (res.ok) {
      setStatusMessage(`Saved ${res.detail.summary.id}`);
    } else {
      setStatusMessage("Save rejected: fix schema validation issues");
    }
  };

  const handleExportJson = () => {
    const blob = new Blob([rawJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${saveSlug || "fixture"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const activeMode = validation?.expanded_modes[selectedModeIdx] ?? null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
      {/* Left Column: Local OFL Library & Offline Importer */}
      <section className="lg:col-span-3 bg-slate border-[1.5px] border-steel rounded-panel p-4 flex flex-col gap-3">
        <h2 className="font-sans text-base font-semibold text-mist">
          Local OFL Fixture Library
        </h2>

        <div className="flex flex-col gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            aria-label="Import OFL JSON File"
            onChange={(e) => {
              void handleImportFile(e);
            }}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-ink border border-steel hover:border-ember text-mist font-sans text-xs font-medium transition-colors"
          >
            <FolderUp className="w-4 h-4 text-ember" />
            <span>Import OFL JSON</span>
          </button>

          <button
            type="button"
            onClick={handleNewDraft}
            className="flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-ember hover:bg-burnt text-frost font-sans text-xs font-semibold transition-colors"
          >
            <FilePlus2 className="w-4 h-4" />
            <span>New Builder Draft</span>
          </button>
        </div>

        <div className="flex flex-col gap-2 max-h-[540px] overflow-y-auto pr-1">
          {fixtureSummaries.map((item) => {
            const isSelected = item.id === selectedFixtureId;
            return (
              <div
                key={item.id}
                className={`rounded-md border p-2.5 transition-colors bg-pitch ${
                  isSelected
                    ? "border-ember"
                    : "border-steel/70 hover:border-fog"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void handleSelectFixture(item.id);
                    }}
                    className="text-left flex-1 min-w-0"
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <span
                        className={`font-mono text-[9px] uppercase px-1.5 py-0.5 rounded border ${
                          item.origin === "age_built_in"
                            ? "bg-pine/25 border-pine text-mist"
                            : "bg-cobalt/25 border-cobalt text-mist"
                        }`}
                      >
                        {item.origin === "age_built_in" ? "AGE" : "USER"}
                      </span>
                      <span className="font-mono text-[10px] text-fog">
                        {item.pixel_count > 1
                          ? `${item.pixel_count} PX`
                          : "1 CELL"}
                      </span>
                    </div>
                    <div className="font-sans text-sm font-medium text-mist truncate">
                      {item.name}
                    </div>
                    <div className="font-mono text-[11px] text-fog mt-0.5">
                      {item.modes.map((m) => m.short_name).join(" | ")}
                    </div>
                  </button>

                  {item.origin === "user_local" && (
                    <button
                      type="button"
                      aria-label={`Delete ${item.name}`}
                      onClick={() => {
                        void deleteUserFixture(item.id);
                      }}
                      className="p-1 text-fog hover:text-signal transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Center Column: Visual Builder & Raw OFL JSON Editor */}
      <section className="lg:col-span-5 bg-slate border-[1.5px] border-steel rounded-panel p-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-sans text-base font-semibold text-mist">
            Visual Fixture Builder
          </h2>

          <div className="flex items-center gap-1 bg-ink border border-steel rounded-md p-0.5">
            <button
              type="button"
              aria-pressed={editorMode === "builder"}
              onClick={() => setEditorMode("builder")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded font-mono text-xs transition-colors ${
                editorMode === "builder"
                  ? "bg-ember text-frost font-medium"
                  : "text-fog hover:text-mist"
              }`}
            >
              <Wrench className="w-3.5 h-3.5" />
              <span>Visual Builder</span>
            </button>
            <button
              type="button"
              aria-pressed={editorMode === "raw"}
              onClick={() => setEditorMode("raw")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded font-mono text-xs transition-colors ${
                editorMode === "raw"
                  ? "bg-ember text-frost font-medium"
                  : "text-fog hover:text-mist"
              }`}
            >
              <Code2 className="w-3.5 h-3.5" />
              <span>Raw JSON Editor</span>
            </button>
          </div>
        </div>

        {editorMode === "builder" ? (
          <div className="flex flex-col gap-3">
            {/* Metadata */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase text-fog">
                  Fixture Name
                </span>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) =>
                    updateDraft((d) => ({ ...d, name: e.target.value }))
                  }
                  className="bg-ink border border-steel rounded px-2.5 py-1.5 text-sm text-mist focus:outline-none focus:border-ember"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase text-fog">
                  Short Name
                </span>
                <input
                  type="text"
                  value={draft.shortName}
                  onChange={(e) =>
                    updateDraft((d) => ({ ...d, shortName: e.target.value }))
                  }
                  className="bg-ink border border-steel rounded px-2.5 py-1.5 text-sm text-mist font-mono focus:outline-none focus:border-ember"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase text-fog">
                  Category
                </span>
                <select
                  value={draft.category}
                  onChange={(e) =>
                    updateDraft((d) => ({ ...d, category: e.target.value }))
                  }
                  className="bg-ink border border-steel rounded px-2.5 py-1.5 text-sm text-mist focus:outline-none focus:border-ember"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase text-fog">
                  Mode Name
                </span>
                <input
                  type="text"
                  value={draft.modeName}
                  onChange={(e) =>
                    updateDraft((d) => ({ ...d, modeName: e.target.value }))
                  }
                  className="bg-ink border border-steel rounded px-2.5 py-1.5 text-sm text-mist focus:outline-none focus:border-ember"
                />
              </label>
            </div>

            {/* Matrix / Pixel Config */}
            <div className="bg-pitch border border-steel rounded-md p-3 flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-mist flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-ember" />
                  <span>Matrix & Pixel Expansion</span>
                </span>
                <label className="flex items-center gap-2 font-mono text-xs text-mist cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.isMatrix}
                    disabled={draft.colorMode === "wheel"}
                    onChange={(e) =>
                      updateDraft((d) => ({ ...d, isMatrix: e.target.checked }))
                    }
                    className="accent-ember"
                  />
                  <span>Multi Cell</span>
                </label>
              </div>

              {draft.isMatrix && draft.colorMode !== "wheel" && (
                <div className="grid grid-cols-4 gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="font-mono text-[10px] text-fog">X</span>
                    <input
                      type="number"
                      min={1}
                      max={128}
                      value={draft.pixelCountX}
                      onChange={(e) =>
                        updateDraft((d) => ({
                          ...d,
                          pixelCountX: Math.max(1, Number(e.target.value)),
                        }))
                      }
                      className="bg-ink border border-steel rounded px-2 py-1 font-mono text-xs text-mist"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="font-mono text-[10px] text-fog">Y</span>
                    <input
                      type="number"
                      min={1}
                      max={64}
                      value={draft.pixelCountY}
                      onChange={(e) =>
                        updateDraft((d) => ({
                          ...d,
                          pixelCountY: Math.max(1, Number(e.target.value)),
                        }))
                      }
                      className="bg-ink border border-steel rounded px-2 py-1 font-mono text-xs text-mist"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="font-mono text-[10px] text-fog">Z</span>
                    <input
                      type="number"
                      min={1}
                      max={16}
                      value={draft.pixelCountZ}
                      onChange={(e) =>
                        updateDraft((d) => ({
                          ...d,
                          pixelCountZ: Math.max(1, Number(e.target.value)),
                        }))
                      }
                      className="bg-ink border border-steel rounded px-2 py-1 font-mono text-xs text-mist"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="font-mono text-[10px] text-fog">
                      Order
                    </span>
                    <select
                      value={draft.channelOrder}
                      onChange={(e) =>
                        updateDraft((d) => ({
                          ...d,
                          channelOrder: e.target.value as
                            | "perPixel"
                            | "perChannel",
                        }))
                      }
                      className="bg-ink border border-steel rounded px-1.5 py-1 font-mono text-xs text-mist"
                    >
                      <option value="perPixel">perPixel</option>
                      <option value="perChannel">perChannel</option>
                    </select>
                  </label>
                </div>
              )}
            </div>

            {/* Channel Composition */}
            <div className="bg-pitch border border-steel rounded-md p-3 flex flex-col gap-2.5">
              <div className="font-mono text-xs text-mist">
                Channels & Capabilities
              </div>

              <div className="flex flex-wrap gap-4 text-xs font-mono text-mist">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.includeMasterDimmer}
                    onChange={(e) =>
                      updateDraft((d) => ({
                        ...d,
                        includeMasterDimmer: e.target.checked,
                      }))
                    }
                    className="accent-ember"
                  />
                  <span>Master Dimmer</span>
                </label>

                {draft.includeMasterDimmer && (
                  <label className="flex items-center gap-1.5 cursor-pointer text-fog">
                    <input
                      type="checkbox"
                      checked={draft.dimmer16Bit}
                      onChange={(e) =>
                        updateDraft((d) => ({
                          ...d,
                          dimmer16Bit: e.target.checked,
                        }))
                      }
                      className="accent-ember"
                    />
                    <span>16 Bit Fine</span>
                  </label>
                )}

                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.includeStrobe}
                    onChange={(e) =>
                      updateDraft((d) => ({
                        ...d,
                        includeStrobe: e.target.checked,
                      }))
                    }
                    className="accent-ember"
                  />
                  <span>Hardware Strobe</span>
                </label>

                {draft.includeStrobe && (
                  <label className="flex items-center gap-1.5 cursor-pointer text-fog">
                    <input
                      type="checkbox"
                      checked={draft.strobeRandom}
                      onChange={(e) =>
                        updateDraft((d) => ({
                          ...d,
                          strobeRandom: e.target.checked,
                        }))
                      }
                      className="accent-ember"
                    />
                    <span>Random Strobe</span>
                  </label>
                )}
              </div>

              {/* Color Mixing Mode */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="font-mono text-[11px] text-fog">
                  Color System:
                </span>
                {(["rgb", "rgbw", "wheel"] as const).map((cm) => (
                  <button
                    key={cm}
                    type="button"
                    onClick={() =>
                      updateDraft((d) => ({
                        ...d,
                        colorMode: cm,
                        isMatrix: cm === "wheel" ? false : d.isMatrix,
                      }))
                    }
                    className={`px-2.5 py-1 rounded font-mono text-xs uppercase border transition-colors ${
                      draft.colorMode === cm
                        ? "bg-ember/20 border-ember text-mist"
                        : "bg-ink border-steel text-fog hover:text-mist"
                    }`}
                  >
                    {cm === "wheel" ? "Color Wheel" : cm}
                  </button>
                ))}
              </div>

              {draft.colorMode === "wheel" && (
                <div className="flex flex-col gap-1.5 pt-1">
                  {draft.wheelSlots.map((slot, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        value={slot.type}
                        onChange={(e) =>
                          updateDraft((d) => {
                            const next = [...d.wheelSlots];
                            next[idx] = {
                              ...next[idx],
                              type: e.target.value as "Open" | "Color",
                            };
                            return { ...d, wheelSlots: next };
                          })
                        }
                        className="bg-ink border border-steel rounded px-2 py-1 font-mono text-xs text-mist"
                      >
                        <option value="Open">Open</option>
                        <option value="Color">Color</option>
                      </select>
                      <input
                        type="text"
                        value={slot.name}
                        onChange={(e) =>
                          updateDraft((d) => {
                            const next = [...d.wheelSlots];
                            next[idx] = { ...next[idx], name: e.target.value };
                            return { ...d, wheelSlots: next };
                          })
                        }
                        className="flex-1 bg-ink border border-steel rounded px-2 py-1 text-xs text-mist"
                      />
                      {slot.type === "Color" && (
                        <input
                          type="color"
                          value={slot.colorHex}
                          onChange={(e) =>
                            updateDraft((d) => {
                              const next = [...d.wheelSlots];
                              next[idx] = {
                                ...next[idx],
                                colorHex: e.target.value,
                              };
                              return { ...d, wheelSlots: next };
                            })
                          }
                          className="w-8 h-6 bg-transparent border border-steel rounded cursor-pointer"
                        />
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      updateDraft((d) => ({
                        ...d,
                        wheelSlots: [
                          ...d.wheelSlots,
                          {
                            type: "Color",
                            name: `Slot ${d.wheelSlots.length + 1}`,
                            colorHex: "#8833AA",
                          },
                        ],
                      }))
                    }
                    className="self-start flex items-center gap-1 font-mono text-[11px] text-ember hover:underline"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Add Wheel Slot</span>
                  </button>
                </div>
              )}

              {/* Custom Unmapped / Macro Channels */}
              <div className="flex flex-col gap-1.5 pt-1 border-t border-steel/40">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase text-fog">
                    Unmapped Control / Macro Channels
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      updateDraft((d) => ({
                        ...d,
                        customChannels: [
                          ...d.customChannels,
                          {
                            name: `Macro ${d.customChannels.length + 1}`,
                            defaultValue: 0,
                          },
                        ],
                      }))
                    }
                    className="flex items-center gap-1 font-mono text-[11px] text-ember hover:underline"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Add Control Channel</span>
                  </button>
                </div>

                {draft.customChannels.map((ch, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={ch.name}
                      onChange={(e) =>
                        updateDraft((d) => {
                          const next = [...d.customChannels];
                          next[idx] = { ...next[idx], name: e.target.value };
                          return { ...d, customChannels: next };
                        })
                      }
                      className="flex-1 bg-ink border border-steel rounded px-2 py-1 text-xs text-mist"
                    />
                    <span className="font-mono text-[10px] text-fog">DEF</span>
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={ch.defaultValue}
                      onChange={(e) =>
                        updateDraft((d) => {
                          const next = [...d.customChannels];
                          next[idx] = {
                            ...next[idx],
                            defaultValue: Number(e.target.value),
                          };
                          return { ...d, customChannels: next };
                        })
                      }
                      className="w-16 bg-ink border border-steel rounded px-2 py-1 font-mono text-xs text-mist"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <textarea
            aria-label="Raw OFL JSON Editor"
            value={rawJson}
            onChange={(e) => {
              setRawJson(e.target.value);
              setStatusMessage(null);
            }}
            spellCheck={false}
            className="w-full h-[380px] bg-pitch border border-steel rounded-md p-3 font-mono text-xs text-mist leading-relaxed focus:outline-none focus:border-ember resize-y"
          />
        )}

        {/* Save & Export Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-steel/50">
          <div className="font-mono text-xs text-fog">
            {statusMessage ?? ""}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportJson}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-ink border border-steel hover:border-fog text-mist font-mono text-xs transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export JSON</span>
            </button>

            <button
              type="button"
              onClick={() => {
                void handleSave();
              }}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-ember hover:bg-burnt text-frost font-mono text-xs font-semibold transition-colors"
            >
              <Save className="w-3.5 h-3.5" />
              <span>Save to User Library</span>
            </button>
          </div>
        </div>
      </section>

      {/* Right Column: Schema Validator & Expanded DMX Footprint */}
      <section className="lg:col-span-4 bg-slate border-[1.5px] border-steel rounded-panel p-4 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-sans text-base font-semibold text-mist">
            Channel Footprint
          </h2>

          {validation?.valid ? (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-pine/25 border border-pine text-mist font-mono text-[11px] font-medium">
              <CheckCircle2 className="w-3.5 h-3.5 text-pine" />
              <span>VALID OFL SCHEMA</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-signal/25 border border-signal text-frost font-mono text-[11px] font-semibold">
              <ShieldAlert className="w-3.5 h-3.5 text-signal" />
              <span>SCHEMA INVALID</span>
            </div>
          )}
        </div>

        {/* Schema Errors */}
        {validation && !validation.valid && (
          <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto">
            {validation.issues.map((issue, idx) => (
              <div
                key={idx}
                className="bg-pitch border border-signal rounded p-2 font-mono text-[11px]"
              >
                <div className="text-frost font-semibold">
                  {issue.instance_path || "/"}
                </div>
                <div className="text-fog mt-0.5">{issue.message}</div>
              </div>
            ))}
          </div>
        )}

        {/* Mode Selector Pills */}
        {validation && validation.expanded_modes.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {validation.expanded_modes.map((m, idx) => (
              <button
                key={m.name}
                type="button"
                onClick={() => setSelectedModeIdx(idx)}
                className={`px-2.5 py-1 rounded font-mono text-xs border transition-colors ${
                  idx === selectedModeIdx
                    ? "bg-ember/20 border-ember text-mist"
                    : "bg-pitch border-steel text-fog hover:text-mist"
                }`}
              >
                {m.name} ({m.channel_count}ch)
              </button>
            ))}
          </div>
        )}

        {/* Cell Mapping Strip */}
        {activeMode && (
          <div className="bg-pitch border border-steel rounded p-2.5 flex flex-wrap gap-1">
            {activeMode.cells.map((cell) => (
              <span
                key={cell.cell_index}
                className="px-1.5 py-0.5 rounded bg-ink border border-steel font-mono text-[10px] text-mist"
              >
                C{cell.cell_index} → K{cell.pixel_key}
              </span>
            ))}
          </div>
        )}

        {/* Expanded DMX Channel List */}
        {activeMode && (
          <div className="flex flex-col gap-1 max-h-[340px] overflow-y-auto pr-1">
            {activeMode.channels.map((ch) => (
              <div
                key={ch.dmx_offset}
                className="flex items-center justify-between gap-2 bg-pitch border border-steel/60 rounded px-2.5 py-1.5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-xs text-ember w-9 shrink-0">
                    CH{String(ch.channel_number).padStart(2, "0")}
                  </span>
                  <div className="min-w-0">
                    <div className="font-sans text-xs font-medium text-mist truncate">
                      {ch.name}
                    </div>
                    <div className="font-mono text-[10px] text-fog truncate">
                      {describeRole(ch.role)} | DEF {ch.default_value}
                    </div>
                  </div>
                </div>

                <span
                  className={`font-mono text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${
                    ch.target.scope === "fixture"
                      ? "bg-ink border-steel text-fog"
                      : "bg-cobalt/20 border-cobalt text-mist"
                  }`}
                >
                  {ch.target.scope === "fixture"
                    ? "FIXTURE"
                    : `CELL ${ch.target.cell_index}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
