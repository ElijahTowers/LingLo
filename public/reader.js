const params = new URLSearchParams(location.search);
const bookId = params.get('book');
if (!bookId) location.href = '/';

// ── Sentence translation helpers ──
function hlToHtml(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[HL\]/g, '<span class="hl">').replace(/\[\/HL\]/g, '</span>');
}
async function fetchSentenceTranslation(word, sentence) {
  const res = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: word, sentence, type: 'context-combined' })
  });
  if (!res.ok) throw new Error();
  let out = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out.trim();
}

// ── Rarity helpers ──
const rarityCache = new Map();
async function fetchRarity(words) {
  const needed = words.filter(w => !rarityCache.has(w));
  if (needed.length > 0) {
    try {
      const res = await fetch('/api/rarity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ words: needed }) });
      const data = await res.json();
      Object.entries(data).forEach(([w, v]) => rarityCache.set(w, v));
    } catch { needed.forEach(w => rarityCache.set(w, null)); }
  }
  return words.map(w => rarityCache.get(w) ?? null);
}
function rarityBadge(zipf) {
  if (zipf === null || zipf === undefined) return '';
  let label, cls;
  if (zipf >= 5)      { label = 'Common';    cls = 'rarity-common'; }
  else if (zipf >= 3) { label = 'Moderate';  cls = 'rarity-moderate'; }
  else if (zipf >= 1) { label = 'Rare';      cls = 'rarity-rare'; }
  else                { label = 'Very rare'; cls = 'rarity-very-rare'; }
  return `<span class="rarity ${cls}">${label}</span>`;
}

let chapters = [];
let currentIndex = 0;
let currentChapterTitle = '';
let savedWords = new Map(); // word.toLowerCase() → id
let activeWordEl = null;
let currentWord = '';
let currentTranslation = '';
let currentSentence = '';
let sidebarOpen = window.innerWidth >= 640;
let searchMatches = [];
let searchCurrent = -1;
let currentPage = 0;
let totalPages = 1;
let pageWidth = 0;
let wordsPerPage = 0;
let loggedPages = new Set();
let paginationTimer = null;
let pageArrivalTime = 0;
const MIN_PAGE_TIME = 30000; // 30 s on a page before its words count

// ── Progress persistence ──
function saveProgress() {
  const textCol = document.getElementById('text-column');
  if (!textCol) return;
  const ratio = textCol.scrollHeight > textCol.clientHeight 
    ? textCol.scrollTop / (textCol.scrollHeight - textCol.clientHeight) 
    : 0;
  try {
    localStorage.setItem(`linglo-progress-${bookId}`, JSON.stringify({
      chapter: currentIndex,
      ratio,
      total: chapters.length
    }));
  } catch {}
}
function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(`linglo-progress-${bookId}`));
    if (p && typeof p.chapter === 'number') return p;
  } catch {}
  // fallback to legacy chapter-only key
  const ch = parseInt(localStorage.getItem(`linglo-chapter-${bookId}`));
  return isNaN(ch) ? { chapter: 0, ratio: 0 } : { chapter: ch, ratio: 0 };
}

// ── Init ──
async function init() {
  renderReaderStreakCircle();
  await Promise.all([loadSavedWords(), loadChapters()]);
  const { chapter, ratio } = loadProgress();
  await loadChapter(chapter, false, ratio);
}

async function loadSavedWords() {
  const res = await fetch('/api/words');
  const words = await res.json();
  savedWords.clear();
  words.forEach(w => savedWords.set(w.word.toLowerCase(), { id: w.id, translation: w.translation }));
}

async function loadChapters() {
  const res = await fetch(`/api/books/${bookId}/chapters`);
  const data = await res.json();
  if (data.error) { alert(data.error); return; }
  chapters = data.chapters;
  document.getElementById('book-title').textContent = data.title;
  document.title = `LingLo — ${data.title}`;
}

async function loadChapter(index, goToLast = false, initRatio = 0) {
  if (index < 0 || index >= chapters.length) return;
  currentIndex = index;
  localStorage.setItem(`linglo-chapter-${bookId}`, index);

  // Track read chapters
  const readSet = new Set(JSON.parse(localStorage.getItem(`linglo-read-${bookId}`) || '[]'));
  readSet.add(index);
  localStorage.setItem(`linglo-read-${bookId}`, JSON.stringify([...readSet]));
  loggedPages = new Set();
  pageArrivalTime = 0;

  // Clear search state
  clearSearchHighlights();
  searchMatches = [];
  searchCurrent = -1;

  const content = document.getElementById('content');
  content.innerHTML = '<p style="color:rgba(255,255,255,0.2);font-style:italic">Loading…</p>';
  clearWordView();

  const res = await fetch(`/api/books/${bookId}/chapter/${index}`);
  const data = await res.json();
  if (data.error) { content.textContent = data.error; return; }

  currentChapterTitle = data.title;
  document.getElementById('chapter-title').textContent = data.title;
  content.innerHTML = data.html;

  wrapWords(content);
  markSavedWords(content);
  updateNav();
  setupPagination(goToLast ? 1 : initRatio);
}

// ── Word wrapping ──
function wrapWords(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement?.tagName?.toLowerCase();
      if (['script', 'style'].includes(tag)) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.classList.contains('word')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const node of nodes) {
    const text = node.textContent;
    if (!text.trim()) continue;
    const frag = document.createDocumentFragment();
    for (const part of text.split(/(\s+)/)) {
      if (/^\s+$/.test(part)) {
        frag.appendChild(document.createTextNode(part));
      } else if (part) {
        const span = document.createElement('span');
        span.className = 'word';
        span.textContent = part;
        frag.appendChild(span);
      }
    }
    node.parentNode.replaceChild(frag, node);
  }
}

function cleanWord(w) {
  return w.replace(/^[¿¡«"'()\[\]\-–—]+|[.,:;!?»"'()\[\]\-–—…]+$/g, '');
}

function markSavedWords(container) {
  container.querySelectorAll('.word').forEach(span => {
    if (savedWords.has(cleanWord(span.textContent).toLowerCase())) {
      span.classList.add('saved');
    }
  });
}

function getSentence(wordSpan) {
  const para = wordSpan.closest('p, h1, h2, h3, h4, li, div') || wordSpan.parentElement;
  if (!para) return '';
  const full = para.textContent.trim().replace(/\s+/g, ' ');
  const word = wordSpan.textContent.trim();
  const sentences = full.split(/(?<=[.!?…])\s+/);
  return sentences.find(s => s.includes(word)) || full;
}

// ── Drag selection ──
let dragStart = null;
let isDragging = false;
let dragHandled = false;

function clearDragSel() {
  document.querySelectorAll('#content .word.drag-sel').forEach(w => w.classList.remove('drag-sel'));
}

document.getElementById('content').addEventListener('mousedown', e => {
  const span = e.target.closest('.word');
  if (!span) return;
  dragStart = span;
  isDragging = false;
  dragHandled = false;
  clearDragSel();
});

document.getElementById('content').addEventListener('mouseover', e => {
  if (!dragStart || !e.buttons) { dragStart = null; return; }
  const span = e.target.closest('.word');
  if (!span || span === dragStart) return;
  isDragging = true;
  const allWords = [...document.querySelectorAll('#content .word')];
  const a = allWords.indexOf(dragStart), b = allWords.indexOf(span);
  const [from, to] = a < b ? [a, b] : [b, a];
  clearDragSel();
  allWords.slice(from, to + 1).forEach(w => w.classList.add('drag-sel'));
});

document.getElementById('content').addEventListener('mouseup', async e => {
  if (!isDragging || !dragStart) { dragStart = null; isDragging = false; return; }
  dragHandled = true;
  const selected = [...document.querySelectorAll('#content .word.drag-sel')];
  const startSpan = dragStart;
  dragStart = null;
  isDragging = false;
  await activatePhrase(selected, startSpan);
});

async function activatePhrase(selected, startSpan) {
  if (!selected.length) return;
  const text = selected.map(w => cleanWord(w.textContent)).filter(Boolean).join(' ');
  if (!text) return;

  if (activeWordEl) { activeWordEl.classList.remove('active'); activeWordEl = null; }
  currentWord = text;
  currentSentence = getSentence(startSpan);
  currentTranslation = '';

  if (isMobile()) {
    // Mobile: show inline popup above the first selected word
    showPopup(text, startSpan);
    speak(text);
    const popupSentTrans = document.getElementById('popup-sentence-translation');
    popupSentTrans.textContent = '';
    popupSentTrans.classList.remove('visible');
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, sentence: currentSentence })
      });
      if (!res.ok) throw new Error();
      popupTranslation.textContent = '';
      popupTranslation.className = 'popup-translation';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        popupTranslation.textContent += decoder.decode(value, { stream: true });
      }
      currentTranslation = popupTranslation.textContent.trim();
      positionPopup(startSpan);
    } catch {
      popupTranslation.textContent = 'Translation failed';
      popupTranslation.className = 'popup-translation';
    }
    // Auto-translate context sentence
    if (currentSentence) {
      fetchSentenceTranslation(text, currentSentence)
        .then(result => {
          popupSentTrans.innerHTML = hlToHtml(result);
          popupSentTrans.classList.add('visible');
          positionPopup(startSpan);
        }).catch(() => {});
    }
  } else {
    if (!sidebarOpen) openSidebar();
    showTab('translate');
    showWordView(text, currentSentence);
    speak(text);
    const transEl = document.getElementById('sidebar-translation');
    transEl.textContent = 'Translating…';
    transEl.className = 'sidebar-translation loading';
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, sentence: currentSentence })
      });
      if (!res.ok) throw new Error();
      transEl.textContent = '';
      transEl.className = 'sidebar-translation';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        transEl.textContent += decoder.decode(value, { stream: true });
      }
      currentTranslation = transEl.textContent.trim();
    } catch {
      transEl.textContent = 'Translation failed';
      transEl.className = 'sidebar-translation';
    }
    updateSaveBtn(text);

    // Auto-translate the context sentence
    if (currentSentence) {
      const sentTransEl = document.getElementById('sentence-translation');
      sentTransEl.innerHTML = '';
      sentTransEl.classList.add('visible');
      fetchSentenceTranslation(text, currentSentence)
        .then(result => { sentTransEl.innerHTML = hlToHtml(result); })
        .catch(() => { sentTransEl.innerHTML = ''; sentTransEl.classList.remove('visible'); });
    }
  }

  // Check for idioms if multi-word selection
  if (text.includes(' ')) {
    const idiomEl = document.getElementById('idiom-note');
    fetch('/api/idiom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sentence: currentSentence })
    }).then(async res => {
      let result = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
      result = result.trim();
      if (result && !/^no\.?$/i.test(result)) {
        idiomEl.textContent = result;
        idiomEl.classList.add('visible');
      }
    }).catch(() => {});
  }
}

// ── Touch drag selection ──
let touchDragStart = null;
let touchDragging = false;
let touchDragHandled = false;

document.getElementById('content').addEventListener('touchstart', e => {
  const span = e.target.closest('.word');
  if (!span) return;
  touchDragStart = span;
  touchDragging = false;
  touchDragHandled = false;
  clearDragSel();
}, { passive: true });

document.getElementById('content').addEventListener('touchmove', e => {
  if (!touchDragStart) return;
  const touch = e.touches[0];
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  const span = el?.closest('.word');
  if (!span || span === touchDragStart) return;
  touchDragging = true;
  e.preventDefault(); // prevent scroll while selecting words
  const allWords = [...document.querySelectorAll('#content .word')];
  const a = allWords.indexOf(touchDragStart), b = allWords.indexOf(span);
  const [from, to] = a < b ? [a, b] : [b, a];
  clearDragSel();
  allWords.slice(from, to + 1).forEach(w => w.classList.add('drag-sel'));
}, { passive: false });

document.getElementById('content').addEventListener('touchend', async e => {
  if (!touchDragging || !touchDragStart) { touchDragStart = null; touchDragging = false; return; }
  touchDragHandled = true;
  const selected = [...document.querySelectorAll('#content .word.drag-sel')];
  const startSpan = touchDragStart;
  touchDragStart = null;
  touchDragging = false;
  await activatePhrase(selected, startSpan);
});

// ── TTS ──
let _ttsAudio = null;
async function speak(text) {
  if (!text) return;
  if (_ttsAudio) { _ttsAudio.pause(); _ttsAudio = null; }
  try {
    const res = await fetch(`/api/tts?text=${encodeURIComponent(text)}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    _ttsAudio = new Audio(url);
    _ttsAudio.onended = () => { URL.revokeObjectURL(url); _ttsAudio = null; };
    _ttsAudio.play();
  } catch {}
}

document.getElementById('speak-btn').addEventListener('click', () => {
  if (currentWord) speak(currentWord);
});

// ── Word click ──
document.getElementById('content').addEventListener('click', async e => {
  if (dragHandled) { dragHandled = false; return; }
  const span = e.target.closest('.word');
  if (!span) return;
  e.stopPropagation();

  const raw = span.textContent;
  const word = cleanWord(raw);
  if (!word) return;

  // Deactivate previous
  if (activeWordEl) activeWordEl.classList.remove('active');
  activeWordEl = span;
  span.classList.add('active');

  currentWord = word;
  currentSentence = getSentence(span);
  currentTranslation = '';

  if (isMobile()) {
    // Mobile: show inline popup, leave sidebar closed
    showPopup(word, span);
    speak(word);
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: word, sentence: currentSentence })
      });
      if (!res.ok) throw new Error();
      popupTranslation.textContent = '';
      popupTranslation.className = 'popup-translation';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        popupTranslation.textContent += decoder.decode(value, { stream: true });
      }
      currentTranslation = popupTranslation.textContent.trim();
      // Re-position after content has rendered and height is known
      if (activeWordEl) positionPopup(activeWordEl);
    } catch {
      popupTranslation.textContent = 'Translation failed';
      popupTranslation.className = 'popup-translation';
    }
  } else {
    // Desktop: open sidebar as before
    if (!sidebarOpen) openSidebar();
    showTab('translate');
    showWordView(word, currentSentence);
    speak(word);
    const transEl = document.getElementById('sidebar-translation');
    transEl.textContent = 'Translating…';
    transEl.className = 'sidebar-translation loading';
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: word, sentence: currentSentence })
      });
      if (!res.ok) throw new Error();
      transEl.textContent = '';
      transEl.className = 'sidebar-translation';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        transEl.textContent += decoder.decode(value, { stream: true });
      }
      currentTranslation = transEl.textContent.trim();
    } catch {
      transEl.textContent = 'Translation failed';
      transEl.className = 'sidebar-translation';
    }
    updateSaveBtn(word);
  }
});


// ── Sidebar word view ──
function showWordView(word, sentence) {
  document.getElementById('sidebar-empty').style.display = 'none';
  document.getElementById('word-view').style.display = 'flex';
  document.getElementById('sidebar-word').textContent = word;
  document.getElementById('rarity-badge').innerHTML = '';
  fetchRarity([word]).then(([zipf]) => {
    document.getElementById('rarity-badge').innerHTML = rarityBadge(zipf);
  });
  document.getElementById('sidebar-translation').textContent = '';
  document.getElementById('sidebar-translation').className = 'sidebar-translation';

  // Sentence with highlight
  const sentEl = document.getElementById('sidebar-sentence');
  if (sentence) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const highlighted = sentence.replace(
      new RegExp(`(${escaped})`, 'gi'),
      '<span class="hl">$1</span>'
    );
    sentEl.innerHTML = highlighted.length > 300
      ? highlighted.slice(0, 300) + '…'
      : highlighted;
    sentEl.parentElement.style.display = '';
  } else {
    sentEl.innerHTML = '';
    sentEl.parentElement.style.display = 'none';
  }

  // Reset explanation
  const expEl = document.getElementById('explanation');
  expEl.textContent = '';
  expEl.classList.remove('visible');
  document.getElementById('explain-btn').textContent = '✦ Explain';
  const modelEl = document.getElementById('explain-model');
  modelEl.textContent = '';
  modelEl.classList.remove('visible');

  // Reset conjugation
  const conjEl = document.getElementById('conjugation');
  conjEl.textContent = '';
  conjEl.classList.remove('visible');
  document.getElementById('conjugate-btn').textContent = '⊞ Conjugate';


  // Reset idiom
  const idiomEl = document.getElementById('idiom-note');
  idiomEl.textContent = '';
  idiomEl.classList.remove('visible');

  // Reset sentence translation
  const sentTransEl = document.getElementById('sentence-translation');
  sentTransEl.textContent = '';
  sentTransEl.classList.remove('visible');
}

function clearWordView() {
  document.getElementById('sidebar-empty').style.display = '';
  document.getElementById('word-view').style.display = 'none';
  document.getElementById('rarity-badge').innerHTML = '';
  document.getElementById('explanation').textContent = '';
  document.getElementById('explanation').classList.remove('visible');
  document.getElementById('explain-model').textContent = '';
  document.getElementById('explain-model').classList.remove('visible');
  document.getElementById('conjugation').textContent = '';
  document.getElementById('conjugation').classList.remove('visible');

  document.getElementById('idiom-note').textContent = '';
  document.getElementById('idiom-note').classList.remove('visible');
  document.getElementById('sentence-translation').textContent = '';
  document.getElementById('sentence-translation').classList.remove('visible');
  if (activeWordEl) { activeWordEl.classList.remove('active'); activeWordEl = null; }
  clearDragSel();
  currentWord = '';
  currentTranslation = '';
}

function updateSaveBtn(word) {
  const btn = document.getElementById('save-btn');
  if (savedWords.has(word.toLowerCase())) {
    btn.textContent = '✓ Saved';
    btn.className = 'saved';
  } else {
    btn.textContent = '💾 Save';
    btn.className = '';
  }
}

// ── Save word ──
document.getElementById('save-btn').addEventListener('click', async () => {
  if (!currentWord || !currentTranslation) return;
  if (savedWords.has(currentWord.toLowerCase())) return;

  const res = await fetch('/api/words', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookId: parseInt(bookId),
      word: currentWord,
      translation: currentTranslation,
      sentence: currentSentence,
      chapterTitle: currentChapterTitle
    })
  });
  const data = await res.json();
  savedWords.set(currentWord.toLowerCase(), { id: data.id, translation: currentTranslation });

  if (activeWordEl) activeWordEl.classList.add('saved');
  updateSaveBtn(currentWord);
  updateWordsTabCount();
});

// ── Explain ──
document.getElementById('explain-btn').addEventListener('click', async () => {
  const expEl = document.getElementById('explanation');
  const btn = document.getElementById('explain-btn');
  btn.textContent = 'Asking AI…';
  btn.disabled = true;
  expEl.classList.add('visible');
  expEl.textContent = '';

  const modelEl = document.getElementById('explain-model');
  try {
    const res = await fetch('/api/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word: currentWord, sentence: currentSentence })
    });
    if (!res.ok) throw new Error();
    const model = res.headers.get('x-model');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      expEl.textContent += decoder.decode(value, { stream: true });
    }
    if (model) {
      modelEl.textContent = model;
      modelEl.classList.add('visible');
    }
  } catch {
    expEl.textContent = 'Could not reach AI.';
  }
  btn.textContent = '✦ Explain';
  btn.disabled = false;
});

// ── Conjugate ──
document.getElementById('conjugate-btn').addEventListener('click', async () => {
  const conjEl = document.getElementById('conjugation');
  const btn = document.getElementById('conjugate-btn');
  btn.textContent = 'Checking…';
  btn.disabled = true;
  conjEl.textContent = '';
  conjEl.classList.add('visible');

  try {
    const res = await fetch('/api/conjugate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word: currentWord, sentence: currentSentence })
    });
    if (!res.ok) throw new Error();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      conjEl.textContent += decoder.decode(value, { stream: true });
    }
    if (conjEl.textContent.trim() === '—') conjEl.classList.remove('visible');
  } catch {
    conjEl.textContent = 'Could not reach AI.';
  }
  btn.textContent = '⊞ Conjugate';
  btn.disabled = false;
});



// ── Words tab ──
async function loadWordsTab() {
  const list = document.getElementById('words-list');
  const countEl = document.getElementById('words-count');
  list.innerHTML = '<div class="words-empty">Loading…</div>';

  const res = await fetch('/api/words');
  const all = await res.json();
  const words = all.filter(w => !w.book_id || w.book_id === parseInt(bookId));

  countEl.textContent = `${words.length} word${words.length !== 1 ? 's' : ''} saved`;

  if (words.length === 0) {
    list.innerHTML = '<div class="words-empty">No words saved yet.<br>Click words while reading to save them.</div>';
    return;
  }

  list.innerHTML = words.map(w => `
    <div class="word-card" id="wc-${w.id}">
      <div class="word-card-body">
        <div class="word-card-word">${w.word} <span class="word-card-rarity" id="wr-${w.id}"></span></div>
        <div class="word-card-translation">${w.translation}</div>
        ${w.sentence ? `<div class="word-card-sentence">${w.sentence.slice(0, 100)}${w.sentence.length > 100 ? '…' : ''}</div>` : ''}
        ${w.chapter_title ? `<div class="word-card-chapter">${w.chapter_title}</div>` : ''}
      </div>
      <button class="word-card-delete" data-id="${w.id}" title="Delete">✕</button>
    </div>
  `).join('');

  // Fetch rarity for all words and update badges
  fetchRarity(words.map(w => w.word)).then(scores => {
    words.forEach((w, i) => {
      const el = document.getElementById(`wr-${w.id}`);
      if (el) el.outerHTML = rarityBadge(scores[i]);
    });
  });

  list.querySelectorAll('.word-card-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id);
      await fetch(`/api/words/${id}`, { method: 'DELETE' });
      document.getElementById(`wc-${id}`)?.remove();
      savedWords.forEach((v, k) => { if (v.id === id) savedWords.delete(k); });
      document.querySelectorAll('#content .word.saved').forEach(s => {
        if (cleanWord(s.textContent).toLowerCase() === (Object.entries(Object.fromEntries(savedWords)).find(([,v]) => v === id)?.[0] ?? '')) {
          s.classList.remove('saved');
        }
      });
      updateWordsTabCount();
      const remaining = list.querySelectorAll('.word-card').length;
      countEl.textContent = `${remaining} word${remaining !== 1 ? 's' : ''} saved`;
      if (remaining === 0) {
        list.innerHTML = '<div class="words-empty">No words saved yet.</div>';
      }
    });
  });
}

function updateWordsTabCount() {
  const btn = document.getElementById('words-tab-btn');
  const count = savedWords.size;
  btn.textContent = count > 0 ? `Words (${count})` : 'Words';
}

// ── Tabs ──
function showTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `panel-${name}`));
  if (name === 'words') loadWordsTab();
  if (name === 'stats') loadStatsTab();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

// ── Sidebar toggle ──
function isMobile() { return window.innerWidth < 640; }

fetch('/api/version').then(r => r.json()).then(d => {
  document.getElementById('version-badge').textContent = d.version;
});

// ── Mobile inline popup ──
const wordPopup = document.getElementById('word-popup');
const popupWord = document.getElementById('popup-word');
const popupTranslation = document.getElementById('popup-translation');

// Single flag: true when we've pushed a history entry for any overlay (popup or sidebar)
let _overlayInHistory = false;

function _pushOverlayHistory() {
  if (!_overlayInHistory) {
    try { history.pushState({ lingloOverlay: true }, ''); } catch(e) {}
    _overlayInHistory = true;
  }
}

function _popOverlayHistory(fromPopstate) {
  if (_overlayInHistory && !fromPopstate) {
    _overlayInHistory = false;
    try { history.back(); } catch(e) {}
  } else {
    _overlayInHistory = false;
  }
}

function showPopup(word, anchorEl) {
  popupWord.textContent = word;
  popupTranslation.textContent = 'Translating…';
  popupTranslation.className = 'popup-translation loading';
  document.getElementById('popup-rarity').innerHTML = '';
  const pst = document.getElementById('popup-sentence-translation');
  pst.textContent = '';
  pst.classList.remove('visible');
  wordPopup.classList.add('visible');
  positionPopup(anchorEl);
  if (isMobile()) _pushOverlayHistory();
  fetchRarity([word]).then(([zipf]) => {
    document.getElementById('popup-rarity').innerHTML = rarityBadge(zipf);
    positionPopup(anchorEl); // reposition after badge may change popup height
  });
}

function positionPopup(anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const popupW = wordPopup.offsetWidth || 220;
  // Centre above the word, keep within viewport
  let left = rect.left + rect.width / 2;
  left = Math.max(popupW / 2 + 8, Math.min(left, window.innerWidth - popupW / 2 - 8));
  const top = rect.top - wordPopup.offsetHeight - 12;
  wordPopup.style.left = left + 'px';
  wordPopup.style.top = Math.max(8, top) + 'px';
}

// skipHistory=true when the caller will handle history (e.g. closeSidebar, popup-more-btn)
function hidePopup(skipHistory = false) {
  wordPopup.classList.remove('visible');
  if (!sidebarOpen && !skipHistory) _popOverlayHistory(false);
}

document.getElementById('popup-speak-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (currentWord) speak(currentWord);
});

document.getElementById('popup-more-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  hidePopup(true); // keep the existing history entry; openSidebar will reuse it
  openSidebar();
  showTab('translate');
  showWordView(currentWord, currentSentence);
  // Put translation into sidebar if we already have it
  const transEl = document.getElementById('sidebar-translation');
  if (currentTranslation) {
    transEl.textContent = currentTranslation;
    transEl.className = 'sidebar-translation';
    updateSaveBtn(currentWord);
  }

  // Copy sentence translation from popup if already loaded, else trigger it
  const popupSentEl = document.getElementById('popup-sentence-translation');
  const sentTransEl = document.getElementById('sentence-translation');
  if (popupSentEl.innerHTML.trim()) {
    sentTransEl.innerHTML = popupSentEl.innerHTML;
    sentTransEl.classList.add('visible');
  } else if (currentSentence) {
    sentTransEl.innerHTML = '';
    sentTransEl.classList.add('visible');
    fetchSentenceTranslation(currentWord, currentSentence)
      .then(result => { sentTransEl.innerHTML = hlToHtml(result); })
      .catch(() => { sentTransEl.innerHTML = ''; sentTransEl.classList.remove('visible'); });
  }
});

// Dismiss popup on tap outside
document.addEventListener('touchstart', (e) => {
  if (wordPopup.classList.contains('visible') && !wordPopup.contains(e.target) && !e.target.closest('.word')) {
    hidePopup();
  }
}, { passive: true });

function openSidebar() {
  sidebarOpen = true;
  document.getElementById('sidebar').classList.remove('closed');
  document.getElementById('sidebar-toggle').classList.add('active');
  if (isMobile()) {
    document.getElementById('sidebar-backdrop').classList.add('visible');
    _pushOverlayHistory(); // no-op if popup already pushed one
  } else {
    document.getElementById('page-summary-bar').style.right = '380px';
    clearTimeout(paginationTimer);
    paginationTimer = setTimeout(() => {
      const ratio = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
      setupPagination(ratio, true);
    }, 270);
  }
}
function closeSidebar(fromPopstate = false) {
  sidebarOpen = false;
  document.getElementById('sidebar').classList.add('closed');
  document.getElementById('sidebar-toggle').classList.remove('active');
  document.getElementById('sidebar-backdrop').classList.remove('visible');
  hidePopup(true); // closeSidebar owns the history entry
  if (isMobile()) _popOverlayHistory(fromPopstate);
  if (!isMobile()) {
    document.getElementById('page-summary-bar').style.right = '0';
    clearTimeout(paginationTimer);
    paginationTimer = setTimeout(() => {
      const ratio = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
      setupPagination(ratio, true);
    }, 270);
  }
}

document.getElementById('sidebar-toggle').addEventListener('click', () => {
  if (sidebarOpen) closeSidebar(); else openSidebar();
});

// ── Chapter navigation ──
function updateNav() {
  const pageInfo = totalPages > 1 ? ` · ${currentPage + 1}/${totalPages}` : '';
  document.getElementById('chapter-counter').textContent =
    chapters.length ? `${currentIndex + 1}/${chapters.length}${pageInfo}` : '';
}

// ── Keyboard shortcuts ──
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); openSearch(); return; }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowRight' && !e.shiftKey) {
    if (currentPage < totalPages - 1) goToPage(currentPage + 1);
    else loadChapter(currentIndex + 1);
  }
  if (e.key === 'ArrowLeft' && !e.shiftKey) {
    if (currentPage > 0) goToPage(currentPage - 1);
    else loadChapter(currentIndex - 1, true);
  }
  if (e.key === 'Escape') clearWordView();
});

// ── Saved word tooltip ──
const tooltip = document.getElementById('word-tooltip');

document.getElementById('content').addEventListener('mouseover', e => {
  if (isDragging) return;
  const span = e.target.closest('.word.saved');
  if (!span) return;
  const entry = savedWords.get(cleanWord(span.textContent).toLowerCase());
  if (!entry?.translation) return;
  const rect = span.getBoundingClientRect();
  tooltip.textContent = entry.translation;
  tooltip.style.left = (rect.left + rect.width / 2) + 'px';
  tooltip.style.top = (rect.top - 34) + 'px';
  tooltip.classList.add('visible');
});

document.getElementById('content').addEventListener('mouseout', e => {
  if (e.target.closest('.word.saved')) tooltip.classList.remove('visible');
});

// ── TOC ──
function buildToc() {
  const dropdown = document.getElementById('toc-dropdown');
  const readSet = new Set(JSON.parse(localStorage.getItem(`linglo-read-${bookId}`) || '[]'));
  dropdown.innerHTML = chapters.map((ch, i) => `
    <div class="toc-item ${i === currentIndex ? 'toc-current' : ''} ${readSet.has(i) ? 'toc-read' : ''}" data-index="${i}">
      <span class="toc-item-num">${readSet.has(i) ? '✓' : i + 1}</span>
      <span class="toc-item-title">${ch.title}</span>
    </div>
  `).join('');
  dropdown.querySelectorAll('.toc-item').forEach(item => {
    item.addEventListener('click', () => {
      closeToc();
      loadChapter(parseInt(item.dataset.index));
    });
  });
}

function closeToc() {
  document.getElementById('toc-dropdown').classList.remove('open');
}

document.getElementById('toc-btn').addEventListener('click', e => {
  e.stopPropagation();
  buildToc();
  document.getElementById('toc-dropdown').classList.toggle('open');
});

document.addEventListener('click', e => {
  if (!e.target.closest('#toc-btn') && !e.target.closest('#toc-dropdown')) closeToc();
});

// ── Search ──
function openSearch() {
  document.getElementById('search-bar').classList.add('visible');
  document.body.classList.add('search-open');
  document.getElementById('search-input').focus();
  document.getElementById('search-input').select();
}

function closeSearch() {
  document.getElementById('search-bar').classList.remove('visible');
  document.body.classList.remove('search-open');
  clearSearchHighlights();
  searchMatches = [];
  searchCurrent = -1;
  document.getElementById('search-count').textContent = '';
  document.getElementById('search-input').value = '';
}

function clearSearchHighlights() {
  document.querySelectorAll('#content .word.search-match, #content .word.search-current').forEach(w => {
    w.classList.remove('search-match', 'search-current');
  });
}

function doSearch() {
  clearSearchHighlights();
  const query = document.getElementById('search-input').value.trim().toLowerCase();
  if (!query) {
    document.getElementById('search-count').textContent = '';
    searchMatches = [];
    searchCurrent = -1;
    return;
  }
  searchMatches = [...document.querySelectorAll('#content .word')].filter(w =>
    w.textContent.toLowerCase().includes(query)
  );
  searchMatches.forEach(w => w.classList.add('search-match'));
  if (searchMatches.length > 0) {
    goToSearchMatch(0);
  } else {
    document.getElementById('search-count').textContent = 'No matches';
  }
}

function goToSearchMatch(index) {
  if (!searchMatches.length) return;
  searchMatches.forEach(w => w.classList.remove('search-current'));
  searchCurrent = ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
  const match = searchMatches[searchCurrent];
  match.classList.add('search-current');
  if (pageWidth > 0) {
    const textCol = document.getElementById('text-column');
    const elLeft = match.getBoundingClientRect().left - textCol.getBoundingClientRect().left;
    const absLeft = elLeft + currentPage * pageWidth;
    const matchPage = Math.max(0, Math.floor(absLeft / pageWidth));
    if (matchPage !== currentPage) goToPage(matchPage);
  }
  document.getElementById('search-count').textContent = `${searchCurrent + 1} / ${searchMatches.length}`;
}

document.getElementById('search-btn').addEventListener('click', openSearch);
document.getElementById('search-close').addEventListener('click', closeSearch);
document.getElementById('search-prev').addEventListener('click', () => goToSearchMatch(searchCurrent - 1));
document.getElementById('search-next').addEventListener('click', () => goToSearchMatch(searchCurrent + 1));

let searchTimeout;
document.getElementById('search-input').addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(doSearch, 300);
});
document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); goToSearchMatch(searchCurrent + (e.shiftKey ? -1 : 1)); }
  if (e.key === 'Escape') closeSearch();
});

// ── Reading stats ──
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function logWordsRead(count) {
  const today = todayStr();
  const storedDate = localStorage.getItem('linglo-daily-date');
  let dailyWords = storedDate === today ? parseInt(localStorage.getItem('linglo-daily-words') || '0') : 0;
  const wasGoalMet = dailyWords >= 500;
  dailyWords += count;
  localStorage.setItem('linglo-daily-date', today);
  localStorage.setItem('linglo-daily-words', String(dailyWords));
  if (!wasGoalMet && dailyWords >= 500) {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().split('T')[0];
    const last = localStorage.getItem('linglo-streak-last');
    if (last !== today) {
      let streak = parseInt(localStorage.getItem('linglo-streak-count') || '0');
      streak = (last === yStr) ? streak + 1 : 1;
      localStorage.setItem('linglo-streak-last', today);
      localStorage.setItem('linglo-streak-count', String(streak));
    }
  }
  renderReaderStreakCircle();
}

function renderReaderStreakCircle() {
  const el = document.getElementById('reader-streak-circle');
  if (!el) return;
  const today = todayStr();
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().split('T')[0];
  const last = localStorage.getItem('linglo-streak-last');
  const streak = (last === today || last === yStr) ? parseInt(localStorage.getItem('linglo-streak-count') || '0') : 0;
  const dailyWords = localStorage.getItem('linglo-daily-date') === today
    ? parseInt(localStorage.getItem('linglo-daily-words') || '0') : 0;
  const pct = Math.min(100, Math.round(dailyWords / 500 * 100));
  const goalMet = pct >= 100;
  const r = 11, size = 28, circ = +(2 * Math.PI * r).toFixed(2);
  const offset = +(circ * (1 - pct / 100)).toFixed(2);
  const stroke = goalMet ? '#34d399' : '#a78bfa';
  const label = streak > 0 ? String(streak) : '';
  const fs = streak > 99 ? 6 : 8;
  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="14" cy="14" r="${r}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2.5"/>
    <circle cx="14" cy="14" r="${r}" fill="none" stroke="${stroke}" stroke-width="2.5"
      stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
      stroke-linecap="round" transform="rotate(-90 14 14)"/>
    <text x="14" y="14" text-anchor="middle" dominant-baseline="central"
      font-size="${fs}" font-weight="700" fill="${goalMet ? '#34d399' : 'currentColor'}" font-family="system-ui,sans-serif">${label}</text>
  </svg>`;
}

// ── Page summary ──
function getVisibleText() {
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  return [...document.querySelectorAll('#content p, #content h1, #content h2, #content h3')]
    .filter(el => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < viewH && r.right > 0 && r.left < viewW;
    })
    .map(el => el.textContent.trim())
    .filter(Boolean)
    .join(' ');
}

document.getElementById('summarize-btn').addEventListener('click', async () => {
  const btn = document.getElementById('summarize-btn');
  const textEl = document.getElementById('page-summary-text');
  const visibleText = getVisibleText();
  if (!visibleText) return;

  btn.textContent = 'Generating…';
  btn.disabled = true;
  textEl.textContent = '';

  try {
    const res = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: visibleText, title: currentChapterTitle })
    });
    if (!res.ok) throw new Error();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      textEl.textContent += decoder.decode(value, { stream: true });
    }
  } catch {
    textEl.textContent = 'Summary unavailable.';
  }
  btn.textContent = '✦ Summarize this page';
  btn.disabled = false;
});

// ── Pagination/Layout ──
function setupPagination(restoreRatio = 0, keepSummary = false) {
  const textCol = document.getElementById('text-column');
  const pages = document.getElementById('chapter-pages');
  if (!pages) return;

  // Clear column-based styles
  pages.style.height = 'auto';
  pages.style.columnWidth = 'auto';
  pages.style.columnGap = '0';
  pages.style.columnFill = 'auto';
  pages.style.transform = 'none';

  // Remove hardcoded padding that was set by JS
  document.getElementById('chapter-title').style.padding = '';
  document.getElementById('content').style.padding = '';

  requestAnimationFrame(() => {
    // Scroll to restored ratio
    const targetScroll = restoreRatio * (textCol.scrollHeight - textCol.clientHeight);
    textCol.scrollTop = targetScroll;
    
    // Update progress bar
    updateProgressBar();
    
    if (!keepSummary) {
      document.getElementById('page-summary-text').textContent = '';
      document.getElementById('summarize-btn').textContent = '✦ Summarize this page';
      document.getElementById('summarize-btn').disabled = false;
    }
  });
}

function updateProgressBar() {
  const textCol = document.getElementById('text-column');
  if (!textCol) return;
  const ratio = textCol.scrollHeight > textCol.clientHeight 
    ? textCol.scrollTop / (textCol.scrollHeight - textCol.clientHeight) 
    : 0;
  document.getElementById('progress-bar').style.width = (Math.min(1, ratio) * 100) + '%';
}

function goToPage(n) {
  // In scroll mode, n=0 means start, n=1 means end of chapter
  const textCol = document.getElementById('text-column');
  if (!textCol) return;
  const targetScroll = n * (textCol.scrollHeight - textCol.clientHeight);
  textCol.scrollTo({ top: targetScroll, behavior: 'smooth' });
}

// Track scroll for progress bar and persistence
document.getElementById('text-column').addEventListener('scroll', () => {
  updateProgressBar();
  saveProgress();
}, { passive: true });

let resizeTimer = null;
const resizeObserver = new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    // Just ensure we keep our relative position during resize
    const textCol = document.getElementById('text-column');
    if (!textCol) return;
    const ratio = textCol.scrollHeight > textCol.clientHeight 
      ? textCol.scrollTop / (textCol.scrollHeight - textCol.clientHeight) 
      : 0;
    setupPagination(ratio, true);
  }, 300);
});
resizeObserver.observe(document.getElementById('text-column'));

// Re-layout when the summary bar grows/shrinks
const summaryBarObserver = new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const textCol = document.getElementById('text-column');
    if (!textCol) return;
    const ratio = textCol.scrollHeight > textCol.clientHeight 
      ? textCol.scrollTop / (textCol.scrollHeight - textCol.clientHeight) 
      : 0;
    setupPagination(ratio, true);
  }, 150);
});
summaryBarObserver.observe(document.getElementById('page-summary-bar'));

// ── Click zones (left 15% = prev chapter, right 15% = next chapter) ──
document.getElementById('text-column').addEventListener('click', e => {
  if (e.target.closest('.word')) return;
  if (isDragging) return;
  const rect = document.getElementById('text-column').getBoundingClientRect();
  const relX = e.clientX - rect.left;
  const W = rect.width;
  if (relX < W * 0.15) {
    loadChapter(currentIndex - 1, true);
  } else if (relX > W * 0.85) {
    loadChapter(currentIndex + 1);
  }
});

// ── Swipe navigation ──
let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
document.getElementById('text-column').addEventListener('touchstart', e => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchStartTime = Date.now();
}, { passive: true });
document.getElementById('text-column').addEventListener('touchend', e => {
  if (touchDragHandled) { touchDragHandled = false; return; }
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  const dt = Date.now() - touchStartTime;
  if (dt < 400 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    if (dx < 0) {
      if (currentPage < totalPages - 1) goToPage(currentPage + 1);
      else loadChapter(currentIndex + 1);
    } else {
      if (currentPage > 0) goToPage(currentPage - 1);
      else loadChapter(currentIndex - 1, true);
    }
  }
}, { passive: true });

// ── Mobile init ──
if (isMobile()) closeSidebar();
document.getElementById('sidebar-backdrop').addEventListener('click', closeSidebar);

// ── Swipe left to close sidebar (mobile) ──
(function() {
  const sidebar = document.getElementById('sidebar');
  let swipeStartX = 0, swipeStartY = 0, swipeLocked = false;
  sidebar.addEventListener('touchstart', e => {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
    swipeLocked = false;
  }, { passive: true });
  // Non-passive so we can preventDefault and block browser back-swipe
  sidebar.addEventListener('touchmove', e => {
    const dx = e.touches[0].clientX - swipeStartX;
    const dy = e.touches[0].clientY - swipeStartY;
    if (!swipeLocked && Math.abs(dx) > 8) swipeLocked = true;
    if (swipeLocked && Math.abs(dx) > Math.abs(dy) * 1.2) e.preventDefault();
  }, { passive: false });
  sidebar.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const dy = e.changedTouches[0].clientY - swipeStartY;
    if (dx < -50 && Math.abs(dx) > Math.abs(dy) * 1.5) closeSidebar();
  }, { passive: true });
})();

// ── Back gesture closes popup or sidebar on mobile (History API) ──
window.addEventListener('popstate', () => {
  if (!isMobile()) return;
  _overlayInHistory = false; // entry was already popped by the browser
  if (sidebarOpen) { closeSidebar(true); return; }
  if (wordPopup.classList.contains('visible')) { hidePopup(true); return; }
});

// ── Boot ──
init().then(updateWordsTabCount);
