/**
 * Production-Grade Broadcast Synchronized TV Player Controller
 * Features: Double-Buffered Seamless Transitions, Fixed Sync Math, Drift Correction,
 *           Live Playlist Polling, Automatic MP4 Fallback
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
    // Config can override this via config.fallbackUrl / config.playlistUrl /
    // config.playlistPollMs; sane defaults are provided below.
    const FALLBACK_MP4_URL = config.fallbackVideoUrl || config.fallbackUrl || 'https://files.catbox.moe/c9z1wf.mp4';
    const PLAYLIST_URL = config.playlistUrl || null; // e.g. '/api/playlist.json'
    const PLAYLIST_POLL_MS = config.playlistPollMs || 15000;
    const STUCK_WATCHDOG_MS = config.stuckWatchdogMs || 12000; // no progress => assume dead

    let isFallbackActive = false;
    let lastPlaylistFingerprint = null;
    let lastProgressTimestamp = 0;
    let lastKnownCurrentTime = -1;

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

    // ---- Live playlist polling ------------------------------------------
    // This is the actual fix for "playlist changes don't show up without a
    // refresh". Previously rawPlaylist was set once at init from a static
    // array and NEVER updated again — evaluateScheduleSync() only recomputes
    // start/end times off that same frozen array. Now we periodically fetch
    // the playlist source and, if it actually changed, swap it in.

    function fingerprintPlaylist(playlist) {
        try {
            return JSON.stringify(playlist.map(p => [p.title, p.duration, p.url, p.type]));
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
        if (fingerprint === lastPlaylistFingerprint) return; // no real change, skip

        lastPlaylistFingerprint = fingerprint;
        rawPlaylist = fresh;

        // Drop any stale preload built against the old playlist so the next
        // evaluateScheduleSync() tick re-evaluates cleanly against new data.
        preloadedScheduleItem = null;
        if (hiddenHls) { hiddenHls.destroy(); hiddenHls = null; }

        // Force re-selection of the current program even if the id would
        // otherwise coincidentally match, by clearing currentScheduleItem
        // only when the *content* at "now" actually differs.
        const recalculated = getCurrentProgram();
        if (!currentScheduleItem || !recalculated || recalculated.url !== currentScheduleItem.url) {
            currentScheduleItem = null; // triggers playMedia() on next tick
        }

        console.info('Playlist updated from remote source, applying live.');
    }

    function startPlaylistPolling() {
        if (!PLAYLIST_URL) return; // no remote source configured, static playlist only
        lastPlaylistFingerprint = fingerprintPlaylist(rawPlaylist);
        playlistPollTimer = setInterval(pollPlaylistForChanges, PLAYLIST_POLL_MS);
    }

    // ---- MP4 fallback logic ---------------------------------------------
    // Triggers when: (a) the schedule is empty, (b) a source errors out via
    // native <video> error event or hls.js fatal error, or (c) playback
    // appears stuck (currentTime not advancing) for STUCK_WATCHDOG_MS.

    function buildFallbackProgram() {
        return {
            id: 'fallback_placeholder',
            title: 'Programming will resume shortly',
            startTime: Date.now() / 1000,
            endTime: Date.now() / 1000 + 1e9, // effectively open-ended
            duration: 1e9,
            url: FALLBACK_MP4_URL,
            type: 'mp4',
            isIframe: false
        };
    }

    function activateFallback(reason) {
        if (isFallbackActive) return;
        isFallbackActive = true;
        console.warn('Activating MP4 fallback:', reason);

        currentScheduleItem = buildFallbackProgram();
        preloadedScheduleItem = null;
        if (elements.nowTitle) elements.nowTitle.textContent = currentScheduleItem.title;
        showError(null);

        isIframe = false;
        elements.iframe.style.display = 'none';
        setupVideoSource(activeVideo, currentScheduleItem, false, /* isFallback */ true);
    }

    function tryDeactivateFallback() {
        // Called on the next schedule sync tick; if a real program is
        // available again, evaluateScheduleSync()'s normal id-diff logic
        // will naturally take over because currentScheduleItem.id is
        // 'fallback_placeholder', which never matches a real program id.
        isFallbackActive = false;
    }

    function armStuckWatchdog() {
        clearTimeout(stuckWatchdogTimer);
        if (isFallbackActive || isIframe) return;
        lastProgressTimestamp = Date.now();
        lastKnownCurrentTime = activeVideo.currentTime;

        stuckWatchdogTimer = setInterval(() => {
            if (isFallbackActive || isIframe || !currentScheduleItem) return;
            if (activeVideo.paused) return; // user-paused, not a failure

            if (activeVideo.currentTime === lastKnownCurrentTime) {
                if (Date.now() - lastProgressTimestamp > STUCK_WATCHDOG_MS) {
                    activateFallback('playback stalled (no currentTime progress)');
                }
            } else {
                lastKnownCurrentTime = activeVideo.currentTime;
                lastProgressTimestamp = Date.now();
            }
        }, 3000);
    }

    function preloadNextStream() {
        if (isFallbackActive) return; // don't preload while riding the fallback
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
            hiddenHls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    console.warn('Preload of next stream failed fatally; will fall back live if it becomes current.');
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
                    activateFallback('fatal HLS error: ' + data.type);
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
            // Native <video> element error (covers plain mp4/dead URLs too,
            // not just hls.js-managed sources).
            targetVideo.onerror = () => {
                if (!isFallback) {
                    console.error('Video element error, activating fallback.');
                    activateFallback('video element error');
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
        // No playlist at all (e.g. still loading, or remote fetch returned
        // nothing usable) -> go straight to fallback rather than sitting on
        // a blank player.
        if (!rawPlaylist.length) {
            activateFallback('empty playlist');
            return;
        }

        const targetProgram = getCurrentProgram();
        if (!targetProgram) {
            activateFallback('no matching program in schedule');
            return;
        }

        // Real content is available again — drop fallback state so normal
        // id-diff logic below picks it up as "new" content.
        if (isFallbackActive) {
            tryDeactivateFallback();
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
        // Static fallback/default list used until the first successful
        // remote poll (if PLAYLIST_URL is configured). Edit this, or better,
        // point config.playlistUrl at a JSON endpoint your CMS updates.
        return [
            {
                "title": "Apna Tv Stream - Part 04",
                "duration":,
                "url":"",
                "type": "m3u8"
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
