const fs = require('fs');
const path = require('path');

// 1. SETTINGS
const DOMAIN = "https://mstvnet.netlify.app"; 

// 2. LOAD DATA
const channels = JSON.parse(fs.readFileSync('./channels.json', 'utf8'));

// 3. SETUP FOLDER (Clean & Recreate)
const pagesDir = path.join(__dirname, 'channels_pages');

if (fs.existsSync(pagesDir)) {
    fs.rmSync(pagesDir, { recursive: true, force: true });
}
fs.mkdirSync(pagesDir);

// Helper to make URLs clean: "9x Jalwa " -> "9x-jalwa"
const getSlug = (text) => text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-');

// Helper to fix the "EntityRef" error by escaping special characters for XML
const escapeXml = (unsafe) => {
    return unsafe.replace(/[<>&"']/g, (m) => {
        switch (m) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '"': return '&quot;';
            case "'": return '&apos;';
            default: return m;
        }
    });
};

let sitemapEntries = [`    <url><loc>${DOMAIN}/</loc></url>`];

// 4. GENERATE INDIVIDUAL SEO PAGES
channels.forEach(ch => {
    const slug = getSlug(ch.name);
    const fileName = `${slug}.html`;
    
    const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Watch ${ch.name} Live Stream | MSTV Network</title>
    <meta name="description" content="Watch ${ch.name} live online in HD. High quality TV streaming on MSTV.">
    <style>
        body { font-family: sans-serif; text-align: center; background: #111; color: white; padding: 20px; }
        .player-btn { background: #e50914; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 20px; font-weight: bold; }
        img { border-radius: 10px; margin-bottom: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
    </style>
</head>
<body>
    <img src="${ch.logo}" alt="${ch.name} logo" width="150">
    <h1>${ch.name} Live</h1>
    <p>You are viewing the SEO preview for ${ch.name}.</p>
    <a href="/?ch=${slug}" class="player-btn">OPEN IN LIVE PLAYER</a>
    <p><br><a href="/" style="color: #888;">View All Channels</a></p>
</body>
</html>`;

    fs.writeFileSync(path.join(pagesDir, fileName), htmlTemplate);
    
    // Use escapeXml on the URL to prevent "EntityRef" errors in Google Search Console
    const safeUrl = escapeXml(`${DOMAIN}/channels_pages/${fileName}`);
    sitemapEntries.push(`    <url><loc>${safeUrl}</loc></url>`);
});

// 5. SAVE SITEMAP.XML
// The xmlns MUST use http:// and match this exact string
const sitemapContent = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries.join('\n')}
</urlset>`;

// .trim() is essential to ensure NO hidden spaces or lines appear before the <?xml tag
fs.writeFileSync('./sitemap.xml', sitemapContent.trim());
console.log(`✅ Success: ${channels.length} pages built & Sitemap updated!`);
