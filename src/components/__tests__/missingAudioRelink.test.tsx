import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
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
    clearAudioAssetRegistry();
    useTaktStore.getState().resetForTest();
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
});
