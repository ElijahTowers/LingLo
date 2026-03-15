const params = new URLSearchParams(location.search);
const bookId = params.get('book');
const fixtureMode = params.get('fixture') === 'layout';
const fixtureScenario = params.get('scenario') || 'explain';
if (!bookId && !fixtureMode) location.href = '/';

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
const frequencyCache = new Map();
const regionalUsageCache = new Map();
let activeFrequencyRequest = '';
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

function getLearningValueLabel(count, phrase) {
  if (count >= (phrase ? 6 : 12)) return 'Worth learning';
  if (count >= (phrase ? 3 : 5)) return 'Shows up regularly';
  if (count >= 2) return 'Occasional in this book';
  if (count === 1) return 'Rare in this book';
  return 'Not found elsewhere yet';
}

function resetBookFrequency() {
  const panel = document.getElementById('book-frequency');
  const panelCount = document.getElementById('book-frequency-count');
  const panelNote = document.getElementById('book-frequency-note');
  const popup = document.getElementById('popup-frequency');
  const popupCount = document.getElementById('popup-frequency-count');
  const popupNote = document.getElementById('popup-frequency-note');

  panel.classList.remove('visible');
  panelCount.textContent = '';
  panelNote.textContent = '';
  panelNote.classList.remove('strong');
  popup.classList.remove('visible');
  popupCount.textContent = '';
  popupNote.textContent = '';
}

function renderBookFrequency(result) {
  const panel = document.getElementById('book-frequency');
  const panelCount = document.getElementById('book-frequency-count');
  const panelNote = document.getElementById('book-frequency-note');
  const popup = document.getElementById('popup-frequency');
  const popupCount = document.getElementById('popup-frequency-count');
  const popupNote = document.getElementById('popup-frequency-note');
  const label = `In this book: ${result.count}x`;
  const note = result.type === 'phrase'
    ? `${getLearningValueLabel(result.count, true)}. Exact phrase match.`
    : `${getLearningValueLabel(result.count, false)}. Grouped across singular/plural and related forms.`;
  const freshNote = result.freshlyAnalyzed ? ' This book was analyzed just now.' : '';

  panel.classList.add('visible');
  panelCount.textContent = label;
  panelNote.textContent = note + freshNote;
  panelNote.classList.toggle('strong', result.count >= (result.type === 'phrase' ? 3 : 5));

  popup.classList.add('visible');
  popupCount.textContent = label;
  popupNote.textContent = (result.type === 'phrase'
    ? 'Exact phrase match in this book.'
    : 'Grouped singular/plural and related forms.') + (result.freshlyAnalyzed ? ' Analyzed just now.' : '');
  scheduleTranslateScrollHintUpdate();
}

function showBookFrequencyLoading() {
  const panel = document.getElementById('book-frequency');
  const panelCount = document.getElementById('book-frequency-count');
  const panelNote = document.getElementById('book-frequency-note');
  const popup = document.getElementById('popup-frequency');
  const popupCount = document.getElementById('popup-frequency-count');
  const popupNote = document.getElementById('popup-frequency-note');

  panel.classList.add('visible');
  panelCount.textContent = 'Analyzing this book...';
  panelNote.textContent = 'Building frequency data so you can judge whether this is worth learning.';
  panelNote.classList.remove('strong');

  popup.classList.add('visible');
  popupCount.textContent = 'Analyzing this book...';
  popupNote.textContent = 'Book frequency is being prepared.';
}

async function loadBookFrequency(text) {
  if (!bookId || !text) return;
  const key = `${bookId}:${text.trim().toLowerCase()}`;
  activeFrequencyRequest = key;
  if (frequencyCache.has(key)) {
    if (activeFrequencyRequest === key) renderBookFrequency(frequencyCache.get(key));
    return;
  }

  showBookFrequencyLoading();
  try {
    const res = await fetch(`/api/books/${bookId}/frequency`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error();
    const result = await res.json();
    frequencyCache.set(key, result);
    if (activeFrequencyRequest === key) renderBookFrequency(result);
  } catch {
    if (activeFrequencyRequest !== key) return;
    const panel = document.getElementById('book-frequency');
    const panelCount = document.getElementById('book-frequency-count');
    const panelNote = document.getElementById('book-frequency-note');
    const popup = document.getElementById('popup-frequency');
    const popupCount = document.getElementById('popup-frequency-count');
    const popupNote = document.getElementById('popup-frequency-note');

    panel.classList.add('visible');
    panelCount.textContent = 'Book frequency unavailable';
    panelNote.textContent = 'Could not analyze this book right now.';
    popup.classList.add('visible');
    popupCount.textContent = 'Book frequency unavailable';
    popupNote.textContent = 'Try again in a moment.';
  }
}

function resetRegionalUsage() {
  const el = document.getElementById('regional-usage');
  el.textContent = '';
  el.classList.remove('visible');
}

async function loadRegionalUsage(text, sentence) {
  const el = document.getElementById('regional-usage');
  const key = `${text.trim().toLowerCase()}::${(sentence || '').trim().toLowerCase()}`;
  if (regionalUsageCache.has(key)) {
    el.innerHTML = `<strong>Regional usage:</strong> ${escapeHtml(regionalUsageCache.get(key))}`;
    el.classList.add('visible');
    return;
  }

  try {
    const res = await fetch('/api/regional-usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sentence })
    });
    if (!res.ok) throw new Error();
    const label = (await res.text()).trim();
    if (!label) return;
    regionalUsageCache.set(key, label);
    el.innerHTML = `<strong>Regional usage:</strong> ${escapeHtml(label)}`;
    el.classList.add('visible');
    scheduleTranslateScrollHintUpdate();
  } catch {}
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
let bookSearchResults = [];   // full-book search from API: { chapterIndex, chapterTitle, snippet }
let currentBookSearchIndex = -1;
let currentPage = 0;
let totalPages = 1;
let pageWidth = 0;
let wordsPerPage = 0;
let loggedPages = new Set();
let paginationTimer = null;
let pageArrivalTime = 0;
const MIN_PAGE_TIME = 30000; // 30 s on a page before its words count

// ── Progress persistence ──
function updateProgressUrl(chapter, ratio) {
  if (fixtureMode || !bookId) return;
  const url = new URL(location.href);
  url.searchParams.set('book', bookId);
  url.searchParams.set('ch', String(chapter));
  url.searchParams.set('r', String(Math.max(0, Math.min(1, ratio))));
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function saveProgress() {
  const ratio = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
  const progress = {
    chapter: currentIndex,
    ratio,
    total: chapters.length
  };
  try {
    localStorage.setItem(`linglo-progress-${bookId}`, JSON.stringify(progress));
    localStorage.setItem('linglo-last-reader-url', `/reader.html?book=${bookId}&ch=${currentIndex}&r=${ratio}`);
  } catch {}
  updateProgressUrl(currentIndex, ratio);
}
function loadProgress() {
  const chapterFromUrl = parseInt(params.get('ch'), 10);
  const ratioFromUrl = parseFloat(params.get('r'));
  if (!isNaN(chapterFromUrl)) {
    return {
      chapter: chapterFromUrl,
      ratio: isNaN(ratioFromUrl) ? 0 : Math.max(0, Math.min(1, ratioFromUrl))
    };
  }
  try {
    const p = JSON.parse(localStorage.getItem(`linglo-progress-${bookId}`));
    if (p && typeof p.chapter === 'number') {
      return {
        chapter: p.chapter,
        ratio: typeof p.ratio === 'number' ? Math.max(0, Math.min(1, p.ratio)) : 0
      };
    }
  } catch {}
  // fallback to legacy chapter-only key
  const ch = parseInt(localStorage.getItem(`linglo-chapter-${bookId}`));
  return isNaN(ch) ? { chapter: 0, ratio: 0 } : { chapter: ch, ratio: 0 };
}

// Persist position when leaving the page (tab close, navigate away) so it's always remembered
function onPageLeave() {
  if (typeof currentIndex === 'number' && chapters && chapters.length > 0) saveProgress();
}
window.addEventListener('pagehide', onPageLeave);
window.addEventListener('beforeunload', onPageLeave);

// ── Init ──
async function init() {
  renderReaderStreakCircle();
  refreshStreakStats();
  if (fixtureMode) {
    renderLayoutFixture();
    return;
  }
  await Promise.all([loadSavedWords(), loadChapters()]);
  const { chapter, ratio } = loadProgress();
  await loadChapter(chapter, false, ratio);
}

function renderLayoutFixture() {
  const fixture = {
    explain: {
      word: 'llamarse',
      translation: 'be named',
      altMeanings: ['be called', 'go by the name', 'be known as'],
      sentence: 'Podria llamarse Harvey, pero nadie estaba seguro de ello hasta mucho despues, cuando por fin encontraron una pista mejor.',
      sentenceTranslation: 'He could [HL]be named[/HL] Harvey, but nobody was sure until much later, when they finally found a better clue.',
      explanation: [
        'Meaning in context: this is a reflexive verb meaning to be called or to be named.',
        'Grammar note: despues de "podria", the infinitive stays unchanged, so "llamarse" keeps its reflexive ending.',
        'Usage note: in natural English this often maps to "be called" or "be named", depending on whether the sentence sounds more formal or descriptive.',
        'Nuance: the reflexive form is about what someone or something is called, not about physically calling someone on the phone.',
        'Memory tip: think of "como se llama?" where the reflexive form points to the name a person goes by.',
        'Extra note: long AI answers should remain fully reachable in this fixture so viewport regressions show up immediately in tests.'
      ].join('\n\n'),
      model: 'qwen2.5-coder:7b',
      explainVisible: true
    },
    phrase: {
      word: 'se dio cuenta',
      translation: 'realized',
      altMeanings: ['noticed', 'became aware', 'figured it out'],
      sentence: 'Al final se dio cuenta de la verdad cuando vio la carta escondida detras del espejo roto.',
      sentenceTranslation: 'In the end [HL]she realized[/HL] the truth when she saw the letter hidden behind the broken mirror.',
      explanation: '',
      model: '',
      explainVisible: false
    }
  }[fixtureScenario] || null;

  if (!fixture) return;

  document.body.dataset.fixtureMode = 'layout';
  document.getElementById('chapter-counter').textContent = '8/37';
  document.getElementById('progress-bar').style.width = '42%';
  document.getElementById('chapter-title').textContent = 'Fixture Chapter';
  document.getElementById('content').innerHTML = `
    <p>Esta es una pagina de prueba para validar layout, scroll y visibilidad del texto en la experiencia de lectura.</p>
    <p>Debe seguir siendo legible en movil, tablet, escritorio estrecho y escritorio ancho sin cortar contenido importante.</p>
    <p>Los paneles laterales, explicaciones largas, traducciones de contexto y frases largas deben seguir siendo completamente alcanzables.</p>
  `;

  currentWord = fixture.word;
  currentSentence = fixture.sentence;
  currentTranslation = fixture.translation;

  document.getElementById('sidebar-empty').style.display = 'none';
  document.getElementById('word-view').style.display = 'flex';
  document.getElementById('sidebar-word').textContent = fixture.word;
  document.getElementById('rarity-badge').innerHTML = rarityBadge(3.4);
  document.getElementById('sidebar-translation').textContent = fixture.translation;
  document.getElementById('sidebar-translation').className = 'sidebar-translation';
  document.getElementById('alt-meanings').innerHTML = fixture.altMeanings
    .map(line => `<div class="alt-meaning-item">${escapeHtml(line)}</div>`)
    .join('');
  document.getElementById('alt-meanings-wrap').classList.add('visible');
  document.getElementById('idiom-note').textContent = fixtureScenario === 'phrase'
    ? 'Fixed expression: this phrase often means suddenly understanding something.'
    : '';
  document.getElementById('idiom-note').classList.toggle('visible', fixtureScenario === 'phrase');
  document.getElementById('sidebar-sentence').innerHTML = fixture.sentence.replace(
    new RegExp(`(${fixture.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i'),
    '<span class="hl">$1</span>'
  );
  document.getElementById('sentence-translation').innerHTML = hlToHtml(fixture.sentenceTranslation);
  document.getElementById('sentence-translation').classList.add('visible');
  document.getElementById('explanation').textContent = fixture.explanation;
  document.getElementById('explanation').classList.toggle('visible', fixture.explainVisible);
  document.getElementById('explain-model').textContent = fixture.model;
  document.getElementById('explain-model').classList.toggle('visible', fixture.explainVisible);
  document.getElementById('conjugation').textContent = fixtureScenario === 'phrase' ? '' : 'not a conjugated form';
  document.getElementById('conjugation').classList.toggle('visible', fixtureScenario !== 'phrase');
  document.getElementById('page-summary-text').textContent = 'Layout fixture mode';
  updateSaveBtn(currentWord);
  openSidebar();

  requestAnimationFrame(() => {
    document.body.dataset.fixtureReady = 'true';
    updateTranslateScrollHint();
  });
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

function isPhrase(text) {
  return /\s/.test(text.trim());
}

function normalizeMeaning(text) {
  return text.toLowerCase().replace(/^[\s•\-–—,.;:!?]+|[\s•\-–—,.;:!?]+$/g, '');
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeSearchText(text) {
  return text
    .toLowerCase()
    .replace(/[áàäâ]/g, 'a')
    .replace(/[éèëê]/g, 'e')
    .replace(/[íìïî]/g, 'i')
    .replace(/[óòöô]/g, 'o')
    .replace(/[úùüû]/g, 'u');
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

  // When sidebar is already open, always update it (don't use popup-only path)
  if (!sidebarOpen && usesInlineLookup()) {
    // Mobile and tablet touch: show inline popup above the first selected word
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
          scheduleTranslateScrollHintUpdate();
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
      loadAlternativeMeanings(text, currentSentence, currentTranslation);
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
        .then(result => { sentTransEl.innerHTML = hlToHtml(result); scheduleTranslateScrollHintUpdate(); })
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

  // When sidebar is already open, always update it (don't use popup-only path)
  if (!sidebarOpen && usesInlineLookup()) {
    // Mobile and tablet touch: show inline popup, leave sidebar closed
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
      loadAlternativeMeanings(word, currentSentence, currentTranslation);
    } catch {
      transEl.textContent = 'Translation failed';
      transEl.className = 'sidebar-translation';
    }
    updateSaveBtn(word);

    // Auto-translate the context sentence (with word highlighted in translation)
    if (currentSentence) {
      const sentTransEl = document.getElementById('sentence-translation');
      sentTransEl.innerHTML = '';
      sentTransEl.classList.add('visible');
      fetchSentenceTranslation(word, currentSentence)
        .then(result => { sentTransEl.innerHTML = hlToHtml(result); scheduleTranslateScrollHintUpdate(); })
        .catch(() => { sentTransEl.innerHTML = ''; sentTransEl.classList.remove('visible'); });
    }
  }
});


// ── Sidebar word view ──
function showWordView(word, sentence) {
  document.getElementById('sidebar-empty').style.display = 'none';
  document.getElementById('word-view').style.display = 'flex';
  document.getElementById('sidebar-word').textContent = word;
  resetBookFrequency();
  resetRegionalUsage();
  document.getElementById('rarity-badge').innerHTML = '';
  fetchRarity([word]).then(([zipf]) => {
    document.getElementById('rarity-badge').innerHTML = rarityBadge(zipf);
  });
  loadBookFrequency(word);
  loadRegionalUsage(word, sentence);
  document.getElementById('sidebar-translation').textContent = '';
  document.getElementById('sidebar-translation').className = 'sidebar-translation';
  document.getElementById('alt-meanings').innerHTML = '';
  document.getElementById('alt-meanings-wrap').classList.remove('visible');
  scheduleTranslateScrollHintUpdate();

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
  scheduleTranslateScrollHintUpdate();
}

function clearWordView() {
  document.getElementById('sidebar-empty').style.display = '';
  document.getElementById('word-view').style.display = 'none';
  activeFrequencyRequest = '';
  resetBookFrequency();
  resetRegionalUsage();
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
  document.getElementById('alt-meanings').innerHTML = '';
  document.getElementById('alt-meanings-wrap').classList.remove('visible');
  if (activeWordEl) { activeWordEl.classList.remove('active'); activeWordEl = null; }
  clearDragSel();
  currentWord = '';
  currentTranslation = '';
  scheduleTranslateScrollHintUpdate();
}

function updateSaveBtn(word) {
  const btn = document.getElementById('save-btn');
  const itemLabel = isPhrase(word) ? 'phrase' : 'word';
  if (savedWords.has(word.toLowerCase())) {
    btn.textContent = `✕ Remove ${itemLabel}`;
    btn.className = 'saved';
    btn.title = `Remove ${itemLabel} from saved items`;
  } else {
    btn.textContent = `💾 Save ${itemLabel}`;
    btn.className = '';
    btn.title = `Save ${itemLabel}`;
  }
}

async function loadAlternativeMeanings(text, sentence, primaryMeaning) {
  const wrap = document.getElementById('alt-meanings-wrap');
  const list = document.getElementById('alt-meanings');
  wrap.classList.remove('visible');
  list.innerHTML = '';
  try {
    const res = await fetch('/api/meanings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sentence, primaryMeaning })
    });
    if (!res.ok) throw new Error();
    const raw = (await res.text()).trim();
    if (!raw) return;
    const primaryNorm = normalizeMeaning(primaryMeaning || '');
    const meanings = raw
      .split('\n')
      .map(line => line.replace(/^\d+[\).\s-]+/, '').trim())
      .filter(Boolean)
      .filter(line => normalizeMeaning(line) !== 'none')
      .filter(line => normalizeMeaning(line) !== primaryNorm)
      .slice(0, 3);
    if (!meanings.length) return;
    list.innerHTML = meanings.map(line => `<div class="alt-meaning-item">${escapeHtml(line)}</div>`).join('');
    wrap.classList.add('visible');
    scheduleTranslateScrollHintUpdate();
  } catch {}
}

async function removeSavedWord(id, word) {
  await fetch(`/api/words/${id}`, { method: 'DELETE' });
  savedWords.delete(word.toLowerCase());
  document.querySelectorAll('#content .word.saved').forEach(span => {
    if (cleanWord(span.textContent).toLowerCase() === word.toLowerCase()) {
      span.classList.remove('saved');
    }
  });
  if (currentWord && currentWord.toLowerCase() === word.toLowerCase()) updateSaveBtn(currentWord);
  updateWordsTabCount();
}

// ── Save / remove word ──
document.getElementById('save-btn').addEventListener('click', async () => {
  if (!currentWord) return;
  const existing = savedWords.get(currentWord.toLowerCase());
  if (existing) {
    await removeSavedWord(existing.id, currentWord);
    return;
  }
  if (!currentTranslation) return;

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
  scheduleTranslateScrollHintUpdate();
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
      <button class="word-card-delete" data-id="${w.id}" data-word="${escapeHtml(w.word)}" title="Delete">✕</button>
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
      const word = btn.dataset.word;
      if (!word) return;
      await removeSavedWord(id, word);
      document.getElementById(`wc-${id}`)?.remove();
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

function updateTranslateScrollHint() {
  const panel = document.getElementById('panel-translate');
  const hint = document.getElementById('translate-scroll-hint');
  const sidebar = document.getElementById('sidebar');
  const canScroll = panel.scrollHeight - panel.clientHeight > 20;
  const hasMoreBelow = panel.scrollHeight - panel.clientHeight - panel.scrollTop > 20;
  const isActive = !panel.classList.contains('hidden') && !sidebar.classList.contains('closed');
  hint.classList.toggle('visible', isActive && canScroll && hasMoreBelow);
}

function scheduleTranslateScrollHintUpdate() {
  requestAnimationFrame(updateTranslateScrollHint);
}

// ── Tabs ──
function showTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `panel-${name}`));
  if (name === 'words') loadWordsTab();
  if (name === 'stats') loadStatsTab();
  scheduleTranslateScrollHintUpdate();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});
document.getElementById('panel-translate').addEventListener('scroll', updateTranslateScrollHint, { passive: true });
window.addEventListener('resize', scheduleTranslateScrollHintUpdate);

// ── Sidebar toggle ──
function isMobile() { return window.innerWidth < 640; }
function usesInlineLookup() {
  return isMobile() || (
    window.matchMedia('(pointer: coarse)').matches &&
    window.innerWidth <= 1024
  );
}

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
  resetBookFrequency();
  document.getElementById('popup-rarity').innerHTML = '';
  const pst = document.getElementById('popup-sentence-translation');
  pst.textContent = '';
  pst.classList.remove('visible');
  wordPopup.classList.add('visible');
  positionPopup(anchorEl);
  if (isMobile()) _pushOverlayHistory();
  loadBookFrequency(word).finally(() => positionPopup(anchorEl));
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
  activeFrequencyRequest = '';
  resetBookFrequency();
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
    loadAlternativeMeanings(currentWord, currentSentence, currentTranslation);
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
      .then(result => { sentTransEl.innerHTML = hlToHtml(result); scheduleTranslateScrollHintUpdate(); })
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
  scheduleTranslateScrollHintUpdate();
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
  scheduleTranslateScrollHintUpdate();
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
function updateSearchLayoutOffset() {
  const offset = document.body.classList.contains('search-open')
    ? `${document.getElementById('search-bar').offsetHeight || 0}px`
    : '0px';
  document.documentElement.style.setProperty('--search-offset', offset);
}

function repaginateForSearchBar(keepSummary = true) {
  if (!chapters.length || fixtureMode) return;
  const ratio = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
  requestAnimationFrame(() => setupPagination(ratio, keepSummary));
}

function openSearch() {
  document.getElementById('search-bar').classList.add('visible');
  document.body.classList.add('search-open');
  updateSearchLayoutOffset();
  repaginateForSearchBar();
  const input = document.getElementById('search-input');
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function closeSearch() {
  document.getElementById('search-bar').classList.remove('visible');
  document.body.classList.remove('search-open');
  updateSearchLayoutOffset();
  repaginateForSearchBar();
  clearSearchHighlights();
  searchMatches = [];
  searchCurrent = -1;
  bookSearchResults = [];
  currentBookSearchIndex = -1;
  document.getElementById('search-count').textContent = '';
  document.getElementById('search-input').value = '';
}

function clearSearchHighlights() {
  document.querySelectorAll('#content .word.search-match, #content .word.search-current').forEach(w => {
    w.classList.remove('search-match', 'search-current');
  });
}

// Find all occurrences of query in current chapter (single word or phrase).
// Returns array of "matches"; each match is an array of .word elements to highlight.
function findSearchMatchesInChapter(query) {
  const words = [...document.querySelectorAll('#content .word')];
  const q = normalizeSearchText(query.trim());
  const queryWords = q.split(/\s+/).filter(Boolean);
  if (!queryWords.length) return [];
  if (queryWords.length === 1) {
    return words.filter(w => normalizeSearchText(cleanWord(w.textContent)) === q).map(w => [w]);
  }
  const matches = [];
  for (let i = 0; i <= words.length - queryWords.length; i++) {
    const run = words
      .slice(i, i + queryWords.length)
      .map(w => normalizeSearchText(cleanWord(w.textContent)))
      .filter(Boolean)
      .join(' ');
    if (run === q) matches.push(words.slice(i, i + queryWords.length));
  }
  return matches;
}

function settleSearchViewport() {
  if (window.matchMedia('(pointer: coarse)').matches) {
    document.getElementById('search-input').blur();
  }
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(resolve, window.matchMedia('(pointer: coarse)').matches ? 180 : 60);
      });
    });
  });
}

function doSearch() {
  clearSearchHighlights();
  searchMatches = [];
  searchCurrent = -1;
  bookSearchResults = [];
  currentBookSearchIndex = -1;
  const query = normalizeSearchText(document.getElementById('search-input').value.trim());
  if (!query) {
    document.getElementById('search-count').textContent = '';
    return;
  }
  if (query.length < 2) {
    document.getElementById('search-count').textContent = 'Min 2 characters';
    return;
  }
  document.getElementById('search-count').textContent = 'Searching…';
  fetch(`/api/books/${bookId}/search?q=${encodeURIComponent(query)}`)
    .then(r => r.json())
    .then(results => {
      if (!Array.isArray(results) || results.length === 0) {
        document.getElementById('search-count').textContent = 'No matches in book';
        return;
      }
      bookSearchResults = results;
      goToBookSearchResult(0);
    })
    .catch(() => {
      document.getElementById('search-count').textContent = 'Search failed';
    });
}

function goToBookSearchResult(index) {
  if (index < 0 || index >= bookSearchResults.length) return;
  currentBookSearchIndex = index;
  const result = bookSearchResults[index];
  const query = document.getElementById('search-input').value.trim().toLowerCase();
  const loadTarget = () => {
    const occurrenceInChapter = bookSearchResults.slice(0, index).filter(r => r.chapterIndex === result.chapterIndex).length;
    searchMatches = findSearchMatchesInChapter(query);
    searchMatches.flat().forEach(w => w.classList.add('search-match'));
    goToSearchMatch(occurrenceInChapter);
    document.getElementById('search-count').textContent = `${index + 1} / ${bookSearchResults.length}`;
  };
  if (result.chapterIndex !== currentIndex) {
    loadChapter(result.chapterIndex, false, 0).then(() => {
      settleSearchViewport().then(loadTarget);
    });
  } else {
    settleSearchViewport().then(loadTarget);
  }
}

function goToSearchMatch(index) {
  if (!searchMatches.length) return;
  // searchMatches is array of arrays (each match = array of .word elements for phrase or single word)
  searchMatches.flat().forEach(w => w.classList.remove('search-current'));
  searchCurrent = ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
  const matchGroup = searchMatches[searchCurrent];
  const firstEl = Array.isArray(matchGroup) ? matchGroup[0] : matchGroup;
  matchGroup.forEach(w => w.classList.add('search-current'));
  if (pageWidth > 0 && firstEl) {
    const matchPage = Math.max(0, Math.min(totalPages - 1, Math.floor(firstEl.offsetLeft / pageWidth)));
    if (matchPage !== currentPage) goToPage(matchPage);
  }
  document.getElementById('search-count').textContent = `${searchCurrent + 1} / ${searchMatches.length}`;
}

document.getElementById('search-btn').addEventListener('click', openSearch);
document.getElementById('search-close').addEventListener('click', closeSearch);
document.getElementById('search-prev').addEventListener('click', () => {
  if (bookSearchResults.length > 0) goToBookSearchResult(currentBookSearchIndex - 1);
  else goToSearchMatch(searchCurrent - 1);
});
document.getElementById('search-next').addEventListener('click', () => {
  if (bookSearchResults.length > 0) goToBookSearchResult(currentBookSearchIndex + 1);
  else goToSearchMatch(searchCurrent + 1);
});

let searchTimeout;
document.getElementById('search-input').addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(doSearch, 300);
});
document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (bookSearchResults.length > 0) goToBookSearchResult(currentBookSearchIndex + (e.shiftKey ? -1 : 1));
    else goToSearchMatch(searchCurrent + (e.shiftKey ? -1 : 1));
  }
  if (e.key === 'Escape') closeSearch();
});
window.addEventListener('resize', () => {
  if (!document.body.classList.contains('search-open')) return;
  updateSearchLayoutOffset();
});

// ── Reading stats ──
let streakStats = { dailyWords: 0, streak: 0, goal: 500, goalMet: false };

async function refreshStreakStats() {
  try {
    const res = await fetch('/api/streak');
    if (!res.ok) throw new Error();
    streakStats = await res.json();
    renderReaderStreakCircle();
  } catch {}
}

async function logWordsRead(count, chapterIndex, pageNumber) {
  try {
    const res = await fetch('/api/reading-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: parseInt(bookId, 10),
        chapterIndex,
        pageNumber,
        wordsRead: count
      })
    });
    if (!res.ok) throw new Error();
    streakStats = await res.json();
  } catch {}
  renderReaderStreakCircle();
}

function renderReaderStreakCircle() {
  const el = document.getElementById('reader-streak-circle');
  if (!el) return;
  const streak = streakStats.streak || 0;
  const goal = streakStats.goal || 500;
  const dailyWords = streakStats.dailyWords || 0;
  const pct = Math.min(100, Math.round(dailyWords / goal * 100));
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

// ── Pagination ──
function setupPagination(restoreRatio = 0, keepSummary = false) {
  const textCol = document.getElementById('text-column');
  const pages = document.getElementById('chapter-pages');
  const content = document.getElementById('content');
  const chapterTitleEl = document.getElementById('chapter-title');
  if (!pages || !content) return;

  // Hide custom title header via inline style as well
  if (chapterTitleEl) chapterTitleEl.style.display = 'none';

  // Reset measurements
  textCol.style.padding = '0';
  const fullW = textCol.clientWidth;
  const fullH = textCol.clientHeight;
  const summaryBar = document.getElementById('page-summary-bar');
  const summaryBarH = summaryBar ? (summaryBar.offsetHeight || 54) : 54;
  
  if (fullW === 0 || fullH <= 0) return;

  // Layout constants
  const readableWidth = 650;
  const minPad = 16;
  const topPad = 24;
  const bottomPad = 32;

  // Symmetrical horizontal padding
  const hPad = fullW > (readableWidth + 2 * minPad) ? Math.round((fullW - readableWidth) / 2) : minPad;
  
  // Robust line-height calculation
  const style = window.getComputedStyle(content);
  let lineHeight = parseFloat(style.lineHeight);
  if (isNaN(lineHeight)) {
    lineHeight = (parseFloat(style.fontSize) || 18) * 1.6;
  }

  // Calculate strict snapped height for columns
  // Reserve generous space so the last line never hides under the summary bar,
  // even on short landscape screens (tablet / Fold inner). We keep at least
  // ~2 lines of breathing room above the bar.
  const bottomSafe = bottomPad + summaryBarH + Math.ceil(lineHeight * 2);
  const availableH = fullH - topPad - bottomSafe - 1;
  const snapH = Math.floor(availableH / lineHeight) * lineHeight;
  
  // Set container padding to create breathing room
  textCol.style.padding = `${topPad}px ${hPad}px ${bottomPad}px ${hPad}px`;

  // Internal column width (W) and full page stride (fullW = W + 2*hPad)
  const W = textCol.clientWidth;
  // Use fullW as the page stride so columns align exactly at the text-column
  // boundary, allowing overflow:hidden to clip the adjacent column cleanly.
  pageWidth = fullW;

  // Ensure content is strictly within the snapped height
  content.style.padding = '0';
  pages.style.height = snapH + 'px';
  pages.style.columnWidth = W + 'px';
  // column-gap = 2*hPad so each page unit = W + gap = fullW
  pages.style.columnGap = (2 * hPad) + 'px';
  pages.style.columnFill = 'auto';
  pages.style.overflow = 'visible'; // Never hide content; let it flow to next column
  pages.style.transform = 'translateX(0)';

  requestAnimationFrame(() => {
    totalPages = Math.max(1, Math.round(pages.scrollWidth / pageWidth));
    const totalWordEls = document.querySelectorAll('#content .word').length;
    wordsPerPage = totalPages > 0 ? Math.round(totalWordEls / totalPages) : 0;
    const target = restoreRatio >= 1 ? totalPages - 1 : Math.round(restoreRatio * (totalPages - 1));
    currentPage = -1;
    goToPage(target, keepSummary);
  });
}

function goToPage(n, keepSummary = false) {
  n = Math.max(0, Math.min(n, totalPages - 1));
  // Log words for the page we're leaving, only if enough time was spent on it
  const now = Date.now();
  if (pageArrivalTime > 0 && wordsPerPage > 0 && !loggedPages.has(currentPage)
      && (now - pageArrivalTime) >= MIN_PAGE_TIME) {
    loggedPages.add(currentPage);
    logWordsRead(wordsPerPage, currentIndex, currentPage);
  }
  currentPage = n;
  pageArrivalTime = now;
  saveProgress();
  const pages = document.getElementById('chapter-pages');
  if (pages) pages.style.transform = `translateX(${-Math.round(n * pageWidth)}px)`;
  const pct = totalPages > 1 ? n / (totalPages - 1) : 1;
  document.getElementById('progress-bar').style.width = (pct * 100) + '%';
  if (!keepSummary) {
    document.getElementById('page-summary-text').textContent = '';
    document.getElementById('summarize-btn').textContent = '✦ Summarize this page';
    document.getElementById('summarize-btn').disabled = false;
  }
  updateNav();
}

let resizeTimer = null;
const resizeObserver = new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const ratio = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
    setupPagination(ratio, true);
  }, 300);
});
resizeObserver.observe(document.getElementById('text-column'));

// Re-paginate when the summary bar grows/shrinks (e.g. summary text streaming in).
// keepSummary=true prevents goToPage from clearing the summary text (no feedback loop).
const summaryBarObserver = new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const ratio = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
    setupPagination(ratio, true);
  }, 150);
});
summaryBarObserver.observe(document.getElementById('page-summary-bar'));

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
