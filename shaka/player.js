let PLAYLIST = [];
let SCHEDULE_TIMELINE = [];
let hlsInstance = null;
let currentTrack = null;
let globalConfig = null;

const PLAYLIST_JSON_URL = "./playlist.json"; 

// Base epoch anchor string reference point
const BASE_ANCHOR_DATE = "2026-01-01T00:00:00Z";

async function fetchPlaylistUpdates() {
    try {
        const response = await fetch(`${PLAYLIST_JSON_URL}?t=${Date.now()}`);
        if (!response.ok) throw new Error("Network issues reaching source");
        
        const freshData = await response.json();
        
        // Only trigger UI repaint loops if actual structure mutations occurred
        if (JSON.stringify(freshData) !== JSON.stringify(PLAYLIST)) {
            PLAYLIST = freshData;
            generateAbsoluteTimeline();
            
            if (globalConfig && document.getElementById(globalConfig.scheduleListId)) {
                renderPlaylistUI(document.getElementById(globalConfig.scheduleListId));
                showNotificationToast(document.getElementById(globalConfig.updateToastId));
            }
        }
    } catch (err) {
        console.error("Silent sync verification log:", err);
    }
}

// Convert track raw lists into absolute time objects relative to an explicit baseline
function generateAbsoluteTimeline() {
    let runningTimelineMs = new Date(BASE_ANCHOR_DATE).getTime();
    
    SCHEDULE_TIMELINE = PLAYLIST.map(track => {
        const trackStartMs = runningTimelineMs;
        const trackEndMs = trackStartMs + (track.duration_seconds * 1000);
        runningTimelineMs = trackEndMs; // Chain link start paths
        
        return {
            ...track,
            startMs: trackStartMs,
            endMs: trackEndMs
        };
    });
}

function initPlayer(config) {
    globalConfig = config;
    
    // Background polling update sequence (runs smoothly every 30 seconds)
    setInterval(fetchPlaylistUpdates, 30000);

    fetchPlaylistUpdates().then(() => {
        const video = document.getElementById(config.videoId);
        const progressFill = document.getElementById(config.progressFillId);
        const syncToast = document.getElementById(config.syncToastId);
        const nowTitle = document.getElementById(config.nowTitleId);
        const statusText = document.getElementById(config.statusTextId);
        const statusOffset = document.getElementById(config.statusOffsetId);

        if (config.showClock) {
            setInterval(() => {
                document.getElementById(config.clockId).innerText = new Date().toLocaleTimeString();
                document.getElementById(config.clockDateId).innerText = new Date().toLocaleDateString();
            }, 1000);
        }

        function calculateLiveSyncState() {
            if (SCHEDULE_TIMELINE.length === 0) return;

            const nowMs = Date.now();
            let totalDurationMs = 0;
            PLAYLIST.forEach(t => totalDurationMs += (t.duration_seconds * 1000));

            const baseAnchorMs = new Date(BASE_ANCHOR_DATE).getTime();
            const msPassedSinceAnchor = nowMs - baseAnchorMs;
            
            // Calculate absolute looping frame boundary offset points
            const currentLoopCycleMs = msPassedSinceAnchor % totalDurationMs;
            const targetVirtualTimeMs = baseAnchorMs + currentLoopCycleMs;

            let activeTrack = null;
            let trackSeekOffset = 0;
            let activeIndex = 0;

            for (let i = 0; i < SCHEDULE_TIMELINE.length; i++) {
                const track = SCHEDULE_TIMELINE[i];
                if (targetVirtualTimeMs >= track.startMs && targetVirtualTimeMs < track.endMs) {
                    activeTrack = track;
                    trackSeekOffset = (targetVirtualTimeMs - track.startMs) / 1000;
                    activeIndex = i;
                    break;
                }
            }

            if (!activeTrack) return;

            updateUIHighlighter(activeIndex);

            if (!currentTrack || currentTrack.url !== activeTrack.url) {
                currentTrack = activeTrack;
                nowTitle.innerText = currentTrack.name;
                loadMedia(currentTrack, trackSeekOffset);
            } else {
                // Keep players aligned within a strict 4-second drift boundary window
                if (Math.abs(video.currentTime - trackSeekOffset) > 4) {
                    video.currentTime = trackSeekOffset;
                    showNotificationToast(syncToast);
                }
            }

            const pct = (video.currentTime / activeTrack.duration_seconds) * 100 || 0;
            progressFill.style.width = `${pct}%`;
            statusText.innerText = `Mode: Absolute Timeline Engine (${activeTrack.type.toUpperCase()})`;
            statusOffset.innerText = `Sync Offset: ${Math.floor(video.currentTime)}s / ${activeTrack.duration_seconds}s`;
        }

        function loadMedia(track, offset) {
            document.getElementById(config.loaderId).classList.remove("hidden");
            document.getElementById(config.errorId).classList.remove("show");

            if (hlsInstance) {
                hlsInstance.destroy();
                hlsInstance = null;
            }

            const formatType = track.type.toLowerCase();

            if (formatType === 'm3u8' || formatType === 'hls') {
                if (Hls.isSupported()) {
                    hlsInstance = new Hls();
                    hlsInstance.loadSource(track.url);
                    hlsInstance.attachMedia(video);
                    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
                        video.currentTime = offset;
                        video.play().catch(handleAutoplayBlock);
                    });
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = track.url;
                    video.addEventListener('loadedmetadata', () => {
                        video.currentTime = offset;
                        video.play().catch(handleAutoplayBlock);
                    }, { once: true });
                }
            } else {
                video.src = track.url;
                video.addEventListener('loadedmetadata', () => {
                    video.currentTime = offset;
                    video.play().catch(handleAutoplayBlock);
                }, { once: true });
            }
        }

        document.getElementById(config.btnPlayId).addEventListener("click", () => {
            if (video.paused) { calculateLiveSyncState(); video.play(); } else { video.pause(); }
        });

        document.getElementById(config.volSliderId).addEventListener("input", (e) => {
            video.volume = e.target.value;
            video.muted = (video.volume === 0);
        });

        video.addEventListener("playing", () => document.getElementById(config.loaderId).classList.add("hidden"));
        video.addEventListener("waiting", () => document.getElementById(config.loaderId).classList.remove("hidden"));
        video.addEventListener("error", () => document.getElementById(config.errorId).classList.add("show"));

        function handleAutoplayBlock() {
            video.muted = true;
            document.getElementById(config.volSliderId).value = 0;
            video.play();
        }

        setInterval(calculateLiveSyncState, 2000);
        calculateLiveSyncState();
    });
}

function renderPlaylistUI(container) {
    container.innerHTML = "";
    SCHEDULE_TIMELINE.forEach((track, index) => {
        const div = document.createElement("div");
        div.className = "schedule-item";
        div.id = `track-${index}`;
        
        // Calculate virtual layout clock paths relative to today's date mapping structure
        const itemStartClock = new Date(track.startMs).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        div.innerHTML = `Slot [${itemStartClock}]: <strong>${track.name}</strong> (${track.duration_seconds}s)`;
        container.appendChild(div);
    });
}

function updateUIHighlighter(activeIndex) {
    document.querySelectorAll(".schedule-item").forEach(el => el.classList.remove("active"));
    const activeEl = document.getElementById(`track-${activeIndex}`);
    if (activeEl) activeEl.classList.add("active");
}

function showNotificationToast(el) {
    if (!el) return;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2500);
}
