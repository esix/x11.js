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
    // case 24 XkbGetDeviceInfo — left unhandled; previous stub crashed Mutter
    case 25: return; // XkbSetDeviceInfo (no reply)
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
  // Return a minimal valid keymap so libxkbcommon can build a (trivial)
  // keymap and return a non-null xkb_state. Without this, Mutter + gnome-shell
  // crash before they reach window-managing code.
  //
  // We provide three sections:
  //   KEY_TYPES (bit 0x0001): one ONE_LEVEL type with no map entries
  //   KEY_SYMS  (bit 0x0002): 248 keys (keycodes 8..255), each mapping to
  //                            type 0 (the ONE_LEVEL we just defined), with
  //                            a single keysym = NoSymbol (0). Real keyboard
  //                            input still travels through core protocol —
  //                            this just satisfies libxkbcommon's structure.
  //   MODIFIER_MAP (bit 0x0004): one byte per key, all zero.
  //
  // Section formats per XKBproto.h are bytewise-packed; counts in the
  // header tell the reader how big each section is.
  const present = 0x0007;
  const firstKey = 8, nKeys = 248;        // keycodes 8..255 inclusive

  // KEY_TYPES section: 4 KeyType structs (8 bytes each, no map entries).
  // libX11 builds in 4 standard types (ONE_LEVEL, TWO_LEVEL, ALPHABETIC,
  // KEYPAD); GDK's XkbGetUpdatedMap merges server data with the built-ins,
  // and it bails if we claim fewer than 4 standard types.
  const nTypes = 4;
  const typesBytes = nTypes * 8;

  // KEY_SYMS section: 248 × (8-byte header + 4-byte syms[0]) = 2976 bytes
  const symsBytes = nKeys * 12;

  // MODIFIER_MAP section: KeyModMap entries (2 bytes each: keycode + mods).
  // We declare zero entries — no keys are modifiers in our minimal keymap.
  const modMapBytes = 0;
  const nModMap = 0;

  // Body = sections, then padded to 4
  const bodyLen = typesBytes + symsBytes + modMapBytes;
  const headerOverflow = 9;                        // 41-byte struct header − 32 fixed
  const total = 32 + ((headerOverflow + bodyLen + 3) & ~3);
  const length = (total - 32) / 4;

  const w = new Writer(total, c.littleEndian);
  w.card8(1);                  // reply marker
  w.card8(1);                  // deviceID
  w.card16(c.sequence);
  w.card32(length);
  w.pad(2);                    // pad1
  w.card16(present);
  // count fields (25 bytes):
  w.card8(0);                  // firstType
  w.card8(nTypes);             // nTypes
  w.card8(nTypes);             // totalTypes
  w.card8(firstKey);           // firstKeySym
  w.card16(nKeys, );           // totalSyms (we have 1 sym per key = nKeys total)
  w.card8(nKeys);              // nKeySyms (count of KeySymMap structs)
  w.card8(0);                  // firstKeyAction
  w.card16(0);                 // totalActions
  w.card8(0);                  // nKeyActions
  w.card8(0);                  // firstKeyBehavior
  w.card8(0);                  // nKeyBehaviors
  w.card8(0);                  // totalKeyBehaviors
  w.card8(0);                  // firstKeyExplicit
  w.card8(0);                  // nKeyExplicit
  w.card8(0);                  // totalKeyExplicit
  w.card8(0);                  // firstModMapKey
  w.card8(nModMap);            // nModMapKeys
  w.card8(nModMap);            // totalModMapKeys
  w.card8(0);                  // firstVModMapKey
  w.card8(0);                  // nVModMapKeys
  w.card8(0);                  // totalVModMapKeys
  w.card16(0);                 // virtualMods
  w.card8(8);                  // minKeyCode
  w.card8(255);                // maxKeyCode
  w.pad(2);                    // pad2

  // ----- KEY_TYPES section -----
  // 4 standard XKB types: ONE_LEVEL, TWO_LEVEL, ALPHABETIC, KEYPAD.
  // We declare each with numLevels=1 and zero map entries — they're
  // structurally present but functionally inert. Real keyboard input still
  // goes through the X core protocol.
  for (let i = 0; i < nTypes; i++) {
    w.card8(0);                // mask
    w.card8(0);                // realMods
    w.card16(0);               // virtualMods
    w.card8(1);                // numLevels
    w.card8(0);                // nMapEntries
    w.card8(0);                // hasPreserve
    w.card8(0);                // pad
  }

  // ----- KEY_SYMS section -----
  // For each key: kt_index[4]=0, group_info=1, width=1, nSyms=1, syms=[0]
  for (let i = 0; i < nKeys; i++) {
    w.card8(0); w.card8(0); w.card8(0); w.card8(0);    // kt_index for 4 groups
    w.card8(1);                                        // group_info = 1 group
    w.card8(1);                                        // width = 1 keysym per level
    w.card16(1);                                       // nSyms
    w.card32(0);                                       // syms[0] = NoSymbol
  }

  // ----- MODIFIER_MAP section -----
  // nModMap = 0, so this section is empty.

  // Trailing alignment to 4
  while (w.offset < total) w.pad(1);
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
