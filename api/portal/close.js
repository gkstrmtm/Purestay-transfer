const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager } = require('../../lib/portalAuth');
const { writePortalAudit } = require('../../lib/portalFoundation');
const { addMonthsYmd, upsertAccount } = require('../../lib/portalAccounts');
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
  let account = null;
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
          const leadIdStr = String(leadId);

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
          const contractEnd = termMonths > 0 ? addMonthsYmd(contractStart, termMonths) : '';

          const saved = await upsertAccount(s.sbAdmin, {
            legacyAccountId: 'acct_lead_' + leadIdStr,
            name: baseName,
            leadId: leadIdStr,
            propertyName: prop || baseName,
            address: addrFull,
            city,
            state: st,
            postalCode: zip,
            primaryContactName: contactName,
            primaryContactEmail: cleanStr(lead.email, 200),
            primaryContactPhone: cleanStr(lead.phone, 80),
            email: cleanStr(lead.email, 200),
            phone: cleanStr(lead.phone, 80),
            contractTier: cleanStr(payload.packageTier, 40),
            termMonths,
            contractSendDate: sendOn,
            contractStart,
            contractEnd,
            renewalReminderDays: 30,
            createdAt: nowIso,
            updatedAt: nowIso,
            status: 'active',
            meta: {
              closeDisposition: disposition,
              packagePrice: payload.packagePrice,
              initialPayment: payload.initialPayment,
              monthlyPricing: payload.monthlyPricing,
            },
          }, { actorUserId: s.realActorUserId || s.user.id });
          if (!saved.ok) throw new Error(saved.error || 'account_upsert_failed');
          account = saved.account || null;
          accountUpserted = true;

          await writePortalAudit(s.sbAdmin, {
            actorUserId: s.realActorUserId || s.user.id,
            entityType: 'account',
            entityId: String(account?.id || 'acct_lead_' + leadIdStr),
            action: 'close_auto_upsert',
            beforePayload: null,
            afterPayload: account,
            meta: {
              realActorUserId: s.realActorUserId || s.user.id,
              effectiveActorUserId: s.actorUserId || null,
              viewAsRole: s.viewAsRole || null,
              viewAsUserId: s.viewAsUserId || null,
              leadId,
            },
          }).catch(() => {});
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
    ...(account ? { account } : {}),
    ...(accountError ? { accountError } : {}),
  });
};
