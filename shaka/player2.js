/**
 * Production-Grade Broadcast Synchronized TV Player Controller
 * Features: Double-Buffered Seamless Transitions, Fixed Sync Math, Drift Correction,
 *           Live Playlist Polling, Automatic MP4 Fallback, Fixed Dynamic Iframe Swapping
 */

function initPlayer(config) {
    const elements = {
        videoPrimary: document.getElementById(config.videoId),
        videoSecondary: document.getElementById('videoPlayerNext'),
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

    let activeVideo = elements.videoPrimary;
    let hiddenVideo = elements.videoSecondary;
    let activeHls = null;
    let hiddenHls = null;

    let currentScheduleItem = null;
    let preloadedScheduleItem = null;
    let rawPlaylist = [];
    let schedule = [];
    let isLiveStream = false;
    let isIframe = false;
    let autoSyncTimer = null;
    let progressTimer = null;
    let clockTimer = null;
    let playlistPollTimer = null;
    let stuckWatchdogTimer = null;
    let retryCount = 0;
    let isInternalSeeking = false;
    let hasInitialSeekApplied = false;
    let hideControlsTimeout = null;
    const MAX_RETRIES = 3;
    const isEmbedMode = document.body.classList.contains('embed-mode');

    const CHANNEL_START_EPOCH = 1700000000;

    // ---- Fallback config ------------------------------------------------
    const FALLBACK_MP4_URL = config.fallbackVideoUrl || config.fallbackUrl || 'https://files.catbox.moe/c9z1wf.mp4';
    const PLAYLIST_URL = config.playlistUrl || null;
    const PLAYLIST_POLL_MS = config.playlistPollMs || 15000;
    const STUCK_WATCHDOG_MS = config.stuckWatchdogMs || 12000;

    let isFallbackActive = false;
    let lastPlaylistFingerprint = null;
    let lastProgressTimestamp = 0;
    let lastKnownCurrentTime = -1;
    let lastFailedProgramId = null;
    let fallbackRetryAt = 0;
    const FALLBACK_RETRY_COOLDOWN_MS = 20000;

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
            const isIframeType = item.type === 'iframe' || (item.url && item.url.includes('iframe'));

            return {
                id: `item_${index}_${Math.floor(itemStartTime)}`,
                title: item.title,
                startTime: itemStartTime,
                endTime: itemEndTime,
                duration: item.duration,
                url: item.url,
                type: item.type,
                isIframe: isIframeType
            };
        });
    }

    function getBroadcastCalculatedTime(program) {
        if (!program || !program.startTime) return 0;
        const nowSec = Date.now() / 1000;
        let elapsedTime = nowSec - program.startTime;
        if (elapsedTime < 0) return 0;
        return Math.min(elapsedTime, program.duration);
    }

    function getCurrentProgram(offsetSeconds = 0) {
        schedule = buildScheduleFromSimplePlaylist(rawPlaylist);
        if (!schedule.length) return null;

        const nowSec = (Date.now() / 1000) + offsetSeconds;
        const match = schedule.find(item => nowSec >= item.startTime && nowSec < item.endTime);
        return match || schedule[0];
    }

    // ---- Live playlist polling & fingerprinting -------------------------

    function fingerprintPlaylist(playlist) {
        try {
            return JSON.stringify(playlist.map(p => [p.title, p.duration, p.url, p.type, p.isIframe]));
        } catch (e) {
            return String(Date.now());
        }
    }

    async function fetchRemotePlaylist() {
        if (!PLAYLIST_URL) return null;
        try {
            const res = await fetch(PLAYLIST_URL, { cache: 'no-store' });
            if (!res.ok) throw new Error(`Playlist fetch failed: ${res.status}`);
            const data = await res.json();
            if (!Array.isArray(data) || !data.length) throw new Error('Empty/invalid playlist payload');
            return data;
        } catch (err) {
            console.warn('Playlist poll failed, keeping current playlist:', err);
            return null;
        }
    }

    async function pollPlaylistForChanges() {
        const fresh = await fetchRemotePlaylist();
        if (!fresh) return;

        const fingerprint = fingerprintPlaylist(fresh);
        if (fingerprint === lastPlaylistFingerprint) return; // No change

        console.info('Playlist updated from remote source. Applying live updates...');
        lastPlaylistFingerprint = fingerprint;
        rawPlaylist = fresh;

        // 1. Drop stale preloaded media
        preloadedScheduleItem = null;
        if (hiddenHls) { hiddenHls.destroy(); hiddenHls = null; }

        // 2. Force current program to null to force immediate re-evaluation
        currentScheduleItem = null;

        // 3. Immediately re-sync schedule to apply the new stream or iframe
        evaluateScheduleSync();
    }

    function startPlaylistPolling() {
        if (!PLAYLIST_URL) return;
        lastPlaylistFingerprint = fingerprintPlaylist(rawPlaylist);
        playlistPollTimer = setInterval(pollPlaylistForChanges, PLAYLIST_POLL_MS);
    }

    // ---- Fallback logic ---------------------------------------------

    function buildFallbackProgram() {
        return {
            id: 'fallback_placeholder',
            title: 'Programming will resume shortly',
            startTime: Date.now() / 1000,
            endTime: Date.now() / 1000 + 1e9,
            duration: 1e9,
            url: FALLBACK_MP4_URL,
            type: 'mp4',
            isIframe: false
        };
    }

    function activateFallback(reason, failedProgramId = null) {
        if (isFallbackActive) return;
        isFallbackActive = true;
        lastFailedProgramId = failedProgramId;
        fallbackRetryAt = Date.now() + FALLBACK_RETRY_COOLDOWN_MS;
        console.warn('Activating MP4 fallback:', reason);

        currentScheduleItem = buildFallbackProgram();
        preloadedScheduleItem = null;
        if (elements.nowTitle) elements.nowTitle.textContent = currentScheduleItem.title;
        showError(null);

        isIframe = false;
        elements.iframe.style.display = 'none';
        setupVideoSource(activeVideo, currentScheduleItem, false, true);
    }

    function tryDeactivateFallback() {
        isFallbackActive = false;
    }

    function armStuckWatchdog() {
        clearTimeout(stuckWatchdogTimer);
        if (isFallbackActive || isIframe) return;
        lastProgressTimestamp = Date.now();
        lastKnownCurrentTime = activeVideo.currentTime;

        stuckWatchdogTimer = setInterval(() => {
            if (isFallbackActive || isIframe || !currentScheduleItem) return;
            if (activeVideo.paused) return;

            if (activeVideo.currentTime === lastKnownCurrentTime) {
                if (Date.now() - lastProgressTimestamp > STUCK_WATCHDOG_MS) {
                    activateFallback('playback stalled (no currentTime progress)', currentScheduleItem ? currentScheduleItem.id : null);
                }
            } else {
                lastKnownCurrentTime = activeVideo.currentTime;
                lastProgressTimestamp = Date.now();
            }
        }, 3000);
    }

    function preloadNextStream() {
        if (isFallbackActive) return;
        const nextProgram = getCurrentProgram(8);
        if (!nextProgram || nextProgram.isIframe || (preloadedScheduleItem && preloadedScheduleItem.id === nextProgram.id)) return;

        preloadedScheduleItem = nextProgram;
        hiddenVideo.muted = true;

        if (hiddenHls) {
            hiddenHls.destroy();
            hiddenHls = null;
        }

        const calculatedSeek = getBroadcastCalculatedTime(nextProgram);

        if (nextProgram.url.includes('.m3u8') && Hls.isSupported()) {
            hiddenHls = new Hls({ enableWorker: true, lowLatencyMode: true });
            hiddenHls.loadSource(nextProgram.url);
            hiddenHls.attachMedia(hiddenVideo);
            hiddenHls.on(Hls.Events.MANIFEST_PARSED, () => {
                hiddenVideo.currentTime = calculatedSeek;
            });
            hiddenHls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    console.warn('Preload of next stream failed fatally.');
                    if (hiddenHls) { hiddenHls.destroy(); hiddenHls = null; }
                    preloadedScheduleItem = null;
                }
            });
        } else {
            hiddenVideo.src = nextProgram.url;
            hiddenVideo.currentTime = calculatedSeek;
            hiddenVideo.load();
        }
    }

    function playMedia(program) {
        showError(null);
        retryCount = 0;

        const isEmbed = program.url.includes('iframe') || program.isIframe;
        if (isEmbed) {
            setupIframePlayer(program.url);
            return;
        }

        isIframe = false;
        elements.iframe.style.display = 'none';

        if (preloadedScheduleItem && preloadedScheduleItem.id === program.id && hiddenVideo.readyState >= 2) {
            hiddenVideo.muted = activeVideo.muted;
            hiddenVideo.volume = activeVideo.volume;
            hiddenVideo.loop = false;

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

            preloadedScheduleItem = null;
            bindVideoEvents(activeVideo);
            showLoader(false);
            armStuckWatchdog();
        } else {
            setupVideoSource(activeVideo, program, false);
        }
    }

    function setupVideoSource(targetVideo, program, isBackground, isFallback = false) {
        let hlsInstance = isBackground ? hiddenHls : activeHls;
        if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
        }

        targetVideo.style.display = isBackground ? 'none' : 'block';
        targetVideo.loop = !!isFallback;
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
                if (!isFallback) applyLinearSeek(program, targetVideo);
                if (!isBackground) {
                    executeAutoPlay(targetVideo);
                    if (!isFallback) armStuckWatchdog();
                }
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal && !isBackground && !isFallback) {
                    console.error('Fatal HLS error, activating fallback:', data);
                    activateFallback('fatal HLS error: ' + data.type, program.id);
                }
            });

            if (isBackground) hiddenHls = hls;
            else activeHls = hls;

        } else {
            targetVideo.src = program.url;
            if (!isFallback) applyLinearSeek(program, targetVideo);
            if (!isBackground) {
                executeAutoPlay(targetVideo);
                if (!isFallback) armStuckWatchdog();
            }
        }

        if (!isBackground) {
            targetVideo.onerror = () => {
                if (!isFallback) {
                    console.error('Video element error, activating fallback.');
                    activateFallback('video element error', program.id);
                }
            };
        }
    }

    function setupIframePlayer(url) {
        isIframe = true;
        destroyPlayer();
        activeVideo.style.display = 'none';
        hiddenVideo.style.display = 'none';
        elements.iframe.style.display = 'block';
        
        // Force reload even if URL matches but requires fresh frame initialization
        if (elements.iframe.src !== url) {
            elements.iframe.src = url;
        } else {
            elements.iframe.src = 'about:blank';
            setTimeout(() => { elements.iframe.src = url; }, 50);
        }

        if (elements.volOverlay) elements.volOverlay.style.display = 'block';
        if (elements.btnMute) elements.btnMute.style.display = 'none';
        showLoader(false);
    }

    function executeAutoPlay(videoTarget) {
        videoTarget.play().catch(() => {
            videoTarget.muted = true;
            updateMuteButtonState();
            videoTarget.play().catch(e => console.error("Autoplay failed:", e));
        });
    }

    function applyLinearSeek(program, videoTarget) {
        if (program && program.startTime) {
            const targetOffset = getBroadcastCalculatedTime(program);
            isInternalSeeking = true;
            videoTarget.currentTime = targetOffset;
            setTimeout(() => { isInternalSeeking = false; }, 500);
        }
    }

    function evaluateScheduleSync() {
        if (!rawPlaylist.length) {
            activateFallback('empty playlist');
            return;
        }

        const targetProgram = getCurrentProgram();
        if (!targetProgram) {
            activateFallback('no matching program in schedule');
            return;
        }

        if (isFallbackActive) {
            const cooldownElapsed = Date.now() >= fallbackRetryAt;
            const differentProgram = targetProgram.id !== lastFailedProgramId;
            if (differentProgram || cooldownElapsed) {
                tryDeactivateFallback();
            } else {
                return;
            }
        }

        const currentOffset = getBroadcastCalculatedTime(targetProgram);
        if (targetProgram.duration - currentOffset <= 8) {
            preloadNextStream();
        }

        // Program transition or manual schedule break
        if (!currentScheduleItem || currentScheduleItem.id !== targetProgram.id) {
            currentScheduleItem = targetProgram;
            if (elements.nowTitle) elements.nowTitle.textContent = targetProgram.title;
            renderScheduleUI();
            
            if (targetProgram.isIframe || targetProgram.url.includes('iframe')) {
                setupIframePlayer(targetProgram.url);
            } else {
                playMedia(targetProgram);
            }
            
            showToast(elements.updateToast);
        } else if (!isLiveStream && !isIframe && activeVideo.readyState >= 2 && !isInternalSeeking) {
            // Drift correction for native HTML5 streams
            const expectedOffset = getBroadcastCalculatedTime(currentScheduleItem);
            const actualOffset = activeVideo.currentTime;
            const drift = actualOffset - expectedOffset;

            if (Math.abs(drift) > 1.0 && Math.abs(drift) <= 5) {
                activeVideo.playbackRate = drift < 0 ? 1.03 : 0.97;
            } else {
                activeVideo.playbackRate = 1.0;
            }

            if (Math.abs(drift) > 8) {
                isInternalSeeking = true;
                activeVideo.currentTime = expectedOffset;
                showToast(elements.syncToast);
                setTimeout(() => { isInternalSeeking = false; }, 1000);
            }
        }
    }

    function destroyPlayer() {
        if (activeHls) { activeHls.destroy(); activeHls = null; }
        if (hiddenHls) { hiddenHls.destroy(); hiddenHls = null; }
        activeVideo.pause();
        hiddenVideo.pause();
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

        if (isFallbackActive) {
            if (elements.statusText) elements.statusText.textContent = 'Fallback Content';
            if (elements.statusOffset) elements.statusOffset.textContent = 'Reconnecting to schedule…';
            return;
        }

        if (isLiveStream) {
            if (elements.statusText) elements.statusText.textContent = 'Live Stream';
            if (elements.statusOffset) elements.statusOffset.textContent = `Latency: ${formatTime(activeVideo.duration - activeVideo.currentTime)}`;
        } else if (currentScheduleItem) {
            const expectedOffset = getBroadcastCalculatedTime(currentScheduleItem);
            const duration = activeVideo.duration || currentScheduleItem.duration;

            if (elements.statusText) elements.statusText.textContent = `Linear Broadcast Sync: ${formatTime(activeVideo.currentTime)} / ${formatTime(duration)}`;
            if (elements.statusOffset) elements.statusOffset.textContent = `Live Drift: ${(activeVideo.currentTime - expectedOffset).toFixed(1)}s`;
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
            showError(null);
            if (elements.btnPlay) elements.btnPlay.textContent = '⏸';
            resetControlsTimeout();
        };

        videoEl.oncanplay = () => {
            if (!videoEl.paused) {
                showLoader(false);
            }
        };

        videoEl.onpause = () => {
            if (elements.btnPlay) elements.btnPlay.textContent = '▶';
            clearTimeout(hideControlsTimeout);
            if (elements.container) elements.container.classList.remove('controls-hidden');
        };

        videoEl.onvolumechange = updateMuteButtonState;
    }

    function bindControls() {
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
                "title": "Apna Tv Stream - Part 06",
                "duration": 1800,
                "url": "https://xtremplay.com/api/proxy?url=https%3A%2F%2Fs2.videoapne.to%2Fhls%2Fbdohwshe7bboxuzvta274tavqd2t3zsemepzjg3tbjj2r5pricxyhxitrlqq%2Findex-v1-a1.m3u8&ref=https%3A%2F%2Fs2.videoapne.to%2Fhls%2Fbdohwshe7bboxuzvta274tavqd2t3zsemepzjg3tbjj2r5pricxyhxitrlqq%2Findex-v1-a1.m3u8",
                "type": "iframe"
            }
        ];
    }

    rawPlaylist = loadPlaylist();
    bindVideoEvents(activeVideo);
    bindControls();
    startClock();
    evaluateScheduleSync();
    startPlaylistPolling();

    autoSyncTimer = setInterval(evaluateScheduleSync, 1000);
    progressTimer = setInterval(updateProgress, 250);
}
