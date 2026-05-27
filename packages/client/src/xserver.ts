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
  // The window with the X input focus. GTK apps watch FocusIn/FocusOut to
  // decide whether their toplevel is "active"; some (gnome-mines) ignore
  // board input entirely until active. metacity sets focus via SetInputFocus,
  // which used to be a no-op — so those apps never activated. We track focus
  // here, answer GetInputFocus truthfully, and emit FocusIn/FocusOut.
  private inputFocus = 0;             // 0 = None, 1 = root/PointerRoot
  // Window holding the implicit pointer grab (a button is held). 0 = none.
  private implicitGrabWindow = 0;
  // Active keyboard grab (XGrabKeyboard). GTK menus grab the keyboard on
  // popup so arrow-key navigation and type-ahead reach the menu rather than
  // the toplevel underneath; we route all key events to the grab window while
  // it's set. undefined = no grab.
  private keyboardGrab: { window: number; client: number; ownerEvents: boolean } | undefined = undefined;

  // Passive button grabs: mate-panel installs these on its top-level window
  // for the Applications/Places/System buttons. Without honoring them, the
  // panel's eventMask doesn't include ButtonPress and clicks vanish.
  // Keyed by window id; matched on (button, modifiers) at press time.
  private passiveButtonGrabs = new Map<number, Array<{
    button: number;          // 0 = AnyButton
    modifiers: number;       // 0x8000 = AnyModifier
    eventMask: number;
    ownerEvents: boolean;
    client: number;
    pointerMode: number;     // 0 = Synchronous, 1 = Asynchronous
  }>>();
  // A Synchronous passive grab that has fired and is now waiting for the
  // grabbing client to call AllowEvents. metacity uses this for click-to-focus:
  // it grabs Button1 (Sync) on every managed window, receives the press,
  // focuses the window, then calls AllowEvents(ReplayPointer) to let the click
  // reach the application. Until then the pointer is "frozen" and we hold the
  // info needed to replay the press (and a release if it arrives meanwhile).
  private frozenSyncGrab: {
    grabClient: number;
    button: number;
    replayHit: Window;       // window the press would reach without the grab
    stateBefore: number;
    releaseQueued: boolean;
  } | undefined = undefined;

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
    if (this.keyboardGrab && this.keyboardGrab.client === clientId) {
      this.keyboardGrab = undefined;
    }

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

    // Crossing events (Enter/Leave) flow during pointer grabs too — GTK menus
    // grab the pointer when they open and rely on Enter/Leave to highlight
    // the menu item under the pointer. Without these, clicks land but the
    // menu doesn't know which item the pointer is over and nothing activates.
    const hit = this.windowAt(rootX, rootY);
    this.maybeCrossing(hit);
    this.windowUnderPointer = hit?.id ?? 0;

    if (this.activeGrab) {
      const target = this.pickGrabTarget(motionMask);
      if (target) this.emit(target, 6, 0, this.activeGrab.client);
      this.renderer.setPointer(rootX, rootY, this.effectiveCursor());
      return;
    }

    // During an implicit grab (button held), motion goes to the grab window.
    if (this.implicitGrabWindow) {
      const gw = this.windows.get(this.implicitGrabWindow);
      if (gw && (gw.eventMask & motionMask)) this.emit(gw, 6 /* MotionNotify */, 0);
      this.renderer.setPointer(rootX, rootY, this.effectiveCursor());
      return;
    }

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

    // Pointer is frozen by a Synchronous passive grab waiting on AllowEvents.
    // Hold the release so it can be replayed to the app after the grabbing
    // client (e.g. metacity) calls AllowEvents(ReplayPointer).
    if (this.frozenSyncGrab) {
      if (!pressed && this.frozenSyncGrab.button === button) {
        this.frozenSyncGrab.releaseQueued = true;
      }
      return;
    }

    if (this.activeGrab) {
      const target = this.pickGrabTarget(eventMask);
      if (target) this.emit(target, pressed ? 4 : 5, button, this.activeGrab.client, stateBefore);
      // Auto-release passive-grab promotion on the matching button release.
      if (!pressed && this.activeGrab.fromPassiveGrab && this.activeGrab.passiveButton === button) {
        this.activeGrab = undefined;
      }
      return;
    }

    // Implicit pointer grab: per X core semantics, a normal button press grabs
    // the pointer to the receiving window until ALL buttons are released, so
    // the release reaches the same window even if the pointer moved. Crucially
    // it also survives the client calling XUngrabPointer — gnome-mines' tiles
    // do exactly that on every press (event.get_seat().ungrab()), and without
    // the implicit grab the release was never delivered and the cell never
    // revealed.
    if (this.implicitGrabWindow) {
      const gw = this.windows.get(this.implicitGrabWindow);
      if (gw && (gw.eventMask & eventMask)) this.emit(gw, pressed ? 4 : 5, button, gw.owner, stateBefore);
      if (!pressed && (this.buttonState & 0x1f00) === 0) this.implicitGrabWindow = 0;
      return;
    }

    const hit = this.windowAt(this.pointerX, this.pointerY);
    if (!hit) return;

    // On ButtonPress, check for a passive button grab on the hit window or any
    // ancestor. Two kinds matter here:
    //   - Asynchronous grabs (GTK menu activation): promote to an active grab
    //     and deliver to the grab window; events keep flowing.
    //   - Synchronous grabs (metacity click-to-focus): deliver the press to the
    //     grabbing client, then FREEZE until it calls AllowEvents. On
    //     ReplayPointer we re-deliver this press to the application, so the
    //     click is not swallowed by the WM's focus grab.
    if (pressed) {
      const promoted = this.findPassiveButtonGrab(hit, button, stateBefore);
      if (promoted) {
        this.emit(promoted.window, 4 /* ButtonPress */, button, promoted.grab.client, stateBefore);
        if (promoted.grab.pointerMode === 0 /* Synchronous */) {
          this.frozenSyncGrab = {
            grabClient: promoted.grab.client,
            button,
            replayHit: hit,
            stateBefore,
            releaseQueued: false,
          };
        } else {
          this.activeGrab = {
            client: promoted.grab.client,
            window: promoted.window.id,
            eventMask: promoted.grab.eventMask,
            ownerEvents: promoted.grab.ownerEvents,
            fromPassiveGrab: true,
            passiveButton: button,
          };
        }
        return;
      }
    }

    const target = this.deliverButtonToApp(hit, button, pressed, stateBefore);
    // Start the implicit grab on the window that received the press.
    if (pressed && target) this.implicitGrabWindow = target.id;
    else if (!pressed && (this.buttonState & 0x1f00) === 0) this.implicitGrabWindow = 0;
  }

  /** Deliver a button event by walking hit→ancestors to the first window that
   *  selected it (X11 propagation), ignoring passive grabs. Used both for
   *  normal delivery and for replaying a press after AllowEvents(ReplayPointer).
   *  Returns the window that received the event (the implicit-grab window). */
  private deliverButtonToApp(hit: Window, button: number, pressed: boolean, state: number): Window | undefined {
    const eventMask = pressed ? EVENT_MASK.ButtonPress : EVENT_MASK.ButtonRelease;
    let cur: Window | undefined = hit;
    while (cur) {
      if (cur.eventMask & eventMask) {
        this.emit(cur, pressed ? 4 : 5, button, cur.owner, state);
        return cur;
      }
      if (cur.id === ROOT_WINDOW_ID) break;
      cur = this.windows.get(cur.parent);
    }
    return undefined;
  }

  /**
   * AllowEvents (opcode 53). We only act on ReplayPointer (mode 2): release the
   * frozen synchronous grab and replay the triggering press — and any release
   * that arrived while frozen — to the application as if the grab never
   * happened. Other modes just thaw. This is what makes metacity's
   * click-to-focus pass the click through to the app (e.g. gnome-mines'
   * difficulty buttons).
   */
  allowEvents(mode: number) {
    const frozen = this.frozenSyncGrab;
    if (!frozen) return;
    this.frozenSyncGrab = undefined;
    if (mode === 2 /* ReplayPointer */) {
      // Replay the press to the app AND establish the implicit pointer grab on
      // the receiving window, exactly as a normal (un-grabbed) press would.
      // Without this, a window whose press handler calls gdk_seat_ungrab
      // (gnome-mines' tiles) found no implicit grab to release, so
      // ungrabPointer emitted no Ungrab crossing, GDK never re-synced, and the
      // matching button-release was never dispatched — the cell never revealed.
      const target = this.deliverButtonToApp(frozen.replayHit, frozen.button, true, frozen.stateBefore);
      if (target) this.implicitGrabWindow = target.id;
      if (frozen.releaseQueued) {
        const relState = frozen.stateBefore | (1 << (7 + frozen.button));
        this.deliverButtonToApp(frozen.replayHit, frozen.button, false, relState);
        if ((this.buttonState & 0x1f00) === 0) this.implicitGrabWindow = 0;
      }
    }
  }

  /** Set the X input focus. What GTK actually cares about is whether focus is
   *  inside a given TOPLEVEL (it derives window-active state from FocusIn/Out
   *  on the toplevel). So we track focus at toplevel granularity: emit FocusOut
   *  on the old toplevel and FocusIn on the new one ONLY when the toplevel
   *  actually changes.
   *
   *  Doing this per-window (with the full ancestor chain) caused focus to
   *  FLAP: GTK CSD apps take focus on a child input/proxy window right after
   *  mapping, and sending FocusOut(toplevel)+FocusIn(toplevel) for that
   *  intra-toplevel move made GTK see the toplevel lose-then-regain focus.
   *  gnome-mines auto-pauses on each focus-out and won't auto-resume, so the
   *  board ended up paused and rejected every click.
   *  `window`: 0/None, 1/PointerRoot, or a window id. */
  setInputFocus(window: number) {
    if (window === this.inputFocus) return;
    const oldTop = this.toplevelOf(this.inputFocus);
    const newTop = this.toplevelOf(window);
    this.inputFocus = window;
    if (oldTop === newTop) return;     // focus stayed within one toplevel
    if (oldTop) this.sendFocusEvent(oldTop, 10 /* FocusOut */, 3 /* Nonlinear */);
    if (newTop) this.sendFocusEvent(newTop, 9 /* FocusIn */, 3 /* Nonlinear */);
  }

  getInputFocus(): number {
    return this.inputFocus || ROOT_WINDOW_ID;
  }

  /** The toplevel (direct child of root) containing `wid`, or undefined for
   *  None/root. */
  private toplevelOf(wid: number): Window | undefined {
    let cur = this.windows.get(wid);
    if (!cur || cur.id === ROOT_WINDOW_ID) return undefined;
    while (cur && cur.parent !== ROOT_WINDOW_ID) cur = this.windows.get(cur.parent);
    return cur;
  }

  /** FocusIn (9) / FocusOut (10). Only delivered to a client that selected
   *  FocusChange on the window. Layout: detail, seq, event-window, mode, pad. */
  private sendFocusEvent(win: Window, type: 9 | 10, detail: number) {
    if (!(win.eventMask & EVENT_MASK.FocusChange)) return;
    const s = this.clients.get(win.owner);
    if (!s) return;
    const w = new Writer(32, s.littleEndian);
    w.card8(type);
    w.card8(detail);
    w.card16(s.sequence);
    w.card32(win.id);                  // event window
    w.card8(0);                        // mode: NotifyNormal
    w.pad(23);
    this.onSend(win.owner, w.finish());
  }

  /** Walk hit→ancestors looking for a passive button grab whose (button,
   *  modifiers) matches the press. Returns the grab + the window it was
   *  installed on (delivery target). */
  private findPassiveButtonGrab(hit: Window, button: number, state: number)
      : { grab: { client: number; eventMask: number; ownerEvents: boolean; pointerMode: number }; window: Window } | undefined {
    // X masks the press modifiers against ~LockMask + ~NumLockMask before
    // matching; we keep it simple — Lock (bit 1) is ignored, everything else
    // must equal-match unless the grab uses AnyModifier (0x8000).
    const effectiveMods = state & ~0x02 & 0xffff;
    let cur: Window | undefined = hit;
    while (cur) {
      const grabs = this.passiveButtonGrabs.get(cur.id);
      if (grabs) {
        for (const g of grabs) {
          const buttonMatch = g.button === 0 /* AnyButton */ || g.button === button;
          const modsMatch = g.modifiers === 0x8000 /* AnyModifier */ || g.modifiers === effectiveMods;
          if (buttonMatch && modsMatch) {
            return { grab: g, window: cur };
          }
        }
      }
      if (cur.id === ROOT_WINDOW_ID) break;
      cur = this.windows.get(cur.parent);
    }
    return undefined;
  }

  addPassiveButtonGrab(window: number, button: number, modifiers: number,
                       eventMask: number, ownerEvents: boolean, client: number,
                       pointerMode: number) {
    let list = this.passiveButtonGrabs.get(window);
    if (!list) { list = []; this.passiveButtonGrabs.set(window, list); }
    // Replace any existing (button, modifiers) grab on this window.
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i]!;
      if (g.button === button && g.modifiers === modifiers) list.splice(i, 1);
    }
    list.push({ button, modifiers, eventMask, ownerEvents, client, pointerMode });
  }

  removePassiveButtonGrab(window: number, button: number, modifiers: number) {
    const list = this.passiveButtonGrabs.get(window);
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i]!;
      const btnMatch = button === 0 || g.button === 0 || g.button === button;
      const modMatch = modifiers === 0x8000 || g.modifiers === 0x8000 || g.modifiers === modifiers;
      if (btnMatch && modMatch) list.splice(i, 1);
    }
    if (list.length === 0) this.passiveButtonGrabs.delete(window);
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

  /** XUngrabPointer from `clientId`. Releases that client's active grab AND the
   *  implicit button grab, then emits an Ungrab crossing (EnterNotify
   *  mode=Ungrab) to the window now under the pointer. GDK relies on that
   *  crossing to re-sync its pointer state after a grab ends; without it, a
   *  GtkButton that calls gdk_seat_ungrab in its press handler (gnome-mines'
   *  tiles) never dispatches the matching button-release, so cells don't
   *  reveal. */
  ungrabPointer(clientId: number) {
    let released = false;
    if (this.activeGrab && this.activeGrab.client === clientId) {
      this.activeGrab = undefined;
      released = true;
    }
    if (this.implicitGrabWindow) {
      const gw = this.windows.get(this.implicitGrabWindow);
      if (gw && gw.owner === clientId) { this.implicitGrabWindow = 0; released = true; }
    }
    if (!released) return;
    const now = this.windowAt(this.pointerX, this.pointerY);
    this.windowUnderPointer = now?.id ?? 0;
    if (now && (now.eventMask & EVENT_MASK.EnterWindow)) {
      this.emitCrossing(now, 7 /* EnterNotify */, 2 /* NotifyUngrab */);
    }
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
    // Determine the source window per X11 keyboard delivery, then propagate up
    // to the first ancestor that selected the event. (Emacs, for instance,
    // selects keys on its top-level frame, not the inner buffer window.)
    const mask = pressed ? EVENT_MASK.KeyPress : EVENT_MASK.KeyRelease;
    let cur = this.keyEventSource();
    while (cur) {
      if (cur.eventMask & mask) {
        this.emit(cur, pressed ? 2 : 3, keycode & 0xff);
        return;
      }
      if (cur.id === ROOT_WINDOW_ID) break;
      cur = this.windows.get(cur.parent);
    }
  }

  /** The window a key event originates from, before upward propagation.
   *
   *  X11 sends key events to the INPUT FOCUS window, not the window under the
   *  pointer. We used to route every key by `windowUnderPointer` — effectively
   *  focus-follows-mouse for the keyboard — so typing while the pointer wasn't
   *  hovering the target (the normal case: you click a window to focus it, then
   *  type with the mouse at rest elsewhere) went nowhere. GTK toplevels take
   *  the X focus on a dedicated 1×1 focus window that selects KeyPress, so
   *  delivering to the focus window lands keys in the right app. */
  private keyEventSource(): Window | undefined {
    // An active keyboard grab (e.g. an open GTK menu) takes all key events,
    // as long as its window is still mapped — menus grab on popup and ungrab
    // on popdown. Drop a stale grab if its window vanished.
    if (this.keyboardGrab) {
      const gw = this.windows.get(this.keyboardGrab.window);
      if (gw && gw.mapped) return gw;
      this.keyboardGrab = undefined;
    }
    const focus = this.inputFocus;
    // None (0) / PointerRoot (1): keyboard follows the pointer.
    if (focus <= 1) return this.windows.get(this.windowUnderPointer);
    const focusWin = this.windows.get(focus);
    if (!focusWin) return this.windows.get(this.windowUnderPointer);
    // If the pointer is inside the focus window or one of its inferiors, the
    // event originates at the pointer window; otherwise at the focus window.
    const pw = this.windows.get(this.windowUnderPointer);
    if (pw && this.isInferiorOrEqual(pw, focusWin.id)) return pw;
    return focusWin;
  }

  /** True if `w` is `ancestorId` or a descendant of it. */
  private isInferiorOrEqual(w: Window, ancestorId: number): boolean {
    let cur: Window | undefined = w;
    while (cur) {
      if (cur.id === ancestorId) return true;
      if (cur.id === ROOT_WINDOW_ID) return false;
      cur = this.windows.get(cur.parent);
    }
    return false;
  }

  /** XGrabKeyboard from `client` on `window`. */
  grabKeyboard(window: number, client: number, ownerEvents: boolean) {
    this.keyboardGrab = { window, client, ownerEvents };
  }

  /** XUngrabKeyboard — only the grabbing client may release its own grab. */
  ungrabKeyboard(client: number) {
    if (this.keyboardGrab && this.keyboardGrab.client === client) {
      this.keyboardGrab = undefined;
    }
  }

  private maybeCrossing(now: Window | undefined) {
    if ((now?.id ?? 0) === this.windowUnderPointer) return;
    const prev = this.windows.get(this.windowUnderPointer);
    if (prev && (prev.eventMask & EVENT_MASK.LeaveWindow)) {
      this.emitCrossing(prev, 8 /* LeaveNotify */, 0 /* Normal */);
    }
    if (now && (now.eventMask & EVENT_MASK.EnterWindow)) {
      this.emitCrossing(now, 7 /* EnterNotify */, 0 /* Normal */);
    }
  }

  /** Crossing-event (Enter/Leave) emit. These events have `mode` at byte 30
   *  and `focus|same_screen` at byte 31 — different from button/motion which
   *  put `same_screen` at byte 30. Using {@link emit} for crossings made GTK
   *  read every Enter as Mode=Grab and stopped menu hover from updating.
   *  mode: 0=Normal, 1=Grab, 2=Ungrab. (GDK aborts on 3=WhileGrabbed.) */
  private emitCrossing(win: Window, type: 7 | 8, mode: number) {
    const s = this.clients.get(win.owner);
    if (!s) return;
    const sp = this.screenPosOf(win.id);
    const ex = this.pointerX - sp.x;
    const ey = this.pointerY - sp.y;
    const w = new Writer(32, s.littleEndian);
    w.card8(type);
    w.card8(0);                        // detail: Ancestor (good enough for siblings)
    w.card16(s.sequence);
    w.card32(Date.now() & 0xffffffff);
    w.card32(ROOT_WINDOW_ID);
    w.card32(win.id);
    w.card32(0);                       // child
    w.int16(this.pointerX); w.int16(this.pointerY);
    w.int16(ex); w.int16(ey);
    const state = this.buttonState | this.modifierState;
    w.card16(state & 0xffff);
    w.card8(mode);                     // mode (byte 30)
    // byte 31 flags: bit0 (0x01)=focus, bit1 (0x02)=same-screen. We're always
    // on one screen and don't model X input focus here, so set same-screen.
    w.card8(0x02);
    this.onSend(win.owner, w.finish());
  }

  private windowAt(x: number, y: number): Window | undefined {
    // X11 hit-test: at each level, among the mapped children containing (x, y),
    // the one highest in z-order wins; then descend into it. We MUST sort by
    // stackOrder here — relying on Map insertion order is wrong once windows
    // overlap across stacking changes. (Bug seen: an Applications submenu and a
    // game window both covered the pointer; insertion order returned the game,
    // so menu hover/clicks were delivered to the wrong window.)
    const pick = (parentId: number, ox: number, oy: number): Window | undefined => {
      let top: Window | undefined;
      for (const w of this.windows.values()) {
        if (w.parent !== parentId || !w.mapped) continue;
        const ax = ox + w.x, ay = oy + w.y;
        if (x < ax || y < ay || x >= ax + w.width || y >= ay + w.height) continue;
        if (!top || w.stackOrder > top.stackOrder) top = w;
      }
      if (!top) return undefined;
      const deeper = pick(top.id, ox + top.x, oy + top.y);
      return deeper ?? top;
    };
    return pick(ROOT_WINDOW_ID, 0, 0);
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
        addPassiveButtonGrab: (w, btn, mods, em, oe, cl, pm) =>
          this.addPassiveButtonGrab(w, btn, mods, em, oe, cl, pm),
        removePassiveButtonGrab: (w, btn, mods) =>
          this.removePassiveButtonGrab(w, btn, mods),
        allowEvents: (mode) => this.allowEvents(mode),
        setInputFocus: (window) => this.setInputFocus(window),
        getInputFocus: () => this.getInputFocus(),
        ungrabPointer: (cid) => this.ungrabPointer(cid),
        grabKeyboard: (window, oe) => this.grabKeyboard(window, clientId, oe),
        ungrabKeyboard: (cid) => this.ungrabKeyboard(cid),
        pointerX: this.pointerX,
        pointerY: this.pointerY,
        buttonState: this.buttonState | this.modifierState,
      };
      handleRequest(ctx);
      s.buffer = s.buffer.subarray(len);
    }
  }
}
