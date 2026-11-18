use std::collections::BTreeMap;
use std::net::Ipv4Addr;

use serde::{Deserialize, Serialize};

use super::ProtocolError;

pub const ARTNET_PORT: u16 = 6454;
pub const ARTNET_HEADER: &[u8; 8] = b"Art-Net\0";
pub const ARTNET_PROTOCOL_VERSION: u16 = 14;
pub const OPCODE_ARTPOLL: u16 = 0x2000;
pub const OPCODE_ARTPOLL_REPLY: u16 = 0x2100;
pub const OPCODE_ARTDMX: u16 = 0x5000;
pub const OPCODE_ARTSYNC: u16 = 0x5200;
pub const ARTNET_NODE_OFFLINE_TIMEOUT_SEC: f64 = 10.0;
pub const ARTPOLL_REPLY_MIN_LEN: usize = 207;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtPollReplyNode {
    pub ip: Ipv4Addr,
    pub port: u16,
    pub net_switch: u8,
    pub sub_switch: u8,
    pub short_name: String,
    pub long_name: String,
    pub num_ports: u8,
    pub sw_out: [u8; 4],
    pub mac: [u8; 6],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackedArtNetNode {
    pub node: ArtPollReplyNode,
    pub last_seen_sec: f64,
    pub online: bool,
}

#[derive(Debug, Default, Clone)]
pub struct NodeDiscoveryTracker {
    nodes: BTreeMap<Ipv4Addr, TrackedArtNetNode>,
}

impl NodeDiscoveryTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_reply(&mut self, node: ArtPollReplyNode, now_sec: f64) {
        self.nodes.insert(
            node.ip,
            TrackedArtNetNode {
                node,
                last_seen_sec: now_sec,
                online: true,
            },
        );
    }

    pub fn refresh_status(&mut self, now_sec: f64) {
        for tracked in self.nodes.values_mut() {
            tracked.online = (now_sec - tracked.last_seen_sec) <= ARTNET_NODE_OFFLINE_TIMEOUT_SEC;
        }
    }

    pub fn nodes(&self) -> Vec<TrackedArtNetNode> {
        self.nodes.values().cloned().collect()
    }
}

pub fn next_artnet_sequence(prev: u8) -> u8 {
    if prev == 0 || prev == 255 {
        1
    } else {
        prev + 1
    }
}

pub fn build_artdmx_packet(
    sequence: u8,
    physical: u8,
    net: u8,
    subnet: u8,
    uni: u8,
    dmx: &[u8; 512],
) -> [u8; 530] {
    let mut pkt = [0u8; 530];
    pkt[0..8].copy_from_slice(ARTNET_HEADER);
    pkt[8..10].copy_from_slice(&OPCODE_ARTDMX.to_le_bytes());
    pkt[10..12].copy_from_slice(&ARTNET_PROTOCOL_VERSION.to_be_bytes());
    pkt[12] = sequence;
    pkt[13] = physical;
    pkt[14] = ((subnet & 0x0F) << 4) | (uni & 0x0F);
    pkt[15] = net & 0x7F;
    pkt[16..18].copy_from_slice(&512u16.to_be_bytes());
    pkt[18..530].copy_from_slice(dmx);
    pkt
}

pub fn build_artsync_packet() -> [u8; 14] {
    let mut pkt = [0u8; 14];
    pkt[0..8].copy_from_slice(ARTNET_HEADER);
    pkt[8..10].copy_from_slice(&OPCODE_ARTSYNC.to_le_bytes());
    pkt[10..12].copy_from_slice(&ARTNET_PROTOCOL_VERSION.to_be_bytes());
    pkt
}

pub fn build_artpoll_packet(talk_to_me: u8, priority: u8) -> [u8; 14] {
    let mut pkt = [0u8; 14];
    pkt[0..8].copy_from_slice(ARTNET_HEADER);
    pkt[8..10].copy_from_slice(&OPCODE_ARTPOLL.to_le_bytes());
    pkt[10..12].copy_from_slice(&ARTNET_PROTOCOL_VERSION.to_be_bytes());
    pkt[12] = talk_to_me;
    pkt[13] = priority;
    pkt
}

fn read_c_string(slice: &[u8]) -> String {
    let end = slice.iter().position(|&b| b == 0).unwrap_or(slice.len());
    String::from_utf8_lossy(&slice[..end]).trim().to_string()
}

pub fn parse_artpoll_reply(buf: &[u8]) -> Result<ArtPollReplyNode, ProtocolError> {
    if buf.len() < ARTPOLL_REPLY_MIN_LEN {
        return Err(ProtocolError::PacketTooShort {
            expected: ARTPOLL_REPLY_MIN_LEN,
            actual: buf.len(),
        });
    }
    if &buf[0..8] != ARTNET_HEADER {
        return Err(ProtocolError::InvalidArtNetHeader);
    }
    let opcode = u16::from_le_bytes([buf[8], buf[9]]);
    if opcode != OPCODE_ARTPOLL_REPLY {
        return Err(ProtocolError::InvalidOpCode {
            expected: OPCODE_ARTPOLL_REPLY,
            actual: opcode,
        });
    }

    let ip = Ipv4Addr::new(buf[10], buf[11], buf[12], buf[13]);
    let port = u16::from_le_bytes([buf[14], buf[15]]);
    let net_switch = buf[18];
    let sub_switch = buf[19];
    let short_name = read_c_string(&buf[26..44]);
    let long_name = read_c_string(&buf[44..108]);
    let num_ports = u16::from_be_bytes([buf[172], buf[173]]).min(4) as u8;
    let sw_out = [buf[190], buf[191], buf[192], buf[193]];
    let mac = [buf[201], buf[202], buf[203], buf[204], buf[205], buf[206]];

    Ok(ArtPollReplyNode {
        ip,
        port,
        net_switch,
        sub_switch,
        short_name,
        long_name,
        num_ports,
        sw_out,
        mac,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequence_wraps_between_1_and_255() {
        assert_eq!(next_artnet_sequence(0), 1);
        assert_eq!(next_artnet_sequence(1), 2);
        assert_eq!(next_artnet_sequence(254), 255);
        assert_eq!(next_artnet_sequence(255), 1);
    }

    #[test]
    fn artdmx_packet_is_530_bytes_with_exact_header() {
        let mut dmx = [0u8; 512];
        dmx[0] = 255;
        dmx[17] = 128;
        dmx[511] = 42;

        let pkt = build_artdmx_packet(7, 1, 2, 3, 4, &dmx);
        assert_eq!(pkt.len(), 530);
        assert_eq!(&pkt[0..8], b"Art-Net\0");
        assert_eq!(&pkt[8..10], &[0x00, 0x50]); // 0x5000 LE
        assert_eq!(&pkt[10..12], &[0x00, 0x0e]); // ProtVer 14 BE
        assert_eq!(pkt[12], 7); // sequence
        assert_eq!(pkt[13], 1); // physical
        assert_eq!(pkt[14], 0x34); // (subnet 3 << 4) | uni 4
        assert_eq!(pkt[15], 2); // net
        assert_eq!(&pkt[16..18], &[0x02, 0x00]); // 512 BE
        assert_eq!(pkt[18], 255);
        assert_eq!(pkt[18 + 17], 128);
        assert_eq!(pkt[18 + 511], 42);
    }

    #[test]
    fn artsync_packet_is_14_bytes_with_exact_header() {
        let pkt = build_artsync_packet();
        assert_eq!(pkt.len(), 14);
        assert_eq!(&pkt[0..8], b"Art-Net\0");
        assert_eq!(&pkt[8..10], &[0x00, 0x52]); // 0x5200 LE
        assert_eq!(&pkt[10..12], &[0x00, 0x0e]);
        assert_eq!(&pkt[12..14], &[0x00, 0x00]);
    }

    #[test]
    fn artpoll_packet_is_14_bytes_with_exact_header() {
        let pkt = build_artpoll_packet(0x02, 0x00);
        assert_eq!(pkt.len(), 14);
        assert_eq!(&pkt[0..8], b"Art-Net\0");
        assert_eq!(&pkt[8..10], &[0x00, 0x20]); // 0x2000 LE
        assert_eq!(&pkt[10..12], &[0x00, 0x0e]);
        assert_eq!(pkt[12], 0x02);
        assert_eq!(pkt[13], 0x00);
    }

    #[test]
    fn parse_artpoll_reply_extracts_node_metadata_and_rejects_bad_packets() {
        let mut reply = [0u8; 239];
        reply[0..8].copy_from_slice(b"Art-Net\0");
        reply[8..10].copy_from_slice(&[0x00, 0x21]); // 0x2100 LE
        reply[10..14].copy_from_slice(&[192, 168, 1, 77]);
        reply[14..16].copy_from_slice(&ARTNET_PORT.to_le_bytes());
        reply[18] = 1; // net_switch
        reply[19] = 2; // sub_switch
        let short = b"RP2040-DMX\0";
        reply[26..26 + short.len()].copy_from_slice(short);
        let long = b"AGE RP2040 8-Universe ArtNet Node\0";
        reply[44..44 + long.len()].copy_from_slice(long);
        reply[172..174].copy_from_slice(&4u16.to_be_bytes());
        reply[190..194].copy_from_slice(&[0, 1, 2, 3]);
        reply[201..207].copy_from_slice(&[0xAA, 0xBB, 0xCC, 0x11, 0x22, 0x33]);

        let node = parse_artpoll_reply(&reply).expect("valid ArtPollReply");
        assert_eq!(node.ip, Ipv4Addr::new(192, 168, 1, 77));
        assert_eq!(node.port, 6454);
        assert_eq!(node.net_switch, 1);
        assert_eq!(node.sub_switch, 2);
        assert_eq!(node.short_name, "RP2040-DMX");
        assert_eq!(node.long_name, "AGE RP2040 8-Universe ArtNet Node");
        assert_eq!(node.num_ports, 4);
        assert_eq!(node.sw_out, [0, 1, 2, 3]);
        assert_eq!(node.mac, [0xAA, 0xBB, 0xCC, 0x11, 0x22, 0x33]);

        assert!(matches!(
            parse_artpoll_reply(&reply[..100]),
            Err(ProtocolError::PacketTooShort { .. })
        ));

        let mut wrong_op = reply;
        wrong_op[8..10].copy_from_slice(&[0x00, 0x50]);
        assert!(matches!(
            parse_artpoll_reply(&wrong_op),
            Err(ProtocolError::InvalidOpCode {
                expected: OPCODE_ARTPOLL_REPLY,
                actual: OPCODE_ARTDMX
            })
        ));
    }

    #[test]
    fn node_discovery_tracker_marks_nodes_offline_after_10_seconds() {
        let mut tracker = NodeDiscoveryTracker::new();
        let node = ArtPollReplyNode {
            ip: Ipv4Addr::new(192, 168, 1, 50),
            port: ARTNET_PORT,
            net_switch: 0,
            sub_switch: 0,
            short_name: "Node1".into(),
            long_name: "Node 1 Long".into(),
            num_ports: 1,
            sw_out: [0, 0, 0, 0],
            mac: [1, 2, 3, 4, 5, 6],
        };

        tracker.record_reply(node.clone(), 5.0);
        tracker.refresh_status(14.9);
        assert!(tracker.nodes()[0].online);

        tracker.refresh_status(15.1);
        assert!(!tracker.nodes()[0].online);

        tracker.record_reply(node, 16.0);
        assert!(tracker.nodes()[0].online);
    }
}
