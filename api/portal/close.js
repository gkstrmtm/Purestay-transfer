const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager } = require('../../lib/portalAuth');
const { roleMatchesAny } = require('../../lib/portalRoleAliases');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function clampNum(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function cleanDate(v) {
  const s = cleanStr(v, 20);
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  return s;
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
  const fromM0 = mm - 1;
  const base = new Date(yyyy, fromM0, 1);
  base.setMonth(base.getMonth() + m);
  const ty = base.getFullYear();
  const tm0 = base.getMonth();
  const day = Math.min(dd, daysInMonth(ty, tm0));
  const out = new Date(ty, tm0, day);
  const outY = String(out.getFullYear()).padStart(4, '0');
  const outM = String(out.getMonth() + 1).padStart(2, '0');
  const outD = String(out.getDate()).padStart(2, '0');
  return `${outY}-${outM}-${outD}`;
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

async function canTouchLead(sbAdmin, { profile, userId, leadId }) {
  if (isManager(profile)) return true;
  const { data, error } = await sbAdmin
    .from('portal_leads')
    .select('id, created_by, assigned_role, assigned_user_id')
    .eq('id', leadId)
    .limit(1);
  if (error) return false;
  const lead = Array.isArray(data) ? data[0] : null;
  if (!lead) return false;
  const role = String(profile?.role || '');
  return (
    (lead.assigned_user_id && lead.assigned_user_id === userId) ||
    (lead.created_by && lead.created_by === userId) ||
    (role && lead.assigned_role && roleMatchesAny(lead.assigned_role, role))
  );
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  if (!hasRole(s.profile, ['closer', 'account_manager', 'manager'])) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const leadId = clampInt(body.leadId, 1, 1e12, null);
  if (!leadId) return sendJson(res, 422, { ok: false, error: 'missing_lead_id' });

  const okLead = await canTouchLead(s.sbAdmin, { profile: s.profile, userId: s.actorUserId, leadId });
  if (!okLead) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const status = body.status != null ? cleanStr(body.status, 40) : null;
  const raw = (body.payload && typeof body.payload === 'object') ? body.payload : {};

  const disposition = cleanStr(raw.disposition, 80) || 'follow_up';

  const payload = {
    disposition,
    closedOn: raw.closedOn ? cleanStr(raw.closedOn, 20) : null,
    packageTier: raw.packageTier ? cleanStr(raw.packageTier, 40) : null,
    packagePrice: clampNum(raw.packagePrice, 0, 1e9, 0),
    initialPayment: clampNum(raw.initialPayment, 0, 1e9, 0),
    termMonths: clampInt(raw.termMonths, 0, 1200, 0),
    monthlyPricing: clampNum(raw.monthlyPricing, 0, 1e9, 0),
    contractSendDate: raw.contractSendDate ? cleanStr(raw.contractSendDate, 20) : null,
    notes: cleanStr(raw.notes, 5000),
  };

  // Update lead status (optional)
  if (status) {
    const { error: e1 } = await s.sbAdmin
      .from('portal_leads')
      .update({ status })
      .eq('id', leadId);
    if (e1) return sendJson(res, 500, { ok: false, error: 'lead_update_failed' });
  }

  const activity = {
    lead_id: leadId,
    created_by: s.actorUserId,
    activity_type: 'close',
    outcome: disposition,
    notes: payload.notes || '',
    payload,
  };

  const { data, error } = await s.sbAdmin
    .from('portal_lead_activities')
    .insert(activity)
    .select('*')
    .limit(1);

  if (error) return sendJson(res, 500, { ok: false, error: 'close_log_failed' });

  // Zero-friction Accounts: when a deal is marked won, auto-upsert an account.
  let accountUpserted = false;
  let accountError = '';
  try {
    const isWon = String(disposition || '') === 'won' || String(status || '') === 'won';
    if (isWon) {
      const { data: leads, error: le } = await s.sbAdmin
        .from('portal_leads')
        .select('id, property_name, address, city, state, postal_code, first_name, last_name, email, phone')
        .eq('id', leadId)
        .limit(1);
      if (!le) {
        const lead = Array.isArray(leads) ? leads[0] : null;
        if (lead) {
          const key = 'portal:accounts:v1';
          const r = await getKv(s.sbAdmin, key);
          if (!r.ok) throw new Error(r.error);
          const store = (r.row?.value && typeof r.row.value === 'object') ? r.row.value : {};
          const list = Array.isArray(store.accounts) ? store.accounts : [];

          const leadIdStr = String(leadId);
          const existingIdx = list.findIndex((x) => String(x?.leadId || '') === leadIdStr);
          const existing = existingIdx >= 0 ? list[existingIdx] : null;

          const first = cleanStr(lead.first_name, 120);
          const last = cleanStr(lead.last_name, 120);
          const contactName = cleanStr([first, last].filter(Boolean).join(' '), 200);

          const prop = cleanStr(lead.property_name, 200);
          const baseName = prop || contactName || ('Lead ' + leadIdStr);

          const addr1 = cleanStr(lead.address, 240);
          const city = cleanStr(lead.city, 120);
          const st = cleanStr(lead.state, 20);
          const zip = cleanStr(lead.postal_code, 20);
          const addrParts = [addr1, [city, st].filter(Boolean).join(', ').trim(), zip].filter(Boolean);
          const addrFull = cleanStr(addrParts.join(' ').replace(/\s+/g, ' ').trim(), 240);

          const nowIso = new Date().toISOString();
          const today = nowIso.slice(0, 10);

          const closedOn = cleanDate(payload.closedOn);
          const sendOn = cleanDate(payload.contractSendDate);
          const termMonths = clampInt(payload.termMonths, 0, 1200, 0);
          const contractStart = closedOn || sendOn || today;
          const contractEnd = termMonths > 0 ? addMonthsYmd(contractStart, termMonths) : cleanDate(existing?.contractEnd);

          const reminderDays = existing?.renewalReminderDays != null
            ? clampInt(existing.renewalReminderDays, 0, 3650, 30)
            : 30;

          const next = {
            ...(existing && typeof existing === 'object' ? existing : {}),
            id: cleanStr(existing?.id, 80) || ('acct_lead_' + leadIdStr),
            name: cleanStr(existing?.name, 200) || baseName,
            leadId: leadIdStr,

            propertyName: cleanStr(existing?.propertyName, 200) || prop || baseName,
            address: cleanStr(existing?.address, 240) || addrFull,
            city: cleanStr(existing?.city, 120) || city,
            state: cleanStr(existing?.state, 20) || st,
            postalCode: cleanStr(existing?.postalCode, 20) || zip,

            primaryContactName: cleanStr(existing?.primaryContactName, 200) || contactName,
            primaryContactEmail: cleanStr(existing?.primaryContactEmail, 200) || cleanStr(lead.email, 200),
            primaryContactPhone: cleanStr(existing?.primaryContactPhone, 80) || cleanStr(lead.phone, 80),

            // Keep legacy convenience fields in sync.
            email: cleanStr(existing?.email, 200) || cleanStr(lead.email, 200),
            phone: cleanStr(existing?.phone, 80) || cleanStr(lead.phone, 80),

            contractTier: cleanStr(payload.packageTier, 40) || cleanStr(existing?.contractTier || existing?.tier, 40),
            tier: cleanStr(payload.packageTier, 40) || cleanStr(existing?.tier, 40),
            termMonths,
            contractSendDate: sendOn || cleanDate(existing?.contractSendDate),
            contractStart,
            contractEnd,
            renewalReminderDays: reminderDays,

            createdAt: cleanStr(existing?.createdAt, 80) || nowIso,
            updatedAt: nowIso,
          };

          const nextList = list.slice();
          if (existingIdx >= 0) nextList.splice(existingIdx, 1);
          // Remove any duplicate that shares the leadId.
          const deduped = nextList.filter((x) => String(x?.leadId || '') !== leadIdStr);
          deduped.unshift(next);

          const w = await upsertKv(s.sbAdmin, key, { accounts: deduped });
          if (!w.ok) throw new Error(w.error);
          accountUpserted = true;
        }
      }
    }
  } catch (e) {
    accountError = String(e?.message || e);
  }

  return sendJson(res, 200, {
    ok: true,
    activity: Array.isArray(data) ? data[0] : null,
    accountUpserted,
    ...(accountError ? { accountError } : {}),
  });
};
