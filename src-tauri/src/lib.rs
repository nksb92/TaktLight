use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use arc_swap::ArcSwap;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, RunEvent, State};
use tokio::sync::watch;

use taktlight_engine::audio::{
    analyze_streaming_chunks, analyze_wav_bytes_streaming, compute_sha256_hex,
    generate_synthetic_drum_track_chunks, AudioAnalysisCache, AudioAnalysisResult,
};
use taktlight_engine::engine::runner::{
    spawn_engine_loop, EngineConfig, EngineRunnerHandle, EngineTelemetrySnapshot,
};
use taktlight_engine::frame::flow::FrameCreditGate;
use taktlight_engine::fx::scene::ActiveSceneInstance;
use taktlight_engine::mixer::traits::SmartControlLayer;
use taktlight_engine::ofl::expander::ExpandedFixtureMode;
use taktlight_engine::ofl::library::{
    validate_and_parse_ofl, FixtureDetail, FixtureLibrary, FixtureSummary, SaveFixtureError,
};
use taktlight_engine::ofl::validator::SchemaValidationIssue;
use taktlight_engine::protocol::artnet::TrackedArtNetNode;
use taktlight_engine::protocol::nic::{
    enumerate_ipv4_interfaces, AdapterSelection, NetworkInterfaceInfo,
};
use taktlight_engine::show::compiler::compile_render_plan;
use taktlight_engine::show::patch::{
    auto_patch_batch, find_placement, validate_patch_no_collisions, FixtureCalibration,
};
use taktlight_engine::show::spatial::GridPos;
use taktlight_engine::show::undo::{ShowCommand, UndoHistory};
use taktlight_engine::show::xml::{
    deserialize_show_xml, serialize_show_xml, ColorPaletteDef, DimmerPaletteDef, DurationUnit,
    FixtureGroupDef, FxBlockDef, SceneDef, ShowState, TimelineDef,
};
use taktlight_engine::state::plan::{CompiledCell, RenderPlan, UniverseConfig};
use taktlight_engine::state::runtime::RuntimeControl;
use taktlight_engine::telemetry::jitter::JitterStats;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ParkedChannelDto {
    pub universe: u16,
    pub channel: u16,
    pub value: u8,
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineSnapshotDto {
    pub grand_master: f32,
    pub blackout: bool,
    pub parked_channels: Vec<ParkedChannelDto>,
    pub live_layers: Vec<SmartControlLayer>,
    pub active_scenes: Vec<ActiveSceneInstance>,
    pub live_bpm: f32,
    pub active_timeline_id: Option<String>,
    pub timeline_playing: bool,
    pub timeline_playhead_sec: f64,
    pub latency_offset_ms: f64,
    pub universes: Vec<UniverseConfig>,
    pub interfaces: Vec<NetworkInterfaceInfo>,
    pub adapter_selection: AdapterSelection,
    pub is_offline: bool,
    pub output_enabled: bool,
    pub discovery_available: bool,
    pub active_interface: Option<NetworkInterfaceInfo>,
    pub discovered_nodes: Vec<TrackedArtNetNode>,
    pub jitter_stats: JitterStats,
    pub jitter_samples_us: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FixtureValidationResult {
    pub valid: bool,
    pub issues: Vec<SchemaValidationIssue>,
    pub expanded_modes: Vec<ExpandedFixtureMode>,
    pub pixel_count: u16,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShowSnapshotDto {
    pub revision: u64,
    pub show: ShowState,
    pub compiled_cells: Vec<CompiledCell>,
    pub can_undo: bool,
    pub can_redo: bool,
    pub rollover_enabled: bool,
    pub toast: Option<String>,
    pub cross_protocol_warning: bool,
}

pub struct AppState {
    pub plan: Arc<ArcSwap<RenderPlan>>,
    pub runtime: Arc<ArcSwap<RuntimeControl>>,
    runtime_write_lock: Mutex<()>,
    pub credit_gate: FrameCreditGate,
    pub frame_rx: watch::Receiver<Vec<u8>>,
    pub telemetry: Arc<RwLock<EngineTelemetrySnapshot>>,
    pub adapter_selection: Arc<RwLock<AdapterSelection>>,
    pub stream_generation: Arc<AtomicU64>,
    pub engine_handle: Mutex<Option<EngineRunnerHandle>>,
    pub fixture_library: RwLock<FixtureLibrary>,
    pub show_state: RwLock<ShowState>,
    pub undo_history: Mutex<UndoHistory>,
    pub rollover_enabled: AtomicBool,
    pub output_enabled: AtomicBool,
    pub app_epoch: Instant,
    pub audio_cache: Mutex<AudioAnalysisCache>,
    next_fixture_seq: AtomicU64,
}

fn resolve_default_fixtures_dir() -> Option<PathBuf> {
    let candidates = [PathBuf::from("fixtures"), PathBuf::from("../fixtures")];
    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    std::env::current_dir().ok().map(|d| d.join("fixtures"))
}

impl AppState {
    pub fn new(start_engine_thread: bool) -> Self {
        let fixtures_dir = if start_engine_thread {
            resolve_default_fixtures_dir()
        } else {
            None
        };
        Self::new_with_fixtures_dir(start_engine_thread, fixtures_dir)
    }

    pub fn new_with_fixtures_dir(
        start_engine_thread: bool,
        fixtures_dir: Option<PathBuf>,
    ) -> Self {
        let fixture_library = RwLock::new(FixtureLibrary::load(fixtures_dir.as_deref()));
        let show_state = RwLock::new(ShowState::default());
        let undo_history = Mutex::new(UndoHistory::default());
        let initial_plan = {
            let show = show_state.read();
            let lib = fixture_library.read();
            compile_render_plan(1, &show, &lib).unwrap_or_else(|_| RenderPlan::default_studio_plan())
        };

        let plan = Arc::new(ArcSwap::from_pointee(initial_plan));
        let runtime = Arc::new(ArcSwap::from_pointee(RuntimeControl::new()));
        let credit_gate = FrameCreditGate::new(true);
        let (frame_tx, frame_rx) = watch::channel(Vec::new());
        let telemetry = Arc::new(RwLock::new(EngineTelemetrySnapshot {
            is_offline: true,
            output_enabled: false,
            ..Default::default()
        }));
        let adapter_selection = Arc::new(RwLock::new(AdapterSelection::Auto));

        let engine_handle = if start_engine_thread {
            Some(spawn_engine_loop(
                EngineConfig::default(),
                Arc::clone(&plan),
                Arc::clone(&runtime),
                frame_tx,
                Arc::clone(&telemetry),
                AdapterSelection::Auto,
                false,
            ))
        } else {
            None
        };

        Self {
            plan,
            runtime,
            runtime_write_lock: Mutex::new(()),
            credit_gate,
            frame_rx,
            telemetry,
            adapter_selection,
            stream_generation: Arc::new(AtomicU64::new(0)),
            engine_handle: Mutex::new(engine_handle),
            fixture_library,
            show_state,
            undo_history,
            rollover_enabled: AtomicBool::new(true),
            output_enabled: AtomicBool::new(false),
            app_epoch: Instant::now(),
            audio_cache: Mutex::new(AudioAnalysisCache::new()),
            next_fixture_seq: AtomicU64::new(1),
        }
    }

    pub fn default_color_palettes() -> Vec<ColorPaletteDef> {
        let defs: [(&str, &str, &[&str]); 12] = [
            (
                "pal_rainbow",
                "Rainbow",
                &[
                    "#FF0000", "#FF8800", "#FFFF00", "#00FF00", "#00CCFF", "#0044FF", "#AA00FF",
                ],
            ),
            ("pal_cyber", "Cyberpunk Dual", &["#FF5500", "#2255AA"]),
            (
                "pal_warm",
                "Warm Tungsten",
                &["#FFCC66", "#FF8822", "#CC4400"],
            ),
            (
                "pal_fire",
                "Fire & Ember",
                &["#FF1100", "#FF6600", "#FFCC00"],
            ),
            (
                "pal_ocean",
                "Ocean Ice",
                &["#001F66", "#0077CC", "#00EEFF", "#CCF9FF"],
            ),
            (
                "pal_synthwave",
                "Neon Synthwave",
                &["#FF00AA", "#8800FF", "#00E5FF"],
            ),
            (
                "pal_sunset",
                "Sunset Glow",
                &["#FF2E63", "#FF7B25", "#FFD166", "#5E2BFF"],
            ),
            (
                "pal_forest",
                "Forest Emerald",
                &["#004D25", "#00C853", "#AEEA00"],
            ),
            (
                "pal_police",
                "Emergency Red Blue",
                &["#FF0000", "#0033FF"],
            ),
            (
                "pal_uv",
                "UV Violet",
                &["#3A0088", "#9D00FF", "#FF4DFF"],
            ),
            (
                "pal_rgb",
                "RGB Primary",
                &["#FF0000", "#00FF00", "#0000FF"],
            ),
            (
                "pal_white_temp",
                "Warm to Cool White",
                &["#FFD28A", "#FFFFFF", "#B8DCFF"],
            ),
        ];
        defs.into_iter()
            .map(|(id, name, stops)| ColorPaletteDef {
                id: id.into(),
                name: name.into(),
                hex_start: stops.first().copied().unwrap_or("#FFFFFF").into(),
                hex_end: stops.last().copied().unwrap_or("#FFFFFF").into(),
                colors: stops.iter().map(|s| (*s).into()).collect(),
            })
            .collect()
    }

    pub fn seed_default_studio_show(&self) {
        let mut show = self.show_state.write();
        if !show.scenes.is_empty() || !show.fx_library.is_empty() {
            return;
        }
        if show.color_palettes.is_empty() {
            show.color_palettes = Self::default_color_palettes();
        }
        if show.dimmer_palettes.is_empty() {
            show.dimmer_palettes = vec![DimmerPaletteDef {
                id: "dim_full".into(),
                name: "Full Intensity".into(),
                value_start: 1.0,
                value_end: 1.0,
            }];
        }
        show.scenes.push(SceneDef {
            id: "sc_new_1".into(),
            name: "New Scene".into(),
            bank: Some("Bank 1".into()),
            target_group: None,
            priority: 10,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            duration_value: 4.0,
            duration_unit: DurationUnit::Beats,
            block_refs: Vec::new(),
        });
        let lib = self.fixture_library.read();
        let rev = self.undo_history.lock().revision();
        if let Ok(compiled) = compile_render_plan(rev, &show, &lib) {
            self.plan.store(Arc::new(compiled));
        }
    }

    pub fn update_runtime<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&mut RuntimeControl) -> R,
    {
        let _guard = self.runtime_write_lock.lock();
        let mut next = (**self.runtime.load()).clone();
        let res = f(&mut next);
        self.runtime.store(Arc::new(next));
        res
    }

    pub fn snapshot(&self) -> EngineSnapshotDto {
        let rt = self.runtime.load();
        let plan = self.plan.load();
        let tel = self.telemetry.read();
        let selection = self.adapter_selection.read().clone();

        let parked_channels = rt
            .parked_channels
            .iter()
            .map(|(&(universe, channel), &value)| ParkedChannelDto {
                universe,
                channel,
                value,
            })
            .collect();

        let t_now = self.app_epoch.elapsed().as_secs_f64();
        let active_scenes = rt
            .active_scenes
            .iter()
            .filter(|s| !s.is_finished(t_now))
            .cloned()
            .collect();

        EngineSnapshotDto {
            grand_master: rt.grand_master,
            blackout: rt.blackout,
            parked_channels,
            live_layers: rt.live_layers.clone(),
            active_scenes,
            live_bpm: rt.beat_clock.bpm,
            active_timeline_id: rt.active_timeline_id.clone(),
            timeline_playing: rt.timeline_playing,
            timeline_playhead_sec: rt
                .effective_timeline_playhead_sec(t_now)
                .unwrap_or(rt.timeline_playhead_sec),
            latency_offset_ms: rt.latency_offset_ms,
            universes: plan.universes.clone(),
            interfaces: enumerate_ipv4_interfaces(),
            adapter_selection: selection,
            is_offline: tel.is_offline,
            output_enabled: self.output_enabled.load(Ordering::Acquire),
            discovery_available: tel.discovery_available,
            active_interface: tel.active_interface.clone(),
            discovered_nodes: tel.discovered_nodes.clone(),
            jitter_stats: tel.jitter_stats,
            jitter_samples_us: tel.jitter_samples_us.clone(),
        }
    }

    pub fn validate_fixture(raw_json: &str) -> FixtureValidationResult {
        match validate_and_parse_ofl(raw_json) {
            Ok((_def, expanded_modes)) => {
                let pixel_count = expanded_modes
                    .iter()
                    .map(|m| m.cells.len() as u16)
                    .max()
                    .unwrap_or(1);
                FixtureValidationResult {
                    valid: true,
                    issues: Vec::new(),
                    expanded_modes,
                    pixel_count,
                }
            }
            Err(issues) => FixtureValidationResult {
                valid: false,
                issues,
                expanded_modes: Vec::new(),
                pixel_count: 0,
            },
        }
    }

    pub fn save_fixture(
        &self,
        slug: &str,
        raw_json: &str,
    ) -> Result<FixtureDetail, Vec<SchemaValidationIssue>> {
        let mut lib = self.fixture_library.write();
        lib.save_user_fixture(slug, raw_json).map_err(|err| match err {
            SaveFixtureError::Validation(issues) => issues,
            other => vec![SchemaValidationIssue {
                instance_path: "/".to_string(),
                schema_path: "".to_string(),
                message: other.to_string(),
            }],
        })
    }

    fn build_show_snapshot(
        &self,
        toast: Option<String>,
        cross_protocol_warning: bool,
    ) -> ShowSnapshotDto {
        let show = self.show_state.read().clone();
        let history = self.undo_history.lock();
        let plan = self.plan.load();
        ShowSnapshotDto {
            revision: history.revision(),
            show,
            compiled_cells: plan.cells.clone(),
            can_undo: history.can_undo(),
            can_redo: history.can_redo(),
            rollover_enabled: self.rollover_enabled.load(Ordering::Acquire),
            toast,
            cross_protocol_warning,
        }
    }

    pub fn execute_show_command(
        &self,
        cmd: ShowCommand,
        toast: Option<String>,
        cross_protocol_warning: bool,
    ) -> Result<ShowSnapshotDto, String> {
        let mut show = self.show_state.write();
        let mut history = self.undo_history.lock();
        let revision = history
            .execute(&mut show, cmd)
            .map_err(|e| e.to_string())?;
        let lib = self.fixture_library.read();
        let compiled = compile_render_plan(revision, &show, &lib).map_err(|e| e.to_string())?;
        self.plan.store(Arc::new(compiled));
        drop(lib);
        drop(history);
        drop(show);
        Ok(self.build_show_snapshot(toast, cross_protocol_warning))
    }

    pub fn patch_fixtures(
        &self,
        profile_id: &str,
        mode_name: &str,
        name_prefix: &str,
        count: u16,
        universe: u16,
        address: u16,
        rollover_split: bool,
    ) -> Result<ShowSnapshotDto, String> {
        let count = count.clamp(1, 64);
        let channel_count = {
            let lib = self.fixture_library.read();
            let detail = lib
                .get_entry(profile_id)
                .ok_or_else(|| format!("profile '{profile_id}' not found"))?;
            let mode = detail
                .expanded_modes
                .iter()
                .find(|m| m.name == mode_name)
                .ok_or_else(|| format!("mode '{mode_name}' not found"))?;
            mode.channel_count as u16
        };

        let existing_show = self.show_state.read().clone();
        let mut batch = Vec::with_capacity(count as usize);
        let existing_count = existing_show.patch.len();
        for idx in 0..count {
            let seq = self.next_fixture_seq.fetch_add(1, Ordering::AcqRel);
            let id = format!("fx_{seq:03}");
            let name = if count == 1 {
                name_prefix.trim().to_string()
            } else {
                format!("{} {}", name_prefix.trim(), idx + 1)
            };
            let grid_y = (0.15 + ((existing_count + (idx as usize)) % 6) as f32 * 0.14).min(0.88);
            let grid_x = (0.25 + (((existing_count + (idx as usize)) / 6) % 3) as f32 * 0.25).min(0.85);
            batch.push((
                id,
                profile_id.to_string(),
                mode_name.to_string(),
                name,
                channel_count,
                GridPos {
                    x: grid_x,
                    y: grid_y,
                    rotation: 0.0,
                    scale_x: 0.30,
                    scale_y: 0.05,
                },
                FixtureCalibration::default(),
            ));
        }

        let (added, auto_created, outcomes) = auto_patch_batch(
            &existing_show.patch,
            &existing_show.network_outputs.universes,
            batch,
            universe,
            address,
            rollover_split,
        )
        .map_err(|e| e.to_string())?;

        let cross_warning = outcomes.iter().any(|o| o.cross_protocol_warning);
        let toast = if outcomes.len() == 1 {
            Some(outcomes[0].toast_message.clone())
        } else if let Some(first) = outcomes.first() {
            Some(format!(
                "Patched {} fixtures starting at U{}.{:03}",
                outcomes.len(),
                first.universe,
                first.address
            ))
        } else {
            None
        };

        self.execute_show_command(
            ShowCommand::PatchFixtures {
                added,
                auto_created_universes: auto_created,
            },
            toast,
            cross_warning,
        )
    }

    pub fn move_fixture_patch(
        &self,
        fixture_id: &str,
        universe: u16,
        address: u16,
        rollover_split: bool,
    ) -> Result<ShowSnapshotDto, String> {
        let show = self.show_state.read().clone();
        let fx = show
            .patch
            .iter()
            .find(|f| f.id == fixture_id)
            .ok_or_else(|| format!("fixture '{fixture_id}' not found"))?;

        let outcome = find_placement(
            &show.patch,
            &show.network_outputs.universes,
            &fx.name,
            universe,
            address,
            fx.channel_count,
            rollover_split,
            Some(fixture_id),
        )
        .map_err(|e| e.to_string())?;

        let before_universe = fx.universe;
        let before_address = fx.address;
        let toast = if outcome.moved_from_requested || outcome.was_split {
            Some(outcome.toast_message)
        } else {
            Some(format!(
                "{} moved to U{}.{:03}",
                fx.name, outcome.universe, outcome.address
            ))
        };

        self.execute_show_command(
            ShowCommand::MoveFixturePatch {
                fixture_id: fixture_id.to_string(),
                before_universe,
                before_address,
                after_universe: outcome.universe,
                after_address: outcome.address,
                auto_created_universes: outcome.auto_create_universes,
            },
            toast,
            outcome.cross_protocol_warning,
        )
    }

    pub fn resolve_split_fixtures(&self) -> Result<ShowSnapshotDto, String> {
        let before_show = self.show_state.read().clone();
        let mut after_show = before_show.clone();
        let mut moved_count = 0usize;

        for idx in 0..after_show.patch.len() {
            let fx = after_show.patch[idx].clone();
            if fx.address + fx.channel_count.saturating_sub(1) <= 512 {
                continue;
            }
            let outcome = find_placement(
                &after_show.patch,
                &after_show.network_outputs.universes,
                &fx.name,
                fx.universe,
                fx.address,
                fx.channel_count,
                false,
                Some(&fx.id),
            )
            .map_err(|e| e.to_string())?;

            for auto_u in outcome.auto_create_universes {
                if !after_show
                    .network_outputs
                    .universes
                    .iter()
                    .any(|u| u.id == auto_u.id)
                {
                    after_show.network_outputs.universes.push(auto_u);
                }
            }
            after_show.network_outputs.universes.sort_by_key(|u| u.id);
            after_show.patch[idx].universe = outcome.universe;
            after_show.patch[idx].address = outcome.address;
            moved_count += 1;
        }

        if moved_count == 0 {
            return Ok(self.build_show_snapshot(None, false));
        }

        self.execute_show_command(
            ShowCommand::ReplaceShowState {
                before: Box::new(before_show),
                after: Box::new(after_show),
            },
            Some(format!("Moved {moved_count} split fixture(s) to valid addresses")),
            false,
        )
    }

    pub fn undo(&self) -> Result<ShowSnapshotDto, String> {
        let mut show = self.show_state.write();
        let mut history = self.undo_history.lock();
        if let Some(revision) = history.undo(&mut show).map_err(|e| e.to_string())? {
            let lib = self.fixture_library.read();
            let compiled = compile_render_plan(revision, &show, &lib).map_err(|e| e.to_string())?;
            self.plan.store(Arc::new(compiled));
        }
        drop(history);
        drop(show);
        Ok(self.build_show_snapshot(Some("Undid last change".to_string()), false))
    }

    pub fn redo(&self) -> Result<ShowSnapshotDto, String> {
        let mut show = self.show_state.write();
        let mut history = self.undo_history.lock();
        if let Some(revision) = history.redo(&mut show).map_err(|e| e.to_string())? {
            let lib = self.fixture_library.read();
            let compiled = compile_render_plan(revision, &show, &lib).map_err(|e| e.to_string())?;
            self.plan.store(Arc::new(compiled));
        }
        drop(history);
        drop(show);
        Ok(self.build_show_snapshot(Some("Redid change".to_string()), false))
    }

    pub fn import_show_xml(&self, xml_str: &str) -> Result<ShowSnapshotDto, String> {
        let mut parsed = deserialize_show_xml(xml_str).map_err(|e| e.to_string())?;
        {
            let lib = self.fixture_library.read();
            for fx in &mut parsed.patch {
                let detail = lib.get_entry(&fx.profile).ok_or_else(|| {
                    format!("fixture profile '{}' not found in OFL library", fx.profile)
                })?;
                let mode = detail
                    .expanded_modes
                    .iter()
                    .find(|m| m.name == fx.mode)
                    .ok_or_else(|| {
                        format!("mode '{}' not found in profile '{}'", fx.mode, fx.profile)
                    })?;
                fx.channel_count = mode.channel_count as u16;
            }
        }
        validate_patch_no_collisions(&parsed.patch).map_err(|e| e.to_string())?;
        let before = Box::new(self.show_state.read().clone());
        let after = Box::new(parsed);
        self.execute_show_command(
            ShowCommand::ReplaceShowState { before, after },
            Some("Imported .takt.xml show".to_string()),
            false,
        )
    }

    pub fn upsert_color_palette(&self, palette: ColorPaletteDef) -> Result<ShowSnapshotDto, String> {
        let before = self
            .show_state
            .read()
            .color_palettes
            .iter()
            .find(|p| p.id == palette.id)
            .cloned();
        let label = palette.name.clone();
        self.execute_show_command(
            ShowCommand::UpsertColorPalette {
                before,
                after: palette,
            },
            Some(format!("Saved color palette {label}")),
            false,
        )
    }

    pub fn delete_color_palette(&self, id: &str) -> Result<ShowSnapshotDto, String> {
        let removed = self
            .show_state
            .read()
            .color_palettes
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| format!("color palette '{id}' not found"))?;
        let label = removed.name.clone();
        self.execute_show_command(
            ShowCommand::DeleteColorPalette { removed },
            Some(format!("Deleted color palette {label}")),
            false,
        )
    }

    pub fn upsert_dimmer_palette(
        &self,
        palette: DimmerPaletteDef,
    ) -> Result<ShowSnapshotDto, String> {
        let before = self
            .show_state
            .read()
            .dimmer_palettes
            .iter()
            .find(|p| p.id == palette.id)
            .cloned();
        let label = palette.name.clone();
        self.execute_show_command(
            ShowCommand::UpsertDimmerPalette {
                before,
                after: palette,
            },
            Some(format!("Saved dimmer palette {label}")),
            false,
        )
    }

    pub fn delete_dimmer_palette(&self, id: &str) -> Result<ShowSnapshotDto, String> {
        let removed = self
            .show_state
            .read()
            .dimmer_palettes
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| format!("dimmer palette '{id}' not found"))?;
        let label = removed.name.clone();
        self.execute_show_command(
            ShowCommand::DeleteDimmerPalette { removed },
            Some(format!("Deleted dimmer palette {label}")),
            false,
        )
    }

    pub fn upsert_group(&self, group: FixtureGroupDef) -> Result<ShowSnapshotDto, String> {
        let before = self
            .show_state
            .read()
            .groups
            .iter()
            .find(|g| g.id == group.id)
            .cloned();
        let label = group.name.clone();
        self.execute_show_command(
            ShowCommand::UpsertGroup {
                before,
                after: group,
            },
            Some(format!("Saved group {label}")),
            false,
        )
    }

    pub fn delete_group(&self, id: &str) -> Result<ShowSnapshotDto, String> {
        let removed = self
            .show_state
            .read()
            .groups
            .iter()
            .find(|g| g.id == id)
            .cloned()
            .ok_or_else(|| format!("group '{id}' not found"))?;
        let label = removed.name.clone();
        self.execute_show_command(
            ShowCommand::DeleteGroup { removed },
            Some(format!("Deleted group {label}")),
            false,
        )
    }

    pub fn upsert_fx_block(&self, block: FxBlockDef) -> Result<ShowSnapshotDto, String> {
        let before = self
            .show_state
            .read()
            .fx_library
            .iter()
            .find(|b| b.id == block.id)
            .cloned();
        let label = block.name.clone();
        self.execute_show_command(
            ShowCommand::UpsertFxBlock {
                before,
                after: block,
            },
            Some(format!("Saved FX block {label}")),
            false,
        )
    }

    pub fn delete_fx_block(&self, id: &str) -> Result<ShowSnapshotDto, String> {
        let removed = self
            .show_state
            .read()
            .fx_library
            .iter()
            .find(|b| b.id == id)
            .cloned()
            .ok_or_else(|| format!("fx block '{id}' not found"))?;
        let label = removed.name.clone();
        self.execute_show_command(
            ShowCommand::DeleteFxBlock { removed },
            Some(format!("Deleted FX block {label}")),
            false,
        )
    }

    pub fn upsert_scene(&self, scene: SceneDef) -> Result<ShowSnapshotDto, String> {
        let before = self
            .show_state
            .read()
            .scenes
            .iter()
            .find(|s| s.id == scene.id)
            .cloned();
        let label = scene.name.clone();
        self.execute_show_command(
            ShowCommand::UpsertScene {
                before,
                after: scene,
            },
            Some(format!("Saved scene {label}")),
            false,
        )
    }

    pub fn delete_scene(&self, id: &str) -> Result<ShowSnapshotDto, String> {
        let removed = self
            .show_state
            .read()
            .scenes
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| format!("scene '{id}' not found"))?;
        let label = removed.name.clone();
        self.execute_show_command(
            ShowCommand::DeleteScene { removed },
            Some(format!("Deleted scene {label}")),
            false,
        )
    }

    pub fn trigger_scene(
        &self,
        scene_id: &str,
        t_sec: Option<f64>,
    ) -> Result<EngineSnapshotDto, String> {
        let scene = self
            .show_state
            .read()
            .scenes
            .iter()
            .find(|s| s.id == scene_id)
            .cloned()
            .ok_or_else(|| format!("scene '{scene_id}' not found"))?;
        let t_now = t_sec.unwrap_or_else(|| self.app_epoch.elapsed().as_secs_f64());
        self.update_runtime(|rt| rt.trigger_scene(&scene, t_now));
        Ok(self.snapshot())
    }

    pub fn release_scene(&self, scene_id: &str, t_sec: Option<f64>) -> EngineSnapshotDto {
        let t_now = t_sec.unwrap_or_else(|| self.app_epoch.elapsed().as_secs_f64());
        self.update_runtime(|rt| {
            rt.release_scene(scene_id, t_now);
            rt.prune_finished_scenes(t_now);
        });
        self.snapshot()
    }

    pub fn release_all_scenes(&self, t_sec: Option<f64>) -> EngineSnapshotDto {
        let t_now = t_sec.unwrap_or_else(|| self.app_epoch.elapsed().as_secs_f64());
        self.update_runtime(|rt| {
            rt.release_all_scenes(t_now);
            rt.prune_finished_scenes(t_now);
        });
        self.snapshot()
    }

    pub fn configure_universe(&self, config: UniverseConfig) -> Result<ShowSnapshotDto, String> {
        let before = self
            .show_state
            .read()
            .network_outputs
            .universes
            .iter()
            .find(|u| u.id == config.id)
            .cloned();
        let uni_id = config.id;
        self.execute_show_command(
            ShowCommand::ConfigureUniverse {
                before,
                after: config,
            },
            Some(format!("Configured Universe {uni_id}")),
            false,
        )
    }

    pub fn rename_scene_bank(
        &self,
        old_name: &str,
        new_name: &str,
    ) -> Result<ShowSnapshotDto, String> {
        let from = old_name.trim();
        let to = new_name.trim();
        if from.is_empty() || to.is_empty() || from == to {
            return Ok(self.build_show_snapshot(None, false));
        }
        let affected_scene_ids: Vec<String> = self
            .show_state
            .read()
            .scenes
            .iter()
            .filter(|s| s.bank.as_deref().map(str::trim) == Some(from))
            .map(|s| s.id.clone())
            .collect();
        if affected_scene_ids.is_empty() {
            return Ok(self.build_show_snapshot(None, false));
        }
        self.execute_show_command(
            ShowCommand::RenameSceneBank {
                old_name: from.to_string(),
                new_name: to.to_string(),
                affected_scene_ids,
            },
            Some(format!("Renamed bank {from} to {to}")),
            false,
        )
    }

    pub fn set_live_bpm(&self, bpm: f32, t_sec: Option<f64>) -> EngineSnapshotDto {
        let t_now = t_sec.unwrap_or_else(|| self.app_epoch.elapsed().as_secs_f64());
        self.update_runtime(|rt| rt.set_live_bpm(bpm, t_now));
        self.snapshot()
    }

    pub fn tap_tempo(&self, t_sec: Option<f64>) -> EngineSnapshotDto {
        let t_now = t_sec.unwrap_or_else(|| self.app_epoch.elapsed().as_secs_f64());
        self.update_runtime(|rt| {
            rt.tap_tempo(t_now);
        });
        self.snapshot()
    }

    pub fn upsert_timeline(
        &self,
        timeline: TimelineDef,
        coalesce_key: Option<String>,
    ) -> Result<ShowSnapshotDto, String> {
        let before = self
            .show_state
            .read()
            .timelines
            .iter()
            .find(|t| t.id == timeline.id)
            .cloned();
        let label = timeline.name.clone();
        self.execute_show_command(
            ShowCommand::UpsertTimeline {
                before,
                after: timeline,
                coalesce_key,
            },
            Some(format!("Saved timeline {label}")),
            false,
        )
    }

    pub fn delete_timeline(&self, id: &str) -> Result<ShowSnapshotDto, String> {
        let removed = self
            .show_state
            .read()
            .timelines
            .iter()
            .find(|t| t.id == id)
            .cloned()
            .ok_or_else(|| format!("timeline '{id}' not found"))?;
        let label = removed.name.clone();
        self.execute_show_command(
            ShowCommand::DeleteTimeline { removed },
            Some(format!("Deleted timeline {label}")),
            false,
        )
    }

    pub fn set_timeline_transport(
        &self,
        timeline_id: Option<String>,
        playing: bool,
        playhead_sec: Option<f64>,
        t_sec: Option<f64>,
    ) -> EngineSnapshotDto {
        let t_now = t_sec.unwrap_or_else(|| self.app_epoch.elapsed().as_secs_f64());
        self.update_runtime(|rt| rt.set_timeline_transport(timeline_id, playing, playhead_sec, t_now));
        self.snapshot()
    }

    pub fn set_latency_offset_ms(&self, offset_ms: f64) -> EngineSnapshotDto {
        self.update_runtime(|rt| rt.set_latency_offset_ms(offset_ms));
        self.snapshot()
    }

    pub fn analyze_audio(
        &self,
        wav_path: Option<String>,
        synthetic_bpm: Option<f32>,
        synthetic_duration_sec: Option<f64>,
        transient_sensitivity: f32,
    ) -> Result<AudioAnalysisResult, String> {
        let sens = transient_sensitivity.clamp(0.0, 1.0);
        if let Some(path_str) = wav_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let bytes = std::fs::read(path_str)
                .map_err(|e| format!("failed to read audio file '{path_str}': {e}"))?;
            let sha = compute_sha256_hex(&bytes);
            if let Some(hit) = self.audio_cache.lock().get(&sha, sens) {
                return Ok(hit);
            }
            let res = analyze_wav_bytes_streaming(&bytes, sens)?;
            self.audio_cache.lock().insert(sens, res.clone());
            return Ok(res);
        }

        let bpm = synthetic_bpm.unwrap_or(120.0).clamp(60.0, 180.0);
        let dur = synthetic_duration_sec.unwrap_or(16.0).clamp(2.0, 120.0);
        let sha_key = compute_sha256_hex(format!("synthetic:{bpm:.2}:{dur:.2}").as_bytes());
        if let Some(hit) = self.audio_cache.lock().get(&sha_key, sens) {
            return Ok(hit);
        }
        let chunks = generate_synthetic_drum_track_chunks(44_100, bpm, dur, 0.120);
        let res = analyze_streaming_chunks(44_100, 1, sha_key, sens, chunks);
        self.audio_cache.lock().insert(sens, res.clone());
        Ok(res)
    }
}

#[tauri::command]
fn subscribe_frames(
    state: State<'_, AppState>,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let my_gen = state.stream_generation.fetch_add(1, Ordering::AcqRel) + 1;
    let stream_gen = Arc::clone(&state.stream_generation);
    let gate = state.credit_gate.clone();
    let mut rx = state.frame_rx.clone();
    gate.grant_credit();

    tauri::async_runtime::spawn(async move {
        while stream_gen.load(Ordering::Acquire) == my_gen {
            let Some(frame_bytes) = gate.wait_for_frame(&mut rx).await else {
                break;
            };
            if stream_gen.load(Ordering::Acquire) != my_gen {
                gate.grant_credit();
                break;
            }
            if channel.send(InvokeResponseBody::Raw(frame_bytes)).is_err() {
                gate.grant_credit();
                break;
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn ack_frame(state: State<'_, AppState>) {
    state.credit_gate.grant_credit();
}

#[tauri::command]
fn set_channel_park(
    state: State<'_, AppState>,
    universe: u16,
    channel: u16,
    value: Option<u8>,
) -> Result<(), String> {
    state
        .update_runtime(|rt| rt.set_park(universe, channel, value))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_all_parked_channels(state: State<'_, AppState>, universe: Option<u16>) {
    state.update_runtime(|rt| rt.clear_parked(universe));
}

#[tauri::command]
fn set_blackout(state: State<'_, AppState>, active: bool) {
    state.update_runtime(|rt| rt.set_blackout(active));
}

#[tauri::command]
fn set_grand_master(state: State<'_, AppState>, value: f32) {
    state.update_runtime(|rt| rt.set_grand_master(value));
}

#[tauri::command]
fn get_engine_snapshot(state: State<'_, AppState>) -> EngineSnapshotDto {
    state.snapshot()
}

#[tauri::command]
fn set_network_adapter(
    state: State<'_, AppState>,
    selection: AdapterSelection,
) -> Result<EngineSnapshotDto, String> {
    {
        let mut guard = state.adapter_selection.write();
        *guard = selection.clone();
    }
    if let Some(handle) = state.engine_handle.lock().as_ref() {
        handle.set_adapter(selection)?;
    }
    Ok(state.snapshot())
}

#[tauri::command]
fn set_output_enabled_command(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<EngineSnapshotDto, String> {
    state.output_enabled.store(enabled, Ordering::Release);
    if let Some(handle) = state.engine_handle.lock().as_ref() {
        handle.set_output_enabled(enabled)?;
    }
    Ok(state.snapshot())
}

#[tauri::command]
fn configure_universe_command(
    state: State<'_, AppState>,
    config: UniverseConfig,
) -> Result<ShowSnapshotDto, String> {
    state.configure_universe(config)
}

#[tauri::command]
fn rename_scene_bank_command(
    state: State<'_, AppState>,
    old_name: String,
    new_name: String,
) -> Result<ShowSnapshotDto, String> {
    state.rename_scene_bank(&old_name, &new_name)
}

#[tauri::command]
fn list_fixtures(state: State<'_, AppState>) -> Vec<FixtureSummary> {
    state.fixture_library.read().list_summaries()
}

#[tauri::command]
fn get_fixture_detail(state: State<'_, AppState>, id: String) -> Result<FixtureDetail, String> {
    state
        .fixture_library
        .read()
        .get_entry(&id)
        .cloned()
        .ok_or_else(|| format!("fixture '{id}' not found"))
}

#[tauri::command]
fn validate_fixture_json(raw_json: String) -> FixtureValidationResult {
    AppState::validate_fixture(&raw_json)
}

#[tauri::command]
fn save_user_fixture(
    state: State<'_, AppState>,
    slug: String,
    raw_json: String,
) -> Result<FixtureDetail, Vec<SchemaValidationIssue>> {
    state.save_fixture(&slug, &raw_json)
}

#[tauri::command]
fn delete_user_fixture(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.fixture_library.write().delete_user_fixture(&id)
}

#[tauri::command]
fn get_show_snapshot(state: State<'_, AppState>) -> ShowSnapshotDto {
    state.build_show_snapshot(None, false)
}

#[tauri::command]
fn patch_fixtures_command(
    state: State<'_, AppState>,
    profile_id: String,
    mode_name: String,
    name_prefix: String,
    count: u16,
    universe: u16,
    address: u16,
    rollover_split: bool,
) -> Result<ShowSnapshotDto, String> {
    state.patch_fixtures(
        &profile_id,
        &mode_name,
        &name_prefix,
        count,
        universe,
        address,
        rollover_split,
    )
}

#[tauri::command]
fn move_fixture_patch_command(
    state: State<'_, AppState>,
    fixture_id: String,
    universe: u16,
    address: u16,
    rollover_split: bool,
) -> Result<ShowSnapshotDto, String> {
    state.move_fixture_patch(&fixture_id, universe, address, rollover_split)
}

#[tauri::command]
fn unpatch_fixture_command(
    state: State<'_, AppState>,
    fixture_id: String,
) -> Result<ShowSnapshotDto, String> {
    let removed = {
        let show = state.show_state.read();
        show.patch
            .iter()
            .find(|f| f.id == fixture_id)
            .cloned()
            .ok_or_else(|| format!("fixture '{fixture_id}' not found"))?
    };
    let name = removed.name.clone();
    state.execute_show_command(
        ShowCommand::UnpatchFixture { removed },
        Some(format!("Removed {name} from patch")),
        false,
    )
}

#[tauri::command]
fn update_fixture_grid_pos_command(
    state: State<'_, AppState>,
    fixture_id: String,
    grid_pos: GridPos,
    coalesce_key: Option<String>,
) -> Result<ShowSnapshotDto, String> {
    let before = {
        let show = state.show_state.read();
        show.patch
            .iter()
            .find(|f| f.id == fixture_id)
            .map(|f| f.grid_pos)
            .ok_or_else(|| format!("fixture '{fixture_id}' not found"))?
    };
    state.execute_show_command(
        ShowCommand::UpdateFixtureGridPos {
            fixture_id,
            before,
            after: grid_pos,
            coalesce_key,
        },
        None,
        false,
    )
}

#[tauri::command]
fn update_fixture_calibration_command(
    state: State<'_, AppState>,
    fixture_id: String,
    calibration: FixtureCalibration,
    coalesce_key: Option<String>,
) -> Result<ShowSnapshotDto, String> {
    let before = {
        let show = state.show_state.read();
        show.patch
            .iter()
            .find(|f| f.id == fixture_id)
            .map(|f| f.calibration)
            .ok_or_else(|| format!("fixture '{fixture_id}' not found"))?
    };
    state.execute_show_command(
        ShowCommand::UpdateFixtureCalibration {
            fixture_id,
            before,
            after: calibration,
            coalesce_key,
        },
        None,
        false,
    )
}

#[tauri::command]
fn set_rollover_enabled_command(state: State<'_, AppState>, enabled: bool) -> ShowSnapshotDto {
    state.rollover_enabled.store(enabled, Ordering::Release);
    state.build_show_snapshot(None, false)
}

#[tauri::command]
fn mark_universe_reviewed_command(
    state: State<'_, AppState>,
    universe_id: u16,
) -> Result<ShowSnapshotDto, String> {
    let before = {
        let show = state.show_state.read();
        show.network_outputs
            .universes
            .iter()
            .find(|u| u.id == universe_id)
            .cloned()
            .ok_or_else(|| format!("universe {universe_id} not found"))?
    };
    let mut after = before.clone();
    after.review_output = false;
    state.execute_show_command(
        ShowCommand::ConfigureUniverse {
            before: Some(before),
            after,
        },
        None,
        false,
    )
}

#[tauri::command]
fn undo_command(state: State<'_, AppState>) -> Result<ShowSnapshotDto, String> {
    state.undo()
}

#[tauri::command]
fn redo_command(state: State<'_, AppState>) -> Result<ShowSnapshotDto, String> {
    state.redo()
}

#[tauri::command]
fn export_show_xml_command(state: State<'_, AppState>) -> Result<String, String> {
    let show = state.show_state.read();
    serialize_show_xml(&show).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_show_xml_command(
    state: State<'_, AppState>,
    xml_str: String,
) -> Result<ShowSnapshotDto, String> {
    state.import_show_xml(&xml_str)
}

#[tauri::command]
fn upsert_color_palette_command(
    state: State<'_, AppState>,
    palette: ColorPaletteDef,
) -> Result<ShowSnapshotDto, String> {
    state.upsert_color_palette(palette)
}

#[tauri::command]
fn delete_color_palette_command(
    state: State<'_, AppState>,
    id: String,
) -> Result<ShowSnapshotDto, String> {
    state.delete_color_palette(&id)
}

#[tauri::command]
fn upsert_dimmer_palette_command(
    state: State<'_, AppState>,
    palette: DimmerPaletteDef,
) -> Result<ShowSnapshotDto, String> {
    state.upsert_dimmer_palette(palette)
}

#[tauri::command]
fn delete_dimmer_palette_command(
    state: State<'_, AppState>,
    id: String,
) -> Result<ShowSnapshotDto, String> {
    state.delete_dimmer_palette(&id)
}

#[tauri::command]
fn upsert_group_command(
    state: State<'_, AppState>,
    group: FixtureGroupDef,
) -> Result<ShowSnapshotDto, String> {
    state.upsert_group(group)
}

#[tauri::command]
fn delete_group_command(
    state: State<'_, AppState>,
    id: String,
) -> Result<ShowSnapshotDto, String> {
    state.delete_group(&id)
}

#[tauri::command]
fn set_live_layers_command(
    state: State<'_, AppState>,
    layers: Vec<SmartControlLayer>,
) -> EngineSnapshotDto {
    state.update_runtime(|rt| rt.set_live_layers(layers));
    state.snapshot()
}

#[tauri::command]
fn upsert_fx_block_command(
    state: State<'_, AppState>,
    block: FxBlockDef,
) -> Result<ShowSnapshotDto, String> {
    state.upsert_fx_block(block)
}

#[tauri::command]
fn delete_fx_block_command(
    state: State<'_, AppState>,
    id: String,
) -> Result<ShowSnapshotDto, String> {
    state.delete_fx_block(&id)
}

#[tauri::command]
fn upsert_scene_command(
    state: State<'_, AppState>,
    scene: SceneDef,
) -> Result<ShowSnapshotDto, String> {
    state.upsert_scene(scene)
}

#[tauri::command]
fn delete_scene_command(
    state: State<'_, AppState>,
    id: String,
) -> Result<ShowSnapshotDto, String> {
    state.delete_scene(&id)
}

#[tauri::command]
fn trigger_scene_command(
    state: State<'_, AppState>,
    scene_id: String,
    t_sec: Option<f64>,
) -> Result<EngineSnapshotDto, String> {
    state.trigger_scene(&scene_id, t_sec)
}

#[tauri::command]
fn release_scene_command(
    state: State<'_, AppState>,
    scene_id: String,
    t_sec: Option<f64>,
) -> EngineSnapshotDto {
    state.release_scene(&scene_id, t_sec)
}

#[tauri::command]
fn release_all_scenes_command(
    state: State<'_, AppState>,
    t_sec: Option<f64>,
) -> EngineSnapshotDto {
    state.release_all_scenes(t_sec)
}

#[tauri::command]
fn set_live_bpm_command(
    state: State<'_, AppState>,
    bpm: f32,
    t_sec: Option<f64>,
) -> EngineSnapshotDto {
    state.set_live_bpm(bpm, t_sec)
}

#[tauri::command]
fn tap_tempo_command(state: State<'_, AppState>, t_sec: Option<f64>) -> EngineSnapshotDto {
    state.tap_tempo(t_sec)
}

#[tauri::command]
fn upsert_timeline_command(
    state: State<'_, AppState>,
    timeline: TimelineDef,
    coalesce_key: Option<String>,
) -> Result<ShowSnapshotDto, String> {
    state.upsert_timeline(timeline, coalesce_key)
}

#[tauri::command]
fn delete_timeline_command(
    state: State<'_, AppState>,
    id: String,
) -> Result<ShowSnapshotDto, String> {
    state.delete_timeline(&id)
}

#[tauri::command]
fn set_timeline_transport_command(
    state: State<'_, AppState>,
    timeline_id: Option<String>,
    playing: bool,
    playhead_sec: Option<f64>,
    t_sec: Option<f64>,
) -> EngineSnapshotDto {
    state.set_timeline_transport(timeline_id, playing, playhead_sec, t_sec)
}

#[tauri::command]
fn set_latency_offset_ms_command(
    state: State<'_, AppState>,
    offset_ms: f64,
) -> EngineSnapshotDto {
    state.set_latency_offset_ms(offset_ms)
}

#[tauri::command]
fn analyze_audio_command(
    state: State<'_, AppState>,
    wav_path: Option<String>,
    synthetic_bpm: Option<f32>,
    synthetic_duration_sec: Option<f64>,
    transient_sensitivity: f32,
) -> Result<AudioAnalysisResult, String> {
    state.analyze_audio(
        wav_path,
        synthetic_bpm,
        synthetic_duration_sec,
        transient_sensitivity,
    )
}

#[tauri::command]
fn resolve_split_fixtures_command(state: State<'_, AppState>) -> Result<ShowSnapshotDto, String> {
    state.resolve_split_fixtures()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new(true);
    app_state.seed_default_studio_show();

    let app = tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            subscribe_frames,
            ack_frame,
            set_channel_park,
            clear_all_parked_channels,
            set_blackout,
            set_grand_master,
            get_engine_snapshot,
            set_network_adapter,
            set_output_enabled_command,
            configure_universe_command,
            rename_scene_bank_command,
            list_fixtures,
            get_fixture_detail,
            validate_fixture_json,
            save_user_fixture,
            delete_user_fixture,
            get_show_snapshot,
            patch_fixtures_command,
            move_fixture_patch_command,
            unpatch_fixture_command,
            update_fixture_grid_pos_command,
            update_fixture_calibration_command,
            set_rollover_enabled_command,
            mark_universe_reviewed_command,
            undo_command,
            redo_command,
            export_show_xml_command,
            import_show_xml_command,
            upsert_color_palette_command,
            delete_color_palette_command,
            upsert_dimmer_palette_command,
            delete_dimmer_palette_command,
            upsert_group_command,
            delete_group_command,
            set_live_layers_command,
            upsert_fx_block_command,
            delete_fx_block_command,
            upsert_scene_command,
            delete_scene_command,
            trigger_scene_command,
            release_scene_command,
            release_all_scenes_command,
            set_live_bpm_command,
            tap_tempo_command,
            upsert_timeline_command,
            delete_timeline_command,
            set_timeline_transport_command,
            set_latency_offset_ms_command,
            analyze_audio_command,
            resolve_split_fixtures_command,
        ])
        .build(tauri::generate_context!())
        .expect("error while building TaktLight application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                if let Some(handle) = state.engine_handle.lock().take() {
                    handle.shutdown();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_state_updates_runtime_controls_without_pushing_undo_or_recompiling_plan() {
        let state = AppState::new(false);
        let initial_plan_ptr = Arc::as_ptr(&state.plan.load());
        let initial_rev = state.undo_history.lock().revision();

        state
            .update_runtime(|rt| rt.set_park(1, 12, Some(220)))
            .unwrap();
        state.update_runtime(|rt| rt.set_blackout(true));
        state.update_runtime(|rt| rt.set_grand_master(0.75));

        assert_eq!(Arc::as_ptr(&state.plan.load()), initial_plan_ptr);
        assert_eq!(state.undo_history.lock().revision(), initial_rev);
        assert!(!state.undo_history.lock().can_undo());

        let snap = state.snapshot();
        assert!(snap.blackout);
        assert!((snap.grand_master - 0.75).abs() < 1e-6);
        assert_eq!(
            snap.parked_channels,
            vec![ParkedChannelDto {
                universe: 1,
                channel: 12,
                value: 220
            }]
        );
        assert_eq!(snap.universes.len(), 2);

        state.update_runtime(|rt| rt.clear_parked(None));
        assert!(state.snapshot().parked_channels.is_empty());
    }

    #[test]
    fn app_state_lists_validates_saves_and_deletes_ofl_fixtures() {
        let temp_dir = std::env::temp_dir().join(format!(
            "taktlight_tauri_ofl_test_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&temp_dir);

        let state = AppState::new_with_fixtures_dir(false, Some(temp_dir.clone()));
        let summaries = state.fixture_library.read().list_summaries();
        assert_eq!(summaries.len(), 2);

        let rlcv3 = state
            .fixture_library
            .read()
            .get_entry("age/rlcv3_8_segment_tube.json")
            .cloned()
            .unwrap();
        let validation = AppState::validate_fixture(&rlcv3.raw_json);
        assert!(validation.valid);
        assert_eq!(validation.pixel_count, 8);
        assert_eq!(validation.expanded_modes[0].channel_count, 34);

        let bad_validation = AppState::validate_fixture("{\"name\": \"\"}");
        assert!(!bad_validation.valid);
        assert!(!bad_validation.issues.is_empty());

        let saved = state
            .save_fixture("my_custom_tube", &rlcv3.raw_json)
            .expect("valid user fixture saved");
        assert_eq!(saved.summary.id, "user/my_custom_tube.json");

        assert_eq!(state.fixture_library.read().list_summaries().len(), 3);
        state
            .fixture_library
            .write()
            .delete_user_fixture("user/my_custom_tube.json")
            .unwrap();
        assert_eq!(state.fixture_library.read().list_summaries().len(), 2);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn app_state_patches_moves_undoes_and_recompiles_render_plan() {
        let state = AppState::new(false);
        let snap = state
            .patch_fixtures(
                "age/rlcv3_8_segment_tube.json",
                "34ch Pixel Mode",
                "Tube Left",
                1,
                1,
                505,
                true,
            )
            .unwrap();

        assert_eq!(snap.show.patch.len(), 1);
        assert_eq!(snap.compiled_cells.len(), 8);
        assert!(snap.cross_protocol_warning);
        assert_eq!(
            snap.toast.as_deref(),
            Some("Tube Left split: U1.505 to U1.512 + U2.001 to U2.026")
        );
        assert_eq!(state.plan.load().cell_count, 8);

        let undone = state.undo().unwrap();
        assert!(undone.show.patch.is_empty());
        assert_eq!(state.plan.load().cell_count, 0);

        let redone = state.redo().unwrap();
        assert_eq!(redone.show.patch.len(), 1);
        assert_eq!(state.plan.load().cell_count, 8);
    }

    #[test]
    fn app_state_manages_palettes_groups_and_live_layers() {
        use taktlight_engine::engine::evaluator::{ClockInput, Engine, QuantizerState};
        use taktlight_engine::mixer::traits::{MergeOp, SmartLayerTrait};
        use taktlight_engine::show::spatial::OrderRule;

        let state = AppState::new(false);
        state
            .patch_fixtures(
                "age/rlcv3_8_segment_tube.json",
                "34ch Pixel Mode",
                "Tube 1",
                1,
                1,
                1,
                true,
            )
            .unwrap();

        let color_snap = state
            .upsert_color_palette(ColorPaletteDef {
                id: "pal_white".into(),
                name: "Studio White".into(),
                hex_start: "#FFFFFF".into(),
                hex_end: "#FFFFFF".into(),
                colors: Vec::new(),
            })
            .unwrap();
        assert_eq!(color_snap.show.color_palettes.len(), 1);
        assert_eq!(state.plan.load().color_palettes.len(), 1);

        let dim_snap = state
            .upsert_dimmer_palette(DimmerPaletteDef {
                id: "dim_full".into(),
                name: "Full".into(),
                value_start: 1.0,
                value_end: 1.0,
            })
            .unwrap();
        assert_eq!(dim_snap.show.dimmer_palettes.len(), 1);

        let grp_snap = state
            .upsert_group(FixtureGroupDef {
                id: "grp_all".into(),
                name: "All Cells".into(),
                order: OrderRule::Mirror,
                targets: vec!["fx_001:0..7".into()],
            })
            .unwrap();
        assert_eq!(grp_snap.show.groups.len(), 1);
        assert_eq!(state.plan.load().groups[0].cells.len(), 8);

        let rev_before_live = state.undo_history.lock().revision();
        let plan_ptr_before_live = Arc::as_ptr(&state.plan.load());
        state.update_runtime(|rt| {
            rt.set_live_layers(vec![
                SmartControlLayer {
                    id: "live_dim".into(),
                    name: "Live Dimmer".into(),
                    enabled: true,
                    priority: 1,
                    trigger_order: 1,
                    alpha: 1.0,
                    target: "grp_all".into(),
                    order_override: None,
                    trait_spec: SmartLayerTrait::Dimmer {
                        op: MergeOp::Htp,
                        palette_ref: Some("dim_full".into()),
                        value_start: 0.0,
                        value_end: 0.0,
                    },
                },
                SmartControlLayer {
                    id: "live_col".into(),
                    name: "Live Color".into(),
                    enabled: true,
                    priority: 1,
                    trigger_order: 2,
                    alpha: 1.0,
                    target: "grp_all".into(),
                    order_override: None,
                    trait_spec: SmartLayerTrait::Color {
                        op: MergeOp::Ltp,
                        palette_ref: Some("pal_white".into()),
                        hex_start: "#000000".into(),
                        hex_end: "#000000".into(),
                    },
                },
            ])
        });
        assert_eq!(state.undo_history.lock().revision(), rev_before_live);
        assert_eq!(Arc::as_ptr(&state.plan.load()), plan_ptr_before_live);
        assert_eq!(state.snapshot().live_layers.len(), 2);

        let plan = state.plan.load();
        let rt = state.runtime.load();
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
        // Master Dimmer untouched fallback = 255, Cell 1 White = 255
        assert_eq!(frame.universes[0].dmx[0], 255);
        assert_eq!(frame.universes[0].dmx[5], 255);

        let deleted = state.delete_color_palette("pal_white").unwrap();
        assert!(deleted.show.color_palettes.is_empty());
        let undone_del = state.undo().unwrap();
        assert_eq!(undone_del.show.color_palettes.len(), 1);
    }

    #[test]
    fn app_state_triggers_scenes_with_bank_exclusivity_and_tap_tempo() {
        use taktlight_engine::show::spatial::OrderRule;
        use taktlight_engine::show::xml::FxElementDef;

        let state = AppState::new(false);
        state
            .patch_fixtures(
                "age/rlcv3_8_segment_tube.json",
                "34ch Pixel Mode",
                "Tube FX",
                1,
                1,
                1,
                true,
            )
            .unwrap();
        state
            .upsert_group(FixtureGroupDef {
                id: "grp_fx".into(),
                name: "FX Group".into(),
                order: OrderRule::CenterOut,
                targets: vec!["fx_001:0..7".into()],
            })
            .unwrap();
        state
            .upsert_fx_block(FxBlockDef {
                id: "blk_wave".into(),
                name: "Wave".into(),
                target_group: Some("grp_fx".into()),
                duration_beats: 4.0,
                duration_sec: None,
                loop_block: true,
                elements: vec![FxElementDef::Curve1D {
                    trait_name: "dimmer".into(),
                    op: "htp".into(),
                    waveform: "sine".into(),
                    amplitude: 1.0,
                    offset: 0.0,
                    rate_beats: Some(2.0),
                    speed_hz: None,
                    rate_cycles: None,
                    phase_deg: 0.0,
                    phase_spread_deg: 360.0,
                    duty: None,
                    grayscale: false,
                    color_width: 1.0,
                    gradient: 1.0,
                    angle_deg: 0.0,
                    fx_kind_tag: None,
                    inline_colors: Vec::new(),
                    value_stops: Vec::new(),
                    palette_ref: None,
                    order: None,
                }],
            })
            .unwrap();

        state
            .upsert_scene(SceneDef {
                id: "sc_1".into(),
                name: "Scene 1".into(),
                bank: Some("main".into()),
                target_group: None,
                priority: 10,
                fade_in_sec: 0.0,
                fade_out_sec: 1.0,
                duration_value: 4.0,
                duration_unit: DurationUnit::Beats,
                block_refs: vec!["blk_wave".into()],
            })
            .unwrap();
        state
            .upsert_scene(SceneDef {
                id: "sc_2".into(),
                name: "Scene 2".into(),
                bank: Some("main".into()),
                target_group: None,
                priority: 10,
                fade_in_sec: 0.0,
                fade_out_sec: 1.0,
                duration_value: 4.0,
                duration_unit: DurationUnit::Beats,
                block_refs: vec!["blk_wave".into()],
            })
            .unwrap();

        let s1 = state.trigger_scene("sc_1", Some(1.0)).unwrap();
        assert_eq!(s1.active_scenes.len(), 1);

        let s2 = state.trigger_scene("sc_2", Some(2.0)).unwrap();
        assert_eq!(s2.active_scenes.len(), 2);
        let releasing_1 = s2.active_scenes.iter().find(|s| s.scene_id == "sc_1").unwrap();
        assert_eq!(releasing_1.release_t_sec, Some(2.0));

        state.tap_tempo(Some(5.0));
        let tapped = state.tap_tempo(Some(5.5));
        assert!((tapped.live_bpm - 120.0).abs() < 1e-3);
        let set_bpm_snap = state.set_live_bpm(140.0, Some(6.0));
        assert!((set_bpm_snap.live_bpm - 140.0).abs() < 1e-3);

        let rel_all = state.release_all_scenes(Some(7.0));
        assert!(rel_all.active_scenes.iter().all(|s| s.release_t_sec.is_some()));
    }

    #[test]
    fn app_state_manages_timelines_transport_and_audio_analysis() {
        use taktlight_engine::show::xml::{ClipDef, FxElementDef, TempoPointDef, TrackDef};

        let state = AppState::new(false);
        state
            .upsert_timeline(
                TimelineDef {
                    id: "tl_test".into(),
                    name: "Test Show".into(),
                    duration_sec: 16.0,
                    grid_offset_sec: 0.12,
                    tempo_map: vec![TempoPointDef {
                        at_sec: 0.0,
                        bpm: 128.0,
                    }],
                    audio_track: None,
                    tracks: vec![TrackDef {
                        id: "trk_1".into(),
                        name: "Track 1".into(),
                        target_group: Some("all".into()),
                        clips: vec![ClipDef {
                            ref_block: None,
                            start_sec: 0.5,
                            duration_sec: 4.0,
                            fade_in_sec: 0.25,
                            fade_out_sec: 0.25,
                            inline_fx: vec![FxElementDef::StaticTrait {
                                trait_name: "dimmer".into(),
                                op: "htp".into(),
                                palette_ref: None,
                                value_start: Some(1.0),
                                value_end: Some(1.0),
                                hex_start: None,
                                hex_end: None,
                                order: None,
                            }],
                        }],
                    }],
                },
                None,
            )
            .unwrap();

        let snap = state.set_timeline_transport(Some("tl_test".into()), true, Some(1.0), Some(10.0));
        assert_eq!(snap.active_timeline_id.as_deref(), Some("tl_test"));
        assert!(snap.timeline_playing);

        let lat = state.set_latency_offset_ms(-12.5);
        assert!((lat.latency_offset_ms - (-12.5)).abs() < 1e-6);

        let a1 = state
            .analyze_audio(None, Some(128.0), Some(8.0), 0.65)
            .unwrap();
        assert!((a1.estimated_bpm - 128.0).abs() <= 1.5);
        let a2 = state
            .analyze_audio(None, Some(128.0), Some(8.0), 0.65)
            .unwrap();
        assert_eq!(a1, a2);
        assert_eq!(state.audio_cache.lock().cache_hits, 1);

        state.undo().unwrap();
        assert!(state.show_state.read().timelines.is_empty());
    }

    #[test]
    fn seed_default_studio_show_populates_single_bank_and_scene() {
        let state = AppState::new(false);
        assert!(!state.snapshot().output_enabled);
        state.seed_default_studio_show();
        let snap = state.build_show_snapshot(None, false);
        assert_eq!(snap.show.scenes.len(), 1);
        assert_eq!(snap.show.scenes[0].name, "New Scene");
        assert_eq!(snap.show.scenes[0].bank.as_deref(), Some("Bank 1"));
        assert_eq!(snap.show.scenes[0].fade_in_sec, 0.0);
        assert_eq!(snap.show.scenes[0].fade_out_sec, 0.0);
        assert!(snap.show.scenes[0].block_refs.is_empty());
        assert!(snap.show.fx_library.is_empty());
        assert_eq!(snap.show.color_palettes.len(), 12);
        assert!(!snap.can_undo);
    }
}
