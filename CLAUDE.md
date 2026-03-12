# LingLo — Project Brief

## Mac Mini setup

This project runs on a Mac Mini (always-on home server).

- **SSH from MacBook**: `ssh macmini` (alias for `Lowie@192.168.1.104`)
- **Node.js**: managed via nvm — always prefix node/npm/pm2 commands with `source ~/.nvm/nvm.sh`
- **nvm node bin**: `/Users/lowie/.nvm/versions/node/v24.14.0/bin`
- **Process manager**: PM2 — keeps the app running, survives reboots via launchd
- **Port**: 3200 (3000=QuartaPotestas frontend, 3100=ArticLo, 5000/7000/8000 taken)
- **Project dir**: `~/LingLo`

## Running the app

```
node server.js
```

Or via PM2 (production):
```bash
source ~/.nvm/nvm.sh
pm2 start --name linglo --interpreter node -- server.js
pm2 save
```

## HTTPS / Public URL

Live at **`https://linglo.quartapotestas.com`** via Cloudflare Tunnel.

- Tunnel UUID: `38c6c8b1-f17d-4131-b1d6-b7ab7b4d0249`
- Tunnel config: `~/QuartaPotestas/ops/tunnel/config.yml`
- LingLo ingress rule already added (routes `linglo.quartapotestas.com` → `http://localhost:3200`)
- DNS record already created
- To restart tunnel: `source ~/.nvm/nvm.sh && pm2 restart tunnel`

## Authentication

All routes (pages, API, WebSocket) are protected by password auth.

- Password stored in `~/LingLo/.env` as `LINGLO_PASSWORD`
- Login page: `/login` — sets a 30-day `HttpOnly` cookie on success
- Logout: POST to `/logout`
- Sessions held in memory (cleared on server restart — users must log in again)
- WebSocket `/terminal-ws` is rejected at upgrade level if no valid session
- To change password: edit `~/LingLo/.env` and `pm2 restart linglo`

## Claude Code terminal

A browser-based Claude Code terminal is available at `/terminal.html` (linked from the library header).

- WebSocket endpoint: `/terminal-ws`
- Uses `node-pty` to spawn a real PTY running `claude` with the correct nvm PATH
- Requires auth — unauthenticated WebSocket upgrades are rejected
- Frontend uses `xterm.js` (CDN) with the FitAddon for resize support

## Stack

- `server.js` — Express API + HTTP server + WebSocket server
- `public/` — `index.html`, `reader.html`, `reader.js`, `flashcards.html`, `terminal.html`, `style.css`
- `db/linglo.db` — SQLite (books + words tables), via `better-sqlite3`
- `uploads/` — EPUB files
- `piper/` — Piper neural TTS (Spanish, `es_ES-davefx-medium.onnx`)
- `.env` — `LINGLO_PASSWORD` (loaded via `dotenv`)
- Dependencies: `express`, `epub2`, `better-sqlite3`, `multer`, `ws`, `node-pty`, `dotenv`

## TTS

Piper neural TTS via Python package (`piper/venv/bin/piper`) with Spanish model `piper/es_ES-davefx-medium.onnx`.
macOS `say -v Monica` as fallback if venv missing. Setup: `./setup-piper.sh`.

## Key features

- EPUB reader with word-click translation (Ollama `llama3.2:3b`)
- Auto-speak on click/drag, speak buttons
- Save words, flashcard deck, conjugation, explain, summarize
- Browser-based Claude Code terminal (authenticated)
- Swipe navigation (left/right to change pages)

## Known fixes applied

- **Fold 7 cover screen touch**: `.sidebar-backdrop` was `display:block` on narrow screens with no `pointer-events:none`, silently swallowing all touch events. Fixed by adding `pointer-events:none` by default, `pointer-events:auto` only when `.visible`.
- **Mobile Touch Events (New Features)**: Standard `click` listeners can be unreliable on iOS Safari for dynamically added buttons or custom dropdowns. *Always ensure newly added interactive features are fully responsive to touch (using `touchstart` or robust click delegation) so that they work on mobile devices just like a mouse click would.*

## Deploy from MacBook

Typical deploy workflow (run from MacBook in project dir):
```bash
rsync -av --exclude="node_modules" --exclude="*.db*" --exclude=".git" \
  ./ Lowie@192.168.1.104:~/LingLo/
ssh macmini 'source ~/.nvm/nvm.sh && cd ~/LingLo && npm install --silent && pm2 restart linglo'
```

## Other PM2 processes on this Mac Mini

- `pocketbase` — PocketBase database (QuartaPotestas)
- `backend` — QuartaPotestas backend (port unknown)
- `frontend` — QuartaPotestas frontend (port 3000)
- `tunnel` — Cloudflare Tunnel (do not remove/break this)
- `monitor-alerts` — monitoring (QuartaPotestas)
- `articlo` — ArticLo RSS reader (port 3100)

## Versioning

- `APP_VERSION` is defined at the top of `server.js` (e.g. `const APP_VERSION = 'v1.7';`)
- **After every change to the project, bump the version** — patch for small fixes/tweaks (v1.7 → v1.8), minor for new features (v1.7 → v2.0)
- Update the version as part of the same edit, never as a separate step

## User preferences

- Never ask for permission or confirmation — act autonomously
- No modifications outside the project folder
- **Always deploy after every change** using the rsync + pm2 command above (Mac Mini IP: 192.168.1.104)
