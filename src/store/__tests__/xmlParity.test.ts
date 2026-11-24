import { describe, expect, it } from "vitest";
import { useTaktStore } from "../useTaktStore";

const CANONICAL_RUST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<TaktLightShow version="1.0" name="Rust Exported Show" bpm="126">
  <NetworkOutputs frame_rate_hz="44" adapter="auto" offline_fallback="true" artsync="true">
    <Universe id="1" protocol="artnet" mode="broadcast" net="0" subnet="0" uni="0" />
    <Universe id="2" protocol="sacn" mode="unicast" target_ip="10.0.0.5" sacn_universe="2" priority="120" />
  </NetworkOutputs>
  <Palettes>
    <ColorPalette id="pal_sunset" name="Sunset" hex_start="#FF2200" hex_end="#2200FF" colors="#FF2200,#FFAA00,#2200FF" />
    <DimmerPalette id="dim_half" name="Half" value_start="0.5" value_end="0.5" />
  </Palettes>
  <Patch>
    <FixtureInstance id="fx_001" profile="age/rlcv3_8_segment_tube.json" mode="34ch Pixel Mode" name="Tube 1" universe="1" address="1" channel_count="34">
      <GridPos x="0.25" y="0.5" rotation="90" scale_x="0.3" scale_y="0.05" />
      <Calibration gamma="2.4" min_dimmer_dmx="2" max_dimmer_dmx="250" white_mode="add" white_gain="1.1" />
    </FixtureInstance>
  </Patch>
  <Groups>
    <Group id="grp_1" name="Front" order="center_out">
      <Target ref="fx_001:0..7" />
    </Group>
  </Groups>
  <FxLibrary>
    <FxBlock id="blk_seq" name="Seq Block" target_group="grp_1" duration_beats="6" loop_block="true">
      <SceneSequence playback_mode="bounce">
        <Step scene_id="sc_1" duration_value="2" duration_unit="beats" fade_sec="0.25" />
        <Step scene_id="sc_2" duration_value="1.5" duration_unit="seconds" fade_sec="0" />
      </SceneSequence>
    </FxBlock>
  </FxLibrary>
  <Scenes>
    <Scene id="sc_1" name="Intro" bank="Bank 1" priority="10" fade_in_sec="0.5" fade_out_sec="0.5" duration_value="4" duration_unit="beats">
      <BlockRef ref="blk_seq" />
    </Scene>
  </Scenes>
  <Timelines>
    <Timeline id="tl_1" name="Main Song" duration_sec="12" grid_offset_sec="0.1" loop_timeline="true">
      <TempoMap>
        <Point at_sec="0" bpm="126" />
      </TempoMap>
      <Track id="trk_1" name="FX 1" track_type="effect" target_group="grp_1">
        <Clip ref_block="blk_seq" start_sec="0" duration_sec="4" fade_in_sec="0.2" fade_out_sec="0.2" time_stretch="true" source_duration_sec="3" />
      </Track>
      <Track id="trk_2" name="Music" track_type="music">
        <Clip audio_file="song.wav" start_sec="0" duration_sec="12" fade_in_sec="0" fade_out_sec="0" />
      </Track>
    </Timeline>
  </Timelines>
</TaktLightShow>`;

describe("JS ↔ Rust .takt.xml Parity & Validation", () => {
  it("parses canonical Rust-serialized .takt.xml and round-trips losslessly through JS exportShowXml", async () => {
    await useTaktStore.getState().loadFixtures();
    await useTaktStore.getState().importShowXml(CANONICAL_RUST_XML);

    const show = useTaktStore.getState().showState;
    expect(show.name).toBe("Rust Exported Show");
    expect(show.bpm).toBe(126);
    expect(show.network_outputs.universes).toHaveLength(2);
    expect(show.network_outputs.universes[1].protocol).toMatchObject({
      protocol: "sacn",
      sacn_universe: 2,
      priority: 120,
    });
    expect(show.color_palettes[0].colors).toEqual(["#FF2200", "#FFAA00", "#2200FF"]);
    expect(show.patch[0].calibration.gamma).toBeCloseTo(2.4);
    expect(show.patch[0].calibration.white_mode).toBe("add");
    expect(show.groups[0].order).toBe("center_out");

    const seqBlk = show.fx_library.find((b) => b.id === "blk_seq");
    expect(seqBlk?.elements[0]).toMatchObject({
      kind: "scene_sequence",
      playback_mode: "bounce",
      steps: [
        { scene_id: "sc_1", duration_value: 2, duration_unit: "beats", fade_sec: 0.25 },
        { scene_id: "sc_2", duration_value: 1.5, duration_unit: "seconds", fade_sec: 0 },
      ],
    });
    expect(show.timelines[0].loop_timeline).toBe(true);
    expect(show.timelines[0].tracks[0].clips[0].time_stretch).toBe(true);
    expect(show.timelines[0].tracks[1].clips[0].audio_file).toBe("song.wav");

    // Re-export and re-import to verify lossless JS round-trip
    const reExported = await useTaktStore.getState().exportShowXml();
    await useTaktStore.getState().importShowXml(reExported);
    const show2 = useTaktStore.getState().showState;
    expect(show2.name).toBe("Rust Exported Show");
    expect(show2.patch[0].calibration.gamma).toBeCloseTo(2.4);
    expect(show2.timelines[0].tracks[1].clips[0].audio_file).toBe("song.wav");
  });

  it("rejects malformed XML and missing root elements", async () => {
    await expect(
      useTaktStore.getState().importShowXml("<TaktLightShow><broken"),
    ).rejects.toThrow(/Invalid XML syntax|Missing <TaktLightShow>/i);

    await expect(
      useTaktStore.getState().importShowXml("<OtherRoot />"),
    ).rejects.toThrow(/Missing <TaktLightShow>/i);
  });
});
