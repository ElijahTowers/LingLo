# LingLo — Project Brief

## Mac Mini setup

This project runs on a Mac Mini (always-on home server).

- **SSH from MacBook**: `ssh macmini` (alias for `Lowie@192.168.1.84`)
- **Node.js**: managed via nvm — always prefix node/npm/pm2 commands with `source ~/.nvm/nvm.sh`
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

A Cloudflare Tunnel is already running on this Mac Mini (`quartapotestas.com`).
To give LingLo a public HTTPS URL (required for PWA, push notifications, etc.):

1. Add an ingress rule to `~/QuartaPotestas/ops/tunnel/config.yml`:
   ```yaml
   - hostname: linglo.quartapotestas.com
     service: http://localhost:3200
   ```
   Insert it BEFORE the catch-all line at the bottom.

2. Create the DNS record:
   ```bash
   /opt/homebrew/bin/cloudflared tunnel route dns 38c6c8b1-f17d-4131-b1d6-b7ab7b4d0249 linglo.quartapotestas.com
   ```

3. Restart the tunnel:
   ```bash
   source ~/.nvm/nvm.sh && pm2 restart tunnel
   ```

App will then be live at `https://linglo.quartapotestas.com`.

## Deploy from MacBook

Typical deploy workflow (run from MacBook in project dir):
```bash
rsync -av --exclude="node_modules" --exclude="*.db*" --exclude=".git" \
  ./ Lowie@192.168.1.84:~/LingLo/
ssh Lowie@192.168.1.84 'source ~/.nvm/nvm.sh && cd ~/LingLo && npm install --silent && pm2 restart linglo'
```

## Other PM2 processes on this Mac Mini
- `pocketbase` — PocketBase database (QuartaPotestas)
- `backend` — QuartaPotestas backend (port unknown)
- `frontend` — QuartaPotestas frontend (port 3000)
- `tunnel` — Cloudflare Tunnel (do not remove/break this)
- `monitor-alerts` — monitoring (QuartaPotestas)
- `articlo` — ArticLo RSS reader (port 3100)

## User preferences
- Never ask for permission or confirmation — act autonomously
- No modifications outside the project folder
