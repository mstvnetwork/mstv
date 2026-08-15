// ═══════════════════════════════════════════════════════════════════
// LINEAR TV — Shared Player Engine v3
// Supports: direct .m3u8/.mp4 URLs  →  <video> + hls.js
//           web player iframe URLs  →  <iframe> embed
// ═══════════════════════════════════════════════════════════════════

const CHANNEL_EPOCH   = new Date('2024-01-01T00:00:00Z').getTime();
const PLAYLIST_URL    = './playlist.json';

const POLL_MS         = 5000;   // playlist change check interval
const WATCHDOG_MS     = 1000;   // sync ticker
const RESYNC_DRIFT    = 3;      // seconds drift before snap (video mode)

// ── URL type detection ────────────────────────────────────────────
// Returns 'iframe' if URL is a web player page, 'hls' or 'mp4' otherwise.
function detectType(item) {
  if (item.type === 'iframe' || item.type === 'embed') return 'iframe';
  const url = item.url || '';
  const lower = url.toLowerCase();

  // 1. Check for player pages/wrappers FIRST (handles ?url=...m3u8 wrappers correctly)
  if (
    lower.includes('/player')   ||
    lower.includes('?url=')     ||
    lower.includes('?src=')     ||
    lower.includes('?stream=')  ||
    lower.includes('?file=')    ||
    lower.includes('?link=')    ||
    lower.includes('?v=')       ||
    lower.includes('embed')     ||
    lower.includes('iframe')
  ) {
    return 'iframe';
  }

  // 2. Direct stream indicators
  if (lower.includes('.m3u8')) return 'hls';
  if (lower.match(/\.(mp4|webm|ogg|mkv)(\?|$)/i)) return 'mp4';

  // Fallback: default web URLs to iframe
  return 'iframe';
}

// ── Seek URL builder ──────────────────────────────────────────────
// Cleanly appends time parameters without breaking wrapper query parameters
function buildIframeSrc(url, seekSec) {
  const t = Math.floor(seekSec);
  try {
    const u = new URL(url);

    // If it's a wrapper player containing another URL query param, pass raw URL
    if (u.searchParams.has('url') || u.searchParams.has('src') || u.searchParams.has('file')) {
      return url;
    }

    if (u.searchParams.has('t')) {
      u.searchParams.set('t', t);
    } else if (u.searchParams.has('start')) {
      u.searchParams.set('start', t);
    } else {
      u.hash = `t=${t}`;
    }
    return u.toString();
  } catch {
    return url;
  }
}

// ═══════════════════════════════════════════════════════════════════
function initPlayer(cfg) {

  // ── DOM refs ──────────────────────────────────────────────────────
  const vid          = document.getElementById(cfg.videoId);
  const iframeEl     = document.getElementById(cfg.iframeId);
  const loader       = document.getElementById(cfg.loaderId);
  const errorMsg     = document.getElementById(cfg.errorId);
  const btnPlay      = document.getElementById(cfg.btnPlayId);
  const volSlider    = document.getElementById(cfg.volSliderId);
  const progressFill = document.getElementById(cfg.progressFillId);
  const scheduleList = cfg.scheduleListId ? document.getElementById(cfg.scheduleListId) : null;
  const syncToast    = document.getElementById(cfg.syncToastId);
  const updateToast  = cfg.updateToastId  ? document.getElementById(cfg.updateToastId)  : null;
  const statusText   = cfg.statusTextId   ? document.getElementById(cfg.statusTextId)   : null;
  const statusOffset = cfg.statusOffsetId ? document.getElementById(cfg.statusOffsetId) : null;
  const nowTitle     = document.getElementById(cfg.nowTitleId);
  const volOverlay   = cfg.volOverlayId   ? document.getElementById(cfg.volOverlayId)   : null;

  // ── State ─────────────────────────────────────────────────────────
  let playlist         = [];
  let totalDur         = 0;
  let currentIndex     = -1;
  let currentMode      = null;   // 'video' | 'iframe'
  let currentUrl       = '';
  let hls              = null;
  let paused           = false;
  let lastPlaylistHash = '';
  let itemStartTime    = 0;      // Wall-clock start time of current item

  // ── Clock ─────────────────────────────────────────────────────────
  if (cfg.showClock && cfg.clockId) {
    const clockEl     = document.getElementById(cfg.clockId);
    const clockDateEl = document.getElementById(cfg.clockDateId);
    function updateClock() {
      const now = new Date();
      if (clockEl)     clockEl.textContent     = now.toLocaleTimeString('en-GB', { hour12: false });
      if (clockDateEl) clockDateEl.textContent = now.toLocaleDateString('en-GB', {
        weekday:'short', day:'numeric', month:'short', year:'numeric'
      }).toUpperCase();
    }
    updateClock();
    setInterval(updateClock, 1000);
  }

  // ── Helpers ───────────────────────────────────────────────────────
  function fmt(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function pad(n) { return String(n).padStart(2,'0'); }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function computePos(nowMs) {
    if (!playlist.length) return null;
    const elapsed = ((nowMs - CHANNEL_EPOCH) / 1000 % totalDur + totalDur) % totalDur;
    let acc = 0;
    for (let i = 0; i < playlist.length; i++) {
      if (elapsed < acc + playlist[i].duration)
        return { index: i, offset: elapsed - acc, globalOffset: elapsed };
      acc += playlist[i].duration;
    }
    return { index: 0, offset: 0, globalOffset: 0 };
  }

  // ── Toasts ────────────────────────────────────────────────────────
  let syncTimer, updateTimer;
  function showSyncToast() {
    if (!syncToast) return;
    syncToast.classList.add('show');
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncToast.classList.remove('show'), 2500);
  }
  function showUpdateToast() {
    if (!updateToast) return;
    updateToast.classList.add('show');
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => updateToast.classList.remove('show'), 3000);
  }

  // ── Schedule ──────────────────────────────────────────────────────
  function renderSchedule(activeIdx, globalOffset) {
    if (!scheduleList) return;
    scheduleList.innerHTML = '';
    let acc = 0;
    playlist.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'schedule-item' +
        (i === activeIdx ? ' active' : acc + item.duration < globalOffset ? ' past' : '');
      el.innerHTML = `
        <div class="s-time">${fmt(acc)}</div>
        <div class="s-title">${esc(item.title)}</div>
        <div class="s-duration">${fmt(item.duration)} runtime</div>
        ${i === activeIdx ? '<div class="s-active-tag">▶ On now</div>' : ''}`;
      scheduleList.appendChild(el);
      if (i === activeIdx)
        setTimeout(() => el.scrollIntoView({ block:'nearest', behavior:'smooth' }), 100);
      acc += item.duration;
    });
  }

  // ── Mode switching ────────────────────────────────────────────────
  function showVideo() {
    if (vid)      vid.style.display      = 'block';
    if (iframeEl) { iframeEl.style.display = 'none'; iframeEl.src = 'about:blank'; }
    if (volSlider) volSlider.closest && volSlider.closest('.vol-wrap') &&
      (volSlider.closest('.vol-wrap').style.opacity = '1');
    if (volOverlay) volOverlay.style.display = 'none';
    currentMode = 'video';
  }

  function showIframe() {
    if (vid)      { vid.pause(); vid.src = ''; vid.style.display = 'none'; }
    if (iframeEl) iframeEl.style.display = 'block';
    if (hls)      { hls.destroy(); hls = null; }
    if (volSlider) volSlider.closest && volSlider.closest('.vol-wrap') &&
      (volSlider.closest('.vol-wrap').style.opacity = '0.3');
    if (volOverlay) volOverlay.style.display = 'flex';
    currentMode = 'iframe';
  }

  // ── Load item ─────────────────────────────────────────────────────
  function loadItem(index, seekTo) {
    const item   = playlist[index];
    const type   = detectType(item);
    const isIframe = type === 'iframe';

    currentIndex  = index;
    currentUrl    = item.url;
    itemStartTime = Date.now() - (seekTo * 1000); // Tracks real start timestamp

    if (nowTitle) nowTitle.textContent = item.title;
    loader.classList.remove('hidden');
    errorMsg.classList.remove('show');

    if (isIframe) {
      loadIframe(item, seekTo);
    } else {
      loadVideo(item, type, seekTo);
    }
  }

  // ── iframe mode ───────────────────────────────────────────────────
  function loadIframe(item, seekTo) {
    if (!iframeEl) {
      loader.classList.add('hidden');
      errorMsg.classList.add('show');
      return;
    }
    showIframe();
    const src = buildIframeSrc(item.url, seekTo);
    iframeEl.src = src;
    iframeEl.onload = () => loader.classList.add('hidden');
    setTimeout(() => loader.classList.add('hidden'), 4000);
  }

  // ── video mode ────────────────────────────────────────────────────
  function loadVideo(item, type, seekTo) {
    showVideo();
    if (hls) { hls.destroy(); hls = null; }

    const onReady = () => { vid.currentTime = seekTo; doPlay(); };

    if (type === 'hls' && typeof Hls !== 'undefined' && Hls.isSupported()) {
      hls = new Hls({ startPosition: seekTo });
      hls.loadSource(item.url);
      hls.attachMedia(vid);
      hls.on(Hls.Events.MANIFEST_PARSED, onReady);
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) handleError(); });
    } else if (vid.canPlayType('application/vnd.apple.mpegurl') && type === 'hls') {
      vid.src = item.url;
      vid.addEventListener('loadedmetadata', onReady, { once: true });
    } else {
      vid.src = item.url;
      vid.addEventListener('loadedmetadata', onReady, { once: true });
    }
    vid.onerror = handleError;
  }

  function doPlay() {
    loader.classList.add('hidden');
    errorMsg.classList.remove('show');
    vid.volume = parseFloat(volSlider ? volSlider.value : 0.8);
    vid.play().catch(() => { if (btnPlay) btnPlay.textContent = '▶'; });
    paused = false;
    if (btnPlay) btnPlay.textContent = '⏸';
  }

  function handleError() {
    loader.classList.add('hidden');
    errorMsg.classList.add('show');
    setTimeout(() => {
      const pos = computePos(Date.now());
      if (pos) loadItem(pos.index, pos.offset);
    }, 5000);
  }

  // ── Play/Pause button ─────────────────────────────────────────────
  if (btnPlay) {
    btnPlay.addEventListener('click', () => {
      if (currentMode === 'iframe') {
        if (!paused) {
          iframeEl.src = 'about:blank';
          paused = true;
          btnPlay.textContent = '▶';
        } else {
          const pos = computePos(Date.now());
          if (!pos) return;
          loadItem(pos.index, pos.offset);
          paused = false;
          btnPlay.textContent = '⏸';
          showSyncToast();
        }
      } else {
        if (vid.paused) {
          const pos = computePos(Date.now());
          if (!pos) return;
          if (pos.index !== currentIndex) {
            loadItem(pos.index, pos.offset);
          } else {
            vid.currentTime = pos.offset;
            vid.play();
          }
          paused = false;
          btnPlay.textContent = '⏸';
          showSyncToast();
        } else {
          vid.pause();
          paused = true;
          btnPlay.textContent = '▶';
        }
      }
    });
  }

  if (volSlider && vid) {
    volSlider.addEventListener('input', () => { vid.volume = parseFloat(volSlider.value); });
  }

  if (vid) vid.addEventListener('contextmenu', e => e.preventDefault());

  // ── Sync watchdog ─────────────────────────────────────────────────
  setInterval(() => {
    if (paused || !playlist.length) return;
    const pos = computePos(Date.now());
    if (!pos) return;

    // Progress bar — for iframe mode calculate relative elapsed runtime
    if (progressFill) {
      if (currentMode === 'iframe') {
        const elapsed = (Date.now() - itemStartTime) / 1000;
        const pct = Math.min((elapsed / playlist[pos.index].duration) * 100, 100);
        progressFill.style.width = pct + '%';
      } else if (vid && !vid.paused) {
        progressFill.style.width =
          Math.min((vid.currentTime / playlist[pos.index].duration) * 100, 100) + '%';
      }
    }

    // Status bar
    if (statusText && playlist[pos.index]) {
      const elapsed = currentMode === 'iframe'
        ? (Date.now() - itemStartTime) / 1000
        : (vid ? vid.currentTime : 0);
      const rem = playlist[pos.index].duration - elapsed;
      statusText.textContent = `Up next in ${fmt(Math.max(0, rem))}`;
    }
    if (statusOffset) statusOffset.textContent = `OFFSET ${fmt(Math.floor(pos.globalOffset))}`;

    // ── Item switch check ─────────────────────────────────────────
    if (pos.index !== currentIndex) {
      loadItem(pos.index, pos.offset);
      renderSchedule(pos.index, pos.globalOffset);
      return;
    }

    // ── Drift correction (video mode only) ────────────────────────
    if (currentMode === 'video' && vid && !vid.paused && !vid.seeking) {
      const drift = Math.abs(vid.currentTime - pos.offset);
      if (drift > RESYNC_DRIFT) {
        vid.currentTime = pos.offset;
        showSyncToast();
      }
    }

    renderSchedule(pos.index, pos.globalOffset);
  }, WATCHDOG_MS);

  // ── Live playlist polling ─────────────────────────────────────────
  async function pollPlaylist() {
    try {
      const res = await fetch(PLAYLIST_URL + '?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const text = await res.text();
      if (text === lastPlaylistHash) return;
      lastPlaylistHash = text;

      let newList;
      try { newList = JSON.parse(text); } catch { return; }
      if (!Array.isArray(newList) || !newList.length) return;

      playlist = newList;
      totalDur = playlist.reduce((s, v) => s + v.duration, 0);

      const pos = computePos(Date.now());
      if (!pos) return;

      showUpdateToast();

      const sameUrl = pos.index === currentIndex &&
        playlist[pos.index] &&
        playlist[pos.index].url === currentUrl;

      if (sameUrl) {
        renderSchedule(pos.index, pos.globalOffset);
      } else {
        loadItem(pos.index, pos.offset);
        renderSchedule(pos.index, pos.globalOffset);
      }
    } catch { /* network blip */ }
  }

  // ── Init ──────────────────────────────────────────────────────────
  async function init() {
    try {
      const res  = await fetch(PLAYLIST_URL + '?_=' + Date.now(), { cache: 'no-store' });
      const text = await res.text();
      lastPlaylistHash = text;
      playlist = JSON.parse(text);
      totalDur = playlist.reduce((s, v) => s + v.duration, 0);

      const pos = computePos(Date.now());
      if (!pos) throw new Error('Empty playlist');

      renderSchedule(pos.index, pos.globalOffset);
      loadItem(pos.index, pos.offset);
      setInterval(pollPlaylist, POLL_MS);
    } catch (e) {
      loader.classList.add('hidden');
      errorMsg.classList.add('show');
      console.error('Channel init failed:', e);
    }
  }

  init();
    }
