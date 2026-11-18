use std::collections::VecDeque;
use std::io::ErrorKind;
use std::net::{SocketAddr, SocketAddrV4, UdpSocket};

use socket2::{Domain, Protocol, Socket, Type};

use super::artnet::ARTNET_PORT;
use super::nic::NetworkInterfaceInfo;
use super::ProtocolError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkChannel {
    ArtNet,
    Sacn,
}

pub trait PacketSink: Send {
    fn send_to(
        &mut self,
        channel: SinkChannel,
        payload: &[u8],
        target: SocketAddr,
    ) -> Result<(), ProtocolError>;

    fn poll_artnet_replies(&mut self) -> Vec<(SocketAddr, Vec<u8>)>;

    fn is_offline(&self) -> bool;

    fn discovery_available(&self) -> bool;

    fn active_interface(&self) -> Option<&NetworkInterfaceInfo>;
}

#[derive(Debug, Default)]
pub struct OfflineSink;

impl PacketSink for OfflineSink {
    fn send_to(
        &mut self,
        _channel: SinkChannel,
        _payload: &[u8],
        _target: SocketAddr,
    ) -> Result<(), ProtocolError> {
        Ok(())
    }

    fn poll_artnet_replies(&mut self) -> Vec<(SocketAddr, Vec<u8>)> {
        Vec::new()
    }

    fn is_offline(&self) -> bool {
        true
    }

    fn discovery_available(&self) -> bool {
        false
    }

    fn active_interface(&self) -> Option<&NetworkInterfaceInfo> {
        None
    }
}

#[derive(Debug, Default)]
pub struct MockPacketSink {
    pub sent: Vec<(SinkChannel, SocketAddr, Vec<u8>)>,
    pub incoming_artnet_replies: VecDeque<(SocketAddr, Vec<u8>)>,
    pub offline: bool,
    pub fail_sends: bool,
}

impl MockPacketSink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_artnet_reply(&mut self, from: SocketAddr, payload: Vec<u8>) {
        self.incoming_artnet_replies.push_back((from, payload));
    }
}

impl PacketSink for MockPacketSink {
    fn send_to(
        &mut self,
        channel: SinkChannel,
        payload: &[u8],
        target: SocketAddr,
    ) -> Result<(), ProtocolError> {
        if self.fail_sends {
            return Err(ProtocolError::SendFailed("mock send failure".into()));
        }
        self.sent.push((channel, target, payload.to_vec()));
        Ok(())
    }

    fn poll_artnet_replies(&mut self) -> Vec<(SocketAddr, Vec<u8>)> {
        self.incoming_artnet_replies.drain(..).collect()
    }

    fn is_offline(&self) -> bool {
        self.offline
    }

    fn discovery_available(&self) -> bool {
        !self.offline
    }

    fn active_interface(&self) -> Option<&NetworkInterfaceInfo> {
        None
    }
}

pub struct UdpSocketSink {
    interface: NetworkInterfaceInfo,
    artnet_socket: UdpSocket,
    sacn_socket: UdpSocket,
    discovery_available: bool,
}

impl UdpSocketSink {
    pub fn bind(interface: NetworkInterfaceInfo) -> Result<Self, ProtocolError> {
        Self::bind_with_artnet_port(interface, ARTNET_PORT)
    }

    pub fn bind_with_artnet_port(
        interface: NetworkInterfaceInfo,
        artnet_port: u16,
    ) -> Result<Self, ProtocolError> {
        let (artnet_socket, discovery_available) =
            match Self::bind_artnet_socket(interface.ipv4, artnet_port, true) {
                Ok(sock) => (sock, true),
                Err(_) => {
                    // Fallback to ephemeral port send-only if 6454 is exclusively held
                    let sock = Self::bind_artnet_socket(interface.ipv4, 0, false)?;
                    (sock, false)
                }
            };

        let sacn_socket = Self::bind_sacn_socket(interface.ipv4)?;

        Ok(Self {
            interface,
            artnet_socket,
            sacn_socket,
            discovery_available,
        })
    }

    fn bind_artnet_socket(
        ip: std::net::Ipv4Addr,
        port: u16,
        reuse_addr: bool,
    ) -> Result<UdpSocket, ProtocolError> {
        let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
        if reuse_addr {
            sock.set_reuse_address(true)?;
        }
        sock.set_nonblocking(true)?;
        sock.set_broadcast(true)?;
        let addr = SocketAddrV4::new(ip, port);
        sock.bind(&addr.into())?;
        Ok(sock.into())
    }

    fn bind_sacn_socket(ip: std::net::Ipv4Addr) -> Result<UdpSocket, ProtocolError> {
        let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
        sock.set_nonblocking(true)?;
        sock.set_multicast_if_v4(&ip)?;
        sock.set_multicast_ttl_v4(4)?;
        let addr = SocketAddrV4::new(ip, 0);
        sock.bind(&addr.into())?;
        Ok(sock.into())
    }
}

impl PacketSink for UdpSocketSink {
    fn send_to(
        &mut self,
        channel: SinkChannel,
        payload: &[u8],
        target: SocketAddr,
    ) -> Result<(), ProtocolError> {
        let sock = match channel {
            SinkChannel::ArtNet => &self.artnet_socket,
            SinkChannel::Sacn => &self.sacn_socket,
        };
        sock.send_to(payload, target)?;
        Ok(())
    }

    fn poll_artnet_replies(&mut self) -> Vec<(SocketAddr, Vec<u8>)> {
        if !self.discovery_available {
            return Vec::new();
        }
        let mut replies = Vec::new();
        let mut buf = [0u8; 1024];
        loop {
            match self.artnet_socket.recv_from(&mut buf) {
                Ok((len, addr)) => {
                    replies.push((addr, buf[..len].to_vec()));
                }
                Err(err) if err.kind() == ErrorKind::WouldBlock => break,
                Err(_) => break,
            }
        }
        replies
    }

    fn is_offline(&self) -> bool {
        false
    }

    fn discovery_available(&self) -> bool {
        self.discovery_available
    }

    fn active_interface(&self) -> Option<&NetworkInterfaceInfo> {
        Some(&self.interface)
    }
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, SocketAddrV4};

    use super::*;

    fn loopback_iface() -> NetworkInterfaceInfo {
        NetworkInterfaceInfo {
            name: "Loopback".into(),
            ipv4: Ipv4Addr::LOCALHOST,
            netmask: Ipv4Addr::new(255, 0, 0, 0),
            broadcast: Ipv4Addr::new(127, 255, 255, 255),
            subnet_cidr: "127.0.0.0/8".into(),
        }
    }

    fn bind_exclusive_blocker() -> UdpSocket {
        let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawSocket;
            // SO_EXCLUSIVEADDRUSE = -5 on Windows Winsock
            unsafe {
                let raw = sock.as_raw_socket();
                let val: i32 = 1;
                extern "system" {
                    fn setsockopt(
                        s: usize,
                        level: i32,
                        optname: i32,
                        optval: *const i8,
                        optlen: i32,
                    ) -> i32;
                }
                const SOL_SOCKET: i32 = 0xffff;
                const SO_EXCLUSIVEADDRUSE: i32 = -5;
                let res = setsockopt(
                    raw as usize,
                    SOL_SOCKET,
                    SO_EXCLUSIVEADDRUSE,
                    &val as *const i32 as *const i8,
                    std::mem::size_of::<i32>() as i32,
                );
                assert_eq!(res, 0);
            }
        }
        sock.bind(&SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0).into())
            .unwrap();
        sock.into()
    }

    #[test]
    fn mock_sink_records_packets_and_returns_replies() {
        let mut sink = MockPacketSink::new();
        let target = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 50), 6454));
        sink.send_to(SinkChannel::ArtNet, &[1, 2, 3], target)
            .unwrap();
        assert_eq!(sink.sent.len(), 1);
        assert_eq!(sink.sent[0].0, SinkChannel::ArtNet);
        assert_eq!(sink.sent[0].1, target);
        assert_eq!(sink.sent[0].2, vec![1, 2, 3]);

        sink.push_artnet_reply(target, vec![9, 8, 7]);
        let replies = sink.poll_artnet_replies();
        assert_eq!(replies, vec![(target, vec![9, 8, 7])]);
    }

    #[test]
    fn offline_sink_accepts_writes_without_error() {
        let mut sink = OfflineSink;
        assert!(sink.is_offline());
        assert!(!sink.discovery_available());
        let target = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 50), 6454));
        assert!(sink.send_to(SinkChannel::ArtNet, &[0u8; 530], target).is_ok());
    }

    #[test]
    fn udp_sink_binds_explicit_ipv4_and_falls_back_when_port_held_exclusively() {
        let iface = loopback_iface();
        let blocker = bind_exclusive_blocker();
        let held_port = blocker.local_addr().unwrap().port();

        let mut sink = UdpSocketSink::bind_with_artnet_port(iface.clone(), held_port).unwrap();
        assert!(!sink.is_offline());
        assert!(!sink.discovery_available());

        let receiver = UdpSocket::bind("127.0.0.1:0").unwrap();
        receiver.set_nonblocking(true).unwrap();
        let recv_addr = receiver.local_addr().unwrap();
        sink.send_to(SinkChannel::ArtNet, b"hello-artnet", recv_addr)
            .unwrap();
        sink.send_to(SinkChannel::Sacn, b"hello-sacn", recv_addr)
            .unwrap();

        let mut buf = [0u8; 64];
        let (n1, _) = receiver.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..n1], b"hello-artnet");
        let (n2, _) = receiver.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..n2], b"hello-sacn");

        drop(blocker);

        let mut sink2 = UdpSocketSink::bind_with_artnet_port(iface, held_port).unwrap();
        assert!(sink2.discovery_available());
        assert!(!sink2.is_offline());
        let _ = sink2.poll_artnet_replies();
    }
}
