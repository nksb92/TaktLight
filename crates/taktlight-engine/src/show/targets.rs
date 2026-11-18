use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use super::ShowError;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TargetRef {
    Fixture {
        fixture_id: String,
    },
    CellRange {
        fixture_id: String,
        start: u16,
        end: u16,
    },
}

impl TargetRef {
    pub fn fixture_id(&self) -> &str {
        match self {
            Self::Fixture { fixture_id } | Self::CellRange { fixture_id, .. } => fixture_id,
        }
    }

    pub fn expand_cell_indices(&self, cell_count: u16) -> Vec<u16> {
        if cell_count == 0 {
            return Vec::new();
        }
        match self {
            Self::Fixture { .. } => (0..cell_count).collect(),
            Self::CellRange { start, end, .. } => {
                if start <= end {
                    (*start..=*end).filter(|&i| i < cell_count).collect()
                } else {
                    (*end..=*start).rev().filter(|&i| i < cell_count).collect()
                }
            }
        }
    }
}

impl fmt::Display for TargetRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fixture { fixture_id } => write!(f, "{fixture_id}"),
            Self::CellRange {
                fixture_id,
                start,
                end,
            } if start == end => write!(f, "{fixture_id}:{start}"),
            Self::CellRange {
                fixture_id,
                start,
                end,
            } => write!(f, "{fixture_id}:{start}..{end}"),
        }
    }
}

impl FromStr for TargetRef {
    type Err = ShowError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return Err(ShowError::InvalidTargetRef(trimmed.to_string()));
        }

        if let Some((fixture_id, range_part)) = trimmed.split_once(':') {
            let fixture_id = fixture_id.trim();
            let range_part = range_part.trim();
            if fixture_id.is_empty() || range_part.is_empty() {
                return Err(ShowError::InvalidTargetRef(trimmed.to_string()));
            }
            if let Some((start_str, end_str)) = range_part.split_once("..") {
                let start: u16 = start_str
                    .trim()
                    .parse()
                    .map_err(|_| ShowError::InvalidTargetRef(trimmed.to_string()))?;
                let end: u16 = end_str
                    .trim()
                    .parse()
                    .map_err(|_| ShowError::InvalidTargetRef(trimmed.to_string()))?;
                return Ok(Self::CellRange {
                    fixture_id: fixture_id.to_string(),
                    start,
                    end,
                });
            }
            let single: u16 = range_part
                .parse()
                .map_err(|_| ShowError::InvalidTargetRef(trimmed.to_string()))?;
            return Ok(Self::CellRange {
                fixture_id: fixture_id.to_string(),
                start: single,
                end: single,
            });
        }

        Ok(Self::Fixture {
            fixture_id: trimmed.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_expands_fixture_single_ascending_and_descending_ranges() {
        let whole: TargetRef = "fx_201".parse().unwrap();
        assert_eq!(whole.expand_cell_indices(4), vec![0, 1, 2, 3]);
        assert_eq!(whole.to_string(), "fx_201");

        let single: TargetRef = "fx_201:3".parse().unwrap();
        assert_eq!(single.expand_cell_indices(8), vec![3]);
        assert_eq!(single.to_string(), "fx_201:3");

        let asc: TargetRef = "fx_201:0..7".parse().unwrap();
        assert_eq!(asc.expand_cell_indices(8), vec![0, 1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(asc.to_string(), "fx_201:0..7");

        let desc: TargetRef = "fx_201:7..0".parse().unwrap();
        assert_eq!(desc.expand_cell_indices(8), vec![7, 6, 5, 4, 3, 2, 1, 0]);
        assert_eq!(desc.to_string(), "fx_201:7..0");

        assert!("".parse::<TargetRef>().is_err());
        assert!(":0..7".parse::<TargetRef>().is_err());
        assert!("fx_201:a..b".parse::<TargetRef>().is_err());
        assert!("fx_201:0..".parse::<TargetRef>().is_err());
    }
}
