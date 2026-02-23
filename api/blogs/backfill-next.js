const { sendJson, handleCors, bearerToken, readJson } = require('../../lib/vercelApi');
const { getSiteUrl } = require('../../lib/blogs');
const { startDateAligned, intervalDays, yearsBack, dateForSequence, sequenceForDate, scheduledMeta } = require('../../lib/blogSchedule');

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
  const years = Math.max(1, Math.min(10, Number(payload?.years || yearsBack())));
  const stepDays = Math.max(1, Math.min(14, Number(payload?.stepDays || intervalDays())));
  const cursorIso = String(payload?.cursor || '').trim();

  const start = startDateAligned({ years, stepDays });
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);

  let cursor = cursorIso ? new Date(cursorIso) : start;
  if (Number.isNaN(cursor.getTime())) cursor = start;
  cursor.setUTCHours(12, 0, 0, 0);

  if (cursor.getTime() > today.getTime()) {
    return sendJson(res, 200, { ok: true, done: true, nextCursor: cursor.toISOString() });
  }

  const seq = sequenceForDate(cursor, { start, stepDays });
  const meta = scheduledMeta({ sequence: seq, publishedAt: cursor.toISOString(), stepDays, start });

  const siteUrl = getSiteUrl(req);
  const warmUrl = `${siteUrl}/blogs/${meta.slug}`;
  const r = await fetch(warmUrl, { method: 'GET', headers: { 'User-Agent': 'PureStay-Blog-Backfill-Warmer' } }).catch(() => null);
  if (!r || !r.ok) {
    return sendJson(res, 503, { ok: false, error: 'warm_failed', slug: meta.slug, url: warmUrl });
  }

  // Move cursor forward by stepDays.
  const next = new Date(cursor);
  next.setUTCDate(next.getUTCDate() + stepDays);

  return sendJson(res, 200, {
    ok: true,
    done: next.getTime() > today.getTime(),
    warmed: true,
    slug: meta.slug,
    url: warmUrl,
    nextCursor: next.toISOString(),
    schedule: { years, stepDays, start: start.toISOString() },
    ...(auth.warning ? { warning: auth.warning } : {}),
  });
};
