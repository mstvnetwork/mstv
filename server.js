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

// Guaranteed working Apple demo stream
const STREAM_URL = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8';

app.get('/test.m3u8', async (req, res) => {
    try {
        const response = await fetch(STREAM_URL);
        if (!response.ok) return res.status(response.status).send('Stream error');

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        response.body.pipe(res);
    } catch (err) {
        res.status(500).send('Proxy Error: ' + err.message);
    }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
