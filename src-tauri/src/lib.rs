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
}

impl AppState {
    pub fn new(start_engine_thread: bool) -> Self {
        let plan = Arc::new(ArcSwap::from_pointee(RenderPlan::default_studio_plan()));
        let runtime = Arc::new(ArcSwap::from_pointee(RuntimeControl::new()));
        let credit_gate = FrameCreditGate::new(true);
        let (frame_tx, frame_rx) = watch::channel(Vec::new());
        let telemetry = Arc::new(RwLock::new(EngineTelemetrySnapshot {
            is_offline: true,
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
}
