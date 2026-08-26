/**
 * Production-Grade Broadcast Synchronized TV Player Controller
 * Features: Double-Buffered Seamless Transitions, Fixed Sync Math, Drift Correction, Accurate Playback Detection & Dynamic Fallback Text
 * TEST MODE: Loop calculation disabled (Playlist runs once in real-time starting from page load).
 */

function initPlayer(config) {
    const elements = {
        videoPrimary: document.getElementById(config.videoId),
        videoSecondary: document.getElementById('videoPlayerNext'),
        iframe: document.getElementById(config.iframeId),
        container: document.getElementById(config.containerId),
        loader: document.getElementById(config.loaderId),
        fallback: document.getElementById(config.fallbackId),
        fallbackTitle: document.getElementById(config.fallbackTitleId),
        fallbackBadge: document.getElementById(config.fallbackBadgeId),
        fallbackSubtext: document.getElementById(config.fallbackSubtextId),
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
    let hideControlsTimeout = null;
    const isEmbedMode = document.body.classList.contains('embed-mode');

    // Lock session start time on page load to establish non-looping timeline
    const SESSION_START_TIME = Date.now() / 1000;

    function updateFallbackState() {
        if (!elements.fallback) return;

        if (isIframe) {
            elements.fallback.classList.add('hidden');
            return;
        }

        const isPlaying = activeVideo && 
                          !activeVideo.paused && 
                          !activeVideo.ended && 
                          activeVideo.readyState >= 2;

        if (isPlaying) {
            elements.fallback.classList.add('hidden');
        } else {
            if (currentScheduleItem) {
                if (elements.fallbackTitle) {
                    elements.fallbackTitle.textContent = currentScheduleItem.title;
                }
                if (elements.fallbackBadge) {
                    elements.fallbackBadge.innerHTML = activeVideo.paused 
                        ? '<span class="dot"></span> Playback Paused' 
                        : '<span class="dot"></span> Signal Standby';
                }
                if (elements.fallbackSubtext) {
                    elements.fallbackSubtext.textContent = activeVideo.paused 
                        ? 'Press play to resume live stream broadcast' 
                        : 'Connecting to linear broadcast transmission...';
                }
            } else {
                if (elements.fallbackTitle) {
                    elements.fallbackTitle.textContent = 'Broadcast Finished';
                }
                if (elements.fallbackBadge) {
                    elements.fallbackBadge.innerHTML = '<span class="dot"></span> Off-Air';
                }
                if (elements.fallbackSubtext) {
                    elements.fallbackSubtext.textContent = 'No active broadcast scheduled';
                }
            }
            elements.fallback.classList.remove('hidden');
        }
    }

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

    /**
     * NON-LOOPING SCHEDULE CALCULATOR
     * Plays items linearly starting from SESSION_START_TIME without cycling back to start.
     */
    function buildScheduleFromSimplePlaylist(playlist) {
        if (!playlist || !playlist.length) return [];
        
        let accumulatedTime = SESSION_START_TIME;

        return playlist.map((item, index) => {
            const itemStartTime = accumulatedTime;
            accumulatedTime += item.duration;
            const itemEndTime = accumulatedTime;

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
        
        // Returns null if sequence end is reached (No loop reset)
        return match || null;
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
        updateFallbackState();
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
        
        // Handle end of transmission (Playlist ended)
        if (!targetProgram) {
            if (currentScheduleItem) {
                currentScheduleItem = null;
                destroyPlayer();
                if (elements.nowTitle) elements.nowTitle.textContent = 'Off Air';
                renderScheduleUI();
                updateFallbackState();
            }
            return;
        }

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
        } else {
            if (elements.statusText) elements.statusText.textContent = 'Broadcast Offline';
            if (elements.statusOffset) elements.statusOffset.textContent = '';
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
        videoEl.onwaiting = () => {
            showLoader(true);
            updateFallbackState();
        };

        videoEl.onplaying = () => {
            showLoader(false);
            showError(null);
            if (elements.btnPlay) elements.btnPlay.textContent = '⏸';
            resetControlsTimeout();
            updateFallbackState();
        };

        videoEl.oncanplay = () => {
            if (!videoEl.paused) {
                showLoader(false);
            }
            updateFallbackState();
        };

        videoEl.onpause = () => {
            if (elements.btnPlay) elements.btnPlay.textContent = '▶';
            clearTimeout(hideControlsTimeout);
            if (elements.container) elements.container.classList.remove('controls-hidden');
            updateFallbackState();
        };

        videoEl.onended = () => updateFallbackState();
        videoEl.onerror = () => updateFallbackState();
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
                updateFallbackState();
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
    evaluateScheduleSync();

    autoSyncTimer = setInterval(evaluateScheduleSync, 1000);
    progressTimer = setInterval(() => {
        updateProgress();
        updateFallbackState();
    }, 250);
}
