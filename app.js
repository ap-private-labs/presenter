// --- Filler word configuration ---
const FILLER_WORDS = [
  'uh', 'um', 'ah', 'er', 'like', 'you know', 'basically',
  'actually', 'literally', 'right', 'so', 'well', 'I mean',
  'kind of', 'sort of', 'honestly', 'okay so',
];

// Build a regex that matches filler words as whole words/phrases (case-insensitive)
const FILLER_REGEX = new RegExp(
  '\\b(' + FILLER_WORDS.map(w => w.replace(/\s+/g, '\\s+')).join('|') + ')\\b',
  'gi'
);

// --- State ---
let recognition = null;
let isRecording = false;
let startTime = null;
let timerInterval = null;
let totalWords = 0;
let fillerCounts = {};  // { word: count }
let transcriptParts = [];  // final transcript segments
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
    transcriptParts.push(newFinalTranscript);
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
  const matches = text.match(FILLER_REGEX);
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

function renderTranscript(interimText) {
  const finalHTML = transcriptParts
    .map(part => highlightFillers(part))
    .join(' ');

  const interimHTML = interimText
    ? `<span class="interim">${escapeHTML(interimText)}</span>`
    : '';

  transcriptEl.innerHTML = finalHTML + ' ' + interimHTML;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function highlightFillers(text) {
  return escapeHTML(text).replace(FILLER_REGEX, '<span class="filler">$1</span>');
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
  btnReset.disabled = true;

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
  btnReset.disabled = false;

  statusEl.textContent = 'Stopped';
  statusEl.className = 'status stopped';

  saveSession();
}

function resetSession() {
  totalWords = 0;
  fillerCounts = {};
  transcriptParts = [];
  startTime = null;

  timerEl.textContent = '00:00';
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
  historyList.innerHTML = sessions.map(s => {
    const date = new Date(s.date).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const mins = Math.floor(s.duration / 60);
    const secs = s.duration % 60;
    return `<div class="history-item">
      <div>
        <strong>${s.wpm} WPM</strong> &middot; ${s.fillers} fillers &middot; Clarity: ${s.clarity}
      </div>
      <div class="meta">${date} &middot; ${mins}m ${secs}s</div>
    </div>`;
  }).join('');
}

// --- Wire up buttons ---
btnStart.addEventListener('click', startRecording);
btnStop.addEventListener('click', stopRecording);
btnReset.addEventListener('click', resetSession);

// Load history on page load
renderHistory();
