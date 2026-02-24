const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, isManager } = require('../../lib/portalAuth');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function countLines(s) {
  return String(s || '').split(/\r?\n/).filter((l) => l.trim()).length;
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const url = new URL(req.url || '/api/portal/docs', 'http://localhost');

  if (req.method === 'GET') {
    const audienceRole = cleanStr(url.searchParams.get('audienceRole'), 40);
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);

    let query = s.sbAdmin
      .from('portal_docs')
      .select('*')
      .order('id', { ascending: false })
      .limit(limit);

    if (!isManager(s.profile)) {
      query = query.or(`audience_role.is.null,audience_role.eq.${s.profile.role}`);
    } else if (audienceRole) {
      query = query.eq('audience_role', audienceRole);
    }

    const { data, error } = await query;
    if (error) return sendJson(res, 500, { ok: false, error: 'docs_query_failed' });
    return sendJson(res, 200, { ok: true, docs: Array.isArray(data) ? data : [] });
  }

  if (req.method === 'POST') {
    if (!isManager(s.profile)) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const title = cleanStr(body.title, 200);
    if (!title) return sendJson(res, 422, { ok: false, error: 'missing_title' });

    const audienceRole = cleanStr(body.audienceRole, 40) || null;
    const source = cleanStr(body.source, 200);

    const content = cleanStr(body.content || body.csv, 200_000);
    if (!content) return sendJson(res, 422, { ok: false, error: 'missing_content' });

    const meta = (body.meta && typeof body.meta === 'object') ? body.meta : {};
    if (body.csv) {
      meta.format = meta.format || 'csv';
      meta.lineCount = meta.lineCount || countLines(content);
    }

    const doc = {
      created_by: s.user.id,
      title,
      audience_role: audienceRole,
      content,
      source,
      meta,
    };

    const { data, error } = await s.sbAdmin
      .from('portal_docs')
      .insert(doc)
      .select('*')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'doc_insert_failed' });
    return sendJson(res, 200, { ok: true, doc: Array.isArray(data) ? data[0] : null });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
