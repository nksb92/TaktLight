export const BINARY_FRAME_HEADER_BYTES = 40;
export const BINARY_FRAME_LAYOUT_VERSION = 1;
export const DMX_UNIVERSE_CHANNELS = 512;

export interface DecodedFrame {
  revision: bigint;
  tSec: number;
  cellCount: number;
  droppedFrames: number;
  meanUs: number;
  maxJitterUs: number;
  p99JitterUs: number;
  layoutVersion: number;
  universeCount: number;
  universes: Uint8Array[];
  cellPreviewRgbd: Uint8Array;
}

export interface BinaryFrameInput {
  revision: bigint;
  tSec: number;
  cellCount: number;
  droppedFrames: number;
  meanUs: number;
  maxJitterUs: number;
  p99JitterUs: number;
  universes: Uint8Array[];
  cellPreviewRgbd: Uint8Array;
}

export function normalizeFramePayload(
  payload: ArrayBuffer | Uint8Array | number[],
): ArrayBuffer {
  if (payload instanceof ArrayBuffer) {
    return payload;
  }
  if (ArrayBuffer.isView(payload)) {
    const view = new Uint8Array(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return copy.buffer;
  }
  const copy = new Uint8Array(payload);
  return copy.buffer;
}

export function encodeBinaryFrame(input: BinaryFrameInput): ArrayBuffer {
  const universeCount = input.universes.length;
  const cellCount = Math.min(
    input.cellCount,
    Math.floor(input.cellPreviewRgbd.byteLength / 4),
  );
  const totalBytes =
    BINARY_FRAME_HEADER_BYTES +
    universeCount * DMX_UNIVERSE_CHANNELS +
    cellCount * 4;
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setBigUint64(0, input.revision, true);
  view.setFloat64(8, input.tSec, true);
  view.setUint32(16, cellCount, true);
  view.setUint32(20, input.droppedFrames, true);
  view.setFloat32(24, input.meanUs, true);
  view.setFloat32(28, input.maxJitterUs, true);
  view.setFloat32(32, input.p99JitterUs, true);
  view.setUint16(36, BINARY_FRAME_LAYOUT_VERSION, true);
  view.setUint16(38, universeCount, true);

  let offset = BINARY_FRAME_HEADER_BYTES;
  for (let i = 0; i < universeCount; i++) {
    const src = input.universes[i];
    bytes.set(src.subarray(0, DMX_UNIVERSE_CHANNELS), offset);
    offset += DMX_UNIVERSE_CHANNELS;
  }
  if (cellCount > 0) {
    bytes.set(input.cellPreviewRgbd.subarray(0, cellCount * 4), offset);
  }

  return buffer;
}

export function decodeBinaryFrame(buffer: ArrayBuffer): DecodedFrame {
  if (buffer.byteLength < BINARY_FRAME_HEADER_BYTES) {
    throw new Error(
      `Binary frame header too short: expected ${BINARY_FRAME_HEADER_BYTES} bytes, got ${buffer.byteLength}`,
    );
  }

  const view = new DataView(buffer);
  const revision = view.getBigUint64(0, true);
  const tSec = view.getFloat64(8, true);
  const cellCount = view.getUint32(16, true);
  const droppedFrames = view.getUint32(20, true);
  const meanUs = view.getFloat32(24, true);
  const maxJitterUs = view.getFloat32(28, true);
  const p99JitterUs = view.getFloat32(32, true);
  const layoutVersion = view.getUint16(36, true);
  const universeCount = view.getUint16(38, true);

  if (layoutVersion !== BINARY_FRAME_LAYOUT_VERSION) {
    throw new Error(`Unsupported binary frame layout version: ${layoutVersion}`);
  }

  const expectedBytes =
    BINARY_FRAME_HEADER_BYTES +
    universeCount * DMX_UNIVERSE_CHANNELS +
    cellCount * 4;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `Binary frame length mismatch: expected ${expectedBytes} bytes, got ${buffer.byteLength}`,
    );
  }

  const bytes = new Uint8Array(buffer);
  const universes: Uint8Array[] = [];
  let offset = BINARY_FRAME_HEADER_BYTES;
  for (let i = 0; i < universeCount; i++) {
    universes.push(bytes.slice(offset, offset + DMX_UNIVERSE_CHANNELS));
    offset += DMX_UNIVERSE_CHANNELS;
  }

  const cellPreviewRgbd = bytes.slice(offset, offset + cellCount * 4);

  return {
    revision,
    tSec,
    cellCount,
    droppedFrames,
    meanUs,
    maxJitterUs,
    p99JitterUs,
    layoutVersion,
    universeCount,
    universes,
    cellPreviewRgbd,
  };
}
