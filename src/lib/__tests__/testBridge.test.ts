import { beforeEach, describe, expect, it } from "vitest";
import { useTaktStore } from "../../store/useTaktStore";
import { installTestBridge, registerCanvasGeometry } from "../testBridge";

describe("testBridge", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
    registerCanvasGeometry(null);
  });

  it("installs window.__TAKTLIGHT_TEST__ and exposes status and DMX helpers", async () => {
    const bridge = installTestBridge();
    expect(bridge).not.toBeNull();
    expect(window.__TAKTLIGHT_TEST__).toBe(bridge);

    const status = bridge!.getStatus();
    expect(status.connectedMode).toBe("simulation");
    expect(status.isTauri).toBe(false);
    expect(status.blackout).toBe(false);
    expect(status.grandMaster).toBe(1);

    await useTaktStore.getState().setChannelPark(1, 5, 180);
    expect(bridge!.getDmxSlice(1, 4, 3)).toEqual([
      { ch: 4, val: 0 },
      { ch: 5, val: 180 },
      { ch: 6, val: 0 },
    ]);
    expect(bridge!.getNonZeroDmx(1)).toEqual([{ ch: 5, val: 180 }]);
  });

  it("returns registered canvas geometry snapshot", () => {
    const bridge = installTestBridge()!;
    expect(bridge.getCanvasGeometry()).toBeNull();

    registerCanvasGeometry(() => ({
      canvasRect: { left: 10, top: 20, width: 840, height: 480 },
      zoom: 1,
      pan: { x: 0, y: 0 },
      fixtures: [
        {
          id: "fx_001",
          name: "Tube 1",
          gridX: 0.25,
          gridY: 0.15,
          rotation: 0,
          clientX: 200,
          clientY: 120,
          rotationHandleX: 245,
          rotationHandleY: 120,
        },
      ],
      shaderGizmo: null,
    }));

    const geom = bridge.getCanvasGeometry();
    expect(geom?.fixtures).toHaveLength(1);
    expect(geom?.fixtures[0].id).toBe("fx_001");
  });
});
