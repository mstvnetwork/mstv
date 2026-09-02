let PLAYLIST = [];
let SCHEDULE_TIMELINE = [];
let hlsInstance = null;
let currentItem = null;
let currentItemIndex = -1;
let currentItemStartTime = 0;
let globalConfig = null;
let uiHideTimer = null;

const PLAYLIST_JSON_URL = "./playlist2.json";
const BASE_ANCHOR_DATE = "2026-01-01T00:00:00Z";
const MAX_ALLOWED_DRIFT_SEC = 0.2;
const SYNC_CHECK_INTERVAL_MS = 500;
const UI_HIDE_TIMEOUT_MS = 3500;

function normalizePlaylistForCompare(list) {
  return JSON.stringify(
    (list || []).map(t => ({
      url: t.url,
      name: t.name,
      type: t.type,
      duration_seconds: t.duration_seconds
    }))
  );
}

function generateAbsoluteTimeline() {
  let runMs = new Date(BASE_ANCHOR_DATE).getTime();
  SCHEDULE_TIMELINE = PLAYLIST.map(track => {
    const trackStartMs = runMs;
    const trackEndMs = trackStartMs + ((track.duration_seconds || 30) * 1000);
    runMs = trackEndMs;
    return {
      ...track,
      startMs: trackStartMs,
      endMs: trackEndMs
    };
  });
}

function getGlobalTimeState() {
  if (SCHEDULE_TIMELINE.length === 0) return null;

  const nowMs = Date.now();
  let totalDurationMs = 0;
  PLAYLIST.forEach(t => { totalDurationMs += ((t.duration_seconds || 30) * 1000); });
  if (totalDurationMs === 0) return null;

  const baseAnchorMs = new Date(BASE_ANCHOR_DATE).getTime();
  const currentLoopCycleMs = (nowMs - baseAnchorMs) % totalDurationMs;
  const targetVirtualTimeMs = baseAnchorMs + currentLoopCycleMs;

  let item = null;
  let seekPosition = 0;
  let itemIndex = 0;

  for (let i = 0; i < SCHEDULE_TIMELINE.length; i++) {
    const track = SCHEDULE_TIMELINE[i];
    if (targetVirtualTimeMs >= track.startMs && targetVirtualTimeMs < track.endMs) {
      item = track;
      seekPosition = (targetVirtualTimeMs - track.startMs) / 1000;
      itemIndex = i;
      break;
    }
  }

  if (!item && SCHEDULE_TIMELINE.length > 0) {
    item = SCHEDULE_TIMELINE[0];
    seekPosition = 0;
    itemIndex = 0;
  }

  if (!item) return null;

  return { item, seekPosition, calculatedStartTime: item.startMs, itemIndex };
}

async function fetchPlaylistUpdates() {
  if (document.hidden) return;
  try {
    const tStamp = Date.now();
    const res = await fetch(`${PLAYLIST_JSON_URL}?cb=${tStamp}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" }
    });
    if (!res.ok) throw new Error("Sync drop");

    const freshData = await res.json();
    const d1 = normalizePlaylistForCompare(freshData);
    const d2 = normalizePlaylistForCompare(PLAYLIST);

    if (d1 !== d2) {
      PLAYLIST = freshData;
      generateAbsoluteTimeline();
      if (globalConfig && document.getElementById(globalConfig.scheduleListId)) {
        renderPlaylistUI(document.getElementById(globalConfig.scheduleListId));
      }
    }
  } catch (err) {
    console.error("Refresh log error:", err);
  }
}

function loadMediaSource(item, seekPosition) {
  if (!globalConfig) return;
  const videoElem = document.getElementById(globalConfig.videoId);
  const loaderEl = document.getElementById(globalConfig.loaderId);
  if (loaderEl) loaderEl.classList.remove("hidden");

  const formatType = (item.type || '').toLowerCase();

  const applyPlayback = () => {
    if (Number.isFinite(seekPosition) && seekPosition >= 0) {
      videoElem.currentTime = seekPosition;
    }
    videoElem.play().then(() => {
      if (loaderEl) loaderEl.classList.add("hidden");
    }).catch(() => {
      videoElem.muted = true;
      videoElem.play().catch(() => {});
      if (loaderEl) loaderEl.classList.add("hidden");
    });
  };

  if (formatType === 'm3u8' || formatType === 'hls') {
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }
      hlsInstance = new Hls({ enableWorker: true, lowLatencyMode: true });
      hlsInstance.attachMedia(videoElem);
      hlsInstance.loadSource(item.url);
      hlsInstance.once('hlsManifestParsed', applyPlayback);
    } else if (videoElem.canPlayType('application/vnd.apple.mpegurl')) {
      videoElem.src = item.url;
      videoElem.addEventListener('loadedmetadata', applyPlayback, { once: true });
    }
  } else {
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
    videoElem.src = item.url;
    videoElem.addEventListener('loadedmetadata', applyPlayback, { once: true });
  }
}

function initPlayer(config) {
  globalConfig = config;
  const videoElem = document.getElementById(config.videoId);
  const container = document.getElementById(config.videoContainerId);
  
  // Locate controls container explicitly or via DOM fallback
  const controlsOverlay = document.getElementById('controlsOverlay') || 
                          (container ? container.querySelector('.controls-overlay, .ui-controls, #controls') : null) || 
                          container;

  const btnPlay = document.getElementById(config.btnPlayId);
  const btnMute = document.getElementById(config.btnMuteId);
  const btnFullscreen = document.getElementById(config.btnFullscreenId);
  const debugElem = document.getElementById(config.nowPlayingOverlayId);
  const nowTitleElem = document.getElementById(config.nowTitleId);

  // Flexible icon targeting for Play button
  const iconPlay = btnPlay ? (btnPlay.querySelector('.icon-play') || btnPlay.children[0]) : null;
  const iconPause = btnPlay ? (btnPlay.querySelector('.icon-pause') || btnPlay.children[1]) : null;

  // Flexible icon targeting for Mute button
  const iconMuted = btnMute ? (btnMute.querySelector('.icon-muted') || btnMute.children[0]) : null;
  const iconUnmuted = btnMute ? (btnMute.querySelector('.icon-unmuted') || btnMute.children[1]) : null;

  // --- Controls Visibility Logic ---
  function showControls() {
    if (controlsOverlay) controlsOverlay.classList.remove('ui-hidden');
    if (container && container !== controlsOverlay) container.classList.remove('ui-hidden');

    clearTimeout(uiHideTimer);
    uiHideTimer = setTimeout(() => {
      if (videoElem && !videoElem.paused) {
        if (controlsOverlay) controlsOverlay.classList.add('ui-hidden');
      }
    }, UI_HIDE_TIMEOUT_MS);
  }

  if (container) {
    container.addEventListener('mousemove', showControls);
    container.addEventListener('click', showControls);
    container.addEventListener('touchstart', showControls, { passive: true });
    container.addEventListener('pointerdown', showControls, { passive: true });
    container.addEventListener('pointermove', showControls, { passive: true });
  }
  document.addEventListener('mousemove', showControls);
  document.addEventListener('pointerdown', showControls, { passive: true });
  showControls();

  // --- Clock Component ---
  if (config.showClock) {
    setInterval(() => {
      const now = new Date();
      const clockEl = document.getElementById(config.clockId);
      const clockDateEl = document.getElementById(config.clockDateId);
      if (clockEl) clockEl.textContent = now.toLocaleTimeString();
      if (clockDateEl) clockDateEl.textContent = now.toLocaleDateString();
    }, 1000);
  }

  // --- Play/Pause Button Listener ---
  if (btnPlay) {
    btnPlay.addEventListener('click', (e) => {
      e.stopPropagation();
      if (videoElem.paused) {
        videoElem.play();
        if (iconPlay) iconPlay.style.display = 'none';
        if (iconPause) iconPause.style.display = 'block';
      } else {
        videoElem.pause();
        if (iconPlay) iconPlay.style.display = 'block';
        if (iconPause) iconPause.style.display = 'none';
      }
    });
  }

  // --- Mute/Unmute Button Listener ---
  if (btnMute) {
    btnMute.addEventListener('click', (e) => {
      e.stopPropagation();
      videoElem.muted = !videoElem.muted;
      if (videoElem.muted) {
        if (iconMuted) iconMuted.style.display = 'block';
        if (iconUnmuted) iconUnmuted.style.display = 'none';
      } else {
        if (iconMuted) iconMuted.style.display = 'none';
        if (iconUnmuted) iconUnmuted.style.display = 'block';
      }
    });
  }

  // --- Fullscreen Listener ---
  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = container || videoElem;
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (target.requestFullscreen) target.requestFullscreen();
        else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
        else if (videoElem.webkitEnterFullscreen) videoElem.webkitEnterFullscreen();
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      }
    });
  }

  // --- Sync Engine ---
  function syncEngine() {
    if (document.hidden) return;

    const state = getGlobalTimeState();
    if (!state) return;

    const { item, seekPosition, calculatedStartTime, itemIndex } = state;
    const displayName = item.name ? item.name : `Video ${itemIndex + 1}`;

    if (debugElem) debugElem.textContent = `Now Playing : ${displayName}`;
    if (nowTitleElem) nowTitleElem.textContent = displayName;

    if (!currentItem || currentItem.url !== item.url) {
      currentItem = item;
      currentItemIndex = itemIndex;
      currentItemStartTime = calculatedStartTime;
      loadMediaSource(item, seekPosition);
      updateUIHighlighter(itemIndex);
      return;
    }

    const itemType = (item.type || '').toLowerCase();
    if (itemType === 'mp4' || itemType === 'm3u8' || itemType === 'hls') {
      const drift = Math.abs(videoElem.currentTime - seekPosition);
      if (drift > MAX_ALLOWED_DRIFT_SEC) {
        videoElem.currentTime = seekPosition;
      }

      if (videoElem.paused && iconPlay && iconPlay.style.display === 'none') {
        videoElem.play().catch(() => {});
      }
    }
  }

  setInterval(syncEngine, SYNC_CHECK_INTERVAL_MS);
  setInterval(fetchPlaylistUpdates, 15000);

  videoElem.addEventListener('seeking', () => {
    const state = getGlobalTimeState();
    if (state) {
      const itemType = (state.item.type || '').toLowerCase();
      if (itemType === 'mp4' || itemType === 'm3u8' || itemType === 'hls') {
        const drift = Math.abs(videoElem.currentTime - state.seekPosition);
        if (drift > MAX_ALLOWED_DRIFT_SEC) {
          videoElem.currentTime = state.seekPosition;
        }
      }
    }
  });

  fetchPlaylistUpdates().then(() => {
    syncEngine();
  });
}

function renderPlaylistUI(container) {
  if (!container) return;
  container.innerHTML = "";
  SCHEDULE_TIMELINE.forEach((track, index) => {
    const div = document.createElement("div");
    div.className = "schedule-item";
    div.id = `track-${index}`;
    const clk = new Date(track.startMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `Slot [${clk}]: <b>${track.name}</b> (${track.duration_seconds}s)`;
    container.appendChild(div);
  });
}

function updateUIHighlighter(activeIndex) {
  const items = document.querySelectorAll(".schedule-item");
  items.forEach(el => el.classList.remove("active"));
  const activeEl = document.getElementById(`track-${activeIndex}`);
  if (activeEl) activeEl.classList.add("active");
}
