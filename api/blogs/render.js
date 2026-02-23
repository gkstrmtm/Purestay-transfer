const { sendJson, handleCors } = require('../../lib/vercelApi');
const { getSiteUrl } = require('../../lib/blogs');
const { parseDateFromSlug, intervalDays, startDateAligned, sequenceForDate, scheduledMeta } = require('../../lib/blogSchedule');
const { generateBlogPost } = require('../../lib/aiBlog');

function wordStats(html) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;
  return { wordCount: words, readingMinutes: Math.max(3, Math.round(words / 220)) };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const url = new URL(req.url || '/', 'http://localhost');
  const slug = String(url.searchParams.get('slug') || '').trim();
  if (!slug) return sendJson(res, 400, { ok: false, error: 'missing_slug' });

  const siteUrl = getSiteUrl(req);
  const date = parseDateFromSlug(slug) || new Date();

  const stepDays = intervalDays();
  const start = startDateAligned({ years: 2, stepDays });
  const seq = sequenceForDate(date, { start, stepDays });
  const meta = scheduledMeta({ sequence: seq, publishedAt: date.toISOString(), stepDays, start });

  const gen = await generateBlogPost({
    sequence: seq,
    publishedAt: meta.publishedAt,
    siteUrl,
    forced: {
      title: meta.title,
      slug: meta.slug,
      topic: meta.topic,
      primaryKeyword: meta.topic,
    },
  });

  if (!gen.ok) return sendJson(res, 503, { ok: false, error: gen.error || 'ai_failed' });

  const stats = wordStats(gen.data.html);
  return sendJson(res, 200, {
    ok: true,
    mode: 'scheduled',
    post: {
      title: gen.data.title,
      slug: meta.slug,
      excerpt: gen.data.excerpt || meta.excerpt,
      metaDescription: gen.data.metaDescription,
      primaryKeyword: gen.data.primaryKeyword || meta.topic,
      keywords: gen.data.keywords || [],
      tags: gen.data.tags || [],
      html: gen.data.html,
      faq: gen.data.faq || [],
      publishedAt: meta.publishedAt,
      updatedAt: meta.publishedAt,
      wordCount: stats.wordCount,
      readingMinutes: stats.readingMinutes,
    },
  });
};
