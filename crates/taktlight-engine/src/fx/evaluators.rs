use std::f32::consts::TAU;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::show::ShowError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Waveform1D {
    #[default]
    Sine,
    Triangle,
    Saw,
    Square,
    Pulse,
}

impl fmt::Display for Waveform1D {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sine => write!(f, "sine"),
            Self::Triangle => write!(f, "triangle"),
            Self::Saw => write!(f, "saw"),
            Self::Square => write!(f, "square"),
            Self::Pulse => write!(f, "pulse"),
        }
    }
}

impl FromStr for Waveform1D {
    type Err = ShowError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "sine" => Ok(Self::Sine),
            "triangle" => Ok(Self::Triangle),
            "saw" => Ok(Self::Saw),
            "square" => Ok(Self::Square),
            "pulse" => Ok(Self::Pulse),
            other => Err(ShowError::Xml(format!("invalid 1D waveform '{other}'"))),
        }
    }
}

impl Waveform1D {
    pub fn eval_unipolar(self, phi: f32, duty: Option<f32>) -> f32 {
        let p = phi.rem_euclid(1.0);
        match self {
            Self::Sine => (0.5 + 0.5 * (TAU * p).sin()).clamp(0.0, 1.0),
            Self::Triangle => (1.0 - (2.0 * p - 1.0).abs()).clamp(0.0, 1.0),
            Self::Saw => p.clamp(0.0, 1.0),
            Self::Square => {
                if p < 0.5 {
                    1.0
                } else {
                    0.0
                }
            }
            Self::Pulse => {
                let d = duty.unwrap_or(0.20).clamp(0.01, 0.99);
                if p < d {
                    1.0
                } else {
                    0.0
                }
            }
        }
    }
}

#[inline]
fn temporal_phase_f64(
    b_block: f64,
    t_local: f64,
    period_beats: Option<f32>,
    speed_hz: Option<f32>,
) -> f64 {
    if let Some(hz) = speed_hz {
        if hz > 0.0 {
            return t_local * (hz as f64);
        }
    }
    b_block / (period_beats.unwrap_or(1.0).max(1e-4) as f64)
}

#[allow(clippy::too_many_arguments)]
pub fn evaluate_curve_1d_phase(
    waveform: Waveform1D,
    base_phase_cycles: f64,
    u_i: f32,
    phase_deg: f32,
    phase_spread_deg: f32,
    duty: Option<f32>,
    amplitude: f32,
    offset: f32,
    is_bipolar_add_dimmer: bool,
) -> f32 {
    let phi = (base_phase_cycles
        + (phase_deg as f64) / 360.0
        + (u_i as f64) * ((phase_spread_deg as f64) / 360.0))
        .rem_euclid(1.0) as f32;
    let w_uni = waveform.eval_unipolar(phi, duty);
    let w = if is_bipolar_add_dimmer {
        2.0 * w_uni - 1.0
    } else {
        w_uni
    };
    offset + amplitude * w
}

#[allow(clippy::too_many_arguments)]
pub fn evaluate_curve_1d_scalar(
    waveform: Waveform1D,
    b_block: f64,
    t_local: f64,
    u_i: f32,
    rate_beats: Option<f32>,
    speed_hz: Option<f32>,
    phase_spread_deg: f32,
    duty: Option<f32>,
    amplitude: f32,
    offset: f32,
    is_bipolar_add_dimmer: bool,
) -> f32 {
    let base_phase = temporal_phase_f64(b_block, t_local, rate_beats, speed_hz);
    evaluate_curve_1d_phase(
        waveform,
        base_phase,
        u_i,
        0.0,
        phase_spread_deg,
        duty,
        amplitude,
        offset,
        is_bipolar_add_dimmer,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn evaluate_step_chase_phase(
    base_phase_cycles: f64,
    u_i: f32,
    cell_count: usize,
    active_ratio: Option<f32>,
    pixels_on: Option<u16>,
    one_way: bool,
    fade: f32,
    amplitude: f32,
) -> f32 {
    let p = base_phase_cycles.rem_euclid(1.0) as f32;
    let abs_d = if one_way {
        let phi_chase = p;
        ((u_i - phi_chase + 0.5).rem_euclid(1.0) - 0.5).abs()
    } else {
        let phi_chase = if p < 0.5 { p * 2.0 } else { (1.0 - p) * 2.0 };
        (u_i - phi_chase).abs()
    };

    let ratio = if let Some(px) = pixels_on {
        if cell_count > 0 {
            ((px.max(1) as f32) / (cell_count as f32)).clamp(1e-4, 1.0)
        } else {
            1.0
        }
    } else {
        active_ratio
            .unwrap_or(1.0 / (cell_count.max(1) as f32))
            .clamp(1e-4, 1.0)
    };
    let half_w = 0.5 * ratio;
    let ramp_w = fade.clamp(0.0, 1.0) * half_w;
    let flat_half = half_w - ramp_w;

    let window = if abs_d <= flat_half + 1e-6 {
        1.0
    } else if abs_d < half_w && ramp_w > 1e-6 {
        ((half_w - abs_d) / ramp_w).clamp(0.0, 1.0)
    } else {
        0.0
    };
    window * amplitude
}

#[allow(clippy::too_many_arguments)]
pub fn evaluate_step_chase_scalar(
    b_block: f64,
    t_local: f64,
    u_i: f32,
    cell_count: usize,
    step_beats: Option<f32>,
    speed_hz: Option<f32>,
    active_ratio: Option<f32>,
    fade: f32,
    amplitude: f32,
) -> f32 {
    let base_phase = temporal_phase_f64(b_block, t_local, step_beats, speed_hz);
    evaluate_step_chase_phase(
        base_phase,
        u_i,
        cell_count,
        active_ratio,
        None,
        true,
        fade,
        amplitude,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Shader2DKind {
    #[default]
    LinearSweep,
    RadialWave,
    Pinwheel,
    Plasma,
}

impl fmt::Display for Shader2DKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LinearSweep => write!(f, "linear_sweep"),
            Self::RadialWave => write!(f, "radial_wave"),
            Self::Pinwheel => write!(f, "pinwheel"),
            Self::Plasma => write!(f, "plasma"),
        }
    }
}

impl FromStr for Shader2DKind {
    type Err = ShowError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "linear_sweep" => Ok(Self::LinearSweep),
            "radial_wave" => Ok(Self::RadialWave),
            "pinwheel" => Ok(Self::Pinwheel),
            "plasma" => Ok(Self::Plasma),
            other => Err(ShowError::Xml(format!("invalid 2D shader '{other}'"))),
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn evaluate_spatial_shader_2d_phase(
    shader: Shader2DKind,
    norm_xy: [f32; 2],
    base_phase_cycles: f64,
    spatial_freq: f32,
    color_width: f32,
    direction_deg: f32,
    center_x: f32,
    center_y: f32,
    transform: Option<&str>,
) -> f32 {
    let tx_xy = match transform {
        Some("mirror_x") => [1.0 - norm_xy[0], norm_xy[1]],
        Some("mirror_y") => [norm_xy[0], 1.0 - norm_xy[1]],
        Some("invert") => [1.0 - norm_xy[0], 1.0 - norm_xy[1]],
        _ => norm_xy,
    };
    let phi = base_phase_cycles.rem_euclid(1.0) as f32;
    let dx = tx_xy[0] - center_x;
    let dy = tx_xy[1] - center_y;
    let k = spatial_freq / color_width.clamp(0.1, 4.0);
    let theta = direction_deg.to_radians();

    let s = match shader {
        Shader2DKind::LinearSweep => (k * (dx * theta.cos() + dy * theta.sin()) - phi).rem_euclid(1.0),
        Shader2DKind::RadialWave => {
            0.5 + 0.5 * (TAU * (k * (dx * dx + dy * dy).sqrt() - phi)).sin()
        }
        Shader2DKind::Pinwheel => {
            ((dy.atan2(dx) / TAU) * k.round().max(1.0) - phi).rem_euclid(1.0)
        }
        Shader2DKind::Plasma => {
            0.5 + 0.25
                * ((TAU * (k * tx_xy[0] + phi)).sin()
                    + (TAU * (k * tx_xy[1] - phi)).sin())
        }
    };
    s.clamp(0.0, 1.0)
}

#[allow(clippy::too_many_arguments)]
pub fn evaluate_spatial_shader_2d(
    shader: Shader2DKind,
    canvas_xy: [f32; 2],
    b_block: f64,
    t_local: f64,
    rate_beats: Option<f32>,
    speed_hz: Option<f32>,
    spatial_freq: f32,
    direction_deg: f32,
    center_x: f32,
    center_y: f32,
) -> f32 {
    let base_phase = temporal_phase_f64(b_block, t_local, rate_beats, speed_hz);
    evaluate_spatial_shader_2d_phase(
        shader,
        canvas_xy,
        base_phase,
        spatial_freq,
        1.0,
        direction_deg,
        center_x,
        center_y,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_1d_waveforms_match_exact_phases_and_bipolar_conversion() {
        // Sine: 0 -> 0.5, 0.25 -> 1.0, 0.5 -> 0.5, 0.75 -> 0.0
        assert!((Waveform1D::Sine.eval_unipolar(0.0, None) - 0.5).abs() < 1e-5);
        assert!((Waveform1D::Sine.eval_unipolar(0.25, None) - 1.0).abs() < 1e-5);
        assert!((Waveform1D::Sine.eval_unipolar(0.5, None) - 0.5).abs() < 1e-5);
        assert!((Waveform1D::Sine.eval_unipolar(0.75, None) - 0.0).abs() < 1e-5);

        // Triangle: 0 -> 0.0, 0.25 -> 0.5, 0.5 -> 1.0, 0.75 -> 0.5
        assert!((Waveform1D::Triangle.eval_unipolar(0.0, None) - 0.0).abs() < 1e-5);
        assert!((Waveform1D::Triangle.eval_unipolar(0.25, None) - 0.5).abs() < 1e-5);
        assert!((Waveform1D::Triangle.eval_unipolar(0.5, None) - 1.0).abs() < 1e-5);
        assert!((Waveform1D::Triangle.eval_unipolar(0.75, None) - 0.5).abs() < 1e-5);

        // Saw
        assert!((Waveform1D::Saw.eval_unipolar(0.0, None) - 0.0).abs() < 1e-5);
        assert!((Waveform1D::Saw.eval_unipolar(0.75, None) - 0.75).abs() < 1e-5);

        // Square & Pulse (duty 0.20)
        assert_eq!(Waveform1D::Square.eval_unipolar(0.49, None), 1.0);
        assert_eq!(Waveform1D::Square.eval_unipolar(0.50, None), 0.0);
        assert_eq!(Waveform1D::Pulse.eval_unipolar(0.19, Some(0.2)), 1.0);
        assert_eq!(Waveform1D::Pulse.eval_unipolar(0.20, Some(0.2)), 0.0);

        // Bipolar conversion: Sine at 0.25 -> 1.0 -> +1.0, at 0.75 -> 0.0 -> -1.0
        let bi_peak = evaluate_curve_1d_scalar(
            Waveform1D::Sine,
            0.25,
            0.0,
            0.0,
            Some(1.0),
            None,
            0.0,
            None,
            0.4,
            0.0,
            true,
        );
        let bi_trough = evaluate_curve_1d_scalar(
            Waveform1D::Sine,
            0.75,
            0.0,
            0.0,
            Some(1.0),
            None,
            0.0,
            None,
            0.4,
            0.0,
            true,
        );
        assert!((bi_peak - 0.4).abs() < 1e-5);
        assert!((bi_trough + 0.4).abs() < 1e-5);
    }

    #[test]
    fn curve_1d_maintains_f64_phase_precision_after_24_hours_and_distributes_phase_spread() {
        // After 24h (86400s) at 1 Hz, phase stays sharp without f32 catastrophic cancellation
        let v_at_quarter_after_24h = evaluate_curve_1d_scalar(
            Waveform1D::Sine,
            0.0,
            86_400.25,
            0.0,
            None,
            Some(1.0),
            0.0,
            None,
            1.0,
            0.0,
            false,
        );
        assert!(
            (v_at_quarter_after_24h - 1.0).abs() < 1e-4,
            "expected sine peak after 24h, got {v_at_quarter_after_24h}"
        );

        // 180 deg phase spread shifts u_i = 0.5 by +0.25 cycle: sine(0 + 0.25) = 1.0
        let v_spread = evaluate_curve_1d_scalar(
            Waveform1D::Sine,
            0.0,
            0.0,
            0.5,
            Some(1.0),
            None,
            180.0,
            None,
            1.0,
            0.0,
            false,
        );
        assert!((v_spread - 1.0).abs() < 1e-5);
    }

    #[test]
    fn step_chase_trapezoid_window_evaluates_flat_top_and_fade_ramps() {
        // phi_chase = 0.5, active_ratio = 0.4 (half_w = 0.2), fade = 0.5 (ramp_w = 0.1, flat_half = 0.1)
        let center =
            evaluate_step_chase_scalar(0.5, 0.0, 0.5, 8, Some(1.0), None, Some(0.4), 0.5, 1.0);
        let flat_edge =
            evaluate_step_chase_scalar(0.5, 0.0, 0.6, 8, Some(1.0), None, Some(0.4), 0.5, 1.0);
        let mid_ramp =
            evaluate_step_chase_scalar(0.5, 0.0, 0.65, 8, Some(1.0), None, Some(0.4), 0.5, 1.0);
        let outside =
            evaluate_step_chase_scalar(0.5, 0.0, 0.75, 8, Some(1.0), None, Some(0.4), 0.5, 1.0);

        assert!((center - 1.0).abs() < 1e-5);
        assert!((flat_edge - 1.0).abs() < 1e-5);
        assert!((mid_ramp - 0.5).abs() < 1e-5);
        assert!(outside.abs() < 1e-5);

        // Circular wrap-around at phi_chase = 0.0 and u_i = 0.95 -> distance 0.05 (inside flat_half 0.1)
        let wrapped =
            evaluate_step_chase_scalar(0.0, 0.0, 0.95, 8, Some(1.0), None, Some(0.4), 0.5, 0.8);
        assert!((wrapped - 0.8).abs() < 1e-5);
    }

    #[test]
    fn spatial_shader_2d_evaluates_all_four_closed_form_shaders_in_unit_interval() {
        for kind in [
            Shader2DKind::LinearSweep,
            Shader2DKind::RadialWave,
            Shader2DKind::Pinwheel,
            Shader2DKind::Plasma,
        ] {
            for xy in [[0.0, 0.0], [0.5, 0.5], [0.85, 0.25], [1.0, 1.0]] {
                let s = evaluate_spatial_shader_2d(
                    kind,
                    xy,
                    0.75,
                    0.3,
                    Some(2.0),
                    None,
                    1.5,
                    45.0,
                    0.5,
                    0.5,
                );
                assert!(
                    (0.0..=1.0).contains(&s),
                    "shader {kind} returned out-of-range {s} at {xy:?}"
                );
            }
        }
    }
}
