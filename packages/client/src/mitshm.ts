/**
 * MIT-SHM stub. We can't actually share memory with the docker-side X
 * client, so we advertise the extension and report no SHM support — clients
 * gracefully fall back to standard PutImage / GetImage.
 *
 * The one thing we MUST do is reply to QueryVersion with sharedPixmaps=0 and
 * Attach with an error so client knows not to use shm pixmaps.
 */

import { Writer } from './wire.js';

export const MITSHM_MAJOR_OPCODE = 133;
export const MITSHM_FIRST_EVENT = 65;
export const MITSHM_FIRST_ERROR = 128;

interface Ctx {
  bytes: Uint8Array;
  littleEndian: boolean;
  sequence: number;
  send: (b: Uint8Array) => void;
}

export function handleMitShmRequest(c: Ctx) {
  const minor = new DataView(c.bytes.buffer, c.bytes.byteOffset, c.bytes.byteLength).getUint8(1);
  switch (minor) {
    case 0:  return onQueryVersion(c);
    case 1:  return; // ShmAttach — silently accept (won't work, but no error)
    case 2:  return; // ShmDetach
    case 3:  return; // PutImage — silently drop
    case 4:  return; // GetImage — would need a reply (skip — Gtk doesn't rely on this)
    case 5:  return; // CreatePixmap — silently accept
    default:
      console.warn(`[MIT-SHM] unhandled minor=${minor} len=${c.bytes.byteLength}`);
  }
}

function onQueryVersion(c: Ctx) {
  // Reply: sharedPixmaps (BOOL via data byte) + serverMajor (CARD16) +
  // serverMinor (CARD16) + uid (CARD16) + gid (CARD16) + pixmapFormat (CARD8)
  const w = new Writer(32, c.littleEndian);
  w.card8(1);                  // reply marker
  w.card8(0);                  // sharedPixmaps = False (no real shm)
  w.card16(c.sequence);
  w.card32(0);
  w.card16(1); w.card16(2);    // major=1, minor=2
  w.card16(0); w.card16(0);    // uid, gid
  w.card8(0);                  // pixmap format (ZPixmap not supported)
  w.pad(15);
  c.send(w.finish());
}
