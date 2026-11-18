use std::net::Ipv4Addr;

use serde::{Deserialize, Serialize};

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
}

#[derive(Debug, Clone, PartialEq)]
pub struct RenderPlan {
    pub revision: u64,
    pub universes: Vec<UniverseConfig>,
    pub artsync_enabled: bool,
    pub cell_count: u32,
    pub base_dmx: Vec<[u8; 512]>,
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
                UniverseConfig {
                    id: 1,
                    protocol: ProtocolKind::ArtNet {
                        mode: ArtNetOutputMode::Broadcast,
                        net: 0,
                        subnet: 0,
                        uni: 0,
                    },
                },
                UniverseConfig {
                    id: 2,
                    protocol: ProtocolKind::Sacn {
                        mode: SacnOutputMode::Multicast,
                        sacn_universe: 2,
                        priority: 100,
                    },
                },
            ],
            artsync_enabled: true,
            cell_count: 0,
            base_dmx: vec![[0u8; 512], [0u8; 512]],
        }
    }
}
