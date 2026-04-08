const { cleanStr, tableExists } = require('./portalFoundation');
const { isValidEmail } = require('./vercelApi');

const LEGACY_ACCOUNTS_KEY = 'portal:accounts:v1';

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

function daysInMonth(year, monthIndex0) {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

function addDaysYmd(ymd, days) {
  const s = cleanDate(ymd);
  if (!s) return '';
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + Number(days || 0));
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
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

function normalizeAccount(a) {
  if (!isPlainObject(a)) return null;
  const out = {
    id: cleanStr(a.id, 80),
    foundationId: a.foundationId != null ? Number(a.foundationId) : null,
    legacyAccountId: cleanStr(a.legacyAccountId || a.legacy_account_id || '', 80),
    name: cleanStr(a.name, 200),
    leadId: cleanStr(a.leadId || a.sourceLeadId || '', 80),
    propertyName: cleanStr(a.propertyName, 200),
    address: cleanStr(a.address, 240),
    city: cleanStr(a.city, 120),
    state: cleanStr(a.state, 20),
    postalCode: cleanStr(a.postalCode, 20),
    primaryContactName: cleanStr(a.primaryContactName, 200),
    primaryContactEmail: cleanStr(a.primaryContactEmail, 200),
    primaryContactPhone: cleanStr(a.primaryContactPhone, 80),
    contractTier: cleanStr(a.contractTier || a.tier, 40),
    termMonths: clampInt(a.termMonths, 0, 1200, 0),
    contractSendDate: cleanDate(a.contractSendDate),
    contractStart: cleanDate(a.contractStart),
    contractEnd: cleanDate(a.contractEnd),
    renewalReminderDays: clampInt(a.renewalReminderDays, 0, 3650, 30),
    renewalReminderDate: cleanDate(a.renewalReminderDate) || '',
    email: cleanStr(a.email, 200),
    phone: cleanStr(a.phone, 80),
    notes: cleanStr(a.notes, 8000),
    createdAt: cleanStr(a.createdAt, 80),
    updatedAt: cleanStr(a.updatedAt, 80),
    status: cleanStr(a.status, 40) || 'prospect',
    accountOwnerUserId: cleanStr(a.accountOwnerUserId, 80),
    closerUserId: cleanStr(a.closerUserId, 80),
    coordinatorUserId: cleanStr(a.coordinatorUserId, 80),
    meta: isPlainObject(a.meta) ? a.meta : {},
  };
  if (!out.name) return null;
  if (!out.id) out.id = out.legacyAccountId || (out.foundationId ? String(out.foundationId) : '');
  if (!out.id) return null;

  if (!out.propertyName) out.propertyName = out.name;
  if (!out.primaryContactEmail && out.email) out.primaryContactEmail = out.email;
  if (!out.primaryContactPhone && out.phone) out.primaryContactPhone = out.phone;
  if (out.primaryContactEmail && !isValidEmail(out.primaryContactEmail)) out.primaryContactEmail = '';
  if (!out.contractEnd && out.contractStart && out.termMonths > 0) {
    out.contractEnd = addMonthsYmd(out.contractStart, out.termMonths);
  }
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

function mapOrganizationRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: Number(row.id || 0) || null,
    name: cleanStr(row.org_name, 200),
    status: cleanStr(row.status, 40),
    industry: cleanStr(row.industry, 120),
    portfolioSize: Number(row.portfolio_size || 0) || 0,
    primaryCity: cleanStr(row.primary_city, 120),
    primaryState: cleanStr(row.primary_state, 20),
  };
}

function mapPropertyRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: Number(row.id || 0) || null,
    accountId: Number(row.account_id || 0) || null,
    organizationId: Number(row.organization_id || 0) || null,
    name: cleanStr(row.property_name, 200),
    code: cleanStr(row.property_code, 80),
    status: cleanStr(row.status, 40),
    marketCode: cleanStr(row.market_code, 80),
    timezone: cleanStr(row.timezone, 80),
    city: cleanStr(row.city, 120),
    state: cleanStr(row.state, 20),
    launchStage: cleanStr(row.launch_stage, 80),
  };
}

function mapLocationRow(row, operatingProfile = null) {
  if (!row || typeof row !== 'object') return null;
  const profile = operatingProfile && typeof operatingProfile === 'object' ? operatingProfile : null;
  return {
    id: Number(row.id || 0) || null,
    accountId: Number(row.account_id || 0) || null,
    propertyId: Number(row.property_id || 0) || null,
    name: cleanStr(row.location_name, 200),
    code: cleanStr(row.location_code, 80),
    status: cleanStr(row.status, 40),
    city: cleanStr(row.city, 120),
    state: cleanStr(row.state, 20),
    timezone: cleanStr(row.timezone, 80),
    defaultEventTypeCode: cleanStr(row.default_event_type_code, 80),
    marketCode: cleanStr(row.market_code, 80),
    operatingProfile: profile ? {
      accessWindow: cleanStr(profile.access_window, 200),
      parkingNotes: cleanStr(profile.parking_notes, 500),
      loadingNotes: cleanStr(profile.loading_notes, 500),
      contactInstructions: cleanStr(profile.contact_instructions, 500),
      insuranceRequired: !!profile.insurance_required,
      w9Required: !!profile.w9_required,
      defaultSetupMinutes: Number(profile.default_setup_minutes || 0) || 0,
      defaultTeardownMinutes: Number(profile.default_teardown_minutes || 0) || 0,
    } : null,
  };
}

function summarizeAccountHealth(events = []) {
  const list = Array.isArray(events) ? events : [];
  const openEvents = list.filter((row) => !['resolved', 'closed'].includes(cleanStr(row?.status, 40).toLowerCase()));
  const atRiskEvents = list.filter((row) => ['high', 'critical'].includes(cleanStr(row?.severity, 40).toLowerCase()));
  return {
    total: list.length,
    open: openEvents.length,
    atRisk: atRiskEvents.length,
    lastEventAt: cleanStr(list[0]?.created_at, 80),
  };
}

async function getKv(sbAdmin, key) {
  const { data, error } = await sbAdmin
    .from('purestay_kv')
    .select('key, value, updated_at')
    .eq('key', key)
    .limit(1);
  if (error) return { ok: false, error: 'kv_read_failed', detail: error.message || '' };
  const row = Array.isArray(data) ? data[0] : null;
  return { ok: true, row };
}

async function upsertKv(sbAdmin, key, value) {
  const { data, error } = await sbAdmin
    .from('purestay_kv')
    .upsert({ key, value }, { onConflict: 'key' })
    .select('key, value, updated_at')
    .limit(1);
  if (error) return { ok: false, error: 'kv_write_failed', detail: error.message || '' };
  return { ok: true, row: Array.isArray(data) ? data[0] : null };
}

async function loadLegacyAccounts(sbAdmin) {
  const r = await getKv(sbAdmin, LEGACY_ACCOUNTS_KEY);
  if (!r.ok) return { ok: false, error: r.error, detail: r.detail || '' };
  const store = (r.row?.value && typeof r.row.value === 'object') ? r.row.value : {};
  const list = Array.isArray(store.accounts) ? store.accounts : [];
  return { ok: true, accounts: list.map(normalizeAccount).filter(Boolean) };
}

function mapRelationalAccount(row, contact, extras = {}) {
  const primary = contact && typeof contact === 'object' ? contact : {};
  const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
  const organization = mapOrganizationRow(extras.organization);
  const property = mapPropertyRow(extras.property);
  const locations = Array.isArray(extras.locations) ? extras.locations.map((location) => mapLocationRow(location.row || location, location.profile || null)).filter(Boolean) : [];
  const healthEvents = Array.isArray(extras.healthEvents) ? extras.healthEvents : [];
  const account = normalizeAccount({
    id: String(row?.id || ''),
    foundationId: row?.id || null,
    legacyAccountId: row?.legacy_account_id || '',
    name: row?.name || row?.property_name || '',
    leadId: row?.source_lead_id != null ? String(row.source_lead_id) : '',
    propertyName: row?.property_name || row?.name || '',
    address: row?.address || '',
    city: row?.city || '',
    state: row?.state || '',
    postalCode: row?.postal_code || '',
    primaryContactName: primary?.full_name || '',
    primaryContactEmail: primary?.email || '',
    primaryContactPhone: primary?.phone || '',
    contractTier: row?.contract_tier || '',
    termMonths: row?.term_months || 0,
    contractSendDate: meta?.contractSendDate || '',
    contractStart: row?.contract_start || '',
    contractEnd: row?.contract_end || '',
    renewalReminderDays: row?.renewal_reminder_days || 30,
    renewalReminderDate: row?.renewal_reminder_date || '',
    email: primary?.email || '',
    phone: primary?.phone || '',
    notes: row?.notes || '',
    createdAt: row?.created_at || '',
    updatedAt: row?.updated_at || row?.created_at || '',
    status: row?.status || 'prospect',
    accountOwnerUserId: row?.account_owner_user_id || '',
    closerUserId: row?.closer_user_id || '',
    coordinatorUserId: row?.coordinator_user_id || '',
    meta,
  });
  if (!account) return null;
  account.organizationId = Number(row?.organization_id || 0) || null;
  account.primaryPropertyId = Number(row?.primary_property_id || 0) || null;
  account.organization = organization;
  account.property = property;
  account.locations = locations;
  account.locationCount = locations.length;
  account.healthSummary = summarizeAccountHealth(healthEvents);
  return account;
}

async function ensureClientFoundationForAccount(sbAdmin, row) {
  const hasOrganizations = await tableExists(sbAdmin, 'portal_client_organizations');
  const hasProperties = await tableExists(sbAdmin, 'portal_properties');
  if (!hasOrganizations || !hasProperties || !row?.id) return { ok: true, skipped: true };

  const orgKey = `account:${row.id}`;
  const orgPayload = {
    legacy_org_key: orgKey,
    org_name: cleanStr(row.name || row.property_name, 200) || `Account ${row.id}`,
    status: cleanStr(row.status, 40) === 'closed' ? 'inactive' : 'active',
    primary_city: cleanStr(row.city, 120) || null,
    primary_state: cleanStr(row.state, 20) || null,
    notes: cleanStr(row.notes, 4000) || null,
    meta: { syncSource: 'lib/portalAccounts' },
  };
  const { data: orgData, error: orgError } = await sbAdmin
    .from('portal_client_organizations')
    .upsert(orgPayload, { onConflict: 'legacy_org_key' })
    .select('*')
    .limit(1);
  if (orgError) return { ok: false, error: 'client_org_sync_failed', detail: orgError.message || '' };
  const organization = Array.isArray(orgData) ? orgData[0] || null : null;

  const propertyPayload = {
    legacy_property_key: orgKey,
    account_id: row.id,
    organization_id: organization?.id || null,
    property_name: cleanStr(row.property_name || row.name, 200) || `Property ${row.id}`,
    property_code: `PROP-${row.id}`,
    status: cleanStr(row.status, 40) === 'closed' ? 'inactive' : 'active',
    market_code: null,
    timezone: cleanStr(row.meta?.timezone, 80) || null,
    address: cleanStr(row.address, 240) || null,
    city: cleanStr(row.city, 120) || null,
    state: cleanStr(row.state, 20) || null,
    postal_code: cleanStr(row.postal_code, 20) || null,
    launch_stage: cleanStr(row.meta?.launchStage, 80) || null,
    notes: cleanStr(row.notes, 4000) || null,
    meta: { syncSource: 'lib/portalAccounts' },
  };
  const { data: propertyData, error: propertyError } = await sbAdmin
    .from('portal_properties')
    .upsert(propertyPayload, { onConflict: 'legacy_property_key' })
    .select('*')
    .limit(1);
  if (propertyError) return { ok: false, error: 'property_sync_failed', detail: propertyError.message || '' };
  const property = Array.isArray(propertyData) ? propertyData[0] || null : null;

  const { data: updatedAccountData, error: accountUpdateError } = await sbAdmin
    .from('portal_accounts')
    .update({ organization_id: organization?.id || null, primary_property_id: property?.id || null, updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .select('*')
    .limit(1);
  if (accountUpdateError) return { ok: false, error: 'account_link_sync_failed', detail: accountUpdateError.message || '' };
  const accountRow = Array.isArray(updatedAccountData) ? updatedAccountData[0] || row : row;

  if (await tableExists(sbAdmin, 'portal_locations')) {
    await sbAdmin
      .from('portal_locations')
      .update({ property_id: property?.id || null })
      .eq('account_id', row.id);
  }

  return { ok: true, organization, property, accountRow };
}

async function upsertRelationalAccount(sbAdmin, account, actorUserId) {
  const normalized = normalizeAccount(account);
  if (!normalized) return { ok: false, error: 'invalid_account_payload' };
  const nowIso = new Date().toISOString();
  const hasAccounts = await tableExists(sbAdmin, 'portal_accounts');
  if (!hasAccounts) return { ok: false, error: 'portal_accounts_missing' };

  let existing = null;
  const idAsNum = Number(normalized.id);
  if (Number.isFinite(idAsNum) && idAsNum > 0) {
    const { data } = await sbAdmin
      .from('portal_accounts')
      .select('*')
      .eq('id', idAsNum)
      .limit(1);
    existing = Array.isArray(data) ? data[0] || null : null;
  }
  if (!existing && normalized.legacyAccountId) {
    const { data } = await sbAdmin
      .from('portal_accounts')
      .select('*')
      .eq('legacy_account_id', normalized.legacyAccountId)
      .limit(1);
    existing = Array.isArray(data) ? data[0] || null : null;
  }
  if (!existing && normalized.id && !Number.isFinite(idAsNum)) {
    const { data } = await sbAdmin
      .from('portal_accounts')
      .select('*')
      .eq('legacy_account_id', normalized.id)
      .limit(1);
    existing = Array.isArray(data) ? data[0] || null : null;
  }

  const payload = {
    legacy_account_id: normalized.legacyAccountId || (!Number.isFinite(idAsNum) ? normalized.id : (existing?.legacy_account_id || null)),
    updated_at: nowIso,
    created_by: existing?.created_by || actorUserId || null,
    source_lead_id: normalized.leadId ? clampInt(normalized.leadId, 1, 1e12, null) : null,
    name: normalized.name,
    property_name: normalized.propertyName || normalized.name,
    status: ['prospect','active','paused','at_risk','renewal','closed'].includes(normalized.status) ? normalized.status : (existing?.status || 'prospect'),
    account_owner_user_id: normalized.accountOwnerUserId || existing?.account_owner_user_id || null,
    closer_user_id: normalized.closerUserId || existing?.closer_user_id || null,
    coordinator_user_id: normalized.coordinatorUserId || existing?.coordinator_user_id || null,
    address: normalized.address || null,
    city: normalized.city || null,
    state: normalized.state || null,
    postal_code: normalized.postalCode || null,
    contract_tier: normalized.contractTier || null,
    contract_start: normalized.contractStart || null,
    contract_end: normalized.contractEnd || null,
    term_months: normalized.termMonths || null,
    renewal_reminder_days: normalized.renewalReminderDays || 30,
    renewal_reminder_date: normalized.renewalReminderDate || null,
    notes: normalized.notes || null,
    meta: Object.assign({}, existing?.meta && typeof existing.meta === 'object' ? existing.meta : {}, normalized.meta || {}, {
      contractSendDate: normalized.contractSendDate || existing?.meta?.contractSendDate || null,
      legacyEmail: normalized.email || null,
      legacyPhone: normalized.phone || null,
    }),
  };
  if (!existing) payload.created_at = normalized.createdAt || nowIso;

  let query = sbAdmin.from('portal_accounts').upsert(payload, {
    onConflict: payload.legacy_account_id ? 'legacy_account_id' : 'id',
  }).select('*').limit(1);

  if (existing?.id) query = sbAdmin.from('portal_accounts').update(payload).eq('id', existing.id).select('*').limit(1);
  const { data, error } = await query;
  if (error) return { ok: false, error: 'account_upsert_failed', detail: error.message || '' };
  let row = Array.isArray(data) ? data[0] || null : null;
  if (!row) return { ok: false, error: 'account_upsert_missing_row' };

  const hasContacts = await tableExists(sbAdmin, 'portal_account_contacts');
  let primary = null;
  if (hasContacts && (normalized.primaryContactName || normalized.primaryContactEmail || normalized.primaryContactPhone)) {
    const { data: contacts } = await sbAdmin
      .from('portal_account_contacts')
      .select('*')
      .eq('account_id', row.id)
      .order('is_primary', { ascending: false })
      .order('id', { ascending: true })
      .limit(10);
    const existingPrimary = Array.isArray(contacts)
      ? (contacts.find((c) => c.is_primary) || contacts[0] || null)
      : null;
    const contactPayload = {
      account_id: row.id,
      full_name: normalized.primaryContactName || existingPrimary?.full_name || normalized.name,
      email: normalized.primaryContactEmail || null,
      phone: normalized.primaryContactPhone || null,
      is_primary: true,
      title: existingPrimary?.title || null,
      meta: existingPrimary?.meta && typeof existingPrimary.meta === 'object' ? existingPrimary.meta : {},
    };
    let contactQuery;
    if (existingPrimary?.id) {
      contactQuery = sbAdmin.from('portal_account_contacts').update(contactPayload).eq('id', existingPrimary.id).select('*').limit(1);
    } else {
      contactQuery = sbAdmin.from('portal_account_contacts').insert(contactPayload).select('*').limit(1);
    }
    const { data: contactData } = await contactQuery;
    primary = Array.isArray(contactData) ? contactData[0] || null : null;
  }
  const foundationSync = await ensureClientFoundationForAccount(sbAdmin, row).catch(() => ({ ok: false }));
  if (foundationSync?.ok && foundationSync.accountRow) row = foundationSync.accountRow;

  return {
    ok: true,
    account: mapRelationalAccount(row, primary, {
      organization: foundationSync?.organization || null,
      property: foundationSync?.property || null,
      locations: [],
      healthEvents: [],
    }),
    row,
    primaryContact: primary,
  };
}

async function mirrorRelationalAccountsToLegacy(sbAdmin) {
  const hasAccounts = await tableExists(sbAdmin, 'portal_accounts');
  if (!hasAccounts) return { ok: true, skipped: true };
  const { data: rows, error } = await sbAdmin
    .from('portal_accounts')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) return { ok: false, error: 'accounts_query_failed', detail: error.message || '' };
  const accountIds = (rows || []).map((r) => r.id).filter(Boolean);
  let contacts = [];
  if (accountIds.length && await tableExists(sbAdmin, 'portal_account_contacts')) {
    const { data } = await sbAdmin
      .from('portal_account_contacts')
      .select('*')
      .in('account_id', accountIds)
      .order('is_primary', { ascending: false })
      .order('id', { ascending: true })
      .limit(1000);
    contacts = Array.isArray(data) ? data : [];
  }
  const contactByAccount = new Map();
  for (const contact of contacts) {
    if (!contactByAccount.has(contact.account_id)) contactByAccount.set(contact.account_id, contact);
  }
  const accounts = (rows || []).map((row) => mapRelationalAccount(row, contactByAccount.get(row.id))).filter(Boolean);
  const w = await upsertKv(sbAdmin, LEGACY_ACCOUNTS_KEY, { accounts: sortAccounts(accounts) });
  if (!w.ok) return { ok: false, error: w.error, detail: w.detail || '' };
  return { ok: true, accounts };
}

async function backfillRelationalAccountsFromLegacy(sbAdmin, actorUserId) {
  const hasAccounts = await tableExists(sbAdmin, 'portal_accounts');
  if (!hasAccounts) return { ok: true, skipped: true };
  const legacy = await loadLegacyAccounts(sbAdmin);
  if (!legacy.ok || !legacy.accounts.length) return { ok: legacy.ok, skipped: true, error: legacy.error, detail: legacy.detail || '' };
  for (const account of legacy.accounts) {
    const existingLegacyId = cleanStr(account.legacyAccountId || account.id, 80);
    const { data } = await sbAdmin
      .from('portal_accounts')
      .select('id, legacy_account_id')
      .eq('legacy_account_id', existingLegacyId)
      .limit(1);
    const exists = Array.isArray(data) ? data[0] || null : null;
    if (exists) continue;
    await upsertRelationalAccount(sbAdmin, Object.assign({}, account, { legacyAccountId: existingLegacyId }), actorUserId);
  }
  return { ok: true };
}

async function listAccounts(sbAdmin, { actorUserId = '' } = {}) {
  const hasAccounts = await tableExists(sbAdmin, 'portal_accounts');
  if (hasAccounts) {
    await backfillRelationalAccountsFromLegacy(sbAdmin, actorUserId).catch(() => {});
    let { data: rows, error } = await sbAdmin
      .from('portal_accounts')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(500);
    if (!error) {
      rows = Array.isArray(rows) ? rows : [];
      const needsFoundationSync = rows.filter((row) => !Number(row?.organization_id || 0) || !Number(row?.primary_property_id || 0));
      for (const row of needsFoundationSync.slice(0, 50)) {
        await ensureClientFoundationForAccount(sbAdmin, row).catch(() => {});
      }
      if (needsFoundationSync.length) {
        const refreshed = await sbAdmin
          .from('portal_accounts')
          .select('*')
          .order('updated_at', { ascending: false })
          .limit(500);
        if (!refreshed.error) rows = Array.isArray(refreshed.data) ? refreshed.data : rows;
      }

      const accountIds = (rows || []).map((r) => r.id).filter(Boolean);
      const orgIds = Array.from(new Set((rows || []).map((r) => Number(r.organization_id || 0)).filter((id) => Number.isFinite(id) && id > 0)));
      const propertyIds = Array.from(new Set((rows || []).map((r) => Number(r.primary_property_id || 0)).filter((id) => Number.isFinite(id) && id > 0)));
      let contacts = [];
      if (accountIds.length && await tableExists(sbAdmin, 'portal_account_contacts')) {
        const { data } = await sbAdmin
          .from('portal_account_contacts')
          .select('*')
          .in('account_id', accountIds)
          .order('is_primary', { ascending: false })
          .order('id', { ascending: true })
          .limit(1000);
        contacts = Array.isArray(data) ? data : [];
      }
      let organizations = [];
      if (orgIds.length && await tableExists(sbAdmin, 'portal_client_organizations')) {
        const { data } = await sbAdmin
          .from('portal_client_organizations')
          .select('*')
          .in('id', orgIds)
          .limit(1000);
        organizations = Array.isArray(data) ? data : [];
      }
      let properties = [];
      if (propertyIds.length && await tableExists(sbAdmin, 'portal_properties')) {
        const { data } = await sbAdmin
          .from('portal_properties')
          .select('*')
          .in('id', propertyIds)
          .limit(1000);
        properties = Array.isArray(data) ? data : [];
      }
      let locations = [];
      if (accountIds.length && await tableExists(sbAdmin, 'portal_locations')) {
        const { data } = await sbAdmin
          .from('portal_locations')
          .select('*')
          .in('account_id', accountIds)
          .limit(2000);
        locations = Array.isArray(data) ? data : [];
      }
      let locationProfiles = [];
      const locationIds = locations.map((row) => Number(row.id || 0)).filter((id) => Number.isFinite(id) && id > 0);
      if (locationIds.length && await tableExists(sbAdmin, 'portal_location_operating_profiles')) {
        const { data } = await sbAdmin
          .from('portal_location_operating_profiles')
          .select('*')
          .in('location_id', locationIds)
          .limit(2000);
        locationProfiles = Array.isArray(data) ? data : [];
      }
      let healthEvents = [];
      if (accountIds.length && await tableExists(sbAdmin, 'portal_account_health_events')) {
        const { data } = await sbAdmin
          .from('portal_account_health_events')
          .select('account_id, event_type, severity, status, created_at')
          .in('account_id', accountIds)
          .order('created_at', { ascending: false })
          .limit(2000);
        healthEvents = Array.isArray(data) ? data : [];
      }
      const contactByAccount = new Map();
      for (const contact of contacts) {
        if (!contactByAccount.has(contact.account_id)) contactByAccount.set(contact.account_id, contact);
      }
      const orgById = new Map(organizations.map((row) => [Number(row.id), row]));
      const propertyById = new Map(properties.map((row) => [Number(row.id), row]));
      const profileByLocationId = new Map(locationProfiles.map((row) => [Number(row.location_id), row]));
      const locationsByAccount = new Map();
      for (const location of locations) {
        const accountId = Number(location.account_id || 0);
        if (!Number.isFinite(accountId) || accountId <= 0) continue;
        if (!locationsByAccount.has(accountId)) locationsByAccount.set(accountId, []);
        locationsByAccount.get(accountId).push({ row: location, profile: profileByLocationId.get(Number(location.id || 0)) || null });
      }
      const healthByAccount = new Map();
      for (const event of healthEvents) {
        const accountId = Number(event.account_id || 0);
        if (!Number.isFinite(accountId) || accountId <= 0) continue;
        if (!healthByAccount.has(accountId)) healthByAccount.set(accountId, []);
        healthByAccount.get(accountId).push(event);
      }
      const accounts = sortAccounts((rows || []).map((row) => mapRelationalAccount(row, contactByAccount.get(row.id), {
        organization: orgById.get(Number(row.organization_id || 0)) || null,
        property: propertyById.get(Number(row.primary_property_id || 0)) || null,
        locations: locationsByAccount.get(Number(row.id || 0)) || [],
        healthEvents: healthByAccount.get(Number(row.id || 0)) || [],
      })).filter(Boolean));
      if (accounts.length) return { ok: true, accounts, source: 'portal_accounts', ready: true };
    }
  }
  const legacy = await loadLegacyAccounts(sbAdmin);
  if (!legacy.ok) return { ok: false, error: legacy.error, detail: legacy.detail || '' };
  return { ok: true, accounts: sortAccounts(legacy.accounts), source: 'legacy_kv', ready: false };
}

async function upsertAccount(sbAdmin, account, { actorUserId = '' } = {}) {
  const hasAccounts = await tableExists(sbAdmin, 'portal_accounts');
  if (!hasAccounts) {
    const legacy = await loadLegacyAccounts(sbAdmin);
    if (!legacy.ok) return legacy;
    const normalized = normalizeAccount(account);
    if (!normalized) return { ok: false, error: 'invalid_account_payload' };
    const next = sortAccounts([normalized, ...legacy.accounts.filter((a) => String(a.id) !== String(normalized.id))]);
    const w = await upsertKv(sbAdmin, LEGACY_ACCOUNTS_KEY, { accounts: next });
    if (!w.ok) return { ok: false, error: w.error, detail: w.detail || '' };
    return { ok: true, account: normalized, source: 'legacy_kv', ready: false };
  }
  const result = await upsertRelationalAccount(sbAdmin, account, actorUserId);
  if (!result.ok) return result;
  await mirrorRelationalAccountsToLegacy(sbAdmin).catch(() => {});
  return { ok: true, account: result.account, source: 'portal_accounts', ready: true };
}

async function deleteAccount(sbAdmin, accountId) {
  const id = cleanStr(accountId, 80);
  if (!id) return { ok: false, error: 'id_required' };
  const hasAccounts = await tableExists(sbAdmin, 'portal_accounts');
  if (!hasAccounts) {
    const legacy = await loadLegacyAccounts(sbAdmin);
    if (!legacy.ok) return legacy;
    const next = sortAccounts(legacy.accounts.filter((a) => String(a.id) !== id));
    const w = await upsertKv(sbAdmin, LEGACY_ACCOUNTS_KEY, { accounts: next });
    if (!w.ok) return { ok: false, error: w.error, detail: w.detail || '' };
    return { ok: true, source: 'legacy_kv', ready: false };
  }
  const maybeNum = Number(id);
  let deleteQuery = null;
  if (Number.isFinite(maybeNum) && maybeNum > 0) {
    deleteQuery = sbAdmin.from('portal_accounts').delete().eq('id', maybeNum);
  } else {
    deleteQuery = sbAdmin.from('portal_accounts').delete().eq('legacy_account_id', id);
  }
  const { error } = await deleteQuery;
  if (error) return { ok: false, error: 'account_delete_failed', detail: error.message || '' };
  await mirrorRelationalAccountsToLegacy(sbAdmin).catch(() => {});
  return { ok: true, source: 'portal_accounts', ready: true };
}

function findAccountForEvent(accounts, ev) {
  const list = Array.isArray(accounts) ? accounts : [];
  const meta = ev?.meta && typeof ev.meta === 'object' ? ev.meta : {};
  const wantedId = cleanStr(meta.accountId, 80);
  if (wantedId) {
    const byId = list.find((a) => cleanStr(a?.id, 80) === wantedId || cleanStr(a?.legacyAccountId, 80) === wantedId);
    if (byId) return byId;
  }
  const propertyName = cleanStr(meta.propertyName || ev?.title || '', 200).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!propertyName) return null;
  const candidates = [];
  for (const a of list) {
    const ak = cleanStr(a?.propertyName || a?.name || '', 200).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!ak) continue;
    if (ak === propertyName) return a;
    if (ak.includes(propertyName) || propertyName.includes(ak)) candidates.push(a);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

module.exports = {
  LEGACY_ACCOUNTS_KEY,
  cleanDate,
  clampInt,
  addMonthsYmd,
  computeRenewalReminderDate,
  normalizeAccount,
  sortAccounts,
  loadLegacyAccounts,
  listAccounts,
  upsertAccount,
  deleteAccount,
  findAccountForEvent,
  mirrorRelationalAccountsToLegacy,
};
