import React, { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";

export interface NumericSliderProps {
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  orientation?: "horizontal" | "vertical";
  unit?: string;
  label?: string;
  disabled?: boolean;
  precision?: number;
  className?: string;
  sliderClassName?: string;
  inputClassName?: string;
  ariaLabel?: string;
  resetTitle?: string;
  onReset?: () => void;
  displayMultiplier?: number;
  active?: boolean;
}

export const NumericSlider: React.FC<NumericSliderProps> = ({
  value,
  defaultValue,
  min,
  max,
  step = 1,
  onChange,
  onCommit,
  orientation = "horizontal",
  unit = "",
  label,
  disabled = false,
  precision,
  className = "",
  sliderClassName = "",
  inputClassName = "",
  ariaLabel,
  resetTitle,
  onReset,
  displayMultiplier = 1,
  active,
}) => {
  const effectiveResetTitle =
    resetTitle ??
    (ariaLabel
      ? `Reset ${ariaLabel}`
      : label
        ? `Reset ${label}`
        : "Reset to default");
  const mult = displayMultiplier > 0 ? displayMultiplier : 1;
  const displayMin = Number((min * mult).toFixed(4));
  const displayMax = Number((max * mult).toFixed(4));
  const displayStep = Number((step * mult).toFixed(4));

  const formatDisplay = (rawVal: number): string => {
    const scaled = rawVal * mult;
    if (precision !== undefined) {
      return Number(scaled.toFixed(precision)).toString();
    }
    if (displayStep >= 1 && Math.abs(Math.round(scaled) - scaled) < 1e-4) {
      return String(Math.round(scaled));
    }
    return Number(scaled.toFixed(2)).toString();
  };

  const [draft, setDraft] = useState<string>(() => formatDisplay(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setDraft(formatDisplay(value));
    }
  }, [value, mult, precision, focused]);

  const clampRaw = (raw: number): number => {
    if (Number.isNaN(raw) || !Number.isFinite(raw)) return value;
    return Math.max(min, Math.min(max, raw));
  };

  const handleTriggerReset = () => {
    if (disabled) return;
    if (onReset) {
      onReset();
    } else {
      const clamped = clampRaw(defaultValue);
      onChange(clamped);
      onCommit?.(clamped);
    }
    setDraft(formatDisplay(defaultValue));
  };

  const commitDraft = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      setDraft(formatDisplay(value));
      return;
    }
    const parsedDisplay = Number(trimmed);
    if (Number.isNaN(parsedDisplay) || !Number.isFinite(parsedDisplay)) {
      setDraft(formatDisplay(value));
      return;
    }
    const clampedDisplay = Math.max(displayMin, Math.min(displayMax, parsedDisplay));
    const nextRaw = clampRaw(clampedDisplay / mult);
    if (Math.abs(nextRaw - value) > 1e-6) {
      onChange(nextRaw);
    }
    onCommit?.(nextRaw);
    setDraft(formatDisplay(nextRaw));
  };

  const isAtDefault =
    Math.abs(value - defaultValue) <= Math.max(1e-4, step * 0.05) &&
    active !== true;

  if (orientation === "vertical") {
    return (
      <div className={`flex flex-col items-center gap-1.5 ${className}`}>
        {label && (
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
            {label}
          </span>
        )}
        <div className="flex items-center gap-1">
          <input
            type="number"
            aria-label={ariaLabel ? `${ariaLabel} value` : label ? `${label} value` : "Numeric value"}
            min={displayMin}
            max={displayMax}
            step={displayStep}
            disabled={disabled}
            value={draft}
            onFocus={() => setFocused(true)}
            onChange={(e) => {
              const nextStr = e.target.value;
              setDraft(nextStr);
              const parsed = Number(nextStr);
              if (nextStr.trim() !== "" && !Number.isNaN(parsed) && Number.isFinite(parsed)) {
                const clampedDisplay = Math.max(displayMin, Math.min(displayMax, parsed));
                onChange(clampRaw(clampedDisplay / mult));
              }
            }}
            onBlur={() => {
              setFocused(false);
              commitDraft(draft);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                setDraft(formatDisplay(value));
                e.currentTarget.blur();
              }
            }}
            className={`no-spinner w-12 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-center font-mono text-[10px] text-zinc-200 focus:border-amber-500 focus:outline-none ${inputClassName}`}
          />
          {unit && <span className="text-[9px] text-zinc-500">{unit}</span>}
          <button
            type="button"
            disabled={disabled}
            onClick={handleTriggerReset}
            title={effectiveResetTitle}
            aria-label={effectiveResetTitle}
            className={`rounded border border-zinc-800 p-0.5 transition ${
              isAtDefault
                ? "text-zinc-600 hover:border-zinc-700 hover:text-zinc-400"
                : "text-amber-400 hover:border-amber-500/60 hover:bg-amber-950/30"
            } disabled:opacity-40`}
          >
            <RotateCcw className="h-2.5 w-2.5" />
          </button>
        </div>

        <div
          className="relative flex flex-1 min-h-[120px] items-center justify-center w-8"
          onDoubleClick={handleTriggerReset}
          title="Drag to adjust, double-click or use reset button for default"
        >
          <input
            type="range"
            aria-label={ariaLabel ?? label ?? "Slider"}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            value={value}
            onChange={(e) => onChange(clampRaw(Number(e.target.value)))}
            onMouseUp={(e) =>
              onCommit?.(clampRaw(Number((e.target as HTMLInputElement).value)))
            }
            onTouchEnd={(e) =>
              onCommit?.(clampRaw(Number((e.target as HTMLInputElement).value)))
            }
            className={`w-28 -rotate-90 cursor-pointer accent-amber-500 ${sliderClassName}`}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      {label && (
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-zinc-400">
          {label}
        </span>
      )}
      <input
        type="range"
        aria-label={ariaLabel ?? label ?? "Slider"}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={value}
        onDoubleClick={handleTriggerReset}
        onChange={(e) => onChange(clampRaw(Number(e.target.value)))}
        onMouseUp={(e) =>
          onCommit?.(clampRaw(Number((e.target as HTMLInputElement).value)))
        }
        onTouchEnd={(e) =>
          onCommit?.(clampRaw(Number((e.target as HTMLInputElement).value)))
        }
        title="Drag to adjust, double-click to reset to default"
        className={`min-w-0 flex-1 accent-amber-500 ${sliderClassName}`}
      />
      <div className="flex shrink-0 items-center gap-0.5">
        <input
          type="number"
          aria-label={ariaLabel ? `${ariaLabel} value` : label ? `${label} value` : "Numeric value"}
          min={displayMin}
          max={displayMax}
          step={displayStep}
          disabled={disabled}
          value={draft}
          onFocus={() => setFocused(true)}
          onChange={(e) => {
            const nextStr = e.target.value;
            setDraft(nextStr);
            const parsed = Number(nextStr);
            if (nextStr.trim() !== "" && !Number.isNaN(parsed) && Number.isFinite(parsed)) {
              const clampedDisplay = Math.max(displayMin, Math.min(displayMax, parsed));
              onChange(clampRaw(clampedDisplay / mult));
            }
          }}
          onBlur={() => {
            setFocused(false);
            commitDraft(draft);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setDraft(formatDisplay(value));
              e.currentTarget.blur();
            }
          }}
          className={`no-spinner w-14 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right font-mono text-[11px] text-zinc-200 focus:border-amber-500 focus:outline-none ${inputClassName}`}
        />
        {unit && (
          <span className="text-[10px] font-mono text-zinc-400">{unit}</span>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={handleTriggerReset}
          title={effectiveResetTitle}
          aria-label={effectiveResetTitle}
          className={`rounded border border-zinc-800 p-1 transition ${
            isAtDefault
              ? "text-zinc-600 hover:border-zinc-700 hover:text-zinc-400"
              : "text-amber-400 hover:border-amber-500/60 hover:bg-amber-950/30"
          } disabled:opacity-40`}
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
};
