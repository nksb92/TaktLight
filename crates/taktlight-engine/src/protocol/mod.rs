pub mod artnet;
pub mod nic;
pub mod sacn;
pub mod sink;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("invalid DMX/sACN universe number: {0}")]
    InvalidUniverse(u16),

    #[error("invalid Art-Net packet header")]
    InvalidArtNetHeader,

    #[error("unexpected Art-Net OpCode: expected 0x{expected:04x}, got 0x{actual:04x}")]
    InvalidOpCode { expected: u16, actual: u16 },

    #[error("packet too short: expected at least {expected} bytes, got {actual}")]
    PacketTooShort { expected: usize, actual: usize },

    #[error("network I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("packet transmission failed: {0}")]
    SendFailed(String),
}
