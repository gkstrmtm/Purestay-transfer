const { sendJson, handleCors, bearerToken } = require('../../lib/vercelApi');
const { getSiteUrl } = require('../../lib/blogs');
const { intervalDays, startDateAligned, sequenceForDate, scheduledMeta } = require('../../lib/blogSchedule');

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

  const siteUrl = getSiteUrl(req);
  const stepDays = intervalDays();
  const start = startDateAligned({ years: 2, stepDays });

  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  const seq = sequenceForDate(today, { start, stepDays });
  const meta = scheduledMeta({ sequence: seq, publishedAt: today.toISOString(), stepDays, start });

  const warmUrl = `${siteUrl}/blogs/${meta.slug}`;
  const r = await fetch(warmUrl, { method: 'GET', headers: { 'User-Agent': 'PureStay-Blog-Cron-Warmer' } }).catch(() => null);
  if (!r || !r.ok) return sendJson(res, 503, { ok: false, error: 'warm_failed', url: warmUrl, slug: meta.slug });

  return sendJson(res, 200, { ok: true, warmed: true, slug: meta.slug, url: warmUrl, schedule: { stepDays, start: start.toISOString() } });
};
