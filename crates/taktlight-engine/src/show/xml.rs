use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use quick_xml::de::from_str as xml_from_str;
use quick_xml::se::Serializer;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::state::plan::{ArtNetOutputMode, ProtocolKind, SacnOutputMode, UniverseConfig};

use super::patch::{validate_patch_no_collisions, FixtureCalibration, FixtureInstance, WhiteMode};
use super::spatial::{GridPos, OrderRule};
use super::ShowError;

pub const CURRENT_SHOW_SCHEMA_VERSION: &str = "1.0";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColorPaletteDef {
    pub id: String,
    pub name: String,
    pub hex_start: String,
    pub hex_end: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DimmerPaletteDef {
    pub id: String,
    pub name: String,
    pub value_start: f32,
    pub value_end: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FxElementDef {
    StaticTrait {
        #[serde(rename = "trait")]
        trait_name: String,
        op: String,
        #[serde(default)]
        palette_ref: Option<String>,
        #[serde(default)]
        value_start: Option<f32>,
        #[serde(default)]
        value_end: Option<f32>,
        #[serde(default)]
        order: Option<OrderRule>,
    },
    Curve1D {
        #[serde(rename = "trait")]
        trait_name: String,
        op: String,
        waveform: String,
        amplitude: f32,
        #[serde(default)]
        offset: f32,
        #[serde(default)]
        rate_beats: Option<f32>,
        #[serde(default)]
        speed_hz: Option<f32>,
        #[serde(default)]
        phase_spread_deg: f32,
        #[serde(default)]
        duty: Option<f32>,
        #[serde(default)]
        palette_ref: Option<String>,
        #[serde(default)]
        order: Option<OrderRule>,
    },
    StepChase {
        #[serde(rename = "trait")]
        trait_name: String,
        op: String,
        #[serde(default)]
        step_beats: Option<f32>,
        #[serde(default)]
        speed_hz: Option<f32>,
        #[serde(default)]
        active_ratio: Option<f32>,
        #[serde(default)]
        fade: f32,
        #[serde(default = "default_one")]
        amplitude: f32,
        #[serde(default)]
        palette_ref: Option<String>,
        #[serde(default)]
        order: Option<OrderRule>,
    },
    SpatialShader2D {
        #[serde(rename = "trait")]
        trait_name: String,
        op: String,
        shader: String,
        #[serde(default)]
        palette_ref: Option<String>,
        #[serde(default)]
        rate_beats: Option<f32>,
        #[serde(default)]
        speed_hz: Option<f32>,
        #[serde(default = "default_one")]
        spatial_freq: f32,
        #[serde(default)]
        direction_deg: f32,
        #[serde(default = "default_half")]
        center_x: f32,
        #[serde(default = "default_half")]
        center_y: f32,
    },
}

fn default_one() -> f32 {
    1.0
}

fn default_half() -> f32 {
    0.5
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FixtureGroupDef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub order: OrderRule,
    pub targets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FxBlockDef {
    pub id: String,
    pub name: String,
    pub target_group: Option<String>,
    #[serde(default = "default_beats")]
    pub duration_beats: f32,
    #[serde(default = "default_true")]
    pub loop_block: bool,
    #[serde(default)]
    pub elements: Vec<FxElementDef>,
}

fn default_beats() -> f32 {
    4.0
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneDef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub bank: Option<String>,
    #[serde(default)]
    pub target_group: Option<String>,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub fade_in_sec: f32,
    #[serde(default)]
    pub fade_out_sec: f32,
    #[serde(default)]
    pub block_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TempoPointDef {
    pub at_sec: f64,
    pub bpm: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioTrackDef {
    pub file: String,
    #[serde(default)]
    pub abs_fallback: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub offset_sec: f64,
    #[serde(default = "default_sensitivity")]
    pub transient_sensitivity: f32,
}

fn default_sensitivity() -> f32 {
    0.65
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClipDef {
    #[serde(default)]
    pub ref_block: Option<String>,
    pub start_sec: f64,
    pub duration_sec: f64,
    #[serde(default)]
    pub fade_in_sec: f32,
    #[serde(default)]
    pub fade_out_sec: f32,
    #[serde(default)]
    pub inline_fx: Vec<FxElementDef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackDef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub target_group: Option<String>,
    #[serde(default)]
    pub clips: Vec<ClipDef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimelineDef {
    pub id: String,
    pub name: String,
    pub duration_sec: f64,
    #[serde(default)]
    pub grid_offset_sec: f64,
    #[serde(default)]
    pub tempo_map: Vec<TempoPointDef>,
    #[serde(default)]
    pub audio_track: Option<AudioTrackDef>,
    #[serde(default)]
    pub tracks: Vec<TrackDef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NetworkOutputsConfig {
    pub frame_rate_hz: u16,
    pub adapter: String,
    #[serde(default)]
    pub subnet: Option<String>,
    pub offline_fallback: bool,
    pub artsync: bool,
    pub universes: Vec<UniverseConfig>,
}

impl Default for NetworkOutputsConfig {
    fn default() -> Self {
        Self {
            frame_rate_hz: 44,
            adapter: "auto".to_string(),
            subnet: None,
            offline_fallback: true,
            artsync: true,
            universes: vec![
                UniverseConfig::new(
                    1,
                    ProtocolKind::ArtNet {
                        mode: ArtNetOutputMode::Broadcast,
                        net: 0,
                        subnet: 0,
                        uni: 0,
                    },
                ),
                UniverseConfig::new(
                    2,
                    ProtocolKind::Sacn {
                        mode: SacnOutputMode::Multicast,
                        sacn_universe: 2,
                        priority: 100,
                    },
                ),
            ],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShowState {
    pub version: String,
    pub name: String,
    pub bpm: f32,
    #[serde(default)]
    pub read_only_newer_version: bool,
    pub network_outputs: NetworkOutputsConfig,
    #[serde(default)]
    pub color_palettes: Vec<ColorPaletteDef>,
    #[serde(default)]
    pub dimmer_palettes: Vec<DimmerPaletteDef>,
    #[serde(default)]
    pub patch: Vec<FixtureInstance>,
    #[serde(default)]
    pub groups: Vec<FixtureGroupDef>,
    #[serde(default)]
    pub fx_library: Vec<FxBlockDef>,
    #[serde(default)]
    pub scenes: Vec<SceneDef>,
    #[serde(default)]
    pub timelines: Vec<TimelineDef>,
}

impl Default for ShowState {
    fn default() -> Self {
        Self {
            version: CURRENT_SHOW_SCHEMA_VERSION.to_string(),
            name: "Untitled Show".to_string(),
            bpm: 120.0,
            read_only_newer_version: false,
            network_outputs: NetworkOutputsConfig::default(),
            color_palettes: Vec::new(),
            dimmer_palettes: Vec::new(),
            patch: Vec::new(),
            groups: Vec::new(),
            fx_library: Vec::new(),
            scenes: Vec::new(),
            timelines: Vec::new(),
        }
    }
}

// =========================================================================
// XML Serde Representation (matches ARCHITECTURE.md Section 3.2)
// =========================================================================

#[derive(Debug, Serialize, Deserialize)]
struct TaktLightShowXml {
    #[serde(rename = "@version")]
    version: String,
    #[serde(rename = "@name")]
    name: String,
    #[serde(rename = "@bpm")]
    bpm: f32,
    #[serde(rename = "NetworkOutputs")]
    network_outputs: NetworkOutputsXml,
    #[serde(rename = "Palettes", default)]
    palettes: PalettesXml,
    #[serde(rename = "Patch", default)]
    patch: PatchXml,
    #[serde(rename = "Groups", default)]
    groups: GroupsXml,
    #[serde(rename = "FxLibrary", default)]
    fx_library: FxLibraryXml,
    #[serde(rename = "Scenes", default)]
    scenes: ScenesXml,
    #[serde(rename = "Timelines", default)]
    timelines: TimelinesXml,
}

#[derive(Debug, Serialize, Deserialize)]
struct NetworkOutputsXml {
    #[serde(rename = "@frame_rate_hz", default = "default_hz")]
    frame_rate_hz: u16,
    #[serde(rename = "@adapter", default = "default_auto")]
    adapter: String,
    #[serde(rename = "@subnet", default, skip_serializing_if = "Option::is_none")]
    subnet: Option<String>,
    #[serde(rename = "@offline_fallback", default = "default_true")]
    offline_fallback: bool,
    #[serde(rename = "@artsync", default = "default_true")]
    artsync: bool,
    #[serde(rename = "Universe", default)]
    universes: Vec<UniverseXml>,
}

fn default_hz() -> u16 {
    44
}

fn default_auto() -> String {
    "auto".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
struct UniverseXml {
    #[serde(rename = "@id")]
    id: u16,
    #[serde(rename = "@protocol")]
    protocol: String,
    #[serde(rename = "@mode")]
    mode: String,
    #[serde(
        rename = "@target_ip",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    target_ip: Option<String>,
    #[serde(rename = "@net", default, skip_serializing_if = "Option::is_none")]
    net: Option<u8>,
    #[serde(rename = "@subnet", default, skip_serializing_if = "Option::is_none")]
    subnet: Option<u8>,
    #[serde(rename = "@uni", default, skip_serializing_if = "Option::is_none")]
    uni: Option<u8>,
    #[serde(
        rename = "@sacn_universe",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    sacn_universe: Option<u16>,
    #[serde(rename = "@priority", default, skip_serializing_if = "Option::is_none")]
    priority: Option<u8>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PalettesXml {
    #[serde(rename = "$value", default)]
    items: Vec<PaletteItemXml>,
}

#[derive(Debug, Serialize, Deserialize)]
enum PaletteItemXml {
    ColorPalette {
        #[serde(rename = "@id")]
        id: String,
        #[serde(rename = "@name")]
        name: String,
        #[serde(rename = "@hex_start")]
        hex_start: String,
        #[serde(rename = "@hex_end")]
        hex_end: String,
    },
    DimmerPalette {
        #[serde(rename = "@id")]
        id: String,
        #[serde(rename = "@name")]
        name: String,
        #[serde(rename = "@value_start")]
        value_start: f32,
        #[serde(rename = "@value_end")]
        value_end: f32,
    },
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PatchXml {
    #[serde(rename = "FixtureInstance", default)]
    fixtures: Vec<FixtureInstanceXml>,
}

#[derive(Debug, Serialize, Deserialize)]
struct FixtureInstanceXml {
    #[serde(rename = "@id")]
    id: String,
    #[serde(rename = "@profile")]
    profile: String,
    #[serde(rename = "@mode")]
    mode: String,
    #[serde(rename = "@name")]
    name: String,
    #[serde(rename = "@universe")]
    universe: u16,
    #[serde(rename = "@address")]
    address: u16,
    #[serde(
        rename = "@channel_count",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    channel_count: Option<u16>,
    #[serde(rename = "GridPos", default)]
    grid_pos: GridPosXml,
    #[serde(rename = "Calibration", default)]
    calibration: CalibrationXml,
}

#[derive(Debug, Serialize, Deserialize)]
struct GridPosXml {
    #[serde(rename = "@x", default = "default_half")]
    x: f32,
    #[serde(rename = "@y", default = "default_half")]
    y: f32,
    #[serde(rename = "@rotation", default)]
    rotation: f32,
    #[serde(rename = "@scale_x", default = "default_scale_x")]
    scale_x: f32,
    #[serde(rename = "@scale_y", default = "default_scale_y")]
    scale_y: f32,
}

fn default_scale_x() -> f32 {
    0.30
}

fn default_scale_y() -> f32 {
    0.05
}

impl Default for GridPosXml {
    fn default() -> Self {
        Self {
            x: 0.5,
            y: 0.5,
            rotation: 0.0,
            scale_x: 0.30,
            scale_y: 0.05,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct CalibrationXml {
    #[serde(rename = "@gamma", default = "default_gamma")]
    gamma: f32,
    #[serde(rename = "@min_dimmer_dmx", default)]
    min_dimmer_dmx: u8,
    #[serde(rename = "@max_dimmer_dmx", default = "default_255")]
    max_dimmer_dmx: u8,
    #[serde(rename = "@white_mode", default = "default_replace")]
    white_mode: String,
    #[serde(rename = "@white_gain", default = "default_one")]
    white_gain: f32,
}

fn default_gamma() -> f32 {
    2.2
}

fn default_255() -> u8 {
    255
}

fn default_replace() -> String {
    "replace".to_string()
}

impl Default for CalibrationXml {
    fn default() -> Self {
        Self {
            gamma: 2.2,
            min_dimmer_dmx: 0,
            max_dimmer_dmx: 255,
            white_mode: "replace".to_string(),
            white_gain: 1.0,
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct GroupsXml {
    #[serde(rename = "Group", default)]
    groups: Vec<GroupXml>,
}

#[derive(Debug, Serialize, Deserialize)]
struct GroupXml {
    #[serde(rename = "@id")]
    id: String,
    #[serde(rename = "@name")]
    name: String,
    #[serde(rename = "@order", default = "default_linear")]
    order: String,
    #[serde(rename = "Target", default)]
    targets: Vec<TargetXml>,
}

fn default_linear() -> String {
    "linear".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
struct TargetXml {
    #[serde(rename = "@ref")]
    target_ref: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct FxLibraryXml {
    #[serde(rename = "FxBlock", default)]
    blocks: Vec<FxBlockXml>,
}

#[derive(Debug, Serialize, Deserialize)]
struct FxBlockXml {
    #[serde(rename = "@id")]
    id: String,
    #[serde(rename = "@name")]
    name: String,
    #[serde(
        rename = "@target_group",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    target_group: Option<String>,
    #[serde(rename = "@duration_beats", default = "default_beats")]
    duration_beats: f32,
    #[serde(rename = "@loop", default = "default_true")]
    loop_block: bool,
    #[serde(rename = "$value", default)]
    elements: Vec<FxElementXml>,
}

#[derive(Debug, Serialize, Deserialize)]
enum FxElementXml {
    StaticTrait {
        #[serde(rename = "@trait")]
        trait_name: String,
        #[serde(rename = "@op")]
        op: String,
        #[serde(
            rename = "@palette_ref",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        palette_ref: Option<String>,
        #[serde(
            rename = "@value_start",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        value_start: Option<f32>,
        #[serde(rename = "@value_end", default, skip_serializing_if = "Option::is_none")]
        value_end: Option<f32>,
        #[serde(rename = "@order", default, skip_serializing_if = "Option::is_none")]
        order: Option<String>,
    },
    Curve1D {
        #[serde(rename = "@trait")]
        trait_name: String,
        #[serde(rename = "@op")]
        op: String,
        #[serde(rename = "@waveform")]
        waveform: String,
        #[serde(rename = "@amplitude")]
        amplitude: f32,
        #[serde(rename = "@offset", default)]
        offset: f32,
        #[serde(
            rename = "@rate_beats",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        rate_beats: Option<f32>,
        #[serde(rename = "@speed_hz", default, skip_serializing_if = "Option::is_none")]
        speed_hz: Option<f32>,
        #[serde(rename = "@phase_spread_deg", default)]
        phase_spread_deg: f32,
        #[serde(rename = "@duty", default, skip_serializing_if = "Option::is_none")]
        duty: Option<f32>,
        #[serde(
            rename = "@palette_ref",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        palette_ref: Option<String>,
        #[serde(rename = "@order", default, skip_serializing_if = "Option::is_none")]
        order: Option<String>,
    },
    StepChase {
        #[serde(rename = "@trait")]
        trait_name: String,
        #[serde(rename = "@op")]
        op: String,
        #[serde(
            rename = "@step_beats",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        step_beats: Option<f32>,
        #[serde(rename = "@speed_hz", default, skip_serializing_if = "Option::is_none")]
        speed_hz: Option<f32>,
        #[serde(
            rename = "@active_ratio",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        active_ratio: Option<f32>,
        #[serde(rename = "@fade", default)]
        fade: f32,
        #[serde(rename = "@amplitude", default = "default_one")]
        amplitude: f32,
        #[serde(
            rename = "@palette_ref",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        palette_ref: Option<String>,
        #[serde(rename = "@order", default, skip_serializing_if = "Option::is_none")]
        order: Option<String>,
    },
    SpatialShader2D {
        #[serde(rename = "@trait")]
        trait_name: String,
        #[serde(rename = "@op")]
        op: String,
        #[serde(rename = "@shader")]
        shader: String,
        #[serde(
            rename = "@palette_ref",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        palette_ref: Option<String>,
        #[serde(
            rename = "@rate_beats",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        rate_beats: Option<f32>,
        #[serde(rename = "@speed_hz", default, skip_serializing_if = "Option::is_none")]
        speed_hz: Option<f32>,
        #[serde(rename = "@spatial_freq", default = "default_one")]
        spatial_freq: f32,
        #[serde(rename = "@direction_deg", default)]
        direction_deg: f32,
        #[serde(rename = "@center_x", default = "default_half")]
        center_x: f32,
        #[serde(rename = "@center_y", default = "default_half")]
        center_y: f32,
    },
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ScenesXml {
    #[serde(rename = "Scene", default)]
    scenes: Vec<SceneXml>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SceneXml {
    #[serde(rename = "@id")]
    id: String,
    #[serde(rename = "@name")]
    name: String,
    #[serde(rename = "@bank", default, skip_serializing_if = "Option::is_none")]
    bank: Option<String>,
    #[serde(
        rename = "@target_group",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    target_group: Option<String>,
    #[serde(rename = "@priority", default)]
    priority: i32,
    #[serde(rename = "@fade_in_sec", default)]
    fade_in_sec: f32,
    #[serde(rename = "@fade_out_sec", default)]
    fade_out_sec: f32,
    #[serde(rename = "BlockRef", default)]
    block_refs: Vec<BlockRefXml>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BlockRefXml {
    #[serde(rename = "@ref")]
    ref_id: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TimelinesXml {
    #[serde(rename = "Timeline", default)]
    timelines: Vec<TimelineXml>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TimelineXml {
    #[serde(rename = "@id")]
    id: String,
    #[serde(rename = "@name")]
    name: String,
    #[serde(rename = "@duration_sec")]
    duration_sec: f64,
    #[serde(rename = "@grid_offset_sec", default)]
    grid_offset_sec: f64,
    #[serde(rename = "TempoMap", default)]
    tempo_map: TempoMapXml,
    #[serde(
        rename = "AudioTrack",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    audio_track: Option<AudioTrackXml>,
    #[serde(rename = "Track", default)]
    tracks: Vec<TrackXml>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TempoMapXml {
    #[serde(rename = "Tempo", default)]
    tempos: Vec<TempoXml>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TempoXml {
    #[serde(rename = "@at_sec")]
    at_sec: f64,
    #[serde(rename = "@bpm")]
    bpm: f32,
}

#[derive(Debug, Serialize, Deserialize)]
struct AudioTrackXml {
    #[serde(rename = "@file")]
    file: String,
    #[serde(
        rename = "@abs_fallback",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    abs_fallback: Option<String>,
    #[serde(rename = "@sha256", default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    #[serde(rename = "@offset_sec", default)]
    offset_sec: f64,
    #[serde(rename = "@transient_sensitivity", default = "default_sensitivity")]
    transient_sensitivity: f32,
}

#[derive(Debug, Serialize, Deserialize)]
struct TrackXml {
    #[serde(rename = "@id")]
    id: String,
    #[serde(rename = "@name")]
    name: String,
    #[serde(
        rename = "@target_group",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    target_group: Option<String>,
    #[serde(rename = "Clip", default)]
    clips: Vec<ClipXml>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ClipXml {
    #[serde(
        rename = "@ref_block",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    ref_block: Option<String>,
    #[serde(rename = "@start_sec")]
    start_sec: f64,
    #[serde(rename = "@duration_sec")]
    duration_sec: f64,
    #[serde(rename = "@fade_in_sec", default)]
    fade_in_sec: f32,
    #[serde(rename = "@fade_out_sec", default)]
    fade_out_sec: f32,
    #[serde(rename = "$value", default)]
    elements: Vec<FxElementXml>,
}

// =========================================================================
// Migration & Version Helpers
// =========================================================================

fn parse_version_tuple(v: &str) -> (u32, u32) {
    let mut parts = v.trim().split('.');
    let maj = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(1);
    let min = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    (maj, min)
}

fn extract_root_version(xml: &str) -> Option<String> {
    let idx = xml.find("<TaktLightShow")?;
    let end = xml[idx..].find('>')?;
    let tag = &xml[idx..idx + end];
    let v_idx = tag.find("version=")?;
    let rest = &tag[v_idx + "version=".len()..];
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let after_quote = &rest[1..];
    let close = after_quote.find(quote)?;
    Some(after_quote[..close].to_string())
}

pub fn migrate_v0_9_to_v1_0(raw_xml: &str) -> String {
    let mut migrated = raw_xml
        .replace("version=\"0.9\"", "version=\"1.0\"")
        .replace("version='0.9'", "version='1.0'");
    if !migrated.contains("offline_fallback=") {
        migrated = migrated.replace(
            "<NetworkOutputs ",
            "<NetworkOutputs offline_fallback=\"true\" ",
        );
    }
    migrated
}

// =========================================================================
// Conversions (XML <-> Domain)
// =========================================================================

fn fx_from_xml(el: FxElementXml) -> Result<FxElementDef, ShowError> {
    match el {
        FxElementXml::StaticTrait {
            trait_name,
            op,
            palette_ref,
            value_start,
            value_end,
            order,
        } => Ok(FxElementDef::StaticTrait {
            trait_name,
            op,
            palette_ref,
            value_start,
            value_end,
            order: order.as_deref().map(OrderRule::from_str).transpose()?,
        }),
        FxElementXml::Curve1D {
            trait_name,
            op,
            waveform,
            amplitude,
            offset,
            rate_beats,
            speed_hz,
            phase_spread_deg,
            duty,
            palette_ref,
            order,
        } => Ok(FxElementDef::Curve1D {
            trait_name,
            op,
            waveform,
            amplitude,
            offset,
            rate_beats,
            speed_hz,
            phase_spread_deg,
            duty,
            palette_ref,
            order: order.as_deref().map(OrderRule::from_str).transpose()?,
        }),
        FxElementXml::StepChase {
            trait_name,
            op,
            step_beats,
            speed_hz,
            active_ratio,
            fade,
            amplitude,
            palette_ref,
            order,
        } => Ok(FxElementDef::StepChase {
            trait_name,
            op,
            step_beats,
            speed_hz,
            active_ratio,
            fade,
            amplitude,
            palette_ref,
            order: order.as_deref().map(OrderRule::from_str).transpose()?,
        }),
        FxElementXml::SpatialShader2D {
            trait_name,
            op,
            shader,
            palette_ref,
            rate_beats,
            speed_hz,
            spatial_freq,
            direction_deg,
            center_x,
            center_y,
        } => Ok(FxElementDef::SpatialShader2D {
            trait_name,
            op,
            shader,
            palette_ref,
            rate_beats,
            speed_hz,
            spatial_freq,
            direction_deg,
            center_x,
            center_y,
        }),
    }
}

fn fx_to_xml(el: &FxElementDef) -> FxElementXml {
    match el {
        FxElementDef::StaticTrait {
            trait_name,
            op,
            palette_ref,
            value_start,
            value_end,
            order,
        } => FxElementXml::StaticTrait {
            trait_name: trait_name.clone(),
            op: op.clone(),
            palette_ref: palette_ref.clone(),
            value_start: *value_start,
            value_end: *value_end,
            order: order.map(|o| o.to_string()),
        },
        FxElementDef::Curve1D {
            trait_name,
            op,
            waveform,
            amplitude,
            offset,
            rate_beats,
            speed_hz,
            phase_spread_deg,
            duty,
            palette_ref,
            order,
        } => FxElementXml::Curve1D {
            trait_name: trait_name.clone(),
            op: op.clone(),
            waveform: waveform.clone(),
            amplitude: *amplitude,
            offset: *offset,
            rate_beats: *rate_beats,
            speed_hz: *speed_hz,
            phase_spread_deg: *phase_spread_deg,
            duty: *duty,
            palette_ref: palette_ref.clone(),
            order: order.map(|o| o.to_string()),
        },
        FxElementDef::StepChase {
            trait_name,
            op,
            step_beats,
            speed_hz,
            active_ratio,
            fade,
            amplitude,
            palette_ref,
            order,
        } => FxElementXml::StepChase {
            trait_name: trait_name.clone(),
            op: op.clone(),
            step_beats: *step_beats,
            speed_hz: *speed_hz,
            active_ratio: *active_ratio,
            fade: *fade,
            amplitude: *amplitude,
            palette_ref: palette_ref.clone(),
            order: order.map(|o| o.to_string()),
        },
        FxElementDef::SpatialShader2D {
            trait_name,
            op,
            shader,
            palette_ref,
            rate_beats,
            speed_hz,
            spatial_freq,
            direction_deg,
            center_x,
            center_y,
        } => FxElementXml::SpatialShader2D {
            trait_name: trait_name.clone(),
            op: op.clone(),
            shader: shader.clone(),
            palette_ref: palette_ref.clone(),
            rate_beats: *rate_beats,
            speed_hz: *speed_hz,
            spatial_freq: *spatial_freq,
            direction_deg: *direction_deg,
            center_x: *center_x,
            center_y: *center_y,
        },
    }
}

pub fn serialize_show_xml(show: &ShowState) -> Result<String, ShowError> {
    if show.read_only_newer_version {
        return Err(ShowError::ReadOnlyNewerSchema(show.version.clone()));
    }

    let universes_xml: Vec<UniverseXml> = show
        .network_outputs
        .universes
        .iter()
        .map(|u| match &u.protocol {
            ProtocolKind::ArtNet {
                mode,
                net,
                subnet,
                uni,
            } => {
                let (mode_str, target_ip) = match mode {
                    ArtNetOutputMode::Broadcast => ("broadcast".to_string(), None),
                    ArtNetOutputMode::Unicast { target_ip } => {
                        ("unicast".to_string(), Some(target_ip.to_string()))
                    }
                };
                UniverseXml {
                    id: u.id,
                    protocol: "artnet".to_string(),
                    mode: mode_str,
                    target_ip,
                    net: Some(*net),
                    subnet: Some(*subnet),
                    uni: Some(*uni),
                    sacn_universe: None,
                    priority: None,
                }
            }
            ProtocolKind::Sacn {
                mode,
                sacn_universe,
                priority,
            } => {
                let (mode_str, target_ip) = match mode {
                    SacnOutputMode::Multicast => ("multicast".to_string(), None),
                    SacnOutputMode::Unicast { target_ip } => {
                        ("unicast".to_string(), Some(target_ip.to_string()))
                    }
                };
                UniverseXml {
                    id: u.id,
                    protocol: "sacn".to_string(),
                    mode: mode_str,
                    target_ip,
                    net: None,
                    subnet: None,
                    uni: None,
                    sacn_universe: Some(*sacn_universe),
                    priority: Some(*priority),
                }
            }
        })
        .collect();

    let mut palette_items = Vec::new();
    for cp in &show.color_palettes {
        palette_items.push(PaletteItemXml::ColorPalette {
            id: cp.id.clone(),
            name: cp.name.clone(),
            hex_start: cp.hex_start.clone(),
            hex_end: cp.hex_end.clone(),
        });
    }
    for dp in &show.dimmer_palettes {
        palette_items.push(PaletteItemXml::DimmerPalette {
            id: dp.id.clone(),
            name: dp.name.clone(),
            value_start: dp.value_start,
            value_end: dp.value_end,
        });
    }

    let fixtures_xml: Vec<FixtureInstanceXml> = show
        .patch
        .iter()
        .map(|fx| FixtureInstanceXml {
            id: fx.id.clone(),
            profile: fx.profile.clone(),
            mode: fx.mode.clone(),
            name: fx.name.clone(),
            universe: fx.universe,
            address: fx.address,
            channel_count: Some(fx.channel_count),
            grid_pos: GridPosXml {
                x: fx.grid_pos.x,
                y: fx.grid_pos.y,
                rotation: fx.grid_pos.rotation,
                scale_x: fx.grid_pos.scale_x,
                scale_y: fx.grid_pos.scale_y,
            },
            calibration: CalibrationXml {
                gamma: fx.calibration.gamma,
                min_dimmer_dmx: fx.calibration.min_dimmer_dmx,
                max_dimmer_dmx: fx.calibration.max_dimmer_dmx,
                white_mode: match fx.calibration.white_mode {
                    WhiteMode::Replace => "replace".to_string(),
                    WhiteMode::Add => "add".to_string(),
                    WhiteMode::Off => "off".to_string(),
                },
                white_gain: fx.calibration.white_gain,
            },
        })
        .collect();

    let groups_xml: Vec<GroupXml> = show
        .groups
        .iter()
        .map(|g| GroupXml {
            id: g.id.clone(),
            name: g.name.clone(),
            order: g.order.to_string(),
            targets: g
                .targets
                .iter()
                .map(|t| TargetXml {
                    target_ref: t.clone(),
                })
                .collect(),
        })
        .collect();

    let fx_blocks_xml: Vec<FxBlockXml> = show
        .fx_library
        .iter()
        .map(|b| FxBlockXml {
            id: b.id.clone(),
            name: b.name.clone(),
            target_group: b.target_group.clone(),
            duration_beats: b.duration_beats,
            loop_block: b.loop_block,
            elements: b.elements.iter().map(fx_to_xml).collect(),
        })
        .collect();

    let scenes_xml: Vec<SceneXml> = show
        .scenes
        .iter()
        .map(|s| SceneXml {
            id: s.id.clone(),
            name: s.name.clone(),
            bank: s.bank.clone(),
            target_group: s.target_group.clone(),
            priority: s.priority,
            fade_in_sec: s.fade_in_sec,
            fade_out_sec: s.fade_out_sec,
            block_refs: s
                .block_refs
                .iter()
                .map(|r| BlockRefXml { ref_id: r.clone() })
                .collect(),
        })
        .collect();

    let timelines_xml: Vec<TimelineXml> = show
        .timelines
        .iter()
        .map(|tl| TimelineXml {
            id: tl.id.clone(),
            name: tl.name.clone(),
            duration_sec: tl.duration_sec,
            grid_offset_sec: tl.grid_offset_sec,
            tempo_map: TempoMapXml {
                tempos: tl
                    .tempo_map
                    .iter()
                    .map(|t| TempoXml {
                        at_sec: t.at_sec,
                        bpm: t.bpm,
                    })
                    .collect(),
            },
            audio_track: tl.audio_track.as_ref().map(|a| AudioTrackXml {
                file: a.file.clone(),
                abs_fallback: a.abs_fallback.clone(),
                sha256: a.sha256.clone(),
                offset_sec: a.offset_sec,
                transient_sensitivity: a.transient_sensitivity,
            }),
            tracks: tl
                .tracks
                .iter()
                .map(|tr| TrackXml {
                    id: tr.id.clone(),
                    name: tr.name.clone(),
                    target_group: tr.target_group.clone(),
                    clips: tr
                        .clips
                        .iter()
                        .map(|c| ClipXml {
                            ref_block: c.ref_block.clone(),
                            start_sec: c.start_sec,
                            duration_sec: c.duration_sec,
                            fade_in_sec: c.fade_in_sec,
                            fade_out_sec: c.fade_out_sec,
                            elements: c.inline_fx.iter().map(fx_to_xml).collect(),
                        })
                        .collect(),
                })
                .collect(),
        })
        .collect();

    let xml_doc = TaktLightShowXml {
        version: CURRENT_SHOW_SCHEMA_VERSION.to_string(),
        name: show.name.clone(),
        bpm: show.bpm,
        network_outputs: NetworkOutputsXml {
            frame_rate_hz: show.network_outputs.frame_rate_hz,
            adapter: show.network_outputs.adapter.clone(),
            subnet: show.network_outputs.subnet.clone(),
            offline_fallback: show.network_outputs.offline_fallback,
            artsync: show.network_outputs.artsync,
            universes: universes_xml,
        },
        palettes: PalettesXml {
            items: palette_items,
        },
        patch: PatchXml {
            fixtures: fixtures_xml,
        },
        groups: GroupsXml { groups: groups_xml },
        fx_library: FxLibraryXml {
            blocks: fx_blocks_xml,
        },
        scenes: ScenesXml { scenes: scenes_xml },
        timelines: TimelinesXml {
            timelines: timelines_xml,
        },
    };

    let mut buffer = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    let mut ser = Serializer::with_root(&mut buffer, Some("TaktLightShow"))
        .map_err(|e| ShowError::Xml(e.to_string()))?;
    ser.indent(' ', 2);
    xml_doc
        .serialize(ser)
        .map_err(|e| ShowError::Xml(e.to_string()))?;
    buffer.push('\n');
    Ok(buffer)
}

pub fn deserialize_show_xml(raw_xml: &str) -> Result<ShowState, ShowError> {
    let raw_version = extract_root_version(raw_xml)
        .ok_or_else(|| ShowError::Xml("missing mandatory root version attribute".to_string()))?;
    let ver_tuple = parse_version_tuple(&raw_version);
    let current_tuple = parse_version_tuple(CURRENT_SHOW_SCHEMA_VERSION);

    let read_only_newer = ver_tuple > current_tuple;
    let migrated_xml = if ver_tuple < current_tuple {
        migrate_v0_9_to_v1_0(raw_xml)
    } else {
        raw_xml.to_string()
    };

    let parsed: TaktLightShowXml =
        xml_from_str(&migrated_xml).map_err(|e| ShowError::Xml(e.to_string()))?;

    let mut universes = Vec::with_capacity(parsed.network_outputs.universes.len());
    for u in parsed.network_outputs.universes {
        let protocol = match u.protocol.as_str() {
            "artnet" => {
                let mode = match u.mode.as_str() {
                    "unicast" => {
                        let ip_str = u.target_ip.as_deref().ok_or_else(|| {
                            ShowError::Xml(format!("ArtNet unicast universe {} missing target_ip", u.id))
                        })?;
                        let target_ip: Ipv4Addr = ip_str
                            .parse()
                            .map_err(|_| ShowError::Xml(format!("invalid IPv4 '{ip_str}'")))?;
                        ArtNetOutputMode::Unicast { target_ip }
                    }
                    _ => ArtNetOutputMode::Broadcast,
                };
                ProtocolKind::ArtNet {
                    mode,
                    net: u.net.unwrap_or(0),
                    subnet: u.subnet.unwrap_or(0),
                    uni: u.uni.unwrap_or(0),
                }
            }
            "sacn" => {
                let mode = match u.mode.as_str() {
                    "unicast" => {
                        let ip_str = u.target_ip.as_deref().ok_or_else(|| {
                            ShowError::Xml(format!("sACN unicast universe {} missing target_ip", u.id))
                        })?;
                        let target_ip: Ipv4Addr = ip_str
                            .parse()
                            .map_err(|_| ShowError::Xml(format!("invalid IPv4 '{ip_str}'")))?;
                        SacnOutputMode::Unicast { target_ip }
                    }
                    _ => SacnOutputMode::Multicast,
                };
                ProtocolKind::Sacn {
                    mode,
                    sacn_universe: u.sacn_universe.unwrap_or(u.id),
                    priority: u.priority.unwrap_or(100),
                }
            }
            other => {
                return Err(ShowError::Xml(format!(
                    "unsupported universe protocol '{other}'"
                )))
            }
        };
        universes.push(UniverseConfig::new(u.id, protocol));
    }

    let mut color_palettes = Vec::new();
    let mut dimmer_palettes = Vec::new();
    for item in parsed.palettes.items {
        match item {
            PaletteItemXml::ColorPalette {
                id,
                name,
                hex_start,
                hex_end,
            } => color_palettes.push(ColorPaletteDef {
                id,
                name,
                hex_start,
                hex_end,
            }),
            PaletteItemXml::DimmerPalette {
                id,
                name,
                value_start,
                value_end,
            } => dimmer_palettes.push(DimmerPaletteDef {
                id,
                name,
                value_start,
                value_end,
            }),
        }
    }

    let palette_ids: HashSet<String> = color_palettes
        .iter()
        .map(|p| p.id.clone())
        .chain(dimmer_palettes.iter().map(|p| p.id.clone()))
        .collect();

    let mut patch = Vec::with_capacity(parsed.patch.fixtures.len());
    for fx in parsed.patch.fixtures {
        let white_mode = match fx.calibration.white_mode.as_str() {
            "add" => WhiteMode::Add,
            "off" => WhiteMode::Off,
            _ => WhiteMode::Replace,
        };
        patch.push(FixtureInstance {
            id: fx.id,
            profile: fx.profile,
            mode: fx.mode,
            name: fx.name,
            universe: fx.universe,
            address: fx.address,
            channel_count: fx.channel_count.unwrap_or(1),
            grid_pos: GridPos {
                x: fx.grid_pos.x,
                y: fx.grid_pos.y,
                rotation: fx.grid_pos.rotation,
                scale_x: fx.grid_pos.scale_x,
                scale_y: fx.grid_pos.scale_y,
            },
            calibration: FixtureCalibration {
                gamma: fx.calibration.gamma,
                min_dimmer_dmx: fx.calibration.min_dimmer_dmx,
                max_dimmer_dmx: fx.calibration.max_dimmer_dmx,
                white_mode,
                white_gain: fx.calibration.white_gain,
            },
        });
    }
    validate_patch_no_collisions(&patch)?;

    let mut groups = Vec::with_capacity(parsed.groups.groups.len());
    for g in parsed.groups.groups {
        groups.push(FixtureGroupDef {
            id: g.id,
            name: g.name,
            order: OrderRule::from_str(&g.order)?,
            targets: g.targets.into_iter().map(|t| t.target_ref).collect(),
        });
    }

    let mut fx_library = Vec::with_capacity(parsed.fx_library.blocks.len());
    let mut block_map: HashMap<String, Option<String>> = HashMap::new();
    for b in parsed.fx_library.blocks {
        let mut elements = Vec::with_capacity(b.elements.len());
        for el in b.elements {
            let conv = fx_from_xml(el)?;
            validate_fx_palette_ref(&conv, &palette_ids)?;
            elements.push(conv);
        }
        block_map.insert(b.id.clone(), b.target_group.clone());
        fx_library.push(FxBlockDef {
            id: b.id,
            name: b.name,
            target_group: b.target_group,
            duration_beats: b.duration_beats,
            loop_block: b.loop_block,
            elements,
        });
    }

    let mut scenes = Vec::with_capacity(parsed.scenes.scenes.len());
    for s in parsed.scenes.scenes {
        let refs: Vec<String> = s.block_refs.into_iter().map(|r| r.ref_id).collect();
        for ref_id in &refs {
            let block_target = block_map.get(ref_id).ok_or_else(|| {
                ShowError::Xml(format!(
                    "scene '{}' references unknown FxBlock '{}'",
                    s.id, ref_id
                ))
            })?;
            if s.target_group.is_none() && block_target.is_none() {
                return Err(ShowError::MissingTargetGroup(ref_id.clone()));
            }
        }
        scenes.push(SceneDef {
            id: s.id,
            name: s.name,
            bank: s.bank,
            target_group: s.target_group,
            priority: s.priority,
            fade_in_sec: s.fade_in_sec,
            fade_out_sec: s.fade_out_sec,
            block_refs: refs,
        });
    }

    let mut timelines = Vec::with_capacity(parsed.timelines.timelines.len());
    for tl in parsed.timelines.timelines {
        let mut tracks = Vec::with_capacity(tl.tracks.len());
        for tr in tl.tracks {
            let mut clips = Vec::with_capacity(tr.clips.len());
            for c in tr.clips {
                if let Some(ref_id) = &c.ref_block {
                    let block_target = block_map.get(ref_id).ok_or_else(|| {
                        ShowError::Xml(format!(
                            "clip in track '{}' references unknown FxBlock '{}'",
                            tr.id, ref_id
                        ))
                    })?;
                    if tr.target_group.is_none() && block_target.is_none() {
                        return Err(ShowError::MissingTargetGroup(ref_id.clone()));
                    }
                } else if tr.target_group.is_none() && !c.elements.is_empty() {
                    return Err(ShowError::MissingTargetGroup(tr.id.clone()));
                }

                let mut inline_fx = Vec::with_capacity(c.elements.len());
                for el in c.elements {
                    let conv = fx_from_xml(el)?;
                    validate_fx_palette_ref(&conv, &palette_ids)?;
                    inline_fx.push(conv);
                }
                clips.push(ClipDef {
                    ref_block: c.ref_block,
                    start_sec: c.start_sec,
                    duration_sec: c.duration_sec,
                    fade_in_sec: c.fade_in_sec,
                    fade_out_sec: c.fade_out_sec,
                    inline_fx,
                });
            }
            tracks.push(TrackDef {
                id: tr.id,
                name: tr.name,
                target_group: tr.target_group,
                clips,
            });
        }

        timelines.push(TimelineDef {
            id: tl.id,
            name: tl.name,
            duration_sec: tl.duration_sec,
            grid_offset_sec: tl.grid_offset_sec,
            tempo_map: tl
                .tempo_map
                .tempos
                .into_iter()
                .map(|t| TempoPointDef {
                    at_sec: t.at_sec,
                    bpm: t.bpm,
                })
                .collect(),
            audio_track: tl.audio_track.map(|a| AudioTrackDef {
                file: a.file,
                abs_fallback: a.abs_fallback,
                sha256: a.sha256,
                offset_sec: a.offset_sec,
                transient_sensitivity: a.transient_sensitivity,
            }),
            tracks,
        });
    }

    Ok(ShowState {
        version: if read_only_newer {
            raw_version
        } else {
            CURRENT_SHOW_SCHEMA_VERSION.to_string()
        },
        name: parsed.name,
        bpm: parsed.bpm,
        read_only_newer_version: read_only_newer,
        network_outputs: NetworkOutputsConfig {
            frame_rate_hz: parsed.network_outputs.frame_rate_hz,
            adapter: parsed.network_outputs.adapter,
            subnet: parsed.network_outputs.subnet,
            offline_fallback: parsed.network_outputs.offline_fallback,
            artsync: parsed.network_outputs.artsync,
            universes,
        },
        color_palettes,
        dimmer_palettes,
        patch,
        groups,
        fx_library,
        scenes,
        timelines,
    })
}

fn validate_fx_palette_ref(el: &FxElementDef, palette_ids: &HashSet<String>) -> Result<(), ShowError> {
    let pref = match el {
        FxElementDef::StaticTrait { palette_ref, .. }
        | FxElementDef::Curve1D { palette_ref, .. }
        | FxElementDef::StepChase { palette_ref, .. }
        | FxElementDef::SpatialShader2D { palette_ref, .. } => palette_ref.as_deref(),
    };
    if let Some(id) = pref {
        if !palette_ids.contains(id) {
            return Err(ShowError::Xml(format!(
                "FX element references unknown palette '{id}'"
            )));
        }
    }
    Ok(())
}

// =========================================================================
// Audio Relinking & SHA-256 Verification
// =========================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioRelinkStatus {
    Matched(PathBuf),
    HashMismatch {
        path: PathBuf,
        expected: String,
        actual: String,
    },
    Missing,
}

pub fn compute_file_sha256_hex(path: &Path) -> Result<String, ShowError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn resolve_audio_track_path(show_dir: &Path, track: &AudioTrackDef) -> AudioRelinkStatus {
    let rel = show_dir.join(&track.file);
    let candidate = if rel.exists() {
        Some(rel)
    } else if let Some(abs) = &track.abs_fallback {
        let abs_path = PathBuf::from(abs);
        if abs_path.exists() {
            Some(abs_path)
        } else {
            None
        }
    } else {
        None
    };

    let Some(path) = candidate else {
        return AudioRelinkStatus::Missing;
    };

    if let Some(expected) = &track.sha256 {
        if let Ok(actual) = compute_file_sha256_hex(&path) {
            if &actual != expected {
                return AudioRelinkStatus::HashMismatch {
                    path,
                    expected: expected.clone(),
                    actual,
                };
            }
        }
    }

    AudioRelinkStatus::Matched(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const ARCHITECTURE_REFERENCE_XML: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<TaktLightShow version="1.0" name="Studio Lightshow" bpm="128.0">
  <NetworkOutputs frame_rate_hz="44" adapter="auto" offline_fallback="true" artsync="true">
    <Universe id="1" protocol="artnet" mode="unicast" target_ip="192.168.1.50" net="0" subnet="0" uni="0" />
    <Universe id="2" protocol="sacn" mode="multicast" sacn_universe="2" priority="100" />
    <Universe id="3" protocol="sacn" mode="unicast" target_ip="192.168.1.60" sacn_universe="3" priority="100" />
  </NetworkOutputs>

  <Palettes>
    <ColorPalette id="pal_cyber" name="Cyberpunk Dual" hex_start="#FF5500" hex_end="#2255AA" />
    <ColorPalette id="pal_warm" name="Warm Tungsten" hex_start="#FFAA44" hex_end="#FF8822" />
    <DimmerPalette id="dim_half" name="Studio 60%" value_start="0.60" value_end="0.60" />
  </Palettes>

  <Patch>
    <FixtureInstance id="fx_201" profile="age/rlcv3_8_segment_tube.json" mode="34ch Pixel Mode" name="Tube Left" universe="1" address="1">
      <GridPos x="0.25" y="0.20" rotation="90.0" scale_x="0.30" scale_y="0.04" />
      <Calibration gamma="2.2" min_dimmer_dmx="4" max_dimmer_dmx="255" white_mode="replace" white_gain="0.85" />
    </FixtureInstance>
  </Patch>

  <Groups>
    <Group id="grp_tubes_cells" name="All Tube Pixels" order="center_out">
      <Target ref="fx_201:0..7" />
    </Group>
  </Groups>

  <FxLibrary>
    <FxBlock id="blk_cyber_wave" name="Cyberpunk Sine Wave" target_group="grp_tubes_cells" duration_beats="4.0" loop="true">
      <StaticTrait trait="dimmer" op="htp" palette_ref="dim_half" />
      <StaticTrait trait="color" op="ltp" palette_ref="pal_cyber" order="mirror" />
      <Curve1D trait="dimmer" op="add" waveform="sine" amplitude="0.40" offset="0.0" rate_beats="2.0" phase_spread_deg="360.0" duty="0.50" />
      <StepChase trait="dimmer" op="htp" step_beats="0.5" active_ratio="0.25" fade="0.20" amplitude="1.0" />
    </FxBlock>
  </FxLibrary>

  <Scenes>
    <Scene id="sc_cyber_wave" name="Cyberpunk Sine Wave" bank="main" priority="10" fade_in_sec="0.5" fade_out_sec="1.0">
      <BlockRef ref="blk_cyber_wave" />
    </Scene>
  </Scenes>

  <Timelines>
    <Timeline id="tl_intro" name="Intro Timecode Track" duration_sec="95.4" grid_offset_sec="0.120">
      <TempoMap>
        <Tempo at_sec="0.0" bpm="128.0" />
      </TempoMap>
      <AudioTrack file="audio/intro_mix.wav" abs_fallback="C:/Audio/Studio/intro_mix.wav" sha256="9f2c" offset_sec="0.0" transient_sensitivity="0.65" />
      <Track id="trk_1" name="Tube Base &amp; Pulse" target_group="grp_tubes_cells">
        <Clip ref_block="blk_cyber_wave" start_sec="4.500" duration_sec="15.000" fade_in_sec="1.200" fade_out_sec="0.500" />
      </Track>
      <Track id="trk_2" name="Matrix Sweep" target_group="grp_tubes_cells">
        <Clip start_sec="12.000" duration_sec="8.000" fade_in_sec="0.0" fade_out_sec="1.0">
          <SpatialShader2D trait="color" op="ltp" shader="radial_wave" palette_ref="pal_cyber" rate_beats="2.0" spatial_freq="1.5" direction_deg="45.0" center_x="0.5" center_y="0.5" />
        </Clip>
      </Track>
    </Timeline>
  </Timelines>
</TaktLightShow>"##;

    #[test]
    fn round_trips_reference_takt_xml_show_file() {
        let show = deserialize_show_xml(ARCHITECTURE_REFERENCE_XML).expect("valid XML");
        assert_eq!(show.name, "Studio Lightshow");
        assert_eq!(show.bpm, 128.0);
        assert_eq!(show.network_outputs.universes.len(), 3);
        assert_eq!(show.color_palettes.len(), 2);
        assert_eq!(show.dimmer_palettes.len(), 1);
        assert_eq!(show.patch.len(), 1);
        assert_eq!(show.groups[0].order, OrderRule::CenterOut);
        assert_eq!(show.fx_library[0].elements.len(), 4);
        assert_eq!(show.scenes[0].block_refs, vec!["blk_cyber_wave"]);
        assert_eq!(show.timelines[0].tracks.len(), 2);

        let xml_out = serialize_show_xml(&show).expect("serialize");
        let show2 = deserialize_show_xml(&xml_out).expect("re-deserialize");
        assert_eq!(show2.name, show.name);
        assert_eq!(show2.patch, show.patch);
        assert_eq!(show2.fx_library, show.fx_library);
        assert_eq!(show2.timelines, show.timelines);
    }

    #[test]
    fn migrates_legacy_v0_9_and_opens_newer_v2_0_read_only() {
        let legacy = ARCHITECTURE_REFERENCE_XML
            .replace("version=\"1.0\"", "version=\"0.9\"")
            .replace("offline_fallback=\"true\" ", "");
        let migrated = deserialize_show_xml(&legacy).unwrap();
        assert_eq!(migrated.version, "1.0");
        assert!(!migrated.read_only_newer_version);
        assert!(migrated.network_outputs.offline_fallback);

        let newer = ARCHITECTURE_REFERENCE_XML.replace("version=\"1.0\"", "version=\"2.0\"");
        let ro = deserialize_show_xml(&newer).unwrap();
        assert!(ro.read_only_newer_version);
        assert!(matches!(
            serialize_show_xml(&ro),
            Err(ShowError::ReadOnlyNewerSchema(_))
        ));
    }

    #[test]
    fn rejects_missing_target_group_and_bad_palette_refs() {
        let missing_target = ARCHITECTURE_REFERENCE_XML
            .replace("target_group=\"grp_tubes_cells\" duration_beats", "duration_beats")
            .replace("<Track id=\"trk_1\" name=\"Tube Base &amp; Pulse\" target_group=\"grp_tubes_cells\">", "<Track id=\"trk_1\" name=\"Tube Base &amp; Pulse\">");
        assert!(matches!(
            deserialize_show_xml(&missing_target),
            Err(ShowError::MissingTargetGroup(_))
        ));

        let bad_palette = ARCHITECTURE_REFERENCE_XML.replace("palette_ref=\"pal_cyber\"", "palette_ref=\"pal_missing\"");
        assert!(deserialize_show_xml(&bad_palette).is_err());
    }

    #[test]
    fn relinks_audio_by_relative_fallback_and_sha256_check() {
        let dir = std::env::temp_dir().join(format!("taktlight_audio_relink_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let audio_dir = dir.join("audio");
        fs::create_dir_all(&audio_dir).unwrap();

        let rel_file = audio_dir.join("mix.wav");
        fs::write(&rel_file, b"RIFF_MOCK_AUDIO_BYTES").unwrap();
        let valid_hash = compute_file_sha256_hex(&rel_file).unwrap();

        let track = AudioTrackDef {
            file: "audio/mix.wav".to_string(),
            abs_fallback: None,
            sha256: Some(valid_hash.clone()),
            offset_sec: 0.0,
            transient_sensitivity: 0.65,
        };
        assert_eq!(
            resolve_audio_track_path(&dir, &track),
            AudioRelinkStatus::Matched(rel_file.clone())
        );

        let wrong_hash = AudioTrackDef {
            sha256: Some("deadbeef".to_string()),
            ..track.clone()
        };
        assert!(matches!(
            resolve_audio_track_path(&dir, &wrong_hash),
            AudioRelinkStatus::HashMismatch { .. }
        ));

        fs::remove_file(&rel_file).unwrap();
        assert_eq!(resolve_audio_track_path(&dir, &track), AudioRelinkStatus::Missing);

        let _ = fs::remove_dir_all(&dir);
    }
}
