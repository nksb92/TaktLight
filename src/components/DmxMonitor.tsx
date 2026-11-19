import { Activity, Lock, Unlock, X } from "lucide-react";
import {
  DisplayFormat,
  parkKey,
  UniverseConfig,
  useTaktStore,
} from "../store/useTaktStore";
import { NumericSlider } from "./NumericSlider";

const CHANNEL_INDICES = Array.from({ length: 512 }, (_, idx) => idx + 1);
const QUICK_PRESETS = [0, 64, 128, 192, 255];

function formatDmxValue(value: number, format: DisplayFormat): string {
  if (format === "HEX") {
    return value.toString(16).toUpperCase().padStart(2, "0");
  }
  if (format === "PCT") {
    return `${Math.round((value / 255) * 100)}%`;
  }
  return String(value);
}

function protocolBadge(uni: UniverseConfig): {
  label: string;
  classes: string;
} {
  if (uni.protocol.protocol === "art_net") {
    return {
      label: "ARTNET",
      classes: "bg-ember/20 text-ember border-ember",
    };
  }
  return {
    label: "SACN",
    classes: "bg-cobalt/25 text-mist border-cobalt",
  };
}

export function DmxMonitor() {
  const universes = useTaktStore((s) => s.universes);
  const selectedUniverseId = useTaktStore((s) => s.selectedUniverseId);
  const dmxByUniverse = useTaktStore((s) => s.dmxByUniverse);
  const parkedChannels = useTaktStore((s) => s.parkedChannels);
  const displayFormat = useTaktStore((s) => s.displayFormat);
  const selectedChannel = useTaktStore((s) => s.selectedChannel);
  const histogramOpen = useTaktStore((s) => s.histogramOpen);

  const setSelectedUniverse = useTaktStore((s) => s.setSelectedUniverse);
  const setDisplayFormat = useTaktStore((s) => s.setDisplayFormat);
  const selectChannel = useTaktStore((s) => s.selectChannel);
  const setChannelPark = useTaktStore((s) => s.setChannelPark);
  const clearAllParked = useTaktStore((s) => s.clearAllParked);
  const toggleHistogram = useTaktStore((s) => s.toggleHistogram);

  const dmx = dmxByUniverse[selectedUniverseId] ?? new Uint8Array(512);
  const universeParkedCount = Object.keys(parkedChannels).filter((k) =>
    k.startsWith(`${selectedUniverseId}:`),
  ).length;
  const totalParkedCount = Object.keys(parkedChannels).length;

  const selectedValue =
    selectedChannel !== null ? (dmx[selectedChannel - 1] ?? 0) : 0;
  const selectedParkedValue =
    selectedChannel !== null
      ? parkedChannels[parkKey(selectedUniverseId, selectedChannel)]
      : undefined;

  return (
    <section className="bg-slate border-[1.5px] border-steel rounded-panel p-4 flex flex-col gap-4">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-sans text-base font-semibold text-mist">
          512 Channel DMX Monitor (U{selectedUniverseId}.001 to U
          {selectedUniverseId}.512)
        </h2>

        <div className="flex flex-wrap items-center gap-2.5">
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
          {/* Universe Tabs */}
          <div className="flex items-center gap-1.5 bg-ink p-1 rounded-md border border-steel">
            {universes.map((uni) => {
              const active = uni.id === selectedUniverseId;
              const badge = protocolBadge(uni);
              return (
                <button
                  key={uni.id}
                  type="button"
                  data-testid={`universe-tab-${uni.id}`}
                  aria-pressed={active}
                  onClick={() => setSelectedUniverse(uni.id)}
                  className={`flex items-center gap-2 px-2.5 py-1 rounded font-mono text-xs transition-colors ${
                    active
                      ? "bg-slate text-mist border border-ember"
                      : "text-fog hover:text-mist border border-transparent"
                  }`}
                >
                  <span>U{uni.id}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded border ${badge.classes}`}
                  >
                    {badge.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Display Format Switcher */}
          <div className="flex items-center gap-1 bg-ink p-1 rounded-md border border-steel">
            {(["DEC", "HEX", "PCT"] as DisplayFormat[]).map((fmt) => (
              <button
                key={fmt}
                type="button"
                aria-pressed={displayFormat === fmt}
                onClick={() => setDisplayFormat(fmt)}
                className={`px-2.5 py-1 rounded font-mono text-xs transition-colors ${
                  displayFormat === fmt
                    ? "bg-ember text-frost font-semibold"
                    : "text-fog hover:text-mist"
                }`}
              >
                {fmt}
              </button>
            ))}
          </div>

          {/* Clear Parked */}
          <button
            type="button"
            disabled={totalParkedCount === 0}
            onClick={() => {
              void clearAllParked();
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-xs border transition-colors ${
              totalParkedCount > 0
                ? "bg-signal/20 border-signal text-frost hover:bg-signal/35 cursor-pointer"
                : "bg-ink border-steel text-fog opacity-50 cursor-not-allowed"
            }`}
          >
            <Unlock className="w-3.5 h-3.5" />
            <span>
              Clear Parked
              {universeParkedCount > 0 ? ` (${universeParkedCount})` : ""}
            </span>
          </button>
        </div>
      </div>

      {/* Main Content: 32x16 Matrix + Channel Park Inspector */}
      <div className="flex flex-col xl:flex-row gap-4 items-start">
        {/* 512-Channel 32x16 Grid */}
        <div className="w-full overflow-x-auto">
          <div className="grid grid-cols-8 sm:grid-cols-[repeat(16,minmax(0,1fr))] xl:grid-cols-[repeat(32,minmax(0,1fr))] gap-1 min-w-[640px]">
            {CHANNEL_INDICES.map((ch) => {
              const val = dmx[ch - 1] ?? 0;
              const isParked =
                parkedChannels[parkKey(selectedUniverseId, ch)] !== undefined;
              const isSelected = selectedChannel === ch;
              const fillPct = (val / 255) * 100;

              return (
                <button
                  key={ch}
                  type="button"
                  data-testid={`dmx-cell-${ch}`}
                  aria-label={`Channel ${String(ch).padStart(3, "0")}`}
                  onClick={() => selectChannel(ch)}
                  className={`relative flex flex-col justify-between bg-pitch rounded-[4px] px-1 pt-1 pb-1.5 min-h-[40px] border text-left transition-colors overflow-hidden ${
                    isParked
                      ? "border-signal"
                      : isSelected
                        ? "border-ember ring-1 ring-ember"
                        : "border-steel/60 hover:border-fog"
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <span className="font-mono text-[9px] leading-none text-fog">
                      {String(ch).padStart(3, "0")}
                    </span>
                    {isParked && (
                      <span className="w-1.5 h-1.5 rounded-full bg-signal" />
                    )}
                  </div>

                  <span
                    className={`font-mono text-[11px] leading-tight font-medium mt-0.5 ${
                      isParked
                        ? "text-frost"
                        : val > 0
                          ? "text-mist"
                          : "text-fog/70"
                    }`}
                  >
                    {formatDmxValue(val, displayFormat)}
                  </span>

                  {/* Intensity Bar */}
                  <div className="w-full h-1 bg-ink rounded-full overflow-hidden mt-0.5">
                    <div
                      className={isParked ? "h-full bg-signal" : "h-full bg-ember"}
                      style={{ width: `${fillPct}%` }}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Channel Park Inspector */}
        <aside
          data-testid="park-inspector"
          className="w-full xl:w-72 shrink-0 bg-ink border-[1.5px] border-steel rounded-panel p-3.5"
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-sans text-sm font-semibold text-mist">
              {selectedChannel !== null
                ? `U${selectedUniverseId}.${String(selectedChannel).padStart(3, "0")}`
                : "Select Any Channel"}
            </h3>
            {selectedChannel !== null && (
              <button
                type="button"
                aria-label="Close channel inspector selection"
                onClick={() => selectChannel(null)}
                className="text-fog hover:text-mist p-1"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {selectedChannel === null ? (
            <p className="font-mono text-xs text-fog">
              Select a channel cell.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between bg-pitch border border-steel rounded-md px-3 py-2">
                <div>
                  <div className="font-mono text-[10px] uppercase text-fog">
                    OUTPUT VALUE
                  </div>
                  <div className="font-mono text-lg font-semibold text-mist">
                    {selectedValue}{" "}
                    <span className="text-xs text-fog">
                      (0x{selectedValue.toString(16).toUpperCase().padStart(2, "0")})
                    </span>
                  </div>
                </div>
                <span
                  className={`font-mono text-[10px] px-2 py-0.5 rounded border ${
                    selectedParkedValue !== undefined
                      ? "bg-signal/25 border-signal text-frost"
                      : "bg-slate border-steel text-fog"
                  }`}
                >
                  {selectedParkedValue !== undefined ? "PARKED" : "LIVE"}
                </span>
              </div>

              <div>
                <div className="flex items-center justify-between font-mono text-[10px] text-fog mb-1">
                  <span>PARK OVERRIDE (0 to 255)</span>
                  <span>{selectedParkedValue ?? selectedValue}</span>
                </div>
                <NumericSlider
                  ariaLabel="Park Channel Value"
                  value={selectedParkedValue ?? selectedValue}
                  defaultValue={0}
                  min={0}
                  max={255}
                  step={1}
                  precision={0}
                  onChange={(val) => {
                    void setChannelPark(
                      selectedUniverseId,
                      selectedChannel,
                      Math.round(val),
                    );
                  }}
                  sliderClassName="accent-signal cursor-pointer"
                />
              </div>

              <div className="grid grid-cols-5 gap-1.5">
                {QUICK_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      void setChannelPark(
                        selectedUniverseId,
                        selectedChannel,
                        preset,
                      );
                    }}
                    className={`py-1 rounded font-mono text-xs border transition-colors ${
                      selectedParkedValue === preset
                        ? "bg-signal border-frost text-frost font-semibold"
                        : "bg-pitch border-steel text-mist hover:border-ember"
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    void setChannelPark(
                      selectedUniverseId,
                      selectedChannel,
                      selectedParkedValue ?? selectedValue,
                    );
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-ember hover:bg-burnt text-frost font-mono text-xs font-medium transition-colors"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>Park</span>
                </button>

                <button
                  type="button"
                  disabled={selectedParkedValue === undefined}
                  onClick={() => {
                    void setChannelPark(
                      selectedUniverseId,
                      selectedChannel,
                      null,
                    );
                  }}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md border font-mono text-xs transition-colors ${
                    selectedParkedValue !== undefined
                      ? "bg-pitch border-steel text-mist hover:border-fog"
                      : "bg-pitch border-steel/40 text-fog opacity-50 cursor-not-allowed"
                  }`}
                >
                  <Unlock className="w-3.5 h-3.5" />
                  <span>Unpark</span>
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
