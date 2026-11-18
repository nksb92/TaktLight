use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::state::plan::UniverseConfig;

use super::patch::{
    validate_patch_no_collisions, FixtureCalibration, FixtureInstance,
};
use super::spatial::GridPos;
use super::xml::{
    serialize_show_xml, ColorPaletteDef, DimmerPaletteDef, FixtureGroupDef, FxBlockDef, SceneDef,
    ShowState,
};
use super::ShowError;

pub const DEFAULT_MAX_UNDO_ENTRIES: usize = 500;
pub const AUTOSAVE_REVISION_INTERVAL: u64 = 20;
pub const AUTOSAVE_TIME_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq)]
pub enum ShowCommand {
    PatchFixtures {
        added: Vec<FixtureInstance>,
        auto_created_universes: Vec<UniverseConfig>,
    },
    UnpatchFixture {
        removed: FixtureInstance,
    },
    MoveFixturePatch {
        fixture_id: String,
        before_universe: u16,
        before_address: u16,
        after_universe: u16,
        after_address: u16,
        auto_created_universes: Vec<UniverseConfig>,
    },
    UpdateFixtureGridPos {
        fixture_id: String,
        before: GridPos,
        after: GridPos,
        coalesce_key: Option<String>,
    },
    UpdateFixtureCalibration {
        fixture_id: String,
        before: FixtureCalibration,
        after: FixtureCalibration,
        coalesce_key: Option<String>,
    },
    ConfigureUniverse {
        before: Option<UniverseConfig>,
        after: UniverseConfig,
    },
    UpsertGroup {
        before: Option<FixtureGroupDef>,
        after: FixtureGroupDef,
    },
    DeleteGroup {
        removed: FixtureGroupDef,
    },
    UpsertColorPalette {
        before: Option<ColorPaletteDef>,
        after: ColorPaletteDef,
    },
    DeleteColorPalette {
        removed: ColorPaletteDef,
    },
    UpsertDimmerPalette {
        before: Option<DimmerPaletteDef>,
        after: DimmerPaletteDef,
    },
    DeleteDimmerPalette {
        removed: DimmerPaletteDef,
    },
    UpsertFxBlock {
        before: Option<FxBlockDef>,
        after: FxBlockDef,
    },
    DeleteFxBlock {
        removed: FxBlockDef,
    },
    UpsertScene {
        before: Option<SceneDef>,
        after: SceneDef,
    },
    DeleteScene {
        removed: SceneDef,
    },
    ReplaceShowState {
        before: Box<ShowState>,
        after: Box<ShowState>,
    },
}

impl ShowCommand {
    pub fn coalesce_key(&self) -> Option<&str> {
        match self {
            Self::UpdateFixtureGridPos { coalesce_key, .. }
            | Self::UpdateFixtureCalibration { coalesce_key, .. } => coalesce_key.as_deref(),
            _ => None,
        }
    }

    pub fn try_merge(&mut self, newer: ShowCommand) -> bool {
        let Some(k1) = self.coalesce_key() else {
            return false;
        };
        let Some(k2) = newer.coalesce_key() else {
            return false;
        };
        if k1 != k2 {
            return false;
        }

        match (self, newer) {
            (
                Self::UpdateFixtureGridPos {
                    fixture_id: id1,
                    after: a1,
                    ..
                },
                Self::UpdateFixtureGridPos {
                    fixture_id: id2,
                    after: a2,
                    ..
                },
            ) if *id1 == id2 => {
                *a1 = a2;
                true
            }
            (
                Self::UpdateFixtureCalibration {
                    fixture_id: id1,
                    after: a1,
                    ..
                },
                Self::UpdateFixtureCalibration {
                    fixture_id: id2,
                    after: a2,
                    ..
                },
            ) if *id1 == id2 => {
                *a1 = a2;
                true
            }
            _ => false,
        }
    }

    pub fn apply(&self, state: &mut ShowState) -> Result<(), ShowError> {
        match self {
            Self::PatchFixtures {
                added,
                auto_created_universes,
            } => {
                for u in auto_created_universes {
                    if !state.network_outputs.universes.iter().any(|e| e.id == u.id) {
                        state.network_outputs.universes.push(u.clone());
                    }
                }
                state.network_outputs.universes.sort_by_key(|u| u.id);

                for inst in added {
                    if state.patch.iter().any(|f| f.id == inst.id) {
                        return Err(ShowError::DuplicateFixtureId(inst.id.clone()));
                    }
                    state.patch.push(inst.clone());
                }
                validate_patch_no_collisions(&state.patch)?;
                Ok(())
            }
            Self::UnpatchFixture { removed } => {
                let before_len = state.patch.len();
                state.patch.retain(|f| f.id != removed.id);
                if state.patch.len() == before_len {
                    return Err(ShowError::FixtureNotFound(removed.id.clone()));
                }
                Ok(())
            }
            Self::MoveFixturePatch {
                fixture_id,
                after_universe,
                after_address,
                auto_created_universes,
                ..
            } => {
                for u in auto_created_universes {
                    if !state.network_outputs.universes.iter().any(|e| e.id == u.id) {
                        state.network_outputs.universes.push(u.clone());
                    }
                }
                state.network_outputs.universes.sort_by_key(|u| u.id);

                let fx = state
                    .patch
                    .iter_mut()
                    .find(|f| f.id == *fixture_id)
                    .ok_or_else(|| ShowError::FixtureNotFound(fixture_id.clone()))?;
                fx.universe = *after_universe;
                fx.address = *after_address;
                validate_patch_no_collisions(&state.patch)?;
                Ok(())
            }
            Self::UpdateFixtureGridPos {
                fixture_id, after, ..
            } => {
                let fx = state
                    .patch
                    .iter_mut()
                    .find(|f| f.id == *fixture_id)
                    .ok_or_else(|| ShowError::FixtureNotFound(fixture_id.clone()))?;
                fx.grid_pos = *after;
                Ok(())
            }
            Self::UpdateFixtureCalibration {
                fixture_id, after, ..
            } => {
                let fx = state
                    .patch
                    .iter_mut()
                    .find(|f| f.id == *fixture_id)
                    .ok_or_else(|| ShowError::FixtureNotFound(fixture_id.clone()))?;
                fx.calibration = *after;
                Ok(())
            }
            Self::ConfigureUniverse { after, .. } => {
                if let Some(existing) = state
                    .network_outputs
                    .universes
                    .iter_mut()
                    .find(|u| u.id == after.id)
                {
                    *existing = after.clone();
                } else {
                    state.network_outputs.universes.push(after.clone());
                    state.network_outputs.universes.sort_by_key(|u| u.id);
                }
                Ok(())
            }
            Self::UpsertGroup { after, .. } => {
                if let Some(existing) = state.groups.iter_mut().find(|g| g.id == after.id) {
                    *existing = after.clone();
                } else {
                    state.groups.push(after.clone());
                }
                Ok(())
            }
            Self::DeleteGroup { removed } => {
                state.groups.retain(|g| g.id != removed.id);
                Ok(())
            }
            Self::UpsertColorPalette { after, .. } => {
                if let Some(existing) = state.color_palettes.iter_mut().find(|p| p.id == after.id) {
                    *existing = after.clone();
                } else {
                    state.color_palettes.push(after.clone());
                }
                Ok(())
            }
            Self::DeleteColorPalette { removed } => {
                state.color_palettes.retain(|p| p.id != removed.id);
                Ok(())
            }
            Self::UpsertDimmerPalette { after, .. } => {
                if let Some(existing) = state.dimmer_palettes.iter_mut().find(|p| p.id == after.id) {
                    *existing = after.clone();
                } else {
                    state.dimmer_palettes.push(after.clone());
                }
                Ok(())
            }
            Self::DeleteDimmerPalette { removed } => {
                state.dimmer_palettes.retain(|p| p.id != removed.id);
                Ok(())
            }
            Self::UpsertFxBlock { after, .. } => {
                if let Some(existing) = state.fx_library.iter_mut().find(|b| b.id == after.id) {
                    *existing = after.clone();
                } else {
                    state.fx_library.push(after.clone());
                }
                Ok(())
            }
            Self::DeleteFxBlock { removed } => {
                state.fx_library.retain(|b| b.id != removed.id);
                Ok(())
            }
            Self::UpsertScene { after, .. } => {
                if let Some(existing) = state.scenes.iter_mut().find(|s| s.id == after.id) {
                    *existing = after.clone();
                } else {
                    state.scenes.push(after.clone());
                }
                Ok(())
            }
            Self::DeleteScene { removed } => {
                state.scenes.retain(|s| s.id != removed.id);
                Ok(())
            }
            Self::ReplaceShowState { after, .. } => {
                *state = (**after).clone();
                Ok(())
            }
        }
    }

    pub fn revert(&self, state: &mut ShowState) -> Result<(), ShowError> {
        match self {
            Self::PatchFixtures {
                added,
                auto_created_universes,
            } => {
                for inst in added {
                    state.patch.retain(|f| f.id != inst.id);
                }
                for u in auto_created_universes {
                    state.network_outputs.universes.retain(|e| e.id != u.id);
                }
                Ok(())
            }
            Self::UnpatchFixture { removed } => {
                state.patch.push(removed.clone());
                validate_patch_no_collisions(&state.patch)?;
                Ok(())
            }
            Self::MoveFixturePatch {
                fixture_id,
                before_universe,
                before_address,
                auto_created_universes,
                ..
            } => {
                let fx = state
                    .patch
                    .iter_mut()
                    .find(|f| f.id == *fixture_id)
                    .ok_or_else(|| ShowError::FixtureNotFound(fixture_id.clone()))?;
                fx.universe = *before_universe;
                fx.address = *before_address;
                for u in auto_created_universes {
                    state.network_outputs.universes.retain(|e| e.id != u.id);
                }
                validate_patch_no_collisions(&state.patch)?;
                Ok(())
            }
            Self::UpdateFixtureGridPos {
                fixture_id, before, ..
            } => {
                let fx = state
                    .patch
                    .iter_mut()
                    .find(|f| f.id == *fixture_id)
                    .ok_or_else(|| ShowError::FixtureNotFound(fixture_id.clone()))?;
                fx.grid_pos = *before;
                Ok(())
            }
            Self::UpdateFixtureCalibration {
                fixture_id, before, ..
            } => {
                let fx = state
                    .patch
                    .iter_mut()
                    .find(|f| f.id == *fixture_id)
                    .ok_or_else(|| ShowError::FixtureNotFound(fixture_id.clone()))?;
                fx.calibration = *before;
                Ok(())
            }
            Self::ConfigureUniverse { before, after } => {
                if let Some(prev) = before {
                    if let Some(existing) = state
                        .network_outputs
                        .universes
                        .iter_mut()
                        .find(|u| u.id == prev.id)
                    {
                        *existing = prev.clone();
                    }
                } else {
                    state.network_outputs.universes.retain(|u| u.id != after.id);
                }
                Ok(())
            }
            Self::UpsertGroup { before, after } => {
                if let Some(prev) = before {
                    if let Some(existing) = state.groups.iter_mut().find(|g| g.id == prev.id) {
                        *existing = prev.clone();
                    }
                } else {
                    state.groups.retain(|g| g.id != after.id);
                }
                Ok(())
            }
            Self::DeleteGroup { removed } => {
                state.groups.push(removed.clone());
                Ok(())
            }
            Self::UpsertColorPalette { before, after } => {
                if let Some(prev) = before {
                    if let Some(existing) = state.color_palettes.iter_mut().find(|p| p.id == prev.id)
                    {
                        *existing = prev.clone();
                    }
                } else {
                    state.color_palettes.retain(|p| p.id != after.id);
                }
                Ok(())
            }
            Self::DeleteColorPalette { removed } => {
                state.color_palettes.push(removed.clone());
                Ok(())
            }
            Self::UpsertDimmerPalette { before, after } => {
                if let Some(prev) = before {
                    if let Some(existing) =
                        state.dimmer_palettes.iter_mut().find(|p| p.id == prev.id)
                    {
                        *existing = prev.clone();
                    }
                } else {
                    state.dimmer_palettes.retain(|p| p.id != after.id);
                }
                Ok(())
            }
            Self::DeleteDimmerPalette { removed } => {
                state.dimmer_palettes.push(removed.clone());
                Ok(())
            }
            Self::UpsertFxBlock { before, after } => {
                if let Some(prev) = before {
                    if let Some(existing) = state.fx_library.iter_mut().find(|b| b.id == prev.id) {
                        *existing = prev.clone();
                    }
                } else {
                    state.fx_library.retain(|b| b.id != after.id);
                }
                Ok(())
            }
            Self::DeleteFxBlock { removed } => {
                state.fx_library.push(removed.clone());
                Ok(())
            }
            Self::UpsertScene { before, after } => {
                if let Some(prev) = before {
                    if let Some(existing) = state.scenes.iter_mut().find(|s| s.id == prev.id) {
                        *existing = prev.clone();
                    }
                } else {
                    state.scenes.retain(|s| s.id != after.id);
                }
                Ok(())
            }
            Self::DeleteScene { removed } => {
                state.scenes.push(removed.clone());
                Ok(())
            }
            Self::ReplaceShowState { before, .. } => {
                *state = (**before).clone();
                Ok(())
            }
        }
    }
}

#[derive(Debug)]
pub struct UndoHistory {
    revision: u64,
    max_entries: usize,
    undo_stack: VecDeque<ShowCommand>,
    redo_stack: Vec<ShowCommand>,
}

impl Default for UndoHistory {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_UNDO_ENTRIES)
    }
}

impl UndoHistory {
    pub fn new(max_entries: usize) -> Self {
        Self {
            revision: 1,
            max_entries: max_entries.max(1),
            undo_stack: VecDeque::new(),
            redo_stack: Vec::new(),
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    pub fn undo_len(&self) -> usize {
        self.undo_stack.len()
    }

    pub fn execute(
        &mut self,
        state: &mut ShowState,
        cmd: ShowCommand,
    ) -> Result<u64, ShowError> {
        let mut next_state = state.clone();
        cmd.apply(&mut next_state)?;
        *state = next_state;

        self.redo_stack.clear();
        self.revision += 1;

        if let Some(top) = self.undo_stack.back_mut() {
            if top.try_merge(cmd.clone()) {
                return Ok(self.revision);
            }
        }

        if self.undo_stack.len() >= self.max_entries {
            self.undo_stack.pop_front();
        }
        self.undo_stack.push_back(cmd);
        Ok(self.revision)
    }

    pub fn undo(&mut self, state: &mut ShowState) -> Result<Option<u64>, ShowError> {
        let Some(cmd) = self.undo_stack.pop_back() else {
            return Ok(None);
        };
        let mut next_state = state.clone();
        if let Err(err) = cmd.revert(&mut next_state) {
            self.undo_stack.push_back(cmd);
            return Err(err);
        }
        *state = next_state;
        self.redo_stack.push(cmd);
        self.revision += 1;
        Ok(Some(self.revision))
    }

    pub fn redo(&mut self, state: &mut ShowState) -> Result<Option<u64>, ShowError> {
        let Some(cmd) = self.redo_stack.pop() else {
            return Ok(None);
        };
        let mut next_state = state.clone();
        if let Err(err) = cmd.apply(&mut next_state) {
            self.redo_stack.push(cmd);
            return Err(err);
        }
        *state = next_state;
        self.undo_stack.push_back(cmd);
        self.revision += 1;
        Ok(Some(self.revision))
    }
}

#[derive(Debug)]
pub struct AutosaveManager {
    dirty_revisions: u64,
    last_autosave: Instant,
}

impl Default for AutosaveManager {
    fn default() -> Self {
        Self::new(Instant::now())
    }
}

impl AutosaveManager {
    pub fn new(now: Instant) -> Self {
        Self {
            dirty_revisions: 0,
            last_autosave: now,
        }
    }

    pub fn record_dirty_revision(&mut self) {
        self.dirty_revisions += 1;
    }

    pub fn reset_clean(&mut self, now: Instant) {
        self.dirty_revisions = 0;
        self.last_autosave = now;
    }

    pub fn autosave_path(show_path: &Path) -> PathBuf {
        let mut os_str = show_path.as_os_str().to_os_string();
        os_str.push(".autosave");
        PathBuf::from(os_str)
    }

    pub fn should_autosave(&self, now: Instant) -> bool {
        self.dirty_revisions >= AUTOSAVE_REVISION_INTERVAL
            || (self.dirty_revisions > 0 && now.duration_since(self.last_autosave) >= AUTOSAVE_TIME_INTERVAL)
    }

    pub fn write_autosave(
        &mut self,
        show_path: &Path,
        show: &ShowState,
        now: Instant,
    ) -> Result<PathBuf, ShowError> {
        let xml = serialize_show_xml(show)?;
        let path = Self::autosave_path(show_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, xml)?;
        self.reset_clean(now);
        Ok(path)
    }

    pub fn has_newer_autosave(show_path: &Path) -> bool {
        let auto = Self::autosave_path(show_path);
        let Ok(auto_meta) = fs::metadata(&auto) else {
            return false;
        };
        let Ok(auto_time) = auto_meta.modified() else {
            return false;
        };
        let Ok(show_meta) = fs::metadata(show_path) else {
            return true;
        };
        let Ok(show_time) = show_meta.modified() else {
            return true;
        };
        auto_time > show_time
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::plan::{ArtNetOutputMode, ProtocolKind};

    fn sample_fixture(id: &str, address: u16) -> FixtureInstance {
        FixtureInstance {
            id: id.to_string(),
            profile: "age/rlcv3_8_segment_tube.json".to_string(),
            mode: "34ch Pixel Mode".to_string(),
            name: "Tube".to_string(),
            universe: 1,
            address,
            channel_count: 34,
            grid_pos: GridPos::default(),
            calibration: FixtureCalibration::default(),
        }
    }

    #[test]
    fn commands_apply_revert_and_redo_symmetrically() {
        let mut show = ShowState::default();
        let mut history = UndoHistory::default();

        let fx = sample_fixture("fx_1", 1);
        let u3 = UniverseConfig::new(
            3,
            ProtocolKind::ArtNet {
                mode: ArtNetOutputMode::Broadcast,
                net: 0,
                subnet: 0,
                uni: 2,
            },
        );

        let rev2 = history
            .execute(
                &mut show,
                ShowCommand::PatchFixtures {
                    added: vec![fx.clone()],
                    auto_created_universes: vec![u3.clone()],
                },
            )
            .unwrap();
        assert_eq!(rev2, 2);
        assert_eq!(show.patch.len(), 1);
        assert_eq!(show.network_outputs.universes.len(), 3);

        // Move fixture
        history
            .execute(
                &mut show,
                ShowCommand::MoveFixturePatch {
                    fixture_id: "fx_1".into(),
                    before_universe: 1,
                    before_address: 1,
                    after_universe: 2,
                    after_address: 10,
                    auto_created_universes: vec![],
                },
            )
            .unwrap();
        assert_eq!(show.patch[0].universe, 2);
        assert_eq!(show.patch[0].address, 10);

        // Undo move
        history.undo(&mut show).unwrap();
        assert_eq!(show.patch[0].universe, 1);
        assert_eq!(show.patch[0].address, 1);

        // Undo patch
        history.undo(&mut show).unwrap();
        assert!(show.patch.is_empty());
        assert_eq!(show.network_outputs.universes.len(), 2);

        // Redo patch
        history.redo(&mut show).unwrap();
        assert_eq!(show.patch.len(), 1);
    }

    #[test]
    fn coalesces_continuous_gestures_with_matching_coalesce_key() {
        let mut show = ShowState::default();
        let mut history = UndoHistory::default();

        history
            .execute(
                &mut show,
                ShowCommand::PatchFixtures {
                    added: vec![sample_fixture("fx_1", 1)],
                    auto_created_universes: vec![],
                },
            )
            .unwrap();

        let initial_pos = show.patch[0].grid_pos;
        for step in 1..=5 {
            let before_pos = show.patch[0].grid_pos;
            let mut next = initial_pos;
            next.x = 0.1 * (step as f32);
            history
                .execute(
                    &mut show,
                    ShowCommand::UpdateFixtureGridPos {
                        fixture_id: "fx_1".into(),
                        before: before_pos,
                        after: next,
                        coalesce_key: Some("drag_fx_1".into()),
                    },
                )
                .unwrap();
        }

        // All 5 drag updates merged into 1 undo entry (plus the initial patch = 2 total)
        assert_eq!(history.undo_len(), 2);
        assert!((show.patch[0].grid_pos.x - 0.5).abs() < 1e-6);

        history.undo(&mut show).unwrap();
        assert!((show.patch[0].grid_pos.x - initial_pos.x).abs() < 1e-6);
    }

    #[test]
    fn autosave_triggers_after_20_revisions_or_60_seconds_and_detects_newer_file() {
        let dir = std::env::temp_dir().join(format!("taktlight_autosave_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let show_path = dir.join("studio.takt.xml");
        let show = ShowState::default();
        fs::write(&show_path, serialize_show_xml(&show).unwrap()).unwrap();

        let t0 = Instant::now();
        let mut mgr = AutosaveManager::new(t0);
        for _ in 0..19 {
            mgr.record_dirty_revision();
        }
        assert!(!mgr.should_autosave(t0 + Duration::from_secs(10)));
        assert!(mgr.should_autosave(t0 + Duration::from_secs(60)));

        mgr.record_dirty_revision(); // 20th revision
        assert!(mgr.should_autosave(t0 + Duration::from_secs(10)));

        std::thread::sleep(Duration::from_millis(25));
        let saved_path = mgr.write_autosave(&show_path, &show, t0).unwrap();
        assert!(saved_path.exists());
        assert!(AutosaveManager::has_newer_autosave(&show_path));

        let _ = fs::remove_dir_all(&dir);
    }
}
