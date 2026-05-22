/**
 * XSHAPE extension stub. Used by toolkits to define non-rectangular window
 * shapes (e.g., xeyes' eye outline, custom window decorations). We accept
 * all shape requests but don't actually clip the window — the underlying
 * rectangular canvas still renders. Visually wrong for shaped windows but
 * apps that just probe the extension proceed normally.
 */

import { Writer } from './wire.js';

export const SHAPE_MAJOR_OPCODE = 134;
export const SHAPE_FIRST_EVENT = 86;
export const SHAPE_FIRST_ERROR = 0;

interface Ctx {
  bytes: Uint8Array;
  littleEndian: boolean;
  sequence: number;
  send: (b: Uint8Array) => void;
}

export function handleShapeRequest(c: Ctx) {
  const minor = new DataView(c.bytes.buffer, c.bytes.byteOffset, c.bytes.byteLength).getUint8(1);
  switch (minor) {
    case 0:  return onQueryVersion(c);
    case 1:  return; // ShapeRectangles
    case 2:  return; // ShapeMask
    case 3:  return; // ShapeCombine
    case 4:  return; // ShapeOffset
    case 5:  return onShapeExtents(c);
    case 6:  return; // ShapeSelectInput
    case 7:  return onShapeInputSelected(c);
    case 8:  return onShapeGetRectangles(c);
    default:
      console.warn(`[SHAPE] unhandled minor=${minor} len=${c.bytes.byteLength}`);
  }
}

function onQueryVersion(c: Ctx) {
  const w = new Writer(32, c.littleEndian);
  w.card8(1);
  w.card8(0);
  w.card16(c.sequence);
  w.card32(0);
  w.card16(1); w.card16(1);    // major=1 minor=1
  w.pad(20);
  c.send(w.finish());
}

function onShapeExtents(c: Ctx) {
  // Reply: bounding_shaped, clip_shaped, pad(2),
  //   bounding_x, bounding_y, bounding_w, bounding_h,
  //   clip_x, clip_y, clip_w, clip_h.
  const w = new Writer(32, c.littleEndian);
  w.card8(1);
  w.card8(0);                  // bounding_shaped = false
  w.card16(c.sequence);
  w.card32(0);
  w.card8(0);                  // clip_shaped = false
  w.pad(3);
  w.card16(0); w.card16(0); w.card16(0); w.card16(0);
  w.card16(0); w.card16(0); w.card16(0); w.card16(0);
  w.pad(4);
  c.send(w.finish());
}

function onShapeInputSelected(c: Ctx) {
  const w = new Writer(32, c.littleEndian);
  w.card8(1);
  w.card8(0);                  // enabled = false
  w.card16(c.sequence);
  w.card32(0);
  w.pad(24);
  c.send(w.finish());
}

function onShapeGetRectangles(c: Ctx) {
  // Reply: ordering(BYTE) + nrectangles(4) + pad(20) + nrectangles*RECTANGLE(8)
  const w = new Writer(32, c.littleEndian);
  w.card8(1);
  w.card8(0);                  // ordering = Unsorted
  w.card16(c.sequence);
  w.card32(0);
  w.card32(0);                 // nrectangles = 0
  w.pad(20);
  c.send(w.finish());
}
