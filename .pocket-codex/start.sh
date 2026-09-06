#!/usr/bin/env bash
set -euo pipefail
umask 077
pocket_root="$(pwd)"
pocket_state="$HOME/.local/share/pocket-codex"
mkdir -p "$pocket_state"
export PATH="$HOME/.local/bin:$PATH"
exec 9>"$pocket_state/start.lock"
flock 9
if [[ -f "$pocket_state/bridge.pid" ]] && kill -0 "$(cat "$pocket_state/bridge.pid")" 2>/dev/null; then exit 0; fi
nohup node "$pocket_root/.pocket-codex/server.mjs" "$pocket_root/.pocket-codex/config.json" >"$pocket_state/bridge.log" 2>&1 9>&- &
echo $! >"$pocket_state/bridge.pid"
