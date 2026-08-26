/**
 * 99.9% Production-Grade Broadcast Synchronized TV Player Controller
 * Features: Simplified Playlist Input, Continuous Looping, Zero-drift Sync, Hidden Controls on Hover/Click
 */

function initPlayer(config) {
    const elements = {
        video: document.getElementById(config.videoId),
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

    let hls = null;
    let currentScheduleItem = null;
    let rawPlaylist = [];
    let schedule = [];
    let isLiveStream = false;
    let isIframe = false;
    let autoSyncTimer = null;
    let progressTimer = null;
    let clockTimer = null;
    let retryCount = 0;
    let isInternalSeeking = false;
    let hasInitialSeekApplied = false;
    let hideControlsTimeout = null;
    const MAX_RETRIES = 3;
    const isEmbedMode = document.body.classList.contains('embed-mode');

    // FIXED CHANNEL UTC ANCHOR: Base time reference for absolute world synchronization
    const CHANNEL_START_EPOCH = 1700000000;

    function showLoader(show) {
        if (elements.loader) {
            elements.loader.classList.toggle('hidden', !show);
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
        elements.btnMute.textContent = (elements.video.muted || elements.video.volume === 0) ? '🔇' : '🔊';
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

    // --- AUTOMATIC TIMELINE ENGINE FOR SIMPLIFIED PLAYLISTS ---
    function buildScheduleFromSimplePlaylist(playlist) {
        if (!playlist || !playlist.length) return [];
        
        const totalPlaylistDuration = playlist.reduce((acc, item) => acc + item.duration, 0);
        if (totalPlaylistDuration <= 0) return [];

        const now = Date.now() / 1000;
        const elapsedSinceLaunch = now - CHANNEL_START_EPOCH;
        const currentLoopOffset = elapsedSinceLaunch % totalPlaylistDuration;
        const currentLoopStart = now - currentLoopOffset;

        let accumulatedTime = 0;

        return playlist.map((item, index) => {
            const itemStartTime = currentLoopStart + accumulatedTime;
            accumulatedTime += item.duration;
            const itemEndTime = currentLoopStart + accumulatedTime;

            return {
                id: `item_${index}_${Math.floor(itemStartTime)}`,
                title: item.title,
                startTime: itemStartTime,
                endTime: itemEndTime,
                duration: item.duration,
                url: item.url,
                isIframe: item.type === 'iframe'
            };
        });
    }

    // --- BROADCAST TIME CALCULATION ENGINE ---
    function getBroadcastCalculatedTime(program) {
        if (!program || !program.startTime) return 0;
        
        const nowSec = Date.now() / 1000;
        let elapsedTime = nowSec - program.startTime;

        if (elapsedTime < 0) return 0;

        // If the individual video duration is known, ensure smooth wrapping within item duration
        const videoDuration = elements.video.duration || program.duration;
        if (videoDuration && !isNaN(videoDuration) && videoDuration > 0) {
            return elapsedTime % videoDuration;
        }

        return elapsedTime;
    }

    function getCurrentProgram() {
        schedule = buildScheduleFromSimplePlaylist(rawPlaylist);
        if (!schedule.length) return null;

        const nowSec = Date.now() / 1000;
        const match = schedule.find(item => nowSec >= item.startTime && nowSec < item.endTime);
        return match || schedule[0];
    }

    // --- ACCURATE 99.9% LIVE DRIFT CORRECTION ---
    function evaluateScheduleSync() {
        if (!rawPlaylist.length) return;
        const targetProgram = getCurrentProgram();
        if (!targetProgram) return;

        if (!currentScheduleItem || currentScheduleItem.id !== targetProgram.id) {
            currentScheduleItem = targetProgram;
            hasInitialSeekApplied = false;
            if (elements.nowTitle) elements.nowTitle.textContent = targetProgram.title;
            renderScheduleUI();
            playMedia(targetProgram);
            showToast(elements.updateToast);
        } else if (!isLiveStream && !isIframe && elements.video.readyState >= 2) {
            const expectedOffset = getBroadcastCalculatedTime(currentScheduleItem);
            const actualOffset = elements.video.currentTime;
            const drift = actualOffset - expectedOffset;

            // Micro-adjustments: smooth out minor clock drifts transparently
            if (Math.abs(drift) > 0.5 && Math.abs(drift) <= 3) {
                elements.video.playbackRate = drift < 0 ? 1.05 : 0.95;
            } else {
                elements.video.playbackRate = 1.0;
            }

            // Hard seek jump if manual seek or large drift occurs
            if (Math.abs(drift) > 3) {
                isInternalSeeking = true;
                elements.video.currentTime = expectedOffset;
                showToast(elements.syncToast);
                setTimeout(() => { isInternalSeeking = false; }, 500);
            }
        }
    }

    function destroyPlayer() {
        if (hls) {
            hls.destroy();
            hls = null;
        }
        elements.video.pause();
        elements.video.removeAttribute('src');
        elements.video.load();
    }

    function playMedia(program) {
        showError(null);
        showLoader(true);
        retryCount = 0;
        hasInitialSeekApplied = false;

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
        elements.video.style.display = 'none';
        elements.iframe.style.display = 'block';
        elements.iframe.src = url;

        if (elements.volOverlay) elements.volOverlay.style.display = 'block';
        if (elements.btnMute) elements.btnMute.style.display = 'none';
        showLoader(false);
    }

    function applyLinearSeek(program) {
        if (program && program.startTime && elements.video.readyState >= 1) {
            const targetOffset = getBroadcastCalculatedTime(program);
            isInternalSeeking = true;
            elements.video.currentTime = targetOffset;
            hasInitialSeekApplied = true;
            setTimeout(() => { isInternalSeeking = false; }, 500);
        }
    }

    function executeAutoPlay() {
        elements.video.play().catch(() => {
            elements.video.muted = true;
            updateMuteButtonState();
            elements.video.play().catch(e => console.error("Autoplay failed:", e));
        });
    }

    function setupHlsPlayer(program) {
        isIframe = false;
        elements.iframe.style.display = 'none';
        elements.iframe.src = '';
        elements.video.style.display = 'block';
        if (elements.volOverlay) elements.volOverlay.style.display = 'none';
        if (elements.btnMute) elements.btnMute.style.display = 'inline-block';

        destroyPlayer();

        if (Hls.isSupported()) {
            hls = new Hls({
                liveSyncDurationCount: 3,
                liveMaxLatencyDurationCount: 10,
                liveDurationInfinity: true,
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 60,
                maxBufferLength: 30,
                maxMaxBufferLength: 60
            });

            hls.loadSource(program.url);
            hls.attachMedia(elements.video);

            hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                isLiveStream = data.levels[0]?.details?.live || false;
                executeAutoPlay();
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            if (retryCount < MAX_RETRIES) {
                                retryCount++;
                                showError(`Network issue. Re-syncing... (${retryCount}/${MAX_RETRIES})`);
                                hls.startLoad();
                            } else {
                                showError('Network offline. Re-initializing playback...');
                                setTimeout(() => playMedia(program), 3000);
                            }
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            showError('Buffer error. Recovering broadcast...');
                            hls.recoverMediaError();
                            break;
                        default:
                            showError('Critical error. Reloading broadcast...');
                            destroyPlayer();
                            setTimeout(() => playMedia(program), 2000);
                            break;
                    }
                }
            });

        } else if (elements.video.canPlayType('application/vnd.apple.mpegurl')) {
            elements.video.src = program.url;
            executeAutoPlay();
        } else {
            showError('HLS Playback is not supported on this browser.');
            showLoader(false);
        }
    }

    function setupNativeVideoPlayer(program) {
        isIframe = false;
        elements.iframe.style.display = 'none';
        elements.iframe.src = '';
        elements.video.style.display = 'block';
        if (elements.volOverlay) elements.volOverlay.style.display = 'none';
        if (elements.btnMute) elements.btnMute.style.display = 'inline-block';

        destroyPlayer();
        elements.video.src = program.url;
        executeAutoPlay();
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
            if (elements.statusOffset) elements.statusOffset.textContent = `Latency: ${formatTime(elements.video.duration - elements.video.currentTime)}`;
        } else if (currentScheduleItem) {
            const expectedOffset = getBroadcastCalculatedTime(currentScheduleItem);
            const duration = elements.video.duration || currentScheduleItem.duration;

            if (elements.statusText) elements.statusText.textContent = `Linear Broadcast Sync: ${formatTime(elements.video.currentTime)} / ${formatTime(duration)}`;
            if (elements.statusOffset) elements.statusOffset.textContent = `Live Drift: ${(elements.video.currentTime - expectedOffset).toFixed(1)}s`;
        }
    }

    function resetControlsTimeout() {
        if (!elements.container) return;

        elements.container.classList.remove('controls-hidden');
        clearTimeout(hideControlsTimeout);

        if (elements.video && !elements.video.paused) {
            hideControlsTimeout = setTimeout(() => {
                elements.container.classList.add('controls-hidden');
            }, 2500);
        }
    }

    function bindEvents() {
        elements.video.addEventListener('canplay', () => {
            if (!hasInitialSeekApplied && currentScheduleItem && !isLiveStream && !isIframe) {
                applyLinearSeek(currentScheduleItem);
            }
        });

        if (elements.btnPlay) {
            elements.btnPlay.addEventListener('click', (e) => {
                e.stopPropagation();
                if (elements.video.paused) {
                    elements.video.play();
                    elements.btnPlay.textContent = '⏸';
                } else {
                    elements.video.pause();
                    elements.btnPlay.textContent = '▶';
                }
            });
        }

        if (elements.btnMute) {
            elements.btnMute.addEventListener('click', (e) => {
                e.stopPropagation();
                elements.video.muted = !elements.video.muted;
                updateMuteButtonState();
            });
        }

        if (elements.btnFullscreen) {
            elements.btnFullscreen.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetEl = document.getElementById('playerWrap') || elements.container || elements.video;
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

        elements.video.addEventListener('seeking', () => {
            if (isIframe || isLiveStream || !currentScheduleItem || isInternalSeeking) return;

            const expectedOffset = getBroadcastCalculatedTime(currentScheduleItem);
            if (Math.abs(elements.video.currentTime - expectedOffset) > 1.5) {
                isInternalSeeking = true;
                elements.video.currentTime = expectedOffset;
                showToast(elements.syncToast);
                setTimeout(() => { isInternalSeeking = false; }, 500);
            }
        });

        elements.video.addEventListener('volumechange', updateMuteButtonState);
        elements.video.addEventListener('waiting', () => showLoader(true));
        elements.video.addEventListener('playing', () => {
            showLoader(false);
            showError(null);
            if (elements.btnPlay) elements.btnPlay.textContent = '⏸';
            resetControlsTimeout();
        });
        
        elements.video.addEventListener('pause', () => {
            if (elements.btnPlay) elements.btnPlay.textContent = '▶';
            clearTimeout(hideControlsTimeout);
            if (elements.container) {
                elements.container.classList.remove('controls-hidden');
            }
        });

        if (elements.container) {
            elements.container.addEventListener('mousemove', resetControlsTimeout);
            elements.container.addEventListener('mousedown', resetControlsTimeout);
            elements.container.addEventListener('click', resetControlsTimeout);
            elements.container.addEventListener('touchstart', resetControlsTimeout, { passive: true });
            
            elements.container.addEventListener('mouseleave', () => {
                if (elements.video && !elements.video.paused) {
                    elements.container.classList.add('controls-hidden');
                }
            });
        }
    }

    // --- YOUR SIMPLE SIMPLIFIED PLAYLIST ---
    function loadPlaylist() {
        return [
            {
                "title": "Apna Tv Stream - Part 01",
                "duration": 3600, // Duration in seconds (e.g., 1 hr)
                "url": "https://cdn30091.jemsa431ilk.com/stream2/i-arch-400/059876ce446f715070a26b5305a7cf47/MJTMsp1RshGTygnMNRUR2N2MSlnWXZEdMNDZzQWe5MDZzMmdZJTO1R2RWVHZDljekhkSsl1VwYnWtx2cihVT2p1VOlmTUNWePdVW61EVa1WW6lUNORVU14UbapWWUtGNOpGZspFVGxWWqNWP:1787714029:101.119.79.147:96d71a98a7d76ec6a84381e0e0644c7c5de1dbe0a655203867eace9b147d9f19:=0EVBhHTqVEePNFNz80U0gnTENWP/720/index.m3u8",
                "type": "m3u8"
            },
            {
                "title": "Apna Tv Stream - Part 02",
                "duration": 1800, // 30 minutes
                "url": "https://cdn30091.jemsa431ilk.com/stream2/i-arch-400/059876ce446f715070a26b5305a7cf47/MJTMsp1RshGTygnMNRUR2N2MSlnWXZEdMNDZzQWe5MDZzMmdZJTO1R2RWVHZDljekhkSsl1VwYnWtx2cihVT2p1VOlmTUNWePdVW61EVa1WW6lUNORVU14UbapWWUtGNOpGZspFVGxWWqNWP:1787714029:101.119.79.147:96d71a98a7d76ec6a84381e0e0644c7c5de1dbe0a655203867eace9b147d9f19:=0EVBhHTqVEePNFNz80U0gnTENWP/720/index.m3u8",
                "type": "m3u8"
            }
        ];
    }

    rawPlaylist = loadPlaylist();
    bindEvents();
    startClock();
    evaluateScheduleSync();

    autoSyncTimer = setInterval(evaluateScheduleSync, 1000);
    progressTimer = setInterval(updateProgress, 250);
}
