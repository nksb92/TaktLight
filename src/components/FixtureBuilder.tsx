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
  orderOflChannelKeys,
  parseOflJsonToDraft,
  resolveDraftColorNames,
  RGB_CHANNEL_ORDERS,
  RgbChannelOrder,
  sanitizeSlug,
  WhiteChannelMode,
  WhiteChannelPosition,
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
  const [editingSource, setEditingSource] = useState<
    | { kind: "new" }
    | { kind: "user"; id: string; name: string }
    | { kind: "built_in"; id: string; name: string }
  >(() => {
    const initial = selectedFixtureId
      ? fixtureSummaries.find((f) => f.id === selectedFixtureId)
      : null;
    if (initial) {
      return initial.origin === "user_local"
        ? { kind: "user", id: initial.id, name: initial.name }
        : { kind: "built_in", id: initial.id, name: initial.name };
    }
    return { kind: "new" };
  });
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
      const generatedJson = buildOflFixtureJson(next);
      setRawJson((prevRaw) => {
        try {
          const prevParsed = JSON.parse(prevRaw) as {
            matrix?: { pixelGroups?: Record<string, unknown> };
            modes?: { name: string; shortName?: string; channels: unknown[] }[];
          };
          if (Array.isArray(prevParsed.modes) && prevParsed.modes.length === 0) {
            const genParsed = JSON.parse(generatedJson) as { modes?: unknown[] };
            genParsed.modes = [];
            return JSON.stringify(genParsed, null, 2);
          }
          if (Array.isArray(prevParsed.modes) && prevParsed.modes.length > 1) {
            const genParsed = JSON.parse(generatedJson) as {
              availableChannels?: Record<string, unknown>;
              templateChannels?: Record<string, unknown>;
              matrix?: { pixelGroups?: Record<string, unknown> };
              modes?: { name: string; shortName?: string; channels: unknown[] }[];
            };
            if (genParsed.matrix && prevParsed.matrix?.pixelGroups) {
              genParsed.matrix.pixelGroups = {
                ...prevParsed.matrix.pixelGroups,
                ...(genParsed.matrix.pixelGroups ?? {}),
              };
            }
            if (Array.isArray(genParsed.modes) && genParsed.modes.length >= 1) {
              const availSet = new Set(Object.keys(genParsed.availableChannels ?? {}));
              const tmplSet = new Set(Object.keys(genParsed.templateChannels ?? {}));
              const fallbackCh = Object.keys(genParsed.availableChannels ?? {})[0];
              const sanitizedExtraModes = prevParsed.modes.slice(1).map((m) => {
                const rawChs = Array.isArray(m.channels) ? m.channels : [];
                const validChs: unknown[] = [];
                for (const entry of rawChs) {
                  if (typeof entry === "string") {
                    if (availSet.has(entry)) validChs.push(entry);
                  } else if (
                    entry &&
                    typeof entry === "object" &&
                    (entry as { insert?: string }).insert === "matrixChannels" &&
                    genParsed.matrix
                  ) {
                    const mc = entry as {
                      insert: string;
                      repeatFor?: unknown;
                      channelOrder?: unknown;
                      templateChannels?: unknown[];
                    };
                    const validTmpls = Array.isArray(mc.templateChannels)
                      ? mc.templateChannels.filter(
                          (t) => typeof t === "string" && tmplSet.has(t),
                        )
                      : [];
                    if (validTmpls.length > 0) {
                      validChs.push({ ...mc, templateChannels: validTmpls });
                    }
                  }
                }
                if (validChs.length === 0 && fallbackCh) {
                  validChs.push(fallbackCh);
                }
                return { ...m, channels: validChs };
              });
              genParsed.modes = [genParsed.modes[0], ...sanitizedExtraModes];
              return JSON.stringify(genParsed, null, 2);
            }
          }
        } catch {
          // Fall back to freshly generated JSON if previous JSON was malformed
        }
        return generatedJson;
      });
      setSaveSlug(sanitizeSlug(next.name) || "custom_fixture");
      setStatusMessage(null);
      return next;
    });
  };

  const handleSelectFixture = async (id: string) => {
    const detail = await selectFixture(id);
    if (detail) {
      setRawJson(detail.raw_json);
      const parsedDraft = parseOflJsonToDraft(detail.raw_json);
      if (parsedDraft) {
        setDraft(parsedDraft);
        setEditorMode("builder");
      } else {
        setEditorMode("raw");
      }
      setEditingSource(
        detail.summary.origin === "user_local"
          ? { kind: "user", id: detail.summary.id, name: detail.summary.name }
          : { kind: "built_in", id: detail.summary.id, name: detail.summary.name },
      );
      setSelectedModeIdx(0);
      setSaveSlug(sanitizeSlug(detail.summary.name) || "custom_fixture");
      setStatusMessage(null);
    }
  };

  const handleNewDraft = () => {
    const fresh = createDefaultBuilderDraft();
    setDraft(fresh);
    setRawJson(buildOflFixtureJson(fresh, { includeDefaultMode: false }));
    setEditingSource({ kind: "new" });
    setSaveSlug(sanitizeSlug(fresh.name) || "custom_fixture");
    setSelectedModeIdx(0);
    setEditorMode("builder");
    setStatusMessage(null);
  };

  const handleAddMode = () => {
    try {
      const parsed = JSON.parse(rawJson) as {
        availableChannels?: Record<string, unknown>;
        templateChannels?: Record<string, unknown>;
        matrix?: unknown;
        modes?: { name: string; shortName?: string; channels: unknown[] }[];
      };
      const modes = Array.isArray(parsed.modes) ? [...parsed.modes] : [];
      const draftParsed = JSON.parse(buildOflFixtureJson(draft)) as {
        modes?: { name: string; shortName?: string; channels: unknown[] }[];
      };
      const templateMode = draftParsed.modes?.[0];
      if (modes.length === 0 && templateMode) {
        modes.push(templateMode);
        parsed.modes = modes;
        setRawJson(JSON.stringify(parsed, null, 2));
        setSelectedModeIdx(0);
        setStatusMessage(`Added ${templateMode.name}`);
        return;
      }
      const preferredColors = resolveDraftColorNames(draft);
      const availKeys = orderOflChannelKeys(
        Object.keys(parsed.availableChannels ?? {}),
        parsed.availableChannels,
        preferredColors,
      );
      const tmplKeys = orderOflChannelKeys(
        Object.keys(parsed.templateChannels ?? {}),
        parsed.templateChannels,
        preferredColors,
      );
      const nextIndex = modes.length + 1;
      const defaultChannels: unknown[] = [...availKeys];
      if (parsed.matrix && tmplKeys.length > 0) {
        defaultChannels.push({
          insert: "matrixChannels",
          repeatFor: "eachPixelABC",
          channelOrder: draft.channelOrder,
          templateChannels: tmplKeys,
        });
      }
      modes.push({
        name: `Mode ${nextIndex}`,
        shortName: `M${nextIndex}`,
        channels: defaultChannels,
      });
      parsed.modes = modes;
      setRawJson(JSON.stringify(parsed, null, 2));
      setSelectedModeIdx(modes.length - 1);
      setStatusMessage(`Added Mode ${nextIndex}`);
    } catch {
      setStatusMessage("Cannot add mode: fix JSON syntax first");
    }
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

  const parsedRawOfl = (() => {
    try {
      return JSON.parse(rawJson) as {
        availableChannels?: Record<string, unknown>;
        templateChannels?: Record<string, unknown>;
        modes?: { name: string; shortName?: string; channels: unknown[] }[];
      };
    } catch {
      return null;
    }
  })();

  const availableChannelNames = Object.keys(parsedRawOfl?.availableChannels ?? {});
  const selectedRawMode = parsedRawOfl?.modes?.[selectedModeIdx] ?? null;

  const updateSelectedMode = (
    updater: (mode: { name: string; shortName?: string; channels: unknown[] }) => {
      name: string;
      shortName?: string;
      channels: unknown[];
    },
  ) => {
    try {
      const parsed = JSON.parse(rawJson) as {
        modes?: { name: string; shortName?: string; channels: unknown[] }[];
      };
      if (!Array.isArray(parsed.modes) || !parsed.modes[selectedModeIdx]) return;
      parsed.modes[selectedModeIdx] = updater({ ...parsed.modes[selectedModeIdx] });
      setRawJson(JSON.stringify(parsed, null, 2));
      setStatusMessage(null);
    } catch {
      // Ignore if raw JSON is currently invalid
    }
  };

  const handleSetModeSegments = (segCount: number) => {
    try {
      const parsed = JSON.parse(rawJson) as {
        matrix?: {
          pixelCount?: number[];
          pixelGroups?: Record<string, unknown>;
        };
        templateChannels?: Record<string, unknown>;
        modes?: { name: string; shortName?: string; channels: unknown[] }[];
      };
      if (!parsed.matrix || !Array.isArray(parsed.modes) || !parsed.modes[selectedModeIdx]) {
        return;
      }
      const tmplKeys = orderOflChannelKeys(
        Object.keys(parsed.templateChannels ?? {}),
        parsed.templateChannels,
        resolveDraftColorNames(draft),
      );
      if (tmplKeys.length === 0) return;

      const pc = Array.isArray(parsed.matrix.pixelCount) ? parsed.matrix.pixelCount : [1, 1, 1];
      const nx = Math.max(1, Number(pc[0]) || 1);
      const ny = Math.max(1, Number(pc[1]) || 1);
      const nz = Math.max(1, Number(pc[2]) || 1);
      const totalPx = nx * ny * nz;

      // Build canonical 1-based pixel keys matching OFL format_pixel_key
      const allKeys: string[] = [];
      for (let z = 0; z < nz; z += 1) {
        for (let y = 0; y < ny; y += 1) {
          for (let x = 0; x < nx; x += 1) {
            if (ny === 1 && nz === 1) allKeys.push(`${x + 1}`);
            else if (nz === 1) allKeys.push(`${x + 1}-${y + 1}`);
            else allKeys.push(`${x + 1}-${y + 1}-${z + 1}`);
          }
        }
      }

      let repeatFor: string | string[] = "eachPixelABC";
      if (segCount < totalPx && segCount >= 1) {
        const groups: Record<string, unknown> = {
          ...(parsed.matrix.pixelGroups ?? { All: "all" }),
        };
        const segKeys: string[] = [];
        const perSeg = Math.max(1, Math.floor(totalPx / segCount));
        for (let s = 0; s < segCount; s += 1) {
          const start = s * perSeg;
          const end = s === segCount - 1 ? totalPx : (s + 1) * perSeg;
          const gName = `Seg${segCount}_${s + 1}`;
          groups[gName] = allKeys.slice(start, end);
          segKeys.push(gName);
        }
        parsed.matrix.pixelGroups = groups;
        repeatFor = segKeys;
      }

      const mode = { ...parsed.modes[selectedModeIdx] };
      const existingIdx = mode.channels.findIndex(
        (c) =>
          c &&
          typeof c === "object" &&
          (c as { insert?: string }).insert === "matrixChannels",
      );
      const existingEntry =
        existingIdx >= 0
          ? (mode.channels[existingIdx] as { templateChannels?: unknown[] })
          : null;
      const existingTmpls = Array.isArray(existingEntry?.templateChannels)
        ? existingEntry.templateChannels.filter(
            (t): t is string =>
              typeof t === "string" && tmplKeys.includes(t),
          )
        : [];
      const nextInsert = {
        insert: "matrixChannels",
        repeatFor,
        channelOrder: draft.channelOrder,
        templateChannels: existingTmpls.length > 0 ? existingTmpls : tmplKeys,
      };
      if (existingIdx >= 0) {
        mode.channels = mode.channels.map((c, i) => (i === existingIdx ? nextInsert : c));
      } else {
        mode.channels = [...mode.channels, nextInsert];
      }
      parsed.modes[selectedModeIdx] = mode;
      setRawJson(JSON.stringify(parsed, null, 2));
      setStatusMessage(null);
    } catch {
      // Ignore invalid JSON
    }
  };

  const handleDeleteSelectedMode = () => {
    try {
      const parsed = JSON.parse(rawJson) as {
        modes?: { name: string; shortName?: string; channels: unknown[] }[];
      };
      if (!Array.isArray(parsed.modes) || parsed.modes.length === 0) return;
      parsed.modes.splice(selectedModeIdx, 1);
      setRawJson(JSON.stringify(parsed, null, 2));
      setSelectedModeIdx((prev) => Math.max(0, Math.min(prev, parsed.modes!.length - 1)));
      setStatusMessage("Removed mode");
    } catch {
      // Ignore
    }
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
      <section className="lg:col-span-5 bg-slate border-[1.5px] border-steel rounded-panel p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-sans text-base font-semibold text-mist">
            1. Fixture Hardware &amp; Channels
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

        {/* Editing Context Banner */}
        <div
          data-testid="fixture-builder-context-banner"
          className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 font-mono text-[11px] ${
            editingSource.kind === "new"
              ? "bg-ember/15 border-ember/60 text-frost"
              : editingSource.kind === "user"
                ? "bg-cobalt/15 border-cobalt/60 text-frost"
                : "bg-pitch border-steel text-mist"
          }`}
        >
          <span>
            {editingSource.kind === "new"
              ? "NEW DRAFT — Unsaved custom fixture (configure hardware, then add DMX modes on the right)"
              : editingSource.kind === "user"
                ? `EDITING USER FIXTURE: ${editingSource.name} (${editingSource.id})`
                : `BUILT-IN PRESET: ${editingSource.name} (saving creates a User Copy)`}
          </span>
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

              <label className="flex flex-col gap-1 sm:col-span-2">
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
              <div className="flex flex-col gap-2 pt-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] text-fog">
                    Color System:
                  </span>
                  {(
                    [
                      { id: "rgb", label: "RGB Mixing" },
                      { id: "wheel", label: "Color Wheel" },
                    ] as const
                  ).map((cm) => (
                    <button
                      key={cm.id}
                      type="button"
                      onClick={() =>
                        updateDraft((d) => ({
                          ...d,
                          colorMode: cm.id,
                          isMatrix: cm.id === "wheel" ? false : d.isMatrix,
                        }))
                      }
                      className={`px-2.5 py-1 rounded font-mono text-xs border transition-colors ${
                        draft.colorMode === cm.id
                          ? "bg-ember/20 border-ember text-mist"
                          : "bg-ink border-steel text-fog hover:text-mist"
                      }`}
                    >
                      {cm.label}
                    </button>
                  ))}
                </div>

                {draft.colorMode === "rgb" && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-0.5">
                    <label className="flex flex-col gap-1">
                      <span className="font-mono text-[10px] uppercase text-fog">
                        RGB Order
                      </span>
                      <select
                        aria-label="RGB Color Order"
                        value={draft.rgbOrder}
                        onChange={(e) =>
                          updateDraft((d) => ({
                            ...d,
                            rgbOrder: e.target.value as RgbChannelOrder,
                          }))
                        }
                        className="bg-ink border border-steel rounded px-2 py-1 font-mono text-xs text-mist focus:outline-none focus:border-ember"
                      >
                        {RGB_CHANNEL_ORDERS.map((order) => (
                          <option key={order} value={order}>
                            {order}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="font-mono text-[10px] uppercase text-fog">
                        White / CCT
                      </span>
                      <select
                        aria-label="White Channel Mode"
                        value={draft.whiteMode}
                        onChange={(e) =>
                          updateDraft((d) => ({
                            ...d,
                            whiteMode: e.target.value as WhiteChannelMode,
                          }))
                        }
                        className="bg-ink border border-steel rounded px-2 py-1 font-mono text-xs text-mist focus:outline-none focus:border-ember"
                      >
                        <option value="none">None</option>
                        <option value="white">White (W)</option>
                        <option value="ww_cw">Warm + Cold White (WW/CW)</option>
                      </select>
                    </label>

                    {draft.whiteMode !== "none" && (
                      <label className="flex flex-col gap-1">
                        <span className="font-mono text-[10px] uppercase text-fog">
                          White Position
                        </span>
                        <select
                          aria-label="White Channel Position"
                          value={draft.whitePosition}
                          onChange={(e) =>
                            updateDraft((d) => ({
                              ...d,
                              whitePosition: e.target
                                .value as WhiteChannelPosition,
                            }))
                          }
                          className="bg-ink border border-steel rounded px-2 py-1 font-mono text-xs text-mist focus:outline-none focus:border-ember"
                        >
                          <option value="after">
                            After RGB ({draft.rgbOrder}
                            {draft.whiteMode === "ww_cw" ? "WWCW" : "W"})
                          </option>
                          <option value="before">
                            Before RGB (
                            {draft.whiteMode === "ww_cw" ? "WWCW" : "W"}
                            {draft.rgbOrder})
                          </option>
                        </select>
                      </label>
                    )}
                  </div>
                )}
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
                      {draft.wheelSlots.length > 1 && (
                        <button
                          type="button"
                          aria-label={`Delete wheel slot ${idx + 1}`}
                          title="Delete wheel slot"
                          onClick={() =>
                            updateDraft((d) => ({
                              ...d,
                              wheelSlots: d.wheelSlots.filter((_, i) => i !== idx),
                            }))
                          }
                          className="p-1 rounded bg-ink border border-steel text-fog hover:text-signal hover:border-signal transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
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
                    <button
                      type="button"
                      aria-label={`Delete control channel ${ch.name}`}
                      title="Delete control channel"
                      onClick={() =>
                        updateDraft((d) => ({
                          ...d,
                          customChannels: d.customChannels.filter(
                            (_, i) => i !== idx,
                          ),
                        }))
                      }
                      className="p-1 rounded bg-ink border border-steel text-fog hover:text-signal hover:border-signal transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
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
            2. DMX Modes &amp; Channel Footprint
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

        {/* Modes Section & Add Mode */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-fog">
              Modes ({validation?.expanded_modes.length ?? 0})
            </span>
            <button
              type="button"
              data-testid="add-mode-btn"
              onClick={handleAddMode}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-ink border border-steel hover:border-ember font-mono text-[11px] text-frost transition-colors"
            >
              <Plus className="w-3 h-3 text-ember" />
              <span>Add Mode</span>
            </button>
          </div>
          {validation && validation.expanded_modes.length > 0 ? (
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
          ) : (
            <div className="bg-pitch border border-dashed border-steel rounded px-2.5 py-2 font-mono text-[11px] text-fog">
              No modes defined yet. Click &ldquo;Add Mode&rdquo; to create a DMX channel mode for this fixture.
            </div>
          )}

          {/* Visual Mode Configurator for the selected mode */}
          {selectedRawMode && (
            <div
              data-testid="visual-mode-config"
              className="bg-pitch border border-steel rounded p-2.5 flex flex-col gap-2"
            >
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 flex-1 min-w-0">
                  <span className="font-mono text-[10px] text-fog uppercase shrink-0">
                    Mode Name
                  </span>
                  <input
                    type="text"
                    aria-label="Selected Mode Name"
                    value={selectedRawMode.name}
                    onChange={(e) =>
                      updateSelectedMode((m) => ({ ...m, name: e.target.value }))
                    }
                    className="flex-1 min-w-0 bg-ink border border-steel rounded px-1.5 py-0.5 font-mono text-xs text-mist"
                  />
                </label>
                {(parsedRawOfl?.modes?.length ?? 0) >= 1 && (
                  <button
                    type="button"
                    data-testid="delete-selected-mode-btn"
                    onClick={handleDeleteSelectedMode}
                    className="px-2 py-0.5 rounded bg-ink border border-steel hover:border-signal font-mono text-[10px] text-fog hover:text-signal"
                  >
                    Delete Mode
                  </button>
                )}
              </div>

              {(availableChannelNames.length > 0 ||
                Object.keys(parsedRawOfl?.templateChannels ?? {}).length > 0) && (
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-[10px] text-fog uppercase">
                    Mode Channels (toggle to include)
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {availableChannelNames.map((chName) => {
                      const included = selectedRawMode.channels.includes(chName);
                      return (
                        <button
                          key={chName}
                          type="button"
                          data-testid={`mode-ch-toggle-${chName}`}
                          aria-pressed={included}
                          onClick={() =>
                            updateSelectedMode((m) => {
                              const exists = m.channels.includes(chName);
                              const nextChannels = exists
                                ? m.channels.filter((c) => c !== chName)
                                : [...m.channels, chName];
                              return {
                                ...m,
                                channels:
                                  nextChannels.length > 0 ? nextChannels : m.channels,
                              };
                            })
                          }
                          className={`px-2 py-0.5 rounded border font-mono text-[10px] transition-colors ${
                            included
                              ? "bg-ember/20 border-ember text-frost"
                              : "bg-ink border-steel text-fog hover:text-mist"
                          }`}
                        >
                          {included ? "✓ " : "+ "}
                          {chName}
                        </button>
                      );
                    })}
                    {Object.keys(parsedRawOfl?.templateChannels ?? {}).length > 0 && (() => {
                      const tmplKeys = orderOflChannelKeys(
                        Object.keys(parsedRawOfl?.templateChannels ?? {}),
                        parsedRawOfl?.templateChannels,
                        resolveDraftColorNames(draft),
                      );
                      const hasMatrixInsert = selectedRawMode.channels.some(
                        (c) =>
                          c &&
                          typeof c === "object" &&
                          (c as { insert?: string }).insert === "matrixChannels",
                      );
                      const pxTotal =
                        Math.max(1, draft.pixelCountX) *
                        Math.max(1, draft.pixelCountY) *
                        Math.max(1, draft.pixelCountZ);
                      const divisors: number[] = [];
                      for (let d = 1; d <= pxTotal; d += 1) {
                        if (pxTotal % d === 0) divisors.push(d);
                      }
                      const matrixEntry = selectedRawMode.channels.find(
                        (c) =>
                          c &&
                          typeof c === "object" &&
                          (c as { insert?: string }).insert === "matrixChannels",
                      ) as { repeatFor?: string | string[] } | undefined;
                      const activeSegCount = !hasMatrixInsert
                        ? 0
                        : Array.isArray(matrixEntry?.repeatFor)
                          ? matrixEntry.repeatFor.length
                          : pxTotal;
                      return (
                        <>
                          <button
                            type="button"
                            data-testid="mode-ch-toggle-matrix"
                            aria-pressed={hasMatrixInsert}
                            onClick={() =>
                              updateSelectedMode((m) => {
                                const withoutMatrix = m.channels.filter(
                                  (c) =>
                                    !(
                                      c &&
                                      typeof c === "object" &&
                                      (c as { insert?: string }).insert ===
                                        "matrixChannels"
                                    ),
                                );
                                const nextChannels = hasMatrixInsert
                                  ? withoutMatrix
                                  : [
                                      ...withoutMatrix,
                                      {
                                        insert: "matrixChannels",
                                        repeatFor: "eachPixelABC",
                                        channelOrder: draft.channelOrder,
                                        templateChannels: tmplKeys,
                                      },
                                    ];
                                return {
                                  ...m,
                                  channels:
                                    nextChannels.length > 0 ? nextChannels : m.channels,
                                };
                              })
                            }
                            className={`px-2 py-0.5 rounded border font-mono text-[10px] transition-colors ${
                              hasMatrixInsert
                                ? "bg-ember/20 border-ember text-frost"
                                : "bg-ink border-steel text-fog hover:text-mist"
                            }`}
                          >
                            {hasMatrixInsert ? "✓ " : "+ "}
                            Pixel Matrix ({activeSegCount || pxTotal}×{tmplKeys.length}ch)
                          </button>
                          {hasMatrixInsert && pxTotal > 1 && (
                            <label className="flex items-center gap-1 font-mono text-[10px] text-fog ml-1">
                              <span>Segments:</span>
                              <select
                                aria-label="Mode Segments"
                                data-testid="mode-segment-count-select"
                                value={activeSegCount}
                                onChange={(e) =>
                                  handleSetModeSegments(Number(e.target.value))
                                }
                                className="bg-ink border border-steel rounded px-1.5 py-0.5 text-[10px] text-frost"
                              >
                                {divisors.map((d) => (
                                  <option key={d} value={d}>
                                    {d} seg ({d * tmplKeys.length}ch)
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

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
