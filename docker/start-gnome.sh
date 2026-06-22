#!/bin/sh
# Auto-launched when a browser connects to x11-js (see AUTORUN_CMD).
# Brings up a MATE desktop: D-Bus session, metacity WM, mate-panel, and a
# terminal. (MATE, not GNOME Shell — Shell needs GLX/Wayland we don't provide.)

set -eu

# 0. Make sure /usr/games is on PATH. Debian installs gnome-mahjongg,
#    gnome-mines, gnome-tetravex (and other games) into /usr/games, which is
#    NOT on the default container PATH. mate-panel inherits this PATH and
#    passes it to the apps it spawns, so without this every game menu entry
#    fails its Exec lookup silently — "click the item, nothing happens".
export PATH="$PATH:/usr/games"

# 1. Session D-Bus — gnome-panel + most GTK apps refuse to start without it.
eval "$(dbus-launch --sh-syntax --exit-with-session)"
export DBUS_SESSION_BUS_ADDRESS

# 1b. Clean up the default mate-panel top-panel layout. The shipped default
#     adds 4 launchers + a drawer at the start edge. Their icons fail to load
#     in this minimal image, so they render blank but still reserve ~240px and
#     push the "Applications/Places/System" menu-bar applet into its overflow
#     state — it collapses to a lone chevron with no visible text. Keeping only
#     the menu-bar + clock + window-list + show-desktop gives a clean panel
#     where the menu bar renders its labels. Best-effort (|| true): never let a
#     gsettings hiccup abort the session.
#
#     NOTE: on a freshly-created container (empty dconf) this pre-launch set
#     does NOT stick — mate-panel has no object definitions for these IDs yet
#     and regenerates its default layout anyway. Step 3b re-applies it after the
#     first launch creates the definitions. We still set it here so a warm dconf
#     (e.g. a manual panel restart) comes up right.
gsettings set org.mate.panel object-id-list \
  "['menu-bar', 'clock', 'window-list', 'show-desktop']" 2>/dev/null || true

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
sleep 3

# 3b. Cold-start completion of step 1b. The first launch above created the
#     applet object definitions in dconf, so the object-id-list override now
#     sticks: re-apply it and restart the panel once. Without this, a fresh
#     container comes up with the menu bar collapsed into an overflow chevron.
#     (-x matches the exact process name — never this script; || true keeps
#     set -e happy when nothing matched.)
gsettings set org.mate.panel object-id-list \
  "['menu-bar', 'clock', 'window-list', 'show-desktop']" 2>/dev/null || true
pkill -x mate-panel 2>/dev/null || true
for applet in wnck-applet clock-applet notification-area-applet; do
  pkill -x "$applet" 2>/dev/null || true
done
sleep 1
mate-panel &
sleep 2

# 4. Default app — open a terminal so the user can launch more things.
mate-terminal &

# Stay alive so the parent (the autorun supervisor) keeps the session up.
wait
