import { HelpCircle } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface HelpTooltipProps {
  text: string;
  children?: ReactNode;
  showIcon?: boolean;
  className?: string;
  iconClassName?: string;
  testId?: string;
  delayMs?: number;
}

export function HelpTooltip({
  text,
  children,
  showIcon = false,
  className = "",
  iconClassName = "w-3 h-3 text-fog hover:text-ember shrink-0",
  testId,
  delayMs = 160,
}: HelpTooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{
    left: number;
    top: number;
    placement: "top" | "bottom";
  }>({ left: 0, top: 0, placement: "top" });

  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const tooltipId = useId();

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el || typeof window === "undefined") return;
    const rect = el.getBoundingClientRect();
    const maxW = 260;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 720;
    const centerX = rect.left + rect.width * 0.5;
    const clampedLeft = Math.max(
      8,
      Math.min(vw - maxW - 8, centerX - maxW * 0.5),
    );
    const showAbove = rect.top > 90 || rect.bottom + 90 > vh;
    setCoords({
      left: clampedLeft,
      top: showAbove ? Math.max(8, rect.top - 6) : Math.min(vh - 8, rect.bottom + 6),
      placement: showAbove ? "top" : "bottom",
    });
  }, []);

  const scheduleOpen = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    if (delayMs <= 0) {
      updatePosition();
      setOpen(true);
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      updatePosition();
      setOpen(true);
    }, delayMs);
  }, [delayMs, updatePosition]);

  const closeNow = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNow();
    };
    const onScroll = () => closeNow();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [closeNow, open]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  return (
    <span
      ref={triggerRef}
      data-testid={testId}
      aria-describedby={open ? tooltipId : undefined}
      onMouseEnter={scheduleOpen}
      onMouseLeave={closeNow}
      onFocus={() => {
        updatePosition();
        setOpen(true);
      }}
      onBlur={closeNow}
      className={`inline-flex items-center gap-1 ${className}`}
    >
      {children}
      {(showIcon || !children) && (
        <span
          tabIndex={!children ? 0 : undefined}
          aria-label={!children ? text : undefined}
          className="inline-flex items-center justify-center cursor-help focus:outline-none"
        >
          <HelpCircle className={iconClassName} />
        </span>
      )}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            style={{
              left: `${coords.left}px`,
              top: `${coords.top}px`,
              transform:
                coords.placement === "top"
                  ? "translateY(-100%)"
                  : "translateY(0)",
            }}
            className="pointer-events-none fixed z-[100] w-max max-w-[260px] rounded border border-steel bg-slate-dark px-2.5 py-1.5 font-sans text-[11px] leading-snug text-frost shadow-2xl"
          >
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
}
