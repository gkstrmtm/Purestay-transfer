const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

async function getKv(sbAdmin, key) {
  const { data, error } = await sbAdmin
    .from('purestay_kv')
    .select('key, value')
    .eq('key', key)
    .limit(1);
  if (error) return { ok: false, error: 'kv_read_failed' };
  const row = Array.isArray(data) ? data[0] : null;
  return { ok: true, value: row?.value };
}

async function upsertKv(sbAdmin, key, value) {
  const { error } = await sbAdmin
    .from('purestay_kv')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) return { ok: false, error: 'kv_write_failed' };
  return { ok: true };
}

function normalizeProfile(input, { userId, allowReliability = false } = {}) {
  const p = (input && typeof input === 'object') ? input : {};
  const specialties = Array.isArray(p.specialties)
    ? p.specialties.map((x) => cleanStr(x, 60)).filter(Boolean).slice(0, 20)
    : cleanStr(p.specialties, 400).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);

  const preferredPairings = Array.isArray(p.preferredPairings)
    ? p.preferredPairings.map((x) => cleanStr(x, 80)).filter(Boolean).slice(0, 20)
    : [];

  const out = {
    userId: cleanStr(userId, 80),
    displayName: cleanStr(p.displayName, 120),
    role: cleanStr(p.role, 40),
    bio: cleanStr(p.bio, 2000),
    homeBaseCity: cleanStr(p.homeBaseCity, 80),
    homeBaseState: cleanStr(p.homeBaseState, 20),
    specialties,
    preferredPairings,
    gear: cleanStr(p.gear, 800),
    tone: cleanStr(p.tone, 120),
    notes: cleanStr(p.notes, 2000),
    updatedAt: new Date().toISOString(),
  };

  if (allowReliability) {
    out.reliability = {
      score: clampInt(p?.reliability?.score, 0, 100, clampInt(p.reliabilityScore, 0, 100, null)),
      lastEventAt: cleanStr(p?.reliability?.lastEventAt, 40),
      flags: Array.isArray(p?.reliability?.flags)
        ? p.reliability.flags.map((x) => cleanStr(x, 60)).filter(Boolean).slice(0, 20)
        : [],
    };
  }

  return out;
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const key = 'portal:talent_profiles:v1';
  const url = new URL(req.url || '/api/portal/talent_profiles', 'http://localhost');

  const requesterRole = String(s.profile?.role || '');
  // Enforce permissions based on the real authenticated role (view-as should not grant access).
  const isCoordinator = hasRole(s.realProfile, ['event_coordinator', 'manager']);

  if (req.method === 'GET') {
    const requestedUserId = cleanStr(url.searchParams.get('userId'), 80);
    const effectiveUserId = requestedUserId || s.user.id;

    if (!isCoordinator && effectiveUserId !== s.user.id) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const r = await getKv(s.sbAdmin, key);
    if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });

    const value = (r.value && typeof r.value === 'object') ? r.value : {};
    const profiles = Array.isArray(value.profiles) ? value.profiles : [];

    if (!requestedUserId && isCoordinator) {
      return sendJson(res, 200, { ok: true, profiles });
    }

    const p = profiles.find((x) => String(x?.userId || '') === String(effectiveUserId)) || null;
    return sendJson(res, 200, { ok: true, profile: p, role: requesterRole });
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const targetUserId = cleanStr(body.userId, 80) || s.user.id;
    if (!isCoordinator && targetUserId !== s.user.id) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const allowReliability = isCoordinator;

    const r = await getKv(s.sbAdmin, key);
    if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });

    const value = (r.value && typeof r.value === 'object') ? r.value : {};
    const profiles = Array.isArray(value.profiles) ? value.profiles : [];

    const next = profiles.slice();
    const idx = next.findIndex((x) => String(x?.userId || '') === String(targetUserId));
    const base = idx >= 0 && next[idx] && typeof next[idx] === 'object' ? next[idx] : { userId: targetUserId };

    const merged = Object.assign({}, base, normalizeProfile(body.profile || body, { userId: targetUserId, allowReliability }));
    if (idx >= 0) next[idx] = merged;
    else next.push(merged);

    const w = await upsertKv(s.sbAdmin, key, { profiles: next });
    if (!w.ok) return sendJson(res, 500, { ok: false, error: w.error });

    return sendJson(res, 200, { ok: true, profile: merged });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
