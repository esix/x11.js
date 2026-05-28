/**
 * Minimal RENDER extension implementation.
 *
 * Scope (in order of dependency):
 *   0  QueryVersion       — probe handshake
 *   1  QueryPictFormats   — declare ARGB32/RGB24/A8/A1
 *   4  CreatePicture      — wrap a drawable in a Picture with format/clip
 *   5  ChangePicture      — patch picture attrs (clip mask etc — partial)
 *   6  SetPictureClipRectangles — rectangle clip
 *   7  FreePicture
 *   8  Composite          — alpha-blended copy (PictOpOver, PictOpSrc)
 *  17  CreateGlyphSet     — glyph cache
 *  18  ReferenceGlyphSet  — alias an existing glyphset id
 *  19  FreeGlyphSet
 *  20  AddGlyphs          — upload alpha bitmaps
 *  23  CompositeGlyphs8   — draw glyphs (8-bit indices, Xft text path)
 *  24  CompositeGlyphs16  — 16-bit indices
 *  25  CompositeGlyphs32  — 32-bit indices
 *  26  FillRectangles     — solid-color rectangles with alpha
 *  33  CreateSolidFill    — a Picture that paints a single color
 *
 * Unimplemented requests are silently ignored. Cairo/Xft don't need them
 * for the text rendering path.
 */

import { Writer } from './wire.js';
import type { Drawable } from './types.js';

export const RENDER_MAJOR_OPCODE = 128;
export const RENDER_FIRST_EVENT = 0;       // we issue no RENDER events
export const RENDER_FIRST_ERROR = 142;     // first of 5 error codes RENDER reserves

// Standard picture formats. IDs are chosen by the server (us) and surfaced
// in QueryPictFormats — clients then reference them by ID.
export const PICT_FORMAT_ARGB32 = 0x100;
export const PICT_FORMAT_RGB24  = 0x101;
export const PICT_FORMAT_A8     = 0x102;
export const PICT_FORMAT_A1     = 0x103;

export interface Picture {
  id: number;
  drawable: number;   // Window or Pixmap id
  format: number;     // PICT_FORMAT_*
  owner: number;
  clipRects?: Array<{ x: number; y: number; w: number; h: number }>;
  // CPClipMask (ChangePicture): a pixmap whose coverage restricts where draws
  // on this picture land. 0/undefined = no mask. Plus its clip origin.
  clipMask?: number;
  clipXOrigin?: number;
  clipYOrigin?: number;
  // SetPictureTransform: source-sampling transform. We support the scale +
  // translate case (the common one for scaled icons/images); rotation/skew/
  // projective transforms are dropped (treated as identity). src coord for a
  // destination offset is sx*srcX+tx, sy*srcY+ty.
  xform?: { sx: number; sy: number; tx: number; ty: number };
  // CreateSolidFill stores a packed 0xAARRGGBB here. Used when the picture is
  // sourced as a solid color in Composite or FillRectangles.
  solidFill?: number;
}

export interface Glyph {
  width: number;
  height: number;
  xOff: number;       // origin offset within the glyph cell
  yOff: number;
  xAdvance: number;   // advance to next glyph baseline
  yAdvance: number;
  alpha: OffscreenCanvas;  // grayscale alpha mask (rendered as luminance)
}

export interface GlyphSet {
  id: number;
  format: number;
  owner: number;
  glyphs: Map<number, Glyph>;
}

export interface RenderState {
  pictures: Map<number, Picture>;
  glyphsets: Map<number, GlyphSet>;
}

export function createRenderState(): RenderState {
  return { pictures: new Map(), glyphsets: new Map() };
}

export interface Ctx {
  bytes: Uint8Array;
  littleEndian: boolean;
  sequence: number;
  clientId: number;
  send: (b: Uint8Array) => void;
  getDrawable: (id: number) => Drawable | undefined;
  invalidate: () => void;
  render: RenderState;
}

function reqView(c: Ctx): DataView {
  return new DataView(c.bytes.buffer, c.bytes.byteOffset, c.bytes.byteLength);
}

function makeReply(c: Ctx, dataByte: number, build: (w: Writer) => void): Uint8Array {
  const w = new Writer(64, c.littleEndian);
  w.card8(1);
  w.card8(dataByte);
  w.card16(c.sequence);
  w.card32(0);
  const start = w.offset;
  build(w);
  while (w.offset - start < 24) w.pad(1);
  const out = w.finish();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(4, Math.max(0, (out.byteLength - 32) / 4), c.littleEndian);
  return out;
}

// ---- dispatch -------------------------------------------------------------

export function handleRenderRequest(c: Ctx) {
  const view = new DataView(c.bytes.buffer, c.bytes.byteOffset, c.bytes.byteLength);
  const minor = view.getUint8(1);
  switch (minor) {
    case 0:  return onQueryVersion(c);
    case 1:  return onQueryPictFormats(c);
    case 4:  return onCreatePicture(c);
    case 5:  return onChangePicture(c);
    case 6:  return onSetPictureClipRectangles(c);
    case 7:  return onFreePicture(c);
    case 8:  return onComposite(c);
    case 10: return onTrapezoids(c);
    case 17: return onCreateGlyphSet(c);
    case 18: return onReferenceGlyphSet(c);
    case 19: return onFreeGlyphSet(c);
    case 20: return onAddGlyphs(c);
    case 22: return; // FreeGlyphs — not maintaining per-glyph lifecycle
    case 23: return onCompositeGlyphs(c, 1);
    case 24: return onCompositeGlyphs(c, 2);
    case 25: return onCompositeGlyphs(c, 4);
    case 26: return onFillRectangles(c);
    case 27: return; // CreateCursor — RENDER-based color cursor; accept silently
    case 28: return onSetPictureTransform(c);
    case 31: return; // CreateAnimCursor — accept silently
    case 29: return; // QueryFilters — would need a reply; many callers tolerate ignored
    case 30: return; // SetPictureFilter — we always use canvas bilinear/nearest
    case 33: return onCreateSolidFill(c);
    case 34: return onCreateLinearGradient(c);
    case 35: return onCreateRadialGradient(c);
    case 36: return onCreateConicalGradient(c);
    default:
      console.warn(`[RENDER] unhandled minor=${minor} len=${c.bytes.byteLength}`);
  }
}

// ---- requests -------------------------------------------------------------

function onQueryVersion(c: Ctx) {
  // We claim RENDER 0.11 — the version where CompositeGlyphs + GlyphSet
  // existed. (Later versions add gradients/transforms we don't implement.)
  c.send(makeReply(c, 0, (w) => {
    w.card32(0);          // major
    w.card32(11);         // minor
    w.pad(16);
  }));
}

function onQueryPictFormats(c: Ctx) {
  // Format entries (28 bytes each). We declare 4 standard formats; Cairo/Xft
  // pick by depth + masks to find ARGB32 and A8.
  type FmtSpec = { id: number; depth: number; type: 1 | 0; r: [number, number]; g: [number, number]; b: [number, number]; a: [number, number]; };
  const formats: FmtSpec[] = [
    { id: PICT_FORMAT_ARGB32, depth: 32, type: 1, r: [16, 0xff], g: [8, 0xff], b: [0, 0xff], a: [24, 0xff] },
    { id: PICT_FORMAT_RGB24,  depth: 24, type: 1, r: [16, 0xff], g: [8, 0xff], b: [0, 0xff], a: [0, 0] },
    { id: PICT_FORMAT_A8,     depth: 8,  type: 1, r: [0, 0], g: [0, 0], b: [0, 0], a: [0, 0xff] },
    { id: PICT_FORMAT_A1,     depth: 1,  type: 1, r: [0, 0], g: [0, 0], b: [0, 0], a: [0, 1] },
  ];

  // Compute sizes. Reply payload has header (24 already by makeReply) + format
  // table + screen tables + subpixel table. We pre-size a Writer manually
  // because the reply is variable-length and exceeds makeReply's auto 32-byte
  // floor.
  const formatBlockLen = formats.length * 28;
  // screens: 1 screen, per screen: num_depths (4), fallback (4); per depth:
  // depth (1) + pad(1) + num_visuals(2) + pad(4); per visual: visual(4) + fmt(4)
  // Group visuals by depth: in our case 1 visual per depth, 2 depths
  const depthsForScreen = [
    { depth: 24, visuals: [{ visual: 0x21, fmt: PICT_FORMAT_RGB24 }] },
    { depth: 32, visuals: [{ visual: 0x21, fmt: PICT_FORMAT_ARGB32 }] },
  ];
  let screensLen = 4 + 4;  // num_depths + fallback
  for (const d of depthsForScreen) screensLen += 8 + d.visuals.length * 8;

  const subpixelLen = 4;  // 1 screen × CARD32

  const payload = 24 /* counts */ + formatBlockLen + screensLen + subpixelLen;
  const totalReply = 32 + ((payload - 24 + 3) & ~3);

  // Counts are TOTALS across all screens — clients use these to size buffers.
  let totalDepths = 0;
  let totalVisuals = 0;
  for (const d of depthsForScreen) { totalDepths++; totalVisuals += d.visuals.length; }

  const w = new Writer(totalReply, c.littleEndian);
  w.card8(1);             // reply marker
  w.card8(0);             // unused
  w.card16(c.sequence);
  w.card32((totalReply - 32) / 4);   // reply length in 4-byte units past 32
  w.card32(formats.length);
  w.card32(1);            // num screens
  w.card32(totalDepths);
  w.card32(totalVisuals);
  w.card32(1);            // num subpixel (one per screen)
  w.pad(4);
  // PICTFORMINFO entries
  for (const f of formats) {
    w.card32(f.id);
    w.card8(f.type);    // 1 = Direct
    w.card8(f.depth);
    w.pad(2);
    w.card16(f.r[0]); w.card16(f.r[1]);
    w.card16(f.g[0]); w.card16(f.g[1]);
    w.card16(f.b[0]); w.card16(f.b[1]);
    w.card16(f.a[0]); w.card16(f.a[1]);
    w.card32(0);          // colormap (None for direct visuals)
  }
  // Screen / depth / visual nesting
  w.card32(depthsForScreen.length);
  w.card32(0);            // fallback PictFormat (none)
  for (const d of depthsForScreen) {
    w.card8(d.depth);
    w.pad(1);
    w.card16(d.visuals.length);
    w.pad(4);
    for (const v of d.visuals) {
      w.card32(v.visual);
      w.card32(v.fmt);
    }
  }
  // Per-screen subpixel order (5 = SubPixelNone)
  w.card32(5);

  // pad to 4-byte boundary if needed
  while (w.offset < totalReply) w.pad(1);
  c.send(w.finish());
}

function onCreatePicture(c: Ctx) {
  const v = reqView(c); const le = c.littleEndian;
  const pid = v.getUint32(4, le);
  const drawable = v.getUint32(8, le);
  const format = v.getUint32(12, le);
  // bytes 16..19 = value-mask; 20+ = values (we ignore all attrs for now)
  c.render.pictures.set(pid, { id: pid, drawable, format, owner: c.clientId });
}

function onFreePicture(c: Ctx) {
  const pid = reqView(c).getUint32(4, c.littleEndian);
  c.render.pictures.delete(pid);
}

// ChangePicture (op 5): update picture attributes. We act on the clip, which
// can be set two ways that share one slot: SetPictureClipRectangles (a rect
// list) OR ChangePicture with CPClipMask (a pixmap, or None to remove all
// clipping). Crucially, CPClipMask = None must CLEAR any clip rectangles too —
// toolkits (Cairo, as used by gnome-mahjongg/-mines) set a per-tile clip rect,
// draw, then reset the clip with CPClipMask=None before the next tile. Ignoring
// that reset left a stale rect that clipped every later draw away (blank
// mahjongg tile faces). Other attributes are accepted and ignored. Values
// follow the 32-bit value-mask in ascending bit order, one CARD32 each.
// SetPictureTransform (op 28): a 3x3 FIXED (16.16) matrix mapping destination
// coords to source coords. GTK/Cairo scales icons and images by setting a
// scale transform on the source picture, then compositing. We honor the
// scale+translate part (drawImage can express that); rotation/skew/projective
// matrices are dropped to identity (no worse than before — they were ignored
// entirely). Without this, scaled-icon composites read the source 1:1 and the
// icon never appears.
function onSetPictureTransform(c: Ctx) {
  const v = reqView(c); const le = c.littleEndian;
  const pid = v.getUint32(4, le);
  const pic = c.render.pictures.get(pid);
  if (!pic) return;
  const m = (off: number) => v.getInt32(off, le) / 65536;
  const m00 = m(8),  m01 = m(12), m02 = m(16);
  const m10 = m(20), m11 = m(24), m12 = m(28);
  const m20 = m(32), m21 = m(36), m22 = m(40);
  // Pure scale+translate only: off-diagonal and projective terms must be zero
  // and the homogeneous term 1. Anything else (or identity) → no transform.
  const identity = m00 === 1 && m11 === 1 && m02 === 0 && m12 === 0;
  const supported = m01 === 0 && m10 === 0 && m20 === 0 && m21 === 0 && m22 === 1 && m00 !== 0 && m11 !== 0;
  if (identity || !supported) { delete pic.xform; return; }
  pic.xform = { sx: m00, sy: m11, tx: m02, ty: m12 };
}

function onChangePicture(c: Ctx) {
  const v = reqView(c); const le = c.littleEndian;
  const pid = v.getUint32(4, le);
  const valueMask = v.getUint32(8, le);
  const pic = c.render.pictures.get(pid);
  if (!pic) return;
  let p = 12;
  const ATTR_CLIP_X_ORIGIN = 4, ATTR_CLIP_Y_ORIGIN = 5, ATTR_CLIP_MASK = 6;
  for (let bit = 0; bit < 13; bit++) {
    if (!(valueMask & (1 << bit))) continue;
    if (p + 4 > c.bytes.byteLength) break;
    const val = v.getUint32(p, le); p += 4;
    if (bit === ATTR_CLIP_X_ORIGIN) pic.clipXOrigin = (val << 16) >> 16;        // INT16
    else if (bit === ATTR_CLIP_Y_ORIGIN) pic.clipYOrigin = (val << 16) >> 16;   // INT16
    else if (bit === ATTR_CLIP_MASK) {
      if (val === 0) {
        // None: remove ALL clipping (mask and any rectangles).
        delete pic.clipMask;
        delete pic.clipRects;
        pic.clipXOrigin = 0; pic.clipYOrigin = 0;
      } else {
        pic.clipMask = val;
      }
    }
  }
}

function onSetPictureClipRectangles(c: Ctx) {
  const v = reqView(c); const le = c.littleEndian;
  const pid = v.getUint32(4, le);
  const pic = c.render.pictures.get(pid);
  if (!pic) return;
  // bytes 8..11 = clip x_origin / y_origin (CARD16+CARD16). Then rectangles.
  const ox = v.getInt16(8, le);
  const oy = v.getInt16(10, le);
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (let p = 12; p + 8 <= c.bytes.byteLength; p += 8) {
    rects.push({
      x: v.getInt16(p, le) + ox,
      y: v.getInt16(p + 2, le) + oy,
      w: v.getUint16(p + 4, le),
      h: v.getUint16(p + 6, le),
    });
  }
  pic.clipRects = rects;
  if ((globalThis as any).__rtrace) {
    console.log(`[RENDER] SetClipRects pid=0x${pid.toString(16)} rects=${JSON.stringify(rects)}`);
  }
}

function onComposite(c: Ctx) {
  const v = reqView(c); const le = c.littleEndian;
  const op = v.getUint8(4);                 // PictOp
  const srcId = v.getUint32(8, le);
  const maskId = v.getUint32(12, le);
  const dstId = v.getUint32(16, le);
  const srcX = v.getInt16(20, le);
  const srcY = v.getInt16(22, le);
  // const maskX = v.getInt16(24, le);
  // const maskY = v.getInt16(26, le);
  const dstX = v.getInt16(28, le);
  const dstY = v.getInt16(30, le);
  const w = v.getUint16(32, le);
  const h = v.getUint16(34, le);

  const src = c.render.pictures.get(srcId);
  const dst = c.render.pictures.get(dstId);
  if (!dst) return;
  const dstDr = c.getDrawable(dst.drawable);
  if (!dstDr || w === 0 || h === 0) return;
  const dctx = dstDr.ctx;
  dctx.save();
  applyClip(dctx, dst);
  // PictOpSrc/Clear semantics: dest := src in the region (including alpha).
  // Canvas's 'copy' achieves this but clears outside the source path too,
  // which corrupts the rest of the canvas. We pre-clear the dest rect then
  // composite with source-over — same final state, no collateral damage.
  if (op === 0 || op === 1) {
    dctx.clearRect(dstX, dstY, w, h);
    dctx.globalCompositeOperation = 'source-over';
  } else {
    dctx.globalCompositeOperation = pictOpToCanvas(op);
  }

  if (src?.solidFill !== undefined) {
    // Solid-fill picture: ignore srcX/srcY, paint a uniform color rect.
    dctx.fillStyle = argbToCss(src.solidFill);
    dctx.fillRect(dstX, dstY, w, h);
  } else if (src) {
    const srcDr = c.getDrawable(src.drawable);
    if (srcDr) {
      // Source-sampling region. With a scale+translate transform on the source
      // (GTK/Cairo uses this to scale icons/images), the dst w×h reads a
      // (sx*w)×(sy*h) region of the source at the transformed origin —
      // drawImage then scales it back into the dst rect. Without honoring this
      // the icon read the wrong (often out-of-bounds → blank) source region.
      const xf = src.xform;
      const sx = xf ? xf.sx * srcX + xf.tx : srcX;
      const sy = xf ? xf.sy * srcY + xf.ty : srcY;
      const sw = xf ? xf.sx * w : w;
      const sh = xf ? xf.sy * h : h;
      // Canvas drawImage with overlapping src/dst on the same canvas is
      // undefined behavior — pixels often smear. Emacs uses this for its
      // line-scroll path (RenderComposite copying a region upward over itself).
      // Detour through a scratch canvas when src and dst share a buffer.
      if (srcDr === dstDr) {
        const tmp = new OffscreenCanvas(w, h);
        const tctx = tmp.getContext('2d')!;
        tctx.drawImage(srcDr.buffer, sx, sy, sw, sh, 0, 0, w, h);
        dctx.drawImage(tmp, 0, 0, w, h, dstX, dstY, w, h);
      } else {
        dctx.drawImage(srcDr.buffer, sx, sy, sw, sh, dstX, dstY, w, h);
      }
    }
  }

  dctx.restore();
  invalidateIfWindow(c, dst);
  void maskId; // mask path not implemented yet
}

/**
 * RENDER Trapezoids: rasterize a list of trapezoids onto dst, modulated by
 * src as the color source. Each trapezoid is bounded by top/bottom Y plus
 * two oblique line segments (left & right edges). For the (very common)
 * solid-fill src case we just fillPath each trapezoid as a 4-vertex polygon
 * — Canvas handles the rasterization, anti-aliasing included.
 */
function onTrapezoids(c: Ctx) {
  const v = reqView(c); const le = c.littleEndian;
  const op = v.getUint8(4);
  const srcId = v.getUint32(8, le);
  const dstId = v.getUint32(12, le);
  // bytes 16..19 = mask-format, bytes 20..23 = src origin x/y. Each trap is 40 bytes.
  const srcOriginX = v.getInt16(20, le);
  const srcOriginY = v.getInt16(22, le);
  const src = c.render.pictures.get(srcId);
  const dst = c.render.pictures.get(dstId);
  if (!dst) return;
  const dstDr = c.getDrawable(dst.drawable);
  if (!dstDr) return;

  const dctx = dstDr.ctx;
  dctx.save();
  applyClip(dctx, dst);
  if (op === 0 || op === 1) {
    // Src/Clear: pre-clear the bounding rect of each trapezoid below.
  }
  dctx.globalCompositeOperation = pictOpToCanvas(op);

  // Determine paint style.
  let fillStyle: string | CanvasPattern = 'rgba(0,0,0,1)';
  if (src?.solidFill !== undefined) {
    fillStyle = argbToCss(src.solidFill);
  } else if (src) {
    const srcDr = c.getDrawable(src.drawable);
    if (srcDr) {
      // For a non-solid source, sample the source at the trapezoid's
      // top-left as an approximation. Most callers use solid fills.
      try {
        const px = srcDr.ctx.getImageData(srcOriginX, srcOriginY, 1, 1).data;
        fillStyle = `rgba(${px[0]},${px[1]},${px[2]},${(px[3] ?? 0xff) / 255})`;
      } catch { /* fall through */ }
    }
  }
  dctx.fillStyle = fillStyle;

  // X RENDER fixed-point: 16.16. Read with getInt32 then /65536.
  const fx = (off: number) => v.getInt32(off, le) / 65536;

  // X-coord on a line at scanline y: linearly interpolate between p1 and p2.
  // If the line is horizontal (p1.y == p2.y), return p1.x.
  const xAtY = (p1x: number, p1y: number, p2x: number, p2y: number, y: number) => {
    const dy = p2y - p1y;
    if (Math.abs(dy) < 1e-6) return p1x;
    return p1x + (p2x - p1x) * (y - p1y) / dy;
  };

  for (let p = 24; p + 40 <= c.bytes.byteLength; p += 40) {
    const top = fx(p);
    const bottom = fx(p + 4);
    const lp1x = fx(p + 8),  lp1y = fx(p + 12);
    const lp2x = fx(p + 16), lp2y = fx(p + 20);
    const rp1x = fx(p + 24), rp1y = fx(p + 28);
    const rp2x = fx(p + 32), rp2y = fx(p + 36);
    if (bottom <= top) continue;

    const xTL = xAtY(lp1x, lp1y, lp2x, lp2y, top);
    const xBL = xAtY(lp1x, lp1y, lp2x, lp2y, bottom);
    const xTR = xAtY(rp1x, rp1y, rp2x, rp2y, top);
    const xBR = xAtY(rp1x, rp1y, rp2x, rp2y, bottom);

    dctx.beginPath();
    dctx.moveTo(xTL, top);
    dctx.lineTo(xTR, top);
    dctx.lineTo(xBR, bottom);
    dctx.lineTo(xBL, bottom);
    dctx.closePath();
    dctx.fill();
  }
  dctx.restore();
  invalidateIfWindow(c, dst);
}

function onCreateGlyphSet(c: Ctx) {
  const v = reqView(c); const le = c.littleEndian;
  const gsid = v.getUint32(4, le);
  const format = v.getUint32(8, le);
  c.render.glyphsets.set(gsid, { id: gsid, format, owner: c.clientId, glyphs: new Map() });
}

function onReferenceGlyphSet(c: Ctx) {
  const v = reqView(c); const le = c.littleEndian;
  const gsid = v.getUint32(4, le);
  const existing = v.getUint32(8, le);
  const old = c.render.glyphsets.get(existing);
  if (old) c.render.glyphsets.set(gsid, old);
}

function onFreeGlyphSet(c: Ctx) {
  const gsid = reqView(c).getUint32(4, c.littleEndian);
  c.render.glyphsets.delete(gsid);
}

function onAddGlyphs(c: Ctx) {
  const v = reqView(c); const le = c.littleEndian;
  const gsid = v.getUint32(4, le);
  const count = v.getUint32(8, le);
  const gs = c.render.glyphsets.get(gsid);
  if (!gs) return;

  // Layout:
  //   glyph-ids: count × CARD32
  //   glyphinfo: count × 12 bytes (w,h,x,y,xOff,yOff each CARD16+INT16)
  //   data bytes (packed, 4-byte padded total, format-dependent)
  let p = 12;
  const ids: number[] = [];
  for (let i = 0; i < count; i++, p += 4) ids.push(v.getUint32(p, le));
  const infos: Array<{ w: number; h: number; xOff: number; yOff: number; xAdv: number; yAdv: number }> = [];
  for (let i = 0; i < count; i++, p += 12) {
    infos.push({
      w: v.getUint16(p, le),
      h: v.getUint16(p + 2, le),
      xOff: v.getInt16(p + 4, le),
      yOff: v.getInt16(p + 6, le),
      xAdv: v.getInt16(p + 8, le),
      yAdv: v.getInt16(p + 10, le),
    });
  }
  let dataOff = p;
  for (let i = 0; i < count; i++) {
    const info = infos[i]!;
    const id = ids[i]!;
    const stride = strideForFormat(gs.format, info.w);
    const bytes = stride * info.h;
    const slice = c.bytes.subarray(dataOff, dataOff + bytes);
    dataOff += bytes;
    // 4-byte align between glyphs
    while (dataOff & 3) dataOff++;

    const alpha = glyphAlphaCanvas(gs.format, info.w, info.h, slice, stride);
    gs.glyphs.set(id, {
      width: info.w, height: info.h,
      xOff: info.xOff, yOff: info.yOff,
      xAdvance: info.xAdv, yAdvance: info.yAdv,
      alpha,
    });
  }
}

function onCompositeGlyphs(c: Ctx, indexBytes: 1 | 2 | 4) {
  const v = reqView(c); const le = c.littleEndian;
  const op = v.getUint8(4);
  const srcId = v.getUint32(8, le);
  const dstId = v.getUint32(12, le);
  // const maskFormat = v.getUint32(16, le);  // hint; we always use alpha
  const gsid = v.getUint32(20, le);
  const srcOriginX = v.getInt16(24, le);
  const srcOriginY = v.getInt16(26, le);

  const src = c.render.pictures.get(srcId);
  const dst = c.render.pictures.get(dstId);
  const gs = c.render.glyphsets.get(gsid);
  if (!dst || !gs) return;
  const dstDr = c.getDrawable(dst.drawable);
  if (!dstDr) return;
  if ((globalThis as any).__rtrace) {
    let firstGid = -1;
    if (c.bytes.byteLength >= 28 + 8 + indexBytes) {
      firstGid = indexBytes === 1 ? v.getUint8(28 + 8)
        : indexBytes === 2 ? v.getUint16(28 + 8, le)
        : v.getUint32(28 + 8, le);
    }
    const clipStr = dst.clipRects ? JSON.stringify(dst.clipRects) : 'none';
    console.log(`[RENDER] CompositeGlyphs dstPid=0x${dstId.toString(16)} op=${op} firstGid=${firstGid} clip=${clipStr}`);
  }

  const dctx = dstDr.ctx;
  dctx.save();
  applyClip(dctx, dst);
  dctx.globalCompositeOperation = pictOpToCanvas(op);

  // GLYPHITEMs (variable):
  //   header: nGlyphs (1) + pad (3) + dx (int16) + dy (int16) = 8
  //     - if nGlyphs == 0xFF, this is a "skip" header meaning the next 4 bytes
  //       are a glyphset id (we don't implement multi-glyphset switch); skip.
  //   glyphs: nGlyphs × indexBytes (then padded to 4)
  let p = 28;
  let curX = 0, curY = 0;
  // Source for foreground color: solid fill or per-pixel sample.
  const srcSolid = src?.solidFill;
  const srcDr = (!src || srcSolid !== undefined) ? undefined : c.getDrawable(src.drawable);

  while (p + 8 <= c.bytes.byteLength) {
    const n = v.getUint8(p);
    if (n === 0xff) {
      // skip-header: next 4 bytes = new glyphset id — not implemented
      p += 8;
      continue;
    }
    const dx = v.getInt16(p + 4, le);
    const dy = v.getInt16(p + 6, le);
    curX += dx;
    curY += dy;
    p += 8;
    for (let i = 0; i < n; i++) {
      let gid: number;
      if (indexBytes === 1) gid = v.getUint8(p);
      else if (indexBytes === 2) gid = v.getUint16(p, le);
      else gid = v.getUint32(p, le);
      p += indexBytes;
      const g = gs.glyphs.get(gid);
      if (g) {
        const drawX = curX - g.xOff;
        const drawY = curY - g.yOff;
        if (srcSolid !== undefined) {
          drawGlyphColored(dctx, g, drawX, drawY, srcSolid);
        } else if (srcDr) {
          // Sample source color at (srcOriginX + curX, srcOriginY + curY)
          const px = sampleSrc(srcDr, srcOriginX + curX, srcOriginY + curY);
          drawGlyphColored(dctx, g, drawX, drawY, px);
        } else {
          // No source → draw the alpha mask in black.
          drawGlyphColored(dctx, g, drawX, drawY, 0xff000000);
        }
        curX += g.xAdvance;
        curY += g.yAdvance;
      }
    }
    // pad to 4-byte boundary
    while (p & 3) p++;
  }

  dctx.restore();
  invalidateIfWindow(c, dst);
}

function onFillRectangles(c: Ctx) {
  const v = reqView(c); const le = c.littleEndian;
  const op = v.getUint8(4);
  const pid = v.getUint32(8, le);
  // 8 bytes of color (CARD16×4 = R G B A)
  const r = v.getUint16(12, le);
  const g = v.getUint16(14, le);
  const b = v.getUint16(16, le);
  const a = v.getUint16(18, le);
  const pic = c.render.pictures.get(pid);
  if (!pic) return;
  if ((globalThis as any).__rtrace) {
    const rects = [];
    for (let pp = 20; pp + 8 <= c.bytes.byteLength; pp += 8) {
      rects.push([v.getInt16(pp, le), v.getInt16(pp + 2, le), v.getUint16(pp + 4, le), v.getUint16(pp + 6, le)]);
    }
    console.log(`[RENDER] FillRect pid=0x${pid.toString(16)} op=${op} rgba=(${r >> 8},${g >> 8},${b >> 8},${a >> 8}) clip=${JSON.stringify(pic.clipRects)} rects=${JSON.stringify(rects)}`);
  }
  const dr = c.getDrawable(pic.drawable);
  if (!dr) return;
  const dctx = dr.ctx;
  dctx.save();
  applyClip(dctx, pic);
  const isSrcOrClear = op === 0 || op === 1;
  if (!isSrcOrClear) dctx.globalCompositeOperation = pictOpToCanvas(op);
  dctx.fillStyle = `rgba(${r >> 8}, ${g >> 8}, ${b >> 8}, ${(a >> 8) / 255})`;
  for (let pp = 20; pp + 8 <= c.bytes.byteLength; pp += 8) {
    const x = v.getInt16(pp, le);
    const y = v.getInt16(pp + 2, le);
    const w = v.getUint16(pp + 4, le);
    const h = v.getUint16(pp + 6, le);
    // For Src/Clear, pre-clear so dest takes src exactly (incl. alpha).
    if (isSrcOrClear) {
      dctx.save();
      dctx.globalCompositeOperation = 'source-over';
      dctx.clearRect(x, y, w, h);
      dctx.fillRect(x, y, w, h);
      dctx.restore();
    } else {
      dctx.fillRect(x, y, w, h);
    }
  }
  dctx.restore();
  invalidateIfWindow(c, pic);
}

function onCreateSolidFill(c: Ctx) {
  const v = reqView(c); const le = c.littleEndian;
  const pid = v.getUint32(4, le);
  const r = v.getUint16(8, le);
  const g = v.getUint16(10, le);
  const b = v.getUint16(12, le);
  const a = v.getUint16(14, le);
  c.render.pictures.set(pid, {
    id: pid, drawable: 0, format: PICT_FORMAT_ARGB32, owner: c.clientId,
    solidFill: ((a & 0xff00) << 16) | ((r & 0xff00) << 8) | (g & 0xff00) | (b >> 8),
  });
}

/**
 * Gradient stubs (CreateLinearGradient/Radial/Conical). We approximate the
 * gradient as a single solid fill using the average of the stops — fine for
 * UI tints that just want a "this region is roughly this color" effect.
 */
function readGradientStops(v: DataView, le: boolean, offset: number, count: number): number {
  if (count === 0) return 0xff000000 | 0;
  let p = offset + 4 * count;       // skip N FIXED stop positions first
  let tr = 0, tg = 0, tb = 0, ta = 0;
  for (let i = 0; i < count; i++, p += 8) {
    tr += v.getUint16(p, le) >> 8;
    tg += v.getUint16(p + 2, le) >> 8;
    tb += v.getUint16(p + 4, le) >> 8;
    ta += v.getUint16(p + 6, le) >> 8;
  }
  const r = Math.round(tr / count) & 0xff;
  const g = Math.round(tg / count) & 0xff;
  const b = Math.round(tb / count) & 0xff;
  const a = Math.round(ta / count) & 0xff;
  return ((a << 24) | (r << 16) | (g << 8) | b) | 0;
}

function onCreateLinearGradient(c: Ctx) {
  const v = reqView(c); const le = c.littleEndian;
  const pid = v.getUint32(4, le);
  const numStops = v.getUint32(24, le);
  c.render.pictures.set(pid, {
    id: pid, drawable: 0, format: PICT_FORMAT_ARGB32, owner: c.clientId,
    solidFill: readGradientStops(v, le, 28, numStops),
  });
}

function onCreateRadialGradient(c: Ctx) {
  const v = reqView(c); const le = c.littleEndian;
  const pid = v.getUint32(4, le);
  const numStops = v.getUint32(32, le);
  c.render.pictures.set(pid, {
    id: pid, drawable: 0, format: PICT_FORMAT_ARGB32, owner: c.clientId,
    solidFill: readGradientStops(v, le, 36, numStops),
  });
}

function onCreateConicalGradient(c: Ctx) {
  const v = reqView(c); const le = c.littleEndian;
  const pid = v.getUint32(4, le);
  const numStops = v.getUint32(20, le);
  c.render.pictures.set(pid, {
    id: pid, drawable: 0, format: PICT_FORMAT_ARGB32, owner: c.clientId,
    solidFill: readGradientStops(v, le, 24, numStops),
  });
}

// ---- helpers --------------------------------------------------------------

function pictOpToCanvas(op: number): GlobalCompositeOperation {
  // PictOp values from X Render spec:
  //   0=Clear  1=Src  2=Dst  3=Over  4=OverReverse  5=In  6=InReverse
  //   7=Out    8=OutReverse  9=Atop  10=AtopReverse  11=Xor  12=Add
  //   13=Saturate
  //
  // Note: X RENDER's PictOpSrc only affects the rect/glyph region. Canvas's
  // 'copy' mode clears the *entire* canvas outside the drawn region — wrong.
  // We use 'source-over' for opaque-only paths (xterm/Xft always paints with
  // alpha=255), which matches X semantics there. Truly-transparent PictOpSrc
  // fills would need explicit clearRect + path clipping; rare in toolkit code.
  switch (op) {
    case 0:  return 'destination-out';       // Clear: erase dest
    case 1:  return 'source-over';           // Src — see note above
    case 2:  return 'destination-over';      // Dst (no-op-ish; use dest-over)
    case 3:  return 'source-over';           // Over (the common case)
    case 4:  return 'destination-over';      // OverReverse
    case 5:  return 'source-in';
    case 6:  return 'destination-in';
    case 7:  return 'source-out';
    case 8:  return 'destination-out';
    case 9:  return 'source-atop';
    case 10: return 'destination-atop';
    case 11: return 'xor';
    case 12: return 'lighter';               // Add
    default: return 'source-over';
  }
}

function applyClip(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, pic: Picture) {
  const rects = pic.clipRects;
  if (!rects || rects.length === 0) return;
  ctx.beginPath();
  for (const r of rects) ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
}

function argbToCss(packed: number): string {
  const a = (packed >>> 24) & 0xff;
  const r = (packed >>> 16) & 0xff;
  const g = (packed >>> 8) & 0xff;
  const b = packed & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

function strideForFormat(format: number, w: number): number {
  // Stride is the byte width of one scanline, padded to 4 bytes.
  let bytes: number;
  if (format === PICT_FORMAT_A8) bytes = w;
  else if (format === PICT_FORMAT_A1) bytes = (w + 7) >> 3;
  else if (format === PICT_FORMAT_RGB24) bytes = w * 4;       // X pads to 32
  else bytes = w * 4;                                          // ARGB32 default
  return (bytes + 3) & ~3;
}

function glyphAlphaCanvas(format: number, w: number, h: number, data: Uint8Array, stride: number): OffscreenCanvas {
  const out = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  if (w === 0 || h === 0) return out;
  const octx = out.getContext('2d')!;
  const img = octx.createImageData(w, h);
  const od = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let alpha = 0;
      if (format === PICT_FORMAT_A8) {
        alpha = data[y * stride + x] ?? 0;
      } else if (format === PICT_FORMAT_A1) {
        const byte = data[y * stride + (x >> 3)] ?? 0;
        alpha = ((byte >> (x & 7)) & 1) ? 0xff : 0;
      } else {
        // ARGB32 / RGB24 — take the alpha (or assume opaque)
        const idx = y * stride + x * 4;
        alpha = data[idx + 3] ?? 0xff;
      }
      const o = (y * w + x) * 4;
      od[o] = 0xff; od[o + 1] = 0xff; od[o + 2] = 0xff; od[o + 3] = alpha;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function drawGlyphColored(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, g: Glyph, x: number, y: number, packedColor: number) {
  if (g.width === 0 || g.height === 0) return;
  const tmp = new OffscreenCanvas(g.width, g.height);
  const tctx = tmp.getContext('2d')!;
  tctx.fillStyle = argbToCss(packedColor);
  tctx.fillRect(0, 0, g.width, g.height);
  tctx.globalCompositeOperation = 'destination-in';
  tctx.drawImage(g.alpha, 0, 0);
  if ((globalThis as any).__rtrace && g.width > 5 && g.height > 5) {
    // Sample tmp before transfer to verify the per-glyph image
    const tdata = tctx.getImageData(0, 0, g.width, g.height).data;
    let tmpOpaque = 0;
    for (let i = 3; i < tdata.length; i += 4) if ((tdata[i] ?? 0) > 0) tmpOpaque++;
    // Sample dctx around (x, y) BEFORE draw
    let beforeOpaque = 0;
    try {
      const bd = (ctx as any).getImageData(x, y, g.width, g.height).data;
      for (let i = 3; i < bd.length; i += 4) if ((bd[i] ?? 0) > 0) beforeOpaque++;
    } catch {}
    ctx.drawImage(tmp, x, y);
    let afterOpaque = 0;
    try {
      const ad = (ctx as any).getImageData(x, y, g.width, g.height).data;
      for (let i = 3; i < ad.length; i += 4) if ((ad[i] ?? 0) > 0) afterOpaque++;
    } catch {}
    console.log(`  glyph ${g.width}x${g.height} @(${x},${y}) tmp=${tmpOpaque}px before=${beforeOpaque}px after=${afterOpaque}px op=${(ctx as any).globalCompositeOperation}`);
  } else {
    ctx.drawImage(tmp, x, y);
  }
}

function sampleSrc(d: Drawable, x: number, y: number): number {
  try {
    const px = d.ctx.getImageData(x, y, 1, 1).data;
    return (0xff << 24) | (px[0]! << 16) | (px[1]! << 8) | px[2]!;
  } catch {
    return 0xff000000;
  }
}

function invalidateIfWindow(c: Ctx, pic: Picture) {
  const d = c.getDrawable(pic.drawable);
  if (d && 'mapped' in d) c.invalidate();
}
