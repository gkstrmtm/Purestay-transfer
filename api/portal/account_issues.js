const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function uuid() {
  try {
    // eslint-disable-next-line global-require
    const crypto = require('crypto');
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch {
    // ignore
  }
  return 'iss_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function getKv(sbAdmin, key) {
  const { data, error } = await sbAdmin
    .from('purestay_kv')
    .select('key, value, updated_at')
    .eq('key', key)
    .limit(1);
  if (error) return { ok: false, error: 'kv_read_failed' };
  const row = Array.isArray(data) ? data[0] : null;
  return { ok: true, row };
}

async function upsertKv(sbAdmin, key, value) {
  const { data, error } = await sbAdmin
    .from('purestay_kv')
    .upsert({ key, value }, { onConflict: 'key' })
    .select('key, value, updated_at')
    .limit(1);
  if (error) return { ok: false, error: 'kv_write_failed' };
  return { ok: true, row: Array.isArray(data) ? data[0] : null };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  if (!hasRole(s.profile, ['account_manager', 'manager'])) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const url = new URL(req.url || '/api/portal/account_issues', 'http://localhost');
  const accountIdQ = cleanStr(url.searchParams.get('accountId'), 80);

  if (req.method === 'GET') {
    const accountId = accountIdQ;
    if (!accountId) return sendJson(res, 400, { ok: false, error: 'accountId_required' });

    const key = `portal:account_issues:${accountId}`;
    const r = await getKv(s.sbAdmin, key);
    if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });
    const value = (r.row?.value && typeof r.row.value === 'object') ? r.row.value : {};
    const issues = Array.isArray(value.issues) ? value.issues : [];
    return sendJson(res, 200, { ok: true, issues });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const accountId = cleanStr(body.accountId, 80);
    if (!accountId) return sendJson(res, 400, { ok: false, error: 'accountId_required' });

    const severity = cleanStr(body.severity, 10) || 'low';
    const status = cleanStr(body.status, 12) || 'open';
    if (!['low', 'med', 'high'].includes(severity)) {
      return sendJson(res, 400, { ok: false, error: 'invalid_severity' });
    }
    if (!['open', 'resolved'].includes(status)) {
      return sendJson(res, 400, { ok: false, error: 'invalid_status' });
    }

    const issue = {
      id: uuid(),
      severity,
      status,
      note: cleanStr(body.note, 4000),
      createdAt: new Date().toISOString(),
      createdBy: cleanStr(s.user?.email, 200) || cleanStr(s.user?.id, 80),
    };

    const key = `portal:account_issues:${accountId}`;
    const r = await getKv(s.sbAdmin, key);
    if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });
    const value = (r.row?.value && typeof r.row.value === 'object') ? r.row.value : {};
    const issues = Array.isArray(value.issues) ? value.issues : [];

    const next = [...issues, issue].slice(-500);
    const w = await upsertKv(s.sbAdmin, key, { issues: next });
    if (!w.ok) return sendJson(res, 500, { ok: false, error: w.error });

    return sendJson(res, 200, { ok: true, issue });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
