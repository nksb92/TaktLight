import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function formatTodayCalVer(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return `${year}.${month}.${day}`;
}

function validateVersion(version) {
  // SemVer without leading zeros on numeric identifiers (required by Cargo, npm, Tauri, and Windows NSIS)
  const re = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
  if (!re.test(version)) {
    throw new Error(
      `Invalid version "${version}". Expected YYYY.M.D (no leading zeros, e.g. 2026.11.25).`,
    );
  }
  const [major, minor, patch] = version.split("-")[0].split(".").map(Number);
  if (major > 65535 || minor > 65535 || patch > 65535) {
    throw new Error(
      `Version components must be <= 65535 for Windows installers: "${version}"`,
    );
  }
}

function updateJsonVersion(filePath, version, updateLockRoot = false) {
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  let changed = false;

  if (parsed.version !== version) {
    parsed.version = version;
    changed = true;
  }
  if (
    updateLockRoot &&
    parsed.packages &&
    parsed.packages[""] &&
    parsed.packages[""].version !== version
  ) {
    parsed.packages[""].version = version;
    changed = true;
  }

  if (changed) {
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const serialized = JSON.stringify(parsed, null, 2).replace(/\n/g, eol) + eol;
    fs.writeFileSync(filePath, serialized, "utf8");
  }
  return changed;
}

function updateCargoWorkspaceVersion(filePath, version) {
  const raw = fs.readFileSync(filePath, "utf8");
  const next = raw.replace(
    /(\[workspace\.package\][\s\S]*?\r?\nversion\s*=\s*")([^"]+)(")/,
    `$1${version}$3`,
  );
  if (next === raw) {
    const check = /\[workspace\.package\][\s\S]*?\r?\nversion\s*=\s*"([^"]+)"/.exec(raw);
    if (!check || check[1] !== version) {
      throw new Error(`Could not locate [workspace.package] version in ${filePath}`);
    }
    return false;
  }
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

const explicitArg = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const version = explicitArg ? explicitArg.trim() : formatTodayCalVer();
validateVersion(version);

const targets = [
  {
    label: "Cargo.toml",
    changed: updateCargoWorkspaceVersion(path.join(rootDir, "Cargo.toml"), version),
  },
  {
    label: "package.json",
    changed: updateJsonVersion(path.join(rootDir, "package.json"), version),
  },
  {
    label: "package-lock.json",
    changed: updateJsonVersion(path.join(rootDir, "package-lock.json"), version, true),
  },
  {
    label: "src-tauri/tauri.conf.json",
    changed: updateJsonVersion(
      path.join(rootDir, "src-tauri", "tauri.conf.json"),
      version,
    ),
  },
];

const updated = targets.filter((t) => t.changed).map((t) => t.label);
if (updated.length > 0) {
  console.log(`[sync-version] Version set to ${version} (updated: ${updated.join(", ")})`);
} else {
  console.log(`[sync-version] Version already synced at ${version}`);
}
