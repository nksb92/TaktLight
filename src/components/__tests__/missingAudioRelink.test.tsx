import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { MissingAudioModal } from "../MissingAudioModal";
import {
  clearAudioAssetRegistry,
  getDecodedAudioAsset,
} from "../../lib/audioEngine";
import { useTaktStore } from "../../store/useTaktStore";

const SHOW_WITH_TWO_AUDIO_CLIPS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<TaktLightShow version="1.0">
  <Meta name="Audio Relink Test" bpm="120" />
  <NetworkOutputs artsync="true">
    <Universe id="1" protocol="artnet" mode="broadcast" net="0" subnet="0" uni="0" />
  </NetworkOutputs>
  <Patch />
  <Palettes />
  <Groups />
  <FxLibrary />
  <Scenes />
  <Timelines>
    <Timeline id="tl_music" name="Music Timeline" duration_sec="30" grid_offset_sec="0" loop_timeline="false">
      <TempoMap>
        <TempoPoint at_sec="0" bpm="120" />
      </TempoMap>
      <Track id="trk_music" name="Music 1" track_type="music">
        <Clip start_sec="0" duration_sec="10" fade_in_sec="0" fade_out_sec="0" audio_file="C:\\OldFolder\\intro.wav" source_duration_sec="10" />
        <Clip start_sec="12" duration_sec="10" fade_in_sec="0" fade_out_sec="0" audio_file="C:\\OldFolder\\drop.wav" source_duration_sec="10" />
      </Track>
    </Timeline>
  </Timelines>
</TaktLightShow>`;

describe("Missing Timeline Audio Relink Modal", () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    clearAudioAssetRegistry();
    useTaktStore.getState().resetForTest();
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it("prompts on project load when music files are missing and supports folder + individual relink", async () => {
    render(<App />);

    await act(async () => {
      await useTaktStore.getState().importShowXml(SHOW_WITH_TWO_AUDIO_CLIPS_XML);
    });

    expect(screen.getByTestId("missing-audio-modal")).toBeInTheDocument();
    expect(screen.getByText(/2 missing/i)).toBeInTheDocument();
    expect(screen.getByTestId("missing-audio-row-intro.wav")).toBeInTheDocument();
    expect(screen.getByTestId("missing-audio-row-drop.wav")).toBeInTheDocument();

    // 1. Relink intro.wav via folder picker
    const folderInput = screen.getByTestId("relink-folder-file-input");
    const introFile = new File([new Uint8Array(128)], "intro.wav", {
      type: "audio/wav",
    });
    const unrelatedFile = new File([new Uint8Array(64)], "other.wav", {
      type: "audio/wav",
    });
    await act(async () => {
      fireEvent.change(folderInput, {
        target: { files: [introFile, unrelatedFile] },
      });
    });

    await waitFor(() => {
      expect(getDecodedAudioAsset("C:\\OldFolder\\intro.wav")).toBeDefined();
    });
    expect(screen.getByText(/1 missing/i)).toBeInTheDocument();

    // 2. Relink drop.wav individually with a renamed replacement file
    const dropInput = screen.getByTestId("relink-file-input-drop.wav");
    const replacementFile = new File([new Uint8Array(128)], "drop_v2.wav", {
      type: "audio/wav",
    });
    await act(async () => {
      fireEvent.change(dropInput, {
        target: { files: [replacementFile] },
      });
    });

    await waitFor(() => {
      expect(getDecodedAudioAsset("drop_v2.wav")).toBeDefined();
    });
    expect(screen.getByText(/0 missing/i)).toBeInTheDocument();

    const updatedClips =
      useTaktStore.getState().showState.timelines[0]?.tracks[0]?.clips ?? [];
    expect(updatedClips[1]?.audio_file).toBe("drop_v2.wav");

    // 3. Dismiss modal
    fireEvent.click(screen.getByTestId("missing-audio-dismiss-btn"));
    expect(screen.queryByTestId("missing-audio-modal")).not.toBeInTheDocument();
  });

  it("does not open the modal when all referenced audio files are already loaded", async () => {
    render(<App />);

    // Pre-import once and relink both files
    await act(async () => {
      await useTaktStore.getState().importShowXml(SHOW_WITH_TWO_AUDIO_CLIPS_XML);
    });
    const introFile = new File([new Uint8Array(128)], "intro.wav", {
      type: "audio/wav",
    });
    const dropFile = new File([new Uint8Array(128)], "drop.wav", {
      type: "audio/wav",
    });
    await act(async () => {
      await useTaktStore
        .getState()
        .relinkMissingAudioFromFolderFiles([introFile, dropFile]);
    });
    fireEvent.click(screen.getByTestId("missing-audio-dismiss-btn"));

    // Re-importing the same show should find both assets in memory and not open the modal
    await act(async () => {
      await useTaktStore.getState().importShowXml(SHOW_WITH_TWO_AUDIO_CLIPS_XML);
    });
    expect(screen.queryByTestId("missing-audio-modal")).not.toBeInTheDocument();
  });

  it("uses native Tauri folder/file pickers (no webkitdirectory upload input), persists full paths, and auto-resolves remembered folders on reopen", async () => {
    const invoked: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const baseShow = useTaktStore.getState().showState;
    const showWithBareName = {
      ...baseShow,
      timelines: [
        {
          id: "tl_native",
          name: "Native Music Timeline",
          duration_sec: 30,
          grid_offset_sec: 0,
          loop_timeline: false,
          tempo_map: [{ at_sec: 0, bpm: 120 }],
          audio_track: null,
          tracks: [
            {
              id: "trk_m",
              name: "Music 1",
              track_type: "music" as const,
              target_group: null,
              clips: [
                {
                  ref_block: null,
                  start_sec: 0,
                  duration_sec: 10,
                  fade_in_sec: 0,
                  fade_out_sec: 0,
                  inline_fx: [],
                  audio_file: "intro.wav",
                  source_duration_sec: 10,
                },
                {
                  ref_block: null,
                  start_sec: 12,
                  duration_sec: 10,
                  fade_in_sec: 0,
                  fade_out_sec: 0,
                  inline_fx: [],
                  audio_file: "drop.wav",
                  source_duration_sec: 10,
                },
              ],
            },
          ],
        },
      ],
    };

    const currentShowRef = { current: showWithBareName };
    const makeSnapshot = () => ({
      revision: 2,
      show: currentShowRef.current,
      compiled_cells: [],
      can_undo: false,
      can_redo: false,
      rollover_enabled: true,
      toast: null,
      cross_protocol_warning: false,
      has_autosave_recovery: false,
    });

    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        invoked.push({ cmd, args });
        switch (cmd) {
          case "pick_audio_folder_command":
            return "C:\\Music\\ShowSet";
          case "pick_audio_file_command":
            return "C:\\Music\\Extras\\drop.wav";
          case "resolve_audio_in_folder_command": {
            const folder = String(args?.folderPath ?? "");
            const names = (args?.fileNames as string[]) ?? [];
            const out = [];
            if (folder === "C:\\Music\\ShowSet" && names.includes("intro.wav")) {
              out.push({
                requested: "intro.wav",
                resolved_path: "C:\\Music\\ShowSet\\intro.wav",
                file_name: "intro.wav",
              });
            }
            if (folder === "C:\\Music\\Extras" && names.includes("drop.wav")) {
              out.push({
                requested: "drop.wav",
                resolved_path: "C:\\Music\\Extras\\drop.wav",
                file_name: "drop.wav",
              });
            }
            return out;
          }
          case "read_audio_file_raw_command": {
            const p = String(args?.path ?? "");
            if (
              p === "C:\\Music\\ShowSet\\intro.wav" ||
              p === "C:\\Music\\Extras\\drop.wav"
            ) {
              return new Uint8Array(128).buffer;
            }
            throw new Error(`Audio file not found: ${p}`);
          }
          case "read_audio_file_bytes_command":
            throw new Error(`Audio file not found: ${String(args?.path ?? "")}`);
          case "upsert_timeline_command": {
            const tl = args?.timeline as (typeof showWithBareName.timelines)[number];
            currentShowRef.current = {
              ...currentShowRef.current,
              timelines: currentShowRef.current.timelines.map((t) =>
                t.id === tl.id ? tl : t,
              ),
            };
            return makeSnapshot();
          }
          default:
            return makeSnapshot();
        }
      }),
    };

    useTaktStore.setState({ showState: showWithBareName });
    render(<MissingAudioModal />);

    // Initial check: neither bare filename exists in CWD -> modal opens
    await act(async () => {
      await useTaktStore.getState().checkShowAudioFiles();
    });
    expect(screen.getByTestId("missing-audio-modal")).toBeInTheDocument();
    // In Tauri desktop mode, HTML webkitdirectory input must NOT be rendered
    expect(
      screen.queryByTestId("relink-folder-file-input"),
    ).not.toBeInTheDocument();

    // 1. Click "Select Folder…" -> uses native folder dialog and persists full path into clip
    await act(async () => {
      fireEvent.click(screen.getByTestId("relink-browse-folder-btn"));
    });
    await waitFor(() => {
      expect(
        useTaktStore.getState().showState.timelines[0]?.tracks[0]?.clips[0]
          ?.audio_file,
      ).toBe("C:\\Music\\ShowSet\\intro.wav");
    });
    expect(
      invoked.some((c) => c.cmd === "pick_audio_folder_command"),
    ).toBe(true);

    // 2. Click "Select File…" on drop.wav -> uses native file dialog and persists full path
    await act(async () => {
      fireEvent.click(screen.getByTestId("relink-native-file-btn-drop.wav"));
    });
    await waitFor(() => {
      expect(
        useTaktStore.getState().showState.timelines[0]?.tracks[0]?.clips[1]
          ?.audio_file,
      ).toBe("C:\\Music\\Extras\\drop.wav");
    });
    expect(invoked.some((c) => c.cmd === "pick_audio_file_command")).toBe(true);
    expect(screen.getByText(/0 missing/i)).toBeInTheDocument();

    // 3. Simulate app restart (in-memory audio cleared) reopening a legacy bare-filename project:
    // remembered folders in localStorage must auto-resolve both clips without prompting!
    clearAudioAssetRegistry();
    useTaktStore.setState({
      showState: showWithBareName,
      missingAudioFiles: [],
      missingAudioModalOpen: false,
    });
    await act(async () => {
      await useTaktStore.getState().checkShowAudioFiles();
    });
    expect(screen.queryByTestId("missing-audio-modal")).not.toBeInTheDocument();
    expect(getDecodedAudioAsset("intro.wav")).toBeDefined();
    expect(getDecodedAudioAsset("drop.wav")).toBeDefined();
  });
});
