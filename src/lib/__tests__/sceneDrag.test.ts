import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startScenePointerDrag } from "../sceneDrag";
import { useTaktStore } from "../../store/useTaktStore";

describe("sceneDrag", () => {
  const origElementsFromPoint = document.elementsFromPoint;

  beforeEach(() => {
    useTaktStore.getState().resetForTest();
    document.body.innerHTML = "";
    document.body.style.userSelect = "auto";
  });

  afterEach(() => {
    document.elementsFromPoint = origElementsFromPoint;
    window.dispatchEvent(new Event("pointercancel"));
    vi.restoreAllMocks();
  });

  it("ignores pointerup when movement stays within 5px drag threshold", () => {
    const spy = vi.fn();
    document.elementsFromPoint = spy;

    startScenePointerDrag("scn_1", "Warm Amber", 100, 100);
    expect(document.body.style.userSelect).toBe("none");

    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 102, clientY: 102 }));
    expect(useTaktStore.getState().draggingSceneId).toBeNull();

    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 102, clientY: 102 }));
    expect(spy).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe("auto");
  });

  it("dispatches takt:scene-sequence-drop with valid and omitted insertIndex", () => {
    const zone = document.createElement("div");
    zone.setAttribute("data-scene-sequence-dropzone", "true");
    zone.setAttribute("data-target-block-id", "blk_seq");
    zone.setAttribute("data-insert-index", "2");
    document.body.appendChild(zone);

    const received: Array<Record<string, unknown>> = [];
    zone.addEventListener("takt:scene-sequence-drop", (e) => {
      received.push((e as CustomEvent).detail);
    });
    document.elementsFromPoint = vi.fn(() => [zone]);

    startScenePointerDrag("scn_1", "Scene One", 10, 10);
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 40, clientY: 40 }));
    expect(useTaktStore.getState().draggingSceneId).toBe("scn_1");
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 40, clientY: 40 }));

    expect(received).toEqual([
      { sceneId: "scn_1", targetBlockId: "blk_seq", insertIndex: 2 },
    ]);
    expect(useTaktStore.getState().draggingSceneId).toBeNull();

    // Missing insertIndex -> undefined
    zone.removeAttribute("data-insert-index");
    zone.removeAttribute("data-target-block-id");
    startScenePointerDrag("scn_2", "Scene Two", 10, 10);
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 50, clientY: 50 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 50, clientY: 50 }));
    expect(received[1]).toEqual({
      sceneId: "scn_2",
      targetBlockId: "",
      insertIndex: undefined,
    });
  });

  it("dispatches takt:scene-drop for track lanes and new-track dropzone", () => {
    const lane = document.createElement("div");
    lane.setAttribute("data-track-lane-id", "trk_1");
    const newZone = document.createElement("div");
    newZone.setAttribute("data-testid", "timeline-new-track-dropzone");
    document.body.append(lane, newZone);

    const events: Array<Record<string, unknown>> = [];
    lane.addEventListener("takt:scene-drop", (e) => events.push((e as CustomEvent).detail));
    newZone.addEventListener("takt:scene-drop", (e) => events.push((e as CustomEvent).detail));

    document.elementsFromPoint = vi.fn(() => [lane]);
    startScenePointerDrag("scn_1", "Scene One", 0, 0);
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 25, clientY: 25 }));
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 120, clientY: 25 }));

    document.elementsFromPoint = vi.fn(() => [newZone]);
    startScenePointerDrag("scn_2", "Scene Two", 0, 0);
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 30 }));
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 200, clientY: 30 }));

    expect(events).toEqual([
      { sceneId: "scn_1", trackId: "trk_1", clientX: 120 },
      { sceneId: "scn_2", trackId: "__new__", clientX: 200 },
    ]);
  });

  it("dispatches takt:scene-bank-drop and cleans up on pointercancel", () => {
    const bank = document.createElement("div");
    bank.setAttribute("data-bank-drop-target", "Bank 2");
    document.body.appendChild(bank);

    const bankEvents: Array<Record<string, unknown>> = [];
    bank.addEventListener("takt:scene-bank-drop", (e) =>
      bankEvents.push((e as CustomEvent).detail),
    );
    document.elementsFromPoint = vi.fn(() => [bank]);

    startScenePointerDrag("scn_9", "Strobe", 5, 5);
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 35, clientY: 35 }));
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 35, clientY: 35 }));
    expect(bankEvents).toEqual([{ sceneId: "scn_9", targetBank: "Bank 2" }]);

    // pointercancel removes ghost and restores userSelect
    startScenePointerDrag("scn_9", "Strobe", 5, 5);
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 35, clientY: 35 }));
    expect(useTaktStore.getState().draggingSceneId).toBe("scn_9");
    window.dispatchEvent(new Event("pointercancel"));
    expect(useTaktStore.getState().draggingSceneId).toBeNull();
    expect(document.body.style.userSelect).toBe("auto");
  });
});
