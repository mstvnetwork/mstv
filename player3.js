/**
 * Production-Grade Linear Sync & HLS Player Controller
 * Seamless Dual-Element Buffering Architecture
 */

function initPlayer(config) {
    const elements = {
        videoA: document.getElementById(config.videoId),
        videoB: document.getElementById(config.videoIdNext || config.videoId + 'Next'),
        iframe: document.getElementById(config.iframeId),
        container: document.getElementById(config.containerId),
        loader: document.getElementById(config.loaderId),
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

    // Active & Hidden Player Refs
    let activeVideo = elements.videoA;
    let hiddenVideo = elements.videoB;

    let hlsActive = null;
    let hlsPreload = null;

    let currentScheduleItem = null;
    let preloadedScheduleItem = null;
    let schedule = [];

    let isLiveStream = false;
    let isIframe = false;
    let retryCount = 0;
    let isInternalSeeking = false;
    const MAX_RETRIES = 3;
    const isEmbedMode = document.body.classList.contains('embed-mode');

    // Make sure background video is initialized cleanly
    if (hiddenVideo) {
        hiddenVideo.style.display = 'none';
        hiddenVideo.muted = true;
    }

    function showLoader(show) {
        if (elements.loader) elements.loader.classList.toggle('hidden', !show);
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
        if (!el || (el === elements.updateToast && isEmbedMode)) return;
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
        if (!elements.btnMute || !activeVideo) return;
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
        setInterval(updateClock, 1000);
    }

    function getCurrentProgram() {
        if (!schedule.length) return null;
        const nowSec = Math.floor(Date.now() / 1000);
        const match = schedule.find(item => nowSec >= item.startTime && nowSec < item.endTime);
        return match || schedule[0];
    }

    function getNextProgram() {
        if (!schedule.length) return null;
        const currentIndex = schedule.findIndex(item => item.id === currentScheduleItem?.id);
        if (currentIndex !== -1 && currentIndex + 1 < schedule.length) {
            return schedule[currentIndex + 1];
        }
        return schedule[0]; // Loop back to start if playlist reaches the end
    }

    function applyLinearSeek(program, targetVideo) {
        if (program && program.startTime) {
            const nowSec = Math.floor(Date.now() / 1000);
            const targetOffset = nowSec - program.startTime;
            if (targetOffset > 0) {
                isInternalSeeking = true;
                targetVideo.currentTime = targetOffset;
                setTimeout(() => { isInternalSeeking = false; }, 500);
            }
        }
    }

    function preloadNextProgram(nextProgram) {
        if (!nextProgram || (preloadedScheduleItem && preloadedScheduleItem.id === nextProgram.id) || !hiddenVideo) return;

        preloadedScheduleItem = nextProgram;
        if (hlsPreload) {
            hlsPreload.destroy();
            hlsPreload = null;
        }

        if (nextProgram.url.includes('.m3u8') && Hls.isSupported()) {
            hlsPreload = new Hls({
                liveSyncDurationCount: 3,
                enableWorker: true,
                lowLatencyMode: true
            });
            hlsPreload.loadSource(nextProgram.url);
            hlsPreload.attachMedia(hiddenVideo);
            hlsPreload.on(Hls.Events.MANIFEST_PARSED, () => {
                applyLinearSeek(nextProgram, hiddenVideo);
            });
        } else if (!nextProgram.url.includes('iframe')) {
            hiddenVideo.src = nextProgram.url;
            hiddenVideo.load();
        }
    }

    function swapPlayersToNext(nextProgram) {
        if (!hiddenVideo) {
            playMedia(nextProgram);
            return;
        }

        // Swap references
        const oldVideo = activeVideo;
        activeVideo = hiddenVideo;
        hiddenVideo = oldVideo;

        if (hlsActive) hlsActive.destroy();
        hlsActive = hlsPreload;
        hlsPreload = null;

        currentScheduleItem = nextProgram;
        preloadedScheduleItem = null;

        // Visual Swap
        hiddenVideo.style.display = 'none';
        hiddenVideo.pause();

        activeVideo.style.display = 'block';
        activeVideo.muted = oldVideo.muted;

        if (elements.nowTitle) elements.nowTitle.textContent = currentScheduleItem.title;
        renderScheduleUI();
        showToast(elements.updateToast);

        applyLinearSeek(currentScheduleItem, activeVideo);
        activeVideo.play().catch(() => {
            activeVideo.muted = true;
            updateMuteButtonState();
            activeVideo.play();
        });
    }

    function evaluateScheduleSync() {
        if (!schedule.length) return;
        const targetProgram = getCurrentProgram();
        if (!targetProgram) return;

        if (!currentScheduleItem || currentScheduleItem.id !== targetProgram.id) {
            if (preloadedScheduleItem && preloadedScheduleItem.id === targetProgram.id) {
                swapPlayersToNext(targetProgram);
            } else {
                currentScheduleItem = targetProgram;
                if (elements.nowTitle) elements.nowTitle.textContent = targetProgram.title;
                renderScheduleUI();
                playMedia(targetProgram);
                showToast(elements.updateToast);
            }
        } else if (!isLiveStream && !isIframe) {
            const nowSec = Math.floor(Date.now() / 1000);
            const expectedOffset = nowSec - currentScheduleItem.startTime;
            const actualOffset = activeVideo.currentTime;

            if (Math.abs(actualOffset - expectedOffset) > 3) {
                isInternalSeeking = true;
                activeVideo.currentTime = expectedOffset;
                showToast(elements.syncToast);
                setTimeout(() => { isInternalSeeking = false; }, 500);
            }
        }
    }

    function destroyPlayer() {
        if (hlsActive) {
            hlsActive.destroy();
            hlsActive = null;
        }
        activeVideo.pause();
        activeVideo.removeAttribute('src');
        activeVideo.load();
    }

    function playMedia(program) {
        showError(null);
        showLoader(true);
        retryCount = 0;

        const isEmbed = program.url.includes('iframe') || program.isIframe;
        if (isEmbed) {
            setupIframePlayer(program.url);
        } else if (program.url.includes('.m3u8')) {
            setupHlsPlayer(program);
        } else {
            setupNativeVideoPlayer(program);
        }
    }

    function setupIframePlayer(url) {
        isIframe = true;
        destroyPlayer();
        activeVideo.style.display = 'none';
        if (hiddenVideo) hiddenVideo.style.display = 'none';
        elements.iframe.style.display = 'block';
        elements.iframe.src = url;

        if (elements.volOverlay) elements.volOverlay.style.display = 'block';
        if (elements.btnMute) elements.btnMute.style.display = 'none';
        showLoader(false);
    }

    function setupHlsPlayer(program) {
        isIframe = false;
        elements.iframe.style.display = 'none';
        elements.iframe.src = '';
        activeVideo.style.display = 'block';
        if (elements.volOverlay) elements.volOverlay.style.display = 'none';
        if (elements.btnMute) elements.btnMute.style.display = 'inline-block';

        destroyPlayer();

        if (Hls.isSupported()) {
            hlsActive = new Hls({
                liveSyncDurationCount: 3,
                liveMaxLatencyDurationCount: 10,
                liveDurationInfinity: true,
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 60,
                maxBufferLength: 30,
                maxMaxBufferLength: 60
            });

            hlsActive.loadSource(program.url);
            hlsActive.attachMedia(activeVideo);

            hlsActive.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                isLiveStream = data.levels[0]?.details?.live || false;
                applyLinearSeek(program, activeVideo);

                activeVideo.play().catch(() => {
                    activeVideo.muted = true;
                    updateMuteButtonState();
                    activeVideo.play();
                });
            });

            hlsActive.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            if (retryCount < MAX_RETRIES) {
                                retryCount++;
                                showError(`Network issue detected. Syncing... (${retryCount}/${MAX_RETRIES})`);
                                hlsActive.startLoad();
                            } else {
                                showError('Network offline. Re-initializing playback...');
                                setTimeout(() => playMedia(program), 3000);
                            }
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            showError('Buffer failure. Recovering live frame...');
                            hlsActive.recoverMediaError();
                            break;
                        default:
                            showError('Playback critical error. Reloading live edge...');
                            destroyPlayer();
                            setTimeout(() => playMedia(program), 2000);
                            break;
                    }
                }
            });

        } else if (activeVideo.canPlayType('application/vnd.apple.mpegurl')) {
            activeVideo.src = program.url;
            activeVideo.addEventListener('loadedmetadata', () => {
                applyLinearSeek(program, activeVideo);
                activeVideo.play().catch(() => {
                    activeVideo.muted = true;
                    updateMuteButtonState();
                    activeVideo.play();
                });
            });
        } else {
            showError('HLS Playback is not supported on this browser.');
            showLoader(false);
        }
    }

    function setupNativeVideoPlayer(program) {
        isIframe = false;
        elements.iframe.style.display = 'none';
        elements.iframe.src = '';
        activeVideo.style.display = 'block';
        if (elements.volOverlay) elements.volOverlay.style.display = 'none';
        if (elements.btnMute) elements.btnMute.style.display = 'inline-block';

        destroyPlayer();
        activeVideo.src = program.url;
        applyLinearSeek(program, activeVideo);
        activeVideo.play().catch(() => {
            activeVideo.muted = true;
            updateMuteButtonState();
            activeVideo.play();
        });
    }

    function renderScheduleUI() {
        if (!elements.scheduleList || !schedule.length) return;
        elements.scheduleList.innerHTML = schedule.map(item => {
            const isActive = currentScheduleItem && currentScheduleItem.id === item.id;
            const startStr = new Date(item.startTime * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const endStr = new Date(item.endTime * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return `
                <div class="schedule-item ${isActive ? 'active' : ''}">
                    <strong>${startStr} - ${endStr}</strong>: ${item.title}
                </div>
            `;
        }).join('');
    }

    function updateProgress() {
        if (isIframe) {
            if (elements.statusText) elements.statusText.textContent = 'Live (Embedded Player)';
            if (elements.statusOffset) elements.statusOffset.textContent = '';
            return;
        }

        if (isLiveStream) {
            if (elements.statusText) elements.statusText.textContent = 'Live Stream';
            if (elements.statusOffset) elements.statusOffset.textContent = `Latency: ${formatTime(activeVideo.duration - activeVideo.currentTime)}`;
        } else if (currentScheduleItem) {
            const nowSec = Math.floor(Date.now() / 1000);
            const duration = currentScheduleItem.endTime - currentScheduleItem.startTime;
            const elapsed = nowSec - currentScheduleItem.startTime;
            const remaining = duration - elapsed;

            // Trigger preload when 15 seconds remain in current item
            if (remaining <= 15 && remaining > 0) {
                const nextProgram = getNextProgram();
                if (nextProgram && nextProgram.id !== currentScheduleItem.id) {
                    preloadNextProgram(nextProgram);
                }
            }

            if (elements.statusText) elements.statusText.textContent = `Linear Sync: ${formatTime(elapsed)} / ${formatTime(duration)}`;
            if (elements.statusOffset) elements.statusOffset.textContent = `Offset: +${Math.round(activeVideo.currentTime - elapsed)}s`;
        }
    }

    function bindEvents() {
        if (elements.btnPlay) {
            elements.btnPlay.addEventListener('click', (e) => {
                e.stopPropagation();
                if (activeVideo.paused) {
                    activeVideo.play();
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
                if (hiddenVideo) hiddenVideo.muted = true;
                updateMuteButtonState();
            });
        }

        if (elements.btnFullscreen) {
            elements.btnFullscreen.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetEl = document.getElementById('playerWrap') || elements.container || activeVideo;
                if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                    const requestFn = targetEl.requestFullscreen || targetEl.webkitRequestFullscreen || targetEl.msRequestFullscreen;
                    if (requestFn) {
                        requestFn.call(targetEl).catch(err => console.error("Fullscreen failed:", err));
                    }
                } else {
                    const exitFn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
                    if (exitFn) exitFn.call(document);
                }
            });
        }

        // Attach listener to current active target
        const handleSeeking = () => {
            if (isIframe || isLiveStream || !currentScheduleItem || isInternalSeeking) return;

            const nowSec = Math.floor(Date.now() / 1000);
            const expectedOffset = nowSec - currentScheduleItem.startTime;

            if (Math.abs(activeVideo.currentTime - expectedOffset) > 2) {
                isInternalSeeking = true;
                activeVideo.currentTime = expectedOffset;
                showToast(elements.syncToast);
                setTimeout(() => { isInternalSeeking = false; }, 500);
            }
        };

        elements.videoA.addEventListener('seeking', handleSeeking);
        if (elements.videoB) elements.videoB.addEventListener('seeking', handleSeeking);

        const handlePlaying = () => {
            showLoader(false);
            showError(null);
            if (elements.btnPlay) elements.btnPlay.textContent = '⏸';
        };

        const handlePause = () => {
            if (elements.btnPlay) elements.btnPlay.textContent = '▶';
        };

        elements.videoA.addEventListener('volumechange', updateMuteButtonState);
        elements.videoA.addEventListener('waiting', () => showLoader(true));
        elements.videoA.addEventListener('playing', handlePlaying);
        elements.videoA.addEventListener('pause', handlePause);

        if (elements.videoB) {
            elements.videoB.addEventListener('volumechange', updateMuteButtonState);
            elements.videoB.addEventListener('waiting', () => showLoader(true));
            elements.videoB.addEventListener('playing', handlePlaying);
            elements.videoB.addEventListener('pause', handlePause);
        }

        let hideControlsTimeout = null;
        function triggerActivity() {
            if (!elements.container) return;
            elements.container.classList.remove('controls-hidden');
            clearTimeout(hideControlsTimeout);

            hideControlsTimeout = setTimeout(() => {
                if (activeVideo && !activeVideo.paused) {
                    elements.container.classList.add('controls-hidden');
                }
            }, 2500);
        }

        if (elements.container) {
            elements.container.addEventListener('mousemove', triggerActivity);
            elements.container.addEventListener('click', triggerActivity);
            elements.container.addEventListener('touchstart', triggerActivity);
        }
    }

    function generateMockSchedule() {
        const now = Math.floor(Date.now() / 1000);
        return [
            {
                id: 'ch1',
                title: 'Linear Stream Channel',
                startTime: now - 300,
                endTime: now + 3600,
                url: 'https://cdn30091.jemsa431ilk.com/stream2/i-arch-400/059876ce446f715070a26b5305a7cf47/MJTMsp1RshGTygnMNRUR2N2MSlnWXZEdMNDZzQWe5MDZzMmdZJTO1R2RWVHZDljekhkSsl1VwYnWtx2cihVT2p1VOlmTUNWePdVW61EVa1WW6lUNORVU14UbapWWUtGNOpGZspFVGxWWqNWP:1787714029:101.119.79.147:96d71a98a7d76ec6a84381e0e0644c7c5de1dbe0a655203867eace9b147d9f19:=0EVBhHTqVEePNFNz80U0gnTENWP/720/index.m3u8'
            }
        ];
    }

    schedule = generateMockSchedule();
    bindEvents();
    startClock();
    evaluateScheduleSync();

    setInterval(evaluateScheduleSync, 1000);
    setInterval(updateProgress, 500);
}
