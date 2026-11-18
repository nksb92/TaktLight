use thiserror::Error;

pub const BINARY_FRAME_HEADER_BYTES: usize = 40;
pub const BINARY_FRAME_LAYOUT_VERSION: u16 = 1;

#[derive(Debug, Error)]
pub enum FrameDecodeError {
    #[error("frame buffer too short for 40-byte header: got {0} bytes")]
    HeaderTooShort(usize),
    #[error("unsupported frame layout version: {0}")]
    UnsupportedLayoutVersion(u16),
    #[error("frame buffer length mismatch: expected {expected} bytes, got {actual}")]
    BodyLengthMismatch { expected: usize, actual: usize },
}

#[derive(Debug, Clone, PartialEq)]
pub struct FrameSnapshot {
    pub revision: u64,
    pub t_sec: f64,
    pub cell_count: u32,
    pub dropped_frames: u32,
    pub mean_us: f32,
    pub max_jitter_us: f32,
    pub p99_jitter_us: f32,
    pub layout_version: u16,
    pub universe_count: u16,
    pub universe_dmx: Vec<[u8; 512]>,
    pub cell_preview_rgbd: Vec<u8>,
}

pub fn encode_binary_frame(snapshot: &FrameSnapshot) -> Vec<u8> {
    let universe_count = snapshot.universe_dmx.len().min(u16::MAX as usize);
    let cell_count = (snapshot.cell_preview_rgbd.len() / 4).min(u32::MAX as usize);
    let total_len = BINARY_FRAME_HEADER_BYTES + universe_count * 512 + cell_count * 4;
    let mut out = Vec::with_capacity(total_len);

    out.extend_from_slice(&snapshot.revision.to_le_bytes());
    out.extend_from_slice(&snapshot.t_sec.to_le_bytes());
    out.extend_from_slice(&(cell_count as u32).to_le_bytes());
    out.extend_from_slice(&snapshot.dropped_frames.to_le_bytes());
    out.extend_from_slice(&snapshot.mean_us.to_le_bytes());
    out.extend_from_slice(&snapshot.max_jitter_us.to_le_bytes());
    out.extend_from_slice(&snapshot.p99_jitter_us.to_le_bytes());
    out.extend_from_slice(&snapshot.layout_version.to_le_bytes());
    out.extend_from_slice(&(universe_count as u16).to_le_bytes());

    for dmx in snapshot.universe_dmx.iter().take(universe_count) {
        out.extend_from_slice(dmx);
    }
    out.extend_from_slice(&snapshot.cell_preview_rgbd[..cell_count * 4]);
    out
}

pub fn decode_binary_frame(buf: &[u8]) -> Result<FrameSnapshot, FrameDecodeError> {
    if buf.len() < BINARY_FRAME_HEADER_BYTES {
        return Err(FrameDecodeError::HeaderTooShort(buf.len()));
    }

    let revision = u64::from_le_bytes(buf[0..8].try_into().unwrap());
    let t_sec = f64::from_le_bytes(buf[8..16].try_into().unwrap());
    let cell_count = u32::from_le_bytes(buf[16..20].try_into().unwrap());
    let dropped_frames = u32::from_le_bytes(buf[20..24].try_into().unwrap());
    let mean_us = f32::from_le_bytes(buf[24..28].try_into().unwrap());
    let max_jitter_us = f32::from_le_bytes(buf[28..32].try_into().unwrap());
    let p99_jitter_us = f32::from_le_bytes(buf[32..36].try_into().unwrap());
    let layout_version = u16::from_le_bytes(buf[36..38].try_into().unwrap());
    let universe_count = u16::from_le_bytes(buf[38..40].try_into().unwrap());

    if layout_version != BINARY_FRAME_LAYOUT_VERSION {
        return Err(FrameDecodeError::UnsupportedLayoutVersion(layout_version));
    }

    let expected_len =
        BINARY_FRAME_HEADER_BYTES + (universe_count as usize) * 512 + (cell_count as usize) * 4;
    if buf.len() != expected_len {
        return Err(FrameDecodeError::BodyLengthMismatch {
            expected: expected_len,
            actual: buf.len(),
        });
    }

    let mut offset = BINARY_FRAME_HEADER_BYTES;
    let mut universe_dmx = Vec::with_capacity(universe_count as usize);
    for _ in 0..universe_count {
        let mut dmx = [0u8; 512];
        dmx.copy_from_slice(&buf[offset..offset + 512]);
        universe_dmx.push(dmx);
        offset += 512;
    }

    let cell_preview_rgbd = buf[offset..].to_vec();

    Ok(FrameSnapshot {
        revision,
        t_sec,
        cell_count,
        dropped_frames,
        mean_us,
        max_jitter_us,
        p99_jitter_us,
        layout_version,
        universe_count,
        universe_dmx,
        cell_preview_rgbd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_frame_round_trips_with_exact_40_byte_header_offsets() {
        let mut u0 = [0u8; 512];
        u0[0] = 255;
        u0[511] = 123;
        let mut u1 = [0u8; 512];
        u1[17] = 77;

        let snapshot = FrameSnapshot {
            revision: 0x1122_3344_5566_7788,
            t_sec: 12.3456789,
            cell_count: 2,
            dropped_frames: 3,
            mean_us: 22_727.25,
            max_jitter_us: 45.5,
            p99_jitter_us: 32.125,
            layout_version: BINARY_FRAME_LAYOUT_VERSION,
            universe_count: 2,
            universe_dmx: vec![u0, u1],
            cell_preview_rgbd: vec![255, 85, 0, 200, 34, 85, 170, 255],
        };

        let bytes = encode_binary_frame(&snapshot);
        assert_eq!(bytes.len(), 40 + 2 * 512 + 2 * 4);

        assert_eq!(
            u64::from_le_bytes(bytes[0..8].try_into().unwrap()),
            0x1122_3344_5566_7788
        );
        assert_eq!(
            f64::from_le_bytes(bytes[8..16].try_into().unwrap()),
            12.3456789
        );
        assert_eq!(u32::from_le_bytes(bytes[16..20].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(bytes[20..24].try_into().unwrap()), 3);
        assert_eq!(
            f32::from_le_bytes(bytes[24..28].try_into().unwrap()),
            22_727.25
        );
        assert_eq!(f32::from_le_bytes(bytes[28..32].try_into().unwrap()), 45.5);
        assert_eq!(
            f32::from_le_bytes(bytes[32..36].try_into().unwrap()),
            32.125
        );
        assert_eq!(u16::from_le_bytes(bytes[36..38].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(bytes[38..40].try_into().unwrap()), 2);

        let decoded = decode_binary_frame(&bytes).expect("round-trip decode");
        assert_eq!(decoded, snapshot);
    }

    #[test]
    fn binary_frame_rejects_short_or_corrupt_buffers() {
        assert!(matches!(
            decode_binary_frame(&[0u8; 39]),
            Err(FrameDecodeError::HeaderTooShort(39))
        ));

        let mut bad_body = vec![0u8; 40];
        bad_body[36..38].copy_from_slice(&1u16.to_le_bytes());
        bad_body[38..40].copy_from_slice(&1u16.to_le_bytes());
        assert!(matches!(
            decode_binary_frame(&bad_body),
            Err(FrameDecodeError::BodyLengthMismatch {
                expected: 552,
                actual: 40
            })
        ));
    }
}
