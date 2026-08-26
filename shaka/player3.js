/**
 * Test-Ready Linear TV Player Controller (Sequential / Non-Looping with Virtual Duration Enforcement)
 */

function initPlayer(config) {
    const elements = {
        videoPrimary: document.getElementById(config.videoId),
        videoSecondary: document.getElementById('videoPlayerNext'),
        iframe: document.getElementById(config.iframeId),
        container: document.getElementById(config.containerId),
        loader: document.getElementById(config.loaderId),
        fallbackOverlay: document.getElementById(config.fallbackOverlayId),
        error: document.getElementById(config.errorId),
        btnPlay: document.getElementById(config.btnPlayId),
        btnMute: document.getElementById(config.btnMuteId),
        btnFullscreen: document.getElementById(config.btnFullscreenId),
        scheduleList: document.getElementById(config.scheduleListId),
        syncToast: document.getElementById(config.syncToastId),
        updateToast: document.getElementById(config.updateToastId),
        statusText: document.getElementById(config.statusTextId),
        statusOffset: document.getElementById(config.statusOffsetId),
        nowTitle: document.getElementById(config.nowTitleId),
        volOverlay: document.getElementById(config.volOverlayId),
        clock: config.showClock ? document.getElementById(config.clockId) : null,
        clockDate: config.showClock ? document.getElementById(config.clockDateId) : null
    };

    let activeVideo = elements.videoPrimary;
    let hiddenVideo = elements.videoSecondary;
    let activeHls = null;
    let hiddenHls = null;

    let currentIndex = 0;
    let preloadedIndex = -1;
    let rawPlaylist = [];
    let isLiveStream = false;
    let isIframe = false;
    let progressTimer = null;
    let clockTimer = null;
    let hideControlsTimeout = null;
    let hasEndedCurrentTrack = false;
    const isEmbedMode = document.body.classList.contains('embed-mode');

    function showLoader(show) {
        if (elements.loader) {
            elements.loader.classList.toggle('hidden', !show);
        }
    }

    function showFallback(show) {
        if (elements.fallbackOverlay) {
            elements.fallbackOverlay.classList.toggle('hidden', !show);
        }
    }

    function showError(message) {
        if (elements.error) {
            if (message) {
                elements.error.textContent = message;
                elements.error.classList.add('show');
            } else {
                elements.error.classList.remove('show');
            }
        }
    }

    function showToast(el) {
        if (!el || isEmbedMode) return;
        el.classList.add('show');
        setTimeout(() => el.classList.remove('show'), 3000);
    }

    function formatTime(seconds) {
        if (isNaN(seconds) || seconds < 0) return '00:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    function updateMuteButtonState() {
        if (!elements.btnMute) return;
        elements.btnMute.textContent = (activeVideo.muted || activeVideo.volume === 0) ? '🔇' : '🔊';
    }

    function startClock() {
        if (!config.showClock) return;
        function updateClock() {
            const now = new Date();
            if (elements.clock) elements.clock.textContent = now.toLocaleTimeString();
            if (elements.clockDate) elements.clockDate.textContent = now.toLocaleDateString();
        }
        updateClock();
        clockTimer = setInterval(updateClock, 1000);
    }

    function preloadNextStream() {
        const nextIndex = currentIndex + 1;
        if (nextIndex >= rawPlaylist.length || preloadedIndex === nextIndex) return;

        const nextProgram = rawPlaylist[nextIndex];
        preloadedIndex = nextIndex;
        hiddenVideo.muted = true;

        if (hiddenHls) {
            hiddenHls.destroy();
            hiddenHls = null;
        }

        if (nextProgram.url.includes('.m3u8') && Hls.isSupported()) {
            hiddenHls = new Hls({ enableWorker: true, lowLatencyMode: true });
            hiddenHls.loadSource(nextProgram.url);
            hiddenHls.attachMedia(hiddenVideo);
        } else {
            hiddenVideo.src = nextProgram.url;
            hiddenVideo.load();
        }
    }

    function playMedia(index) {
        hasEndedCurrentTrack = false;

        if (index < 0 || index >= rawPlaylist.length) {
            // End of playlist reach - Stop video and display animated fallback overlay
            activeVideo.pause();
            showFallback(true);
            showLoader(false);
            if (elements.nowTitle) elements.nowTitle.textContent = "Broadcast Standby";
            return;
        }

        currentIndex = index;
        const program = rawPlaylist[currentIndex];
        showError(null);

        if (elements.nowTitle) elements.nowTitle.textContent = program.title;
        renderScheduleUI();

        const isEmbed = program.url.includes('iframe') || program.type === 'iframe';
        if (isEmbed) {
            setupIframePlayer(program.url);
            return;
        }

        isIframe = false;
        elements.iframe.style.display = 'none';

        // Seamless buffer swap if already preloaded
        if (preloadedIndex === index && hiddenVideo.readyState >= 2) {
            hiddenVideo.muted = activeVideo.muted;
            hiddenVideo.volume = activeVideo.volume;

            activeVideo.style.display = 'none';
            activeVideo.pause();

            hiddenVideo.style.display = 'block';
            executeAutoPlay(hiddenVideo);

            const tempVid = activeVideo;
            activeVideo = hiddenVideo;
            hiddenVideo = tempVid;

            const tempHls = activeHls;
            activeHls = hiddenHls;
            hiddenHls = tempHls;

            preloadedIndex = -1;
            bindVideoEvents(activeVideo);
            showLoader(false);
            showFallback(false);
        } else {
            setupVideoSource(activeVideo, program, false);
        }

        showToast(elements.updateToast);
    }

    function setupVideoSource(targetVideo, program, isBackground) {
        let hlsInstance = isBackground ? hiddenHls : activeHls;
        if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
        }

        targetVideo.style.display = isBackground ? 'none' : 'block';
        if (elements.volOverlay) elements.volOverlay.style.display = 'none';
        if (elements.btnMute) elements.btnMute.style.display = 'inline-block';

        if (program.url.includes('.m3u8') && Hls.isSupported()) {
            const hls = new Hls({
                liveSyncDurationCount: 3,
                liveMaxLatencyDurationCount: 10,
                enableWorker: true,
                lowLatencyMode: true
            });

            hls.loadSource(program.url);
            hls.attachMedia(targetVideo);

            hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                isLiveStream = data.levels[0]?.details?.live || false;
                if (!isBackground) executeAutoPlay(targetVideo);
            });

            if (isBackground) hiddenHls = hls;
            else activeHls = hls;

        } else {
            targetVideo.src = program.url;
            if (!isBackground) executeAutoPlay(targetVideo);
        }
    }

    function setupIframePlayer(url) {
        isIframe = true;
        destroyPlayer();
        activeVideo.style.display = 'none';
        hiddenVideo.style.display = 'none';
        elements.iframe.style.display = 'block';
        elements.iframe.src = url;

        if (elements.volOverlay) elements.volOverlay.style.display = 'block';
        if (elements.btnMute) elements.btnMute.style.display = 'none';
        showLoader(false);
        showFallback(false);
    }

    function executeAutoPlay(videoTarget) {
        videoTarget.play().catch(() => {
            videoTarget.muted = true;
            updateMuteButtonState();
            videoTarget.play().catch(e => console.error("Autoplay failed:", e));
        });
    }

    function destroyPlayer() {
        if (activeHls) { activeHls.destroy(); activeHls = null; }
        if (hiddenHls) { hiddenHls.destroy(); hiddenHls = null; }
        activeVideo.pause();
        hiddenVideo.pause();
    }

    function renderScheduleUI() {
        if (!elements.scheduleList || !rawPlaylist.length) return;
        elements.scheduleList.innerHTML = rawPlaylist.map((item, idx) => {
            const isActive = currentIndex === idx;
            return `
                <div class="schedule-item ${isActive ? 'active' : ''}">
                    <strong>Part ${idx + 1}</strong>: ${item.title}
                </div>
            `;
        }).join('');
    }

    function updateProgress() {
        if (isIframe) {
            showFallback(false);
            if (elements.statusText) elements.statusText.textContent = 'Live (Embedded Player)';
            if (elements.statusOffset) elements.statusOffset.textContent = '';
            return;
        }

        const currentItem = rawPlaylist[currentIndex];
        
        // --- VIRTUAL DURATION CHECK ---
        // Force track end when currentTime hits the array duration (60s in your test)
        if (currentItem && currentItem.duration && activeVideo.currentTime >= currentItem.duration) {
            if (!hasEndedCurrentTrack) {
                hasEndedCurrentTrack = true;
                playMedia(currentIndex + 1);
                return;
            }
        }

        const isPlaying = activeVideo && 
                          !activeVideo.paused && 
                          !activeVideo.ended && 
                          activeVideo.readyState >= 2 &&
                          !hasEndedCurrentTrack;

        showFallback(!isPlaying);

        if (isPlaying && currentItem && (currentItem.duration - activeVideo.currentTime <= 8)) {
            preloadNextStream();
        }

        if (isLiveStream) {
            if (elements.statusText) elements.statusText.textContent = 'Live Stream';
            if (elements.statusOffset) elements.statusOffset.textContent = `Latency: ${formatTime(activeVideo.duration - activeVideo.currentTime)}`;
        } else if (currentItem) {
            const limitDuration = currentItem.duration || activeVideo.duration;
            if (elements.statusText) elements.statusText.textContent = `Playing: ${formatTime(activeVideo.currentTime)} / ${formatTime(limitDuration)}`;
            if (elements.statusOffset) elements.statusOffset.textContent = `Track ${currentIndex + 1} of ${rawPlaylist.length}`;
        }
    }

    function resetControlsTimeout() {
        if (!elements.container) return;
        elements.container.classList.remove('controls-hidden');
        clearTimeout(hideControlsTimeout);

        if (activeVideo && !activeVideo.paused) {
            hideControlsTimeout = setTimeout(() => {
                elements.container.classList.add('controls-hidden');
            }, 2500);
        }
    }

    function bindVideoEvents(videoEl) {
        videoEl.onwaiting = () => showLoader(true);

        videoEl.onplaying = () => {
            showLoader(false);
            showFallback(false);
            showError(null);
            if (elements.btnPlay) elements.btnPlay.textContent = '⏸';
            resetControlsTimeout();
        };

        videoEl.oncanplay = () => {
            if (!videoEl.paused && !hasEndedCurrentTrack) {
                showLoader(false);
                showFallback(false);
            }
        };

        videoEl.onpause = () => {
            if (elements.btnPlay) elements.btnPlay.textContent = '▶';
            clearTimeout(hideControlsTimeout);
            if (elements.container) elements.container.classList.remove('controls-hidden');
            if (!isIframe) {
                showFallback(true);
            }
        };

        videoEl.onended = () => {
            if (!hasEndedCurrentTrack) {
                hasEndedCurrentTrack = true;
                playMedia(currentIndex + 1);
            }
        };

        videoEl.onvolumechange = updateMuteButtonState;
    }

    function bindControls() {
        if (elements.btnPlay) {
            elements.btnPlay.addEventListener('click', (e) => {
                e.stopPropagation();
                if (activeVideo.paused) {
                    // If stream was terminated by virtual duration, replay from 0
                    if (hasEndedCurrentTrack) {
                        playMedia(currentIndex);
                    } else {
                        activeVideo.play();
                    }
                    elements.btnPlay.textContent = '⏸';
                } else {
                    activeVideo.pause();
                    elements.btnPlay.textContent = '▶';
                }
            });
        }

        if (elements.btnMute) {
            elements.btnMute.addEventListener('click', (e) => {
                e.stopPropagation();
                activeVideo.muted = !activeVideo.muted;
                updateMuteButtonState();
            });
        }

        if (elements.btnFullscreen) {
            elements.btnFullscreen.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetEl = elements.container || activeVideo;
                if (!document.fullscreenElement) {
                    targetEl.requestFullscreen().catch(err => console.error("Fullscreen failed:", err));
                } else {
                    document.exitFullscreen();
                }
            });
        }

        if (elements.container) {
            elements.container.addEventListener('mousemove', resetControlsTimeout);
            elements.container.addEventListener('mousedown', resetControlsTimeout);
            elements.container.addEventListener('click', resetControlsTimeout);
            elements.container.addEventListener('mouseleave', () => {
                if (activeVideo && !activeVideo.paused) {
                    elements.container.classList.add('controls-hidden');
                }
            });
        }
    }

    function loadPlaylist() {
        return [
            {
                "title": "Apna Tv Stream - Part 03",
                "duration": 60,
                "url": "https://xtremplay.com/api/proxy?url=https%3A%2F%2Fsi.videoapne.to%2Fhls%2Fbdohwghl7fboxuzvtaq74hyprcimk2rlc64hqoigerngtagfy7bxmxkkmk6q%2Findex-v1-a1.m3u8&ref=https%3A%2F%2Fsi.videoapne.to%2Fhls%2Fbdohwghl7fboxuzvtaq74hyprcimk2rlc64hqoigerngtagfy7bxmxkkmk6q%2Findex-v1-a1.m3u8",
                "type": "m3u8"
            }
        ];
    }

    rawPlaylist = loadPlaylist();
    bindVideoEvents(activeVideo);
    bindControls();
    startClock();
    playMedia(0);

    progressTimer = setInterval(updateProgress, 250);
}
