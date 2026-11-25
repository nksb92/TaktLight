import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { ErrorBoundary } from "../ErrorBoundary";
import { tryDecodeWavBytes } from "../../lib/audioEngine";
import { useTaktStore } from "../../store/useTaktStore";
import { seedTestFixturesInStore, TEST_TUBE_8SEG_ID } from "../../test/testFixtures";

function build24BitMonoWav(sampleRate: number, samples: number[]): Uint8Array {
  const dataSize = samples.length * 3;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i);
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 3, true);
  view.setUint16(32, 3, true);
  view.setUint16(34, 24, true); // 24-bit
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(0.999999, samples[i]));
    let intVal = Math.round(clamped * 8388608);
    if (intVal < 0) intVal += 16777216;
    const off = 44 + i * 3;
    u8[off] = intVal & 0xff;
    u8[off + 1] = (intVal >> 8) & 0xff;
    u8[off + 2] = (intVal >> 16) & 0xff;
  }
  return u8;
}

describe("Platform & Studio Improvements", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
    seedTestFixturesInStore();
  });

  it("decodes 24-bit PCM WAV buffers accurately", () => {
    const wav = build24BitMonoWav(48000, [0, 0.5, -0.5, 0.25]);
    const decoded = tryDecodeWavBytes(wav);
    expect(decoded).not.toBeNull();
    expect(decoded!.sampleRate).toBe(48000);
    expect(decoded!.monoPcm.length).toBe(4);
    expect(decoded!.monoPcm[1]).toBeCloseTo(0.5, 3);
    expect(decoded!.monoPcm[2]).toBeCloseTo(-0.5, 3);
  });

  it("persists keyBindings and groupMixerStrips through .takt.xml export and import", async () => {
    const store = useTaktStore.getState();
    store.bindKeyToTarget("sc_new_1", "K");
    store.updateGroupMixerStrip("all", { dimmer: 0.65, hueShiftDeg: 45 });

    const xml = await store.exportShowXml();
    expect(xml).toContain("<KeyBindings>");
    expect(xml).toContain('target="sc_new_1" key="K"');
    expect(xml).toContain("<GroupMixerStrips>");
    expect(xml).toContain('group="all"');

    store.resetForTest();
    await useTaktStore.getState().importShowXml(xml);
    const reloaded = useTaktStore.getState();
    expect(reloaded.keyBindings.sc_new_1).toBe("K");
    expect(reloaded.groupMixerStrips.all?.dimmer).toBeCloseTo(0.65, 2);
    expect(reloaded.groupMixerStrips.all?.hueShiftDeg).toBe(45);
  });

  it("toggles Locate/Identify fixture from PatchView and displays fixture ownership in DmxMonitor", async () => {
    await useTaktStore
      .getState()
      .patchFixtures(TEST_TUBE_8SEG_ID, "34ch Pixel Mode", "TestTube", 1, 1, 1);
    const fx = useTaktStore.getState().showState.patch[0];
    expect(fx).toBeDefined();

    render(<App />);
    const locateBtn = screen.getByTestId(`locate-fixture-${fx.id}`);
    fireEvent.click(locateBtn);
    expect(useTaktStore.getState().identifiedFixtureId).toBe(fx.id);
    // Master dimmer channel U1.001 should be driven high while locating
    expect(useTaktStore.getState().dmxByUniverse[1][0]).toBeGreaterThan(200);

    // Toggle off
    fireEvent.click(locateBtn);
    expect(useTaktStore.getState().identifiedFixtureId).toBeNull();

    // Switch to Monitor and select U1.001 -> shows fixture ownership
    useTaktStore.getState().setActiveTab("monitor");
    const ch1 = await screen.findByTestId("dmx-cell-1");
    fireEvent.click(ch1);
    const ownerBadge = await screen.findByTestId("dmx-channel-owner-badge");
    expect(ownerBadge.textContent).toContain("TestTube");
  });

  it("renders autosave recovery banner, supports File menu Autosave ON/OFF toggle, and clears recovery when disabled", () => {
    useTaktStore.setState({ hasAutosaveRecovery: true, autosaveEnabled: true });
    render(<App />);
    expect(screen.getByTestId("autosave-recovery-banner")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("menu-file-btn"));
    const toggle = screen.getByTestId("menu-file-autosave-toggle");
    expect(toggle.textContent).toContain("ON");
    fireEvent.click(toggle);

    expect(useTaktStore.getState().autosaveEnabled).toBe(false);
    expect(useTaktStore.getState().hasAutosaveRecovery).toBe(false);
    expect(screen.queryByTestId("autosave-recovery-banner")).not.toBeInTheDocument();
  });

  it("auto-fits all fixtures on project startup in 2D view and provides a Fit All button", async () => {
    const store = useTaktStore.getState();
    await store.patchFixtures(
      TEST_TUBE_8SEG_ID,
      "34ch Pixel Mode",
      "WideTube",
      2,
      1,
      1,
    );
    const [fx1, fx2] = useTaktStore.getState().showState.patch;
    await useTaktStore
      .getState()
      .updateFixtureGridPos(fx1.id, { ...fx1.grid_pos, x: -1.5, y: -1.0 });
    await useTaktStore
      .getState()
      .updateFixtureGridPos(fx2.id, { ...fx2.grid_pos, x: 2.5, y: 2.0 });

    useTaktStore.getState().setActiveTab("studio");
    render(<App />);

    // Startup auto-fit zooms out below 100% so both widely spaced fixtures fit in view
    const zoomReadout = screen.getByTestId("grid-zoom-value");
    const startupZoomPct = Number(zoomReadout.textContent?.replace("%", "") ?? "100");
    expect(startupZoomPct).toBeLessThan(100);

    // Manually reset zoom to 100%, then click Fit All to re-frame all fixtures
    fireEvent.click(screen.getByTestId("grid-zoom-reset"));
    expect(screen.getByTestId("grid-zoom-value").textContent).toBe("100%");

    fireEvent.click(screen.getByTestId("grid-fit-all-btn"));
    const fittedZoomPct = Number(
      screen.getByTestId("grid-zoom-value").textContent?.replace("%", "") ?? "100",
    );
    expect(fittedZoomPct).toBeLessThan(100);
  });

  it("shows an empty-fixtures onboarding banner on PatchView with a direct Fixtures tab shortcut", () => {
    useTaktStore.getState().resetForTest();
    useTaktStore.setState({ fixtureSummaries: [], fixtureDetailsCache: {}, selectedFixtureId: null });
    render(<App />);

    expect(screen.getByTestId("empty-fixtures-onboarding-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("go-to-fixtures-btn"));
    expect(useTaktStore.getState().activeTab).toBe("fixtures");
  });

  it("catches unhandled UI errors in ErrorBoundary and renders recovery screen", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Bomb(): never {
      throw new Error("Simulated render crash");
    }

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId("error-boundary-fallback")).toBeInTheDocument();
    expect(screen.getByText(/Simulated render crash/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reload Application/i })).toBeInTheDocument();
    consoleSpy.mockRestore();
  });
});
