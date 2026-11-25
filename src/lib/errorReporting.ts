import { invoke } from "@tauri-apps/api/core";

export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || "Unknown error";
  }
  if (typeof err === "string") {
    return err.trim() || "Unknown error";
  }
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) {
      return msg.trim();
    }
  }
  try {
    return JSON.stringify(err) || "Unknown error";
  } catch {
    return String(err);
  }
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export function logToBackend(level: "info" | "warn" | "error", message: string): void {
  if (!isTauriRuntime()) return;
  try {
    void invoke("log_frontend_error", { level, message }).catch(() => undefined);
  } catch {
    // Never let diagnostic logging throw
  }
}

export function reportError(
  context: string,
  err: unknown,
  options?: {
    notify?: (message: string) => void;
    level?: "error" | "warn";
  },
): string {
  const detail = formatErrorMessage(err);
  const full = `${context}: ${detail}`;
  const level = options?.level ?? "error";

  if (level === "warn") {
    console.warn(`[TaktLight] ${full}`);
  } else {
    console.error(`[TaktLight] ${full}`);
  }

  logToBackend(level, full);
  options?.notify?.(full);
  return full;
}

export function installGlobalErrorHandlers(
  onNotify: (message: string) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  let lastNotifiedMsg = "";
  let lastNotifiedAt = 0;

  const notifyThrottled = (msg: string) => {
    const now = Date.now();
    if (msg === lastNotifiedMsg && now - lastNotifiedAt < 3000) {
      return;
    }
    lastNotifiedMsg = msg;
    lastNotifiedAt = now;
    onNotify(msg);
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    event.preventDefault();
    reportError("Unexpected async error", event.reason, {
      notify: notifyThrottled,
    });
  };

  const onWindowError = (event: ErrorEvent) => {
    const reason = event.error ?? event.message ?? "Unhandled runtime error";
    reportError("Unhandled error", reason, {
      notify: notifyThrottled,
    });
  };

  window.addEventListener("unhandledrejection", onUnhandledRejection);
  window.addEventListener("error", onWindowError);

  return () => {
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    window.removeEventListener("error", onWindowError);
  };
}
