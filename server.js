import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/live/:id.m3u8', async (req, res) => {
    const channelId = req.params.id;
    // Trying the updated endpoint format
    const targetUrl = `https://playyonogames.in/sliv/stream.php?e=.m3u8&id=${channelId}`;

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://playyonogames.in/',
                'Origin': 'https://playyonogames.in'
            }
        });

        const status = response.status;
        const text = await response.text();

        // Output raw HTTP response as Plain Text so mobile browser won't launch a video player
        res.setHeader('Content-Type', 'text/plain');
        res.send(`=== HTTP STATUS: ${status} ===\n\n=== RAW RESPONSE BODY ===\n${text}`);
    } catch (err) {
        res.setHeader('Content-Type', 'text/plain');
        res.status(500).send(`FETCH ERROR: ${err.message}`);
    }
});

app.listen(PORT, () => console.log(`Diagnostic Server Live`));
