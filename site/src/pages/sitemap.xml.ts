export const GET = () => new Response(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://think.coey.dev/</loc></url>
</urlset>
`, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
