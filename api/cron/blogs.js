const { sendJson, handleCors, bearerToken } = require('../../lib/vercelApi');
const { getSiteUrl, putPost, getPost } = require('../../lib/blogs');
const { hasKvEnv } = require('../../lib/storage');
const { intervalDays, startDateAligned, sequenceForDate, scheduledMeta } = require('../../lib/blogSchedule');
const { generateBlogPost } = require('../../lib/aiBlog');

function nowIso() {
  return new Date().toISOString();
}

async function isAuthorized(req) {
  // If this request was triggered by Vercel Cron, it includes a header.
  const cronHeader = req.headers?.['x-vercel-cron'];
  if (cronHeader) return true;

  const adminToken = process.env.ADMIN_TOKEN || '';
  if (!adminToken) return true;

  const token = bearerToken(req) || (req.url ? new URL(req.url, 'http://localhost').searchParams.get('token') : '') || '';
  return token === adminToken;
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;
  if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const okAuth = await isAuthorized(req);
  if (!okAuth) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  if (!hasKvEnv()) {
    // If KV isn't configured, don't generate placeholders.
    return sendJson(res, 200, { ok: true, skipped: true, reason: 'kv_not_configured' });
  }

  const siteUrl = getSiteUrl(req);
  const stepDays = intervalDays();
  const start = startDateAligned({ years: 2, stepDays });

  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  const seq = sequenceForDate(today, { start, stepDays });
  const meta = scheduledMeta({ sequence: seq, publishedAt: today.toISOString(), stepDays, start });

  // If we already generated this scheduled post, skip so cron doesn't burn AI credits.
  const existing = await getPost(meta.slug);
  if (existing && existing.slug === meta.slug) {
    return sendJson(res, 200, {
      ok: true,
      skipped: true,
      reason: 'already_generated',
      slug: meta.slug,
      url: `${siteUrl}/blogs/${meta.slug}`,
      schedule: { stepDays, start: start.toISOString() },
    });
  }

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

  if (!gen.ok) return sendJson(res, 503, { ok: false, error: 'ai_failed', detail: gen.error, slug: meta.slug });

  const post = {
    ...gen.data,
    slug: meta.slug,
    title: meta.title,
    excerpt: meta.excerpt,
    publishedAt: meta.publishedAt,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  const stored = await putPost(post);
  if (!stored) return sendJson(res, 503, { ok: false, error: 'kv_store_failed', slug: meta.slug });

  return sendJson(res, 200, { ok: true, stored: true, slug: meta.slug, url: `${siteUrl}/blogs/${meta.slug}`, schedule: { stepDays, start: start.toISOString() } });
};
