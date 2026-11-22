use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::show::spatial::{compute_order_u, OrderRule};
use crate::show::targets::TargetRef;
use crate::show::ShowError;
use crate::state::plan::{CompiledFixture, CompiledGroup, RenderPlan};

use super::color::{
    linear_rgb_to_oklab, oklab_to_linear_rgb, parse_hex_to_linear_rgb, CompiledColorPalette,
    CompiledDimmerPalette,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MergeOp {
    #[default]
    Htp,
    Ltp,
    Add,
    Scale,
}

impl fmt::Display for MergeOp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Htp => write!(f, "htp"),
            Self::Ltp => write!(f, "ltp"),
            Self::Add => write!(f, "add"),
            Self::Scale => write!(f, "scale"),
        }
    }
}

impl FromStr for MergeOp {
    type Err = ShowError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "htp" => Ok(Self::Htp),
            "ltp" => Ok(Self::Ltp),
            "add" => Ok(Self::Add),
            "scale" => Ok(Self::Scale),
            other => Err(ShowError::Xml(format!("invalid merge op '{other}'"))),
        }
    }
}

impl MergeOp {
    pub fn apply_scalar(self, current: f32, layer_val: f32, alpha: f32) -> f32 {
        let a = alpha.clamp(0.0, 1.0);
        let out = match self {
            Self::Htp => current.max(a * layer_val),
            Self::Ltp => (1.0 - a) * current + a * layer_val,
            Self::Add => current + a * layer_val,
            Self::Scale => current * (1.0 - a + a * layer_val),
        };
        out.clamp(0.0, 1.0)
    }

    pub fn apply_color(self, current: [f32; 3], layer_rgb: [f32; 3], alpha: f32) -> [f32; 3] {
        [
            self.apply_scalar(current[0], layer_rgb[0], alpha),
            self.apply_scalar(current[1], layer_rgb[1], alpha),
            self.apply_scalar(current[2], layer_rgb[2], alpha),
        ]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", content = "hz", rename_all = "snake_case")]
pub enum ShutterState {
    #[default]
    Open,
    Closed,
    StrobeHz(f32),
    RandomStrobe(f32),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct FixtureTraitDelta {
    pub master_dimmer: Option<(MergeOp, f32)>,
    pub shutter: Option<ShutterState>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CellTraitDelta {
    pub dimmer: Option<(MergeOp, f32)>,
    pub color: Option<(MergeOp, [f32; 3])>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FixtureTraitState {
    pub master_dimmer: f32,
    pub master_dimmer_touched: bool,
    pub any_cell_touched: bool,
    pub any_cell_dimmer_touched: bool,
    pub shutter: ShutterState,
    pub shutter_touched: bool,
}

impl Default for FixtureTraitState {
    fn default() -> Self {
        Self {
            master_dimmer: 0.0,
            master_dimmer_touched: false,
            any_cell_touched: false,
            any_cell_dimmer_touched: false,
            shutter: ShutterState::Open,
            shutter_touched: false,
        }
    }
}

impl FixtureTraitState {
    pub fn apply_fixture_delta(&mut self, delta: &FixtureTraitDelta, alpha: f32) {
        if let Some((op, val)) = delta.master_dimmer {
            self.master_dimmer = op.apply_scalar(self.master_dimmer, val, alpha);
            self.master_dimmer_touched = true;
        }
        if let Some(shutter_state) = delta.shutter {
            if alpha > 0.5 {
                self.shutter = shutter_state;
                self.shutter_touched = true;
            }
        }
    }

    pub fn finalize_fixture_state(&mut self, grand_master: f32, blackout: bool) {
        if !self.master_dimmer_touched && self.any_cell_dimmer_touched {
            self.master_dimmer = 1.0;
        }
        if blackout {
            self.master_dimmer = 0.0;
        } else if !self.any_cell_dimmer_touched && self.master_dimmer_touched {
            self.master_dimmer = (self.master_dimmer * grand_master.clamp(0.0, 1.0)).clamp(0.0, 1.0);
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CellTraitState {
    pub dimmer: f32,
    pub dimmer_touched: bool,
    pub color: [f32; 3],
    pub color_touched: bool,
}

impl Default for CellTraitState {
    fn default() -> Self {
        Self {
            dimmer: 0.0,
            dimmer_touched: false,
            color: [0.0, 0.0, 0.0],
            color_touched: false,
        }
    }
}

impl CellTraitState {
    pub fn apply_cell_delta(&mut self, delta: &CellTraitDelta, alpha: f32) -> bool {
        let mut touched = false;
        if let Some((op, val)) = delta.dimmer {
            self.dimmer = op.apply_scalar(self.dimmer, val, alpha);
            self.dimmer_touched = true;
            touched = true;
        }
        if let Some((op, rgb)) = delta.color {
            self.color = op.apply_color(self.color, rgb, alpha);
            self.color_touched = true;
            touched = true;
        }
        touched
    }

    pub fn finalize_cell_state_with_fixture(
        &mut self,
        fx_state: &FixtureTraitState,
        grand_master: f32,
        blackout: bool,
    ) {
        if blackout {
            self.dimmer = 0.0;
            return;
        }
        let gm = grand_master.clamp(0.0, 1.0);
        if self.dimmer_touched {
            self.dimmer = (self.dimmer * gm).clamp(0.0, 1.0);
        } else if fx_state.master_dimmer_touched
            && !fx_state.any_cell_dimmer_touched
            && fx_state.master_dimmer > 0.0
        {
            self.dimmer = 1.0;
        } else {
            self.dimmer = 0.0;
        }
    }

    pub fn finalize_cell_state(&mut self, grand_master: f32, blackout: bool) {
        self.finalize_cell_state_with_fixture(&FixtureTraitState::default(), grand_master, blackout);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "trait_kind", rename_all = "snake_case")]
pub enum SmartLayerTrait {
    Dimmer {
        op: MergeOp,
        palette_ref: Option<String>,
        value_start: f32,
        value_end: f32,
    },
    Color {
        op: MergeOp,
        palette_ref: Option<String>,
        hex_start: String,
        hex_end: String,
    },
    MasterDimmer {
        op: MergeOp,
        value: f32,
    },
    Shutter {
        state: ShutterState,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SmartControlLayer {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub priority: i32,
    pub trigger_order: u64,
    pub alpha: f32,
    pub target: String,
    pub order_override: Option<OrderRule>,
    pub trait_spec: SmartLayerTrait,
}

pub fn resolve_target_cells_and_fixtures(
    target: &str,
    order_override: Option<OrderRule>,
    fixtures: &[CompiledFixture],
    fixture_index_by_id: &HashMap<&str, usize>,
    cell_to_fixture: &[usize],
    groups: &[CompiledGroup],
    cell_count: usize,
) -> (Vec<(usize, f32)>, Vec<usize>) {
    let trimmed = target.trim();
    if trimmed.eq_ignore_ascii_case("all") || trimmed == "*" {
        let rule = order_override.unwrap_or(OrderRule::Linear);
        let cells = (0..cell_count)
            .map(|idx| (idx, compute_order_u(rule, idx, cell_count)))
            .collect();
        let fx_indices = (0..fixtures.len()).collect();
        return (cells, fx_indices);
    }

    if let Some(group) = groups.iter().find(|g| g.id == trimmed) {
        let mut cells = Vec::with_capacity(group.cells.len());
        let mut touched_fixtures = BTreeSet::new();
        let total = group.cells.len();
        for (pos, &(cell_idx, compiled_u)) in group.cells.iter().enumerate() {
            let u = match order_override {
                Some(rule) => compute_order_u(rule, pos, total),
                None => compiled_u,
            };
            if cell_idx < cell_count {
                cells.push((cell_idx, u));
                if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                    touched_fixtures.insert(fx_idx);
                }
            }
        }
        return (cells, touched_fixtures.into_iter().collect());
    }

    if let Ok(parsed) = TargetRef::from_str(trimmed) {
        if let Some(&fx_idx) = fixture_index_by_id.get(parsed.fixture_id()) {
            let fx = &fixtures[fx_idx];
            let local_indices = parsed.expand_cell_indices(fx.cell_count);
            let total = local_indices.len();
            let rule = order_override.unwrap_or(OrderRule::Linear);
            let cells = local_indices
                .into_iter()
                .enumerate()
                .filter_map(|(pos, local_idx)| {
                    let global_idx = fx.cell_start + (local_idx as usize);
                    (global_idx < cell_count)
                        .then(|| (global_idx, compute_order_u(rule, pos, total)))
                })
                .collect();
            return (cells, vec![fx_idx]);
        }
    }

    (Vec::new(), Vec::new())
}

fn sample_inline_hex_oklab_linear(hex_start: &str, hex_end: &str, u: f32) -> [f32; 3] {
    let lin_a = parse_hex_to_linear_rgb(hex_start).unwrap_or([0.0, 0.0, 0.0]);
    let lin_b = parse_hex_to_linear_rgb(hex_end).unwrap_or(lin_a);
    let lab_a = linear_rgb_to_oklab(lin_a);
    let lab_b = linear_rgb_to_oklab(lin_b);
    let t = u.clamp(0.0, 1.0);
    oklab_to_linear_rgb([
        lab_a[0] + t * (lab_b[0] - lab_a[0]),
        lab_a[1] + t * (lab_b[1] - lab_a[1]),
        lab_a[2] + t * (lab_b[2] - lab_a[2]),
    ])
}

#[allow(clippy::too_many_arguments)]
pub fn fold_layers_into_states(
    fixtures: &[CompiledFixture],
    groups: &[CompiledGroup],
    color_palettes: &[CompiledColorPalette],
    dimmer_palettes: &[CompiledDimmerPalette],
    cell_count: usize,
    layers: &[SmartControlLayer],
    fixture_states: &mut [FixtureTraitState],
    cell_states: &mut [CellTraitState],
) {
    let mut cell_to_fixture = vec![0usize; cell_count];
    let mut fixture_index_by_id: HashMap<&str, usize> = HashMap::with_capacity(fixtures.len());
    for (fx_idx, fx) in fixtures.iter().enumerate() {
        fixture_index_by_id.insert(fx.id.as_str(), fx_idx);
        let end = (fx.cell_start + fx.cell_count as usize).min(cell_count);
        for slot in &mut cell_to_fixture[fx.cell_start.min(cell_count)..end] {
            *slot = fx_idx;
        }
    }

    let color_map: HashMap<&str, &CompiledColorPalette> = color_palettes
        .iter()
        .map(|p| (p.id.as_str(), p))
        .collect();
    let dimmer_map: HashMap<&str, &CompiledDimmerPalette> = dimmer_palettes
        .iter()
        .map(|p| (p.id.as_str(), p))
        .collect();

    let mut sorted_layers: Vec<&SmartControlLayer> =
        layers.iter().filter(|l| l.enabled && l.alpha > 0.0).collect();
    sorted_layers.sort_by_key(|l| (l.priority, l.trigger_order));

    for layer in sorted_layers {
        let alpha = layer.alpha.clamp(0.0, 1.0);
        let (target_cells, target_fixtures) = resolve_target_cells_and_fixtures(
            &layer.target,
            layer.order_override,
            fixtures,
            &fixture_index_by_id,
            &cell_to_fixture,
            groups,
            cell_count,
        );

        match &layer.trait_spec {
            SmartLayerTrait::Dimmer {
                op,
                palette_ref,
                value_start,
                value_end,
            } => {
                let pal = palette_ref
                    .as_deref()
                    .and_then(|id| dimmer_map.get(id).copied());
                for (cell_idx, u) in target_cells {
                    let val = match pal {
                        Some(p) => p.sample_dimmer(u),
                        None => value_start + u.clamp(0.0, 1.0) * (value_end - value_start),
                    };
                    let delta = CellTraitDelta {
                        dimmer: Some((*op, val)),
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
            SmartLayerTrait::Color {
                op,
                palette_ref,
                hex_start,
                hex_end,
            } => {
                let pal = palette_ref
                    .as_deref()
                    .and_then(|id| color_map.get(id).copied());
                for (cell_idx, u) in target_cells {
                    let rgb = match pal {
                        Some(p) => p.sample_linear_rgb(u),
                        None => sample_inline_hex_oklab_linear(hex_start, hex_end, u),
                    };
                    let delta = CellTraitDelta {
                        dimmer: None,
                        color: Some((*op, rgb)),
                    };
                    if cell_states[cell_idx].apply_cell_delta(&delta, alpha) {
                        if let Some(&fx_idx) = cell_to_fixture.get(cell_idx) {
                            fixture_states[fx_idx].any_cell_touched = true;
                        }
                    }
                }
            }
            SmartLayerTrait::MasterDimmer { op, value } => {
                let delta = FixtureTraitDelta {
                    master_dimmer: Some((*op, *value)),
                    shutter: None,
                };
                for fx_idx in target_fixtures {
                    fixture_states[fx_idx].apply_fixture_delta(&delta, alpha);
                }
            }
            SmartLayerTrait::Shutter { state } => {
                let delta = FixtureTraitDelta {
                    master_dimmer: None,
                    shutter: Some(*state),
                };
                for fx_idx in target_fixtures {
                    fixture_states[fx_idx].apply_fixture_delta(&delta, alpha);
                }
            }
        }
    }
}

pub fn evaluate_layer_stack_inputs(
    fixtures: &[CompiledFixture],
    groups: &[CompiledGroup],
    color_palettes: &[CompiledColorPalette],
    dimmer_palettes: &[CompiledDimmerPalette],
    cell_count: usize,
    layers: &[SmartControlLayer],
    grand_master: f32,
    blackout: bool,
) -> (Vec<FixtureTraitState>, Vec<CellTraitState>) {
    let mut fixture_states = vec![FixtureTraitState::default(); fixtures.len()];
    let mut cell_states = vec![CellTraitState::default(); cell_count];

    fold_layers_into_states(
        fixtures,
        groups,
        color_palettes,
        dimmer_palettes,
        cell_count,
        layers,
        &mut fixture_states,
        &mut cell_states,
    );

    for fx_state in &mut fixture_states {
        fx_state.finalize_fixture_state(grand_master, blackout);
    }
    let mut cell_to_fixture = vec![0usize; cell_count];
    for (fx_idx, fx) in fixtures.iter().enumerate() {
        let end = (fx.cell_start + fx.cell_count as usize).min(cell_count);
        for slot in &mut cell_to_fixture[fx.cell_start.min(cell_count)..end] {
            *slot = fx_idx;
        }
    }
    for (cell_idx, cell_state) in cell_states.iter_mut().enumerate() {
        let fx_state = cell_to_fixture
            .get(cell_idx)
            .and_then(|&fx_idx| fixture_states.get(fx_idx));
        match fx_state {
            Some(fs) => cell_state.finalize_cell_state_with_fixture(fs, grand_master, blackout),
            None => cell_state.finalize_cell_state(grand_master, blackout),
        }
    }

    (fixture_states, cell_states)
}

pub fn evaluate_layer_stack(
    plan: &RenderPlan,
    layers: &[SmartControlLayer],
    grand_master: f32,
    blackout: bool,
) -> (Vec<FixtureTraitState>, Vec<CellTraitState>) {
    evaluate_layer_stack_inputs(
        &plan.fixtures,
        &plan.groups,
        &plan.color_palettes,
        &plan.dimmer_palettes,
        plan.cell_count as usize,
        layers,
        grand_master,
        blackout,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::show::patch::FixtureCalibration;
    use crate::show::xml::{ColorPaletteDef, DimmerPaletteDef};

    fn dummy_fixture(id: &str, cell_start: usize, cell_count: u16) -> CompiledFixture {
        CompiledFixture {
            id: id.to_string(),
            name: id.to_string(),
            profile: "test".to_string(),
            mode: "test".to_string(),
            calibration: FixtureCalibration::default(),
            cell_start,
            cell_count,
            channels: Vec::new(),
        }
    }

    #[test]
    fn merge_ops_htp_ltp_add_and_scale_respect_alpha_and_clamp() {
        assert!((MergeOp::Htp.apply_scalar(0.3, 0.8, 0.5) - 0.4).abs() < 1e-6);
        assert!((MergeOp::Htp.apply_scalar(0.6, 0.8, 0.5) - 0.6).abs() < 1e-6);

        // LTP crossfade: (1 - alpha) * cur + alpha * layer
        assert!((MergeOp::Ltp.apply_scalar(0.2, 0.8, 0.25) - 0.35).abs() < 1e-6);

        // Add bipolar pulse + clamping
        assert!((MergeOp::Add.apply_scalar(0.7, -0.4, 0.5) - 0.5).abs() < 1e-6);
        assert!((MergeOp::Add.apply_scalar(0.9, 0.5, 1.0) - 1.0).abs() < 1e-6);
        assert!((MergeOp::Add.apply_scalar(0.1, -0.5, 1.0) - 0.0).abs() < 1e-6);

        // Scale multiplicative mask
        assert!((MergeOp::Scale.apply_scalar(0.8, 0.5, 0.5) - 0.6).abs() < 1e-6);
    }

    #[test]
    fn master_dimmer_falls_back_to_one_when_untouched_and_folds_from_zero_when_targeted() {
        let mut untouched = FixtureTraitState::default();
        untouched.any_cell_touched = true;
        untouched.any_cell_dimmer_touched = true;
        untouched.finalize_fixture_state(0.5, false);
        assert!((untouched.master_dimmer - 1.0).abs() < 1e-6);

        let mut targeted = FixtureTraitState::default();
        targeted.any_cell_touched = true;
        targeted.any_cell_dimmer_touched = true;
        targeted.apply_fixture_delta(
            &FixtureTraitDelta {
                master_dimmer: Some((MergeOp::Ltp, 0.4)),
                shutter: None,
            },
            1.0,
        );
        targeted.finalize_fixture_state(0.5, false);
        assert!((targeted.master_dimmer - 0.4).abs() < 1e-6);

        let mut master_only = FixtureTraitState::default();
        master_only.apply_fixture_delta(
            &FixtureTraitDelta {
                master_dimmer: Some((MergeOp::Htp, 0.8)),
                shutter: None,
            },
            1.0,
        );
        master_only.finalize_fixture_state(0.5, false);
        assert!((master_only.master_dimmer - 0.4).abs() < 1e-6);

        // Strict A2: color-only without dimmer leaves master_dimmer and cell.dimmer at 0.0
        let mut color_only_fx = FixtureTraitState::default();
        color_only_fx.any_cell_touched = true;
        color_only_fx.finalize_fixture_state(1.0, false);
        assert_eq!(color_only_fx.master_dimmer, 0.0);

        let mut color_only_cell = CellTraitState {
            dimmer: 0.0,
            dimmer_touched: false,
            color: [1.0, 0.0, 0.0],
            color_touched: true,
        };
        color_only_cell.finalize_cell_state_with_fixture(&color_only_fx, 1.0, false);
        assert_eq!(color_only_cell.dimmer, 0.0);

        // Raising master_only + cell color sets cell.dimmer = 1.0 without double-applying grand_master
        let mut color_with_master_cell = CellTraitState {
            dimmer: 0.0,
            dimmer_touched: false,
            color: [1.0, 0.0, 0.0],
            color_touched: true,
        };
        color_with_master_cell.finalize_cell_state_with_fixture(&master_only, 0.5, false);
        assert!((color_with_master_cell.dimmer - 1.0).abs() < 1e-6);

        // Segment dimmer only keeps cell.color at [0, 0, 0] (no implied white mix)
        let mut dim_only_cell = CellTraitState {
            dimmer: 0.6,
            dimmer_touched: true,
            color: [0.0, 0.0, 0.0],
            color_touched: false,
        };
        dim_only_cell.finalize_cell_state_with_fixture(&untouched, 0.5, false);
        assert!((dim_only_cell.dimmer - 0.3).abs() < 1e-6);
        assert_eq!(dim_only_cell.color, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn shutter_none_does_not_clobber_lower_layer_strobe_and_topmost_above_half_alpha_wins() {
        let mut st = FixtureTraitState::default();
        st.apply_fixture_delta(
            &FixtureTraitDelta {
                master_dimmer: None,
                shutter: Some(ShutterState::StrobeHz(5.0)),
            },
            1.0,
        );
        // Dimmer overlay with shutter: None does not clobber strobe
        st.apply_fixture_delta(
            &FixtureTraitDelta {
                master_dimmer: Some((MergeOp::Htp, 1.0)),
                shutter: None,
            },
            1.0,
        );
        assert_eq!(st.shutter, ShutterState::StrobeHz(5.0));

        // Shutter fade with alpha <= 0.5 ignored; > 0.5 wins
        st.apply_fixture_delta(
            &FixtureTraitDelta {
                master_dimmer: None,
                shutter: Some(ShutterState::Closed),
            },
            0.5,
        );
        assert_eq!(st.shutter, ShutterState::StrobeHz(5.0));

        st.apply_fixture_delta(
            &FixtureTraitDelta {
                master_dimmer: None,
                shutter: Some(ShutterState::StrobeHz(10.0)),
            },
            0.6,
        );
        assert_eq!(st.shutter, ShutterState::StrobeHz(10.0));
    }

    #[test]
    fn layer_stack_sorts_by_priority_then_trigger_order_and_applies_grand_master_and_blackout() {
        let fixtures = vec![dummy_fixture("fx_1", 0, 4)];
        let groups = vec![CompiledGroup {
            id: "grp_1".to_string(),
            name: "Group 1".to_string(),
            order: OrderRule::Linear,
            cells: vec![(0, 0.0), (1, 1.0 / 3.0), (2, 2.0 / 3.0), (3, 1.0)],
        }];
        let color_palettes = vec![CompiledColorPalette::from_def(&ColorPaletteDef {
            id: "pal_c".into(),
            name: "Cyber".into(),
            hex_start: "#FF0000".into(),
            hex_end: "#0000FF".into(),
            colors: Vec::new(),
        })];
        let dimmer_palettes = vec![CompiledDimmerPalette::from_def(&DimmerPaletteDef {
            id: "dim_h".into(),
            name: "Half".into(),
            value_start: 0.6,
            value_end: 0.6,
        })];

        let layers = vec![
            // Higher priority should run AFTER lower priority even if placed earlier in slice
            SmartControlLayer {
                id: "l_top".into(),
                name: "Override Green".into(),
                enabled: true,
                priority: 10,
                trigger_order: 1,
                alpha: 1.0,
                target: "fx_1:0..1".into(),
                order_override: None,
                trait_spec: SmartLayerTrait::Color {
                    op: MergeOp::Ltp,
                    palette_ref: None,
                    hex_start: "#00FF00".into(),
                    hex_end: "#00FF00".into(),
                },
            },
            SmartControlLayer {
                id: "l_base_color".into(),
                name: "Base Color".into(),
                enabled: true,
                priority: 1,
                trigger_order: 1,
                alpha: 1.0,
                target: "grp_1".into(),
                order_override: None,
                trait_spec: SmartLayerTrait::Color {
                    op: MergeOp::Ltp,
                    palette_ref: Some("pal_c".into()),
                    hex_start: "#000000".into(),
                    hex_end: "#000000".into(),
                },
            },
            SmartControlLayer {
                id: "l_dim".into(),
                name: "Dimmer".into(),
                enabled: true,
                priority: 1,
                trigger_order: 2,
                alpha: 1.0,
                target: "grp_1".into(),
                order_override: None,
                trait_spec: SmartLayerTrait::Dimmer {
                    op: MergeOp::Htp,
                    palette_ref: Some("dim_h".into()),
                    value_start: 0.0,
                    value_end: 0.0,
                },
            },
        ];

        let (fx_states, cell_states) = evaluate_layer_stack_inputs(
            &fixtures,
            &groups,
            &color_palettes,
            &dimmer_palettes,
            4,
            &layers,
            0.5,
            false,
        );
        assert!((fx_states[0].master_dimmer - 1.0).abs() < 1e-6);
        // Cell dimmer = 0.6 * 0.5 grand_master = 0.3
        assert!((cell_states[0].dimmer - 0.3).abs() < 1e-6);
        // Cell 0 & 1 overridden to pure green (#00FF00), cell 3 pure blue (#0000FF)
        assert!(cell_states[0].color[1] > 0.99);
        assert!(cell_states[3].color[2] > 0.99);

        let (fx_bo, cell_bo) = evaluate_layer_stack_inputs(
            &fixtures,
            &groups,
            &color_palettes,
            &dimmer_palettes,
            4,
            &layers,
            0.5,
            true,
        );
        assert_eq!(fx_bo[0].master_dimmer, 0.0);
        assert_eq!(cell_bo[0].dimmer, 0.0);
    }
}
