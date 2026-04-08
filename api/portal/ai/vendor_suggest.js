const { sendJson, handleCors } = require('../../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../../lib/portalAuth');
const { generateVendorSuggestions } = require('../../../lib/aiPortal');

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

function pickVendorName(v) {
  return String(v?.Vendor || v?.vendor || v?.Name || v?.name || v?.Company || v?.company || '').trim();
}

function reduceVendor(v) {
  const city = String(v?.City || v?.city || '').trim();
  const state = String(v?.State || v?.state || '').trim();
  const name = pickVendorName(v);
  const email = String(v?.Email || v?.email || '').trim();
  const phone = String(v?.Phone || v?.phone || '').trim();
  const type = String(v?.Type || v?.type || v?.Category || v?.category || '').trim();
  return {
    name: name || JSON.stringify(v).slice(0, 80),
    city,
    state,
    type,
    email,
    phone,
  };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!hasRole(s.profile, ['event_coordinator', 'manager'])) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const url = new URL(req.url || '/api/portal/ai/vendor_suggest', 'http://localhost');
  const eventId = clampInt(url.searchParams.get('eventId') || url.searchParams.get('event_id'), 1, 1e12, null);
  const limit = clampInt(url.searchParams.get('limit'), 20, 200, 120);
  if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

  const { data: events, error: e1 } = await s.sbAdmin
    .from('portal_events')
    .select('*')
    .eq('id', eventId)
    .limit(1);

  if (e1) return sendJson(res, 500, { ok: false, error: 'event_lookup_failed' });
  const ev = Array.isArray(events) ? events[0] : null;
  if (!ev) return sendJson(res, 404, { ok: false, error: 'event_not_found' });

  const r = await getKv(s.sbAdmin, 'portal:vendors:v1');
  if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });

  const value = (r.value && typeof r.value === 'object') ? r.value : {};
  const vendors = Array.isArray(value.vendors) ? value.vendors : [];

  const evCity = cleanStr(ev?.city, 80).toLowerCase();
  const evState = cleanStr(ev?.state, 20).toLowerCase();

  function city(v) {
    return cleanStr(v?.City || v?.city, 80).toLowerCase();
  }
  function state(v) {
    return cleanStr(v?.State || v?.state, 20).toLowerCase();
  }

  // Prefer local/state matches to keep AI context small and relevant.
  let pool = vendors;
  if (evCity && evState) {
    const local = vendors.filter((v) => city(v) === evCity && state(v) === evState);
    const inState = vendors.filter((v) => state(v) === evState);
    pool = local.length ? local.concat(inState) : inState.length ? inState : vendors;
  } else if (evState) {
    const inState = vendors.filter((v) => state(v) === evState);
    pool = inState.length ? inState : vendors;
  }

  // De-dupe by stringified reduced vendor.
  const seen = new Set();
  const reduced = [];
  for (const v of pool) {
    const rv = reduceVendor(v);
    const key = JSON.stringify(rv);
    if (seen.has(key)) continue;
    seen.add(key);
    reduced.push(rv);
    if (reduced.length >= limit) break;
  }

  const ai = await generateVendorSuggestions({ event: ev, vendors: reduced });
  if (!ai.ok) return sendJson(res, 502, { ok: false, error: ai.error });

  const suggestions = Array.isArray(ai.data?.suggestions) ? ai.data.suggestions : [];
  const picked = suggestions
    .map((sug) => {
      const idx = clampInt(sug?.idx, 0, reduced.length - 1, null);
      if (idx == null) return null;
      return {
        idx,
        vendor: reduced[idx],
        reason: cleanStr(sug?.reason, 300),
      };
    })
    .filter(Boolean)
    .slice(0, 10);

  return sendJson(res, 200, {
    ok: true,
    eventId,
    candidatesCount: reduced.length,
    searchQuery: cleanStr(ai.data?.searchQuery, 120),
    missingInfo: Array.isArray(ai.data?.missingInfo) ? ai.data.missingInfo.slice(0, 8).map((x) => cleanStr(x, 160)).filter(Boolean) : [],
    picked,
  });
};
