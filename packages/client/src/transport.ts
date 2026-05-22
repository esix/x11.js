import { encodeFrame, decodeFrame, FRAME_TYPE } from '@x11-js/protocol';

interface Handlers {
  onOpen(): void;
  onClose(): void;
  onClientData(clientId: number, bytes: Uint8Array): void;
  onClientDisconnect(clientId: number): void;
}

export class Transport {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;

  constructor(private readonly url: string, private readonly h: Handlers) {}

  connect() {
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this.h.onOpen();
    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const frame = decodeFrame(new Uint8Array(ev.data));
      if (frame.type === FRAME_TYPE.DATA_C2S) this.h.onClientData(frame.clientId, frame.payload);
      else if (frame.type === FRAME_TYPE.DISCONNECT) this.h.onClientDisconnect(frame.clientId);
    };
    ws.onclose = (event) => {
      this.h.onClose();
      // 4001 = server replaced this connection with a newer one (a fresh
      // tab took over). Reconnecting would just kick the new tab off.
      if (event.code !== 4001) this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  send(clientId: number, bytes: Uint8Array) {
    this.ws?.send(encodeFrame(FRAME_TYPE.DATA_S2C, clientId, bytes));
  }

  disconnectClient(clientId: number) {
    this.ws?.send(encodeFrame(FRAME_TYPE.DISCONNECT, clientId, new Uint8Array()));
  }
}
