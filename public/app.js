const form = document.getElementById('capture-form');
const urlInput = document.getElementById('url-input');
const captureBtn = document.getElementById('capture-btn');
const result = document.getElementById('result');
const loading = document.getElementById('loading');
const errorMsg = document.getElementById('error-msg');
const previewArea = document.getElementById('preview-area');
const previewImg = document.getElementById('preview-img');
const downloadBtn = document.getElementById('download-btn');
const infoDims = document.getElementById('info-dims');
const infoSize = document.getElementById('info-size');
const infoTime = document.getElementById('info-time');
const truncWarning = document.getElementById('truncation-warning');
const loginWarning = document.getElementById('login-warning');
const selectorWarning = document.getElementById('selector-warning');
const delaySlider = document.getElementById('delay-slider');
const delayValue = document.getElementById('delay-value');
const historyList = document.getElementById('history-list');
const vpWidth = document.getElementById('vp-width');
const vpHeight = document.getElementById('vp-height');
const clearHistoryBtn = document.getElementById('clear-history');

let currentBlob = null;
let currentFilename = '';

// Preview image error handler
previewImg.addEventListener('error', () => {
  previewArea.classList.add('hidden');
  showError('Failed to load screenshot preview. The image may be corrupted.');
});

// --- Settings persistence ---
const SETTINGS_KEY = 'screenshotter_settings';

function saveSettings() {
  const settings = {
    url: urlInput.value,
    vpWidth: parseInt(vpWidth.value, 10),
    vpHeight: parseInt(vpHeight.value, 10),
    scale: parseInt(document.querySelector('input[name="scale"]:checked').value, 10),
    fullPage: document.getElementById('full-page').checked,
    darkMode: document.getElementById('dark-mode').checked,
    delay: parseInt(delaySlider.value, 10),
    waitSelector: document.getElementById('wait-selector').value,
    customCss: document.getElementById('custom-css').value,
  };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

function restoreSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch { return; }
  if (!s || typeof s !== 'object') return;

  if (typeof s.url === 'string' && s.url) urlInput.value = s.url;

  const w = parseInt(s.vpWidth, 10);
  if (w >= 320 && w <= 3840) vpWidth.value = w;
  const h = parseInt(s.vpHeight, 10);
  if (h >= 320 && h <= 2160) vpHeight.value = h;

  const scale = parseInt(s.scale, 10);
  if (scale >= 1 && scale <= 3) {
    const radio = document.querySelector(`input[name="scale"][value="${scale}"]`);
    if (radio) radio.checked = true;
  }

  if (typeof s.fullPage === 'boolean') document.getElementById('full-page').checked = s.fullPage;
  if (typeof s.darkMode === 'boolean') document.getElementById('dark-mode').checked = s.darkMode;

  const delay = parseInt(s.delay, 10);
  if (delay >= 0 && delay <= 10000) {
    delaySlider.value = delay;
    delayValue.textContent = (delay / 1000).toFixed(1) + 's';
  }

  if (typeof s.waitSelector === 'string') document.getElementById('wait-selector').value = s.waitSelector;
  if (typeof s.customCss === 'string') document.getElementById('custom-css').value = s.customCss;
}

restoreSettings();

// Delay slider display
delaySlider.addEventListener('input', () => {
  delayValue.textContent = (delaySlider.value / 1000).toFixed(1) + 's';
});

// Viewport presets
document.querySelectorAll('.preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    vpWidth.value = btn.dataset.width;
    vpHeight.value = btn.dataset.height;
  });
});

// Form submit
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  let url = urlInput.value.trim();
  if (!url) return;

  // Auto-prepend https if no scheme
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
    urlInput.value = url;
  }

  // Show loading with elapsed timer
  result.classList.remove('hidden');
  loading.classList.remove('hidden');
  errorMsg.classList.add('hidden');
  previewArea.classList.add('hidden');
  captureBtn.disabled = true;
  captureBtn.textContent = 'Capturing...';

  const loadingText = loading.querySelector('p');
  const timerStart = Date.now();
  const timerInterval = setInterval(() => {
    const elapsed = ((Date.now() - timerStart) / 1000).toFixed(0);
    loadingText.textContent = `Capturing screenshot... ${elapsed}s`;
  }, 1000);

  const body = {
    url,
    viewport: {
      width: parseInt(vpWidth.value, 10) || 1440,
      height: parseInt(vpHeight.value, 10) || 900,
    },
    deviceScaleFactor: parseInt(document.querySelector('input[name="scale"]:checked').value, 10),
    fullPage: document.getElementById('full-page').checked,
    darkMode: document.getElementById('dark-mode').checked,
    waitTime: parseInt(delaySlider.value, 10),
    customCss: document.getElementById('custom-css').value.trim(),
    waitForSelector: document.getElementById('wait-selector').value.trim(),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  try {
    saveSettings();

    const res = await fetch('/api/screenshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      let errText;
      try {
        const data = await res.json();
        errText = data.error || `Error ${res.status}`;
        if (data.retryAfter) {
          errText += ` (retry in ${data.retryAfter}s)`;
        }
      } catch {
        errText = `Error ${res.status}: ${res.statusText}`;
      }
      showError(errText);
      return;
    }

    const blob = await res.blob();
    const width = res.headers.get('X-Screenshot-Width');
    const height = res.headers.get('X-Screenshot-Height');
    const captureTime = res.headers.get('X-Capture-Time-Ms');
    const truncated = res.headers.get('X-Screenshot-Truncated') === 'true';
    const selectorTimeout = res.headers.get('X-Selector-Timeout') === 'true';
    const disposition = res.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="(.+?)"/);

    currentBlob = blob;
    currentFilename = filenameMatch ? filenameMatch[1] : 'screenshot.png';

    // Show preview
    loading.classList.add('hidden');
    previewArea.classList.remove('hidden');

    const objectUrl = URL.createObjectURL(blob);
    previewImg.src = objectUrl;

    infoDims.textContent = `${width} x ${height}px`;
    infoSize.textContent = formatBytes(blob.size);
    infoTime.textContent = captureTime ? `${(captureTime / 1000).toFixed(1)}s` : '';

    truncWarning.classList.toggle('hidden', !truncated);
    selectorWarning.classList.toggle('hidden', !selectorTimeout);

    // Login page detection
    const isLoginPage = /log\s*in|sign\s*in|auth/i.test(url);
    loginWarning.classList.toggle('hidden', !isLoginPage);

    // Save to history
    saveToHistory(url, objectUrl, blob);
  } catch (err) {
    if (err.name === 'AbortError') {
      showError('Request timed out (3 minutes). Try a smaller viewport or lower scale factor.');
    } else {
      showError(err.message || 'Network error');
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(timerInterval);
    loadingText.textContent = 'Capturing screenshot...';
    captureBtn.disabled = false;
    captureBtn.textContent = 'Capture';
  }
});

function showError(msg) {
  loading.classList.add('hidden');
  previewArea.classList.add('hidden');
  errorMsg.classList.remove('hidden');
  errorMsg.textContent = msg;
}

// Download
downloadBtn.addEventListener('click', () => {
  if (!currentBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(currentBlob);
  a.download = currentFilename;
  a.click();
  URL.revokeObjectURL(a.href);
});

// History
const HISTORY_KEY = 'screenshotter_history';
const MAX_HISTORY = 20;

function saveToHistory(url, objectUrl, blob) {
  // Create thumbnail via canvas
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    const scale = 200 / img.width;
    canvas.width = 200;
    canvas.height = Math.round(img.height * scale);
    // Cap thumbnail height
    if (canvas.height > 200) canvas.height = 200;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const thumbnail = canvas.toDataURL('image/jpeg', 0.6);

    const history = getHistory();
    history.unshift({
      url,
      timestamp: Date.now(),
      thumbnail,
    });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;

    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      // localStorage full, drop oldest
      history.length = Math.floor(history.length / 2);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch {}
    }

    renderHistory();
  };
  img.src = objectUrl;
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function renderHistory() {
  const history = getHistory();
  clearHistoryBtn.classList.toggle('hidden', history.length === 0);
  if (history.length === 0) {
    historyList.innerHTML = '<p class="history-empty">No captures yet</p>';
    return;
  }

  historyList.innerHTML = history.map((item) => {
    const fullDate = new Date(item.timestamp).toLocaleString();
    return `
    <div class="history-item" data-url="${escapeAttr(item.url)}">
      <img src="${item.thumbnail}" alt="Thumbnail" loading="lazy">
      <div class="url">${escapeHtml(item.url)}</div>
      <div class="time" title="${escapeAttr(fullDate)}">${formatTime(item.timestamp)}</div>
    </div>
  `;
  }).join('');

  // Click to re-capture
  historyList.querySelectorAll('.history-item').forEach((el) => {
    el.addEventListener('click', () => {
      urlInput.value = el.dataset.url;
      urlInput.focus();
    });
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;

  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3600_000) return Math.floor(diffMs / 60_000) + 'm ago';

  const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  // Same day
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return timeStr;

  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${timeStr}`;

  const monthDay = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  // Same year
  if (d.getFullYear() === now.getFullYear()) return `${monthDay}, ${timeStr}`;

  // Older
  return `${monthDay}, ${d.getFullYear()}, ${timeStr}`;
}

function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// Clear history
clearHistoryBtn.addEventListener('click', () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

// Initial render
renderHistory();
