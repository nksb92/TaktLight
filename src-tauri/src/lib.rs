use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use arc_swap::ArcSwap;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, RunEvent, State};
use tokio::sync::watch;

use taktlight_engine::engine::runner::{
    spawn_engine_loop, EngineConfig, EngineRunnerHandle, EngineTelemetrySnapshot,
};
use taktlight_engine::frame::flow::FrameCreditGate;
use taktlight_engine::ofl::expander::ExpandedFixtureMode;
use taktlight_engine::ofl::library::{
    validate_and_parse_ofl, FixtureDetail, FixtureLibrary, FixtureSummary, SaveFixtureError,
};
use taktlight_engine::ofl::validator::SchemaValidationIssue;
use taktlight_engine::protocol::artnet::TrackedArtNetNode;
use taktlight_engine::protocol::nic::{
    enumerate_ipv4_interfaces, AdapterSelection, NetworkInterfaceInfo,
};
use taktlight_engine::state::plan::{RenderPlan, UniverseConfig};
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
    pub universes: Vec<UniverseConfig>,
    pub interfaces: Vec<NetworkInterfaceInfo>,
    pub adapter_selection: AdapterSelection,
    pub is_offline: bool,
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
        let plan = Arc::new(ArcSwap::from_pointee(RenderPlan::default_studio_plan()));
        let runtime = Arc::new(ArcSwap::from_pointee(RuntimeControl::new()));
        let credit_gate = FrameCreditGate::new(true);
        let (frame_tx, frame_rx) = watch::channel(Vec::new());
        let telemetry = Arc::new(RwLock::new(EngineTelemetrySnapshot {
            is_offline: true,
            ..Default::default()
        }));
        let adapter_selection = Arc::new(RwLock::new(AdapterSelection::Auto));
        let fixture_library = RwLock::new(FixtureLibrary::load(fixtures_dir.as_deref()));

        let engine_handle = if start_engine_thread {
            Some(spawn_engine_loop(
                EngineConfig::default(),
                Arc::clone(&plan),
                Arc::clone(&runtime),
                frame_tx,
                Arc::clone(&telemetry),
                AdapterSelection::Auto,
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

        EngineSnapshotDto {
            grand_master: rt.grand_master,
            blackout: rt.blackout,
            parked_channels,
            universes: plan.universes.clone(),
            interfaces: enumerate_ipv4_interfaces(),
            adapter_selection: selection,
            is_offline: tel.is_offline,
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
                break;
            }
            if channel.send(InvokeResponseBody::Raw(frame_bytes)).is_err() {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new(true);

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
            list_fixtures,
            get_fixture_detail,
            validate_fixture_json,
            save_user_fixture,
            delete_user_fixture,
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
    fn app_state_updates_runtime_controls_and_snapshot() {
        let state = AppState::new(false);
        state
            .update_runtime(|rt| rt.set_park(1, 12, Some(220)))
            .unwrap();
        state.update_runtime(|rt| rt.set_blackout(true));
        state.update_runtime(|rt| rt.set_grand_master(0.75));

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
}
