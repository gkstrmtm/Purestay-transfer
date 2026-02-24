const { listPosts, getSiteUrl } = require('../lib/blogs');
const { hasStorageEnv } = require('../lib/storage');
const { listScheduled } = require('../lib/blogSchedule');

function sendXml(res, status, xml) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.end(xml);
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function iso(d) {
  try { return new Date(d).toISOString(); } catch { return ''; }
}

module.exports = async (req, res) => {
  const siteUrl = getSiteUrl(req);
  let posts = [];
  if (hasStorageEnv()) {
    const data = await listPosts({ limit: 500, offset: 0 });
    posts = data.posts || [];
  }

  const staticUrls = [
    { loc: `${siteUrl}/`, lastmod: '' },
    { loc: `${siteUrl}/discovery`, lastmod: '' },
    { loc: `${siteUrl}/core`, lastmod: '' },
    { loc: `${siteUrl}/culture-shift`, lastmod: '' },
    { loc: `${siteUrl}/signature-stay`, lastmod: '' },
    { loc: `${siteUrl}/blogs`, lastmod: '' },
    { loc: `${siteUrl}/privacy`, lastmod: '' },
    { loc: `${siteUrl}/terms`, lastmod: '' },
  ];

  const blogUrls = posts.map((p) => ({
    loc: `${siteUrl}/blogs/${p.slug}`,
    lastmod: p.publishedAt ? iso(p.publishedAt) : '',
  }));

  const urls = [...staticUrls, ...blogUrls];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => {
  const lm = u.lastmod ? `<lastmod>${escapeXml(u.lastmod)}</lastmod>` : '';
  return `  <url><loc>${escapeXml(u.loc)}</loc>${lm}</url>`;
}).join('\n')}
</urlset>`;

  return sendXml(res, 200, xml);
};
