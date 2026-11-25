mod logging;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody, Response as IpcResponse};
use tauri::{Manager, RunEvent, State};
use tokio::sync::watch;

use taktlight_engine::audio::{
    analyze_streaming_chunks, analyze_wav_bytes_streaming, compute_sha256_hex,
    generate_synthetic_drum_track_chunks, AudioAnalysisCache, AudioAnalysisResult,
    AudioCallbackSnapshot, InterpolatedAudioClock,
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
use taktlight_engine::show::undo::{AutosaveManager, ShowCommand, UndoHistory};
use taktlight_engine::show::xml::{
    deserialize_show_xml, serialize_show_xml, ColorPaletteDef, DimmerPaletteDef, DurationUnit,
    FixtureGroupDef, FxBlockDef, GroupMixerStripDef, SceneDef, ShowState, TimelineDef,
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
    pub identified_fixture_id: Option<String>,
    pub last_network_error: Option<String>,
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
    pub has_autosave_recovery: bool,
}

const NIC_CACHE_TTL: Duration = Duration::from_secs(5);

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
    pub autosave_manager: Mutex<AutosaveManager>,
    pub autosave_enabled: AtomicBool,
    pub has_pending_recovery: AtomicBool,
    pub fallback_autosave_path: Mutex<Option<PathBuf>>,
    pub rollover_enabled: AtomicBool,
    pub output_enabled: AtomicBool,
    pub app_epoch: Instant,
    pub audio_clock: Arc<InterpolatedAudioClock>,
    pub audio_cache: Mutex<AudioAnalysisCache>,
    pub cached_interfaces: RwLock<(Instant, Vec<NetworkInterfaceInfo>)>,
    pub current_project_path: Mutex<Option<PathBuf>>,
    pub recent_projects: Mutex<Vec<String>>,
    pub recent_projects_file: Mutex<Option<PathBuf>>,
    next_fixture_seq: AtomicU64,
}

const MAX_RECENT_PROJECTS: usize = 10;

fn resolve_app_data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME"))
        .map(PathBuf::from)
    {
        return Some(dir.join("TaktLight"));
    }
    if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        return Some(profile.join("AppData").join("Roaming").join("TaktLight"));
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        return Some(home.join(".config").join("TaktLight"));
    }
    None
}

fn resolve_default_recent_projects_file() -> Option<PathBuf> {
    resolve_app_data_dir().map(|dir| dir.join("recent_projects.txt"))
}

fn load_recent_projects_from_file(path: &std::path::Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() && !out.iter().any(|p| p == trimmed) {
            out.push(trimmed.to_string());
            if out.len() >= MAX_RECENT_PROJECTS {
                break;
            }
        }
    }
    out
}

fn save_recent_projects_to_file(path: &std::path::Path, items: &[String]) {
    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            logging::log_warn(&format!(
                "Failed to create recent projects dir '{}': {err}",
                parent.display()
            ));
            return;
        }
    }
    let body = items.join("\n");
    if let Err(err) = std::fs::write(path, body) {
        logging::log_warn(&format!(
            "Failed to save recent projects '{}': {err}",
            path.display()
        ));
    }
}

fn resolve_default_fixtures_dir() -> Option<PathBuf> {
    if let Some(override_dir) = std::env::var_os("TAKTLIGHT_FIXTURES_DIR") {
        let path = PathBuf::from(override_dir);
        if !path.as_os_str().is_empty() {
            return Some(path);
        }
    }
    if let Some(app_data) = resolve_app_data_dir() {
        return Some(app_data.join("fixtures"));
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
        if let Some(ref dir) = fixtures_dir {
            let _ = std::fs::create_dir_all(dir.join("user"));
        }
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
        let app_epoch = Instant::now();
        let audio_clock = Arc::new(InterpolatedAudioClock::new());
        let initial_interfaces = enumerate_ipv4_interfaces();

        let engine_handle = if start_engine_thread {
            let mut engine_cfg = EngineConfig::default();
            engine_cfg.audio_clock = Some(Arc::clone(&audio_clock));
            engine_cfg.app_epoch = Some(app_epoch);
            Some(spawn_engine_loop(
                engine_cfg,
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

        let recent_projects_file = if start_engine_thread {
            resolve_default_recent_projects_file()
        } else {
            None
        };
        let fallback_autosave_path = recent_projects_file
            .as_ref()
            .and_then(|p| p.parent())
            .map(|dir| dir.join("untitled.takt.xml"));
        let initial_recent = recent_projects_file
            .as_deref()
            .map(load_recent_projects_from_file)
            .unwrap_or_default();

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
            autosave_manager: Mutex::new(AutosaveManager::new(app_epoch)),
            autosave_enabled: AtomicBool::new(true),
            has_pending_recovery: AtomicBool::new(false),
            fallback_autosave_path: Mutex::new(fallback_autosave_path),
            rollover_enabled: AtomicBool::new(true),
            output_enabled: AtomicBool::new(false),
            app_epoch,
            audio_clock,
            audio_cache: Mutex::new(AudioAnalysisCache::new()),
            cached_interfaces: RwLock::new((app_epoch, initial_interfaces)),
            current_project_path: Mutex::new(None),
            recent_projects: Mutex::new(initial_recent),
            recent_projects_file: Mutex::new(recent_projects_file),
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
            timeline_ref: None,
        });
        let lib = self.fixture_library.read();
        let rev = self.undo_history.lock().revision();
        if let Ok(compiled) = compile_render_plan(rev, &show, &lib) {
            self.plan.store(Arc::new(compiled));
        }
    }

    pub fn record_recent_project(&self, path: &std::path::Path) {
        let normalized = path.to_string_lossy().to_string();
        if normalized.trim().is_empty() {
            return;
        }
        let mut recent = self.recent_projects.lock();
        recent.retain(|p| p != &normalized);
        recent.insert(0, normalized);
        recent.truncate(MAX_RECENT_PROJECTS);
        let snapshot = recent.clone();
        drop(recent);
        if let Some(storage_path) = self.recent_projects_file.lock().clone() {
            save_recent_projects_to_file(&storage_path, &snapshot);
        }
    }

    pub fn get_recent_projects(&self) -> Vec<String> {
        self.recent_projects.lock().clone()
    }

    pub fn new_project(&self) -> ShowSnapshotDto {
        {
            let mut show = self.show_state.write();
            *show = ShowState::default();
        }
        {
            let mut history = self.undo_history.lock();
            *history = UndoHistory::default();
        }
        *self.current_project_path.lock() = None;
        self.next_fixture_seq.store(1, Ordering::Release);
        self.update_runtime(|rt| {
            rt.active_scenes.clear();
            rt.live_layers.clear();
            rt.active_timeline_id = None;
            rt.timeline_playing = false;
            rt.timeline_playhead_sec = 0.0;
            rt.parked_channels.clear();
            rt.beat_clock.bpm = 120.0;
            rt.identified_fixture_id = None;
        });
        self.audio_clock.publish(None);
        self.autosave_manager.lock().reset_clean(Instant::now());
        self.has_pending_recovery.store(false, Ordering::Release);
        self.seed_default_studio_show();
        self.build_show_snapshot(Some("Started new project".to_string()), false)
    }

    pub fn active_autosave_target(&self) -> Option<PathBuf> {
        self.current_project_path
            .lock()
            .clone()
            .or_else(|| self.fallback_autosave_path.lock().clone())
    }

    pub fn set_autosave_enabled(&self, enabled: bool) -> bool {
        self.autosave_enabled.store(enabled, Ordering::Release);
        if !enabled {
            self.has_pending_recovery.store(false, Ordering::Release);
            if let Some(target) = self.active_autosave_target() {
                let _ = std::fs::remove_file(AutosaveManager::autosave_path(&target));
            }
            self.autosave_manager.lock().reset_clean(Instant::now());
        }
        enabled
    }

    pub fn check_startup_autosave_recovery(&self) -> bool {
        if !self.autosave_enabled.load(Ordering::Acquire) {
            self.has_pending_recovery.store(false, Ordering::Release);
            return false;
        }
        let found = self
            .active_autosave_target()
            .as_deref()
            .is_some_and(AutosaveManager::has_newer_autosave);
        self.has_pending_recovery.store(found, Ordering::Release);
        found
    }

    pub fn has_autosave_recovery(&self) -> bool {
        self.has_pending_recovery.load(Ordering::Acquire)
    }

    pub fn on_project_saved(&self, path: &std::path::Path) {
        self.autosave_manager.lock().reset_clean(Instant::now());
        self.has_pending_recovery.store(false, Ordering::Release);
        let sidecar = AutosaveManager::autosave_path(path);
        let _ = std::fs::remove_file(sidecar);
        if let Some(fallback) = self.fallback_autosave_path.lock().clone() {
            let _ = std::fs::remove_file(AutosaveManager::autosave_path(&fallback));
        }
    }

    pub fn recover_autosave(&self) -> Result<ShowSnapshotDto, String> {
        let target = self
            .active_autosave_target()
            .ok_or_else(|| "No autosave target configured".to_string())?;
        let auto_path = AutosaveManager::autosave_path(&target);
        let xml = std::fs::read_to_string(&auto_path)
            .map_err(|e| format!("Failed to read autosave '{}': {e}", auto_path.display()))?;
        let mut snapshot = self.import_show_xml(&xml)?;
        let _ = std::fs::remove_file(&auto_path);
        self.autosave_manager.lock().reset_clean(Instant::now());
        self.has_pending_recovery.store(false, Ordering::Release);
        snapshot.toast = Some("Recovered unsaved changes from autosave".to_string());
        snapshot.has_autosave_recovery = false;
        Ok(snapshot)
    }

    pub fn discard_autosave(&self) -> Result<(), String> {
        if let Some(target) = self.active_autosave_target() {
            let auto_path = AutosaveManager::autosave_path(&target);
            if auto_path.exists() {
                std::fs::remove_file(&auto_path)
                    .map_err(|e| format!("Failed to discard autosave: {e}"))?;
            }
        }
        self.autosave_manager.lock().reset_clean(Instant::now());
        self.has_pending_recovery.store(false, Ordering::Release);
        Ok(())
    }

    pub fn cached_ipv4_interfaces(&self, force_refresh: bool) -> Vec<NetworkInterfaceInfo> {
        let now = Instant::now();
        if !force_refresh {
            let guard = self.cached_interfaces.read();
            if now.duration_since(guard.0) < NIC_CACHE_TTL {
                return guard.1.clone();
            }
        }
        let fresh = enumerate_ipv4_interfaces();
        let mut guard = self.cached_interfaces.write();
        *guard = (now, fresh.clone());
        fresh
    }

    pub fn open_project_path(&self, path: &std::path::Path) -> Result<ShowSnapshotDto, String> {
        let xml = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read project file '{}': {e}", path.display()))?;
        let mut snapshot = self.import_show_xml(&xml)?;
        *self.current_project_path.lock() = Some(path.to_path_buf());
        self.autosave_manager.lock().reset_clean(Instant::now());
        self.record_recent_project(path);
        let has_recovery = self.autosave_enabled.load(Ordering::Acquire)
            && AutosaveManager::has_newer_autosave(path);
        self.has_pending_recovery
            .store(has_recovery, Ordering::Release);
        snapshot.has_autosave_recovery = has_recovery;
        Ok(snapshot)
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
            interfaces: self.cached_ipv4_interfaces(false),
            adapter_selection: selection,
            is_offline: tel.is_offline,
            output_enabled: self.output_enabled.load(Ordering::Acquire),
            discovery_available: tel.discovery_available,
            active_interface: tel.active_interface.clone(),
            discovered_nodes: tel.discovered_nodes.clone(),
            jitter_stats: tel.jitter_stats,
            jitter_samples_us: tel.jitter_samples_us.clone(),
            identified_fixture_id: rt.identified_fixture_id.clone(),
            last_network_error: tel.last_network_error.clone(),
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
            has_autosave_recovery: self.has_autosave_recovery(),
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

        let mut final_toast = toast;
        if self.autosave_enabled.load(Ordering::Acquire) {
            let now = Instant::now();
            let mut autosave = self.autosave_manager.lock();
            autosave.record_dirty_revision();
            if autosave.should_autosave(now) {
                if let Some(target_path) = self.active_autosave_target() {
                    if let Err(err) = autosave.write_autosave(&target_path, &show, now) {
                        logging::log_error(&format!(
                            "Autosave failed for '{}': {err}",
                            target_path.display()
                        ));
                        if final_toast.is_none() {
                            final_toast = Some(format!("Autosave warning: {err}"));
                        }
                    }
                }
            }
        }
        drop(show);
        Ok(self.build_show_snapshot(final_toast, cross_protocol_warning))
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
            let mut show = self.show_state.write();
            if let Some(color) = show.bank_colors.remove(from) {
                show.bank_colors.insert(to.to_string(), color);
            }
            drop(show);
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

    pub fn set_bank_color(&self, bank_name: &str, color: Option<String>) -> ShowSnapshotDto {
        let target = bank_name.trim();
        if !target.is_empty() {
            let mut show = self.show_state.write();
            match color.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
                Some(clean) => {
                    show.bank_colors
                        .insert(target.to_string(), clean.to_string());
                }
                None => {
                    show.bank_colors.remove(target);
                }
            }
        }
        self.build_show_snapshot(None, false)
    }

    pub fn set_key_binding(&self, target_id: &str, key: Option<String>) -> ShowSnapshotDto {
        let target = target_id.trim();
        if !target.is_empty() {
            let mut show = self.show_state.write();
            match key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
                Some(clean) => {
                    show.key_bindings
                        .insert(target.to_string(), clean.to_string());
                }
                None => {
                    show.key_bindings.remove(target);
                }
            }
        }
        self.build_show_snapshot(None, false)
    }

    pub fn set_group_mixer_strip(
        &self,
        group_id: &str,
        strip: Option<GroupMixerStripDef>,
    ) -> ShowSnapshotDto {
        let target = group_id.trim();
        if !target.is_empty() {
            let mut show = self.show_state.write();
            match strip {
                Some(def) => {
                    show.group_mixer_strips.insert(target.to_string(), def);
                }
                None => {
                    show.group_mixer_strips.remove(target);
                }
            }
        }
        self.build_show_snapshot(None, false)
    }

    pub fn set_identified_fixture(&self, fixture_id: Option<String>) -> EngineSnapshotDto {
        self.update_runtime(|rt| rt.set_identified_fixture(fixture_id));
        self.snapshot()
    }

    pub fn publish_audio_clock_snapshot(
        &self,
        samples_played: Option<u64>,
        sample_rate: Option<u32>,
        buffer_duration_ms: Option<f64>,
        is_playing: bool,
    ) {
        if let (Some(samples), Some(sr)) = (samples_played, sample_rate) {
            if sr > 0 {
                let now_ns = self.app_epoch.elapsed().as_nanos() as u64;
                let buf_ns = (buffer_duration_ms.unwrap_or(25.0).clamp(2.0, 250.0) * 1_000_000.0)
                    .round() as u64;
                self.audio_clock.publish(Some(AudioCallbackSnapshot {
                    samples_played: samples,
                    sample_rate: sr,
                    callback_instant_ns: now_ns,
                    buffer_duration_ns: buf_ns,
                    is_playing,
                }));
                return;
            }
        }
        self.audio_clock.publish(None);
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
    let _ = state.cached_ipv4_interfaces(true);
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
    let snapshot = state.import_show_xml(&xml_str)?;
    *state.current_project_path.lock() = None;
    Ok(snapshot)
}

#[tauri::command]
async fn open_project_file_command(
    state: State<'_, AppState>,
) -> Result<Option<ShowSnapshotDto>, String> {
    let picked = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Open TaktLight Project")
            .add_filter("TaktLight Show XML", &["xml"])
            .pick_file()
    })
    .await
    .map_err(|e| format!("Failed to open file dialog: {e}"))?;

    let Some(path) = picked else {
        return Ok(None);
    };

    let snapshot = state.open_project_path(&path)?;
    Ok(Some(snapshot))
}

#[tauri::command]
async fn open_project_path_command(
    state: State<'_, AppState>,
    path: String,
) -> Result<ShowSnapshotDto, String> {
    state.open_project_path(std::path::Path::new(&path))
}

#[tauri::command]
fn new_project_command(state: State<'_, AppState>) -> ShowSnapshotDto {
    state.new_project()
}

#[tauri::command]
fn get_recent_projects_command(state: State<'_, AppState>) -> Vec<String> {
    state.get_recent_projects()
}

#[tauri::command]
async fn save_project_file_command(
    state: State<'_, AppState>,
    suggested_name: String,
) -> Result<bool, String> {
    let existing_path = state.current_project_path.lock().clone();
    let target_path = match existing_path {
        Some(path) => path,
        None => {
            let file_name = if suggested_name.trim().is_empty() {
                "taktlight_show.takt.xml".to_string()
            } else {
                suggested_name
            };
            let picked = tokio::task::spawn_blocking(move || {
                rfd::FileDialog::new()
                    .set_title("Save TaktLight Project")
                    .set_file_name(&file_name)
                    .add_filter("TaktLight Show XML", &["xml"])
                    .save_file()
            })
            .await
            .map_err(|e| format!("Failed to open save dialog: {e}"))?;

            match picked {
                Some(path) => path,
                None => return Ok(false),
            }
        }
    };

    let xml = {
        let show = state.show_state.read();
        serialize_show_xml(&show).map_err(|e| e.to_string())?
    };
    std::fs::write(&target_path, xml)
        .map_err(|e| format!("Failed to write project file '{}': {e}", target_path.display()))?;
    *state.current_project_path.lock() = Some(target_path.clone());
    state.on_project_saved(&target_path);
    state.record_recent_project(&target_path);
    Ok(true)
}

#[tauri::command]
async fn save_project_as_command(
    state: State<'_, AppState>,
    suggested_name: String,
) -> Result<bool, String> {
    let file_name = if suggested_name.trim().is_empty() {
        "taktlight_show.takt.xml".to_string()
    } else {
        suggested_name
    };
    let picked = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("Save TaktLight Project As")
            .set_file_name(&file_name)
            .add_filter("TaktLight Show XML", &["xml"])
            .save_file()
    })
    .await
    .map_err(|e| format!("Failed to open save dialog: {e}"))?;

    let Some(target_path) = picked else {
        return Ok(false);
    };

    let xml = {
        let show = state.show_state.read();
        serialize_show_xml(&show).map_err(|e| e.to_string())?
    };
    std::fs::write(&target_path, xml)
        .map_err(|e| format!("Failed to write project file '{}': {e}", target_path.display()))?;
    *state.current_project_path.lock() = Some(target_path.clone());
    state.on_project_saved(&target_path);
    state.record_recent_project(&target_path);
    Ok(true)
}

#[tauri::command]
fn set_bank_color_command(
    state: State<'_, AppState>,
    bank_name: String,
    color: Option<String>,
) -> ShowSnapshotDto {
    state.set_bank_color(&bank_name, color)
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

#[derive(Debug, Clone, Serialize)]
pub struct AudioFileBytesDto {
    pub resolved_path: String,
    pub file_name: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedAudioMatchDto {
    pub requested: String,
    pub resolved_path: String,
    pub file_name: String,
}

fn collect_files_recursive(dir: &std::path::Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            out.push(path);
        } else if path.is_dir() && depth > 0 {
            collect_files_recursive(&path, depth - 1, out);
        }
    }
}

fn normalize_display_path(p: &std::path::Path) -> String {
    let canonical = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let raw = canonical.to_string_lossy();
    if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        raw.into_owned()
    }
}

#[tauri::command]
async fn pick_audio_file_command(title: Option<String>) -> Result<Option<String>, String> {
    let dialog_title = title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "Select Audio File".to_string());
    let picked = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(&dialog_title)
            .add_filter(
                "Audio Files",
                &["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"],
            )
            .pick_file()
    })
    .await
    .map_err(|e| format!("Failed to open audio file dialog: {e}"))?;

    Ok(picked.map(|p| normalize_display_path(&p)))
}

#[tauri::command]
async fn pick_audio_folder_command(title: Option<String>) -> Result<Option<String>, String> {
    let dialog_title = title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "Select Music Folder".to_string());
    let picked = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(&dialog_title)
            .pick_folder()
    })
    .await
    .map_err(|e| format!("Failed to open folder dialog: {e}"))?;

    Ok(picked.map(|p| normalize_display_path(&p)))
}

#[tauri::command]
fn read_audio_file_bytes_command(path: String) -> Result<AudioFileBytesDto, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_file() {
        return Err(format!("Audio file not found: {}", p.display()));
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("Failed to read audio file: {e}"))?;
    let resolved_path = normalize_display_path(&p);
    let file_name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("audio")
        .to_string();
    Ok(AudioFileBytesDto {
        resolved_path,
        file_name,
        bytes,
    })
}

#[tauri::command]
fn resolve_audio_in_folder_command(
    folder_path: String,
    file_names: Vec<String>,
) -> Result<Vec<ResolvedAudioMatchDto>, String> {
    let dir = PathBuf::from(folder_path.trim());
    if !dir.is_dir() {
        return Err(format!("Folder not found: {}", dir.display()));
    }
    let mut candidates = Vec::new();
    collect_files_recursive(&dir, 2, &mut candidates);

    let mut by_lower_name: std::collections::HashMap<String, PathBuf> =
        std::collections::HashMap::new();
    for path in candidates {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            by_lower_name
                .entry(name.to_ascii_lowercase())
                .or_insert(path);
        }
    }

    let mut matches = Vec::new();
    for requested in file_names {
        let base = PathBuf::from(&requested)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&requested)
            .to_ascii_lowercase();
        if let Some(found) = by_lower_name.get(&base) {
            let resolved_path = normalize_display_path(found);
            let file_name = found
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&requested)
                .to_string();
            matches.push(ResolvedAudioMatchDto {
                requested,
                resolved_path,
                file_name,
            });
        }
    }
    Ok(matches)
}

#[tauri::command]
fn read_audio_file_raw_command(path: String) -> Result<IpcResponse, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_file() {
        return Err(format!("Audio file not found: {}", p.display()));
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("Failed to read audio file: {e}"))?;
    Ok(IpcResponse::new(bytes))
}

#[tauri::command]
fn set_identified_fixture_command(
    state: State<'_, AppState>,
    fixture_id: Option<String>,
) -> EngineSnapshotDto {
    state.set_identified_fixture(fixture_id)
}

#[tauri::command]
fn publish_audio_clock_snapshot_command(
    state: State<'_, AppState>,
    samples_played: Option<u64>,
    sample_rate: Option<u32>,
    buffer_duration_ms: Option<f64>,
    is_playing: bool,
) {
    state.publish_audio_clock_snapshot(samples_played, sample_rate, buffer_duration_ms, is_playing);
}

#[tauri::command]
fn set_autosave_enabled_command(state: State<'_, AppState>, enabled: bool) -> bool {
    state.set_autosave_enabled(enabled)
}

#[tauri::command]
fn check_autosave_recovery_command(state: State<'_, AppState>) -> bool {
    state.check_startup_autosave_recovery()
}

#[tauri::command]
fn recover_autosave_command(state: State<'_, AppState>) -> Result<ShowSnapshotDto, String> {
    state.recover_autosave()
}

#[tauri::command]
fn discard_autosave_command(state: State<'_, AppState>) -> Result<(), String> {
    state.discard_autosave()
}

#[tauri::command]
fn set_key_binding_command(
    state: State<'_, AppState>,
    target_id: String,
    key: Option<String>,
) -> ShowSnapshotDto {
    state.set_key_binding(&target_id, key)
}

#[tauri::command]
fn set_group_mixer_strip_command(
    state: State<'_, AppState>,
    group_id: String,
    strip: Option<GroupMixerStripDef>,
) -> ShowSnapshotDto {
    state.set_group_mixer_strip(&group_id, strip)
}

#[tauri::command]
fn log_frontend_error(level: String, message: String) {
    let normalized = match level.to_ascii_uppercase().as_str() {
        "INFO" => "INFO",
        "WARN" | "WARNING" => "WARN",
        _ => "ERROR",
    };
    logging::write_log(normalized, &format!("[UI] {message}"));
}

#[tauri::command]
fn close_splashscreen(app: tauri::AppHandle) {
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some(app_data) = resolve_app_data_dir() {
        logging::init_logging(app_data.join("logs"));
    }
    let app_state = AppState::new(true);
    app_state.seed_default_studio_show();

    let app = tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            // Only fall back to Tauri's app_config_dir when resolve_app_data_dir() could not resolve one,
            // keeping fixtures/, recent_projects.txt, and untitled autosaves unified in one folder.
            if let Some(state) = app.try_state::<AppState>() {
                let needs_fallback = state.recent_projects_file.lock().is_none();
                if needs_fallback {
                    if let Ok(config_dir) = app.path().app_config_dir() {
                        let recent_file = config_dir.join("recent_projects.txt");
                        let loaded = load_recent_projects_from_file(&recent_file);
                        if !loaded.is_empty() {
                            *state.recent_projects.lock() = loaded;
                        }
                        *state.recent_projects_file.lock() = Some(recent_file);
                        *state.fallback_autosave_path.lock() =
                            Some(config_dir.join("untitled.takt.xml"));
                    }
                }
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(6));
                if let Some(splash) = handle.get_webview_window("splashscreen") {
                    let _ = splash.close();
                }
                if let Some(main) = handle.get_webview_window("main") {
                    let _ = main.show();
                }
            });
            Ok(())
        })
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
            open_project_file_command,
            open_project_path_command,
            new_project_command,
            get_recent_projects_command,
            save_project_file_command,
            save_project_as_command,
            set_bank_color_command,
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
            pick_audio_file_command,
            pick_audio_folder_command,
            read_audio_file_bytes_command,
            read_audio_file_raw_command,
            resolve_audio_in_folder_command,
            set_identified_fixture_command,
            publish_audio_clock_snapshot_command,
            set_autosave_enabled_command,
            check_autosave_recovery_command,
            recover_autosave_command,
            discard_autosave_command,
            set_key_binding_command,
            set_group_mixer_strip_command,
            log_frontend_error,
            close_splashscreen,
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

    const TEST_TUBE_8SEG_JSON: &str = r#"{
  "$schema": "https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/fixture.json",
  "name": "Test 8-Segment RGBW Tube",
  "shortName": "Test-8Px",
  "categories": ["Pixel Bar", "Color Changer"],
  "meta": {
    "authors": ["Test Suite"],
    "createDate": "2026-11-17",
    "lastModifyDate": "2026-11-18"
  },
  "matrix": {
    "pixelCount": [8, 1, 1],
    "pixelGroups": { "All": "all" }
  },
  "availableChannels": {
    "Master Dimmer": { "defaultValue": 0, "capability": { "type": "Intensity" } },
    "Strobe": {
      "defaultValue": 0,
      "capabilities": [
        { "dmxRange": [0, 7], "type": "ShutterStrobe", "shutterEffect": "Closed" },
        { "dmxRange": [8, 15], "type": "ShutterStrobe", "shutterEffect": "Open" },
        { "dmxRange": [16, 200], "type": "ShutterStrobe", "shutterEffect": "Strobe", "speedStart": "1Hz", "speedEnd": "20Hz" },
        { "dmxRange": [201, 255], "type": "ShutterStrobe", "shutterEffect": "Strobe", "randomTiming": true, "speedStart": "1Hz", "speedEnd": "20Hz" }
      ]
    },
    "Red": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "Red" } },
    "Green": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "Green" } },
    "Blue": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "Blue" } },
    "White": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "White" } }
  },
  "templateChannels": {
    "Red $pixelKey": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "Red" } },
    "Green $pixelKey": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "Green" } },
    "Blue $pixelKey": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "Blue" } },
    "White $pixelKey": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "White" } }
  },
  "modes": [
    {
      "name": "34ch Pixel Mode",
      "shortName": "34ch",
      "channels": [
        "Master Dimmer",
        "Strobe",
        {
          "insert": "matrixChannels",
          "repeatFor": "eachPixelABC",
          "channelOrder": "perPixel",
          "templateChannels": ["Red $pixelKey", "Green $pixelKey", "Blue $pixelKey", "White $pixelKey"]
        }
      ]
    },
    {
      "name": "6ch Basic Mode",
      "shortName": "6ch",
      "channels": ["Master Dimmer", "Strobe", "Red", "Green", "Blue", "White"]
    }
  ]
}"#;

    fn new_test_state_with_tube() -> AppState {
        let state = AppState::new(false);
        state
            .save_fixture("test_tube_8seg", TEST_TUBE_8SEG_JSON)
            .expect("register test 8-segment tube fixture");
        state
    }

    #[test]
    fn resolve_default_fixtures_dir_uses_writable_app_data_location() {
        let dir = resolve_default_fixtures_dir().expect("resolved fixtures dir");
        assert!(dir.is_absolute(), "fixtures dir must be absolute: {dir:?}");
        assert_eq!(dir.file_name().and_then(|s| s.to_str()), Some("fixtures"));

        let recent = resolve_default_recent_projects_file().expect("resolved recent projects file");
        assert_eq!(
            dir.parent(),
            recent.parent(),
            "fixtures and recent projects must share the same TaktLight app-data root"
        );
    }

    #[test]
    fn app_state_lists_validates_saves_and_deletes_ofl_fixtures() {
        let temp_dir = std::env::temp_dir().join(format!(
            "taktlight_tauri_ofl_test_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&temp_dir);

        let state = AppState::new_with_fixtures_dir(false, Some(temp_dir.clone()));
        assert!(temp_dir.join("user").exists());
        let summaries = state.fixture_library.read().list_summaries();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "standard/rlcv3.json");

        let validation = AppState::validate_fixture(TEST_TUBE_8SEG_JSON);
        assert!(validation.valid);
        assert_eq!(validation.pixel_count, 8);
        assert_eq!(validation.expanded_modes[0].channel_count, 34);

        let bad_validation = AppState::validate_fixture("{\"name\": \"\"}");
        assert!(!bad_validation.valid);
        assert!(!bad_validation.issues.is_empty());

        let saved = state
            .save_fixture("my_custom_tube", TEST_TUBE_8SEG_JSON)
            .expect("valid user fixture saved");
        assert_eq!(saved.summary.id, "user/my_custom_tube.json");

        assert_eq!(state.fixture_library.read().list_summaries().len(), 2);
        state
            .fixture_library
            .write()
            .delete_user_fixture("user/my_custom_tube.json")
            .unwrap();
        assert_eq!(state.fixture_library.read().list_summaries().len(), 1);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn app_state_patches_moves_undoes_and_recompiles_render_plan() {
        let state = new_test_state_with_tube();
        state.show_state.write().network_outputs.universes[1] = UniverseConfig::new(
            2,
            taktlight_engine::state::plan::ProtocolKind::Sacn {
                mode: taktlight_engine::state::plan::SacnOutputMode::Multicast,
                sacn_universe: 2,
                priority: 100,
            },
        );
        let snap = state
            .patch_fixtures(
                "user/test_tube_8seg.json",
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

        let state = new_test_state_with_tube();
        state
            .patch_fixtures(
                "user/test_tube_8seg.json",
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

        let state = new_test_state_with_tube();
        state
            .patch_fixtures(
                "user/test_tube_8seg.json",
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
                timeline_ref: None,
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
                timeline_ref: None,
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
                    loop_timeline: false,
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
                            ..Default::default()
                        }],
                        ..Default::default()
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

    #[test]
    fn audio_file_check_and_folder_relink_commands_resolve_and_report_missing() {
        let dir = std::env::temp_dir().join(format!(
            "taktlight_audio_cmd_test_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let sub = dir.join("stems");
        std::fs::create_dir_all(&sub).unwrap();
        let track_path = sub.join("Intro.WAV");
        std::fs::write(&track_path, b"RIFFtestbytes").unwrap();

        // Direct read succeeds for existing file and fails for missing file
        let ok = read_audio_file_bytes_command(track_path.to_string_lossy().to_string()).unwrap();
        assert_eq!(ok.file_name, "Intro.WAV");
        assert_eq!(ok.bytes, b"RIFFtestbytes");
        assert!(!ok.resolved_path.starts_with(r"\\?\"));
        assert!(read_audio_file_bytes_command(
            dir.join("does_not_exist.wav").to_string_lossy().to_string()
        )
        .is_err());

        // Folder scan matches case-insensitively across nested subfolders
        let matches = resolve_audio_in_folder_command(
            dir.to_string_lossy().to_string(),
            vec![
                "C:\\Old\\intro.wav".to_string(),
                "C:\\Old\\missing.mp3".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].requested, "C:\\Old\\intro.wav");
        assert_eq!(matches[0].file_name, "Intro.WAV");
        assert!(!matches[0].resolved_path.starts_with(r"\\?\"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn app_state_xml_export_import_roundtrip_and_malformed_rejection() {
        let state = new_test_state_with_tube();
        state
            .patch_fixtures(
                "user/test_tube_8seg.json",
                "34ch Pixel Mode",
                "Tube XML",
                1,
                1,
                1,
                true,
            )
            .unwrap();
        let xml = serialize_show_xml(&state.show_state.read()).expect("export XML");
        assert!(xml.contains("Tube XML"));

        let fresh = new_test_state_with_tube();
        let imported = fresh.import_show_xml(&xml).expect("import exported XML");
        assert_eq!(imported.show.patch.len(), 1);
        assert_eq!(imported.show.patch[0].name, "Tube XML");
        assert_eq!(fresh.plan.load().cell_count, 8);

        assert!(fresh.import_show_xml("<TaktLightShow><broken").is_err());
        assert!(fresh.import_show_xml("<WrongRoot />").is_err());
    }

    #[test]
    fn app_state_resolves_splits_configures_universes_manages_bank_colors_and_deletions() {
        use taktlight_engine::state::plan::{ProtocolKind, SacnOutputMode};

        let state = new_test_state_with_tube();
        state.seed_default_studio_show();

        // Patch a split fixture straddling U1.505 -> U2 and resolve splits
        state
            .patch_fixtures(
                "user/test_tube_8seg.json",
                "34ch Pixel Mode",
                "SplitTube",
                1,
                1,
                505,
                true,
            )
            .unwrap();
        let resolved = state.resolve_split_fixtures().unwrap();
        assert!(resolved
            .show
            .patch
            .iter()
            .all(|f| f.address + f.channel_count - 1 <= 512));

        // Configure universe 2 as sACN
        let u2 = UniverseConfig::new(
            2,
            ProtocolKind::Sacn {
                mode: SacnOutputMode::Multicast,
                sacn_universe: 2,
                priority: 120,
            },
        );
        let cfg_snap = state.configure_universe(u2).unwrap();
        assert!(matches!(
            cfg_snap.show.network_outputs.universes.iter().find(|u| u.id == 2).unwrap().protocol,
            ProtocolKind::Sacn { priority: 120, .. }
        ));

        // Bank color set & clear
        let colored = state.set_bank_color("Bank 1", Some("#FF5500".into()));
        assert_eq!(
            colored.show.bank_colors.get("Bank 1").map(|s| s.as_str()),
            Some("#FF5500")
        );
        let cleared = state.set_bank_color("Bank 1", None);
        assert!(!cleared.show.bank_colors.contains_key("Bank 1"));

        // Delete scene, fx_block, palette, group, and timeline cleanly
        let first_scene_id = state.show_state.read().scenes[0].id.clone();
        state.delete_scene(&first_scene_id).unwrap();
        assert!(state.show_state.read().scenes.is_empty());
        state.undo().unwrap();
        assert_eq!(state.show_state.read().scenes.len(), 1);

        let first_cp_id = state.show_state.read().color_palettes[0].id.clone();
        state.delete_color_palette(&first_cp_id).unwrap();
        state.undo().unwrap();

        state
            .upsert_group(FixtureGroupDef {
                id: "grp_del".into(),
                name: "Temp".into(),
                order: taktlight_engine::show::spatial::OrderRule::Linear,
                targets: vec![],
            })
            .unwrap();
        state.delete_group("grp_del").unwrap();
        assert!(state.show_state.read().groups.is_empty());

        state
            .upsert_fx_block(FxBlockDef {
                id: "blk_del".into(),
                name: "Temp".into(),
                target_group: Some("all".into()),
                duration_beats: 4.0,
                duration_sec: None,
                loop_block: true,
                elements: vec![],
            })
            .unwrap();
        state.delete_fx_block("blk_del").unwrap();
        assert!(state.show_state.read().fx_library.is_empty());

        state
            .upsert_timeline(
                TimelineDef {
                    id: "tl_del".into(),
                    name: "Temp TL".into(),
                    duration_sec: 8.0,
                    grid_offset_sec: 0.0,
                    tempo_map: vec![],
                    audio_track: None,
                    loop_timeline: false,
                    tracks: vec![],
                },
                None,
            )
            .unwrap();
        state.delete_timeline("tl_del").unwrap();
        assert!(state.show_state.read().timelines.is_empty());
    }

    #[test]
    fn new_project_and_recent_projects_manage_lifecycle_and_dedup() {
        let dir = std::env::temp_dir().join(format!(
            "taktlight_project_lifecycle_test_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let state = new_test_state_with_tube();
        *state.recent_projects_file.lock() = Some(dir.join("recent.txt"));
        state.seed_default_studio_show();
        state
            .patch_fixtures(
                "user/test_tube_8seg.json",
                "34ch Pixel Mode",
                "LifecycleTube",
                1,
                1,
                1,
                true,
            )
            .unwrap();

        let p1 = dir.join("alpha.takt.xml");
        let p2 = dir.join("beta.takt.xml");
        let xml = serialize_show_xml(&state.show_state.read()).unwrap();
        std::fs::write(&p1, &xml).unwrap();
        std::fs::write(&p2, &xml).unwrap();

        // Open p1 then p2 then p1 again -> deduplicated, p1 first
        state.open_project_path(&p1).unwrap();
        state.open_project_path(&p2).unwrap();
        state.open_project_path(&p1).unwrap();

        let recent = state.get_recent_projects();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0], p1.to_string_lossy().to_string());
        assert_eq!(recent[1], p2.to_string_lossy().to_string());

        // Missing path returns a clear error
        assert!(state.open_project_path(&dir.join("does_not_exist.takt.xml")).is_err());

        // new_project resets patch, undo, current_project_path, and keeps 1 default scene
        let reset_snap = state.new_project();
        assert!(reset_snap.show.patch.is_empty());
        assert_eq!(reset_snap.show.scenes.len(), 1);
        assert!(!reset_snap.can_undo);
        assert!(state.current_project_path.lock().is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn autosave_audio_clock_locate_and_bindings_persist_cleanly() {
        let dir = std::env::temp_dir().join(format!(
            "taktlight_enhancements_test_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let state = AppState::new(false);
        state.seed_default_studio_show();
        let show_path = dir.join("live.takt.xml");
        let initial_xml = serialize_show_xml(&state.show_state.read()).unwrap();
        std::fs::write(&show_path, &initial_xml).unwrap();
        *state.current_project_path.lock() = Some(show_path.clone());

        // Key bindings & group mixer strips round-trip through XML
        state.set_key_binding("sc_new_1", Some("F1".into()));
        state.set_group_mixer_strip(
            "all",
            Some(GroupMixerStripDef {
                dimmer: 0.75,
                hue_shift_deg: 30.0,
                saturation: 1.2,
                strobe_enabled: false,
                strobe_hz: 8.0,
                mode: "normal".into(),
            }),
        );
        let xml = serialize_show_xml(&state.show_state.read()).unwrap();
        let roundtrip = deserialize_show_xml(&xml).unwrap();
        assert_eq!(roundtrip.key_bindings.get("sc_new_1").map(String::as_str), Some("F1"));
        assert!((roundtrip.group_mixer_strips["all"].dimmer - 0.75).abs() < 1e-5);

        // Autosave triggers silently after 20 dirty revisions (must NOT show recovery banner mid-session!)
        let mut last_snap = None;
        for i in 0..20 {
            last_snap = Some(
                state
                    .upsert_dimmer_palette(DimmerPaletteDef {
                        id: format!("dim_auto_{i}"),
                        name: format!("Auto {i}"),
                        value_start: 0.5,
                        value_end: 0.5,
                    })
                    .unwrap(),
            );
        }
        assert!(
            !last_snap.unwrap().has_autosave_recovery,
            "mid-session autosave must not trigger recovery banner while actively editing"
        );
        // On reopen / restart, recovery IS detected and restores unsaved changes
        let reopened = state.open_project_path(&show_path).unwrap();
        assert!(reopened.has_autosave_recovery);
        assert!(state.has_autosave_recovery());
        let recovered = state.recover_autosave().unwrap();
        assert!(!recovered.has_autosave_recovery);
        assert!(recovered
            .show
            .dimmer_palettes
            .iter()
            .any(|p| p.id == "dim_auto_19"));

        // Disabling autosave prevents writing sidecars
        assert!(!state.set_autosave_enabled(false));
        for i in 0..25 {
            let _ = state.upsert_dimmer_palette(DimmerPaletteDef {
                id: format!("dim_off_{i}"),
                name: format!("Off {i}"),
                value_start: 0.4,
                value_end: 0.4,
            });
        }
        assert!(!AutosaveManager::autosave_path(&show_path).exists());
        assert!(state.set_autosave_enabled(true));

        // Locate / Identify sets runtime field and surfaces in EngineSnapshotDto
        let loc_snap = state.set_identified_fixture(Some("fx_001".into()));
        assert_eq!(loc_snap.identified_fixture_id.as_deref(), Some("fx_001"));
        let clear_snap = state.set_identified_fixture(None);
        assert!(clear_snap.identified_fixture_id.is_none());

        // Audio clock publishes and clears snapshots
        state.publish_audio_clock_snapshot(Some(48_000), Some(48_000), Some(20.0), true);
        assert!(state.audio_clock.latest_snapshot().is_some());
        state.publish_audio_clock_snapshot(None, None, None, false);
        assert!(state.audio_clock.latest_snapshot().is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
