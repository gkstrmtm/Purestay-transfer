const { sendJson, handleCors } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');
const { getLogTail } = require('../../lib/storage');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function summarize(entries) {
  const items = Array.isArray(entries) ? entries : [];
  const hist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  let count = 0;

  const comments = [];
  for (const it of items) {
    const rating = Number(it?.rating);
    if (rating >= 1 && rating <= 5) {
      hist[String(rating)] += 1;
      sum += rating;
      count += 1;
    }

    const comment = cleanStr(it?.comment, 2000);
    const name = cleanStr(it?.name, 80);
    if (comment) {
      comments.push({
        ts: cleanStr(it?.ts, 40),
        rating: (rating >= 1 && rating <= 5) ? rating : null,
        name: name || null,
        comment,
      });
    }
  }

  const avg = count ? (sum / count) : null;
  return {
    count,
    avgRating: avg == null ? null : Math.round(avg * 100) / 100,
    histogram: hist,
    comments: comments.slice(0, 40),
  };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  if (!hasRole(s.profile, ['event_coordinator', 'account_manager', 'manager'])) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const url = new URL(req.url || '/api/portal/event_feedback', 'http://localhost');
  const eventId = clampInt(url.searchParams.get('eventId') || url.searchParams.get('event_id'), 1, 1e12, null);
  if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

  const listKey = `portal:event_feedback:${eventId}`;
  const entries = await getLogTail(listKey, 500);
  const summary = summarize(entries);

  return sendJson(res, 200, { ok: true, eventId, summary });
};
