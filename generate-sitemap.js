/**
 * generate-sitemap.js
 * ════════════════════════════════════════════════════════
 * Generates:
 *   1. /channels_pages/<slug>.html  — individual SEO page per channel
 *   2. /sitemap.xml                 — full sitemap pointing to CF domain
 *
 * USAGE:
 *   node generate-sitemap.js
 *
 * Run locally before pushing, OR let Netlify/CF run it automatically:
 *   netlify.toml  → command = "node generate-sitemap.js"
 *   CF Pages      → Build command: node generate-sitemap.js
 *
 * ⚠️  IMPORTANT: Set CANONICAL_DOMAIN to your Cloudflare domain.
 *     Netlify is a redirect host — sitemap must point to CF only.
 * ════════════════════════════════════════════════════════
 */

const fs   = require('fs');
const path = require('path');

// ── 1. SETTINGS ─────────────────────────────────────────
// Set this to your Cloudflare Pages URL (or custom domain if you have one)
const CANONICAL_DOMAIN = "https://crickethd.pages.dev";

// The channels JSON file (relative to this script)
const CHANNELS_FILE = './channels2.json';

// Output folder for SEO pages
const PAGES_DIR = path.join(__dirname, 'channels_pages');

// ── 2. LOAD CHANNELS ────────────────────────────────────
if (!fs.existsSync(CHANNELS_FILE)) {
  console.error(`❌ Error: ${CHANNELS_FILE} not found.`);
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
} catch (e) {
  console.error('❌ Error: channels2.json is not valid JSON.', e.message);
  process.exit(1);
}

// Accept array or { channels: [] }
const channels = Array.isArray(raw) ? raw : (raw.channels || []);
const valid = channels.filter(ch => ch && ch.name && ch.url);

if (!valid.length) {
  console.error('❌ No valid channels found in channels2.json');
  process.exit(1);
}

// ── 3. HELPERS ───────────────────────────────────────────

/** Convert channel name to a clean URL slug */
const getSlug = (text) =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')       // remove special chars
    .replace(/[\s_|]+/g, '-')       // spaces/pipes → dash
    .replace(/-{2,}/g, '-')         // collapse double dashes
    .replace(/^-|-$/g, '');         // trim leading/trailing dashes

/** Escape XML special characters to prevent sitemap errors */
const escapeXml = (str) =>
  String(str).replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  }[c]));

/** Escape HTML attribute values */
const escapeHtml = (str) =>
  String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

// ── 4. CLEAN & RECREATE OUTPUT FOLDER ───────────────────
if (fs.existsSync(PAGES_DIR)) {
  fs.rmSync(PAGES_DIR, { recursive: true, force: true });
}
fs.mkdirSync(PAGES_DIR);

// ── 5. GENERATE SEO PAGES ───────────────────────────────
const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
const sitemapEntries = [];

// Homepage entry
sitemapEntries.push(
  `  <url>\n    <loc>${CANONICAL_DOMAIN}/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n    <lastmod>${today}</lastmod>\n  </url>`
);

const slugMap = {}; // track duplicate slugs

valid.forEach((ch) => {
  let slug = getSlug(ch.name);

  // Handle duplicate slugs (e.g. two channels with same name)
  if (slugMap[slug] !== undefined) {
    slugMap[slug]++;
    slug = `${slug}-${slugMap[slug]}`;
  } else {
    slugMap[slug] = 0;
  }

  const fileName  = `${slug}.html`;
  const pageUrl   = `${CANONICAL_DOMAIN}/channels_pages/${fileName}`;
  const safeUrl   = escapeXml(pageUrl);
  const safeName  = escapeHtml(ch.name);
  const safeLogo  = escapeHtml(ch.logo || '');
  const typeLabel = (ch.type || 'hls').toUpperCase();

  // ── Individual SEO landing page ──
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Watch ${safeName} Live Stream | MSTV Network</title>
  <meta name="description" content="Watch ${safeName} live online in HD. High quality ${typeLabel} TV streaming on MSTV Network." />
  <meta property="og:title" content="${safeName} Live Stream | MSTV Network" />
  <meta property="og:description" content="Stream ${safeName} live in HD on MSTV Network." />
  <meta property="og:image" content="${safeLogo}" />
  <meta property="og:url" content="${escapeHtml(pageUrl)}" />
  <meta property="og:type" content="website" />
  <link rel="canonical" href="${escapeHtml(pageUrl)}" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', sans-serif;
      background: #07070d;
      color: #e8e8f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      text-align: center;
    }
    .card {
      background: #13131f;
      border: 1px solid #1e1e30;
      border-radius: 16px;
      padding: 40px 32px;
      max-width: 420px;
      width: 100%;
    }
    .logo-wrap {
      width: 120px; height: 120px;
      background: #0f0f1a;
      border-radius: 12px;
      border: 1px solid #1e1e30;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      overflow: hidden;
    }
    .logo-wrap img {
      max-width: 90%; max-height: 90%;
      object-fit: contain;
    }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
    .type-badge {
      display: inline-block;
      font-size: 11px;
      font-family: monospace;
      color: #f4a227;
      border: 1px solid rgba(244,162,39,.3);
      padding: 3px 10px;
      border-radius: 20px;
      margin-bottom: 20px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    p { color: #6b6b8a; font-size: 14px; line-height: 1.6; margin-bottom: 28px; }
    .watch-btn {
      display: inline-block;
      background: #e5383b;
      color: #fff;
      text-decoration: none;
      padding: 14px 32px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 15px;
      transition: background .2s, transform .1s;
      margin-bottom: 20px;
    }
    .watch-btn:hover { background: #ff6b6b; transform: translateY(-1px); }
    .back-link {
      color: #6b6b8a;
      text-decoration: none;
      font-size: 13px;
      transition: color .2s;
    }
    .back-link:hover { color: #e8e8f0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo-wrap">
      <img src="${safeLogo}" alt="${safeName} logo" width="100" height="100" loading="lazy"
           onerror="this.style.display='none'" />
    </div>
    <h1>${safeName}</h1>
    <div class="type-badge">${typeLabel} · Live</div>
    <p>Stream ${safeName} live in HD on MSTV Network. Click below to open in the full player.</p>
    <a href="/?ch=${encodeURIComponent(slug)}" class="watch-btn">▶ Watch Live</a>
    <br />
    <a href="/" class="back-link">← Back to All Channels</a>
  </div>
</body>
</html>`;

  fs.writeFileSync(path.join(PAGES_DIR, fileName), htmlContent, 'utf8');

  // Sitemap entry
  sitemapEntries.push(
    `  <url>\n    <loc>${safeUrl}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n    <lastmod>${today}</lastmod>\n  </url>`
  );
});

// ── 6. WRITE SITEMAP.XML ─────────────────────────────────
const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries.join('\n')}
</urlset>`.trim();

fs.writeFileSync('./sitemap.xml', sitemapXml, 'utf8');

// ── 7. DONE ──────────────────────────────────────────────
console.log(`✅ Done!`);
console.log(`   📄 ${valid.length} SEO pages → /channels_pages/`);
console.log(`   🗺  sitemap.xml updated (${sitemapEntries.length} URLs)`);
console.log(`   🌐 Canonical domain: ${CANONICAL_DOMAIN}`);
