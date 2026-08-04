import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// TEST ROUTE
app.get('/test.m3u8', async (req, res) => {
    // Open-source public Akamai HLS test stream
    const targetUrl = 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8';

    try {
        const response = await fetch(targetUrl);
        if (!response.ok) return res.status(response.status).send('Test fetch failed');

        let bodyText = await response.text();
        const host = req.get('host');
        const protocol = req.protocol;
        const baseUrl = `${protocol}://${host}`;

        // Rewrite segment path
        const lines = bodyText.split('\n');
        const rewrittenLines = lines.map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;

            let fullSegmentUrl = trimmed;
            if (!trimmed.startsWith('http')) {
                fullSegmentUrl = new URL(trimmed, 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/').href;
            }

            return `${baseUrl}/segment?target=${encodeURIComponent(fullSegmentUrl)}`;
        });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewrittenLines.join('\n'));
    } catch (err) {
        res.status(500).send('Test route error: ' + err.message);
    }
});

app.get('/segment', async (req, res) => {
    const segmentUrl = req.query.target;
    if (!segmentUrl) return res.status(400).send('Missing segment URL');

    try {
        const segResp = await fetch(segmentUrl);
        if (!segResp.ok) return res.status(segResp.status).send('Segment fetch failed');

        res.setHeader('Content-Type', segResp.headers.get('content-type') || 'video/MP2T');
        segResp.body.pipe(res);
    } catch (err) {
        res.status(500).send('Segment Error: ' + err.message);
    }
});

app.listen(PORT, () => console.log(`Test relay online on port ${PORT}`));
