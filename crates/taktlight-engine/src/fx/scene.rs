use std::collections::HashMap;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::engine::evaluator::ClockInput;
use crate::mixer::color::{
    linear_rgb_to_oklab, oklab_to_linear_rgb, parse_hex_to_linear_rgb, sample_hex_stops_linear,
    sample_value_stops, CompiledColorPalette, CompiledDimmerPalette,
};
use crate::mixer::traits::{
    fold_layers_into_states, resolve_target_cells_and_fixtures, CellTraitDelta, CellTraitState,
    FixtureTraitDelta, FixtureTraitState, MergeOp, ShutterState,
};
use crate::show::xml::{
    ClipDef, DurationUnit, FxBlockDef, FxElementDef, SceneDef, SceneSequenceStepDef,
    SequencePlaybackMode, TempoPointDef,
};
use crate::state::plan::RenderPlan;
use crate::state::runtime::RuntimeControl;

use super::evaluators::{
    evaluate_curve_1d_phase, evaluate_spatial_shader_2d_phase, evaluate_step_chase_phase,
    resolve_gizmo_half_extents,
    Shader2DKind, Waveform1D,
};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BeatClockAnchor {
    pub bpm: f32,
    pub t_anchor_sec: f64,
    pub beat_anchor: f64,
}

impl Default for BeatClockAnchor {
    fn default() -> Self {
        Self::new(120.0)
    }
}

impl BeatClockAnchor {
    pub fn new(bpm: f32) -> Self {
        Self {
            bpm: bpm.clamp(20.0, 300.0),
            t_anchor_sec: 0.0,
            beat_anchor: 0.0,
        }
    }

    pub fn beat_at(&self, t_sec: f64) -> f64 {
        self.beat_anchor + (t_sec - self.t_anchor_sec) * ((self.bpm as f64) / 60.0)
    }

    pub fn set_bpm_phase_continuous(&mut self, new_bpm: f32, t_now_sec: f64) {
        self.beat_anchor = self.beat_at(t_now_sec);
        self.t_anchor_sec = t_now_sec;
        self.bpm = new_bpm.clamp(20.0, 300.0);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveSceneInstance {
    pub scene_id: String,
    pub bank: Option<String>,
    pub trigger_t_sec: f64,
    pub trigger_beat: f64,
    pub trigger_order: u64,
    pub fade_in_sec: f32,
    pub fade_out_sec: f32,
    pub release_t_sec: Option<f64>,
    pub release_start_alpha: f32,
}

impl ActiveSceneInstance {
    pub fn alpha_at(&self, t_now_sec: f64) -> f32 {
        if t_now_sec < self.trigger_t_sec {
            return 0.0;
        }
        let dt_in = (t_now_sec - self.trigger_t_sec).max(0.0) as f32;
        let in_alpha = if self.fade_in_sec <= 1e-6 {
            1.0
        } else {
            (dt_in / self.fade_in_sec).clamp(0.0, 1.0)
        };

        if let Some(rel_t) = self.release_t_sec {
            let dt_out = (t_now_sec - rel_t).max(0.0) as f32;
            let out_factor = if self.fade_out_sec <= 1e-6 {
                0.0
            } else {
                (1.0 - (dt_out / self.fade_out_sec)).clamp(0.0, 1.0)
            };
            (self.release_start_alpha * out_factor).clamp(0.0, 1.0)
        } else {
            in_alpha
        }
    }

    pub fn is_finished(&self, t_now_sec: f64) -> bool {
        match self.release_t_sec {
            Some(rel_t) => t_now_sec >= rel_t && self.alpha_at(t_now_sec) <= 1e-6,
            None => false,
        }
    }
}

fn sample_color_palette_linear(
    color_map: &HashMap<&str, &CompiledColorPalette>,
    palette_ref: Option<&str>,
    w: f32,
) -> [f32; 3] {
    let clamped = w.clamp(0.0, 1.0);
    if let Some(pal) = palette_ref.and_then(|id| color_map.get(id).copied()) {
        pal.sample_linear_rgb(clamped)
    } else {
        [clamped, clamped, clamped]
    }
}

fn sample_color_element_linear(
    color_map: &HashMap<&str, &CompiledColorPalette>,
    palette_ref: Option<&str>,
    inline_colors: &[String],
    w: f32,
    gradient: f32,
    grayscale: bool,
    cyclic: bool,
) -> [f32; 3] {
    if !inline_colors.is_empty() {
        return sample_hex_stops_linear(inline_colors, w, gradient, grayscale, cyclic);
    }
    if let Some(pal) = palette_ref.and_then(|id| color_map.get(id).copied()) {
        return pal.sample_linear_rgb_ex(w, gradient, grayscale, cyclic);
    }
    let clamped = if cyclic {
        w.rem_euclid(1.0)
    } else {
        w.clamp(0.0, 1.0)
    };
    [clamped, clamped, clamped]
}

fn apply_scalar_trait_to_cell(
    trait_name: &str,
    op: MergeOp,
    cell_idx: usize,
    val: f32,
    alpha: f32,
    cell_to_fixture: &[usize],
    fixture_states: &mut [FixtureTraitState],
    cell_states: &mut [CellTraitState],
) {
    let t = trait_name.trim().to_ascii_lowercase();
    match t.as_str() {
        "red" => {
            cell_states[cell_idx].color[0] =
                op.apply_scalar(cell_states[cell_idx].color[0], val, alpha);
            cell_states[cell_idx].color_touched = true;
            if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                fixture_states[fx_idx].any_cell_touched = true;
            }
        }
        "green" => {
            cell_states[cell_idx].color[1] =
                op.apply_scalar(cell_states[cell_idx].color[1], val, alpha);
            cell_states[cell_idx].color_touched = true;
            if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                fixture_states[fx_idx].any_cell_touched = true;
            }
        }
        "blue" => {
            cell_states[cell_idx].color[2] =
                op.apply_scalar(cell_states[cell_idx].color[2], val, alpha);
            cell_states[cell_idx].color_touched = true;
            if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                fixture_states[fx_idx].any_cell_touched = true;
            }
        }
        "white" => {
            let delta = CellTraitDelta {
                dimmer: None,
                color: Some((op, [val, val, val])),
            };
            if cell_states[cell_idx].apply_cell_delta(&delta, alpha) {
                if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                    fixture_states[fx_idx].any_cell_touched = true;
                }
            }
        }
        "strobe" => {
            if alpha > 0.1 {
                if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                    fixture_states[fx_idx].shutter = if val > 0.05 {
                        ShutterState::StrobeHz(1.0 + val.clamp(0.0, 1.0) * 19.0)
                    } else {
                        ShutterState::Open
                    };
                    fixture_states[fx_idx].shutter_touched = true;
                }
            }
        }
        _ => {
            let delta = CellTraitDelta {
                dimmer: Some((op, val)),
                color: None,
            };
            if cell_states[cell_idx].apply_cell_delta(&delta, alpha) {
                if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                    fixture_states[fx_idx].any_cell_touched = true;
                    fixture_states[fx_idx].any_cell_dimmer_touched = true;
                }
            }
        }
    }
}

fn resolve_element_base_phase(
    b_block: f64,
    t_local: f64,
    cycle_cycles: f64,
    legacy_beats: Option<f32>,
    speed_hz: Option<f32>,
    rate_cycles: Option<f32>,
) -> f64 {
    if let Some(hz) = speed_hz {
        if hz > 0.0 {
            return t_local * (hz as f64);
        }
    }
    if let Some(rb) = legacy_beats {
        if rb > 0.0 {
            return b_block / (rb as f64);
        }
    }
    if let Some(rc) = rate_cycles {
        if rc <= 0.0 {
            return 0.0;
        }
        return cycle_cycles * (rc as f64);
    }
    cycle_cycles
}

const MAX_SCENE_SEQUENCE_DEPTH: u8 = 4;

pub fn compute_scene_sequence_duration_sec(steps: &[SceneSequenceStepDef], bpm: f32) -> f64 {
    let sec_per_beat = 60.0 / (bpm.max(1.0) as f64);
    steps
        .iter()
        .map(|st| match st.duration_unit {
            DurationUnit::Seconds => (st.duration_value as f64).max(0.05),
            DurationUnit::Beats => (st.duration_value as f64).max(0.05) * sec_per_beat,
        })
        .sum()
}

fn compute_block_natural_duration_sec(block: &FxBlockDef, show_bpm: f32) -> f64 {
    if let Some(FxElementDef::SceneSequence { steps, .. }) = block
        .elements
        .iter()
        .find(|el| matches!(el, FxElementDef::SceneSequence { .. }))
    {
        let seq_dur = compute_scene_sequence_duration_sec(steps, show_bpm);
        if seq_dur > 0.05 {
            return seq_dur;
        }
    }
    block
        .duration_sec
        .map(|s| (s as f64).max(0.05))
        .unwrap_or_else(|| {
            (block.duration_beats.max(0.25) as f64) * (60.0 / show_bpm.max(1.0) as f64)
        })
}

#[allow(clippy::too_many_arguments)]
fn fold_scene_sequence_into_states(
    plan: &RenderPlan,
    parent_block_id: &str,
    steps: &[SceneSequenceStepDef],
    playback_mode: SequencePlaybackMode,
    effective_target_group: &str,
    scene_alpha: f32,
    t_local: f64,
    b_local: f64,
    block_map: &HashMap<&str, &FxBlockDef>,
    scene_map: &HashMap<&str, &SceneDef>,
    fixture_index_by_id: &HashMap<&str, usize>,
    cell_to_fixture: &[usize],
    color_map: &HashMap<&str, &CompiledColorPalette>,
    dimmer_map: &HashMap<&str, &CompiledDimmerPalette>,
    fixture_states: &mut [FixtureTraitState],
    cell_states: &mut [CellTraitState],
    depth: u8,
) {
    if depth >= MAX_SCENE_SEQUENCE_DEPTH || steps.is_empty() || scene_alpha <= 0.0 {
        return;
    }

    let sec_per_beat = if t_local > 1e-6 && b_local > 1e-6 {
        (t_local / b_local).clamp(0.05, 10.0)
    } else {
        60.0 / (plan.show_bpm.max(1.0) as f64)
    };

    let step_durs: Vec<f64> = steps
        .iter()
        .map(|st| match st.duration_unit {
            DurationUnit::Seconds => (st.duration_value as f64).max(0.05),
            DurationUnit::Beats => (st.duration_value as f64).max(0.05) * sec_per_beat,
        })
        .collect();

    let n = steps.len();
    let total_linear_dur: f64 = step_durs.iter().sum();
    if total_linear_dur <= 1e-9 {
        return;
    }

    let t_clamped = t_local.max(0.0);
    let (active_idx, prev_idx, step_local_t): (usize, Option<usize>, f64) = match playback_mode {
        SequencePlaybackMode::Loop => {
            let t_mod = t_clamped.rem_euclid(total_linear_dur);
            let mut acc = 0.0;
            let mut found_idx = n - 1;
            let mut local_t = 0.0;
            for (i, &dur) in step_durs.iter().enumerate() {
                if t_mod < acc + dur || i == n - 1 {
                    found_idx = i;
                    local_t = (t_mod - acc).max(0.0);
                    break;
                }
                acc += dur;
            }
            let prev = if n > 1 && (found_idx > 0 || t_clamped >= step_durs[0]) {
                Some((found_idx + n - 1) % n)
            } else {
                None
            };
            (found_idx, prev, local_t)
        }
        SequencePlaybackMode::OneShot => {
            if t_clamped >= total_linear_dur {
                (n - 1, None, step_durs[n - 1])
            } else {
                let mut acc = 0.0;
                let mut found_idx = n - 1;
                let mut local_t = 0.0;
                for (i, &dur) in step_durs.iter().enumerate() {
                    if t_clamped < acc + dur || i == n - 1 {
                        found_idx = i;
                        local_t = (t_clamped - acc).max(0.0);
                        break;
                    }
                    acc += dur;
                }
                let prev = if found_idx > 0 {
                    Some(found_idx - 1)
                } else {
                    None
                };
                (found_idx, prev, local_t)
            }
        }
        SequencePlaybackMode::Bounce => {
            if n == 1 {
                (0, None, t_clamped.rem_euclid(step_durs[0]))
            } else {
                let mut order: Vec<usize> = Vec::with_capacity(2 * n - 2);
                for i in 0..n {
                    order.push(i);
                }
                for i in (1..n - 1).rev() {
                    order.push(i);
                }
                let cycle_dur: f64 = order.iter().map(|&idx| step_durs[idx]).sum();
                let t_mod = t_clamped.rem_euclid(cycle_dur);
                let mut acc = 0.0;
                let mut found_pos = order.len() - 1;
                let mut local_t = 0.0;
                for (pos, &step_idx) in order.iter().enumerate() {
                    let dur = step_durs[step_idx];
                    if t_mod < acc + dur || pos == order.len() - 1 {
                        found_pos = pos;
                        local_t = (t_mod - acc).max(0.0);
                        break;
                    }
                    acc += dur;
                }
                let found_idx = order[found_pos];
                let prev = if found_pos > 0 || t_clamped >= step_durs[order[0]] {
                    Some(order[(found_pos + order.len() - 1) % order.len()])
                } else {
                    None
                };
                (found_idx, prev, local_t)
            }
        }
    };

    let honor_step_targets =
        effective_target_group.trim().is_empty() || effective_target_group.eq_ignore_ascii_case("all");

    let eval_step = |step_idx: usize,
                         weight_alpha: f32,
                         local_t_sec: f64,
                         fixture_states: &mut [FixtureTraitState],
                         cell_states: &mut [CellTraitState]| {
        if weight_alpha <= 1e-6 {
            return;
        }
        let Some(step_scene) = scene_map.get(steps[step_idx].scene_id.as_str()).copied() else {
            return;
        };
        if step_scene.timeline_ref.is_some() {
            return;
        }
        let step_b_local = local_t_sec / sec_per_beat;
        let scene_target = step_scene
            .target_group
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        for block_ref in &step_scene.block_refs {
            if !parent_block_id.is_empty() && block_ref == parent_block_id {
                continue;
            }
            let Some(step_block) = block_map.get(block_ref.as_str()).copied() else {
                continue;
            };
            let target_group = if honor_step_targets {
                scene_target
                    .or_else(|| {
                        step_block
                            .target_group
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                    })
                    .unwrap_or(effective_target_group)
            } else {
                effective_target_group
            };
            fold_fx_block_into_states(
                plan,
                step_block,
                target_group,
                Some((step_scene.duration_value, step_scene.duration_unit)),
                weight_alpha,
                local_t_sec,
                step_b_local,
                block_map,
                scene_map,
                fixture_index_by_id,
                cell_to_fixture,
                color_map,
                dimmer_map,
                fixture_states,
                cell_states,
                depth + 1,
            );
        }
    };

    let fade_sec = (steps[active_idx].fade_sec as f64)
        .max(0.0)
        .min(step_durs[active_idx]);
    if fade_sec > 1e-6 && step_local_t < fade_sec {
        if let Some(prev_i) = prev_idx {
            if prev_i != active_idx {
                let cur_weight = (step_local_t / fade_sec).clamp(0.0, 1.0) as f32;
                let prev_weight = 1.0 - cur_weight;
                eval_step(
                    prev_i,
                    scene_alpha * prev_weight,
                    step_durs[prev_i] + step_local_t,
                    fixture_states,
                    cell_states,
                );
                eval_step(
                    active_idx,
                    scene_alpha * cur_weight,
                    step_local_t,
                    fixture_states,
                    cell_states,
                );
                return;
            }
        }
    }

    eval_step(
        active_idx,
        scene_alpha,
        step_local_t,
        fixture_states,
        cell_states,
    );
}

#[allow(clippy::too_many_arguments)]
fn fold_fx_block_into_states(
    plan: &RenderPlan,
    block: &FxBlockDef,
    effective_target_group: &str,
    scene_duration: Option<(f32, DurationUnit)>,
    scene_alpha: f32,
    t_local: f64,
    b_local: f64,
    block_map: &HashMap<&str, &FxBlockDef>,
    scene_map: &HashMap<&str, &SceneDef>,
    fixture_index_by_id: &HashMap<&str, usize>,
    cell_to_fixture: &[usize],
    color_map: &HashMap<&str, &CompiledColorPalette>,
    dimmer_map: &HashMap<&str, &CompiledDimmerPalette>,
    fixture_states: &mut [FixtureTraitState],
    cell_states: &mut [CellTraitState],
    depth: u8,
) {
    let cell_count = plan.cell_count as usize;
    let dur_beats = match scene_duration {
        Some((val, DurationUnit::Beats)) => (val as f64).max(0.05),
        _ => (block.duration_beats as f64).max(0.05),
    };
    let b_block = if block.loop_block {
        b_local.rem_euclid(dur_beats)
    } else {
        b_local.min(dur_beats)
    };
    let cycle_cycles = match scene_duration {
        Some((val, DurationUnit::Seconds)) => {
            let dur_sec = (val as f64).max(0.05);
            if block.loop_block {
                t_local / dur_sec
            } else {
                (t_local / dur_sec).min(1.0)
            }
        }
        _ => {
            if let Some(sec) = block.duration_sec {
                let dur_sec = (sec as f64).max(0.05);
                if block.loop_block {
                    t_local / dur_sec
                } else {
                    (t_local / dur_sec).min(1.0)
                }
            } else if block.loop_block {
                b_local / dur_beats
            } else {
                (b_local / dur_beats).min(1.0)
            }
        }
    };

    for elem in &block.elements {
        match elem {
            FxElementDef::StaticTrait {
                trait_name,
                op,
                palette_ref,
                value_start,
                value_end,
                hex_start,
                hex_end,
                order,
            } => {
                let parsed_op = MergeOp::from_str(op).unwrap_or(MergeOp::Htp);
                let (target_cells, target_fixtures) = resolve_target_cells_and_fixtures(
                    effective_target_group,
                    *order,
                    &plan.fixtures,
                    fixture_index_by_id,
                    cell_to_fixture,
                    &plan.groups,
                    cell_count,
                );
                if trait_name == "master_dimmer" {
                    let delta = FixtureTraitDelta {
                        master_dimmer: Some((parsed_op, value_start.unwrap_or(1.0))),
                        shutter: None,
                    };
                    for fx_idx in target_fixtures {
                        fixture_states[fx_idx].apply_fixture_delta(&delta, scene_alpha);
                    }
                } else if trait_name == "color" {
                    let v0 = value_start.unwrap_or(0.0);
                    let v1 = value_end.unwrap_or(1.0);
                    let inline_start = hex_start
                        .as_deref()
                        .and_then(parse_hex_to_linear_rgb);
                    let inline_end = hex_end
                        .as_deref()
                        .and_then(parse_hex_to_linear_rgb)
                        .or(inline_start);
                    for (cell_idx, u) in target_cells {
                        let w = v0 + u * (v1 - v0);
                        let rgb = if palette_ref.is_some() {
                            sample_color_palette_linear(color_map, palette_ref.as_deref(), w)
                        } else if let (Some(c0), Some(c1)) = (inline_start, inline_end) {
                            let lab0 = linear_rgb_to_oklab(c0);
                            let lab1 = linear_rgb_to_oklab(c1);
                            let t = w.clamp(0.0, 1.0);
                            oklab_to_linear_rgb([
                                lab0[0] + t * (lab1[0] - lab0[0]),
                                lab0[1] + t * (lab1[1] - lab0[1]),
                                lab0[2] + t * (lab1[2] - lab0[2]),
                            ])
                        } else {
                            sample_color_palette_linear(color_map, None, w)
                        };
                        let delta = CellTraitDelta {
                            dimmer: None,
                            color: Some((parsed_op, rgb)),
                        };
                        if cell_states[cell_idx].apply_cell_delta(&delta, scene_alpha) {
                            if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                                fixture_states[fx_idx].any_cell_touched = true;
                            }
                        }
                    }
                } else {
                    let dim_pal = palette_ref
                        .as_deref()
                        .and_then(|id| dimmer_map.get(id).copied());
                    let v0 = value_start.unwrap_or(1.0);
                    let v1 = value_end.unwrap_or(v0);
                    for (cell_idx, u) in target_cells {
                        let val = match dim_pal {
                            Some(p) => p.sample_dimmer(u),
                            None => v0 + u * (v1 - v0),
                        };
                        let delta = CellTraitDelta {
                            dimmer: Some((parsed_op, val)),
                            color: None,
                        };
                        if cell_states[cell_idx].apply_cell_delta(&delta, scene_alpha) {
                            if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                                fixture_states[fx_idx].any_cell_touched = true;
                                fixture_states[fx_idx].any_cell_dimmer_touched = true;
                            }
                        }
                    }
                }
            }
            FxElementDef::Curve1D {
                trait_name,
                op,
                waveform,
                amplitude,
                offset,
                rate_beats,
                speed_hz,
                rate_cycles,
                phase_deg,
                phase_spread_deg,
                duty,
                grayscale,
                color_width,
                gradient,
                angle_deg,
                fx_kind_tag,
                inline_colors,
                value_stops,
                palette_ref,
                order,
            } => {
                let parsed_op = MergeOp::from_str(op).unwrap_or(MergeOp::Add);
                let parsed_wf = Waveform1D::from_str(waveform).unwrap_or(Waveform1D::Sine);
                let base_phase = resolve_element_base_phase(
                    b_block,
                    t_local,
                    cycle_cycles,
                    *rate_beats,
                    *speed_hz,
                    *rate_cycles,
                );
                let (target_cells, target_fixtures) = resolve_target_cells_and_fixtures(
                    effective_target_group,
                    *order,
                    &plan.fixtures,
                    fixture_index_by_id,
                    cell_to_fixture,
                    &plan.groups,
                    cell_count,
                );
                if trait_name == "master_dimmer" {
                    let is_bipolar = parsed_op == MergeOp::Add;
                    let val = evaluate_curve_1d_phase(
                        parsed_wf,
                        base_phase,
                        0.0,
                        *phase_deg,
                        *phase_spread_deg,
                        *duty,
                        *amplitude,
                        *offset,
                        is_bipolar,
                    );
                    let delta = FixtureTraitDelta {
                        master_dimmer: Some((parsed_op, val)),
                        shutter: None,
                    };
                    for fx_idx in target_fixtures {
                        fixture_states[fx_idx].apply_fixture_delta(&delta, scene_alpha);
                    }
                } else if trait_name == "color" {
                    let is_color_fx = fx_kind_tag.as_deref() == Some("color_fx");
                    let cw = color_width.clamp(0.1, 4.0);
                    let dir_sign = if angle_deg.rem_euclid(360.0) >= 180.0 {
                        -1.0f64
                    } else {
                        1.0f64
                    };
                    for (cell_idx, u) in target_cells {
                        let rgb = if is_color_fx {
                            let phi = (base_phase * dir_sign
                                + (*phase_deg as f64) / 360.0
                                + (u as f64)
                                    * ((*phase_spread_deg as f64) / 360.0)
                                    / (cw as f64))
                                .rem_euclid(1.0) as f32;
                            sample_color_element_linear(
                                color_map,
                                palette_ref.as_deref(),
                                inline_colors,
                                phi,
                                *gradient,
                                *grayscale,
                                true,
                            )
                        } else {
                            let w = evaluate_curve_1d_phase(
                                parsed_wf,
                                base_phase,
                                u,
                                *phase_deg,
                                *phase_spread_deg,
                                *duty,
                                *amplitude,
                                *offset,
                                false,
                            );
                            sample_color_element_linear(
                                color_map,
                                palette_ref.as_deref(),
                                inline_colors,
                                w,
                                *gradient,
                                *grayscale,
                                false,
                            )
                        };
                        let delta = CellTraitDelta {
                            dimmer: None,
                            color: Some((parsed_op, rgb)),
                        };
                        if cell_states[cell_idx].apply_cell_delta(&delta, scene_alpha) {
                            if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                                fixture_states[fx_idx].any_cell_touched = true;
                            }
                        }
                    }
                } else {
                    let is_bipolar = parsed_op == MergeOp::Add;
                    let is_value_fx =
                        fx_kind_tag.as_deref() == Some("value_fx") && !value_stops.is_empty();
                    for (cell_idx, u) in target_cells {
                        let val = if is_value_fx {
                            let phi = (base_phase
                                + (*phase_deg as f64) / 360.0
                                + (u as f64) * ((*phase_spread_deg as f64) / 360.0))
                                .rem_euclid(1.0) as f32;
                            *offset
                                + *amplitude * sample_value_stops(value_stops, phi, *gradient, true)
                        } else {
                            evaluate_curve_1d_phase(
                                parsed_wf,
                                base_phase,
                                u,
                                *phase_deg,
                                *phase_spread_deg,
                                *duty,
                                *amplitude,
                                *offset,
                                is_bipolar,
                            )
                        };
                        apply_scalar_trait_to_cell(
                            trait_name,
                            parsed_op,
                            cell_idx,
                            val,
                            scene_alpha,
                            cell_to_fixture,
                            fixture_states,
                            cell_states,
                        );
                    }
                }
            }
            FxElementDef::StepChase {
                trait_name,
                op,
                step_beats,
                speed_hz,
                rate_cycles,
                one_way,
                pixels_on,
                active_ratio,
                fade,
                amplitude,
                palette_ref,
                order,
            } => {
                let parsed_op = MergeOp::from_str(op).unwrap_or(MergeOp::Htp);
                let base_phase = resolve_element_base_phase(
                    b_block,
                    t_local,
                    cycle_cycles,
                    *step_beats,
                    *speed_hz,
                    *rate_cycles,
                );
                let (target_cells, target_fixtures) = resolve_target_cells_and_fixtures(
                    effective_target_group,
                    *order,
                    &plan.fixtures,
                    fixture_index_by_id,
                    cell_to_fixture,
                    &plan.groups,
                    cell_count,
                );
                if trait_name == "master_dimmer" {
                    let val = evaluate_step_chase_phase(
                        base_phase,
                        0.0,
                        target_fixtures.len().max(1),
                        *active_ratio,
                        *pixels_on,
                        *one_way,
                        *fade,
                        *amplitude,
                    );
                    let delta = FixtureTraitDelta {
                        master_dimmer: Some((parsed_op, val)),
                        shutter: None,
                    };
                    for fx_idx in target_fixtures {
                        fixture_states[fx_idx].apply_fixture_delta(&delta, scene_alpha);
                    }
                } else {
                    let total = target_cells.len();
                    for (cell_idx, u) in target_cells {
                        let val = evaluate_step_chase_phase(
                            base_phase,
                            u,
                            total,
                            *active_ratio,
                            *pixels_on,
                            *one_way,
                            *fade,
                            *amplitude,
                        );
                        if trait_name == "color" {
                            let rgb =
                                sample_color_palette_linear(color_map, palette_ref.as_deref(), val);
                            let delta = CellTraitDelta {
                                dimmer: None,
                                color: Some((parsed_op, rgb)),
                            };
                            if cell_states[cell_idx].apply_cell_delta(&delta, scene_alpha) {
                                if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                                    fixture_states[fx_idx].any_cell_touched = true;
                                }
                            }
                        } else {
                            apply_scalar_trait_to_cell(
                                trait_name,
                                parsed_op,
                                cell_idx,
                                val,
                                scene_alpha,
                                cell_to_fixture,
                                fixture_states,
                                cell_states,
                            );
                        }
                    }
                }
            }
            FxElementDef::SpatialShader2D {
                trait_name,
                op,
                shader,
                palette_ref,
                rate_beats,
                speed_hz,
                rate_cycles,
                phase_offset,
                spatial_freq,
                color_width,
                gradient,
                grayscale,
                transform,
                inline_colors,
                value_stops,
                direction_deg,
                center_x,
                center_y,
                box_half_x,
                box_half_y,
            } => {
                let parsed_op = MergeOp::from_str(op).unwrap_or(MergeOp::Ltp);
                let parsed_shader = Shader2DKind::from_str(shader).unwrap_or(Shader2DKind::LinearSweep);
                let base_phase = resolve_element_base_phase(
                    b_block,
                    t_local,
                    cycle_cycles,
                    *rate_beats,
                    *speed_hz,
                    *rate_cycles,
                ) + (phase_offset.unwrap_or(0.0) as f64);
                let (target_cells, _) = resolve_target_cells_and_fixtures(
                    effective_target_group,
                    None,
                    &plan.fixtures,
                    fixture_index_by_id,
                    cell_to_fixture,
                    &plan.groups,
                    cell_count,
                );
                let (box_half_x, box_half_y) =
                    resolve_gizmo_half_extents(*spatial_freq, *box_half_x, *box_half_y);
                for (cell_idx, _) in target_cells {
                    let canvas_xy = plan
                        .cells
                        .get(cell_idx)
                        .map(|c| c.canvas_xy)
                        .unwrap_or([0.5, 0.5]);
                    if (canvas_xy[0] - *center_x).abs() > box_half_x + 1e-6
                        || (canvas_xy[1] - *center_y).abs() > box_half_y + 1e-6
                    {
                        continue;
                    }
                    let s = evaluate_spatial_shader_2d_phase(
                        parsed_shader,
                        canvas_xy,
                        base_phase,
                        *spatial_freq,
                        *color_width,
                        *direction_deg,
                        *center_x,
                        *center_y,
                        transform.as_deref(),
                    );
                    if trait_name == "color" {
                        let rgb = sample_color_element_linear(
                            color_map,
                            palette_ref.as_deref(),
                            inline_colors,
                            s,
                            *gradient,
                            *grayscale,
                            true,
                        );
                        let delta = CellTraitDelta {
                            dimmer: None,
                            color: Some((parsed_op, rgb)),
                        };
                        if cell_states[cell_idx].apply_cell_delta(&delta, scene_alpha) {
                            if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                                fixture_states[fx_idx].any_cell_touched = true;
                            }
                        }
                    } else {
                        let val = if !value_stops.is_empty() {
                            sample_value_stops(value_stops, s, *gradient, true)
                        } else if *gradient < 0.01 {
                            (s * 4.0).floor() / 4.0
                        } else {
                            s
                        };
                        if trait_name == "master_dimmer" {
                            if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                                let delta = FixtureTraitDelta {
                                    master_dimmer: Some((parsed_op, val)),
                                    shutter: None,
                                };
                                fixture_states[fx_idx].apply_fixture_delta(&delta, scene_alpha);
                                fixture_states[fx_idx].any_cell_touched = true;
                            }
                        } else {
                            apply_scalar_trait_to_cell(
                                trait_name,
                                parsed_op,
                                cell_idx,
                                val,
                                scene_alpha,
                                cell_to_fixture,
                                fixture_states,
                                cell_states,
                            );
                        }
                    }
                }
            }
            FxElementDef::SceneSequence {
                playback_mode,
                steps,
            } => {
                fold_scene_sequence_into_states(
                    plan,
                    &block.id,
                    steps,
                    *playback_mode,
                    effective_target_group,
                    scene_alpha,
                    t_local,
                    b_local,
                    block_map,
                    scene_map,
                    fixture_index_by_id,
                    cell_to_fixture,
                    color_map,
                    dimmer_map,
                    fixture_states,
                    cell_states,
                    depth,
                );
            }
        }
    }
}

pub fn integrate_tempo_map_beats(
    tempo_map: &[TempoPointDef],
    default_bpm: f32,
    t_start_sec: f64,
    t_end_sec: f64,
) -> f64 {
    if t_end_sec <= t_start_sec {
        return 0.0;
    }
    let fallback_bpm = (default_bpm.clamp(20.0, 300.0)) as f64;
    if tempo_map.is_empty() {
        return (t_end_sec - t_start_sec) * fallback_bpm / 60.0;
    }

    let mut points: Vec<&TempoPointDef> = tempo_map.iter().collect();
    points.sort_by(|a, b| a.at_sec.total_cmp(&b.at_sec));

    let bpm_at = |t: f64| -> f64 {
        let mut active = fallback_bpm;
        for pt in &points {
            if pt.at_sec <= t {
                active = (pt.bpm.clamp(20.0, 300.0)) as f64;
            } else {
                break;
            }
        }
        active
    };

    let mut cur = t_start_sec;
    let mut beats = 0.0f64;
    for pt in &points {
        if pt.at_sec > cur && pt.at_sec < t_end_sec {
            beats += (pt.at_sec - cur) * bpm_at(cur) / 60.0;
            cur = pt.at_sec;
        }
    }
    if t_end_sec > cur {
        beats += (t_end_sec - cur) * bpm_at(cur) / 60.0;
    }
    beats
}

pub fn clip_alpha_at(clip: &ClipDef, t_timeline_sec: f64) -> f32 {
    if clip.duration_sec <= 0.0 {
        return 0.0;
    }
    let clip_end = clip.start_sec + clip.duration_sec;
    if t_timeline_sec < clip.start_sec || t_timeline_sec >= clip_end {
        return 0.0;
    }
    let dt_in = (t_timeline_sec - clip.start_sec).max(0.0) as f32;
    let dt_rem = (clip_end - t_timeline_sec).max(0.0) as f32;
    let in_alpha = if clip.fade_in_sec <= 1e-6 {
        1.0
    } else {
        (dt_in / clip.fade_in_sec).clamp(0.0, 1.0)
    };
    let out_alpha = if clip.fade_out_sec <= 1e-6 {
        1.0
    } else {
        (dt_rem / clip.fade_out_sec).clamp(0.0, 1.0)
    };
    in_alpha.min(out_alpha)
}

pub fn evaluate_scenes_and_live_layers(
    plan: &RenderPlan,
    clock: &ClockInput,
    runtime: &RuntimeControl,
) -> (Vec<FixtureTraitState>, Vec<CellTraitState>) {
    evaluate_scenes_and_live_layers_with_audio_clock(plan, clock, runtime, None)
}

pub fn evaluate_scenes_and_live_layers_with_audio_clock(
    plan: &RenderPlan,
    clock: &ClockInput,
    runtime: &RuntimeControl,
    audio_clock_playhead_sec: Option<f64>,
) -> (Vec<FixtureTraitState>, Vec<CellTraitState>) {
    let cell_count = plan.cell_count as usize;
    let mut fixture_states = vec![FixtureTraitState::default(); plan.fixtures.len()];
    let mut cell_states = vec![CellTraitState::default(); cell_count];

    let mut cell_to_fixture = vec![0usize; cell_count];
    let mut fixture_index_by_id: HashMap<&str, usize> = HashMap::with_capacity(plan.fixtures.len());
    for (fx_idx, fx) in plan.fixtures.iter().enumerate() {
        fixture_index_by_id.insert(fx.id.as_str(), fx_idx);
        let end = (fx.cell_start + fx.cell_count as usize).min(cell_count);
        for slot in &mut cell_to_fixture[fx.cell_start.min(cell_count)..end] {
            *slot = fx_idx;
        }
    }

    let color_map: HashMap<&str, &CompiledColorPalette> = plan
        .color_palettes
        .iter()
        .map(|p| (p.id.as_str(), p))
        .collect();
    let dimmer_map: HashMap<&str, &CompiledDimmerPalette> = plan
        .dimmer_palettes
        .iter()
        .map(|p| (p.id.as_str(), p))
        .collect();
    let block_map: HashMap<&str, &FxBlockDef> =
        plan.fx_blocks.iter().map(|b| (b.id.as_str(), b)).collect();
    let scene_map: HashMap<&str, &SceneDef> =
        plan.scenes.iter().map(|s| (s.id.as_str(), s)).collect();

    // 1. Timeline layer (bottom of stack): tracks evaluated in document order (later track on top)
    let resolved_timeline_playhead = if runtime.timeline_playing {
        audio_clock_playhead_sec.or_else(|| runtime.effective_timeline_playhead_sec(clock.t_sec))
    } else {
        runtime.effective_timeline_playhead_sec(clock.t_sec)
    };
    if let (Some(tl_id), Some(t_tl)) = (
        runtime.active_timeline_id.as_deref(),
        resolved_timeline_playhead,
    ) {
        if let Some(timeline) = plan.timelines.iter().find(|t| t.id == tl_id) {
            for track in &timeline.tracks {
                let track_target = track
                    .target_group
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                for clip in &track.clips {
                    let clip_alpha = clip_alpha_at(clip, t_tl);
                    if clip_alpha <= 0.0 {
                        continue;
                    }
                    let t_local = (t_tl - clip.start_sec).max(0.0);
                    let b_local = integrate_tempo_map_beats(
                        &timeline.tempo_map,
                        plan.show_bpm,
                        clip.start_sec,
                        t_tl,
                    );

                    if let Some(ref block_ref) = clip.ref_block {
                        let Some(block) = block_map.get(block_ref.as_str()).copied() else {
                            continue;
                        };
                        let Some(target_group) = track_target.or_else(|| {
                            block
                                .target_group
                                .as_deref()
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                        }) else {
                            continue;
                        };
                        let phase_scale = if clip.time_stretch && clip.duration_sec > 1e-6 {
                            let nat_sec = clip
                                .source_duration_sec
                                .unwrap_or_else(|| compute_block_natural_duration_sec(block, plan.show_bpm));
                            (nat_sec / clip.duration_sec).max(0.01)
                        } else {
                            1.0
                        };
                        fold_fx_block_into_states(
                            plan,
                            block,
                            target_group,
                            None,
                            clip_alpha,
                            t_local * phase_scale,
                            b_local * phase_scale,
                            &block_map,
                            &scene_map,
                            &fixture_index_by_id,
                            &cell_to_fixture,
                            &color_map,
                            &dimmer_map,
                            &mut fixture_states,
                            &mut cell_states,
                            0,
                        );
                    } else if !clip.inline_fx.is_empty() {
                        let target_group = track_target.unwrap_or("all");
                        let clip_beats = integrate_tempo_map_beats(
                            &timeline.tempo_map,
                            plan.show_bpm,
                            clip.start_sec,
                            clip.start_sec + clip.duration_sec,
                        )
                        .max(0.25) as f32;
                        let inline_block = FxBlockDef {
                            id: String::new(),
                            name: String::new(),
                            target_group: Some(target_group.to_string()),
                            duration_beats: clip_beats,
                            duration_sec: None,
                            loop_block: true,
                            elements: clip.inline_fx.clone(),
                        };
                        fold_fx_block_into_states(
                            plan,
                            &inline_block,
                            target_group,
                            None,
                            clip_alpha,
                            t_local,
                            b_local,
                            &block_map,
                            &scene_map,
                            &fixture_index_by_id,
                            &cell_to_fixture,
                            &color_map,
                            &dimmer_map,
                            &mut fixture_states,
                            &mut cell_states,
                            0,
                        );
                    }
                }
            }
        }
    }

    // 2. Live Scene layers on top of Timeline: sorted bottom-to-top by (SceneDef.priority, trigger_order)
    let mut active_with_def: Vec<(&ActiveSceneInstance, &SceneDef, f32)> = runtime
        .active_scenes
        .iter()
        .filter_map(|inst| {
            let def = scene_map.get(inst.scene_id.as_str()).copied()?;
            let alpha = inst.alpha_at(clock.t_sec);
            (alpha > 0.0).then_some((inst, def, alpha))
        })
        .collect();
    active_with_def.sort_by_key(|(inst, def, _)| (def.priority, inst.trigger_order));

    let b_now = runtime.beat_clock.beat_at(clock.t_sec);
    for (inst, def, alpha) in active_with_def {
        let t_local = (clock.t_sec - inst.trigger_t_sec).max(0.0);
        let b_local = (b_now - inst.trigger_beat).max(0.0);
        for block_ref in &def.block_refs {
            let Some(block) = block_map.get(block_ref.as_str()).copied() else {
                continue;
            };
            let Some(target_group) = def
                .target_group
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    block
                        .target_group
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                })
            else {
                continue;
            };
            fold_fx_block_into_states(
                plan,
                block,
                target_group,
                Some((def.duration_value, def.duration_unit)),
                alpha,
                t_local,
                b_local,
                &block_map,
                &scene_map,
                &fixture_index_by_id,
                &cell_to_fixture,
                &color_map,
                &dimmer_map,
                &mut fixture_states,
                &mut cell_states,
                0,
            );
        }
    }

    // Live SmartControlLayer stack evaluates on top of scenes
    fold_layers_into_states(
        &plan.fixtures,
        &plan.groups,
        &plan.color_palettes,
        &plan.dimmer_palettes,
        cell_count,
        &runtime.live_layers,
        &mut fixture_states,
        &mut cell_states,
    );

    for fx_state in &mut fixture_states {
        fx_state.finalize_fixture_state(runtime.grand_master, runtime.blackout);
    }
    for (cell_idx, cell_state) in cell_states.iter_mut().enumerate() {
        let fx_state = cell_to_fixture
            .get(cell_idx)
            .and_then(|&fx_idx| fixture_states.get(fx_idx));
        match fx_state {
            Some(fs) => {
                cell_state.finalize_cell_state_with_fixture(fs, runtime.grand_master, runtime.blackout)
            }
            None => cell_state.finalize_cell_state(runtime.grand_master, runtime.blackout),
        }
    }

    (fixture_states, cell_states)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene(id: &str, bank: Option<&str>, priority: i32, fade_in: f32, fade_out: f32) -> SceneDef {
        SceneDef {
            id: id.to_string(),
            name: id.to_string(),
            bank: bank.map(str::to_string),
            target_group: Some("grp_1".to_string()),
            priority,
            fade_in_sec: fade_in,
            fade_out_sec: fade_out,
            duration_value: 4.0,
            duration_unit: DurationUnit::Beats,
            block_refs: vec!["blk_1".to_string()],
            timeline_ref: None,
        }
    }

    #[test]
    fn scene_bank_auto_releases_previous_scene_in_same_bank_while_keeping_overlay_scenes() {
        let mut rt = RuntimeControl::new();
        let sc_a = scene("sc_a", Some("main"), 10, 0.0, 1.0);
        let sc_b = scene("sc_b", Some("main"), 10, 0.5, 1.0);
        let sc_overlay = scene("sc_overlay", None, 20, 0.0, 0.5);

        rt.trigger_scene(&sc_a, 1.0);
        rt.trigger_scene(&sc_overlay, 1.5);
        assert_eq!(rt.active_scenes.len(), 2);

        // Triggering sc_b in bank "main" releases sc_a at t=2.0 while sc_overlay remains active
        rt.trigger_scene(&sc_b, 2.0);
        assert_eq!(rt.active_scenes.len(), 3);

        let a_inst = rt.active_scenes.iter().find(|s| s.scene_id == "sc_a").unwrap();
        let b_inst = rt.active_scenes.iter().find(|s| s.scene_id == "sc_b").unwrap();
        let ov_inst = rt
            .active_scenes
            .iter()
            .find(|s| s.scene_id == "sc_overlay")
            .unwrap();

        assert_eq!(a_inst.release_t_sec, Some(2.0));
        assert!((a_inst.alpha_at(2.5) - 0.5).abs() < 1e-5);
        assert!(a_inst.is_finished(3.1));
        assert!(ov_inst.release_t_sec.is_none());
        assert_eq!(ov_inst.alpha_at(2.5), 1.0);
        assert!((b_inst.alpha_at(2.25) - 0.5).abs() < 1e-5);
    }

    #[test]
    fn tap_tempo_and_live_bpm_changes_preserve_phase_continuity_without_jump() {
        let mut rt = RuntimeControl::new();
        assert_eq!(rt.beat_clock.bpm, 120.0);

        // At 120 BPM, 2.5 seconds = 5.0 beats
        let beat_before = rt.beat_clock.beat_at(2.5);
        assert!((beat_before - 5.0).abs() < 1e-6);

        // Tap tempo: 0.4s intervals -> 150 BPM
        rt.tap_tempo(2.1);
        let bpm = rt.tap_tempo(2.5);
        assert!((bpm - 150.0).abs() < 1e-3);

        // Right at tap time t=2.5s, beat position must still be 5.0 (zero jump)
        let beat_at_switch = rt.beat_clock.beat_at(2.5);
        assert!((beat_at_switch - 5.0).abs() < 1e-6);

        // 0.4s later at 150 BPM = +1.0 beat -> 6.0
        assert!((rt.beat_clock.beat_at(2.9) - 6.0).abs() < 1e-5);
    }

    #[test]
    fn scene_fade_in_and_mid_fade_release_envelope_is_continuous() {
        let mut rt = RuntimeControl::new();
        let sc = scene("sc_fade", None, 10, 1.0, 2.0);
        rt.trigger_scene(&sc, 10.0);

        // Halfway through 1.0s fade-in: alpha = 0.5
        assert!((rt.active_scenes[0].alpha_at(10.5) - 0.5).abs() < 1e-5);

        // Release mid fade-in at t=10.5s: starts fade-out smoothly from 0.5 (not jumping to 1.0!)
        rt.release_scene("sc_fade", 10.5);
        assert!((rt.active_scenes[0].alpha_at(10.5) - 0.5).abs() < 1e-5);
        assert!((rt.active_scenes[0].alpha_at(11.5) - 0.25).abs() < 1e-5);
        assert!((rt.active_scenes[0].alpha_at(12.5) - 0.0).abs() < 1e-5);
    }

    #[test]
    fn tempo_map_integrates_piecewise_bpm_changes_and_clip_fades_are_exact() {
        let tempo_map = vec![
            TempoPointDef {
                at_sec: 0.0,
                bpm: 120.0,
            },
            TempoPointDef {
                at_sec: 2.0,
                bpm: 150.0,
            },
        ];

        // 0..2s at 120 BPM = 4.0 beats; 2..4s at 150 BPM = 5.0 beats -> total 9.0 beats
        let beats = integrate_tempo_map_beats(&tempo_map, 120.0, 0.0, 4.0);
        assert!((beats - 9.0).abs() < 1e-9);

        // Clip window [1.0, 5.0) with 1.0s fade-in and 1.0s fade-out
        let clip = ClipDef {
            ref_block: Some("blk_1".to_string()),
            start_sec: 1.0,
            duration_sec: 4.0,
            fade_in_sec: 1.0,
            fade_out_sec: 1.0,
            inline_fx: Vec::new(),
            ..Default::default()
        };
        assert_eq!(clip_alpha_at(&clip, 0.9), 0.0);
        assert_eq!(clip_alpha_at(&clip, 1.0), 0.0);
        assert!((clip_alpha_at(&clip, 1.5) - 0.5).abs() < 1e-5);
        assert_eq!(clip_alpha_at(&clip, 2.5), 1.0);
        assert!((clip_alpha_at(&clip, 4.5) - 0.5).abs() < 1e-5);
        assert_eq!(clip_alpha_at(&clip, 5.0), 0.0);
    }

    fn build_two_fixture_sequence_show(
        mode: SequencePlaybackMode,
        fade_sec: f32,
        track_target: Option<&str>,
        time_stretch: bool,
        clip_duration_sec: f64,
    ) -> (RenderPlan, SceneDef) {
        use crate::ofl::library::FixtureLibrary;
        use crate::show::compiler::compile_render_plan;
        use crate::show::patch::{FixtureCalibration, FixtureInstance};
        use crate::show::spatial::{GridPos, OrderRule};
        use crate::show::xml::{FixtureGroupDef, ShowState, TimelineDef, TrackDef, TrackType};

        let lib = FixtureLibrary::load_with_test_fixtures();
        let mut show = ShowState::default();
        show.bpm = 120.0;

        for (i, id) in ["fx_1", "fx_2"].iter().enumerate() {
            show.patch.push(FixtureInstance {
                id: (*id).into(),
                profile: "user/test_tube_8seg.json".into(),
                mode: "34ch Pixel Mode".into(),
                name: format!("Tube {}", i + 1),
                universe: 1,
                address: (1 + i * 40) as u16,
                channel_count: 34,
                grid_pos: GridPos {
                    x: 0.25 + (i as f32) * 0.5,
                    y: 0.5,
                    rotation: 0.0,
                    scale_x: 0.3,
                    scale_y: 0.05,
                },
                calibration: FixtureCalibration::default(),
            });
        }

        show.groups.push(FixtureGroupDef {
            id: "grp_a".into(),
            name: "Group A".into(),
            order: OrderRule::Linear,
            targets: vec!["fx_1".into()],
        });
        show.groups.push(FixtureGroupDef {
            id: "grp_b".into(),
            name: "Group B".into(),
            order: OrderRule::Linear,
            targets: vec!["fx_2".into()],
        });

        let make_solid = |id: &str, grp: &str, dim: f32| FxBlockDef {
            id: id.into(),
            name: id.into(),
            target_group: Some(grp.into()),
            duration_beats: 4.0,
            duration_sec: None,
            loop_block: true,
            elements: vec![FxElementDef::StaticTrait {
                trait_name: "dimmer".into(),
                op: "ltp".into(),
                palette_ref: None,
                value_start: Some(dim),
                value_end: Some(dim),
                hex_start: None,
                hex_end: None,
                order: None,
            }],
        };

        show.fx_library.push(make_solid("blk_1", "grp_a", 0.2));
        show.fx_library.push(make_solid("blk_2", "grp_b", 0.6));
        show.fx_library.push(make_solid("blk_3", "grp_a", 1.0));
        show.fx_library.push(FxBlockDef {
            id: "blk_seq".into(),
            name: "Seq".into(),
            target_group: Some("all".into()),
            duration_beats: 6.0,
            duration_sec: None,
            loop_block: true,
            elements: vec![FxElementDef::SceneSequence {
                playback_mode: mode,
                steps: vec![
                    SceneSequenceStepDef {
                        scene_id: "sc_1".into(),
                        duration_value: 2.0, // 1.0s at 120 BPM
                        duration_unit: DurationUnit::Beats,
                        fade_sec,
                    },
                    SceneSequenceStepDef {
                        scene_id: "sc_2".into(),
                        duration_value: 1.0, // 1.0s
                        duration_unit: DurationUnit::Seconds,
                        fade_sec,
                    },
                    SceneSequenceStepDef {
                        scene_id: "sc_3".into(),
                        duration_value: 1.0, // 1.0s
                        duration_unit: DurationUnit::Seconds,
                        fade_sec,
                    },
                ],
            }],
        });

        let make_sc = |id: &str, grp: &str, blk: &str| SceneDef {
            id: id.into(),
            name: id.into(),
            bank: Some("Bank 1".into()),
            target_group: Some(grp.into()),
            priority: 10,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            duration_value: 4.0,
            duration_unit: DurationUnit::Beats,
            block_refs: vec![blk.into()],
            timeline_ref: None,
        };
        show.scenes.push(make_sc("sc_1", "grp_a", "blk_1"));
        show.scenes.push(make_sc("sc_2", "grp_b", "blk_2"));
        show.scenes.push(make_sc("sc_3", "grp_a", "blk_3"));
        let sc_seq = make_sc("sc_seq", "all", "blk_seq");
        show.scenes.push(sc_seq.clone());

        show.timelines.push(TimelineDef {
            id: "tl_1".into(),
            name: "TL".into(),
            duration_sec: 20.0,
            grid_offset_sec: 0.0,
            tempo_map: vec![TempoPointDef {
                at_sec: 0.0,
                bpm: 120.0,
            }],
            audio_track: None,
            loop_timeline: false,
            tracks: vec![TrackDef {
                id: "trk_1".into(),
                name: "Track 1".into(),
                track_type: TrackType::Effect,
                target_group: track_target.map(str::to_string),
                clips: vec![ClipDef {
                    ref_block: Some("blk_seq".into()),
                    start_sec: 0.0,
                    duration_sec: clip_duration_sec,
                    fade_in_sec: 0.0,
                    fade_out_sec: 0.0,
                    inline_fx: Vec::new(),
                    audio_file: None,
                    time_stretch,
                    source_duration_sec: Some(3.0),
                }],
            }],
        });

        let plan = compile_render_plan(1, &show, &lib).expect("compile plan");
        (plan, sc_seq)
    }

    #[test]
    fn scene_sequence_evaluates_steps_crossfade_modes_and_cycle_guard() {
        // 1. Loop mode with 0.5s crossfade: steps are 1s (grp_a=0.2), 1s (grp_b=0.6), 1s (grp_a=1.0)
        let (plan, sc_seq) =
            build_two_fixture_sequence_show(SequencePlaybackMode::Loop, 0.5, Some("all"), false, 6.0);
        let mut rt = RuntimeControl::new();
        rt.trigger_scene(&sc_seq, 0.0);

        // t=0.5s -> Step 0 active (grp_a = 0.2, grp_b = 0.0)
        let (_, cells_0) = evaluate_scenes_and_live_layers(
            &plan,
            &ClockInput { t_sec: 0.5, frame_index: 0 },
            &rt,
        );
        assert!((cells_0[0].dimmer - 0.2).abs() < 1e-4);
        assert!((cells_0[8].dimmer - 0.0).abs() < 1e-4);

        // t=1.25s -> Halfway through 0.5s crossfade from Step 0 (grp_a=0.2) to Step 1 (grp_b=0.6)
        let (_, cells_xfade) = evaluate_scenes_and_live_layers(
            &plan,
            &ClockInput { t_sec: 1.25, frame_index: 0 },
            &rt,
        );
        assert!((cells_xfade[0].dimmer - 0.1).abs() < 1e-4);
        assert!((cells_xfade[8].dimmer - 0.3).abs() < 1e-4);

        // t=3.6s -> Loop wrapped back to Step 0 (grp_a=0.2)
        let (_, cells_wrap) = evaluate_scenes_and_live_layers(
            &plan,
            &ClockInput { t_sec: 3.6, frame_index: 0 },
            &rt,
        );
        assert!((cells_wrap[0].dimmer - 0.2).abs() < 1e-4);

        // 2. OneShot holds on last step (Step 2: grp_a=1.0) after total duration (3.0s)
        let (plan_os, sc_os) =
            build_two_fixture_sequence_show(SequencePlaybackMode::OneShot, 0.0, Some("all"), false, 6.0);
        let mut rt_os = RuntimeControl::new();
        rt_os.trigger_scene(&sc_os, 0.0);
        let (_, cells_os) = evaluate_scenes_and_live_layers(
            &plan_os,
            &ClockInput { t_sec: 5.0, frame_index: 0 },
            &rt_os,
        );
        assert!((cells_os[0].dimmer - 1.0).abs() < 1e-4);

        // 3. Bounce mode: order [0, 1, 2, 1] -> at t=3.5s should be on Step 1 (grp_b=0.6)
        let (plan_b, sc_b) =
            build_two_fixture_sequence_show(SequencePlaybackMode::Bounce, 0.0, Some("all"), false, 6.0);
        let mut rt_b = RuntimeControl::new();
        rt_b.trigger_scene(&sc_b, 0.0);
        let (_, cells_b) = evaluate_scenes_and_live_layers(
            &plan_b,
            &ClockInput { t_sec: 3.5, frame_index: 0 },
            &rt_b,
        );
        assert!((cells_b[8].dimmer - 0.6).abs() < 1e-4);

        // 4. Recursion cycle guard: self-referencing sequence must terminate without stack overflow
        let mut cyclic_plan = plan.clone();
        if let Some(blk) = cyclic_plan.fx_blocks.iter_mut().find(|b| b.id == "blk_seq") {
            blk.elements = vec![FxElementDef::SceneSequence {
                playback_mode: SequencePlaybackMode::Loop,
                steps: vec![SceneSequenceStepDef {
                    scene_id: "sc_seq".into(),
                    duration_value: 1.0,
                    duration_unit: DurationUnit::Seconds,
                    fade_sec: 0.0,
                }],
            }];
        }
        let (_, cells_cyc) = evaluate_scenes_and_live_layers(
            &cyclic_plan,
            &ClockInput { t_sec: 0.5, frame_index: 0 },
            &rt,
        );
        assert_eq!(cells_cyc[0].dimmer, 0.0);
    }

    #[test]
    fn scene_sequence_on_timeline_supports_time_stretch_and_step_target_precedence() {
        // Natural duration = 3.0s, stretched to 6.0s -> plays at 0.5x speed (each 1s step lasts 2s)
        let (plan, _) =
            build_two_fixture_sequence_show(SequencePlaybackMode::Loop, 0.0, Some("all"), true, 6.0);
        let mut rt = RuntimeControl::new();
        rt.active_timeline_id = Some("tl_1".into());
        rt.timeline_playing = false;

        // At t=1.5s (scaled t=0.75s) -> still Step 0 (grp_a=0.2, grp_b=0.0)
        rt.timeline_playhead_sec = 1.5;
        let (_, c1) = evaluate_scenes_and_live_layers(
            &plan,
            &ClockInput { t_sec: 0.0, frame_index: 0 },
            &rt,
        );
        assert!((c1[0].dimmer - 0.2).abs() < 1e-4);
        assert!((c1[8].dimmer - 0.0).abs() < 1e-4);

        // At t=3.0s (scaled t=1.5s) -> Step 1 (grp_b=0.6, grp_a=0.0) honoring step's own target_group
        rt.timeline_playhead_sec = 3.0;
        let (_, c2) = evaluate_scenes_and_live_layers(
            &plan,
            &ClockInput { t_sec: 0.0, frame_index: 0 },
            &rt,
        );
        assert!((c2[0].dimmer - 0.0).abs() < 1e-4);
        assert!((c2[8].dimmer - 0.6).abs() < 1e-4);

        // When track explicitly sets target_group="grp_a", Step 1's output is redirected to grp_a
        let (plan_override, _) = build_two_fixture_sequence_show(
            SequencePlaybackMode::Loop,
            0.0,
            Some("grp_a"),
            false,
            6.0,
        );
        rt.timeline_playhead_sec = 1.5;
        let (_, c3) = evaluate_scenes_and_live_layers(
            &plan_override,
            &ClockInput { t_sec: 0.0, frame_index: 0 },
            &rt,
        );
        assert!((c3[0].dimmer - 0.6).abs() < 1e-4);
        assert!((c3[8].dimmer - 0.0).abs() < 1e-4);
    }
}
