use std::collections::HashMap;
use std::str::FromStr;

use crate::ofl::library::FixtureLibrary;
use crate::state::plan::{CompiledCell, CompiledChannelSlot, CompiledFixture, CompiledGroup, RenderPlan};

use super::spatial::compute_order_u;
use super::targets::TargetRef;
use super::xml::ShowState;
use super::ShowError;

pub fn compile_render_plan(
    revision: u64,
    show: &ShowState,
    library: &FixtureLibrary,
) -> Result<RenderPlan, ShowError> {
    let universes = show.network_outputs.universes.clone();
    let universe_index_map: HashMap<u16, usize> = universes
        .iter()
        .enumerate()
        .map(|(idx, u)| (u.id, idx))
        .collect();

    let mut base_dmx = vec![[0u8; 512]; universes.len()];
    let mut compiled_fixtures = Vec::with_capacity(show.patch.len());
    let mut compiled_cells = Vec::new();
    let mut fixture_cell_ranges: HashMap<String, (usize, u16)> = HashMap::new();

    for (fx_idx, inst) in show.patch.iter().enumerate() {
        let detail = library.get_entry(&inst.profile).ok_or_else(|| {
            ShowError::ProfileOrModeNotFound(inst.profile.clone(), inst.mode.clone())
        })?;
        let expanded_mode = detail
            .expanded_modes
            .iter()
            .find(|m| m.name == inst.mode)
            .ok_or_else(|| {
                ShowError::ProfileOrModeNotFound(inst.profile.clone(), inst.mode.clone())
            })?;

        let cell_start = compiled_cells.len();
        let cell_count = expanded_mode.cells.len() as u16;
        for cell in &expanded_mode.cells {
            compiled_cells.push(CompiledCell {
                fixture_index: fx_idx,
                fixture_id: inst.id.clone(),
                cell_index: cell.cell_index,
                pixel_key: cell.pixel_key.clone(),
                canvas_xy: inst.grid_pos.transform_cell_uv(cell.local_uv),
            });
        }
        fixture_cell_ranges.insert(inst.id.clone(), (cell_start, cell_count));

        let mut compiled_channels = Vec::with_capacity(expanded_mode.channels.len());
        for ch in &expanded_mode.channels {
            let linear_addr = inst.address + (ch.dmx_offset as u16);
            let (universe_id, dmx_address) = if linear_addr <= 512 {
                (inst.universe, linear_addr)
            } else {
                (inst.universe + 1, linear_addr - 512)
            };
            let universe_index = universe_index_map.get(&universe_id).copied();

            if let Some(u_idx) = universe_index {
                if ch.default_value > 0 && (1..=512).contains(&dmx_address) {
                    base_dmx[u_idx][(dmx_address - 1) as usize] = ch.default_value;
                }
            }

            compiled_channels.push(CompiledChannelSlot {
                universe_id,
                universe_index,
                dmx_address,
                name: ch.name.clone(),
                default_value: ch.default_value,
                target: ch.target.clone(),
                role: ch.role.clone(),
                fine_channel_offset: ch.fine_channel_offset,
            });
        }

        compiled_fixtures.push(CompiledFixture {
            id: inst.id.clone(),
            name: inst.name.clone(),
            profile: inst.profile.clone(),
            mode: inst.mode.clone(),
            calibration: inst.calibration,
            cell_start,
            cell_count,
            channels: compiled_channels,
        });
    }

    let mut compiled_groups = Vec::with_capacity(show.groups.len());
    for grp in &show.groups {
        let mut raw_cell_indices: Vec<usize> = Vec::new();
        for target_str in &grp.targets {
            let parsed = TargetRef::from_str(target_str)?;
            if let Some(&(cell_start, cell_count)) = fixture_cell_ranges.get(parsed.fixture_id()) {
                for local_idx in parsed.expand_cell_indices(cell_count) {
                    raw_cell_indices.push(cell_start + (local_idx as usize));
                }
            }
        }
        let total = raw_cell_indices.len();
        let cells: Vec<(usize, f32)> = raw_cell_indices
            .into_iter()
            .enumerate()
            .map(|(i, global_cell_idx)| (global_cell_idx, compute_order_u(grp.order, i, total)))
            .collect();

        compiled_groups.push(CompiledGroup {
            id: grp.id.clone(),
            name: grp.name.clone(),
            order: grp.order,
            cells,
        });
    }

    Ok(RenderPlan {
        revision,
        universes,
        artsync_enabled: show.network_outputs.artsync,
        cell_count: compiled_cells.len() as u32,
        base_dmx,
        fixtures: compiled_fixtures,
        cells: compiled_cells,
        groups: compiled_groups,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::show::patch::{FixtureCalibration, FixtureInstance};
    use crate::show::spatial::{GridPos, OrderRule};
    use crate::show::xml::FixtureGroupDef;

    #[test]
    fn compiles_split_fixture_with_per_channel_universe_address_and_group_ordering() {
        let lib = FixtureLibrary::load(None);
        let mut show = ShowState::default();
        show.patch.push(FixtureInstance {
            id: "fx_201".into(),
            profile: "age/rlcv3_8_segment_tube.json".into(),
            mode: "34ch Pixel Mode".into(),
            name: "Tube Left".into(),
            universe: 1,
            address: 505, // 8 channels in U1 (505..512), 26 channels in U2 (1..26)
            channel_count: 34,
            grid_pos: GridPos {
                x: 0.5,
                y: 0.5,
                rotation: 0.0,
                scale_x: 0.4,
                scale_y: 0.04,
            },
            calibration: FixtureCalibration::default(),
        });
        show.groups.push(FixtureGroupDef {
            id: "grp_rev".into(),
            name: "Flipped Tube".into(),
            order: OrderRule::Linear,
            targets: vec!["fx_201:7..0".into()],
        });

        let plan = compile_render_plan(42, &show, &lib).unwrap();
        assert_eq!(plan.revision, 42);
        assert_eq!(plan.cell_count, 8);
        assert_eq!(plan.fixtures.len(), 1);

        let fx = &plan.fixtures[0];
        assert_eq!(fx.channels.len(), 34);
        // Channel 0 (Master Dimmer) -> U1.505
        assert_eq!(fx.channels[0].universe_id, 1);
        assert_eq!(fx.channels[0].dmx_address, 505);
        // Channel 7 (Blue 2) -> U1.512
        assert_eq!(fx.channels[7].universe_id, 1);
        assert_eq!(fx.channels[7].dmx_address, 512);
        // Channel 8 (White 2) -> U2.001
        assert_eq!(fx.channels[8].universe_id, 2);
        assert_eq!(fx.channels[8].dmx_address, 1);
        // Channel 33 (White 8) -> U2.026
        assert_eq!(fx.channels[33].universe_id, 2);
        assert_eq!(fx.channels[33].dmx_address, 26);

        // Group reversed descending range 7..0 -> cell 7 gets u=0.0, cell 0 gets u=1.0
        assert_eq!(plan.groups[0].cells[0].0, 7);
        assert!((plan.groups[0].cells[0].1 - 0.0).abs() < 1e-6);
        assert_eq!(plan.groups[0].cells[7].0, 0);
        assert!((plan.groups[0].cells[7].1 - 1.0).abs() < 1e-6);
    }
}
