use std::net::Ipv4Addr;

use serde::{Deserialize, Serialize};

use crate::mixer::color::{CompiledColorPalette, CompiledDimmerPalette};
use crate::mixer::traits::SmartControlLayer;
use crate::ofl::expander::{ChannelRole, ChannelTarget};
use crate::ofl::model::OflColor;
use crate::show::patch::FixtureCalibration;
use crate::show::spatial::OrderRule;
use crate::show::xml::{FxBlockDef, SceneDef, TimelineDef};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ArtNetOutputMode {
    Broadcast,
    Unicast { target_ip: Ipv4Addr },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum SacnOutputMode {
    Multicast,
    Unicast { target_ip: Ipv4Addr },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "protocol", rename_all = "snake_case")]
pub enum ProtocolKind {
    ArtNet {
        mode: ArtNetOutputMode,
        net: u8,
        subnet: u8,
        uni: u8,
    },
    Sacn {
        mode: SacnOutputMode,
        sacn_universe: u16,
        priority: u8,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UniverseConfig {
    pub id: u16,
    pub protocol: ProtocolKind,
    #[serde(default)]
    pub review_output: bool,
}

impl UniverseConfig {
    pub fn new(id: u16, protocol: ProtocolKind) -> Self {
        Self {
            id,
            protocol,
            review_output: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompiledCell {
    pub fixture_index: usize,
    pub fixture_id: String,
    pub cell_index: u16,
    pub pixel_key: String,
    pub canvas_xy: [f32; 2],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompiledChannelSlot {
    pub universe_id: u16,
    pub universe_index: Option<usize>,
    pub dmx_address: u16,
    pub name: String,
    pub default_value: u8,
    pub target: ChannelTarget,
    pub role: ChannelRole,
    pub fine_channel_offset: Option<usize>,
    #[serde(default)]
    pub wheel_slot_oklabs: Vec<Option<[f32; 3]>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompiledFixture {
    pub id: String,
    pub name: String,
    pub profile: String,
    pub mode: String,
    pub calibration: FixtureCalibration,
    pub cell_start: usize,
    pub cell_count: u16,
    pub channels: Vec<CompiledChannelSlot>,
    #[serde(default)]
    pub has_hardware_shutter: bool,
    #[serde(default)]
    pub fixture_has_master_intensity: bool,
    #[serde(default)]
    pub has_fixture_white: bool,
    #[serde(default)]
    pub cell_has_dedicated_intensity: Vec<bool>,
    #[serde(default)]
    pub cell_has_white: Vec<bool>,
}

impl CompiledFixture {
    pub fn compute_precomputed_flags(&mut self) {
        self.has_hardware_shutter = self
            .channels
            .iter()
            .any(|c| matches!(c.role, ChannelRole::ShutterStrobe { .. }));
        self.fixture_has_master_intensity = self
            .channels
            .iter()
            .any(|c| c.target == ChannelTarget::Fixture && c.role == ChannelRole::Intensity);
        self.has_fixture_white = self.channels.iter().any(|c| {
            matches!(
                c.role,
                ChannelRole::ColorIntensity {
                    color: OflColor::White | OflColor::WarmWhite | OflColor::ColdWhite
                }
            )
        });
        let n = self.cell_count as usize;
        self.cell_has_dedicated_intensity = vec![false; n];
        self.cell_has_white = vec![false; n];
        for ch in &self.channels {
            if let ChannelTarget::Cell { cell_index, .. } = ch.target {
                let idx = cell_index as usize;
                if idx < n {
                    if ch.role == ChannelRole::Intensity {
                        self.cell_has_dedicated_intensity[idx] = true;
                    }
                    if matches!(
                        ch.role,
                        ChannelRole::ColorIntensity {
                            color: OflColor::White | OflColor::WarmWhite | OflColor::ColdWhite
                        }
                    ) {
                        self.cell_has_white[idx] = true;
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompiledGroup {
    pub id: String,
    pub name: String,
    pub order: OrderRule,
    pub cells: Vec<(usize, f32)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RenderPlan {
    pub revision: u64,
    pub universes: Vec<UniverseConfig>,
    pub artsync_enabled: bool,
    pub cell_count: u32,
    pub base_dmx: Vec<[u8; 512]>,
    pub fixtures: Vec<CompiledFixture>,
    pub cells: Vec<CompiledCell>,
    pub groups: Vec<CompiledGroup>,
    pub color_palettes: Vec<CompiledColorPalette>,
    pub dimmer_palettes: Vec<CompiledDimmerPalette>,
    pub static_layers: Vec<SmartControlLayer>,
    pub show_bpm: f32,
    pub fx_blocks: Vec<FxBlockDef>,
    pub scenes: Vec<SceneDef>,
    pub timelines: Vec<TimelineDef>,
}

impl Default for RenderPlan {
    fn default() -> Self {
        Self::default_studio_plan()
    }
}

impl RenderPlan {
    pub fn default_studio_plan() -> Self {
        Self {
            revision: 1,
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
                    ProtocolKind::ArtNet {
                        mode: ArtNetOutputMode::Broadcast,
                        net: 0,
                        subnet: 0,
                        uni: 1,
                    },
                ),
            ],
            artsync_enabled: true,
            cell_count: 0,
            base_dmx: vec![[0u8; 512], [0u8; 512]],
            fixtures: Vec::new(),
            cells: Vec::new(),
            groups: Vec::new(),
            color_palettes: Vec::new(),
            dimmer_palettes: Vec::new(),
            static_layers: Vec::new(),
            show_bpm: 120.0,
            fx_blocks: Vec::new(),
            scenes: Vec::new(),
            timelines: Vec::new(),
        }
    }
}
