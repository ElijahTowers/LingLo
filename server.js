const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
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

app.use(express.json());
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
  // Extract body content if full document
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) html = bodyMatch[1];
  // Strip scripts and styles
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Strip image tags (epub images won't resolve)
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
  res.json(db.prepare('SELECT * FROM books ORDER BY created_at DESC').all());
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
    const chapters = epub.flow
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
    const chapters = epub.flow.filter(ch => ch.id);
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

autoImport().then(() => {
  app.listen(PORT, () => console.log(`LingLo → http://localhost:${PORT}`));
});
