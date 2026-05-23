// ═══════════════════════════════════════════════════════════════════════════
// TubeGrab — Frontend Logic
// ═══════════════════════════════════════════════════════════════════════════

const API_BASE = window.location.origin;

// ── DOM Elements ─────────────────────────────────────────────────────────
const urlInput       = document.getElementById('url-input');
const fetchBtn       = document.getElementById('fetch-btn');
const loadingSection = document.getElementById('loading-section');
const errorSection   = document.getElementById('error-section');
const errorText      = document.getElementById('error-text');
const retryBtn       = document.getElementById('retry-btn');
const resultsSection = document.getElementById('results-section');
const videoThumbnail = document.getElementById('video-thumbnail');
const videoTitle     = document.getElementById('video-title');
const durationBadge  = document.getElementById('duration-badge');
const videoChannel   = document.getElementById('video-channel');
const videoViews     = document.getElementById('video-views');
const formatsGrid    = document.getElementById('formats-grid');
const newSearchBtn   = document.getElementById('new-search-btn');

// ── State ────────────────────────────────────────────────────────────────
let currentVideoUrl = '';
let isLoading = false;

// ── Init Lucide Icons ────────────────────────────────────────────────────
lucide.createIcons();

// ── Check Cookies Status ─────────────────────────────────────────────────

async function checkCookies() {
  const badge = document.getElementById('cookies-badge');
  const guide = document.getElementById('cookie-guide');
  if (!badge || !guide) return;
  
  try {
    const res = await fetch(`${API_BASE}/api/cookies-status`);
    const data = await res.json();
    if (data.loaded) {
      badge.textContent = 'Cookies Loaded';
      badge.className = 'cookies-badge cookies-ok';
      guide.classList.add('hidden');
    } else {
      badge.textContent = 'Cookies Missing';
      badge.className = 'cookies-badge cookies-missing';
      guide.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Failed to check cookies:', err);
  }
}

checkCookies();

// ── Helpers ──────────────────────────────────────────────────────────────

function formatViewCount(num) {
  if (!num) return '—';
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B';
  if (num >= 1_000_000)     return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000)         return (num / 1_000).toFixed(1) + 'K';
  return num.toString();
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + ' GB';
  if (bytes >= 1_048_576)     return (bytes / 1_048_576).toFixed(0) + ' MB';
  if (bytes >= 1024)          return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function showSection(section) {
  [loadingSection, errorSection, resultsSection].forEach(s => s.classList.add('hidden'));
  if (section) section.classList.remove('hidden');
}

// ── Fetch Video Info ─────────────────────────────────────────────────────

async function fetchVideoInfo() {
  const url = urlInput.value.trim();
  if (!url) {
    urlInput.focus();
    return;
  }

  currentVideoUrl = url;
  isLoading = true;
  fetchBtn.disabled = true;
  showSection(loadingSection);

  try {
    const res = await fetch(`${API_BASE}/api/info?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Failed to fetch video info.');
    }

    renderResults(data);
    showSection(resultsSection);
  } catch (err) {
    errorText.textContent = err.message || 'Something went wrong. Please try again.';
    showSection(errorSection);
    lucide.createIcons();
  } finally {
    isLoading = false;
    fetchBtn.disabled = false;
  }
}

// ── Render Results ───────────────────────────────────────────────────────

function renderResults(data) {
  videoThumbnail.src = data.thumbnail || '';
  videoThumbnail.alt = data.title || 'Video thumbnail';
  videoTitle.textContent = data.title || 'Untitled Video';
  durationBadge.textContent = data.duration || '';

  const channelSpan = videoChannel.querySelector('span');
  channelSpan.textContent = data.channel || 'Unknown';

  const viewsSpan = videoViews.querySelector('span');
  viewsSpan.textContent = formatViewCount(data.view_count) + ' views';

  formatsGrid.innerHTML = '';

  data.formats.forEach((fmt) => {
    const btn = document.createElement('button');
    btn.className = 'format-btn';

    if (fmt.type === 'best')  btn.classList.add('format-best');
    if (fmt.type === 'audio') btn.classList.add('format-audio');

    const sizeStr = fmt.filesize ? formatFileSize(fmt.filesize) : '';

    btn.innerHTML = `
      <span class="format-quality">${fmt.quality}</span>
      <span class="format-ext">${fmt.ext}</span>
      ${sizeStr ? `<span class="format-size">${sizeStr}</span>` : ''}
    `;

    btn.addEventListener('click', () => startDownload(fmt.format_id));
    formatsGrid.appendChild(btn);
  });

  lucide.createIcons();
}

// ── Start Download ───────────────────────────────────────────────────────

function startDownload(formatId) {
  const downloadUrl = `${API_BASE}/api/download?url=${encodeURIComponent(currentVideoUrl)}&format_id=${encodeURIComponent(formatId)}`;
  window.open(downloadUrl, '_blank');
}

// ── Event Listeners ──────────────────────────────────────────────────────

fetchBtn.addEventListener('click', fetchVideoInfo);

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchVideoInfo();
});

retryBtn.addEventListener('click', () => {
  showSection(null);
  urlInput.focus();
});

newSearchBtn.addEventListener('click', () => {
  urlInput.value = '';
  currentVideoUrl = '';
  showSection(null);
  urlInput.focus();
});

urlInput.focus();
