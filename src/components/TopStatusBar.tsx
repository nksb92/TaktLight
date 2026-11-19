import {
  Cpu,
  FolderOpen,
  Lock,
  Network,
  Power,
  Radio,
  Save,
  ShieldAlert,
} from "lucide-react";
import { type ChangeEvent, useEffect, useRef } from "react";
import { AdapterSelection, useTaktStore } from "../store/useTaktStore";
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

  const setBlackout = useTaktStore((s) => s.setBlackout);
  const setGrandMaster = useTaktStore((s) => s.setGrandMaster);
  const setNetworkAdapter = useTaktStore((s) => s.setNetworkAdapter);
  const setOutputEnabled = useTaktStore((s) => s.setOutputEnabled);
  const saveProjectToFile = useTaktStore((s) => s.saveProjectToFile);
  const importShowXml = useTaktStore((s) => s.importShowXml);

  const openFileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSaveProject = async () => {
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
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSaveProject();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openFileInputRef.current?.click();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const parkedCount = Object.keys(parkedChannels).length;
  const onlineNodeCount = discoveredNodes.filter((n) => n.online).length;
  const meanMs = (telemetry.meanUs / 1000).toFixed(2);
  const p99Ms = (telemetry.p99JitterUs / 1000).toFixed(2);
  const hz =
    telemetry.meanUs > 0
      ? (1_000_000 / telemetry.meanUs).toFixed(1)
      : "44.0";
  const timingHealthy = telemetry.droppedFrames === 0;

  return (
    <header className="shrink-0 bg-slate-dark border-b border-steel px-3 py-1.5 flex flex-wrap items-center justify-between gap-2">
      {/* Brand + Frame Timing Telemetry */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-1.5 h-6 rounded-full bg-ember" />
          <span className="font-sans font-semibold text-base tracking-wide text-mist">
            TAKTLIGHT
          </span>
        </div>

        {/* Project Open / Save Icon Controls */}
        <div className="flex items-center gap-1">
          <input
            ref={openFileInputRef}
            type="file"
            accept=".takt.xml,.xml"
            aria-label="Open Project File"
            onChange={(e) => void handleOpenProjectFile(e)}
            className="hidden"
          />
          <button
            type="button"
            data-testid="topbar-open-project-btn"
            aria-label="Open Project"
            title="Open Project (.takt.xml) [Ctrl+O]"
            onClick={() => openFileInputRef.current?.click()}
            className="p-1.5 rounded-md bg-ink border border-steel text-mist hover:border-cobalt hover:text-frost transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            data-testid="topbar-save-project-btn"
            aria-label="Save Project"
            title={
              isDirty
                ? "Save Project (.takt.xml) [Ctrl+S] (unsaved changes)"
                : "Save Project (.takt.xml) [Ctrl+S]"
            }
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
        </div>

        {/* 44 Hz Telemetry Pill */}
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

        {/* Active Warning Badges */}
        {parkedCount > 0 && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-signal/20 border border-signal text-frost font-mono text-xs font-medium">
            <Lock className="w-3.5 h-3.5 text-signal" />
            <span>PARK OVERRIDE: {parkedCount} CH</span>
          </div>
        )}

        {blackout && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-signal text-frost font-mono text-xs font-semibold">
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
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-ink border border-steel font-mono text-xs text-fog"
          title={
            discoveryAvailable
              ? "ArtPoll UDP 6454 discovery active"
              : "ArtPoll UDP 6454 listener inactive"
          }
        >
          <Radio
            className={`w-3.5 h-3.5 ${
              discoveryAvailable && !isOffline ? "text-pine" : "text-fog"
            }`}
          />
          <span>NODES: {onlineNodeCount}</span>
        </div>

        {/* Grand Master */}
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

        {/* Blackout Button */}
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
      </div>
    </header>
  );
}
