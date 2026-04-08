const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, isManager } = require('../../lib/portalAuth');
const { getState, listPosts, getSiteUrl, putPost, deleteAllPosts } = require('../../lib/blogs');
const { hasKvEnv, hasSupabaseEnv, hasStorageEnv } = require('../../lib/storage');
const { startDateAligned, intervalDays, yearsBack, sequenceForDate, scheduledMeta } = require('../../lib/blogSchedule');
const { generateBlogPost } = require('../../lib/aiBlog');

function canManageAdmin(s) {
  return isManager(s.realProfile || s.profile) && !s.viewAsRole && !s.viewAsUserId;
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function parseDateOnly(s) {
  const raw = String(s || '').trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function nowIso() {
  return new Date().toISOString();
}

async function getStatus() {
  if (!hasStorageEnv()) {
    return {
      ok: true,
      mode: 'disabled',
      reason: 'storage_required',
      latest: null,
      total: 0,
    };
  }

  const state = await getState();
  const listing = await listPosts({ limit: 1, offset: 0 });
  return {
    ok: true,
    mode: hasSupabaseEnv() ? 'supabase' : (hasKvEnv() ? 'kv' : 'unknown'),
    state,
    latest: listing.posts?.[0] || null,
    total: listing.total || 0,
  };
}

async function generateOne(req, payload) {
  if (!hasStorageEnv()) {
    return { ok: false, status: 400, error: 'storage_required', hint: 'Configure Supabase or Vercel KV to persist posts.' };
  }

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

  if (!gen.ok) return { ok: false, status: 503, error: 'ai_failed', detail: gen.error, slug: meta.slug };

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
  if (!stored) return { ok: false, status: 503, error: 'store_failed', slug: meta.slug };

  return { ok: true, stored: true, slug: meta.slug, url: `${siteUrl}/blogs/${meta.slug}` };
}

async function backfillNext(req, payload) {
  if (!hasStorageEnv()) {
    return { ok: false, status: 400, error: 'storage_required', hint: 'Configure Supabase or Vercel KV to persist posts.' };
  }

  const years = clampInt(payload?.years, 1, 10, yearsBack());
  const stepDays = clampInt(payload?.stepDays, 1, 14, intervalDays());
  const batchSize = clampInt(payload?.batchSize, 1, 5, 1);
  const startDateInput = parseDateOnly(payload?.startDate);
  const endDateInput = parseDateOnly(payload?.endDate);

  const defaultStart = startDateAligned({ years, stepDays });
  const start = startDateInput || defaultStart;

  const endDefault = new Date();
  endDefault.setUTCHours(12, 0, 0, 0);
  const end = endDateInput || endDefault;

  const cursorIso = String(payload?.cursor || '').trim();
  let cursor = cursorIso ? new Date(cursorIso) : start;
  if (Number.isNaN(cursor.getTime())) cursor = start;
  cursor.setUTCHours(12, 0, 0, 0);

  if (cursor.getTime() > end.getTime()) {
    return {
      ok: true,
      done: true,
      nextCursor: cursor.toISOString(),
      range: { start: start.toISOString(), end: end.toISOString(), stepDays },
    };
  }

  const siteUrl = getSiteUrl(req);
  const generated = [];

  for (let i = 0; i < batchSize; i += 1) {
    if (cursor.getTime() > end.getTime()) break;

    const seq = sequenceForDate(cursor, { start, stepDays });
    const meta = scheduledMeta({ sequence: seq, publishedAt: cursor.toISOString(), stepDays, start });

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
      return { ok: false, status: 503, error: 'ai_failed', detail: gen.error, slug: meta.slug, generated };
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
      return { ok: false, status: 503, error: 'store_failed', slug: meta.slug, generated };
    }

    generated.push({ slug: meta.slug, url: `${siteUrl}/blogs/${meta.slug}`, publishedAt: meta.publishedAt });

    cursor = new Date(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + stepDays);
    cursor.setUTCHours(12, 0, 0, 0);
  }

  return {
    ok: true,
    done: cursor.getTime() > end.getTime(),
    generated,
    nextCursor: cursor.toISOString(),
    range: { start: start.toISOString(), end: end.toISOString(), stepDays },
  };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!canManageAdmin(s)) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  if (req.method === 'GET') {
    const status = await getStatus();
    return sendJson(res, 200, status);
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const action = String(body.action || '').trim();
    if (!action) return sendJson(res, 422, { ok: false, error: 'missing_action' });

    if (action === 'generate') {
      const out = await generateOne(req, body);
      return sendJson(res, out.status || 200, out);
    }

    if (action === 'backfill_next') {
      const out = await backfillNext(req, body);
      return sendJson(res, out.status || 200, out);
    }

    if (action === 'delete_all') {
      if (!hasStorageEnv()) {
        return sendJson(res, 400, { ok: false, error: 'storage_required', hint: 'Configure Supabase or Vercel KV to delete persisted posts.' });
      }
      const r = await deleteAllPosts();
      return sendJson(res, 200, { ok: true, deleted: r.deleted || 0 });
    }

    return sendJson(res, 422, { ok: false, error: 'unknown_action' });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
