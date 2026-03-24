// uploadChannels.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const GITHUB_USER = 'mstvnetwork';
const REPO = 'mstv';
const BRANCH = 'main';
const TOKEN = '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'; // must have repo permissions

// Path to channels JSON
const CHANNELS_JSON = path.join(__dirname, 'channels2.json');

// Utility: slugify names for file paths
function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Generate SEO HTML for a channel
function generateSEOHtml(ch, index) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Watch ${ch.name} Live Stream</title>
<meta name="description" content="Watch ${ch.name} live stream online in HD.">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body{margin:0;background:#111;color:#fff;font-family:Arial}
iframe{width:100%;height:60vh;border:none}
h1{padding:10px}
p{padding:10px;color:#ccc}
</style>
</head>
<body>
<h1>${ch.name} Live Stream</h1>
<iframe src="../index.html?=${index}" allowfullscreen></iframe>
<p>Watch ${ch.name} live stream online in HD. Enjoy streaming anytime.</p>
</body>
</html>`;
}

// Upload a file to GitHub repo
async function uploadFileToGitHub(filePath, content) {
    const apiUrl = `https://api.github.com/repos/${GITHUB_USER}/${REPO}/contents/${filePath}`;

    let sha = null;
    try {
        // Check if file exists
        const res = await axios.get(apiUrl, {
            headers: { Authorization: `token ${TOKEN}` }
        });
        if (res.data.sha) sha = res.data.sha;
    } catch (err) {
        // File does not exist → create new
    }

    // Upload / update file
    await axios.put(apiUrl, {
        message: `Add/update ${filePath}`,
        content: Buffer.from(content).toString('base64'),
        branch: BRANCH,
        sha: sha
    }, {
        headers: { Authorization: `token ${TOKEN}` }
    });

    console.log(`Uploaded: ${filePath}`);
}

// Main function
async function main() {
    const channels = JSON.parse(fs.readFileSync(CHANNELS_JSON, 'utf8'));

    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        const slug = slugify(ch.name);
        const html = generateSEOHtml(ch, i);
        await uploadFileToGitHub(`channels/${slug}.html`, html);
    }

    console.log('All pages uploaded successfully!');
}

main().catch(err => console.error(err));
