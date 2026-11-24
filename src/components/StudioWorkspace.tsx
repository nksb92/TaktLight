import {
  Activity,
  Camera,
  Keyboard,
  PanelBottom,
  PanelRight,
  Plus,
  Redo2,
  Sliders,
  Square,
  Trash2,
  Undo2,
  Users,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { OrderRuleStr } from "../lib/patchLogic";
import { DEFAULT_STUDIO_LAYOUT, useTaktStore } from "../store/useTaktStore";
import { FixtureGrid2D } from "./FixtureGrid2D";
import { HelpTooltip } from "./HelpTooltip";
import { PalettesAndControls } from "./PalettesAndControls";
import { SceneAndFxManager } from "./SceneAndFxManager";
import { SplitHandle } from "./SplitHandle";
import { TimelineEditor } from "./TimelineEditor";

function slugGroupId(name: string, existingIds: string[]): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = `grp_${clean || "group"}`;
  if (!existingIds.includes(base)) return base;
  let suffix = 2;
  while (existingIds.includes(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

export function StudioWorkspace() {
  const showState = useTaktStore((s) => s.showState);
  const canUndo = useTaktStore((s) => s.canUndo);
  const canRedo = useTaktStore((s) => s.canRedo);
  const mappingOverlayMode = useTaktStore((s) => s.mappingOverlayMode);
  const selectedMappingTarget = useTaktStore((s) => s.selectedMappingTarget);
  const keyBindings = useTaktStore((s) => s.keyBindings);
  const activeScenes = useTaktStore((s) => s.activeScenes);
  const activeGroupFilterId = useTaktStore((s) => s.activeGroupFilterId);
  const selectedCellIndices = useTaktStore((s) => s.selectedCellIndices);
  const compiledCells = useTaktStore((s) => s.compiledCells);
  const canvasOrderRule = useTaktStore((s) => s.canvasOrderRule);
  const liveBpm = useTaktStore((s) => s.liveBpm);
  const selectedSceneId = useTaktStore((s) => s.selectedSceneId);

  const undoShow = useTaktStore((s) => s.undoShow);
  const redoShow = useTaktStore((s) => s.redoShow);
  const upsertGroup = useTaktStore((s) => s.upsertGroup);
  const deleteGroup = useTaktStore((s) => s.deleteGroup);
  const setStudioSubMode = useTaktStore((s) => s.setStudioSubMode);
  const setMappingOverlayMode = useTaktStore((s) => s.setMappingOverlayMode);
  const bindKeyToTarget = useTaktStore((s) => s.bindKeyToTarget);
  const bindMidiToTarget = useTaktStore((s) => s.bindMidiToTarget);
  const captureLiveSnapshotToScene = useTaktStore(
    (s) => s.captureLiveSnapshotToScene,
  );
  const setActiveGroupFilterId = useTaktStore((s) => s.setActiveGroupFilterId);
  const triggerScene = useTaktStore((s) => s.triggerScene);
  const releaseScene = useTaktStore((s) => s.releaseScene);
  const releaseAllScenes = useTaktStore((s) => s.releaseAllScenes);
  const setLiveBpm = useTaktStore((s) => s.setLiveBpm);
  const tapTempo = useTaktStore((s) => s.tapTempo);
  const studioLayout = useTaktStore((s) => s.studioLayout);
  const setStudioLayout = useTaktStore((s) => s.setStudioLayout);

  const showInspector = studioLayout.showInspector;
  const showBottomDock = studioLayout.showBottomDock;
  const timelineExpanded = studioLayout.timelineExpanded;

  const workspaceContainerRef = useRef<HTMLDivElement | null>(null);
  const bottomSplitRef = useRef<HTMLDivElement | null>(null);
  const expandedUpperRef = useRef<HTMLDivElement | null>(null);

  const [groupName, setGroupName] = useState("Stage Front");
  const [groupOrder, setGroupOrder] = useState<OrderRuleStr>("center_out");
  const [groupTargets, setGroupTargets] = useState(
    showState.patch[0]?.id ?? "fx_001",
  );
  const [hasCustomTargets, setHasCustomTargets] = useState(false);
  const [groupContextMenu, setGroupContextMenu] = useState<{
    groupId: string;
    groupName: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!groupContextMenu) return;
    const close = () => setGroupContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [groupContextMenu]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      const isInput =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable;
      if (isInput) return;

      if (mappingOverlayMode === "key" && selectedMappingTarget) {
        e.preventDefault();
        const keyLabel = e.key.length === 1 ? e.key.toUpperCase() : e.key;
        bindKeyToTarget(selectedMappingTarget, keyLabel);
        return;
      }

      if (mappingOverlayMode === "off") {
        const pressed = e.key.length === 1 ? e.key.toUpperCase() : e.key;
        const matchedEntry = Object.entries(keyBindings).find(
          ([, k]) => k.toUpperCase() === pressed,
        );
        if (matchedEntry) {
          const [sceneId] = matchedEntry;
          const isRunning = activeScenes.some(
            (s) => s.scene_id === sceneId && s.release_t_sec === null,
          );
          if (isRunning) {
            void releaseScene(sceneId);
          } else {
            void triggerScene(sceneId);
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeScenes,
    bindKeyToTarget,
    keyBindings,
    mappingOverlayMode,
    releaseScene,
    selectedMappingTarget,
    triggerScene,
  ]);

  const handleSaveGroup = async () => {
    const chosenCells = selectedCellIndices
      .map((idx) => compiledCells[idx])
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    const useSelectionTargets = !hasCustomTargets && chosenCells.length > 0;
    const targets = useSelectionTargets
      ? Array.from(
          new Set(chosenCells.map((c) => `${c.fixture_id}:${c.cell_index}`)),
        )
      : groupTargets
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
    const id = slugGroupId(
      groupName,
      showState.groups.map((g) => g.id),
    );
    await upsertGroup({
      id,
      name: groupName.trim() || "Group",
      order: useSelectionTargets ? canvasOrderRule : groupOrder,
      targets,
    });
    setActiveGroupFilterId(id);
    setHasCustomTargets(false);
  };

  const activeScene =
    showState.scenes.find((s) => s.id === selectedSceneId) ??
    showState.scenes[0] ??
    null;
  const isTimelineScene = Boolean(activeScene?.timeline_ref);
  const isTimelineFullWidth = isTimelineScene && timelineExpanded;

  return (
    <div
      ref={workspaceContainerRef}
      className="flex-1 min-h-0 flex flex-col gap-1.5"
    >
      {/* Slim Daslight Control Header Strip */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 bg-slate-dark border border-steel rounded px-2.5 py-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 pr-2 border-r border-steel/60">
            <Sliders className="w-3.5 h-3.5 text-ember" />
            <span className="font-mono text-[11px] font-semibold tracking-wider text-frost uppercase">
              CONTROL
            </span>
          </div>

          {/* Global Transport / Tempo */}
          <label className="flex items-center gap-1 bg-pitch border border-steel rounded px-2 py-0.5">
            <Activity className="w-3 h-3 text-pine" />
            <span className="font-mono text-[10px] text-fog">BPM</span>
            <input
              aria-label="Live BPM"
              type="number"
              min={20}
              max={300}
              step={1}
              value={liveBpm}
              onChange={(e) => {
                const parsed = Number(e.target.value);
                if (!Number.isNaN(parsed)) {
                  void setLiveBpm(parsed);
                }
              }}
              className="w-12 bg-ink border border-steel rounded px-1 py-0.5 font-mono text-[11px] text-frost"
            />
          </label>

          <button
            type="button"
            onClick={() => void tapTempo()}
            className="px-2 py-0.5 rounded border border-cobalt bg-cobalt/20 hover:bg-cobalt/35 font-mono text-[11px] font-medium text-frost transition-colors"
          >
            Tap Tempo
          </button>

          <button
            type="button"
            aria-label="Release All Scenes"
            title="Stop All Active Scenes"
            onClick={() => void releaseAllScenes()}
            className="flex items-center gap-1 p-1 rounded border border-signal/70 bg-signal/15 hover:bg-signal/30 font-mono text-[11px] font-medium text-frost transition-colors"
          >
            <Square className="w-3 h-3 text-signal" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Tools & Mapping Popover */}
          <details className="relative">
            <summary className="list-none cursor-pointer flex items-center gap-1 px-2 py-0.5 rounded border border-steel bg-ink hover:border-cobalt font-mono text-[11px] text-mist">
              <Wrench className="w-3 h-3 text-cobalt" />
              <span>Tools &amp; Map ▾</span>
            </summary>
            <div className="absolute right-0 mt-1 z-30 bg-slate-dark border border-steel rounded p-2 shadow-xl flex flex-col gap-1.5 min-w-[180px]">
              <button
                type="button"
                data-testid="toggle-key-map-overlay"
                aria-pressed={mappingOverlayMode === "key"}
                onClick={() =>
                  setMappingOverlayMode(
                    mappingOverlayMode === "key" ? "off" : "key",
                  )
                }
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded border font-mono text-[11px] transition-colors ${
                  mappingOverlayMode === "key"
                    ? "bg-signal/30 border-signal text-frost font-semibold"
                    : "bg-ink border-steel text-fog hover:text-mist"
                }`}
              >
                <Keyboard className="w-3.5 h-3.5" />
                <span>KEY MAP</span>
              </button>

              <button
                type="button"
                data-testid="toggle-midi-map-overlay"
                aria-pressed={mappingOverlayMode === "midi"}
                onClick={() =>
                  setMappingOverlayMode(
                    mappingOverlayMode === "midi" ? "off" : "midi",
                  )
                }
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded border font-mono text-[11px] transition-colors ${
                  mappingOverlayMode === "midi"
                    ? "bg-plum/30 border-plum text-frost font-semibold"
                    : "bg-ink border-steel text-fog hover:text-mist"
                }`}
              >
                <span>MIDI MAP</span>
              </button>

              <button
                type="button"
                data-testid="snapshot-live-scene-btn"
                onClick={() => void captureLiveSnapshotToScene()}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-cobalt bg-cobalt/20 hover:bg-cobalt/35 font-mono text-[11px] text-frost transition-colors"
                title="Capture active live output into a new Scene"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>Snapshot Live Output</span>
              </button>
            </div>
          </details>

          <button
            type="button"
            disabled={!canUndo}
            onClick={() => void undoShow()}
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
            className="p-1 rounded border border-steel bg-ink text-mist hover:border-ember disabled:opacity-40"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            disabled={!canRedo}
            onClick={() => void redoShow()}
            aria-label="Redo"
            title="Redo (Ctrl+Y)"
            className="p-1 rounded border border-steel bg-ink text-mist hover:border-ember disabled:opacity-40"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>

          {/* Daslight Pane Visibility Toggles */}
          <div className="flex items-center gap-0.5 pl-1.5 border-l border-steel/60">
            <HelpTooltip text="Toggle Bottom Dock (2D Grid & Controls / Timeline)">
              <button
                type="button"
                data-testid="toggle-bottom-dock-btn"
                aria-pressed={showBottomDock}
                onClick={() =>
                  setStudioLayout({ showBottomDock: !showBottomDock })
                }
                className={`p-1 rounded border transition-colors ${
                  showBottomDock
                    ? "bg-ink border-ember text-frost"
                    : "bg-pitch border-steel text-fog hover:text-mist"
                }`}
              >
                <PanelBottom className="w-3.5 h-3.5" />
              </button>
            </HelpTooltip>
            <HelpTooltip text="Toggle Right Scene FX Inspector">
              <button
                type="button"
                data-testid="toggle-right-inspector-btn"
                aria-pressed={showInspector}
                onClick={() =>
                  setStudioLayout({ showInspector: !showInspector })
                }
                className={`p-1 rounded border transition-colors ${
                  showInspector
                    ? "bg-ink border-ember text-frost"
                    : "bg-pitch border-steel text-fog hover:text-mist"
                }`}
              >
                <PanelRight className="w-3.5 h-3.5" />
              </button>
            </HelpTooltip>
          </div>
        </div>
      </div>

      {/* Color-Coded Mapping Overlay Banner */}
      {mappingOverlayMode !== "off" && (
        <div
          data-testid="mapping-overlay-banner"
          className={`shrink-0 rounded border px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs font-mono ${
            mappingOverlayMode === "key"
              ? "bg-signal/15 border-signal text-frost"
              : "bg-plum/15 border-plum text-frost"
          }`}
        >
          <span>
            {mappingOverlayMode === "key"
              ? selectedMappingTarget
                ? `Listening for key press to bind target "${selectedMappingTarget}"...`
                : "KEY MAPPING OVERLAY ACTIVE: Click any Scene tile, then press a keyboard key."
              : selectedMappingTarget
                ? `Click "Assign Note 48" or send CC/Note for "${selectedMappingTarget}".`
                : "MIDI MAPPING OVERLAY ACTIVE: Click any Scene tile to assign a MIDI note."}
          </span>
          {mappingOverlayMode === "midi" && selectedMappingTarget && (
            <button
              type="button"
              data-testid="simulate-midi-bind-btn"
              onClick={() => bindMidiToTarget(selectedMappingTarget, "Note 48")}
              className="px-2.5 py-0.5 rounded bg-plum text-frost font-semibold"
            >
              Assign Note 48
            </button>
          )}
        </div>
      )}

      {/* Upper Daslight Split: When Timeline is expanded full-width, show Scene Library + 2D Grid side-by-side; otherwise Banks & Scenes + FX Inspector */}
      {isTimelineFullWidth ? (
        <div
          ref={expandedUpperRef}
          className="flex-1 min-h-0 flex flex-col lg:flex-row gap-1.5 lg:gap-0"
        >
          <div
            style={{ width: `${studioLayout.expandedUpperSplitPct}%` }}
            className="min-h-0 min-w-0 flex flex-col max-lg:!w-full"
          >
            <SceneAndFxManager
              hideUndoRedo
              daslightUpper
              showInspector={false}
              liveBuskingMode={false}
            />
          </div>
          <SplitHandle
            orientation="vertical"
            testId="split-expanded-upper"
            ariaLabel="Resize Scene Library and 2D Grid"
            className="hidden lg:flex"
            onDragDelta={(deltaPx) => {
              const totalW = expandedUpperRef.current?.clientWidth || 1200;
              const deltaPct = (deltaPx / Math.max(300, totalW)) * 100;
              setStudioLayout({
                expandedUpperSplitPct:
                  useTaktStore.getState().studioLayout.expandedUpperSplitPct +
                  deltaPct,
              });
            }}
            onDoubleClick={() =>
              setStudioLayout({
                expandedUpperSplitPct: DEFAULT_STUDIO_LAYOUT.expandedUpperSplitPct,
              })
            }
          />
          <div className="flex-1 min-h-0 min-w-0">
            <FixtureGrid2D hideUndoRedo compact />
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          <SceneAndFxManager
            hideUndoRedo
            daslightUpper
            showInspector={showInspector}
            liveBuskingMode={false}
          />
        </div>
      )}

      {showBottomDock && (
        <SplitHandle
          orientation="horizontal"
          testId="split-studio-vertical"
          ariaLabel="Resize upper and bottom workspace height"
          onDragDelta={(deltaPx) => {
            const totalH = workspaceContainerRef.current?.clientHeight || 720;
            const deltaPct = (deltaPx / Math.max(300, totalH)) * 100;
            setStudioLayout({
              bottomDockPct:
                useTaktStore.getState().studioLayout.bottomDockPct - deltaPct,
            });
          }}
          onDoubleClick={() =>
            setStudioLayout({
              bottomDockPct: DEFAULT_STUDIO_LAYOUT.bottomDockPct,
            })
          }
        />
      )}

      {/* Middle Horizontal GROUPS + Bottom Dock Tab Bar */}
      <section
        data-testid="daslight-groups-bar"
        className="shrink-0 bg-slate-dark border border-steel rounded px-2.5 py-1 flex flex-wrap items-center justify-between gap-2 relative"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1 font-mono text-[10px] uppercase text-fog mr-1">
            <Users className="w-3 h-3 text-plum" />
            <span>GROUPS</span>
          </span>
          <button
            type="button"
            aria-pressed={activeGroupFilterId === "all"}
            onClick={() => setActiveGroupFilterId("all")}
            className={`px-2 py-0.5 rounded border font-mono text-[11px] transition-colors ${
              activeGroupFilterId === "all"
                ? "bg-frost text-void border-frost font-semibold"
                : "bg-ink text-mist border-steel hover:border-fog"
            }`}
          >
            All
          </button>
          {showState.groups.map((grp) => (
            <button
              key={grp.id}
              type="button"
              onClick={() => setActiveGroupFilterId(grp.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setGroupContextMenu({
                  groupId: grp.id,
                  groupName: grp.name,
                  x: e.clientX,
                  y: e.clientY,
                });
              }}
              className={`px-2 py-0.5 rounded border font-mono text-[11px] truncate max-w-[140px] cursor-pointer transition-colors ${
                activeGroupFilterId === grp.id
                  ? "bg-plum/25 border-plum text-frost font-semibold"
                  : "bg-ink border-steel text-mist hover:border-fog"
              }`}
              title={`${grp.order}: ${grp.targets.join(", ")} · Right-click to delete`}
            >
              {grp.name}
            </button>
          ))}

          <details className="relative">
            <summary
              title="Create Group"
              className="list-none cursor-pointer flex items-center gap-1 px-1.5 py-0.5 rounded border border-steel bg-ink hover:border-plum font-mono text-[11px] text-mist"
            >
              <Plus className="w-3 h-3 text-plum" />
              {selectedCellIndices.length > 0 && (
                <span>({selectedCellIndices.length})</span>
              )}
            </summary>
            <div className="absolute left-0 bottom-7 z-30 flex flex-wrap items-center gap-1.5 bg-slate-dark border border-steel rounded p-2 shadow-xl min-w-[360px]">
              <input
                aria-label="Group Name"
                type="text"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="Group Name"
                className="w-28 bg-ink border border-steel rounded px-2 py-1 text-xs text-frost"
              />
              <select
                aria-label="Group Order"
                value={groupOrder}
                onChange={(e) => setGroupOrder(e.target.value as OrderRuleStr)}
                className="bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              >
                <option value="linear">Linear</option>
                <option value="reverse">Reverse</option>
                <option value="center_out">Center Out</option>
                <option value="mirror">Mirror</option>
                <option value="odd_even">Odd Even</option>
                <option value="blocks(2)">Blocks (2)</option>
              </select>
              <input
                aria-label="Group Targets"
                type="text"
                value={groupTargets}
                onChange={(e) => {
                  setHasCustomTargets(true);
                  setGroupTargets(e.target.value);
                }}
                placeholder={
                  selectedCellIndices.length > 0
                    ? `${selectedCellIndices.length} canvas cells`
                    : "fx_001:0..7"
                }
                className="w-28 bg-ink border border-steel rounded px-2 py-1 text-xs font-mono text-frost"
              />
              <button
                type="button"
                onClick={() => void handleSaveGroup()}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-ink border border-plum hover:bg-plum/20 text-frost text-xs font-semibold"
              >
                <Plus className="w-3 h-3 text-plum" />
                <span>Save Group</span>
              </button>
            </div>
          </details>
        </div>

        {/* Active Scene Edit Indicator */}
        <div className="flex items-center gap-0.5 bg-pitch border border-steel rounded p-0.5 font-mono text-[11px]">
          <button
            type="button"
            data-testid="submode-builder"
            aria-pressed={true}
            onClick={() => setStudioSubMode("builder")}
            className="px-2.5 py-0.5 rounded bg-slate text-frost font-semibold border border-steel transition-colors"
          >
            EDIT: {activeScene ? activeScene.name : "Scene"}
          </button>
        </div>
      </section>

      {/* Bottom Split Dock: Full-width Expanded Timeline OR Left = 2D Grid, Right = Timeline / EDIT */}
      {showBottomDock &&
        (isTimelineFullWidth ? (
          <div
            data-testid="daslight-timeline-dock"
            style={{
              height: `${Math.min(72, Math.max(32, studioLayout.bottomDockPct + 5))}%`,
            }}
            className="min-h-[240px] shrink-0 overflow-y-auto"
          >
            <TimelineEditor
              hideUndoRedo
              timelineId={activeScene?.timeline_ref ?? undefined}
              expanded={timelineExpanded}
              onToggleExpand={() =>
                setStudioLayout({ timelineExpanded: !timelineExpanded })
              }
            />
          </div>
        ) : (
          <div
            ref={bottomSplitRef}
            data-testid="daslight-bottom-dock"
            style={{ height: `${studioLayout.bottomDockPct}%` }}
            className="min-h-[220px] shrink-0 flex flex-col lg:flex-row gap-1.5 lg:gap-0 min-h-0"
          >
            <div
              style={{ width: `${studioLayout.bottomSplitPct}%` }}
              className="h-full min-h-0 min-w-0 max-lg:!w-full"
            >
              <FixtureGrid2D hideUndoRedo compact />
            </div>
            <SplitHandle
              orientation="vertical"
              testId="split-bottom-dock-horizontal"
              ariaLabel="Resize 2D Grid and Controls or Timeline"
              className="hidden lg:flex"
              onDragDelta={(deltaPx) => {
                const totalW = bottomSplitRef.current?.clientWidth || 1200;
                const deltaPct = (deltaPx / Math.max(300, totalW)) * 100;
                setStudioLayout({
                  bottomSplitPct:
                    useTaktStore.getState().studioLayout.bottomSplitPct +
                    deltaPct,
                });
              }}
              onDoubleClick={() =>
                setStudioLayout({
                  bottomSplitPct: DEFAULT_STUDIO_LAYOUT.bottomSplitPct,
                })
              }
            />
            <div className="flex-1 h-full min-h-0 min-w-0 overflow-y-auto">
              {isTimelineScene ? (
                <div data-testid="daslight-timeline-dock" className="h-full min-h-0">
                  <TimelineEditor
                    hideUndoRedo
                    timelineId={activeScene?.timeline_ref ?? undefined}
                    expanded={timelineExpanded}
                    onToggleExpand={() =>
                      setStudioLayout({ timelineExpanded: !timelineExpanded })
                    }
                  />
                </div>
              ) : (
                <PalettesAndControls
                  hideUndoRedo
                  hideGroups
                  daslightDock
                />
              )}
            </div>
          </div>
        ))}

      {groupContextMenu && (
        <div
          data-testid="group-context-menu"
          style={{ left: groupContextMenu.x, top: groupContextMenu.y }}
          className="fixed z-50 bg-slate-dark border border-steel rounded shadow-2xl py-1 min-w-[150px] font-mono text-xs flex flex-col"
        >
          <button
            type="button"
            aria-label={`Delete group ${groupContextMenu.groupName}`}
            onClick={() => {
              void deleteGroup(groupContextMenu.groupId);
              if (activeGroupFilterId === groupContextMenu.groupId) {
                setActiveGroupFilterId("all");
              }
              setGroupContextMenu(null);
            }}
            className="px-3 py-1.5 text-left text-signal hover:bg-ink flex items-center gap-2"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete Group</span>
          </button>
        </div>
      )}
    </div>
  );
}
