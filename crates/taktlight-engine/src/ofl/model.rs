use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum OflColor {
    Red,
    Green,
    Blue,
    Cyan,
    Magenta,
    Yellow,
    Amber,
    White,
    #[serde(rename = "Warm White")]
    WarmWhite,
    #[serde(rename = "Cold White")]
    ColdWhite,
    #[serde(rename = "UV")]
    Uv,
    Lime,
    Indigo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum OflShutterEffect {
    Open,
    Closed,
    Strobe,
    Pulse,
    RampUp,
    RampDown,
    RampUpDown,
    Lightning,
    Spikes,
    Burst,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum OflWheelSlotType {
    Open,
    Closed,
    Color,
    Gobo,
    Prism,
    Frost,
    Iris,
    AnimationGoboStart,
    AnimationGoboEnd,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OflWheelSlot {
    #[serde(rename = "type")]
    pub slot_type: OflWheelSlotType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub colors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OflWheel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    pub slots: Vec<OflWheelSlot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OflDefaultValue {
    Integer(u8),
    Float(f64),
    Percent(String),
}

impl OflDefaultValue {
    pub fn to_dmx_byte(&self) -> u8 {
        match self {
            Self::Integer(v) => *v,
            Self::Float(v) => v.round().clamp(0.0, 255.0) as u8,
            Self::Percent(s) => {
                let trimmed = s.trim();
                if let Some(pct_str) = trimmed.strip_suffix('%') {
                    if let Ok(pct) = pct_str.trim().parse::<f64>() {
                        return ((pct.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8;
                    }
                }
                trimmed
                    .parse::<f64>()
                    .map(|v| v.round().clamp(0.0, 255.0) as u8)
                    .unwrap_or(0)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OflWheelRef {
    Single(String),
    Multiple(Vec<String>),
}

impl OflWheelRef {
    pub fn primary_name(&self) -> Option<&str> {
        match self {
            Self::Single(s) => Some(s.as_str()),
            Self::Multiple(list) => list.first().map(|s| s.as_str()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OflCapability {
    #[serde(rename = "type")]
    pub cap_type: String,
    #[serde(rename = "dmxRange", skip_serializing_if = "Option::is_none")]
    pub dmx_range: Option<[u8; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<OflColor>,
    #[serde(rename = "shutterEffect", skip_serializing_if = "Option::is_none")]
    pub shutter_effect: Option<OflShutterEffect>,
    #[serde(rename = "randomTiming", skip_serializing_if = "Option::is_none")]
    pub random_timing: Option<bool>,
    #[serde(rename = "speedStart", skip_serializing_if = "Option::is_none")]
    pub speed_start: Option<String>,
    #[serde(rename = "speedEnd", skip_serializing_if = "Option::is_none")]
    pub speed_end: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wheel: Option<OflWheelRef>,
    #[serde(rename = "slotNumber", skip_serializing_if = "Option::is_none")]
    pub slot_number: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OflChannel {
    #[serde(rename = "defaultValue", skip_serializing_if = "Option::is_none")]
    pub default_value: Option<OflDefaultValue>,
    #[serde(rename = "highlightValue", skip_serializing_if = "Option::is_none")]
    pub highlight_value: Option<OflDefaultValue>,
    #[serde(
        rename = "fineChannelAliases",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub fine_channel_aliases: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precedence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability: Option<OflCapability>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<OflCapability>,
}

impl OflChannel {
    pub fn resolved_capabilities(&self) -> Vec<OflCapability> {
        if let Some(cap) = &self.capability {
            let mut single = cap.clone();
            if single.dmx_range.is_none() {
                single.dmx_range = Some([0, 255]);
            }
            vec![single]
        } else {
            self.capabilities.clone()
        }
    }

    pub fn default_dmx_byte(&self) -> u8 {
        self.default_value
            .as_ref()
            .map(OflDefaultValue::to_dmx_byte)
            .unwrap_or(0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OflMeta {
    pub authors: Vec<String>,
    #[serde(rename = "createDate")]
    pub create_date: String,
    #[serde(rename = "lastModifyDate")]
    pub last_modify_date: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OflMatrix {
    #[serde(rename = "pixelCount", skip_serializing_if = "Option::is_none")]
    pub pixel_count: Option<[u16; 3]>,
    #[serde(rename = "pixelKeys", skip_serializing_if = "Option::is_none")]
    pub pixel_keys: Option<serde_json::Value>,
    #[serde(
        rename = "pixelGroups",
        default,
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub pixel_groups: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChannelOrder {
    #[serde(rename = "perPixel")]
    PerPixel,
    #[serde(rename = "perChannel")]
    PerChannel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OflRepeatFor {
    Order(String),
    ExplicitKeys(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OflMatrixChannelInsert {
    pub insert: String,
    #[serde(rename = "repeatFor")]
    pub repeat_for: OflRepeatFor,
    #[serde(rename = "channelOrder")]
    pub channel_order: ChannelOrder,
    #[serde(rename = "templateChannels")]
    pub template_channels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OflModeChannelEntry {
    Direct(Option<String>),
    MatrixInsert(OflMatrixChannelInsert),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OflMode {
    pub name: String,
    #[serde(rename = "shortName", skip_serializing_if = "Option::is_none")]
    pub short_name: Option<String>,
    pub channels: Vec<OflModeChannelEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OflFixtureDefinition {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    #[serde(rename = "shortName", skip_serializing_if = "Option::is_none")]
    pub short_name: Option<String>,
    pub categories: Vec<String>,
    pub meta: OflMeta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matrix: Option<OflMatrix>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub wheels: BTreeMap<String, OflWheel>,
    #[serde(
        rename = "availableChannels",
        default,
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub available_channels: BTreeMap<String, OflChannel>,
    #[serde(
        rename = "templateChannels",
        default,
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub template_channels: BTreeMap<String, OflChannel>,
    pub modes: Vec<OflMode>,
}

pub fn parse_frequency_hz(raw: &str) -> Option<f32> {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    let num_part = lower.strip_suffix("hz")?.trim();
    num_part.parse::<f32>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frequency_strings_and_default_values() {
        assert_eq!(parse_frequency_hz("1Hz"), Some(1.0));
        assert_eq!(parse_frequency_hz("20Hz"), Some(20.0));
        assert_eq!(parse_frequency_hz("12.5 Hz"), Some(12.5));
        assert_eq!(parse_frequency_hz("invalid"), None);

        assert_eq!(OflDefaultValue::Integer(128).to_dmx_byte(), 128);
        assert_eq!(OflDefaultValue::Percent("50%".into()).to_dmx_byte(), 128);
        assert_eq!(OflDefaultValue::Percent("100%".into()).to_dmx_byte(), 255);
    }
}
