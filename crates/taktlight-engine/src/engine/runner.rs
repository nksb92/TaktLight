use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use parking_lot::RwLock;
use spin_sleep::SpinSleeper;
use tokio::sync::watch;

use crate::engine::evaluator::{ClockInput, Engine, EvaluatedFrame, QuantizerState};
use crate::frame::binary::{
    encode_binary_frame, FrameSnapshot, BINARY_FRAME_LAYOUT_VERSION,
};
use crate::protocol::artnet::{
    build_artdmx_packet, build_artpoll_packet, build_artsync_packet, next_artnet_sequence,
    parse_artpoll_reply, NodeDiscoveryTracker, TrackedArtNetNode, ARTNET_PORT,
};
use crate::protocol::nic::{
    enumerate_ipv4_interfaces, resolve_adapter, AdapterSelection, NetworkInterfaceInfo,
};
use crate::protocol::sacn::{
    build_sacn_data_packet, build_sacn_stream_termination_sequence,
    build_sacn_universe_discovery_pages, sacn_multicast_ip, SACN_DISCOVERY_UNIVERSE, SACN_PORT,
};
use crate::protocol::sink::{OfflineSink, PacketSink, SinkChannel, UdpSocketSink};
use crate::protocol::ProtocolError;
use crate::state::plan::{ArtNetOutputMode, ProtocolKind, RenderPlan, SacnOutputMode};
use crate::state::runtime::RuntimeControl;
use crate::telemetry::jitter::{JitterStats, JitterTracker, FRAME_PERIOD_US};

pub const ARTPOLL_INTERVAL_SEC: f64 = 2.5;
pub const SACN_DISCOVERY_INTERVAL_SEC: f64 = 10.0;
pub const SACN_TERMINATION_GAP: Duration = Duration::from_millis(20);

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub cid: [u8; 16],
    pub source_name: String,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            cid: *uuid::Uuid::new_v4().as_bytes(),
            source_name: "TaktLight".to_string(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct EngineTelemetrySnapshot {
    pub jitter_stats: JitterStats,
    pub jitter_samples_us: Vec<f32>,
    pub is_offline: bool,
    pub discovery_available: bool,
    pub active_interface: Option<NetworkInterfaceInfo>,
    pub discovered_nodes: Vec<TrackedArtNetNode>,
}

#[derive(Debug, Clone)]
struct ActiveSacnStream {
    sacn_universe: u16,
    priority: u8,
    target: SocketAddr,
    last_sequence: u8,
}

pub struct TickTransmitter {
    cid: [u8; 16],
    source_name: String,
    artnet_sequences: HashMap<u16, u8>,
    sacn_streams: HashMap<u16, ActiveSacnStream>,
    last_artpoll_sec: Option<f64>,
    last_sacn_discovery_sec: Option<f64>,
    discovery_tracker: NodeDiscoveryTracker,
}

impl TickTransmitter {
    pub fn new(cid: [u8; 16], source_name: impl Into<String>) -> Self {
        Self {
            cid,
            source_name: source_name.into(),
            artnet_sequences: HashMap::new(),
            sacn_streams: HashMap::new(),
            last_artpoll_sec: None,
            last_sacn_discovery_sec: None,
            discovery_tracker: NodeDiscoveryTracker::new(),
        }
    }

    pub fn discovered_nodes(&self) -> Vec<TrackedArtNetNode> {
        self.discovery_tracker.nodes()
    }

    pub fn transmit_frame(
        &mut self,
        plan: &RenderPlan,
        frame: &EvaluatedFrame,
        sink: &mut dyn PacketSink,
        termination_gap: Option<Duration>,
    ) -> Result<(), ProtocolError> {
        // 1. Poll ArtPollReply packets and refresh discovery timeout status
        for (_addr, buf) in sink.poll_artnet_replies() {
            if let Ok(node) = parse_artpoll_reply(&buf) {
                self.discovery_tracker.record_reply(node, frame.t_sec);
            }
        }
        self.discovery_tracker.refresh_status(frame.t_sec);

        let broadcast_ip = sink
            .active_interface()
            .map(|i| i.broadcast)
            .unwrap_or(Ipv4Addr::BROADCAST);

        // Terminate any sACN universe that was removed from the plan
        let current_sacn_ids: Vec<u16> = plan
            .universes
            .iter()
            .filter_map(|u| match u.protocol {
                ProtocolKind::Sacn { .. } => Some(u.id),
                _ => None,
            })
            .collect();
        let removed_sacn_ids: Vec<u16> = self
            .sacn_streams
            .keys()
            .copied()
            .filter(|id| !current_sacn_ids.contains(id))
            .collect();
        for removed_id in removed_sacn_ids {
            if let Some(stream) = self.sacn_streams.remove(&removed_id) {
                self.send_stream_termination(&stream, sink, termination_gap)?;
            }
        }

        let mut sent_any_artnet = false;

        // 2. Transmit per-universe DMX packets
        for (uni_cfg, eval_uni) in plan.universes.iter().zip(frame.universes.iter()) {
            match &uni_cfg.protocol {
                ProtocolKind::ArtNet {
                    mode,
                    net,
                    subnet,
                    uni,
                } => {
                    let prev_seq = self.artnet_sequences.get(&uni_cfg.id).copied().unwrap_or(0);
                    let seq = next_artnet_sequence(prev_seq);
                    self.artnet_sequences.insert(uni_cfg.id, seq);

                    let pkt = build_artdmx_packet(seq, 0, *net, *subnet, *uni, &eval_uni.dmx);
                    let target_ip = match mode {
                        ArtNetOutputMode::Broadcast => broadcast_ip,
                        ArtNetOutputMode::Unicast { target_ip } => *target_ip,
                    };
                    let target = SocketAddr::V4(SocketAddrV4::new(target_ip, ARTNET_PORT));
                    sink.send_to(SinkChannel::ArtNet, &pkt, target)?;
                    sent_any_artnet = true;
                }
                ProtocolKind::Sacn {
                    mode,
                    sacn_universe,
                    priority,
                } => {
                    let seq = self
                        .sacn_streams
                        .get(&uni_cfg.id)
                        .map(|s| s.last_sequence.wrapping_add(1))
                        .unwrap_or(0);
                    let target_ip = match mode {
                        SacnOutputMode::Multicast => sacn_multicast_ip(*sacn_universe)?,
                        SacnOutputMode::Unicast { target_ip } => *target_ip,
                    };
                    let target = SocketAddr::V4(SocketAddrV4::new(target_ip, SACN_PORT));
                    let pkt = build_sacn_data_packet(
                        &self.cid,
                        &self.source_name,
                        *priority,
                        seq,
                        0x00,
                        *sacn_universe,
                        &eval_uni.dmx,
                    )?;
                    sink.send_to(SinkChannel::Sacn, &pkt, target)?;
                    self.sacn_streams.insert(
                        uni_cfg.id,
                        ActiveSacnStream {
                            sacn_universe: *sacn_universe,
                            priority: *priority,
                            target,
                            last_sequence: seq,
                        },
                    );
                }
            }
        }

        // 3. ArtSync once per tick after all ArtDmx packets
        if sent_any_artnet && plan.artsync_enabled {
            let sync_pkt = build_artsync_packet();
            let target = SocketAddr::V4(SocketAddrV4::new(broadcast_ip, ARTNET_PORT));
            sink.send_to(SinkChannel::ArtNet, &sync_pkt, target)?;
        }

        // 4. Periodic ArtPoll every 2.5 seconds
        let should_artpoll = match self.last_artpoll_sec {
            None => true,
            Some(prev) => (frame.t_sec - prev) >= ARTPOLL_INTERVAL_SEC,
        };
        if should_artpoll && !sink.is_offline() {
            let poll_pkt = build_artpoll_packet(0x02, 0x00);
            let target = SocketAddr::V4(SocketAddrV4::new(broadcast_ip, ARTNET_PORT));
            sink.send_to(SinkChannel::ArtNet, &poll_pkt, target)?;
            self.last_artpoll_sec = Some(frame.t_sec);
        }

        // 5. Periodic sACN Universe Discovery every 10 seconds
        let should_sacn_discovery = match self.last_sacn_discovery_sec {
            None => true,
            Some(prev) => (frame.t_sec - prev) >= SACN_DISCOVERY_INTERVAL_SEC,
        };
        if should_sacn_discovery && !self.sacn_streams.is_empty() && !sink.is_offline() {
            let active_universes: Vec<u16> =
                self.sacn_streams.values().map(|s| s.sacn_universe).collect();
            let pages = build_sacn_universe_discovery_pages(
                &self.cid,
                &self.source_name,
                &active_universes,
            );
            let discovery_ip = sacn_multicast_ip(SACN_DISCOVERY_UNIVERSE)?;
            let target = SocketAddr::V4(SocketAddrV4::new(discovery_ip, SACN_PORT));
            for page in pages {
                sink.send_to(SinkChannel::Sacn, &page, target)?;
            }
            self.last_sacn_discovery_sec = Some(frame.t_sec);
        }

        Ok(())
    }

    fn send_stream_termination(
        &self,
        stream: &ActiveSacnStream,
        sink: &mut dyn PacketSink,
        gap: Option<Duration>,
    ) -> Result<(), ProtocolError> {
        let burst = build_sacn_stream_termination_sequence(
            &self.cid,
            &self.source_name,
            stream.priority,
            stream.last_sequence,
            stream.sacn_universe,
        )?;
        for (idx, pkt) in burst.iter().enumerate() {
            sink.send_to(SinkChannel::Sacn, pkt, stream.target)?;
            if idx < 2 {
                if let Some(d) = gap {
                    if !d.is_zero() {
                        std::thread::sleep(d);
                    }
                }
            }
        }
        Ok(())
    }

    pub fn terminate_all_sacn(
        &mut self,
        sink: &mut dyn PacketSink,
        gap: Option<Duration>,
    ) -> Result<(), ProtocolError> {
        let streams: Vec<ActiveSacnStream> = self.sacn_streams.drain().map(|(_, s)| s).collect();
        for stream in streams {
            self.send_stream_termination(&stream, sink, gap)?;
        }
        Ok(())
    }
}

pub enum EngineCommand {
    SetAdapter(AdapterSelection),
    Shutdown,
}

pub struct EngineRunnerHandle {
    cmd_tx: Sender<EngineCommand>,
    join_handle: Option<JoinHandle<JitterStats>>,
}

impl EngineRunnerHandle {
    pub fn set_adapter(&self, selection: AdapterSelection) -> Result<(), String> {
        self.cmd_tx
            .send(EngineCommand::SetAdapter(selection))
            .map_err(|e| format!("failed to send adapter command: {e}"))
    }

    pub fn shutdown(mut self) -> JitterStats {
        let _ = self.cmd_tx.send(EngineCommand::Shutdown);
        if let Some(handle) = self.join_handle.take() {
            handle.join().unwrap_or_default()
        } else {
            JitterStats::default()
        }
    }
}

impl Drop for EngineRunnerHandle {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(EngineCommand::Shutdown);
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
    }
}

pub fn create_sink_for_selection(selection: &AdapterSelection) -> Box<dyn PacketSink> {
    let interfaces = enumerate_ipv4_interfaces();
    match resolve_adapter(&interfaces, selection) {
        Some(iface) => match UdpSocketSink::bind(iface) {
            Ok(sink) => Box::new(sink),
            Err(_) => Box::new(OfflineSink),
        },
        None => Box::new(OfflineSink),
    }
}

pub fn spawn_engine_loop(
    config: EngineConfig,
    plan: Arc<ArcSwap<RenderPlan>>,
    runtime: Arc<ArcSwap<RuntimeControl>>,
    frame_tx: watch::Sender<Vec<u8>>,
    telemetry: Arc<RwLock<EngineTelemetrySnapshot>>,
    initial_selection: AdapterSelection,
) -> EngineRunnerHandle {
    let (cmd_tx, cmd_rx) = mpsc::channel();
    let sink = create_sink_for_selection(&initial_selection);
    let join_handle = std::thread::Builder::new()
        .name("taktlight-44hz".into())
        .spawn(move || {
            run_realtime_loop_with_sink(
                config, plan, runtime, frame_tx, telemetry, sink, cmd_rx, None,
            )
        })
        .expect("failed to spawn taktlight-44hz thread");

    EngineRunnerHandle {
        cmd_tx,
        join_handle: Some(join_handle),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn run_realtime_loop_with_sink(
    config: EngineConfig,
    plan: Arc<ArcSwap<RenderPlan>>,
    runtime: Arc<ArcSwap<RuntimeControl>>,
    frame_tx: watch::Sender<Vec<u8>>,
    telemetry: Arc<RwLock<EngineTelemetrySnapshot>>,
    mut sink: Box<dyn PacketSink>,
    cmd_rx: Receiver<EngineCommand>,
    max_duration: Option<Duration>,
) -> JitterStats {
    // 2 ms spin cushion prevents Windows WaitableTimer wakeups (>700 us) from overshooting the deadline
    let sleeper = SpinSleeper::new(2_000_000);
    let mut transmitter = TickTransmitter::new(config.cid, config.source_name);
    let mut jitter = JitterTracker::new();
    let mut quantizer_state = QuantizerState::default();

    let t0 = Instant::now();
    let mut tick_index: u64 = 0;
    let mut prev_post_send: Option<Instant> = None;

    loop {
        if let Some(limit) = max_duration {
            if t0.elapsed() >= limit {
                break;
            }
        }

        let mut should_shutdown = false;
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                EngineCommand::Shutdown => {
                    should_shutdown = true;
                }
                EngineCommand::SetAdapter(selection) => {
                    let _ = transmitter.terminate_all_sacn(&mut *sink, Some(SACN_TERMINATION_GAP));
                    sink = create_sink_for_selection(&selection);
                }
            }
        }
        if should_shutdown {
            break;
        }

        let deadline = t0 + Duration::from_micros(tick_index * FRAME_PERIOD_US);
        let now = Instant::now();
        let mut skipped_deadlines: u32 = 0;

        if now < deadline {
            sleeper.sleep(deadline - now);
        } else {
            let late_us = now.duration_since(deadline).as_micros() as u64;
            if late_us >= FRAME_PERIOD_US {
                let missed = late_us / FRAME_PERIOD_US;
                tick_index += missed;
                skipped_deadlines = missed as u32;
            }
        }

        let current_plan = plan.load();
        let current_runtime = runtime.load();
        let clock = ClockInput {
            t_sec: Instant::now().duration_since(t0).as_secs_f64(),
            frame_index: tick_index,
        };

        let evaluated = Engine::evaluate_frame(
            &current_plan,
            &clock,
            &current_runtime,
            &mut quantizer_state,
        );

        if transmitter
            .transmit_frame(&current_plan, &evaluated, &mut *sink, Some(SACN_TERMINATION_GAP))
            .is_err()
        {
            // Graceful offline fallback if network adapter drops mid-stream
            sink = Box::new(OfflineSink);
        }

        // Timestamp AFTER the last packet of the tick has been handed to the socket
        let post_send = Instant::now();
        if let Some(prev) = prev_post_send {
            let delta_us = post_send.duration_since(prev).as_secs_f64() * 1_000_000.0;
            jitter.record_interval_with_skipped(delta_us as f32, skipped_deadlines);
        }
        prev_post_send = Some(post_send);

        let stats = jitter.stats();
        let snapshot = FrameSnapshot {
            revision: evaluated.revision,
            t_sec: evaluated.t_sec,
            cell_count: current_plan.cell_count,
            dropped_frames: stats.dropped_frames,
            mean_us: stats.mean_us,
            max_jitter_us: stats.max_jitter_us,
            p99_jitter_us: stats.p99_jitter_us,
            layout_version: BINARY_FRAME_LAYOUT_VERSION,
            universe_count: evaluated.universes.len() as u16,
            universe_dmx: evaluated.universes.iter().map(|u| u.dmx).collect(),
            cell_preview_rgbd: evaluated.cell_preview_rgbd,
        };
        let encoded = encode_binary_frame(&snapshot);
        let _ = frame_tx.send(encoded);

        {
            let mut guard = telemetry.write();
            guard.jitter_stats = stats;
            guard.jitter_samples_us = jitter.samples();
            guard.is_offline = sink.is_offline();
            guard.discovery_available = sink.discovery_available();
            guard.active_interface = sink.active_interface().cloned();
            guard.discovered_nodes = transmitter.discovered_nodes();
        }

        tick_index += 1;
    }

    let _ = transmitter.terminate_all_sacn(&mut *sink, Some(SACN_TERMINATION_GAP));
    jitter.stats()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::artnet::{OPCODE_ARTDMX, OPCODE_ARTPOLL, OPCODE_ARTSYNC};
    use crate::protocol::sink::MockPacketSink;
    use crate::state::plan::UniverseConfig;

    #[test]
    fn transmitter_emits_artdmx_artsync_sacn_artpoll_and_discovery() {
        let mut plan = RenderPlan::default_studio_plan();
        plan.base_dmx[0][0] = 255;
        plan.base_dmx[1][10] = 128;

        let rt = RuntimeControl::new();
        let mut q = QuantizerState::default();
        let mut sink = MockPacketSink::new();
        let mut tx = TickTransmitter::new([0x44u8; 16], "TaktLightTest");

        // Tick at t=0.0 triggers ArtDmx, sACN Data, ArtSync, ArtPoll, sACN Discovery
        let f0 = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 0.0,
                frame_index: 0,
            },
            &rt,
            &mut q,
        );
        tx.transmit_frame(&plan, &f0, &mut sink, None).unwrap();

        assert_eq!(sink.sent.len(), 5);
        // 0: ArtDmx
        assert_eq!(sink.sent[0].0, SinkChannel::ArtNet);
        assert_eq!(sink.sent[0].2.len(), 530);
        assert_eq!(
            u16::from_le_bytes([sink.sent[0].2[8], sink.sent[0].2[9]]),
            OPCODE_ARTDMX
        );
        // 1: sACN Data
        assert_eq!(sink.sent[1].0, SinkChannel::Sacn);
        assert_eq!(sink.sent[1].2.len(), 638);
        // 2: ArtSync
        assert_eq!(sink.sent[2].0, SinkChannel::ArtNet);
        assert_eq!(sink.sent[2].2.len(), 14);
        assert_eq!(
            u16::from_le_bytes([sink.sent[2].2[8], sink.sent[2].2[9]]),
            OPCODE_ARTSYNC
        );
        // 3: ArtPoll
        assert_eq!(sink.sent[3].0, SinkChannel::ArtNet);
        assert_eq!(sink.sent[3].2.len(), 14);
        assert_eq!(
            u16::from_le_bytes([sink.sent[3].2[8], sink.sent[3].2[9]]),
            OPCODE_ARTPOLL
        );
        // 4: sACN Discovery
        assert_eq!(sink.sent[4].0, SinkChannel::Sacn);
        assert_eq!(
            sink.sent[4].1,
            SocketAddr::V4(SocketAddrV4::new(
                Ipv4Addr::new(239, 255, 250, 214),
                SACN_PORT
            ))
        );

        sink.sent.clear();

        // Tick at t=2.6s triggers ArtPoll again, not sACN discovery
        let f1 = Engine::evaluate_frame(
            &plan,
            &ClockInput {
                t_sec: 2.6,
                frame_index: 114,
            },
            &rt,
            &mut q,
        );
        tx.transmit_frame(&plan, &f1, &mut sink, None).unwrap();
        assert_eq!(sink.sent.len(), 4); // ArtDmx + sACN + ArtSync + ArtPoll

        sink.sent.clear();

        // Removing sACN universe emits 3-packet Stream_Terminated burst
        let artnet_only = RenderPlan {
            revision: 2,
            universes: vec![UniverseConfig::new(
                1,
                ProtocolKind::ArtNet {
                    mode: ArtNetOutputMode::Broadcast,
                    net: 0,
                    subnet: 0,
                    uni: 0,
                },
            )],
            artsync_enabled: true,
            cell_count: 0,
            base_dmx: vec![[0u8; 512]],
            fixtures: Vec::new(),
            cells: Vec::new(),
            groups: Vec::new(),
        };
        let f2 = Engine::evaluate_frame(
            &artnet_only,
            &ClockInput {
                t_sec: 3.0,
                frame_index: 132,
            },
            &rt,
            &mut q,
        );
        tx.transmit_frame(&artnet_only, &f2, &mut sink, None)
            .unwrap();

        let term_packets: Vec<&Vec<u8>> = sink
            .sent
            .iter()
            .filter(|(ch, _, pkt)| *ch == SinkChannel::Sacn && pkt.len() == 638 && pkt[112] == 0x40)
            .map(|(_, _, pkt)| pkt)
            .collect();
        assert_eq!(term_packets.len(), 3);
        assert_eq!(term_packets[0][111], 2);
        assert_eq!(term_packets[1][111], 3);
        assert_eq!(term_packets[2][111], 4);
    }
}
