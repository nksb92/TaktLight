use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::time::Duration;

use taktlight_engine::engine::evaluator::{ClockInput, Engine, QuantizerState};
use taktlight_engine::engine::runner::TickTransmitter;
use taktlight_engine::protocol::artnet::{ARTNET_HEADER, ARTNET_PORT};
use taktlight_engine::protocol::nic::NetworkInterfaceInfo;
use taktlight_engine::protocol::sacn::SACN_PORT;
use taktlight_engine::protocol::sink::{PacketSink, SinkChannel, UdpSocketSink};
use taktlight_engine::protocol::ProtocolError;
use taktlight_engine::state::plan::{
    ArtNetOutputMode, ProtocolKind, RenderPlan, SacnOutputMode, UniverseConfig,
};
use taktlight_engine::state::runtime::RuntimeControl;

fn loopback_iface() -> NetworkInterfaceInfo {
    NetworkInterfaceInfo {
        name: "Loopback".into(),
        ipv4: Ipv4Addr::LOCALHOST,
        netmask: Ipv4Addr::new(255, 0, 0, 0),
        broadcast: Ipv4Addr::LOCALHOST,
        subnet_cidr: "127.0.0.0/8".into(),
    }
}

/// Real OS UDP sink over 127.0.0.1 that remaps well-known Art-Net (6454) and
/// sACN (5568) ports onto ephemeral loopback test receiver ports so tests run
/// deterministically without requiring privileged or unoccupied standard ports.
struct LoopbackPortRemapSink {
    inner: UdpSocketSink,
    artnet_rx_addr: SocketAddr,
    sacn_rx_addr: SocketAddr,
}

impl LoopbackPortRemapSink {
    fn new(artnet_rx_addr: SocketAddr, sacn_rx_addr: SocketAddr) -> Self {
        let inner = UdpSocketSink::bind_with_artnet_port(loopback_iface(), 0)
            .expect("bind ephemeral UdpSocketSink on 127.0.0.1");
        Self {
            inner,
            artnet_rx_addr,
            sacn_rx_addr,
        }
    }
}

impl PacketSink for LoopbackPortRemapSink {
    fn send_to(
        &mut self,
        channel: SinkChannel,
        payload: &[u8],
        target: SocketAddr,
    ) -> Result<(), ProtocolError> {
        let remapped = match (channel, target.port()) {
            (SinkChannel::ArtNet, ARTNET_PORT) => self.artnet_rx_addr,
            (SinkChannel::Sacn, SACN_PORT) => self.sacn_rx_addr,
            _ => target,
        };
        self.inner.send_to(channel, payload, remapped)
    }

    fn poll_artnet_replies(&mut self) -> Vec<(SocketAddr, Vec<u8>)> {
        self.inner.poll_artnet_replies()
    }

    fn is_offline(&self) -> bool {
        self.inner.is_offline()
    }

    fn discovery_available(&self) -> bool {
        self.inner.discovery_available()
    }

    fn active_interface(&self) -> Option<&NetworkInterfaceInfo> {
        self.inner.active_interface()
    }
}

fn recv_all_packets(sock: &UdpSocket) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0u8; 2048];
    while let Ok((n, _)) = sock.recv_from(&mut buf) {
        out.push(buf[..n].to_vec());
    }
    out
}

#[test]
fn loopback_udp_transmits_artnet_dmx_artsync_and_sacn_with_termination_burst() {
    let artnet_rx = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
    artnet_rx
        .set_read_timeout(Some(Duration::from_millis(40)))
        .unwrap();
    let sacn_rx = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
    sacn_rx
        .set_read_timeout(Some(Duration::from_millis(40)))
        .unwrap();

    let mut sink = LoopbackPortRemapSink::new(
        artnet_rx.local_addr().unwrap(),
        sacn_rx.local_addr().unwrap(),
    );

    let mut plan = RenderPlan::default_studio_plan();
    plan.artsync_enabled = true;
    plan.universes = vec![
        UniverseConfig {
            id: 1,
            review_output: false,
            protocol: ProtocolKind::ArtNet {
                mode: ArtNetOutputMode::Unicast {
                    target_ip: Ipv4Addr::LOCALHOST,
                },
                net: 0,
                subnet: 0,
                uni: 0,
            },
        },
        UniverseConfig {
            id: 2,
            review_output: false,
            protocol: ProtocolKind::Sacn {
                mode: SacnOutputMode::Unicast {
                    target_ip: Ipv4Addr::LOCALHOST,
                },
                sacn_universe: 2,
                priority: 120,
            },
        },
    ];
    plan.base_dmx = vec![[0u8; 512], [0u8; 512]];
    plan.base_dmx[0][0] = 200; // U1 ch1
    plan.base_dmx[0][1] = 100; // U1 ch2
    plan.base_dmx[1][0] = 150; // U2 ch1

    let mut tx = TickTransmitter::new([0xAB; 16], "TaktLightLoopback");
    let runtime = RuntimeControl::new();
    let mut qstate = QuantizerState::default();

    let frame1 = Engine::evaluate_frame(
        &plan,
        &ClockInput {
            t_sec: 0.0,
            frame_index: 0,
        },
        &runtime,
        &mut qstate,
    );
    tx.transmit_frame(&plan, &frame1, &mut sink, None).unwrap();

    // Verify Art-Net packets received over real loopback UDP
    let artnet_pkts = recv_all_packets(&artnet_rx);
    let artdmx = artnet_pkts
        .iter()
        .find(|p| p.len() >= 18 + 512 && &p[0..8] == ARTNET_HEADER && u16::from_le_bytes([p[8], p[9]]) == 0x5000)
        .expect("expected ArtDmx packet over loopback UDP");
    assert_eq!(artdmx[18], 200, "U1 CH1 DMX value on wire");
    assert_eq!(artdmx[19], 100, "U1 CH2 DMX value on wire");

    let has_artsync = artnet_pkts
        .iter()
        .any(|p| p.len() >= 14 && &p[0..8] == ARTNET_HEADER && u16::from_le_bytes([p[8], p[9]]) == 0x5200);
    assert!(has_artsync, "expected ArtSync packet over loopback UDP");

    // Verify sACN (E1.31) data packet received over real loopback UDP
    let sacn_pkts = recv_all_packets(&sacn_rx);
    let sacn_data = sacn_pkts
        .iter()
        .find(|p| p.len() == 638 && &p[4..16] == b"ASC-E1.17\0\0\0")
        .expect("expected E1.31 sACN data packet over loopback UDP");
    assert_eq!(sacn_data[108], 120, "sACN priority on wire");
    assert_eq!(u16::from_be_bytes([sacn_data[113], sacn_data[114]]), 2, "sACN universe on wire");
    assert_eq!(sacn_data[126], 150, "U2 CH1 DMX value on wire");
    assert_eq!(sacn_data[112] & 0x40, 0, "Stream_Terminated flag must be 0 during active stream");

    // Now clear all output on both universes -> Art-Net suppressed, sACN emits 3 Stream_Terminated packets
    plan.base_dmx = vec![[0u8; 512], [0u8; 512]];
    let frame2 = Engine::evaluate_frame(
        &plan,
        &ClockInput {
            t_sec: 0.05,
            frame_index: 2,
        },
        &runtime,
        &mut qstate,
    );
    tx.transmit_frame(&plan, &frame2, &mut sink, None).unwrap();

    let artnet_after = recv_all_packets(&artnet_rx);
    let has_artdmx_after = artnet_after
        .iter()
        .any(|p| p.len() >= 18 && u16::from_le_bytes([p[8], p[9]]) == 0x5000);
    assert!(!has_artdmx_after, "empty Art-Net universe must not transmit ArtDmx");

    let sacn_after = recv_all_packets(&sacn_rx);
    let term_pkts: Vec<&Vec<u8>> = sacn_after
        .iter()
        .filter(|p| p.len() == 638 && &p[4..16] == b"ASC-E1.17\0\0\0" && (p[112] & 0x40) != 0)
        .collect();
    assert_eq!(
        term_pkts.len(),
        3,
        "empty sACN universe must emit 3 E1.31 Stream_Terminated packets over UDP"
    );
}

#[test]
fn loopback_udp_artpoll_reply_discovery_roundtrip() {
    let iface = loopback_iface();
    let mut sink = UdpSocketSink::bind_with_artnet_port(iface, 0).unwrap();
    let probe_rx = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
    probe_rx
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();

    // Send a probe packet from sink to probe_rx so we discover sink's ephemeral Art-Net port
    sink.send_to(SinkChannel::ArtNet, b"ping", probe_rx.local_addr().unwrap())
        .unwrap();
    let mut buf = [0u8; 64];
    let (n, sink_addr) = probe_rx.recv_from(&mut buf).unwrap();
    assert_eq!(&buf[..n], b"ping");

    // Send a valid minimal ArtPollReply (239 bytes) back to sink_addr
    let mut reply = vec![0u8; 239];
    reply[0..8].copy_from_slice(ARTNET_HEADER);
    reply[8..10].copy_from_slice(&0x2100u16.to_le_bytes()); // OpPollReply
    reply[10..14].copy_from_slice(&[127, 0, 0, 1]);
    reply[14..16].copy_from_slice(&ARTNET_PORT.to_le_bytes());
    reply[26..36].copy_from_slice(b"LoopNode01");
    reply[44..60].copy_from_slice(b"Loopback Test Nd");
    probe_rx.send_to(&reply, sink_addr).unwrap();

    // Give OS loopback socket a brief moment then poll through TickTransmitter
    std::thread::sleep(Duration::from_millis(10));
    let mut tx = TickTransmitter::new([0x11; 16], "TaktLightDiscovery");
    let plan = RenderPlan::default_studio_plan();
    let runtime = RuntimeControl::new();
    let mut qstate = QuantizerState::default();
    let frame = Engine::evaluate_frame(
        &plan,
        &ClockInput {
            t_sec: 1.0,
            frame_index: 44,
        },
        &runtime,
        &mut qstate,
    );
    tx.transmit_frame(&plan, &frame, &mut sink, None).unwrap();

    let nodes = tx.discovered_nodes();
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].node.short_name, "LoopNode01");
    assert_eq!(nodes[0].node.ip, Ipv4Addr::LOCALHOST);
}
