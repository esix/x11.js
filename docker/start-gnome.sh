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

# 2. Window manager: metacity, gnome 2's reference WM.
#    Tried fvwm (creates empty ghost frames that block panel clicks)
#    and marco (positions DOCK panels at y=-24/y=768 — entirely off
#    screen). metacity is mature and predictable.
#
#    --sm-disable: skip session manager registration we don't have.
#    --no-composite: skip compositing (we don't render shadows etc).
metacity --sm-disable --no-composite &
sleep 1

# 3. MATE panel (GNOME 2 fork) — uses the same XDG menu data as gnome-panel
#    but doesn't require org.gnome.SessionManager / Login1.
mate-panel &
sleep 2

# 4. Default app — open a terminal so the user can launch more things.
mate-terminal &

# Stay alive so the parent (the autorun supervisor) keeps the session up.
wait
