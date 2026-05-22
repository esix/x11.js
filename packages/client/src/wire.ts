// X11 wire-protocol primitives. Byte order is per-connection (declared in setup).

export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private off = 0;
  constructor(initialCapacity = 256, public readonly littleEndian = true) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }
  get offset() { return this.off; }
  private grow(extra: number) {
    if (this.off + extra <= this.buf.byteLength) return;
    let n = this.buf.byteLength * 2;
    while (n < this.off + extra) n *= 2;
    const next = new Uint8Array(n);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }
  card8(v: number) { this.grow(1); this.view.setUint8(this.off, v & 0xff); this.off += 1; }
  card16(v: number) { this.grow(2); this.view.setUint16(this.off, v & 0xffff, this.littleEndian); this.off += 2; }
  card32(v: number) { this.grow(4); this.view.setUint32(this.off, v >>> 0, this.littleEndian); this.off += 4; }
  int16(v: number) { this.grow(2); this.view.setInt16(this.off, v, this.littleEndian); this.off += 2; }
  int32(v: number) { this.grow(4); this.view.setInt32(this.off, v, this.littleEndian); this.off += 4; }
  pad(n: number) { this.grow(n); this.off += n; }
  padTo(boundary: number) {
    const need = (boundary - (this.off % boundary)) % boundary;
    this.pad(need);
  }
  bytes(b: Uint8Array) { this.grow(b.byteLength); this.buf.set(b, this.off); this.off += b.byteLength; }
  patchCard16(at: number, v: number) { this.view.setUint16(at, v & 0xffff, this.littleEndian); }
  patchCard32(at: number, v: number) { this.view.setUint32(at, v >>> 0, this.littleEndian); }
  finish(): Uint8Array { return this.buf.subarray(0, this.off); }
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
