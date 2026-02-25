const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager } = require('../../lib/portalAuth');

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function clampUuid(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  // Very light validation; Supabase will enforce actual uuid type.
  if (!/^[0-9a-fA-F-]{10,}$/.test(s)) return '';
  return s;
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
  if (handleCors(req, res, { methods: ['GET', 'PUT', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  if (!hasRole(s.profile, ['closer', 'account_manager', 'manager'])) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const url = new URL(req.url || '/api/portal/availability', 'http://localhost');
  const requestedUserId = clampUuid(url.searchParams.get('userId'));

  const userId = (isManager(s.profile) && requestedUserId) ? requestedUserId : s.user.id;
  const key = `portal:availability:${userId}`;

  if (req.method === 'GET') {
    const r = await getKv(s.sbAdmin, key);
    if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });
    const value = r.row?.value && typeof r.row.value === 'object' ? r.row.value : {};
    return sendJson(res, 200, {
      ok: true,
      userId,
      availability: {
        notes: String(value.notes || ''),
        updatedAt: r.row?.updated_at || null,
      },
    });
  }

  if (req.method === 'PUT') {
    if (!isManager(s.profile) && userId !== s.user.id) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const value = {
      notes: cleanStr(body.notes, 8000),
    };

    const w = await upsertKv(s.sbAdmin, key, value);
    if (!w.ok) return sendJson(res, 500, { ok: false, error: w.error });

    return sendJson(res, 200, {
      ok: true,
      userId,
      availability: {
        notes: String(w.row?.value?.notes || ''),
        updatedAt: w.row?.updated_at || null,
      },
    });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
