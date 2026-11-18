use std::collections::HashMap;

use crate::ofl::expander::{ChannelRole, ChannelTarget, ResolvedWheelSlot, StrobeRange};
use crate::ofl::model::{OflColor, OflShutterEffect};
use crate::show::patch::{FixtureCalibration, WhiteMode};
use crate::state::plan::{CompiledChannelSlot, CompiledFixture};

use super::color::{
    linear_rgb_to_oklab, oklab_distance, parse_hex_to_oklab, resolve_named_css_color_to_oklab,
};
use super::traits::{CellTraitState, FixtureTraitState, ShutterState};

pub const SOFTWARE_STROBE_MAX_HZ: f32 = 11.0;
pub const WHEEL_HYSTERESIS_OKLAB: f32 = 0.03;

#[derive(Debug, Default, Clone)]
pub struct QuantizerState {
    pub prev_t_sec: Option<f64>,
    pub wheel_slot_cache: HashMap<(usize, usize), usize>,
}

impl QuantizerState {
    pub fn prepare_for_time(&mut self, t_sec: f64) {
        let is_jump = self
            .prev_t_sec
            .map_or(true, |prev| (t_sec - prev).abs() > 0.1);
        if is_jump {
            self.wheel_slot_cache.clear();
        }
    }

    pub fn commit_time(&mut self, t_sec: f64) {
        self.prev_t_sec = Some(t_sec);
    }
}

pub fn extract_rgbw(
    r: f32,
    g: f32,
    b: f32,
    white_mode: WhiteMode,
    white_gain: f32,
    gamma: f32,
) -> (f32, f32, f32, f32) {
    let r = r.clamp(0.0, 1.0);
    let g = g.clamp(0.0, 1.0);
    let b = b.clamp(0.0, 1.0);
    let w_raw = r.min(g).min(b);
    let gain = white_gain.clamp(0.0, 2.0);

    match white_mode {
        WhiteMode::Off => (r, g, b, 0.0),
        WhiteMode::Add => (r, g, b, (w_raw * gain).clamp(0.0, 1.0)),
        WhiteMode::Replace => {
            if w_raw <= 1e-6 {
                return (r, g, b, 0.0);
            }
            let r0 = (r - w_raw).max(0.0);
            let g0 = (g - w_raw).max(0.0);
            let b0 = (b - w_raw).max(0.0);
            let m = r.max(g).max(b);
            if m - w_raw <= 1e-6 {
                return (0.0, 0.0, 0.0, (w_raw * gain).clamp(0.0, 1.0));
            }
            let g_exp = gamma.max(0.1);
            let denom = (m - w_raw).powf(g_exp) + w_raw.powf(g_exp);
            let k = if denom > 1e-9 {
                (m.powf(g_exp) / denom).powf(1.0 / g_exp)
            } else {
                1.0
            };
            (
                (r0 * k).clamp(0.0, 1.0),
                (g0 * k).clamp(0.0, 1.0),
                (b0 * k).clamp(0.0, 1.0),
                (w_raw * k * gain).clamp(0.0, 1.0),
            )
        }
    }
}

pub fn quantize_value_u8(
    v: f32,
    gamma: f32,
    min_dmx: u8,
    max_dmx: u8,
    apply_deadzone: bool,
) -> u8 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.0 {
        return 0;
    }
    let v_gamma = v.powf(gamma.max(0.1));
    if apply_deadzone {
        let min_f = min_dmx as f32;
        let max_f = max_dmx.max(min_dmx) as f32;
        (min_f + v_gamma * (max_f - min_f))
            .round()
            .clamp(0.0, 255.0) as u8
    } else {
        (v_gamma * 255.0).round().clamp(0.0, 255.0) as u8
    }
}

pub fn quantize_value_u16(
    v: f32,
    gamma: f32,
    min_dmx: u8,
    max_dmx: u8,
    apply_deadzone: bool,
) -> u16 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.0 {
        return 0;
    }
    let v_gamma = v.powf(gamma.max(0.1));
    if apply_deadzone {
        let min_16 = (min_dmx as f32) * 257.0;
        let max_16 = (max_dmx.max(min_dmx) as f32) * 257.0;
        (min_16 + v_gamma * (max_16 - min_16))
            .round()
            .clamp(0.0, 65535.0) as u16
    } else {
        (v_gamma * 65535.0).round().clamp(0.0, 65535.0) as u16
    }
}

fn resolve_slot_oklab(slot: &ResolvedWheelSlot) -> Option<[f32; 3]> {
    for hex in &slot.colors_hex {
        if let Some(lab) = parse_hex_to_oklab(hex) {
            return Some(lab);
        }
    }
    slot.name
        .as_deref()
        .and_then(resolve_named_css_color_to_oklab)
}

pub fn select_color_wheel_dmx(
    target_linear_rgb: [f32; 3],
    slots: &[ResolvedWheelSlot],
    fixture_idx: usize,
    ch_idx: usize,
    state: &mut QuantizerState,
) -> u8 {
    let target_oklab = linear_rgb_to_oklab(target_linear_rgb);

    let mut resolved: Vec<(usize, f32)> = slots
        .iter()
        .enumerate()
        .filter_map(|(idx, slot)| {
            resolve_slot_oklab(slot).map(|lab| (idx, oklab_distance(target_oklab, lab)))
        })
        .collect();

    if resolved.is_empty() {
        return slots
            .first()
            .map(|s| ((s.dmx_range[0] as u16 + s.dmx_range[1] as u16) / 2) as u8)
            .unwrap_or(0);
    }

    resolved.sort_by(|a, b| a.1.total_cmp(&b.1));
    let (best_idx, best_dist) = resolved[0];

    let chosen_idx = if let Some(&cached_idx) = state.wheel_slot_cache.get(&(fixture_idx, ch_idx)) {
        if let Some(&(_, cur_dist)) = resolved.iter().find(|&&(idx, _)| idx == cached_idx) {
            if best_dist + WHEEL_HYSTERESIS_OKLAB < cur_dist {
                best_idx
            } else {
                cached_idx
            }
        } else {
            best_idx
        }
    } else {
        best_idx
    };

    state
        .wheel_slot_cache
        .insert((fixture_idx, ch_idx), chosen_idx);

    let range = slots[chosen_idx].dmx_range;
    ((range[0] as u16 + range[1] as u16) / 2) as u8
}

pub fn map_hardware_shutter_dmx(
    shutter: ShutterState,
    capabilities: &[StrobeRange],
    default_value: u8,
) -> u8 {
    match shutter {
        ShutterState::Open => capabilities
            .iter()
            .find(|c| c.effect == OflShutterEffect::Open)
            .map(|c| ((c.dmx_range[0] as u16 + c.dmx_range[1] as u16) / 2) as u8)
            .unwrap_or(default_value),
        ShutterState::Closed => capabilities
            .iter()
            .find(|c| c.effect == OflShutterEffect::Closed)
            .map(|c| ((c.dmx_range[0] as u16 + c.dmx_range[1] as u16) / 2) as u8)
            .unwrap_or(0),
        ShutterState::StrobeHz(hz) | ShutterState::RandomStrobe(hz) => {
            let is_random = matches!(shutter, ShutterState::RandomStrobe(_));
            let is_strobe_effect = |eff: OflShutterEffect| {
                !matches!(eff, OflShutterEffect::Open | OflShutterEffect::Closed)
            };
            let cap = capabilities
                .iter()
                .find(|c| is_strobe_effect(c.effect) && c.random_timing == is_random)
                .or_else(|| capabilities.iter().find(|c| is_strobe_effect(c.effect)));

            let Some(cap) = cap else {
                return default_value;
            };

            let d0 = cap.dmx_range[0] as f32;
            let d1 = cap.dmx_range[1] as f32;
            let f_start = cap.speed_start_hz.unwrap_or(1.0);
            let f_end = cap.speed_end_hz.unwrap_or(20.0);
            if (f_end - f_start).abs() < 1e-6 {
                return ((d0 + d1) * 0.5).round().clamp(0.0, 255.0) as u8;
            }
            let min_f = f_start.min(f_end);
            let max_f = f_start.max(f_end);
            let clamped_hz = hz.clamp(min_f, max_f);
            let t = ((clamped_hz - f_start) / (f_end - f_start)).clamp(0.0, 1.0);
            (d0 + t * (d1 - d0)).round().clamp(0.0, 255.0) as u8
        }
    }
}

#[inline]
fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

pub fn software_strobe_gate(shutter: ShutterState, t_sec: f64, fixture_idx: usize) -> (f32, bool) {
    match shutter {
        ShutterState::Open => (1.0, false),
        ShutterState::Closed => (0.0, false),
        ShutterState::StrobeHz(hz) => {
            let clamped = hz > SOFTWARE_STROBE_MAX_HZ;
            let hz_eff = hz.clamp(0.1, SOFTWARE_STROBE_MAX_HZ) as f64;
            let phase = (t_sec * hz_eff).rem_euclid(1.0);
            (if phase < 0.5 { 1.0 } else { 0.0 }, clamped)
        }
        ShutterState::RandomStrobe(hz) => {
            let clamped = hz > SOFTWARE_STROBE_MAX_HZ;
            let hz_eff = hz.clamp(0.1, SOFTWARE_STROBE_MAX_HZ) as f64;
            let tick = (t_sec * hz_eff * 2.0).floor() as i64 as u64;
            let hash = splitmix64(0x5441_4B54u64 ^ (fixture_idx as u64).rotate_left(17) ^ tick);
            (if (hash & 1) == 0 { 1.0 } else { 0.0 }, clamped)
        }
    }
}

fn color_component_for_ofl(
    color: OflColor,
    rw: f32,
    gw: f32,
    bw: f32,
    ww: f32,
    orig_rgb: [f32; 3],
) -> f32 {
    match color {
        OflColor::Red => rw,
        OflColor::Green => gw,
        OflColor::Blue => bw,
        OflColor::White | OflColor::WarmWhite | OflColor::ColdWhite => ww,
        OflColor::Amber => orig_rgb[0].min(orig_rgb[1] * 1.5),
        OflColor::Yellow => orig_rgb[0].min(orig_rgb[1]),
        OflColor::Cyan => orig_rgb[1].min(orig_rgb[2]),
        OflColor::Magenta => orig_rgb[0].min(orig_rgb[2]),
        OflColor::Lime => orig_rgb[1],
        OflColor::Indigo | OflColor::Uv => orig_rgb[2],
    }
}

fn write_scalar_slot<F>(
    slot_idx: usize,
    fixture: &CompiledFixture,
    val: f32,
    apply_deadzone: bool,
    cal: FixtureCalibration,
    write_channel: &mut F,
) where
    F: FnMut(&CompiledChannelSlot, u8),
{
    let slot = &fixture.channels[slot_idx];
    if let Some(fine_off) = slot.fine_channel_offset {
        if let Some(fine_slot) = fixture.channels.get(fine_off) {
            let v16 = quantize_value_u16(
                val,
                cal.gamma,
                cal.min_dimmer_dmx,
                cal.max_dimmer_dmx,
                apply_deadzone,
            );
            write_channel(slot, (v16 >> 8) as u8);
            write_channel(fine_slot, (v16 & 0xFF) as u8);
            return;
        }
    }
    let v8 = quantize_value_u8(
        val,
        cal.gamma,
        cal.min_dimmer_dmx,
        cal.max_dimmer_dmx,
        apply_deadzone,
    );
    write_channel(slot, v8);
}

pub fn quantize_fixture_to_dmx<F>(
    fixture_idx: usize,
    fixture: &CompiledFixture,
    fx_state: &FixtureTraitState,
    cell_states: &[CellTraitState],
    t_sec: f64,
    quantizer_state: &mut QuantizerState,
    mut write_channel: F,
) -> bool
where
    F: FnMut(&CompiledChannelSlot, u8),
{
    let cal = fixture.calibration;
    let has_hardware_shutter = fixture
        .channels
        .iter()
        .any(|c| matches!(c.role, ChannelRole::ShutterStrobe { .. }));
    let (strobe_gate, strobe_clamped) = if has_hardware_shutter {
        (1.0, false)
    } else {
        software_strobe_gate(fx_state.shutter, t_sec, fixture_idx)
    };

    let fixture_has_master_intensity = fixture
        .channels
        .iter()
        .any(|c| c.target == ChannelTarget::Fixture && c.role == ChannelRole::Intensity);

    let cell_slice_start = fixture.cell_start.min(cell_states.len());
    let cell_slice_end = (fixture.cell_start + fixture.cell_count as usize).min(cell_states.len());
    let local_cells = &cell_states[cell_slice_start..cell_slice_end];

    let has_fixture_white = fixture.channels.iter().any(|c| {
        matches!(
            c.role,
            ChannelRole::ColorIntensity {
                color: OflColor::White | OflColor::WarmWhite | OflColor::ColdWhite
            }
        )
    });

    let mut cell_has_dedicated_intensity = vec![false; local_cells.len()];
    let mut cell_has_white = vec![false; local_cells.len()];
    for ch in &fixture.channels {
        if let ChannelTarget::Cell { cell_index, .. } = ch.target {
            let idx = cell_index as usize;
            if idx < local_cells.len() {
                if ch.role == ChannelRole::Intensity {
                    cell_has_dedicated_intensity[idx] = true;
                }
                if matches!(
                    ch.role,
                    ChannelRole::ColorIntensity {
                        color: OflColor::White | OflColor::WarmWhite | OflColor::ColdWhite
                    }
                ) {
                    cell_has_white[idx] = true;
                }
            }
        }
    }

    for (ch_idx, ch) in fixture.channels.iter().enumerate() {
        match &ch.role {
            ChannelRole::FineAlias { .. } => {
                // Written alongside parent coarse channel
            }
            ChannelRole::Unmapped { .. } => {
                write_channel(ch, ch.default_value);
            }
            ChannelRole::ShutterStrobe { capabilities } => {
                let dmx = map_hardware_shutter_dmx(fx_state.shutter, capabilities, ch.default_value);
                write_channel(ch, dmx);
            }
            ChannelRole::WheelSlot { slots, .. } => {
                let target_rgb = match ch.target {
                    ChannelTarget::Cell { cell_index, .. } => local_cells
                        .get(cell_index as usize)
                        .map(|c| c.color)
                        .unwrap_or([0.0, 0.0, 0.0]),
                    ChannelTarget::Fixture => {
                        local_cells.first().map(|c| c.color).unwrap_or([0.0, 0.0, 0.0])
                    }
                };
                let dmx =
                    select_color_wheel_dmx(target_rgb, slots, fixture_idx, ch_idx, quantizer_state);
                write_channel(ch, dmx);
            }
            ChannelRole::Intensity => match ch.target {
                ChannelTarget::Fixture => {
                    let val = if fixture.cell_count <= 1 {
                        let cell_dim = local_cells.first().map(|c| c.dimmer).unwrap_or(1.0);
                        (cell_dim * fx_state.master_dimmer * strobe_gate).clamp(0.0, 1.0)
                    } else {
                        (fx_state.master_dimmer * strobe_gate).clamp(0.0, 1.0)
                    };
                    write_scalar_slot(ch_idx, fixture, val, true, cal, &mut write_channel);
                }
                ChannelTarget::Cell { cell_index, .. } => {
                    let cell_dim = local_cells
                        .get(cell_index as usize)
                        .map(|c| c.dimmer)
                        .unwrap_or(0.0);
                    let val = (cell_dim * strobe_gate).clamp(0.0, 1.0);
                    write_scalar_slot(ch_idx, fixture, val, true, cal, &mut write_channel);
                }
            },
            ChannelRole::ColorIntensity { color } => {
                let (cell_dim, cell_color, has_int, has_white) = match ch.target {
                    ChannelTarget::Cell { cell_index, .. } => {
                        let idx = cell_index as usize;
                        let st = local_cells.get(idx).cloned().unwrap_or_default();
                        let dedicated = cell_has_dedicated_intensity.get(idx).copied().unwrap_or(false)
                            || (fixture.cell_count == 1 && fixture_has_master_intensity);
                        let white = cell_has_white.get(idx).copied().unwrap_or(false)
                            || (fixture.cell_count == 1 && has_fixture_white);
                        (st.dimmer, st.color, dedicated, white)
                    }
                    ChannelTarget::Fixture => {
                        let st = local_cells.first().cloned().unwrap_or_default();
                        let dedicated = fixture_has_master_intensity
                            || cell_has_dedicated_intensity.first().copied().unwrap_or(false);
                        let white = has_fixture_white || cell_has_white.first().copied().unwrap_or(false);
                        (st.dimmer, st.color, dedicated, white)
                    }
                };

                let (rw, gw, bw, ww) = if has_white {
                    extract_rgbw(
                        cell_color[0],
                        cell_color[1],
                        cell_color[2],
                        cal.white_mode,
                        cal.white_gain,
                        cal.gamma,
                    )
                } else {
                    (cell_color[0], cell_color[1], cell_color[2], 0.0)
                };

                let component = color_component_for_ofl(*color, rw, gw, bw, ww, cell_color);
                if has_int {
                    write_scalar_slot(ch_idx, fixture, component, false, cal, &mut write_channel);
                } else {
                    let scaled = (component * cell_dim * strobe_gate).clamp(0.0, 1.0);
                    write_scalar_slot(ch_idx, fixture, scaled, true, cal, &mut write_channel);
                }
            }
        }
    }

    strobe_clamped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ofl::expander::StrobeRange;

    fn make_slot(
        dmx_offset: usize,
        name: &str,
        target: ChannelTarget,
        role: ChannelRole,
    ) -> CompiledChannelSlot {
        CompiledChannelSlot {
            universe_id: 1,
            universe_index: Some(0),
            dmx_address: (dmx_offset + 1) as u16,
            name: name.to_string(),
            default_value: 0,
            target,
            role,
            fine_channel_offset: None,
        }
    }

    #[test]
    fn virtual_dimmer_vs_dedicated_intensity_and_single_vs_multicell_master_routing() {
        // 1) Multi-cell fixture with Master Dimmer ONLY -> Virtual Dimmer scales cell colors
        let multi_fixture = CompiledFixture {
            id: "fx_multi".into(),
            name: "Multi Tube".into(),
            profile: "test".into(),
            mode: "multi".into(),
            calibration: FixtureCalibration {
                gamma: 1.0,
                min_dimmer_dmx: 0,
                max_dimmer_dmx: 255,
                white_mode: WhiteMode::Off,
                white_gain: 1.0,
            },
            cell_start: 0,
            cell_count: 2,
            channels: vec![
                make_slot(0, "Master Dimmer", ChannelTarget::Fixture, ChannelRole::Intensity),
                make_slot(
                    1,
                    "Red 1",
                    ChannelTarget::Cell {
                        cell_index: 0,
                        pixel_key: "1".into(),
                    },
                    ChannelRole::ColorIntensity {
                        color: OflColor::Red,
                    },
                ),
                make_slot(
                    2,
                    "Red 2",
                    ChannelTarget::Cell {
                        cell_index: 1,
                        pixel_key: "2".into(),
                    },
                    ChannelRole::ColorIntensity {
                        color: OflColor::Red,
                    },
                ),
            ],
        };
        let mut q = QuantizerState::default();
        let mut multi_dmx = [0u8; 3];
        quantize_fixture_to_dmx(
            0,
            &multi_fixture,
            &FixtureTraitState {
                master_dimmer: 1.0,
                master_dimmer_touched: false,
                any_cell_touched: true,
                shutter: ShutterState::Open,
                shutter_touched: false,
            },
            &[
                CellTraitState {
                    dimmer: 0.5,
                    dimmer_touched: true,
                    color: [1.0, 0.0, 0.0],
                    color_touched: true,
                },
                CellTraitState {
                    dimmer: 1.0,
                    dimmer_touched: true,
                    color: [1.0, 0.0, 0.0],
                    color_touched: true,
                },
            ],
            0.0,
            &mut q,
            |slot, val| multi_dmx[(slot.dmx_address - 1) as usize] = val,
        );
        assert_eq!(multi_dmx[0], 255);
        assert_eq!(multi_dmx[1], 128);
        assert_eq!(multi_dmx[2], 255);

        // 2) Single-cell fixture with Master Dimmer -> Master gets cell[0].dimmer * master_dimmer, Red stays unscaled
        let single_fixture = CompiledFixture {
            id: "fx_single".into(),
            name: "Single Par".into(),
            profile: "test".into(),
            mode: "single".into(),
            calibration: FixtureCalibration {
                gamma: 1.0,
                min_dimmer_dmx: 0,
                max_dimmer_dmx: 255,
                white_mode: WhiteMode::Off,
                white_gain: 1.0,
            },
            cell_start: 0,
            cell_count: 1,
            channels: vec![
                make_slot(0, "Master Dimmer", ChannelTarget::Fixture, ChannelRole::Intensity),
                make_slot(
                    1,
                    "Red",
                    ChannelTarget::Cell {
                        cell_index: 0,
                        pixel_key: "1".into(),
                    },
                    ChannelRole::ColorIntensity {
                        color: OflColor::Red,
                    },
                ),
            ],
        };
        let mut single_dmx = [0u8; 2];
        quantize_fixture_to_dmx(
            0,
            &single_fixture,
            &FixtureTraitState {
                master_dimmer: 0.5,
                master_dimmer_touched: true,
                any_cell_touched: true,
                shutter: ShutterState::Open,
                shutter_touched: false,
            },
            &[CellTraitState {
                dimmer: 0.5,
                dimmer_touched: true,
                color: [1.0, 0.0, 0.0],
                color_touched: true,
            }],
            0.0,
            &mut q,
            |slot, val| single_dmx[(slot.dmx_address - 1) as usize] = val,
        );
        assert_eq!(single_dmx[0], 64); // 0.25 * 255
        assert_eq!(single_dmx[1], 255); // unscaled color
    }

    #[test]
    fn deadzone_applies_min_dimmer_dmx_and_zero_input_outputs_exact_zero() {
        assert_eq!(quantize_value_u8(0.0, 2.2, 12, 240, true), 0);
        let low = quantize_value_u8(0.01, 2.2, 12, 240, true);
        assert!(low >= 12);
        assert_eq!(quantize_value_u8(1.0, 2.2, 12, 240, true), 240);
    }

    #[test]
    fn rgbw_replace_add_and_off_modes_with_gamma_luminance_compensation() {
        // Off keeps white at 0
        let (r_off, g_off, b_off, w_off) = extract_rgbw(0.8, 0.4, 0.4, WhiteMode::Off, 1.0, 2.2);
        assert_eq!(w_off, 0.0);
        assert!((r_off - 0.8).abs() < 1e-6);
        assert!((g_off - 0.4).abs() < 1e-6);
        assert!((b_off - 0.4).abs() < 1e-6);

        // Add preserves RGB and sets W = min * gain
        let (r_add, _, _, w_add) = extract_rgbw(0.8, 0.4, 0.4, WhiteMode::Add, 0.5, 2.2);
        assert!((r_add - 0.8).abs() < 1e-6);
        assert!((w_add - 0.2).abs() < 1e-6);

        // Replace extracts common white with gamma compensation: r^g + w^g == max^g
        let (r_rep, g_rep, b_rep, w_rep) =
            extract_rgbw(0.8, 0.4, 0.4, WhiteMode::Replace, 1.0, 2.2);
        assert!(g_rep <= 1e-6 && b_rep <= 1e-6);
        let post_gamma_sum = r_rep.powf(2.2) + w_rep.powf(2.2);
        assert!(
            (post_gamma_sum - 0.8_f32.powf(2.2)).abs() < 1e-4,
            "expected post-gamma luminance compensation: sum={post_gamma_sum}"
        );
    }

    #[test]
    fn color_wheel_matches_oklab_with_sequential_hysteresis_and_resets_on_time_jump() {
        let slots = vec![
            ResolvedWheelSlot {
                slot_number: 1,
                dmx_range: [0, 9],
                name: Some("Open White".into()),
                colors_hex: vec!["#FFFFFF".into()],
            },
            ResolvedWheelSlot {
                slot_number: 2,
                dmx_range: [10, 19],
                name: Some("Warm Orange".into()),
                colors_hex: vec!["#FF6600".into()],
            },
            ResolvedWheelSlot {
                slot_number: 3,
                dmx_range: [20, 29],
                name: Some("Amber Gold".into()),
                colors_hex: vec!["#FF7200".into()],
            },
            ResolvedWheelSlot {
                slot_number: 4,
                dmx_range: [30, 39],
                name: Some("Gobo Spin".into()),
                colors_hex: Vec::new(),
            },
        ];

        let mut q = QuantizerState::default();
        q.prepare_for_time(0.0);
        // Slightly closer to #FF6600 -> selects slot 2 (midpoint 14)
        let orange = parse_hex_to_oklab("#FF6800").unwrap();
        let dmx1 = select_color_wheel_dmx(
            super::super::color::oklab_to_linear_rgb(orange),
            &slots,
            0,
            0,
            &mut q,
        );
        assert_eq!(dmx1, 14);
        q.commit_time(0.0);

        // Sequential frame (+0.023s): slightly closer to #FF7200, but distance gain < 0.03 -> hysteresis holds slot 2!
        q.prepare_for_time(0.023);
        let amber_edge = parse_hex_to_oklab("#FF6D00").unwrap();
        let dmx2 = select_color_wheel_dmx(
            super::super::color::oklab_to_linear_rgb(amber_edge),
            &slots,
            0,
            0,
            &mut q,
        );
        assert_eq!(dmx2, 14);
        q.commit_time(0.023);

        // Time jump (> 0.1s): hysteresis bypassed, selects closest slot (#FF7200 -> midpoint 24)
        q.prepare_for_time(5.0);
        let close_to_slot3 = parse_hex_to_oklab("#FF7100").unwrap();
        let dmx3 = select_color_wheel_dmx(
            super::super::color::oklab_to_linear_rgb(close_to_slot3),
            &slots,
            0,
            0,
            &mut q,
        );
        assert_eq!(dmx3, 24);
    }

    #[test]
    fn hardware_shutter_interpolates_hz_and_software_strobe_caps_at_11hz_deterministically() {
        let caps = vec![
            StrobeRange {
                dmx_range: [0, 7],
                effect: OflShutterEffect::Closed,
                random_timing: false,
                speed_start_hz: None,
                speed_end_hz: None,
            },
            StrobeRange {
                dmx_range: [8, 15],
                effect: OflShutterEffect::Open,
                random_timing: false,
                speed_start_hz: None,
                speed_end_hz: None,
            },
            StrobeRange {
                dmx_range: [16, 200],
                effect: OflShutterEffect::Strobe,
                random_timing: false,
                speed_start_hz: Some(1.0),
                speed_end_hz: Some(20.0),
            },
            StrobeRange {
                dmx_range: [201, 255],
                effect: OflShutterEffect::Strobe,
                random_timing: true,
                speed_start_hz: Some(1.0),
                speed_end_hz: Some(20.0),
            },
        ];

        assert_eq!(map_hardware_shutter_dmx(ShutterState::Closed, &caps, 0), 3);
        assert_eq!(map_hardware_shutter_dmx(ShutterState::Open, &caps, 0), 11);
        let d_mid = map_hardware_shutter_dmx(ShutterState::StrobeHz(10.5), &caps, 0);
        assert!((d_mid as i16 - 108).abs() <= 1);
        assert_eq!(
            map_hardware_shutter_dmx(ShutterState::RandomStrobe(20.0), &caps, 0),
            255
        );

        // Software strobe caps > 11Hz and is deterministic across calls
        let (gate_on, clamped) = software_strobe_gate(ShutterState::StrobeHz(20.0), 0.01, 0);
        assert!(clamped);
        assert_eq!(gate_on, 1.0);
        let (gate_off, _) = software_strobe_gate(ShutterState::StrobeHz(20.0), 0.06, 0);
        assert_eq!(gate_off, 0.0);

        let (r1, c1) = software_strobe_gate(ShutterState::RandomStrobe(15.0), 1.25, 2);
        let (r2, c2) = software_strobe_gate(ShutterState::RandomStrobe(15.0), 1.25, 2);
        assert!(c1 && c2);
        assert_eq!(r1, r2);
    }

    #[test]
    fn sixteen_bit_channels_split_coarse_and_fine_bytes_accurately() {
        let mut q = QuantizerState::default();
        let fixture = CompiledFixture {
            id: "fx_16".into(),
            name: "16bit Dimmer".into(),
            profile: "test".into(),
            mode: "16bit".into(),
            calibration: FixtureCalibration {
                gamma: 1.0,
                min_dimmer_dmx: 0,
                max_dimmer_dmx: 255,
                white_mode: WhiteMode::Off,
                white_gain: 1.0,
            },
            cell_start: 0,
            cell_count: 1,
            channels: vec![
                CompiledChannelSlot {
                    universe_id: 1,
                    universe_index: Some(0),
                    dmx_address: 1,
                    name: "Dimmer".into(),
                    default_value: 0,
                    target: ChannelTarget::Cell {
                        cell_index: 0,
                        pixel_key: "1".into(),
                    },
                    role: ChannelRole::Intensity,
                    fine_channel_offset: Some(1),
                },
                CompiledChannelSlot {
                    universe_id: 1,
                    universe_index: Some(0),
                    dmx_address: 2,
                    name: "Dimmer fine".into(),
                    default_value: 0,
                    target: ChannelTarget::Cell {
                        cell_index: 0,
                        pixel_key: "1".into(),
                    },
                    role: ChannelRole::FineAlias {
                        parent_channel_name: "Dimmer".into(),
                        parent_offset: 0,
                        resolution_byte_index: 1,
                    },
                    fine_channel_offset: None,
                },
            ],
        };

        let mut dmx = [0u8; 2];
        quantize_fixture_to_dmx(
            0,
            &fixture,
            &FixtureTraitState {
                master_dimmer: 1.0,
                master_dimmer_touched: false,
                any_cell_touched: true,
                shutter: ShutterState::Open,
                shutter_touched: false,
            },
            &[CellTraitState {
                dimmer: 0.5,
                dimmer_touched: true,
                color: [0.0, 0.0, 0.0],
                color_touched: false,
            }],
            0.0,
            &mut q,
            |slot, val| dmx[(slot.dmx_address - 1) as usize] = val,
        );
        // round(0.5 * 65535) = 32768 = 0x8000 -> coarse 128, fine 0
        assert_eq!(dmx, [128, 0]);
    }
}
