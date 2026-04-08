const crypto = require('crypto');
const { supabaseAdmin } = require('./portalAuth');
const { cleanStr, tableExists, writePortalWorkflowEvent } = require('./portalFoundation');

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value, maxLen) {
  return cleanStr(value, maxLen);
}

function cleanEmail(value) {
  return cleanStr(value, 200).toLowerCase();
}

function cleanPhone(value) {
  return cleanStr(value, 40).replace(/[^\d+x#*()-\.\s]/g, '');
}

function normalizeTags(tags) {
  return asArray(tags)
    .map((tag) => cleanStr(tag, 40).toLowerCase())
    .filter(Boolean)
    .slice(0, 20);
}

function stableDedupKey(source, parts = []) {
  const seed = [cleanStr(source, 40).toLowerCase()]
    .concat(asArray(parts).map((part) => cleanStr(part, 240).toLowerCase()))
    .filter(Boolean)
    .join('|');
  if (!seed) return '';
  return `public_intake:${crypto.createHash('sha1').update(seed).digest('hex')}`;
}

function cleanComparable(value, maxLen = 200) {
  return cleanStr(value, maxLen).toLowerCase();
}

function splitFullName(value) {
  const compact = cleanStr(String(value || '').replace(/\s+/g, ' '), 160);
  if (!compact) return { firstName: '', lastName: '' };
  const parts = compact.split(' ');
  const firstName = cleanStr(parts.shift(), 80);
  const lastName = cleanStr(parts.join(' '), 80);
  return { firstName, lastName };
}

function normalizeLeadIdentity(normalizedData = {}) {
  const data = asObject(normalizedData);
  const contact = asObject(data.contact);
  const property = asObject(data.property);
  const requestedWindow = asObject(data.requestedWindow);
  const nameParts = splitFullName(contact.name);

  return {
    firstName: nameParts.firstName,
    lastName: nameParts.lastName,
    email: cleanEmail(contact.email),
    phone: cleanPhone(contact.phone),
    company: cleanText(contact.company, 120),
    propertyName: cleanText(property.name, 160),
    address: cleanText(property.address, 200),
    city: cleanText(property.city, 120),
    state: cleanText(property.state, 20),
    postalCode: cleanText(property.postalCode, 20),
    requestedDate: cleanText(requestedWindow.date, 20),
    requestedTime: cleanText(requestedWindow.time, 40),
    requestedTz: cleanText(requestedWindow.tz, 80),
  };
}

function publicLeadDefaults(source) {
  const cleanSource = cleanStr(source, 40).toLowerCase();
  if (cleanSource === 'public_booking') {
    return { assignedRole: 'dialer', priority: 3, status: 'new' };
  }
  if (cleanSource === 'public_quote') {
    return { assignedRole: 'dialer', priority: 2, status: 'new' };
  }
  return { assignedRole: 'dialer', priority: 1, status: 'new' };
}

function mergeLeadMeta(existingMeta, nextMeta) {
  const existing = asObject(existingMeta);
  const incoming = asObject(nextMeta);
  const existingPublicIntake = asObject(existing.publicIntake);
  const incomingPublicIntake = asObject(incoming.publicIntake);
  const channels = Array.from(new Set(
    asArray(existingPublicIntake.channels)
      .concat(asArray(incomingPublicIntake.channels))
      .map((item) => cleanStr(item, 40))
      .filter(Boolean)
  ));
  const sources = Array.from(new Set(
    asArray(existingPublicIntake.sources)
      .concat(asArray(incomingPublicIntake.sources))
      .map((item) => cleanStr(item, 40))
      .filter(Boolean)
  ));

  return Object.assign({}, existing, incoming, {
    publicIntake: Object.assign({}, existingPublicIntake, incomingPublicIntake, {
      channels,
      sources,
      firstSource: cleanStr(existingPublicIntake.firstSource || incomingPublicIntake.firstSource, 40),
      lastSource: cleanStr(incomingPublicIntake.lastSource || existingPublicIntake.lastSource, 40),
      lastIntakeId: incomingPublicIntake.lastIntakeId || existingPublicIntake.lastIntakeId || null,
      lastDedupKey: cleanStr(incomingPublicIntake.lastDedupKey || existingPublicIntake.lastDedupKey, 200),
      lastReceivedAt: cleanStr(incomingPublicIntake.lastReceivedAt || existingPublicIntake.lastReceivedAt, 80),
    }),
  });
}

function buildLeadNotes({ source, title, description, leadIdentity }) {
  const lines = [];
  if (title) lines.push(cleanStr(title, 200));
  if (description) lines.push(cleanStr(description, 1200));
  if (leadIdentity.requestedDate || leadIdentity.requestedTime) {
    lines.push(`Requested window: ${[leadIdentity.requestedDate, leadIdentity.requestedTime, leadIdentity.requestedTz].filter(Boolean).join(' ')}`);
  }
  if (source) lines.push(`Source: ${cleanStr(source, 40)}`);
  return cleanStr(lines.filter(Boolean).join('\n'), 5000);
}

function buildLeadActivityPayload({ source, intakeId, dedupKey, intakeChannel, formKey, normalizedData }) {
  return {
    intakeId: intakeId || null,
    dedupKey: cleanStr(dedupKey, 200),
    source: cleanStr(source, 40),
    intakeChannel: cleanStr(intakeChannel, 40),
    formKey: cleanStr(formKey, 80),
    normalizedData: asObject(normalizedData),
  };
}

async function findExistingIntake(sbAdmin, dedupKey) {
  const cleanDedupKey = cleanStr(dedupKey, 200);
  if (!cleanDedupKey) return null;
  const { data, error } = await sbAdmin
    .from('portal_intake_submissions')
    .select('id, dedup_key, normalized_data, meta, submitted_at')
    .eq('dedup_key', cleanDedupKey)
    .limit(1);
  if (error) return null;
  return Array.isArray(data) ? data[0] || null : null;
}

async function findMatchingLead(sbAdmin, leadIdentity) {
  const matchEmail = cleanEmail(leadIdentity.email);
  const matchPhone = cleanPhone(leadIdentity.phone);
  if (!matchEmail && !matchPhone) return null;

  let query = sbAdmin
    .from('portal_leads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(12);

  const matchers = [];
  if (matchEmail) matchers.push(`email.eq.${matchEmail}`);
  if (matchPhone) matchers.push(`phone.eq.${matchPhone}`);
  query = query.or(matchers.join(','));

  const { data, error } = await query;
  if (error) return null;

  const propertyName = cleanComparable(leadIdentity.propertyName, 160);
  const company = cleanComparable(leadIdentity.company, 120);
  const leads = Array.isArray(data) ? data : [];
  let best = null;
  let bestScore = 0;
  for (const row of leads) {
    let score = 0;
    if (matchEmail && cleanEmail(row?.email) === matchEmail) score += 4;
    if (matchPhone && cleanPhone(row?.phone) === matchPhone) score += 4;
    if (propertyName && cleanComparable(row?.property_name, 160) === propertyName) score += 1;
    if (company && cleanComparable(row?.company, 120) === company) score += 1;
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

async function writeLeadActivity(sbAdmin, { leadId, notes, payload }) {
  if (!leadId || !(await tableExists(sbAdmin, 'portal_lead_activities'))) return;

  const intakeId = payload?.intakeId || null;
  if (intakeId) {
    const { data, error } = await sbAdmin
      .from('portal_lead_activities')
      .select('id')
      .eq('lead_id', leadId)
      .eq('activity_type', 'public_intake')
      .contains('payload', { intakeId })
      .limit(1);
    if (!error && Array.isArray(data) && data[0]) return;
  }

  await sbAdmin.from('portal_lead_activities').insert({
    lead_id: leadId,
    created_by: null,
    activity_type: 'public_intake',
    outcome: cleanStr(payload?.source, 80) || 'public_intake',
    notes: cleanStr(notes, 8000),
    payload,
  });
}

async function updateIntakeWithLead(sbAdmin, intake, lead, leadAction) {
  if (!intake?.id || !lead?.id) return;
  const existingNormalized = asObject(intake.normalized_data);
  const existingMeta = asObject(intake.meta);
  const nextNormalized = Object.assign({}, existingNormalized, {
    lead: Object.assign({}, asObject(existingNormalized.lead), {
      id: lead.id,
      source: cleanStr(lead.source, 80),
      status: cleanStr(lead.status, 40),
      assignedRole: cleanStr(lead.assigned_role, 40),
      assignedUserId: cleanStr(lead.assigned_user_id, 80),
      action: cleanStr(leadAction, 20),
    }),
  });
  const nextMeta = Object.assign({}, existingMeta, {
    leadId: lead.id,
    leadAction: cleanStr(leadAction, 20),
    leadCorrelatedAt: new Date().toISOString(),
  });

  await sbAdmin
    .from('portal_intake_submissions')
    .update({
      updated_at: new Date().toISOString(),
      normalized_data: nextNormalized,
      meta: nextMeta,
    })
    .eq('id', intake.id);
}

async function correlateIntakeToLead(sbAdmin, {
  intake = null,
  source = '',
  intakeChannel = '',
  formKey = '',
  title = '',
  description = '',
  normalizedData = {},
  dedupKey = '',
  submittedAt = '',
} = {}) {
  if (!(await tableExists(sbAdmin, 'portal_leads'))) {
    return { ok: false, skipped: true, reason: 'portal_leads_missing' };
  }
  if (!intake?.id) {
    return { ok: false, skipped: true, reason: 'missing_intake_row' };
  }

  const leadIdentity = normalizeLeadIdentity(normalizedData);
  if (!leadIdentity.email && !leadIdentity.phone && !leadIdentity.company && !leadIdentity.propertyName) {
    return { ok: false, skipped: true, reason: 'insufficient_lead_identity' };
  }

  const defaults = publicLeadDefaults(source);
  const notes = buildLeadNotes({ source, title, description, leadIdentity });
  const meta = {
    publicIntake: {
      channels: [cleanStr(intakeChannel, 40) || cleanStr(source, 40)],
      sources: [cleanStr(source, 40)],
      firstSource: cleanStr(source, 40),
      lastSource: cleanStr(source, 40),
      lastIntakeId: intake?.id || null,
      lastDedupKey: cleanStr(dedupKey, 200),
      lastReceivedAt: cleanStr(submittedAt || intake?.submitted_at, 80),
    },
  };

  const existingLead = await findMatchingLead(sbAdmin, leadIdentity);
  let lead = null;
  let action = 'created';

  if (existingLead?.id) {
    const patch = {
      source: cleanStr(existingLead.source, 80) || cleanStr(source, 80),
      priority: Math.max(Number(existingLead.priority || 0), defaults.priority),
      first_name: cleanStr(existingLead.first_name, 80) || leadIdentity.firstName || null,
      last_name: cleanStr(existingLead.last_name, 80) || leadIdentity.lastName || null,
      phone: cleanPhone(existingLead.phone) || leadIdentity.phone || null,
      email: cleanEmail(existingLead.email) || leadIdentity.email || null,
      company: cleanStr(existingLead.company, 120) || leadIdentity.company || null,
      property_name: cleanStr(existingLead.property_name, 160) || leadIdentity.propertyName || null,
      address: cleanStr(existingLead.address, 200) || leadIdentity.address || null,
      city: cleanStr(existingLead.city, 120) || leadIdentity.city || null,
      state: cleanStr(existingLead.state, 20) || leadIdentity.state || null,
      postal_code: cleanStr(existingLead.postal_code, 20) || leadIdentity.postalCode || null,
      notes: cleanStr(existingLead.notes, 5000) || notes || null,
      meta: mergeLeadMeta(existingLead.meta, meta),
    };

    const { data, error } = await sbAdmin
      .from('portal_leads')
      .update(patch)
      .eq('id', existingLead.id)
      .select('*')
      .limit(1);
    if (error) return { ok: false, error: 'lead_update_failed', detail: error.message || '' };
    lead = Array.isArray(data) ? data[0] || null : null;
    action = 'matched';
  } else {
    const { data, error } = await sbAdmin
      .from('portal_leads')
      .insert({
        created_by: null,
        assigned_role: defaults.assignedRole,
        assigned_user_id: null,
        source: cleanStr(source, 80),
        status: defaults.status,
        priority: defaults.priority,
        first_name: leadIdentity.firstName || null,
        last_name: leadIdentity.lastName || null,
        phone: leadIdentity.phone || null,
        email: leadIdentity.email || null,
        company: leadIdentity.company || null,
        property_name: leadIdentity.propertyName || null,
        address: leadIdentity.address || null,
        city: leadIdentity.city || null,
        state: leadIdentity.state || null,
        postal_code: leadIdentity.postalCode || null,
        notes: notes || null,
        meta,
      })
      .select('*')
      .limit(1);
    if (error) return { ok: false, error: 'lead_insert_failed', detail: error.message || '' };
    lead = Array.isArray(data) ? data[0] || null : null;
  }

  if (!lead?.id) return { ok: false, error: 'lead_write_missing_row' };

  const activityPayload = buildLeadActivityPayload({
    source,
    intakeId: intake?.id || null,
    dedupKey,
    intakeChannel,
    formKey,
    normalizedData,
  });
  await writeLeadActivity(sbAdmin, {
    leadId: lead.id,
    notes: description || notes || title,
    payload: activityPayload,
  }).catch(() => {});

  await updateIntakeWithLead(sbAdmin, intake, lead, action).catch(() => {});

  await writePortalWorkflowEvent(sbAdmin, {
    actorUserId: null,
    ownerUserId: lead.assigned_user_id || null,
    entityType: 'lead',
    entityId: String(lead.id),
    eventType: action === 'matched' ? 'lead_routed' : 'lead_created',
    status: 'pending',
    priority: defaults.priority,
    sourceTable: 'portal_leads',
    sourceId: String(lead.id),
    payload: {
      source: cleanStr(source, 40),
      intakeId: intake?.id || null,
      dedupKey: cleanStr(dedupKey, 200),
      action,
    },
    dedupKey: cleanStr(dedupKey, 200) ? `${action === 'matched' ? 'lead_routed' : 'lead_created'}:${cleanStr(dedupKey, 200)}` : '',
    meta: {
      intakeChannel: cleanStr(intakeChannel, 40),
      formKey: cleanStr(formKey, 80),
      visibility: 'public',
    },
  }).catch(() => {});

  return { ok: true, leadId: lead.id, leadAction: action };
}

async function ingestPublicIntake({
  source = 'website',
  intakeChannel = '',
  formKey = '',
  title = '',
  description = '',
  payload = {},
  normalizedData = {},
  tags = [],
  meta = {},
  dedupParts = [],
  dedupKey = '',
  submittedAt = '',
} = {}) {
  const sbAdmin = supabaseAdmin();
  if (!sbAdmin) return { ok: false, skipped: true, reason: 'missing_supabase_service_role' };

  const hasIntake = await tableExists(sbAdmin, 'portal_intake_submissions');
  if (!hasIntake) return { ok: false, skipped: true, reason: 'workflow_foundation_not_applied' };

  const cleanSource = cleanStr(source, 40) || 'website';
  const cleanFormKey = cleanStr(formKey, 80) || null;
  const cleanSubmittedAt = cleanStr(submittedAt, 80) || new Date().toISOString();
  const resolvedDedupKey = cleanStr(dedupKey, 200) || stableDedupKey(cleanSource, dedupParts);

  const row = {
    intake_type: 'general',
    status: 'submitted',
    source: cleanSource,
    form_key: cleanFormKey,
    title: cleanStr(title, 200) || null,
    description: cleanStr(description, 4000) || null,
    payload: asObject(payload),
    normalized_data: asObject(normalizedData),
    tags: normalizeTags(tags),
    dedup_key: resolvedDedupKey || null,
    meta: Object.assign({}, asObject(meta), {
      intakeChannel: cleanStr(intakeChannel, 40) || cleanSource,
      visibility: 'public',
    }),
    submitted_at: cleanSubmittedAt,
  };

  const { data, error } = await sbAdmin
    .from('portal_intake_submissions')
    .insert(row)
    .select('id, created_at, submitted_at, dedup_key, normalized_data, meta')
    .limit(1);

  let intake = Array.isArray(data) ? data[0] || null : null;

  if (error) {
    if (String(error.code || '') === '23505' && resolvedDedupKey) {
      intake = await findExistingIntake(sbAdmin, resolvedDedupKey);
      const leadLink = await correlateIntakeToLead(sbAdmin, {
        intake,
        source: cleanSource,
        intakeChannel,
        formKey: cleanFormKey,
        title,
        description,
        normalizedData,
        dedupKey: resolvedDedupKey,
        submittedAt: cleanSubmittedAt,
      }).catch(() => ({ ok: false, skipped: true, reason: 'lead_correlation_failed' }));
      return {
        ok: true,
        duplicate: true,
        intakeId: intake?.id || null,
        dedupKey: resolvedDedupKey,
        leadId: leadLink?.leadId || intake?.meta?.leadId || null,
        leadAction: leadLink?.leadAction || '',
      };
    }
    return { ok: false, error: 'intake_insert_failed', detail: error.message || '' };
  }

  await writePortalWorkflowEvent(sbAdmin, {
    actorUserId: null,
    ownerUserId: null,
    entityType: 'intake_submission',
    entityId: String(intake?.id || ''),
    eventType: 'website_intake_received',
    status: 'pending',
    priority: 4,
    sourceTable: 'portal_intake_submissions',
    sourceId: String(intake?.id || ''),
    intakeSubmissionId: intake?.id || null,
    payload: {
      source: cleanSource,
      formKey: cleanFormKey,
      normalizedData: asObject(normalizedData),
    },
    dedupKey: intake?.dedup_key ? `website_intake_received:${intake.dedup_key}` : '',
    meta: { visibility: 'public', intakeChannel: cleanStr(intakeChannel, 40) || cleanSource },
  }).catch(() => {});

  const leadLink = await correlateIntakeToLead(sbAdmin, {
    intake,
    source: cleanSource,
    intakeChannel,
    formKey: cleanFormKey,
    title,
    description,
    normalizedData,
    dedupKey: intake?.dedup_key || resolvedDedupKey,
    submittedAt: cleanSubmittedAt,
  }).catch(() => ({ ok: false, skipped: true, reason: 'lead_correlation_failed' }));

  return {
    ok: true,
    intakeId: intake?.id || null,
    dedupKey: intake?.dedup_key || resolvedDedupKey || '',
    leadId: leadLink?.leadId || null,
    leadAction: leadLink?.leadAction || '',
  };
}

module.exports = {
  cleanEmail,
  cleanPhone,
  cleanText,
  ingestPublicIntake,
  stableDedupKey,
};