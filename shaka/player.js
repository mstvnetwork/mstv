let PLAYLIST = [];
let SCHEDULE_TIMELINE = [];
let hlsInstance = null;
let currentTrack = null;
let globalConfig = null;
let uiTimeout = null;
let isInternalSeeking = false;
let isSwitchingTrack = false;
let isMediaLoading = false;
let autoRecoveryAttempts = 0;

const PLAYLIST_JSON_URL = "./playlist.json";
const BASE_ANCHOR_DATE = "2026-01-01T00:00:00Z";

const MAX_ALLOWED_DRIFT_SEC = 0.5; // Relaxed slightly to prevent constant micro-adjustments
const SYNC_CHECK_INTERVAL_MS = 1000;
const MAX_CORRECTION_JUMP_SEC = 120;

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

async function fetchPlaylistUpdates() {
  if (document.hidden) return;

  try {
    const tStamp = Date.now();
    const res = await fetch(`${PLAYLIST_JSON_URL}?cb=${tStamp}`, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      }
    });

    if (!res.ok) throw new Error("Sync drop");

    const freshData = await res.json();
    const d1 = normalizePlaylistForCompare(freshData);
    const d2 = normalizePlaylistForCompare(PLAYLIST);

    if (d1 !== d2) {
      const conf = globalConfig;
      PLAYLIST = freshData;
      generateAbsoluteTimeline();

      if (conf && document.getElementById(conf.scheduleListId)) {
        renderPlaylistUI(document.getElementById(conf.scheduleListId));
        showNotificationToast(document.getElementById(conf.updateToastId));
      }

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

function computeLiveTarget() {
  if (SCHEDULE_TIMELINE.length === 0) return null;

  const nowMs = Date.now();
  let totalDurationMs = 0;
  PLAYLIST.forEach(t => {
    totalDurationMs += ((t.duration_seconds || 30) * 1000);
  });

  if (totalDurationMs === 0) return null;

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

  if (!activeTrack && SCHEDULE_TIMELINE.length > 0) {
    activeTrack = SCHEDULE_TIMELINE[0];
    trackSeekOffset = 0;
    activeIndex = 0;
  }

  if (!activeTrack) return null;

  return { activeTrack, trackSeekOffset, activeIndex };
}

function calculateLiveSyncState() {
  if (document.hidden || SCHEDULE_TIMELINE.length === 0 || isSwitchingTrack || isMediaLoading) return;

  const video = globalConfig ? document.getElementById(globalConfig.videoId) : null;
  const target = computeLiveTarget();
  if (!target) return;

  const { activeTrack, trackSeekOffset, activeIndex } = target;

  const nowTitle = globalConfig ? document.getElementById(globalConfig.nowTitleId) : null;
  const nowPlayingOverlay = globalConfig ? document.getElementById(globalConfig.nowPlayingOverlayId) : null;
  const syncToast = globalConfig ? document.getElementById(globalConfig.syncToastId) : null;
  const statusText = globalConfig ? document.getElementById(globalConfig.statusTextId) : null;
  const statusOffset = globalConfig ? document.getElementById(globalConfig.statusOffsetId) : null;

  // Case 1: Same track currently playing
  if (currentTrack && currentTrack.url === activeTrack.url) {
    if (video && video.readyState >= 2 && !video.seeking && !isInternalSeeking) {
      const delta = trackSeekOffset - video.currentTime;
      const absDelta = Math.abs(delta);

      if (absDelta > 15 && absDelta <= MAX_CORRECTION_JUMP_SEC) {
        isInternalSeeking = true;
        video.currentTime = trackSeekOffset;
        showNotificationToast(syncToast);
        setTimeout(() => { isInternalSeeking = false; }, 800);
      }
    }

    updateUIHighlighter(activeIndex);
    if (statusText && activeTrack.type) {
      statusText.innerText = `Mode: Timeline Engine (${activeTrack.type.toUpperCase()})`;
    }
    if (statusOffset && video) {
      statusOffset.innerText = `Sync: ${Math.floor(video.currentTime || 0)}s / ${activeTrack.duration_seconds}s`;
    }
    return;
  }

  // Case 2: Schedule target moved to another track slot
  const stillActivelyPlayingSomething = video && !video.paused && !video.ended && currentTrack;

  if (stillActivelyPlayingSomething) {
    const currentTrackStillInSchedule = SCHEDULE_TIMELINE.some(t => t.url === currentTrack.url);
    if (currentTrackStillInSchedule) {
      const idx = SCHEDULE_TIMELINE.findIndex(t => t.url === currentTrack.url);
      updateUIHighlighter(idx >= 0 ? idx : activeIndex);
      return;
    }
  }

  currentTrack = activeTrack;
  if (nowTitle) nowTitle.innerText = `Playing Now: ${currentTrack.name}`;
  if (nowPlayingOverlay) nowPlayingOverlay.innerText = `Now Playing : ${currentTrack.name}`;

  updateUIHighlighter(activeIndex);
  loadMediaSeamless(currentTrack, trackSeekOffset);

  if (statusText && activeTrack.type) {
    statusText.innerText = `Mode: Timeline Engine (${activeTrack.type.toUpperCase()})`;
  }
}

function loadMediaSeamless(track, offset) {
  if (!globalConfig || isMediaLoading) return;

  const video = document.getElementById(globalConfig.videoId);

  if (video && video.currentSrc && track.url && video.currentSrc.indexOf(track.url) !== -1 &&
      !video.paused && !video.ended && video.readyState >= 2) {
    currentTrack = track;
    return;
  }

  isSwitchingTrack = true;
  isMediaLoading = true;

  const loaderEl = document.getElementById(globalConfig.loaderId);
  const errorEl = document.getElementById(globalConfig.errorId);

  // Keep loader hidden during soft track switches to prevent UI flash
  if (errorEl) errorEl.classList.remove("show");

  const formatType = (track.type || '').toLowerCase();

  const executeSeamlessPlay = () => {
    isInternalSeeking = true;

    if (Number.isFinite(offset) && offset >= 0) {
      video.currentTime = offset;
    }

    const playPromise = video.play();
    if (playPromise !== undefined) {
      playPromise.then(() => {
        if (loaderEl) loaderEl.classList.add("hidden");
        if (errorEl) errorEl.classList.remove("show");
        autoRecoveryAttempts = 0;
        isMediaLoading = false;
      }).catch(err => {
        isMediaLoading = false;
        if (err.name === 'AbortError' || err.message.includes('interrupted')) {
          console.warn("Play request safely interrupted for source switch.");
        } else {
          handleAutoplayBlock();
        }
      });
    } else {
      isMediaLoading = false;
    }

    setTimeout(() => {
      isInternalSeeking = false;
      isSwitchingTrack = false;
    }, 600);
  };

  if (formatType === 'm3u8' || formatType === 'hls') {
    if (typeof Hls === 'undefined') {
      if (loaderEl) loaderEl.classList.add("hidden");
      if (errorEl) errorEl.classList.add("show");
      isSwitchingTrack = false;
      isMediaLoading = false;
      return;
    }

    if (Hls.isSupported()) {
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }

      hlsInstance = new Hls({
        liveSyncDurationCount: 3,
        maxBufferLength: 30,
        enableWorker: true,
        lowLatencyMode: true
      });

      hlsInstance.attachMedia(video);
      const hlsErrorEvent = (Hls.Events && Hls.Events.ERROR) ? Hls.Events.ERROR : 'hlsError';

      hlsInstance.on(hlsErrorEvent, (event, data) => {
        if (data && data.fatal) {
          const netErr = Hls.ErrorTypes ? Hls.ErrorTypes.NETWORK_ERROR : 'networkError';
          const medErr = Hls.ErrorTypes ? Hls.ErrorTypes.MEDIA_ERROR : 'mediaError';

          switch (data.type) {
            case netErr:
              hlsInstance.startLoad();
              break;
            case medErr:
              hlsInstance.recoverMediaError();
              break;
            default:
              if (hlsInstance) {
                hlsInstance.destroy();
                hlsInstance = null;
              }
              isMediaLoading = false;
              break;
          }
        }
      });

      const manifestParsedEvent = (Hls.Events && Hls.Events.MANIFEST_PARSED) ? Hls.Events.MANIFEST_PARSED : 'hlsManifestParsed';
      hlsInstance.loadSource(track.url);
      hlsInstance.once(manifestParsedEvent, () => {
        executeSeamlessPlay();
      });

    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = track.url;
      video.addEventListener('loadedmetadata', () => {
        executeSeamlessPlay();
      }, { once: true });
    }
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

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      isMediaLoading = false;
      isSwitchingTrack = false;
      fetchPlaylistUpdates().then(() => {
        calculateLiveSyncState();
      });
    }
  });

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

    video.addEventListener("ended", () => {
      isMediaLoading = false;

      if (SCHEDULE_TIMELINE.length > 0) {
        const endedIndex = currentTrack
          ? SCHEDULE_TIMELINE.findIndex(t => t.url === currentTrack.url)
          : -1;
        const nextIndex = endedIndex >= 0
          ? (endedIndex + 1) % SCHEDULE_TIMELINE.length
          : 0;

        const nextTrack = SCHEDULE_TIMELINE[nextIndex];
        currentTrack = nextTrack;

        if (globalConfig) {
          const nowTitle = document.getElementById(globalConfig.nowTitleId);
          const nowPlayingOverlay = document.getElementById(globalConfig.nowPlayingOverlayId);
          if (nowTitle) nowTitle.innerText = `Playing Now: ${nextTrack.name}`;
          if (nowPlayingOverlay) nowPlayingOverlay.innerText = `Now Playing : ${nextTrack.name}`;
        }

        updateUIHighlighter(nextIndex);
        loadMediaSeamless(nextTrack, 0);
      } else {
        currentTrack = null;
        calculateLiveSyncState();
      }
    });

    video.addEventListener("error", (e) => {
      if (isSwitchingTrack || isMediaLoading) return;

      const errorEl = document.getElementById(config.errorId);

      if (autoRecoveryAttempts < 3) {
        autoRecoveryAttempts++;
        if (errorEl) errorEl.classList.remove("show");

        setTimeout(() => {
          currentTrack = null;
          isMediaLoading = false;
          calculateLiveSyncState();
        }, 1200);
      } else {
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
      if (btnMute) btnMute.innerText = video.muted ? "🔇" : "🔊";
      if (!video.muted && video.volume === 0) {
        video.volume = 0.8;
      }
    }

    async function handleFullscreenToggle(e) {
      e.preventDefault();
      e.stopPropagation();

      try {
        const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;

        if (!isFullscreen) {
          if (video.webkitEnterFullscreen && !container.requestFullscreen) {
            video.webkitEnterFullscreen();
            return;
          }

          if (container.requestFullscreen) {
            await container.requestFullscreen();
          } else if (container.webkitRequestFullscreen) {
            await container.webkitRequestFullscreen();
          }

          if (screen.orientation && screen.orientation.lock) {
            await screen.orientation.lock("landscape").catch(err => {
              console.warn("Orientation lock warning:", err);
            });
          }
        } else {
          if (document.exitFullscreen) {
            await document.exitFullscreen();
          } else if (document.webkitExitFullscreen) {
            await document.webkitExitFullscreen();
          }

          if (screen.orientation && screen.orientation.unlock) {
            screen.orientation.unlock();
          }
        }
      } catch (err) {
        console.error("Fullscreen toggle error:", err);
      }
    }

    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && screen.orientation && screen.orientation.unlock) {
        screen.orientation.unlock();
      }
    });

    if (btnPlay) {
      btnPlay.addEventListener("click", handlePlayToggle);
      btnPlay.addEventListener("touchstart", handlePlayToggle);
    }

    if (btnMute) {
      btnMute.addEventListener("click", handleMuteToggle);
      btnMute.addEventListener("touchstart", handleMuteToggle);
    }

    if (btnFullscreen) {
      btnFullscreen.addEventListener("click", handleFullscreenToggle);
      btnFullscreen.addEventListener("touchstart", handleFullscreenToggle);
    }

    video.addEventListener("play", () => {
      if (btnPlay) btnPlay.innerText = "⏸";
    });
    video.addEventListener("pause", () => {
      if (btnPlay) btnPlay.innerText = "▶";
      if (!isSwitchingTrack) container.classList.add('show-ui');
    });

    function getExactSeekPosition() {
      if (!currentTrack || SCHEDULE_TIMELINE.length === 0) return null;
      const liveTrack = SCHEDULE_TIMELINE.find(t => t.url === currentTrack.url);
      if (!liveTrack) return null;

      const nowMs = Date.now();
      const baseAnchorMs = new Date(BASE_ANCHOR_DATE).getTime();
      let totalDurationMs = 0;
      PLAYLIST.forEach(t => { totalDurationMs += ((t.duration_seconds || 30) * 1000); });
      if (totalDurationMs === 0) return null;

      const currentLoopCycleMs = (nowMs - baseAnchorMs) % totalDurationMs;
      const targetVirtualTimeMs = baseAnchorMs + currentLoopCycleMs;

      if (targetVirtualTimeMs >= liveTrack.startMs && targetVirtualTimeMs < liveTrack.endMs) {
        return (targetVirtualTimeMs - liveTrack.startMs) / 1000;
      }
      return null;
    }

    // Fixed: Throttled engine prevents rapid micro-seeks causing buffer flushes
    function syncEngine() {
      if (document.hidden || isSwitchingTrack || isMediaLoading || isInternalSeeking || video.seeking || !currentTrack) return;

      const itemType = (currentTrack.type || '').toLowerCase();
      if (itemType === 'mp4' || itemType === 'm3u8' || itemType === 'hls') {
        const seekPosition = getExactSeekPosition();
        if (seekPosition === null) return;

        const drift = seekPosition - video.currentTime;
        const absDrift = Math.abs(drift);

        if (absDrift > MAX_ALLOWED_DRIFT_SEC && absDrift <= MAX_CORRECTION_JUMP_SEC) {
          isInternalSeeking = true;
          video.currentTime = seekPosition;
          setTimeout(() => { isInternalSeeking = false; }, 500);
        }

        if (video.paused && btnPlay && btnPlay.innerText === "⏸") {
          video.play().catch(() => {});
        }
      }
    }
    setInterval(syncEngine, SYNC_CHECK_INTERVAL_MS);

    // Fixed: Guarded seeking event listener prevents recursive seek loops
    video.addEventListener('seeking', () => {
      if (!currentTrack || isInternalSeeking || isSwitchingTrack) return;
      const itemType = (currentTrack.type || '').toLowerCase();

      if (itemType === 'mp4' || itemType === 'm3u8' || itemType === 'hls') {
        const seekPosition = getExactSeekPosition();
        if (seekPosition === null) return;

        const drift = Math.abs(video.currentTime - seekPosition);
        if (drift > MAX_ALLOWED_DRIFT_SEC && drift <= MAX_CORRECTION_JUMP_SEC) {
          isInternalSeeking = true;
          video.currentTime = seekPosition;
          setTimeout(() => { isInternalSeeking = false; }, 500);
        }
      }
    });

    video.addEventListener("playing", () => {
      const loaderEl = document.getElementById(config.loaderId);
      const errorEl = document.getElementById(config.errorId);
      if (loaderEl) loaderEl.classList.add("hidden");
      if (errorEl) errorEl.classList.remove("show");
      isMediaLoading = false;
    });

    // Fixed: Suppress loading spinner during brief buffers/internal seeks
    video.addEventListener("waiting", () => {
      if (!isSwitchingTrack && !isMediaLoading && !isInternalSeeking) {
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
      minute: '2-digit'
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
