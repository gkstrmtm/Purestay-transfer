const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager } = require('../../lib/portalAuth');

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function cleanSlots(input) {
  if (!isPlainObject(input)) return null;
  const tz = cleanStr(input.tz, 80);
  const byDateIn = isPlainObject(input.byDate) ? input.byDate : {};
  const byDate = {};

  const keys = Object.keys(byDateIn).slice(0, 400);
  for (const k of keys) {
    const key = cleanStr(k, 20);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const raw = byDateIn[k];
    const arr = Array.isArray(raw) ? raw : [];
    const cleaned = [];
    for (const t of arr.slice(0, 64)) {
      const s = cleanStr(t, 10);
      if (!/^\d{2}:\d{2}$/.test(s)) continue;
      cleaned.push(s);
    }
    // de-dupe + sort
    const uniq = Array.from(new Set(cleaned)).sort();
    if (uniq.length) byDate[key] = uniq;
  }

  return { tz, byDate };
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

async function getUserRole(sbAdmin, userId) {
  if (!userId) return '';
  const { data, error } = await sbAdmin
    .from('portal_profiles')
    .select('role')
    .eq('user_id', userId)
    .limit(1);
  if (error) return '';
  const row = Array.isArray(data) ? data[0] : null;
  return String(row?.role || '').trim();
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'PUT', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  if (!hasRole(s.profile, ['dialer', 'remote_setter', 'in_person_setter', 'closer', 'account_manager', 'event_coordinator', 'event_host', 'media_team', 'manager'])) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const url = new URL(req.url || '/api/portal/availability', 'http://localhost');
  const requestedUserId = clampUuid(url.searchParams.get('userId'));

  const baseUserId = String(s.effectiveUserId || s.user.id || '');
  let userId = (s.realIsManager && requestedUserId) ? requestedUserId : baseUserId;

  // Read-only team visibility: allow setters/dialers/coordinators to view a closer/AM's availability.
  if (req.method === 'GET' && requestedUserId && !s.realIsManager) {
    const canViewTeam = hasRole(s.profile, ['dialer', 'remote_setter', 'in_person_setter', 'event_coordinator']);
    if (canViewTeam) {
      const targetRole = await getUserRole(s.sbAdmin, requestedUserId);
      if (['closer', 'account_manager', 'manager'].includes(targetRole)) {
        userId = requestedUserId;
      }
    }
  }
  const key = `portal:availability:${userId}`;

  if (req.method === 'GET') {
    const r = await getKv(s.sbAdmin, key);
    if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });
    const value = r.row?.value && typeof r.row.value === 'object' ? r.row.value : {};
    const slots = cleanSlots(value.slots) || null;
    return sendJson(res, 200, {
      ok: true,
      userId,
      availability: {
        notes: String(value.notes || ''),
        slots,
        updatedAt: r.row?.updated_at || null,
      },
    });
  }

  if (req.method === 'PUT') {
    const actingUserId = String(s.effectiveUserId || s.user.id || '');
    if (!s.realIsManager && userId !== actingUserId) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const nextSlots = cleanSlots(body.slots);

    const value = {
      notes: cleanStr(body.notes, 8000),
      slots: nextSlots || undefined,
    };

    if (value.slots === undefined) delete value.slots;

    const w = await upsertKv(s.sbAdmin, key, value);
    if (!w.ok) return sendJson(res, 500, { ok: false, error: w.error });

    return sendJson(res, 200, {
      ok: true,
      userId,
      availability: {
        notes: String(w.row?.value?.notes || ''),
        slots: cleanSlots(w.row?.value?.slots) || null,
        updatedAt: w.row?.updated_at || null,
      },
    });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
