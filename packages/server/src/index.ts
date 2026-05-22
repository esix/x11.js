import { createServer as createNetServer, type Socket } from 'node:net';
import { existsSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { encodeFrame, decodeFrame, FRAME_TYPE } from '@x11-js/protocol';

const DISPLAY_NUM = Number(process.env.DISPLAY_NUM ?? '0');
const SOCKET_PATH = `/tmp/.X11-unix/X${DISPLAY_NUM}`;
const WS_PORT = Number(process.env.WS_PORT ?? '9090');
// Command to launch when a browser connects. Set AUTORUN_CMD='' to disable.
const AUTORUN_CMD = process.env.AUTORUN_CMD ?? 'xterm';
const AUTORUN_ARGS = (process.env.AUTORUN_ARGS ?? '').split(/\s+/).filter(Boolean);

mkdirSync('/tmp/.X11-unix', { recursive: true, mode: 0o1777 });
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

const x11Clients = new Map<number, Socket>();
const pending = new Map<number, Buffer[]>();
let nextClientId = 1;
let browser: WebSocket | null = null;
let autorunChild: ChildProcess | null = null;

function startAutorun() {
  if (!AUTORUN_CMD) return;
  if (autorunChild && autorunChild.exitCode === null) return; // already running
  console.log(`[autorun] launching ${AUTORUN_CMD} ${AUTORUN_ARGS.join(' ')}`.trim());
  const child = spawn(AUTORUN_CMD, AUTORUN_ARGS, {
    env: { ...process.env, DISPLAY: `:${DISPLAY_NUM}` },
    stdio: 'inherit',
    detached: false,
  });
  child.on('error', (err) => console.warn(`[autorun] failed to launch: ${err.message}`));
  child.on('exit', (code, signal) => {
    console.log(`[autorun] exited code=${code} signal=${signal}`);
    if (autorunChild === child) autorunChild = null;
  });
  autorunChild = child;
}

function stopAutorun() {
  if (autorunChild && autorunChild.exitCode === null) {
    autorunChild.kill('SIGTERM');
  }
  autorunChild = null;
}

function toUint8(b: Buffer | Uint8Array): Uint8Array {
  return b instanceof Uint8Array ? b : new Uint8Array(b);
}

function broadcast(frame: Uint8Array) {
  if (browser && browser.readyState === WebSocket.OPEN) browser.send(frame);
}

const x11Server = createNetServer((sock) => {
  const id = nextClientId++;
  x11Clients.set(id, sock);
  console.log(`[x11] client ${id} connected`);

  sock.on('data', (chunk: Buffer) => {
    if (!browser || browser.readyState !== WebSocket.OPEN) {
      const q = pending.get(id) ?? [];
      q.push(chunk);
      pending.set(id, q);
      return;
    }
    broadcast(encodeFrame(FRAME_TYPE.DATA_C2S, id, toUint8(chunk)));
  });

  sock.on('close', () => {
    x11Clients.delete(id);
    pending.delete(id);
    console.log(`[x11] client ${id} disconnected`);
    broadcast(encodeFrame(FRAME_TYPE.DISCONNECT, id, new Uint8Array()));
  });

  sock.on('error', (err) => {
    console.warn(`[x11] client ${id} error: ${err.message}`);
  });
});

x11Server.listen(SOCKET_PATH, () => {
  // Mode 0777 so other users in the container can connect.
  chmodSync(SOCKET_PATH, 0o777);
  console.log(`[x11] listening on ${SOCKET_PATH} (DISPLAY=:${DISPLAY_NUM})`);
});

const wss = new WebSocketServer({ port: WS_PORT });
wss.on('connection', (ws) => {
  // Replace any previous session — useful for tab reloads where the old
  // WebSocket hasn't fully closed yet.
  if (browser) {
    console.log('[ws] new browser connected — dropping previous session');
    try { browser.close(4001, 'replaced'); } catch { /* ignore */ }
    browser = null;
    stopAutorun();
    for (const sock of x11Clients.values()) sock.destroy();
    x11Clients.clear();
    pending.clear();
  }

  console.log('[ws] browser connected');
  browser = ws;

  for (const [id, chunks] of pending) {
    for (const c of chunks) ws.send(encodeFrame(FRAME_TYPE.DATA_C2S, id, toUint8(c)));
  }
  pending.clear();

  startAutorun();

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (!isBinary) return;
    const u8 = data instanceof Buffer ? toUint8(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : toUint8(Buffer.concat(data as Buffer[]));
    const frame = decodeFrame(u8);
    const sock = x11Clients.get(frame.clientId);
    if (!sock) return;
    if (frame.type === FRAME_TYPE.DATA_S2C) sock.write(frame.payload);
    else if (frame.type === FRAME_TYPE.DISCONNECT) sock.destroy();
  });

  ws.on('close', () => {
    // If a newer browser already took over this slot, the old ws closing is
    // not a real disconnect — skip the teardown so we don't kill the new
    // session's xterm.
    if (browser !== ws) return;
    console.log('[ws] browser disconnected');
    browser = null;
    for (const sock of x11Clients.values()) sock.destroy();
    stopAutorun();
  });
});

console.log(`[ws] listening on :${WS_PORT}`);

const shutdown = () => {
  stopAutorun();
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
