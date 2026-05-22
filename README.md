# x11-js

Browser-based X11 server. A Node.js bridge (in Docker) exposes a `:0` display
on a Unix socket, forwards raw bytes over WebSocket to a browser, and the
browser implements the actual X server: parses requests, renders to canvas,
turns input into X events.

Server is intentionally dumb — all X11 protocol logic lives in `packages/client`.

## Layout

```
packages/
  protocol/   shared WS framing (Node + browser)
  server/     Node bridge: Unix socket :0 <-> WebSocket
  client/     Browser X server (Vite)
```

## Run

```sh
# Start the bridge + the apps container
docker compose up --build

# In another terminal, start the browser-side X server
yarn install
yarn dev:client          # http://localhost:8080
```

When the browser tab connects to ws://localhost:9090, the bridge auto-launches
`xterm` so you get a usable terminal immediately. Override with env vars:

```sh
# Disable autorun
AUTORUN_CMD='' docker compose up

# Launch something else
AUTORUN_CMD=xeyes docker compose up
AUTORUN_CMD=xterm AUTORUN_ARGS='-geometry 100x30 -e /bin/bash' docker compose up
```

You can also launch additional X clients manually any time:

```sh
docker compose exec apps env DISPLAY=:0 xlogo
docker compose exec apps env DISPLAY=:0 xeyes
```

## Milestone status

- [x] Connection setup handshake (Success reply with one screen, TrueColor visual)
- [x] CreateWindow / MapWindow → black rectangle on canvas
- [x] Stubs for InternAtom, GetProperty, QueryExtension/ListExtensions,
      GetKeyboardMapping, GetGeometry, QueryPointer, GetInputFocus
- [ ] Drawing primitives (PolyLine, PolyRectangle, PutImage, ImageText8…)
- [ ] BIG_REQUESTS / XKB / RENDER extensions
- [ ] Input → KeyPress/ButtonPress/MotionNotify events
