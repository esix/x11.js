import type { Window, Cursor } from './types.js';

const ROOT_WINDOW_ID = 1;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private screenW = 1024;
  private screenH = 768;
  private windows = new Map<number, Window>();
  private rafPending = false;
  private pointerX = 0;
  private pointerY = 0;
  private cursor: Cursor | undefined;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.canvas.style.cursor = 'none';   // hide the browser cursor — we draw our own
    this.compose();
  }

  setPointer(x: number, y: number, cursor: Cursor | undefined) {
    this.pointerX = x;
    this.pointerY = y;
    if (this.cursor !== cursor) this.cursor = cursor;
    this.invalidate();
  }

  setScreen(w: number, h: number) {
    this.canvas.width = w;
    this.canvas.height = h;
    this.screenW = w;
    this.screenH = h;
    this.invalidate();
  }

  upsertWindow(win: Window) {
    this.windows.set(win.id, win);
    this.invalidate();
  }

  removeWindow(id: number) {
    if (this.windows.delete(id)) this.invalidate();
  }

  invalidate() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.compose();
    });
  }

  redraw() { this.invalidate(); }

  // Composite the X tree: root background, then each mapped window in DFS
  // order so parents land underneath their descendants. Coordinates are
  // accumulated down the tree because X children are positioned relative
  // to their parent.
  private compose() {
    this.ctx.fillStyle = '#2b2b2b';
    this.ctx.fillRect(0, 0, this.screenW, this.screenH);

    const childrenOf = new Map<number, Window[]>();
    for (const w of this.windows.values()) {
      if (!w.mapped) continue;
      const arr = childrenOf.get(w.parent);
      if (arr) arr.push(w);
      else childrenOf.set(w.parent, [w]);
    }
    // Sort siblings by stackOrder ascending — lowest first, so higher draws
    // last (on top). Apps raise to top via XConfigureWindow stack-mode=Above.
    for (const arr of childrenOf.values()) {
      arr.sort((a, b) => a.stackOrder - b.stackOrder);
    }

    const paint = (parentId: number, ox: number, oy: number) => {
      const kids = childrenOf.get(parentId);
      if (!kids) return;
      for (const w of kids) {
        const ax = ox + w.x;
        const ay = oy + w.y;
        this.ctx.drawImage(w.buffer, ax, ay);
        paint(w.id, ax, ay);
      }
    };
    paint(ROOT_WINDOW_ID, 0, 0);

    // Pointer cursor on top of everything. Position is hotspot-relative.
    // Falls back to a built-in arrow when no app/WM has installed one for
    // the window under the pointer — typically true before twm/fvwm start.
    if (this.cursor) {
      this.ctx.drawImage(this.cursor.image, this.pointerX - this.cursor.hotspotX, this.pointerY - this.cursor.hotspotY);
    } else {
      this.drawFallbackArrow(this.pointerX, this.pointerY);
    }
  }

  private drawFallbackArrow(x: number, y: number) {
    const c = this.ctx;
    c.fillStyle = '#fff';
    c.beginPath();
    c.moveTo(x, y); c.lineTo(x, y + 13); c.lineTo(x + 4, y + 9);
    c.lineTo(x + 7, y + 14); c.lineTo(x + 9, y + 13); c.lineTo(x + 6, y + 8); c.lineTo(x + 11, y + 8);
    c.closePath(); c.fill();
    c.fillStyle = '#000';
    c.beginPath();
    c.moveTo(x + 1, y + 1); c.lineTo(x + 1, y + 11); c.lineTo(x + 4, y + 8);
    c.lineTo(x + 7, y + 13); c.lineTo(x + 8, y + 12); c.lineTo(x + 5, y + 7); c.lineTo(x + 9, y + 7);
    c.closePath(); c.fill();
  }
}
