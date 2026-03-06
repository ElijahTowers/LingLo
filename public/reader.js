const params = new URLSearchParams(location.search);
const bookId = params.get('book');
if (!bookId) location.href = '/';

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
let paginationTimer = null;

// ── Init ──
async function init() {
  await Promise.all([loadSavedWords(), loadChapters()]);
  const saved = parseInt(localStorage.getItem(`linglo-chapter-${bookId}`)) || 0;
  await loadChapter(saved);
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

async function loadChapter(index, goToLast = false) {
  if (index < 0 || index >= chapters.length) return;
  currentIndex = index;
  localStorage.setItem(`linglo-chapter-${bookId}`, index);

  // Track read chapters
  const readSet = new Set(JSON.parse(localStorage.getItem(`linglo-read-${bookId}`) || '[]'));
  readSet.add(index);
  localStorage.setItem(`linglo-read-${bookId}`, JSON.stringify([...readSet]));
  updateStreak();

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
  setupPagination(goToLast ? 1 : 0);
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

// ── Sentence translate ──
document.getElementById('sentence-translate-btn').addEventListener('click', async () => {
  const el = document.getElementById('sentence-translation');
  const btn = document.getElementById('sentence-translate-btn');
  btn.disabled = true;
  el.textContent = 'Translating…';
  el.classList.add('visible');

  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: currentSentence })
    });
    if (!res.ok) throw new Error();
    el.textContent = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      el.textContent += decoder.decode(value, { stream: true });
    }
  } catch {
    el.textContent = 'Translation failed.';
  }
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
        <div class="word-card-word">${w.word}</div>
        <div class="word-card-translation">${w.translation}</div>
        ${w.sentence ? `<div class="word-card-sentence">${w.sentence.slice(0, 100)}${w.sentence.length > 100 ? '…' : ''}</div>` : ''}
        ${w.chapter_title ? `<div class="word-card-chapter">${w.chapter_title}</div>` : ''}
      </div>
      <button class="word-card-delete" data-id="${w.id}" title="Delete">✕</button>
    </div>
  `).join('');

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

// ── Mobile inline popup ──
const wordPopup = document.getElementById('word-popup');
const popupWord = document.getElementById('popup-word');
const popupTranslation = document.getElementById('popup-translation');

function showPopup(word, anchorEl) {
  popupWord.textContent = word;
  popupTranslation.textContent = 'Translating…';
  popupTranslation.className = 'popup-translation loading';
  wordPopup.classList.add('visible');
  positionPopup(anchorEl);
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

function hidePopup() {
  wordPopup.classList.remove('visible');
}

document.getElementById('popup-speak-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (currentWord) speak(currentWord);
});

document.getElementById('popup-more-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  hidePopup();
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
  } else {
    document.getElementById('page-summary-bar').style.right = '380px';
    clearTimeout(paginationTimer);
    paginationTimer = setTimeout(() => {
      const ratio = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
      setupPagination(ratio);
    }, 270);
  }
}
function closeSidebar() {
  sidebarOpen = false;
  document.getElementById('sidebar').classList.add('closed');
  document.getElementById('sidebar-toggle').classList.remove('active');
  document.getElementById('sidebar-backdrop').classList.remove('visible');
  hidePopup();
  if (!isMobile()) {
    document.getElementById('page-summary-bar').style.right = '0';
    clearTimeout(paginationTimer);
    paginationTimer = setTimeout(() => {
      const ratio = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
      setupPagination(ratio);
    }, 270);
  }
}

document.getElementById('sidebar-toggle').addEventListener('click', () => {
  if (sidebarOpen) closeSidebar(); else openSidebar();
});

// ── Chapter navigation ──
document.getElementById('prev-btn').addEventListener('click', () => {
  if (currentPage > 0) goToPage(currentPage - 1);
  else loadChapter(currentIndex - 1, true);
});
document.getElementById('next-btn').addEventListener('click', () => {
  if (currentPage < totalPages - 1) goToPage(currentPage + 1);
  else loadChapter(currentIndex + 1);
});

function updateNav() {
  const onFirst = currentPage <= 0;
  const onLast = currentPage >= totalPages - 1;
  document.getElementById('prev-btn').disabled = onFirst && currentIndex <= 0;
  document.getElementById('next-btn').disabled = onLast && currentIndex >= chapters.length - 1;
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
function updateStreak() {
  const today = new Date().toDateString();
  const last = localStorage.getItem('linglo-streak-last');
  if (last === today) return;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  let streak = parseInt(localStorage.getItem('linglo-streak-count') || '0');
  streak = (last === yesterday.toDateString()) ? streak + 1 : 1;
  localStorage.setItem('linglo-streak-last', today);
  localStorage.setItem('linglo-streak-count', streak);
}

function getStreak() {
  const today = new Date().toDateString();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const last = localStorage.getItem('linglo-streak-last');
  if (last !== today && last !== yesterday.toDateString()) return 0;
  return parseInt(localStorage.getItem('linglo-streak-count') || '0');
}

function loadStatsTab() {
  const panel = document.getElementById('stats-panel');
  const readChapters = JSON.parse(localStorage.getItem(`linglo-read-${bookId}`) || '[]');
  const streak = getStreak();
  const wordCount = savedWords.size;
  const pct = chapters.length ? Math.round((readChapters.length / chapters.length) * 100) : 0;

  panel.innerHTML = `
    <div class="stat-card">
      <div class="stat-icon">📖</div>
      <div>
        <div class="stat-value">${readChapters.length}</div>
        <div class="stat-label">Chapters Read</div>
        <div class="stat-sub">${pct}% of ${chapters.length} chapters</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">💾</div>
      <div>
        <div class="stat-value">${wordCount}</div>
        <div class="stat-label">Words Saved</div>
        <div class="stat-sub">in this book</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-icon stat-streak-fire">🔥</div>
      <div>
        <div class="stat-value">${streak}</div>
        <div class="stat-label">Day Streak</div>
        <div class="stat-sub">${streak >= 7 ? 'Incredible! 🎉' : streak >= 3 ? 'On fire!' : streak === 1 ? 'Good start!' : 'Read daily to build a streak'}</div>
      </div>
    </div>
  `;
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

// ── Pagination ──
function setupPagination(restoreRatio = 0) {
  const textCol = document.getElementById('text-column');
  const pages = document.getElementById('chapter-pages');
  if (!pages) return;
  const W = textCol.clientWidth;
  const summaryBarH = document.getElementById('page-summary-bar').offsetHeight;
  const H = textCol.clientHeight - summaryBarH;
  if (W === 0 || H === 0) return;
  pageWidth = W;

  const readableWidth = 680;
  const minPad = 24;
  const hPad = W > readableWidth + 2 * minPad ? Math.round((W - readableWidth) / 2) : minPad;
  document.getElementById('chapter-title').style.padding = `48px ${hPad}px 24px`;
  document.getElementById('content').style.padding = `0 ${hPad}px 120px`;

  pages.style.height = H + 'px';
  pages.style.columnWidth = W + 'px';
  pages.style.columnGap = '0';
  pages.style.columnFill = 'auto';
  pages.style.transform = 'translateX(0)';

  requestAnimationFrame(() => {
    totalPages = Math.max(1, Math.ceil(pages.scrollWidth / W));
    const target = restoreRatio >= 1 ? totalPages - 1 : Math.round(restoreRatio * (totalPages - 1));
    currentPage = -1;
    goToPage(target);
  });
}

function goToPage(n) {
  n = Math.max(0, Math.min(n, totalPages - 1));
  currentPage = n;
  const pages = document.getElementById('chapter-pages');
  if (pages) pages.style.transform = `translateX(${-n * pageWidth}px)`;
  const pct = totalPages > 1 ? n / (totalPages - 1) : 1;
  document.getElementById('progress-bar').style.width = (pct * 100) + '%';
  document.getElementById('page-summary-text').textContent = '';
  document.getElementById('summarize-btn').textContent = '✦ Summarize this page';
  document.getElementById('summarize-btn').disabled = false;
  updateNav();
}

let resizeTimer = null;
const resizeObserver = new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const ratio = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
    setupPagination(ratio);
  }, 300);
});
resizeObserver.observe(document.getElementById('text-column'));

// ── Click zones (left 30% = prev, right 30% = next) ──
document.getElementById('text-column').addEventListener('click', e => {
  if (e.target.closest('.word')) return;
  if (isDragging) return;
  const rect = document.getElementById('text-column').getBoundingClientRect();
  const relX = e.clientX - rect.left;
  const W = rect.width;
  if (relX < W * 0.3) {
    if (currentPage > 0) goToPage(currentPage - 1);
    else loadChapter(currentIndex - 1, true);
  } else if (relX > W * 0.7) {
    if (currentPage < totalPages - 1) goToPage(currentPage + 1);
    else loadChapter(currentIndex + 1);
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
  let swipeStartX = 0, swipeStartY = 0;
  sidebar.addEventListener('touchstart', e => {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
  }, { passive: true });
  sidebar.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const dy = e.changedTouches[0].clientY - swipeStartY;
    if (dx < -50 && Math.abs(dx) > Math.abs(dy) * 1.5) closeSidebar();
  }, { passive: true });
})();

// ── Boot ──
init().then(updateWordsTabCount);
