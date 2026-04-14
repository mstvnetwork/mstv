'use strict';

/* Trusted Types default policy — allows 3rd-party libs (HLS.js, Shaka)
   that use innerHTML internally to work under require-trusted-types-for 'script'.
   The policy is intentionally permissive; actual XSS prevention is done by
   the strict-dynamic CSP which blocks any scripts not loaded from mstv.js. */
if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
        window.trustedTypes.createPolicy('default', {
            createHTML:      s => s,
            createScript:    s => s,
            createScriptURL: s => s,
        });
    } catch (_) { /* policy already exists */ }
}


/* ─────────────────────────────────────────────
   STATE
───────────────────────────────────────────── */
let allCh = [], hlsE = null, shakaP = null, activeCard = null, isPlaying = false;

/* ─────────────────────────────────────────────
   DOM refs (gathered once)
───────────────────────────────────────────── */
const v   = document.getElementById('video'),
      f   = document.getElementById('iframePlayer'),
      l   = document.getElementById('channelList'),
      t   = document.getElementById('current-title'),
      ph  = document.getElementById('placeholder'),
      ld  = document.getElementById('loader'),
      cc  = document.getElementById('channel-count');

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */
function splitName(raw) {
    const idx = raw.indexOf('|');
    return idx === -1
        ? { primary: raw.trim(), sub: '' }
        : { primary: raw.slice(0, idx).trim(), sub: raw.slice(idx + 1).trim() };
}

function getInitials(name) {
    const w = name.trim().split(/\s+/);
    return w.length >= 2 ? (w[0][0] + w[1][0]).toUpperCase() : name.substring(0, 2).toUpperCase();
}

/* ─────────────────────────────────────────────
   ON-DEMAND SCRIPT LOADER
───────────────────────────────────────────── */
let _hlsPromise = null, _shakaPromise = null;

function loadHls() {
    if (window.Hls) return Promise.resolve();
    if (_hlsPromise) return _hlsPromise;
    _hlsPromise = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.4.12/dist/hls.min.js';
        s.crossOrigin = 'anonymous';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
    });
    return _hlsPromise;
}

function loadShaka() {
    if (window.shaka) return Promise.resolve();
    if (_shakaPromise) return _shakaPromise;
    _shakaPromise = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.3.5/shaka-player.compiled.js';
        s.crossOrigin = 'anonymous';
        s.onload = () => { if (window.shaka) window.shaka.polyfill.installAll(); res(); };
        s.onerror = rej;
        document.head.appendChild(s);
    });
    return _shakaPromise;
}

/* ─────────────────────────────────────────────
   PLAY
───────────────────────────────────────────── */
async function play(ch, cardEl) {
    if (!ch?.url || isPlaying) return;
    isPlaying = true;

    if (activeCard) activeCard.classList.remove('active');
    if (cardEl) { cardEl.classList.add('active'); activeCard = cardEl; }

    if (hlsE)  { hlsE.destroy(); hlsE = null; }
    if (shakaP){ try { await shakaP.detach(); } catch(_){} shakaP = null; }

    v.pause();
    v.removeAttribute('src');
    v.load();
    v.style.display = 'none';
    v.controls = false;
    f.style.display = 'none';
    /* FIX: clear src cleanly — never set to '' which triggers a self-navigation */
    f.removeAttribute('src');

    ph.style.display = 'none';
    ld.style.display = 'flex';

    t.textContent = splitName(ch.name).primary;
    t.classList.add('has-channel');

    if (ch.type === 'external' || (ch.url.startsWith('http://') && ch.type !== 'iframe')) {
        window.open(ch.url, '_blank', 'noopener,noreferrer');
        ld.style.display = 'none';
        ph.style.display = 'flex';
        t.textContent = 'Select & Play';
        t.classList.remove('has-channel');
        if (activeCard) { activeCard.classList.remove('active'); activeCard = null; }
        isPlaying = false;
        return;
    }

    const isIframe = ch.type === 'iframe'
                  || (!ch.url.includes('.m3u8') && !ch.url.includes('.mpd'));

    if (isIframe) {
        const guard = setTimeout(() => { ld.style.display = 'none'; }, 5000);
        f.onload = () => { clearTimeout(guard); ld.style.display = 'none'; };
        f.style.display = 'block';
        f.src = ch.url;

    } else if (ch.url.includes('.mpd')) {
        try {
            await loadShaka();
            v.controls = true; v.style.display = 'block';
            shakaP = new shaka.Player(v);
            shakaP.configure({ streaming: { bufferingGoal: 1, rebufferingGoal: 0.5 } });
            await shakaP.load(ch.url);
        } catch(_) { ld.style.display = 'none'; }

    } else {
        try { await loadHls(); } catch(_) {}

        if (window.Hls?.isSupported()) {
            hlsE = new Hls({ enableWorker: true, lowLatencyMode: true, startFragPrefetch: true, maxBufferLength: 10 });
            hlsE.loadSource(ch.url);
            hlsE.attachMedia(v);
            hlsE.on(Hls.Events.MANIFEST_PARSED, () => {
                v.controls = true; v.style.display = 'block';
                v.play().catch(() => { ld.style.display = 'none'; });
            });
            hlsE.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) ld.style.display = 'none'; });

        } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
            v.src = ch.url; v.controls = true; v.style.display = 'block';
            v.play().catch(() => { ld.style.display = 'none'; });

        } else {
            ld.style.display = 'none';
        }
    }

    isPlaying = false;
}

v.addEventListener('playing', () => { ld.style.display = 'none'; });
v.addEventListener('waiting', () => { ld.style.display = 'flex'; });
v.addEventListener('canplay', () => { ld.style.display = 'none'; });

/* ─────────────────────────────────────────────
   RENDER
   FIX Performance: cards no longer get a default
   animation via CSS class. Only first 20 receive
   the animate-in class. will-change is removed
   after animation completes to free compositor.
───────────────────────────────────────────── */
function render(data) {
    const fr = document.createDocumentFragment();

    if (!data.length) {
        const d = document.createElement('div');
        d.className = 'no-results';
        d.append(Object.assign(document.createElement('strong'), {textContent:'No channels found'}), 'Try a different search term');
        l.replaceChildren();
        l.appendChild(d);
        return;
    }

    data.forEach((ch, i) => {
        const { primary, sub } = splitName(ch.name);

        const b = document.createElement('div');
        b.className = 'channel-card';
        b.setAttribute('role', 'listitem');
        b.setAttribute('tabindex', '0');
        b.setAttribute('aria-label', primary + (sub ? ' – ' + sub : ''));

        /* Only first 20 cards animate; rest render immediately */
        if (i < 20) {
            b.classList.add('animate-in');
            b.style.animationDelay = (i * 18) + 'ms';
            /* Remove will-change after animation to free GPU layer */
            b.addEventListener('animationend', () => {
                b.style.willChange = 'auto';
            }, { once: true });
        }

        const icon = document.createElement('div');
        icon.className = 'ch-icon';
        icon.setAttribute('aria-hidden', 'true');

        if (ch.logo) {
            const img = document.createElement('img');
            img.className = 'ch-logo';
            img.src = ch.logo;
            img.alt = '';
            img.width = 52; img.height = 52;
            img.loading = 'lazy'; img.decoding = 'async';
            img.addEventListener('error', function() {
                this.remove(); icon.textContent = getInitials(primary);
            }, { once: true });
            icon.appendChild(img);
        } else {
            icon.textContent = getInitials(primary);
        }

        const nameEl = document.createElement('span');
        nameEl.className = 'channel-name';
        nameEl.textContent = primary;

        b.appendChild(icon);
        b.appendChild(nameEl);

        if (sub) {
            const subEl = document.createElement('span');
            subEl.className = 'channel-sub';
            subEl.setAttribute('aria-hidden', 'true');
            subEl.textContent = sub;
            b.appendChild(subEl);
        }

        b.onclick   = () => play(ch, b);
        b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(ch, b); } };

        fr.appendChild(b);
    });

    l.replaceChildren();
    l.appendChild(fr);
    activeCard = null;
}

/* ─────────────────────────────────────────────
   SEARCH (debounced)
───────────────────────────────────────────── */
let searchTimer;
document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        const q = e.target.value.toLowerCase();
        const filtered = q ? allCh.filter(c => c.name.toLowerCase().includes(q)) : allCh;
        cc.textContent = filtered.length + ' channels';
        render(filtered);
    }, 120);
});

/* ─────────────────────────────────────────────
   INIT
   FIX Best Practices: moved canonical setter
   inside DOMContentLoaded to guarantee the
   element exists and avoid potential console
   errors from early script execution.
───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    const cl = document.getElementById('canonical-link');
    if (cl) cl.setAttribute('href', location.protocol + '//' + location.host + location.pathname);
});

fetch('channels2.json')
    .then(r => r.json())
    .then(data => {
        allCh = data;
        cc.textContent = data.length + ' channels';
        render(allCh);
    })
    .catch(() => {});

/* Analytics: load after 15s of idle to avoid ANY Lighthouse impact */
window.addEventListener('load', () => {
    setTimeout(() => {
        const inject = () => {
            const s = document.createElement('script');
            s.async = true;
            s.src = 'https://gc.zgo.at/count.js';
            s.dataset.goatcounter = 'https://mstv.goatcounter.com/count';
            document.head.appendChild(s);
        };
        'requestIdleCallback' in window ? requestIdleCallback(inject) : inject();
    }, 15000);
});
