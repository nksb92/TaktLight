use std::net::Ipv4Addr;

use super::ProtocolError;

pub const SACN_PORT: u16 = 5568;
pub const SACN_DISCOVERY_UNIVERSE: u16 = 64214;
pub const SACN_OPTION_STREAM_TERMINATED: u8 = 0x40;
pub const SACN_DEFAULT_PRIORITY: u8 = 100;
pub const SACN_UNIVERSES_PER_DISCOVERY_PAGE: usize = 512;

const ACN_PACKET_ID: &[u8; 12] = b"ASC-E1.17\0\0\0";
const VECTOR_ROOT_E131_DATA: u32 = 0x0000_0004;
const VECTOR_ROOT_E131_EXTENDED: u32 = 0x0000_0008;
const VECTOR_E131_DATA_PACKET: u32 = 0x0000_0002;
const VECTOR_E131_EXTENDED_DISCOVERY: u32 = 0x0000_0002;
const VECTOR_UNIVERSE_DISCOVERY_UNIVERSE_LIST: u32 = 0x0000_0001;
const VECTOR_DMP_SET_PROPERTY: u8 = 0x02;

pub fn sacn_multicast_ip(universe: u16) -> Result<Ipv4Addr, ProtocolError> {
    if (1..=63999).contains(&universe) || universe == SACN_DISCOVERY_UNIVERSE {
        Ok(Ipv4Addr::new(
            239,
            255,
            (universe >> 8) as u8,
            (universe & 0xFF) as u8,
        ))
    } else {
        Err(ProtocolError::InvalidUniverse(universe))
    }
}

fn write_source_name_64(dst: &mut [u8], source_name: &str) {
    dst.fill(0);
    let mut end = source_name.len().min(63);
    while end > 0 && !source_name.is_char_boundary(end) {
        end -= 1;
    }
    dst[..end].copy_from_slice(&source_name.as_bytes()[..end]);
}

#[inline]
fn flags_and_len(len: usize) -> [u8; 2] {
    (0x7000u16 | (len as u16 & 0x0FFF)).to_be_bytes()
}

pub fn build_sacn_data_packet(
    cid: &[u8; 16],
    source_name: &str,
    priority: u8,
    sequence: u8,
    options: u8,
    universe: u16,
    dmx: &[u8; 512],
) -> Result<[u8; 638], ProtocolError> {
    if !(1..=63999).contains(&universe) {
        return Err(ProtocolError::InvalidUniverse(universe));
    }

    let mut pkt = [0u8; 638];

    // Root Layer (38 bytes: 0..38)
    pkt[0..2].copy_from_slice(&0x0010u16.to_be_bytes());
    pkt[2..4].copy_from_slice(&0x0000u16.to_be_bytes());
    pkt[4..16].copy_from_slice(ACN_PACKET_ID);
    pkt[16..18].copy_from_slice(&flags_and_len(638 - 16));
    pkt[18..22].copy_from_slice(&VECTOR_ROOT_E131_DATA.to_be_bytes());
    pkt[22..38].copy_from_slice(cid);

    // Framing Layer (77 bytes: 38..115)
    pkt[38..40].copy_from_slice(&flags_and_len(638 - 38));
    pkt[40..44].copy_from_slice(&VECTOR_E131_DATA_PACKET.to_be_bytes());
    write_source_name_64(&mut pkt[44..108], source_name);
    pkt[108] = priority;
    pkt[109..111].copy_from_slice(&0x0000u16.to_be_bytes());
    pkt[111] = sequence;
    pkt[112] = options;
    pkt[113..115].copy_from_slice(&universe.to_be_bytes());

    // DMP Layer (11 bytes header 115..126 + 512 payload 126..638)
    pkt[115..117].copy_from_slice(&flags_and_len(638 - 115));
    pkt[117] = VECTOR_DMP_SET_PROPERTY;
    pkt[118] = 0xa1;
    pkt[119..121].copy_from_slice(&0x0000u16.to_be_bytes());
    pkt[121..123].copy_from_slice(&0x0001u16.to_be_bytes());
    pkt[123..125].copy_from_slice(&513u16.to_be_bytes());
    pkt[125] = 0x00; // DMX Start Code
    pkt[126..638].copy_from_slice(dmx);

    Ok(pkt)
}

pub fn build_sacn_stream_termination_sequence(
    cid: &[u8; 16],
    source_name: &str,
    priority: u8,
    last_sequence: u8,
    universe: u16,
) -> Result<[[u8; 638]; 3], ProtocolError> {
    let zero_dmx = [0u8; 512];
    let p1 = build_sacn_data_packet(
        cid,
        source_name,
        priority,
        last_sequence.wrapping_add(1),
        SACN_OPTION_STREAM_TERMINATED,
        universe,
        &zero_dmx,
    )?;
    let p2 = build_sacn_data_packet(
        cid,
        source_name,
        priority,
        last_sequence.wrapping_add(2),
        SACN_OPTION_STREAM_TERMINATED,
        universe,
        &zero_dmx,
    )?;
    let p3 = build_sacn_data_packet(
        cid,
        source_name,
        priority,
        last_sequence.wrapping_add(3),
        SACN_OPTION_STREAM_TERMINATED,
        universe,
        &zero_dmx,
    )?;
    Ok([p1, p2, p3])
}

pub fn build_sacn_universe_discovery_pages(
    cid: &[u8; 16],
    source_name: &str,
    active_universes: &[u16],
) -> Vec<Vec<u8>> {
    let mut universes: Vec<u16> = active_universes
        .iter()
        .copied()
        .filter(|u| (1..=63999).contains(u))
        .collect();
    if universes.is_empty() {
        return Vec::new();
    }
    universes.sort_unstable();
    universes.dedup();

    let chunks: Vec<&[u16]> = universes
        .chunks(SACN_UNIVERSES_PER_DISCOVERY_PAGE)
        .collect();
    let last_page = (chunks.len() - 1) as u8;

    chunks
        .into_iter()
        .enumerate()
        .map(|(page_idx, chunk)| {
            let total_len = 120 + chunk.len() * 2;
            let mut pkt = vec![0u8; total_len];

            // Root Layer (0..38)
            pkt[0..2].copy_from_slice(&0x0010u16.to_be_bytes());
            pkt[2..4].copy_from_slice(&0x0000u16.to_be_bytes());
            pkt[4..16].copy_from_slice(ACN_PACKET_ID);
            pkt[16..18].copy_from_slice(&flags_and_len(total_len - 16));
            pkt[18..22].copy_from_slice(&VECTOR_ROOT_E131_EXTENDED.to_be_bytes());
            pkt[22..38].copy_from_slice(cid);

            // Extended Discovery Framing Layer (38..112)
            pkt[38..40].copy_from_slice(&flags_and_len(total_len - 38));
            pkt[40..44].copy_from_slice(&VECTOR_E131_EXTENDED_DISCOVERY.to_be_bytes());
            write_source_name_64(&mut pkt[44..108], source_name);
            // 108..112 reserved zeros

            // Universe Discovery Layer (112..)
            pkt[112..114].copy_from_slice(&flags_and_len(total_len - 112));
            pkt[114..118].copy_from_slice(&VECTOR_UNIVERSE_DISCOVERY_UNIVERSE_LIST.to_be_bytes());
            pkt[118] = page_idx as u8;
            pkt[119] = last_page;

            for (idx, &uni) in chunk.iter().enumerate() {
                let offset = 120 + idx * 2;
                pkt[offset..offset + 2].copy_from_slice(&uni.to_be_bytes());
            }

            pkt
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multicast_ip_maps_universe_and_rejects_invalid() {
        assert_eq!(sacn_multicast_ip(1).unwrap(), Ipv4Addr::new(239, 255, 0, 1));
        assert_eq!(
            sacn_multicast_ip(258).unwrap(),
            Ipv4Addr::new(239, 255, 1, 2)
        );
        assert_eq!(
            sacn_multicast_ip(SACN_DISCOVERY_UNIVERSE).unwrap(),
            Ipv4Addr::new(239, 255, 250, 214)
        );
        assert!(sacn_multicast_ip(0).is_err());
        assert!(sacn_multicast_ip(64000).is_err());
    }

    #[test]
    fn sacn_data_packet_is_638_bytes_with_exact_e131_headers() {
        let cid = [0x11u8; 16];
        let mut dmx = [0u8; 512];
        dmx[0] = 200;
        dmx[511] = 99;

        let pkt = build_sacn_data_packet(&cid, "TaktLight", 100, 42, 0x00, 2, &dmx).unwrap();
        assert_eq!(pkt.len(), 638);
        assert_eq!(&pkt[0..2], &[0x00, 0x10]);
        assert_eq!(&pkt[2..4], &[0x00, 0x00]);
        assert_eq!(&pkt[4..16], b"ASC-E1.17\0\0\0");
        assert_eq!(&pkt[16..18], &[0x72, 0x6e]);
        assert_eq!(&pkt[18..22], &[0x00, 0x00, 0x00, 0x04]);
        assert_eq!(&pkt[22..38], &cid);

        assert_eq!(&pkt[38..40], &[0x72, 0x58]);
        assert_eq!(&pkt[40..44], &[0x00, 0x00, 0x00, 0x02]);
        assert_eq!(&pkt[44..53], b"TaktLight");
        assert_eq!(pkt[53], 0);
        assert_eq!(pkt[108], 100);
        assert_eq!(&pkt[109..111], &[0x00, 0x00]);
        assert_eq!(pkt[111], 42);
        assert_eq!(pkt[112], 0x00);
        assert_eq!(&pkt[113..115], &[0x00, 0x02]);

        assert_eq!(&pkt[115..117], &[0x72, 0x0b]);
        assert_eq!(pkt[117], 0x02);
        assert_eq!(pkt[118], 0xa1);
        assert_eq!(&pkt[119..121], &[0x00, 0x00]);
        assert_eq!(&pkt[121..123], &[0x00, 0x01]);
        assert_eq!(&pkt[123..125], &[0x02, 0x01]);
        assert_eq!(pkt[125], 0x00);
        assert_eq!(pkt[126], 200);
        assert_eq!(pkt[126 + 511], 99);
    }

    #[test]
    fn sacn_stream_termination_sends_3_packets_with_incrementing_sequence() {
        let cid = [0x22u8; 16];
        let packets =
            build_sacn_stream_termination_sequence(&cid, "TaktLight", 100, 254, 5).unwrap();
        assert_eq!(packets.len(), 3);
        assert_eq!(packets[0][111], 255);
        assert_eq!(packets[1][111], 0);
        assert_eq!(packets[2][111], 1);
        for pkt in &packets {
            assert_eq!(pkt[112], SACN_OPTION_STREAM_TERMINATED);
            assert_eq!(&pkt[113..115], &5u16.to_be_bytes());
            assert!(pkt[126..].iter().all(|&b| b == 0));
        }
    }

    #[test]
    fn sacn_universe_discovery_sorts_dedups_and_pages_at_512() {
        let cid = [0x33u8; 16];
        assert!(build_sacn_universe_discovery_pages(&cid, "TaktLight", &[]).is_empty());

        let mut universes: Vec<u16> = (1..=515).rev().collect();
        universes.push(1);
        let pages = build_sacn_universe_discovery_pages(&cid, "TaktLight", &universes);
        assert_eq!(pages.len(), 2);

        let p0 = &pages[0];
        assert_eq!(p0.len(), 120 + 512 * 2);
        assert_eq!(&p0[18..22], &[0x00, 0x00, 0x00, 0x08]);
        assert_eq!(&p0[40..44], &[0x00, 0x00, 0x00, 0x02]);
        assert_eq!(&p0[114..118], &[0x00, 0x00, 0x00, 0x01]);
        assert_eq!(p0[118], 0);
        assert_eq!(p0[119], 1);
        assert_eq!(&p0[120..122], &1u16.to_be_bytes());
        assert_eq!(&p0[p0.len() - 2..], &512u16.to_be_bytes());

        let p1 = &pages[1];
        assert_eq!(p1.len(), 120 + 3 * 2);
        assert_eq!(p1[118], 1);
        assert_eq!(p1[119], 1);
        assert_eq!(&p1[120..122], &513u16.to_be_bytes());
        assert_eq!(&p1[124..126], &515u16.to_be_bytes());
    }
}
