/**
 * Minimum XKB stub. GTK/GDK refuses some keyboard paths without it, and
 * xkbcommon falls into a degraded mode that's worse than no XKB at all.
 *
 * We implement just XkbUseExtension (the protocol handshake). Everything
 * else is a silent no-op — XKB queries that expect replies will hang their
 * callers, but in practice modern GTK gracefully handles XkbUseExtension
 * succeeding and then never actually using XKB calls.
 */

import { Writer } from './wire.js';

export const XKB_MAJOR_OPCODE = 132;
export const XKB_FIRST_EVENT = 88;
export const XKB_FIRST_ERROR = 158;

interface Ctx {
  bytes: Uint8Array;
  littleEndian: boolean;
  sequence: number;
  send: (b: Uint8Array) => void;
}

export function handleXkbRequest(c: Ctx) {
  const minor = new DataView(c.bytes.buffer, c.bytes.byteOffset, c.bytes.byteLength).getUint8(1);
  switch (minor) {
    case 0:  return onUseExtension(c);
    case 1:  return; // XkbSelectEvents (no reply)
    case 3:  return; // XkbBell
    case 4:  return onGetState(c);            // XkbGetState
    case 5:  return; // XkbLatchLockState (no reply)
    case 6:  return onGetControls(c);         // XkbGetControls
    case 7:  return; // XkbSetControls
    case 8:  return onGetMap(c);              // XkbGetMap
    case 9:  return; // XkbSetMap (no reply)
    case 10: return onGetCompatMap(c);        // XkbGetCompatMap
    case 12: return onGetIndicatorState(c);   // XkbGetIndicatorState
    case 13: return onGetIndicatorMap(c);     // XkbGetIndicatorMap
    case 14: return; // XkbSetIndicatorMap
    case 17: return onGetNames(c);            // XkbGetNames
    case 18: return; // XkbSetNames
    case 21: return onPerClientFlags(c);      // XkbPerClientFlags (has reply)
    case 23: return onGetKbdByName(c);        // XkbGetKbdByName
    default:
      console.warn(`[XKB] unhandled minor=${minor} len=${c.bytes.byteLength}`);
  }
}

function onUseExtension(c: Ctx) {
  // Request: wantedMajor (CARD16), wantedMinor (CARD16)
  // Reply: supported (BYTE) + serverMajor (CARD16) + serverMinor (CARD16) + pad
  const w = new Writer(32, c.littleEndian);
  w.card8(1);                  // reply marker
  w.card8(1);                  // supported = True
  w.card16(c.sequence);
  w.card32(0);                 // length
  w.card16(1);                 // server major
  w.card16(0);                 // server minor (1.0)
  w.pad(20);
  c.send(w.finish());
}

function onGetState(c: Ctx) {
  // Reply: lots of state. We zero everything.
  const w = new Writer(32, c.littleEndian);
  w.card8(1);
  w.card8(1);                  // deviceID
  w.card16(c.sequence);
  w.card32(0);
  w.pad(24);                   // mods, group, ptrButtons, ...
  c.send(w.finish());
}

function onGetControls(c: Ctx) {
  // Reply: 56 bytes of "boot defaults" controls (all zero is fine).
  const w = new Writer(32 + 80, c.littleEndian);
  w.card8(1);
  w.card8(1);                  // deviceID
  w.card16(c.sequence);
  w.card32(20);                // length: 20 * 4 = 80 extra bytes
  for (let i = 0; i < 24 + 80; i++) w.card8(0);
  c.send(w.finish());
}

function onGetMap(c: Ctx) {
  // xkbGetMapReply (per XKBproto.h):
  //   bytes 0..7   reply marker
  //   bytes 8..9   pad1[2]
  //   bytes 10..11 present (CARD16)
  //   bytes 12     firstType
  //   bytes 13     nTypes
  //   bytes 14     totalTypes
  //   bytes 15     firstKeySym
  //   bytes 16..17 totalSyms
  //   bytes 18     nKeySyms
  //   bytes 19     firstKeyAction
  //   bytes 20..21 totalActions
  //   bytes 22     nKeyActions
  //   bytes 23     firstKeyBehavior
  //   bytes 24     nKeyBehaviors
  //   bytes 25     totalKeyBehaviors
  //   bytes 26     firstKeyExplicit
  //   bytes 27     nKeyExplicit
  //   bytes 28     totalKeyExplicit
  //   bytes 29     firstModMapKey
  //   bytes 30     nModMapKeys
  //   bytes 31     totalModMapKeys
  //   bytes 32     firstVModMapKey
  //   bytes 33     nVModMapKeys
  //   bytes 34     totalVModMapKeys
  //   bytes 35..36 virtualMods (CARD16)   ← actually 2 bytes
  //   wait that puts 35..36 = 2 bytes ending at 37
  //   bytes 37     minKeyCode
  //   bytes 38     maxKeyCode
  //   bytes 39..40 pad2[2]
  // total = 40 bytes when no data. We pad up to 40.
  const w = new Writer(40, c.littleEndian);
  w.card8(1);                  // reply marker
  w.card8(1);                  // deviceID
  w.card16(c.sequence);
  w.card32(2);                 // length = 8 extra bytes / 4
  w.pad(2);                    // pad1
  w.card16(0);                 // present = 0 (no fields included)
  for (let i = 0; i < 23; i++) w.card8(0);  // 23 zero bytes for the count fields
  w.card8(8);                  // minKeyCode
  w.card8(255);                // maxKeyCode
  w.pad(2);                    // pad2
  c.send(w.finish());
}

function onGetCompatMap(c: Ctx) {
  const w = new Writer(32, c.littleEndian);
  w.card8(1); w.card8(1); w.card16(c.sequence); w.card32(0); w.pad(24);
  c.send(w.finish());
}

function onGetIndicatorState(c: Ctx) {
  const w = new Writer(32, c.littleEndian);
  w.card8(1); w.card8(1); w.card16(c.sequence); w.card32(0);
  w.card32(0);                 // state (no indicators lit)
  w.pad(20);
  c.send(w.finish());
}

function onGetIndicatorMap(c: Ctx) {
  const w = new Writer(32, c.littleEndian);
  w.card8(1); w.card8(1); w.card16(c.sequence); w.card32(0);
  w.card32(0);                 // which (no indicators)
  w.card32(0);                 // realIndicators
  w.pad(16);
  c.send(w.finish());
}

function onGetNames(c: Ctx) {
  const w = new Writer(32, c.littleEndian);
  w.card8(1); w.card8(1); w.card16(c.sequence); w.card32(0);
  w.card32(0);                 // which (no names)
  w.pad(20);
  c.send(w.finish());
}

function onPerClientFlags(c: Ctx) {
  // Request: deviceSpec(2) + pad(2) + change(4) + value(4) + ctrlsToChange(4) + autoCtrls(4) + autoValues(4)
  const w = new Writer(32, c.littleEndian);
  w.card8(1); w.card8(1); w.card16(c.sequence); w.card32(0);
  w.card32(0);                 // supported (we lie: no flags supported, no error)
  w.card32(0);                 // value
  w.pad(16);
  c.send(w.finish());
}

function onGetKbdByName(c: Ctx) {
  // Minimum reply: deviceID + minKeyCode + maxKeyCode + loaded + newKeyboard + found + reported + pad.
  // The reply is conditional on which 'present' bits the request asked for —
  // 0 in all of them is the simplest answer.
  const w = new Writer(32, c.littleEndian);
  w.card8(1); w.card8(1); w.card16(c.sequence); w.card32(0);
  w.card8(8); w.card8(255);    // minKeyCode/maxKeyCode
  w.card8(0); w.card8(0);      // loaded, newKeyboard
  w.card16(0); w.card16(0);    // found, reported
  w.pad(16);
  c.send(w.finish());
}
