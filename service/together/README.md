# Watch together service

This service carries room state and chat only. Each Nen client loads its own video.
Rooms have a 10-person limit and expire after 12 hours. Room codes are random
144-bit secrets. Anyone with a code can join. Rooms and the last 100 chat messages
are held only in memory. A restart ends all rooms.

## Server

Deploy this directory separately from the website project:
`/home/zil/projects/nen-together`.

Run `sudo docker compose up -d --build` there. The service listens on
127.0.0.1:8090. Use the supplied Nginx configuration after issuing a certificate
for together.crygup.com. Reload Nginx only after `sudo nginx -t` passes.

Cloudflare: proxied A record `together` -> `37.221.193.8`.
Use Full (strict) TLS. WebSocket connections must be allowed and must not receive
an interactive challenge.

Health check: `https://together.crygup.com/health`.
Client endpoint: `wss://together.crygup.com/session`.

## Local checks

Run `npm ci`, then `npm test` in this directory.
Run `npm start` to listen on port 8090.
Set `NEN_TOGETHER_URL=ws://127.0.0.1:8090/session` for local app tests.

## Playback behavior

The host chooses an episode through the normal anime page. Guests first try the
host's source. The existing source search falls back if it is unavailable or slow.
Each person can choose another source. Different edits of an episode can have
different scene timings, even with matching playback positions.

All players open paused. Playback starts automatically when everyone is ready.
A loading or buffering member holds the room paused. Playback resumes when all
members are ready. Seeking is host-only. Guests can pause and resume only when the
host enables that setting. Automatic skips and automatic next episode are disabled
in a room. Normal playback speed is used. The host can use Next episode.

Leaving or losing the host connection ends the room and pauses the remaining
players. There is no host migration or automatic reconnect in this version.
