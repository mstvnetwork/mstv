function initPlayer(config) {
  globalConfig = config;
  const videoElem = document.getElementById(config.videoId);
  const container = document.getElementById(config.videoContainerId);
  const controlsOverlay = document.getElementById(config.controlsOverlayId || 'controlsOverlay') || container;
  
  const btnPlay = document.getElementById(config.btnPlayId);
  const btnMute = document.getElementById(config.btnMuteId);
  const btnFullscreen = document.getElementById(config.btnFullscreenId);
  const debugElem = document.getElementById(config.nowPlayingOverlayId);

  // Directly access icons or fall back to button targets
  const iconPlay = btnPlay ? (btnPlay.querySelector('.icon-play') || btnPlay) : null;
  const iconPause = btnPlay ? btnPlay.querySelector('.icon-pause') : null;
  const iconMuted = btnMute ? (btnMute.querySelector('.icon-muted') || btnMute) : null;
  const iconUnmuted = btnMute ? btnMute.querySelector('.icon-unmuted') : null;

  // --- Restored working overlay visibility handling ---
  function showControls() {
    if (controlsOverlay) controlsOverlay.classList.remove('ui-hidden');
    if (container) container.classList.remove('ui-hidden');
    
    clearTimeout(uiHideTimer);
    uiHideTimer = setTimeout(() => {
      if (!videoElem.paused) {
        if (controlsOverlay) controlsOverlay.classList.add('ui-hidden');
      }
    }, UI_HIDE_TIMEOUT_MS);
  }

  // Bind mouse/touch triggers directly to container & document
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

  // --- Direct Unmute Button Listener ---
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

  // --- Play/Pause Listener ---
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

    if (debugElem) {
      const displayName = item.name ? item.name : `Video ${itemIndex + 1}`;
      debugElem.textContent = `Now Playing : ${displayName}`;
    }

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
