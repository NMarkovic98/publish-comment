#!/bin/bash
# Launch server + tunnel in their own systemd scope so Chrome runs outside
# VSCode's cgroup (prevents resource throttling that makes Chrome slow).
cd "$(dirname "$0")"
exec systemd-run --user --scope --slice=-.slice \
  node_modules/.bin/concurrently -k -n server,tunnel -c green,cyan \
  "node src/server.js" \
  "$HOME/.local/bin/cloudflared tunnel --url http://localhost:3099"
