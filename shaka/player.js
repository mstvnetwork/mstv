let PLAYLIST = [];
let SCHEDULE_TIMELINE = [];
let hlsInstance = null;
let currentTrack = null;
let globalConfig = null;
let uiTimeout = null;

const PLAYLIST_JSON_URL = "./playlist.json"; 
const BASE_ANCHOR_DATE = "2026-01-01T00:00:00Z";

async function fetchPlaylistUpdates() {
  try {
    const tStamp = Date.now();
    const res = await fetch(
      `${PLAYLIST_JSON_URL}?t=${tStamp}`
    );
    if (!res.ok) throw new Error("Sync drop");
    
    const freshData = await res.json();
    const d1 = JSON.stringify(freshData);
    const d2 = JSON.stringify(PLAYLIST);
    
    if (d1 !== d2) {
      PLAYLIST = freshData;
      generateAbsoluteTimeline();
      
      const conf = globalConfig;
      if (conf && document.getElementById(
        conf.scheduleListId
      )) {
        renderPlaylistUI(
          document.getElementById(conf.scheduleListId)
        );
        showNotificationToast(
          document.getElementById(conf.updateToastId)
        );
      }
    }
  } catch (err) {
    console.error("Refresh log error:", err);
  }
}

function generateAbsoluteTimeline() {
  let runMs = new Date(BASE_ANCHOR_DATE).getTime();
  SCHEDULE_TIMELINE = PLAYLIST.map(track => {
    const trackStartMs = runMs;
    const trackEndMs = trackStartMs + (
      track.duration_seconds * 1000
    );
    runMs = trackEndMs;
    return { 
      ...track, 
      startMs: trackStartMs, 
      endMs: trackEndMs 
    };
  });
}

function initPlayer(config) {
  globalConfig = config;

  const urlParams = new URLSearchParams(
    window.location.search
  );
  const mode = urlParams.get('mode') || 'private';
  
  if (mode === 'public') {
    document.body.classList.add('public-mode');
  }

  const container = document.getElementById(
    config.videoContainerId
  );
  
  function triggerUIReveal() {
    container.classList.add('show-ui');
    clearTimeout(uiTimeout);
    uiTimeout = setTimeout(() => {
      const video = document.getElementById(
        config.videoId
      );
      if (!video.paused) {
        container.classList.remove('show-ui');
      }
    }, 3000);
  }
  
  container.addEventListener('mousemove', triggerUIReveal);
  container.addEventListener('click', triggerUIReveal);
  
  setInterval(fetchPlaylistUpdates, 30000);

  fetchPlaylistUpdates().then(() => {
    const video = document.getElementById(
      config.videoId
    );
    const progressFill = document.getElementById(
      config.progressFillId
    );
    const syncToast = document.getElementById(
      config.syncToastId
    );
    const nowTitle = document.getElementById(
      config.nowTitleId
    );
    const nowPlayingOverlay = document.getElementById(
      config.nowPlayingOverlayId
    );
    const statusText = document.getElementById(
      config.statusTextId
    );
    const statusOffset = document.getElementById(
      config.statusOffsetId
    );
    const btnPlay = document.getElementById(
      config.btnPlayId
    );
    const btnMute = document.getElementById(
      config.btnMuteId
    );
    const volSlider = document.getElementById(
      config.volSliderId
    );
    const btnFullscreen = document.getElementById(
      config.btnFullscreenId
    );

    if (config.showClock) {
      setInterval(() => {
        const elClock = document.getElementById(
          config.clockId
        );
        const elDate = document.getElementById(
          config.clockDateId
        );
        if(elClock) {
          elClock.innerText = 
            new Date().toLocaleTimeString();
        }
        if(elDate) {
          elDate.innerText = 
            new Date().toLocaleDateString();
        }
      }, 1000);
    }

    function calculateLiveSyncState() {
      if (SCHEDULE_TIMELINE.length === 0) return;

      const nowMs = Date.now();
      let totalDurationMs = 0;
      PLAYLIST.forEach(t => {
        totalDurationMs += (
          t.duration_seconds * 1000
        );
      });

      const baseAnchorMs = new Date(
        BASE_ANCHOR_DATE
      ).getTime();
      const currentLoopCycleMs = (
        nowMs - baseAnchorMs
      ) % totalDurationMs;
      const targetVirtualTimeMs = (
        baseAnchorMs + currentLoopCycleMs
      );

      let activeTrack = null;
      let trackSeekOffset = 0;
      let activeIndex = 0;

      for (let i = 0; i < SCHEDULE_TIMELINE.length; i++) {
        const track = SCHEDULE_TIMELINE[i];
        if (targetVirtualTimeMs >= track.startMs && 
            targetVirtualTimeMs < track.endMs) {
          activeTrack = track;
          trackSeekOffset = (
            targetVirtualTimeMs - track.startMs
          ) / 1000;
          activeIndex = i;
          break;
        }
      }

      if (!activeTrack) return;

      updateUIHighlighter(activeIndex);

      if (!currentTrack || 
          currentTrack.url !== activeTrack.url) {
        currentTrack = activeTrack;
        if(nowTitle) {
          nowTitle.innerText = 
            `Playing Now: ${currentTrack.name}`;
        }
        if(nowPlayingOverlay) {
          nowPlayingOverlay.innerText = 
            `Now Playing: ${currentTrack.name}`;
        }
        loadMedia(currentTrack, trackSeekOffset);
      } else {
        const delta = Math.abs(
          video.currentTime - trackSeekOffset
        );
        if (delta > 4) {
          video.currentTime = trackSeekOffset;
          showNotificationToast(syncToast);
        }
      }

      const pct = (
        video.currentTime / 
        activeTrack.duration_seconds
      ) * 100 || 0;
      progressFill.style.width = `${pct}%`;
      
      if(statusText) {
        statusText.innerText = 
          `Mode: Timeline Engine (${
            activeTrack.type.toUpperCase()
          })`;
      }
      if(statusOffset) {
        statusOffset.innerText = 
          `Sync: ${
            Math.floor(video.currentTime)
          }s / ${activeTrack.duration_seconds}s`;
      }
    }

    function loadMedia(track, offset) {
      document.getElementById(
        config.loaderId
      ).classList.remove("hidden");
      document.getElementById(
        config.errorId
      ).classList.remove("show");

      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }

      const formatType = track.type.toLowerCase();

      if (formatType === 'm3u8' || 
          formatType === 'hls') {
        if (Hls.isSupported()) {
          hlsInstance = new Hls();
          hlsInstance.loadSource(track.url);
          hlsInstance.attachMedia(video);
          hlsInstance.on(
            Hls.Events.MANIFEST_PARSED, 
            () => {
              video.currentTime = offset;
              video.play().catch(handleAutoplayBlock);
            }
          );
        } else if (video.canPlayType(
          'application/vnd.apple.mpegurl'
        )) {
          video.src = track.url;
          video.addEventListener(
            'loadedmetadata', 
            () => {
              video.currentTime = offset;
              video.play().catch(handleAutoplayBlock);
            }, 
            { once: true }
          );
        }
      } else {
        video.src = track.url;
        video.addEventListener(
          'loadedmetadata', 
          () => {
            video.currentTime = offset;
            video.play().catch(handleAutoplayBlock);
          }, 
          { once: true }
        );
      }
    }

    btnPlay.addEventListener("click", (e) => {
      e.stopPropagation();
      if (video.paused) { 
        calculateLiveSyncState(); 
        video.play(); 
      } else { 
        video.pause(); 
      }
    });

    btnMute.addEventListener("click", (e) => {
      e.stopPropagation();
      video.muted = !video.muted;
      if (video.muted) {
        btnMute.innerText = "🔇";
        volSlider.value = 0;
      } else {
        btnMute.innerText = "🔊";
        volSlider.value = video.volume || 0.8;
        if(video.volume === 0) { 
          video.volume = 0.8; 
          volSlider.value = 0.8; 
        }
      }
    });

    volSlider.addEventListener("input", (e) => {
      video.volume = e.target.value;
      video.muted = (video.volume == 0);
      btnMute.innerText = video.muted ? "🔇" : "🔊";
    });

    btnFullscreen.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!document.fullscreenElement) {
        container.requestFullscreen().catch(
          err => console.error(err)
        );
        btnFullscreen.innerText = "⛶"; 
      } else {
        document.exitFullscreen();
        btnFullscreen.innerText = "⛶";
      }
    });

    video.addEventListener(
      "play", 
      () => btnPlay.innerText = "⏸"
    );
    video.addEventListener("pause", () => { 
      btnPlay.innerText = "▶"; 
      container.classList.add('show-ui'); 
    });
    video.addEventListener("playing", () => {
      document.getElementById(
        config.loaderId
      ).classList.add("hidden");
    });
    video.addEventListener("waiting", () => {
      document.getElementById(
        config.loaderId
      ).classList.remove("hidden");
    });
    video.addEventListener("error", () => {
      document.getElementById(
        config.errorId
      ).classList.add("show");
    });

    function handleAutoplayBlock() {
      video.muted = true;
      btnMute.innerText = "🔇";
      volSlider.value = 0;
      video.play();
    }

    setInterval(calculateLiveSyncState, 2000);
    calculateLiveSyncState();
    triggerUIReveal();
  });
}

function renderPlaylistUI(
  container
) {
  if (!container) return;
  container.innerHTML = "";
  SCHEDULE_TIMELINE.forEach(
    (track, index) => {
      const div = 
        document.createElement(
          "div"
        );
      div.className = 
        "schedule-item";
      div.id = `track-${index}`;
      const clk = new Date(
        track.startMs
      ).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });
      div.innerHTML = 
        `Slot [${clk}]: <b>${
          track.name
        }</b> (${
          track.duration_seconds
        }s)`;
      container.appendChild(div);
    }
  );
}

function updateUIHighlighter(
  activeIndex
) {
  document.querySelectorAll(
    ".schedule-item"
  ).forEach(el => 
    el.classList.remove("active")
  );
  const activeEl = 
    document.getElementById(
      `track-${activeIndex}`
    );
  if (activeEl) {
    activeEl.classList.add(
      "active"
    );
  }
}

function showNotificationToast(
  el
) {
  if (!el) return;
  el.classList.add("show");
  setTimeout(() => {
    el.classList.remove("show");
  }, 2500);
}
