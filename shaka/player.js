// Sample linear TV schedule. Replace URLs and times with your actual content.
// "start" must be a UTC ISO string. "duration" is in seconds.
const SAMPLE_SCHEDULE = [
    {
        title: "Big Buck Bunny (HLS Stream)",
        type: "hls",
        url: "https://mux.dev",
        start: "2026-01-01T00:00:00Z", 
        duration: 600 // 10 minutes
    },
    {
        title: "Sintel (MP4 fallback)",
        type: "mp4",
        url: "https://googleapis.com",
        start: "2026-01-01T00:10:00Z",
        duration: 318 // 5.3 minutes
    }
];

let hlsInstance = null;

function initPlayer(config) {
    const video = document.getElementById(config.videoId);
    const iframe = document.getElementById(config.iframeId);
    const loader = document.getElementById(config.loaderId);
    const errorMsg = document.getElementById(config.errorId);
    const btnPlay = document.getElementById(config.btnPlayId);
    const volSlider = document.getElementById(config.volSliderId);
    const progressFill = document.getElementById(config.progressFillId);
    const scheduleList = document.getElementById(config.scheduleListId);
    const syncToast = document.getElementById(config.syncToastId);
    const nowTitle = document.getElementById(config.nowTitleId);
    const statusText = document.getElementById(config.statusTextId);
    const statusOffset = document.getElementById(config.statusOffsetId);
    const volOverlay = document.getElementById(config.volOverlayId);

    let currentItem = null;
    let isMutedByUser = false;

    // 1. Digital Clock System
    if (config.showClock) {
        setInterval(() => {
            const now = new Date();
            document.getElementById(config.clockId).innerText = now.toLocaleTimeString();
            document.getElementById(config.clockDateId).innerText = now.toLocaleDateString();
        }, 1000);
    }

    // 2. Generate Loopable Schedule dynamically if old
    const schedule = generateLoopingSchedule(SAMPLE_SCHEDULE);

    // 3. Render Schedule UI Layout
    renderScheduleUI(schedule, scheduleList);

    // 4. Core Core Synchronization Loop
    function syncToLinearTimeline() {
        const nowMs = Date.now();
        let activeItem = null;
        let seekOffsetSeconds = 0;

        for (let item of schedule) {
            const startMs = new Date(item.start).getTime();
            const endMs = startMs + (item.duration * 1000);

            if (nowMs >= startMs && nowMs < endMs) {
                activeItem = item;
                seekOffsetSeconds = (nowMs - startMs) / 1000;
                break;
            }
        }

        if (!activeItem) {
            nowTitle.innerText = "Off-Air / Intermission";
            video.style.display = "none";
            iframe.style.display = "none";
            loader.classList.add("hidden");
            return;
        }

        // Handle item transition
        if (!currentItem || currentItem.url !== activeItem.url) {
            currentItem = activeItem;
            nowTitle.innerText = `Playing Now: ${currentItem.title}`;
            highlightActiveScheduleUI(schedule, currentItem);
            loadMediaSource(currentItem, seekOffsetSeconds);
        } else {
            // Guard against drifted tabs or pausing: Enforce sync drift boundary
            if (currentItem.type !== 'iframe' && Math.abs(video.currentTime - seekOffsetSeconds) > 3) {
                video.currentTime = seekOffsetSeconds;
                showToast(syncToast);
            }
        }

        // Update technical status displays
        if (currentItem.type !== 'iframe') {
            const pct = (video.currentTime / video.duration) * 100 || 0;
            progressFill.style.width = `${pct}%`;
            statusText.innerText = `Source type: ${currentItem.type.toUpperCase()}`;
            statusOffset.innerText = `Current Seek Offset: ${Math.floor(seekOffsetSeconds)}s / ${currentItem.duration}s`;
        }
    }

    // 5. Media Source Handlers (HLS, HTML5 Video, iframe)
    function loadMediaSource(item, offset) {
        loader.classList.remove("hidden");
        errorMsg.classList.remove("show");

        if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
        }

        if (item.type === 'iframe') {
            video.style.display = "none";
            iframe.style.display = "block";
            volOverlay.style.display = "block";
            // Check if YouTube link to inject timestamp variables automatically
            let embedUrl = item.url;
            if (embedUrl.includes("youtube.com") || embedUrl.includes("youtu.be")) {
                embedUrl += (embedUrl.includes("?") ? "&" : "?") + `autoplay=1&start=${Math.floor(offset)}`;
            }
            iframe.src = embedUrl;
            loader.classList.add("hidden");
        } else {
            iframe.style.display = "none";
            video.style.display = "block";
            volOverlay.style.display = "none";

            if (item.type === 'hls' && Hls.isSupported()) {
                hlsInstance = new Hls();
                hlsInstance.loadSource(item.url);
                hlsInstance.attachMedia(video);
                hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
                    video.currentTime = offset;
                    video.play().catch(handleAutoplayBlock);
                });
            } else {
                video.src = item.url;
                video.addEventListener('loadedmetadata', () => {
                    video.currentTime = offset;
                    video.play().catch(handleAutoplayBlock);
                }, { once: true });
            }
        }
    }

    // 6. User Event Controls
    btnPlay.addEventListener("click", () => {
        if (video.paused) {
            syncToLinearTimeline(); 
            video.play();
            btnPlay.innerText = "⏸";
        } else {
            video.pause();
            btnPlay.innerText = "▶";
        }
    });

    volSlider.addEventListener("input", (e) => {
        video.volume = e.target.value;
        video.muted = (video.volume === 0);
    });

    video.addEventListener("play", () => btnPlay.innerText = "⏸");
    video.addEventListener("pause", () => btnPlay.innerText = "▶");
    video.addEventListener("playing", () => loader.classList.add("hidden"));
    video.addEventListener("waiting", () => loader.classList.remove("hidden"));
    video.addEventListener("error", () => errorMsg.classList.add("show"));

    function handleAutoplayBlock() {
        video.muted = true; // Browsers block sound on auto-load
        video.play();
        btnPlay.innerText = "⏸";
        statusText.innerText = "Playback started muted. Click anywhere or adjust slider to unmute.";
    }

    // Run synchronization calculation loop every 2 seconds
    setInterval(syncToLinearTimeline, 2000);
    syncToLinearTimeline();
}

// Helper: Ensure the schedule never expires by looping it over today's date
function generateLoopingSchedule(baseSchedule) {
    const now = new Date();
    const startOfTodayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0);
    
    let totalScheduleDuration = 0;
    baseSchedule.forEach(item => totalScheduleDuration += item.duration);

    const msPassedToday = Date.now() - startOfTodayMs;
    const currentLoopIteration = Math.floor(msPassedToday / (totalScheduleDuration * 1000));
    let runningTimelineMs = startOfTodayMs + (currentLoopIteration * totalScheduleDuration * 1000);

    return baseSchedule.map(item => {
        const itemStart = new Date(runningTimelineMs).toISOString();
        runningTimelineMs += (item.duration * 1000);
        return { ...item, start: itemStart };
    });
}

function renderScheduleUI(schedule, container) {
    container.innerHTML = "";
    schedule.forEach((item, index) => {
        const div = document.createElement("div");
        div.className = "schedule-item";
        div.id = `sched-${index}`;
        const startTimeStr = new Date(item.start).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        div.innerHTML = `<strong>${startTimeStr}</strong> - ${item.title} (${item.duration}s)`;
        container.appendChild(div);
    });
}

function highlightActiveScheduleUI(schedule, activeItem) {
    document.querySelectorAll(".schedule-item").forEach(el => el.classList.remove("active"));
    const matchIndex = schedule.findIndex(item => item.url === activeItem.url && item.start === activeItem.start);
    if (matchIndex !== -1) {
        const targetEl = document.getElementById(`sched-${matchIndex}`);
        if (targetEl) {
            targetEl.classList.add("active");
            targetEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
    }
}

function showToast(el) {
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2500);
}
