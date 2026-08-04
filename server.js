import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

// Allow CORS for all origins
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://playyonogames.in/',
    'Origin': 'https://playyonogames.in',
    'Accept': '*/*'
};

app.get('/live/:id.m3u8', async (req, res) => {
    const channelId = req.params.id;
    const targetUrl = `https://playyonogames.in/sliv/stream.php?e=.m3u8&id=${channelId}`;

    try {
        const response = await fetch(targetUrl, { headers: HEADERS });

        if (!response.ok) {
            return res.status(response.status).send(`Origin Error: HTTP ${response.status}`);
        }

        let bodyText = await response.text();

        const host = req.get('host');
        const protocol = req.protocol;
        const baseUrl = `${protocol}://${host}`;
        const streamOriginBase = 'https://playyonogames.in/sliv/';

        // Parse playlist lines and rewrite relative segment URLs to route back through Render
        const lines = bodyText.split('\n');
        const rewrittenLines = lines.map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;

            let fullSegmentUrl = trimmed;
            if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
                fullSegmentUrl = new URL(trimmed, streamOriginBase).href;
            }

            return `${baseUrl}/segment?target=${encodeURIComponent(fullSegmentUrl)}`;
        });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewrittenLines.join('\n'));
    } catch (err) {
        res.status(500).send('Relay Error: ' + err.message);
    }
});

app.get('/segment', async (req, res) => {
    const segmentUrl = req.query.target;
    if (!segmentUrl) return res.status(400).send('Missing segment target URL');

    try {
        const segResp = await fetch(segmentUrl, { headers: HEADERS });

        if (!segResp.ok) {
            return res.status(segResp.status).send(`Segment Fetch Failed: HTTP ${segResp.status}`);
        }

        res.setHeader('Content-Type', segResp.headers.get('content-type') || 'video/MP2T');
        segResp.body.pipe(res);
    } catch (err) {
        res.status(500).send('Segment Proxy Error: ' + err.message);
    }
});

app.listen(PORT, () => console.log(`Stream relay running on port ${PORT}`));
