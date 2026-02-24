const { sendJson, handleCors, bearerToken, readJson } = require('../../lib/vercelApi');
const { getSiteUrl, putPost } = require('../../lib/blogs');
const { hasKvEnv } = require('../../lib/storage');
const { startDateAligned, intervalDays, yearsBack, sequenceForDate, scheduledMeta } = require('../../lib/blogSchedule');
const { generateBlogPost } = require('../../lib/aiBlog');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function parseDateOnly(s) {
  const raw = String(s || '').trim();
  if (!raw) return null;
  // Expect YYYY-MM-DD
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

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

  const years = clampInt(payload?.years, 1, 10, yearsBack());
  const stepDays = clampInt(payload?.stepDays, 1, 14, intervalDays());
  const batchSize = clampInt(payload?.batchSize, 1, 5, 1);

  const startDateInput = parseDateOnly(payload?.startDate);
  const endDateInput = parseDateOnly(payload?.endDate);

  // Default range: last N years to today
  const defaultStart = startDateAligned({ years, stepDays });
  const start = startDateInput || defaultStart;

  const endDefault = new Date();
  endDefault.setUTCHours(12, 0, 0, 0);
  const end = endDateInput || endDefault;

  // Cursor: where to start generating from.
  const cursorIso = String(payload?.cursor || '').trim();
  let cursor = cursorIso ? new Date(cursorIso) : start;
  if (Number.isNaN(cursor.getTime())) cursor = start;
  cursor.setUTCHours(12, 0, 0, 0);

  if (cursor.getTime() > end.getTime()) {
    return sendJson(res, 200, { ok: true, done: true, nextCursor: cursor.toISOString(), range: { start: start.toISOString(), end: end.toISOString(), stepDays } });
  }

  const siteUrl = getSiteUrl(req);
  const generated = [];

  for (let i = 0; i < batchSize; i += 1) {
    if (cursor.getTime() > end.getTime()) break;

    const seq = sequenceForDate(cursor, { start, stepDays });
    const meta = scheduledMeta({ sequence: seq, publishedAt: cursor.toISOString(), stepDays, start });

    // Generate via AI
    // eslint-disable-next-line no-await-in-loop
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
      return sendJson(res, 503, { ok: false, error: 'ai_failed', detail: gen.error, slug: meta.slug, generated });
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

    // eslint-disable-next-line no-await-in-loop
    const stored = await putPost(post);
    if (!stored) {
      return sendJson(res, 503, { ok: false, error: 'kv_store_failed', slug: meta.slug, generated });
    }

    generated.push({ slug: meta.slug, url: `${siteUrl}/blogs/${meta.slug}`, publishedAt: meta.publishedAt });

    cursor = new Date(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + stepDays);
    cursor.setUTCHours(12, 0, 0, 0);
  }

  return sendJson(res, 200, {
    ok: true,
    done: cursor.getTime() > end.getTime(),
    generated,
    nextCursor: cursor.toISOString(),
    range: { start: start.toISOString(), end: end.toISOString(), stepDays },
    ...(auth.warning ? { warning: auth.warning } : {}),
  });
};
