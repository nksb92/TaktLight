import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const usePrebuilt = args.has("--prebuilt");
const cdpPort = Number(process.env.TAKTLIGHT_CDP_PORT ?? "9222");
const vitePort = Number(process.env.TAKTLIGHT_VITE_PORT ?? "5173");
const viteUrl = `http://127.0.0.1:${vitePort}`;
const cdpUrl = `http://127.0.0.1:${cdpPort}`;

async function isHttpReachable(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHttp(url, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isHttpReachable(url)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label} at ${url}`);
}

const children = [];

function shutdown(exitCode = 0) {
  for (const child of children) {
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore cleanup errors
      }
    }
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main() {
  let viteAlreadyRunning = await isHttpReachable(viteUrl);
  if (!viteAlreadyRunning) {
    console.log(`[launch-tauri-cdp] Starting Vite dev server on ${viteUrl}...`);
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const viteChild = spawn(npmCmd, ["run", "dev", "--", "--port", String(vitePort)], {
      cwd: projectRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    children.push(viteChild);
    viteChild.on("exit", (code) => {
      if (code && code !== 0) {
        console.error(`[launch-tauri-cdp] Vite exited with code ${code}`);
        shutdown(code);
      }
    });
    await waitForHttp(viteUrl, 30_000, "Vite dev server");
  } else {
    console.log(`[launch-tauri-cdp] Reusing existing Vite server at ${viteUrl}`);
  }

  const extraWebviewArgs = [
    process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? "",
    `--remote-debugging-port=${cdpPort}`,
  ]
    .filter(Boolean)
    .join(" ");

  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: extraWebviewArgs,
  };

  const prebuiltExe = path.join(
    projectRoot,
    "target",
    "debug",
    process.platform === "win32" ? "taktlight-app.exe" : "taktlight-app",
  );

  let tauriChild;
  if (usePrebuilt && fs.existsSync(prebuiltExe)) {
    console.log(`[launch-tauri-cdp] Launching prebuilt binary: ${prebuiltExe}`);
    tauriChild = spawn(prebuiltExe, [], {
      cwd: projectRoot,
      env,
      stdio: "inherit",
    });
  } else {
    if (usePrebuilt) {
      console.log(
        `[launch-tauri-cdp] Prebuilt binary not found at ${prebuiltExe}; falling back to cargo run.`,
      );
    }
    console.log(`[launch-tauri-cdp] Launching Tauri via cargo run -p taktlight-app...`);
    tauriChild = spawn("cargo", ["run", "-p", "taktlight-app"], {
      cwd: projectRoot,
      env,
      stdio: "inherit",
    });
  }

  children.push(tauriChild);
  tauriChild.on("exit", (code) => {
    console.log(`[launch-tauri-cdp] TaktLight exited with code ${code ?? 0}`);
    shutdown(code ?? 0);
  });

  await waitForHttp(`${cdpUrl}/json/version`, 180_000, "WebView2 CDP endpoint");
  console.log(`TAKTLIGHT_CDP_READY ${cdpUrl}`);
}

main().catch((err) => {
  console.error(`[launch-tauri-cdp] Error: ${err.message}`);
  shutdown(1);
});
