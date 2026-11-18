import { Activity, Cpu, Lock, Network, Radio, ShieldAlert } from "lucide-react";
import { AdapterSelection, useTaktStore } from "../store/useTaktStore";

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
  const discoveryAvailable = useTaktStore((s) => s.discoveryAvailable);
  const activeInterface = useTaktStore((s) => s.activeInterface);
  const discoveredNodes = useTaktStore((s) => s.discoveredNodes);
  const histogramOpen = useTaktStore((s) => s.histogramOpen);

  const setBlackout = useTaktStore((s) => s.setBlackout);
  const setGrandMaster = useTaktStore((s) => s.setGrandMaster);
  const setNetworkAdapter = useTaktStore((s) => s.setNetworkAdapter);
  const toggleHistogram = useTaktStore((s) => s.toggleHistogram);

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
    <header className="bg-slate-dark border-b-[1.5px] border-steel px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
      {/* Brand + Frame Timing Telemetry */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-1.5 h-7 rounded-full bg-ember" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-sans font-semibold text-base tracking-wide text-mist">
                TAKTLIGHT
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded bg-ink border border-steel text-fog">
                SLICE 1
              </span>
            </div>
          </div>
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
              isOffline
                ? "bg-slate text-fog border border-steel"
                : "bg-pine/25 text-mist border border-pine"
            }`}
          >
            {isOffline
              ? "OFFLINE"
              : activeInterface
                ? activeInterface.ipv4
                : "LIVE"}
          </span>
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

        {/* Histogram Toggle */}
        <button
          type="button"
          onClick={toggleHistogram}
          aria-pressed={histogramOpen}
          className={`flex items-center gap-1.5 px-3 py-1 rounded-md border font-sans text-xs font-medium transition-colors ${
            histogramOpen
              ? "bg-ember/15 border-ember text-mist"
              : "bg-ink border-steel text-fog hover:text-mist"
          }`}
        >
          <Activity className="w-3.5 h-3.5 text-ember" />
          <span>Jitter Histogram</span>
        </button>

        {/* Grand Master */}
        <div className="flex items-center gap-2 bg-ink border border-steel rounded-md px-3 py-1">
          <Cpu className="w-3.5 h-3.5 text-fog" />
          <span className="font-mono text-[11px] text-fog uppercase">GM</span>
          <input
            aria-label="Grand Master"
            type="range"
            min={0}
            max={100}
            value={Math.round(grandMaster * 100)}
            onChange={(e) => {
              void setGrandMaster(Number(e.target.value) / 100);
            }}
            className="w-24 accent-ember cursor-pointer"
          />
          <span className="font-mono text-xs text-mist w-10 text-right">
            {Math.round(grandMaster * 100)}%
          </span>
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
