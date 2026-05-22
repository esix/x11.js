/**
 * Minimum RANDR (X Resize and Rotate) stub. Modern GTK apps probe it on
 * startup to learn about monitor geometry. We declare a single connected
 * output covering the whole virtual screen and provide enough reply data
 * to satisfy initial probes.
 */

import { Writer } from './wire.js';

export const RANDR_MAJOR_OPCODE = 130;
export const RANDR_FIRST_EVENT = 89;
export const RANDR_FIRST_ERROR = 147;

interface Ctx {
  bytes: Uint8Array;
  littleEndian: boolean;
  sequence: number;
  send: (b: Uint8Array) => void;
  rootWindowId: number;
}

const OUTPUT_ID = 100;
const CRTC_ID = 200;
const MODE_ID = 300;

export function handleRandrRequest(c: Ctx) {
  const minor = new DataView(c.bytes.buffer, c.bytes.byteOffset, c.bytes.byteLength).getUint8(1);
  // Opcodes per xcb-proto randr.xml (RANDR 1.5):
  //   0  QueryVersion              1  Old GetScreenInfo
  //   2  SetScreenConfig           3  Old SelectInput / etc.
  //   4  SelectInput               5  GetScreenInfo (old)
  //   6  GetScreenSizeRange        7  SetScreenSize
  //   8  GetScreenResources        9  GetOutputInfo
  //  10  ListOutputProperties     11  QueryOutputProperty
  //  12  ConfigureOutputProperty  13  ChangeOutputProperty
  //  14  DeleteOutputProperty     15  GetOutputProperty
  //  16  CreateMode               17  DestroyMode
  //  18  AddOutputMode            19  DeleteOutputMode
  //  20  GetCrtcInfo              21  SetCrtcConfig
  //  22  GetCrtcGammaSize         23  GetCrtcGamma
  //  24  SetCrtcGamma             25  GetScreenResourcesCurrent
  //  26  SetCrtcTransform         27  GetCrtcTransform
  //  28  GetPanning               29  SetPanning
  //  30  SetOutputPrimary         31  GetOutputPrimary
  //  32  GetProviders             33  GetProviderInfo
  //  34  SetProviderOffloadSink   35  SetProviderOutputSource
  //  36  ListProviderProperties   37  QueryProviderProperty
  //  38  ConfigureProviderProperty 39 ChangeProviderProperty
  //  40  DeleteProviderProperty   41  GetProviderProperty
  //  42  GetMonitors              43  SetMonitor              44 DeleteMonitor
  switch (minor) {
    case 0:  return onQueryVersion(c);
    case 2:  return; // SetScreenConfig
    case 4:  return; // SelectInput
    case 5:  return onGetScreenInfo(c);
    case 6:  return onGetScreenSizeRange(c);
    case 7:  return; // SetScreenSize
    case 8:  return onGetScreenResources(c);
    case 9:  return onGetOutputInfo(c);
    case 10: return onListOutputProperties(c);
    case 15: return onGetOutputProperty(c);
    case 20: return onGetCrtcInfo(c);
    case 21: return; // SetCrtcConfig
    case 22: return onGetCrtcGammaSize(c);
    case 23: return onGetCrtcGamma(c);
    case 25: return onGetScreenResources(c);    // Current variant
    case 27: return onGetCrtcTransform(c);
    case 31: return onGetOutputPrimary(c);
    case 30: return; // SetOutputPrimary
    case 32: return onGetProviders(c);
    case 33: return onGetProviderInfo(c);
    case 36: return onListProviderProperties(c);
    case 37: return onQueryProviderProperty(c);
    case 41: return onGetProviderProperty(c);
    case 42: return onGetMonitors(c);
    case 43: return; // SetMonitor
    case 44: return; // DeleteMonitor
    default:
      console.warn(`[RANDR] unhandled minor=${minor} len=${c.bytes.byteLength}`);
  }
}

function reply(c: Ctx, dataByte: number, extraBytes: number, build: (w: Writer) => void) {
  const w = new Writer(32 + extraBytes, c.littleEndian);
  w.card8(1);
  w.card8(dataByte);
  w.card16(c.sequence);
  w.card32(extraBytes / 4);
  build(w);
  while (w.offset < 32 + extraBytes) w.pad(1);
  c.send(w.finish());
}

function onQueryVersion(c: Ctx) {
  reply(c, 0, 0, (w) => { w.card32(1); w.card32(5); w.pad(16); });  // 1.5
}

function onGetScreenInfo(c: Ctx) {
  // Old API. Reply: rotations(BYTE), root(4), timestamp(4), config_ts(4),
  // num_sizes(2), size_id(2), rotation(2), rate(2), num_rates(2), pad(2).
  // Then num_sizes × SCREENSIZE (8 bytes each), then rate_info (2 bytes per
  // size: nRates then rates...). 0 sizes → no extra body.
  const w = new Writer(32, c.littleEndian);
  w.card8(1);
  w.card8(1);                  // rotations = 1 (only no-rotation)
  w.card16(c.sequence);
  w.card32(0);
  w.card32(c.rootWindowId);
  w.card32(0); w.card32(0);    // timestamps
  w.card16(0); w.card16(0); w.card16(1); w.card16(0); w.card16(0); w.pad(2);
  c.send(w.finish());
}

function onGetScreenSizeRange(c: Ctx) {
  // Reply: min_w, min_h, max_w, max_h (CARD16 each) + pad.
  reply(c, 0, 0, (w) => {
    w.card16(1); w.card16(1);
    w.card16(8192); w.card16(8192);
    w.pad(16);
  });
}

function onGetScreenResources(c: Ctx) {
  // Reply: timestamp(4), config_ts(4), num_crtcs(2), num_outputs(2),
  // num_modes(2), names_len(2), pad(8), then crtcs[], outputs[], modes[], names.
  // We declare 1 CRTC + 1 Output + 1 Mode, mode name "1024x768".
  const modeName = '1024x768';
  const modeNamePadded = (modeName.length + 3) & ~3;
  const extra = 4 /* 1 CRTC */ + 4 /* 1 Output */ + 32 /* 1 ModeInfo */ + modeNamePadded;
  reply(c, 0, extra, (w) => {
    w.card32(0); w.card32(0);          // timestamps
    w.card16(1);                       // num_crtcs
    w.card16(1);                       // num_outputs
    w.card16(1);                       // num_modes
    w.card16(modeName.length);         // names_len
    w.pad(8);
    w.card32(CRTC_ID);                 // crtc[0]
    w.card32(OUTPUT_ID);               // output[0]
    // ModeInfo (32 bytes): id, w, h, dotClock, hSyncStart, hSyncEnd, hTotal,
    // hSkew, vSyncStart, vSyncEnd, vTotal, nameLen, modeFlags
    w.card32(MODE_ID); w.card16(1024); w.card16(768);
    w.card32(65000000);                // dot clock
    w.card16(1024); w.card16(1024); w.card16(1024); w.card16(0);
    w.card16(768); w.card16(768); w.card16(768);
    w.card16(modeName.length);
    w.card32(0);                       // flags
    for (let i = 0; i < modeName.length; i++) w.card8(modeName.charCodeAt(i));
    while (w.offset % 4) w.pad(1);
  });
}

function onGetOutputInfo(c: Ctx) {
  // GetOutputInfo reply layout (X RANDR spec, in wire order after 8-byte
  // reply marker):
  //   bytes 8..23  timestamp(4) + crtc(4) + mm_w(4) + mm_h(4)        [16 bytes]
  //   bytes 24..31 connection(1) + subpixel(1) + num_crtcs(2) +
  //                num_modes(2) + num_preferred(2)                   [8 bytes]
  //   bytes 32..35 num_clones(2) + name_len(2)        ← spills into "body"
  //   bytes 36..   crtcs[] + modes[] + clones[] + name (padded to 4)
  const name = 'X11JS-1';
  const padded = (name.length + 3) & ~3;
  const numCrtcs = 1, numModes = 1, numClones = 0;
  const extra = 4 /* num_clones + name_len overflow into body */
              + 4 * numCrtcs + 4 * numModes + 4 * numClones + padded;
  reply(c, 0, extra, (w) => {
    w.card32(0);                       // timestamp
    w.card32(CRTC_ID);                 // crtc
    w.card32(270);                     // mm_w
    w.card32(203);                     // mm_h
    w.card8(0);                        // connection = Connected
    w.card8(0);                        // subpixel order = unknown
    w.card16(numCrtcs);
    w.card16(numModes);
    w.card16(1);                       // num_preferred
    // overflow into body:
    w.card16(numClones);
    w.card16(name.length);             // name_len
    w.card32(CRTC_ID);                 // crtcs[0]
    w.card32(MODE_ID);                 // modes[0]
    for (let i = 0; i < name.length; i++) w.card8(name.charCodeAt(i));
    while (w.offset % 4) w.pad(1);
  });
}

function onGetCrtcInfo(c: Ctx) {
  // Reply: status, timestamp, x, y, w, h, mode, rotation, rotations,
  //   num_outputs, num_possible_outputs, then outputs[], possible[].
  const extra = 4 /* 1 output */ + 4 /* 1 possible */;
  reply(c, 0, extra, (w) => {
    w.card32(0);                       // timestamp
    w.card16(0); w.card16(0);          // x, y
    w.card16(1024); w.card16(768);     // w, h
    w.card32(MODE_ID);                 // mode
    w.card16(1);                       // rotation = no-rotate
    w.card16(1);                       // rotations
    w.card16(1);                       // num_outputs
    w.card16(1);                       // num_possible
    w.card32(OUTPUT_ID);               // outputs[0]
    w.card32(OUTPUT_ID);               // possible[0]
  });
}

function onListOutputProperties(c: Ctx) {
  reply(c, 0, 0, (w) => { w.card16(0); w.pad(22); });
}

function onGetOutputProperty(c: Ctx) {
  reply(c, 0, 0, (w) => {
    w.card32(0);                       // type = None
    w.card32(0);                       // bytes_after
    w.card32(0);                       // length
    w.pad(12);
  });
}

function onGetCrtcGamma(c: Ctx) {
  reply(c, 0, 0, (w) => { w.card16(0); w.pad(22); });
}

function onGetCrtcGammaSize(c: Ctx) {
  reply(c, 0, 0, (w) => { w.card16(0); w.pad(22); });
}

function onGetCrtcTransform(c: Ctx) {
  // Two 9-element matrices (3x3) = 9*4*2 = 72 bytes, plus filter name strings.
  const extra = 72;
  reply(c, 0, extra, (w) => {
    w.pad(24);
    // pending matrix (identity)
    w.card32(65536); w.card32(0); w.card32(0);
    w.card32(0); w.card32(65536); w.card32(0);
    w.card32(0); w.card32(0); w.card32(65536);
    // (filter name lengths + names omitted — set lengths=0 in header)
  });
}

function onGetOutputPrimary(c: Ctx) {
  reply(c, 0, 0, (w) => { w.card32(OUTPUT_ID); w.pad(20); });
}

function onGetProviders(c: Ctx) {
  reply(c, 0, 0, (w) => { w.card32(0); w.card16(0); w.pad(18); });
}

function onGetMonitors(c: Ctx) {
  // Reply layout: timestamp(4) + nMonitors(4) + nOutputs(4) + pad(12),
  // then list of MonitorInfo. We declare 1 monitor wrapping our single output.
  // MonitorInfo (24 bytes + per-output): name(ATOM 4) + primary(1) + automatic(1)
  // + nOutput(2) + x,y,w,h (2 each = 8) + widthMM,heightMM (4 each = 8) + outputs[].
  const monitorInfoLen = 24 + 4 /* 1 output */;
  reply(c, 0, monitorInfoLen, (w) => {
    w.card32(0);                       // timestamp
    w.card32(1);                       // nMonitors
    w.card32(1);                       // nOutputs
    w.pad(12);
    // MonitorInfo
    w.card32(1);                       // name atom (using atom #1 as a placeholder)
    w.card8(1);                        // primary
    w.card8(1);                        // automatic
    w.card16(1);                       // nOutput
    w.card16(0); w.card16(0);          // x, y
    w.card16(1024); w.card16(768);     // w, h
    w.card32(270); w.card32(203);      // widthMM, heightMM
    w.card32(OUTPUT_ID);
  });
}

function onGetProviderInfo(c: Ctx) {
  reply(c, 0, 0, (w) => {
    w.card32(0);                       // capabilities
    w.card16(0); w.card16(0); w.card16(0); w.card16(0); // counts
    w.card16(0);                       // name_len
    w.pad(8);
  });
}

function onListProviderProperties(c: Ctx) {
  reply(c, 0, 0, (w) => { w.card16(0); w.pad(22); });
}

function onQueryProviderProperty(c: Ctx) {
  reply(c, 0, 0, (w) => { w.pad(24); });
}

function onGetProviderProperty(c: Ctx) {
  reply(c, 0, 0, (w) => {
    w.card32(0); w.card32(0); w.card32(0); w.pad(12);
  });
}
