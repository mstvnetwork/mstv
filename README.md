# MSTV Network — Streaming Portal

Single-page live TV site. Plays HLS, DASH, and iframe channels from `channels2.json`. Real-time updates without page refresh. SEO pages auto-generated per channel. Works identically on Netlify and Cloudflare Pages.

---

## Final Repo Structure

```
/
├── index.html              ← Main streaming page (player + channel grid)
├── channels2.json          ← Your channel list — edit this to add/remove channels
├── generate-sitemap.js     ← Run to generate SEO pages + sitemap.xml
├── sitemap.xml             ← Auto-generated (commit after running script)
├── robots.txt              ← One file, works on both platforms
│
├── _redirects              ← ONE file for BOTH Netlify + Cloudflare Pages
├── _headers                ← ONE file for BOTH platforms (cache + security)
├── netlify.toml            ← Netlify-only config (CF ignores it)
│
└── channels_pages/         ← Auto-generated SEO pages (commit after running script)
    ├── b4u-movies.html
    ├── sony-tv.html
    └── ...
```

> **No separate cf/ folder needed.** `_redirects` and `_headers` use the same format
> on both platforms. The rule in `_redirects` only fires on the Netlify host, so
> Cloudflare reads the file but skips the redirect rule and serves normally.

---

## One-Time Setup

### 1. Set your Cloudflare domain

Replace `mstvnet.pages.dev` in these 3 files with your actual CF Pages URL:
- `_redirects`
- `netlify.toml`
- `robots.txt`
- `generate-sitemap.js` → `CANONICAL_DOMAIN`

### 2. Run the sitemap generator

```bash
node generate-sitemap.js
```

This creates `/channels_pages/*.html` and `sitemap.xml`. Commit them.

### 3. Connect Cloudflare Pages

- Cloudflare Dashboard → Pages → Create project → Connect GitHub repo
- Build command: `node generate-sitemap.js`
- Output directory: `.` (root)

### 4. Netlify (existing)

No changes needed. It picks up `netlify.toml` automatically and 301-redirects
all traffic to your Cloudflare URL.

---

## Real-Time Channel Updates

The page polls `channels2.json` every **15 seconds** using a hash-change detector.
When you push an update to the repo and it deploys (~20–30s), viewers see a toast
notification and the channel list refreshes automatically — no page reload.

To change the poll interval, edit `index.html`:
```js
const POLL_INTERVAL = 15000; // milliseconds
```

---

## channels2.json Format

```json
[
  { "name": "Channel Name", "url": "https://…/stream.m3u8", "type": "hls",    "logo": "https://…/logo.webp" },
  { "name": "Channel Name", "url": "https://…/stream.mpd",  "type": "dash",   "logo": "https://…/logo.webp" },
  { "name": "Channel Name", "url": "https://…/player.html", "type": "iframe", "logo": "https://…/logo.webp" }
]
```

Supported types: `hls` · `dash` · `iframe`

---

## SEO Deep Links

Each channel gets a standalone SEO page at `/channels_pages/<slug>.html`.
Clicking "Watch Live" opens the main player with that channel pre-loaded via `/?ch=<slug>`.
