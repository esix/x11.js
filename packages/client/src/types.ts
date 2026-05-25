export interface GC {
  id: number;
  foreground: number;
  background: number;
  lineWidth: number;
  arcMode: number;
}

export interface Drawable {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly buffer: OffscreenCanvas;
  readonly ctx: OffscreenCanvasRenderingContext2D;
}

export class Pixmap implements Drawable {
  readonly buffer: OffscreenCanvas;
  readonly ctx: OffscreenCanvasRenderingContext2D;
  owner = 0;

  constructor(
    readonly id: number,
    readonly width: number,
    readonly height: number,
    readonly depth: number,
  ) {
    this.buffer = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    const c = this.buffer.getContext('2d');
    if (!c) throw new Error('OffscreenCanvas 2D context unavailable');
    this.ctx = c;
  }
}

export interface PropertyValue {
  type: number;
  format: 8 | 16 | 32;
  data: Uint8Array;
}

export interface Cursor {
  id: number;
  image: OffscreenCanvas;
  hotspotX: number;
  hotspotY: number;
}

export class Window {
  readonly buffer: OffscreenCanvas;
  readonly ctx: OffscreenCanvasRenderingContext2D;
  readonly properties = new Map<number, PropertyValue>();
  mapped = false;
  // Union of every client's selected event mask. We OR new selections in
  // rather than overwriting, so that one client (e.g. marco) selecting
  // SubstructureNotify on the panel doesn't wipe out the panel-owner's
  // ButtonPress selection. A real X server tracks per-client masks; we
  // settle for the union plus per-event routing to the window owner.
  eventMask = 0;
  owner = 0;
  overrideRedirect = false;
  substructureRedirectClient: number | undefined = undefined;
  substructureNotifyClient: number | undefined = undefined;
  // Cursor active when the pointer is over this window (or inherited from
  // an ancestor when this is 0). Set via CWCursor in window attributes.
  cursor = 0;
  // Z-order key within siblings. Higher draws on top. Compositor sorts by
  // this per parent. Default seeded at create; raise/lower updates it.
  stackOrder = 0;

  constructor(
    readonly id: number,
    public parent: number,
    public x: number,
    public y: number,
    public width: number,
    public height: number,
    public backgroundPixel: number,
  ) {
    this.buffer = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    const c = this.buffer.getContext('2d');
    if (!c) throw new Error('OffscreenCanvas 2D context unavailable');
    this.ctx = c;
    this.paintBackground(0, 0, width, height);
  }

  paintBackground(x: number, y: number, w: number, h: number) {
    this.ctx.fillStyle = pixelToCss(this.backgroundPixel);
    this.ctx.fillRect(x, y, w, h);
  }
}

export function pixelToCss(pixel: number): string {
  const r = (pixel >> 16) & 0xff;
  const g = (pixel >> 8) & 0xff;
  const b = pixel & 0xff;
  return `rgb(${r}, ${g}, ${b})`;
}

export interface PointerGrab {
  client: number;
  window: number;
  eventMask: number;
  ownerEvents: boolean;
  // True when this grab was activated by a passive button grab firing on a
  // ButtonPress. In that case it auto-releases on the matching ButtonRelease.
  fromPassiveGrab?: boolean;
  passiveButton?: number;
}

// X11 event mask bits (subset)
export const EVENT_MASK = {
  KeyPress: 0x00000001,
  KeyRelease: 0x00000002,
  ButtonPress: 0x00000004,
  ButtonRelease: 0x00000008,
  EnterWindow: 0x00000010,
  LeaveWindow: 0x00000020,
  PointerMotion: 0x00000040,
  PointerMotionHint: 0x00000080,
  Button1Motion: 0x00000100,
  Button2Motion: 0x00000200,
  Button3Motion: 0x00000400,
  Button4Motion: 0x00000800,
  Button5Motion: 0x00001000,
  ButtonMotion: 0x00002000,
  Exposure: 0x00008000,
  StructureNotify: 0x00020000,
  SubstructureNotify: 0x00080000,
  SubstructureRedirect: 0x00100000,
  PropertyChange: 0x00400000,
} as const;
