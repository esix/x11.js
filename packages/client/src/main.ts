import { Transport } from './transport.js';
import { Renderer } from './renderer.js';
import { XServer } from './xserver.js';

const status = document.getElementById('status') as HTMLDivElement;
const canvas = document.getElementById('screen') as HTMLCanvasElement;

const renderer = new Renderer(canvas);
const server = new XServer(renderer);
(globalThis as unknown as Record<string, unknown>).__x11 = { server, renderer };

const wsUrl = `ws://${location.hostname}:9090`;
const transport = new Transport(wsUrl, {
  onOpen() { status.textContent = `connected — ${wsUrl} (DISPLAY=:0 open)`; },
  onClose() { status.textContent = `disconnected — reconnecting to ${wsUrl}…`; },
  onClientData(id, bytes) { server.feed(id, bytes); },
  onClientDisconnect(id) { server.dropClient(id); },
});

server.onSend = (id, bytes) => transport.send(id, bytes);
server.onCloseClient = (id) => transport.disconnectClient(id);

transport.connect();

// ---- DOM input → X events --------------------------------------------------

function rootCoords(ev: MouseEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.floor((ev.clientX - r.left) * canvas.width / r.width),
    y: Math.floor((ev.clientY - r.top) * canvas.height / r.height),
  };
}

canvas.addEventListener('mousemove', (ev) => {
  const { x, y } = rootCoords(ev);
  server.setPointer(x, y);
});

canvas.addEventListener('mousedown', (ev) => {
  ev.preventDefault();
  const { x, y } = rootCoords(ev);
  server.setPointer(x, y);
  server.pointerButton(ev.button + 1, true);
});

canvas.addEventListener('mouseup', (ev) => {
  ev.preventDefault();
  const { x, y } = rootCoords(ev);
  server.setPointer(x, y);
  server.pointerButton(ev.button + 1, false);
});

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const button = ev.deltaY < 0 ? 4 : 5;
  server.pointerButton(button, true);
  server.pointerButton(button, false);
}, { passive: false });

canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

import { domEventToKeycode } from './keyboard.js';

window.addEventListener('keydown', (ev) => {
  const kc = domEventToKeycode(ev);
  if (kc === undefined) return;
  ev.preventDefault();
  server.key(kc, true);
});
window.addEventListener('keyup', (ev) => {
  const kc = domEventToKeycode(ev);
  if (kc === undefined) return;
  ev.preventDefault();
  server.key(kc, false);
});
