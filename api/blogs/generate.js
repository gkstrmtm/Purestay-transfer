const { sendJson, handleCors, bearerToken, readJson } = require('../../lib/vercelApi');
const { getSiteUrl } = require('../../lib/blogs');
const { scheduledMeta, intervalDays, startDateAligned, sequenceForDate } = require('../../lib/blogSchedule');

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

  const payload = await readJson(req);
  const publishedAt = String(payload?.publishedAt || '').trim() || nowIso();

  const siteUrl = getSiteUrl(req);
  const stepDays = intervalDays();
  const start = startDateAligned({ years: 2, stepDays });
  const seq = sequenceForDate(new Date(publishedAt), { start, stepDays });
  const meta = scheduledMeta({ sequence: seq, publishedAt: new Date(publishedAt).toISOString(), stepDays, start });

  // Warm the cached HTML page at /blogs/:slug (the rewrite points to api/blogs/page)
  const warmUrl = `${siteUrl}/blogs/${meta.slug}`;
  const r = await fetch(warmUrl, { method: 'GET', headers: { 'User-Agent': 'PureStay-Blog-Warmer' } }).catch(() => null);
  if (!r || !r.ok) {
    return sendJson(res, 503, { ok: false, error: 'warm_failed', slug: meta.slug, url: warmUrl });
  }

  return sendJson(res, 200, { ok: true, mode: 'scheduled', warmed: true, slug: meta.slug, url: warmUrl, ...(auth.warning ? { warning: auth.warning } : {}) });
};
