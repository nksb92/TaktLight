import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTaktStore } from "../useTaktStore";

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

describe("Tauri IPC Contract — useTaktStore ↔ src-tauri/src/lib.rs", () => {
  let calls: InvokeCall[] = [];

  beforeEach(() => {
    calls = [];
    const baseShow = useTaktStore.getState().showState;
    const baseSnapshot = {
      revision: 2,
      show: baseShow,
      compiled_cells: [],
      can_undo: true,
      can_redo: false,
      rollover_enabled: true,
      toast: null,
      cross_protocol_warning: false,
    };
    const baseEngineSnap = {
      grand_master: 0.75,
      blackout: true,
      parked_channels: [],
      live_layers: [],
      active_scenes: [],
      live_bpm: 128,
      active_timeline_id: "tl_1",
      timeline_playing: true,
      timeline_playhead_sec: 1.5,
      latency_offset_ms: 0,
      universes: baseShow.network_outputs.universes,
      interfaces: [],
      adapter_selection: { mode: "auto" },
      is_offline: false,
      output_enabled: true,
      discovery_available: true,
      active_interface: null,
      discovered_nodes: [],
      jitter_stats: {
        samples: 0,
        mean_us: 0,
        max_jitter_us: 0,
        p99_jitter_us: 0,
        dropped_frames: 0,
      },
      jitter_samples_us: [],
    };

    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        switch (cmd) {
          case "set_blackout":
          case "set_grand_master":
          case "set_channel_park":
          case "clear_all_parked_channels":
            return undefined;
          case "set_output_enabled_command":
          case "trigger_scene_command":
          case "release_scene_command":
          case "release_all_scenes_command":
          case "set_live_bpm_command":
          case "tap_tempo_command":
          case "set_timeline_transport_command":
          case "set_latency_offset_ms_command":
          case "get_engine_snapshot":
            return baseEngineSnap;
          case "patch_fixtures_command":
          case "import_show_xml_command":
          case "rename_scene_bank_command":
          case "resolve_split_fixtures_command":
          case "undo_command":
          case "redo_command":
            return baseSnapshot;
          case "export_show_xml_command":
            return `<?xml version="1.0" encoding="UTF-8"?><TaktLightShow version="1.0" name="IPC" bpm="120"></TaktLightShow>`;
          case "delete_user_fixture":
            return undefined;
          case "list_fixtures":
            return [];
          case "resolve_audio_in_folder_command":
            return [
              {
                requested: "C:\\Old\\song.wav",
                resolved_path: "C:\\New\\song.wav",
                file_name: "song.wav",
              },
            ];
          case "read_audio_file_bytes_command":
            throw new Error("missing audio");
          case "pick_audio_file_command":
            return "C:\\Music\\song.mp3";
          case "pick_audio_folder_command":
            return "C:\\Music";
          case "new_project_command":
            return baseSnapshot;
          case "open_project_path_command":
            return baseSnapshot;
          case "get_recent_projects_command":
            return ["C:\\Shows\\demo.takt.xml"];
          case "save_project_as_command":
            return true;
          default:
            return baseSnapshot;
        }
      }),
    };
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it("dispatches runtime, output, park, scene, timeline, and XML commands with exact Rust parameter names", async () => {
    const store = useTaktStore.getState();

    await store.setGrandMaster(0.75);
    await store.setBlackout(true);
    await store.setOutputEnabled(true);
    await store.setChannelPark(1, 5, 200);
    await store.clearAllParked(1);
    await store.setLiveBpm(128);
    await store.tapTempo();
    await store.triggerScene("scn_1");
    await store.releaseScene("scn_1");
    await store.releaseAllScenes();
    await store.setTimelineTransport("tl_1", true, 1.5);
    await store.setLatencyOffsetMs(10);
    await store.patchFixtures("user/test_tube_8seg.json", "34ch Pixel Mode", "Tube", 1, 1, 1);
    await store.renameSceneBank("Bank 1", "Verse");
    await store.resolveSplitFixtures();
    await store.undoShow();
    await store.redoShow();
    const xml = await store.exportShowXml();
    expect(xml).toContain("<TaktLightShow");
    await store.importShowXml(xml);
    await store.deleteUserFixture("user/custom.json");
    await store.loadRecentProjects();
    await store.openRecentProject("C:\\Shows\\demo.takt.xml");
    await store.saveProjectAsFile();
    await store.newProject();
    expect(await store.pickNativeAudioFile("Select Music")).toBe(
      "C:\\Music\\song.mp3",
    );
    expect(await store.pickNativeAudioFolder("Select Folder")).toBe(
      "C:\\Music",
    );

    const findCall = (name: string) => calls.find((c) => c.cmd === name);
    const findLastCall = (name: string) =>
      [...calls].reverse().find((c) => c.cmd === name);

    expect(findCall("set_grand_master")?.args).toEqual({ value: 0.75 });
    expect(findCall("set_blackout")?.args).toEqual({ active: true });
    expect(findCall("set_output_enabled_command")?.args).toEqual({ enabled: true });
    expect(findCall("set_channel_park")?.args).toEqual({
      universe: 1,
      channel: 5,
      value: 200,
    });
    expect(findCall("clear_all_parked_channels")?.args).toEqual({ universe: 1 });
    expect(findCall("set_live_bpm_command")?.args).toMatchObject({ bpm: 128 });
    expect(findCall("tap_tempo_command")).toBeDefined();
    expect(findCall("trigger_scene_command")?.args).toMatchObject({ sceneId: "scn_1" });
    expect(findCall("release_scene_command")?.args).toMatchObject({ sceneId: "scn_1" });
    expect(findCall("release_all_scenes_command")).toBeDefined();
    expect(findLastCall("set_timeline_transport_command")?.args).toMatchObject({
      timelineId: "tl_1",
      playing: true,
      playheadSec: 1.5,
    });
    expect(findCall("set_latency_offset_ms_command")?.args).toEqual({ offsetMs: 10 });
    expect(findCall("patch_fixtures_command")?.args).toMatchObject({
      profileId: "user/test_tube_8seg.json",
      modeName: "34ch Pixel Mode",
      namePrefix: "Tube",
      count: 1,
      universe: 1,
      address: 1,
    });
    expect(findCall("rename_scene_bank_command")?.args).toEqual({
      oldName: "Bank 1",
      newName: "Verse",
    });
    expect(findCall("resolve_split_fixtures_command")).toBeDefined();
    expect(findCall("undo_command")).toBeDefined();
    expect(findCall("redo_command")).toBeDefined();
    expect(findCall("export_show_xml_command")).toBeDefined();
    expect(findCall("import_show_xml_command")?.args).toEqual({ xmlStr: xml });
    expect(findCall("delete_user_fixture")?.args).toEqual({ id: "user/custom.json" });
    expect(findCall("get_recent_projects_command")).toBeDefined();
    expect(findCall("open_project_path_command")?.args).toEqual({
      path: "C:\\Shows\\demo.takt.xml",
    });
    expect(findCall("save_project_as_command")?.args).toMatchObject({
      suggestedName: expect.stringMatching(/\.takt\.xml$/),
    });
    expect(findCall("new_project_command")).toBeDefined();
    expect(findCall("pick_audio_file_command")?.args).toEqual({
      title: "Select Music",
    });
    expect(findCall("pick_audio_folder_command")?.args).toEqual({
      title: "Select Folder",
    });
  });
});
