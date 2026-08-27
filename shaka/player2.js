/**
 * Production-Grade Broadcast Synchronized TV Player Controller
 * Features: Double-Buffered Seamless Transitions, Fixed Sync Math, Drift Correction
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
    let retryCount = 0;
    let isInternalSeeking = false;
    let hasInitialSeekApplied = false;
    let hideControlsTimeout = null;
    const MAX_RETRIES = 3;
    const isEmbedMode = document.body.classList.contains('embed-mode');

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

            return {
                id: `item_${index}_${Math.floor(itemStartTime)}`,
                title: item.title,
                startTime: itemStartTime,
                endTime: itemEndTime,
                duration: item.duration,
                url: item.url,
                type: item.type,
                isIframe: item.type === 'iframe'
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

    function preloadNextStream() {
        const nextProgram = getCurrentProgram(8);
        if (!nextProgram || (preloadedScheduleItem && preloadedScheduleItem.id === nextProgram.id)) return;

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
        } else {
            setupVideoSource(activeVideo, program, false);
        }
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
                applyLinearSeek(program, targetVideo);
                if (!isBackground) executeAutoPlay(targetVideo);
            });

            if (isBackground) hiddenHls = hls;
            else activeHls = hls;

        } else {
            targetVideo.src = program.url;
            applyLinearSeek(program, targetVideo);
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
        if (!rawPlaylist.length) return;
        const targetProgram = getCurrentProgram();
        if (!targetProgram) return;

        const currentOffset = getBroadcastCalculatedTime(targetProgram);
        if (targetProgram.duration - currentOffset <= 8) {
            preloadNextStream();
        }

        if (!currentScheduleItem || currentScheduleItem.id !== targetProgram.id) {
            currentScheduleItem = targetProgram;
            if (elements.nowTitle) elements.nowTitle.textContent = targetProgram.title;
            renderScheduleUI();
            playMedia(targetProgram);
            showToast(elements.updateToast);
        } else if (!isLiveStream && !isIframe && activeVideo.readyState >= 2 && !isInternalSeeking) {
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
        // Show loader if video pauses to buffer mid-stream
        videoEl.onwaiting = () => showLoader(true);

        // Hide loader immediately when playback begins rendering frames
        videoEl.onplaying = () => {
            showLoader(false);
            showError(null);
            if (elements.btnPlay) elements.btnPlay.textContent = '⏸';
            resetControlsTimeout();
        };

        // Fallback: hide loader once media can play if not paused
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
                "title": "Apna Tv Stream - Part 03",
                "duration": 3425,
                "url": "https://xtremplay.com/api/proxy?url=https%3A%2F%2Fs2.videoapne.to%2Fhls%2Fbdohwspe7bboxuzvta274ealq5jq3vlxdownbvs7t6hhciiylhtnqvoaby3q%2Findex-v1-a1.m3u8&ref=https%3A%2F%2Fs2.videoapne.to%2Fhls%2Fbdohwspe7bboxuzvta274ealq5jq3vlxdownbvs7t6hhciiylhtnqvoaby3q%2Findex-v1-a1.m3u8",
                "type": "m3u8"
            },
            {
                "title": "Apna Tv Stream - Part 04",
                "duration": 3438,
                "url": "https://xtremplay.com/api/proxy?url=https%3A%2F%2Fs2.videoapne.to%2Fhls%2Fbdohwshe7bboxuzvta274tavqd2t3zsemepzjg3tbjj2r5pricxyhxitrlqq%2Findex-v1-a1.m3u8&ref=https%3A%2F%2Fs2.videoapne.to%2Fhls%2Fbdohwshe7bboxuzvta274tavqd2t3zsemepzjg3tbjj2r5pricxyhxitrlqq%2Findex-v1-a1.m3u8",
                "type": "m3u8"
            }
            
        ];
    }

    rawPlaylist = loadPlaylist();
    bindVideoEvents(activeVideo);
    bindControls();
    startClock();
    evaluateScheduleSync();

    autoSyncTimer = setInterval(evaluateScheduleSync, 1000);
    progressTimer = setInterval(updateProgress, 250);
}
