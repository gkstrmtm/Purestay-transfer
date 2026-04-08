const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { cleanStr } = require('../../lib/portalFoundation');
const { ingestPublicIntake, cleanEmail, cleanPhone, cleanText, stableDedupKey } = require('../../lib/portalIntake');

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeContact(body = {}) {
  const raw = asObject(body.contact);
  const firstName = cleanText(body.firstName || raw.firstName, 80);
  const lastName = cleanText(body.lastName || raw.lastName, 80);
  const name = cleanText(raw.name || [firstName, lastName].filter(Boolean).join(' '), 160);
  return {
    name,
    email: cleanEmail(body.email || raw.email),
    phone: cleanPhone(body.phone || raw.phone),
    company: cleanText(body.company || raw.company, 120),
  };
}

function normalizeProperty(body = {}) {
  const raw = asObject(body.property);
  return {
    name: cleanText(body.propertyName || raw.name, 160),
    address: cleanText(body.address || raw.address, 200),
    city: cleanText(body.city || raw.city, 120),
    state: cleanText(body.state || raw.state, 20),
    postalCode: cleanText(body.postalCode || raw.postalCode, 20),
  };
}

function normalizeRequestedWindow(body = {}) {
  const raw = asObject(body.requestedWindow);
  return {
    date: cleanText(body.requestedDate || raw.date, 20),
    time: cleanText(body.requestedTime || raw.time, 40),
    tz: cleanText(body.requestedTz || raw.tz, 80),
  };
}

function normalizeContext(body = {}, req) {
  const raw = asObject(body.context);
  return {
    landingPage: cleanText(raw.landingPage || body.landingPage, 240),
    pagePath: cleanText(raw.pagePath || body.pagePath, 240),
    referrer: cleanText(raw.referrer || body.referrer || req?.headers?.referer, 500),
    campaign: cleanText(raw.campaign || body.campaign, 160),
    utmSource: cleanText(raw.utmSource || body.utmSource, 120),
    utmMedium: cleanText(raw.utmMedium || body.utmMedium, 120),
    utmCampaign: cleanText(raw.utmCampaign || body.utmCampaign, 160),
    userAgent: cleanText(raw.userAgent || req?.headers?.['user-agent'], 500),
  };
}

function buildNormalizedData(body, req) {
  return {
    contact: normalizeContact(body),
    property: normalizeProperty(body),
    requestedWindow: normalizeRequestedWindow(body),
    context: normalizeContext(body, req),
  };
}

function hasIdentitySignal(normalizedData = {}) {
  const contact = asObject(normalizedData.contact);
  const property = asObject(normalizedData.property);
  return !!(
    cleanText(contact.name, 160) ||
    cleanEmail(contact.email) ||
    cleanPhone(contact.phone) ||
    cleanText(contact.company, 120) ||
    cleanText(property.name, 160)
  );
}

function normalizeTags(value) {
  return asArray(value)
    .map((item) => cleanStr(item, 40).toLowerCase())
    .filter(Boolean)
    .slice(0, 20);
}

function resolveTitle(body, normalizedData, source) {
  const explicit = cleanText(body.title, 200);
  if (explicit) return explicit;

  const propertyName = cleanText(normalizedData?.property?.name, 160);
  const contactName = cleanText(normalizedData?.contact?.name, 160);
  if (propertyName) return `${propertyName} intake`;
  if (contactName) return `${contactName} inquiry`;
  return `${cleanStr(source, 40) || 'website'} intake`;
}

function resolveDescription(body, normalizedData) {
  const parts = [
    cleanText(body.description, 4000),
    cleanText(body.message, 4000),
    cleanText(body.notes, 4000),
  ].filter(Boolean);

  const requestedWindow = asObject(normalizedData.requestedWindow);
  const requestedSummary = [requestedWindow.date, requestedWindow.time, requestedWindow.tz].filter(Boolean).join(' ');
  if (requestedSummary) parts.push(`Requested window: ${requestedSummary}`);

  return cleanText(parts.join('\n'), 4000);
}

function resolveMeta(body, normalizedData) {
  const meta = asObject(body.meta);
  return Object.assign({}, meta, {
    context: asObject(normalizedData.context),
  });
}

function resolvePayload(body) {
  return asObject(body);
}

function resolveDedupKey(body, source, formKey, normalizedData) {
  const explicit = cleanStr(body.dedupKey || body.dedup_key, 200);
  if (explicit) return explicit;

  const contact = asObject(normalizedData.contact);
  const property = asObject(normalizedData.property);
  const requestedWindow = asObject(normalizedData.requestedWindow);
  return stableDedupKey(source, [
    formKey,
    cleanEmail(contact.email),
    cleanPhone(contact.phone),
    cleanText(property.name, 160),
    cleanText(requestedWindow.date, 20),
    cleanText(requestedWindow.time, 40),
  ]);
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { ok: false, error: 'invalid_body' });
  }

  const source = cleanStr(body.source, 40).toLowerCase() || 'website';
  const intakeChannel = cleanStr(body.intakeChannel || body.intake_channel, 40) || source;
  const formKey = cleanStr(body.formKey || body.form_key, 80);
  const normalizedData = buildNormalizedData(body, req);

  if (!hasIdentitySignal(normalizedData)) {
    return sendJson(res, 422, { ok: false, error: 'insufficient_identity' });
  }

  const title = resolveTitle(body, normalizedData, source);
  const description = resolveDescription(body, normalizedData);
  const tags = normalizeTags(body.tags);
  const meta = resolveMeta(body, normalizedData);
  const payload = resolvePayload(body);
  const submittedAt = cleanStr(body.submittedAt || body.submitted_at, 80) || new Date().toISOString();
  const dedupKey = resolveDedupKey(body, source, formKey, normalizedData);

  const result = await ingestPublicIntake({
    source,
    intakeChannel,
    formKey,
    title,
    description,
    payload,
    normalizedData,
    tags,
    meta,
    dedupKey,
    submittedAt,
  });

  if (!result.ok) {
    const status = ['missing_supabase_service_role', 'workflow_foundation_not_applied'].includes(result.reason)
      ? 503
      : 500;
    return sendJson(res, status, {
      ok: false,
      error: result.reason || result.error || 'public_intake_failed',
      detail: result.detail || '',
    });
  }

  return sendJson(res, 200, {
    ok: true,
    intakeId: result.intakeId || null,
    leadId: result.leadId || null,
    leadAction: result.leadAction || '',
    duplicate: !!result.duplicate,
    dedupKey: result.dedupKey || dedupKey,
    source,
    intakeChannel,
    formKey,
  });
};