import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

// Set up full browser headers to avoid 403 / refused connection
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://playyonogames.in/',
    'Origin': 'https://playyonogames.in',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
};

app.get('/live/:id.m3u8', async (req, res) => {
    const channelId = req.params.id;
    const targetUrl = `https://playyonogames.in/sliv/stream.php?e=.m3u8&id=${channelId}`;

    try {
        const streamResp = await fetch(targetUrl, { headers: BROWSER_HEADERS });

        if (!streamResp.ok) {
            return res.status(streamResp.status).send(`Stream Source Error: ${streamResp.statusText}`);
        }

        let bodyText = await streamResp.text();

        // Dynamically rewrite segment links to route through Render proxy
        const host = req.get('host');
        const protocol = req.protocol;
        const baseUrl = `${protocol}://${host}`;

        bodyText = bodyText.replace(/stream\.php\?/g, `${baseUrl}/segment?target=${encodeURIComponent('https://playyonogames.in/sliv/stream.php?')}`);

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(bodyText);
    } catch (err) {
        res.status(500).send('Relay Error: ' + err.message);
    }
});

app.get('/segment', async (req, res) => {
    const segmentUrl = req.query.target;
    if (!segmentUrl) return res.status(400).send('Missing target URL');

    try {
        const segResp = await fetch(segmentUrl, { headers: BROWSER_HEADERS });

        if (!segResp.ok) {
            return res.status(segResp.status).send('Segment fetch failed');
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', segResp.headers.get('content-type') || 'video/MP2T');
        segResp.body.pipe(res);
    } catch (err) {
        res.status(500).send('Segment Relay Error');
    }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
