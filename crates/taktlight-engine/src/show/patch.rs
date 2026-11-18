use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::state::plan::{ArtNetOutputMode, ProtocolKind, UniverseConfig};

use super::spatial::GridPos;
use super::ShowError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WhiteMode {
    #[default]
    Replace,
    Add,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FixtureCalibration {
    pub gamma: f32,
    pub min_dimmer_dmx: u8,
    pub max_dimmer_dmx: u8,
    pub white_mode: WhiteMode,
    pub white_gain: f32,
}

impl Default for FixtureCalibration {
    fn default() -> Self {
        Self {
            gamma: 2.2,
            min_dimmer_dmx: 0,
            max_dimmer_dmx: 255,
            white_mode: WhiteMode::Replace,
            white_gain: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct UniverseSegment {
    pub universe: u16,
    pub start_address: u16,
    pub end_address: u16,
    pub channel_offset_start: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FixtureFootprint {
    pub head: UniverseSegment,
    pub tail: Option<UniverseSegment>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FixtureInstance {
    pub id: String,
    pub profile: String,
    pub mode: String,
    pub name: String,
    pub universe: u16,
    pub address: u16,
    pub channel_count: u16,
    pub grid_pos: GridPos,
    pub calibration: FixtureCalibration,
}

impl FixtureInstance {
    pub fn footprint(&self) -> FixtureFootprint {
        let clamped_count = self.channel_count.clamp(1, 512);
        let end = self.address + clamped_count - 1;
        if end <= 512 {
            FixtureFootprint {
                head: UniverseSegment {
                    universe: self.universe,
                    start_address: self.address,
                    end_address: end,
                    channel_offset_start: 0,
                },
                tail: None,
            }
        } else {
            let head_len = 512 - self.address + 1;
            let tail_len = clamped_count - head_len;
            FixtureFootprint {
                head: UniverseSegment {
                    universe: self.universe,
                    start_address: self.address,
                    end_address: 512,
                    channel_offset_start: 0,
                },
                tail: Some(UniverseSegment {
                    universe: self.universe + 1,
                    start_address: 1,
                    end_address: tail_len,
                    channel_offset_start: head_len,
                }),
            }
        }
    }

    pub fn is_split(&self) -> bool {
        self.address + self.channel_count.clamp(1, 512) - 1 > 512
    }

    pub fn end_cursor(&self) -> (u16, u16) {
        let fp = self.footprint();
        if let Some(tail) = fp.tail {
            (tail.universe, tail.end_address)
        } else {
            (fp.head.universe, fp.head.end_address)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UniverseFreeStats {
    pub universe: u16,
    pub free_channels: u16,
    pub largest_contiguous_block: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlacementOutcome {
    pub universe: u16,
    pub address: u16,
    pub was_split: bool,
    pub tail_end_address: Option<u16>,
    pub moved_from_requested: bool,
    pub auto_create_universes: Vec<UniverseConfig>,
    pub cross_protocol_warning: bool,
    pub toast_message: String,
}

pub fn inherit_next_universe(prev: &UniverseConfig, new_id: u16) -> UniverseConfig {
    let protocol = match &prev.protocol {
        ProtocolKind::ArtNet {
            mode,
            net,
            subnet,
            uni,
        } => {
            let port_addr =
                (((*net as u16) & 0x7F) << 8) | (((*subnet as u16) & 0x0F) << 4) | ((*uni as u16) & 0x0F);
            let next = (port_addr + 1) & 0x7FFF;
            ProtocolKind::ArtNet {
                mode: mode.clone(),
                net: ((next >> 8) & 0x7F) as u8,
                subnet: ((next >> 4) & 0x0F) as u8,
                uni: (next & 0x0F) as u8,
            }
        }
        ProtocolKind::Sacn {
            mode,
            sacn_universe,
            priority,
        } => {
            let next_sacn = if *sacn_universe >= 63999 {
                1
            } else {
                sacn_universe + 1
            };
            ProtocolKind::Sacn {
                mode: mode.clone(),
                sacn_universe: next_sacn,
                priority: *priority,
            }
        }
    };

    UniverseConfig {
        id: new_id,
        protocol,
        review_output: true,
    }
}

pub fn has_cross_protocol_warning(
    universe_a: &UniverseConfig,
    universe_b: &UniverseConfig,
) -> bool {
    match (&universe_a.protocol, &universe_b.protocol) {
        (ProtocolKind::ArtNet { mode: ma, .. }, ProtocolKind::ArtNet { mode: mb, .. }) => ma != mb,
        (ProtocolKind::Sacn { mode: ma, .. }, ProtocolKind::Sacn { mode: mb, .. }) => ma != mb,
        _ => true,
    }
}

pub fn universe_occupied_mask(
    instances: &[FixtureInstance],
    universe: u16,
    exclude_fixture_id: Option<&str>,
) -> [bool; 512] {
    let mut mask = [false; 512];
    for inst in instances {
        if exclude_fixture_id == Some(inst.id.as_str()) {
            continue;
        }
        let fp = inst.footprint();
        if fp.head.universe == universe {
            for addr in fp.head.start_address..=fp.head.end_address {
                if (1..=512).contains(&addr) {
                    mask[(addr - 1) as usize] = true;
                }
            }
        }
        if let Some(tail) = fp.tail {
            if tail.universe == universe {
                for addr in tail.start_address..=tail.end_address {
                    if (1..=512).contains(&addr) {
                        mask[(addr - 1) as usize] = true;
                    }
                }
            }
        }
    }
    mask
}

pub fn universe_free_stats(instances: &[FixtureInstance], universe: u16) -> UniverseFreeStats {
    let mask = universe_occupied_mask(instances, universe, None);
    let mut free_channels: u16 = 0;
    let mut largest_contiguous_block: u16 = 0;
    let mut current_run: u16 = 0;

    for occupied in mask {
        if !occupied {
            free_channels += 1;
            current_run += 1;
            if current_run > largest_contiguous_block {
                largest_contiguous_block = current_run;
            }
        } else {
            current_run = 0;
        }
    }

    UniverseFreeStats {
        universe,
        free_channels,
        largest_contiguous_block,
    }
}

pub fn validate_patch_no_collisions(instances: &[FixtureInstance]) -> Result<(), ShowError> {
    let mut owners: HashMap<u16, [Option<usize>; 512]> = HashMap::new();

    for (idx, inst) in instances.iter().enumerate() {
        if !(1..=512).contains(&inst.address) {
            return Err(ShowError::InvalidDmxAddress(inst.address));
        }
        if !(1..=512).contains(&inst.channel_count) {
            return Err(ShowError::InvalidChannelCount(inst.channel_count));
        }
        let fp = inst.footprint();
        let segments = [Some(fp.head), fp.tail];
        for seg in segments.into_iter().flatten() {
            let map = owners.entry(seg.universe).or_insert([None; 512]);
            for addr in seg.start_address..=seg.end_address {
                let slot = &mut map[(addr - 1) as usize];
                if let Some(existing_idx) = *slot {
                    return Err(ShowError::AddressCollision {
                        universe: seg.universe,
                        address: addr,
                        existing_id: instances[existing_idx].id.clone(),
                    });
                }
                *slot = Some(idx);
            }
        }
    }

    Ok(())
}

pub fn check_direct_placement_collision(
    instances: &[FixtureInstance],
    universe: u16,
    address: u16,
    channel_count: u16,
    exclude_fixture_id: Option<&str>,
) -> Option<ShowError> {
    if !(1..=512).contains(&address) {
        return Some(ShowError::InvalidDmxAddress(address));
    }
    if !(1..=512).contains(&channel_count) {
        return Some(ShowError::InvalidChannelCount(channel_count));
    }
    let temp = FixtureInstance {
        id: "__probe".to_string(),
        profile: String::new(),
        mode: String::new(),
        name: String::new(),
        universe,
        address,
        channel_count,
        grid_pos: GridPos::default(),
        calibration: FixtureCalibration::default(),
    };
    let fp = temp.footprint();
    let occ_head = universe_occupied_mask(instances, fp.head.universe, exclude_fixture_id);
    for addr in fp.head.start_address..=fp.head.end_address {
        if occ_head[(addr - 1) as usize] {
            return Some(ShowError::AddressCollision {
                universe: fp.head.universe,
                address: addr,
                existing_id: "occupied".to_string(),
            });
        }
    }
    if let Some(tail) = fp.tail {
        let occ_tail = universe_occupied_mask(instances, tail.universe, exclude_fixture_id);
        for addr in tail.start_address..=tail.end_address {
            if occ_tail[(addr - 1) as usize] {
                return Some(ShowError::AddressCollision {
                    universe: tail.universe,
                    address: addr,
                    existing_id: "occupied".to_string(),
                });
            }
        }
    }
    None
}

fn ensure_universe_cfg(
    target_id: u16,
    universe_map: &mut HashMap<u16, UniverseConfig>,
    created: &mut Vec<UniverseConfig>,
) -> UniverseConfig {
    if let Some(existing) = universe_map.get(&target_id) {
        return existing.clone();
    }
    let max_existing = universe_map.keys().copied().max().unwrap_or(0);
    if max_existing == 0 {
        let mut base = UniverseConfig::new(
            1,
            ProtocolKind::ArtNet {
                mode: ArtNetOutputMode::Broadcast,
                net: 0,
                subnet: 0,
                uni: 0,
            },
        );
        base.review_output = true;
        universe_map.insert(1, base.clone());
        created.push(base);
    }

    let mut cur = universe_map.keys().copied().max().unwrap_or(1);
    while cur < target_id {
        let prev = universe_map.get(&cur).unwrap().clone();
        let next_id = cur + 1;
        let next_cfg = inherit_next_universe(&prev, next_id);
        universe_map.insert(next_id, next_cfg.clone());
        created.push(next_cfg);
        cur = next_id;
    }

    universe_map.get(&target_id).unwrap().clone()
}

#[allow(clippy::too_many_arguments)]
pub fn find_placement(
    instances: &[FixtureInstance],
    universes: &[UniverseConfig],
    fixture_name: &str,
    start_universe: u16,
    requested_address: u16,
    channel_count: u16,
    rollover_split_on: bool,
    exclude_fixture_id: Option<&str>,
) -> Result<PlacementOutcome, ShowError> {
    if start_universe == 0 || !(1..=512).contains(&requested_address) {
        return Err(ShowError::InvalidDmxAddress(requested_address));
    }
    if !(1..=512).contains(&channel_count) {
        return Err(ShowError::InvalidChannelCount(channel_count));
    }

    let mut universe_map: HashMap<u16, UniverseConfig> =
        universes.iter().map(|u| (u.id, u.clone())).collect();
    let max_configured = universe_map.keys().copied().max().unwrap_or(1);
    let scan_limit = max_configured.max(start_universe);

    for u in start_universe..=scan_limit {
        let min_addr = if u == start_universe {
            requested_address
        } else {
            1
        };
        let occ_u = universe_occupied_mask(instances, u, exclude_fixture_id);

        let mut cursor = min_addr as usize;
        while cursor <= 512 {
            // Skip occupied channels
            while cursor <= 512 && occ_u[cursor - 1] {
                cursor += 1;
            }
            if cursor > 512 {
                break;
            }

            let run_start = cursor as u16;
            while cursor <= 512 && !occ_u[cursor - 1] {
                cursor += 1;
            }
            let run_end = (cursor - 1) as u16;
            let run_len = run_end - run_start + 1;

            // Condition 1: Whole fixture fits in this free run
            if run_len >= channel_count {
                let mut auto_created = Vec::new();
                ensure_universe_cfg(u, &mut universe_map, &mut auto_created);
                let moved = !(u == start_universe && run_start == requested_address);
                let toast_message = if moved {
                    format!("{fixture_name} moved to U{u}.{run_start:03}")
                } else {
                    format!("{fixture_name} patched at U{u}.{run_start:03}")
                };
                return Ok(PlacementOutcome {
                    universe: u,
                    address: run_start,
                    was_split: false,
                    tail_end_address: None,
                    moved_from_requested: moved,
                    auto_create_universes: auto_created,
                    cross_protocol_warning: false,
                    toast_message,
                });
            }

            // Condition 2: Roll-over ON split across u -> u+1.001
            if rollover_split_on && run_end == 512 {
                let head_len = run_len;
                let tail_len = channel_count - head_len;
                let occ_next = universe_occupied_mask(instances, u + 1, exclude_fixture_id);
                let tail_fits = occ_next[..tail_len as usize].iter().all(|&occ| !occ);
                if tail_fits {
                    let mut auto_created = Vec::new();
                    let cfg_u = ensure_universe_cfg(u, &mut universe_map, &mut auto_created);
                    let cfg_next =
                        ensure_universe_cfg(u + 1, &mut universe_map, &mut auto_created);
                    let cross_warning = has_cross_protocol_warning(&cfg_u, &cfg_next);
                    let moved = !(u == start_universe && run_start == requested_address);
                    let toast_message = format!(
                        "{fixture_name} split: U{u}.{run_start:03} to U{u}.512 + U{}.001 to U{}.{tail_len:03}",
                        u + 1,
                        u + 1
                    );
                    return Ok(PlacementOutcome {
                        universe: u,
                        address: run_start,
                        was_split: true,
                        tail_end_address: Some(tail_len),
                        moved_from_requested: moved,
                        auto_create_universes: auto_created,
                        cross_protocol_warning: cross_warning,
                        toast_message,
                    });
                }
            }
        }
    }

    // Fallback: create a new universe past scan_limit and place at 001
    let new_u = scan_limit + 1;
    let mut auto_created = Vec::new();
    ensure_universe_cfg(new_u, &mut universe_map, &mut auto_created);
    Ok(PlacementOutcome {
        universe: new_u,
        address: 1,
        was_split: false,
        tail_end_address: None,
        moved_from_requested: true,
        auto_create_universes: auto_created,
        cross_protocol_warning: false,
        toast_message: format!("{fixture_name} moved to U{new_u}.001"),
    })
}

pub fn auto_patch_batch(
    existing_instances: &[FixtureInstance],
    existing_universes: &[UniverseConfig],
    new_fixtures: Vec<(String, String, String, String, u16, GridPos, FixtureCalibration)>,
    start_universe: u16,
    start_address: u16,
    rollover_split_on: bool,
) -> Result<(Vec<FixtureInstance>, Vec<UniverseConfig>, Vec<PlacementOutcome>), ShowError> {
    let mut all_instances = existing_instances.to_vec();
    let mut all_universes = existing_universes.to_vec();
    let mut added_instances = Vec::with_capacity(new_fixtures.len());
    let mut created_universes = Vec::new();
    let mut outcomes = Vec::with_capacity(new_fixtures.len());

    let mut cur_uni = start_universe;
    let mut cur_addr = start_address;

    for (id, profile, mode, name, channel_count, grid_pos, calibration) in new_fixtures {
        let outcome = find_placement(
            &all_instances,
            &all_universes,
            &name,
            cur_uni,
            cur_addr,
            channel_count,
            rollover_split_on,
            None,
        )?;

        for cfg in &outcome.auto_create_universes {
            all_universes.push(cfg.clone());
            created_universes.push(cfg.clone());
        }

        let inst = FixtureInstance {
            id,
            profile,
            mode,
            name,
            universe: outcome.universe,
            address: outcome.address,
            channel_count,
            grid_pos,
            calibration,
        };
        let (end_u, end_addr) = inst.end_cursor();
        if end_addr >= 512 {
            cur_uni = end_u + 1;
            cur_addr = 1;
        } else {
            cur_uni = end_u;
            cur_addr = end_addr + 1;
        }

        all_instances.push(inst.clone());
        added_instances.push(inst);
        outcomes.push(outcome);
    }

    Ok((added_instances, created_universes, outcomes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::plan::{ArtNetOutputMode, SacnOutputMode};

    fn dummy_fixture(
        id: &str,
        name: &str,
        universe: u16,
        address: u16,
        channel_count: u16,
    ) -> FixtureInstance {
        FixtureInstance {
            id: id.to_string(),
            profile: "age/rlcv3_8_segment_tube.json".to_string(),
            mode: "34ch Pixel Mode".to_string(),
            name: name.to_string(),
            universe,
            address,
            channel_count,
            grid_pos: GridPos::default(),
            calibration: FixtureCalibration::default(),
        }
    }

    fn two_artnet_universes() -> Vec<UniverseConfig> {
        vec![
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
        ]
    }

    #[test]
    fn footprint_derives_implicit_tail_on_reload() {
        let fx = dummy_fixture("fx_1", "Tube Left", 1, 505, 34);
        assert!(fx.is_split());
        let fp = fx.footprint();
        assert_eq!(fp.head.universe, 1);
        assert_eq!(fp.head.start_address, 505);
        assert_eq!(fp.head.end_address, 512);
        assert_eq!(fp.head.channel_offset_start, 0);

        let tail = fp.tail.expect("split fixture has tail");
        assert_eq!(tail.universe, 2);
        assert_eq!(tail.start_address, 1);
        assert_eq!(tail.end_address, 26);
        assert_eq!(tail.channel_offset_start, 8);
    }

    #[test]
    fn collision_detection_rejects_overlapping_heads_and_implicit_tails() {
        let f1 = dummy_fixture("fx_1", "Tube 1", 1, 505, 34);
        let f2 = dummy_fixture("fx_2", "Tube 2", 2, 10, 10);
        let err = validate_patch_no_collisions(&[f1, f2]).unwrap_err();
        assert!(matches!(
            err,
            ShowError::AddressCollision {
                universe: 2,
                address: 10,
                ..
            }
        ));
    }

    #[test]
    fn rollover_on_splits_when_next_universe_001_is_free_and_warns_on_cross_protocol() {
        let universes = vec![
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
        ];

        let outcome =
            find_placement(&[], &universes, "Tube Left", 1, 505, 34, true, None).unwrap();
        assert_eq!(outcome.universe, 1);
        assert_eq!(outcome.address, 505);
        assert!(outcome.was_split);
        assert_eq!(outcome.tail_end_address, Some(26));
        assert!(outcome.cross_protocol_warning);
        assert_eq!(
            outcome.toast_message,
            "Tube Left split: U1.505 to U1.512 + U2.001 to U2.026"
        );
    }

    #[test]
    fn rollover_on_moves_whole_fixture_when_next_universe_001_is_occupied_and_retries_split() {
        let universes = vec![
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
            UniverseConfig::new(
                3,
                ProtocolKind::ArtNet {
                    mode: ArtNetOutputMode::Broadcast,
                    net: 0,
                    subnet: 0,
                    uni: 2,
                },
            ),
        ];

        let existing = vec![
            dummy_fixture("fx_u2_start", "Blocker", 2, 1, 36),
            dummy_fixture("fx_u2_mid", "Mid", 2, 37, 463),
        ];

        let outcome = find_placement(
            &existing,
            &universes,
            "Tube Left",
            1,
            505,
            34,
            true,
            None,
        )
        .unwrap();
        assert_eq!(outcome.universe, 2);
        assert_eq!(outcome.address, 500);
        assert!(outcome.was_split);
        assert_eq!(outcome.tail_end_address, Some(21));
        assert!(outcome.moved_from_requested);
    }

    #[test]
    fn rollover_off_moves_whole_fixture_to_first_fitting_block() {
        let universes = two_artnet_universes();
        let existing = vec![dummy_fixture("fx_u2_start", "Blocker", 2, 1, 36)];

        let outcome = find_placement(
            &existing,
            &universes,
            "Tube Left",
            1,
            505,
            34,
            false,
            None,
        )
        .unwrap();
        assert_eq!(outcome.universe, 2);
        assert_eq!(outcome.address, 37);
        assert!(!outcome.was_split);
        assert!(outcome.moved_from_requested);
        assert_eq!(outcome.toast_message, "Tube Left moved to U2.037");
    }

    #[test]
    fn creates_unconfigured_universe_with_artnet_carry_and_falls_back_past_configured() {
        let universes = vec![UniverseConfig::new(
            1,
            ProtocolKind::ArtNet {
                mode: ArtNetOutputMode::Broadcast,
                net: 0,
                subnet: 15,
                uni: 15,
            },
        )];

        let split_outcome =
            find_placement(&[], &universes, "Tube Auto", 1, 505, 34, true, None).unwrap();
        assert_eq!(split_outcome.auto_create_universes.len(), 1);
        let new_u2 = &split_outcome.auto_create_universes[0];
        assert_eq!(new_u2.id, 2);
        assert!(new_u2.review_output);
        assert_eq!(
            new_u2.protocol,
            ProtocolKind::ArtNet {
                mode: ArtNetOutputMode::Broadcast,
                net: 1,
                subnet: 0,
                uni: 0,
            }
        );

        let full_u1 = vec![dummy_fixture("fx_full", "Full", 1, 1, 512)];
        let fallback =
            find_placement(&full_u1, &universes, "NewTube", 1, 1, 34, false, None).unwrap();
        assert_eq!(fallback.universe, 2);
        assert_eq!(fallback.address, 1);
        assert_eq!(fallback.auto_create_universes.len(), 1);
    }

    #[test]
    fn auto_patch_batch_continues_from_previous_fixture_end() {
        let universes = two_artnet_universes();
        let batch = vec![
            (
                "fx_1".into(),
                "age/rlcv3_8_segment_tube.json".into(),
                "34ch Pixel Mode".into(),
                "Tube 1".into(),
                34,
                GridPos::default(),
                FixtureCalibration::default(),
            ),
            (
                "fx_2".into(),
                "age/rlcv3_8_segment_tube.json".into(),
                "34ch Pixel Mode".into(),
                "Tube 2".into(),
                34,
                GridPos::default(),
                FixtureCalibration::default(),
            ),
        ];
        let (added, _created, _outcomes) =
            auto_patch_batch(&[], &universes, batch, 1, 470, false).unwrap();
        assert_eq!(added[0].universe, 1);
        assert_eq!(added[0].address, 470); // 470..=503
        // 504..=512 is only 9 channels -> Rollover OFF moves Tube 2 to U2.001
        assert_eq!(added[1].universe, 2);
        assert_eq!(added[1].address, 1);
    }
}
