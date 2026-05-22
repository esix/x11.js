import { Writer } from './wire.js';
import type { Renderer } from './renderer.js';
import { Window, Pixmap, pixelToCss, EVENT_MASK, type GC, type Drawable, type PointerGrab, type Cursor } from './types.js';
import { handleRenderRequest, RENDER_MAJOR_OPCODE, RENDER_FIRST_EVENT, RENDER_FIRST_ERROR, type RenderState } from './render.js';
import { handleXInput2Request, XINPUT_MAJOR_OPCODE, XINPUT_FIRST_EVENT, XINPUT_FIRST_ERROR } from './xinput2.js';
import { handleXkbRequest, XKB_MAJOR_OPCODE, XKB_FIRST_EVENT, XKB_FIRST_ERROR } from './xkb.js';
import { handleRandrRequest, RANDR_MAJOR_OPCODE, RANDR_FIRST_EVENT, RANDR_FIRST_ERROR } from './randr.js';
import { handleMitShmRequest, MITSHM_MAJOR_OPCODE, MITSHM_FIRST_EVENT, MITSHM_FIRST_ERROR } from './mitshm.js';
import { handleShapeRequest, SHAPE_MAJOR_OPCODE, SHAPE_FIRST_EVENT, SHAPE_FIRST_ERROR } from './shape.js';
import { FONT, FAKE_FONT_NAMES } from './font.js';
import {
  MIN_KEYCODE, MAX_KEYCODE, KEYSYMS_PER_KEYCODE,
  MODIFIER_MAP, fillKeysymRange,
} from './keyboard.js';

// Opcodes per Xproto.h.
const OP = {
  CreateWindow: 1,
  ChangeWindowAttributes: 2,
  MapWindow: 8,
  UnmapWindow: 10,
  GetGeometry: 14,
  GetWindowAttributes: 3,
  DestroyWindow: 4,
  DestroySubwindows: 5,
  ReparentWindow: 7,
  MapSubwindows: 9,
  UnmapSubwindows: 11,
  QueryTree: 15,
  InternAtom: 16,
  GetAtomName: 17,
  ChangeProperty: 18,
  DeleteProperty: 19,
  GetProperty: 20,
  ListProperties: 21,
  GetSelectionOwner: 23,
  GrabServer: 36,
  UngrabServer: 37,
  SendEvent: 25,
  ConvertSelection: 24,
  SetSelectionOwner: 22,
  GrabPointer: 26,
  UngrabPointer: 27,
  GrabButton: 28,
  UngrabButton: 29,
  ChangeActivePointerGrab: 30,
  GrabKeyboard: 31,
  UngrabKeyboard: 32,
  GrabKey: 33,
  UngrabKey: 34,
  ConfigureWindow: 12,
  TranslateCoordinates: 40,
  OpenFont: 45,
  CloseFont: 46,
  QueryFont: 47,
  QueryTextExtents: 48,
  ListFonts: 49,
  ListFontsWithInfo: 50,
  SetFontPath: 51,
  GetFontPath: 52,
  QueryPointer: 38,
  SetInputFocus: 42,
  GetInputFocus: 43,
  QueryKeymap: 44,
  CreatePixmap: 53,
  FreePixmap: 54,
  CreateGC: 55,
  ChangeGC: 56,
  CopyGC: 57,
  SetDashes: 58,
  SetClipRectangles: 59,
  FreeGC: 60,
  ClearArea: 61,
  CopyArea: 62,
  CopyPlane: 63,
  PolyPoint: 64,
  PolyLine: 65,
  PolySegment: 66,
  PolyRectangle: 67,
  PolyArc: 68,
  FillPoly: 69,
  PolyFillRectangle: 70,
  PolyFillArc: 71,
  PutImage: 72,
  PolyText8: 74,
  PolyText16: 75,
  ImageText8: 76,
  ImageText16: 77,
  CreateColormap: 78,
  FreeColormap: 79,
  CopyColormapAndFree: 80,
  InstallColormap: 81,
  UninstallColormap: 82,
  ListInstalledColormaps: 83,
  AllocColor: 84,
  AllocNamedColor: 85,
  AllocColorCells: 86,
  AllocColorPlanes: 87,
  FreeColors: 88,
  StoreColors: 89,
  StoreNamedColor: 90,
  QueryColors: 91,
  LookupColor: 92,
  CreateCursor: 93,
  CreateGlyphCursor: 94,
  FreeCursor: 95,
  RecolorCursor: 96,
  QueryBestSize: 97,
  QueryExtension: 98,
  ListExtensions: 99,
  GetKeyboardMapping: 101,
  ChangeKeyboardControl: 102,
  GetKeyboardControl: 103,
  Bell: 104,
  ChangePointerControl: 105,
  GetPointerControl: 106,
  SetScreenSaver: 107,
  GetScreenSaver: 108,
  ChangeHosts: 109,
  ListHosts: 110,
  SetAccessControl: 111,
  SetCloseDownMode: 112,
  KillClient: 113,
  RotateProperties: 114,
  ForceScreenSaver: 115,
  GetPointerMapping: 117,
  GetModifierMapping: 119,
  NoOperation: 127,
} as const;

export interface RequestContext {
  clientId: number;
  opcode: number;
  requestData: number;
  sequence: number;
  littleEndian: boolean;
  bytes: Uint8Array;
  bodyOffset: number;
  windows: Map<number, Window>;
  pixmaps: Map<number, Pixmap>;
  gcs: Map<number, GC>;
  cursors: Map<number, Cursor>;
  render: RenderState;
  rootWindowId: number;
  renderer: Renderer;
  send: (bytes: Uint8Array) => void;
  sendTo: (clientId: number, bytes: Uint8Array) => void;
  /** Get sequence/byte-order for an arbitrary client — needed to address
   *  events at clients other than the request's originator. */
  clientInfo: (clientId: number) => { sequence: number; littleEndian: boolean } | undefined;
  setActiveGrab: (grab: PointerGrab | undefined) => void;
  getActiveGrab: () => PointerGrab | undefined;
  pointerX: number;
  pointerY: number;
  buttonState: number;
}

function reqView(ctx: RequestContext): DataView {
  return new DataView(ctx.bytes.buffer, ctx.bytes.byteOffset, ctx.bytes.byteLength);
}

function makeReply(ctx: RequestContext, data: number, build: (w: Writer) => void): Uint8Array {
  const w = new Writer(64, ctx.littleEndian);
  w.card8(1);
  w.card8(data);
  w.card16(ctx.sequence);
  w.card32(0);                       // length placeholder
  const startSlot = w.offset;
  build(w);
  while (w.offset - startSlot < 24) w.pad(1);
  const out = w.finish();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(4, Math.max(0, (out.byteLength - 32) / 4), ctx.littleEndian);
  return out;
}

// --- atoms -----------------------------------------------------------------

const atoms = new Map<string, number>();
const atomNames = new Map<number, string>();
let nextAtom = 1;
const PREDEFINED = [
  'PRIMARY', 'SECONDARY', 'ARC', 'ATOM', 'BITMAP', 'CARDINAL', 'COLORMAP',
  'CURSOR', 'CUT_BUFFER0', 'CUT_BUFFER1', 'CUT_BUFFER2', 'CUT_BUFFER3',
  'CUT_BUFFER4', 'CUT_BUFFER5', 'CUT_BUFFER6', 'CUT_BUFFER7', 'DRAWABLE',
  'FONT', 'INTEGER', 'PIXMAP', 'POINT', 'RECTANGLE', 'RESOURCE_MANAGER',
  'RGB_COLOR_MAP', 'RGB_BEST_MAP', 'RGB_BLUE_MAP', 'RGB_DEFAULT_MAP',
  'RGB_GRAY_MAP', 'RGB_GREEN_MAP', 'RGB_RED_MAP', 'STRING', 'VISUALID',
  'WINDOW', 'WM_COMMAND', 'WM_HINTS', 'WM_CLIENT_MACHINE', 'WM_ICON_NAME',
  'WM_ICON_SIZE', 'WM_NAME', 'WM_NORMAL_HINTS', 'WM_SIZE_HINTS',
  'WM_ZOOM_HINTS', 'MIN_SPACE', 'NORM_SPACE', 'MAX_SPACE', 'END_SPACE',
  'SUPERSCRIPT_X', 'SUPERSCRIPT_Y', 'SUBSCRIPT_X', 'SUBSCRIPT_Y',
  'UNDERLINE_POSITION', 'UNDERLINE_THICKNESS', 'STRIKEOUT_ASCENT',
  'STRIKEOUT_DESCENT', 'ITALIC_ANGLE', 'X_HEIGHT', 'QUAD_WIDTH',
  'WEIGHT', 'POINT_SIZE', 'RESOLUTION', 'COPYRIGHT', 'NOTICE', 'FONT_NAME',
  'FAMILY_NAME', 'FULL_NAME', 'CAP_HEIGHT', 'WM_CLASS', 'WM_TRANSIENT_FOR',
];
for (const n of PREDEFINED) { atoms.set(n, nextAtom); atomNames.set(nextAtom, n); nextAtom++; }

function internAtom(name: string, onlyIfExists: boolean): number {
  const existing = atoms.get(name);
  if (existing) return existing;
  if (onlyIfExists) return 0;
  const id = nextAtom++;
  atoms.set(name, id);
  atomNames.set(id, name);
  return id;
}

// --- dispatch --------------------------------------------------------------

export function handleRequest(ctx: RequestContext) {
  if ((globalThis as any).__x11trace) console.log(`[op ${ctx.opcode}] len=${ctx.bytes.byteLength}`);
  switch (ctx.opcode) {
    case OP.CreateWindow: return onCreateWindow(ctx);
    case OP.ChangeWindowAttributes: return onChangeWindowAttributes(ctx);
    case OP.GetWindowAttributes: return onGetWindowAttributes(ctx);
    case OP.DestroyWindow: return onDestroyWindow(ctx);
    case OP.DestroySubwindows: return;
    case OP.ReparentWindow: return onReparentWindow(ctx);
    case OP.MapWindow: return onMapWindow(ctx);
    case OP.MapSubwindows: return onMapSubwindows(ctx);
    case OP.UnmapSubwindows: return onUnmapSubwindows(ctx);
    case OP.UnmapWindow: return onUnmapWindow(ctx);
    case OP.QueryTree: return onQueryTree(ctx);
    case OP.GetGeometry: return onGetGeometry(ctx);
    case OP.InternAtom: return onInternAtom(ctx);
    case OP.GetAtomName: return onGetAtomName(ctx);
    case OP.ChangeProperty: return onChangeProperty(ctx);
    case OP.DeleteProperty: return onDeleteProperty(ctx);
    case OP.GetProperty: return onGetProperty(ctx);
    case OP.ListProperties: return onListProperties(ctx);
    case OP.GetSelectionOwner: return onGetSelectionOwner(ctx);
    case OP.GrabServer: case OP.UngrabServer: return;
    case OP.SendEvent: return onSendEvent(ctx);
    case OP.ConvertSelection: return;
    case OP.SetSelectionOwner: return onSetSelectionOwner(ctx);
    case OP.GrabPointer: return onGrabPointer(ctx);
    case OP.UngrabPointer: return onUngrabPointer(ctx);
    case OP.GrabButton: return; // passive grab; treated as no-op for now
    case OP.UngrabButton: return;
    case OP.GrabKeyboard: return onGrabKeyboard(ctx);
    case OP.UngrabKeyboard: return;
    case OP.GrabKey: return; // passive key grab
    case OP.UngrabKey: return;
    case OP.ChangeActivePointerGrab: return; // no-op
    case OP.ConfigureWindow: return onConfigureWindow(ctx);
    case OP.TranslateCoordinates: return onTranslateCoordinates(ctx);
    case OP.OpenFont: case OP.CloseFont: case OP.SetFontPath: return;
    case OP.QueryFont: return onQueryFont(ctx);
    case OP.QueryTextExtents: return onQueryTextExtents(ctx);
    case OP.ListFonts: return onListFonts(ctx);
    case OP.ListFontsWithInfo: return onListFonts(ctx); // simpler: same as ListFonts
    case OP.GetFontPath: return onGetFontPath(ctx);
    case OP.QueryPointer: return onQueryPointer(ctx);
    case OP.SetInputFocus: return; // accept silently
    case OP.GetInputFocus: return onGetInputFocus(ctx);
    case OP.QueryKeymap: return onQueryKeymap(ctx);
    case OP.CreatePixmap: return onCreatePixmap(ctx);
    case OP.FreePixmap: return onFreePixmap(ctx);
    case OP.CreateGC: return onCreateGC(ctx);
    case OP.ChangeGC: return onChangeGC(ctx);
    case OP.CopyGC: return onCopyGC(ctx);
    case OP.SetDashes: case OP.SetClipRectangles: return;
    case OP.FreeGC: return onFreeGC(ctx);
    case OP.ClearArea: return onClearArea(ctx);
    case OP.CopyArea: return onCopyArea(ctx);
    case OP.CopyPlane: return onCopyPlane(ctx);
    case OP.PolyPoint: return onPolyPoint(ctx);
    case OP.PolyLine: return onPolyLine(ctx);
    case OP.PolySegment: return onPolySegment(ctx);
    case OP.PolyRectangle: return onPolyRectangle(ctx);
    case OP.PolyArc: return onPolyArc(ctx);
    case OP.FillPoly: return onFillPoly(ctx);
    case OP.PolyFillRectangle: return onPolyFillRectangle(ctx);
    case OP.PolyFillArc: return onPolyFillArc(ctx);
    case OP.PutImage: return onPutImage(ctx);
    case OP.ImageText8: return onImageText8(ctx);
    case OP.PolyText8: return onPolyText8(ctx);
    case OP.ImageText16: case OP.PolyText16: return; // wide chars not yet
    case OP.CreateColormap: case OP.FreeColormap: case OP.CopyColormapAndFree:
    case OP.InstallColormap: case OP.UninstallColormap: case OP.FreeColors:
    case OP.StoreColors: case OP.StoreNamedColor:
      return; // no-ops — non-trivial colormaps
    case OP.CreateCursor: return onCreateCursor(ctx);
    case OP.CreateGlyphCursor: return onCreateGlyphCursor(ctx);
    case OP.FreeCursor: return onFreeCursor(ctx);
    case OP.RecolorCursor: return onRecolorCursor(ctx);
    case OP.ListInstalledColormaps: return onListInstalledColormaps(ctx);
    case OP.AllocColor: return onAllocColor(ctx);
    case OP.AllocNamedColor: return onAllocNamedColor(ctx);
    case OP.AllocColorCells: return onAllocColorCells(ctx);
    case OP.AllocColorPlanes: return onAllocColorPlanes(ctx);
    case OP.QueryColors: return onQueryColors(ctx);
    case OP.LookupColor: return onLookupColor(ctx);
    case OP.QueryBestSize: return onQueryBestSize(ctx);
    case OP.QueryExtension: return onQueryExtension(ctx);
    case OP.ListExtensions: return onListExtensions(ctx);
    case OP.GetKeyboardMapping: return onGetKeyboardMapping(ctx);
    case OP.ChangeKeyboardControl: return;            // auto-repeat / LED no-ops
    case OP.GetKeyboardControl: return onGetKeyboardControl(ctx);
    case OP.Bell: return;                             // ding! (no audio yet)
    case OP.ChangePointerControl: return;             // accel/threshold no-ops
    case OP.GetPointerControl: return onGetPointerControl(ctx);
    case OP.SetScreenSaver: return;
    case OP.GetScreenSaver: return onGetScreenSaver(ctx);
    case OP.ChangeHosts: case OP.SetAccessControl: case OP.ForceScreenSaver:
    case OP.SetCloseDownMode: case OP.KillClient: case OP.RotateProperties: return;
    case OP.ListHosts: return onListHosts(ctx);
    case OP.GetPointerMapping: return onGetPointerMapping(ctx);
    case OP.GetModifierMapping: return onGetModifierMapping(ctx);
    case OP.NoOperation: return;
    default:
      if (ctx.opcode === RENDER_MAJOR_OPCODE) return dispatchRender(ctx);
      if (ctx.opcode === XINPUT_MAJOR_OPCODE) return handleXInput2Request({
        bytes: ctx.bytes, littleEndian: ctx.littleEndian, sequence: ctx.sequence, send: ctx.send,
        rootWindowId: ctx.rootWindowId, pointerX: ctx.pointerX, pointerY: ctx.pointerY,
        buttonState: ctx.buttonState,
      });
      if (ctx.opcode === XKB_MAJOR_OPCODE) return handleXkbRequest({
        bytes: ctx.bytes, littleEndian: ctx.littleEndian, sequence: ctx.sequence, send: ctx.send,
      });
      if (ctx.opcode === RANDR_MAJOR_OPCODE) return handleRandrRequest({
        bytes: ctx.bytes, littleEndian: ctx.littleEndian, sequence: ctx.sequence, send: ctx.send,
        rootWindowId: ctx.rootWindowId,
      });
      if (ctx.opcode === MITSHM_MAJOR_OPCODE) return handleMitShmRequest({
        bytes: ctx.bytes, littleEndian: ctx.littleEndian, sequence: ctx.sequence, send: ctx.send,
      });
      if (ctx.opcode === SHAPE_MAJOR_OPCODE) return handleShapeRequest({
        bytes: ctx.bytes, littleEndian: ctx.littleEndian, sequence: ctx.sequence, send: ctx.send,
      });
      console.warn(`[client ${ctx.clientId}] unhandled opcode ${ctx.opcode} len=${ctx.bytes.byteLength}`);
  }
}

function dispatchRender(ctx: RequestContext) {
  handleRenderRequest({
    bytes: ctx.bytes,
    littleEndian: ctx.littleEndian,
    sequence: ctx.sequence,
    clientId: ctx.clientId,
    send: ctx.send,
    getDrawable: (id) => getDrawable(ctx, id),
    invalidate: () => ctx.renderer.invalidate(),
    render: ctx.render,
  });
}

// --- window / property -----------------------------------------------------

// CW value-mask bits per X11 spec. We store a handful of them.
// `requester` is the clientId asking — used for SubstructureRedirect/Notify
// attribution so window-manager redirects target the right client.
function applyWindowValueMask(
  v: DataView, le: boolean, off: number, mask: number, win: Window, requester: number,
) {
  let p = off;
  for (let i = 0; i < 15; i++) {
    if (!(mask & (1 << i))) continue;
    const val = v.getUint32(p, le);
    p += 4;
    switch (i) {
      case 1:  win.backgroundPixel = val; break;   // CWBackPixel
      case 9:  win.overrideRedirect = val !== 0; break; // CWOverrideRedirect
      case 11: {
        win.eventMask = val;
        // Track who selected SubstructureRedirect / SubstructureNotify so
        // we can redirect their events and notify the right client.
        if (val & EVENT_MASK.SubstructureRedirect) {
          win.substructureRedirectClient = requester;
        } else if (win.substructureRedirectClient === requester) {
          win.substructureRedirectClient = undefined;
        }
        if (val & EVENT_MASK.SubstructureNotify) {
          win.substructureNotifyClient = requester;
        } else if (win.substructureNotifyClient === requester) {
          win.substructureNotifyClient = undefined;
        }
        break;
      }
      case 14: win.cursor = val; break;            // CWCursor
      default: break;
    }
  }
}

// Monotonically incrementing — every newly created or raised window grabs
// a fresh value, so it lands above prior siblings when the renderer sorts.
// Lowering pushes below all known values by decrementing below the floor.
let nextStackOrder = 1;
let lowestStackOrder = 0;

function onCreateWindow(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const wid = v.getUint32(4, le);
  const parent = v.getUint32(8, le);
  const x = v.getInt16(12, le);
  const y = v.getInt16(14, le);
  const width = v.getUint16(16, le);
  const height = v.getUint16(18, le);
  const valueMask = v.getUint32(28, le);

  const win = new Window(wid, parent, x, y, width, height, 0);
  win.owner = ctx.clientId;
  win.stackOrder = nextStackOrder++;
  applyWindowValueMask(v, le, 32, valueMask, win, ctx.clientId);
  win.paintBackground(0, 0, width, height);
  ctx.windows.set(wid, win);
  console.log(`[CreateWindow] id=${wid} parent=${parent} ${width}x${height}+${x}+${y} bg=0x${win.backgroundPixel.toString(16).padStart(8, '0')} mask=0x${win.eventMask.toString(16)}`);

  // Notify the substructure-notify subscriber on the parent (typically the WM).
  const parentWin = ctx.windows.get(parent);
  if (parentWin?.substructureNotifyClient !== undefined) {
    sendCreateNotify(ctx, parentWin.substructureNotifyClient, parent, win);
  }
}

function onChangeWindowAttributes(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const wid = v.getUint32(4, le);
  const valueMask = v.getUint32(8, le);
  const win = ctx.windows.get(wid);
  if (!win) return;
  applyWindowValueMask(v, le, 12, valueMask, win, ctx.clientId);
}

function emitEvent(ctx: RequestContext, target: number, type: number, seqOverride: number | null, build: (w: Writer) => void) {
  const info = ctx.clientInfo(target);
  if (!info) return;
  const w = new Writer(32, info.littleEndian);
  w.card8(type);
  w.card8(0);
  w.card16(seqOverride ?? info.sequence);
  build(w);
  while (w.offset < 32) w.pad(1);
  ctx.sendTo(target, w.finish());
}

function sendExpose(ctx: RequestContext, win: Window) {
  // Expose goes to the window's owner — use that client's seq/byte-order.
  emitEvent(ctx, win.owner, 12, null, (w) => {
    w.card32(win.id);
    w.card16(0); w.card16(0);
    w.card16(win.width); w.card16(win.height);
    w.card16(0);
    w.pad(14);
  });
}

function sendMapRequest(ctx: RequestContext, targetClient: number, parent: number, window: number) {
  emitEvent(ctx, targetClient, 20, null, (w) => {
    w.card32(parent);
    w.card32(window);
    w.pad(20);
  });
}

function sendMapNotify(ctx: RequestContext, targetClient: number, eventWindow: number, mappedWindow: number, overrideRedirect: boolean) {
  emitEvent(ctx, targetClient, 19, null, (w) => {
    w.card32(eventWindow);
    w.card32(mappedWindow);
    w.card8(overrideRedirect ? 1 : 0);
    w.pad(19);
  });
}

function sendUnmapNotify(ctx: RequestContext, targetClient: number, eventWindow: number, unmappedWindow: number) {
  emitEvent(ctx, targetClient, 18, null, (w) => {
    w.card32(eventWindow);
    w.card32(unmappedWindow);
    w.card8(0);
    w.pad(19);
  });
}

function sendReparentNotify(ctx: RequestContext, targetClient: number, eventWindow: number, window: number, parent: number, x: number, y: number, overrideRedirect: boolean) {
  emitEvent(ctx, targetClient, 21, null, (w) => {
    w.card32(eventWindow);
    w.card32(window);
    w.card32(parent);
    w.int16(x); w.int16(y);
    w.card8(overrideRedirect ? 1 : 0);
    w.pad(11);
  });
}

function sendCreateNotify(ctx: RequestContext, targetClient: number, parent: number, win: Window) {
  emitEvent(ctx, targetClient, 16, null, (w) => {
    w.card32(parent);
    w.card32(win.id);
    w.int16(win.x); w.int16(win.y);
    w.card16(win.width); w.card16(win.height);
    w.card16(0);
    w.card8(win.overrideRedirect ? 1 : 0);
    w.pad(9);
  });
}

function sendDestroyNotify(ctx: RequestContext, targetClient: number, eventWindow: number, window: number) {
  emitEvent(ctx, targetClient, 17, null, (w) => {
    w.card32(eventWindow);
    w.card32(window);
    w.pad(20);
  });
}

function sendConfigureRequest(ctx: RequestContext, targetClient: number, parent: number, win: Window, sibling: number, stackMode: number, valueMask: number, requested: { x: number; y: number; width: number; height: number; borderWidth: number }) {
  // ConfigureRequest uses the `detail` byte for stack-mode, not 0.
  const info = ctx.clientInfo(targetClient);
  if (!info) return;
  const w = new Writer(32, info.littleEndian);
  w.card8(23);
  w.card8(stackMode);
  w.card16(info.sequence);
  w.card32(parent);
  w.card32(win.id);
  w.card32(sibling);
  w.int16(requested.x); w.int16(requested.y);
  w.card16(requested.width); w.card16(requested.height);
  w.card16(requested.borderWidth);
  w.card16(valueMask);
  w.pad(4);
  ctx.sendTo(targetClient, w.finish());
}

function sendConfigureNotify(ctx: RequestContext, targetClient: number, eventWindow: number, win: Window) {
  emitEvent(ctx, targetClient, 22, null, (w) => {
    w.card32(eventWindow);
    w.card32(win.id);
    w.card32(0);
    w.int16(win.x); w.int16(win.y);
    w.card16(win.width); w.card16(win.height);
    w.card16(0);
    w.card8(win.overrideRedirect ? 1 : 0);
    w.pad(5);
  });
}

function mapOne(ctx: RequestContext, win: Window) {
  if (win.mapped) return;
  win.mapped = true;
  // Newly mapped windows surface above their siblings (matches what most X
  // servers do, and what twm relies on for raise-on-map).
  win.stackOrder = nextStackOrder++;
  ctx.renderer.upsertWindow(win);
  // StructureNotify on the window itself: the owning client wants MapNotify.
  // Many toolkits (Xaw/Motif) gate first-paint on this; Expose alone isn't
  // enough — without MapNotify they show only the title bar until something
  // (e.g. a move) forces a fresh notify cycle.
  if (win.eventMask & EVENT_MASK.StructureNotify) {
    sendMapNotify(ctx, win.owner, win.id, win.id, win.overrideRedirect);
  }
  const parent = ctx.windows.get(win.parent);
  if (parent?.substructureNotifyClient !== undefined &&
      parent.substructureNotifyClient !== win.owner) {
    sendMapNotify(ctx, parent.substructureNotifyClient, parent.id, win.id, win.overrideRedirect);
  }
  sendExpose(ctx, win);
  console.log(`[MapWindow] id=${win.id}`);
}

function onMapWindow(ctx: RequestContext) {
  const wid = reqView(ctx).getUint32(4, ctx.littleEndian);
  const win = ctx.windows.get(wid);
  if (!win) return;
  // Redirect to the window manager if applicable.
  const parent = ctx.windows.get(win.parent);
  if (parent?.substructureRedirectClient !== undefined &&
      parent.substructureRedirectClient !== ctx.clientId &&
      !win.overrideRedirect) {
    sendMapRequest(ctx, parent.substructureRedirectClient, parent.id, wid);
    return;
  }
  mapOne(ctx, win);
}

function onMapSubwindows(ctx: RequestContext) {
  const parent = reqView(ctx).getUint32(4, ctx.littleEndian);
  for (const win of ctx.windows.values()) {
    if (win.parent === parent) mapOne(ctx, win);
  }
}

function onUnmapWindow(ctx: RequestContext) {
  const wid = reqView(ctx).getUint32(4, ctx.littleEndian);
  const win = ctx.windows.get(wid);
  if (!win || !win.mapped) return;
  win.mapped = false;
  ctx.renderer.invalidate();
  if (win.eventMask & EVENT_MASK.StructureNotify) {
    sendUnmapNotify(ctx, win.owner, win.id, win.id);
  }
  const parent = ctx.windows.get(win.parent);
  if (parent?.substructureNotifyClient !== undefined &&
      parent.substructureNotifyClient !== win.owner) {
    sendUnmapNotify(ctx, parent.substructureNotifyClient, parent.id, win.id);
  }
}

function onUnmapSubwindows(ctx: RequestContext) {
  const parent = reqView(ctx).getUint32(4, ctx.littleEndian);
  for (const win of ctx.windows.values()) {
    if (win.parent === parent && win.mapped) {
      win.mapped = false;
    }
  }
  ctx.renderer.invalidate();
}

function onGetGeometry(ctx: RequestContext) {
  const drawable = reqView(ctx).getUint32(4, ctx.littleEndian);
  let x = 0, y = 0, width = 1024, height = 768;
  if (drawable !== ctx.rootWindowId) {
    const win = ctx.windows.get(drawable);
    if (win) { x = win.x; y = win.y; width = win.width; height = win.height; }
  }
  ctx.send(makeReply(ctx, 24, (w) => {
    w.card32(ctx.rootWindowId);
    w.int16(x); w.int16(y);
    w.card16(width); w.card16(height);
    w.card16(0);
    w.pad(10);
  }));
}

function onInternAtom(ctx: RequestContext) {
  const v = reqView(ctx);
  const onlyIfExists = ctx.requestData !== 0;
  const nameLen = v.getUint16(4, ctx.littleEndian);
  const name = new TextDecoder('latin1').decode(ctx.bytes.subarray(8, 8 + nameLen));
  const atom = internAtom(name, onlyIfExists);
  ctx.send(makeReply(ctx, 0, (w) => { w.card32(atom); w.pad(20); }));
}

function onGetAtomName(ctx: RequestContext) {
  const atom = reqView(ctx).getUint32(4, ctx.littleEndian);
  const name = atomNames.get(atom) ?? '';
  const bytes = new TextEncoder().encode(name);
  const padded = (bytes.byteLength + 3) & ~3;
  const w = new Writer(32 + padded, ctx.littleEndian);
  w.card8(1); w.card8(0);
  w.card16(ctx.sequence);
  w.card32(padded / 4);
  w.card16(bytes.byteLength);
  w.pad(22);
  w.bytes(bytes);
  w.padTo(4);
  ctx.send(w.finish());
}

function onChangeProperty(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const mode = ctx.requestData;                    // 0=Replace, 1=Prepend, 2=Append
  const wid = v.getUint32(4, le);
  const property = v.getUint32(8, le);
  const type = v.getUint32(12, le);
  const format = v.getUint8(16) as 8 | 16 | 32;
  const dataLen = v.getUint32(20, le);             // count of format-units
  const win = ctx.windows.get(wid);
  if (!win) return;
  const bytesPerUnit = format / 8;
  const totalBytes = dataLen * bytesPerUnit;
  const incoming = ctx.bytes.slice(24, 24 + totalBytes);

  const existing = win.properties.get(property);
  if (mode === 0 || !existing) {
    win.properties.set(property, { type, format, data: incoming });
  } else if (existing.type !== type || existing.format !== format) {
    // Spec says BadMatch; for now just replace.
    win.properties.set(property, { type, format, data: incoming });
  } else {
    const merged = new Uint8Array(existing.data.byteLength + incoming.byteLength);
    if (mode === 1) {
      merged.set(incoming, 0);
      merged.set(existing.data, incoming.byteLength);
    } else {
      merged.set(existing.data, 0);
      merged.set(incoming, existing.data.byteLength);
    }
    win.properties.set(property, { type, format, data: merged });
  }
  // PropertyNotify — fvwm and ICCCM-aware apps use property changes as a
  // wake-up mechanism. Without this event, fvwm sits in initialization
  // forever waiting on its own anchor window's property change.
  if (win.eventMask & EVENT_MASK.PropertyChange) {
    sendPropertyNotify(ctx, win.owner, win.id, property, 0 /* state=NewValue */);
  }
}

function sendPropertyNotify(ctx: RequestContext, target: number, window: number, atom: number, state: number) {
  emitEvent(ctx, target, 28 /* PropertyNotify */, null, (w) => {
    w.card32(window);
    w.card32(atom);
    w.card32(Date.now() & 0xffffffff);
    w.card8(state);
    w.pad(15);
  });
}

function onDeleteProperty(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const wid = v.getUint32(4, le);
  const property = v.getUint32(8, le);
  const win = ctx.windows.get(wid);
  if (!win) return;
  const had = win.properties.delete(property);
  if (had && (win.eventMask & EVENT_MASK.PropertyChange)) {
    sendPropertyNotify(ctx, win.owner, win.id, property, 1 /* state=Deleted */);
  }
}

function emptyPropertyReply(ctx: RequestContext): Uint8Array {
  return makeReply(ctx, 0, (w) => {
    w.card32(0); w.card32(0); w.card32(0); w.pad(12);
  });
}

function onGetProperty(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const deleteFlag = ctx.requestData;
  const wid = v.getUint32(4, le);
  const property = v.getUint32(8, le);
  const reqType = v.getUint32(12, le);             // 0 = AnyPropertyType
  const longOffset = v.getUint32(16, le);          // in 4-byte units
  const longLength = v.getUint32(20, le);          // in 4-byte units

  const win = ctx.windows.get(wid);
  const prop = win?.properties.get(property);
  if (!prop) { ctx.send(emptyPropertyReply(ctx)); return; }

  if (reqType !== 0 && reqType !== prop.type) {
    // Type mismatch: report actual type but no data.
    ctx.send(makeReply(ctx, prop.format, (w) => {
      w.card32(prop.type);
      w.card32(prop.data.byteLength);             // bytes-after
      w.card32(0);
      w.pad(12);
    }));
    return;
  }

  const offsetBytes = Math.min(longOffset * 4, prop.data.byteLength);
  let lengthBytes = longLength * 4;
  if (offsetBytes + lengthBytes > prop.data.byteLength) {
    lengthBytes = prop.data.byteLength - offsetBytes;
  }
  const slice = prop.data.subarray(offsetBytes, offsetBytes + lengthBytes);
  const bytesAfter = prop.data.byteLength - (offsetBytes + lengthBytes);
  const formatUnits = lengthBytes / (prop.format / 8);

  if (deleteFlag && bytesAfter === 0 && win) win.properties.delete(property);

  const padded = (slice.byteLength + 3) & ~3;
  const w = new Writer(32 + padded, ctx.littleEndian);
  w.card8(1); w.card8(prop.format);
  w.card16(ctx.sequence);
  w.card32(padded / 4);
  w.card32(prop.type);
  w.card32(bytesAfter);
  w.card32(formatUnits);
  w.pad(12);
  w.bytes(slice);
  w.padTo(4);
  ctx.send(w.finish());
}

function onListProperties(ctx: RequestContext) {
  const wid = reqView(ctx).getUint32(4, ctx.littleEndian);
  const win = ctx.windows.get(wid);
  const atoms = win ? Array.from(win.properties.keys()) : [];
  const w = new Writer(32 + atoms.length * 4, ctx.littleEndian);
  w.card8(1); w.card8(0);
  w.card16(ctx.sequence);
  w.card32(atoms.length);
  w.card16(atoms.length);
  w.pad(22);
  for (const a of atoms) w.card32(a);
  ctx.send(w.finish());
}

function onDestroyWindow(ctx: RequestContext) {
  const wid = reqView(ctx).getUint32(4, ctx.littleEndian);
  const win = ctx.windows.get(wid);
  if (!win) return;
  const parent = ctx.windows.get(win.parent);
  ctx.windows.delete(wid);
  ctx.renderer.removeWindow(wid);
  if (parent?.substructureNotifyClient !== undefined) {
    sendDestroyNotify(ctx, parent.substructureNotifyClient, parent.id, wid);
  }
}

// selection-atom → owner window-id. fvwm (and ICCCM-aware WMs) use this to
// claim _NET_WM_Sn / WM_Sn etc. After SetSelectionOwner they round-trip
// through GetSelectionOwner and bail if the readback doesn't match.
const selectionOwners = new Map<number, number>();

function onSetSelectionOwner(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const owner = v.getUint32(4, le);
  const selection = v.getUint32(8, le);
  // Time field at byte 12 is informational; we don't gate ownership by it.
  const prev = selectionOwners.get(selection) ?? 0;
  if (owner === 0) selectionOwners.delete(selection);
  else selectionOwners.set(selection, owner);
  // Notify the previous owner that it lost the selection (SelectionClear).
  if (prev !== 0 && prev !== owner) {
    const prevWin = ctx.windows.get(prev);
    if (prevWin) {
      emitEvent(ctx, prevWin.owner, 29 /* SelectionClear */, null, (w) => {
        w.card32(Date.now() & 0xffffffff);
        w.card32(prev);
        w.card32(selection);
        w.pad(16);
      });
    }
  }
}

function onGetSelectionOwner(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const selection = v.getUint32(4, le);
  const owner = selectionOwners.get(selection) ?? 0;
  ctx.send(makeReply(ctx, 0, (w) => { w.card32(owner); w.pad(20); }));
}

function onQueryPointer(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const wid = v.getUint32(4, le);
  // win-x/win-y must be cursor coords relative to the queried window's
  // *screen* position, not its parent-relative position. Apps (xeyes is the
  // classic example) call XQueryPointer on their own window to find where
  // the cursor is relative to themselves; using parent-relative breaks them
  // after any reparenting.
  const sp = screenPosOf(ctx, wid);
  const winX = ctx.pointerX - sp.x;
  const winY = ctx.pointerY - sp.y;
  ctx.send(makeReply(ctx, 1, (w) => {
    w.card32(ctx.rootWindowId);
    w.card32(0);                       // child = None
    w.int16(ctx.pointerX); w.int16(ctx.pointerY);
    w.int16(winX); w.int16(winY);
    w.card16(ctx.buttonState & 0xffff);
    w.pad(6);
  }));
}

function onGetInputFocus(ctx: RequestContext) {
  ctx.send(makeReply(ctx, 0, (w) => { w.card32(ctx.rootWindowId); w.pad(20); }));
}

function onQueryKeymap(ctx: RequestContext) {
  ctx.send(makeReply(ctx, 0, (w) => { w.pad(32); }));
}

function onSendEvent(ctx: RequestContext) {
  // SendEvent body: byte 1 = propagate, bytes 4..7 = destination window,
  // bytes 8..11 = event-mask (CARD32), bytes 12..43 = 32-byte event payload.
  // Per spec, eventMask=0 means "deliver to the window-creating client";
  // non-zero means "deliver to every client selecting any of these events".
  // We don't track per-client selections separately. Approximation: only
  // deliver when (eventMask is 0) or (the destination window's eventMask
  // covers some of the requested bits) AND the destination is owned by a
  // *different* client. The same-client case is a no-op because our
  // approximation can't tell whether the sender really meant to receive its
  // own event, and delivering it back has caused crashes (twm).
  const v = reqView(ctx); const le = ctx.littleEndian;
  const destWid = v.getUint32(4, le);
  const eventMask = v.getUint32(8, le);
  if (destWid < 4) return;
  const dest = ctx.windows.get(destWid);
  if (!dest) return;
  if (dest.owner === ctx.clientId) return;
  if (eventMask !== 0 && !(dest.eventMask & eventMask)) return;

  // Copy the 32-byte event and set the "synthetic" high bit on byte 0.
  // Patch the sequence number to the destination client's last sequence
  // so xcb's reply-sequence tracking doesn't get confused.
  const event = new Uint8Array(32);
  for (let i = 0; i < 32; i++) event[i] = ctx.bytes[12 + i] ?? 0;
  event[0] = (event[0] ?? 0) | 0x80;
  const info = ctx.clientInfo(dest.owner);
  if (info) {
    const dv = new DataView(event.buffer);
    dv.setUint16(2, info.sequence & 0xffff, info.littleEndian);
  }
  ctx.sendTo(dest.owner, event);
}

function onGrabPointer(ctx: RequestContext) {
  // body: owner_events (data byte), grab_window (4), event_mask (2),
  //   pointer_mode (1), keyboard_mode (1), confine_to (4), cursor (4), time (4)
  const v = reqView(ctx); const le = ctx.littleEndian;
  const ownerEvents = ctx.requestData !== 0;
  const grabWindow = v.getUint32(4, le);
  const eventMask = v.getUint16(8, le);
  // pointer_mode/keyboard_mode/confine_to/cursor/time are ignored.

  const existing = ctx.getActiveGrab();
  if (existing && existing.client !== ctx.clientId) {
    // Already grabbed by another client. Reply with status=1 (AlreadyGrabbed).
    ctx.send(makeReply(ctx, 1, (w) => { w.pad(24); }));
    return;
  }
  ctx.setActiveGrab({ client: ctx.clientId, window: grabWindow, eventMask, ownerEvents });
  ctx.send(makeReply(ctx, 0 /* Success */, (w) => { w.pad(24); }));
}

function onUngrabPointer(ctx: RequestContext) {
  const grab = ctx.getActiveGrab();
  if (!grab || grab.client !== ctx.clientId) return;
  ctx.setActiveGrab(undefined);
}

function onGrabKeyboard(ctx: RequestContext) {
  // We don't model keyboard grabs separately, but the request has a reply.
  ctx.send(makeReply(ctx, 0, (w) => { w.pad(24); }));
}

// --- graphics contexts -----------------------------------------------------

const GC_DEFAULTS: GC = {
  id: 0, foreground: 0, background: 0xffffff, lineWidth: 0, arcMode: 1,
};

function parseGCValues(v: DataView, le: boolean, off: number, mask: number, gc: GC) {
  // bit 0: function, 1: plane-mask, 2: foreground, 3: background, 4: line-width,
  // … 22: arc-mode. Every value occupies 4 bytes on the wire.
  let p = off;
  for (let i = 0; i < 23; i++) {
    if (!(mask & (1 << i))) continue;
    const val = v.getUint32(p, le);
    p += 4;
    switch (i) {
      case 2: gc.foreground = val; break;
      case 3: gc.background = val; break;
      case 4: gc.lineWidth = val & 0xffff; break;
      case 22: gc.arcMode = val & 0xff; break;
      default: /* ignored for now */ break;
    }
  }
}

function onCreateGC(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const cid = v.getUint32(4, le);
  const valueMask = v.getUint32(12, le);
  const gc: GC = { ...GC_DEFAULTS, id: cid };
  parseGCValues(v, le, 16, valueMask, gc);
  ctx.gcs.set(cid, gc);
}

function onChangeGC(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const cid = v.getUint32(4, le);
  const valueMask = v.getUint32(8, le);
  const gc = ctx.gcs.get(cid);
  if (!gc) return;
  parseGCValues(v, le, 12, valueMask, gc);
}

function onCopyGC(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const src = ctx.gcs.get(v.getUint32(4, le));
  const dstId = v.getUint32(8, le);
  if (!src) return;
  ctx.gcs.set(dstId, { ...src, id: dstId });
}

function onFreeGC(ctx: RequestContext) {
  const cid = reqView(ctx).getUint32(4, ctx.littleEndian);
  ctx.gcs.delete(cid);
}

// --- pixmaps and image transfer --------------------------------------------

function onCreatePixmap(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const depth = ctx.requestData;
  const pid = v.getUint32(4, le);
  // bytes 8..11 is "drawable" used only to pick the screen; ignored.
  const width = v.getUint16(12, le);
  const height = v.getUint16(14, le);
  const px = new Pixmap(pid, width, height, depth);
  px.owner = ctx.clientId;
  ctx.pixmaps.set(pid, px);
}

function onFreePixmap(ctx: RequestContext) {
  const pid = reqView(ctx).getUint32(4, ctx.littleEndian);
  ctx.pixmaps.delete(pid);
}

// --- cursors ---------------------------------------------------------------

/**
 * Build a small RGBA cursor image from a source pixmap, a mask, and fg/bg
 * colors. Source pixel set → fg; source pixel unset → bg. Mask pixel unset
 * → transparent. Approximation: we treat any non-zero source/mask canvas
 * pixel as "bit set".
 */
function buildCursorImage(
  src: Drawable | undefined,
  mask: Drawable | undefined,
  fg: number, bg: number,
  width: number, height: number,
): OffscreenCanvas {
  const out = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  const octx = out.getContext('2d')!;
  const img = octx.createImageData(width, height);
  const od = img.data;
  const fr = (fg >> 16) & 0xff, fgg = (fg >> 8) & 0xff, fb = fg & 0xff;
  const br = (bg >> 16) & 0xff, bgg = (bg >> 8) & 0xff, bb = bg & 0xff;
  const sd = src ? src.ctx.getImageData(0, 0, width, height).data : null;
  const md = mask ? mask.ctx.getImageData(0, 0, width, height).data : null;
  for (let i = 0, n = width * height * 4; i < n; i += 4) {
    const maskBit = md ? ((md[i]! | md[i + 1]! | md[i + 2]!) !== 0 ? 1 : 0) : 1;
    if (!maskBit) { od[i + 3] = 0; continue; }
    const srcBit = sd ? ((sd[i]! | sd[i + 1]! | sd[i + 2]!) !== 0 ? 1 : 0) : 1;
    if (srcBit) { od[i] = fr; od[i + 1] = fgg; od[i + 2] = fb; od[i + 3] = 0xff; }
    else        { od[i] = br; od[i + 1] = bgg; od[i + 2] = bb; od[i + 3] = 0xff; }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/**
 * Build a stylized cursor for a few well-known X cursor-font glyphs. Real X
 * cursor fonts have ~76 glyphs; we cover the half-dozen that toolkits use
 * most. Anything unrecognized falls back to an arrow so the user always
 * gets *some* visible pointer.
 */
function buildGlyphCursor(sourceChar: number, fg: number, bg: number): { canvas: OffscreenCanvas; hx: number; hy: number } {
  const W = 16, H = 16;
  const out = new OffscreenCanvas(W, H);
  const c = out.getContext('2d')!;
  const fgCss = pixelToCss(fg);
  const bgCss = pixelToCss(bg);

  // XC_xterm = 152 (I-beam): vertical bar with serifs at top & bottom
  if (sourceChar === 152) {
    c.strokeStyle = bgCss; c.lineWidth = 3;
    c.beginPath(); c.moveTo(8, 1); c.lineTo(8, 14); c.stroke();
    c.beginPath(); c.moveTo(4, 2); c.lineTo(12, 2); c.stroke();
    c.beginPath(); c.moveTo(4, 13); c.lineTo(12, 13); c.stroke();
    c.strokeStyle = fgCss; c.lineWidth = 1;
    c.beginPath(); c.moveTo(8.5, 1); c.lineTo(8.5, 14); c.stroke();
    c.beginPath(); c.moveTo(4, 2); c.lineTo(12, 2); c.stroke();
    c.beginPath(); c.moveTo(4, 13); c.lineTo(12, 13); c.stroke();
    return { canvas: out, hx: 8, hy: 7 };
  }

  // XC_hand2 / XC_hand1 = 92 / 60: hand silhouette
  if (sourceChar === 60 || sourceChar === 58 || sourceChar === 92) {
    c.fillStyle = bgCss;
    c.fillRect(2, 5, 12, 11);
    c.fillStyle = fgCss;
    c.fillRect(3, 6, 2, 8);
    c.fillRect(5, 2, 2, 12);
    c.fillRect(7, 4, 2, 10);
    c.fillRect(9, 4, 2, 10);
    c.fillRect(11, 6, 2, 8);
    return { canvas: out, hx: 5, hy: 1 };
  }

  // XC_sb_h_double_arrow = 116 (horizontal resize ←→)
  if (sourceChar === 116) {
    c.strokeStyle = bgCss; c.lineWidth = 3;
    c.beginPath(); c.moveTo(1, 8); c.lineTo(15, 8); c.stroke();
    c.strokeStyle = fgCss; c.lineWidth = 1;
    c.beginPath();
    c.moveTo(1, 8); c.lineTo(4, 5); c.moveTo(1, 8); c.lineTo(4, 11);
    c.moveTo(1, 8); c.lineTo(15, 8);
    c.moveTo(15, 8); c.lineTo(12, 5); c.moveTo(15, 8); c.lineTo(12, 11);
    c.stroke();
    return { canvas: out, hx: 8, hy: 8 };
  }

  // XC_sb_v_double_arrow = 114 (vertical resize ↕)
  if (sourceChar === 114) {
    c.strokeStyle = bgCss; c.lineWidth = 3;
    c.beginPath(); c.moveTo(8, 1); c.lineTo(8, 15); c.stroke();
    c.strokeStyle = fgCss; c.lineWidth = 1;
    c.beginPath();
    c.moveTo(8, 1); c.lineTo(5, 4); c.moveTo(8, 1); c.lineTo(11, 4);
    c.moveTo(8, 1); c.lineTo(8, 15);
    c.moveTo(8, 15); c.lineTo(5, 12); c.moveTo(8, 15); c.lineTo(11, 12);
    c.stroke();
    return { canvas: out, hx: 8, hy: 8 };
  }

  // Default: arrow (XC_left_ptr = 68, XC_top_left_arrow = 132, anything else)
  c.fillStyle = bgCss;
  c.beginPath();
  c.moveTo(0, 0); c.lineTo(0, 13); c.lineTo(4, 9); c.lineTo(7, 14); c.lineTo(9, 13); c.lineTo(6, 8); c.lineTo(11, 8); c.closePath();
  c.fill();
  c.fillStyle = fgCss;
  c.beginPath();
  c.moveTo(1, 1); c.lineTo(1, 11); c.lineTo(4, 8); c.lineTo(7, 13); c.lineTo(8, 12); c.lineTo(5, 7); c.lineTo(9, 7); c.closePath();
  c.fill();
  return { canvas: out, hx: 1, hy: 1 };
}

function pixelFromGcRGB(r: number, g: number, b: number): number {
  // X spec: r/g/b are CARD16 (0..65535). Truncate to 8 bits.
  return ((r >> 8) << 16) | ((g >> 8) << 8) | (b >> 8);
}

function onCreateCursor(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const cid = v.getUint32(4, le);
  const sourceId = v.getUint32(8, le);
  const maskId = v.getUint32(12, le);
  const fg = pixelFromGcRGB(v.getUint16(16, le), v.getUint16(18, le), v.getUint16(20, le));
  const bg = pixelFromGcRGB(v.getUint16(22, le), v.getUint16(24, le), v.getUint16(26, le));
  const hx = v.getUint16(28, le);
  const hy = v.getUint16(30, le);
  const src = ctx.pixmaps.get(sourceId);
  const mask = maskId ? ctx.pixmaps.get(maskId) : undefined;
  if (!src) return;
  const image = buildCursorImage(src, mask, fg, bg, src.width, src.height);
  ctx.cursors.set(cid, { id: cid, image, hotspotX: hx, hotspotY: hy });
}

function onCreateGlyphCursor(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const cid = v.getUint32(4, le);
  // bytes 8..15 are source/mask font IDs — ignored, we use built-in shapes
  const sourceChar = v.getUint16(16, le);
  // mask-char at byte 18 — also ignored
  const fg = pixelFromGcRGB(v.getUint16(20, le), v.getUint16(22, le), v.getUint16(24, le));
  const bg = pixelFromGcRGB(v.getUint16(26, le), v.getUint16(28, le), v.getUint16(30, le));
  const { canvas, hx, hy } = buildGlyphCursor(sourceChar, fg, bg);
  ctx.cursors.set(cid, { id: cid, image: canvas, hotspotX: hx, hotspotY: hy });
}

function onFreeCursor(ctx: RequestContext) {
  const cid = reqView(ctx).getUint32(4, ctx.littleEndian);
  ctx.cursors.delete(cid);
}

function onRecolorCursor(ctx: RequestContext) {
  // Repaint the cursor with new fg/bg. Cheapest path: re-detect the glyph
  // is impossible from the OffscreenCanvas alone, so for now just ignore —
  // worst case the cursor keeps its original colors. Toolkits rarely re-color.
  void ctx;
}

function onCopyArea(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const srcId = v.getUint32(4, le);
  const dstId = v.getUint32(8, le);
  const src = getDrawable(ctx, srcId);
  const dst = getDrawable(ctx, dstId);
  // gc at offset 12, ignored for now (function, plane-mask, clip rect…)
  const srcX = v.getInt16(16, le);
  const srcY = v.getInt16(18, le);
  const dstX = v.getInt16(20, le);
  const dstY = v.getInt16(22, le);
  const w = v.getUint16(24, le);
  const h = v.getUint16(26, le);
  if (!src || !dst || w === 0 || h === 0) return;
  if (src === dst) {
    // Same drawable: scroll-style overlapping copy. Canvas drawImage is not
    // reliable when src and dst overlap on the same canvas — route through a
    // throwaway buffer. xterm's line-scroll path is the main consumer.
    const tmp = new OffscreenCanvas(w, h);
    const tctx = tmp.getContext('2d');
    if (!tctx) return;
    tctx.drawImage(src.buffer, srcX, srcY, w, h, 0, 0, w, h);
    dst.ctx.drawImage(tmp, 0, 0, w, h, dstX, dstY, w, h);
  } else {
    dst.ctx.drawImage(src.buffer, srcX, srcY, w, h, dstX, dstY, w, h);
  }
  invalidateIfWindow(ctx, dst);

  // graphics-exposures defaults to True on GCs; xterm relies on NoExposure
  // events after CopyArea to know the scroll completed and continue drawing.
  // We always source from the full backing buffer, so nothing was clipped —
  // always reply NoExposure (not GraphicsExposure).
  const ew = new Writer(32, ctx.littleEndian);
  ew.card8(14);                       // NoExposure event
  ew.card8(0);
  ew.card16(ctx.sequence);
  ew.card32(dstId);
  ew.card16(0);                       // minorEvent (core request)
  ew.card8(62);                       // majorEvent = CopyArea
  ew.pad(21);
  ctx.send(ew.finish());
}

function onCopyPlane(ctx: RequestContext) {
  // Used by Athena/Lucid widgets to render bitmap glyphs and toolbar icons in
  // arbitrary colors: a 1-bit source pixmap selects per-pixel between the
  // GC's foreground and background. We approximate "bit set" as "src pixel
  // has non-zero alpha + brightness" — works for pixmaps drawn via fills.
  const v = reqView(ctx); const le = ctx.littleEndian;
  const src = getDrawable(ctx, v.getUint32(4, le));
  const dst = getDrawable(ctx, v.getUint32(8, le));
  const gc = ctx.gcs.get(v.getUint32(12, le));
  const srcX = v.getInt16(16, le);
  const srcY = v.getInt16(18, le);
  const dstX = v.getInt16(20, le);
  const dstY = v.getInt16(22, le);
  const w = v.getUint16(24, le);
  const h = v.getUint16(26, le);
  // const bitPlane = v.getUint32(28, le);  // single bit; we don't model planes
  if (!src || !dst || !gc || w === 0 || h === 0) return;

  const srcImg = src.ctx.getImageData(srcX, srcY, w, h);
  const sd = srcImg.data;
  const out = new ImageData(w, h);
  const od = out.data;
  const fg = gc.foreground >>> 0;
  const bg = gc.background >>> 0;
  const fr = (fg >> 16) & 0xff, fgg = (fg >> 8) & 0xff, fb = fg & 0xff;
  const br = (bg >> 16) & 0xff, bgg = (bg >> 8) & 0xff, bb = bg & 0xff;
  for (let i = 0, n = w * h * 4; i < n; i += 4) {
    const set = (sd[i]! | sd[i + 1]! | sd[i + 2]!) !== 0 && sd[i + 3]! !== 0;
    if (set) { od[i] = fr; od[i + 1] = fgg; od[i + 2] = fb; od[i + 3] = 0xff; }
    else     { od[i] = br; od[i + 1] = bgg; od[i + 2] = bb; od[i + 3] = 0xff; }
  }
  dst.ctx.putImageData(out, dstX, dstY);
  invalidateIfWindow(ctx, dst);
}

function onPutImage(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const format = ctx.requestData;                  // 0=Bitmap, 1=XYPixmap, 2=ZPixmap
  const drawable = getDrawable(ctx, v.getUint32(4, le));
  const gc = ctx.gcs.get(v.getUint32(8, le));
  const width = v.getUint16(12, le);
  const height = v.getUint16(14, le);
  const dstX = v.getInt16(16, le);
  const dstY = v.getInt16(18, le);
  const leftPad = v.getUint8(20);
  const depth = v.getUint8(21);
  if (!drawable || width === 0 || height === 0) return;

  // Bitmap path: format=0 (XYBitmap) or format=2 (ZPixmap) with depth=1.
  // Bits 1=foreground, 0=background (both from GC). Scanline stride is
  // 32-bit-padded, bit-order is LSBFirst (declared in setup).
  if (depth === 1 && (format === 0 || format === 2)) {
    if (!gc) return;
    const fg = (gc.foreground >>> 0);
    const bg = (gc.background >>> 0);
    const stride = ((width + leftPad + 31) >> 5) << 2;        // bytes per scanline
    const src = ctx.bytes.subarray(24, 24 + stride * height);
    if (src.byteLength < stride * height) return;
    const img = new ImageData(width, height);
    const out = img.data;
    const fr = (fg >> 16) & 0xff, fgg = (fg >> 8) & 0xff, fb = fg & 0xff;
    const br = (bg >> 16) & 0xff, bgg = (bg >> 8) & 0xff, bb = bg & 0xff;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bitIdx = x + leftPad;
        const byte = src[y * stride + (bitIdx >> 3)] ?? 0;
        const bitOn = (byte >> (bitIdx & 7)) & 1;
        const o = (y * width + x) * 4;
        if (bitOn) { out[o] = fr; out[o + 1] = fgg; out[o + 2] = fb; out[o + 3] = 0xff; }
        else       { out[o] = br; out[o + 1] = bgg; out[o + 2] = bb; out[o + 3] = 0xff; }
      }
    }
    drawable.ctx.putImageData(img, dstX, dstY);
    invalidateIfWindow(ctx, drawable);
    return;
  }

  // Depth-8 ZPixmap: alpha/grayscale data (1 byte per pixel). Many GTK icon
  // paths upload depth-8 masks. Render as a luminance image (grayscale opaque).
  if (depth === 8 && format === 2) {
    const stride = (width + 3) & ~3;
    const src = ctx.bytes.subarray(24, 24 + stride * height);
    if (src.byteLength < stride * height) return;
    const img = new ImageData(width, height);
    const out = img.data;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const px = src[y * stride + x] ?? 0;
        const o = (y * width + x) * 4;
        out[o] = px; out[o + 1] = px; out[o + 2] = px; out[o + 3] = 0xff;
      }
    }
    drawable.ctx.putImageData(img, dstX, dstY);
    invalidateIfWindow(ctx, drawable);
    return;
  }

  if (format !== 2 || (depth !== 24 && depth !== 32)) {
    console.warn(`[PutImage] unsupported format=${format} depth=${depth}`);
    return;
  }
  const expected = width * height * 4;
  const src = ctx.bytes.subarray(24, 24 + expected);
  if (src.byteLength < expected) return;
  const img = new ImageData(width, height);
  const out = img.data;
  const useAlpha = depth === 32;
  if (le) {
    // 0x00RRGGBB stored LE -> bytes B G R X
    for (let i = 0, o = 0; i < expected; i += 4, o += 4) {
      out[o]     = src[i + 2]!;
      out[o + 1] = src[i + 1]!;
      out[o + 2] = src[i]!;
      out[o + 3] = useAlpha ? src[i + 3]! : 0xff;
    }
  } else {
    // MSB byte-order: bytes X R G B
    for (let i = 0, o = 0; i < expected; i += 4, o += 4) {
      out[o]     = src[i + 1]!;
      out[o + 1] = src[i + 2]!;
      out[o + 2] = src[i + 3]!;
      out[o + 3] = useAlpha ? src[i]! : 0xff;
    }
  }
  drawable.ctx.putImageData(img, dstX, dstY);
  invalidateIfWindow(ctx, drawable);
}

// --- drawing primitives ----------------------------------------------------

interface Target { drawable: Drawable; gc: GC; }

function getDrawable(ctx: RequestContext, id: number): Drawable | undefined {
  return ctx.windows.get(id) ?? ctx.pixmaps.get(id);
}

function targetOf(ctx: RequestContext): Target | undefined {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const drawable = getDrawable(ctx, v.getUint32(4, le));
  const gc = ctx.gcs.get(v.getUint32(8, le));
  if (!drawable || !gc) return undefined;
  return { drawable, gc };
}

function invalidateIfWindow(ctx: RequestContext, d: Drawable) {
  if (d instanceof Window) ctx.renderer.invalidate();
}

function setStroke(c: OffscreenCanvasRenderingContext2D, gc: GC) {
  c.strokeStyle = pixelToCss(gc.foreground);
  c.lineWidth = gc.lineWidth || 1;
}

// Canvas stroke convention: a stroke centered on an integer coordinate
// antialiases across two rows of pixels. Adding 0.5 keeps an odd-width line
// crisp on a single row; even-width lines are crisp without the offset.
// X11 line-width=0 is a "thin line" (treat as 1).
function strokeOffsetFor(gc: GC): number {
  const lw = gc.lineWidth || 1;
  return (lw % 2 === 1) ? 0.5 : 0;
}

function onClearArea(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const exposures = ctx.requestData !== 0;
  const wid = v.getUint32(4, le);
  const x = v.getInt16(8, le);
  const y = v.getInt16(10, le);
  const w = v.getUint16(12, le);
  const h = v.getUint16(14, le);
  const win = ctx.windows.get(wid);
  if (!win) return;
  const cw = w === 0 ? win.width - x : w;
  const ch = h === 0 ? win.height - y : h;
  win.paintBackground(x, y, cw, ch);
  ctx.renderer.invalidate();
  // Per X spec: when `exposures=True`, the server must generate Expose
  // events for the cleared region. xcalc relies on this — it clears the
  // digit window and waits for Expose before redrawing the number.
  if (exposures) {
    emitEvent(ctx, win.owner, 12 /* Expose */, null, (wb) => {
      wb.card32(win.id);
      wb.card16(x); wb.card16(y);
      wb.card16(cw); wb.card16(ch);
      wb.card16(0);                  // count: 0 = last expose
      wb.pad(14);
    });
  }
}

function onPolyPoint(ctx: RequestContext) {
  const t = targetOf(ctx); if (!t) return;
  const v = reqView(ctx); const le = ctx.littleEndian;
  const coordMode = ctx.requestData;
  const c = t.drawable.ctx;
  c.fillStyle = pixelToCss(t.gc.foreground);
  let cx = 0, cy = 0, first = true;
  for (let p = 12; p + 4 <= ctx.bytes.byteLength; p += 4) {
    const px = v.getInt16(p, le);
    const py = v.getInt16(p + 2, le);
    if (coordMode === 1 && !first) { cx += px; cy += py; } else { cx = px; cy = py; }
    c.fillRect(cx, cy, 1, 1);
    first = false;
  }
  invalidateIfWindow(ctx, t.drawable);
}

function onPolyLine(ctx: RequestContext) {
  const t = targetOf(ctx); if (!t) return;
  const v = reqView(ctx); const le = ctx.littleEndian;
  const coordMode = ctx.requestData;
  const c = t.drawable.ctx;
  setStroke(c, t.gc);
  const o = strokeOffsetFor(t.gc);
  c.beginPath();
  let cx = 0, cy = 0, first = true;
  for (let p = 12; p + 4 <= ctx.bytes.byteLength; p += 4) {
    const px = v.getInt16(p, le);
    const py = v.getInt16(p + 2, le);
    if (coordMode === 1 && !first) { cx += px; cy += py; } else { cx = px; cy = py; }
    if (first) c.moveTo(cx + o, cy + o);
    else c.lineTo(cx + o, cy + o);
    first = false;
  }
  c.stroke();
  invalidateIfWindow(ctx, t.drawable);
}

function onPolySegment(ctx: RequestContext) {
  const t = targetOf(ctx); if (!t) return;
  const v = reqView(ctx); const le = ctx.littleEndian;
  const c = t.drawable.ctx;
  setStroke(c, t.gc);
  const o = strokeOffsetFor(t.gc);
  c.beginPath();
  for (let p = 12; p + 8 <= ctx.bytes.byteLength; p += 8) {
    const x1 = v.getInt16(p, le);
    const y1 = v.getInt16(p + 2, le);
    const x2 = v.getInt16(p + 4, le);
    const y2 = v.getInt16(p + 6, le);
    c.moveTo(x1 + o, y1 + o);
    c.lineTo(x2 + o, y2 + o);
  }
  c.stroke();
  invalidateIfWindow(ctx, t.drawable);
}

function onPolyRectangle(ctx: RequestContext) {
  const t = targetOf(ctx); if (!t) return;
  const v = reqView(ctx); const le = ctx.littleEndian;
  const c = t.drawable.ctx;
  setStroke(c, t.gc);
  const o = strokeOffsetFor(t.gc);
  for (let p = 12; p + 8 <= ctx.bytes.byteLength; p += 8) {
    const x = v.getInt16(p, le);
    const y = v.getInt16(p + 2, le);
    const w = v.getUint16(p + 4, le);
    const h = v.getUint16(p + 6, le);
    c.strokeRect(x + o, y + o, w, h);
  }
  invalidateIfWindow(ctx, t.drawable);
}

function arcPath(
  c: OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, a1: number, a2: number,
  pieSlice: boolean,
) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = Math.max(0.5, w / 2);
  const ry = Math.max(0.5, h / 2);
  c.beginPath();
  if (Math.abs(a2) >= 360 * 64) {
    c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    return;
  }
  // X11: angles in 1/64 deg, CCW from +X. Canvas y-axis is flipped, so we
  // negate angles and ask for CW arc direction to preserve X11 semantics.
  const startRad = -a1 * Math.PI / (64 * 180);
  const endRad = -(a1 + a2) * Math.PI / (64 * 180);
  if (pieSlice) c.moveTo(cx, cy);
  c.ellipse(cx, cy, rx, ry, 0, startRad, endRad, a2 > 0);
  if (pieSlice) c.closePath();
}

function onPolyArc(ctx: RequestContext) {
  const t = targetOf(ctx); if (!t) return;
  const v = reqView(ctx); const le = ctx.littleEndian;
  const c = t.drawable.ctx;
  setStroke(c, t.gc);
  for (let p = 12; p + 12 <= ctx.bytes.byteLength; p += 12) {
    const x = v.getInt16(p, le);
    const y = v.getInt16(p + 2, le);
    const w = v.getUint16(p + 4, le);
    const h = v.getUint16(p + 6, le);
    const a1 = v.getInt16(p + 8, le);
    const a2 = v.getInt16(p + 10, le);
    arcPath(c, x, y, w, h, a1, a2, false);
    c.stroke();
  }
  invalidateIfWindow(ctx, t.drawable);
}

function onFillPoly(ctx: RequestContext) {
  const v0 = reqView(ctx); const le0 = ctx.littleEndian;
  const drawableId = v0.getUint32(4, le0);
  const gcId = v0.getUint32(8, le0);
  const t = targetOf(ctx);
  if (!t) {
    console.warn(`[FillPoly] no target: drawable=${drawableId} gc=${gcId} have-win=${ctx.windows.has(drawableId)} have-px=${ctx.pixmaps.has(drawableId)} have-gc=${ctx.gcs.has(gcId)}`);
    return;
  }
  const v = reqView(ctx); const le = ctx.littleEndian;
  const coordMode = v.getUint8(13);
  const c = t.drawable.ctx;
  if ((globalThis as any).__x11trace) {
    const pts: string[] = [];
    for (let p = 16; p + 4 <= ctx.bytes.byteLength; p += 4) {
      pts.push(`${v.getInt16(p, le)},${v.getInt16(p + 2, le)}`);
    }
    console.log(`[FillPoly] drawable=${drawableId} (win? ${t.drawable instanceof Window}) gc=${gcId} fg=0x${t.gc.foreground.toString(16)} coord=${coordMode} pts=${pts.join(' ')}`);
  }
  c.fillStyle = pixelToCss(t.gc.foreground);
  c.beginPath();
  let cx = 0, cy = 0, first = true;
  for (let p = 16; p + 4 <= ctx.bytes.byteLength; p += 4) {
    const px = v.getInt16(p, le);
    const py = v.getInt16(p + 2, le);
    if (coordMode === 1 && !first) { cx += px; cy += py; } else { cx = px; cy = py; }
    if (first) c.moveTo(cx, cy);
    else c.lineTo(cx, cy);
    first = false;
  }
  c.closePath();
  c.fill();
  invalidateIfWindow(ctx, t.drawable);
}

function onPolyFillRectangle(ctx: RequestContext) {
  const t = targetOf(ctx); if (!t) return;
  const v = reqView(ctx); const le = ctx.littleEndian;
  const c = t.drawable.ctx;
  c.fillStyle = pixelToCss(t.gc.foreground);
  for (let p = 12; p + 8 <= ctx.bytes.byteLength; p += 8) {
    const x = v.getInt16(p, le);
    const y = v.getInt16(p + 2, le);
    const w = v.getUint16(p + 4, le);
    const h = v.getUint16(p + 6, le);
    c.fillRect(x, y, w, h);
  }
  invalidateIfWindow(ctx, t.drawable);
}

function onPolyFillArc(ctx: RequestContext) {
  const t = targetOf(ctx); if (!t) return;
  const v = reqView(ctx); const le = ctx.littleEndian;
  const c = t.drawable.ctx;
  c.fillStyle = pixelToCss(t.gc.foreground);
  const pieSlice = t.gc.arcMode !== 0; // 0=Chord, 1=PieSlice
  for (let p = 12; p + 12 <= ctx.bytes.byteLength; p += 12) {
    const x = v.getInt16(p, le);
    const y = v.getInt16(p + 2, le);
    const w = v.getUint16(p + 4, le);
    const h = v.getUint16(p + 6, le);
    const a1 = v.getInt16(p + 8, le);
    const a2 = v.getInt16(p + 10, le);
    arcPath(c, x, y, w, h, a1, a2, pieSlice);
    c.fill();
  }
  invalidateIfWindow(ctx, t.drawable);
}

// --- colors / cursors (TrueColor stubs) ------------------------------------

const NAMED_COLORS: Record<string, number> = {
  black: 0x000000, white: 0xffffff,
  red: 0xff0000, green: 0x00ff00, blue: 0x0000ff,
  yellow: 0xffff00, cyan: 0x00ffff, magenta: 0xff00ff,
  gray: 0x808080, grey: 0x808080,
  honeydew: 0xf0fff0,                  // xeyes uses this for the sclera
};

function rgbFromPixel(pixel: number): [number, number, number] {
  return [(pixel >> 16) & 0xff, (pixel >> 8) & 0xff, pixel & 0xff];
}

function onAllocColor(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const r = v.getUint16(8, le) >> 8;
  const g = v.getUint16(10, le) >> 8;
  const b = v.getUint16(12, le) >> 8;
  const pixel = ((r << 16) | (g << 8) | b) >>> 0;
  ctx.send(makeReply(ctx, 0, (w) => {
    w.card16(r * 0x101); w.card16(g * 0x101); w.card16(b * 0x101);
    w.pad(2);
    w.card32(pixel);
    w.pad(12);
  }));
}

function onAllocNamedColor(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const nameLen = v.getUint16(8, le);
  const name = new TextDecoder('latin1').decode(ctx.bytes.subarray(12, 12 + nameLen)).toLowerCase();
  const pixel = NAMED_COLORS[name] ?? 0;
  const [r, g, b] = rgbFromPixel(pixel);
  ctx.send(makeReply(ctx, 0, (w) => {
    w.card32(pixel);
    w.card16(r * 0x101); w.card16(g * 0x101); w.card16(b * 0x101);
    w.card16(r * 0x101); w.card16(g * 0x101); w.card16(b * 0x101);
    w.pad(8);
  }));
}

function onLookupColor(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const nameLen = v.getUint16(8, le);
  const name = new TextDecoder('latin1').decode(ctx.bytes.subarray(12, 12 + nameLen)).toLowerCase();
  const pixel = NAMED_COLORS[name] ?? 0;
  const [r, g, b] = rgbFromPixel(pixel);
  ctx.send(makeReply(ctx, 0, (w) => {
    w.card16(r * 0x101); w.card16(g * 0x101); w.card16(b * 0x101);
    w.card16(r * 0x101); w.card16(g * 0x101); w.card16(b * 0x101);
    w.pad(12);
  }));
}

function onQueryColors(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const numPixels = Math.floor((ctx.bytes.byteLength - 8) / 4);
  const dataBytes = numPixels * 8;
  const w = new Writer(32 + dataBytes, ctx.littleEndian);
  w.card8(1); w.card8(0);
  w.card16(ctx.sequence);
  w.card32(dataBytes / 4);
  w.card16(numPixels);
  w.pad(22);
  for (let i = 0; i < numPixels; i++) {
    const pixel = v.getUint32(8 + i * 4, le);
    const [r, g, b] = rgbFromPixel(pixel);
    w.card16(r * 0x101); w.card16(g * 0x101); w.card16(b * 0x101);
    w.pad(2);
  }
  ctx.send(w.finish());
}

function onAllocColorCells(ctx: RequestContext) {
  // We always reply with zero pixels and zero masks — TrueColor clients should
  // not really hit this; the reply just keeps the protocol stream balanced.
  ctx.send(makeReply(ctx, 0, (w) => {
    w.card16(0); w.card16(0); w.pad(20);
  }));
}

function onAllocColorPlanes(ctx: RequestContext) {
  ctx.send(makeReply(ctx, 0, (w) => {
    w.card16(0); w.pad(2);
    w.card32(0); w.card32(0); w.card32(0);
    w.pad(8);
  }));
}

function onListInstalledColormaps(ctx: RequestContext) {
  // One installed colormap with id 0 (we don't actually maintain colormaps).
  const w = new Writer(36, ctx.littleEndian);
  w.card8(1); w.card8(1);
  w.card16(ctx.sequence);
  w.card32(1);                          // additional length = 1 * 4-byte unit
  w.card16(1);                          // number of colormaps
  w.pad(22);
  w.card32(0);
  ctx.send(w.finish());
}

function onQueryBestSize(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  // Request just echoes back the requested size as "best".
  const width = v.getUint16(8, le);
  const height = v.getUint16(10, le);
  ctx.send(makeReply(ctx, 0, (w) => {
    w.card16(width); w.card16(height); w.pad(20);
  }));
}

// --- fonts -----------------------------------------------------------------

function writeCharInfo(w: Writer) {
  w.int16(0);                          // left-side-bearing
  w.int16(FONT.charWidth);             // right-side-bearing
  w.int16(FONT.charWidth);             // character-width
  w.int16(FONT.ascent);
  w.int16(FONT.descent);
  w.card16(0);                         // attributes
}

function onQueryFont(ctx: RequestContext) {
  // QueryFont reply has a 60-byte fixed structure (not the usual 32) followed
  // by font properties and per-char info. We claim no per-char info so the
  // client uses min_bounds == max_bounds for everything.
  const propsCount = 0;
  const charInfoCount = 0;
  const totalLen = 60 + propsCount * 8 + charInfoCount * 12;
  const w = new Writer(totalLen, ctx.littleEndian);
  w.card8(1);                          // Reply
  w.card8(0);
  w.card16(ctx.sequence);
  w.card32((totalLen - 32) / 4);

  writeCharInfo(w);                    // min_bounds
  w.card32(0);                         // walign1
  writeCharInfo(w);                    // max_bounds
  w.card32(0);                         // walign2

  w.card16(FONT.minChar);
  w.card16(FONT.maxChar);
  w.card16(FONT.defaultChar);
  w.card16(propsCount);
  w.card8(0);                          // draw-direction: LeftToRight
  w.card8(0);                          // min-byte1
  w.card8(0);                          // max-byte1
  w.card8(1);                          // all-chars-exist
  w.int16(FONT.ascent);
  w.int16(FONT.descent);
  w.card32(charInfoCount);
  ctx.send(w.finish());
}

function onQueryTextExtents(ctx: RequestContext) {
  // Request: oddLength (data byte), font (4), string (CHAR2B). Pad to 4.
  const stringBytes = ctx.bytes.byteLength - 8;
  const realStringBytes = ctx.requestData ? stringBytes - 2 : stringBytes;
  const n = Math.max(0, realStringBytes / 2);
  const overallWidth = n * FONT.charWidth;
  ctx.send(makeReply(ctx, 0, (w) => {
    w.card16(FONT.ascent);             // font-ascent
    w.card16(FONT.descent);            // font-descent
    w.int16(FONT.ascent);              // overall-ascent
    w.int16(FONT.descent);             // overall-descent
    w.int32(overallWidth);
    w.int32(0);                        // overall-left
    w.int32(overallWidth);             // overall-right
    w.pad(4);
  }));
}

function onListFonts(ctx: RequestContext) {
  const names = FAKE_FONT_NAMES;
  const dataBytes = names.reduce((s, n) => s + 1 + n.length, 0);
  const padded = (dataBytes + 3) & ~3;
  const w = new Writer(32 + padded, ctx.littleEndian);
  w.card8(1); w.card8(0);
  w.card16(ctx.sequence);
  w.card32(padded / 4);
  w.card16(names.length);
  w.pad(22);
  const enc = new TextEncoder();
  for (const name of names) {
    w.card8(name.length);
    w.bytes(enc.encode(name));
  }
  w.padTo(4);
  ctx.send(w.finish());
}

function onGetFontPath(ctx: RequestContext) {
  ctx.send(makeReply(ctx, 0, (w) => {
    w.card16(0);                       // number of paths
    w.pad(22);
  }));
}

// --- text drawing ----------------------------------------------------------

function applyTextFont(c: OffscreenCanvasRenderingContext2D) {
  c.font = FONT.cssFont;
  c.textBaseline = 'alphabetic';
}

// Draw one glyph per FONT.charWidth pixels regardless of Canvas's natural
// advance, so positions stay synchronised with what xterm expects.
function drawCells(c: OffscreenCanvasRenderingContext2D, str: string, x: number, y: number) {
  for (let i = 0; i < str.length; i++) {
    c.fillText(str.charAt(i), x + i * FONT.charWidth, y);
  }
}

function onImageText8(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const strLen = ctx.requestData;
  const drawable = getDrawable(ctx, v.getUint32(4, le));
  const gc = ctx.gcs.get(v.getUint32(8, le));
  if (!drawable || !gc) return;
  const x = v.getInt16(12, le);
  const y = v.getInt16(14, le);
  const str = new TextDecoder('latin1').decode(ctx.bytes.subarray(16, 16 + strLen));

  const c = drawable.ctx;
  c.fillStyle = pixelToCss(gc.background);
  c.fillRect(x, y - FONT.ascent, strLen * FONT.charWidth, FONT.ascent + FONT.descent);
  c.fillStyle = pixelToCss(gc.foreground);
  applyTextFont(c);
  drawCells(c, str, x, y);
  invalidateIfWindow(ctx, drawable);
}

function onPolyText8(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const drawable = getDrawable(ctx, v.getUint32(4, le));
  const gc = ctx.gcs.get(v.getUint32(8, le));
  if (!drawable || !gc) return;
  let x = v.getInt16(12, le);
  const y = v.getInt16(14, le);

  const c = drawable.ctx;
  c.fillStyle = pixelToCss(gc.foreground);
  applyTextFont(c);

  let p = 16;
  while (p < ctx.bytes.byteLength) {
    const first = ctx.bytes[p];
    if (first === undefined) break;
    if (first === 0xff) {
      // Font shift (4-byte fid follows). We have one font, so just skip.
      if (p + 5 > ctx.bytes.byteLength) break;
      p += 5;
      continue;
    }
    const len = first;
    if (len === 0) { p += 2; continue; }
    if (p + 2 + len > ctx.bytes.byteLength) break;
    const delta = new Int8Array([ctx.bytes[p + 1] ?? 0])[0]!;
    const str = new TextDecoder('latin1').decode(ctx.bytes.subarray(p + 2, p + 2 + len));
    x += delta;
    drawCells(c, str, x, y);
    x += len * FONT.charWidth;
    p += 2 + len;
  }
  invalidateIfWindow(ctx, drawable);
}

// --- window config / coords ------------------------------------------------

function onConfigureWindow(ctx: RequestContext) {
  // Honour x/y/width/height bits in the value-mask so apps can move/resize
  // their own windows. Other bits (border, sibling, stack-mode) ignored except
  // when redirected — then the WM gets the full picture in ConfigureRequest.
  const v = reqView(ctx); const le = ctx.littleEndian;
  const wid = v.getUint32(4, le);
  const valueMask = v.getUint16(8, le);
  const win = ctx.windows.get(wid);
  if (!win) return;

  // Parse requested values from the variable list (each entry is 4 bytes).
  const requested = { x: win.x, y: win.y, width: win.width, height: win.height, borderWidth: 0 };
  let sibling = 0;
  let stackMode = 0;
  let p = 12;
  const readU = () => { const x = v.getUint32(p, le); p += 4; return x; };
  const readI = () => { const x = v.getInt32(p, le); p += 4; return x; };
  if (valueMask & 0x001) requested.x = readI();
  if (valueMask & 0x002) requested.y = readI();
  if (valueMask & 0x004) requested.width = readU();
  if (valueMask & 0x008) requested.height = readU();
  if (valueMask & 0x010) requested.borderWidth = readU();
  if (valueMask & 0x020) sibling = readU();
  if (valueMask & 0x040) stackMode = v.getUint8(p) & 0xff;


  // Redirect to the WM if applicable.
  const parent = ctx.windows.get(win.parent);
  if (parent?.substructureRedirectClient !== undefined &&
      parent.substructureRedirectClient !== ctx.clientId &&
      !win.overrideRedirect) {
    sendConfigureRequest(ctx, parent.substructureRedirectClient, parent.id, win, sibling, stackMode, valueMask, requested);
    return;
  }

  let resized = false;
  if (valueMask & 0x001) win.x = requested.x;
  if (valueMask & 0x002) win.y = requested.y;
  if (valueMask & 0x004 && requested.width !== win.width) { win.width = requested.width; resized = true; }
  if (valueMask & 0x008 && requested.height !== win.height) { win.height = requested.height; resized = true; }
  if (resized) {
    win.buffer.width = Math.max(1, win.width);
    win.buffer.height = Math.max(1, win.height);
    win.paintBackground(0, 0, win.width, win.height);
  }
  // Stack-mode: 0=Above, 1=Below, 2=TopIf, 3=BottomIf, 4=Opposite.
  // We approximate TopIf/Opposite as Above (most common case is raise-on-focus).
  if (valueMask & 0x040) {
    if (stackMode === 1 /* Below */ || stackMode === 3 /* BottomIf */) {
      win.stackOrder = --lowestStackOrder;
    } else {
      win.stackOrder = nextStackOrder++;
    }
  }
  ctx.renderer.invalidate();

  // Notify subscribers.
  if (win.eventMask & EVENT_MASK.StructureNotify) {
    sendConfigureNotify(ctx, win.owner, win.id, win);
  }
  if (parent?.substructureNotifyClient !== undefined) {
    sendConfigureNotify(ctx, parent.substructureNotifyClient, parent.id, win);
  }
}

function onReparentWindow(ctx: RequestContext) {
  // Per ICCCM 4.1.3.1, a successful XReparentWindow on a mapped client window
  // generates this exact sequence:
  //   1. UnmapNotify
  //   2. ReparentNotify
  //   3. MapNotify
  //   4. (synthetic) ConfigureNotify with the new position in root coordinates
  // GTK toolkits (and especially their marco/metacity-style reparent
  // handlers) lose track of the window if any of these are missing.
  const v = reqView(ctx); const le = ctx.littleEndian;
  const wid = v.getUint32(4, le);
  const newParentId = v.getUint32(8, le);
  const newX = v.getInt16(12, le);
  const newY = v.getInt16(14, le);
  const win = ctx.windows.get(wid);
  if (!win) return;
  const wasMapped = win.mapped;
  const oldParent = ctx.windows.get(win.parent);
  const newParent = ctx.windows.get(newParentId);

  // Step 1: UnmapNotify (only if it was mapped).
  if (wasMapped) {
    win.mapped = false;
    if (win.eventMask & EVENT_MASK.StructureNotify) {
      sendUnmapNotify(ctx, win.owner, wid, wid);
    }
    if (oldParent?.substructureNotifyClient !== undefined) {
      sendUnmapNotify(ctx, oldParent.substructureNotifyClient, oldParent.id, wid);
    }
  }

  // Step 2: update parent + position, then send ReparentNotify.
  win.parent = newParentId;
  win.x = newX;
  win.y = newY;
  if (oldParent?.substructureNotifyClient !== undefined) {
    sendReparentNotify(ctx, oldParent.substructureNotifyClient, oldParent.id, wid, newParentId, newX, newY, win.overrideRedirect);
  }
  if (newParent?.substructureNotifyClient !== undefined &&
      newParent.substructureNotifyClient !== oldParent?.substructureNotifyClient) {
    sendReparentNotify(ctx, newParent.substructureNotifyClient, newParent.id, wid, newParentId, newX, newY, win.overrideRedirect);
  }
  if (win.eventMask & EVENT_MASK.StructureNotify) {
    sendReparentNotify(ctx, win.owner, wid, wid, newParentId, newX, newY, win.overrideRedirect);
  }

  // Step 3: re-map and send MapNotify if it was mapped.
  if (wasMapped) {
    win.mapped = true;
    if (win.eventMask & EVENT_MASK.StructureNotify) {
      sendMapNotify(ctx, win.owner, wid, wid, win.overrideRedirect);
    }
    if (newParent?.substructureNotifyClient !== undefined) {
      sendMapNotify(ctx, newParent.substructureNotifyClient, newParent.id, wid, win.overrideRedirect);
    }
    sendExpose(ctx, win);
  }

  // Step 4: synthetic ConfigureNotify so the client knows its absolute coords.
  if (win.eventMask & EVENT_MASK.StructureNotify) {
    sendConfigureNotify(ctx, win.owner, wid, win);
  }

  ctx.renderer.invalidate();
}

function onQueryTree(ctx: RequestContext) {
  const wid = reqView(ctx).getUint32(4, ctx.littleEndian);
  const win = ctx.windows.get(wid);
  const children: number[] = [];
  for (const w of ctx.windows.values()) {
    if (w.parent === wid) children.push(w.id);
  }
  const additional = children.length * 4;
  const wbuf = new Writer(32 + additional, ctx.littleEndian);
  wbuf.card8(1); wbuf.card8(0);
  wbuf.card16(ctx.sequence);
  wbuf.card32(additional / 4);
  wbuf.card32(ctx.rootWindowId);                 // root
  wbuf.card32(wid === ctx.rootWindowId ? 0 : (win?.parent ?? 0)); // parent
  wbuf.card16(children.length);
  wbuf.pad(14);
  for (const c of children) wbuf.card32(c);
  ctx.send(wbuf.finish());
}

function onGetWindowAttributes(ctx: RequestContext) {
  const wid = reqView(ctx).getUint32(4, ctx.littleEndian);
  const win = ctx.windows.get(wid);
  const mapped = win?.mapped ?? false;
  const eventMask = win?.eventMask ?? 0;
  const overrideRedirect = win?.overrideRedirect ?? false;
  ctx.send(makeReply(ctx, 1 /* backing-store: WhenMapped */, (wb) => {
    wb.card32(0x21);                  // visual (our root visual)
    wb.card16(1);                     // class: InputOutput
    wb.card8(0);                      // bit-gravity: ForgetGravity
    wb.card8(1);                      // win-gravity: NorthWestGravity
    wb.card32(0xffffffff);            // backing-planes
    wb.card32(0);                     // backing-pixel
    wb.card8(0);                      // save-under
    wb.card8(1);                      // map-is-installed
    wb.card8(mapped ? 2 : 0);         // map-state
    wb.card8(overrideRedirect ? 1 : 0);
    wb.card32(0);                     // colormap
    // additional 12 bytes
    wb.card32(eventMask);             // all-event-masks
    wb.card32(eventMask);             // your-event-mask
    wb.card16(0);                     // do-not-propagate-mask
    wb.pad(2);
  }));
}

function screenPosOf(ctx: RequestContext, wid: number): { x: number; y: number } {
  let x = 0, y = 0;
  let cur = ctx.windows.get(wid);
  while (cur && cur.id !== ctx.rootWindowId) {
    x += cur.x;
    y += cur.y;
    cur = ctx.windows.get(cur.parent);
  }
  return { x, y };
}

function onTranslateCoordinates(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const srcWid = v.getUint32(4, le);
  const dstWid = v.getUint32(8, le);
  const srcX = v.getInt16(12, le);
  const srcY = v.getInt16(14, le);
  // Window x/y on the wire are *parent-relative*; the protocol needs the
  // screen positions of src and dst to translate. Walk each window's parent
  // chain to accumulate the actual screen positions.
  const srcSp = screenPosOf(ctx, srcWid);
  const dstSp = screenPosOf(ctx, dstWid);
  const sx = srcSp.x + srcX;
  const sy = srcSp.y + srcY;
  const dx = sx - dstSp.x;
  const dy = sy - dstSp.y;
  ctx.send(makeReply(ctx, 1 /* same-screen */, (w) => {
    w.card32(0);                       // child = None
    w.int16(dx); w.int16(dy);
    w.pad(16);
  }));
}

// --- extension / config replies (unchanged) --------------------------------

function onQueryExtension(ctx: RequestContext) {
  const v = reqView(ctx); const le = ctx.littleEndian;
  const nameLen = v.getUint16(4, le);
  let name = '';
  for (let i = 0; i < nameLen; i++) name += String.fromCharCode(v.getUint8(8 + i));
  let present = 0, major = 0, firstEvent = 0, firstError = 0;
  if (name === 'RENDER') {
    present = 1;
    major = RENDER_MAJOR_OPCODE;
    firstEvent = RENDER_FIRST_EVENT;
    firstError = RENDER_FIRST_ERROR;
  } else if (name === 'XInputExtension') {
    present = 1;
    major = XINPUT_MAJOR_OPCODE;
    firstEvent = XINPUT_FIRST_EVENT;
    firstError = XINPUT_FIRST_ERROR;
  } else if (name === 'XKEYBOARD' && (globalThis as any).__enable_xkb !== false) {
    present = 1;
    major = XKB_MAJOR_OPCODE;
    firstEvent = XKB_FIRST_EVENT;
    firstError = XKB_FIRST_ERROR;
  } else if (name === 'RANDR' && (globalThis as any).__enable_randr !== false) {
    present = 1;
    major = RANDR_MAJOR_OPCODE;
    firstEvent = RANDR_FIRST_EVENT;
    firstError = RANDR_FIRST_ERROR;
  } else if (name === 'MIT-SHM' && (globalThis as any).__enable_shm !== false) {
    present = 1;
    major = MITSHM_MAJOR_OPCODE;
    firstEvent = MITSHM_FIRST_EVENT;
    firstError = MITSHM_FIRST_ERROR;
  } else if (name === 'SHAPE') {
    present = 1;
    major = SHAPE_MAJOR_OPCODE;
    firstEvent = SHAPE_FIRST_EVENT;
    firstError = SHAPE_FIRST_ERROR;
  }
  ctx.send(makeReply(ctx, 0, (w) => {
    w.card8(present); w.card8(major); w.card8(firstEvent); w.card8(firstError);
    w.pad(20);
  }));
}

function onListExtensions(ctx: RequestContext) {
  const names = ['RENDER', 'XInputExtension', 'SHAPE'];
  if ((globalThis as any).__enable_xkb !== false) names.push('XKEYBOARD');
  if ((globalThis as any).__enable_randr !== false) names.push('RANDR');
  if ((globalThis as any).__enable_shm !== false) names.push('MIT-SHM');
  // Reply: dataByte = numNames, then 24 bytes header, then length-prefixed names
  let bodyLen = 0;
  for (const n of names) bodyLen += 1 + n.length;
  const padded = (bodyLen + 3) & ~3;
  const w = new Writer(32 + padded, ctx.littleEndian);
  w.card8(1); w.card8(names.length);
  w.card16(ctx.sequence);
  w.card32(padded / 4);
  w.pad(24);
  for (const n of names) {
    w.card8(n.length);
    for (let i = 0; i < n.length; i++) w.card8(n.charCodeAt(i));
  }
  while (w.offset < 32 + padded) w.pad(1);
  ctx.send(w.finish());
}

function onGetKeyboardMapping(ctx: RequestContext) {
  const v = reqView(ctx);
  const first = v.getUint8(4);
  const count = v.getUint8(5);
  const perKey = KEYSYMS_PER_KEYCODE;
  const total = count * perKey;
  const keysyms = new Uint32Array(total);
  fillKeysymRange(first, count, perKey, keysyms);
  const w = new Writer(32 + total * 4, ctx.littleEndian);
  w.card8(1); w.card8(perKey);
  w.card16(ctx.sequence);
  w.card32(total);
  w.pad(24);
  for (let i = 0; i < total; i++) w.card32(keysyms[i]!);
  ctx.send(w.finish());
}

function onGetKeyboardControl(ctx: RequestContext) {
  ctx.send(makeReply(ctx, 1, (w) => {
    w.card32(0);
    w.card8(50); w.card8(50);
    w.card16(440); w.card16(100);
    w.pad(2);
    for (let i = 0; i < 32; i++) w.card8(0);
  }));
}

function onGetPointerControl(ctx: RequestContext) {
  ctx.send(makeReply(ctx, 0, (w) => {
    w.card16(2); w.card16(1); w.card16(4); w.pad(18);
  }));
}

function onGetScreenSaver(ctx: RequestContext) {
  ctx.send(makeReply(ctx, 0, (w) => {
    w.card16(600); w.card16(600); w.card8(0); w.card8(0); w.pad(18);
  }));
}

function onListHosts(ctx: RequestContext) {
  // mode=Enabled, 0 hosts. Apps just check whether anyone is excluded.
  ctx.send(makeReply(ctx, 1 /* mode: Enabled */, (w) => {
    w.card16(0);                       // nHosts
    w.pad(22);
  }));
}

function onGetPointerMapping(ctx: RequestContext) {
  const w = new Writer(36, ctx.littleEndian);
  w.card8(1); w.card8(3);
  w.card16(ctx.sequence);
  w.card32(0);
  w.pad(24);
  w.card8(1); w.card8(2); w.card8(3); w.pad(1);
  ctx.send(w.finish());
}

function onGetModifierMapping(ctx: RequestContext) {
  const kPM = Math.max(1, ...MODIFIER_MAP.map((m) => m.length));
  const total = 8 * kPM;
  const w = new Writer(32 + total, ctx.littleEndian);
  w.card8(1); w.card8(kPM);
  w.card16(ctx.sequence);
  w.card32(total / 4);
  w.pad(24);
  for (let i = 0; i < 8; i++) {
    const mod = MODIFIER_MAP[i] ?? [];
    for (let j = 0; j < kPM; j++) w.card8(mod[j] ?? 0);
  }
  ctx.send(w.finish());
}
