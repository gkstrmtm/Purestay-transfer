const { sendJson, handleCors, readJson, isValidEmail } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function cleanDate(v) {
  const s = cleanStr(v, 20);
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  return s;
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function addDaysYmd(ymd, days) {
  const s = cleanDate(ymd);
  if (!s) return '';
  const d = new Date(s + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + Number(days || 0));
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function daysInMonth(year, monthIndex0) {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

function addMonthsYmd(ymd, months) {
  const s = cleanDate(ymd);
  if (!s) return '';
  const m = clampInt(months, -1200, 1200, 0);
  if (!m) return s;
  const [yyyy, mm, dd] = s.split('-').map((x) => Number(x));
  if (!yyyy || !mm || !dd) return '';

  const fromMonth0 = mm - 1;
  const target = new Date(yyyy, fromMonth0, 1);
  target.setMonth(target.getMonth() + m);

  const ty = target.getFullYear();
  const tm0 = target.getMonth();
  const maxDay = daysInMonth(ty, tm0);
  const day = Math.min(dd, maxDay);
  const out = new Date(ty, tm0, day);
  const outY = String(out.getFullYear()).padStart(4, '0');
  const outM = String(out.getMonth() + 1).padStart(2, '0');
  const outD = String(out.getDate()).padStart(2, '0');
  return `${outY}-${outM}-${outD}`;
}

function computeRenewalReminderDate(contractEnd, reminderDays) {
  const end = cleanDate(contractEnd);
  if (!end) return '';
  const days = clampInt(reminderDays, 0, 3650, 30);
  return addDaysYmd(end, -days);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function uuid() {
  try {
    // eslint-disable-next-line global-require
    const crypto = require('crypto');
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch {
    // ignore
  }
  return 'acct_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
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

function normalizeAccount(a) {
  if (!isPlainObject(a)) return null;
  const out = {
    id: cleanStr(a.id, 80),
    // Account core
    name: cleanStr(a.name, 200),
    leadId: cleanStr(a.leadId, 80),

    // Property
    propertyName: cleanStr(a.propertyName, 200),
    address: cleanStr(a.address, 240),
    city: cleanStr(a.city, 120),
    state: cleanStr(a.state, 20),
    postalCode: cleanStr(a.postalCode, 20),

    // Primary contact
    primaryContactName: cleanStr(a.primaryContactName, 200),
    primaryContactEmail: cleanStr(a.primaryContactEmail, 200),
    primaryContactPhone: cleanStr(a.primaryContactPhone, 80),

    // Contract + renewal
    contractTier: cleanStr(a.contractTier, 40) || cleanStr(a.tier, 40),
    termMonths: clampInt(a.termMonths, 0, 1200, 0),
    contractSendDate: cleanDate(a.contractSendDate),
    contractStart: cleanDate(a.contractStart),
    contractEnd: cleanDate(a.contractEnd),
    renewalReminderDays: clampInt(a.renewalReminderDays, 0, 3650, 30),
    renewalReminderDate: cleanDate(a.renewalReminderDate) || '',

    // Legacy convenience fields (kept for compatibility)
    email: cleanStr(a.email, 200),
    phone: cleanStr(a.phone, 80),

    notes: cleanStr(a.notes, 8000),
    createdAt: cleanStr(a.createdAt, 80),
    updatedAt: cleanStr(a.updatedAt, 80),
  };
  if (!out.id || !out.name) return null;

  // Defaults
  if (!out.propertyName) out.propertyName = out.name;
  if (!out.primaryContactEmail && out.email) out.primaryContactEmail = out.email;
  if (!out.primaryContactPhone && out.phone) out.primaryContactPhone = out.phone;
  if (out.primaryContactEmail && !isValidEmail(out.primaryContactEmail)) out.primaryContactEmail = '';

  // Derive contract end from term if it wasn't explicitly provided.
  if (!out.contractEnd && out.contractStart && out.termMonths > 0) {
    out.contractEnd = addMonthsYmd(out.contractStart, out.termMonths);
  }

  // Compute renewal reminder if we have a contract end.
  if (!out.renewalReminderDate && out.contractEnd) {
    out.renewalReminderDate = computeRenewalReminderDate(out.contractEnd, out.renewalReminderDays);
  }

  return out;
}

function sortAccounts(arr) {
  return arr.slice().sort((a, b) => {
    const au = String(a.updatedAt || a.createdAt || '');
    const bu = String(b.updatedAt || b.createdAt || '');
    if (au && bu) return bu.localeCompare(au);
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  if (!hasRole(s.profile, ['account_manager', 'manager'])) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const key = 'portal:accounts:v1';
  const url = new URL(req.url || '/api/portal/accounts', 'http://localhost');
  const q = cleanStr(url.searchParams.get('q'), 200).toLowerCase();
  const expiringSoon = cleanStr(url.searchParams.get('expiringSoon'), 10) === '1';

  const r = await getKv(s.sbAdmin, key);
  if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });
  const store = (r.row?.value && typeof r.row.value === 'object') ? r.row.value : {};
  const list = Array.isArray(store.accounts) ? store.accounts : [];
  const accounts = list.map(normalizeAccount).filter(Boolean);

  if (req.method === 'GET') {
    const now = new Date();
    const soonDays = 45;
    const soon = new Date(now.getTime() + soonDays * 86400 * 1000);

    let out = accounts;
    if (q) {
      out = out.filter((a) => {
        const hay = [
          a.name,
          a.propertyName,
          a.address,
          a.city,
          a.state,
          a.postalCode,
          a.primaryContactName,
          a.primaryContactEmail,
          a.primaryContactPhone,
          a.contractTier,
          a.email,
          a.phone,
          a.notes,
        ]
          .map((x) => String(x || '').toLowerCase())
          .join(' ');
        return hay.includes(q);
      });
    }
    if (expiringSoon) {
      out = out.filter((a) => {
        if (!a.contractEnd) return false;
        const d = new Date(a.contractEnd + 'T00:00:00');
        if (Number.isNaN(d.getTime())) return false;
        return d <= soon;
      });
    }

    return sendJson(res, 200, { ok: true, accounts: sortAccounts(out) });
  }

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  if (req.method === 'POST') {
    const name = cleanStr(body.name, 200);
    if (!name) return sendJson(res, 400, { ok: false, error: 'name_required' });

    const nowIso = new Date().toISOString();
    const account = normalizeAccount({
      id: uuid(),
      name,
      leadId: cleanStr(body.leadId, 80),

      propertyName: cleanStr(body.propertyName, 200),
      address: cleanStr(body.address, 240),
      city: cleanStr(body.city, 120),
      state: cleanStr(body.state, 20),
      postalCode: cleanStr(body.postalCode, 20),

      primaryContactName: cleanStr(body.primaryContactName, 200),
      primaryContactEmail: cleanStr(body.primaryContactEmail, 200),
      primaryContactPhone: cleanStr(body.primaryContactPhone, 80),

      contractTier: cleanStr(body.contractTier || body.tier, 40),
      termMonths: clampInt(body.termMonths, 0, 1200, 0),
      contractSendDate: cleanDate(body.contractSendDate),
      contractStart: cleanDate(body.contractStart),
      contractEnd: cleanDate(body.contractEnd),
      renewalReminderDays: clampInt(body.renewalReminderDays, 0, 3650, 30),
      renewalReminderDate: cleanDate(body.renewalReminderDate),

      email: cleanStr(body.email, 200),
      phone: cleanStr(body.phone, 80),
      notes: cleanStr(body.notes, 8000),
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    const next = sortAccounts([account, ...accounts.filter((a) => a.id !== account.id)]);
    const w = await upsertKv(s.sbAdmin, key, { accounts: next });
    if (!w.ok) return sendJson(res, 500, { ok: false, error: w.error });

    return sendJson(res, 200, { ok: true, account });
  }

  if (req.method === 'PUT') {
    const id = cleanStr(body.id, 80);
    const patch = isPlainObject(body.patch) ? body.patch : {};
    if (!id) return sendJson(res, 400, { ok: false, error: 'id_required' });

    const existing = accounts.find((a) => a.id === id);
    if (!existing) return sendJson(res, 404, { ok: false, error: 'not_found' });

    const updated = normalizeAccount({
      ...existing,
      name: cleanStr(patch.name != null ? patch.name : existing.name, 200),
      leadId: cleanStr(patch.leadId != null ? patch.leadId : existing.leadId, 80),

      propertyName: cleanStr(patch.propertyName != null ? patch.propertyName : existing.propertyName, 200),
      address: cleanStr(patch.address != null ? patch.address : existing.address, 240),
      city: cleanStr(patch.city != null ? patch.city : existing.city, 120),
      state: cleanStr(patch.state != null ? patch.state : existing.state, 20),
      postalCode: cleanStr(patch.postalCode != null ? patch.postalCode : existing.postalCode, 20),

      primaryContactName: cleanStr(patch.primaryContactName != null ? patch.primaryContactName : existing.primaryContactName, 200),
      primaryContactEmail: cleanStr(patch.primaryContactEmail != null ? patch.primaryContactEmail : existing.primaryContactEmail, 200),
      primaryContactPhone: cleanStr(patch.primaryContactPhone != null ? patch.primaryContactPhone : existing.primaryContactPhone, 80),

      contractTier: cleanStr(patch.contractTier != null ? patch.contractTier : existing.contractTier, 40),
      termMonths: patch.termMonths != null ? clampInt(patch.termMonths, 0, 1200, existing.termMonths || 0) : existing.termMonths,
      contractSendDate: cleanDate(patch.contractSendDate != null ? patch.contractSendDate : existing.contractSendDate),
      contractStart: cleanDate(patch.contractStart != null ? patch.contractStart : existing.contractStart),
      contractEnd: cleanDate(patch.contractEnd != null ? patch.contractEnd : existing.contractEnd),
      renewalReminderDays: patch.renewalReminderDays != null ? clampInt(patch.renewalReminderDays, 0, 3650, existing.renewalReminderDays || 30) : existing.renewalReminderDays,
      renewalReminderDate: cleanDate(patch.renewalReminderDate != null ? patch.renewalReminderDate : existing.renewalReminderDate),

      email: cleanStr(patch.email != null ? patch.email : existing.email, 200),
      phone: cleanStr(patch.phone != null ? patch.phone : existing.phone, 80),
      notes: cleanStr(patch.notes != null ? patch.notes : existing.notes, 8000),
      updatedAt: new Date().toISOString(),
    });

    const next = sortAccounts([updated, ...accounts.filter((a) => a.id !== id)]);
    const w = await upsertKv(s.sbAdmin, key, { accounts: next });
    if (!w.ok) return sendJson(res, 500, { ok: false, error: w.error });

    return sendJson(res, 200, { ok: true, account: updated });
  }

  if (req.method === 'DELETE') {
    const id = cleanStr(body.id, 80);
    if (!id) return sendJson(res, 400, { ok: false, error: 'id_required' });

    const exists = accounts.some((a) => a.id === id);
    if (!exists) return sendJson(res, 200, { ok: true });

    const next = sortAccounts(accounts.filter((a) => a.id !== id));
    const w = await upsertKv(s.sbAdmin, key, { accounts: next });
    if (!w.ok) return sendJson(res, 500, { ok: false, error: w.error });

    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
