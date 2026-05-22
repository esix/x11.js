import { tryParseSetup, buildSetupSuccess, allocResourceIdBase } from './setup.js';
import { Writer, concatBytes } from './wire.js';
import type { Renderer } from './renderer.js';
import { Window, Pixmap, EVENT_MASK, type GC, type PointerGrab, type Cursor } from './types.js';
import { MODIFIER_MAP } from './keyboard.js';
import { handleRequest, type RequestContext } from './handlers.js';
import { createRenderState, type RenderState } from './render.js';

interface ClientState {
  littleEndian: boolean;
  buffer: Uint8Array;
  phase: 'setup' | 'main';
  sequence: number;
  resourceIdBase: number;
  gcs: Map<number, GC>;
}

const SCREEN_W = 1024;
const SCREEN_H = 768;
const ROOT_WINDOW_ID = 1;
const ROOT_VISUAL_ID = 0x21;

export class XServer {
  private clients = new Map<number, ClientState>();
  // Windows and pixmaps are global: IDs are unique across clients (per
  // resource-id-base ranges) and input delivery needs to look up windows by
  // ID across clients.
  private windows = new Map<number, Window>();
  private pixmaps = new Map<number, Pixmap>();
  private cursors = new Map<number, Cursor>();
  private render: RenderState = createRenderState();
  private pointerX = 0;
  private pointerY = 0;
  private buttonState = 0;
  private modifierState = 0;          // Shift/Lock/Control/Mod1 bits
  private windowUnderPointer = 0;     // 0 = root
  private activeGrab: PointerGrab | undefined = undefined;

  onSend: (clientId: number, bytes: Uint8Array) => void = () => {};
  onCloseClient: (clientId: number) => void = () => {};

  constructor(private readonly renderer: Renderer) {
    this.renderer.setScreen(SCREEN_W, SCREEN_H);
    // Root is a real Window so window managers can attach event masks to it
    // (SubstructureRedirect/Notify) and QueryTree(root) returns its children.
    const root = new Window(ROOT_WINDOW_ID, 0, 0, 0, SCREEN_W, SCREEN_H, 0);
    root.mapped = true;
    root.owner = 0;
    this.windows.set(ROOT_WINDOW_ID, root);
  }

  feed(clientId: number, bytes: Uint8Array) {
    let s = this.clients.get(clientId);
    if (!s) {
      s = {
        littleEndian: true,
        buffer: new Uint8Array(0),
        phase: 'setup',
        sequence: 0,
        resourceIdBase: 0,
        gcs: new Map(),
      };
      this.clients.set(clientId, s);
    }
    s.buffer = concatBytes(s.buffer, bytes);
    this.process(clientId, s);
  }

  dropClient(clientId: number) {
    const s = this.clients.get(clientId);
    if (!s) return;
    this.clients.delete(clientId);

    // Collect windows to destroy first so SubstructureNotify subscribers
    // (window managers) can be notified BEFORE the windows disappear from
    // the map. Without these synthesized DestroyNotify events, twm leaves
    // orphan frames behind when an app exits, and a fresh launch overlaps
    // with the old frame's title-only ghost.
    const toDestroy: Array<{ wid: number; parent: number }> = [];
    for (const [wid, win] of this.windows) {
      if (win.owner === clientId) toDestroy.push({ wid, parent: win.parent });
    }
    for (const { wid, parent: parentId } of toDestroy) {
      const parent = this.windows.get(parentId);
      const target = parent?.substructureNotifyClient;
      if (target !== undefined && target !== clientId) {
        this.sendDestroyNotify(target, parentId, wid);
      }
    }
    for (const { wid } of toDestroy) {
      this.windows.delete(wid);
      this.renderer.removeWindow(wid);
    }
    for (const [pid, px] of this.pixmaps) {
      if (px.owner === clientId) this.pixmaps.delete(pid);
    }
  }

  private sendDestroyNotify(targetClient: number, eventWindow: number, window: number) {
    const cs = this.clients.get(targetClient);
    if (!cs) return;
    const w = new Writer(32, cs.littleEndian);
    w.card8(17);                       // DestroyNotify
    w.card8(0);
    w.card16(cs.sequence);
    w.card32(eventWindow);
    w.card32(window);
    w.pad(20);
    this.onSend(targetClient, w.finish());
  }

  // ---- input (called from the DOM event listeners in main.ts) ----

  setPointer(rootX: number, rootY: number) {
    if (rootX === this.pointerX && rootY === this.pointerY) return;
    this.pointerX = rootX;
    this.pointerY = rootY;

    const motionMask = EVENT_MASK.PointerMotion |
      (this.buttonState ? (EVENT_MASK.ButtonMotion | (this.buttonState & 0x1f00)) : 0);

    if (this.activeGrab) {
      const target = this.pickGrabTarget(motionMask);
      if (target) this.emit(target, 6, 0, this.activeGrab.client);
      this.renderer.setPointer(rootX, rootY, this.effectiveCursor());
      return;
    }

    const hit = this.windowAt(rootX, rootY);
    this.maybeCrossing(hit);
    this.windowUnderPointer = hit?.id ?? 0;
    if (hit && (hit.eventMask & motionMask)) {
      this.emit(hit, 6 /* MotionNotify */, 0);
    }
    this.renderer.setPointer(rootX, rootY, this.effectiveCursor());
  }

  /** Cursor that applies at the pointer's current position. CWCursor cascades:
   *  if a window has cursor=0 we inherit from its parent, all the way to root. */
  private effectiveCursor(): Cursor | undefined {
    let cur: Window | undefined = this.windowAt(this.pointerX, this.pointerY)
      ?? this.windows.get(ROOT_WINDOW_ID);
    while (cur) {
      if (cur.cursor) {
        const c = this.cursors.get(cur.cursor);
        if (c) return c;
      }
      if (cur.id === ROOT_WINDOW_ID) break;
      cur = this.windows.get(cur.parent);
    }
    return undefined;
  }

  pointerButton(button: number, pressed: boolean) {
    if (button < 1 || button > 5) return;
    const bit = 1 << (7 + button);     // Button1Mask = 0x100, etc.

    // Per X spec, the `state` field of ButtonPress/ButtonRelease is the
    // modifier+button state *just before* the event.
    const stateBefore = this.buttonState | this.modifierState;
    if (pressed) this.buttonState |= bit;
    else this.buttonState &= ~bit;

    const eventMask = pressed ? EVENT_MASK.ButtonPress : EVENT_MASK.ButtonRelease;

    if (this.activeGrab) {
      const target = this.pickGrabTarget(eventMask);
      if (target) this.emit(target, pressed ? 4 : 5, button, this.activeGrab.client, stateBefore);
      return;
    }

    const hit = this.windowAt(this.pointerX, this.pointerY);
    if (!hit) return;
    if (hit.eventMask & eventMask) this.emit(hit, pressed ? 4 : 5, button, hit.owner, stateBefore);
  }

  /**
   * Resolve the target window for a pointer event during a grab.
   *
   * With owner_events=True, X spec says the event is delivered "as if" no grab
   * existed when the window under the pointer (or one of its ancestors) is
   * owned by the grabbing client and selects the event; otherwise it falls
   * back to the grab window. With owner_events=False, it always goes to the
   * grab window. The window choice changes the event-coordinate frame, which
   * window managers (twm) rely on for drag math.
   */
  private pickGrabTarget(eventMask: number): Window | undefined {
    const grab = this.activeGrab;
    if (!grab) return undefined;
    if (grab.ownerEvents) {
      let cur: Window | undefined = this.windowAt(this.pointerX, this.pointerY);
      while (cur) {
        if (cur.owner === grab.client && (cur.eventMask & eventMask)) return cur;
        cur = this.windows.get(cur.parent);
      }
    }
    if (!(grab.eventMask & eventMask)) return undefined;
    return this.windows.get(grab.window);
  }

  setActiveGrab(grab: PointerGrab | undefined) {
    this.activeGrab = grab;
  }
  getActiveGrab(): PointerGrab | undefined {
    return this.activeGrab;
  }

  key(keycode: number, pressed: boolean) {
    // Update modifier-state bitmask if this keycode is a modifier.
    for (let i = 0; i < MODIFIER_MAP.length; i++) {
      if (MODIFIER_MAP[i]!.includes(keycode)) {
        const bit = 1 << i;
        if (pressed) this.modifierState |= bit;
        else this.modifierState &= ~bit;
      }
    }
    // Key events propagate up the window tree: if the leaf doesn't have
    // KeyPress/Release selected, the parent gets it, and so on. Emacs only
    // selects key events on its top-level frame, not the inner buffer window.
    const mask = pressed ? EVENT_MASK.KeyPress : EVENT_MASK.KeyRelease;
    let cur: Window | undefined = this.windows.get(this.windowUnderPointer);
    while (cur) {
      if (cur.eventMask & mask) {
        this.emit(cur, pressed ? 2 : 3, keycode & 0xff);
        return;
      }
      if (cur.id === ROOT_WINDOW_ID) break;
      cur = this.windows.get(cur.parent);
    }
  }

  private maybeCrossing(now: Window | undefined) {
    if ((now?.id ?? 0) === this.windowUnderPointer) return;
    const prev = this.windows.get(this.windowUnderPointer);
    if (prev && (prev.eventMask & EVENT_MASK.LeaveWindow)) {
      this.emit(prev, 8 /* LeaveNotify */, 0);
    }
    if (now && (now.eventMask & EVENT_MASK.EnterWindow)) {
      this.emit(now, 7 /* EnterNotify */, 0);
    }
  }

  private windowAt(x: number, y: number): Window | undefined {
    // Walk the window tree from root, accumulating parent offsets. The deepest
    // mapped window containing (x, y) is the topmost in z-order — that's the
    // X11 hit-test rule.
    let best: Window | undefined;
    const visit = (parentId: number, ox: number, oy: number) => {
      for (const w of this.windows.values()) {
        if (w.parent !== parentId) continue;
        if (!w.mapped) continue;
        const ax = ox + w.x;
        const ay = oy + w.y;
        if (x < ax || y < ay) continue;
        if (x >= ax + w.width || y >= ay + w.height) continue;
        best = w;
        visit(w.id, ax, ay);
      }
    };
    visit(ROOT_WINDOW_ID, 0, 0);
    return best;
  }

  /** Absolute screen position of `wid` accumulated through its parents. */
  private screenPosOf(wid: number): { x: number; y: number } {
    let x = 0, y = 0;
    let cur = this.windows.get(wid);
    while (cur && cur.id !== ROOT_WINDOW_ID) {
      x += cur.x;
      y += cur.y;
      cur = this.windows.get(cur.parent);
    }
    return { x, y };
  }

  private emit(
    win: Window, type: number, detail: number,
    targetClient: number = win.owner, stateOverride?: number,
  ) {
    const s = this.clients.get(targetClient);
    if (!s) return;
    const sp = this.screenPosOf(win.id);
    const ex = this.pointerX - sp.x;
    const ey = this.pointerY - sp.y;
    const w = new Writer(32, s.littleEndian);
    w.card8(type);
    w.card8(detail);
    w.card16(s.sequence);
    w.card32(Date.now() & 0xffffffff);
    w.card32(ROOT_WINDOW_ID);
    w.card32(win.id);
    w.card32(0);                       // child
    w.int16(this.pointerX); w.int16(this.pointerY);
    w.int16(ex); w.int16(ey);
    const state = stateOverride ?? (this.buttonState | this.modifierState);
    w.card16(state & 0xffff);
    w.card8(1);                        // same-screen
    w.card8(0);                        // unused
    this.onSend(targetClient, w.finish());
  }

  // ---- request processing ----

  private process(clientId: number, s: ClientState) {
    if (s.phase === 'setup') {
      const r = tryParseSetup(s.buffer);
      if (r.status === 'incomplete') return;
      if (r.status === 'fail') {
        console.error(`[client ${clientId}] setup failed: ${r.reason}`);
        this.onCloseClient(clientId);
        return;
      }
      s.littleEndian = r.littleEndian;
      const { base, mask } = allocResourceIdBase();
      s.resourceIdBase = base;
      const reply = buildSetupSuccess({
        littleEndian: r.littleEndian,
        resourceIdBase: base,
        resourceIdMask: mask,
        screen: { width: SCREEN_W, height: SCREEN_H, rootWindow: ROOT_WINDOW_ID, rootVisual: ROOT_VISUAL_ID },
      });
      this.onSend(clientId, reply);
      s.buffer = s.buffer.subarray(r.consumed);
      s.phase = 'main';
      console.log(`[client ${clientId}] setup ok, idBase=0x${base.toString(16)}`);
    }

    while (s.phase === 'main' && s.buffer.byteLength >= 4) {
      const view = new DataView(s.buffer.buffer, s.buffer.byteOffset, s.buffer.byteLength);
      const opcode = view.getUint8(0);
      const dataByte = view.getUint8(1);
      const len4 = view.getUint16(2, s.littleEndian);
      let len = len4 * 4;
      let bodyOffset = 4;
      if (len4 === 0) {
        if (s.buffer.byteLength < 8) return;
        len = view.getUint32(4, s.littleEndian) * 4;
        bodyOffset = 8;
      }
      if (len < 4 || s.buffer.byteLength < len) return;
      const reqBytes = s.buffer.subarray(0, len);
      s.sequence = (s.sequence + 1) & 0xffff;
      const ctx: RequestContext = {
        clientId,
        opcode,
        requestData: dataByte,
        sequence: s.sequence,
        littleEndian: s.littleEndian,
        bytes: reqBytes,
        bodyOffset,
        windows: this.windows,
        pixmaps: this.pixmaps,
        gcs: s.gcs,
        cursors: this.cursors,
        render: this.render,
        rootWindowId: ROOT_WINDOW_ID,
        renderer: this.renderer,
        send: (bytes) => this.onSend(clientId, bytes),
        sendTo: (cid, bytes) => this.onSend(cid, bytes),
        clientInfo: (cid) => {
          const cs = this.clients.get(cid);
          return cs ? { sequence: cs.sequence, littleEndian: cs.littleEndian } : undefined;
        },
        setActiveGrab: (g) => this.setActiveGrab(g),
        getActiveGrab: () => this.getActiveGrab(),
        pointerX: this.pointerX,
        pointerY: this.pointerY,
        buttonState: this.buttonState | this.modifierState,
      };
      handleRequest(ctx);
      s.buffer = s.buffer.subarray(len);
    }
  }
}
