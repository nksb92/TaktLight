import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../../../package.json";
import { TopStatusBar } from "../../components/TopStatusBar";
import { useTaktStore } from "../../store/useTaktStore";
import {
  formatErrorMessage,
  installGlobalErrorHandlers,
  reportError,
} from "../errorReporting";

describe("Error handling & diagnostics hardening", () => {
  beforeEach(() => {
    useTaktStore.getState().resetForTest();
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it("formats Error instances, strings, and plain error objects cleanly", () => {
    expect(formatErrorMessage(new Error("Socket bound"))).toBe("Socket bound");
    expect(formatErrorMessage("  disk full  ")).toBe("disk full");
    expect(formatErrorMessage({ message: "IPC rejected" })).toBe("IPC rejected");
  });

  it("reports frontend errors to console, notify callback, and backend log_frontend_error", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const invokeMock = vi.fn().mockResolvedValue(undefined);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: invokeMock,
    };

    const notified: string[] = [];
    const msg = reportError("Patch failed", new Error("Universe collision"), {
      notify: (m) => notified.push(m),
    });

    expect(msg).toBe("Patch failed: Universe collision");
    expect(notified).toEqual(["Patch failed: Universe collision"]);
    expect(consoleSpy).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith(
      "log_frontend_error",
      { level: "error", message: "Patch failed: Universe collision" },
      undefined,
    );
  });

  it("installs global error handlers that surface window errors and throttle duplicate spam", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notified: string[] = [];
    const cleanup = installGlobalErrorHandlers((msg) => notified.push(msg));

    window.dispatchEvent(
      new ErrorEvent("error", { message: "Background worker crashed" }),
    );
    window.dispatchEvent(
      new ErrorEvent("error", { message: "Background worker crashed" }),
    );

    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("Background worker crashed");

    cleanup();
    consoleSpy.mockRestore();
  });

  it("surfaces Tauri IPC mutation errors via patchToast instead of rejecting uncaught", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const invokeMock = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "log_frontend_error") return Promise.resolve();
      return Promise.reject("No free DMX slots in universe");
    });
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: invokeMock,
    };

    await expect(
      useTaktStore
        .getState()
        .patchFixtures("user/test.json", "4ch", "Par", 1, 1, 510),
    ).resolves.toBeUndefined();

    expect(useTaktStore.getState().patchToast).toContain(
      "No free DMX slots in universe",
    );
    consoleSpy.mockRestore();
  });

  it("displays NET ERR status badge in TopStatusBar when offline with a network error", () => {
    useTaktStore.setState({
      outputEnabled: true,
      isOffline: true,
      lastNetworkError: "Failed to bind eth0: permission denied",
    });

    render(<TopStatusBar />);
    expect(screen.getByTestId("network-status-badge")).toHaveTextContent(
      "NET ERR",
    );
    expect(screen.getByTestId("app-version-badge")).toHaveTextContent(
      `v${pkg.version}`,
    );
  });
});
