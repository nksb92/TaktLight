use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

pub const JITTER_WINDOW_CAPACITY: usize = 256;
pub const TARGET_FRAME_INTERVAL_US: f32 = 22_727.0;
pub const FRAME_PERIOD_US: u64 = 22_727;
pub const DROPPED_FRAME_THRESHOLD_US: f32 = TARGET_FRAME_INTERVAL_US * 1.5;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct JitterStats {
    pub mean_us: f32,
    pub max_jitter_us: f32,
    pub p99_jitter_us: f32,
    pub dropped_frames: u32,
    pub sample_count: usize,
}

impl Default for JitterStats {
    fn default() -> Self {
        Self {
            mean_us: TARGET_FRAME_INTERVAL_US,
            max_jitter_us: 0.0,
            p99_jitter_us: 0.0,
            dropped_frames: 0,
            sample_count: 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct JitterTracker {
    samples: VecDeque<f32>,
    dropped_frames: u32,
}

impl Default for JitterTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl JitterTracker {
    pub fn new() -> Self {
        Self {
            samples: VecDeque::with_capacity(JITTER_WINDOW_CAPACITY),
            dropped_frames: 0,
        }
    }

    pub fn record_interval_us(&mut self, delta_us: f32) {
        let skipped = if delta_us > DROPPED_FRAME_THRESHOLD_US {
            1
        } else {
            0
        };
        self.record_interval_with_skipped(delta_us, skipped);
    }

    pub fn record_interval_with_skipped(&mut self, delta_us: f32, skipped_deadlines: u32) {
        if self.samples.len() == JITTER_WINDOW_CAPACITY {
            self.samples.pop_front();
        }
        self.samples.push_back(delta_us);

        let interval_drop = u32::from(delta_us > DROPPED_FRAME_THRESHOLD_US);
        self.dropped_frames = self
            .dropped_frames
            .saturating_add(skipped_deadlines.max(interval_drop));
    }

    pub fn stats(&self) -> JitterStats {
        let n = self.samples.len();
        if n == 0 {
            return JitterStats {
                dropped_frames: self.dropped_frames,
                ..JitterStats::default()
            };
        }

        let sum: f64 = self.samples.iter().map(|&s| s as f64).sum();
        let mean_us = (sum / (n as f64)) as f32;

        let mut abs_jitters: Vec<f32> = self
            .samples
            .iter()
            .map(|&dt| (dt - TARGET_FRAME_INTERVAL_US).abs())
            .collect();
        abs_jitters.sort_by(|a, b| a.total_cmp(b));

        let max_jitter_us = *abs_jitters.last().unwrap_or(&0.0);
        let p99_idx = ((0.99 * (n as f32)).ceil() as usize)
            .saturating_sub(1)
            .min(n - 1);
        let p99_jitter_us = abs_jitters[p99_idx];

        JitterStats {
            mean_us,
            max_jitter_us,
            p99_jitter_us,
            dropped_frames: self.dropped_frames,
            sample_count: n,
        }
    }

    pub fn samples(&self) -> Vec<f32> {
        self.samples.iter().copied().collect()
    }

    pub fn histogram_buckets(&self, bucket_count: usize, min_us: f32, max_us: f32) -> Vec<u32> {
        if bucket_count == 0 {
            return Vec::new();
        }
        let mut buckets = vec![0u32; bucket_count];
        let span = (max_us - min_us).max(1.0);
        for &sample in &self.samples {
            let norm = ((sample - min_us) / span).clamp(0.0, 0.999_999);
            let idx = (norm * (bucket_count as f32)) as usize;
            buckets[idx.min(bucket_count - 1)] += 1;
        }
        buckets
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_tracker_returns_target_mean_and_zero_jitter() {
        let tracker = JitterTracker::new();
        let stats = tracker.stats();
        assert_eq!(stats.mean_us, TARGET_FRAME_INTERVAL_US);
        assert_eq!(stats.max_jitter_us, 0.0);
        assert_eq!(stats.p99_jitter_us, 0.0);
        assert_eq!(stats.dropped_frames, 0);
        assert_eq!(stats.sample_count, 0);
    }

    #[test]
    fn jitter_stats_compute_mean_max_p99_and_dropped_frames() {
        let mut tracker = JitterTracker::new();
        for _ in 0..98 {
            tracker.record_interval_us(22_727.0);
        }
        tracker.record_interval_us(22_777.0);
        tracker.record_interval_us(22_927.0);

        let stats = tracker.stats();
        assert_eq!(stats.sample_count, 100);
        assert!((stats.mean_us - 22_729.5).abs() < 0.01);
        assert!((stats.max_jitter_us - 200.0).abs() < 0.01);
        assert!((stats.p99_jitter_us - 50.0).abs() < 0.01);
        assert_eq!(stats.dropped_frames, 0);

        tracker.record_interval_us(35_000.0);
        let stats2 = tracker.stats();
        assert_eq!(stats2.dropped_frames, 1);
    }

    #[test]
    fn ring_buffer_evicts_oldest_past_256_samples() {
        let mut tracker = JitterTracker::new();
        tracker.record_interval_us(24_000.0);
        for _ in 0..256 {
            tracker.record_interval_us(22_727.0);
        }
        let stats = tracker.stats();
        assert_eq!(stats.sample_count, 256);
        assert!((stats.max_jitter_us - 0.0).abs() < 0.01);
    }

    #[test]
    fn histogram_buckets_bin_samples_and_clamp_outliers() {
        let mut tracker = JitterTracker::new();
        tracker.record_interval_us(22_500.0);
        tracker.record_interval_us(22_727.0);
        tracker.record_interval_us(23_100.0);

        let buckets = tracker.histogram_buckets(10, 22_627.0, 22_827.0);
        assert_eq!(buckets.len(), 10);
        assert_eq!(buckets[0], 1);
        assert_eq!(buckets[5], 1);
        assert_eq!(buckets[9], 1);
    }
}
