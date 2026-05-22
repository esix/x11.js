import { Writer } from './wire.js';

export type SetupParse =
  | { status: 'incomplete' }
  | { status: 'ok'; littleEndian: boolean; consumed: number }
  | { status: 'fail'; reason: string };

export function tryParseSetup(buf: Uint8Array): SetupParse {
  if (buf.byteLength < 12) return { status: 'incomplete' };
  const byteOrder = buf[0]!;
  if (byteOrder !== 0x6c && byteOrder !== 0x42) {
    return { status: 'fail', reason: `bad byte-order 0x${byteOrder.toString(16)}` };
  }
  const littleEndian = byteOrder === 0x6c;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nameLen = view.getUint16(6, littleEndian);
  const dataLen = view.getUint16(8, littleEndian);
  const namePadded = (nameLen + 3) & ~3;
  const dataPadded = (dataLen + 3) & ~3;
  const total = 12 + namePadded + dataPadded;
  if (buf.byteLength < total) return { status: 'incomplete' };
  return { status: 'ok', littleEndian, consumed: total };
}

// Each new X11 client gets a fresh ~1M-wide resource-id range.
const ID_RANGE = 0x00100000;
let nextIdBase = 0x00200000;
export function allocResourceIdBase(): { base: number; mask: number } {
  const base = nextIdBase;
  nextIdBase += ID_RANGE;
  return { base, mask: ID_RANGE - 1 };
}

const VENDOR = 'x11-js';

export interface ScreenInfo {
  width: number;
  height: number;
  rootWindow: number;
  rootVisual: number;
}

export function buildSetupSuccess(opts: {
  littleEndian: boolean;
  resourceIdBase: number;
  resourceIdMask: number;
  screen: ScreenInfo;
}): Uint8Array {
  const { littleEndian, resourceIdBase, resourceIdMask, screen } = opts;
  const w = new Writer(1024, littleEndian);

  w.card8(1);           // 1 = Success
  w.card8(0);           // unused
  w.card16(11);         // protocol-major-version
  w.card16(0);          // protocol-minor-version
  w.card16(0);          // length of additional data in 4-byte units (patched at end)
  w.card32(0);          // release-number
  w.card32(resourceIdBase);
  w.card32(resourceIdMask);
  w.card32(0);          // motion-buffer-size

  const vendorBytes = new TextEncoder().encode(VENDOR);
  w.card16(vendorBytes.length);
  w.card16(0xffff);     // maximum-request-length (in 4-byte units)
  w.card8(1);           // number-of-screens
  w.card8(1);           // number-of-formats

  w.card8(littleEndian ? 0 : 1); // image-byte-order
  w.card8(0);           // bitmap-format-bit-order = LeastSignificant
  w.card8(32);          // bitmap-format-scanline-unit
  w.card8(32);          // bitmap-format-scanline-pad

  w.card8(8);           // min-keycode
  w.card8(255);         // max-keycode
  w.pad(4);             // unused

  w.bytes(vendorBytes);
  w.padTo(4);

  // One pixmap format
  w.card8(24);          // depth
  w.card8(32);          // bits-per-pixel
  w.card8(32);          // scanline-pad
  w.pad(5);             // unused

  // One screen
  w.card32(screen.rootWindow);
  w.card32(0);                       // default-colormap (None for now)
  w.card32(0x00ffffff);              // white-pixel
  w.card32(0x00000000);              // black-pixel
  w.card32(0);                       // current-input-masks
  w.card16(screen.width);
  w.card16(screen.height);
  w.card16(Math.max(1, Math.round(screen.width * 0.264)));   // width-in-mm @96dpi
  w.card16(Math.max(1, Math.round(screen.height * 0.264)));
  w.card16(1);                       // min-installed-maps
  w.card16(1);                       // max-installed-maps
  w.card32(screen.rootVisual);
  w.card8(0);                        // backing-stores: Never
  w.card8(0);                        // save-unders: False
  w.card8(24);                       // root-depth
  w.card8(1);                        // number-of-allowed-depths

  // One depth entry with one visual
  w.card8(24);                       // depth
  w.card8(0);                        // unused
  w.card16(1);                       // number-of-visuals
  w.pad(4);                          // unused

  w.card32(screen.rootVisual);
  w.card8(4);                        // class: TrueColor
  w.card8(8);                        // bits-per-rgb-value
  w.card16(256);                     // colormap-entries
  w.card32(0x00ff0000);              // red-mask
  w.card32(0x0000ff00);              // green-mask
  w.card32(0x000000ff);              // blue-mask
  w.pad(4);                          // unused

  const out = w.finish();
  // Patch additional-data length: (total - 8) / 4
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint16(6, (out.byteLength - 8) / 4, littleEndian);
  return out;
}
