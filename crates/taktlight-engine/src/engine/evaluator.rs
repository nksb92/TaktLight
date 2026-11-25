use crate::fx::scene::evaluate_scenes_and_live_layers_with_audio_clock;
use crate::mixer::color::{linear_rgb_to_srgb_u8, oklab_to_linear_rgb};
use crate::mixer::quantizer::{
    quantize_fixture_to_dmx, resolve_slot_oklab, software_strobe_gate,
};
pub use crate::mixer::quantizer::QuantizerState;
use crate::mixer::traits::ShutterState;
use crate::ofl::expander::{ChannelRole, ChannelTarget};
use crate::ofl::model::{OflColor, OflShutterEffect};
use crate::state::plan::RenderPlan;
use crate::state::runtime::RuntimeControl;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClockInput {
    pub t_sec: f64,
    pub frame_index: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvaluatedUniverse {
    pub universe_id: u16,
    pub dmx: [u8; 512],
}

#[derive(Debug, Clone, PartialEq)]
pub struct EvaluatedFrame {
    pub revision: u64,
    pub t_sec: f64,
    pub universes: Vec<EvaluatedUniverse>,
    pub cell_preview_rgbd: Vec<u8>,
}

pub struct Engine;

#[inline]
fn dmx_to_perceptual_u8(val: u8, gamma: f32) -> u8 {
    if val == 0 {
        return 0;
    }
    let inv_g = 1.0 / gamma.max(0.1);
    (((val as f32) / 255.0).powf(inv_g) * 255.0)
        .round()
        .clamp(0.0, 255.0) as u8
}

impl Engine {
    pub fn evaluate_frame(
        plan: &RenderPlan,
        clock: &ClockInput,
        runtime: &RuntimeControl,
        quantizer_state: &mut QuantizerState,
    ) -> EvaluatedFrame {
        Self::evaluate_frame_with_audio_clock(plan, clock, runtime, quantizer_state, None)
    }

    pub fn evaluate_frame_with_audio_clock(
        plan: &RenderPlan,
        clock: &ClockInput,
        runtime: &RuntimeControl,
        quantizer_state: &mut QuantizerState,
        audio_clock_playhead_sec: Option<f64>,
    ) -> EvaluatedFrame {
        quantizer_state.prepare_for_time(clock.t_sec);

        let master_scale = if runtime.blackout {
            0.0
        } else {
            runtime.grand_master.clamp(0.0, 1.0)
        };

        let mut universes = Vec::with_capacity(plan.universes.len());
        for (idx, uni_cfg) in plan.universes.iter().enumerate() {
            let mut dmx = [0u8; 512];
            if let Some(base) = plan.base_dmx.get(idx) {
                for (ch_idx, &base_val) in base.iter().enumerate() {
                    if base_val > 0 && master_scale > 0.0 {
                        dmx[ch_idx] = ((base_val as f32) * master_scale)
                            .round()
                            .clamp(0.0, 255.0) as u8;
                    }
                }
            }

            universes.push(EvaluatedUniverse {
                universe_id: uni_cfg.id,
                dmx,
            });
        }

        // Stages 1 to 4: Timeline + Scenes + Layer Stack -> Trait-Space Mixer -> Hardware Quantizer
        let has_identified = runtime.identified_fixture_id.is_some();
        if !plan.fixtures.is_empty()
            && (has_identified
                || (runtime.active_timeline_id.is_some() && !plan.timelines.is_empty())
                || !runtime.active_scenes.is_empty()
                || !plan.static_layers.is_empty()
                || !runtime.live_layers.is_empty())
        {
            let (mut fx_states, mut cell_states) =
                evaluate_scenes_and_live_layers_with_audio_clock(
                    plan,
                    clock,
                    runtime,
                    audio_clock_playhead_sec,
                );

            // Benchtop Locate / Identify override: force target fixture to 100% open white
            if let Some(ref ident_id) = runtime.identified_fixture_id {
                for (fx_idx, fixture) in plan.fixtures.iter().enumerate() {
                    if fixture.id == *ident_id {
                        fx_states[fx_idx].master_dimmer = 1.0;
                        fx_states[fx_idx].master_dimmer_touched = true;
                        fx_states[fx_idx].shutter = ShutterState::Open;
                        fx_states[fx_idx].shutter_touched = true;
                        let start = fixture.cell_start.min(cell_states.len());
                        let end =
                            (fixture.cell_start + fixture.cell_count as usize).min(cell_states.len());
                        for cell in &mut cell_states[start..end] {
                            cell.dimmer = 1.0;
                            cell.dimmer_touched = true;
                            cell.color = [1.0, 1.0, 1.0];
                            cell.color_touched = true;
                        }
                    }
                }
            }

            for (fx_idx, fixture) in plan.fixtures.iter().enumerate() {
                quantize_fixture_to_dmx(
                    fx_idx,
                    fixture,
                    &fx_states[fx_idx],
                    &cell_states,
                    clock.t_sec,
                    quantizer_state,
                    |slot, val| {
                        if let Some(u_idx) = slot.universe_index {
                            if let Some(u) = universes.get_mut(u_idx) {
                                if (1..=512).contains(&slot.dmx_address) {
                                    u.dmx[(slot.dmx_address - 1) as usize] = val;
                                }
                            }
                        }
                    },
                );
            }
        }

        // Stage 4 Step 7: Session-only Channel Park overrides everything including Blackout & Identify
        for (idx, uni_cfg) in plan.universes.iter().enumerate() {
            for (&(parked_uni, parked_ch), &parked_val) in &runtime.parked_channels {
                if parked_uni == uni_cfg.id && (1..=512).contains(&parked_ch) {
                    universes[idx].dmx[(parked_ch - 1) as usize] = parked_val;
                }
            }
        }

        // Compute cell preview RGBD bytes from live DMX output (supports Channel Park, Color Wheels & Strobe on 2D grid!)
        let mut cell_preview_rgbd = vec![0u8; (plan.cell_count as usize) * 4];
        for (fx_idx, fx) in plan.fixtures.iter().enumerate() {
            let mut fixture_master: Option<u8> = None;
            let mut fixture_wheel_srgb: Option<[u8; 3]> = None;
            let mut fixture_shutter_open = true;

            for ch in &fx.channels {
                if ch.target != ChannelTarget::Fixture {
                    continue;
                }
                let val = ch
                    .universe_index
                    .and_then(|u_idx| universes.get(u_idx))
                    .map(|u| u.dmx[(ch.dmx_address - 1) as usize])
                    .unwrap_or(0);
                match &ch.role {
                    ChannelRole::Intensity => {
                        fixture_master = Some(dmx_to_perceptual_u8(val, fx.calibration.gamma));
                    }
                    ChannelRole::WheelSlot { slots, .. } => {
                        if let Some((slot_idx, slot)) = slots
                            .iter()
                            .enumerate()
                            .find(|(_, s)| val >= s.dmx_range[0] && val <= s.dmx_range[1])
                        {
                            let lab_opt = ch
                                .wheel_slot_oklabs
                                .get(slot_idx)
                                .copied()
                                .flatten()
                                .or_else(|| resolve_slot_oklab(slot));
                            if let Some(lab) = lab_opt {
                                fixture_wheel_srgb =
                                    Some(linear_rgb_to_srgb_u8(oklab_to_linear_rgb(lab)));
                            }
                        }
                    }
                    ChannelRole::ShutterStrobe { capabilities } => {
                        if let Some(cap) = capabilities
                            .iter()
                            .find(|c| val >= c.dmx_range[0] && val <= c.dmx_range[1])
                        {
                            match cap.effect {
                                OflShutterEffect::Open => {
                                    fixture_shutter_open = true;
                                }
                                OflShutterEffect::Closed => {
                                    fixture_shutter_open = false;
                                }
                                _ => {
                                    let d0 = cap.dmx_range[0] as f32;
                                    let d1 = cap.dmx_range[1] as f32;
                                    let f_start = cap.speed_start_hz.unwrap_or(1.0);
                                    let f_end = cap.speed_end_hz.unwrap_or(20.0);
                                    let t = if (d1 - d0).abs() > 1e-6 {
                                        ((val as f32 - d0) / (d1 - d0)).clamp(0.0, 1.0)
                                    } else {
                                        0.5
                                    };
                                    let hz = f_start + t * (f_end - f_start);
                                    let st = if cap.random_timing {
                                        ShutterState::RandomStrobe(hz)
                                    } else {
                                        ShutterState::StrobeHz(hz)
                                    };
                                    let (gate, _) = software_strobe_gate(st, clock.t_sec, fx_idx);
                                    fixture_shutter_open = gate > 0.5;
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }

            for local_cell in 0..fx.cell_count {
                let global_cell = fx.cell_start + (local_cell as usize);
                if global_cell * 4 + 3 >= cell_preview_rgbd.len() {
                    continue;
                }
                let mut r: u16 = 0;
                let mut g: u16 = 0;
                let mut b: u16 = 0;
                let mut w: u16 = 0;
                let mut cell_intensity: Option<u8> = None;
                let mut cell_wheel_srgb: Option<[u8; 3]> = None;

                for ch in &fx.channels {
                    let applies = match &ch.target {
                        ChannelTarget::Cell { cell_index, .. } => *cell_index == local_cell,
                        ChannelTarget::Fixture => false,
                    };
                    if !applies {
                        continue;
                    }
                    let val = ch
                        .universe_index
                        .and_then(|u_idx| universes.get(u_idx))
                        .map(|u| u.dmx[(ch.dmx_address - 1) as usize])
                        .unwrap_or(0);
                    match &ch.role {
                        ChannelRole::Intensity => {
                            cell_intensity = Some(dmx_to_perceptual_u8(val, fx.calibration.gamma))
                        }
                        ChannelRole::ColorIntensity { color } => match color {
                            OflColor::Red => r = r.max(val as u16),
                            OflColor::Green => g = g.max(val as u16),
                            OflColor::Blue => b = b.max(val as u16),
                            OflColor::White | OflColor::WarmWhite | OflColor::ColdWhite => {
                                w = w.max(val as u16)
                            }
                            OflColor::Amber => {
                                r = r.max(val as u16);
                                g = g.max((val as u16) * 2 / 3);
                            }
                            OflColor::Cyan => {
                                g = g.max(val as u16);
                                b = b.max(val as u16);
                            }
                            OflColor::Magenta => {
                                r = r.max(val as u16);
                                b = b.max(val as u16);
                            }
                            OflColor::Yellow => {
                                r = r.max(val as u16);
                                g = g.max(val as u16);
                            }
                            _ => {}
                        },
                        ChannelRole::WheelSlot { slots, .. } => {
                            if let Some((slot_idx, slot)) = slots
                                .iter()
                                .enumerate()
                                .find(|(_, s)| val >= s.dmx_range[0] && val <= s.dmx_range[1])
                            {
                                let lab_opt = ch
                                    .wheel_slot_oklabs
                                    .get(slot_idx)
                                    .copied()
                                    .flatten()
                                    .or_else(|| resolve_slot_oklab(slot));
                                if let Some(lab) = lab_opt {
                                    cell_wheel_srgb =
                                        Some(linear_rgb_to_srgb_u8(oklab_to_linear_rgb(lab)));
                                }
                            }
                        }
                        _ => {}
                    }
                }

                let mut rr = dmx_to_perceptual_u8((r + w).min(255) as u8, fx.calibration.gamma);
                let mut gg = dmx_to_perceptual_u8((g + w).min(255) as u8, fx.calibration.gamma);
                let mut bb = dmx_to_perceptual_u8((b + w).min(255) as u8, fx.calibration.gamma);
                if rr == 0 && gg == 0 && bb == 0 {
                    if let Some([wr, wg, wb]) = cell_wheel_srgb.or(fixture_wheel_srgb) {
                        rr = wr;
                        gg = wg;
                        bb = wb;
                    }
                }

                let mut eff_dim = match (cell_intensity, fixture_master) {
                    (Some(ci), Some(fm)) => (((ci as u16) * (fm as u16)) / 255) as u8,
                    (Some(ci), None) => ci,
                    (None, Some(fm)) => fm,
                    (None, None) => {
                        if rr > 0 || gg > 0 || bb > 0 {
                            255
                        } else {
                            0
                        }
                    }
                };
                if !fixture_shutter_open {
                    eff_dim = 0;
                }
                let base_idx = global_cell * 4;
                cell_preview_rgbd[base_idx] = rr;
                cell_preview_rgbd[base_idx + 1] = gg;
                cell_preview_rgbd[base_idx + 2] = bb;
                cell_preview_rgbd[base_idx + 3] = eff_dim;
            }
        }

        quantizer_state.commit_time(clock.t_sec);

        EvaluatedFrame {
            revision: plan.revision,
            t_sec: clock.t_sec,
            universes,
            cell_preview_rgbd,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::show::patch::WhiteMode;

    #[test]
    fn park_overrides_grand_master_and_blackout() {
        let mut plan = RenderPlan::default_studio_plan();
        plan.base_dmx[0][0] = 200;
        plan.base_dmx[0][1] = 100;
        plan.base_dmx[1][4] = 180;

        let mut runtime = RuntimeControl::new();
        runtime.set_grand_master(0.5);
        runtime.set_park(1, 2, Some(255)).unwrap();

        let clock = ClockInput {
            t_sec: 1.0,
            frame_index: 44,
        };
        let mut q = QuantizerState::default();
        let frame = Engine::evaluate_frame(&plan, &clock, &runtime, &mut q);

        assert_eq!(frame.universes[0].dmx[0], 100);
        assert_eq!(frame.universes[0].dmx[1], 255);
        assert_eq!(frame.universes[1].dmx[4], 90);

        runtime.set_blackout(true);
        let frame_bo = Engine::evaluate_frame(&plan, &clock, &runtime, &mut q);
        assert_eq!(frame_bo.universes[0].dmx[0], 0);
        assert_eq!(frame_bo.universes[0].dmx[1], 255);
        assert_eq!(frame_bo.universes[1].dmx[4], 0);
    }

    #[test]
    fn evaluates_live_layers_with_palettes_rgbw_deadzone_and_park_override() {
        use crate::mixer::traits::{MergeOp, SmartControlLayer, SmartLayerTrait};
        use crate::ofl::library::FixtureLibrary;
        use crate::show::compiler::compile_render_plan;
        use crate::show::patch::{FixtureCalibration, FixtureInstance};
        use crate::show::spatial::GridPos;
        use crate::show::xml::{ColorPaletteDef, DimmerPaletteDef, ShowState};

        let library = FixtureLibrary::load_with_test_fixtures();
        let mut show = ShowState::default();
        show.color_palettes.push(ColorPaletteDef {
            id: "pal_white".into(),
            name: "Pure White".into(),
            hex_start: "#FFFFFF".into(),
            hex_end: "#FFFFFF".into(),
            colors: Vec::new(),
        });
        show.dimmer_palettes.push(DimmerPaletteDef {
            id: "dim_full".into(),
            name: "Full".into(),
            value_start: 1.0,
            value_end: 1.0,
        });
        show.patch.push(FixtureInstance {
            id: "fx_tube".into(),
            profile: "user/test_tube_8seg.json".into(),
            mode: "34ch Pixel Mode".into(),
            name: "Tube 1".into(),
            universe: 1,
            address: 1,
            channel_count: 34,
            grid_pos: GridPos::default(),
            calibration: FixtureCalibration {
                gamma: 2.2,
                min_dimmer_dmx: 10,
                max_dimmer_dmx: 255,
                white_mode: WhiteMode::Replace,
                white_gain: 1.0,
            },
        });

        let plan = compile_render_plan(1, &show, &library).unwrap();
        let mut runtime = RuntimeControl::new();
        runtime.set_live_layers(vec![
            SmartControlLayer {
                id: "l_dim".into(),
                name: "Full Dimmer".into(),
                enabled: true,
                priority: 1,
                trigger_order: 1,
                alpha: 1.0,
                target: "all".into(),
                order_override: None,
                trait_spec: SmartLayerTrait::Dimmer {
                    op: MergeOp::Htp,
                    palette_ref: Some("dim_full".into()),
                    value_start: 0.0,
                    value_end: 0.0,
                },
            },
            SmartControlLayer {
                id: "l_col".into(),
                name: "White Palette".into(),
                enabled: true,
                priority: 1,
                trigger_order: 2,
                alpha: 1.0,
                target: "fx_tube".into(),
                order_override: None,
                trait_spec: SmartLayerTrait::Color {
                    op: MergeOp::Ltp,
                    palette_ref: Some("pal_white".into()),
                    hex_start: "#000000".into(),
                    hex_end: "#000000".into(),
                },
            },
        ]);

        let clock = ClockInput {
            t_sec: 0.0,
            frame_index: 1,
        };
        let mut q = QuantizerState::default();
        let frame = Engine::evaluate_frame(&plan, &clock, &runtime, &mut q);

        // Ch1 = Master Dimmer (fallback 1.0 -> 255), Ch2 = Strobe Open (default 0)
        // Cell 1 RGBW (Ch3..Ch6): pure white with WhiteMode::Replace -> R=0, G=0, B=0, W=255
        assert_eq!(frame.universes[0].dmx[0], 255);
        assert_eq!(frame.universes[0].dmx[2], 0);
        assert_eq!(frame.universes[0].dmx[3], 0);
        assert_eq!(frame.universes[0].dmx[4], 0);
        assert_eq!(frame.universes[0].dmx[5], 255);

        // Park override still overrides Ch3
        runtime.set_park(1, 3, Some(123)).unwrap();
        let parked = Engine::evaluate_frame(&plan, &clock, &runtime, &mut q);
        assert_eq!(parked.universes[0].dmx[2], 123);
    }

    #[test]
    fn golden_frame_cyberpunk_sine_and_step_chase_scene_across_time_steps() {
        use crate::ofl::library::FixtureLibrary;
        use crate::show::compiler::compile_render_plan;
        use crate::show::patch::{FixtureCalibration, FixtureInstance};
        use crate::show::spatial::{GridPos, OrderRule};
        use crate::show::xml::{
            ColorPaletteDef, DimmerPaletteDef, DurationUnit, FixtureGroupDef, FxBlockDef,
            FxElementDef, SceneDef, ShowState,
        };

        let library = FixtureLibrary::load_with_test_fixtures();
        let mut show = ShowState::default();
        show.bpm = 120.0;
        show.color_palettes.push(ColorPaletteDef {
            id: "pal_cyber".into(),
            name: "Cyberpunk Dual".into(),
            hex_start: "#FF5500".into(),
            hex_end: "#2255AA".into(),
            colors: Vec::new(),
        });
        show.dimmer_palettes.push(DimmerPaletteDef {
            id: "dim_half".into(),
            name: "Studio 60%".into(),
            value_start: 0.60,
            value_end: 0.60,
        });
        show.patch.push(FixtureInstance {
            id: "fx_201".into(),
            profile: "user/test_tube_8seg.json".into(),
            mode: "34ch Pixel Mode".into(),
            name: "Tube Left".into(),
            universe: 1,
            address: 1,
            channel_count: 34,
            grid_pos: GridPos::default(),
            calibration: FixtureCalibration {
                gamma: 2.2,
                min_dimmer_dmx: 4,
                max_dimmer_dmx: 255,
                white_mode: WhiteMode::Replace,
                white_gain: 0.85,
            },
        });
        show.groups.push(FixtureGroupDef {
            id: "grp_tubes_cells".into(),
            name: "All Tube Pixels".into(),
            order: OrderRule::CenterOut,
            targets: vec!["fx_201:0..7".into()],
        });
        show.fx_library.push(FxBlockDef {
            id: "blk_cyber_wave".into(),
            name: "Cyberpunk Sine Wave".into(),
            target_group: Some("grp_tubes_cells".into()),
            duration_beats: 4.0,
            duration_sec: None,
            loop_block: true,
            elements: vec![
                FxElementDef::StaticTrait {
                    trait_name: "dimmer".into(),
                    op: "htp".into(),
                    palette_ref: Some("dim_half".into()),
                    value_start: None,
                    value_end: None,
                    hex_start: None,
                    hex_end: None,
                    order: None,
                },
                FxElementDef::StaticTrait {
                    trait_name: "color".into(),
                    op: "ltp".into(),
                    palette_ref: Some("pal_cyber".into()),
                    value_start: None,
                    value_end: None,
                    hex_start: None,
                    hex_end: None,
                    order: Some(OrderRule::Mirror),
                },
                FxElementDef::Curve1D {
                    trait_name: "dimmer".into(),
                    op: "add".into(),
                    waveform: "sine".into(),
                    amplitude: 0.40,
                    offset: 0.0,
                    rate_beats: Some(2.0),
                    speed_hz: None,
                    rate_cycles: None,
                    phase_deg: 0.0,
                    phase_spread_deg: 360.0,
                    duty: Some(0.5),
                    grayscale: false,
                    color_width: 1.0,
                    gradient: 1.0,
                    angle_deg: 0.0,
                    fx_kind_tag: None,
                    inline_colors: Vec::new(),
                    value_stops: Vec::new(),
                    palette_ref: None,
                    order: None,
                },
                FxElementDef::StepChase {
                    trait_name: "dimmer".into(),
                    op: "htp".into(),
                    step_beats: Some(0.5),
                    speed_hz: None,
                    rate_cycles: None,
                    one_way: true,
                    pixels_on: None,
                    active_ratio: Some(0.25),
                    fade: 0.20,
                    amplitude: 1.0,
                    palette_ref: None,
                    order: None,
                },
            ],
        });
        let scene = SceneDef {
            id: "sc_cyber_wave".into(),
            name: "Cyberpunk Sine Wave".into(),
            bank: Some("main".into()),
            target_group: None,
            priority: 10,
            fade_in_sec: 0.5,
            fade_out_sec: 1.0,
            duration_value: 4.0,
            duration_unit: DurationUnit::Beats,
            block_refs: vec!["blk_cyber_wave".into()],
            timeline_ref: None,
        };
        show.scenes.push(scene.clone());

        let plan = compile_render_plan(1, &show, &library).unwrap();
        let mut rt = RuntimeControl::new();
        rt.trigger_scene(&scene, 0.0);

        let mut q = QuantizerState::default();
        let f0 = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 0.0,
                frame_index: 0,
            },
            &rt,
            &mut q,
        );
        let f25 = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 0.25,
                frame_index: 11,
            },
            &rt,
            &mut q,
        );
        let f50 = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 0.5,
                frame_index: 22,
            },
            &rt,
            &mut q,
        );
        let f100 = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 1.0,
                frame_index: 44,
            },
            &rt,
            &mut q,
        );

        // Determinism check: evaluating out-of-order returns byte-identical result
        let f50_repeat = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 0.5,
                frame_index: 22,
            },
            &rt,
            &mut q,
        );
        assert_eq!(f50.universes[0].dmx, f50_repeat.universes[0].dmx);

        // At t=0.0s (fade_in=0.5 -> alpha=0.0): Master=0, Shutter=Open(11), all cells=0
        assert_eq!(f0.universes[0].dmx[0], 0);
        assert_eq!(f0.universes[0].dmx[1], 11);
        assert_eq!(&f0.universes[0].dmx[2..34], &[0u8; 32]);

        // Fade-in strictly increases energy from t=0.25 to t=0.50
        let sum25: u32 = f25.universes[0].dmx[2..34].iter().map(|&b| b as u32).sum();
        let sum50: u32 = f50.universes[0].dmx[2..34].iter().map(|&b| b as u32).sum();
        assert!(sum25 > 0 && sum50 > sum25);
        assert_eq!(f25.universes[0].dmx[0], 255);
        assert_eq!(f50.universes[0].dmx[0], 255);

        // Pixel 0 (u_mirror=0.0 -> #FF5500 orange) vs Pixel 3 (center -> u_mirror=1.0 -> #2255AA blue)
        assert_ne!(&f50.universes[0].dmx[2..6], &f50.universes[0].dmx[14..18]);

        // Time evolution changes chase/wave state between t=0.5s and t=1.0s
        assert_ne!(&f50.universes[0].dmx[2..34], &f100.universes[0].dmx[2..34]);

        const GOLDEN_F50: [u8; 34] = [
            255, 11, 255, 26, 0, 0, 85, 4, 0, 45, 5, 0, 5, 10, 0, 4, 7, 6, 0, 4, 7, 6, 5, 0, 5, 10,
            85, 4, 0, 45, 255, 26, 0, 0,
        ];
        const GOLDEN_F100: [u8; 34] = [
            255, 11, 255, 26, 0, 0, 7, 4, 0, 5, 8, 0, 6, 28, 0, 5, 41, 27, 0, 5, 41, 27, 8, 0, 6,
            28, 7, 4, 0, 5, 255, 26, 0, 0,
        ];
        assert_eq!(&f50.universes[0].dmx[0..34], &GOLDEN_F50);
        assert_eq!(&f100.universes[0].dmx[0..34], &GOLDEN_F100);
    }

    #[test]
    fn evaluates_multi_track_timeline_with_clip_fades_and_scene_busking_overlay() {
        use crate::ofl::library::FixtureLibrary;
        use crate::show::compiler::compile_render_plan;
        use crate::show::patch::{FixtureCalibration, FixtureInstance};
        use crate::show::spatial::GridPos;
        use crate::show::xml::{
            ClipDef, ColorPaletteDef, DurationUnit, FxBlockDef, FxElementDef, SceneDef, ShowState,
            TempoPointDef, TimelineDef, TrackDef,
        };

        let lib = FixtureLibrary::load_with_test_fixtures();
        let mut show = ShowState::default();
        show.color_palettes.push(ColorPaletteDef {
            id: "pal_orange".into(),
            name: "Orange".into(),
            hex_start: "#FF5500".into(),
            hex_end: "#FF5500".into(),
            colors: Vec::new(),
        });
        show.color_palettes.push(ColorPaletteDef {
            id: "pal_blue".into(),
            name: "Blue".into(),
            hex_start: "#0044FF".into(),
            hex_end: "#0044FF".into(),
            colors: Vec::new(),
        });
        show.patch.push(FixtureInstance {
            id: "fx_201".into(),
            profile: "user/test_tube_8seg.json".into(),
            mode: "34ch Pixel Mode".into(),
            name: "Tube".into(),
            universe: 1,
            address: 1,
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
        show.fx_library.push(FxBlockDef {
            id: "blk_orange".into(),
            name: "Orange".into(),
            target_group: Some("all".into()),
            duration_beats: 4.0,
            duration_sec: None,
            loop_block: true,
            elements: vec![
                FxElementDef::StaticTrait {
                    trait_name: "dimmer".into(),
                    op: "htp".into(),
                    palette_ref: None,
                    value_start: Some(1.0),
                    value_end: Some(1.0),
                    hex_start: None,
                    hex_end: None,
                    order: None,
                },
                FxElementDef::StaticTrait {
                    trait_name: "color".into(),
                    op: "ltp".into(),
                    palette_ref: Some("pal_orange".into()),
                    value_start: Some(0.0),
                    value_end: Some(1.0),
                    hex_start: None,
                    hex_end: None,
                    order: None,
                },
            ],
        });
        show.fx_library.push(FxBlockDef {
            id: "blk_blue".into(),
            name: "Blue Busk".into(),
            target_group: Some("all".into()),
            duration_beats: 4.0,
            duration_sec: None,
            loop_block: true,
            elements: vec![
                FxElementDef::StaticTrait {
                    trait_name: "dimmer".into(),
                    op: "htp".into(),
                    palette_ref: None,
                    value_start: Some(1.0),
                    value_end: Some(1.0),
                    hex_start: None,
                    hex_end: None,
                    order: None,
                },
                FxElementDef::StaticTrait {
                    trait_name: "color".into(),
                    op: "ltp".into(),
                    palette_ref: Some("pal_blue".into()),
                    value_start: Some(0.0),
                    value_end: Some(1.0),
                    hex_start: None,
                    hex_end: None,
                    order: None,
                },
            ],
        });
        show.scenes.push(SceneDef {
            id: "sc_blue".into(),
            name: "Blue".into(),
            bank: Some("busk".into()),
            target_group: None,
            priority: 10,
            fade_in_sec: 0.0,
            fade_out_sec: 0.5,
            duration_value: 4.0,
            duration_unit: DurationUnit::Beats,
            block_refs: vec!["blk_blue".into()],
            timeline_ref: None,
        });
        show.timelines.push(TimelineDef {
            id: "tl_main".into(),
            name: "Main Timeline".into(),
            duration_sec: 30.0,
            grid_offset_sec: 0.0,
            tempo_map: vec![TempoPointDef {
                at_sec: 0.0,
                bpm: 120.0,
            }],
            audio_track: None,
            loop_timeline: false,
            tracks: vec![
                TrackDef {
                    id: "trk_1".into(),
                    name: "Base Orange".into(),
                    target_group: Some("all".into()),
                    clips: vec![ClipDef {
                        ref_block: Some("blk_orange".into()),
                        start_sec: 1.0,
                        duration_sec: 4.0,
                        fade_in_sec: 0.0,
                        fade_out_sec: 0.0,
                        inline_fx: Vec::new(),
                        ..Default::default()
                    }],
                    ..Default::default()
                },
                TrackDef {
                    id: "trk_2".into(),
                    name: "Upper White Inline".into(),
                    target_group: Some("all".into()),
                    clips: vec![ClipDef {
                        ref_block: None,
                        start_sec: 2.0,
                        duration_sec: 2.0,
                        fade_in_sec: 0.0,
                        fade_out_sec: 0.0,
                        inline_fx: vec![
                            FxElementDef::StaticTrait {
                                trait_name: "dimmer".into(),
                                op: "htp".into(),
                                palette_ref: None,
                                value_start: Some(1.0),
                                value_end: Some(1.0),
                                hex_start: None,
                                hex_end: None,
                                order: None,
                            },
                            FxElementDef::StaticTrait {
                                trait_name: "color".into(),
                                op: "ltp".into(),
                                palette_ref: Some("pal_blue".into()),
                                value_start: Some(0.0),
                                value_end: Some(1.0),
                                hex_start: None,
                                hex_end: None,
                                order: None,
                            },
                        ],
                        ..Default::default()
                    }],
                    ..Default::default()
                },
            ],
        });

        let plan = compile_render_plan(2, &show, &lib).unwrap();
        let mut rt = RuntimeControl::new();
        rt.set_timeline_transport(Some("tl_main".into()), false, Some(1.5), 0.0);
        let mut q = QuantizerState::default();

        // At t_tl = 1.5s: only track 1 Orange clip is active (Ch3 Red high, Ch5 Blue = 0)
        let f_track1 = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 0.0,
                frame_index: 1,
            },
            &rt,
            &mut q,
        );
        assert!(f_track1.universes[0].dmx[2] > 200);
        assert_eq!(f_track1.universes[0].dmx[4], 0);

        // At t_tl = 2.5s: track 2 sits on top of track 1 (LTP Blue overrides Orange)
        rt.seek_timeline(2.5, 0.0);
        let f_track2 = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 0.0,
                frame_index: 2,
            },
            &rt,
            &mut q,
        );
        assert!(f_track2.universes[0].dmx[4] > 200);
        assert_eq!(f_track2.universes[0].dmx[2], 0);

        // Trigger a live busk scene on top of Track 1 at t_tl = 1.5s -> Scene overrides Timeline!
        rt.seek_timeline(1.5, 10.0);
        rt.trigger_scene(&show.scenes[0], 10.0);
        let f_busk = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 10.0,
                frame_index: 3,
            },
            &rt,
            &mut q,
        );
        assert!(f_busk.universes[0].dmx[4] > 200);
    }

    #[test]
    fn single_gamma_preserves_orange_and_blue_dmx_and_srgb_preview_roundtrip() {
        use crate::ofl::library::FixtureLibrary;
        use crate::show::compiler::compile_render_plan;
        use crate::show::patch::{FixtureCalibration, FixtureInstance};
        use crate::show::spatial::GridPos;
        use crate::show::xml::{
            ColorPaletteDef, DurationUnit, FxBlockDef, FxElementDef, SceneDef, ShowState,
        };

        let lib = FixtureLibrary::load_with_test_fixtures();
        let mut show = ShowState::default();
        show.color_palettes.push(ColorPaletteDef {
            id: "pal_o".into(),
            name: "Orange".into(),
            hex_start: "#FF5500".into(),
            hex_end: "#FF5500".into(),
            colors: vec!["#FF5500".into(), "#FF5500".into()],
        });
        show.patch.push(FixtureInstance {
            id: "fx_1".into(),
            profile: "user/test_tube_8seg.json".into(),
            mode: "34ch Pixel Mode".into(),
            name: "Tube".into(),
            universe: 1,
            address: 1,
            channel_count: 34,
            grid_pos: GridPos::default(),
            calibration: FixtureCalibration {
                gamma: 2.2,
                min_dimmer_dmx: 0,
                max_dimmer_dmx: 255,
                white_mode: WhiteMode::Off,
                white_gain: 1.0,
            },
        });
        show.fx_library.push(FxBlockDef {
            id: "blk_o".into(),
            name: "Orange".into(),
            target_group: Some("all".into()),
            duration_beats: 4.0,
            duration_sec: None,
            loop_block: true,
            elements: vec![
                FxElementDef::StaticTrait {
                    trait_name: "dimmer".into(),
                    op: "htp".into(),
                    palette_ref: None,
                    value_start: Some(1.0),
                    value_end: Some(1.0),
                    hex_start: None,
                    hex_end: None,
                    order: None,
                },
                FxElementDef::StaticTrait {
                    trait_name: "color".into(),
                    op: "ltp".into(),
                    palette_ref: Some("pal_o".into()),
                    value_start: Some(0.0),
                    value_end: Some(1.0),
                    hex_start: None,
                    hex_end: None,
                    order: None,
                },
            ],
        });
        let sc = SceneDef {
            id: "sc_o".into(),
            name: "Orange".into(),
            bank: Some("Bank 1".into()),
            target_group: None,
            priority: 10,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            duration_value: 4.0,
            duration_unit: DurationUnit::Beats,
            block_refs: vec!["blk_o".into()],
            timeline_ref: None,
        };
        show.scenes.push(sc.clone());

        let plan = compile_render_plan(1, &show, &lib).unwrap();
        let mut rt = RuntimeControl::new();
        rt.trigger_scene(&sc, 0.0);
        let mut q = QuantizerState::default();
        let frame = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 0.0,
                frame_index: 0,
            },
            &rt,
            &mut q,
        );
        // Single gamma 2.2 on #FF5500 (G=85/255 = 1/3 -> (1/3)^2.2 * 255 ~= 23, NOT 1!)
        assert_eq!(frame.universes[0].dmx[2], 255);
        assert!(frame.universes[0].dmx[3] >= 20 && frame.universes[0].dmx[3] <= 26);
        assert_eq!(frame.universes[0].dmx[4], 0);
        // Inverse-gamma 2D preview reconstructs ~85 for green channel
        assert_eq!(frame.cell_preview_rgbd[0], 255);
        assert!((frame.cell_preview_rgbd[1] as i16 - 85).abs() <= 4);
        assert_eq!(frame.cell_preview_rgbd[2], 0);
        assert_eq!(frame.cell_preview_rgbd[3], 255);
    }

    #[test]
    fn color_only_scene_stays_strictly_dark_until_dimmer_or_master_raised() {
        use crate::ofl::library::FixtureLibrary;
        use crate::show::compiler::compile_render_plan;
        use crate::show::patch::{FixtureCalibration, FixtureInstance};
        use crate::show::spatial::GridPos;
        use crate::show::xml::{
            ColorPaletteDef, DurationUnit, FxBlockDef, FxElementDef, SceneDef, ShowState,
        };

        let lib = FixtureLibrary::load_with_test_fixtures();
        let mut show = ShowState::default();
        show.color_palettes.push(ColorPaletteDef {
            id: "pal_red".into(),
            name: "Red".into(),
            hex_start: "#FF0000".into(),
            hex_end: "#FF0000".into(),
            colors: Vec::new(),
        });
        show.patch.push(FixtureInstance {
            id: "fx_1".into(),
            profile: "user/test_tube_8seg.json".into(),
            mode: "34ch Pixel Mode".into(),
            name: "Tube".into(),
            universe: 1,
            address: 1,
            channel_count: 34,
            grid_pos: GridPos::default(),
            calibration: FixtureCalibration::default(),
        });
        show.fx_library.push(FxBlockDef {
            id: "blk_col_only".into(),
            name: "Color Only".into(),
            target_group: Some("all".into()),
            duration_beats: 4.0,
            duration_sec: None,
            loop_block: true,
            elements: vec![FxElementDef::StaticTrait {
                trait_name: "color".into(),
                op: "ltp".into(),
                palette_ref: Some("pal_red".into()),
                value_start: Some(0.0),
                value_end: Some(1.0),
                hex_start: None,
                hex_end: None,
                order: None,
            }],
        });
        let sc_col = SceneDef {
            id: "sc_col".into(),
            name: "Color Only".into(),
            bank: Some("main".into()),
            target_group: None,
            priority: 10,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            duration_value: 4.0,
            duration_unit: DurationUnit::Beats,
            block_refs: vec!["blk_col_only".into()],
            timeline_ref: None,
        };
        show.scenes.push(sc_col.clone());

        show.fx_library.push(FxBlockDef {
            id: "blk_master".into(),
            name: "Master Overlay".into(),
            target_group: Some("all".into()),
            duration_beats: 4.0,
            duration_sec: None,
            loop_block: true,
            elements: vec![FxElementDef::StaticTrait {
                trait_name: "master_dimmer".into(),
                op: "htp".into(),
                palette_ref: None,
                value_start: Some(1.0),
                value_end: Some(1.0),
                hex_start: None,
                hex_end: None,
                order: None,
            }],
        });
        let sc_master = SceneDef {
            id: "sc_master".into(),
            name: "Master Overlay".into(),
            bank: Some("overlay".into()),
            target_group: None,
            priority: 20,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            duration_value: 4.0,
            duration_unit: DurationUnit::Beats,
            block_refs: vec!["blk_master".into()],
            timeline_ref: None,
        };
        show.scenes.push(sc_master.clone());

        let plan = compile_render_plan(1, &show, &lib).unwrap();
        let mut rt = RuntimeControl::new();
        rt.trigger_scene(&sc_col, 0.0);
        let mut q = QuantizerState::default();

        // Color-only scene without any dimmer keeps Master Dimmer = 0 and pixel output = 0
        let f_dark = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 0.0,
                frame_index: 0,
            },
            &rt,
            &mut q,
        );
        assert_eq!(f_dark.universes[0].dmx[0], 0);
        assert_eq!(f_dark.universes[0].dmx[2], 0);
        assert_eq!(f_dark.cell_preview_rgbd[3], 0);

        // Triggering Master Dimmer overlay lights up the red color!
        rt.trigger_scene(&sc_master, 0.0);
        let f_lit = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 0.0,
                frame_index: 1,
            },
            &rt,
            &mut q,
        );
        assert_eq!(f_lit.universes[0].dmx[0], 255);
        assert_eq!(f_lit.universes[0].dmx[2], 255);
        assert_eq!(f_lit.cell_preview_rgbd[0], 255);
        assert_eq!(f_lit.cell_preview_rgbd[3], 255);
    }

    #[test]
    fn scene_duration_seconds_vs_beats_controls_fx_cycle_length() {
        use crate::ofl::library::FixtureLibrary;
        use crate::show::compiler::compile_render_plan;
        use crate::show::patch::{FixtureCalibration, FixtureInstance};
        use crate::show::spatial::GridPos;
        use crate::show::xml::{DurationUnit, FxBlockDef, FxElementDef, SceneDef, ShowState};

        let lib = FixtureLibrary::load_with_test_fixtures();
        let mut show = ShowState::default();
        show.bpm = 60.0; // 1 beat = 1.0 sec
        show.patch.push(FixtureInstance {
            id: "fx_1".into(),
            profile: "user/test_tube_8seg.json".into(),
            mode: "34ch Pixel Mode".into(),
            name: "Tube".into(),
            universe: 1,
            address: 1,
            channel_count: 34,
            grid_pos: GridPos::default(),
            calibration: FixtureCalibration {
                gamma: 1.0,
                white_mode: WhiteMode::Off,
                ..FixtureCalibration::default()
            },
        });
        show.fx_library.push(FxBlockDef {
            id: "blk_saw".into(),
            name: "Saw Curve".into(),
            target_group: Some("all".into()),
            duration_beats: 4.0,
            duration_sec: None,
            loop_block: true,
            elements: vec![
                FxElementDef::StaticTrait {
                    trait_name: "color".into(),
                    op: "ltp".into(),
                    palette_ref: None,
                    value_start: None,
                    value_end: None,
                    hex_start: Some("#FFFFFF".into()),
                    hex_end: Some("#FFFFFF".into()),
                    order: None,
                },
                FxElementDef::Curve1D {
                    trait_name: "dimmer".into(),
                    op: "ltp".into(),
                    waveform: "saw".into(),
                    amplitude: 1.0,
                    offset: 0.0,
                    rate_beats: None,
                    speed_hz: None,
                    rate_cycles: Some(1.0),
                    phase_deg: 0.0,
                    phase_spread_deg: 0.0,
                    duty: None,
                    grayscale: false,
                    color_width: 1.0,
                    gradient: 1.0,
                    angle_deg: 0.0,
                    fx_kind_tag: Some("curve_fx".into()),
                    inline_colors: Vec::new(),
                    value_stops: Vec::new(),
                    palette_ref: None,
                    order: None,
                },
            ],
        });
        let sc_sec = SceneDef {
            id: "sc_sec".into(),
            name: "2 Sec Scene".into(),
            bank: Some("main".into()),
            target_group: None,
            priority: 10,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            duration_value: 2.0,
            duration_unit: DurationUnit::Seconds,
            block_refs: vec!["blk_saw".into()],
            timeline_ref: None,
        };
        show.scenes.push(sc_sec.clone());

        let plan = compile_render_plan(1, &show, &lib).unwrap();
        let mut rt = RuntimeControl::new();
        rt.set_live_bpm(60.0, 0.0);
        rt.trigger_scene(&sc_sec, 0.0);
        let mut q = QuantizerState::default();

        // At t=1.0s with duration_value=2.0 Seconds, cycle phase is 0.5 -> saw ~ 128
        let f_half = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 1.0,
                frame_index: 1,
            },
            &rt,
            &mut q,
        );
        assert!((f_half.universes[0].dmx[2] as i16 - 128).abs() <= 2);

        // At t=1.5s -> phase 0.75 -> saw ~ 191 (independent of BPM since unit is Seconds)
        rt.set_live_bpm(180.0, 1.0);
        let f_three_quarter = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 1.5,
                frame_index: 2,
            },
            &rt,
            &mut q,
        );
        assert!((f_three_quarter.universes[0].dmx[2] as i16 - 191).abs() <= 2);
    }

    #[test]
    fn all_six_fx_scene_types_adapt_parameters_and_produce_plausible_dmx() {
        use crate::ofl::library::FixtureLibrary;
        use crate::show::compiler::compile_render_plan;
        use crate::show::patch::{FixtureCalibration, FixtureInstance};
        use crate::show::spatial::{GridPos, OrderRule};
        use crate::show::xml::{DurationUnit, FxBlockDef, FxElementDef, SceneDef, ShowState};

        let lib = FixtureLibrary::load_with_test_fixtures();
        let eval_elements = |elements: Vec<FxElementDef>, t_sec: f64| -> EvaluatedFrame {
            let mut show = ShowState::default();
            show.bpm = 120.0;
            show.patch.push(FixtureInstance {
                id: "fx_tube".into(),
                profile: "user/test_tube_8seg.json".into(),
                mode: "34ch Pixel Mode".into(),
                name: "Tube".into(),
                universe: 1,
                address: 1,
                channel_count: 34,
                grid_pos: GridPos {
                    x: 0.5,
                    y: 0.5,
                    rotation: 0.0,
                    scale_x: 0.3,
                    scale_y: 0.05,
                },
                calibration: FixtureCalibration {
                    gamma: 1.0,
                    min_dimmer_dmx: 0,
                    max_dimmer_dmx: 255,
                    white_mode: WhiteMode::Off,
                    white_gain: 1.0,
                },
            });
            show.fx_library.push(FxBlockDef {
                id: "blk_test".into(),
                name: "Test".into(),
                target_group: Some("all".into()),
                duration_beats: 4.0,
                duration_sec: None,
                loop_block: true,
                elements,
            });
            let sc = SceneDef {
                id: "sc_test".into(),
                name: "Test".into(),
                bank: Some("Bank 1".into()),
                target_group: None,
                priority: 10,
                fade_in_sec: 0.0,
                fade_out_sec: 0.0,
                duration_value: 4.0,
                duration_unit: DurationUnit::Beats,
                block_refs: vec!["blk_test".into()],
                timeline_ref: None,
            };
            show.scenes.push(sc.clone());
            let plan = compile_render_plan(1, &show, &lib).unwrap();
            let mut rt = RuntimeControl::new();
            rt.trigger_scene(&sc, 0.0);
            let mut q = QuantizerState::default();
            Engine::evaluate_frame(
                &plan,
                &ClockInput {
                    t_sec,
                    frame_index: 1,
                },
                &rt,
                &mut q,
            )
        };

        let static_dim = FxElementDef::StaticTrait {
            trait_name: "dimmer".into(),
            op: "ltp".into(),
            palette_ref: None,
            value_start: Some(1.0),
            value_end: Some(1.0),
            hex_start: None,
            hex_end: None,
            order: None,
        };
        let static_white = FxElementDef::StaticTrait {
            trait_name: "color".into(),
            op: "ltp".into(),
            palette_ref: None,
            value_start: Some(0.0),
            value_end: Some(1.0),
            hex_start: Some("#FFFFFF".into()),
            hex_end: Some("#FFFFFF".into()),
            order: None,
        };
        let cell_rgb = |f: &EvaluatedFrame, idx: usize| -> [u8; 3] {
            let b = 2 + idx * 4;
            [
                f.universes[0].dmx[b],
                f.universes[0].dmx[b + 1],
                f.universes[0].dmx[b + 2],
            ]
        };

        // 1. FX-01: color_fx (color spread, time evolution, grayscale, direction reversal)
        let color_fx = FxElementDef::Curve1D {
            trait_name: "color".into(),
            op: "ltp".into(),
            waveform: "saw".into(),
            amplitude: 1.0,
            offset: 0.0,
            rate_beats: None,
            speed_hz: None,
            rate_cycles: Some(1.0),
            phase_deg: 0.0,
            phase_spread_deg: 360.0,
            duty: None,
            grayscale: false,
            color_width: 1.0,
            gradient: 1.0,
            angle_deg: 0.0,
            fx_kind_tag: Some("color_fx".into()),
            inline_colors: vec!["#FF0000".into(), "#00FF00".into(), "#0000FF".into()],
            value_stops: Vec::new(),
            palette_ref: None,
            order: Some(OrderRule::Linear),
        };
        let f_cfx0 = eval_elements(vec![static_dim.clone(), color_fx.clone()], 0.0);
        let f_cfx1 = eval_elements(vec![static_dim.clone(), color_fx.clone()], 0.5);
        assert_ne!(cell_rgb(&f_cfx0, 0), cell_rgb(&f_cfx0, 3));
        assert_ne!(f_cfx0.universes[0].dmx[2..34], f_cfx1.universes[0].dmx[2..34]);

        let mut color_fx_gray = color_fx.clone();
        if let FxElementDef::Curve1D {
            ref mut grayscale, ..
        } = color_fx_gray
        {
            *grayscale = true;
        }
        let f_gray = eval_elements(vec![static_dim.clone(), color_fx_gray], 0.25);
        for i in 0..8 {
            let [r, g, b] = cell_rgb(&f_gray, i);
            assert!((r as i16 - g as i16).abs() <= 2);
            assert!((g as i16 - b as i16).abs() <= 2);
            assert!(r > 0);
        }

        // 2. FX-02: color_mappings (all 4 shaders, gizmo bounding box, mirror_x)
        for shader in ["linear_sweep", "radial_wave", "pinwheel", "plasma"] {
            let cmap = FxElementDef::SpatialShader2D {
                trait_name: "color".into(),
                op: "ltp".into(),
                shader: shader.into(),
                palette_ref: None,
                rate_beats: None,
                speed_hz: None,
                rate_cycles: Some(1.0),
                phase_offset: None,
                spatial_freq: 1.0,
                color_width: 1.0,
                gradient: 1.0,
                grayscale: false,
                transform: None,
                inline_colors: vec!["#FF0000".into(), "#00FF00".into(), "#0000FF".into()],
                value_stops: Vec::new(),
                direction_deg: 0.0,
                center_x: 0.5,
                center_y: 0.5,
                box_half_x: None,
                box_half_y: None,
            };
            let f0 = eval_elements(vec![static_dim.clone(), cmap.clone()], 0.0);
            let f1 = eval_elements(vec![static_dim.clone(), cmap], 0.5);
            assert!(f0.universes[0].dmx[2..34].iter().any(|&v| v > 0));
            assert_ne!(f0.universes[0].dmx[2..34], f1.universes[0].dmx[2..34]);
        }
        let cmap_oob = FxElementDef::SpatialShader2D {
            trait_name: "color".into(),
            op: "ltp".into(),
            shader: "linear_sweep".into(),
            palette_ref: None,
            rate_beats: None,
            speed_hz: None,
            rate_cycles: Some(1.0),
            phase_offset: None,
            spatial_freq: 1.0,
            color_width: 1.0,
            gradient: 1.0,
            grayscale: false,
            transform: None,
            inline_colors: vec!["#FF0000".into(), "#0000FF".into()],
            value_stops: Vec::new(),
            direction_deg: 0.0,
            center_x: 0.99,
            center_y: 0.99,
            box_half_x: None,
            box_half_y: None,
        };
        let f_oob = eval_elements(vec![static_dim.clone(), cmap_oob], 0.0);
        assert!(f_oob.universes[0].dmx[2..34].iter().all(|&v| v == 0));

        // Wide scale (spatial_freq = 0.25 => pattern_scale = 4.0 => box_half_norm = 0.8) covers cells beyond 0.45 from center
        let cmap_wide = FxElementDef::SpatialShader2D {
            trait_name: "color".into(),
            op: "ltp".into(),
            shader: "linear_sweep".into(),
            palette_ref: None,
            rate_beats: None,
            speed_hz: None,
            rate_cycles: Some(1.0),
            phase_offset: None,
            spatial_freq: 0.25,
            color_width: 1.0,
            gradient: 1.0,
            grayscale: false,
            transform: None,
            inline_colors: vec!["#FF0000".into(), "#0000FF".into()],
            value_stops: Vec::new(),
            direction_deg: 0.0,
            center_x: 0.99,
            center_y: 0.5,
            box_half_x: None,
            box_half_y: None,
        };
        let f_wide = eval_elements(vec![static_dim.clone(), cmap_wide], 0.0);
        assert!(f_wide.universes[0].dmx[2..34].iter().any(|&v| v > 0));

        // 3. FX-03: chaser_fx (pixels_on, one_way bounce, fade, reverse order)
        let make_chase = |pixels_on: u16, one_way: bool, fade: f32, order: OrderRule| {
            FxElementDef::StepChase {
                trait_name: "dimmer".into(),
                op: "ltp".into(),
                step_beats: None,
                speed_hz: None,
                rate_cycles: Some(1.0),
                one_way,
                pixels_on: Some(pixels_on),
                active_ratio: None,
                fade,
                amplitude: 1.0,
                palette_ref: None,
                order: Some(order),
            }
        };
        let f_c1 = eval_elements(
            vec![
                static_white.clone(),
                make_chase(1, true, 0.0, OrderRule::Linear),
            ],
            0.5,
        );
        let f_c3 = eval_elements(
            vec![
                static_white.clone(),
                make_chase(3, true, 0.0, OrderRule::Linear),
            ],
            0.5,
        );
        let lit_c1 = (0..8).filter(|&i| cell_rgb(&f_c1, i)[0] > 0).count();
        let lit_c3 = (0..8).filter(|&i| cell_rgb(&f_c3, i)[0] > 0).count();
        assert!(lit_c1 >= 1 && lit_c3 > lit_c1);

        let f_b_q1 = eval_elements(
            vec![
                static_white.clone(),
                make_chase(2, false, 0.0, OrderRule::Linear),
            ],
            0.5,
        );
        let f_b_q3 = eval_elements(
            vec![
                static_white.clone(),
                make_chase(2, false, 0.0, OrderRule::Linear),
            ],
            1.5,
        );
        assert_eq!(
            f_b_q1.universes[0].dmx[2..34],
            f_b_q3.universes[0].dmx[2..34]
        );

        // 4. FX-04: value_fx (value_stops, phase_spread_deg=0 sync, gradient=0 stepped)
        let make_val = |stops: Vec<f32>, spread: f32, grad: f32| FxElementDef::Curve1D {
            trait_name: "dimmer".into(),
            op: "ltp".into(),
            waveform: "saw".into(),
            amplitude: 1.0,
            offset: 0.0,
            rate_beats: None,
            speed_hz: None,
            rate_cycles: Some(1.0),
            phase_deg: 0.0,
            phase_spread_deg: spread,
            duty: None,
            grayscale: false,
            color_width: 1.0,
            gradient: grad,
            angle_deg: 0.0,
            fx_kind_tag: Some("value_fx".into()),
            inline_colors: Vec::new(),
            value_stops: stops,
            palette_ref: None,
            order: Some(OrderRule::Linear),
        };
        let f_vsync = eval_elements(
            vec![static_white.clone(), make_val(vec![1.0, 0.5, 0.0], 0.0, 1.0)],
            0.0,
        );
        let r0 = cell_rgb(&f_vsync, 0)[0];
        assert!(r0 > 200);
        assert!((0..8).all(|i| cell_rgb(&f_vsync, i)[0] == r0));

        let f_vstep = eval_elements(
            vec![static_white.clone(), make_val(vec![1.0, 0.0], 360.0, 0.0)],
            0.0,
        );
        assert!((0..8).all(|i| {
            let v = cell_rgb(&f_vstep, i)[0];
            v == 0 || v == 255
        }));

        // 5. FX-05: curve_fx (pulse duty adaptation & amplitude/offset range)
        let make_pulse = |duty: f32| FxElementDef::Curve1D {
            trait_name: "dimmer".into(),
            op: "ltp".into(),
            waveform: "pulse".into(),
            amplitude: 1.0,
            offset: 0.0,
            rate_beats: None,
            speed_hz: None,
            rate_cycles: Some(1.0),
            phase_deg: 0.0,
            phase_spread_deg: 0.0,
            duty: Some(duty),
            grayscale: false,
            color_width: 1.0,
            gradient: 1.0,
            angle_deg: 0.0,
            fx_kind_tag: Some("curve_fx".into()),
            inline_colors: Vec::new(),
            value_stops: Vec::new(),
            palette_ref: None,
            order: Some(OrderRule::Linear),
        };
        let f_narrow = eval_elements(vec![static_white.clone(), make_pulse(0.25)], 1.0);
        let f_wide = eval_elements(vec![static_white.clone(), make_pulse(0.75)], 1.0);
        assert_eq!(cell_rgb(&f_narrow, 0)[0], 0);
        assert_eq!(cell_rgb(&f_wide, 0)[0], 255);

        // 6. FX-06: mappings (dimmer spatial_shader_2d with value_stops, mirror_x, bounds)
        let make_dim_map = |stops: Vec<f32>, transform: Option<&str>, cx: f32| {
            FxElementDef::SpatialShader2D {
                trait_name: "dimmer".into(),
                op: "ltp".into(),
                shader: "linear_sweep".into(),
                palette_ref: None,
                rate_beats: None,
                speed_hz: None,
                rate_cycles: Some(1.0),
                phase_offset: None,
                spatial_freq: 1.0,
                color_width: 1.0,
                gradient: 1.0,
                grayscale: false,
                transform: transform.map(str::to_string),
                inline_colors: Vec::new(),
                value_stops: stops,
                direction_deg: 0.0,
                center_x: cx,
                center_y: 0.5,
                box_half_x: None,
                box_half_y: None,
            }
        };
        let f_mhalf = eval_elements(
            vec![static_white.clone(), make_dim_map(vec![0.5, 0.5], None, 0.5)],
            0.0,
        );
        for i in 0..8 {
            let v = cell_rgb(&f_mhalf, i)[0];
            assert!((v as i16 - 128).abs() <= 3, "expected ~128, got {v}");
        }
        let f_mnorm = eval_elements(
            vec![
                static_white.clone(),
                make_dim_map(vec![1.0, 0.2, 0.0], None, 0.5),
            ],
            0.0,
        );
        let f_mmirr = eval_elements(
            vec![
                static_white.clone(),
                make_dim_map(vec![1.0, 0.2, 0.0], Some("mirror_x"), 0.5),
            ],
            0.0,
        );
        assert_ne!(cell_rgb(&f_mnorm, 0)[0], cell_rgb(&f_mmirr, 0)[0]);
        assert_eq!(cell_rgb(&f_mmirr, 0)[0], cell_rgb(&f_mmirr, 7)[0]);
        let f_moob = eval_elements(
            vec![static_white, make_dim_map(vec![1.0, 0.0], None, 0.99)],
            0.0,
        );
        assert!(f_moob.universes[0].dmx[2..34].iter().all(|&v| v == 0));

        // 7. Scalar channel traits (red/green/blue) + master_dimmer parity with TS mixer
        let static_master = FxElementDef::StaticTrait {
            trait_name: "master_dimmer".into(),
            op: "ltp".into(),
            palette_ref: None,
            value_start: Some(1.0),
            value_end: Some(1.0),
            hex_start: None,
            hex_end: None,
            order: None,
        };
        let red_curve = FxElementDef::Curve1D {
            trait_name: "red".into(),
            op: "ltp".into(),
            waveform: "square".into(),
            amplitude: 1.0,
            offset: 0.0,
            rate_beats: None,
            speed_hz: None,
            rate_cycles: Some(1.0),
            phase_deg: 0.0,
            phase_spread_deg: 0.0,
            duty: Some(0.5),
            grayscale: false,
            color_width: 1.0,
            gradient: 1.0,
            angle_deg: 0.0,
            fx_kind_tag: Some("curve_fx".into()),
            inline_colors: Vec::new(),
            value_stops: Vec::new(),
            palette_ref: None,
            order: Some(OrderRule::Linear),
        };
        let f_red = eval_elements(vec![static_master.clone(), red_curve], 0.0);
        assert_eq!(cell_rgb(&f_red, 0), [255, 0, 0]);

        let blue_chase = FxElementDef::StepChase {
            trait_name: "blue".into(),
            op: "ltp".into(),
            step_beats: None,
            speed_hz: None,
            rate_cycles: Some(1.0),
            one_way: true,
            pixels_on: Some(8),
            active_ratio: None,
            fade: 0.0,
            amplitude: 1.0,
            palette_ref: None,
            order: Some(OrderRule::Linear),
        };
        let f_blue = eval_elements(vec![static_master, blue_chase], 0.0);
        assert_eq!(cell_rgb(&f_blue, 0), [0, 0, 255]);

        let master_chase = FxElementDef::StepChase {
            trait_name: "master_dimmer".into(),
            op: "ltp".into(),
            step_beats: None,
            speed_hz: None,
            rate_cycles: Some(1.0),
            one_way: true,
            pixels_on: Some(1),
            active_ratio: None,
            fade: 0.0,
            amplitude: 1.0,
            palette_ref: None,
            order: Some(OrderRule::Linear),
        };
        let f_mchase = eval_elements(vec![master_chase], 0.0);
        assert_eq!(f_mchase.universes[0].dmx[0], 255);
    }

    #[test]
    fn edge_cases_zero_and_single_cell_split_universe_dangling_refs_and_xml_dmx_invariance() {
        use crate::ofl::library::FixtureLibrary;
        use crate::show::compiler::compile_render_plan;
        use crate::show::patch::{FixtureCalibration, FixtureInstance};
        use crate::show::spatial::{GridPos, OrderRule};
        use crate::show::xml::{DurationUnit, FxBlockDef, FxElementDef, SceneDef, ShowState};

        let lib = FixtureLibrary::load_with_test_fixtures();

        // 1. 0-fixture show with active FX scene + dangling palette_ref & target_group -> zero panic, zero DMX
        let mut empty_show = ShowState::default();
        empty_show.fx_library.push(FxBlockDef {
            id: "blk_dangling".into(),
            name: "Dangling".into(),
            target_group: Some("grp_missing".into()),
            duration_beats: 4.0,
            duration_sec: None,
            loop_block: true,
            elements: vec![FxElementDef::Curve1D {
                trait_name: "color".into(),
                op: "ltp".into(),
                waveform: "sine".into(),
                amplitude: 1.0,
                offset: 0.0,
                rate_beats: None,
                speed_hz: None,
                rate_cycles: Some(1.0),
                phase_deg: 0.0,
                phase_spread_deg: 360.0,
                duty: None,
                grayscale: false,
                color_width: 1.0,
                gradient: 1.0,
                angle_deg: 0.0,
                fx_kind_tag: Some("color_fx".into()),
                inline_colors: Vec::new(),
                value_stops: Vec::new(),
                palette_ref: Some("pal_nonexistent".into()),
                order: Some(OrderRule::Linear),
            }],
        });
        let sc_empty = SceneDef {
            id: "sc_empty".into(),
            name: "Empty".into(),
            bank: Some("Bank 1".into()),
            target_group: None,
            priority: 10,
            fade_in_sec: 10.0,
            fade_out_sec: 10.0,
            duration_value: 2.0,
            duration_unit: DurationUnit::Beats,
            block_refs: vec!["blk_dangling".into()],
            timeline_ref: None,
        };
        empty_show.scenes.push(sc_empty.clone());
        let plan_empty = compile_render_plan(1, &empty_show, &lib).unwrap();
        let mut rt_empty = RuntimeControl::new();
        rt_empty.trigger_scene(&sc_empty, 0.0);
        let mut q = QuantizerState::default();
        let f_empty = Engine::evaluate_frame(
            &plan_empty,
            &ClockInput {
                t_sec: 0.5,
                frame_index: 1,
            },
            &rt_empty,
            &mut q,
        );
        assert!(f_empty.universes[0].dmx.iter().all(|&v| v == 0));

        // 2. Split 16-segment RLCV4 across U1.490 -> U2 under color_fx + chaser_fx (pixels_on > cell_count)
        let mut split_show = ShowState::default();
        split_show.patch.push(FixtureInstance {
            id: "fx_rlcv4".into(),
            profile: "user/test_tube_16seg.json".into(),
            mode: "66ch Pixel Mode".into(),
            name: "Split RLCV4".into(),
            universe: 1,
            address: 490,
            channel_count: 66,
            grid_pos: GridPos {
                x: 0.5,
                y: 0.5,
                rotation: 0.0,
                scale_x: 0.3,
                scale_y: 0.05,
            },
            calibration: FixtureCalibration {
                gamma: 1.0,
                min_dimmer_dmx: 0,
                max_dimmer_dmx: 255,
                white_mode: WhiteMode::Off,
                white_gain: 1.0,
            },
        });
        split_show.fx_library.push(FxBlockDef {
            id: "blk_split_fx".into(),
            name: "Split FX".into(),
            target_group: Some("all".into()),
            duration_beats: 4.0,
            duration_sec: None,
            loop_block: true,
            elements: vec![
                FxElementDef::Curve1D {
                    trait_name: "color".into(),
                    op: "ltp".into(),
                    waveform: "saw".into(),
                    amplitude: 1.0,
                    offset: 0.0,
                    rate_beats: None,
                    speed_hz: None,
                    rate_cycles: Some(1.0),
                    phase_deg: 0.0,
                    phase_spread_deg: 360.0,
                    duty: None,
                    grayscale: false,
                    color_width: 1.0,
                    gradient: 1.0,
                    angle_deg: 0.0,
                    fx_kind_tag: Some("color_fx".into()),
                    inline_colors: vec!["#FF0000".into(), "#00FF00".into(), "#0000FF".into()],
                    value_stops: Vec::new(),
                    palette_ref: None,
                    order: Some(OrderRule::Linear),
                },
                FxElementDef::StepChase {
                    trait_name: "dimmer".into(),
                    op: "ltp".into(),
                    step_beats: None,
                    speed_hz: None,
                    rate_cycles: Some(1.0),
                    one_way: false,
                    pixels_on: Some(99), // > cell_count (16) must clamp cleanly to all on
                    active_ratio: None,
                    fade: 0.25,
                    amplitude: 1.0,
                    palette_ref: None,
                    order: Some(OrderRule::Linear),
                },
            ],
        });
        let sc_split = SceneDef {
            id: "sc_split".into(),
            name: "Split Scene".into(),
            bank: Some("Bank 1".into()),
            target_group: None,
            priority: 10,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            duration_value: 4.0,
            duration_unit: DurationUnit::Beats,
            block_refs: vec!["blk_split_fx".into()],
            timeline_ref: None,
        };
        split_show.scenes.push(sc_split.clone());

        let plan_before = compile_render_plan(1, &split_show, &lib).unwrap();
        let mut rt_split = RuntimeControl::new();
        rt_split.trigger_scene(&sc_split, 0.0);
        let f_before = Engine::evaluate_frame(
            &plan_before,
            &ClockInput {
                t_sec: 0.35,
                frame_index: 15,
            },
            &rt_split,
            &mut q,
        );
        // Both Universe 1 (head at ch 490..512) and Universe 2 (tail at ch 1..43) must have non-zero DMX
        assert!(f_before.universes[0].dmx[489..512].iter().any(|&v| v > 0));
        assert!(f_before.universes[1].dmx[0..43].iter().any(|&v| v > 0));

        // 3. Full XML export -> import round-trip produces byte-identical DMX output
        let xml = crate::show::xml::serialize_show_xml(&split_show).unwrap();
        let reloaded = crate::show::xml::deserialize_show_xml(&xml).unwrap();
        let plan_after = compile_render_plan(2, &reloaded, &lib).unwrap();
        let f_after = Engine::evaluate_frame(
            &plan_after,
            &ClockInput {
                t_sec: 0.35,
                frame_index: 15,
            },
            &rt_split,
            &mut q,
        );
        assert_eq!(f_before.universes[0].dmx, f_after.universes[0].dmx);
        assert_eq!(f_before.universes[1].dmx, f_after.universes[1].dmx);
    }

    #[test]
    fn static_spatial_shader_2d_freezes_over_time_and_respects_phase_offset() {
        use crate::ofl::library::FixtureLibrary;
        use crate::show::compiler::compile_render_plan;
        use crate::show::patch::{FixtureCalibration, FixtureInstance};
        use crate::show::spatial::GridPos;
        use crate::show::xml::{DurationUnit, FxBlockDef, FxElementDef, SceneDef, ShowState};

        let mut show = ShowState::default();
        show.bpm = 120.0;
        show.patch.push(FixtureInstance {
            id: "fx_tube".into(),
            profile: "user/test_tube_8seg.json".into(),
            mode: "34ch Pixel Mode".into(),
            name: "Tube".into(),
            universe: 1,
            address: 1,
            channel_count: 34,
            grid_pos: GridPos {
                x: 0.5,
                y: 0.5,
                rotation: 0.0,
                scale_x: 0.3,
                scale_y: 0.05,
            },
            calibration: FixtureCalibration::default(),
        });
        let lib = FixtureLibrary::load_with_test_fixtures();
        let mut q = QuantizerState::default();

        let mut eval_elements = |elements: Vec<FxElementDef>, t_sec: f64| -> EvaluatedFrame {
            let mut s = show.clone();
            s.fx_library.push(FxBlockDef {
                id: "blk_static_map".into(),
                name: "Static Map".into(),
                target_group: Some("all".into()),
                duration_beats: 4.0,
                duration_sec: None,
                loop_block: true,
                elements,
            });
            let sc = SceneDef {
                id: "sc_static_map".into(),
                name: "Static Map".into(),
                bank: Some("Bank 1".into()),
                target_group: None,
                priority: 10,
                fade_in_sec: 0.0,
                fade_out_sec: 0.0,
                duration_value: 4.0,
                duration_unit: DurationUnit::Beats,
                block_refs: vec!["blk_static_map".into()],
                timeline_ref: None,
            };
            s.scenes.push(sc.clone());
            let plan = compile_render_plan(1, &s, &lib).unwrap();
            let mut rt = RuntimeControl::new();
            rt.trigger_scene(&sc, 0.0);
            Engine::evaluate_frame(
                &plan,
                &ClockInput {
                    t_sec,
                    frame_index: (t_sec * 44.0) as u64,
                },
                &rt,
                &mut q,
            )
        };

        let static_dim = FxElementDef::StaticTrait {
            trait_name: "dimmer".into(),
            op: "ltp".into(),
            palette_ref: None,
            value_start: Some(1.0),
            value_end: Some(1.0),
            hex_start: None,
            hex_end: None,
            order: None,
        };
        let static_white = FxElementDef::StaticTrait {
            trait_name: "color".into(),
            op: "ltp".into(),
            palette_ref: None,
            value_start: None,
            value_end: None,
            hex_start: Some("#FFFFFF".into()),
            hex_end: Some("#FFFFFF".into()),
            order: None,
        };

        // 1. Color mapping with rate_cycles = 0 freezes across time
        let make_color_map = |phase_offset: Option<f32>| FxElementDef::SpatialShader2D {
            trait_name: "color".into(),
            op: "ltp".into(),
            shader: "linear_sweep".into(),
            palette_ref: None,
            rate_beats: None,
            speed_hz: None,
            rate_cycles: Some(0.0),
            phase_offset,
            spatial_freq: 1.0,
            color_width: 1.0,
            gradient: 1.0,
            grayscale: false,
            transform: None,
            inline_colors: vec!["#FF0000".into(), "#00FF00".into(), "#0000FF".into()],
            value_stops: Vec::new(),
            direction_deg: 0.0,
            center_x: 0.5,
            center_y: 0.5,
            box_half_x: None,
            box_half_y: None,
        };
        let c0 = eval_elements(vec![static_dim.clone(), make_color_map(None)], 0.0);
        let c1 = eval_elements(vec![static_dim.clone(), make_color_map(None)], 0.5);
        let c2 = eval_elements(vec![static_dim.clone(), make_color_map(None)], 1.25);
        assert_eq!(c0.universes[0].dmx[2..34], c1.universes[0].dmx[2..34]);
        assert_eq!(c0.universes[0].dmx[2..34], c2.universes[0].dmx[2..34]);
        // Must still have spatial variation across cells
        assert_ne!(c0.universes[0].dmx[2..6], c0.universes[0].dmx[30..34]);

        // phase_offset shifts the static color pattern
        let c_shifted = eval_elements(vec![static_dim, make_color_map(Some(0.5))], 0.0);
        assert_ne!(c0.universes[0].dmx[2..34], c_shifted.universes[0].dmx[2..34]);

        // 2. Dimmer mapping with rate_cycles = 0 freezes across time and shifts with phase_offset
        let make_dim_map = |phase_offset: Option<f32>| FxElementDef::SpatialShader2D {
            trait_name: "dimmer".into(),
            op: "ltp".into(),
            shader: "linear_sweep".into(),
            palette_ref: None,
            rate_beats: None,
            speed_hz: None,
            rate_cycles: Some(0.0),
            phase_offset,
            spatial_freq: 1.0,
            color_width: 1.0,
            gradient: 1.0,
            grayscale: false,
            transform: None,
            inline_colors: Vec::new(),
            value_stops: vec![1.0, 0.0],
            direction_deg: 0.0,
            center_x: 0.5,
            center_y: 0.5,
            box_half_x: None,
            box_half_y: None,
        };
        let d0 = eval_elements(vec![static_white.clone(), make_dim_map(None)], 0.0);
        let d1 = eval_elements(vec![static_white.clone(), make_dim_map(None)], 0.75);
        assert_eq!(d0.universes[0].dmx[2..34], d1.universes[0].dmx[2..34]);

        let d_shifted = eval_elements(vec![static_white, make_dim_map(Some(0.5))], 0.0);
        assert_ne!(d0.universes[0].dmx[2..34], d_shifted.universes[0].dmx[2..34]);
    }

    #[test]
    fn identified_fixture_forces_open_white_and_preview_reflects_wheel_and_strobe() {
        use crate::ofl::expander::{ResolvedWheelSlot, StrobeRange};
        use crate::ofl::library::FixtureLibrary;
        use crate::show::compiler::compile_render_plan;
        use crate::show::patch::{FixtureCalibration, FixtureInstance};
        use crate::show::spatial::GridPos;
        use crate::show::xml::ShowState;
        use crate::state::plan::{CompiledChannelSlot, CompiledFixture};

        // 1. Identify/Locate forces a patched fixture to full white even with no active scenes
        let library = FixtureLibrary::load_with_test_fixtures();
        let mut show = ShowState::default();
        show.patch.push(FixtureInstance {
            id: "fx_locate".into(),
            profile: "user/test_tube_8seg.json".into(),
            mode: "34ch Pixel Mode".into(),
            name: "Locate Tube".into(),
            universe: 1,
            address: 1,
            channel_count: 34,
            grid_pos: GridPos::default(),
            calibration: FixtureCalibration::default(),
        });
        let plan = compile_render_plan(1, &show, &library).unwrap();
        let mut rt = RuntimeControl::new();
        rt.set_identified_fixture(Some("fx_locate".into()));
        let mut q = QuantizerState::default();
        let frame = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 0.0,
                frame_index: 1,
            },
            &rt,
            &mut q,
        );
        assert_eq!(frame.universes[0].dmx[0], 255); // Master dimmer 100%
        assert_eq!(frame.universes[0].dmx[1], 11); // Shutter open
        assert!(frame.universes[0].dmx[5] > 200 || frame.universes[0].dmx[2] > 200);

        // 2. 2D preview resolves WheelSlot color and ShutterStrobe closed/strobe gating
        let mut wheel_plan = RenderPlan::default_studio_plan();
        let mut fx = CompiledFixture {
            id: "fx_wheel".into(),
            name: "Wheel Spot".into(),
            profile: "test".into(),
            mode: "3ch".into(),
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
                    default_value: 255,
                    target: ChannelTarget::Fixture,
                    role: ChannelRole::Intensity,
                    fine_channel_offset: None,
                    wheel_slot_oklabs: Vec::new(),
                },
                CompiledChannelSlot {
                    universe_id: 1,
                    universe_index: Some(0),
                    dmx_address: 2,
                    name: "Color Wheel".into(),
                    default_value: 25,
                    target: ChannelTarget::Fixture,
                    role: ChannelRole::WheelSlot {
                        wheel_name: Some("Color".into()),
                        slots: vec![
                            ResolvedWheelSlot {
                                slot_number: 1,
                                dmx_range: [0, 19],
                                name: Some("Open".into()),
                                colors_hex: vec!["#FFFFFF".into()],
                            },
                            ResolvedWheelSlot {
                                slot_number: 2,
                                dmx_range: [20, 39],
                                name: Some("Red".into()),
                                colors_hex: vec!["#FF0000".into()],
                            },
                        ],
                    },
                    fine_channel_offset: None,
                    wheel_slot_oklabs: Vec::new(),
                },
                CompiledChannelSlot {
                    universe_id: 1,
                    universe_index: Some(0),
                    dmx_address: 3,
                    name: "Shutter".into(),
                    default_value: 10,
                    target: ChannelTarget::Fixture,
                    role: ChannelRole::ShutterStrobe {
                        capabilities: vec![
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
                        ],
                    },
                    fine_channel_offset: None,
                    wheel_slot_oklabs: Vec::new(),
                },
            ],
            has_hardware_shutter: false,
            fixture_has_master_intensity: false,
            has_fixture_white: false,
            cell_has_dedicated_intensity: Vec::new(),
            cell_has_white: Vec::new(),
        };
        fx.compute_precomputed_flags();
        wheel_plan.fixtures = vec![fx];
        wheel_plan.cell_count = 1;
        wheel_plan.base_dmx[0][0] = 255;
        wheel_plan.base_dmx[0][1] = 25; // Red wheel slot
        wheel_plan.base_dmx[0][2] = 10; // Shutter open

        let rt_open = RuntimeControl::new();
        let f_open = Engine::evaluate_frame(
            &wheel_plan,
            &ClockInput {
                t_sec: 0.0,
                frame_index: 1,
            },
            &rt_open,
            &mut q,
        );
        assert!(f_open.cell_preview_rgbd[0] > 240); // R
        assert!(f_open.cell_preview_rgbd[1] < 10); // G
        assert!(f_open.cell_preview_rgbd[2] < 10); // B
        assert_eq!(f_open.cell_preview_rgbd[3], 255); // Dimmer open

        // Closing shutter zeroes preview dimmer
        wheel_plan.base_dmx[0][2] = 3; // Closed
        let f_closed = Engine::evaluate_frame(
            &wheel_plan,
            &ClockInput {
                t_sec: 0.0,
                frame_index: 2,
            },
            &rt_open,
            &mut q,
        );
        assert_eq!(f_closed.cell_preview_rgbd[3], 0);
    }
}
