@echo off
cd /d "%~dp0"
node_modules\.bin\concurrently.cmd -k -n server,tunnel -c green,cyan ^
  "node src/server.js" ^
  "cloudflared tunnel --url http://localhost:3099"
