// --- Filler word configuration ---
const DEFAULT_FILLERS = [
  'uh', 'um', 'ah', 'er', 'like', 'you know', 'basically',
  'actually', 'literally', 'right', 'so', 'well', 'I mean',
  'kind of', 'sort of', 'honestly', 'okay so',
];

// Load saved filler config from localStorage, or initialize from defaults
// Format: { word: { enabled: bool, custom: bool } }
function loadFillerConfig() {
  const saved = localStorage.getItem('presenter-filler-config');
  if (saved) return JSON.parse(saved);
  const config = {};
  for (const word of DEFAULT_FILLERS) {
    config[word] = { enabled: true, custom: false };
  }
  return config;
}

let fillerConfig = loadFillerConfig();

function saveFillerConfig() {
  localStorage.setItem('presenter-filler-config', JSON.stringify(fillerConfig));
}

function getActiveFillers() {
  return Object.entries(fillerConfig)
    .filter(([_, v]) => v.enabled)
    .map(([word]) => word);
}

// Build regex from currently active filler words
function buildFillerRegex() {
  const active = getActiveFillers();
  if (active.length === 0) return null;
  return new RegExp(
    '\\b(' + active.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|') + ')\\b',
    'gi'
  );
}

let FILLER_REGEX = buildFillerRegex();

// --- State ---
let recognition = null;
let isRecording = false;
let startTime = null;
let timerInterval = null;
let totalWords = 0;
let fillerCounts = {};  // { word: count }
let transcriptParts = [];  // { text, timestamp, slide }
let currentSlide = 1;
let slideTimestamps = [];  // { slide, timestamp }
let sessions = JSON.parse(localStorage.getItem('presenter-sessions') || '[]');

// --- DOM refs ---
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnReset = document.getElementById('btn-reset');
const statusEl = document.getElementById('status');
const timerEl = document.getElementById('timer');
const wpmEl = document.getElementById('wpm');
const totalWordsEl = document.getElementById('total-words');
const fillerCountEl = document.getElementById('filler-count');
const fillerRateEl = document.getElementById('filler-rate');
const clarityEl = document.getElementById('clarity-score');
const fillerChipsEl = document.getElementById('filler-chips');
const transcriptEl = document.getElementById('transcript');
const historySection = document.getElementById('history-section');
const historyList = document.getElementById('history-list');
const btnNextSlide = document.getElementById('btn-next-slide');
const slideIndicator = document.getElementById('slide-indicator');
const replaySection = document.getElementById('replay-section');
const replayContent = document.getElementById('replay-content');
const btnCloseReplay = document.getElementById('btn-close-replay');

// --- Check browser support ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognition) {
  statusEl.textContent = 'Speech Recognition not supported — use Chrome or Edge';
  statusEl.className = 'status stopped';
  btnStart.disabled = true;
}

// --- Speech Recognition setup ---
function createRecognition() {
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';
  rec.maxAlternatives = 1;

  rec.onresult = handleResult;
  rec.onerror = handleError;
  rec.onend = handleEnd;

  return rec;
}

// --- Event handlers ---
function handleResult(event) {
  let interimTranscript = '';
  let newFinalTranscript = '';

  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result = event.results[i];
    const text = result[0].transcript;

    if (result.isFinal) {
      newFinalTranscript += text;
    } else {
      interimTranscript += text;
    }
  }

  if (newFinalTranscript) {
    transcriptParts.push({
      text: newFinalTranscript,
      timestamp: getElapsedSeconds(),
      slide: currentSlide,
    });
    processFinalText(newFinalTranscript);
  }

  renderTranscript(interimTranscript);
  updateStats();
}

function handleError(event) {
  if (event.error === 'no-speech') return; // ignore silence
  console.error('Speech recognition error:', event.error);
  if (event.error === 'not-allowed') {
    statusEl.textContent = 'Microphone access denied';
    statusEl.className = 'status stopped';
    stopRecording();
  }
}

function handleEnd() {
  // Auto-restart if still recording (browser stops after silence)
  if (isRecording) {
    try {
      recognition.start();
    } catch (e) {
      // already started
    }
  }
}

// --- Text processing ---
function processFinalText(text) {
  // Count words
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);
  totalWords += words.length;

  // Detect filler words
  const matches = FILLER_REGEX ? text.match(FILLER_REGEX) : null;
  if (matches) {
    for (const match of matches) {
      const key = match.toLowerCase();
      fillerCounts[key] = (fillerCounts[key] || 0) + 1;
    }
  }
}

// --- UI updates ---
function updateStats() {
  const elapsed = getElapsedSeconds();
  const minutes = elapsed / 60;

  // WPM
  const wpm = minutes > 0 ? Math.round(totalWords / minutes) : 0;
  wpmEl.textContent = wpm;
  totalWordsEl.textContent = `${totalWords} words total`;

  // Color-code WPM (ideal: 120-160)
  const wpmCard = wpmEl.closest('.stat-card');
  wpmCard.classList.remove('good', 'bad', 'warning');
  if (wpm > 0 && wpm >= 120 && wpm <= 160) {
    wpmCard.classList.add('good');
  } else if (wpm > 180 || (wpm > 0 && wpm < 100)) {
    wpmCard.classList.add('bad');
  }

  // Filler count
  const totalFillers = Object.values(fillerCounts).reduce((a, b) => a + b, 0);
  fillerCountEl.textContent = totalFillers;

  const fillerRate = totalWords > 0 ? ((totalFillers / totalWords) * 100).toFixed(1) : 0;
  fillerRateEl.textContent = `${fillerRate}% of words`;

  // Clarity score (100 = no fillers, drops as filler % increases)
  const clarity = Math.max(0, Math.round(100 - (fillerRate * 5)));
  clarityEl.textContent = clarity;

  const clarityCard = clarityEl.closest('.stat-card');
  clarityCard.classList.remove('good', 'bad', 'warning');
  if (clarity >= 80) clarityCard.classList.add('good');
  else if (clarity >= 50) clarityCard.classList.add('warning');
  else clarityCard.classList.add('bad');

  // Filler chips
  renderFillerChips();
}

function renderFillerChips() {
  const sorted = Object.entries(fillerCounts).sort((a, b) => b[1] - a[1]);
  fillerChipsEl.innerHTML = sorted.length === 0
    ? '<span style="color:#475569;font-size:0.85rem">No filler words detected yet</span>'
    : sorted.map(([word, count]) =>
        `<div class="filler-chip">
          <span>${word}</span>
          <span class="count">${count}</span>
        </div>`
      ).join('');
}

function formatTime(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function renderTranscript(interimText) {
  let html = '';
  let lastSlide = 0;

  for (const part of transcriptParts) {
    if (part.slide !== lastSlide) {
      const slideTs = slideTimestamps.find(s => s.slide === part.slide);
      const time = slideTs ? formatTime(slideTs.timestamp) : formatTime(part.timestamp);
      html += `<div class="slide-divider">Slide ${part.slide} <span class="slide-time">${time}</span></div>`;
      lastSlide = part.slide;
    }
    html += `<span class="timestamp">${formatTime(part.timestamp)}</span>${highlightFillers(part.text)} `;
  }

  const interimHTML = interimText
    ? `<span class="interim">${escapeHTML(interimText)}</span>`
    : '';

  transcriptEl.innerHTML = html + interimHTML;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function highlightFillers(text) {
  const escaped = escapeHTML(text);
  return FILLER_REGEX ? escaped.replace(FILLER_REGEX, '<span class="filler">$1</span>') : escaped;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Timer ---
function startTimer() {
  startTime = Date.now();
  timerInterval = setInterval(() => {
    const s = getElapsedSeconds();
    const mins = String(Math.floor(s / 60)).padStart(2, '0');
    const secs = String(Math.floor(s % 60)).padStart(2, '0');
    timerEl.textContent = `${mins}:${secs}`;
    updateStats();
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function getElapsedSeconds() {
  if (!startTime) return 0;
  return (Date.now() - startTime) / 1000;
}

// --- Recording controls ---
function startRecording() {
  recognition = createRecognition();
  recognition.start();
  isRecording = true;

  btnStart.textContent = 'Recording...';
  btnStart.classList.add('recording');
  btnStart.disabled = true;
  btnStop.disabled = false;
  btnNextSlide.disabled = false;
  btnReset.disabled = true;

  currentSlide = 1;
  slideTimestamps = [{ slide: 1, timestamp: 0 }];
  slideIndicator.textContent = 'Slide 1';
  slideIndicator.style.display = 'inline';

  statusEl.textContent = 'Listening';
  statusEl.className = 'status listening';

  transcriptEl.innerHTML = '';
  startTimer();
}

function stopRecording() {
  isRecording = false;
  if (recognition) {
    recognition.stop();
    recognition = null;
  }

  stopTimer();

  btnStart.textContent = 'Start Recording';
  btnStart.classList.remove('recording');
  btnStart.disabled = false;
  btnStop.disabled = true;
  btnNextSlide.disabled = true;
  btnReset.disabled = false;

  statusEl.textContent = 'Stopped';
  statusEl.className = 'status stopped';

  saveSession();
}

function nextSlide() {
  currentSlide++;
  const ts = getElapsedSeconds();
  slideTimestamps.push({ slide: currentSlide, timestamp: ts });
  slideIndicator.textContent = `Slide ${currentSlide}`;
  renderTranscript('');
}

function resetSession() {
  totalWords = 0;
  fillerCounts = {};
  transcriptParts = [];
  currentSlide = 1;
  slideTimestamps = [];
  startTime = null;

  timerEl.textContent = '00:00';
  slideIndicator.style.display = 'none';
  transcriptEl.innerHTML = '<span class="placeholder">Your speech will appear here...</span>';

  btnReset.disabled = true;
  statusEl.textContent = 'Ready';
  statusEl.className = 'status idle';

  updateStats();
}

// --- Session persistence ---
function saveSession() {
  if (totalWords === 0) return;

  const elapsed = getElapsedSeconds();
  const totalFillers = Object.values(fillerCounts).reduce((a, b) => a + b, 0);

  const session = {
    date: new Date().toISOString(),
    duration: Math.round(elapsed),
    words: totalWords,
    wpm: elapsed > 0 ? Math.round(totalWords / (elapsed / 60)) : 0,
    fillers: totalFillers,
    fillerBreakdown: { ...fillerCounts },
    clarity: Math.max(0, Math.round(100 - ((totalFillers / totalWords) * 100 * 5))),
    transcript: transcriptParts.map(p => ({ ...p })),
    slides: slideTimestamps.map(s => ({ ...s })),
    totalSlides: currentSlide,
  };

  sessions.unshift(session);
  if (sessions.length > 20) sessions.pop();
  localStorage.setItem('presenter-sessions', JSON.stringify(sessions));
  renderHistory();
}

function renderHistory() {
  if (sessions.length === 0) {
    historySection.style.display = 'none';
    return;
  }

  historySection.style.display = 'block';
  historyList.innerHTML = sessions.map((s, i) => {
    const date = new Date(s.date).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const mins = Math.floor(s.duration / 60);
    const secs = s.duration % 60;
    const slideInfo = s.totalSlides ? ` &middot; ${s.totalSlides} slides` : '';
    const hasTranscript = s.transcript && s.transcript.length > 0;
    return `<div class="history-item" ${hasTranscript ? `data-session="${i}"` : ''}>
      <div>
        <strong>${s.wpm} WPM</strong> &middot; ${s.fillers} fillers &middot; Clarity: ${s.clarity}${slideInfo}
      </div>
      <div class="meta">${date} &middot; ${mins}m ${secs}s${hasTranscript ? ' &middot; click to replay' : ''}</div>
    </div>`;
  }).join('');
}

// --- Replay ---
function showReplay(sessionIndex) {
  const s = sessions[sessionIndex];
  if (!s || !s.transcript) return;

  let html = `<div class="replay-stats">
    <span>${s.wpm} WPM</span>
    <span>${s.words} words</span>
    <span>${s.fillers} fillers</span>
    <span>Clarity: ${s.clarity}</span>
    <span>${s.totalSlides || 1} slide${(s.totalSlides || 1) !== 1 ? 's' : ''}</span>
    <span>${formatTime(s.duration)}</span>
  </div>`;

  html += '<div class="replay-content-inner">';
  let lastSlide = 0;
  for (const part of s.transcript) {
    if (part.slide !== lastSlide) {
      const slideTs = s.slides ? s.slides.find(sl => sl.slide === part.slide) : null;
      const time = slideTs ? formatTime(slideTs.timestamp) : formatTime(part.timestamp);
      html += `<div class="slide-divider">Slide ${part.slide} <span class="slide-time">${time}</span></div>`;
      lastSlide = part.slide;
    }
    html += `<span class="timestamp">${formatTime(part.timestamp)}</span>${highlightFillers(part.text)} `;
  }
  html += '</div>';

  replayContent.innerHTML = html;
  replaySection.style.display = 'block';
  replaySection.scrollIntoView({ behavior: 'smooth' });
}

function closeReplay() {
  replaySection.style.display = 'none';
}

historyList.addEventListener('click', e => {
  const item = e.target.closest('.history-item[data-session]');
  if (item) showReplay(parseInt(item.dataset.session));
});

btnCloseReplay.addEventListener('click', closeReplay);

// --- Settings panel ---
const btnSettings = document.getElementById('btn-settings');
const settingsPanel = document.getElementById('settings-panel');
const fillerTogglesEl = document.getElementById('filler-toggles');
const newFillerInput = document.getElementById('new-filler-input');
const btnAddFiller = document.getElementById('btn-add-filler');

function toggleSettings() {
  const open = settingsPanel.style.display !== 'none';
  settingsPanel.style.display = open ? 'none' : 'block';
  btnSettings.textContent = open ? 'Settings' : 'Hide Settings';
}

function renderFillerToggles() {
  fillerTogglesEl.innerHTML = Object.entries(fillerConfig)
    .map(([word, { enabled, custom }]) => {
      const cls = `filler-toggle ${enabled ? 'active' : 'inactive'} ${custom ? 'custom' : ''}`;
      return `<div class="${cls}" data-word="${escapeHTML(word)}">
        <span>${escapeHTML(word)}</span>
        ${custom ? `<button class="remove-btn" data-remove="${escapeHTML(word)}">&times;</button>` : ''}
      </div>`;
    }).join('');
}

function handleToggleClick(e) {
  const toggle = e.target.closest('.filler-toggle');
  const removeBtn = e.target.closest('.remove-btn');

  if (removeBtn) {
    const word = removeBtn.dataset.remove;
    delete fillerConfig[word];
    saveFillerConfig();
    FILLER_REGEX = buildFillerRegex();
    renderFillerToggles();
    return;
  }

  if (toggle) {
    const word = toggle.dataset.word;
    fillerConfig[word].enabled = !fillerConfig[word].enabled;
    saveFillerConfig();
    FILLER_REGEX = buildFillerRegex();
    renderFillerToggles();
  }
}

function addCustomFiller() {
  const word = newFillerInput.value.trim().toLowerCase();
  if (!word) return;
  if (fillerConfig[word]) {
    fillerConfig[word].enabled = true;
  } else {
    fillerConfig[word] = { enabled: true, custom: true };
  }
  newFillerInput.value = '';
  saveFillerConfig();
  FILLER_REGEX = buildFillerRegex();
  renderFillerToggles();
}

btnSettings.addEventListener('click', toggleSettings);
fillerTogglesEl.addEventListener('click', handleToggleClick);
btnAddFiller.addEventListener('click', addCustomFiller);
newFillerInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') addCustomFiller();
});

// --- Wire up buttons ---
btnStart.addEventListener('click', startRecording);
btnStop.addEventListener('click', stopRecording);
btnNextSlide.addEventListener('click', nextSlide);
btnReset.addEventListener('click', resetSession);

// Initial render
renderFillerToggles();
renderHistory();
