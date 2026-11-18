use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::matrix::{expand_canonical_matrix_cells, order_matrix_cells_for_repeat, MatrixCell};
use super::model::{
    parse_frequency_hz, ChannelOrder, OflCapability, OflChannel, OflColor, OflFixtureDefinition,
    OflModeChannelEntry, OflShutterEffect,
};
use super::OflError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrobeRange {
    pub dmx_range: [u8; 2],
    pub effect: OflShutterEffect,
    pub random_timing: bool,
    pub speed_start_hz: Option<f32>,
    pub speed_end_hz: Option<f32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedWheelSlot {
    pub slot_number: u16,
    pub dmx_range: [u8; 2],
    pub name: Option<String>,
    pub colors_hex: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChannelRole {
    Intensity,
    ColorIntensity {
        color: OflColor,
    },
    ShutterStrobe {
        capabilities: Vec<StrobeRange>,
    },
    WheelSlot {
        wheel_name: Option<String>,
        slots: Vec<ResolvedWheelSlot>,
    },
    FineAlias {
        parent_channel_name: String,
        parent_offset: usize,
        resolution_byte_index: usize,
    },
    Unmapped {
        capability_type: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
pub enum ChannelTarget {
    Fixture,
    Cell {
        cell_index: u16,
        pixel_key: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExpandedChannel {
    pub dmx_offset: usize,
    pub channel_number: u16,
    pub name: String,
    pub default_value: u8,
    pub target: ChannelTarget,
    pub role: ChannelRole,
    pub fine_channel_offset: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExpandedFixtureMode {
    pub name: String,
    pub short_name: String,
    pub channel_count: usize,
    pub cells: Vec<MatrixCell>,
    pub channels: Vec<ExpandedChannel>,
}

struct PendingChannel {
    name: String,
    def: Option<OflChannel>,
    target: ChannelTarget,
}

fn classify_channel_role(
    fixture: &OflFixtureDefinition,
    channel: &OflChannel,
) -> ChannelRole {
    let caps = channel.resolved_capabilities();
    if caps.is_empty() {
        return ChannelRole::Unmapped {
            capability_type: "NoFunction".into(),
        };
    }

    // Single-capability Intensity or ColorIntensity
    if caps.len() == 1 {
        let c = &caps[0];
        match c.cap_type.as_str() {
            "Intensity" => return ChannelRole::Intensity,
            "ColorIntensity" => {
                if let Some(color) = c.color {
                    return ChannelRole::ColorIntensity { color };
                }
            }
            _ => {}
        }
    }

    // ShutterStrobe capabilities
    let strobe_caps: Vec<&OflCapability> = caps
        .iter()
        .filter(|c| c.cap_type == "ShutterStrobe")
        .collect();
    if !strobe_caps.is_empty() {
        let ranges = strobe_caps
            .into_iter()
            .filter_map(|c| {
                let effect = c.shutter_effect?;
                Some(StrobeRange {
                    dmx_range: c.dmx_range.unwrap_or([0, 255]),
                    effect,
                    random_timing: c.random_timing.unwrap_or(false),
                    speed_start_hz: c.speed_start.as_deref().and_then(parse_frequency_hz),
                    speed_end_hz: c.speed_end.as_deref().and_then(parse_frequency_hz),
                })
            })
            .collect();
        return ChannelRole::ShutterStrobe {
            capabilities: ranges,
        };
    }

    // WheelSlot capabilities
    let wheel_caps: Vec<&OflCapability> =
        caps.iter().filter(|c| c.cap_type == "WheelSlot").collect();
    if !wheel_caps.is_empty() {
        let wheel_name = wheel_caps
            .iter()
            .find_map(|c| c.wheel.as_ref().and_then(|w| w.primary_name()))
            .map(ToString::to_string);
        let wheel_def = wheel_name
            .as_deref()
            .and_then(|name| fixture.wheels.get(name));

        let slots = wheel_caps
            .into_iter()
            .map(|c| {
                let slot_num = c.slot_number.unwrap_or(1.0).max(1.0).round() as u16;
                let slot_def = wheel_def
                    .and_then(|w| w.slots.get((slot_num as usize).saturating_sub(1)));
                ResolvedWheelSlot {
                    slot_number: slot_num,
                    dmx_range: c.dmx_range.unwrap_or([0, 255]),
                    name: slot_def.and_then(|s| s.name.clone()),
                    colors_hex: slot_def.map(|s| s.colors.clone()).unwrap_or_default(),
                }
            })
            .collect();

        return ChannelRole::WheelSlot { wheel_name, slots };
    }

    ChannelRole::Unmapped {
        capability_type: caps[0].cap_type.clone(),
    }
}

fn single_cell_fallback() -> Vec<MatrixCell> {
    vec![MatrixCell {
        cell_index: 0,
        pixel_key: "1".to_string(),
        grid_xyz: [0, 0, 0],
        local_uv: [0.0, 0.0],
    }]
}

pub fn expand_fixture_mode(
    fixture: &OflFixtureDefinition,
    mode_name: &str,
) -> Result<ExpandedFixtureMode, OflError> {
    let mode = fixture
        .modes
        .iter()
        .find(|m| m.name == mode_name)
        .ok_or_else(|| OflError::ModeNotFound(mode_name.to_string()))?;

    let is_multi_cell = fixture.matrix.is_some();
    let canonical_cells = match &fixture.matrix {
        Some(matrix) => expand_canonical_matrix_cells(matrix)?,
        None => single_cell_fallback(),
    };

    // Map fine channel aliases -> (parent_name, 1-based fine byte index)
    let mut fine_alias_lookup: HashMap<String, (String, usize)> = HashMap::new();
    for (parent_name, ch) in &fixture.available_channels {
        for (idx, alias) in ch.fine_channel_aliases.iter().enumerate() {
            fine_alias_lookup.insert(alias.clone(), (parent_name.clone(), idx + 1));
        }
    }
    for (tpl_name, ch) in &fixture.template_channels {
        if !ch.fine_channel_aliases.is_empty() {
            for cell in &canonical_cells {
                let expanded_parent = tpl_name.replace("$pixelKey", &cell.pixel_key);
                for (idx, alias) in ch.fine_channel_aliases.iter().enumerate() {
                    let expanded_alias = alias.replace("$pixelKey", &cell.pixel_key);
                    fine_alias_lookup.insert(expanded_alias, (expanded_parent.clone(), idx + 1));
                }
            }
        }
    }

    let mut pending: Vec<PendingChannel> = Vec::new();

    for entry in &mode.channels {
        match entry {
            OflModeChannelEntry::Direct(None) => {
                pending.push(PendingChannel {
                    name: "NoFunction".to_string(),
                    def: None,
                    target: ChannelTarget::Fixture,
                });
            }
            OflModeChannelEntry::Direct(Some(ch_name)) => {
                if fine_alias_lookup.contains_key(ch_name) {
                    pending.push(PendingChannel {
                        name: ch_name.clone(),
                        def: None,
                        target: ChannelTarget::Fixture,
                    });
                } else {
                    let def = fixture
                        .available_channels
                        .get(ch_name)
                        .ok_or_else(|| OflError::ChannelNotFound(ch_name.clone()))?;
                    let role_preview = classify_channel_role(fixture, def);
                    let target = if !is_multi_cell
                        && matches!(
                            role_preview,
                            ChannelRole::ColorIntensity { .. } | ChannelRole::WheelSlot { .. }
                        ) {
                        ChannelTarget::Cell {
                            cell_index: 0,
                            pixel_key: canonical_cells[0].pixel_key.clone(),
                        }
                    } else {
                        ChannelTarget::Fixture
                    };
                    pending.push(PendingChannel {
                        name: ch_name.clone(),
                        def: Some(def.clone()),
                        target,
                    });
                }
            }
            OflModeChannelEntry::MatrixInsert(insert) => {
                let matrix = fixture.matrix.as_ref().ok_or(OflError::MissingMatrix)?;
                let ordered_cells = order_matrix_cells_for_repeat(matrix, &insert.repeat_for)?;

                match insert.channel_order {
                    ChannelOrder::PerPixel => {
                        for cell in &ordered_cells {
                            for tpl in &insert.template_channels {
                                let ch_def = fixture
                                    .template_channels
                                    .get(tpl)
                                    .ok_or_else(|| OflError::TemplateChannelNotFound(tpl.clone()))?;
                                let concrete_name = tpl.replace("$pixelKey", &cell.pixel_key);
                                pending.push(PendingChannel {
                                    name: concrete_name,
                                    def: Some(ch_def.clone()),
                                    target: ChannelTarget::Cell {
                                        cell_index: cell.cell_index,
                                        pixel_key: cell.pixel_key.clone(),
                                    },
                                });
                            }
                        }
                    }
                    ChannelOrder::PerChannel => {
                        for tpl in &insert.template_channels {
                            let ch_def = fixture
                                .template_channels
                                .get(tpl)
                                .ok_or_else(|| OflError::TemplateChannelNotFound(tpl.clone()))?;
                            for cell in &ordered_cells {
                                let concrete_name = tpl.replace("$pixelKey", &cell.pixel_key);
                                pending.push(PendingChannel {
                                    name: concrete_name,
                                    def: Some(ch_def.clone()),
                                    target: ChannelTarget::Cell {
                                        cell_index: cell.cell_index,
                                        pixel_key: cell.pixel_key.clone(),
                                    },
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // Build offset map for resolving fineChannelAliases
    let name_to_offset: HashMap<String, usize> = pending
        .iter()
        .enumerate()
        .map(|(offset, p)| (p.name.clone(), offset))
        .collect();

    let mut channels: Vec<ExpandedChannel> = Vec::with_capacity(pending.len());
    for (offset, p) in pending.into_iter().enumerate() {
        if let Some((parent_name, byte_idx)) = fine_alias_lookup.get(&p.name) {
            let parent_offset = name_to_offset.get(parent_name).copied().unwrap_or(offset);
            channels.push(ExpandedChannel {
                dmx_offset: offset,
                channel_number: (offset + 1) as u16,
                name: p.name,
                default_value: 0,
                target: ChannelTarget::Fixture,
                role: ChannelRole::FineAlias {
                    parent_channel_name: parent_name.clone(),
                    parent_offset,
                    resolution_byte_index: *byte_idx,
                },
                fine_channel_offset: None,
            });
        } else if let Some(def) = p.def {
            let role = classify_channel_role(fixture, &def);
            let fine_channel_offset = def
                .fine_channel_aliases
                .first()
                .and_then(|alias| name_to_offset.get(alias).copied());
            channels.push(ExpandedChannel {
                dmx_offset: offset,
                channel_number: (offset + 1) as u16,
                name: p.name,
                default_value: def.default_dmx_byte(),
                target: p.target,
                role,
                fine_channel_offset,
            });
        } else {
            channels.push(ExpandedChannel {
                dmx_offset: offset,
                channel_number: (offset + 1) as u16,
                name: p.name,
                default_value: 0,
                target: p.target,
                role: ChannelRole::Unmapped {
                    capability_type: "NoFunction".to_string(),
                },
                fine_channel_offset: None,
            });
        }
    }

    // Propagate parent target scope onto FineAlias channels
    for idx in 0..channels.len() {
        if let ChannelRole::FineAlias { parent_offset, .. } = channels[idx].role {
            if let Some(parent_target) = channels.get(parent_offset).map(|c| c.target.clone()) {
                channels[idx].target = parent_target;
            }
        }
    }

    Ok(ExpandedFixtureMode {
        name: mode.name.clone(),
        short_name: mode
            .short_name
            .clone()
            .unwrap_or_else(|| format!("{}ch", channels.len())),
        channel_count: channels.len(),
        cells: canonical_cells,
        channels,
    })
}

pub fn expand_all_modes(
    fixture: &OflFixtureDefinition,
) -> Result<Vec<ExpandedFixtureMode>, OflError> {
    fixture
        .modes
        .iter()
        .map(|m| expand_fixture_mode(fixture, &m.name))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RLCV3_JSON: &str = r#"{
      "name": "RLCV3 8-Segment RGBW Tube",
      "shortName": "RLCV3-8Px",
      "categories": ["Pixel Bar"],
      "meta": { "authors": ["AGE"], "createDate": "2026-11-17", "lastModifyDate": "2026-11-18" },
      "matrix": { "pixelCount": [8, 1, 1] },
      "availableChannels": {
        "Master Dimmer": { "defaultValue": 0, "capability": { "type": "Intensity" } },
        "Strobe": {
          "defaultValue": 0,
          "capabilities": [
            { "dmxRange": [0, 7], "type": "ShutterStrobe", "shutterEffect": "Closed" },
            { "dmxRange": [8, 15], "type": "ShutterStrobe", "shutterEffect": "Open" },
            { "dmxRange": [16, 200], "type": "ShutterStrobe", "shutterEffect": "Strobe", "speedStart": "1Hz", "speedEnd": "20Hz" },
            { "dmxRange": [201, 255], "type": "ShutterStrobe", "shutterEffect": "Strobe", "randomTiming": true, "speedStart": "1Hz", "speedEnd": "20Hz" }
          ]
        }
      },
      "templateChannels": {
        "Red $pixelKey": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "Red" } },
        "Green $pixelKey": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "Green" } },
        "Blue $pixelKey": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "Blue" } },
        "White $pixelKey": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "White" } }
      },
      "modes": [
        {
          "name": "34ch Pixel Mode",
          "shortName": "34ch",
          "channels": [
            "Master Dimmer",
            "Strobe",
            {
              "insert": "matrixChannels",
              "repeatFor": "eachPixelABC",
              "channelOrder": "perPixel",
              "templateChannels": ["Red $pixelKey", "Green $pixelKey", "Blue $pixelKey", "White $pixelKey"]
            }
          ]
        },
        {
          "name": "34ch Planar Mode",
          "shortName": "34ch-ch",
          "channels": [
            "Master Dimmer",
            "Strobe",
            {
              "insert": "matrixChannels",
              "repeatFor": "eachPixelABC",
              "channelOrder": "perChannel",
              "templateChannels": ["Red $pixelKey", "Green $pixelKey", "Blue $pixelKey", "White $pixelKey"]
            }
          ]
        }
      ]
    }"#;

    #[test]
    fn expands_per_pixel_and_per_channel_matrix_modes_with_strobe_capabilities() {
        let def: OflFixtureDefinition = serde_json::from_str(RLCV3_JSON).unwrap();
        let mode = expand_fixture_mode(&def, "34ch Pixel Mode").unwrap();
        assert_eq!(mode.channel_count, 34);
        assert_eq!(mode.cells.len(), 8);

        assert_eq!(mode.channels[0].name, "Master Dimmer");
        assert_eq!(mode.channels[0].target, ChannelTarget::Fixture);
        assert_eq!(mode.channels[0].role, ChannelRole::Intensity);

        match &mode.channels[1].role {
            ChannelRole::ShutterStrobe { capabilities } => {
                assert_eq!(capabilities.len(), 4);
                assert!(capabilities[3].random_timing);
                assert_eq!(capabilities[2].speed_start_hz, Some(1.0));
                assert_eq!(capabilities[2].speed_end_hz, Some(20.0));
            }
            other => panic!("expected ShutterStrobe, got {other:?}"),
        }

        assert_eq!(mode.channels[2].name, "Red 1");
        assert_eq!(
            mode.channels[2].target,
            ChannelTarget::Cell {
                cell_index: 0,
                pixel_key: "1".into()
            }
        );
        assert_eq!(mode.channels[33].name, "White 8");
        assert_eq!(
            mode.channels[33].target,
            ChannelTarget::Cell {
                cell_index: 7,
                pixel_key: "8".into()
            }
        );

        let planar = expand_fixture_mode(&def, "34ch Planar Mode").unwrap();
        assert_eq!(planar.channels[2].name, "Red 1");
        assert_eq!(planar.channels[9].name, "Red 8");
        assert_eq!(planar.channels[10].name, "Green 1");
    }

    #[test]
    fn expands_16bit_fine_aliases_color_wheels_and_default_values() {
        let spot_json = r##"{
          "name": "Spot Wheel 16bit",
          "shortName": "Spot16",
          "categories": ["Color Changer"],
          "meta": { "authors": ["AGE"], "createDate": "2026-11-18", "lastModifyDate": "2026-11-18" },
          "wheels": {
            "Color Wheel": {
              "slots": [
                { "type": "Open", "name": "Open White" },
                { "type": "Color", "name": "Amber", "colors": ["#FF5500"] }
              ]
            }
          },
          "availableChannels": {
            "Dimmer": {
              "defaultValue": 0,
              "fineChannelAliases": ["Dimmer fine"],
              "capability": { "type": "Intensity" }
            },
            "Color Wheel": {
              "defaultValue": 0,
              "capabilities": [
                { "dmxRange": [0, 127], "type": "WheelSlot", "wheel": "Color Wheel", "slotNumber": 1 },
                { "dmxRange": [128, 255], "type": "WheelSlot", "wheel": "Color Wheel", "slotNumber": 2 }
              ]
            },
            "Control": {
              "defaultValue": 120,
              "capability": { "type": "NoFunction" }
            }
          },
          "modes": [
            {
              "name": "4ch Mode",
              "channels": ["Dimmer", "Dimmer fine", "Color Wheel", "Control"]
            }
          ]
        }"##;

        let def: OflFixtureDefinition = serde_json::from_str(spot_json).unwrap();
        let mode = expand_fixture_mode(&def, "4ch Mode").unwrap();
        assert_eq!(mode.channel_count, 4);
        assert_eq!(mode.cells.len(), 1);
        assert_eq!(mode.channels[0].fine_channel_offset, Some(1));
        assert_eq!(
            mode.channels[1].role,
            ChannelRole::FineAlias {
                parent_channel_name: "Dimmer".into(),
                parent_offset: 0,
                resolution_byte_index: 1
            }
        );

        match &mode.channels[2].role {
            ChannelRole::WheelSlot { wheel_name, slots } => {
                assert_eq!(wheel_name.as_deref(), Some("Color Wheel"));
                assert_eq!(slots.len(), 2);
                assert_eq!(slots[1].colors_hex, vec!["#FF5500"]);
            }
            other => panic!("expected WheelSlot, got {other:?}"),
        }

        assert_eq!(mode.channels[3].default_value, 120);
        assert_eq!(
            mode.channels[3].role,
            ChannelRole::Unmapped {
                capability_type: "NoFunction".into()
            }
        );
    }
}
