use std::collections::HashMap;
use std::f32::consts::PI;

use arc_swap::ArcSwap;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const STREAM_CHUNK_FRAMES: usize = 4096;
pub const FFT_SIZE: usize = 1024;
pub const LOW_DECIMATION_FACTOR: usize = 4;
pub const LOW_HOP_SAMPLES: usize = 64;
pub const HIGH_HOP_SAMPLES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransientBand {
    Kick,
    Snare,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransientMarker {
    pub time_sec: f64,
    pub band: TransientBand,
    pub strength: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WaveformPeak {
    pub min: f32,
    pub max: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioAnalysisResult {
    pub sha256: String,
    pub sample_rate: u32,
    pub duration_sec: f64,
    pub estimated_bpm: f32,
    pub grid_offset_sec: f64,
    pub transients: Vec<TransientMarker>,
    pub waveform_peaks: Vec<WaveformPeak>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioCallbackSnapshot {
    pub samples_played: u64,
    pub sample_rate: u32,
    pub callback_instant_ns: u64,
    pub buffer_duration_ns: u64,
    pub is_playing: bool,
}

pub trait AudioClock: Send + Sync {
    fn timeline_time_sec(&self, now_ns: u64, latency_offset_ms: f64) -> Option<f64>;
}

pub fn evaluate_interpolated_clock_sec(
    snap: &AudioCallbackSnapshot,
    now_ns: u64,
    latency_offset_ms: f64,
) -> Option<f64> {
    if snap.sample_rate == 0 {
        return None;
    }
    let base_sec = (snap.samples_played as f64) / (snap.sample_rate as f64);
    let elapsed_clamped_sec = if snap.is_playing {
        let dt_ns = now_ns.saturating_sub(snap.callback_instant_ns);
        let clamped_ns = dt_ns.min(snap.buffer_duration_ns);
        (clamped_ns as f64) * 1e-9
    } else {
        0.0
    };
    let raw_sec = base_sec + elapsed_clamped_sec + (latency_offset_ms / 1000.0);
    Some(raw_sec.max(0.0))
}

#[derive(Debug, Default)]
pub struct InterpolatedAudioClock {
    snapshot: ArcSwap<Option<AudioCallbackSnapshot>>,
}

impl InterpolatedAudioClock {
    pub fn new() -> Self {
        Self {
            snapshot: ArcSwap::from_pointee(None),
        }
    }

    pub fn publish(&self, snapshot: Option<AudioCallbackSnapshot>) {
        self.snapshot.store(std::sync::Arc::new(snapshot));
    }

    pub fn latest_snapshot(&self) -> Option<AudioCallbackSnapshot> {
        **self.snapshot.load()
    }
}

impl AudioClock for InterpolatedAudioClock {
    fn timeline_time_sec(&self, now_ns: u64, latency_offset_ms: f64) -> Option<f64> {
        let guard = self.snapshot.load();
        guard
            .as_ref()
            .as_ref()
            .and_then(|snap| evaluate_interpolated_clock_sec(snap, now_ns, latency_offset_ms))
    }
}

#[derive(Debug, Default)]
pub struct MockAudioClock {
    inner: InterpolatedAudioClock,
}

impl MockAudioClock {
    pub fn new() -> Self {
        Self {
            inner: InterpolatedAudioClock::new(),
        }
    }

    pub fn set_snapshot(&self, snapshot: Option<AudioCallbackSnapshot>) {
        self.inner.publish(snapshot);
    }
}

impl AudioClock for MockAudioClock {
    fn timeline_time_sec(&self, now_ns: u64, latency_offset_ms: f64) -> Option<f64> {
        self.inner.timeline_time_sec(now_ns, latency_offset_ms)
    }
}

#[derive(Debug, Clone, Default)]
pub struct AudioAnalysisCache {
    entries: HashMap<String, AudioAnalysisResult>,
    pub cache_hits: u64,
}

impl AudioAnalysisCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn key(sha256: &str, transient_sensitivity: f32) -> String {
        let clamped_q = (transient_sensitivity.clamp(0.0, 1.0) * 1000.0).round() as u32;
        format!("{sha256}:{clamped_q}")
    }

    pub fn get(&mut self, sha256: &str, transient_sensitivity: f32) -> Option<AudioAnalysisResult> {
        let key = Self::key(sha256, transient_sensitivity);
        if let Some(hit) = self.entries.get(&key).cloned() {
            self.cache_hits += 1;
            return Some(hit);
        }
        None
    }

    pub fn insert(&mut self, transient_sensitivity: f32, result: AudioAnalysisResult) {
        const MAX_AUDIO_CACHE_ENTRIES: usize = 32;
        if self.entries.len() >= MAX_AUDIO_CACHE_ENTRIES {
            if let Some(evict_key) = self.entries.keys().next().cloned() {
                self.entries.remove(&evict_key);
            }
        }
        let key = Self::key(&result.sha256, transient_sensitivity);
        self.entries.insert(key, result);
    }
}

pub fn compute_sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}

#[derive(Clone, Copy)]
struct Complex {
    re: f32,
    im: f32,
}

fn fft_in_place(buf: &mut [Complex; FFT_SIZE]) {
    let mut j = 0usize;
    for i in 1..FFT_SIZE {
        let mut bit = FFT_SIZE >> 1;
        while (j & bit) != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            buf.swap(i, j);
        }
    }

    let mut len = 2usize;
    while len <= FFT_SIZE {
        let half = len / 2;
        let angle = -2.0 * PI / (len as f32);
        let wlen = Complex {
            re: angle.cos(),
            im: angle.sin(),
        };
        let mut i = 0usize;
        while i < FFT_SIZE {
            let mut w = Complex { re: 1.0, im: 0.0 };
            for k in 0..half {
                let u = buf[i + k];
                let v_raw = buf[i + k + half];
                let v = Complex {
                    re: v_raw.re * w.re - v_raw.im * w.im,
                    im: v_raw.re * w.im + v_raw.im * w.re,
                };
                buf[i + k] = Complex {
                    re: u.re + v.re,
                    im: u.im + v.im,
                };
                buf[i + k + half] = Complex {
                    re: u.re - v.re,
                    im: u.im - v.im,
                };
                w = Complex {
                    re: w.re * wlen.re - w.im * wlen.im,
                    im: w.re * wlen.im + w.im * wlen.re,
                };
            }
            i += len;
        }
        len <<= 1;
    }
}

fn build_hann_window() -> [f32; FFT_SIZE] {
    let mut win = [0.0f32; FFT_SIZE];
    for (n, slot) in win.iter_mut().enumerate() {
        *slot = 0.5 * (1.0 - (2.0 * PI * (n as f32) / (FFT_SIZE as f32)).cos());
    }
    win
}

struct StreamingBandAnalyzer {
    band_sample_rate: f64,
    hop_samples: usize,
    bin_lo: usize,
    bin_hi: usize,
    window: [f32; FFT_SIZE],
    ring: Vec<f32>,
    write_pos: usize,
    filled: usize,
    total_samples: u64,
    hop_countdown: usize,
    prev_mag: Vec<f32>,
    fft_buf: [Complex; FFT_SIZE],
    pub flux: Vec<f32>,
    pub frame_times_sec: Vec<f64>,
}

impl StreamingBandAnalyzer {
    fn new(band_sample_rate: f64, hop_samples: usize, freq_lo_hz: f64, freq_hi_hz: f64) -> Self {
        let bin_hz = band_sample_rate / (FFT_SIZE as f64);
        let bin_lo = ((freq_lo_hz / bin_hz).floor() as usize).max(1);
        let bin_hi = ((freq_hi_hz / bin_hz).ceil() as usize).min(FFT_SIZE / 2 - 1);
        Self {
            band_sample_rate,
            hop_samples,
            bin_lo,
            bin_hi,
            window: build_hann_window(),
            ring: vec![0.0f32; FFT_SIZE],
            write_pos: 0,
            filled: 0,
            total_samples: 0,
            hop_countdown: FFT_SIZE,
            prev_mag: vec![0.0f32; FFT_SIZE / 2],
            fft_buf: [Complex { re: 0.0, im: 0.0 }; FFT_SIZE],
            flux: Vec::new(),
            frame_times_sec: Vec::new(),
        }
    }

    fn push_sample(&mut self, sample: f32) {
        self.ring[self.write_pos] = sample;
        self.write_pos = (self.write_pos + 1) & (FFT_SIZE - 1);
        if self.filled < FFT_SIZE {
            self.filled += 1;
        }
        self.total_samples += 1;
        self.hop_countdown = self.hop_countdown.saturating_sub(1);

        if self.filled == FFT_SIZE && self.hop_countdown == 0 {
            self.compute_frame();
            self.hop_countdown = self.hop_samples;
        }
    }

    fn compute_frame(&mut self) {
        let start = self.write_pos;
        for i in 0..FFT_SIZE {
            let ring_idx = (start + i) & (FFT_SIZE - 1);
            self.fft_buf[i] = Complex {
                re: self.ring[ring_idx] * self.window[i],
                im: 0.0,
            };
        }
        fft_in_place(&mut self.fft_buf);

        let mut pos_flux = 0.0f32;
        for bin in self.bin_lo..=self.bin_hi {
            let c = self.fft_buf[bin];
            let mag = (c.re * c.re + c.im * c.im).sqrt();
            let diff = mag - self.prev_mag[bin];
            if diff > 0.0 {
                pos_flux += diff;
            }
            self.prev_mag[bin] = mag;
        }

        let center_sample = self.total_samples.saturating_sub((FFT_SIZE / 2) as u64);
        let time_sec = (center_sample as f64) / self.band_sample_rate;
        self.flux.push(pos_flux);
        self.frame_times_sec.push(time_sec);
    }
}

fn pick_transients(
    flux: &[f32],
    times: &[f64],
    band: TransientBand,
    sensitivity: f32,
) -> Vec<TransientMarker> {
    if flux.len() < 3 {
        return Vec::new();
    }
    let sens = sensitivity.clamp(0.0, 1.0);
    let max_flux = flux.iter().copied().fold(0.0f32, f32::max);
    if max_flux <= 1e-6 {
        return Vec::new();
    }

    let mult = 1.4 + (1.0 - sens) * 2.4;
    let abs_floor = max_flux * (0.14 - 0.09 * sens).max(0.02);
    let radius = 16usize;
    let mut scratch = Vec::with_capacity(radius * 2 + 1);
    let mut candidates = Vec::new();

    for i in 1..(flux.len() - 1) {
        let cur = flux[i];
        if cur < flux[i - 1] || cur <= flux[i + 1] {
            continue;
        }
        let lo = i.saturating_sub(radius);
        let hi = (i + radius + 1).min(flux.len());
        scratch.clear();
        scratch.extend_from_slice(&flux[lo..hi]);
        scratch.sort_by(|a, b| a.total_cmp(b));
        let median = scratch[scratch.len() / 2];
        let thresh = median * mult + abs_floor;
        if cur > thresh {
            candidates.push((i, cur));
        }
    }

    // Greedy non-maximum suppression within 85 ms to avoid double-triggering on a single burst
    let min_gap_sec = 0.085;
    let mut selected: Vec<TransientMarker> = Vec::new();
    for (idx, val) in candidates {
        let t = times[idx];
        let strength = (val / max_flux).clamp(0.0, 1.0);
        if let Some(last) = selected.last_mut() {
            if t - last.time_sec < min_gap_sec {
                if strength > last.strength {
                    last.time_sec = t;
                    last.strength = strength;
                }
                continue;
            }
        }
        selected.push(TransientMarker {
            time_sec: t,
            band,
            strength,
        });
    }

    selected
}

fn build_time_aligned_excess(
    flux: &[f32],
    times: &[f64],
    hop_sec: f64,
    out: &mut [f64],
) {
    let max_flux = flux.iter().copied().fold(0.0f32, f32::max);
    if max_flux <= 1e-6 || out.is_empty() {
        return;
    }
    let radius = 12usize;
    let mut scratch = Vec::with_capacity(radius * 2 + 1);
    for (i, &val) in flux.iter().enumerate() {
        let lo = i.saturating_sub(radius);
        let hi = (i + radius + 1).min(flux.len());
        scratch.clear();
        scratch.extend_from_slice(&flux[lo..hi]);
        scratch.sort_by(|a, b| a.total_cmp(b));
        let median = scratch[scratch.len() / 2];
        let excess = ((val - median * 1.2) / max_flux).max(0.0) as f64;
        if excess > 0.0 {
            let bin = (times[i] / hop_sec).round() as isize;
            if bin >= 0 && (bin as usize) < out.len() {
                out[bin as usize] += excess;
            }
        }
    }
}

fn estimate_bpm_autocorrelation(
    low_flux: &[f32],
    low_times: &[f64],
    high_flux: &[f32],
    high_times: &[f64],
    duration_sec: f64,
    hop_sec: f64,
) -> f32 {
    if hop_sec <= 0.0 || duration_sec <= 0.5 {
        return 120.0;
    }
    let n = ((duration_sec / hop_sec).ceil() as usize).max(1);
    if n < 32 {
        return 120.0;
    }

    let mut combined = vec![0.0f64; n];
    build_time_aligned_excess(low_flux, low_times, hop_sec, &mut combined);
    build_time_aligned_excess(high_flux, high_times, hop_sec, &mut combined);

    let min_lag = ((60.0 / 180.0) / hop_sec).floor() as usize;
    let max_lag = (((60.0 / 60.0) / hop_sec).ceil() as usize).min(n.saturating_sub(4));
    if max_lag <= min_lag + 2 {
        return 120.0;
    }

    let mut corr_by_lag = vec![0.0f64; max_lag + 2];
    for lag in (min_lag.saturating_sub(1))..=(max_lag + 1).min(n - 1) {
        if lag == 0 || lag >= n {
            continue;
        }
        let mut sum = 0.0f64;
        let overlap = n - lag;
        for i in 0..overlap {
            sum += combined[i] * combined[i + lag];
        }
        let norm_corr = sum / (overlap as f64);
        let bpm = 60.0 / ((lag as f64) * hop_sec);
        let octave_ratio = (bpm / 120.0).log2();
        let prior = (-0.5 * (octave_ratio / 0.55).powi(2)).exp();
        corr_by_lag[lag] = norm_corr * prior;
    }

    let mut best_lag = min_lag;
    let mut best_score = f64::NEG_INFINITY;
    for lag in min_lag..=max_lag {
        if corr_by_lag[lag] > best_score {
            best_score = corr_by_lag[lag];
            best_lag = lag;
        }
    }

    if best_score <= 1e-9 {
        return 120.0;
    }

    // Parabolic interpolation around best_lag to avoid discrete hop quantization drift
    let refined_lag = if best_lag > min_lag && best_lag < max_lag {
        let y0 = corr_by_lag[best_lag - 1];
        let y1 = corr_by_lag[best_lag];
        let y2 = corr_by_lag[best_lag + 1];
        let denom = y0 - 2.0 * y1 + y2;
        if denom.abs() > 1e-12 {
            let delta = (0.5 * (y0 - y2) / denom).clamp(-0.5, 0.5);
            (best_lag as f64) + delta
        } else {
            best_lag as f64
        }
    } else {
        best_lag as f64
    };

    let bpm = 60.0 / (refined_lag * hop_sec);
    (bpm as f32).clamp(60.0, 180.0)
}

/// Analyze an audio stream chunk-by-chunk (`<= STREAM_CHUNK_FRAMES` per chunk) so
/// peak working memory stays bounded (`< 2 MB`) even on long recordings.
pub fn analyze_streaming_chunks<I>(
    sample_rate: u32,
    channels: usize,
    sha256: String,
    transient_sensitivity: f32,
    chunks: I,
) -> AudioAnalysisResult
where
    I: IntoIterator<Item = Vec<f32>>,
{
    let sr = sample_rate.max(8000);
    let ch = channels.max(1);
    let low_sr = (sr as f64) / (LOW_DECIMATION_FACTOR as f64);

    let mut low_band = StreamingBandAnalyzer::new(low_sr, LOW_HOP_SAMPLES, 40.0, 140.0);
    let mut high_band = StreamingBandAnalyzer::new(sr as f64, HIGH_HOP_SAMPLES, 1500.0, 8000.0);

    // 7-tap Hamming-windowed sinc approximation anti-alias kernel for 4:1 decimation
    const AA_TAPS: [f32; 7] = [0.04, 0.11, 0.21, 0.28, 0.21, 0.11, 0.04];
    let mut aa_hist = [0.0f32; 7];
    let mut aa_phase = 0usize;

    let samples_per_peak = ((sr as usize) / 100).max(1);
    let mut cur_min = f32::INFINITY;
    let mut cur_max = f32::NEG_INFINITY;
    let mut cur_peak_count = 0usize;
    let mut waveform_peaks = Vec::new();

    let mut mono_buf = Vec::with_capacity(STREAM_CHUNK_FRAMES);
    let mut total_frames: u64 = 0;

    for chunk in chunks {
        let frames_in_chunk = chunk.len() / ch;
        for frame_start in (0..frames_in_chunk).step_by(STREAM_CHUNK_FRAMES) {
            let frame_end = (frame_start + STREAM_CHUNK_FRAMES).min(frames_in_chunk);
            mono_buf.clear();
            for f in frame_start..frame_end {
                let base = f * ch;
                let mut sum = 0.0f32;
                for c in 0..ch {
                    sum += chunk[base + c];
                }
                mono_buf.push(sum / (ch as f32));
            }

            for &s in &mono_buf {
                total_frames += 1;

                // Update waveform peak bucket
                cur_min = cur_min.min(s);
                cur_max = cur_max.max(s);
                cur_peak_count += 1;
                if cur_peak_count >= samples_per_peak {
                    waveform_peaks.push(WaveformPeak {
                        min: cur_min,
                        max: cur_max,
                    });
                    cur_min = f32::INFINITY;
                    cur_max = f32::NEG_INFINITY;
                    cur_peak_count = 0;
                }

                // Feed high-rate band (1.5 kHz to 8 kHz)
                high_band.push_sample(s);

                // Anti-aliased 4:1 decimator feeding low-rate band (40 Hz to 140 Hz)
                aa_hist.copy_within(1.., 0);
                aa_hist[6] = s;
                aa_phase += 1;
                if aa_phase >= LOW_DECIMATION_FACTOR {
                    aa_phase = 0;
                    let mut decimated = 0.0f32;
                    for (t, h) in AA_TAPS.iter().zip(aa_hist.iter()) {
                        decimated += t * h;
                    }
                    low_band.push_sample(decimated);
                }
            }
        }
    }

    if cur_peak_count > 0 {
        waveform_peaks.push(WaveformPeak {
            min: cur_min,
            max: cur_max,
        });
    }

    let mut kicks = pick_transients(
        &low_band.flux,
        &low_band.frame_times_sec,
        TransientBand::Kick,
        transient_sensitivity,
    );
    let mut snares = pick_transients(
        &high_band.flux,
        &high_band.frame_times_sec,
        TransientBand::Snare,
        transient_sensitivity,
    );

    let grid_offset_sec = kicks
        .first()
        .map(|k| k.time_sec)
        .unwrap_or(0.0);

    let duration_sec = (total_frames as f64) / (sr as f64);
    let hop_sec = (HIGH_HOP_SAMPLES as f64) / (sr as f64);
    let estimated_bpm = estimate_bpm_autocorrelation(
        &low_band.flux,
        &low_band.frame_times_sec,
        &high_band.flux,
        &high_band.frame_times_sec,
        duration_sec,
        hop_sec,
    );

    let mut transients = Vec::with_capacity(kicks.len() + snares.len());
    transients.append(&mut kicks);
    transients.append(&mut snares);
    transients.sort_by(|a, b| a.time_sec.total_cmp(&b.time_sec));

    AudioAnalysisResult {
        sha256,
        sample_rate: sr,
        duration_sec,
        estimated_bpm,
        grid_offset_sec,
        transients,
        waveform_peaks,
    }
}

/// Parse uncompressed PCM WAV bytes (16-bit int or 32-bit float) via streaming `4096`-frame chunks.
pub fn analyze_wav_bytes_streaming(
    wav_bytes: &[u8],
    transient_sensitivity: f32,
) -> Result<AudioAnalysisResult, String> {
    if wav_bytes.len() < 44 || &wav_bytes[0..4] != b"RIFF" || &wav_bytes[8..12] != b"WAVE" {
        return Err("invalid WAV header".into());
    }

    let mut pos = 12usize;
    let mut audio_format: u16 = 0;
    let mut channels: u16 = 0;
    let mut sample_rate: u32 = 0;
    let mut bits_per_sample: u16 = 0;
    let mut data_slice: Option<&[u8]> = None;

    while pos + 8 <= wav_bytes.len() {
        let id = &wav_bytes[pos..pos + 4];
        let size = u32::from_le_bytes(wav_bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let payload_start = pos + 8;
        let payload_end = (payload_start + size).min(wav_bytes.len());
        if id == b"fmt " && payload_end >= payload_start + 16 {
            let p = &wav_bytes[payload_start..payload_end];
            audio_format = u16::from_le_bytes([p[0], p[1]]);
            channels = u16::from_le_bytes([p[2], p[3]]);
            sample_rate = u32::from_le_bytes([p[4], p[5], p[6], p[7]]);
            bits_per_sample = u16::from_le_bytes([p[14], p[15]]);
        } else if id == b"data" {
            data_slice = Some(&wav_bytes[payload_start..payload_end]);
        }
        pos = payload_start + size + (size & 1);
    }

    let data = data_slice.ok_or_else(|| "missing WAV data chunk".to_string())?;
    if channels == 0 || sample_rate == 0 {
        return Err("invalid WAV format parameters".into());
    }
    let bytes_per_sample = match (audio_format, bits_per_sample) {
        (1, 16) => 2usize,
        (1, 24) => 3usize,
        (3, 32) => 4usize,
        _ => return Err(format!("unsupported WAV format {audio_format}/{bits_per_sample}-bit")),
    };

    let sha256 = compute_sha256_hex(wav_bytes);
    let ch = channels as usize;
    let frame_bytes = ch * bytes_per_sample;
    let total_frames = data.len() / frame_bytes;

    let chunks = (0..total_frames)
        .step_by(STREAM_CHUNK_FRAMES)
        .map(|f_start| {
            let f_end = (f_start + STREAM_CHUNK_FRAMES).min(total_frames);
            let mut out = Vec::with_capacity((f_end - f_start) * ch);
            for f in f_start..f_end {
                let base = f * frame_bytes;
                for c in 0..ch {
                    let s_off = base + c * bytes_per_sample;
                    let sample = if audio_format == 1 && bits_per_sample == 16 {
                        let raw = i16::from_le_bytes([data[s_off], data[s_off + 1]]);
                        (raw as f32) / 32768.0
                    } else if audio_format == 1 && bits_per_sample == 24 {
                        let b0 = data[s_off] as i32;
                        let b1 = (data[s_off + 1] as i32) << 8;
                        let b2 = (data[s_off + 2] as i8 as i32) << 16;
                        ((b0 | b1 | b2) as f32) / 8_388_608.0
                    } else {
                        f32::from_le_bytes([
                            data[s_off],
                            data[s_off + 1],
                            data[s_off + 2],
                            data[s_off + 3],
                        ])
                    };
                    out.push(sample);
                }
            }
            out
        });

    Ok(analyze_streaming_chunks(
        sample_rate,
        ch,
        sha256,
        transient_sensitivity,
        chunks,
    ))
}

/// Generate a synthetic drum track (80 Hz kick on beats 1 & 3, 3 kHz snare on beats 2 & 4)
/// in `4096`-frame mono chunks for deterministic unit testing and studio preview.
pub fn generate_synthetic_drum_track_chunks(
    sample_rate: u32,
    bpm: f32,
    duration_sec: f64,
    grid_offset_sec: f64,
) -> Vec<Vec<f32>> {
    let total_frames = (duration_sec * (sample_rate as f64)).round() as usize;
    let beat_period = 60.0 / (bpm.max(20.0) as f64);

    let mut beat_events: Vec<(f64, bool)> = Vec::new();
    let mut t = grid_offset_sec;
    let mut beat_idx = 0usize;
    while t < duration_sec - 0.05 {
        let is_kick = beat_idx % 2 == 0;
        beat_events.push((t, is_kick));
        beat_idx += 1;
        t += beat_period;
    }

    let mut chunks = Vec::new();
    for start in (0..total_frames).step_by(STREAM_CHUNK_FRAMES) {
        let end = (start + STREAM_CHUNK_FRAMES).min(total_frames);
        let mut chunk = vec![0.0f32; end - start];
        for (i, slot) in chunk.iter_mut().enumerate() {
            let sample_idx = start + i;
            let cur_t = (sample_idx as f64) / (sample_rate as f64);
            let mut val = 0.0f64;
            for &(evt_t, is_kick) in &beat_events {
                let dt = cur_t - evt_t;
                if (0.0..0.090).contains(&dt) {
                    if is_kick {
                        let env = (-dt / 0.032).exp();
                        val += env * (2.0 * std::f64::consts::PI * 80.0 * dt).sin();
                    } else {
                        let env = (-dt / 0.025).exp();
                        val += env * (2.0 * std::f64::consts::PI * 3000.0 * dt).sin();
                    }
                }
            }
            *slot = val.clamp(-1.0, 1.0) as f32;
        }
        chunks.push(chunk);
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolated_audio_clock_smooths_buffer_callbacks_handles_drift_and_clamps_negative_latency() {
        let clock = MockAudioClock::new();
        assert_eq!(clock.timeline_time_sec(100_000_000, 0.0), None);

        // Buffer chunk of 512 frames @ 48000 Hz = ~10.667 ms
        let sr = 48_000u32;
        let buf_ns = 10_666_667u64;
        clock.set_snapshot(Some(AudioCallbackSnapshot {
            samples_played: 0,
            sample_rate: sr,
            callback_instant_ns: 1_000_000_000,
            buffer_duration_ns: buf_ns,
            is_playing: true,
        }));

        // Initial audio latency offset -25 ms holds playhead at 0.0 while t < 0
        assert_eq!(
            clock.timeline_time_sec(1_005_000_000, -25.0),
            Some(0.0)
        );

        // Simulated 44 Hz lighting polls within one 21.3 ms audio buffer remain smooth and clamped
        clock.set_snapshot(Some(AudioCallbackSnapshot {
            samples_played: 44_100,
            sample_rate: 44_100,
            callback_instant_ns: 2_000_000_000,
            buffer_duration_ns: 21_333_333,
            is_playing: true,
        }));

        let t0 = clock.timeline_time_sec(2_000_000_000, 5.0).unwrap();
        let t1 = clock.timeline_time_sec(2_010_000_000, 5.0).unwrap();
        let t2 = clock.timeline_time_sec(2_020_000_000, 5.0).unwrap();
        let t_late_stall = clock.timeline_time_sec(2_100_000_000, 5.0).unwrap();

        assert!((t0 - 1.005).abs() < 1e-6);
        assert!((t1 - 1.015).abs() < 1e-6);
        assert!((t2 - 1.025).abs() < 1e-6);
        // Past buffer_duration_ns, interpolation freezes instead of drifting away unboundedly
        assert!((t_late_stall - (1.005 + 0.021_333_333)).abs() < 1e-6);
    }

    #[test]
    fn streaming_detector_identifies_80hz_kick_and_3khz_snare_onsets_within_bounded_memory() {
        let sr = 44_100u32;
        let total_sec = 4.0f64;
        // Kick bursts at t = 0.50s and t = 2.00s (80 Hz); Snare bursts at t = 1.25s and t = 2.75s (3 kHz)
        let events = [(0.50f64, true), (1.25, false), (2.00, true), (2.75, false)];
        let total_frames = (total_sec * (sr as f64)) as usize;
        let mut chunks = Vec::new();
        for start in (0..total_frames).step_by(STREAM_CHUNK_FRAMES) {
            let end = (start + STREAM_CHUNK_FRAMES).min(total_frames);
            assert!(end - start <= STREAM_CHUNK_FRAMES);
            let mut buf = vec![0.0f32; end - start];
            for (i, slot) in buf.iter_mut().enumerate() {
                let t = ((start + i) as f64) / (sr as f64);
                let mut val = 0.0f64;
                for &(evt_t, is_kick) in &events {
                    let dt = t - evt_t;
                    if (0.0..0.08).contains(&dt) {
                        if is_kick {
                            val += (-dt / 0.03).exp() * (2.0 * std::f64::consts::PI * 80.0 * dt).sin();
                        } else {
                            val += (-dt / 0.025).exp() * (2.0 * std::f64::consts::PI * 3000.0 * dt).sin();
                        }
                    }
                }
                *slot = val as f32;
            }
            chunks.push(buf);
        }

        let res = analyze_streaming_chunks(sr, 1, "synthetic_ks".into(), 0.65, chunks);
        let kicks: Vec<f64> = res
            .transients
            .iter()
            .filter(|m| m.band == TransientBand::Kick)
            .map(|m| m.time_sec)
            .collect();
        let snares: Vec<f64> = res
            .transients
            .iter()
            .filter(|m| m.band == TransientBand::Snare)
            .map(|m| m.time_sec)
            .collect();

        assert!(kicks.iter().any(|&t| (t - 0.50).abs() < 0.05), "kicks={kicks:?}");
        assert!(kicks.iter().any(|&t| (t - 2.00).abs() < 0.05), "kicks={kicks:?}");
        assert!(snares.iter().any(|&t| (t - 1.25).abs() < 0.05), "snares={snares:?}");
        assert!(snares.iter().any(|&t| (t - 2.75).abs() < 0.05), "snares={snares:?}");
        assert!(!waveform_size_exceeds_budget(&res));
    }

    fn waveform_size_exceeds_budget(res: &AudioAnalysisResult) -> bool {
        let bytes = res.waveform_peaks.len() * std::mem::size_of::<WaveformPeak>()
            + res.transients.len() * std::mem::size_of::<TransientMarker>();
        bytes >= 2 * 1024 * 1024
    }

    #[test]
    fn tempo_estimator_accurately_detects_120_bpm_and_128_bpm_and_seeds_grid_offset() {
        let sr = 44_100u32;

        let chunks_120 = generate_synthetic_drum_track_chunks(sr, 120.0, 12.0, 0.120);
        let res_120 = analyze_streaming_chunks(sr, 1, "hash_120".into(), 0.65, chunks_120);
        assert!(
            (res_120.estimated_bpm - 120.0).abs() <= 1.0,
            "expected ~120 BPM, got {}",
            res_120.estimated_bpm
        );
        assert!(
            (res_120.grid_offset_sec - 0.120).abs() < 0.05,
            "expected grid_offset near 0.120s, got {}",
            res_120.grid_offset_sec
        );

        let chunks_128 = generate_synthetic_drum_track_chunks(sr, 128.0, 12.0, 0.250);
        let res_128 = analyze_streaming_chunks(sr, 1, "hash_128".into(), 0.65, chunks_128);
        assert!(
            (res_128.estimated_bpm - 128.0).abs() <= 1.0,
            "expected ~128 BPM, got {}",
            res_128.estimated_bpm
        );
        assert!(
            (res_128.grid_offset_sec - 0.250).abs() < 0.05,
            "expected grid_offset near 0.250s, got {}",
            res_128.grid_offset_sec
        );
    }

    #[test]
    fn analysis_cache_returns_cached_result_on_unchanged_sha256_hash() {
        let mut cache = AudioAnalysisCache::new();
        let chunks = generate_synthetic_drum_track_chunks(44_100, 120.0, 6.0, 0.0);
        let first = analyze_streaming_chunks(44_100, 1, "same_sha256".into(), 0.65, chunks);
        cache.insert(0.65, first.clone());

        assert_eq!(cache.cache_hits, 0);
        let hit = cache.get("same_sha256", 0.65).expect("expected cache hit");
        assert_eq!(hit, first);
        assert_eq!(cache.cache_hits, 1);
        assert!(cache.get("different_sha256", 0.65).is_none());
    }
}
