# LingLo — Project Brief

## What it is
Language learning app with EPUB reader, word-click translation (Ollama), and flashcards. PM2 process: `linglo` (port 3200).

## This machine
Running directly on the Mac Mini (Apple M4, macOS 15). No SSH needed.
- **Node.js**: `/Users/lowie/.nvm/versions/node/v24.14.0/bin`
- **Project dir**: `~/LingLo`
- **PM2 process**: `linglo`

## Tech stack
- Backend: Node.js, Express, better-sqlite3, ws, node-pty
- Frontend: Vanilla HTML/JS/CSS (public/)
- TTS: Piper neural TTS (Spanish), macOS `say` as fallback

## After every change
1. Bump `APP_VERSION` in `server.js` (patch v1.x → v1.x+1, feature → v2.0)
2. Run: `source ~/.nvm/nvm.sh && pm2 restart linglo`
3. Run: `git add -A && git commit -m "<description>" && git push`

## User preferences
- Never ask for permission or confirmation — act autonomously
- No modifications outside the project folder
