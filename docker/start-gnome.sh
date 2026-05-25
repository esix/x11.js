#!/bin/sh
# Auto-launched when a browser connects to x11-js (see AUTORUN_CMD).
# Brings up a GNOME-family desktop: D-Bus session, EWMH-aware WM, panel,
# and a default GNOME app.
#
# We use fvwm2 instead of Mutter because Mutter requires the in-page
# XKB toggle (globalThis.__enable_xkb = true) and we can't set that
# from the server side. fvwm2 is EWMH-aware enough for gnome-panel's
# show-desktop button and window-manager probing.

set -eu

# 1. Session D-Bus — gnome-panel + most GTK apps refuse to start without it.
eval "$(dbus-launch --sh-syntax --exit-with-session)"
export DBUS_SESSION_BUS_ADDRESS

# 2. Skip the WM for now. fvwm's default config reparents the panel into
#    an empty frame window that ends up stacked above the panel, blocking
#    all clicks on Applications/Places/System. Without a WM, mate-panel
#    self-positions at (0,0) and clicks reach it directly.
#
#    The trade-off: no window decorations, no focus management for other
#    apps, no "show desktop" button. But the menu is the user's current
#    complaint and matters more.
# fvwm &
# sleep 1

# 3. MATE panel (GNOME 2 fork) — uses the same XDG menu data as gnome-panel
#    but doesn't require org.gnome.SessionManager / Login1.
mate-panel &
sleep 2

# 4. Default app — open a terminal so the user can launch more things.
mate-terminal &

# Stay alive so the parent (the autorun supervisor) keeps the session up.
wait
