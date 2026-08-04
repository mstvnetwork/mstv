import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/live/:id.m3u8', async (req, res) => {
    const channelId = req.params.id;
    const targetUrl = `https://playyonogames.in/sliv/stream.php?e=.m3u8&id=${channelId}`;

    try {
        const streamResp = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://playyonogames.in/'
            }
        });

        if (!streamResp.ok) return res.status(streamResp.status).send('Stream Offline');

        let bodyText = await streamResp.text();

        const host = req.get('host');
        const protocol = req.protocol;
        const baseUrl = `${protocol}://${host}`;

        bodyText = bodyText.replace(/stream\.php\?/g, `${baseUrl}/segment?target=${encodeURIComponent('https://playyonogames.in/sliv/stream.php?')}`);

        res.setHeader('Access-Control-Allow-Origin', '*');
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
        const segResp = await fetch(segmentUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://playyonogames.in/'
            }
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        segResp.body.pipe(res);
    } catch (err) {
        res.status(500).send('Segment Relay Error');
    }
});

app.listen(PORT, () => console.log(`Free Relay Server running on port ${PORT}`));
