/**
 * Production-Grade Linear Sync & HLS Player Controller
 */

function initPlayer(config) {
    // -------------------------------------------------------------------------
    // 1. DOM Elements Reference
    // -------------------------------------------------------------------------
    const elements = {
        video: document.getElementById(config.videoId),
        iframe: document.getElementById(config.iframeId),
        loader: document.getElementById(config.loaderId),
        error: document.getElementById(config.errorId),
        btnPlay: document.getElementById(config.btnPlayId),
        volSlider: document.getElementById(config.volSliderId),
        progressFill: document.getElementById(config.progressFillId),
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

    // -------------------------------------------------------------------------
    // 2. State Management
    // -------------------------------------------------------------------------
    let hls = null;
    let currentScheduleItem = null;
    let schedule = [];
    let isLiveStream = false;
    let isIframe = false;
    let autoSyncTimer = null;
    let progressTimer = null;
    let clockTimer = null;
    let retryCount = 0;
    const MAX_RETRIES = 3;

    // -------------------------------------------------------------------------
    // 3. UI Helpers
    // -------------------------------------------------------------------------
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
        if (!el) return;
        el.classList.add('show');
        setTimeout(() => el.classList.remove('show'), 3000);
    }

    function formatTime(seconds) {
        if (isNaN(seconds) || seconds < 0) return '00:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    // -------------------------------------------------------------------------
    // 4. Live Clock & EPG Sync Logic
    // -------------------------------------------------------------------------
    function startClock() {
        if (!config.showClock) return;

        function updateClock() {
            const now = new Date();
            if (elements.clock) {
                elements.clock.textContent = now.toLocaleTimeString();
            }
            if (elements.clockDate) {
                elements.clockDate.textContent = now.toLocaleDateString();
            }
        }

        updateClock();
        clockTimer = setInterval(updateClock, 1000);
    }

    /**
     * Finds what program should be playing based on system time relative to item start/end
     */
    function getCurrentProgram() {
        if (!schedule.length) return null;
        const nowSec = Math.floor(Date.now() / 1000);

        // Find match in provided linear schedule array
        const match = schedule.find(item => nowSec >= item.startTime && nowSec < item.endTime);
        return match || schedule[schedule.length - 1]; // Fallback to last item if past schedule
    }

    function evaluateScheduleSync() {
        if (!schedule.length) return;

        const targetProgram = getCurrentProgram();
        if (!targetProgram) return;

        // Swapped to a new channel/program
        if (!currentScheduleItem || currentScheduleItem.id !== targetProgram.id) {
            currentScheduleItem = targetProgram;
            if (elements.nowTitle) elements.nowTitle.textContent = targetProgram.title;

            renderScheduleUI();
            playMedia(targetProgram);
            showToast(elements.updateToast);
        } else if (!isLiveStream && !isIframe) {
            // Check drift for static files simulating live schedule offset
            const nowSec = Math.floor(Date.now() / 1000);
            const expectedOffset = nowSec - currentScheduleItem.startTime;
            const actualOffset = elements.video.currentTime;

            // If drift > 4 seconds, seek to live edge of scheduled item
            if (Math.abs(actualOffset - expectedOffset) > 4) {
                elements.video.currentTime = expectedOffset;
                showToast(elements.syncToast);
            }
        }
    }

    // -------------------------------------------------------------------------
    // 5. HLS.js Player Initialization & Error Handling
    // -------------------------------------------------------------------------
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
        showLoader(false);
    }

    function setupHlsPlayer(program) {
        isIframe = false;
        elements.iframe.style.display = 'none';
        elements.iframe.src = '';
        elements.video.style.display = 'block';
        if (elements.volOverlay) elements.volOverlay.style.display = 'none';

        destroyPlayer();

        if (Hls.isSupported()) {
            hls = new Hls({
                // Config tuned for ultra-smooth Live Sync & Low-Latency Playback
                liveSyncDurationCount: 3,        // Keep 3 segments buffered to avoid stalls
                liveMaxLatencyDurationCount: 10, // Catch up if falling too far behind
                liveDurationInfinity: true,      // Treat live stream manifests correctly
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 60,            // Garbage collection buffer management
                maxBufferLength: 30,
                maxMaxBufferLength: 60
            });

            hls.loadSource(program.url);
            hls.attachMedia(elements.video);

            hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                isLiveStream = data.levels[0]?.details?.live || false;

                // Sync static VOD item simulating a TV program to calculated target timestamp
                if (!isLiveStream && program.startTime) {
                    const nowSec = Math.floor(Date.now() / 1000);
                    const targetOffset = nowSec - program.startTime;
                    if (targetOffset > 0) {
                        elements.video.currentTime = targetOffset;
                    }
                }

                elements.video.play().catch(() => {
                    // Autoplay blocked handling: start muted
                    elements.video.muted = true;
                    elements.video.play();
                });
            });

            // Resilient Stalling & Network Error Auto-Recovery Engine
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            if (retryCount < MAX_RETRIES) {
                                retryCount++;
                                showError(`Network issue detected. Syncing... (${retryCount}/${MAX_RETRIES})`);
                                hls.startLoad();
                            } else {
                                showError('Network offline. Re-initializing playback...');
                                setTimeout(() => playMedia(program), 3000);
                            }
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            showError('Buffer failure. Recovering live frame...');
                            hls.recoverMediaError();
                            break;
                        default:
                            showError('Playback critical error. Reloading live edge...');
                            destroyPlayer();
                            setTimeout(() => playMedia(program), 2000);
                            break;
                    }
                }
            });

        } else if (elements.video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari Native HLS Support
            elements.video.src = program.url;
            elements.video.addEventListener('loadedmetadata', () => {
                elements.video.play();
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
        elements.video.style.display = 'block';
        if (elements.volOverlay) elements.volOverlay.style.display = 'none';

        destroyPlayer();
        elements.video.src = program.url;
        elements.video.play();
    }

    // -------------------------------------------------------------------------
    // 6. UI Rendering & Progress Trackers
    // -------------------------------------------------------------------------
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
            if (elements.progressFill) elements.progressFill.style.width = '100%';
            return;
        }

        if (isLiveStream) {
            if (elements.statusText) elements.statusText.textContent = 'Live Stream';
            if (elements.statusOffset) elements.statusOffset.textContent = `Latency: ${formatTime(elements.video.duration - elements.video.currentTime)}`;
            if (elements.progressFill) elements.progressFill.style.width = '100%';
        } else if (currentScheduleItem) {
            const nowSec = Math.floor(Date.now() / 1000);
            const duration = currentScheduleItem.endTime - currentScheduleItem.startTime;
            const elapsed = nowSec - currentScheduleItem.startTime;
            const pct = Math.min(Math.max((elapsed / duration) * 100, 0), 100);

            if (elements.progressFill) elements.progressFill.style.width = `${pct}%`;
            if (elements.statusText) elements.statusText.textContent = `Linear Sync: ${formatTime(elapsed)} / ${formatTime(duration)}`;
            if (elements.statusOffset) elements.statusOffset.textContent = `Offset: +${Math.round(elements.video.currentTime - elapsed)}s`;
        }
    }

    // -------------------------------------------------------------------------
    // 7. Event Listeners & Control Bindings
    // -------------------------------------------------------------------------
    function bindEvents() {
        if (elements.btnPlay) {
            elements.btnPlay.addEventListener('click', () => {
                if (elements.video.paused) {
                    elements.video.play();
                    elements.btnPlay.textContent = '⏸';
                } else {
                    elements.video.pause();
                    elements.btnPlay.textContent = '▶';
                }
            });
        }

        if (elements.volSlider) {
            elements.volSlider.addEventListener('input', (e) => {
                elements.video.volume = parseFloat(e.target.value);
                elements.video.muted = elements.video.volume === 0;
            });
        }

        elements.video.addEventListener('waiting', () => showLoader(true));
        elements.video.addEventListener('playing', () => {
            showLoader(false);
            showError(null);
            if (elements.btnPlay) elements.btnPlay.textContent = '⏸';
        });
        elements.video.addEventListener('pause', () => {
            if (elements.btnPlay) elements.btnPlay.textContent = '▶';
        });
    }

    // -------------------------------------------------------------------------
    // 8. Sample Mock Schedule Generator & Startup
    // -------------------------------------------------------------------------
    function generateMockSchedule() {
        const now = Math.floor(Date.now() / 1000);
        return [
            {
                id: 'ch1',
                title: 'Tears of Steel (HLS Demo Stream)',
                startTime: now - 60,
                endTime: now + 300,
                url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
            },
            {
                id: 'ch2',
                title: 'Big Buck Bunny (Live Feed)',
                startTime: now + 300,
                endTime: now + 900,
                url: 'https://test-streams.mux.dev/x36xhzz/url_0/1920x1080/2000/index.m3u8'
            }
        ];
    }

    // Startup Execution
    schedule = generateMockSchedule();
    bindEvents();
    startClock();
    evaluateScheduleSync();

    // Check Live Schedule alignment every 3 seconds
    autoSyncTimer = setInterval(evaluateScheduleSync, 3000);
    
    // Update Progress Bars every 500ms
    progressTimer = setInterval(updateProgress, 500);
                }
