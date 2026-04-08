const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');
const { getLogTail } = require('../../lib/storage');
const { upsertEventSurveyDistribution } = require('../../lib/portalFoundation');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function normalizeAudience(v) {
  const s = cleanStr(v, 40).toLowerCase();
  if (s === 'client') return 'client';
  return 'resident';
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
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  if (!hasRole(s.profile, ['event_coordinator', 'account_manager', 'manager'])) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const url = new URL(req.url || '/api/portal/event_feedback', 'http://localhost');

  if (req.method === 'GET') {
    const eventId = clampInt(url.searchParams.get('eventId') || url.searchParams.get('event_id'), 1, 1e12, null);
    const audience = normalizeAudience(url.searchParams.get('audience'));
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const keys = [`portal:event_feedback:${eventId}:${audience}`];
    if (audience === 'resident') keys.push(`portal:event_feedback:${eventId}`);
    const lists = await Promise.all(keys.map((key) => getLogTail(key, 500).catch(() => [])));
    const entries = lists.flat();
    const summary = summarize(entries);

    return sendJson(res, 200, { ok: true, eventId, audience, summary });
  }

  if (!hasRole(s.profile, ['event_coordinator', 'manager'])) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const eventId = clampInt(body.eventId, 1, 1e12, null);
  const audience = normalizeAudience(body.audience);
  if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

  const keys = [`portal:event_feedback:${eventId}:${audience}`];
  if (audience === 'resident') keys.push(`portal:event_feedback:${eventId}`);
  const lists = await Promise.all(keys.map((key) => getLogTail(key, 500).catch(() => [])));
  const entries = lists.flat();
  const summary = summarize(entries);

  const result = await upsertEventSurveyDistribution(s.sbAdmin, {
    eventId,
    distributionChannel: cleanStr(body.distributionChannel, 80) || 'link',
    surveyLink: cleanStr(body.surveyLink, 2000),
    recipientGroup: audience,
    status: cleanStr(body.status, 40) || (cleanStr(body.surveyLink, 2000) ? 'sent' : 'draft'),
    sentAt: cleanStr(body.sentAt, 80) || (cleanStr(body.surveyLink, 2000) ? new Date().toISOString() : ''),
    responseCount: summary.count,
    completionRate: body.completionRate != null ? body.completionRate : null,
    meta: Object.assign({}, body.meta && typeof body.meta === 'object' ? body.meta : {}, {
      audience,
      histogram: summary.histogram,
      avgRating: summary.avgRating,
      commentsPreview: summary.comments.slice(0, 5),
    }),
  });
  if (!result.ok) return sendJson(res, 500, { ok: false, error: result.error, detail: result.detail || '' });

  return sendJson(res, 200, {
    ok: true,
    eventId,
    audience,
    summary,
    surveyDistribution: result.surveyDistribution || null,
  });
};
