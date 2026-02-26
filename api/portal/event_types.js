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

function builtinEventTypes() {
  // Used when resources/*.csv isn't bundled on Vercel.
  return [
    { name: 'Influencer Meetup', kind: 'momentum', duration_hours: '3' },
    { name: 'Brand Launch Party', kind: 'anchor', duration_hours: '4' },
    { name: 'VIP Dinner', kind: 'anchor', duration_hours: '2.5' },
    { name: 'Creator House Tour', kind: 'momentum', duration_hours: '1.5' },
    { name: 'Press Day', kind: 'anchor', duration_hours: '6' },
    { name: 'Community Pop-Up', kind: 'momentum', duration_hours: '4' }
  ];
}

function eventTypesFromResources() {
  const text = readResourceText('resources/event_types.csv');
  if (!text) return { ok: true, types: builtinEventTypes(), source: 'builtin' };
  const rows = parseCsv(text);
  const objs = toObjects(rows);
  return { ok: true, types: objs.slice(0, 2000), source: 'resources' };
}

function typeName(t) {
  return cleanStr(t?.['Event Type'] || t?.event_type || t?.type || t?.name, 400);
}

function normalizeType(t) {
  const base = (t && typeof t === 'object') ? t : {};
  const name = typeName(base);
  const hook = cleanStr(base?.['Psychological Hook'] || base?.hook, 1000);
  const classFit = cleanStr(base?.['Class Fit'] || base?.classFit || base?.class_fit, 200);
  const goal = cleanStr(base?.Goal || base?.goal, 800);
  const notes = cleanStr(base?.Notes || base?.notes, 2000);
  const kind = cleanStr(base?.Type || base?.kind, 40);
  return {
    ...base,
    name,
    hook,
    classFit,
    goal,
    notes,
    kind,
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

function scoreTypeForQuery(t, tokens) {
  if (!tokens.length) return 0;
  const name = String(t?.name || '').toLowerCase();
  const classFit = String(t?.classFit || '').toLowerCase();
  const hook = String(t?.hook || '').toLowerCase();
  const goal = String(t?.goal || '').toLowerCase();
  const notes = String(t?.notes || '').toLowerCase();
  const kind = String(t?.kind || '').toLowerCase();
  const blob = [name, classFit, hook, goal, notes, kind].join(' • ');

  let score = 0;
  for (const tok of tokens) {
    if (!tok) continue;
    if (name.includes(tok)) score += 6;
    else if (classFit.includes(tok)) score += 5;
    else if (kind.includes(tok)) score += 3;
    else if (blob.includes(tok)) score += 1;
  }
  return score;
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
    let seedSource = 'none';
    if (!types.length) {
      const rr = eventTypesFromResources();
      if (rr.ok && rr.types.length) {
        const w = await upsertKv(s.sbAdmin, key, { types: rr.types, updatedAt: new Date().toISOString(), source: rr.source || 'unknown' });
        if (w.ok) {
          types = rr.types;
          seeded = true;
          seedSource = rr.source || 'unknown';
        }
      }
    }

    // Normalize + remove junk rows (blank names, repeated header rows).
    types = types
      .map(normalizeType)
      .filter((t) => {
        const n = String(t?.name || '').trim();
        if (!n) return false;
        if (n.toLowerCase() === 'event type') return false;
        return true;
      });

    if (kind) {
      types = types.filter((t) => String(t?.kind || '').toLowerCase().includes(kind));
    }

    if (q) {
      const tokens = tokenizeQuery(q);
      types = types
        .map((t) => ({ t, s: scoreTypeForQuery(t, tokens) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => {
          if (b.s !== a.s) return b.s - a.s;
          return String(a.t?.name || '').localeCompare(String(b.t?.name || ''));
        })
        .map((x) => x.t);
    }

    types = types.slice(0, 500);

    return sendJson(res, 200, { ok: true, types, seeded, seedSource });
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
      const w = await upsertKv(s.sbAdmin, key, { types: rr.types, updatedAt: new Date().toISOString(), source: rr.source || 'unknown' });
      if (!w.ok) return sendJson(res, 500, { ok: false, error: w.error });
      return sendJson(res, 200, { ok: true, types: rr.types, count: rr.types.length, reloaded: true, source: rr.source || 'unknown' });
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
