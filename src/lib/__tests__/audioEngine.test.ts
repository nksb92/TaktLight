import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAudioAssetRegistry,
  decodeAudioFile,
  reanalyzeAudioClip,
  tryDecodeWavBytes,
} from "../audioEngine";

function buildSyntheticWavFile(
  fileName: string,
  durationSec: number,
  sampleRate = 8000,
  bpm = 120,
): { file: File; buf: ArrayBuffer } {
  const numSamples = Math.round(durationSec * sampleRate);
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  const beatPeriod = 60 / bpm;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const beatIdx = Math.floor(t / beatPeriod);
    const dt = t - beatIdx * beatPeriod;
    let sample = 0;
    if (dt < 0.08) {
      const env = Math.exp(-dt / 0.025);
      const freq = beatIdx % 2 === 0 ? 80 : 2500;
      sample = env * Math.sin(2 * Math.PI * freq * dt) * 0.85;
    }
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }

  return { file: new File([buf], fileName, { type: "audio/wav" }), buf };
}

describe("audioEngine", () => {
  beforeEach(() => {
    clearAudioAssetRegistry();
  });

  it("decodes real WAV duration, waveform peaks, and kick/snare transients", async () => {
    const { file: wavFile, buf } = buildSyntheticWavFile("show_track.wav", 22.0, 8000, 120);
    const bytes = new Uint8Array(buf);
    const raw = tryDecodeWavBytes(bytes);
    expect(raw).not.toBeNull();
    expect(raw!.durationSec).toBeCloseTo(22.0, 2);

    const { asset, analysis } = await decodeAudioFile(wavFile, 0.7);
    expect(asset.durationSec).toBeCloseTo(22.0, 1);
    expect(analysis.duration_sec).toBeCloseTo(22.0, 1);
    expect(analysis.waveform_peaks.length).toBeGreaterThan(50);
    expect(analysis.transients.length).toBeGreaterThan(4);

    // Re-analyzing with different sensitivity uses the real registered PCM buffer
    const reanalyzed = reanalyzeAudioClip("show_track.wav", 0.9);
    expect(reanalyzed).not.toBeNull();
    expect(reanalyzed!.duration_sec).toBeCloseTo(22.0, 1);
    expect(reanalyzed!.waveform_peaks.length).toBeGreaterThan(50);
  });
});
