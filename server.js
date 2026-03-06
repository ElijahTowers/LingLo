require('dotenv').config();
const express = require('express');
const qrcode = require('qrcode');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const crypto = require('crypto');

// ── Native TOTP (RFC 6238) — no external dependency ──
function base32Decode(secret) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.toUpperCase().replace(/=+$/, '')) {
    const i = chars.indexOf(c);
    if (i >= 0) bits += i.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpCode(secret, offset = 0) {
  const key = base32Decode(secret);
  const counter = BigInt(Math.floor(Date.now() / 1000 / 30) + offset);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const pos = hmac[19] & 0xf;
  const code = ((hmac[pos] & 0x7f) << 24 | hmac[pos+1] << 16 | hmac[pos+2] << 8 | hmac[pos+3]) % 1000000;
  return code.toString().padStart(6, '0');
}

function verifyTOTP(token, secret) {
  return [-1, 0, 1].some(w => totpCode(secret, w) === token);
}
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { EPub } = require('epub2');
const Database = require('better-sqlite3');

const app = express();
const PORT = 3200;

for (const dir of ['uploads', 'db', 'public']) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const db = new Database('./db/linglo.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER,
    word TEXT NOT NULL,
    translation TEXT NOT NULL,
    sentence TEXT,
    chapter_title TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (book_id) REFERENCES books(id)
  );
`);

// ── Auth ──
const PASSWORD = process.env.LINGLO_PASSWORD;
if (!PASSWORD) { console.error('LINGLO_PASSWORD not set in .env'); process.exit(1); }

const TOTP_SECRET = process.env.LINGLO_TOTP_SECRET;
if (!TOTP_SECRET) { console.error('LINGLO_TOTP_SECRET not set in .env'); process.exit(1); }

const sessions = new Set();
const totpVerified = new Map(); // token -> expiry timestamp (8h)
const usedTotpCodes = new Map(); // code -> expiry timestamp (prevent replay)

// Rate limiting: ip -> { attempts, resetAt }
const loginAttempts = new Map();
const totpAttempts = new Map();

const TOTP_SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours
const RATE_WINDOW = 15 * 60 * 1000;           // 15 minutes
const LOGIN_MAX = 10;                          // max password attempts per window
const TOTP_MAX = 5;                            // max TOTP attempts per window

function isRateLimited(map, ip, max) {
  const now = Date.now();
  const entry = map.get(ip) || { attempts: 0, resetAt: now + RATE_WINDOW };
  if (now > entry.resetAt) { entry.attempts = 0; entry.resetAt = now + RATE_WINDOW; }
  entry.attempts++;
  map.set(ip, entry);
  return entry.attempts > max;
}

// Purge expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of totpVerified) if (now > v) totpVerified.delete(k);
  for (const [k, v] of usedTotpCodes) if (now > v) usedTotpCodes.delete(k);
  for (const [k, v] of loginAttempts) if (now > v.resetAt) loginAttempts.delete(k);
  for (const [k, v] of totpAttempts) if (now > v.resetAt) totpAttempts.delete(k);
}, 60 * 1000);

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  return token;
}

function getToken(cookieHeader) {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)linglo_s=([a-f0-9]{64})/);
  return m ? m[1] : null;
}

function isAuthed(cookieHeader) {
  return sessions.has(getToken(cookieHeader));
}

function isTerminalAuthed(cookieHeader) {
  const token = getToken(cookieHeader);
  if (!sessions.has(token)) return false;
  const expiry = totpVerified.get(token);
  if (!expiry || Date.now() > expiry) { totpVerified.delete(token); return false; }
  return true;
}

function timingSafeCompare(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Still run the comparison to avoid timing leak on length
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function authMiddleware(req, res, next) {
  if (isAuthed(req.headers.cookie)) return next();
  res.redirect('/login');
}

// ── Parsers ──
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Login routes (no auth required) ──
app.get('/login', (req, res) => {
  const err = req.url.includes('?err') ? '<p class="err">Wrong password.</p>' : '';
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LingLo — Sign in</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0f0e17;
      font-family: 'Inter', system-ui, sans-serif;
      color: #e8e4f0;
    }
    .card {
      background: #1a1828;
      border: 1px solid #2a2840;
      border-radius: 16px;
      padding: 40px 36px;
      width: min(360px, 92vw);
    }
    .logo { font-size: 1.6rem; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 8px; }
    .sub { font-size: 0.85rem; color: #7c7a8e; margin-bottom: 28px; }
    label { font-size: 0.8rem; color: #7c7a8e; display: block; margin-bottom: 6px; }
    input[type=password] {
      width: 100%;
      background: #0f0e17;
      border: 1px solid #2a2840;
      border-radius: 8px;
      padding: 10px 14px;
      color: #e8e4f0;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type=password]:focus { border-color: #a78bfa; }
    button {
      margin-top: 16px;
      width: 100%;
      background: #a78bfa;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 11px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover { background: #9061f9; }
    .err { margin-top: 12px; font-size: 0.82rem; color: #f87171; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">LingLo</div>
    <div class="sub">Enter your password to continue</div>
    <form method="POST" action="/login">
      <label for="pw">Password</label>
      <input type="password" id="pw" name="password" autofocus autocomplete="current-password">
      <button type="submit">Sign in</button>
      ${err}
    </form>
  </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (isRateLimited(loginAttempts, ip, LOGIN_MAX))
    return res.status(429).send('Too many attempts. Try again in 15 minutes.');
  if (timingSafeCompare(req.body.password || '', PASSWORD)) {
    const token = createSession();
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `linglo_s=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=2592000`);
    res.redirect('/');
  } else {
    res.redirect('/login?err=1');
  }
});

app.post('/logout', (req, res) => {
  sessions.delete(getToken(req.headers.cookie));
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `linglo_s=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`);
  res.redirect('/login');
});

// ── TOTP setup (one-time scan page, password protected) ──
app.get('/totp-setup', async (req, res) => {
  // Require full password auth (TOTP not required — this is the setup page)
  // But add a no-store header so the secret isn't cached by browser or Cloudflare
  if (!isAuthed(req.headers.cookie)) return res.redirect('/login');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  const uri = `otpauth://totp/LingLo:lowie?secret=${TOTP_SECRET}&issuer=LingLo&algorithm=SHA1&digits=6&period=30`;
  const qr = await qrcode.toDataURL(uri);
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LingLo — TOTP Setup</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0f0e17; font-family: system-ui, sans-serif; color: #e8e4f0; }
    .card { background: #1a1828; border: 1px solid #2a2840; border-radius: 16px;
      padding: 36px; width: min(400px, 94vw); text-align: center; }
    h1 { font-size: 1.2rem; margin-bottom: 8px; }
    p { font-size: 0.85rem; color: #7c7a8e; margin-bottom: 20px; line-height: 1.5; }
    img { border-radius: 8px; width: 220px; height: 220px; }
    .secret { margin-top: 16px; font-family: monospace; font-size: 0.85rem;
      background: #0f0e17; border: 1px solid #2a2840; border-radius: 8px;
      padding: 10px 14px; letter-spacing: 2px; color: #a78bfa; word-break: break-all; }
    .note { margin-top: 16px; font-size: 0.78rem; color: #4a4860; }
    a { display: inline-block; margin-top: 20px; color: #a78bfa; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Scan this QR code</h1>
    <p>Open Google Authenticator, Authy, or any TOTP app and scan the code below.</p>
    <img src="${qr}" alt="QR code">
    <div class="secret">${TOTP_SECRET}</div>
    <div class="note">Manual entry: use the key above with SHA1, 6 digits, 30s interval.</div>
    <a href="/">← Back to library</a>
  </div>
</body>
</html>`);
});

// ── TOTP verification for terminal ──
app.get('/terminal-auth', (req, res) => {
  if (!isAuthed(req.headers.cookie)) return res.redirect('/login');
  const err = req.url.includes('?err') ? '<p class="err">Invalid code. Try again.</p>' : '';
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LingLo — Verify</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0f0e17; font-family: system-ui, sans-serif; color: #e8e4f0; }
    .card { background: #1a1828; border: 1px solid #2a2840; border-radius: 16px;
      padding: 40px 36px; width: min(340px, 92vw); }
    .logo { font-size: 1.4rem; font-weight: 700; margin-bottom: 4px; }
    .sub { font-size: 0.85rem; color: #7c7a8e; margin-bottom: 28px; }
    label { font-size: 0.8rem; color: #7c7a8e; display: block; margin-bottom: 6px; }
    input[type=text] { width: 100%; background: #0f0e17; border: 1px solid #2a2840;
      border-radius: 8px; padding: 10px 14px; color: #e8e4f0; font-size: 1.4rem;
      letter-spacing: 6px; text-align: center; outline: none; font-family: monospace;
      transition: border-color 0.15s; }
    input[type=text]:focus { border-color: #a78bfa; }
    button { margin-top: 16px; width: 100%; background: #a78bfa; color: #fff;
      border: none; border-radius: 8px; padding: 11px; font-size: 0.95rem;
      font-weight: 600; cursor: pointer; transition: background 0.15s; }
    button:hover { background: #9061f9; }
    .err { margin-top: 12px; font-size: 0.82rem; color: #f87171; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Claude Code</div>
    <div class="sub">Enter your authenticator code</div>
    <form method="POST" action="/terminal-auth">
      <label for="code">6-digit code</label>
      <input type="text" id="code" name="code" maxlength="6" autocomplete="one-time-code"
             inputmode="numeric" pattern="[0-9]{6}" autofocus>
      <button type="submit">Verify</button>
      ${err}
    </form>
  </div>
</body>
</html>`);
});

app.post('/terminal-auth', (req, res) => {
  if (!isAuthed(req.headers.cookie)) return res.redirect('/login');
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (isRateLimited(totpAttempts, ip, TOTP_MAX))
    return res.status(429).send('Too many attempts. Try again in 15 minutes.');
  const code = (req.body.code || '').trim();
  // Reject replayed codes
  if (usedTotpCodes.has(code)) return res.redirect('/terminal-auth?err=1');
  const isValid = verifyTOTP(code, TOTP_SECRET);
  if (isValid) {
    usedTotpCodes.set(code, Date.now() + 90 * 1000); // mark used for 90s (covers ±1 window)
    totpVerified.set(getToken(req.headers.cookie), Date.now() + TOTP_SESSION_TTL);
    res.redirect('/terminal.html');
  } else {
    res.redirect('/terminal-auth?err=1');
  }
});

// ── Auth wall — everything below requires login ──
app.use(authMiddleware);
app.use(express.static('public'));

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + '.epub');
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.epub')) cb(null, true);
    else cb(new Error('Only EPUB files are supported'));
  },
  limits: { fileSize: 150 * 1024 * 1024 }
});

const epubCache = new Map();

async function getEpub(filepath) {
  if (epubCache.has(filepath)) return epubCache.get(filepath);
  const epub = await EPub.createAsync(path.resolve(filepath));
  epubCache.set(filepath, epub);
  return epub;
}

function cleanHtml(html) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) html = bodyMatch[1];
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<img[^>]*>/gi, '');
  return html.trim();
}

async function autoImport() {
  const epubs = fs.readdirSync('.').filter(f => f.toLowerCase().endsWith('.epub'));
  for (const file of epubs) {
    if (db.prepare('SELECT id FROM books WHERE filename = ?').get(file)) continue;
    try {
      const epub = await getEpub(`./${file}`);
      const title = epub.metadata.title || file.replace(/\.epub$/i, '');
      const author = epub.metadata.creator || epub.metadata.author || 'Unknown';
      db.prepare('INSERT INTO books (title, author, filename, filepath) VALUES (?, ?, ?, ?)')
        .run(title, author, file, `./${file}`);
      console.log(`Auto-imported: "${title}" by ${author}`);
    } catch (err) {
      console.error(`Could not import ${file}:`, err.message);
    }
  }
}

// --- Routes ---

app.get('/api/books', (req, res) => {
  res.json(db.prepare('SELECT * FROM books ORDER BY title COLLATE NOCASE ASC').all());
});

app.post('/api/upload', upload.single('epub'), async (req, res) => {
  try {
    const epub = await getEpub(req.file.path);
    const title = epub.metadata.title || req.file.originalname.replace(/\.epub$/i, '');
    const author = epub.metadata.creator || epub.metadata.author || 'Unknown';
    const result = db.prepare(
      'INSERT INTO books (title, author, filename, filepath) VALUES (?, ?, ?, ?)'
    ).run(title, author, req.file.originalname, req.file.path);
    res.json({ id: result.lastInsertRowid, title, author });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/books/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  res.json(book);
});

app.get('/api/books/:id/chapters', async (req, res) => {
  try {
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    const epub = await getEpub(book.filepath);
    const chapters = epub.toc
      .filter(ch => ch.id)
      .map((ch, i) => ({ index: i, id: ch.id, title: ch.title || `Chapter ${i + 1}` }));
    res.json({ title: book.title, author: book.author, chapters });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/books/:id/chapter/:index', async (req, res) => {
  try {
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    const epub = await getEpub(book.filepath);
    const chapters = epub.toc.filter(ch => ch.id);
    const idx = parseInt(req.params.index);
    const chapter = chapters[idx];
    if (!chapter) return res.status(404).json({ error: 'Chapter not found' });

    let html;
    try {
      html = await epub.getChapterRawAsync(chapter.id);
    } catch {
      html = await epub.getChapterAsync(chapter.id);
    }

    res.json({
      index: idx,
      title: chapter.title || `Chapter ${idx + 1}`,
      html: cleanHtml(html),
      total: chapters.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/translate', async (req, res) => {
  const { text, sentence } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'No text provided' });
  try {
    const context = sentence && sentence !== text
      ? ` Use this sentence as context to pick the right meaning: "${sentence}"`
      : '';
    const r = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:3b',
        prompt: `Translate only the Spanish word or phrase "${text.trim()}" to English.${context} Reply with only the English translation of "${text.trim()}", nothing else.`,
        stream: true
      })
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Model', 'llama3.2:3b');

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.response) res.write(json.response);
          if (json.done) { res.end(); return; }
        } catch {}
      }
    }
    res.end();
  } catch {
    res.status(503).end('Ollama not available');
  }
});

app.post('/api/explain', async (req, res) => {
  const { word, sentence } = req.body;
  try {
    const r = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:3b',
        prompt: `You are a concise Spanish language tutor. Always respond in English. The learner clicked on "${word}" in:\n"${sentence}"\n\nGive 3 short lines:\n1. Meaning in this context\n2. Grammar note (tense/conjugation if relevant)\n3. Memory tip\n\nNo headers, just the 3 lines. Respond in English only.`,
        stream: true
      })
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Model', 'llama3.2:3b');

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.response) res.write(json.response);
          if (json.done) { res.end(); return; }
        } catch {}
      }
    }
    res.end();
  } catch {
    res.status(503).end('Ollama not available');
  }
});

app.post('/api/conjugate', async (req, res) => {
  const { word, sentence } = req.body;
  try {
    const r = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:3b',
        prompt: `The Spanish word "${word}" appears in: "${sentence}". Is it a verb? If yes, reply in this exact format (3 lines, nothing else):\nInfinitive: [infinitive]\nPresent: yo [form], tú [form], él [form], nosotros [form], ellos [form]\nPreterite: yo [form]\nIf it is not a verb, reply with just: —`,
        stream: true
      })
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.trim()) continue;
        try { const j = JSON.parse(line); if (j.response) res.write(j.response); if (j.done) { res.end(); return; } } catch {}
      }
    }
    res.end();
  } catch { res.status(503).end('Ollama not available'); }
});

app.post('/api/idiom', async (req, res) => {
  const { text, sentence } = req.body;
  try {
    const r = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:3b',
        prompt: `Is the Spanish phrase "${text}" an idiomatic expression or fixed phrase? Context: "${sentence}". If yes, reply with one short sentence explaining what it means as an idiom. If no, reply with just: no`,
        stream: true
      })
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.trim()) continue;
        try { const j = JSON.parse(line); if (j.response) res.write(j.response); if (j.done) { res.end(); return; } } catch {}
      }
    }
    res.end();
  } catch { res.status(503).end('Ollama not available'); }
});

app.post('/api/summarize', async (req, res) => {
  const { text, title } = req.body;
  if (!text?.trim()) return res.status(400).end('No text');
  try {
    const r = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:3b',
        prompt: `Summarize this chapter${title ? ` ("${title}")` : ''} in 3-4 sentences in English. Be concise, focus on what happens. Do not start with "This chapter".\n\n${text.slice(0, 4000)}`,
        stream: true
      })
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.trim()) continue;
        try { const j = JSON.parse(line); if (j.response) res.write(j.response); if (j.done) { res.end(); return; } } catch {}
      }
    }
    res.end();
  } catch { res.status(503).end('Ollama not available'); }
});

app.post('/api/words', (req, res) => {
  const { bookId, word, translation, sentence, chapterTitle } = req.body;
  const existing = db.prepare(
    'SELECT id FROM words WHERE word = ? AND book_id IS ?'
  ).get(word, bookId ?? null);
  if (existing) return res.json({ id: existing.id, duplicate: true });
  const result = db.prepare(
    'INSERT INTO words (book_id, word, translation, sentence, chapter_title) VALUES (?, ?, ?, ?, ?)'
  ).run(bookId ?? null, word, translation, sentence ?? null, chapterTitle ?? null);
  res.json({ id: result.lastInsertRowid });
});

app.get('/api/words', (req, res) => {
  res.json(db.prepare(`
    SELECT w.*, b.title as book_title
    FROM words w LEFT JOIN books b ON w.book_id = b.id
    ORDER BY w.created_at DESC
  `).all());
});

app.delete('/api/words/:id', (req, res) => {
  db.prepare('DELETE FROM words WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// TTS
const PIPER_DIR   = path.join(__dirname, 'piper');
const PIPER_PY    = path.join(PIPER_DIR, 'venv', 'bin', 'piper');
const PIPER_BIN   = path.join(PIPER_DIR, process.platform === 'win32' ? 'piper.exe' : 'piper');
const PIPER_MODEL = path.join(PIPER_DIR, 'es_ES-sharvard-medium.onnx');

function getPiperCmd(wavPath) {
  if (fs.existsSync(PIPER_PY) && fs.existsSync(PIPER_MODEL))
    return [PIPER_PY, ['--model', PIPER_MODEL, '--output-file', wavPath]];
  if (fs.existsSync(PIPER_BIN) && fs.existsSync(PIPER_MODEL))
    return [PIPER_BIN, ['--model', PIPER_MODEL, '--output_file', wavPath, '--quiet']];
  return null;
}

app.get('/api/tts', async (req, res) => {
  const text = req.query.text?.trim();
  if (!text) return res.status(400).end();

  const id  = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const wav = path.join(os.tmpdir(), `linglo-${id}.wav`);
  const cleanup = () => fs.unlink(wav, () => {});

  try {
    const piperCmd = getPiperCmd(wav);
    if (piperCmd) {
      const [bin, args] = piperCmd;
      await new Promise((resolve, reject) => {
        const p = spawn(bin, args);
        p.stdin.write(text);
        p.stdin.end();
        p.on('close', code => code === 0 ? resolve() : reject(new Error(`piper exited ${code}`)));
        p.on('error', reject);
      });
    } else if (process.platform === 'darwin') {
      const aiff = wav.replace('.wav', '.aiff');
      await new Promise((resolve, reject) => {
        const p = spawn('say', ['-v', 'Monica', text, '-o', aiff]);
        p.on('close', c => c === 0 ? resolve() : reject());
      });
      await new Promise((resolve, reject) => {
        const p = spawn('afconvert', ['-f', 'WAVE', '-d', 'LEI16', aiff, wav]);
        p.on('close', c => c === 0 ? resolve() : reject());
      });
      fs.unlink(aiff, () => {});
    } else {
      return res.status(503).end('TTS not configured — run setup-piper.sh');
    }

    res.setHeader('Content-Type', 'audio/wav');
    const stream = fs.createReadStream(wav);
    stream.pipe(res);
    stream.on('end', cleanup);
    stream.on('error', cleanup);
  } catch {
    cleanup();
    res.status(500).end();
  }
});

// ── HTTP server + WebSocket terminal ──
const server = http.createServer(app);

const NVM_BIN = '/Users/lowie/.nvm/versions/node/v24.14.0/bin';

const wss = new WebSocketServer({
  server,
  path: '/terminal-ws',
  verifyClient: ({ req }) => isTerminalAuthed(req.headers.cookie)
});

wss.on('connection', (ws) => {
  const NODE_BIN = '/Users/lowie/.nvm/versions/node/v24.14.0/bin/node';
  const CLAUDE_SCRIPT = '/Users/lowie/.nvm/versions/node/v24.14.0/lib/node_modules/@anthropic-ai/claude-code/cli.js';
  let shell;
  try {
    shell = pty.spawn(NODE_BIN, [CLAUDE_SCRIPT], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: '/Users/lowie/LingLo',
      env: {
        ...process.env,
        PATH: `${NVM_BIN}:${process.env.PATH || '/usr/bin:/bin'}`,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        CLAUDECODE: undefined,
      }
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'data', data: `\r\nFailed to start Claude Code: ${err.message}\r\n` }));
    ws.send(JSON.stringify({ type: 'exit' }));
    ws.close();
    return;
  }

  shell.onData(data => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
  });

  shell.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit' }));
    ws.close();
  });

  ws.on('message', raw => {
    try {
      const { type, data, cols, rows } = JSON.parse(raw);
      if (type === 'input') shell.write(data);
      if (type === 'resize') shell.resize(Math.max(1, cols), Math.max(1, rows));
    } catch {}
  });

  ws.on('close', () => { try { shell.kill(); } catch {} });
});

autoImport().then(() => {
  server.listen(PORT, () => console.log(`LingLo → http://localhost:${PORT}`));
});
