use crate::fx::scene::evaluate_scenes_and_live_layers;
use crate::mixer::quantizer::quantize_fixture_to_dmx;
pub use crate::mixer::quantizer::QuantizerState;
use crate::ofl::expander::{ChannelRole, ChannelTarget};
use crate::ofl::model::OflColor;
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
        if !plan.fixtures.is_empty()
            && ((runtime.active_timeline_id.is_some() && !plan.timelines.is_empty())
                || !runtime.active_scenes.is_empty()
                || !plan.static_layers.is_empty()
                || !runtime.live_layers.is_empty())
        {
            let (fx_states, cell_states) =
                evaluate_scenes_and_live_layers(plan, clock, runtime);

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

        // Stage 4 Step 7: Session-only Channel Park overrides everything including Blackout
        for (idx, uni_cfg) in plan.universes.iter().enumerate() {
            for (&(parked_uni, parked_ch), &parked_val) in &runtime.parked_channels {
                if parked_uni == uni_cfg.id && (1..=512).contains(&parked_ch) {
                    universes[idx].dmx[(parked_ch - 1) as usize] = parked_val;
                }
            }
        }

        // Compute cell preview RGBD bytes from live DMX output (supports Channel Park visualization on 2D grid!)
        let mut cell_preview_rgbd = vec![0u8; (plan.cell_count as usize) * 4];
        for fx in &plan.fixtures {
            let mut fixture_master: Option<u8> = None;
            for ch in &fx.channels {
                if ch.target == ChannelTarget::Fixture && ch.role == ChannelRole::Intensity {
                    if let Some(u_idx) = ch.universe_index {
                        if let Some(u) = universes.get(u_idx) {
                            fixture_master = Some(dmx_to_perceptual_u8(
                                u.dmx[(ch.dmx_address - 1) as usize],
                                fx.calibration.gamma,
                            ));
                        }
                    }
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
                    match ch.role {
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
                        _ => {}
                    }
                }

                let rr = dmx_to_perceptual_u8((r + w).min(255) as u8, fx.calibration.gamma);
                let gg = dmx_to_perceptual_u8((g + w).min(255) as u8, fx.calibration.gamma);
                let bb = dmx_to_perceptual_u8((b + w).min(255) as u8, fx.calibration.gamma);
                let eff_dim = match (cell_intensity, fixture_master) {
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

        let library = FixtureLibrary::load(None);
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
            profile: "age/rlcv3_8_segment_tube.json".into(),
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

        let library = FixtureLibrary::load(None);
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
            profile: "age/rlcv3_8_segment_tube.json".into(),
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

        let lib = FixtureLibrary::load(None);
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
            profile: "age/rlcv3_8_segment_tube.json".into(),
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
                    }],
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
                    }],
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

        let lib = FixtureLibrary::load(None);
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
            profile: "age/rlcv3_8_segment_tube.json".into(),
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

        let lib = FixtureLibrary::load(None);
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
            profile: "age/rlcv3_8_segment_tube.json".into(),
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

        let lib = FixtureLibrary::load(None);
        let mut show = ShowState::default();
        show.bpm = 60.0; // 1 beat = 1.0 sec
        show.patch.push(FixtureInstance {
            id: "fx_1".into(),
            profile: "age/rlcv3_8_segment_tube.json".into(),
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
            elements: vec![FxElementDef::Curve1D {
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
            }],
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
}
