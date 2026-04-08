const { sendJson, handleCors } = require('../../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../../lib/portalAuth');
const { generateEventTypeSuggestions } = require('../../../lib/aiPortal');

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

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!hasRole(s.profile, ['event_coordinator', 'account_manager', 'manager'])) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const url = new URL(req.url || '/api/portal/ai/event_suggest', 'http://localhost');
  const strategy = cleanStr(url.searchParams.get('strategy'), 20).toLowerCase();
  const classType = cleanStr(url.searchParams.get('classType'), 40);
  const propertyName = cleanStr(url.searchParams.get('propertyName'), 120);
  const propertyCity = cleanStr(url.searchParams.get('city'), 80);
  const goals = cleanStr(url.searchParams.get('goals'), 300);
  const count = clampInt(url.searchParams.get('count'), 3, 8, 5);

  const r = await getKv(s.sbAdmin, 'portal:event_types:v1');
  if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });

  const value = (r.value && typeof r.value === 'object') ? r.value : {};
  let eventTypes = Array.isArray(value.event_types) ? value.event_types : [];

  if (!eventTypes.length) {
    return sendJson(res, 404, { ok: false, error: 'event_types_not_loaded', hint: 'Use /api/portal/event_types to sync event types first.' });
  }

  // Pre-filter by strategy type
  if (strategy && strategy !== 'any') {
    const filtered = eventTypes.filter(e =>
      String(e['Type'] || '').toLowerCase() === strategy
    );
    if (filtered.length >= 5) eventTypes = filtered;
  }

  // Pre-filter by class fit if given
  if (classType) {
    const norm = classType.toLowerCase();
    const filtered = eventTypes.filter(e => {
      const cf = String(e['Class Fit'] || '').toLowerCase();
      return cf.includes(norm) || cf.includes('all');
    });
    if (filtered.length >= 5) eventTypes = filtered;
  }

  // Limit pool sent to AI
  const pool = eventTypes.slice(0, 80);

  const propertyContext = {
    name: propertyName || 'unknown',
    city: propertyCity || 'unknown',
    classType: classType || 'unknown',
    goals: goals || 'resident retention and community building',
    strategy: strategy || 'any',
  };

  const ai = await generateEventTypeSuggestions({ eventTypes: pool, propertyContext, strategy, count });
  if (!ai.ok) return sendJson(res, 502, { ok: false, error: ai.error });

  const picks = Array.isArray(ai.data?.picks) ? ai.data.picks : [];
  const resolved = picks
    .map(p => {
      const idx = clampInt(p?.idx, 0, pool.length - 1, null);
      if (idx == null) return null;
      const et = pool[idx];
      return {
        name: String(et['Event Type'] || '').trim(),
        type: String(et['Type'] || '').trim(),
        classFit: String(et['Class Fit'] || '').trim(),
        goal: String(et['Goal'] || '').trim(),
        notes: String(et['Notes'] || '').trim(),
        psychHook: String(et['Psychological Hook'] || '').trim(),
        reason: cleanStr(p?.reason, 300),
        hook: cleanStr(p?.hook, 200),
      };
    })
    .filter(Boolean);

  return sendJson(res, 200, {
    ok: true,
    picks: resolved,
    tip: cleanStr(ai.data?.tip, 400),
    total: eventTypes.length,
  });
};
