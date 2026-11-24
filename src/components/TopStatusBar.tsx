import {
  ChevronDown,
  ChevronRight,
  Cpu,
  FilePlus,
  FolderOpen,
  History,
  LayoutGrid,
  Lock,
  Network,
  Power,
  Radio,
  RotateCcw,
  Save,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import {
  AdapterSelection,
  isTauriEnvironment,
  useTaktStore,
} from "../store/useTaktStore";
import { HelpTooltip } from "./HelpTooltip";
import { NumericSlider } from "./NumericSlider";

function selectionToKey(sel: AdapterSelection): string {
  if (sel.mode === "auto") return "auto";
  if (sel.mode === "offline") return "offline";
  return `named::${sel.name}::${sel.subnet_cidr}`;
}

function keyToSelection(key: string): AdapterSelection {
  if (key === "auto") return { mode: "auto" };
  if (key === "offline") return { mode: "offline" };
  const [, name = "", subnet_cidr = ""] = key.split("::");
  return { mode: "named", name, subnet_cidr };
}

export function TopStatusBar() {
  const telemetry = useTaktStore((s) => s.telemetry);
  const jitterSamplesUs = useTaktStore((s) => s.jitterSamplesUs);
  const parkedChannels = useTaktStore((s) => s.parkedChannels);
  const blackout = useTaktStore((s) => s.blackout);
  const grandMaster = useTaktStore((s) => s.grandMaster);
  const interfaces = useTaktStore((s) => s.interfaces);
  const adapterSelection = useTaktStore((s) => s.adapterSelection);
  const isOffline = useTaktStore((s) => s.isOffline);
  const outputEnabled = useTaktStore((s) => s.outputEnabled);
  const discoveryAvailable = useTaktStore((s) => s.discoveryAvailable);
  const activeInterface = useTaktStore((s) => s.activeInterface);
  const discoveredNodes = useTaktStore((s) => s.discoveredNodes);
  const isDirty = useTaktStore((s) => s.isDirty);
  const recentProjects = useTaktStore((s) => s.recentProjects);
  const studioLayout = useTaktStore((s) => s.studioLayout);

  const setBlackout = useTaktStore((s) => s.setBlackout);
  const setGrandMaster = useTaktStore((s) => s.setGrandMaster);
  const setNetworkAdapter = useTaktStore((s) => s.setNetworkAdapter);
  const setOutputEnabled = useTaktStore((s) => s.setOutputEnabled);
  const requestProjectAction = useTaktStore((s) => s.requestProjectAction);
  const saveProjectToFile = useTaktStore((s) => s.saveProjectToFile);
  const saveProjectAsFile = useTaktStore((s) => s.saveProjectAsFile);
  const importShowXml = useTaktStore((s) => s.importShowXml);
  const setStudioLayout = useTaktStore((s) => s.setStudioLayout);
  const resetStudioLayout = useTaktStore((s) => s.resetStudioLayout);

  const openFileInputRef = useRef<HTMLInputElement | null>(null);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);
  const [openMenu, setOpenMenu] = useState<"file" | "view" | null>(null);
  const [recentSubmenuOpen, setRecentSubmenuOpen] = useState(false);

  const handleOpenProject = async () => {
    setOpenMenu(null);
    await requestProjectAction({ type: "open_project" });
  };

  const handleSaveProject = async () => {
    setOpenMenu(null);
    await saveProjectToFile();
  };

  const handleOpenProjectFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      await importShowXml(content);
    } finally {
      e.target.value = "";
    }
  };

  useEffect(() => {
    const onFallbackOpen = () => {
      openFileInputRef.current?.click();
    };
    window.addEventListener("takt:open-file-fallback", onFallbackOpen);
    return () =>
      window.removeEventListener("takt:open-file-fallback", onFallbackOpen);
  }, []);

  useEffect(() => {
    if (!openMenu) {
      setRecentSubmenuOpen(false);
      return;
    }
    const onPointerDown = (e: MouseEvent) => {
      if (
        menuContainerRef.current &&
        !menuContainerRef.current.contains(e.target as Node)
      ) {
        setOpenMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "s" && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        setOpenMenu(null);
        void saveProjectAsFile();
      } else if (key === "s") {
        e.preventDefault();
        e.stopPropagation();
        void handleSaveProject();
      } else if (key === "o") {
        e.preventDefault();
        e.stopPropagation();
        void handleOpenProject();
      } else if (key === "n") {
        e.preventDefault();
        e.stopPropagation();
        setOpenMenu(null);
        void requestProjectAction({ type: "new_project" });
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const parkedCount = Object.keys(parkedChannels).length;
  const onlineNodeCount = discoveredNodes.filter((n) => n.online).length;
  const meanMs = (telemetry.meanUs / 1000).toFixed(2);
  const p99Ms = (telemetry.p99JitterUs / 1000).toFixed(2);
  const hz =
    telemetry.meanUs > 0
      ? (1_000_000 / telemetry.meanUs).toFixed(1)
      : "44.0";
  const recentDrops = jitterSamplesUs.filter((dt) => dt > 34_090.5).length;
  const timingHealthy =
    jitterSamplesUs.length > 0 ? recentDrops === 0 : telemetry.droppedFrames === 0;
  const lastRecent = recentProjects[0] ?? null;

  return (
    <header className="shrink-0 bg-slate-dark border-b border-steel px-3 py-1.5 flex flex-wrap items-center justify-between gap-2">
      {/* Brand + App Menus + Frame Timing Telemetry */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-1.5 h-6 rounded-full bg-ember" />
          <span className="font-sans font-semibold text-base tracking-wide text-mist">
            TAKTLIGHT
          </span>
        </div>

        {/* File / View Application Menus */}
        <div ref={menuContainerRef} className="relative flex items-center gap-1">
          <div className="relative">
            <button
              type="button"
              data-testid="menu-file-btn"
              aria-expanded={openMenu === "file"}
              onClick={() =>
                setOpenMenu((cur) => (cur === "file" ? null : "file"))
              }
              className={`flex items-center gap-1 px-2 py-1 rounded-md border font-mono text-xs transition-colors ${
                openMenu === "file"
                  ? "bg-slate border-ember text-frost"
                  : "bg-ink border-steel text-mist hover:border-fog"
              }`}
            >
              <span>File</span>
              <ChevronDown className="w-3 h-3 text-fog" />
            </button>

            {openMenu === "file" && (
              <div
                role="menu"
                data-testid="menu-file-dropdown"
                className="absolute left-0 top-full mt-1 z-50 min-w-[230px] rounded-md border border-steel bg-slate-dark py-1 shadow-2xl font-mono text-xs flex flex-col"
              >
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-file-new"
                  onClick={() => {
                    setOpenMenu(null);
                    void requestProjectAction({ type: "new_project" });
                  }}
                  className="px-3 py-1.5 text-left text-mist hover:bg-ink hover:text-frost flex items-center justify-between gap-3"
                >
                  <span className="flex items-center gap-2">
                    <FilePlus className="w-3.5 h-3.5 text-ember" />
                    <span>New Project</span>
                  </span>
                  <span className="text-[10px] text-fog">Ctrl+N</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-file-open"
                  onClick={() => void handleOpenProject()}
                  className="px-3 py-1.5 text-left text-mist hover:bg-ink hover:text-frost flex items-center justify-between gap-3"
                >
                  <span className="flex items-center gap-2">
                    <FolderOpen className="w-3.5 h-3.5 text-cobalt" />
                    <span>Open Project...</span>
                  </span>
                  <span className="text-[10px] text-fog">Ctrl+O</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-file-open-last"
                  disabled={!lastRecent}
                  onClick={() => {
                    if (!lastRecent) return;
                    setOpenMenu(null);
                    void requestProjectAction({
                      type: "open_recent",
                      path: lastRecent.path,
                    });
                  }}
                  title={lastRecent ? lastRecent.path : "No recent projects"}
                  className="px-3 py-1.5 text-left text-mist hover:bg-ink hover:text-frost disabled:opacity-40 flex items-center justify-between gap-2"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <History className="w-3.5 h-3.5 text-plum shrink-0" />
                    <span className="truncate">
                      {lastRecent
                        ? `Open Last (${lastRecent.name})`
                        : "Open Last Used"}
                    </span>
                  </span>
                </button>

                <div
                  className="relative"
                  onMouseEnter={() => setRecentSubmenuOpen(true)}
                  onMouseLeave={() => setRecentSubmenuOpen(false)}
                >
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="menu-file-recent-trigger"
                    onClick={() => setRecentSubmenuOpen((v) => !v)}
                    className="w-full px-3 py-1.5 text-left text-mist hover:bg-ink hover:text-frost flex items-center justify-between gap-2"
                  >
                    <span className="flex items-center gap-2">
                      <History className="w-3.5 h-3.5 text-fog" />
                      <span>Open Recent</span>
                    </span>
                    <ChevronRight className="w-3 h-3 text-fog" />
                  </button>

                  {recentSubmenuOpen && (
                    <div
                      data-testid="menu-file-recent-list"
                      className="absolute left-full top-0 ml-0.5 min-w-[220px] max-w-[300px] rounded-md border border-steel bg-slate-dark py-1 shadow-2xl flex flex-col"
                    >
                      {recentProjects.length === 0 ? (
                        <div className="px-3 py-1.5 text-[11px] text-fog">
                          No recent projects
                        </div>
                      ) : (
                        recentProjects.map((entry) => (
                          <button
                            key={entry.path}
                            type="button"
                            title={entry.path}
                            onClick={() => {
                              setOpenMenu(null);
                              void requestProjectAction({
                                type: "open_recent",
                                path: entry.path,
                              });
                            }}
                            className="px-3 py-1.5 text-left text-mist hover:bg-ink hover:text-frost truncate"
                          >
                            {entry.name}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                <div className="my-1 border-t border-steel/70" />

                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-file-save"
                  onClick={() => void handleSaveProject()}
                  className="px-3 py-1.5 text-left text-mist hover:bg-ink hover:text-frost flex items-center justify-between gap-3"
                >
                  <span className="flex items-center gap-2">
                    <Save className="w-3.5 h-3.5 text-ember" />
                    <span>Save{isDirty ? " *" : ""}</span>
                  </span>
                  <span className="text-[10px] text-fog">Ctrl+S</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-file-save-as"
                  onClick={() => {
                    setOpenMenu(null);
                    void saveProjectAsFile();
                  }}
                  className="px-3 py-1.5 text-left text-mist hover:bg-ink hover:text-frost flex items-center justify-between gap-3"
                >
                  <span className="flex items-center gap-2">
                    <Save className="w-3.5 h-3.5 text-fog" />
                    <span>Save As...</span>
                  </span>
                  <span className="text-[10px] text-fog">Ctrl+Shift+S</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-file-close"
                  onClick={() => {
                    setOpenMenu(null);
                    void requestProjectAction({ type: "close_project" });
                  }}
                  className="px-3 py-1.5 text-left text-mist hover:bg-ink hover:text-frost flex items-center gap-2"
                >
                  <XCircle className="w-3.5 h-3.5 text-fog" />
                  <span>Close Project</span>
                </button>

                {isTauriEnvironment() && (
                  <>
                    <div className="my-1 border-t border-steel/70" />
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="menu-file-exit"
                      onClick={() => {
                        setOpenMenu(null);
                        void requestProjectAction({ type: "close_window" });
                      }}
                      className="px-3 py-1.5 text-left text-signal hover:bg-ink flex items-center gap-2"
                    >
                      <Power className="w-3.5 h-3.5" />
                      <span>Exit</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="relative">
            <button
              type="button"
              data-testid="menu-view-btn"
              aria-expanded={openMenu === "view"}
              onClick={() =>
                setOpenMenu((cur) => (cur === "view" ? null : "view"))
              }
              className={`flex items-center gap-1 px-2 py-1 rounded-md border font-mono text-xs transition-colors ${
                openMenu === "view"
                  ? "bg-slate border-ember text-frost"
                  : "bg-ink border-steel text-mist hover:border-fog"
              }`}
            >
              <span>View</span>
              <ChevronDown className="w-3 h-3 text-fog" />
            </button>

            {openMenu === "view" && (
              <div
                role="menu"
                data-testid="menu-view-dropdown"
                className="absolute left-0 top-full mt-1 z-50 min-w-[220px] rounded-md border border-steel bg-slate-dark py-1 shadow-2xl font-mono text-xs flex flex-col"
              >
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-view-toggle-inspector"
                  onClick={() => {
                    setStudioLayout({
                      showInspector: !studioLayout.showInspector,
                    });
                    setOpenMenu(null);
                  }}
                  className="px-3 py-1.5 text-left text-mist hover:bg-ink hover:text-frost flex items-center justify-between gap-2"
                >
                  <span className="flex items-center gap-2">
                    <LayoutGrid className="w-3.5 h-3.5 text-cobalt" />
                    <span>FX Inspector</span>
                  </span>
                  <span className="text-[10px] text-ember">
                    {studioLayout.showInspector ? "ON" : "OFF"}
                  </span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-view-toggle-bottom-dock"
                  onClick={() => {
                    setStudioLayout({
                      showBottomDock: !studioLayout.showBottomDock,
                    });
                    setOpenMenu(null);
                  }}
                  className="px-3 py-1.5 text-left text-mist hover:bg-ink hover:text-frost flex items-center justify-between gap-2"
                >
                  <span className="flex items-center gap-2">
                    <LayoutGrid className="w-3.5 h-3.5 text-plum" />
                    <span>2D Grid &amp; Dock</span>
                  </span>
                  <span className="text-[10px] text-ember">
                    {studioLayout.showBottomDock ? "ON" : "OFF"}
                  </span>
                </button>

                <div className="my-1 border-t border-steel/70" />

                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-reset-layout-btn"
                  onClick={() => {
                    resetStudioLayout();
                    setOpenMenu(null);
                  }}
                  className="px-3 py-1.5 text-left text-mist hover:bg-ink hover:text-frost flex items-center gap-2"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-ember" />
                  <span>Reset Layout</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Project Open / Save Quick Icon Controls */}
        <div className="flex items-center gap-1">
          <input
            ref={openFileInputRef}
            type="file"
            accept=".takt.xml,.xml"
            aria-label="Open Project File"
            onChange={(e) => void handleOpenProjectFile(e)}
            className="hidden"
          />
          <HelpTooltip text="Open Project (.takt.xml) [Ctrl+O]">
            <button
              type="button"
              data-testid="topbar-open-project-btn"
              aria-label="Open Project"
              onClick={() => void handleOpenProject()}
              className="p-1.5 rounded-md bg-ink border border-steel text-mist hover:border-cobalt hover:text-frost transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
          </HelpTooltip>
          <HelpTooltip
            text={
              isDirty
                ? "Save Project (.takt.xml) [Ctrl+S] (unsaved changes)"
                : "Save Project (.takt.xml) [Ctrl+S]"
            }
          >
            <button
              type="button"
              data-testid="topbar-save-project-btn"
              aria-label="Save Project"
              onClick={() => void handleSaveProject()}
              className={`relative p-1.5 rounded-md bg-ink border text-mist hover:border-ember hover:text-frost transition-colors ${
                isDirty ? "border-ember" : "border-steel"
              }`}
            >
              <Save className="w-3.5 h-3.5" />
              {isDirty && (
                <span
                  data-testid="topbar-unsaved-dot"
                  className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-ember"
                />
              )}
            </button>
          </HelpTooltip>
        </div>

        {/* 44 Hz Telemetry Pill */}
        <HelpTooltip text="Real-time 44 Hz DMX engine loop rate, mean frame interval, and p99 jitter.">
          <div
            className={`flex items-center gap-2 px-3 py-1 rounded-md border font-mono text-xs ${
              timingHealthy
                ? "bg-pitch border-pine text-mist"
                : "bg-pitch border-signal text-frost"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                timingHealthy ? "bg-pine" : "bg-signal animate-pulse"
              }`}
            />
            <span>
              {hz} Hz | {meanMs} ms ± {p99Ms} ms
            </span>
          </div>
        </HelpTooltip>

        {/* Active Warning Badges */}
        {parkedCount > 0 && (
          <div
            data-testid="topbar-park-override-badge"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-signal/20 border border-signal text-frost font-mono text-xs font-medium"
          >
            <Lock className="w-3.5 h-3.5 text-signal" />
            <span>PARK OVERRIDE: {parkedCount} CH</span>
          </div>
        )}

        {blackout && (
          <div
            data-testid="topbar-blackout-badge"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-signal text-frost font-mono text-xs font-semibold"
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>BLACKOUT ACTIVE</span>
          </div>
        )}
      </div>

      {/* Network Adapter, Histogram Toggle, Grand Master & Blackout */}
      <div className="flex flex-wrap items-center gap-3">
        {/* NIC / Offline Selector */}
        <div className="flex items-center gap-2 bg-ink border border-steel rounded-md px-2.5 py-1">
          <Network className="w-3.5 h-3.5 text-fog" />
          <select
            aria-label="Network Output Adapter"
            value={selectionToKey(adapterSelection)}
            onChange={(e) => {
              void setNetworkAdapter(keyToSelection(e.target.value));
            }}
            className="bg-transparent text-mist font-mono text-xs focus:outline-none cursor-pointer"
          >
            <option value="auto" className="bg-slate-dark text-mist">
              Auto Interface
            </option>
            <option value="offline" className="bg-slate-dark text-mist">
              Offline Loopback
            </option>
            {interfaces.map((iface) => (
              <option
                key={`${iface.name}:${iface.ipv4}`}
                value={`named::${iface.name}::${iface.subnet_cidr}`}
                className="bg-slate-dark text-mist"
              >
                {iface.name} ({iface.ipv4})
              </option>
            ))}
          </select>

          <span
            className={`font-mono text-[10px] uppercase px-1.5 py-0.5 rounded ${
              isOffline || !outputEnabled
                ? "bg-slate text-fog border border-steel"
                : "bg-pine/25 text-mist border border-pine"
            }`}
          >
            {!outputEnabled
              ? "TX OFF"
              : isOffline
                ? "OFFLINE"
                : activeInterface
                  ? activeInterface.ipv4
                  : "LIVE"}
          </span>

          <button
            type="button"
            data-testid="toggle-network-output-btn"
            aria-label={outputEnabled ? "Stop Network Output" : "Start Network Output"}
            aria-pressed={outputEnabled}
            title={
              outputEnabled
                ? "Stop Art-Net / sACN Network Output"
                : "Start Art-Net / sACN Network Output"
            }
            onClick={() => void setOutputEnabled(!outputEnabled)}
            className={`p-1 rounded border transition-colors ${
              outputEnabled
                ? "bg-pine/25 border-pine text-frost hover:bg-pine/40"
                : "bg-pitch border-steel text-fog hover:border-ember hover:text-mist"
            }`}
          >
            <Power className="w-3 h-3" />
          </button>
        </div>

        {/* ArtPoll Discovery Pill */}
        <HelpTooltip
          text={
            discoveryAvailable
              ? "ArtPoll UDP 6454 node discovery active on the selected network interface."
              : "ArtPoll UDP 6454 discovery listener inactive (offline or loopback mode)."
          }
        >
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-ink border border-steel font-mono text-xs text-fog">
            <Radio
              className={`w-3.5 h-3.5 ${
                discoveryAvailable && !isOffline ? "text-pine" : "text-fog"
              }`}
            />
            <span>NODES: {onlineNodeCount}</span>
          </div>
        </HelpTooltip>

        {/* Grand Master */}
        <HelpTooltip
          testId="topbar-gm-help"
          text="Grand Master (GM): scales overall DMX output intensity (0–100%) across all universes. Parked channels bypass GM."
        >
          <div className="flex items-center gap-2 bg-ink border border-steel rounded-md px-3 py-1">
            <Cpu className="w-3.5 h-3.5 text-fog" />
            <span className="font-mono text-[11px] text-fog uppercase">GM</span>
            <NumericSlider
              ariaLabel="Grand Master"
              value={grandMaster}
              defaultValue={1}
              min={0}
              max={1}
              step={0.01}
              displayMultiplier={100}
              unit="%"
              precision={0}
              onChange={(v) => void setGrandMaster(v)}
              className="w-44"
              sliderClassName="w-20 accent-ember cursor-pointer"
              inputClassName="w-12"
            />
          </div>
        </HelpTooltip>

        {/* Blackout Button */}
        <HelpTooltip text="Blackout: immediately forces all non-parked DMX channels to 0 without stopping running scenes.">
          <button
            type="button"
            onClick={() => {
              void setBlackout(!blackout);
            }}
            aria-pressed={blackout}
            className={`px-3.5 py-1 rounded-md font-mono text-xs font-semibold tracking-wider border transition-colors ${
              blackout
                ? "bg-signal border-frost text-frost"
                : "bg-ink border-steel text-mist hover:border-signal"
            }`}
          >
            BLACKOUT
          </button>
        </HelpTooltip>
      </div>
    </header>
  );
}
