use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::mixer::traits::SmartControlLayer;

#[derive(Debug, Error)]
pub enum StateError {
    #[error("invalid universe id {0}: expected >= 1")]
    InvalidUniverseId(u16),
    #[error("invalid DMX channel {0}: expected 1..=512")]
    InvalidDmxChannel(u16),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeControl {
    pub grand_master: f32,
    pub blackout: bool,
    pub parked_channels: BTreeMap<(u16, u16), u8>,
    #[serde(default)]
    pub live_layers: Vec<SmartControlLayer>,
}

impl Default for RuntimeControl {
    fn default() -> Self {
        Self {
            grand_master: 1.0,
            blackout: false,
            parked_channels: BTreeMap::new(),
            live_layers: Vec::new(),
        }
    }
}

impl RuntimeControl {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_park(
        &mut self,
        universe: u16,
        channel: u16,
        value: Option<u8>,
    ) -> Result<(), StateError> {
        if universe == 0 {
            return Err(StateError::InvalidUniverseId(universe));
        }
        if !(1..=512).contains(&channel) {
            return Err(StateError::InvalidDmxChannel(channel));
        }

        match value {
            Some(val) => {
                self.parked_channels.insert((universe, channel), val);
            }
            None => {
                self.parked_channels.remove(&(universe, channel));
            }
        }
        Ok(())
    }

    pub fn clear_parked(&mut self, universe: Option<u16>) {
        match universe {
            Some(uni) => self.parked_channels.retain(|&(u, _), _| u != uni),
            None => self.parked_channels.clear(),
        }
    }

    pub fn set_blackout(&mut self, active: bool) {
        self.blackout = active;
    }

    pub fn set_grand_master(&mut self, value: f32) {
        if value.is_nan() {
            return;
        }
        self.grand_master = value.clamp(0.0, 1.0);
    }

    pub fn set_live_layers(&mut self, layers: Vec<SmartControlLayer>) {
        self.live_layers = layers;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn park_validates_universe_and_channel_and_clears_properly() {
        let mut rt = RuntimeControl::new();
        assert!(rt.set_park(0, 1, Some(100)).is_err());
        assert!(rt.set_park(1, 0, Some(100)).is_err());
        assert!(rt.set_park(1, 513, Some(100)).is_err());

        rt.set_park(1, 1, Some(255)).unwrap();
        rt.set_park(1, 10, Some(128)).unwrap();
        rt.set_park(2, 5, Some(64)).unwrap();
        assert_eq!(rt.parked_channels.len(), 3);

        rt.set_park(1, 10, None).unwrap();
        assert_eq!(rt.parked_channels.len(), 2);

        rt.clear_parked(Some(1));
        assert_eq!(rt.parked_channels.len(), 1);
        assert_eq!(rt.parked_channels.get(&(2, 5)), Some(&64));

        rt.clear_parked(None);
        assert!(rt.parked_channels.is_empty());
    }

    #[test]
    fn grand_master_clamps_to_unit_interval() {
        let mut rt = RuntimeControl::new();
        rt.set_grand_master(1.5);
        assert_eq!(rt.grand_master, 1.0);
        rt.set_grand_master(-0.2);
        assert_eq!(rt.grand_master, 0.0);
        rt.set_grand_master(0.45);
        assert!((rt.grand_master - 0.45).abs() < 1e-6);
    }
}
