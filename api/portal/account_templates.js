const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function uuid() {
  try {
    // eslint-disable-next-line global-require
    const crypto = require('crypto');
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch {
    // ignore
  }
  return 'tpl_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
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

function normalizeTpl(t) {
  if (!isPlainObject(t)) return null;
  const out = {
    id: cleanStr(t.id, 80),
    type: cleanStr(t.type, 20) || 'email',
    name: cleanStr(t.name, 200),
    body: cleanStr(t.body, 12000),
    createdAt: cleanStr(t.createdAt, 80),
    updatedAt: cleanStr(t.updatedAt, 80),
  };
  if (!out.id || !out.name || !out.body) return null;
  if (!['email', 'sms'].includes(out.type)) out.type = 'email';
  return out;
}

function sortTemplates(arr) {
  return arr.slice().sort((a, b) => {
    const au = String(a.updatedAt || a.createdAt || '');
    const bu = String(b.updatedAt || b.createdAt || '');
    if (au && bu) return bu.localeCompare(au);
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  if (!hasRole(s.profile, ['account_manager', 'manager'])) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const key = 'portal:account_templates:v1';
  const r = await getKv(s.sbAdmin, key);
  if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });
  const store = (r.row?.value && typeof r.row.value === 'object') ? r.row.value : {};
  const list = Array.isArray(store.templates) ? store.templates : [];
  const templates = list.map(normalizeTpl).filter(Boolean);

  if (req.method === 'GET') {
    return sendJson(res, 200, { ok: true, templates: sortTemplates(templates) });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const nowIso = new Date().toISOString();
    const tpl = normalizeTpl({
      id: uuid(),
      type: cleanStr(body.type, 20) || 'email',
      name: cleanStr(body.name, 200),
      body: cleanStr(body.body, 12000),
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    if (!tpl) return sendJson(res, 400, { ok: false, error: 'invalid_template' });

    const next = sortTemplates([tpl, ...templates]);
    const w = await upsertKv(s.sbAdmin, key, { templates: next });
    if (!w.ok) return sendJson(res, 500, { ok: false, error: w.error });

    return sendJson(res, 200, { ok: true, template: tpl, templates: next });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
