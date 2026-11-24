use taktlight_engine::show::xml::{deserialize_show_xml, serialize_show_xml, FxElementDef, SequencePlaybackMode};
use taktlight_engine::state::plan::ProtocolKind;

/// Canonical XML formatted by frontend `serializeShowXmlLocally` in `useTaktStore.ts`.
const CANONICAL_JS_XML: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<TaktLightShow version="1.0" name="JS Exported Show" bpm="124">
  <NetworkOutputs frame_rate_hz="44" adapter="auto" offline_fallback="true" artsync="true">
    <Universe id="1" protocol="artnet" mode="broadcast" net="0" subnet="0" uni="0" />
    <Universe id="2" protocol="sacn" mode="unicast" target_ip="10.0.0.9" sacn_universe="2" priority="110" />
  </NetworkOutputs>
  <Palettes>
    <ColorPalette id="pal_neon" name="Neon" hex_start="#FF00AA" hex_end="#00E5FF" colors="#FF00AA,#8800FF,#00E5FF" />
    <DimmerPalette id="dim_75" name="75%" value_start="0.75" value_end="0.75" />
  </Palettes>
  <Patch>
    <FixtureInstance id="fx_001" profile="age/rlcv3_8_segment_tube.json" mode="34ch Pixel Mode" name="Tube 1" universe="1" address="1" channel_count="34">
      <GridPos x="0.3" y="0.4" rotation="45" scale_x="0.25" scale_y="0.05" />
      <Calibration gamma="2.2" min_dimmer_dmx="0" max_dimmer_dmx="255" white_mode="replace" white_gain="1" />
    </FixtureInstance>
  </Patch>
  <Groups>
    <Group id="grp_1" name="Stage" order="mirror">
      <Target ref="fx_001:0..7" />
    </Group>
  </Groups>
  <FxLibrary>
    <FxBlock id="blk_seq" name="Chaser Seq" target_group="grp_1" duration_beats="6" loop_block="true">
      <SceneSequence playback_mode="bounce">
        <Step scene_id="sc_1" duration_value="2" duration_unit="beats" fade_sec="0.2" />
        <Step scene_id="sc_2" duration_value="1" duration_unit="seconds" fade_sec="0" />
      </SceneSequence>
    </FxBlock>
  </FxLibrary>
  <Scenes>
    <Scene id="sc_1" name="Opening" bank="Bank 1" priority="10" fade_in_sec="0.5" fade_out_sec="0.5" duration_value="4" duration_unit="beats">
      <BlockRef ref="blk_seq" />
    </Scene>
  </Scenes>
  <Timelines>
    <Timeline id="tl_1" name="Show Song" duration_sec="10" grid_offset_sec="0.05" loop_timeline="true">
      <TempoMap>
        <Point at_sec="0" bpm="124" />
      </TempoMap>
      <Track id="trk_1" name="FX" track_type="effect" target_group="grp_1">
        <Clip ref_block="blk_seq" start_sec="0" duration_sec="4" fade_in_sec="0.1" fade_out_sec="0.1" />
      </Track>
      <Track id="trk_2" name="Music" track_type="music">
        <Clip audio_file="song.wav" start_sec="0" duration_sec="10" fade_in_sec="0" fade_out_sec="0" />
      </Track>
    </Timeline>
  </Timelines>
</TaktLightShow>
"##;

#[test]
fn rust_deserializes_canonical_js_show_xml_and_roundtrips() {
    let show = deserialize_show_xml(CANONICAL_JS_XML).expect("parse JS-formatted .takt.xml");
    assert_eq!(show.name, "JS Exported Show");
    assert!((show.bpm - 124.0).abs() < 1e-4);
    assert_eq!(show.network_outputs.universes.len(), 2);
    assert!(matches!(
        show.network_outputs.universes[1].protocol,
        ProtocolKind::Sacn {
            sacn_universe: 2,
            priority: 110,
            ..
        }
    ));
    assert_eq!(show.color_palettes[0].colors.len(), 3);
    assert_eq!(show.patch.len(), 1);
    assert_eq!(show.groups.len(), 1);
    assert_eq!(show.fx_library.len(), 1);
    match &show.fx_library[0].elements[0] {
        FxElementDef::SceneSequence {
            playback_mode,
            steps,
        } => {
            assert_eq!(*playback_mode, SequencePlaybackMode::Bounce);
            assert_eq!(steps.len(), 2);
        }
        other => panic!("expected SceneSequence, got {other:?}"),
    }
    assert_eq!(show.timelines.len(), 1);
    assert!(show.timelines[0].loop_timeline);
    assert_eq!(show.timelines[0].tracks.len(), 2);
    assert_eq!(
        show.timelines[0].tracks[1].clips[0].audio_file.as_deref(),
        Some("song.wav")
    );

    // Round-trip back through Rust serializer and deserializer
    let reserialized = serialize_show_xml(&show).expect("reserialize show");
    let reparsed = deserialize_show_xml(&reserialized).expect("reparse show");
    assert_eq!(reparsed.name, show.name);
    assert_eq!(reparsed.timelines.len(), 1);
    assert_eq!(reparsed.fx_library.len(), 1);
}

#[test]
fn rust_rejects_malformed_and_wrong_root_xml() {
    assert!(deserialize_show_xml("<TaktLightShow><unclosed").is_err());
    assert!(deserialize_show_xml("<NotTaktLight />").is_err());
}
