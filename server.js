require('dotenv').config();
const APP_VERSION = 'v5.00';
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { EPub } = require('epub2');
const Database = require('better-sqlite3');
const { newStemmer } = require('snowball-stemmers');

const app = express();
const PORT = parseInt(process.env.PORT || '3200', 10);
const BOOK_ANALYSIS_VERSION = 1;
const spanishStemmer = newStemmer('spanish');
const analysisPromises = new Map();

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
  CREATE TABLE IF NOT EXISTS book_analysis (
    book_id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL,
    analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    token_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (book_id) REFERENCES books(id)
  );
  CREATE TABLE IF NOT EXISTS book_lemma_counts (
    book_id INTEGER NOT NULL,
    lemma_key TEXT NOT NULL,
    count INTEGER NOT NULL,
    sample TEXT NOT NULL,
    PRIMARY KEY (book_id, lemma_key),
    FOREIGN KEY (book_id) REFERENCES books(id)
  );
  CREATE TABLE IF NOT EXISTS book_surface_counts (
    book_id INTEGER NOT NULL,
    surface_key TEXT NOT NULL,
    lemma_key TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (book_id, surface_key),
    FOREIGN KEY (book_id) REFERENCES books(id)
  );
  CREATE TABLE IF NOT EXISTS book_chapter_cache (
    book_id INTEGER NOT NULL,
    chapter_index INTEGER NOT NULL,
    normalized_text TEXT NOT NULL,
    PRIMARY KEY (book_id, chapter_index),
    FOREIGN KEY (book_id) REFERENCES books(id)
  );
  CREATE TABLE IF NOT EXISTS reading_pages (
    read_date TEXT NOT NULL,
    book_id INTEGER NOT NULL,
    chapter_index INTEGER NOT NULL,
    page_number INTEGER NOT NULL,
    words_read INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (read_date, book_id, chapter_index, page_number),
    FOREIGN KEY (book_id) REFERENCES books(id)
  );
  CREATE TABLE IF NOT EXISTS saved_item_encounters (
    book_id INTEGER NOT NULL,
    chapter_index INTEGER NOT NULL,
    page_number INTEGER NOT NULL,
    word_key TEXT NOT NULL,
    encountered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (book_id, chapter_index, page_number, word_key),
    FOREIGN KEY (book_id) REFERENCES books(id)
  );
  CREATE INDEX IF NOT EXISTS idx_book_lemma_counts_book_id ON book_lemma_counts(book_id);
  CREATE INDEX IF NOT EXISTS idx_book_surface_counts_book_id ON book_surface_counts(book_id);
  CREATE INDEX IF NOT EXISTS idx_reading_pages_read_date ON reading_pages(read_date);
  CREATE INDEX IF NOT EXISTS idx_saved_item_encounters_lookup ON saved_item_encounters(book_id, word_key);
`);

// ── Auth ──
const PASSWORD = process.env.LINGLO_PASSWORD;
if (!PASSWORD) { console.error('LINGLO_PASSWORD not set in .env'); process.exit(1); }

const sessions = new Set();

// Rate limiting: ip -> { attempts, resetAt }
const loginAttempts = new Map();

const RATE_WINDOW = 15 * 60 * 1000;           // 15 minutes
const LOGIN_MAX = 10;                          // max password attempts per window

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
  for (const [k, v] of loginAttempts) if (now > v.resetAt) loginAttempts.delete(k);
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
  const nextUrl = encodeURIComponent(req.originalUrl || '/');
  res.redirect(`/login?next=${nextUrl}`);
}

async function ollamaGenerateText(prompt, model = 'qwen2.5-coder:7b') {
  const r = await fetch('http://localhost:11435/api/generate', {
    headers: { 'X-Source': 'linglo' },
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: true })
  });
  if (!r.ok || !r.body) throw new Error('Ollama not available');
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split('\n')) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        if (json.response) out += json.response;
      } catch { }
    }
  }
  return out.trim();
}

// ── Gemini backend ──
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.0-flash';

async function geminiGenerateText(prompt) {
  if (!GEMINI_API_KEY) throw new Error('No Gemini API key configured');
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    }
  );
  if (!r.ok) throw new Error(`Gemini error: ${r.status}`);
  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function geminiStream(prompt, res) {
  if (!GEMINI_API_KEY) throw new Error('No Gemini API key configured');
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    }
  );
  if (!r.ok) throw new Error(`Gemini error: ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value, { stream: true }).split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const json = JSON.parse(line.slice(6));
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) res.write(text);
      } catch { }
    }
  }
  res.end();
}

// ── Settings (ai backend) ──
const SETTINGS_FILE = path.join(__dirname, 'db', 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}
let appSettings = loadSettings();

// ── AI router ──
async function aiGenerateText(prompt) {
  if ((appSettings.aiBackend || 'ollama') === 'gemini') return geminiGenerateText(prompt);
  return ollamaGenerateText(prompt);
}

async function aiStream(prompt, res) {
  if ((appSettings.aiBackend || 'ollama') === 'gemini') return geminiStream(prompt, res);
  // Ollama streaming
  const r = await fetch('http://localhost:11435/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen2.5-coder:7b', prompt, stream: true })
  });
  if (!r.ok || !r.body) throw new Error('Ollama not available');
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
      } catch { }
    }
  }
  res.end();
}

function tokenizeForHighlight(text) {
  const tokens = [];
  const re = /[A-Za-zÀ-ÖØ-öø-ÿ']+/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    tokens.push({
      value: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return tokens;
}

function findHighlightSpan(sentenceTranslation, focusTranslation) {
  const sentenceTokens = tokenizeForHighlight(sentenceTranslation);
  const focusTokens = tokenizeForHighlight(focusTranslation);
  if (!sentenceTokens.length || !focusTokens.length) return null;

  const focusPhrase = focusTokens.map(t => t.value).join(' ');
  let best = null;

  for (let start = 0; start < sentenceTokens.length; start++) {
    for (let len = Math.max(1, focusTokens.length - 1); len <= Math.min(sentenceTokens.length - start, focusTokens.length + 2); len++) {
      const window = sentenceTokens.slice(start, start + len);
      const windowPhrase = window.map(t => t.value).join(' ');
      let score = 0;

      if (windowPhrase === focusPhrase) score += 100;

      const focusSet = new Set(focusTokens.map(t => t.value));
      const windowSet = new Set(window.map(t => t.value));
      for (const token of windowSet) {
        if (focusSet.has(token)) score += 12;
      }

      if (window[0]?.value === focusTokens[0]?.value) score += 4;
      if (window[window.length - 1]?.value === focusTokens[focusTokens.length - 1]?.value) score += 4;
      score -= Math.abs(window.length - focusTokens.length) * 3;

      if (!best || score > best.score) {
        best = {
          score,
          start: window[0].start,
          end: window[window.length - 1].end
        };
      }
    }
  }

  return best && best.score > 0 ? best : null;
}

function withHighlight(sentenceTranslation, focusTranslation) {
  const span = findHighlightSpan(sentenceTranslation, focusTranslation);
  if (!span) return sentenceTranslation;
  return `${sentenceTranslation.slice(0, span.start)}[HL]${sentenceTranslation.slice(span.start, span.end)}[/HL]${sentenceTranslation.slice(span.end)}`;
}

function countWordTokens(text) {
  return (text.match(/[A-Za-zÀ-ÖØ-öø-ÿ']+/g) || []).length;
}

function extractContextualFocus(word, sentence) {
  const target = canonicalizeSpanishToken(word);
  if (!target || !sentence) return word;
  const tokens = [...sentence.matchAll(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+/g)].map(match => ({
    raw: match[0],
    canonical: canonicalizeSpanishToken(match[0])
  }));
  const idx = tokens.findIndex(token => token.canonical === target);
  if (idx <= 0) return word;
  const previous = tokens[idx - 1].canonical;
  if (['me', 'te', 'se', 'nos', 'os'].includes(previous)) {
    return `${tokens[idx - 1].raw} ${tokens[idx].raw}`;
  }
  return word;
}

async function translateSingleWordInContext(word, sentence, sentenceTranslation = '') {
  const focus = extractContextualFocus(word, sentence);
  if (sentenceTranslation) {
    const alignedPrompt = `The user clicked the single Spanish word "${word}" in this sentence:
"${sentence}"

Here is a natural English translation of the whole sentence:
"${sentenceTranslation}"

Use the Spanish sentence and this English sentence translation together.

Reply ONLY with the smallest English word or short phrase from that English sentence that best matches the clicked Spanish word in context.

Rules:
- Prefer the wording already used in the English sentence
- Maximum 3 English words
- No explanations
- No punctuation
- No quotes

Good examples:
- "trepidantes" in "quince minutos trepidantes" with English "fifteen intense minutes" -> "intense"
- "llamadas" with English "important phone calls" -> "phone calls"
- "dirigió" with English "headed for the platforms" -> "headed"`;
    let aligned = await aiGenerateText(alignedPrompt);
    if (countWordTokens(aligned) <= 3) return aligned.trim();
  }

  const basePrompt = `The user clicked the single Spanish word "${word}" in this sentence:
"${sentence}"

Translate the clicked word as it functions here. If it is part of a reflexive mini-construction like "${focus}", use that local construction to understand the word, but still return only the smallest English equivalent for the clicked word's meaning.

Rules:
- Return the smallest exact English equivalent of the clicked word only
- Do not include words that translate neighboring Spanish words
- Do not include following prepositional phrases or objects
- If the clicked word is a preposition, article, pronoun, or particle, still translate only that single word
- No explanations
- No punctuation
- No quotes

Good examples:
- "por" in "lo llevo por la estacion" -> "through"
- "a" in "fue a la casa" -> "to"
- "de" in "el libro de Harry" -> "of"
- "llamarse" in "Podria llamarse Harvey" -> "be named"
- "dirigio" in "se dirigio hacia los andenes" -> "headed"
- "dirigio" in "dirigio la mirada a Harry" -> "turned"`;

  let translation = await aiGenerateText(basePrompt);
  if (countWordTokens(translation) <= 3) return translation.trim();

  const retryPrompt = `Your previous answer was too broad because it included neighboring words.

Clicked word: "${word}"
Sentence: "${sentence}"
Local focus: "${focus}"
Bad answer: "${translation}"

Reply again with ONLY the smallest English equivalent of the clicked Spanish word itself.

Rules:
- Maximum 3 English words
- No surrounding phrase
- No translation of following prepositions or noun phrases
- No explanations
- No punctuation
- No quotes`;

  translation = await aiGenerateText(retryPrompt);
  return translation.trim();
}

// ── Parsers ──
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Login routes (no auth required) ──
app.get('/login', (req, res) => {
  const err = req.url.includes('?err') ? '<p class="err">Wrong password.</p>' : '';
  let next = '/';
  try {
    const u = new URL(`http://linglo.local${req.url}`);
    const candidate = u.searchParams.get('next');
    if (candidate && candidate.startsWith('/')) next = candidate;
  } catch {}
  const nextEscaped = next
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
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
      background: #1a1612;
      font-family: 'Inter', system-ui, sans-serif;
      color: #ede0cc;
      transition: background 0.2s, color 0.2s;
    }
    body.theme-light {
      background: #faf7f2;
      color: #1e1610;
    }
    body.theme-ereader {
      background: #ffffff;
      color: #000000;
    }
    body.theme-ereader * { transition: none !important; }
    .card {
      background: #231e18;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 40px 36px;
      width: min(360px, 92vw);
    }
    body.theme-light .card {
      background: #f2ece2;
      border-color: rgba(0,0,0,0.12);
    }
    body.theme-ereader .card {
      background: #ffffff;
      border: 1px solid #000000;
      box-shadow: none;
    }
    .logo { font-size: 1.6rem; font-weight: 700; font-family: 'Lora', Georgia, serif; letter-spacing: -0.3px; margin-bottom: 8px; color: #ede0cc; }
    body.theme-light .logo { color: #1e1610; }
    body.theme-ereader .logo { color: #000000; }
    .sub { font-size: 0.85rem; color: rgba(237,224,204,0.45); margin-bottom: 28px; }
    body.theme-light .sub { color: rgba(30,22,16,0.5); }
    body.theme-ereader .sub { color: #555555; }
    label { font-size: 0.8rem; color: rgba(237,224,204,0.45); display: block; margin-bottom: 6px; }
    body.theme-light label { color: rgba(30,22,16,0.5); }
    body.theme-ereader label { color: #555555; }
    input[type=password] {
      width: 100%;
      background: #1a1612;
      border: 1px solid rgba(255,255,255,0.11);
      border-radius: 8px;
      padding: 10px 14px;
      color: #ede0cc;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.15s;
    }
    body.theme-light input[type=password] {
      background: #e8dfd0;
      border-color: rgba(0,0,0,0.18);
      color: #1e1610;
    }
    body.theme-ereader input[type=password] {
      background: #ffffff;
      border: 1px solid #000000;
      color: #000000;
    }
    input[type=password]:focus { border-color: #d4874a; }
    body.theme-ereader input[type=password]:focus { border-color: #000000; }
    .signin-btn {
      margin-top: 16px;
      width: 100%;
      background: #a85f2e;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 11px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .signin-btn:hover { background: #d4874a; }
    body.theme-light .signin-btn { background: #8b4513; }
    body.theme-light .signin-btn:hover { background: #7c3d0f; }
    body.theme-ereader .signin-btn { background: #000000; color: #ffffff; }
    body.theme-ereader .signin-btn:hover { background: #333333; }
    .err { margin-top: 12px; font-size: 0.82rem; color: #e07070; }
    body.theme-ereader .err { color: #000000; }
    .theme-toggle {
      display: flex;
      gap: 6px;
      margin-top: 20px;
      justify-content: center;
    }
    .theme-btn {
      flex: 1;
      padding: 6px 0;
      font-size: 0.78rem;
      font-weight: 500;
      border-radius: 6px;
      cursor: pointer;
      border: 1px solid rgba(255,255,255,0.11);
      background: transparent;
      color: rgba(237,224,204,0.45);
      transition: all 0.15s;
    }
    body.theme-light .theme-btn { border-color: rgba(0,0,0,0.18); color: rgba(30,22,16,0.45); }
    body.theme-ereader .theme-btn { border-color: #888888; color: #555555; }
    .theme-btn.active {
      background: #a85f2e;
      border-color: #a85f2e;
      color: #ffffff;
    }
    body.theme-light .theme-btn.active { background: #8b4513; border-color: #8b4513; }
    body.theme-ereader .theme-btn.active { background: #000000; border-color: #000000; color: #ffffff; }
  </style>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;700&display=swap" rel="stylesheet">
</head>
<body>
  <script>
    (function() {
      try {
        var s = JSON.parse(localStorage.getItem('linglo_settings'));
        if (s && s.theme === 'light') document.body.classList.add('theme-light');
        if (s && s.theme === 'ereader') document.body.classList.add('theme-ereader');
      } catch(e) {}
    })();
  </script>
  <div class="card">
    <div class="logo">LingLo</div>
    <div class="sub">Enter your password to continue</div>
    <form method="POST" action="/login">
      <input type="hidden" name="next" value="${nextEscaped}">
      <label for="pw">Password</label>
      <input type="password" id="pw" name="password" autofocus autocomplete="current-password">
      <button type="submit" class="signin-btn">Sign in</button>
      ${err}
    </form>
    <div class="theme-toggle">
      <button class="theme-btn" id="btn-dark" onclick="setTheme('dark')">Dark</button>
      <button class="theme-btn" id="btn-light" onclick="setTheme('light')">Light</button>
      <button class="theme-btn" id="btn-ereader" onclick="setTheme('ereader')">E-ink</button>
    </div>
  </div>
  <script>
    function getTheme() {
      try { return (JSON.parse(localStorage.getItem('linglo_settings')) || {}).theme || 'dark'; } catch(e) { return 'dark'; }
    }
    function setTheme(t) {
      try {
        var s = JSON.parse(localStorage.getItem('linglo_settings')) || {};
        s.theme = t;
        localStorage.setItem('linglo_settings', JSON.stringify(s));
      } catch(e) {}
      document.body.classList.toggle('theme-light', t === 'light');
      document.body.classList.toggle('theme-ereader', t === 'ereader');
      updateButtons(t);
    }
    function updateButtons(t) {
      ['dark','light','ereader'].forEach(function(name) {
        document.getElementById('btn-' + name).classList.toggle('active', name === t);
      });
    }
    updateButtons(getTheme());
  </script>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (isRateLimited(loginAttempts, ip, LOGIN_MAX))
    return res.status(429).send('Too many attempts. Try again in 15 minutes.');
  const next = typeof req.body.next === 'string' && req.body.next.startsWith('/') ? req.body.next : '/';
  if (timingSafeCompare(req.body.password || '', PASSWORD)) {
    const token = createSession();
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `linglo_s=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=2592000`);
    res.redirect(next);
  } else {
    res.redirect(`/login?err=1&next=${encodeURIComponent(next)}`);
  }
});

app.post('/logout', (req, res) => {
  sessions.delete(getToken(req.headers.cookie));
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `linglo_s=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`);
  res.redirect('/login');
});

// ── Auth wall — everything below requires login ──
app.use(authMiddleware);
app.use(express.static('public', {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

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

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;|&#160;|&#x00A0;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function chapterHtmlToText(html) {
  return decodeHtmlEntities(cleanHtml(html).replace(/<[^>]+>/g, ' '))
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSpanishLetters(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[áàäâ]/g, 'a')
    .replace(/[éèëê]/g, 'e')
    .replace(/[íìïî]/g, 'i')
    .replace(/[óòöô]/g, 'o')
    .replace(/[úùüû]/g, 'u');
}

function canonicalizeSpanishToken(text) {
  return normalizeSpanishLetters(text).replace(/[^a-zñ]/g, '');
}

function singularizeSpanishToken(token) {
  if (!token) return '';
  if (token.endsWith('ces') && token.length > 4) return `${token.slice(0, -3)}z`;
  if (token.endsWith('es') && token.length > 4) {
    if (/(iones|adores|adoras|antes|ores|oras|ales|eles|iles|enes|eses)$/.test(token)) {
      return token.slice(0, -2);
    }
  }
  if (token.endsWith('s') && token.length > 4 && !/(is|us|ss)$/.test(token)) {
    return token.slice(0, -1);
  }
  return token;
}

function lemmaKeyForToken(text) {
  const canonical = canonicalizeSpanishToken(text);
  if (!canonical) return '';
  const singular = singularizeSpanishToken(canonical);
  return spanishStemmer.stem(singular) || singular;
}

function tokenizeSpanishWords(text) {
  return (text.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+/g) || []);
}

function tokenizeSearchableText(text) {
  return [...text.matchAll(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+/g)].map(match => ({
    raw: match[0],
    value: normalizeSpanishLetters(match[0]),
    start: match.index,
    end: match.index + match[0].length
  }));
}

function normalizeTextForPhraseSearch(text) {
  return normalizeSpanishLetters(text)
    .replace(/[^a-zñ]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDateString(date);
}

function getQualifyingStreakDates(goal) {
  return db.prepare(
    `SELECT read_date
     FROM reading_pages
     GROUP BY read_date
     HAVING SUM(words_read) >= ?
     ORDER BY read_date ASC`
  ).all(goal).map(row => row.read_date);
}

function computeLongestStreak(qualifyingDates) {
  if (!qualifyingDates.length) return 0;
  let longest = 1;
  let current = 1;
  for (let i = 1; i < qualifyingDates.length; i++) {
    if (addDays(qualifyingDates[i - 1], 1) === qualifyingDates[i]) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }
  return longest;
}

function computeServerStreakStats() {
  const goal = 500;
  const today = localDateString();
  const dailyWords = db.prepare(
    'SELECT COALESCE(SUM(words_read), 0) AS total FROM reading_pages WHERE read_date = ?'
  ).get(today).total || 0;
  const qualifyingDates = getQualifyingStreakDates(goal);
  const qualifying = new Set(qualifyingDates);
  const yesterday = addDays(today, -1);
  let streak = 0;
  let cursor = qualifying.has(today) ? today : (qualifying.has(yesterday) ? yesterday : null);
  while (cursor && qualifying.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return {
    dailyWords,
    streak,
    goal,
    goalMet: dailyWords >= goal
  };
}

function computeMotivationStats() {
  const streakStats = computeServerStreakStats();
  const totalWordsRead = db.prepare(
    'SELECT COALESCE(SUM(words_read), 0) AS total FROM reading_pages'
  ).get().total || 0;
  const totalSavedWords = db.prepare(
    'SELECT COUNT(*) AS total FROM words'
  ).get().total || 0;
  const totalBooksStarted = db.prepare(
    'SELECT COUNT(DISTINCT book_id) AS total FROM reading_pages WHERE book_id IS NOT NULL'
  ).get().total || 0;
  return {
    ...streakStats,
    totalWordsRead,
    totalSavedWords,
    totalBooksStarted,
    longestStreak: computeLongestStreak(getQualifyingStreakDates(streakStats.goal))
  };
}

function countPhraseOccurrences(normalizedText, normalizedPhrase) {
  if (!normalizedText || !normalizedPhrase) return 0;
  const escaped = normalizedPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = normalizedText.match(new RegExp(`(^| )${escaped}(?= |$)`, 'g'));
  return matches ? matches.length : 0;
}

function getBookOccurrenceCount(bookId, text) {
  const tokens = tokenizeSpanishWords(String(text || '').trim());
  if (!bookId || !tokens.length) return 0;
  if (tokens.length > 1) {
    const normalizedPhrase = normalizeTextForPhraseSearch(text);
    const chapters = db.prepare(
      'SELECT normalized_text FROM book_chapter_cache WHERE book_id = ? ORDER BY chapter_index'
    ).all(bookId);
    return chapters.reduce((sum, chapter) => sum + countPhraseOccurrences(chapter.normalized_text, normalizedPhrase), 0);
  }
  const surfaceKey = canonicalizeSpanishToken(tokens[0]);
  const lemmaKey = lemmaKeyForToken(tokens[0]);
  const exactRow = db.prepare(
    'SELECT count FROM book_surface_counts WHERE book_id = ? AND surface_key = ?'
  ).get(bookId, surfaceKey);
  const lemmaRow = db.prepare(
    'SELECT count FROM book_lemma_counts WHERE book_id = ? AND lemma_key = ?'
  ).get(bookId, lemmaKey);
  return lemmaRow?.count || exactRow?.count || 0;
}

async function getChapterHtml(epub, chapterId) {
  try {
    return await epub.getChapterRawAsync(chapterId);
  } catch {
    return epub.getChapterAsync(chapterId);
  }
}

const clearBookAnalysis = db.transaction((bookId) => {
  db.prepare('DELETE FROM book_lemma_counts WHERE book_id = ?').run(bookId);
  db.prepare('DELETE FROM book_surface_counts WHERE book_id = ?').run(bookId);
  db.prepare('DELETE FROM book_chapter_cache WHERE book_id = ?').run(bookId);
  db.prepare('DELETE FROM book_analysis WHERE book_id = ?').run(bookId);
});

const saveBookAnalysis = db.transaction((bookId, tokenCount, lemmaRows, surfaceRows, chapterRows) => {
  clearBookAnalysis(bookId);
  const insertLemma = db.prepare(
    'INSERT INTO book_lemma_counts (book_id, lemma_key, count, sample) VALUES (?, ?, ?, ?)'
  );
  const insertSurface = db.prepare(
    'INSERT INTO book_surface_counts (book_id, surface_key, lemma_key, count) VALUES (?, ?, ?, ?)'
  );
  const insertChapter = db.prepare(
    'INSERT INTO book_chapter_cache (book_id, chapter_index, normalized_text) VALUES (?, ?, ?)'
  );
  const insertAnalysis = db.prepare(
    'INSERT INTO book_analysis (book_id, version, analyzed_at, token_count) VALUES (?, ?, CURRENT_TIMESTAMP, ?)'
  );

  for (const row of lemmaRows) insertLemma.run(bookId, row.lemmaKey, row.count, row.sample);
  for (const row of surfaceRows) insertSurface.run(bookId, row.surfaceKey, row.lemmaKey, row.count);
  for (const row of chapterRows) insertChapter.run(bookId, row.chapterIndex, row.normalizedText);
  insertAnalysis.run(bookId, BOOK_ANALYSIS_VERSION, tokenCount);
});

async function analyzeBookFrequency(book) {
  if (!book) return null;
  const existing = analysisPromises.get(book.id);
  if (existing) return existing;

  const job = (async () => {
    const epub = await getEpub(book.filepath);
    const chapters = epub.toc.filter(ch => ch.id);
    const lemmaCounts = new Map();
    const surfaceCounts = new Map();
    const chapterRows = [];
    let tokenCount = 0;

    for (let i = 0; i < chapters.length; i++) {
      let html;
      try {
        html = await getChapterHtml(epub, chapters[i].id);
      } catch {
        continue;
      }
      const rawText = chapterHtmlToText(html);
      const normalizedText = normalizeTextForPhraseSearch(rawText);
      chapterRows.push({ chapterIndex: i, normalizedText });

      for (const token of tokenizeSpanishWords(rawText)) {
        const surfaceKey = canonicalizeSpanishToken(token);
        if (!surfaceKey) continue;
        const lemmaKey = lemmaKeyForToken(token);
        tokenCount++;

        const lemmaEntry = lemmaCounts.get(lemmaKey) || { count: 0, sample: token };
        lemmaEntry.count++;
        if (!lemmaEntry.sample || token.length < lemmaEntry.sample.length) lemmaEntry.sample = token;
        lemmaCounts.set(lemmaKey, lemmaEntry);

        const surfaceEntry = surfaceCounts.get(surfaceKey) || { count: 0, lemmaKey };
        surfaceEntry.count++;
        surfaceCounts.set(surfaceKey, surfaceEntry);
      }
    }

    saveBookAnalysis(
      book.id,
      tokenCount,
      [...lemmaCounts.entries()].map(([lemmaKey, value]) => ({ lemmaKey, count: value.count, sample: value.sample })),
      [...surfaceCounts.entries()].map(([surfaceKey, value]) => ({ surfaceKey, lemmaKey: value.lemmaKey, count: value.count })),
      chapterRows
    );

    return {
      analyzedAt: db.prepare('SELECT analyzed_at FROM book_analysis WHERE book_id = ?').get(book.id)?.analyzed_at || null,
      tokenCount
    };
  })();

  analysisPromises.set(book.id, job);
  try {
    return await job;
  } finally {
    analysisPromises.delete(book.id);
  }
}

async function ensureBookAnalysis(bookId) {
  const status = db.prepare('SELECT version, analyzed_at, token_count FROM book_analysis WHERE book_id = ?').get(bookId);
  if (status && status.version === BOOK_ANALYSIS_VERSION) {
    return { analyzedAt: status.analyzed_at, tokenCount: status.token_count, freshlyAnalyzed: false };
  }
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
  if (!book) return null;
  const analysis = await analyzeBookFrequency(book);
  return { ...(analysis || {}), freshlyAnalyzed: true };
}

async function backfillBookAnalyses() {
  const books = db.prepare('SELECT id, title, filepath FROM books ORDER BY id').all();
  const pending = books.filter(book => {
    const status = db.prepare('SELECT version FROM book_analysis WHERE book_id = ?').get(book.id);
    return !status || status.version !== BOOK_ANALYSIS_VERSION;
  });
  if (!pending.length) return;
  console.log(`Backfilling book frequency analysis for ${pending.length} book(s)...`);
  for (const book of pending) {
    console.log(`Analyzing existing book: "${book.title}"`);
    await analyzeBookFrequency(book);
  }
  console.log('Book frequency backfill complete.');
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

app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));

app.get('/api/streak', (req, res) => {
  res.json(computeServerStreakStats());
});

app.get('/api/motivation', (req, res) => {
  res.json(computeMotivationStats());
});

app.post('/api/reading-event', (req, res) => {
  const bookId = parseInt(req.body.bookId, 10);
  const chapterIndex = parseInt(req.body.chapterIndex, 10);
  const pageNumber = parseInt(req.body.pageNumber, 10);
  const wordsRead = Math.max(0, Math.min(2000, parseInt(req.body.wordsRead, 10) || 0));
  if (!bookId || isNaN(chapterIndex) || chapterIndex < 0 || isNaN(pageNumber) || pageNumber < 0 || wordsRead <= 0) {
    return res.status(400).json({ error: 'Invalid reading event' });
  }

  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(bookId);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const savedKeys = Array.isArray(req.body.savedKeys)
    ? [...new Set(req.body.savedKeys
      .map(key => String(key || '').trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 50))]
    : [];

  const today = localDateString();
  db.prepare(
    `INSERT OR IGNORE INTO reading_pages
     (read_date, book_id, chapter_index, page_number, words_read)
     VALUES (?, ?, ?, ?, ?)`
  ).run(today, bookId, chapterIndex, pageNumber, wordsRead);
  if (savedKeys.length) {
    const insertEncounter = db.prepare(
      `INSERT OR IGNORE INTO saved_item_encounters
       (book_id, chapter_index, page_number, word_key)
       VALUES (?, ?, ?, ?)`
    );
    for (const key of savedKeys) insertEncounter.run(bookId, chapterIndex, pageNumber, key);
  }

  res.json(computeServerStreakStats());
});

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
    analyzeBookFrequency({
      id: result.lastInsertRowid,
      title,
      filepath: req.file.path
    }).catch(err => console.error(`Could not analyze uploaded book "${title}":`, err.message));
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

app.get('/api/books/:id/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const queryWords = normalizeTextForPhraseSearch(q).split(/\s+/).filter(Boolean);
    if (!queryWords.length || queryWords.join(' ').length < 2) return res.json([]);

    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    const epub = await getEpub(book.filepath);
    const chapters = epub.toc.filter(ch => ch.id);

    const results = [];
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      let html;
      try {
        html = await epub.getChapterRawAsync(chapter.id);
      } catch {
        try {
          html = await epub.getChapterAsync(chapter.id);
        } catch {
          continue;
        }
      }

      const rawText = chapterHtmlToText(html);
      const tokens = tokenizeSearchableText(rawText);

      for (let tokenIndex = 0; tokenIndex <= tokens.length - queryWords.length; tokenIndex++) {
        let matches = true;
        for (let offset = 0; offset < queryWords.length; offset++) {
          if (tokens[tokenIndex + offset].value !== queryWords[offset]) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;

        const start = Math.max(0, tokens[tokenIndex].start - 40);
        const end = Math.min(rawText.length, tokens[tokenIndex + queryWords.length - 1].end + 40);
        let snippet = rawText.substring(start, end).trim();
        if (start > 0) snippet = '...' + snippet;
        if (end < rawText.length) snippet = snippet + '...';

        results.push({
          chapterIndex: i,
          chapterTitle: chapter.title || `Chapter ${i + 1}`,
          snippet,
          match: rawText.substring(tokens[tokenIndex].start, tokens[tokenIndex + queryWords.length - 1].end)
        });

        if (results.length > 500) break;
      }
      if (results.length > 500) break;
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/books/:id/frequency', async (req, res) => {
  try {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });

    const analysis = await ensureBookAnalysis(book.id);
    const tokens = tokenizeSpanishWords(text);
    if (!tokens.length) {
      return res.json({ type: 'word', count: 0, exactCount: 0, lemmaCount: 0, freshlyAnalyzed: analysis?.freshlyAnalyzed || false });
    }

    if (tokens.length > 1) {
      const normalizedPhrase = normalizeTextForPhraseSearch(text);
      const chapters = db.prepare('SELECT normalized_text FROM book_chapter_cache WHERE book_id = ? ORDER BY chapter_index').all(book.id);
      const count = chapters.reduce((sum, chapter) => sum + countPhraseOccurrences(chapter.normalized_text, normalizedPhrase), 0);
      const encounterCount = db.prepare(
        'SELECT COUNT(*) AS total FROM saved_item_encounters WHERE book_id = ? AND word_key = ?'
      ).get(book.id, text.trim().toLowerCase()).total || 0;
      return res.json({
        type: 'phrase',
        count,
        encounterCount,
        normalizedPhrase,
        freshlyAnalyzed: analysis?.freshlyAnalyzed || false,
        analyzedAt: analysis?.analyzedAt || null
      });
    }

    const surfaceKey = canonicalizeSpanishToken(tokens[0]);
    const lemmaKey = lemmaKeyForToken(tokens[0]);
    const exactRow = db.prepare(
      'SELECT count FROM book_surface_counts WHERE book_id = ? AND surface_key = ?'
    ).get(book.id, surfaceKey);
    const lemmaRow = db.prepare(
      'SELECT count, sample FROM book_lemma_counts WHERE book_id = ? AND lemma_key = ?'
    ).get(book.id, lemmaKey);
    const encounterCount = db.prepare(
      'SELECT COUNT(*) AS total FROM saved_item_encounters WHERE book_id = ? AND word_key = ?'
    ).get(book.id, text.trim().toLowerCase()).total || 0;

    res.json({
      type: 'word',
      count: lemmaRow?.count || exactRow?.count || 0,
      exactCount: exactRow?.count || 0,
      lemmaCount: lemmaRow?.count || 0,
      lemmaKey,
      sample: lemmaRow?.sample || tokens[0],
      encounterCount,
      freshlyAnalyzed: analysis?.freshlyAnalyzed || false,
      analyzedAt: analysis?.analyzedAt || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/translate', async (req, res) => {
  const { text, sentence, type } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'No text provided' });
  try {
    const trimmedText = text.trim();
    const singleWordSelection = countWordTokens(trimmedText) === 1;
    let prompt;
    if (type === 'context-combined') {
      const sentenceTranslation = await aiGenerateText(
        `Translate the following Spanish sentence to natural English. Reply ONLY with the translated English sentence, nothing else.\n\nSentence: "${sentence}"`
      );
      const focusTranslation = await aiGenerateText(
        `Translate the Spanish word or phrase "${text}" in the context of this sentence: "${sentence}".

Reply ONLY with the smallest exact English equivalent for that word or phrase.

Rules:
- No extra surrounding words
- No subject pronouns unless they are part of the focus itself
- No explanations
- No quotes

Examples:
"llamadas" -> "phone calls"
"llamarse" in "Podría llamarse Harvey." -> "be named"
"se dio cuenta" -> "realized"`
      );
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(withHighlight(sentenceTranslation, focusTranslation));
    } else if (singleWordSelection && sentence && sentence !== trimmedText) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      const sentenceTranslation = await aiGenerateText(
        `Translate the following Spanish sentence to natural English. Reply ONLY with the translated English sentence, nothing else.\n\nSentence: "${sentence}"`
      );
      return res.end(await translateSingleWordInContext(trimmedText, sentence, sentenceTranslation));
    } else if (type === 'context-sentence') {
      prompt = `Translate the following Spanish sentence to English. Reply ONLY with the translated English sentence, nothing else. Sentence: "${trimmedText}"`;
    } else {
      prompt = (sentence && sentence !== text)
        ? `Translate the Spanish word or phrase "${trimmedText}" in the context of this sentence: "${sentence}". Reply with ONLY the English translation of "${trimmedText}", nothing else.`
        : `Translate the Spanish word or phrase "${trimmedText}" to English. Reply with ONLY the English translation, nothing else.`;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    await aiStream(prompt, res);
  } catch {
    res.status(503).end('AI not available');
  }
});

app.post('/api/meanings', async (req, res) => {
  const { text, sentence, primaryMeaning } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'No text provided' });
  try {
    const prompt = `You are a concise Spanish dictionary assistant. The user clicked the Spanish word or phrase "${text}"${sentence ? ` in the sentence "${sentence}"` : ''}. The main in-context translation is "${primaryMeaning || ''}".

Give up to 3 short alternative English meanings or translations that this Spanish word or phrase can also have.

Rules:
- One meaning per line
- No numbering
- No quotes
- No explanations
- Avoid repeating the exact main in-context translation if possible
- If there are no good alternatives, reply with: none`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    await aiStream(prompt, res);
  } catch {
    res.status(503).end('AI not available');
  }
});

app.post('/api/regional-usage', async (req, res) => {
  const { text, sentence } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'No text provided' });
  try {
    const label = await aiGenerateText(
      `You are a concise Spanish usage classifier. Classify whether the Spanish word or phrase "${text.trim()}"${sentence ? ` in the sentence "${sentence}"` : ''} is more associated with Spain, more associated with Latin American Spanish, or broadly neutral.

Reply with EXACTLY one of these labels:
- Broadly neutral
- Mostly Spain
- Mostly Latin America
- Context-dependent

Prefer "Broadly neutral" if the term is standard across regions.`
    );
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(label.trim());
  } catch {
    res.status(503).end('Broadly neutral');
  }
});

app.post('/api/explain', async (req, res) => {
  const { word, sentence } = req.body;
  try {
    const prompt = `You are a concise Spanish language tutor. Always respond in English. The learner clicked on "${word}" in:\n"${sentence}"\n\nGive 3 short lines:\n1. Meaning in this context\n2. Grammar note (tense/conjugation if relevant)\n3. Memory tip\n\nNo headers, just the 3 lines. Respond in English only.`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    await aiStream(prompt, res);
  } catch {
    res.status(503).end('AI not available');
  }
});


app.post('/api/rarity', (req, res) => {
  const { words } = req.body;
  if (!Array.isArray(words) || words.length === 0) return res.json({});
  const child = spawn('/usr/bin/python3', [path.join(__dirname, 'wordfreq_lookup.py')]);
  let out = '';
  child.stdin.write(JSON.stringify(words));
  child.stdin.end();
  child.stdout.on('data', d => out += d.toString());
  child.on('close', () => { try { res.json(JSON.parse(out)); } catch { res.json({}); } });
  child.on('error', () => res.json({}));
});

app.post('/api/conjugate', async (req, res) => {
  const { word, sentence } = req.body;
  try {
    const prompt = `The Spanish word "${word}" appears in: "${sentence}". Is it a verb? If yes, reply in this exact format (3 lines, nothing else):\nInfinitive: [infinitive]\nPresent: yo [form], tú [form], él [form], nosotros [form], ellos [form]\nPreterite: yo [form]\nIf it is not a verb, reply with just: —`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    await aiStream(prompt, res);
  } catch { res.status(503).end('AI not available'); }
});

app.post('/api/idiom', async (req, res) => {
  const { text, sentence } = req.body;
  try {
    const prompt = `Is the Spanish phrase "${text}" an idiomatic expression or fixed phrase? Context: "${sentence}". If yes, reply with one short sentence explaining what it means as an idiom. If no, reply with just: no`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    await aiStream(prompt, res);
  } catch { res.status(503).end('AI not available'); }
});

app.post('/api/summarize', async (req, res) => {
  const { text, title } = req.body;
  if (!text?.trim()) return res.status(400).end('No text');
  try {
    const prompt = `Summarize this chapter${title ? ` ("${title}")` : ''} in 3-4 sentences in English. Be concise, focus on what happens. Do not start with "This chapter".\n\n${text.slice(0, 4000)}`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    await aiStream(prompt, res);
  } catch { res.status(503).end('AI not available'); }
});

app.post('/api/simplify', async (req, res) => {
  const { sentence } = req.body;
  if (!sentence?.trim()) return res.status(400).end('No sentence');
  try {
    const prompt = `Rewrite the following Spanish sentence into "Simple Spanish" suitable for a beginner (A1/A2 level). Keep the original meaning but use simpler words and structures. Respond ONLY with the simplified Spanish sentence, nothing else.\n\nSentence: "${sentence}"`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    await aiStream(prompt, res);
  } catch { res.status(503).end('AI not available'); }
});

app.get('/api/settings', (req, res) => {
  res.json({ aiBackend: appSettings.aiBackend || 'ollama' });
});

app.post('/api/settings', (req, res) => {
  const { aiBackend } = req.body;
  if (aiBackend === 'ollama' || aiBackend === 'gemini') {
    appSettings.aiBackend = aiBackend;
    saveSettings(appSettings);
    res.json({ ok: true, aiBackend });
  } else {
    res.status(400).json({ error: 'Invalid backend' });
  }
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

function callWordfreq(words) {
  return new Promise((resolve, reject) => {
    const py = spawn('/usr/bin/python3', [path.join(__dirname, 'wordfreq_lookup.py')]);
    let out = '';
    py.stdout.on('data', d => { out += d; });
    py.on('close', code => {
      if (code !== 0) return reject(new Error(`wordfreq exited ${code}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
    py.on('error', reject);
    py.stdin.write(JSON.stringify(words));
    py.stdin.end();
  });
}

app.get('/api/words', async (req, res) => {
  const words = db.prepare(`
    SELECT w.*, b.title as book_title
    FROM words w LEFT JOIN books b ON w.book_id = b.id
    ORDER BY w.created_at DESC
  `).all();
  const analyzedBooks = new Set(
    db.prepare('SELECT book_id FROM book_analysis WHERE version = ?').all(BOOK_ANALYSIS_VERSION).map(row => row.book_id)
  );
  words.forEach(w => {
    w.book_frequency = w.book_id && analyzedBooks.has(w.book_id)
      ? getBookOccurrenceCount(w.book_id, w.word)
      : null;
  });
  if (words.length > 0) {
    try {
      const freqs = await callWordfreq(words.map(w => w.word));
      words.forEach(w => { w.frequency = freqs[w.word] ?? 0; });
    } catch { }
  }
  res.json(words);
});

app.delete('/api/words/:id', (req, res) => {
  db.prepare('DELETE FROM words WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// TTS
const PIPER_DIR = path.join(__dirname, 'piper');
const PIPER_PY = path.join(PIPER_DIR, 'venv', 'bin', 'piper');
const PIPER_BIN = path.join(PIPER_DIR, process.platform === 'win32' ? 'piper.exe' : 'piper');
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

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const wav = path.join(os.tmpdir(), `linglo-${id}.wav`);
  const cleanup = () => fs.unlink(wav, () => { });

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
      fs.unlink(aiff, () => { });
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

autoImport().then(() => {
  app.listen(PORT, () => {
    console.log(`LingLo → http://localhost:${PORT}`);
    backfillBookAnalyses().catch(err => console.error('Book frequency backfill failed:', err.message));
  });
});
