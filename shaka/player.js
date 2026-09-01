let PLAYLIST = [];
let SCHEDULE_TIMELINE = [];
let hlsInstance = null;
let currentTrack = null;
let globalConfig = null;
let uiTimeout = null;
let isInternalSeeking = false;
let isSwitchingTrack = false;
let autoRecoveryAttempts = 0;

const PLAYLIST_JSON_URL = "./playlist.json"; 
const BASE_ANCHOR_DATE = "2026-01-01T00:00:00Z";

async function fetchPlaylistUpdates() {
  try {
    const tStamp = Date.now();
    const res = await fetch(`${PLAYLIST_JSON_URL}?t=${tStamp}`);
    if (!res.ok) throw new Error("Sync drop");
    
    const freshData = await res.json();
    const d1 = JSON.stringify(freshData);
    const d2 = JSON.stringify(PLAYLIST);
    
    if (d1 !== d2) {
      PLAYLIST = freshData;
      generateAbsoluteTimeline();
      
      // If URLs were added/removed, force re-sync immediately without triggering error screen
      if (currentTrack) {
        const trackStillExists = PLAYLIST.some(t => t.url === currentTrack.url);
        if (!trackStillExists) {
          currentTrack = null; // Force media reload to new valid slot
        }
      }

      const conf = globalConfig;
      if (conf && document.getElementById(conf.scheduleListId)) {
        renderPlaylistUI(document.getElementById(conf.scheduleListId));
        showNotificationToast(document.getElementById(conf.updateToastId));
      }

      // Re-evaluate current slot dynamically after playlist array structural mutation
      calculateLiveSyncState();
    }
  } catch (err) {
    console.error("Refresh log error:", err);
  }
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

function calculateLiveSyncState() {
  if (SCHEDULE_TIMELINE.length === 0 || isSwitchingTrack) return;

  const nowMs = Date.now();
  let totalDurationMs = 0;
  PLAYLIST.forEach(t => {
    totalDurationMs += ((t.duration_seconds || 30) * 1000);
  });

  if (totalDurationMs === 0) return;

  const baseAnchorMs = new Date(BASE_ANCHOR_DATE).getTime();
  const currentLoopCycleMs = (nowMs - baseAnchorMs) % totalDurationMs;
  const targetVirtualTimeMs = baseAnchorMs + currentLoopCycleMs;

  let activeTrack = null;
  let trackSeekOffset = 0;
  let activeIndex = 0;

  for (let i = 0; i < SCHEDULE_TIMELINE.length; i++) {
    const track = SCHEDULE_TIMELINE[i];
    if (targetVirtualTimeMs >= track.startMs && targetVirtualTimeMs < track.endMs) {
      activeTrack = track;
      trackSeekOffset = (targetVirtualTimeMs - track.startMs) / 1000;
      activeIndex = i;
      break;
    }
  }

  // Fallback to first track if bounds calculation fails due to URL additions/deletions
  if (!activeTrack && SCHEDULE_TIMELINE.length > 0) {
    activeTrack = SCHEDULE_TIMELINE[0];
    trackSeekOffset = 0;
    activeIndex = 0;
  }

  if (!activeTrack) return;

  updateUIHighlighter(activeIndex);

  const video = globalConfig ? document.getElementById(globalConfig.videoId) : null;
  const nowTitle = globalConfig ? document.getElementById(globalConfig.nowTitleId) : null;
  const nowPlayingOverlay = globalConfig ? document.getElementById(globalConfig.nowPlayingOverlayId) : null;
  const syncToast = globalConfig ? document.getElementById(globalConfig.syncToastId) : null;
  const statusText = globalConfig ? document.getElementById(globalConfig.statusTextId) : null;
  const statusOffset = globalConfig ? document.getElementById(globalConfig.statusOffsetId) : null;

  // Seamless track switch trigger
  if (!currentTrack || currentTrack.url !== activeTrack.url) {
    currentTrack = activeTrack;
    if (nowTitle) nowTitle.innerText = `Playing Now: ${currentTrack.name}`;
    if (nowPlayingOverlay) nowPlayingOverlay.innerText = `Now Playing : ${currentTrack.name}`;
    
    loadMediaSeamless(currentTrack, trackSeekOffset);
  } else if (video) {
    // Smooth time sync
    if (video.readyState >= 2 && !video.seeking && !isInternalSeeking) {
      const delta = Math.abs(video.currentTime - trackSeekOffset);
      if (delta > 8) {
        isInternalSeeking = true;
        video.currentTime = trackSeekOffset;
        showNotificationToast(syncToast);
        setTimeout(() => { isInternalSeeking = false; }, 600);
      }
    }
  }
  
  if (statusText && activeTrack.type) {
    statusText.innerText = `Mode: Timeline Engine (${activeTrack.type.toUpperCase()})`;
  }
  if (statusOffset && video) {
    statusOffset.innerText = `Sync: ${Math.floor(video.currentTime || 0)}s / ${activeTrack.duration_seconds}s`;
  }
}

function loadMediaSeamless(track, offset) {
  if (!globalConfig) return;
  
  isSwitchingTrack = true;
  const video = document.getElementById(globalConfig.videoId);
  const loaderEl = document.getElementById(globalConfig.loaderId);
  const errorEl = document.getElementById(globalConfig.errorId);
  
  if (loaderEl) loaderEl.classList.remove("hidden");
  // Automatically hide error banner on new load attempt
  if (errorEl) errorEl.classList.remove("show");

  const isAlreadyPlaying = !video.paused;
  const formatType = (track.type || '').toLowerCase();

  // Replace executeSeamlessPlay inside player.js -> loadMediaSeamless

const executeSeamlessPlay = () => {
  isInternalSeeking = true;
  video.currentTime = offset;

  const playPromise = video.play();
  if (playPromise !== undefined) {
    playPromise
      .then(() => {
        if (loaderEl) loaderEl.classList.add("hidden");
        if (errorEl) errorEl.classList.remove("show");
        autoRecoveryAttempts = 0;
      })
      .catch((err) => {
        // Intercept play/pause interrupts silently without breaking player execution
        if (err.name === 'AbortError' || err.message.includes('interrupted')) {
          console.warn("Play request safely interrupted for source switch.");
        } else {
          handleAutoplayBlock();
        }
      });
  }

  setTimeout(() => { 
    isInternalSeeking = false; 
    isSwitchingTrack = false;
  }, 500);
};

    setTimeout(() => { 
      isInternalSeeking = false; 
      isSwitchingTrack = false;
    }, 500);
  };

  if ((formatType === 'm3u8' || formatType === 'hls') && typeof Hls !== 'undefined' && Hls.isSupported()) {
    if (!hlsInstance) {
      hlsInstance = new Hls({
        liveSyncDurationCount: 3,
        maxBufferLength: 30,
        enableWorker: true,
        lowLatencyMode: true
      });
      hlsInstance.attachMedia(video);
    } else {
      hlsInstance.stopLoad();
    }

    const manifestParsedEvent = Hls.Events ? Hls.Events.MANIFEST_PARSED : 'hlsManifestParsed';
    
    hlsInstance.loadSource(track.url);
    hlsInstance.once(manifestParsedEvent, () => {
      executeSeamlessPlay();
    });

  } else {
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }

    video.src = track.url;
    video.addEventListener('loadedmetadata', () => {
      executeSeamlessPlay();
    }, { once: true });
  }
}

function initPlayer(config) {
  globalConfig = config;

  const urlParams = new URLSearchParams(window.location.search);
  const mode = urlParams.get('mode') || 'private';
  
  if (mode === 'public') {
    document.body.classList.add('public-mode');
  }

  const container = document.getElementById(config.videoContainerId);
  const video = document.getElementById(config.videoId);

  function triggerUIReveal() {
    container.classList.add('show-ui');
    clearTimeout(uiTimeout);
    uiTimeout = setTimeout(() => {
      if (!video.paused) {
        container.classList.remove('show-ui');
      }
    }, 3500);
  }
  
  container.addEventListener('mousemove', triggerUIReveal);
  container.addEventListener('click', triggerUIReveal);
  container.addEventListener('touchstart', triggerUIReveal, { passive: true });
  
  setInterval(fetchPlaylistUpdates, 15000);

  fetchPlaylistUpdates().then(() => {
    const btnPlay = document.getElementById(config.btnPlayId);
    const btnMute = document.getElementById(config.btnMuteId);
    const btnFullscreen = document.getElementById(config.btnFullscreenId);

    if (config.showClock) {
      setInterval(() => {
        const elClock = document.getElementById(config.clockId);
        const elDate = document.getElementById(config.clockDateId);
        if (elClock) elClock.innerText = new Date().toLocaleTimeString();
        if (elDate) elDate.innerText = new Date().toLocaleDateString();
      }, 1000);
    }

    // Auto-advance seamlessly when a discrete video track ends naturally
    video.addEventListener("ended", () => {
      calculateLiveSyncState();
    });

    // Auto-Recovery Error Interceptor
    video.addEventListener("error", (e) => {
      // Ignore temporary errors caused while actively swapping media sources
      if (isSwitchingTrack) return;

      console.warn("Media error caught. Attempting silent recovery...", e);
      
      const errorEl = document.getElementById(config.errorId);
      
      // Try to recover automatically up to 3 times before displaying error banner
      if (autoRecoveryAttempts < 3) {
        autoRecoveryAttempts++;
        if (errorEl) errorEl.classList.remove("show");
        
        setTimeout(() => {
          currentTrack = null; // Clear cached track to trigger a fresh rebuild
          calculateLiveSyncState();
        }, 1000);
      } else {
        // Display error banner only if multiple recovery attempts fail completely
        if (errorEl) errorEl.classList.add("show");
      }
    });

    function handlePlayToggle(e) {
      e.preventDefault();
      e.stopPropagation();
      if (video.paused) { 
        calculateLiveSyncState(); 
        video.play(); 
      } else { 
        video.pause(); 
      }
    }

    function handleMuteToggle(e) {
      e.preventDefault();
      e.stopPropagation();
      video.muted = !video.muted;
      btnMute.innerText = video.muted ? "🔇" : "🔊";
      if (!video.muted && video.volume === 0) { 
        video.volume = 0.8; 
      }
    }

    function handleFullscreenToggle(e) {
      e.preventDefault();
      e.stopPropagation();
      if (!document.fullscreenElement) {
        container.requestFullscreen().catch(err => console.error(err));
      } else {
        document.exitFullscreen();
      }
    }

    btnPlay.addEventListener("click", handlePlayToggle);
    btnPlay.addEventListener("touchstart", handlePlayToggle);

    btnMute.addEventListener("click", handleMuteToggle);
    btnMute.addEventListener("touchstart", handleMuteToggle);

    btnFullscreen.addEventListener("click", handleFullscreenToggle);
    btnFullscreen.addEventListener("touchstart", handleFullscreenToggle);

    video.addEventListener("play", () => { btnPlay.innerText = "⏸"; });
    video.addEventListener("pause", () => { 
      btnPlay.innerText = "▶"; 
      if (!isSwitchingTrack) container.classList.add('show-ui'); 
    });
    
    video.addEventListener("playing", () => {
      const loaderEl = document.getElementById(config.loaderId);
      const errorEl = document.getElementById(config.errorId);
      if (loaderEl) loaderEl.classList.add("hidden");
      if (errorEl) errorEl.classList.remove("show");
    });
    
    video.addEventListener("waiting", () => {
      if (!isSwitchingTrack) {
        const loaderEl = document.getElementById(config.loaderId);
        if (loaderEl) loaderEl.classList.remove("hidden");
      }
    });

    setInterval(calculateLiveSyncState, 1000);
    calculateLiveSyncState();
    triggerUIReveal();
  });
}

function handleAutoplayBlock() {
  if (!globalConfig) return;
  const video = document.getElementById(globalConfig.videoId);
  const btnMute = document.getElementById(globalConfig.btnMuteId);
  if (video) {
    video.muted = true;
    if (btnMute) btnMute.innerText = "🔇";
    video.play().catch(e => console.warn("Autoplay manual intervention needed:", e));
  }
}

function renderPlaylistUI(container) {
  if (!container) return;
  container.innerHTML = "";
  
  SCHEDULE_TIMELINE.forEach((track, index) => {
    const div = document.createElement("div");
    div.className = "schedule-item";
    div.id = `track-${index}`;
      
    const clk = new Date(track.startMs).toLocaleTimeString([], {
      hour: '2-digit', 
      minute:'2-digit'
    });
    
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

function showNotificationToast(el) {
  if (!el || document.body.classList.contains('public-mode')) return;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}
