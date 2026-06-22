import { defineConfig } from 'vite';

// Single dev port. Vite serves the app on 8080 and proxies the X11 WebSocket at
// /x11-ws to the Docker bridge (9090), so the browser only ever talks to 8080.
const proxy = {
  '/x11-ws': { target: 'ws://localhost:9090', ws: true },
};

export default defineConfig({
  server: {
    port: 8080,
    host: '0.0.0.0',
    proxy,
  },
  preview: {
    port: 8080,
    host: '0.0.0.0',
    proxy,
  },
});
