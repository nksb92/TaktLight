import { describe, expect, it } from "vitest";
import {
  BINARY_FRAME_HEADER_BYTES,
  BINARY_FRAME_LAYOUT_VERSION,
  decodeBinaryFrame,
  encodeBinaryFrame,
  normalizeFramePayload,
} from "../frameDecoder";

describe("frameDecoder", () => {
  it("round-trips a 40-byte header and multi-universe DMX + preview body", () => {
    const u0 = new Uint8Array(512);
    u0[0] = 255;
    u0[511] = 123;
    const u1 = new Uint8Array(512);
    u1[17] = 77;
    const preview = new Uint8Array([255, 85, 0, 200, 34, 85, 170, 255]);

    const buffer = encodeBinaryFrame({
      revision: 0x1122334455667788n,
      tSec: 12.3456789,
      cellCount: 2,
      droppedFrames: 3,
      meanUs: 22727.25,
      maxJitterUs: 45.5,
      p99JitterUs: 32.125,
      universes: [u0, u1],
      cellPreviewRgbd: preview,
    });

    expect(buffer.byteLength).toBe(BINARY_FRAME_HEADER_BYTES + 2 * 512 + 8);

    const view = new DataView(buffer);
    expect(view.getBigUint64(0, true)).toBe(0x1122334455667788n);
    expect(view.getFloat64(8, true)).toBeCloseTo(12.3456789, 7);
    expect(view.getUint32(16, true)).toBe(2);
    expect(view.getUint32(20, true)).toBe(3);
    expect(view.getFloat32(24, true)).toBeCloseTo(22727.25, 2);
    expect(view.getFloat32(28, true)).toBeCloseTo(45.5, 2);
    expect(view.getFloat32(32, true)).toBeCloseTo(32.125, 3);
    expect(view.getUint16(36, true)).toBe(BINARY_FRAME_LAYOUT_VERSION);
    expect(view.getUint16(38, true)).toBe(2);

    const decoded = decodeBinaryFrame(buffer);
    expect(decoded.revision).toBe(0x1122334455667788n);
    expect(decoded.tSec).toBeCloseTo(12.3456789, 7);
    expect(decoded.cellCount).toBe(2);
    expect(decoded.droppedFrames).toBe(3);
    expect(decoded.meanUs).toBeCloseTo(22727.25, 2);
    expect(decoded.maxJitterUs).toBeCloseTo(45.5, 2);
    expect(decoded.p99JitterUs).toBeCloseTo(32.125, 3);
    expect(decoded.layoutVersion).toBe(1);
    expect(decoded.universeCount).toBe(2);
    expect(decoded.universes[0][0]).toBe(255);
    expect(decoded.universes[0][511]).toBe(123);
    expect(decoded.universes[1][17]).toBe(77);
    expect(Array.from(decoded.cellPreviewRgbd)).toEqual(Array.from(preview));
  });

  it("rejects short, unsupported version, or mismatched body buffers", () => {
    expect(() => decodeBinaryFrame(new ArrayBuffer(39))).toThrow(/header/i);

    const badVersion = new ArrayBuffer(40);
    new DataView(badVersion).setUint16(36, 99, true);
    expect(() => decodeBinaryFrame(badVersion)).toThrow(/layout version/i);

    const badLength = new ArrayBuffer(40);
    const dv = new DataView(badLength);
    dv.setUint16(36, 1, true);
    dv.setUint16(38, 1, true);
    expect(() => decodeBinaryFrame(badLength)).toThrow(/length mismatch/i);
  });

  it("normalizes ArrayBuffer, Uint8Array slices, and number arrays", () => {
    const u0 = new Uint8Array(512);
    u0[3] = 91;
    const buf = encodeBinaryFrame({
      revision: 1n,
      tSec: 0.5,
      cellCount: 0,
      droppedFrames: 0,
      meanUs: 22727,
      maxJitterUs: 10,
      p99JitterUs: 8,
      universes: [u0],
      cellPreviewRgbd: new Uint8Array(0),
    });

    const u8 = new Uint8Array(buf);
    const fromU8 = decodeBinaryFrame(normalizeFramePayload(u8));
    expect(fromU8.universes[0][3]).toBe(91);

    const fromArr = decodeBinaryFrame(normalizeFramePayload(Array.from(u8)));
    expect(fromArr.universes[0][3]).toBe(91);
  });
});
