const { sendJson, handleCors } = require('../../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../../lib/portalAuth');
const { generateTalentRecommendations } = require('../../../lib/aiPortal');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
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

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!hasRole(s.profile, ['event_coordinator', 'manager'])) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const url = new URL(req.url || '/api/portal/ai/talent_recommend', 'http://localhost');
  const eventId = clampInt(url.searchParams.get('eventId') || url.searchParams.get('event_id'), 1, 1e12, null);
  const limit = clampInt(url.searchParams.get('limit'), 20, 120, 70);
  if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

  const { data: events, error: e1 } = await s.sbAdmin
    .from('portal_events')
    .select('*')
    .eq('id', eventId)
    .limit(1);

  if (e1) return sendJson(res, 500, { ok: false, error: 'event_lookup_failed' });
  const ev = Array.isArray(events) ? events[0] : null;
  if (!ev) return sendJson(res, 404, { ok: false, error: 'event_not_found' });

  // Directory
  const { data: profiles, error: e2 } = await s.sbAdmin
    .from('portal_profiles')
    .select('user_id, role, full_name, created_at')
    .order('created_at', { ascending: true })
    .limit(500);

  if (e2) return sendJson(res, 500, { ok: false, error: 'profiles_query_failed' });

  const listed = await s.sbAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const byId = new Map((listed?.data?.users || []).map((u) => [u.id, u]));

  const users = (profiles || [])
    .map((p) => {
      const u = byId.get(p.user_id);
      return {
        userId: p.user_id,
        role: p.role,
        fullName: p.full_name || '',
        email: u?.email || '',
      };
    })
    .filter((u) => ['event_host', 'media_team'].includes(String(u.role || '')));

  // Talent profiles KV
  const kv = await getKv(s.sbAdmin, 'portal:talent_profiles:v1');
  if (!kv.ok) return sendJson(res, 500, { ok: false, error: kv.error });
  const value = (kv.value && typeof kv.value === 'object') ? kv.value : {};
  const talentProfiles = Array.isArray(value.profiles) ? value.profiles : [];
  const talentById = new Map(talentProfiles.map((p) => [String(p?.userId || ''), p]));

  // Reduce to AI-friendly candidates
  const evCity = cleanStr(ev?.city, 80).toLowerCase();
  const evState = cleanStr(ev?.state, 20).toLowerCase();

  function score(u) {
    const p = talentById.get(String(u.userId)) || null;
    const st = cleanStr(p?.homeBaseState, 20).toLowerCase();
    const city = cleanStr(p?.homeBaseCity, 80).toLowerCase();
    let s0 = 0;
    if (evState && st && evState === st) s0 += 1;
    if (evCity && city && evCity === city) s0 += 2;
    const rel = p?.reliability && typeof p.reliability === 'object' ? p.reliability : {};
    const relScore = Number(rel?.score);
    if (Number.isFinite(relScore)) s0 += Math.max(0, Math.min(100, relScore)) / 200; // +0..0.5
    return s0;
  }

  const ranked = users.slice().sort((a, b) => score(b) - score(a));

  const candidates = ranked.slice(0, limit).map((u) => {
    const p = talentById.get(String(u.userId)) || {};
    const rel = p?.reliability && typeof p.reliability === 'object' ? p.reliability : {};
    return {
      userId: String(u.userId),
      role: String(u.role || ''),
      name: cleanStr(p?.displayName, 120) || cleanStr(u.fullName, 120) || cleanStr(u.email, 120) || String(u.userId),
      email: cleanStr(u.email, 120),
      homeBaseCity: cleanStr(p?.homeBaseCity, 80),
      homeBaseState: cleanStr(p?.homeBaseState, 20),
      specialties: Array.isArray(p?.specialties) ? p.specialties.slice(0, 8).map((x) => cleanStr(x, 60)).filter(Boolean) : [],
      tone: cleanStr(p?.tone, 120),
      gear: cleanStr(p?.gear, 200),
      reliabilityScore: Number.isFinite(Number(rel?.score)) ? Number(rel.score) : null,
      reliabilityFlags: Array.isArray(rel?.flags) ? rel.flags.slice(0, 8).map((x) => cleanStr(x, 60)).filter(Boolean) : [],
    };
  });

  const ai = await generateTalentRecommendations({ event: ev, talent: candidates });
  if (!ai.ok) return sendJson(res, 502, { ok: false, error: ai.error });

  const poolIds = new Set(candidates.map((c) => String(c.userId)));
  function normList(arr) {
    const a = Array.isArray(arr) ? arr : [];
    const out = [];
    for (const it of a) {
      const uid = cleanStr(it?.userId, 80);
      if (!uid || !poolIds.has(uid)) continue;
      out.push({ userId: uid, reason: cleanStr(it?.reason, 280) });
      if (out.length >= 6) break;
    }
    return out;
  }

  return sendJson(res, 200, {
    ok: true,
    eventId,
    candidatesCount: candidates.length,
    hosts: normList(ai.data?.hosts),
    media: normList(ai.data?.media),
    missingInfo: Array.isArray(ai.data?.missingInfo) ? ai.data.missingInfo.slice(0, 8).map((x) => cleanStr(x, 160)).filter(Boolean) : [],
  });
};
