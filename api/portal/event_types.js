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

function eventTypesFromResources() {
  const text = readResourceText('resources/event_types.csv');
  if (!text) return { ok: false, error: 'resources_missing' };
  const rows = parseCsv(text);
  const objs = toObjects(rows);
  return { ok: true, types: objs.slice(0, 2000) };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const key = 'portal:event_types:v1';
  const url = new URL(req.url || '/api/portal/event_types', 'http://localhost');

  if (req.method === 'GET') {
    const q = cleanStr(url.searchParams.get('q'), 200).toLowerCase();
    const kind = cleanStr(url.searchParams.get('kind'), 40).toLowerCase(); // anchor/momentum

    const r = await getKv(s.sbAdmin, key);
    if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });

    const value = (r.value && typeof r.value === 'object') ? r.value : {};
    let types = Array.isArray(value.types) ? value.types : [];

    let seeded = false;
    if (!types.length) {
      const rr = eventTypesFromResources();
      if (rr.ok && rr.types.length) {
        const w = await upsertKv(s.sbAdmin, key, { types: rr.types, updatedAt: new Date().toISOString(), source: 'resources' });
        if (w.ok) {
          types = rr.types;
          seeded = true;
        }
      }
    }

    if (kind) {
      types = types.filter((t) => JSON.stringify(t).toLowerCase().includes(kind));
    }
    if (q) {
      types = types.filter((t) => JSON.stringify(t).toLowerCase().includes(q));
    }

    return sendJson(res, 200, { ok: true, types, seeded });
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
      const rr = eventTypesFromResources();
      if (!rr.ok) return sendJson(res, 500, { ok: false, error: rr.error });
      const w = await upsertKv(s.sbAdmin, key, { types: rr.types, updatedAt: new Date().toISOString(), source: 'resources' });
      if (!w.ok) return sendJson(res, 500, { ok: false, error: w.error });
      return sendJson(res, 200, { ok: true, types: rr.types, count: rr.types.length, reloaded: true });
    }

    const csvText = body.csvText != null ? String(body.csvText || '') : '';
    const types = Array.isArray(body.types) ? body.types : null;

    let next = [];
    if (types) {
      next = types.slice(0, 2000);
    } else {
      const rows = parseCsv(csvText);
      const objs = toObjects(rows);
      next = objs.slice(0, 2000);
    }

    const w = await upsertKv(s.sbAdmin, key, { types: next, updatedAt: new Date().toISOString() });
    if (!w.ok) return sendJson(res, 500, { ok: false, error: w.error });

    return sendJson(res, 200, { ok: true, types: next, count: next.length });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
