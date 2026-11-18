use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use super::ShowError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OrderRule {
    #[default]
    Linear,
    Reverse,
    CenterOut,
    Mirror,
    OddEven,
    Blocks(u16),
}

impl fmt::Display for OrderRule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Linear => write!(f, "linear"),
            Self::Reverse => write!(f, "reverse"),
            Self::CenterOut => write!(f, "center_out"),
            Self::Mirror => write!(f, "mirror"),
            Self::OddEven => write!(f, "odd_even"),
            Self::Blocks(k) => write!(f, "blocks({k})"),
        }
    }
}

impl FromStr for OrderRule {
    type Err = ShowError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let trimmed = s.trim();
        match trimmed {
            "linear" => Ok(Self::Linear),
            "reverse" => Ok(Self::Reverse),
            "center_out" => Ok(Self::CenterOut),
            "mirror" => Ok(Self::Mirror),
            "odd_even" => Ok(Self::OddEven),
            other => {
                if let Some(inner) = other
                    .strip_prefix("blocks(")
                    .and_then(|rest| rest.strip_suffix(')'))
                {
                    let k: u16 = inner
                        .trim()
                        .parse()
                        .map_err(|_| ShowError::InvalidOrderRule(trimmed.to_string()))?;
                    if k >= 1 {
                        return Ok(Self::Blocks(k));
                    }
                }
                Err(ShowError::InvalidOrderRule(trimmed.to_string()))
            }
        }
    }
}

pub fn compute_order_u(rule: OrderRule, index: usize, count: usize) -> f32 {
    if count <= 1 || index >= count {
        return 0.0;
    }

    let i = index as f32;
    let max_idx = (count - 1) as f32;
    let c = max_idx / 2.0;

    match rule {
        OrderRule::Linear => i / max_idx,
        OrderRule::Reverse => 1.0 - (i / max_idx),
        OrderRule::CenterOut => (i - c).abs() / c,
        OrderRule::Mirror => 1.0 - ((i - c).abs() / c),
        OrderRule::OddEven => (index % 2) as f32,
        OrderRule::Blocks(k) => {
            let k = (k.max(1)) as usize;
            let num_blocks = count.div_ceil(k);
            if num_blocks <= 1 {
                0.0
            } else {
                (index / k) as f32 / (num_blocks - 1) as f32
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GridPos {
    pub x: f32,
    pub y: f32,
    pub rotation: f32,
    pub scale_x: f32,
    pub scale_y: f32,
}

impl Default for GridPos {
    fn default() -> Self {
        Self {
            x: 0.5,
            y: 0.5,
            rotation: 0.0,
            scale_x: 0.30,
            scale_y: 0.05,
        }
    }
}

impl GridPos {
    pub fn transform_cell_uv(&self, local_uv: [f32; 2]) -> [f32; 2] {
        let sx = local_uv[0] * self.scale_x;
        let sy = local_uv[1] * self.scale_y;
        let (sin_r, cos_r) = self.rotation.to_radians().sin_cos();
        let rx = sx * cos_r - sy * sin_r;
        let ry = sx * sin_r + sy * cos_r;
        [(self.x + rx).clamp(0.0, 1.0), (self.y + ry).clamp(0.0, 1.0)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_rule_parses_and_formats_all_variants() {
        for (txt, expected) in [
            ("linear", OrderRule::Linear),
            ("reverse", OrderRule::Reverse),
            ("center_out", OrderRule::CenterOut),
            ("mirror", OrderRule::Mirror),
            ("odd_even", OrderRule::OddEven),
            ("blocks(4)", OrderRule::Blocks(4)),
        ] {
            let parsed: OrderRule = txt.parse().unwrap();
            assert_eq!(parsed, expected);
            assert_eq!(parsed.to_string(), txt);
        }
        assert!("blocks(0)".parse::<OrderRule>().is_err());
        assert!("bogus".parse::<OrderRule>().is_err());
    }

    #[test]
    fn compute_order_u_matches_architecture_formulas_for_n1_odd_and_even() {
        for rule in [
            OrderRule::Linear,
            OrderRule::Reverse,
            OrderRule::CenterOut,
            OrderRule::Mirror,
            OrderRule::OddEven,
            OrderRule::Blocks(2),
        ] {
            assert_eq!(compute_order_u(rule, 0, 1), 0.0);
        }

        let lin4: Vec<f32> = (0..4)
            .map(|i| compute_order_u(OrderRule::Linear, i, 4))
            .collect();
        assert!((lin4[0] - 0.0).abs() < 1e-5);
        assert!((lin4[1] - 1.0 / 3.0).abs() < 1e-5);
        assert!((lin4[3] - 1.0).abs() < 1e-5);

        let rev4: Vec<f32> = (0..4)
            .map(|i| compute_order_u(OrderRule::Reverse, i, 4))
            .collect();
        assert!((rev4[0] - 1.0).abs() < 1e-5);
        assert!((rev4[3] - 0.0).abs() < 1e-5);

        let co5: Vec<f32> = (0..5)
            .map(|i| compute_order_u(OrderRule::CenterOut, i, 5))
            .collect();
        assert!((co5[0] - 1.0).abs() < 1e-5);
        assert!((co5[1] - 0.5).abs() < 1e-5);
        assert!((co5[2] - 0.0).abs() < 1e-5);
        assert!((co5[3] - 0.5).abs() < 1e-5);
        assert!((co5[4] - 1.0).abs() < 1e-5);

        let mir5: Vec<f32> = (0..5)
            .map(|i| compute_order_u(OrderRule::Mirror, i, 5))
            .collect();
        assert!((mir5[0] - 0.0).abs() < 1e-5);
        assert!((mir5[2] - 1.0).abs() < 1e-5);

        assert_eq!(compute_order_u(OrderRule::OddEven, 0, 4), 0.0);
        assert_eq!(compute_order_u(OrderRule::OddEven, 1, 4), 1.0);
        assert_eq!(compute_order_u(OrderRule::OddEven, 2, 4), 0.0);

        let blk6: Vec<f32> = (0..6)
            .map(|i| compute_order_u(OrderRule::Blocks(2), i, 6))
            .collect();
        assert!((blk6[0] - 0.0).abs() < 1e-5);
        assert!((blk6[1] - 0.0).abs() < 1e-5);
        assert!((blk6[2] - 0.5).abs() < 1e-5);
        assert!((blk6[4] - 1.0).abs() < 1e-5);
    }

    #[test]
    fn grid_pos_applies_scale_rotation_translation_and_clamps_to_unit_square() {
        let gp0 = GridPos {
            x: 0.5,
            y: 0.25,
            rotation: 0.0,
            scale_x: 0.4,
            scale_y: 0.2,
        };
        let p_right = gp0.transform_cell_uv([0.5, 0.0]);
        assert!((p_right[0] - 0.7).abs() < 1e-5);
        assert!((p_right[1] - 0.25).abs() < 1e-5);

        let gp90 = GridPos {
            x: 0.5,
            y: 0.5,
            rotation: 90.0,
            scale_x: 0.4,
            scale_y: 0.2,
        };
        let p90 = gp90.transform_cell_uv([0.5, 0.0]);
        assert!((p90[0] - 0.5).abs() < 1e-5);
        assert!((p90[1] - 0.7).abs() < 1e-5);

        let gp180 = GridPos {
            x: 0.5,
            y: 0.5,
            rotation: 180.0,
            scale_x: 0.4,
            scale_y: 0.2,
        };
        let p180 = gp180.transform_cell_uv([0.5, 0.0]);
        assert!((p180[0] - 0.3).abs() < 1e-5);
        assert!((p180[1] - 0.5).abs() < 1e-5);
    }
}
