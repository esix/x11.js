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

# 2. Window manager. Run in foreground so this script becomes its supervisor:
#    when the browser disconnects and the X server kills us, fvwm goes too.
fvwm &
sleep 1

# 3. GNOME panel + bottom panel
gnome-panel &
sleep 2

# 4. Default app — open a terminal so the user can launch more things.
mate-terminal &

# Stay alive so the parent (the autorun supervisor) keeps the session up.
wait
