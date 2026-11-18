import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  Move,
  Redo2,
  RotateCcw,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  type FixtureCalibration,
  type FixtureInstance,
  getFixtureFootprint,
  getUniverseFreeStats,
  inheritNextUniverse,
  previewPlacement,
  type WhiteMode,
} from "../lib/patchLogic";
import { type UniverseConfig, useTaktStore } from "../store/useTaktStore";

interface CellOwnership {
  fixture: FixtureInstance;
  segment: "head" | "tail";
  isSplit: boolean;
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function formatFootprintLabel(inst: FixtureInstance): string {
  const fp = getFixtureFootprint(inst);
  const headStr = `U${fp.head.universe}.${pad3(fp.head.startAddress)} to U${fp.head.universe}.${pad3(fp.head.endAddress)}`;
  if (!fp.tail) return headStr;
  return `${headStr} + U${fp.tail.universe}.${pad3(fp.tail.startAddress)} to U${fp.tail.universe}.${pad3(fp.tail.endAddress)}`;
}

function resolveUniverseDisplayConfig(
  universes: UniverseConfig[],
  targetId: number,
): { config: UniverseConfig; isPreview: boolean } {
  const existing = universes.find((u) => u.id === targetId);
  if (existing) return { config: existing, isPreview: false };

  const sorted = [...universes].sort((a, b) => a.id - b.id);
  let base: UniverseConfig =
    sorted[sorted.length - 1] ?? {
      id: 1,
      review_output: false,
      protocol: {
        protocol: "art_net",
        mode: { mode: "broadcast" },
        net: 0,
        subnet: 0,
        uni: 0,
      },
    };
  let curId = base.id;
  while (curId < targetId) {
    base = inheritNextUniverse(base, curId + 1);
    curId += 1;
  }
  return { config: { ...base, review_output: false }, isPreview: true };
}

function formatProtocolSublabel(config: UniverseConfig): string {
  if (config.protocol.protocol === "art_net") {
    return `Net ${config.protocol.net} Sub ${config.protocol.subnet} Uni ${config.protocol.uni}`;
  }
  return `sACN U${config.protocol.sacn_universe}`;
}

export function PatchView() {
  const showState = useTaktStore((s) => s.showState);
  const fixtureSummaries = useTaktStore((s) => s.fixtureSummaries);
  const fixtureDetailsCache = useTaktStore((s) => s.fixtureDetailsCache);
  const rolloverEnabled = useTaktStore((s) => s.rolloverEnabled);
  const canUndo = useTaktStore((s) => s.canUndo);
  const canRedo = useTaktStore((s) => s.canRedo);
  const patchToast = useTaktStore((s) => s.patchToast);
  const crossProtocolWarning = useTaktStore((s) => s.crossProtocolWarning);
  const selectedFixtureInstanceId = useTaktStore(
    (s) => s.selectedFixtureInstanceId,
  );
  const focusedPatchUniverse = useTaktStore((s) => s.focusedPatchUniverse);

  const patchFixtures = useTaktStore((s) => s.patchFixtures);
  const moveFixturePatch = useTaktStore((s) => s.moveFixturePatch);
  const unpatchFixture = useTaktStore((s) => s.unpatchFixture);
  const updateFixtureCalibration = useTaktStore(
    (s) => s.updateFixtureCalibration,
  );
  const setRolloverEnabled = useTaktStore((s) => s.setRolloverEnabled);
  const markUniverseReviewed = useTaktStore((s) => s.markUniverseReviewed);
  const undoShow = useTaktStore((s) => s.undoShow);
  const redoShow = useTaktStore((s) => s.redoShow);
  const exportShowXml = useTaktStore((s) => s.exportShowXml);
  const importShowXml = useTaktStore((s) => s.importShowXml);
  const selectFixtureInstance = useTaktStore((s) => s.selectFixtureInstance);
  const setFocusedPatchUniverse = useTaktStore(
    (s) => s.setFocusedPatchUniverse,
  );
  const dismissToast = useTaktStore((s) => s.dismissToast);

  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    fixtureSummaries[0]?.id ?? "",
  );
  const activeProfile = useMemo(
    () =>
      fixtureSummaries.find((f) => f.id === selectedProfileId) ??
      fixtureSummaries[0],
    [fixtureSummaries, selectedProfileId],
  );
  const [selectedModeName, setSelectedModeName] = useState<string>(
    activeProfile?.modes[0]?.name ?? "",
  );
  const [namePrefix, setNamePrefix] = useState<string>("Tube");
  const [fixtureCount, setFixtureCount] = useState<number>(1);
  const [startUniverse, setStartUniverse] = useState<number>(1);
  const [startAddress, setStartAddress] = useState<number>(1);

  const [movingFixtureId, setMovingFixtureId] = useState<string | null>(null);
  const [hoverTarget, setHoverTarget] = useState<{
    universe: number;
    address: number;
  } | null>(null);
  const [exportedXml, setExportedXml] = useState<string | null>(null);
  const [xmlError, setXmlError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!activeProfile) return;
    if (!activeProfile.modes.some((m) => m.name === selectedModeName)) {
      setSelectedModeName(activeProfile.modes[0]?.name ?? "");
    }
  }, [activeProfile, selectedModeName]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      const isEditingText =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        if (e.shiftKey) {
          e.preventDefault();
          void redoShow();
        } else {
          e.preventDefault();
          void undoShow();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void redoShow();
        return;
      }
      if (isEditingText) return;

      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        void setRolloverEnabled(!rolloverEnabled);
      } else if (e.key === "PageUp") {
        e.preventDefault();
        setFocusedPatchUniverse(Math.max(1, focusedPatchUniverse - 1));
      } else if (e.key === "PageDown") {
        e.preventDefault();
        setFocusedPatchUniverse(focusedPatchUniverse + 1);
      } else if (e.key === "Escape" && movingFixtureId) {
        setMovingFixtureId(null);
        setHoverTarget(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    focusedPatchUniverse,
    movingFixtureId,
    redoShow,
    rolloverEnabled,
    setFocusedPatchUniverse,
    setRolloverEnabled,
    undoShow,
  ]);

  const movingFixture = useMemo(
    () => showState.patch.find((f) => f.id === movingFixtureId) ?? null,
    [movingFixtureId, showState.patch],
  );

  const ghostPreview = useMemo(() => {
    if (!movingFixture || !hoverTarget) return null;
    return previewPlacement(
      showState.patch,
      showState.network_outputs.universes,
      movingFixture.name,
      hoverTarget.universe,
      hoverTarget.address,
      movingFixture.channel_count,
      rolloverEnabled,
      movingFixture.id,
    );
  }, [
    hoverTarget,
    movingFixture,
    rolloverEnabled,
    showState.network_outputs.universes,
    showState.patch,
  ]);

  const ghostMaskByUniverse = useMemo(() => {
    const map = new Map<number, Set<number>>();
    if (!movingFixture || !ghostPreview) return map;

    const previewInst: FixtureInstance = {
      ...movingFixture,
      universe: ghostPreview.universe,
      address: ghostPreview.address,
    };
    const fp = getFixtureFootprint(previewInst);
    const headSet = new Set<number>();
    for (let a = fp.head.startAddress; a <= fp.head.endAddress; a++) {
      headSet.add(a);
    }
    map.set(fp.head.universe, headSet);

    if (fp.tail) {
      const tailSet = new Set<number>();
      for (let a = fp.tail.startAddress; a <= fp.tail.endAddress; a++) {
        tailSet.add(a);
      }
      map.set(fp.tail.universe, tailSet);
    }
    return map;
  }, [ghostPreview, movingFixture]);

  const ownershipByUniverse = useMemo(() => {
    const map = new Map<number, Map<number, CellOwnership>>();
    const ensureUni = (u: number) => {
      let inner = map.get(u);
      if (!inner) {
        inner = new Map<number, CellOwnership>();
        map.set(u, inner);
      }
      return inner;
    };

    for (const fixture of showState.patch) {
      const fp = getFixtureFootprint(fixture);
      const isSplit = fp.tail !== null;
      const headMap = ensureUni(fp.head.universe);
      for (let a = fp.head.startAddress; a <= fp.head.endAddress; a++) {
        headMap.set(a, { fixture, segment: "head", isSplit });
      }
      if (fp.tail) {
        const tailMap = ensureUni(fp.tail.universe);
        for (let a = fp.tail.startAddress; a <= fp.tail.endAddress; a++) {
          tailMap.set(a, { fixture, segment: "tail", isSplit: true });
        }
      }
    }
    return map;
  }, [showState.patch]);

  const selectedFixture = useMemo(
    () =>
      showState.patch.find((f) => f.id === selectedFixtureInstanceId) ??
      showState.patch[0] ??
      null,
    [selectedFixtureInstanceId, showState.patch],
  );

  const pairUniverses = [focusedPatchUniverse, focusedPatchUniverse + 1];

  const handlePatchSubmit = async () => {
    if (!activeProfile) return;
    const mode =
      activeProfile.modes.find((m) => m.name === selectedModeName) ??
      activeProfile.modes[0];
    if (!mode) return;

    await patchFixtures(
      activeProfile.id,
      mode.name,
      namePrefix.trim() || activeProfile.short_name,
      Math.max(1, Math.min(32, fixtureCount)),
      Math.max(1, startUniverse),
      Math.max(1, Math.min(512, startAddress)),
    );
  };

  const handleExportXml = async () => {
    setXmlError(null);
    const xml = await exportShowXml();
    setExportedXml(xml);
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      try {
        const blob = new Blob([xml], { type: "application/xml" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${showState.name.toLowerCase().replace(/\s+/g, "_") || "show"}.takt.xml`;
        link.click();
        URL.revokeObjectURL(url);
      } catch {
        // Browser preview still renders the exported XML block
      }
    }
  };

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setXmlError(null);
    try {
      const content = await file.text();
      await importShowXml(content);
      setExportedXml(content);
    } catch (err) {
      setXmlError(
        err instanceof Error ? err.message : "Failed to import .takt.xml show",
      );
    } finally {
      e.target.value = "";
    }
  };

  const updateCalField = (patch: Partial<FixtureCalibration>) => {
    if (!selectedFixture) return;
    const nextCal: FixtureCalibration = {
      ...selectedFixture.calibration,
      ...patch,
    };
    void updateFixtureCalibration(
      selectedFixture.id,
      nextCal,
      `cal_${selectedFixture.id}`,
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Patch View Toolbar */}
      <section className="bg-slate border border-steel rounded-panel p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 bg-ink border border-steel rounded-md p-1">
            <button
              type="button"
              disabled={focusedPatchUniverse <= 1}
              onClick={() =>
                setFocusedPatchUniverse(Math.max(1, focusedPatchUniverse - 1))
              }
              title="Previous Universe Pair (PageUp)"
              className="px-2 py-1 rounded text-xs font-mono text-mist hover:bg-slate-dark disabled:opacity-40 flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Prev</span>
            </button>
            <span className="px-2.5 font-mono text-xs text-frost font-medium">
              Pair: U{focusedPatchUniverse} &amp; U{focusedPatchUniverse + 1}
            </span>
            <button
              type="button"
              onClick={() => setFocusedPatchUniverse(focusedPatchUniverse + 1)}
              title="Next Universe Pair (PageDown)"
              className="px-2 py-1 rounded text-xs font-mono text-mist hover:bg-slate-dark flex items-center gap-1"
            >
              <span>Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={rolloverEnabled}
            onClick={() => void setRolloverEnabled(!rolloverEnabled)}
            title="Toggle universe spillover split mode (Shortcut: R)"
            className="flex items-center gap-2 px-2.5 py-1 rounded-md border border-steel bg-ink font-mono text-xs font-semibold text-mist hover:border-ember transition-colors"
          >
            <span
              className={`relative inline-flex w-8 h-4 rounded-full transition-colors ${
                rolloverEnabled ? "bg-ember" : "bg-slate-dark border border-steel"
              }`}
            >
              <span
                className={`inline-block w-3 h-3 rounded-full bg-frost transition-transform mt-0.5 ${
                  rolloverEnabled ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </span>
            <span>{rolloverEnabled ? "Rollover: ON" : "Rollover: OFF"}</span>
          </button>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!canUndo}
              onClick={() => void undoShow()}
              title="Undo (Ctrl+Z)"
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-ink border border-steel text-xs font-sans text-mist hover:border-ember disabled:opacity-40"
            >
              <Undo2 className="w-3.5 h-3.5" />
              <span>Undo</span>
            </button>
            <button
              type="button"
              disabled={!canRedo}
              onClick={() => void redoShow()}
              title="Redo (Ctrl+Y)"
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-ink border border-steel text-xs font-sans text-mist hover:border-ember disabled:opacity-40"
            >
              <Redo2 className="w-3.5 h-3.5" />
              <span>Redo</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xml,.takt.xml"
            aria-label="Import Show XML File"
            onChange={(e) => void handleImportFile(e)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-ink border border-steel text-xs font-sans text-mist hover:border-cobalt"
          >
            <Upload className="w-3.5 h-3.5 text-cobalt" />
            <span>Import .takt.xml</span>
          </button>
          <button
            type="button"
            onClick={() => void handleExportXml()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-ink border border-steel text-xs font-sans text-mist hover:border-ember"
          >
            <Download className="w-3.5 h-3.5 text-ember" />
            <span>Export .takt.xml</span>
          </button>
        </div>
      </section>

      {showState.read_only_newer_version && (
        <div className="bg-signal/15 border border-signal rounded-panel px-3 py-2 flex items-center gap-2 text-xs text-frost">
          <AlertTriangle className="w-4 h-4 text-signal shrink-0" />
          <span>
            Loaded show uses schema v{showState.version}. Opened in read only mode to protect unsupported tags.
          </span>
        </div>
      )}

      {/* Placement Toast & Conditional Cross Protocol Warning */}
      {(patchToast ||
        (!rolloverEnabled &&
          (crossProtocolWarning ||
            showState.patch.some((inst) => getFixtureFootprint(inst).tail !== null))) ||
        movingFixture) && (
        <div className="bg-slate-dark border border-steel rounded-panel px-3 py-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            {patchToast && (
              <span className="font-mono text-frost">{patchToast}</span>
            )}
            {!rolloverEnabled &&
              (crossProtocolWarning ||
                showState.patch.some((inst) => getFixtureFootprint(inst).tail !== null)) && (
              <span className="px-2 py-0.5 rounded bg-signal/20 border border-signal text-signal font-mono font-semibold flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>CROSS PROTOCOL SPLIT</span>
              </span>
            )}
            {movingFixture && (
              <span className="px-2 py-0.5 rounded bg-ember/20 border border-ember text-ember font-mono">
                Moving {movingFixture.name}: click any channel cell or press Esc to cancel
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {patchToast && canUndo && (
              <button
                type="button"
                data-testid="toast-undo-button"
                onClick={() => void undoShow()}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-ember text-frost font-mono text-xs font-medium hover:bg-burnt"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Undo</span>
              </button>
            )}
            {movingFixture && (
              <button
                type="button"
                onClick={() => {
                  setMovingFixtureId(null);
                  setHoverTarget(null);
                }}
                className="px-2 py-1 rounded bg-ink border border-steel text-xs text-fog hover:text-mist"
              >
                Cancel Move
              </button>
            )}
            {patchToast && (
              <button
                type="button"
                onClick={() => dismissToast()}
                className="px-2 py-1 rounded bg-ink border border-steel text-xs text-fog hover:text-mist"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}

      {xmlError && (
        <div className="bg-signal/15 border border-signal rounded-panel px-3 py-2 text-xs text-signal font-mono">
          {xmlError}
        </div>
      )}

      {/* Auto-Patch Bar */}
      <section className="bg-slate border border-steel rounded-panel p-3">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-7 gap-2.5 items-end">
          <div className="flex flex-col gap-1 lg:col-span-2">
            <label
              htmlFor="patch-profile-select"
              className="text-[11px] font-mono uppercase tracking-wider text-fog"
            >
              Fixture Profile
            </label>
            <select
              id="patch-profile-select"
              aria-label="Fixture Profile"
              value={activeProfile?.id ?? ""}
              onChange={(e) => setSelectedProfileId(e.target.value)}
              className="bg-ink border border-steel rounded px-2.5 py-1.5 text-xs text-frost font-sans focus:outline-none focus:border-ember"
            >
              {fixtureSummaries.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="patch-mode-select"
              className="text-[11px] font-mono uppercase tracking-wider text-fog"
            >
              Fixture Mode
            </label>
            <select
              id="patch-mode-select"
              aria-label="Fixture Mode"
              value={selectedModeName}
              onChange={(e) => setSelectedModeName(e.target.value)}
              className="bg-ink border border-steel rounded px-2.5 py-1.5 text-xs text-frost font-mono focus:outline-none focus:border-ember"
            >
              {(activeProfile?.modes ?? []).map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name} ({m.channel_count}ch)
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="patch-name-prefix"
              className="text-[11px] font-mono uppercase tracking-wider text-fog"
            >
              Name Prefix
            </label>
            <input
              id="patch-name-prefix"
              aria-label="Name Prefix"
              type="text"
              value={namePrefix}
              onChange={(e) => setNamePrefix(e.target.value)}
              className="bg-ink border border-steel rounded px-2.5 py-1.5 text-xs text-frost font-sans focus:outline-none focus:border-ember"
            />
          </div>

          <div className="grid grid-cols-3 gap-1.5 lg:col-span-2">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="patch-count-input"
                className="text-[11px] font-mono uppercase tracking-wider text-fog"
              >
                Qty
              </label>
              <input
                id="patch-count-input"
                aria-label="Fixture Count"
                type="number"
                min={1}
                max={32}
                value={fixtureCount}
                onChange={(e) =>
                  setFixtureCount(Math.max(1, Number(e.target.value) || 1))
                }
                className="bg-ink border border-steel rounded px-2 py-1.5 text-xs text-frost font-mono focus:outline-none focus:border-ember"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="patch-start-uni"
                className="text-[11px] font-mono uppercase tracking-wider text-fog"
              >
                Universe
              </label>
              <input
                id="patch-start-uni"
                aria-label="Start Universe"
                type="number"
                min={1}
                max={256}
                value={startUniverse}
                onChange={(e) =>
                  setStartUniverse(Math.max(1, Number(e.target.value) || 1))
                }
                className="bg-ink border border-steel rounded px-2 py-1.5 text-xs text-frost font-mono focus:outline-none focus:border-ember"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="patch-start-addr"
                className="text-[11px] font-mono uppercase tracking-wider text-fog"
              >
                Address
              </label>
              <input
                id="patch-start-addr"
                aria-label="Start Address"
                type="number"
                min={1}
                max={512}
                value={startAddress}
                onChange={(e) =>
                  setStartAddress(
                    Math.max(1, Math.min(512, Number(e.target.value) || 1)),
                  )
                }
                className="bg-ink border border-steel rounded px-2 py-1.5 text-xs text-frost font-mono focus:outline-none focus:border-ember"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handlePatchSubmit()}
            disabled={!activeProfile}
            className="px-3 py-1.5 rounded bg-ember hover:bg-burnt text-frost font-sans text-xs font-semibold transition-colors disabled:opacity-40"
          >
            Patch Fixtures
          </button>
        </div>
      </section>

      {/* Dual 512-Channel Universe Patch Grids */}
      <section className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
        {pairUniverses.map((uniId) => {
          const { config, isPreview } = resolveUniverseDisplayConfig(
            showState.network_outputs.universes,
            uniId,
          );
          const stats = getUniverseFreeStats(showState.patch, uniId);
          const cellOwners = ownershipByUniverse.get(uniId);
          const ghostCells = ghostMaskByUniverse.get(uniId);

          const fixturesInUni = showState.patch.filter((inst) => {
            const fp = getFixtureFootprint(inst);
            return fp.head.universe === uniId || fp.tail?.universe === uniId;
          });

          const isArtNet = config.protocol.protocol === "art_net";

          return (
            <div
              key={uniId}
              data-testid={`patch-universe-${uniId}`}
              className={`bg-slate rounded-panel p-3 flex flex-col gap-3 border ${
                isPreview ? "border-dashed border-steel" : "border-steel"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-frost">
                    Universe {uniId}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded font-mono text-[10px] font-semibold uppercase border ${
                      isArtNet
                        ? "bg-ember/15 border-ember text-ember"
                        : "bg-cobalt/15 border-cobalt text-cobalt"
                    }`}
                  >
                    {isArtNet ? "ARTNET" : "SACN"}
                  </span>
                  <span className="font-mono text-[11px] text-fog">
                    {formatProtocolSublabel(config)}
                  </span>
                  {isPreview && (
                    <span className="px-1.5 py-0.5 rounded bg-ink border border-dashed border-steel font-mono text-[10px] text-fog">
                      Preview next
                    </span>
                  )}
                  {config.review_output && (
                    <button
                      type="button"
                      onClick={() => void markUniverseReviewed(uniId)}
                      className="px-2 py-0.5 rounded bg-ember text-frost font-mono text-[10px] font-semibold hover:bg-burnt"
                    >
                      Review output
                    </button>
                  )}
                </div>
                <span className="font-mono text-xs text-mist">
                  {stats.freeChannels} free | largest block {stats.largestBlock}
                </span>
              </div>

              {/* 32x16 512-Channel Grid */}
              <div className="grid grid-cols-[repeat(32,minmax(0,1fr))] gap-0.5 bg-pitch p-1.5 rounded border border-steel">
                {Array.from({ length: 512 }, (_, idx) => {
                  const ch = idx + 1;
                  const owner = cellOwners?.get(ch);
                  const isGhost = ghostCells?.has(ch) ?? false;
                  const isSelected =
                    owner && selectedFixture?.id === owner.fixture.id;

                  let cellBg = "bg-ink text-fog/60 hover:bg-slate-dark";
                  if (owner) {
                    if (isSelected) {
                      cellBg = "bg-ember text-frost font-semibold";
                    } else if (owner.isSplit) {
                      cellBg = rolloverEnabled
                        ? "bg-cobalt/25 border border-dashed border-cobalt/80 text-mist"
                        : "bg-signal/30 border border-signal text-frost";
                    } else {
                      cellBg = "bg-cobalt/25 border border-cobalt/60 text-mist";
                    }
                  }

                  const ghostClass = isGhost
                    ? ghostPreview?.collidesDirectly
                      ? "ring-2 ring-signal bg-signal/40"
                      : "ring-2 ring-ember bg-ember/35"
                    : "";

                  const profileDetail = owner
                    ? fixtureDetailsCache[owner.fixture.profile]
                    : undefined;
                  const titleText = owner
                    ? `${owner.fixture.name} (${profileDetail?.summary.short_name ?? owner.fixture.mode}) U${uniId}.${pad3(ch)}`
                    : `U${uniId}.${pad3(ch)} empty`;

                  return (
                    <button
                      key={ch}
                      type="button"
                      draggable={Boolean(owner)}
                      title={titleText}
                      data-testid={`patch-u${uniId}-ch${ch}`}
                      onDragStart={() => {
                        if (owner) setMovingFixtureId(owner.fixture.id);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (movingFixtureId) {
                          setHoverTarget({ universe: uniId, address: ch });
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (movingFixtureId) {
                          void moveFixturePatch(movingFixtureId, uniId, ch);
                          setMovingFixtureId(null);
                          setHoverTarget(null);
                        }
                      }}
                      onDragEnd={() => {
                        setHoverTarget(null);
                      }}
                      onMouseEnter={() => {
                        if (movingFixtureId) {
                          setHoverTarget({ universe: uniId, address: ch });
                        }
                      }}
                      onClick={() => {
                        if (movingFixtureId) {
                          void moveFixturePatch(movingFixtureId, uniId, ch);
                          setMovingFixtureId(null);
                          setHoverTarget(null);
                          return;
                        }
                        if (owner) {
                          selectFixtureInstance(owner.fixture.id);
                        } else {
                          setStartUniverse(uniId);
                          setStartAddress(ch);
                        }
                      }}
                      className={`h-4 text-[8px] font-mono rounded-[2px] flex items-center justify-center select-none transition-colors ${cellBg} ${ghostClass}`}
                    >
                      {ch === 1 || ch % 16 === 1 || owner ? ch : ""}
                    </button>
                  );
                })}
              </div>

              {/* Patched Fixtures List for this Universe */}
              <div className="flex flex-col gap-1.5">
                {fixturesInUni.length === 0 ? (
                  <p className="text-xs font-mono text-fog py-1">
                    No fixtures patched in Universe {uniId}.
                  </p>
                ) : (
                  fixturesInUni.map((fx) => {
                    const fp = getFixtureFootprint(fx);
                    const isSelected = selectedFixture?.id === fx.id;
                    return (
                      <div
                        key={`${uniId}-${fx.id}`}
                        data-testid={`patch-block-${fx.id}`}
                        onClick={() => selectFixtureInstance(fx.id)}
                        className={`flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded border text-xs cursor-pointer ${
                          isSelected
                            ? "bg-pitch border-ember text-frost"
                            : "bg-ink border-steel text-mist hover:border-fog"
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-sans font-medium text-frost">
                            {fx.name}
                          </span>
                          <span className="font-mono text-[11px] text-fog">
                            {formatFootprintLabel(fx)}
                          </span>
                          {fp.tail && (
                            <span
                              className={`px-1.5 py-0.5 rounded border font-mono text-[10px] ${
                                rolloverEnabled
                                  ? "border-steel bg-ink text-fog"
                                  : "border-signal bg-signal/20 text-signal"
                              }`}
                            >
                              U{fp.head.universe} to U{fp.tail.universe} split
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMovingFixtureId(
                                movingFixtureId === fx.id ? null : fx.id,
                              );
                              setHoverTarget(null);
                            }}
                            className={`flex items-center gap-1 px-2 py-0.5 rounded border font-mono text-[10px] ${
                              movingFixtureId === fx.id
                                ? "bg-ember border-ember text-frost"
                                : "bg-slate-dark border-steel text-mist hover:border-ember"
                            }`}
                          >
                            <Move className="w-3 h-3" />
                            <span>Move</span>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void unpatchFixture(fx.id);
                            }}
                            className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-dark border border-steel font-mono text-[10px] text-signal hover:border-signal"
                          >
                            <Trash2 className="w-3 h-3" />
                            <span>Unpatch</span>
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </section>

      {/* Per-Fixture Calibration Inspector & XML Export Preview */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-slate border border-steel rounded-panel p-3 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-sans text-sm font-semibold text-frost">
              Fixture Calibration Inspector
            </h2>
            {selectedFixture && (
              <span className="font-mono text-xs text-ember">
                {selectedFixture.name} ({selectedFixture.id})
              </span>
            )}
          </div>

          {!selectedFixture ? (
            <p className="text-xs font-mono text-fog">
              Select a fixture above.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="cal-gamma"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  Gamma
                </label>
                <input
                  id="cal-gamma"
                  aria-label="Gamma"
                  type="number"
                  step="0.1"
                  min="1.0"
                  max="4.0"
                  value={selectedFixture.calibration.gamma}
                  onChange={(e) =>
                    updateCalField({
                      gamma: Math.max(
                        1.0,
                        Math.min(4.0, Number(e.target.value) || 2.2),
                      ),
                    })
                  }
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost focus:outline-none focus:border-ember"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="cal-min-dimmer"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  Min Dimmer DMX
                </label>
                <input
                  id="cal-min-dimmer"
                  aria-label="Min Dimmer DMX"
                  type="number"
                  min={0}
                  max={254}
                  value={selectedFixture.calibration.min_dimmer_dmx}
                  onChange={(e) =>
                    updateCalField({
                      min_dimmer_dmx: Math.max(
                        0,
                        Math.min(254, Number(e.target.value) || 0),
                      ),
                    })
                  }
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost focus:outline-none focus:border-ember"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="cal-max-dimmer"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  Max Dimmer DMX
                </label>
                <input
                  id="cal-max-dimmer"
                  aria-label="Max Dimmer DMX"
                  type="number"
                  min={1}
                  max={255}
                  value={selectedFixture.calibration.max_dimmer_dmx}
                  onChange={(e) =>
                    updateCalField({
                      max_dimmer_dmx: Math.max(
                        1,
                        Math.min(255, Number(e.target.value) || 255),
                      ),
                    })
                  }
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost focus:outline-none focus:border-ember"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="cal-white-mode"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  White Mode
                </label>
                <select
                  id="cal-white-mode"
                  aria-label="White Mode"
                  value={selectedFixture.calibration.white_mode}
                  onChange={(e) =>
                    updateCalField({ white_mode: e.target.value as WhiteMode })
                  }
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost focus:outline-none focus:border-ember"
                >
                  <option value="replace">replace</option>
                  <option value="add">add</option>
                  <option value="off">off</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="cal-white-gain"
                  className="text-[11px] font-mono uppercase text-fog"
                >
                  White Gain
                </label>
                <input
                  id="cal-white-gain"
                  aria-label="White Gain"
                  type="number"
                  step="0.05"
                  min={0}
                  max={2.0}
                  value={selectedFixture.calibration.white_gain}
                  onChange={(e) =>
                    updateCalField({
                      white_gain: Math.max(
                        0,
                        Math.min(2.0, Number(e.target.value) || 0),
                      ),
                    })
                  }
                  className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost focus:outline-none focus:border-ember"
                />
              </div>
            </div>
          )}
        </div>

        <div className="bg-slate border border-steel rounded-panel p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="font-sans text-sm font-semibold text-frost">
              Show XML Snapshot (.takt.xml)
            </h2>
            <span className="font-mono text-[11px] text-fog">
              Schema v{showState.version} | {showState.patch.length} fixtures
            </span>
          </div>
          {exportedXml ? (
            <pre
              data-testid="show-xml-preview"
              className="bg-void border border-steel rounded p-2.5 text-[11px] font-mono text-mist overflow-auto max-h-40 whitespace-pre-wrap"
            >
              {exportedXml}
            </pre>
          ) : (
            <p className="text-xs font-mono text-fog">
              No XML snapshot exported.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
