const ALLOWED_PORTAL_ROLES = [
  'dialer',
  'in_person_setter',
  'remote_setter',
  'closer',
  'account_manager',
  'territory_specialist',
  'event_host',
  'event_coordinator',
  'media_team',
  'manager',
];

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function normalizePortalRole(roleLike, fallback = 'dialer') {
  const r = cleanStr(roleLike, 40).toLowerCase();
  if (ALLOWED_PORTAL_ROLES.includes(r)) return r;
  return fallback;
}

function normalizeCredentialState(stateLike, fallback = 'unlinked') {
  const state = cleanStr(stateLike, 40).toLowerCase();
  if (['unlinked', 'provisioned', 'invite_pending', 'verification_pending', 'active', 'suspended'].includes(state)) return state;
  return fallback;
}

function normalizeWorkerType(workerTypeLike, fallback = 'employee') {
  const workerType = cleanStr(workerTypeLike, 40).toLowerCase();
  if (['employee', 'contractor', 'temporary', 'vendor'].includes(workerType)) return workerType;
  return fallback;
}

function normalizeDocumentStatus(statusLike, fallback = 'missing') {
  const status = cleanStr(statusLike, 40).toLowerCase();
  if (['missing', 'pending', 'submitted', 'verified', 'rejected', 'expired', 'waived'].includes(status)) return status;
  return fallback;
}

function normalizeEventCompletionState(stateLike, fallback = 'planned') {
  const state = cleanStr(stateLike, 40).toLowerCase();
  if (['planned', 'scheduled', 'in_progress', 'completed', 'cancelled', 'closed'].includes(state)) return state;
  return fallback;
}

function normalizeClosureStatus(statusLike, fallback = 'not_started') {
  const status = cleanStr(statusLike, 40).toLowerCase();
  if (['not_started', 'in_review', 'blocked', 'approved', 'closed'].includes(status)) return status;
  return fallback;
}

function normalizeSurveyStatus(statusLike, fallback = 'draft') {
  const status = cleanStr(statusLike, 40).toLowerCase();
  if (['draft', 'scheduled', 'sent', 'collecting', 'closed', 'cancelled'].includes(status)) return status;
  return fallback;
}

function normalizeDispatchStatus(statusLike, fallback = 'open') {
  const status = cleanStr(statusLike, 40).toLowerCase();
  if (['not_started', 'open', 'assigned', 'in_progress', 'blocked', 'completed', 'cancelled'].includes(status)) return status;
  return fallback;
}

function normalizeRouteStatus(statusLike, fallback = 'planned') {
  const status = cleanStr(statusLike, 40).toLowerCase();
  if (['planned', 'confirmed', 'in_transit', 'arrived', 'delayed', 'cancelled'].includes(status)) return status;
  return fallback;
}

function normalizeEquipmentStatus(statusLike, fallback = 'planned') {
  const status = cleanStr(statusLike, 40).toLowerCase();
  if (['planned', 'checked_out', 'received', 'returned', 'lost', 'damaged', 'cancelled'].includes(status)) return status;
  return fallback;
}

function normalizeExceptionSeverity(severityLike, fallback = 'medium') {
  const severity = cleanStr(severityLike, 40).toLowerCase();
  if (['low', 'medium', 'high', 'critical'].includes(severity)) return severity;
  return fallback;
}

function normalizeExceptionStatus(statusLike, fallback = 'open') {
  const status = cleanStr(statusLike, 40).toLowerCase();
  if (['open', 'investigating', 'blocked', 'resolved', 'closed'].includes(status)) return status;
  return fallback;
}

function isMissingRelationError(error) {
  const code = String(error?.code || '').trim();
  const msg = String(error?.message || '').toLowerCase();
  return code === '42P01' || msg.includes('does not exist') || msg.includes('relation') && msg.includes('exist');
}

async function tableExists(sbAdmin, tableName) {
  try {
    const { error } = await sbAdmin
      .from(String(tableName))
      .select('*', { head: true, count: 'exact' })
      .limit(1);
    if (!error) return true;
    if (isMissingRelationError(error)) return false;
    return false;
  } catch {
    return false;
  }
}

async function explainTableMissing(sbAdmin, tableName) {
  try {
    const { error } = await sbAdmin
      .from(String(tableName))
      .select('*', { head: true, count: 'exact' })
      .limit(1);
    if (!error) return { ok: true };
    return { ok: false, error };
  } catch (err) {
    return { ok: false, error: err };
  }
}

async function syncPortalPerson(sbAdmin, { userId, role, fullName, createdAt, patch = {} } = {}) {
  const cleanUserId = cleanStr(userId, 80);
  if (!cleanUserId) return { ok: false, error: 'missing_user_id' };
  const exists = await tableExists(sbAdmin, 'portal_people');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_people_missing' };

  const payload = {
    user_id: cleanUserId,
    role: normalizePortalRole(role),
    full_name: cleanStr(fullName, 120) || null,
    updated_at: new Date().toISOString(),
  };

  if (createdAt) payload.created_at = createdAt;
  if (patch && typeof patch === 'object') {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      payload[key] = value;
    }
  }

  const { error, data } = await sbAdmin
    .from('portal_people')
    .upsert(payload, { onConflict: 'user_id' })
    .select('*')
    .limit(1);

  if (error) return { ok: false, error: 'portal_people_sync_failed', detail: error.message || '' };

  const person = Array.isArray(data) ? data[0] : null;
  const [employmentProfile, roleAuthorization] = await Promise.all([
    syncPortalEmploymentProfile(sbAdmin, {
      userId: cleanUserId,
      person,
    }),
    ensurePortalRoleAuthorization(sbAdmin, {
      userId: cleanUserId,
      role: person?.role || role,
    }),
  ]);

  return {
    ok: true,
    person,
    employmentProfile: employmentProfile?.ok ? employmentProfile.profile || null : null,
    roleAuthorization: roleAuthorization?.ok ? roleAuthorization.authorization || null : null,
  };
}

async function syncPortalUserIdentity(sbAdmin, {
  userId,
  email = '',
  phone = '',
  credentialState = '',
  inviteSentAt = '',
  emailConfirmedAt = '',
  lastSignInAt = '',
  mfaState = '',
  suspendedAt = '',
  suspendedReason = '',
  provisionedBy = '',
  lastAccessActionAt = '',
  lastAccessActionBy = '',
  meta = {},
} = {}) {
  const cleanUserId = cleanStr(userId, 80);
  if (!cleanUserId) return { ok: false, error: 'missing_user_id' };
  const exists = await tableExists(sbAdmin, 'portal_user_identities');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_user_identities_missing' };

  const { data: existingRows } = await sbAdmin
    .from('portal_user_identities')
    .select('*')
    .eq('user_id', cleanUserId)
    .limit(1);
  const existing = Array.isArray(existingRows) ? existingRows[0] || null : null;
  const nowIso = new Date().toISOString();

  const payload = {
    user_id: cleanUserId,
    updated_at: nowIso,
    email: cleanStr(email, 160) || existing?.email || null,
    phone: cleanStr(phone, 40) || existing?.phone || null,
    credential_state: normalizeCredentialState(credentialState, existing?.credential_state || 'unlinked'),
    invite_sent_at: cleanStr(inviteSentAt, 80) || existing?.invite_sent_at || null,
    email_confirmed_at: cleanStr(emailConfirmedAt, 80) || existing?.email_confirmed_at || null,
    last_sign_in_at: cleanStr(lastSignInAt, 80) || existing?.last_sign_in_at || null,
    mfa_state: cleanStr(mfaState, 40) || existing?.mfa_state || null,
    suspended_at: cleanStr(suspendedAt, 80) || existing?.suspended_at || null,
    suspended_reason: cleanStr(suspendedReason, 500) || existing?.suspended_reason || null,
    provisioned_by: cleanStr(provisionedBy, 80) || existing?.provisioned_by || null,
    last_access_action_at: cleanStr(lastAccessActionAt, 80) || existing?.last_access_action_at || null,
    last_access_action_by: cleanStr(lastAccessActionBy, 80) || existing?.last_access_action_by || null,
    meta: Object.assign({}, existing?.meta && typeof existing.meta === 'object' ? existing.meta : {}, meta && typeof meta === 'object' ? meta : {}),
  };

  if (!existing?.created_at) payload.created_at = nowIso;

  const { error, data } = await sbAdmin
    .from('portal_user_identities')
    .upsert(payload, { onConflict: 'user_id' })
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_user_identity_sync_failed', detail: error.message || '' };
  return { ok: true, identity: Array.isArray(data) ? data[0] || null : null };
}

async function syncPortalEmploymentProfile(sbAdmin, { userId, person = null, patch = {} } = {}) {
  const cleanUserId = cleanStr(userId, 80);
  if (!cleanUserId) return { ok: false, error: 'missing_user_id' };
  const exists = await tableExists(sbAdmin, 'portal_employment_profiles');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_employment_profiles_missing' };

  const source = person && typeof person === 'object' ? person : {};
  const meta = source.meta && typeof source.meta === 'object' ? source.meta : {};
  const { data: existingRows } = await sbAdmin
    .from('portal_employment_profiles')
    .select('*')
    .eq('person_user_id', cleanUserId)
    .limit(1);
  const existing = Array.isArray(existingRows) ? existingRows[0] || null : null;
  const employmentStatus = cleanStr(patch.employment_status != null ? patch.employment_status : source.employment_status, 40) || existing?.employment_status || 'active';
  const workerType = normalizeWorkerType(
    patch.worker_type || meta.workerType || existing?.worker_type || (employmentStatus === 'contractor' ? 'contractor' : 'employee'),
    employmentStatus === 'contractor' ? 'contractor' : 'employee'
  );
  const nowIso = new Date().toISOString();

  const payload = {
    person_user_id: cleanUserId,
    updated_at: nowIso,
    worker_type: workerType,
    employment_status: employmentStatus,
    team_code: cleanStr(patch.team_code != null ? patch.team_code : source.team_code, 80) || existing?.team_code || null,
    manager_user_id: cleanStr(patch.manager_user_id != null ? patch.manager_user_id : source.manager_user_id, 80) || existing?.manager_user_id || null,
    start_date: cleanStr(patch.start_date != null ? patch.start_date : source.start_date, 20) || existing?.start_date || null,
    end_date: cleanStr(patch.end_date != null ? patch.end_date : source.end_date, 20) || existing?.end_date || null,
    readiness_status: cleanStr(patch.readiness_status != null ? patch.readiness_status : source.readiness_status, 40) || existing?.readiness_status || 'not_started',
    readiness_reason: cleanStr(patch.readiness_reason || meta.readinessReason, 500) || existing?.readiness_reason || null,
    can_be_assigned: patch.can_be_assigned != null ? !!patch.can_be_assigned : (source.can_be_assigned != null ? !!source.can_be_assigned : (existing?.can_be_assigned != null ? !!existing.can_be_assigned : true)),
    payroll_ready: patch.payroll_ready != null ? !!patch.payroll_ready : (existing?.payroll_ready != null ? !!existing.payroll_ready : false),
    tax_profile_ready: patch.tax_profile_ready != null ? !!patch.tax_profile_ready : (existing?.tax_profile_ready != null ? !!existing.tax_profile_ready : false),
    onboarding_packet_status: normalizeDocumentStatus(patch.onboarding_packet_status || meta.onboardingPacketStatus || existing?.onboarding_packet_status || 'missing'),
    background_check_status: normalizeDocumentStatus(patch.background_check_status || meta.backgroundCheckStatus || existing?.background_check_status || 'missing'),
    shirt_size: cleanStr(patch.shirt_size || meta.shirtSize, 20) || existing?.shirt_size || null,
    home_base_city: cleanStr(patch.home_base_city != null ? patch.home_base_city : source.home_base_city, 80) || existing?.home_base_city || null,
    home_base_state: cleanStr(patch.home_base_state != null ? patch.home_base_state : source.home_base_state, 20) || existing?.home_base_state || null,
    meta: Object.assign({}, existing?.meta && typeof existing.meta === 'object' ? existing.meta : {}, meta),
  };

  if (!existing?.created_at) payload.created_at = nowIso;

  const { error, data } = await sbAdmin
    .from('portal_employment_profiles')
    .upsert(payload, { onConflict: 'person_user_id' })
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_employment_profile_sync_failed', detail: error.message || '' };
  return { ok: true, profile: Array.isArray(data) ? data[0] || null : null };
}

async function ensurePortalRoleAuthorization(sbAdmin, {
  userId,
  role,
  status = 'active',
  grantedBy = '',
  grantedAt = '',
  scopeType = 'global',
  scopeId = '',
  notes = '',
  meta = {},
} = {}) {
  const cleanUserId = cleanStr(userId, 80);
  const normalizedRole = normalizePortalRole(role, '');
  if (!cleanUserId || !normalizedRole) return { ok: false, error: 'invalid_role_authorization_payload' };

  const exists = await tableExists(sbAdmin, 'portal_person_role_authorizations');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_person_role_authorizations_missing' };

  const payload = {
    person_user_id: cleanUserId,
    role_code: normalizedRole,
    status: ['pending', 'active', 'revoked', 'expired'].includes(cleanStr(status, 40).toLowerCase()) ? cleanStr(status, 40).toLowerCase() : 'active',
    granted_by: cleanStr(grantedBy, 80) || null,
    granted_at: cleanStr(grantedAt, 80) || new Date().toISOString(),
    scope_type: cleanStr(scopeType, 80) || 'global',
    scope_id: cleanStr(scopeId, 160),
    notes: cleanStr(notes, 2000) || null,
    meta: meta && typeof meta === 'object' ? meta : {},
  };

  const { error, data } = await sbAdmin
    .from('portal_person_role_authorizations')
    .upsert(payload, { onConflict: 'person_user_id,role_code,scope_type,scope_id' })
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_role_authorization_sync_failed', detail: error.message || '' };
  return { ok: true, authorization: Array.isArray(data) ? data[0] || null : null };
}

async function upsertEventAttendanceRecord(sbAdmin, {
  eventId,
  attendanceSource = 'internal_log',
  estimatedCount = null,
  actualCount = null,
  checkinCount = null,
  noShowCount = null,
  capturedBy = '',
  capturedAt = '',
  notes = '',
  meta = {},
} = {}) {
  const normalizedEventId = Number(eventId || 0);
  if (!Number.isFinite(normalizedEventId) || normalizedEventId <= 0) return { ok: false, error: 'missing_event_id' };
  const exists = await tableExists(sbAdmin, 'portal_event_attendance_records');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_event_attendance_records_missing' };

  const payload = {
    event_id: normalizedEventId,
    attendance_source: cleanStr(attendanceSource, 80) || 'internal_log',
    updated_at: new Date().toISOString(),
    estimated_count: Number.isFinite(Number(estimatedCount)) ? Math.max(0, Math.trunc(Number(estimatedCount))) : null,
    actual_count: Number.isFinite(Number(actualCount)) ? Math.max(0, Math.trunc(Number(actualCount))) : null,
    checkin_count: Number.isFinite(Number(checkinCount)) ? Math.max(0, Math.trunc(Number(checkinCount))) : null,
    no_show_count: Number.isFinite(Number(noShowCount)) ? Math.max(0, Math.trunc(Number(noShowCount))) : null,
    captured_by: cleanStr(capturedBy, 80) || null,
    captured_at: cleanStr(capturedAt, 80) || new Date().toISOString(),
    notes: cleanStr(notes, 4000) || null,
    meta: meta && typeof meta === 'object' ? meta : {},
  };

  const { error, data } = await sbAdmin
    .from('portal_event_attendance_records')
    .upsert(payload, { onConflict: 'event_id,attendance_source' })
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_event_attendance_upsert_failed', detail: error.message || '' };
  return { ok: true, attendanceRecord: Array.isArray(data) ? data[0] || null : null };
}

async function upsertEventClosureRecord(sbAdmin, {
  eventId,
  closureStatus = 'not_started',
  staffingComplete,
  formsComplete,
  assetsReturned,
  vendorItemsClosed,
  reportComplete,
  payoutReviewComplete,
  approvedBy = '',
  approvedAt = '',
  notes = '',
  meta = {},
} = {}) {
  const normalizedEventId = Number(eventId || 0);
  if (!Number.isFinite(normalizedEventId) || normalizedEventId <= 0) return { ok: false, error: 'missing_event_id' };
  const exists = await tableExists(sbAdmin, 'portal_event_closure_records');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_event_closure_records_missing' };

  const { data: existingRows } = await sbAdmin
    .from('portal_event_closure_records')
    .select('*')
    .eq('event_id', normalizedEventId)
    .limit(1);
  const existing = Array.isArray(existingRows) ? existingRows[0] || null : null;

  const payload = {
    event_id: normalizedEventId,
    updated_at: new Date().toISOString(),
    closure_status: normalizeClosureStatus(closureStatus, existing?.closure_status || 'not_started'),
    staffing_complete: staffingComplete != null ? !!staffingComplete : !!existing?.staffing_complete,
    forms_complete: formsComplete != null ? !!formsComplete : !!existing?.forms_complete,
    assets_returned: assetsReturned != null ? !!assetsReturned : !!existing?.assets_returned,
    vendor_items_closed: vendorItemsClosed != null ? !!vendorItemsClosed : !!existing?.vendor_items_closed,
    report_complete: reportComplete != null ? !!reportComplete : !!existing?.report_complete,
    payout_review_complete: payoutReviewComplete != null ? !!payoutReviewComplete : !!existing?.payout_review_complete,
    approved_by: cleanStr(approvedBy, 80) || existing?.approved_by || null,
    approved_at: cleanStr(approvedAt, 80) || existing?.approved_at || null,
    notes: cleanStr(notes, 4000) || existing?.notes || null,
    meta: Object.assign({}, existing?.meta && typeof existing.meta === 'object' ? existing.meta : {}, meta && typeof meta === 'object' ? meta : {}),
  };

  const { error, data } = await sbAdmin
    .from('portal_event_closure_records')
    .upsert(payload, { onConflict: 'event_id' })
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_event_closure_upsert_failed', detail: error.message || '' };
  return { ok: true, closureRecord: Array.isArray(data) ? data[0] || null : null };
}

async function ensureDispatchWorkOrder(sbAdmin, {
  event,
  ownerUserId = '',
  status = '',
  dispatchType = '',
  priority = null,
  notes = '',
  meta = {},
} = {}) {
  const eventRow = event && typeof event === 'object' ? event : null;
  const eventId = Number(eventRow?.id || 0);
  if (!Number.isFinite(eventId) || eventId <= 0) return { ok: false, error: 'missing_event_id' };
  const exists = await tableExists(sbAdmin, 'portal_dispatch_work_orders');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_dispatch_work_orders_missing' };

  const eventMeta = eventRow?.meta && typeof eventRow.meta === 'object' ? eventRow.meta : {};
  const payload = {
    event_id: eventId,
    updated_at: new Date().toISOString(),
    owner_user_id: cleanStr(ownerUserId || eventRow?.assigned_user_id || eventRow?.coordinator_user_id || eventRow?.created_by, 80) || null,
    status: normalizeDispatchStatus(status || eventRow?.status, 'open'),
    dispatch_type: cleanStr(dispatchType || eventMeta.dispatchType || eventMeta.kind || eventRow?.area_tag, 80) || 'general',
    priority: Number.isFinite(Number(priority))
      ? Math.max(-5, Math.min(5, Math.trunc(Number(priority))))
      : Math.max(-5, Math.min(5, Math.trunc(Number(eventMeta.priority || 0) || 0))),
    notes: cleanStr(notes || eventRow?.notes, 4000) || null,
    meta: Object.assign({}, eventMeta, meta && typeof meta === 'object' ? meta : {}),
  };

  const { error, data } = await sbAdmin
    .from('portal_dispatch_work_orders')
    .upsert(payload, { onConflict: 'event_id' })
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_dispatch_work_order_upsert_failed', detail: error.message || '' };
  return { ok: true, workOrder: Array.isArray(data) ? data[0] || null : null };
}

async function upsertEventSurveyDistribution(sbAdmin, {
  eventId,
  distributionChannel = 'link',
  surveyLink = '',
  recipientGroup = '',
  status = 'draft',
  sentAt = '',
  responseCount = null,
  completionRate = null,
  meta = {},
} = {}) {
  const normalizedEventId = Number(eventId || 0);
  if (!Number.isFinite(normalizedEventId) || normalizedEventId <= 0) return { ok: false, error: 'missing_event_id' };
  const exists = await tableExists(sbAdmin, 'portal_event_survey_distributions');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_event_survey_distributions_missing' };

  const normalizedChannel = cleanStr(distributionChannel, 80) || 'link';
  const normalizedGroup = cleanStr(recipientGroup, 80) || 'resident';
  const { data: existingRows } = await sbAdmin
    .from('portal_event_survey_distributions')
    .select('*')
    .eq('event_id', normalizedEventId)
    .eq('distribution_channel', normalizedChannel)
    .eq('recipient_group', normalizedGroup)
    .order('updated_at', { ascending: false })
    .limit(1);
  const existing = Array.isArray(existingRows) ? existingRows[0] || null : null;
  const payload = {
    event_id: normalizedEventId,
    updated_at: new Date().toISOString(),
    distribution_channel: normalizedChannel,
    survey_link: cleanStr(surveyLink, 2000) || existing?.survey_link || null,
    recipient_group: normalizedGroup,
    status: normalizeSurveyStatus(status, existing?.status || 'draft'),
    sent_at: cleanStr(sentAt, 80) || existing?.sent_at || null,
    response_count: Number.isFinite(Number(responseCount)) ? Math.max(0, Math.trunc(Number(responseCount))) : (existing?.response_count || 0),
    completion_rate: Number.isFinite(Number(completionRate)) ? Math.max(0, Math.min(100, Number(completionRate))) : (existing?.completion_rate ?? null),
    meta: Object.assign({}, existing?.meta && typeof existing.meta === 'object' ? existing.meta : {}, meta && typeof meta === 'object' ? meta : {}),
  };

  if (existing?.id) {
    const { error, data } = await sbAdmin
      .from('portal_event_survey_distributions')
      .update(payload)
      .eq('id', existing.id)
      .select('*')
      .limit(1);
    if (error) return { ok: false, error: 'portal_event_survey_distribution_upsert_failed', detail: error.message || '' };
    return { ok: true, surveyDistribution: Array.isArray(data) ? data[0] || null : null };
  }

  const { error, data } = await sbAdmin
    .from('portal_event_survey_distributions')
    .insert(payload)
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_event_survey_distribution_upsert_failed', detail: error.message || '' };
  return { ok: true, surveyDistribution: Array.isArray(data) ? data[0] || null : null };
}

async function upsertOperationsException(sbAdmin, {
  id = null,
  eventId = null,
  entityType = 'event',
  entityId = '',
  exceptionType = '',
  severity = 'medium',
  ownerUserId = '',
  status = 'open',
  openedAt = '',
  resolvedAt = '',
  resolutionNotes = '',
  meta = {},
} = {}) {
  const exists = await tableExists(sbAdmin, 'portal_operations_exceptions');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_operations_exceptions_missing' };

  const normalizedId = Number(id || 0);
  const normalizedEventId = Number(eventId || 0);
  const cleanEntityType = cleanStr(entityType, 80) || 'event';
  const cleanEntityId = cleanStr(entityId, 160) || (normalizedEventId > 0 ? String(normalizedEventId) : '');
  const cleanExceptionType = cleanStr(exceptionType, 80);
  if (!cleanEntityId) return { ok: false, error: 'invalid_exception_payload' };

  if (normalizedId > 0) {
    const { data: existingRows } = await sbAdmin
      .from('portal_operations_exceptions')
      .select('*')
      .eq('id', normalizedId)
      .limit(1);
    const existing = Array.isArray(existingRows) ? existingRows[0] || null : null;
    if (!existing) return { ok: false, error: 'exception_not_found' };

    const payload = {
      updated_at: new Date().toISOString(),
      event_id: normalizedEventId > 0 ? normalizedEventId : (existing.event_id || null),
      entity_type: cleanEntityType,
      entity_id: cleanEntityId,
      exception_type: cleanExceptionType || existing.exception_type,
      severity: normalizeExceptionSeverity(severity, existing.severity || 'medium'),
      owner_user_id: cleanStr(ownerUserId, 80) || existing.owner_user_id || null,
      status: normalizeExceptionStatus(status, existing.status || 'open'),
      opened_at: cleanStr(openedAt, 80) || existing.opened_at || new Date().toISOString(),
      resolved_at: cleanStr(resolvedAt, 80) || existing.resolved_at || null,
      resolution_notes: cleanStr(resolutionNotes, 4000) || existing.resolution_notes || null,
      meta: Object.assign({}, existing.meta && typeof existing.meta === 'object' ? existing.meta : {}, meta && typeof meta === 'object' ? meta : {}),
    };

    const { error, data } = await sbAdmin
      .from('portal_operations_exceptions')
      .update(payload)
      .eq('id', normalizedId)
      .select('*')
      .limit(1);
    if (error) return { ok: false, error: 'portal_operations_exception_upsert_failed', detail: error.message || '' };
    return { ok: true, exception: Array.isArray(data) ? data[0] || null : null };
  }

  const payload = {
    event_id: normalizedEventId > 0 ? normalizedEventId : null,
    entity_type: cleanEntityType,
    entity_id: cleanEntityId,
    exception_type: cleanExceptionType,
    severity: normalizeExceptionSeverity(severity),
    owner_user_id: cleanStr(ownerUserId, 80) || null,
    status: normalizeExceptionStatus(status),
    opened_at: cleanStr(openedAt, 80) || new Date().toISOString(),
    resolved_at: cleanStr(resolvedAt, 80) || null,
    resolution_notes: cleanStr(resolutionNotes, 4000) || null,
    meta: meta && typeof meta === 'object' ? meta : {},
  };
  if (!payload.exception_type) return { ok: false, error: 'invalid_exception_payload' };

  const { error, data } = await sbAdmin
    .from('portal_operations_exceptions')
    .insert(payload)
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_operations_exception_upsert_failed', detail: error.message || '' };
  return { ok: true, exception: Array.isArray(data) ? data[0] || null : null };
}

async function upsertRoutePlan(sbAdmin, {
  id = null,
  eventId,
  personUserId = '',
  departureTime = '',
  arrivalTarget = '',
  routeStatus = 'planned',
  parkingNotes = '',
  loadInNotes = '',
  lastKnownEta = '',
  meta = {},
} = {}) {
  const normalizedEventId = Number(eventId || 0);
  if (!Number.isFinite(normalizedEventId) || normalizedEventId <= 0) return { ok: false, error: 'missing_event_id' };
  const exists = await tableExists(sbAdmin, 'portal_route_plans');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_route_plans_missing' };

  const normalizedId = Number(id || 0);
  if (normalizedId > 0) {
    const { data: existingRows } = await sbAdmin
      .from('portal_route_plans')
      .select('*')
      .eq('id', normalizedId)
      .limit(1);
    const existing = Array.isArray(existingRows) ? existingRows[0] || null : null;
    if (!existing) return { ok: false, error: 'route_plan_not_found' };
    const payload = {
      updated_at: new Date().toISOString(),
      event_id: normalizedEventId,
      person_user_id: cleanStr(personUserId, 80) || existing.person_user_id || null,
      departure_time: cleanStr(departureTime, 80) || existing.departure_time || null,
      arrival_target: cleanStr(arrivalTarget, 80) || existing.arrival_target || null,
      route_status: normalizeRouteStatus(routeStatus, existing.route_status || 'planned'),
      parking_notes: cleanStr(parkingNotes, 4000) || existing.parking_notes || null,
      load_in_notes: cleanStr(loadInNotes, 4000) || existing.load_in_notes || null,
      last_known_eta: cleanStr(lastKnownEta, 80) || existing.last_known_eta || null,
      meta: Object.assign({}, existing.meta && typeof existing.meta === 'object' ? existing.meta : {}, meta && typeof meta === 'object' ? meta : {}),
    };
    const { error, data } = await sbAdmin
      .from('portal_route_plans')
      .update(payload)
      .eq('id', normalizedId)
      .select('*')
      .limit(1);
    if (error) return { ok: false, error: 'portal_route_plan_upsert_failed', detail: error.message || '' };
    return { ok: true, routePlan: Array.isArray(data) ? data[0] || null : null };
  }

  const { data: existingRows } = await sbAdmin
    .from('portal_route_plans')
    .select('*')
    .eq('event_id', normalizedEventId)
    .order('updated_at', { ascending: false })
    .limit(1);
  const existing = Array.isArray(existingRows) ? existingRows[0] || null : null;
  if (existing) {
    return upsertRoutePlan(sbAdmin, {
      id: existing.id,
      eventId: normalizedEventId,
      personUserId,
      departureTime,
      arrivalTarget,
      routeStatus,
      parkingNotes,
      loadInNotes,
      lastKnownEta,
      meta,
    });
  }

  const payload = {
    event_id: normalizedEventId,
    person_user_id: cleanStr(personUserId, 80) || null,
    departure_time: cleanStr(departureTime, 80) || null,
    arrival_target: cleanStr(arrivalTarget, 80) || null,
    route_status: normalizeRouteStatus(routeStatus),
    parking_notes: cleanStr(parkingNotes, 4000) || null,
    load_in_notes: cleanStr(loadInNotes, 4000) || null,
    last_known_eta: cleanStr(lastKnownEta, 80) || null,
    meta: meta && typeof meta === 'object' ? meta : {},
  };
  const { error, data } = await sbAdmin
    .from('portal_route_plans')
    .insert(payload)
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_route_plan_upsert_failed', detail: error.message || '' };
  return { ok: true, routePlan: Array.isArray(data) ? data[0] || null : null };
}

async function upsertEquipmentHandoff(sbAdmin, {
  id = null,
  eventId,
  assetId = null,
  fromLocationId = null,
  toPersonUserId = '',
  checkedOutAt = '',
  receivedAt = '',
  returnedAt = '',
  status = 'planned',
  conditionNotes = '',
  meta = {},
} = {}) {
  const normalizedEventId = Number(eventId || 0);
  if (!Number.isFinite(normalizedEventId) || normalizedEventId <= 0) return { ok: false, error: 'missing_event_id' };
  const exists = await tableExists(sbAdmin, 'portal_equipment_handoffs');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_equipment_handoffs_missing' };

  const normalizedId = Number(id || 0);
  if (normalizedId > 0) {
    const { data: existingRows } = await sbAdmin
      .from('portal_equipment_handoffs')
      .select('*')
      .eq('id', normalizedId)
      .limit(1);
    const existing = Array.isArray(existingRows) ? existingRows[0] || null : null;
    if (!existing) return { ok: false, error: 'equipment_handoff_not_found' };
    const payload = {
      updated_at: new Date().toISOString(),
      event_id: normalizedEventId,
      asset_id: Number.isFinite(Number(assetId)) && Number(assetId) > 0 ? Math.trunc(Number(assetId)) : (existing.asset_id || null),
      from_location_id: Number.isFinite(Number(fromLocationId)) && Number(fromLocationId) > 0 ? Math.trunc(Number(fromLocationId)) : (existing.from_location_id || null),
      to_person_user_id: cleanStr(toPersonUserId, 80) || existing.to_person_user_id || null,
      checked_out_at: cleanStr(checkedOutAt, 80) || existing.checked_out_at || null,
      received_at: cleanStr(receivedAt, 80) || existing.received_at || null,
      returned_at: cleanStr(returnedAt, 80) || existing.returned_at || null,
      status: normalizeEquipmentStatus(status, existing.status || 'planned'),
      condition_notes: cleanStr(conditionNotes, 4000) || existing.condition_notes || null,
      meta: Object.assign({}, existing.meta && typeof existing.meta === 'object' ? existing.meta : {}, meta && typeof meta === 'object' ? meta : {}),
    };
    const { error, data } = await sbAdmin
      .from('portal_equipment_handoffs')
      .update(payload)
      .eq('id', normalizedId)
      .select('*')
      .limit(1);
    if (error) return { ok: false, error: 'portal_equipment_handoff_upsert_failed', detail: error.message || '' };
    return { ok: true, equipmentHandoff: Array.isArray(data) ? data[0] || null : null };
  }

  const { data: existingRows } = await sbAdmin
    .from('portal_equipment_handoffs')
    .select('*')
    .eq('event_id', normalizedEventId)
    .order('updated_at', { ascending: false })
    .limit(1);
  const existing = Array.isArray(existingRows) ? existingRows[0] || null : null;
  if (existing) {
    return upsertEquipmentHandoff(sbAdmin, {
      id: existing.id,
      eventId: normalizedEventId,
      assetId,
      fromLocationId,
      toPersonUserId,
      checkedOutAt,
      receivedAt,
      returnedAt,
      status,
      conditionNotes,
      meta,
    });
  }

  const payload = {
    event_id: normalizedEventId,
    asset_id: Number.isFinite(Number(assetId)) && Number(assetId) > 0 ? Math.trunc(Number(assetId)) : null,
    from_location_id: Number.isFinite(Number(fromLocationId)) && Number(fromLocationId) > 0 ? Math.trunc(Number(fromLocationId)) : null,
    to_person_user_id: cleanStr(toPersonUserId, 80) || null,
    checked_out_at: cleanStr(checkedOutAt, 80) || null,
    received_at: cleanStr(receivedAt, 80) || null,
    returned_at: cleanStr(returnedAt, 80) || null,
    status: normalizeEquipmentStatus(status),
    condition_notes: cleanStr(conditionNotes, 4000) || null,
    meta: meta && typeof meta === 'object' ? meta : {},
  };
  const { error, data } = await sbAdmin
    .from('portal_equipment_handoffs')
    .insert(payload)
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_equipment_handoff_upsert_failed', detail: error.message || '' };
  return { ok: true, equipmentHandoff: Array.isArray(data) ? data[0] || null : null };
}

async function writePortalAudit(sbAdmin, {
  actorUserId,
  entityType,
  entityId,
  action,
  beforePayload = null,
  afterPayload = null,
  meta = {},
} = {}) {
  const exists = await tableExists(sbAdmin, 'portal_entity_audit');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_entity_audit_missing' };

  const cleanEntityType = cleanStr(entityType, 80);
  const cleanEntityId = cleanStr(entityId, 160);
  const cleanAction = cleanStr(action, 80);
  if (!cleanEntityType || !cleanEntityId || !cleanAction) {
    return { ok: false, error: 'invalid_audit_payload' };
  }

  const payload = {
    actor_user_id: cleanStr(actorUserId, 80) || null,
    entity_type: cleanEntityType,
    entity_id: cleanEntityId,
    action: cleanAction,
    before_payload: beforePayload && typeof beforePayload === 'object' ? beforePayload : beforePayload ?? null,
    after_payload: afterPayload && typeof afterPayload === 'object' ? afterPayload : afterPayload ?? null,
    meta: meta && typeof meta === 'object' ? meta : {},
  };

  const { error } = await sbAdmin.from('portal_entity_audit').insert(payload);
  if (error) return { ok: false, error: 'portal_audit_write_failed', detail: error.message || '' };
  return { ok: true };
}

async function writePortalWorkflowEvent(sbAdmin, {
  actorUserId,
  ownerUserId,
  entityType,
  entityId,
  eventType,
  status = 'pending',
  priority = 0,
  sourceTable = '',
  sourceId = '',
  intakeSubmissionId = null,
  onboardingJourneyId = null,
  payload = {},
  resultPayload = null,
  errorText = '',
  dedupKey = '',
  meta = {},
} = {}) {
  const exists = await tableExists(sbAdmin, 'portal_workflow_events');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_workflow_events_missing' };

  const cleanEntityType = cleanStr(entityType, 80);
  const cleanEntityId = cleanStr(entityId, 160);
  const cleanEventType = cleanStr(eventType, 80);
  const cleanStatus = cleanStr(status, 20).toLowerCase() || 'pending';
  if (!cleanEntityType || !cleanEntityId || !cleanEventType) {
    return { ok: false, error: 'invalid_workflow_event_payload' };
  }

  const row = {
    actor_user_id: cleanStr(actorUserId, 80) || null,
    owner_user_id: cleanStr(ownerUserId, 80) || null,
    entity_type: cleanEntityType,
    entity_id: cleanEntityId,
    event_type: cleanEventType,
    status: cleanStatus,
    priority: Number.isFinite(Number(priority)) ? Math.trunc(Number(priority)) : 0,
    source_table: cleanStr(sourceTable, 80) || null,
    source_id: cleanStr(sourceId, 160) || null,
    intake_submission_id: Number.isFinite(Number(intakeSubmissionId)) ? Math.trunc(Number(intakeSubmissionId)) : null,
    onboarding_journey_id: Number.isFinite(Number(onboardingJourneyId)) ? Math.trunc(Number(onboardingJourneyId)) : null,
    payload: payload && typeof payload === 'object' ? payload : {},
    result_payload: resultPayload && typeof resultPayload === 'object' ? resultPayload : resultPayload ?? null,
    error_text: cleanStr(errorText, 2000) || null,
    dedup_key: cleanStr(dedupKey, 200) || null,
    meta: meta && typeof meta === 'object' ? meta : {},
  };

  const { data, error } = await sbAdmin
    .from('portal_workflow_events')
    .insert(row)
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_workflow_event_write_failed', detail: error.message || '' };
  return { ok: true, event: Array.isArray(data) ? data[0] || null : null };
}

async function writePortalAgentActionAudit(sbAdmin, {
  actorUserId,
  agentKey,
  actionType,
  status = 'completed',
  entityType = '',
  entityId = '',
  threadId = '',
  workflowEventId = null,
  inputPayload = {},
  outputPayload = null,
  durationMs = null,
  model = '',
  meta = {},
} = {}) {
  const exists = await tableExists(sbAdmin, 'portal_agent_action_audit');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_agent_action_audit_missing' };

  const cleanAgentKey = cleanStr(agentKey, 80);
  const cleanActionType = cleanStr(actionType, 80);
  const cleanStatus = cleanStr(status, 20).toLowerCase() || 'completed';
  if (!cleanAgentKey || !cleanActionType) {
    return { ok: false, error: 'invalid_agent_action_payload' };
  }

  const row = {
    actor_user_id: cleanStr(actorUserId, 80) || null,
    agent_key: cleanAgentKey,
    action_type: cleanActionType,
    status: cleanStatus,
    entity_type: cleanStr(entityType, 80) || null,
    entity_id: cleanStr(entityId, 160) || null,
    thread_id: cleanStr(threadId, 80) || null,
    workflow_event_id: Number.isFinite(Number(workflowEventId)) ? Math.trunc(Number(workflowEventId)) : null,
    input_payload: inputPayload && typeof inputPayload === 'object' ? inputPayload : {},
    output_payload: outputPayload && typeof outputPayload === 'object' ? outputPayload : outputPayload ?? null,
    duration_ms: Number.isFinite(Number(durationMs)) ? Math.max(0, Math.trunc(Number(durationMs))) : null,
    model: cleanStr(model, 120) || null,
    meta: meta && typeof meta === 'object' ? meta : {},
  };

  const { data, error } = await sbAdmin
    .from('portal_agent_action_audit')
    .insert(row)
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_agent_action_write_failed', detail: error.message || '' };
  return { ok: true, audit: Array.isArray(data) ? data[0] || null : null };
}

async function writePortalSystemIncident(sbAdmin, {
  createdBy,
  ownerUserId = '',
  status = 'open',
  severity = 'error',
  incidentType = 'runtime',
  service = '',
  environment = '',
  runtime = '',
  releaseVersion = '',
  host = '',
  route = '',
  incidentKey = '',
  fingerprint = '',
  signalSource = '',
  crashKind = '',
  errorName = '',
  errorMessage = '',
  rootCauseCategory = '',
  suspectedCause = '',
  oom = false,
  lastExitCode = null,
  rssBytes = null,
  heapTotalBytes = null,
  heapUsedBytes = null,
  heapLimitBytes = null,
  externalBytes = null,
  arrayBuffersBytes = null,
  memoryPayload = {},
  payload = {},
  tags = [],
  meta = {},
  firstSeenAt = '',
  lastSeenAt = '',
  resolvedAt = '',
} = {}) {
  const exists = await tableExists(sbAdmin, 'portal_system_incidents');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_system_incidents_missing' };

  const cleanStatus = cleanStr(status, 20).toLowerCase() || 'open';
  const cleanSeverity = cleanStr(severity, 20).toLowerCase() || 'error';
  const cleanIncidentType = cleanStr(incidentType, 40).toLowerCase() || 'runtime';
  const cleanIncidentKey = cleanStr(incidentKey, 200);
  const cleanFingerprint = cleanStr(fingerprint, 200);
  const derivedIncidentKey = cleanIncidentKey || cleanFingerprint || cleanStr(`${cleanIncidentType}:${cleanStr(service, 80)}:${cleanStr(route, 160)}:${cleanStr(errorName || crashKind || suspectedCause, 120)}`, 200);
  if (!derivedIncidentKey) return { ok: false, error: 'invalid_system_incident_payload' };

  const normalizedTags = Array.isArray(tags)
    ? tags.map((tag) => cleanStr(tag, 40)).filter(Boolean).slice(0, 30)
    : [];
  const nowIso = new Date().toISOString();

  const row = {
    updated_at: nowIso,
    first_seen_at: cleanStr(firstSeenAt, 80) || nowIso,
    last_seen_at: cleanStr(lastSeenAt, 80) || nowIso,
    resolved_at: cleanStr(resolvedAt, 80) || null,
    created_by: cleanStr(createdBy, 80) || null,
    owner_user_id: cleanStr(ownerUserId, 80) || null,
    status: ['open', 'monitoring', 'resolved', 'ignored'].includes(cleanStatus) ? cleanStatus : 'open',
    severity: ['info', 'warn', 'error', 'critical'].includes(cleanSeverity) ? cleanSeverity : 'error',
    incident_type: cleanIncidentType,
    service: cleanStr(service, 80) || null,
    environment: cleanStr(environment, 40) || null,
    runtime: cleanStr(runtime, 40) || null,
    release_version: cleanStr(releaseVersion, 80) || null,
    host: cleanStr(host, 120) || null,
    route: cleanStr(route, 200) || null,
    incident_key: derivedIncidentKey,
    fingerprint: cleanFingerprint || null,
    signal_source: cleanStr(signalSource, 80) || null,
    crash_kind: cleanStr(crashKind, 80) || null,
    error_name: cleanStr(errorName, 120) || null,
    error_message: cleanStr(errorMessage, 4000) || null,
    root_cause_category: cleanStr(rootCauseCategory, 120) || null,
    suspected_cause: cleanStr(suspectedCause, 500) || null,
    oom: !!oom,
    last_exit_code: Number.isFinite(Number(lastExitCode)) ? Math.trunc(Number(lastExitCode)) : null,
    rss_bytes: Number.isFinite(Number(rssBytes)) ? Math.max(0, Math.trunc(Number(rssBytes))) : null,
    heap_total_bytes: Number.isFinite(Number(heapTotalBytes)) ? Math.max(0, Math.trunc(Number(heapTotalBytes))) : null,
    heap_used_bytes: Number.isFinite(Number(heapUsedBytes)) ? Math.max(0, Math.trunc(Number(heapUsedBytes))) : null,
    heap_limit_bytes: Number.isFinite(Number(heapLimitBytes)) ? Math.max(0, Math.trunc(Number(heapLimitBytes))) : null,
    external_bytes: Number.isFinite(Number(externalBytes)) ? Math.max(0, Math.trunc(Number(externalBytes))) : null,
    array_buffers_bytes: Number.isFinite(Number(arrayBuffersBytes)) ? Math.max(0, Math.trunc(Number(arrayBuffersBytes))) : null,
    memory_payload: memoryPayload && typeof memoryPayload === 'object' ? memoryPayload : {},
    payload: payload && typeof payload === 'object' ? payload : {},
    tags: normalizedTags,
    meta: meta && typeof meta === 'object' ? meta : {},
  };

  const { data: existingRows, error: lookupError } = await sbAdmin
    .from('portal_system_incidents')
    .select('*')
    .eq('incident_key', derivedIncidentKey)
    .limit(1);
  if (lookupError) return { ok: false, error: 'portal_system_incident_lookup_failed', detail: lookupError.message || '' };

  const existing = Array.isArray(existingRows) ? existingRows[0] || null : null;
  if (existing?.id) {
    row.first_seen_at = existing.first_seen_at || row.first_seen_at;
    row.occurrence_count = Math.max(1, Number(existing.occurrence_count || 1)) + 1;
    row.created_by = existing.created_by || row.created_by;
    row.tags = Array.from(new Set([...(Array.isArray(existing.tags) ? existing.tags : []), ...normalizedTags])).slice(0, 30);
    row.meta = Object.assign({}, existing.meta && typeof existing.meta === 'object' ? existing.meta : {}, row.meta);
    row.payload = Object.assign({}, existing.payload && typeof existing.payload === 'object' ? existing.payload : {}, row.payload);
    row.memory_payload = Object.assign({}, existing.memory_payload && typeof existing.memory_payload === 'object' ? existing.memory_payload : {}, row.memory_payload);

    const { data, error } = await sbAdmin
      .from('portal_system_incidents')
      .update(row)
      .eq('id', existing.id)
      .select('*')
      .limit(1);
    if (error) return { ok: false, error: 'portal_system_incident_update_failed', detail: error.message || '' };
    return { ok: true, incident: Array.isArray(data) ? data[0] || null : null, duplicate: true };
  }

  row.occurrence_count = 1;
  const { data, error } = await sbAdmin
    .from('portal_system_incidents')
    .insert(row)
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_system_incident_write_failed', detail: error.message || '' };
  return { ok: true, incident: Array.isArray(data) ? data[0] || null : null, duplicate: false };
}

async function enqueuePortalNotification(sbAdmin, {
  createdBy,
  userId,
  workflowEventId = null,
  channel,
  status = 'pending',
  templateKey = '',
  toEmail = '',
  toPhone = '',
  subject = '',
  bodyText = '',
  bodyHtml = '',
  dedupKey = '',
  scheduledFor = null,
  entityType = '',
  entityId = '',
  meta = {},
} = {}) {
  const exists = await tableExists(sbAdmin, 'portal_notification_queue');
  if (!exists) return { ok: true, skipped: true, reason: 'portal_notification_queue_missing' };

  const cleanChannel = cleanStr(channel, 20).toLowerCase();
  if (!cleanChannel) return { ok: false, error: 'invalid_notification_payload' };

  const row = {
    created_by: cleanStr(createdBy, 80) || null,
    user_id: cleanStr(userId, 80) || null,
    workflow_event_id: Number.isFinite(Number(workflowEventId)) ? Math.trunc(Number(workflowEventId)) : null,
    channel: cleanChannel,
    status: cleanStr(status, 20).toLowerCase() || 'pending',
    template_key: cleanStr(templateKey, 80) || null,
    to_email: cleanStr(toEmail, 320) || null,
    to_phone: cleanStr(toPhone, 40) || null,
    subject: cleanStr(subject, 300) || null,
    body_text: cleanStr(bodyText, 8000) || null,
    body_html: cleanStr(bodyHtml, 20000) || null,
    dedup_key: cleanStr(dedupKey, 200) || null,
    scheduled_for: cleanStr(scheduledFor, 80) || null,
    entity_type: cleanStr(entityType, 80) || null,
    entity_id: cleanStr(entityId, 160) || null,
    meta: meta && typeof meta === 'object' ? meta : {},
  };

  const { data, error } = await sbAdmin
    .from('portal_notification_queue')
    .insert(row)
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_notification_queue_failed', detail: error.message || '' };
  return { ok: true, notification: Array.isArray(data) ? data[0] || null : null };
}

module.exports = {
  ALLOWED_PORTAL_ROLES,
  cleanStr,
  normalizePortalRole,
  normalizeCredentialState,
  normalizeWorkerType,
  normalizeDocumentStatus,
  normalizeEventCompletionState,
  normalizeClosureStatus,
  normalizeSurveyStatus,
  normalizeDispatchStatus,
  normalizeRouteStatus,
  normalizeEquipmentStatus,
  normalizeExceptionSeverity,
  normalizeExceptionStatus,
  isMissingRelationError,
  tableExists,
  explainTableMissing,
  syncPortalPerson,
  syncPortalUserIdentity,
  syncPortalEmploymentProfile,
  ensurePortalRoleAuthorization,
  upsertEventAttendanceRecord,
  upsertEventClosureRecord,
  upsertEventSurveyDistribution,
  ensureDispatchWorkOrder,
  upsertOperationsException,
  upsertRoutePlan,
  upsertEquipmentHandoff,
  writePortalAudit,
  writePortalWorkflowEvent,
  writePortalAgentActionAudit,
  writePortalSystemIncident,
  enqueuePortalNotification,
};
