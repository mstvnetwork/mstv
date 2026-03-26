const fs = require('fs');

// 1. Load your channels
const channels = JSON.parse(fs.readFileSync('./channels.json', 'utf8'));
const baseUrl = 'https://mstvnet.netlify.app';

// 2. Start the XML structure
let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <priority>1.0</priority>
  </url>`;

// 3. Generate slugs exactly like your site does
channels.forEach(ch => {
  const slug = ch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  xml += `
  <url>
    <loc>${baseUrl}/${slug}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
});

xml += '\n</urlset>';

// 4. Write the file to your root directory
fs.writeFileSync('./sitemap.xml', xml);
console.log('✅ SEO Sitemap generated for Netlify deploy!');
