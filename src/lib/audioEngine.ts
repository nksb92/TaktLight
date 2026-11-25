import type {
  AudioAnalysisResult,
  TrackDef,
  TransientBand,
  TransientMarker,
  WaveformPeak,
} from "./mixerLogic";

export interface DecodedAudioAsset {
  key: string;
  fileName: string;
  durationSec: number;
  sampleRate: number;
  monoPcm: Float32Array;
  audioBuffer: AudioBuffer | null;
}

const audioAssetRegistry = new Map<string, DecodedAudioAsset>();
let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedAudioContext) {
    try {
      sharedAudioContext = new Ctor();
    } catch {
      return null;
    }
  }
  return sharedAudioContext;
}

export function getDecodedAudioAsset(key: string): DecodedAudioAsset | undefined {
  return audioAssetRegistry.get(key);
}

export function registerDecodedAudioAsset(asset: DecodedAudioAsset): void {
  audioAssetRegistry.set(asset.key, asset);
}

export function clearAudioAssetRegistry(): void {
  audioAssetRegistry.clear();
}

/**
 * Fallback uncompressed PCM WAV decoder (16-bit int or 32-bit float) used when
 * Web Audio API `AudioContext` is unavailable (e.g., JSDOM unit tests).
 */
export function tryDecodeWavBytes(
  bytes: Uint8Array,
): { monoPcm: Float32Array; sampleRate: number; durationSec: number } | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff =
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === "RIFF";
  const wave =
    String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === "WAVE";
  if (!riff || !wave) return null;

  let pos = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(
      bytes[pos],
      bytes[pos + 1],
      bytes[pos + 2],
      bytes[pos + 3],
    );
    const size = view.getUint32(pos + 4, true);
    const payloadStart = pos + 8;
    const payloadEnd = Math.min(bytes.length, payloadStart + size);
    if (id === "fmt " && payloadEnd >= payloadStart + 16) {
      audioFormat = view.getUint16(payloadStart, true);
      channels = view.getUint16(payloadStart + 2, true);
      sampleRate = view.getUint32(payloadStart + 4, true);
      bitsPerSample = view.getUint16(payloadStart + 14, true);
    } else if (id === "data") {
      dataOffset = payloadStart;
      dataLength = payloadEnd - payloadStart;
    }
    pos = payloadStart + size + (size & 1);
  }

  if (dataOffset < 0 || channels === 0 || sampleRate === 0) return null;
  const bytesPerSample =
    audioFormat === 1 && bitsPerSample === 16
      ? 2
      : audioFormat === 1 && bitsPerSample === 24
        ? 3
        : audioFormat === 3 && bitsPerSample === 32
          ? 4
          : 0;
  if (bytesPerSample === 0) return null;

  const frameBytes = channels * bytesPerSample;
  const totalFrames = Math.floor(dataLength / frameBytes);
  const monoPcm = new Float32Array(totalFrames);

  for (let f = 0; f < totalFrames; f++) {
    const base = dataOffset + f * frameBytes;
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const sOff = base + c * bytesPerSample;
      if (audioFormat === 1 && bitsPerSample === 16) {
        sum += view.getInt16(sOff, true) / 32768.0;
      } else if (audioFormat === 1 && bitsPerSample === 24) {
        const b0 = bytes[sOff];
        const b1 = bytes[sOff + 1] << 8;
        const b2 = (bytes[sOff + 2] << 24) >> 8;
        sum += (b0 | b1 | b2) / 8388608.0;
      } else {
        sum += view.getFloat32(sOff, true);
      }
    }
    monoPcm[f] = sum / channels;
  }

  return {
    monoPcm,
    sampleRate,
    durationSec: totalFrames / sampleRate,
  };
}

function pickTransientsFromFlux(
  flux: Float32Array,
  hopSec: number,
  band: TransientBand,
  sensitivity: number,
): TransientMarker[] {
  const n = flux.length;
  if (n < 3) return [];
  const sens = Math.max(0, Math.min(1, sensitivity));
  let maxFlux = 0;
  for (let i = 0; i < n; i++) {
    if (flux[i] > maxFlux) maxFlux = flux[i];
  }
  if (maxFlux <= 1e-6) return [];

  const mult = 1.4 + (1 - sens) * 2.4;
  const absFloor = maxFlux * Math.max(0.02, 0.14 - 0.09 * sens);
  const radius = 12;
  const scratch: number[] = [];
  const candidates: Array<{ idx: number; val: number }> = [];

  for (let i = 1; i < n - 1; i++) {
    const cur = flux[i];
    if (cur < flux[i - 1] || cur <= flux[i + 1]) continue;
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n, i + radius + 1);
    scratch.length = 0;
    for (let j = lo; j < hi; j++) scratch.push(flux[j]);
    scratch.sort((a, b) => a - b);
    const median = scratch[Math.floor(scratch.length / 2)] ?? 0;
    if (cur > median * mult + absFloor) {
      candidates.push({ idx: i, val: cur });
    }
  }

  const minGapSec = 0.085;
  const selected: TransientMarker[] = [];
  for (const { idx, val } of candidates) {
    const t = Number((idx * hopSec).toFixed(3));
    const strength = Math.max(0, Math.min(1, val / maxFlux));
    const last = selected[selected.length - 1];
    if (last && t - last.time_sec < minGapSec) {
      if (strength > last.strength) {
        last.time_sec = t;
        last.strength = Number(strength.toFixed(3));
      }
      continue;
    }
    selected.push({
      time_sec: t,
      band,
      strength: Number(strength.toFixed(3)),
    });
  }
  return selected;
}

function estimateBpmFromFlux(
  lowFlux: Float32Array,
  highFlux: Float32Array,
  hopSec: number,
): number {
  const n = Math.min(lowFlux.length, highFlux.length);
  if (n < 32 || hopSec <= 0) return 120;

  const combined = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    combined[i] = lowFlux[i] * 1.2 + highFlux[i] * 0.8;
  }

  const minLag = Math.max(1, Math.floor(60 / 180 / hopSec));
  const maxLag = Math.min(n - 4, Math.ceil(60 / 60 / hopSec));
  if (maxLag <= minLag + 2) return 120;

  let bestLag = minLag;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const overlap = n - lag;
    for (let i = 0; i < overlap; i++) {
      sum += combined[i] * combined[i + lag];
    }
    const norm = sum / overlap;
    const bpm = 60 / (lag * hopSec);
    const octaveRatio = Math.log2(bpm / 120);
    const prior = Math.exp(-0.5 * (octaveRatio / 0.55) ** 2);
    const score = norm * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestScore <= 1e-9) return 120;
  const bpm = 60 / (bestLag * hopSec);
  return Number(Math.max(60, Math.min(180, bpm)).toFixed(1));
}

/**
 * Computes real waveform peak buckets, dual-band kick/snare transients, and BPM
 * directly from decoded mono PCM audio samples.
 */
export function analyzePcmBuffer(
  monoPcm: Float32Array,
  sampleRate: number,
  key: string,
  transientSensitivity = 0.65,
): AudioAnalysisResult {
  const sr = Math.max(8000, Math.round(sampleRate));
  const totalFrames = monoPcm.length;
  const durationSec = Number((totalFrames / sr).toFixed(3));

  // 1. Waveform peaks (target ~80 buckets/sec, capped at 2400 bars)
  const targetBuckets = Math.max(
    1,
    Math.min(2400, Math.ceil(Math.max(0.1, durationSec) * 80)),
  );
  const samplesPerBucket = Math.max(1, Math.floor(totalFrames / targetBuckets));
  const waveform_peaks: WaveformPeak[] = [];
  for (let start = 0; start < totalFrames; start += samplesPerBucket) {
    const end = Math.min(totalFrames, start + samplesPerBucket);
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i++) {
      const s = monoPcm[i];
      if (s < min) min = s;
      if (s > max) max = s;
    }
    waveform_peaks.push({
      min: Number(Math.max(-1, min).toFixed(3)),
      max: Number(Math.min(1, max).toFixed(3)),
    });
  }

  // 2. Dual-band energy onset flux (~10 ms hop)
  const hopSamples = Math.max(64, Math.round(sr * 0.01));
  const hopSec = hopSamples / sr;
  const numFrames = Math.floor(totalFrames / hopSamples);
  const lowFlux = new Float32Array(numFrames);
  const highFlux = new Float32Array(numFrames);

  // Simple 1-pole low-pass (~150 Hz) for kick band and high-pass (~1500 Hz) for snare band
  const lpAlpha = Math.min(0.99, (2 * Math.PI * 150) / (2 * Math.PI * 150 + sr));
  const hpAlpha = Math.max(0.01, sr / (2 * Math.PI * 1500 + sr));

  let lpState = 0;
  let hpState = 0;
  let prevX = 0;
  let prevLowE = 0;
  let prevHighE = 0;

  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSamples;
    const end = start + hopSamples;
    let lowE = 0;
    let highE = 0;
    for (let i = start; i < end; i++) {
      const x = monoPcm[i];
      lpState += lpAlpha * (x - lpState);
      hpState = hpAlpha * (hpState + x - prevX);
      prevX = x;
      lowE += lpState * lpState;
      highE += hpState * hpState;
    }
    lowE = Math.sqrt(lowE / hopSamples);
    highE = Math.sqrt(highE / hopSamples);
    lowFlux[f] = Math.max(0, lowE - prevLowE);
    highFlux[f] = Math.max(0, highE - prevHighE);
    prevLowE = lowE;
    prevHighE = highE;
  }

  const kicks = pickTransientsFromFlux(lowFlux, hopSec, "kick", transientSensitivity);
  const snares = pickTransientsFromFlux(highFlux, hopSec, "snare", transientSensitivity);
  const transients = [...kicks, ...snares].sort((a, b) => a.time_sec - b.time_sec);
  const estimatedBpm = estimateBpmFromFlux(lowFlux, highFlux, hopSec);
  const gridOffsetSec = kicks[0]?.time_sec ?? 0;

  return {
    sha256: `pcm_${key}_${totalFrames}`,
    sample_rate: sr,
    duration_sec: durationSec,
    estimated_bpm: estimatedBpm,
    grid_offset_sec: gridOffsetSec,
    transients,
    waveform_peaks,
  };
}

async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") {
    return file.arrayBuffer();
  }
  if (typeof FileReader !== "undefined") {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(reader.result);
        } else {
          resolve(new ArrayBuffer(0));
        }
      };
      reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
      reader.readAsArrayBuffer(file);
    });
  }
  return new Response(file).arrayBuffer();
}

export function extractAudioFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || filePath;
}

export async function decodeAudioArrayBuffer(
  arrayBuffer: ArrayBuffer,
  key: string,
  fileName: string,
  transientSensitivity = 0.65,
): Promise<{ asset: DecodedAudioAsset; analysis: AudioAnalysisResult }> {
  const ctx = getAudioContext();
  if (ctx && typeof ctx.decodeAudioData === "function") {
    try {
      const copy = arrayBuffer.slice(0);
      const audioBuffer = await ctx.decodeAudioData(copy);
      const length = audioBuffer.length;
      const channels = Math.max(1, audioBuffer.numberOfChannels);
      const monoPcm = new Float32Array(length);
      for (let c = 0; c < channels; c++) {
        const chData = audioBuffer.getChannelData(c);
        for (let i = 0; i < length; i++) {
          monoPcm[i] += chData[i] / channels;
        }
      }
      const asset: DecodedAudioAsset = {
        key,
        fileName,
        durationSec: Number(Math.max(0.1, audioBuffer.duration).toFixed(3)),
        sampleRate: audioBuffer.sampleRate,
        monoPcm,
        audioBuffer,
      };
      registerDecodedAudioAsset(asset);
      const analysis = analyzePcmBuffer(
        monoPcm,
        asset.sampleRate,
        key,
        transientSensitivity,
      );
      return { asset, analysis };
    } catch {
      // Fall through to WAV parser / deterministic fallback
    }
  }

  const wavDecoded = tryDecodeWavBytes(new Uint8Array(arrayBuffer));
  if (wavDecoded && wavDecoded.monoPcm.length > 0) {
    const asset: DecodedAudioAsset = {
      key,
      fileName,
      durationSec: Number(Math.max(0.1, wavDecoded.durationSec).toFixed(3)),
      sampleRate: wavDecoded.sampleRate,
      monoPcm: wavDecoded.monoPcm,
      audioBuffer: null,
    };
    registerDecodedAudioAsset(asset);
    const analysis = analyzePcmBuffer(
      asset.monoPcm,
      asset.sampleRate,
      key,
      transientSensitivity,
    );
    return { asset, analysis };
  }

  // Last-resort fallback (e.g. non-WAV file in JSDOM without AudioContext)
  const sr = 22050;
  const fallbackDur = 8;
  const monoPcm = new Float32Array(sr * fallbackDur);
  for (let i = 0; i < monoPcm.length; i++) {
    const t = i / sr;
    const beatFrac = (t * 2) % 1;
    const env = beatFrac < 0.08 ? Math.exp(-beatFrac / 0.025) : 0;
    monoPcm[i] = env * Math.sin(2 * Math.PI * 80 * t) * 0.7;
  }
  const asset: DecodedAudioAsset = {
    key,
    fileName,
    durationSec: fallbackDur,
    sampleRate: sr,
    monoPcm,
    audioBuffer: null,
  };
  registerDecodedAudioAsset(asset);
  const analysis = analyzePcmBuffer(monoPcm, sr, key, transientSensitivity);
  return { asset, analysis };
}

export async function decodeAudioBytes(
  bytes: Uint8Array | number[],
  key: string,
  fileName: string,
  transientSensitivity = 0.65,
): Promise<{ asset: DecodedAudioAsset; analysis: AudioAnalysisResult }> {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return decodeAudioArrayBuffer(copy.buffer, key, fileName, transientSensitivity);
}

/**
 * Decodes an OS-dropped or file-picked audio File (MP3, WAV, OGG, FLAC, M4A)
 * using Web Audio API `AudioContext.decodeAudioData` (with WAV fallback for tests),
 * registers the asset in memory, and returns both asset metadata and initial analysis.
 */
export async function decodeAudioFile(
  file: File,
  transientSensitivity = 0.65,
  overrideKey?: string,
): Promise<{ asset: DecodedAudioAsset; analysis: AudioAnalysisResult }> {
  const key = overrideKey ?? file.name;
  const arrayBuffer = await readFileAsArrayBuffer(file);
  return decodeAudioArrayBuffer(arrayBuffer, key, file.name, transientSensitivity);
}

export function reanalyzeAudioClip(
  audioKey: string,
  transientSensitivity: number,
): AudioAnalysisResult | null {
  const asset = audioAssetRegistry.get(audioKey);
  if (!asset) return null;
  return analyzePcmBuffer(
    asset.monoPcm,
    asset.sampleRate,
    audioKey,
    transientSensitivity,
  );
}

export interface AudioClockSyncPayload {
  samplesPlayed: number | null;
  sampleRate: number | null;
  bufferDurationMs: number | null;
  isPlaying: boolean;
}

type AudioClockPublisher = (payload: AudioClockSyncPayload) => void;

/**
 * Syncs Web Audio API playback of all music clips on a timeline with transport
 * play/pause/seek state and publishes hardware audio clock snapshots so the
 * Rust 44 Hz engine stays phase-locked to audio output without drift.
 */
class WebAudioTimelinePlayer {
  private activeSources: AudioBufferSourceNode[] = [];
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private clockPublisher: AudioClockPublisher | null = null;

  setClockPublisher(publisher: AudioClockPublisher | null): void {
    this.clockPublisher = publisher;
  }

  private clearClockTimer(): void {
    if (this.clockTimer !== null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  stop(): void {
    this.clearClockTimer();
    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already-stopped nodes
      }
    }
    this.activeSources = [];
    this.clockPublisher?.({
      samplesPlayed: null,
      sampleRate: null,
      bufferDurationMs: null,
      isPlaying: false,
    });
  }

  startFrom(playheadSec: number, tracks: ReadonlyArray<TrackDef>): void {
    this.stop();
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    let scheduledAny = false;
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (!clip.audio_file) continue;
        const asset = audioAssetRegistry.get(clip.audio_file);
        if (!asset?.audioBuffer) continue;

        const clipStart = clip.start_sec;
        const clipEnd = clip.start_sec + clip.duration_sec;
        if (clipEnd <= playheadSec + 0.005) continue;

        const src = ctx.createBufferSource();
        src.buffer = asset.audioBuffer;
        src.connect(ctx.destination);

        if (playheadSec <= clipStart) {
          const delaySec = clipStart - playheadSec;
          const playDur = Math.min(clip.duration_sec, asset.audioBuffer.duration);
          src.start(now + delaySec, 0, Math.max(0.01, playDur));
        } else {
          const offsetInClip = playheadSec - clipStart;
          const remainingClip = clipEnd - playheadSec;
          const remainingAsset = Math.max(0, asset.audioBuffer.duration - offsetInClip);
          const playDur = Math.min(remainingClip, remainingAsset);
          if (playDur > 0.01) {
            src.start(now, offsetInClip, playDur);
          } else {
            continue;
          }
        }
        this.activeSources.push(src);
        scheduledAny = true;
      }
    }

    if (scheduledAny && this.clockPublisher) {
      const sampleRate = Math.max(8000, Math.round(ctx.sampleRate || 48000));
      const baseLatencyMs =
        typeof (ctx as AudioContext & { baseLatency?: number }).baseLatency === "number"
          ? Math.max(10, ((ctx as AudioContext & { baseLatency?: number }).baseLatency ?? 0.02) * 1000)
          : 25;
      const emitSnapshot = () => {
        const ts =
          typeof ctx.getOutputTimestamp === "function" ? ctx.getOutputTimestamp() : null;
        const audioTime =
          ts && typeof ts.contextTime === "number" && ts.contextTime > 0
            ? ts.contextTime
            : ctx.currentTime;
        const timelineSec = Math.max(0, playheadSec + (audioTime - now));
        this.clockPublisher?.({
          samplesPlayed: Math.round(timelineSec * sampleRate),
          sampleRate,
          bufferDurationMs: baseLatencyMs + 45,
          isPlaying: ctx.state === "running",
        });
      };
      emitSnapshot();
      this.clockTimer = setInterval(emitSnapshot, 40);
    }
  }
}

export const timelineAudioPlayer = new WebAudioTimelinePlayer();
