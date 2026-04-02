// 2. LOAD DATA - Updated to your new filename
const channels = JSON.parse(fs.readFileSync('./channels2.json', 'utf8'));

// ... (helpers remain the same) ...

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
    <meta name="description" content="Watch ${ch.name} live online in HD.">
    <style>
        body { font-family: sans-serif; text-align: center; background: #111; color: white; padding: 20px; }
        .player-btn { background: #e50914; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 20px; font-weight: bold; }
        /* Small CSS tweak to prevent layout shift (Good for Speed Score) */
        .logo-box { min-height: 150px; display: flex; align-items: center; justify-content: center; }
        img { border-radius: 10px; margin-bottom: 20px; max-width: 150px; height: auto; }
    </style>
</head>
<body>
    <div class="logo-box">
        <img src="${ch.logo}" alt="${ch.name} logo" width="150" height="150" loading="lazy">
    </div>
    <h1>${ch.name} Live</h1>
    <p>You are viewing the SEO preview for ${ch.name}.</p>
    <a href="/?ch=${slug}" class="player-btn">OPEN IN LIVE PLAYER</a>
    <p><br><a href="/" style="color: #888;">View All Channels</a></p>
</body>
</html>`;

    fs.writeFileSync(path.join(pagesDir, fileName), htmlTemplate);
    
    const safeUrl = escapeXml(`${DOMAIN}/channels_pages/${fileName}`);
    sitemapEntries.push(`    <url><loc>${safeUrl}</loc></url>`);
});
