import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

interface SplitHandleProps {
  orientation: "horizontal" | "vertical";
  onDragDelta: (deltaPx: number) => void;
  onDoubleClick?: () => void;
  ariaLabel?: string;
  testId?: string;
  className?: string;
}

export function SplitHandle({
  orientation,
  onDragDelta,
  onDoubleClick,
  ariaLabel,
  testId,
  className = "",
}: SplitHandleProps) {
  const [dragging, setDragging] = useState(false);
  const lastPosRef = useRef<number | null>(null);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: PointerEvent) => {
      const current = orientation === "horizontal" ? e.clientY : e.clientX;
      if (!Number.isFinite(current)) return;
      if (lastPosRef.current !== null) {
        const delta = current - lastPosRef.current;
        if (delta !== 0) {
          onDragDelta(delta);
        }
      }
      lastPosRef.current = current;
    };

    const onUp = () => {
      lastPosRef.current = null;
      setDragging(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, onDragDelta, orientation]);

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const initial = orientation === "horizontal" ? e.clientY : e.clientX;
    lastPosRef.current = Number.isFinite(initial) ? initial : null;
    setDragging(true);
  };

  const isHorizontal = orientation === "horizontal";

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={
        ariaLabel ??
        (isHorizontal ? "Resize top and bottom panes" : "Resize left and right panes")
      }
      data-testid={testId}
      onPointerDown={handlePointerDown}
      onDoubleClick={onDoubleClick}
      title="Drag to resize • Double-click to reset"
      className={`group shrink-0 select-none flex items-center justify-center transition-colors ${
        isHorizontal
          ? "h-1.5 w-full cursor-row-resize hover:bg-ember/20"
          : "w-1.5 h-full cursor-col-resize hover:bg-ember/20"
      } ${dragging ? "bg-ember/30" : ""} ${className}`}
    >
      <div
        className={`rounded-full transition-colors ${
          isHorizontal ? "w-10 h-0.5" : "h-10 w-0.5"
        } ${dragging ? "bg-ember" : "bg-steel group-hover:bg-ember"}`}
      />
    </div>
  );
}
