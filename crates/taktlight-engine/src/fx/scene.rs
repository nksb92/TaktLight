use std::collections::HashMap;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::engine::evaluator::ClockInput;
use crate::mixer::color::{CompiledColorPalette, CompiledDimmerPalette};
use crate::mixer::traits::{
    fold_layers_into_states, resolve_target_cells_and_fixtures, CellTraitDelta, CellTraitState,
    FixtureTraitDelta, FixtureTraitState, MergeOp,
};
use crate::show::xml::{ClipDef, FxBlockDef, FxElementDef, SceneDef, TempoPointDef};
use crate::state::plan::RenderPlan;
use crate::state::runtime::RuntimeControl;

use super::evaluators::{
    evaluate_curve_1d_scalar, evaluate_spatial_shader_2d, evaluate_step_chase_scalar,
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
        self.release_t_sec.is_some() && self.alpha_at(t_now_sec) <= 1e-6
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

#[allow(clippy::too_many_arguments)]
fn fold_fx_block_into_states(
    plan: &RenderPlan,
    block: &FxBlockDef,
    effective_target_group: &str,
    scene_alpha: f32,
    t_local: f64,
    b_local: f64,
    fixture_index_by_id: &HashMap<&str, usize>,
    cell_to_fixture: &[usize],
    color_map: &HashMap<&str, &CompiledColorPalette>,
    dimmer_map: &HashMap<&str, &CompiledDimmerPalette>,
    fixture_states: &mut [FixtureTraitState],
    cell_states: &mut [CellTraitState],
) {
    let cell_count = plan.cell_count as usize;
    let dur = (block.duration_beats as f64).max(1e-4);
    let b_block = if block.loop_block {
        b_local.rem_euclid(dur)
    } else {
        b_local.min(dur)
    };

    for elem in &block.elements {
        match elem {
            FxElementDef::StaticTrait {
                trait_name,
                op,
                palette_ref,
                value_start,
                value_end,
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
                    for (cell_idx, u) in target_cells {
                        let w = v0 + u * (v1 - v0);
                        let rgb = sample_color_palette_linear(color_map, palette_ref.as_deref(), w);
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
                phase_spread_deg,
                duty,
                palette_ref,
                order,
            } => {
                let parsed_op = MergeOp::from_str(op).unwrap_or(MergeOp::Add);
                let parsed_wf = Waveform1D::from_str(waveform).unwrap_or(Waveform1D::Sine);
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
                    let val = evaluate_curve_1d_scalar(
                        parsed_wf,
                        b_block,
                        t_local,
                        0.0,
                        *rate_beats,
                        *speed_hz,
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
                    for (cell_idx, u) in target_cells {
                        let w = evaluate_curve_1d_scalar(
                            parsed_wf,
                            b_block,
                            t_local,
                            u,
                            *rate_beats,
                            *speed_hz,
                            *phase_spread_deg,
                            *duty,
                            *amplitude,
                            *offset,
                            false,
                        );
                        let rgb = sample_color_palette_linear(color_map, palette_ref.as_deref(), w);
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
                    for (cell_idx, u) in target_cells {
                        let val = evaluate_curve_1d_scalar(
                            parsed_wf,
                            b_block,
                            t_local,
                            u,
                            *rate_beats,
                            *speed_hz,
                            *phase_spread_deg,
                            *duty,
                            *amplitude,
                            *offset,
                            is_bipolar,
                        );
                        let delta = CellTraitDelta {
                            dimmer: Some((parsed_op, val)),
                            color: None,
                        };
                        if cell_states[cell_idx].apply_cell_delta(&delta, scene_alpha) {
                            if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                                fixture_states[fx_idx].any_cell_touched = true;
                            }
                        }
                    }
                }
            }
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
            } => {
                let parsed_op = MergeOp::from_str(op).unwrap_or(MergeOp::Htp);
                let (target_cells, _) = resolve_target_cells_and_fixtures(
                    effective_target_group,
                    *order,
                    &plan.fixtures,
                    fixture_index_by_id,
                    cell_to_fixture,
                    &plan.groups,
                    cell_count,
                );
                let total = target_cells.len();
                for (cell_idx, u) in target_cells {
                    let val = evaluate_step_chase_scalar(
                        b_block,
                        t_local,
                        u,
                        total,
                        *step_beats,
                        *speed_hz,
                        *active_ratio,
                        *fade,
                        *amplitude,
                    );
                    let delta = if trait_name == "color" {
                        let rgb =
                            sample_color_palette_linear(color_map, palette_ref.as_deref(), val);
                        CellTraitDelta {
                            dimmer: None,
                            color: Some((parsed_op, rgb)),
                        }
                    } else {
                        CellTraitDelta {
                            dimmer: Some((parsed_op, val)),
                            color: None,
                        }
                    };
                    if cell_states[cell_idx].apply_cell_delta(&delta, scene_alpha) {
                        if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                            fixture_states[fx_idx].any_cell_touched = true;
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
                spatial_freq,
                direction_deg,
                center_x,
                center_y,
            } => {
                let parsed_op = MergeOp::from_str(op).unwrap_or(MergeOp::Ltp);
                let parsed_shader = Shader2DKind::from_str(shader).unwrap_or(Shader2DKind::LinearSweep);
                let (target_cells, _) = resolve_target_cells_and_fixtures(
                    effective_target_group,
                    None,
                    &plan.fixtures,
                    fixture_index_by_id,
                    cell_to_fixture,
                    &plan.groups,
                    cell_count,
                );
                for (cell_idx, _) in target_cells {
                    let canvas_xy = plan
                        .cells
                        .get(cell_idx)
                        .map(|c| c.canvas_xy)
                        .unwrap_or([0.5, 0.5]);
                    let s = evaluate_spatial_shader_2d(
                        parsed_shader,
                        canvas_xy,
                        b_block,
                        t_local,
                        *rate_beats,
                        *speed_hz,
                        *spatial_freq,
                        *direction_deg,
                        *center_x,
                        *center_y,
                    );
                    let delta = if trait_name == "color" {
                        let rgb = sample_color_palette_linear(color_map, palette_ref.as_deref(), s);
                        CellTraitDelta {
                            dimmer: None,
                            color: Some((parsed_op, rgb)),
                        }
                    } else {
                        CellTraitDelta {
                            dimmer: Some((parsed_op, s)),
                            color: None,
                        }
                    };
                    if cell_states[cell_idx].apply_cell_delta(&delta, scene_alpha) {
                        if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                            fixture_states[fx_idx].any_cell_touched = true;
                        }
                    }
                }
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
    if let (Some(tl_id), Some(t_tl)) = (
        runtime.active_timeline_id.as_deref(),
        runtime.effective_timeline_playhead_sec(clock.t_sec),
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
                        fold_fx_block_into_states(
                            plan,
                            block,
                            target_group,
                            clip_alpha,
                            t_local,
                            b_local,
                            &fixture_index_by_id,
                            &cell_to_fixture,
                            &color_map,
                            &dimmer_map,
                            &mut fixture_states,
                            &mut cell_states,
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
                            loop_block: true,
                            elements: clip.inline_fx.clone(),
                        };
                        fold_fx_block_into_states(
                            plan,
                            &inline_block,
                            target_group,
                            clip_alpha,
                            t_local,
                            b_local,
                            &fixture_index_by_id,
                            &cell_to_fixture,
                            &color_map,
                            &dimmer_map,
                            &mut fixture_states,
                            &mut cell_states,
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
                alpha,
                t_local,
                b_local,
                &fixture_index_by_id,
                &cell_to_fixture,
                &color_map,
                &dimmer_map,
                &mut fixture_states,
                &mut cell_states,
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
    for cell_state in &mut cell_states {
        cell_state.finalize_cell_state(runtime.grand_master, runtime.blackout);
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
            block_refs: vec!["blk_1".to_string()],
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
        };
        assert_eq!(clip_alpha_at(&clip, 0.9), 0.0);
        assert_eq!(clip_alpha_at(&clip, 1.0), 0.0);
        assert!((clip_alpha_at(&clip, 1.5) - 0.5).abs() < 1e-5);
        assert_eq!(clip_alpha_at(&clip, 2.5), 1.0);
        assert!((clip_alpha_at(&clip, 4.5) - 0.5).abs() < 1e-5);
        assert_eq!(clip_alpha_at(&clip, 5.0), 0.0);
    }
}
