use crate::ofl::expander::{ChannelRole, ChannelTarget};
use crate::ofl::model::OflColor;
use crate::state::plan::RenderPlan;
use crate::state::runtime::RuntimeControl;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClockInput {
    pub t_sec: f64,
    pub frame_index: u64,
}

#[derive(Debug, Default, Clone)]
pub struct QuantizerState {
    pub prev_t_sec: Option<f64>,
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

impl Engine {
    pub fn evaluate_frame(
        plan: &RenderPlan,
        clock: &ClockInput,
        runtime: &RuntimeControl,
        quantizer_state: &mut QuantizerState,
    ) -> EvaluatedFrame {
        quantizer_state.prev_t_sec = Some(clock.t_sec);

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

            // Stage 4 Step 7: Session-only Channel Park overrides everything including Blackout
            for (&(parked_uni, parked_ch), &parked_val) in &runtime.parked_channels {
                if parked_uni == uni_cfg.id && (1..=512).contains(&parked_ch) {
                    dmx[(parked_ch - 1) as usize] = parked_val;
                }
            }

            universes.push(EvaluatedUniverse {
                universe_id: uni_cfg.id,
                dmx,
            });
        }

        // Compute cell preview RGBD bytes from live DMX output (supports Channel Park visualization on 2D grid!)
        let mut cell_preview_rgbd = vec![0u8; (plan.cell_count as usize) * 4];
        for fx in &plan.fixtures {
            let mut fixture_master: Option<u8> = None;
            for ch in &fx.channels {
                if ch.target == ChannelTarget::Fixture && ch.role == ChannelRole::Intensity {
                    if let Some(u_idx) = ch.universe_index {
                        if let Some(u) = universes.get(u_idx) {
                            fixture_master = Some(u.dmx[(ch.dmx_address - 1) as usize]);
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
                        ChannelRole::Intensity => cell_intensity = Some(val),
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

                let rr = (r + w).min(255) as u8;
                let gg = (g + w).min(255) as u8;
                let bb = (b + w).min(255) as u8;
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
                // If color channels are parked/lit while fixture master was left at 0 in Slice 3 bench testing,
                // keep preview dimmer proportional to max color channel so parked RGB channels stay visible
                let display_dim = if eff_dim == 0 && (rr > 0 || gg > 0 || bb > 0) {
                    rr.max(gg).max(bb) / 2
                } else {
                    eff_dim
                };

                let base_idx = global_cell * 4;
                cell_preview_rgbd[base_idx] = rr;
                cell_preview_rgbd[base_idx + 1] = gg;
                cell_preview_rgbd[base_idx + 2] = bb;
                cell_preview_rgbd[base_idx + 3] = display_dim;
            }
        }

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
}
