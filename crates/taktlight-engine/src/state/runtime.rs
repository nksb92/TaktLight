use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::fx::scene::{ActiveSceneInstance, BeatClockAnchor};
use crate::mixer::traits::SmartControlLayer;
use crate::show::xml::SceneDef;

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
    #[serde(default)]
    pub beat_clock: BeatClockAnchor,
    #[serde(default)]
    pub active_scenes: Vec<ActiveSceneInstance>,
    #[serde(default)]
    pub tap_history_sec: Vec<f64>,
    #[serde(default)]
    pub next_scene_trigger_order: u64,
    #[serde(default)]
    pub active_timeline_id: Option<String>,
    #[serde(default)]
    pub timeline_playing: bool,
    #[serde(default)]
    pub timeline_playhead_sec: f64,
    #[serde(default)]
    pub timeline_start_anchor_t_sec: f64,
    #[serde(default)]
    pub latency_offset_ms: f64,
    #[serde(default)]
    pub identified_fixture_id: Option<String>,
}

impl Default for RuntimeControl {
    fn default() -> Self {
        Self {
            grand_master: 1.0,
            blackout: false,
            parked_channels: BTreeMap::new(),
            live_layers: Vec::new(),
            beat_clock: BeatClockAnchor::new(120.0),
            active_scenes: Vec::new(),
            tap_history_sec: Vec::new(),
            next_scene_trigger_order: 1,
            active_timeline_id: None,
            timeline_playing: false,
            timeline_playhead_sec: 0.0,
            timeline_start_anchor_t_sec: 0.0,
            latency_offset_ms: 0.0,
            identified_fixture_id: None,
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

    pub fn prune_finished_scenes(&mut self, t_now_sec: f64) {
        self.active_scenes.retain(|s| !s.is_finished(t_now_sec));
    }

    pub fn trigger_scene(&mut self, scene: &SceneDef, t_now_sec: f64) {
        self.prune_finished_scenes(t_now_sec);
        let norm_bank = scene
            .bank
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        if let Some(ref bank_name) = norm_bank {
            for active in &mut self.active_scenes {
                if active.scene_id != scene.id
                    && active.bank.as_deref() == Some(bank_name.as_str())
                    && active.release_t_sec.is_none()
                {
                    let cur_alpha = active.alpha_at(t_now_sec);
                    active.release_start_alpha = cur_alpha;
                    active.release_t_sec = Some(t_now_sec);
                }
            }
        }

        self.active_scenes.retain(|s| s.scene_id != scene.id);
        let order = self.next_scene_trigger_order.max(1);
        self.next_scene_trigger_order = order.saturating_add(1);

        self.active_scenes.push(ActiveSceneInstance {
            scene_id: scene.id.clone(),
            bank: norm_bank,
            trigger_t_sec: t_now_sec,
            trigger_beat: self.beat_clock.beat_at(t_now_sec),
            trigger_order: order,
            fade_in_sec: scene.fade_in_sec.max(0.0),
            fade_out_sec: scene.fade_out_sec.max(0.0),
            release_t_sec: None,
            release_start_alpha: 1.0,
        });
    }

    pub fn release_scene(&mut self, scene_id: &str, t_now_sec: f64) {
        for active in &mut self.active_scenes {
            if active.scene_id == scene_id && active.release_t_sec.is_none() {
                active.release_start_alpha = active.alpha_at(t_now_sec);
                active.release_t_sec = Some(t_now_sec);
            }
        }
        self.prune_finished_scenes(t_now_sec);
    }

    pub fn release_all_scenes(&mut self, t_now_sec: f64) {
        for active in &mut self.active_scenes {
            if active.release_t_sec.is_none() {
                active.release_start_alpha = active.alpha_at(t_now_sec);
                active.release_t_sec = Some(t_now_sec);
            }
        }
        self.prune_finished_scenes(t_now_sec);
    }

    pub fn set_live_bpm(&mut self, bpm: f32, t_now_sec: f64) {
        if !bpm.is_nan() {
            self.beat_clock.set_bpm_phase_continuous(bpm, t_now_sec);
        }
    }

    pub fn tap_tempo(&mut self, tap_t_sec: f64) -> f32 {
        if let Some(&last) = self.tap_history_sec.last() {
            if (tap_t_sec - last).abs() > 3.0 || tap_t_sec < last {
                self.tap_history_sec.clear();
            }
        }
        self.tap_history_sec.push(tap_t_sec);
        if self.tap_history_sec.len() > 8 {
            let excess = self.tap_history_sec.len() - 8;
            self.tap_history_sec.drain(0..excess);
        }
        if self.tap_history_sec.len() >= 2 {
            let span =
                self.tap_history_sec[self.tap_history_sec.len() - 1] - self.tap_history_sec[0];
            let intervals = (self.tap_history_sec.len() - 1) as f64;
            if span > 1e-4 {
                let bpm = ((60.0 * intervals) / span) as f32;
                self.set_live_bpm(bpm, tap_t_sec);
            }
        }
        self.beat_clock.bpm
    }

    pub fn set_timeline_transport(
        &mut self,
        timeline_id: Option<String>,
        playing: bool,
        playhead_sec: Option<f64>,
        clock_t_now_sec: f64,
    ) {
        self.active_timeline_id = timeline_id.filter(|s| !s.trim().is_empty());
        if self.active_timeline_id.is_none() {
            self.timeline_playing = false;
            self.timeline_playhead_sec = 0.0;
            self.timeline_start_anchor_t_sec = clock_t_now_sec;
            return;
        }
        if self.timeline_playing && playhead_sec.is_none() {
            self.timeline_playhead_sec += (clock_t_now_sec - self.timeline_start_anchor_t_sec).max(0.0);
        }
        if let Some(pos) = playhead_sec {
            if !pos.is_nan() {
                self.timeline_playhead_sec = pos.max(0.0);
            }
        }
        self.timeline_playing = playing;
        self.timeline_start_anchor_t_sec = clock_t_now_sec;
    }

    pub fn seek_timeline(&mut self, playhead_sec: f64, clock_t_now_sec: f64) {
        if !playhead_sec.is_nan() {
            self.timeline_playhead_sec = playhead_sec.max(0.0);
            self.timeline_start_anchor_t_sec = clock_t_now_sec;
        }
    }

    pub fn set_latency_offset_ms(&mut self, offset_ms: f64) {
        if !offset_ms.is_nan() {
            self.latency_offset_ms = offset_ms.clamp(-500.0, 500.0);
        }
    }

    pub fn set_identified_fixture(&mut self, fixture_id: Option<String>) {
        self.identified_fixture_id = fixture_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
    }

    pub fn effective_timeline_playhead_sec(&self, clock_t_sec: f64) -> Option<f64> {
        self.active_timeline_id.as_ref()?;
        let base = if self.timeline_playing {
            self.timeline_playhead_sec + (clock_t_sec - self.timeline_start_anchor_t_sec).max(0.0)
        } else {
            self.timeline_playhead_sec
        };
        Some((base + self.latency_offset_ms / 1000.0).max(0.0))
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
