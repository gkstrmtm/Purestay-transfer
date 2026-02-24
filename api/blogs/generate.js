const { sendJson, handleCors, bearerToken, readJson } = require('../../lib/vercelApi');
const { getSiteUrl, putPost } = require('../../lib/blogs');
const { hasKvEnv } = require('../../lib/storage');
const { scheduledMeta, intervalDays, startDateAligned, sequenceForDate } = require('../../lib/blogSchedule');
const { generateBlogPost } = require('../../lib/aiBlog');

function nowIso() {
  return new Date().toISOString();
}

async function requireAdminIfConfigured(req) {
  const adminToken = process.env.ADMIN_TOKEN || '';
  if (!adminToken) return { ok: true, warning: 'unprotected' };

  const token = bearerToken(req) || (req.url ? new URL(req.url, 'http://localhost').searchParams.get('token') : '') || '';
  if (token !== adminToken) return { ok: false };
  return { ok: true };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const auth = await requireAdminIfConfigured(req);
  if (!auth.ok) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  if (!hasKvEnv()) {
    return sendJson(res, 400, { ok: false, error: 'kv_required' });
  }

  const payload = await readJson(req);
  const publishedAt = String(payload?.publishedAt || '').trim() || nowIso();

  const siteUrl = getSiteUrl(req);
  const stepDays = intervalDays();
  const start = startDateAligned({ years: 2, stepDays });
  const seq = sequenceForDate(new Date(publishedAt), { start, stepDays });
  const meta = scheduledMeta({ sequence: seq, publishedAt: new Date(publishedAt).toISOString(), stepDays, start });

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

  if (!gen.ok) {
    return sendJson(res, 503, { ok: false, error: 'ai_failed', detail: gen.error, slug: meta.slug });
  }

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

  return sendJson(res, 200, { ok: true, stored: true, slug: meta.slug, url: `${siteUrl}/blogs/${meta.slug}`, ...(auth.warning ? { warning: auth.warning } : {}) });
};
