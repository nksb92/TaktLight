import { ChangeEvent, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileAudio, FolderOpen } from "lucide-react";
import { isTauriEnvironment, useTaktStore } from "../store/useTaktStore";

export function MissingAudioModal() {
  const missingAudioFiles = useTaktStore((s) => s.missingAudioFiles);
  const missingAudioModalOpen = useTaktStore((s) => s.missingAudioModalOpen);
  const relinkMissingAudioWithFile = useTaktStore(
    (s) => s.relinkMissingAudioWithFile,
  );
  const relinkMissingAudioWithPath = useTaktStore(
    (s) => s.relinkMissingAudioWithPath,
  );
  const relinkMissingAudioFromFolderFiles = useTaktStore(
    (s) => s.relinkMissingAudioFromFolderFiles,
  );
  const relinkMissingAudioFromFolderPath = useTaktStore(
    (s) => s.relinkMissingAudioFromFolderPath,
  );
  const pickNativeAudioFolder = useTaktStore((s) => s.pickNativeAudioFolder);
  const pickNativeAudioFile = useTaktStore((s) => s.pickNativeAudioFile);
  const dismissMissingAudioModal = useTaktStore(
    (s) => s.dismissMissingAudioModal,
  );

  const [folderPathInput, setFolderPathInput] = useState("");
  const [individualPaths, setIndividualPaths] = useState<Record<string, string>>(
    {},
  );
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const folderInputRef = useRef<HTMLInputElement | null>(null);

  if (!missingAudioModalOpen || missingAudioFiles.length === 0) {
    return null;
  }

  const remainingCount = missingAudioFiles.filter((f) => !f.resolved).length;
  const inTauri = isTauriEnvironment();

  const handleFolderPickerChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    setStatusMessage(null);
    try {
      const matched = await relinkMissingAudioFromFolderFiles(files);
      setStatusMessage(
        matched > 0
          ? `Relinked ${matched} audio file${matched === 1 ? "" : "s"} from folder.`
          : "No matching audio files found in selected folder.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleNativeSelectFolder = async () => {
    setBusy(true);
    setStatusMessage(null);
    try {
      const picked = await pickNativeAudioFolder("Select Music Folder");
      if (!picked) return;
      setFolderPathInput(picked);
      const res = await relinkMissingAudioFromFolderPath(picked);
      setStatusMessage(
        res.matched > 0
          ? `${res.message} Save the project to keep the updated path.`
          : res.message,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleNativeSelectFile = async (
    originalKey: string,
    baseName: string,
  ) => {
    setBusy(true);
    setStatusMessage(null);
    try {
      const picked = await pickNativeAudioFile(`Select ${baseName}`);
      if (!picked) return;
      setIndividualPaths((prev) => ({ ...prev, [originalKey]: picked }));
      const res = await relinkMissingAudioWithPath(originalKey, picked);
      setStatusMessage(
        res.ok
          ? `${res.message} Save the project to keep the updated path.`
          : res.message,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleScanFolderPath = async () => {
    const trimmed = folderPathInput.trim();
    if (!trimmed) return;
    setBusy(true);
    setStatusMessage(null);
    try {
      const res = await relinkMissingAudioFromFolderPath(trimmed);
      setStatusMessage(
        res.matched > 0
          ? `${res.message} Save the project to keep the updated path.`
          : res.message,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleIndividualFileChange = async (
    originalKey: string,
    e: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setStatusMessage(null);
    try {
      await relinkMissingAudioWithFile(originalKey, file);
      setStatusMessage(`Relinked ${file.name}.`);
    } finally {
      setBusy(false);
    }
  };

  const handleIndividualPathApply = async (originalKey: string) => {
    const path = (individualPaths[originalKey] ?? "").trim();
    if (!path) return;
    setBusy(true);
    setStatusMessage(null);
    try {
      const res = await relinkMissingAudioWithPath(originalKey, path);
      setStatusMessage(res.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Missing Timeline Audio Files"
      data-testid="missing-audio-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="w-full max-w-2xl rounded-panel border border-steel bg-slate-dark p-4 shadow-2xl flex flex-col gap-3 max-h-[85vh]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-ember shrink-0" />
            <h2 className="font-sans text-sm font-semibold text-frost">
              Missing Timeline Audio Files ({remainingCount} missing)
            </h2>
          </div>
          <span className="font-mono text-[10px] text-fog uppercase">
            Relink Required
          </span>
        </div>

        <p className="text-xs text-mist leading-relaxed">
          One or more music files referenced by timelines in this project could
          not be found at their saved paths. Select a folder to relink matching
          files automatically, or set individual file paths below.
        </p>

        {/* Folder Relink Bar */}
        <div className="bg-pitch border border-steel rounded-md p-2.5 flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase text-fog">
              Relink by Folder
            </span>
            <div>
              {!inTauri && (
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  aria-label="Browse Audio Folder"
                  data-testid="relink-folder-file-input"
                  // @ts-expect-error webkitdirectory is supported in Chromium/WebView2
                  webkitdirectory=""
                  onChange={(e) => {
                    void handleFolderPickerChange(e);
                  }}
                  className="hidden"
                />
              )}
              <button
                type="button"
                disabled={busy}
                data-testid="relink-browse-folder-btn"
                onClick={() => {
                  if (inTauri) {
                    void handleNativeSelectFolder();
                  } else {
                    folderInputRef.current?.click();
                  }
                }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-ember hover:bg-burnt disabled:opacity-50 text-frost font-mono text-xs font-semibold transition-colors"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>Select Folder…</span>
              </button>
            </div>
          </div>

          {inTauri && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                aria-label="Audio Folder Path"
                placeholder="C:\Music\ShowTracks"
                value={folderPathInput}
                onChange={(e) => setFolderPathInput(e.target.value)}
                className="flex-1 bg-ink border border-steel rounded px-2 py-1 font-mono text-xs text-mist focus:outline-none focus:border-ember"
              />
              <button
                type="button"
                disabled={busy || !folderPathInput.trim()}
                data-testid="relink-scan-folder-path-btn"
                onClick={() => {
                  void handleScanFolderPath();
                }}
                className="px-2.5 py-1 rounded bg-ink border border-steel hover:border-ember disabled:opacity-50 font-mono text-xs text-frost transition-colors"
              >
                Scan Folder Path
              </button>
            </div>
          )}
        </div>

        {/* Individual Missing Files List */}
        <div className="flex flex-col gap-2 overflow-y-auto pr-1">
          {missingAudioFiles.map((entry) => (
            <div
              key={entry.originalKey}
              data-testid={`missing-audio-row-${entry.baseName}`}
              className={`rounded-md border p-2.5 flex flex-col gap-2 bg-pitch ${
                entry.resolved ? "border-pine/70" : "border-steel"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {entry.resolved ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-pine shrink-0" />
                    ) : (
                      <FileAudio className="w-3.5 h-3.5 text-ember shrink-0" />
                    )}
                    <span className="font-mono text-xs text-frost truncate">
                      {entry.baseName}
                    </span>
                  </div>
                  <div className="font-mono text-[10px] text-fog truncate mt-0.5">
                    {entry.resolved
                      ? `Linked: ${entry.resolvedPath ?? entry.baseName}`
                      : `Missing: ${entry.originalKey}`}
                  </div>
                </div>

                {inTauri ? (
                  <button
                    type="button"
                    disabled={busy}
                    data-testid={`relink-native-file-btn-${entry.baseName}`}
                    onClick={() => {
                      void handleNativeSelectFile(
                        entry.originalKey,
                        entry.baseName,
                      );
                    }}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded bg-ink border border-steel hover:border-ember disabled:opacity-50 font-mono text-[11px] text-mist transition-colors"
                  >
                    Select File…
                  </button>
                ) : (
                  <label className="shrink-0 cursor-pointer">
                    <input
                      type="file"
                      accept="audio/*"
                      aria-label={`Browse file for ${entry.baseName}`}
                      data-testid={`relink-file-input-${entry.baseName}`}
                      onChange={(e) => {
                        void handleIndividualFileChange(entry.originalKey, e);
                      }}
                      className="hidden"
                    />
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-ink border border-steel hover:border-ember font-mono text-[11px] text-mist transition-colors">
                      Select File…
                    </span>
                  </label>
                )}
              </div>

              {inTauri && !entry.resolved && (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    aria-label={`File path for ${entry.baseName}`}
                    placeholder={`Full path to ${entry.baseName}`}
                    value={individualPaths[entry.originalKey] ?? ""}
                    onChange={(e) =>
                      setIndividualPaths((prev) => ({
                        ...prev,
                        [entry.originalKey]: e.target.value,
                      }))
                    }
                    className="flex-1 bg-ink border border-steel rounded px-2 py-1 font-mono text-[11px] text-mist focus:outline-none focus:border-ember"
                  />
                  <button
                    type="button"
                    disabled={
                      busy || !(individualPaths[entry.originalKey] ?? "").trim()
                    }
                    onClick={() => {
                      void handleIndividualPathApply(entry.originalKey);
                    }}
                    className="px-2 py-1 rounded bg-ink border border-steel hover:border-ember disabled:opacity-50 font-mono text-[11px] text-frost"
                  >
                    Set Path
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {statusMessage && (
          <div
            data-testid="missing-audio-status"
            className="font-mono text-[11px] text-mist bg-ink border border-steel/70 rounded px-2.5 py-1.5"
          >
            {statusMessage}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1 border-t border-steel/50">
          <button
            type="button"
            data-testid="missing-audio-dismiss-btn"
            onClick={dismissMissingAudioModal}
            className={`px-3 py-1.5 rounded font-mono text-xs transition-colors ${
              remainingCount === 0
                ? "bg-pine/80 hover:bg-pine text-frost font-semibold"
                : "border border-steel bg-ink text-mist hover:border-fog"
            }`}
          >
            {remainingCount === 0 ? "Done" : "Continue Without Missing Audio"}
          </button>
        </div>
      </div>
    </div>
  );
}
