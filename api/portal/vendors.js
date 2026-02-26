const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');
const fs = require('fs');
const path = require('path');

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

async function upsertKv(sbAdmin, key, value) {
  const { error } = await sbAdmin
    .from('purestay_kv')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) return { ok: false, error: 'kv_write_failed' };
  return { ok: true };
}

function parseCsv(text) {
  const s = String(text || '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = s[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      continue;
    }

    if (ch === '\r') {
      continue;
    }

    field += ch;
  }

  row.push(field);
  rows.push(row);

  // trim trailing blank lines
  while (rows.length && rows[rows.length - 1].every((c) => !String(c || '').trim())) rows.pop();
  return rows;
}

function toObjects(rows) {
  const arr = Array.isArray(rows) ? rows : [];
  if (!arr.length) return [];
  const header = arr[0].map((h) => cleanStr(h, 80));
  const out = [];
  for (const r of arr.slice(1)) {
    const obj = {};
    for (let i = 0; i < header.length; i++) {
      const k = header[i] || `col_${i + 1}`;
      obj[k] = cleanStr(r[i], 2000);
    }
    out.push(obj);
  }
  return out;
}

function readResourceText(relPath) {
  try {
    const full = path.join(process.cwd(), relPath);
    return fs.readFileSync(full, 'utf8');
  } catch (e) {
    return null;
  }
}

function builtinVendors() {
  // Keep this small and demo-friendly; it's used when resources/*.csv isn't bundled on Vercel.
  return [
    { name: 'PureStay Catering Co', category: 'catering', state: 'FL', city: 'Orlando' },
    { name: 'Sunset AV & Lighting', category: 'av', state: 'FL', city: 'Miami' },
    { name: 'Blue Ribbon Security', category: 'security', state: 'FL', city: 'Tampa' },
    { name: 'Skyline Photo Booth', category: 'photo', state: 'FL', city: 'Orlando' },
    { name: 'Palm Coast Florals', category: 'decor', state: 'FL', city: 'Jacksonville' },
    { name: 'Coastal Shuttle Service', category: 'transport', state: 'FL', city: 'Fort Lauderdale' }
  ];
}

function vendorsFromResources() {
  const text = readResourceText('resources/vendors.csv');
  if (!text) return { ok: true, vendors: builtinVendors(), source: 'builtin' };
  const rows = parseCsv(text);
  const objs = toObjects(rows);
  return { ok: true, vendors: objs.slice(0, 2000), source: 'resources' };
}

function vendorName(v) {
  return cleanStr(v?.['Vendor Name'] || v?.vendor_name || v?.vendorName || v?.name, 400);
}

function normalizeVendor(v) {
  const base = (v && typeof v === 'object') ? v : {};
  const name = vendorName(base);
  const type = cleanStr(base?.Type || base?.type || base?.Category || base?.category, 200);
  const coverage = cleanStr(base?.['City/Coverage Area'] || base?.coverage || base?.City || base?.city, 400);
  const contact = cleanStr(base?.['Phone / Email'] || base?.contact || base?.phone || base?.email, 600);
  const rateInfo = cleanStr(base?.['Rate Info'] || base?.rate || base?.rateInfo, 300);
  const notes = cleanStr(base?.Notes || base?.notes, 2000);
  return {
    ...base,
    name,
    type,
    coverage,
    contact,
    rateInfo,
    notes,
  };
}

function tokenizeQuery(q) {
  return String(q || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function scoreVendorForQuery(v, tokens) {
  if (!tokens.length) return 0;
  const name = String(v?.name || '').toLowerCase();
  const type = String(v?.type || '').toLowerCase();
  const coverage = String(v?.coverage || '').toLowerCase();
  const notes = String(v?.notes || '').toLowerCase();
  const contact = String(v?.contact || '').toLowerCase();
  const blob = [name, type, coverage, notes, contact].join(' • ');

  let score = 0;
  for (const t of tokens) {
    if (!t) continue;
    if (name.includes(t)) score += 6;
    else if (type.includes(t)) score += 5;
    else if (coverage.includes(t)) score += 2;
    else if (blob.includes(t)) score += 1;
  }

  // Light boosts for common vendor intents.
  if (tokens.includes('dj') && (type.includes('dj') || name.includes('dj'))) score += 4;
  if (tokens.includes('band') && (type.includes('band') || name.includes('band'))) score += 4;
  if (tokens.includes('mobile') && (type.includes('mobile') || name.includes('mobile'))) score += 2;
  return score;
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const key = 'portal:vendors:v1';
  const url = new URL(req.url || '/api/portal/vendors', 'http://localhost');

  if (req.method === 'GET') {
    const q = cleanStr(url.searchParams.get('q'), 200).toLowerCase();
    const state = cleanStr(url.searchParams.get('state'), 20).toLowerCase();

    const r = await getKv(s.sbAdmin, key);
    if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });

    const value = (r.value && typeof r.value === 'object') ? r.value : {};
    let vendors = Array.isArray(value.vendors) ? value.vendors : [];

    let seeded = false;
    let seedSource = 'none';
    if (!vendors.length) {
      const rr = vendorsFromResources();
      if (rr.ok && rr.vendors.length) {
        const w = await upsertKv(s.sbAdmin, key, { vendors: rr.vendors, updatedAt: new Date().toISOString(), source: rr.source || 'unknown' });
        if (w.ok) {
          vendors = rr.vendors;
          seeded = true;
          seedSource = rr.source || 'unknown';
        }
      }
    }

    // Normalize + remove junk rows (blank vendor name, repeated header rows).
    vendors = vendors
      .map(normalizeVendor)
      .filter((v) => {
        const n = String(v?.name || '').trim();
        if (!n) return false;
        if (n.toLowerCase() === 'vendor name') return false;
        return true;
      });

    if (state) {
      vendors = vendors.filter((v) => JSON.stringify(v).toLowerCase().includes(state));
    }

    if (q) {
      const tokens = tokenizeQuery(q);
      vendors = vendors
        .map((v) => ({ v, s: scoreVendorForQuery(v, tokens) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => {
          if (b.s !== a.s) return b.s - a.s;
          return String(a.v?.name || '').localeCompare(String(b.v?.name || ''));
        })
        .map((x) => x.v);
    }

    vendors = vendors.slice(0, 500);

    return sendJson(res, 200, { ok: true, vendors, seeded, seedSource });
  }

  if (req.method === 'POST') {
    if (!hasRole(s.profile, ['event_coordinator', 'manager'])) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const action = cleanStr(body.action, 80).toLowerCase();
    const reloadFromResources = action === 'reload_from_resources' || action === 'reloadfromresources' || body.reloadFromResources === true;
    if (reloadFromResources) {
      const rr = vendorsFromResources();
      if (!rr.ok) return sendJson(res, 500, { ok: false, error: rr.error });
      const w = await upsertKv(s.sbAdmin, key, { vendors: rr.vendors, updatedAt: new Date().toISOString(), source: rr.source || 'unknown' });
      if (!w.ok) return sendJson(res, 500, { ok: false, error: w.error });
      return sendJson(res, 200, { ok: true, vendors: rr.vendors, count: rr.vendors.length, reloaded: true, source: rr.source || 'unknown' });
    }

    const csvText = body.csvText != null ? String(body.csvText || '') : '';
    const vendors = Array.isArray(body.vendors) ? body.vendors : null;

    let next = [];
    if (vendors) {
      next = vendors.slice(0, 2000);
    } else {
      const rows = parseCsv(csvText);
      const objs = toObjects(rows);
      next = objs.slice(0, 2000);
    }

    const w = await upsertKv(s.sbAdmin, key, { vendors: next, updatedAt: new Date().toISOString() });
    if (!w.ok) return sendJson(res, 500, { ok: false, error: w.error });

    return sendJson(res, 200, { ok: true, vendors: next, count: next.length });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
