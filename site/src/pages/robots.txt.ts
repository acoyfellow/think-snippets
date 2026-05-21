export const GET = () => new Response('User-agent: *\nAllow: /\nSitemap: https://think.coey.dev/sitemap.xml\n', {
  headers: { 'content-type': 'text/plain; charset=utf-8' },
});
