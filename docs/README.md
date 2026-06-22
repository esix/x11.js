# x11.js documentation

x11.js is an X11 server that runs in a browser tab. Real Linux GUI clients run in
Docker, a dumb Node bridge forwards the X11 protocol over a WebSocket, and the
browser does the actual server work — parsing the protocol, drawing to a
`<canvas>`, and turning DOM input into X events.

These pages walk through the project roughly in the order it was built — from the
first three-line X clients to a full desktop and Firefox.

## Pages

1. [Getting started: xeyes, xclock, xterm](01-getting-started.md) — the first
   clients to connect and draw, and what each one exercises in the protocol.
2. [The protocol we had to implement](02-protocol.md) — the X11 wire protocol,
   the bridge, and which extensions (RENDER, XKB, …) were needed.
3. [A whole desktop: MATE](03-mate-desktop.md) — window manager, panel, menus,
   taskbar, and window management.
4. [GNOME games: Mahjongg and Mines](04-games.md) — tiles, glyphs, and the long
   road to making clicks land.
5. [The file manager: Caja](05-file-manager.md) — icons, navigation, and the
   shared-memory trick.
6. [The big one: Firefox](06-firefox.md) — a multiprocess browser, rendered to a
   canvas, browsing the real web.

See the [project README](../README.md) for how to run it.
