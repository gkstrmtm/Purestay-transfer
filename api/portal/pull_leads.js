const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession } = require('../../lib/portalAuth');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

async function gFetchJson(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error('google_http_' + r.status);
  }
  if (!j) throw new Error('google_bad_json');
  if (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS') {
    const msg = String(j.error_message || j.status || 'google_error');
    throw new Error(msg);
  }
  return j;
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  // Only for actual setter roles; manager view-as is read-only and will be blocked upstream.
  const role = String(s.profile?.role || '').trim();
  if (!['remote_setter', 'in_person_setter'].includes(role)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const key = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
  if (!key) return sendJson(res, 503, { ok: false, error: 'missing_google_maps_api_key' });

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const cityState = cleanStr(body.cityState, 120);
  const keyword = cleanStr(body.keyword, 120) || 'apartment leasing office';
  const notes = cleanStr(body.notes, 800);
  const limit = clampInt(body.limit, 1, 25, 10);

  if (!cityState) return sendJson(res, 422, { ok: false, error: 'missing_city_state' });

  const query = `${keyword} in ${cityState}`;

  // 1) Text Search to get place_ids
  const textUrl = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
  textUrl.searchParams.set('query', query);
  textUrl.searchParams.set('key', key);

  const search = await gFetchJson(textUrl.toString());
  const results = Array.isArray(search.results) ? search.results : [];
  const placeIds = results
    .map((r) => String(r.place_id || '').trim())
    .filter(Boolean)
    .slice(0, limit);

  let inserted = 0;
  let skipped = 0;

  // 2) Details per place_id for phone + website
  for (const placeId of placeIds) {
    const detUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    detUrl.searchParams.set('place_id', placeId);
    detUrl.searchParams.set('fields', 'name,formatted_phone_number,website,url');
    detUrl.searchParams.set('key', key);

    const det = await gFetchJson(detUrl.toString());
    const p = det.result || {};

    const name = cleanStr(p.name, 160);
    const phone = cleanStr(p.formatted_phone_number, 40);
    const website = cleanStr(p.website, 300);
    const mapsUrl = cleanStr(p.url, 600);

    // Phone is critical for calling workflows; skip if missing.
    if (!phone) {
      skipped += 1;
      continue;
    }

    const lead = {
      created_by: s.user.id,
      assigned_role: role,
      assigned_user_id: null,
      source: 'google_maps',
      status: 'new',
      priority: 0,

      first_name: '',
      last_name: '',
      phone,
      email: '',

      company: '',
      property_name: name,
      address: '',
      city: '',
      state: '',
      postal_code: '',

      notes,
      meta: {
        google_place_id: placeId,
        website: website || null,
        maps_url: mapsUrl || null,
        query,
      },
    };

    const { error } = await s.sbAdmin.from('portal_leads').insert(lead);
    if (error) {
      // If insertion fails for any record, continue with the rest.
      skipped += 1;
      continue;
    }

    inserted += 1;
  }

  return sendJson(res, 200, { ok: true, inserted, skipped });
};
