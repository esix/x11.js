/**
 * Minimum XInput2 stub. GTK3 / Gdk refuses to open a display unless this
 * extension is present, even when it doesn't actively use any XI2 devices.
 *
 * What we cover:
 *   8  XIQueryVersion — negotiate version 2.3 (GTK3-era)
 *   9  XIQueryDevice  — return one master pointer + one master keyboard
 *   7  XISelectEvents — accept and ignore (we never raise XI2 events)
 *
 * Everything else is a silent no-op. Apps that actively probe other XI2
 * features will still fail, but the *startup* path passes.
 */

import { Writer } from './wire.js';

export const XINPUT_MAJOR_OPCODE = 131;
export const XINPUT_FIRST_EVENT = 0;
export const XINPUT_FIRST_ERROR = 152;

// We claim to be a single-screen server with two virtual master devices.
const MASTER_POINTER_ID = 2;
const MASTER_KEYBOARD_ID = 3;

interface Ctx {
  bytes: Uint8Array;
  littleEndian: boolean;
  sequence: number;
  send: (b: Uint8Array) => void;
  rootWindowId: number;
  pointerX: number;
  pointerY: number;
  buttonState: number;
}

function reqView(c: Ctx): DataView {
  return new DataView(c.bytes.buffer, c.bytes.byteOffset, c.bytes.byteLength);
}

export function handleXInput2Request(c: Ctx) {
  const minor = new DataView(c.bytes.buffer, c.bytes.byteOffset, c.bytes.byteLength).getUint8(1);
  switch (minor) {
    case 1:  return onQueryPointer(c);
    case 8:  return onQueryVersion(c);
    case 9:  return onQueryDevice(c);
    case 7:  return; // XISelectEvents — accept
    case 12: return; // XIGrabDevice — accept (would need a reply but app rarely waits)
    case 13: return; // XIUngrabDevice
    case 15: return; // XIPassiveGrabDevice
    case 16: return; // XIPassiveUngrabDevice
    case 18: return; // XIChangeProperty
    case 19: return; // XIDeleteProperty
    default:
      console.warn(`[XI2] unhandled minor=${minor} len=${c.bytes.byteLength}`);
  }
}

function onQueryPointer(c: Ctx) {
  // XIQueryPointer reply layout (per xcb-proto xinput.xml):
  //   bytes 0..7   reply marker (1 + 1 pad + 2 seq + 4 length)
  //   bytes 8..15  root, child (4 each)
  //   bytes 16..31 4 × FP1616 (root_x/y, win_x/y)
  //   bytes 32..35 same_screen(1) + pad(1) + buttons_len(2)
  //   bytes 36..51 ModifierInfo: base, latched, locked, effective (CARD32×4)
  //   bytes 52..55 GroupInfo: base, latched, locked, effective (CARD8×4)
  //   bytes 56..   buttons[buttons_len] (CARD32 each)
  // No buttons → total 56 bytes → extra = 24 (length = 6).
  const w = new Writer(56, c.littleEndian);
  w.card8(1);
  w.card8(0);
  w.card16(c.sequence);
  w.card32(6);                       // length = (56 - 32) / 4
  w.card32(c.rootWindowId);
  w.card32(0);                       // child
  w.card32(c.pointerX * 65536);
  w.card32(c.pointerY * 65536);
  w.card32(c.pointerX * 65536);
  w.card32(c.pointerY * 65536);
  w.card8(1);                        // same_screen
  w.card8(0);
  w.card16(0);                       // buttons_len
  // ModifierInfo: 4 × CARD32
  w.card32(c.buttonState & 0xffff);
  w.card32(0); w.card32(0); w.card32(0);
  // GroupInfo: 4 × CARD8 packed into one CARD32
  w.card32(0);
  c.send(w.finish());
}

function onQueryVersion(c: Ctx) {
  // Request: client major + client minor (CARD16 each, no other fields).
  // Reply: server major (CARD16) + server minor (CARD16). We negotiate 2.3.
  const w = new Writer(32, c.littleEndian);
  w.card8(1);                 // reply
  w.card8(0);
  w.card16(c.sequence);
  w.card32(0);                // length
  w.card16(2); w.card16(4);   // major=2 minor=4 (GTK4 expects ≥2.4)
  w.pad(20);
  c.send(w.finish());
}

function onQueryDevice(c: Ctx) {
  // Request: deviceid (CARD16) + pad(2). 0 == XIAllDevices, 1 == XIAllMasterDevices.
  const v = reqView(c); const le = c.littleEndian;
  const requested = v.getUint16(4, le);
  const devices: number[] = [];
  if (requested === 0 || requested === 1) {
    devices.push(MASTER_POINTER_ID, MASTER_KEYBOARD_ID);
  } else if (requested === MASTER_POINTER_ID || requested === MASTER_KEYBOARD_ID) {
    devices.push(requested);
  }

  // GTK4 considers XI2 unsupported unless each master device has at least one
  // device class. We attach a minimal KeyClass to the master keyboard and a
  // ButtonClass to the master pointer.
  const buildKeyClass = (sourceId: number): Uint8Array => {
    // type(2)=0 + len(2)=2(words=8B) + sourceid(2) + num_keys(2) = 8 bytes
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    dv.setUint16(0, 0, c.littleEndian);          // type = KeyClass
    dv.setUint16(2, 2, c.littleEndian);          // len = 2 (×4 = 8 bytes)
    dv.setUint16(4, sourceId, c.littleEndian);   // sourceid
    dv.setUint16(6, 0, c.littleEndian);          // num_keys
    return buf;
  };
  const buildButtonClass = (sourceId: number): Uint8Array => {
    // type(2)=1 + len(2)=2 + sourceid(2) + num_buttons(2) = 8 bytes
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    dv.setUint16(0, 1, c.littleEndian);
    dv.setUint16(2, 2, c.littleEndian);
    dv.setUint16(4, sourceId, c.littleEndian);
    dv.setUint16(6, 0, c.littleEndian);
    return buf;
  };

  const nameFor = (id: number) =>
    id === MASTER_POINTER_ID ? 'Virtual core pointer' : 'Virtual core keyboard';

  // Per-device block: deviceid(2) + use(2) + attachment(2) + num_classes(2)
  //   + name_len(2) + enabled(1) + pad(1) = 12 byte header
  //   + name (padded to 4)
  //   + concatenated class entries (each 8+ bytes, all 4-byte aligned)
  let payload = 24;            // header (num_devices + 22 pad)
  const blocks: Uint8Array[] = [];
  for (const id of devices) {
    const name = nameFor(id);
    const namePadded = (name.length + 3) & ~3;
    const classBytes = id === MASTER_POINTER_ID
      ? buildButtonClass(id)
      : buildKeyClass(id);
    const blkLen = 12 + namePadded + classBytes.length;
    const blk = new Uint8Array(blkLen);
    const bv = new DataView(blk.buffer);
    bv.setUint16(0, id, c.littleEndian);                                  // deviceid
    bv.setUint16(2, id === MASTER_POINTER_ID ? 1 : 2, c.littleEndian);   // use
    bv.setUint16(4, id === MASTER_POINTER_ID ? MASTER_KEYBOARD_ID : MASTER_POINTER_ID, c.littleEndian);
    bv.setUint16(6, 1, c.littleEndian);                                  // num_classes = 1
    bv.setUint16(8, name.length, c.littleEndian);                        // name_len
    blk[10] = 1;                                                         // enabled
    blk[11] = 0;                                                         // pad
    for (let i = 0; i < name.length; i++) blk[12 + i] = name.charCodeAt(i);
    blk.set(classBytes, 12 + namePadded);
    blocks.push(blk);
    payload += blkLen;
  }

  const padded = (payload + 3) & ~3;
  const w = new Writer(32 + Math.max(0, padded - 24), c.littleEndian);
  w.card8(1);
  w.card8(0);
  w.card16(c.sequence);
  w.card32(Math.max(0, (padded - 24) / 4));
  w.card16(devices.length);
  w.pad(22);
  for (const blk of blocks) w.bytes(blk);
  while (w.offset < 32 + Math.max(0, padded - 24)) w.pad(1);
  c.send(w.finish());
}
