import { useTaktStore } from "../store/useTaktStore";

let activeDrag: {
  sceneId: string;
  sceneName: string;
  startX: number;
  startY: number;
  dragging: boolean;
  ghostEl: HTMLDivElement | null;
  prevUserSelect: string;
} | null = null;

function cleanupDrag() {
  if (activeDrag) {
    if (activeDrag.ghostEl) {
      activeDrag.ghostEl.remove();
    }
    document.body.style.userSelect = activeDrag.prevUserSelect;
  }
  activeDrag = null;
  useTaktStore.getState().setDraggingSceneId(null);
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("mousemove", onMove);
  window.removeEventListener("mouseup", onUp);
  window.removeEventListener("pointercancel", onCancel);
}

function onMove(e: MouseEvent | PointerEvent) {
  if (!activeDrag) return;
  const dist = Math.hypot(
    e.clientX - activeDrag.startX,
    e.clientY - activeDrag.startY,
  );
  if (!activeDrag.dragging && dist > 5) {
    activeDrag.dragging = true;
    useTaktStore.getState().setDraggingSceneId(activeDrag.sceneId);
    const ghost = document.createElement("div");
    ghost.textContent = `+ ${activeDrag.sceneName}`;
    ghost.style.position = "fixed";
    ghost.style.zIndex = "9999";
    ghost.style.pointerEvents = "none";
    ghost.style.padding = "4px 8px";
    ghost.style.borderRadius = "4px";
    ghost.style.background = "#1E293B";
    ghost.style.border = "1px solid #FF5500";
    ghost.style.color = "#F8FAFC";
    ghost.style.fontFamily = "monospace";
    ghost.style.fontSize = "11px";
    ghost.style.boxShadow = "0 8px 20px rgba(0,0,0,0.5)";
    document.body.appendChild(ghost);
    activeDrag.ghostEl = ghost;
  }
  if (activeDrag.dragging && activeDrag.ghostEl) {
    activeDrag.ghostEl.style.left = `${e.clientX + 12}px`;
    activeDrag.ghostEl.style.top = `${e.clientY + 12}px`;
  }
}

function onUp(e: MouseEvent | PointerEvent) {
  if (!activeDrag) return;
  const { sceneId, dragging } = activeDrag;
  cleanupDrag();
  if (!dragging) return;

  const els = document.elementsFromPoint(e.clientX, e.clientY);
  for (const el of els) {
    const laneId = el.getAttribute("data-track-lane-id");
    const testId = el.getAttribute("data-testid");
    if (laneId || testId === "timeline-new-track-dropzone") {
      el.dispatchEvent(
        new CustomEvent("takt:scene-drop", {
          bubbles: true,
          detail: {
            sceneId,
            trackId: laneId ?? "__new__",
            clientX: e.clientX,
          },
        }),
      );
      break;
    }
  }
}

function onCancel() {
  cleanupDrag();
}

export function startScenePointerDrag(
  sceneId: string,
  sceneName: string,
  clientX: number,
  clientY: number,
) {
  cleanupDrag();
  const prevUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";
  activeDrag = {
    sceneId,
    sceneName,
    startX: clientX,
    startY: clientY,
    dragging: false,
    ghostEl: null,
    prevUserSelect,
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("pointercancel", onCancel);
}
