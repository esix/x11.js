// Binary framing for the WS bridge.
// Layout: [u8 type][u32LE clientId][payload bytes]

export const FRAME_TYPE = {
  DATA_C2S: 0x01,
  DATA_S2C: 0x02,
  DISCONNECT: 0x03,
} as const;

export type FrameType = (typeof FRAME_TYPE)[keyof typeof FRAME_TYPE];

export interface Frame {
  type: FrameType;
  clientId: number;
  payload: Uint8Array;
}

const HEADER_SIZE = 5;

export function encodeFrame(type: FrameType, clientId: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, type);
  view.setUint32(1, clientId >>> 0, true);
  out.set(payload, HEADER_SIZE);
  return out;
}

export function decodeFrame(bytes: Uint8Array): Frame {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0) as FrameType;
  const clientId = view.getUint32(1, true);
  const payload = bytes.subarray(HEADER_SIZE);
  return { type, clientId, payload };
}
