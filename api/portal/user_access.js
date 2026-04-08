const crypto = require('crypto');
const { sendJson, handleCors, readJson, isValidEmail } = require('../../lib/vercelApi');
const { requirePortalSession, buildPortalCapabilities } = require('../../lib/portalAuth');
const { cleanStr, normalizePortalRole, syncPortalPerson, syncPortalUserIdentity, tableExists, writePortalAudit, writePortalWorkflowEvent } = require('../../lib/portalFoundation');
const { summarizeAuthIdentity } = require('../../lib/portalIdentity');

function titleCaseWords(value) {
  return String(value || '')
    .split(/[\s._-]+/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function fallbackFullName(email, role) {
  const local = String(email || '').split('@')[0] || '';
  return cleanStr(titleCaseWords(local || role || 'Team member'), 120) || 'Team member';
}

function emailDomain(email) {
  const s = String(email || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0) return '';
  return s.slice(at + 1);
}

function allowedDomains() {
  const raw = String(process.env.PORTAL_ALLOWED_EMAIL_DOMAINS || '').trim();
  const fallback = ['purestaync.com', 'demo.purestaync.com'];
  const items = raw
    ? raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
    : fallback;
  return Array.from(new Set(items));
}

function isAllowedEmail(email) {
  const domain = emailDomain(email);
  if (!domain) return false;
  return allowedDomains().some((allowed) => domain === allowed || domain.endsWith('.' + allowed));
}

function tempPassword() {
  return `Purestay!${crypto.randomBytes(6).toString('hex')}`;
}

async function findAuthUserByEmail(sbAdmin, email) {
  const target = cleanStr(email, 320).toLowerCase();
  if (!target) return { ok: false, error: 'email_required' };
  try {
    const listed = await sbAdmin.auth.admin.listUsers({ page: 1, perPage: 500 });
    if (listed?.error) return { ok: false, error: 'auth_list_failed', detail: listed.error.message || '' };
    const user = (listed?.data?.users || []).find((entry) => String(entry?.email || '').trim().toLowerCase() === target) || null;
    return { ok: true, user };
  } catch (error) {
    return { ok: false, error: 'auth_list_failed', detail: String(error?.message || error || '') };
  }
}

async function findAuthUserById(sbAdmin, userId) {
  const id = cleanStr(userId, 80);
  if (!id) return { ok: false, error: 'missing_user_id' };
  try {
    const result = await sbAdmin.auth.admin.getUserById(id);
    if (result?.error) return { ok: false, error: 'auth_lookup_failed', detail: result.error.message || '' };
    const user = result?.data?.user || null;
    return { ok: true, user };
  } catch (error) {
    return { ok: false, error: 'auth_lookup_failed', detail: String(error?.message || error || '') };
  }
}

function accessSupportFlags(sbAdmin) {
  const admin = sbAdmin?.auth?.admin || {};
  return {
    recoveryLink: typeof admin.generateLink === 'function',
    invite: typeof admin.inviteUserByEmail === 'function' || typeof admin.generateLink === 'function',
    suspend: typeof admin.updateUserById === 'function',
  };
}

function accessActionLabel(action) {
  const key = cleanStr(action, 80).toLowerCase();
  const map = {
    provision: 'Provisioned login',
    provision_refresh: 'Refreshed login access',
    reset_password: 'Generated reset link',
    resend_invite: 'Resent invite',
    suspend_access: 'Suspended access',
    restore_access: 'Restored access',
  };
  return map[key] || titleCaseWords(key || 'access_action');
}

async function ensureProvisionOnboarding(sbAdmin, {
  actorUserId = '',
  userId = '',
  email = '',
  approvedRole = '',
  fullName = '',
  managerUserId = '',
} = {}) {
  const personUserId = cleanStr(userId, 80);
  const role = normalizePortalRole(approvedRole, 'dialer');
  if (!personUserId) return { ok: false, error: 'missing_user_id' };
  if (!(await tableExists(sbAdmin, 'portal_intake_submissions'))) {
    return { ok: true, skipped: true, reason: 'portal_intake_submissions_missing' };
  }

  const nowIso = new Date().toISOString();
  const ownerUserId = personUserId;
  const reviewerUserId = cleanStr(managerUserId, 80) || cleanStr(actorUserId, 80) || null;
  const title = cleanStr(`Employee activation: ${fullName || email || personUserId}`, 200);
  const description = cleanStr(`Access provisioned for ${fullName || email || personUserId}. Complete profile setup, required onboarding steps, and role-specific activation.`, 4000);

  const { data: existingRows, error: existingError } = await sbAdmin
    .from('portal_intake_submissions')
    .select('*')
    .eq('person_user_id', personUserId)
    .eq('source', 'access_provision')
    .eq('intake_type', 'employee_onboarding')
    .order('created_at', { ascending: false })
    .limit(1);
  if (existingError) return { ok: false, error: 'provision_intake_lookup_failed', detail: existingError.message || '' };

  let intake = Array.isArray(existingRows) ? existingRows[0] || null : null;
  if (!intake) {
    const intakeRow = {
      submitted_by: cleanStr(actorUserId, 80) || null,
      person_user_id: personUserId,
      owner_user_id: ownerUserId,
      assigned_user_id: reviewerUserId,
      reviewed_by: reviewerUserId,
      intake_type: 'employee_onboarding',
      status: 'approved',
      subject_role: role,
      source: 'access_provision',
      form_key: 'employee_activation',
      title,
      description,
      payload: {
        email: cleanStr(email, 320),
        fullName: cleanStr(fullName, 120),
        requestedRole: role,
        approvedRole: role,
      },
      normalized_data: {
        requestedRole: role,
        approvedRole: role,
        approvalStatus: 'approved',
      },
      tags: ['employee', 'activation', role].filter(Boolean),
      dedup_key: `access_provision:${personUserId}`,
      meta: {
        onboardingSource: 'user_access_provision',
        requestedRole: role,
        approvedRole: role,
        approvalStatus: 'approved',
        approvedBy: reviewerUserId,
      },
      submitted_at: nowIso,
    };

    const { data, error } = await sbAdmin
      .from('portal_intake_submissions')
      .insert(intakeRow)
      .select('*')
      .limit(1);
    if (error) return { ok: false, error: 'provision_intake_create_failed', detail: error.message || '' };
    intake = Array.isArray(data) ? data[0] || null : null;
  }

  let journey = null;
  if (await tableExists(sbAdmin, 'portal_onboarding_journeys')) {
    const { data: existingJourneyRows, error: journeyLookupError } = await sbAdmin
      .from('portal_onboarding_journeys')
      .select('*')
      .eq('person_user_id', personUserId)
      .eq('role', role)
      .order('created_at', { ascending: false })
      .limit(1);
    if (journeyLookupError) {
      return { ok: false, error: 'provision_journey_lookup_failed', detail: journeyLookupError.message || '' };
    }

    journey = Array.isArray(existingJourneyRows) ? existingJourneyRows[0] || null : null;
    if (!journey) {
      const journeyRow = {
        person_user_id: personUserId,
        intake_submission_id: intake?.id || null,
        role,
        status: 'pending',
        stage_key: 'access_setup',
        owner_user_id: ownerUserId,
        manager_user_id: reviewerUserId,
        checklist: {
          accessActivated: false,
          profileCompleted: false,
          roleConfirmed: true,
        },
        required_forms: ['profile_setup'],
        collected_data: {
          requestedRole: role,
          approvedRole: role,
        },
        notes: description,
        meta: {
          onboardingSource: 'user_access_provision',
          requestedRole: role,
          approvedRole: role,
          approvalStatus: 'approved',
        },
        started_at: nowIso,
      };

      const { data, error } = await sbAdmin
        .from('portal_onboarding_journeys')
        .insert(journeyRow)
        .select('*')
        .limit(1);
      if (error) return { ok: false, error: 'provision_journey_create_failed', detail: error.message || '' };
      journey = Array.isArray(data) ? data[0] || null : null;
    }
  }

  await writePortalWorkflowEvent(sbAdmin, {
    actorUserId: cleanStr(actorUserId, 80) || null,
    ownerUserId: reviewerUserId || ownerUserId,
    entityType: 'person',
    entityId: personUserId,
    eventType: 'access_provisioned',
    status: 'processed',
    priority: 4,
    sourceTable: 'portal_intake_submissions',
    sourceId: String(intake?.id || ''),
    intakeSubmissionId: intake?.id || null,
    onboardingJourneyId: journey?.id || null,
    payload: {
      personUserId,
      email: cleanStr(email, 320),
      approvedRole: role,
      fullName: cleanStr(fullName, 120),
    },
    dedupKey: `access_provisioned:${personUserId}:${role}`,
    meta: {
      source: 'api/portal/user_access',
      managerUserId: reviewerUserId,
    },
  }).catch(() => {});

  return {
    ok: true,
    submission: intake,
    journey,
  };
}

async function listPeopleRecords(sbAdmin) {
  const usePeople = await tableExists(sbAdmin, 'portal_people');
  const query = usePeople
    ? sbAdmin
      .from('portal_people')
      .select('user_id, role, full_name, employment_status, readiness_status, manager_user_id, can_be_assigned, created_at, updated_at')
      .order('created_at', { ascending: true })
      .limit(500)
    : sbAdmin
      .from('portal_profiles')
      .select('user_id, role, full_name, created_at')
      .order('created_at', { ascending: true })
      .limit(500);
  const { data, error } = await query;
  if (error) return { ok: false, error: 'people_records_query_failed', detail: error.message || '' };
  return {
    ok: true,
    usePeople,
    rows: Array.isArray(data) ? data : [],
  };
}

async function listProfileNames(sbAdmin, userIds = []) {
  const unique = Array.from(new Set((Array.isArray(userIds) ? userIds : []).map((value) => cleanStr(value, 80)).filter(Boolean)));
  if (!unique.length) return new Map();
  const { data, error } = await sbAdmin
    .from('portal_profiles')
    .select('user_id, full_name')
    .in('user_id', unique)
    .limit(unique.length);
  if (error) return new Map();
  return new Map((data || []).map((row) => [String(row.user_id || ''), cleanStr(row.full_name, 120)]));
}

async function listRecentAccessAudit(sbAdmin, userIds = [], limit = 1000) {
  if (!(await tableExists(sbAdmin, 'portal_entity_audit'))) return [];
  const unique = Array.from(new Set((Array.isArray(userIds) ? userIds : []).map((value) => cleanStr(value, 160)).filter(Boolean)));
  if (!unique.length) return [];
  const { data, error } = await sbAdmin
    .from('portal_entity_audit')
    .select('id, created_at, actor_user_id, entity_id, action, before_payload, after_payload, meta')
    .eq('entity_type', 'user_access')
    .in('entity_id', unique)
    .order('id', { ascending: false })
    .limit(limit);
  if (error) return [];
  return Array.isArray(data) ? data : [];
}

async function listRecentAccessAuditForUser(sbAdmin, userId, limit = 20) {
  const cleanUserId = cleanStr(userId, 160);
  if (!cleanUserId) return [];
  if (!(await tableExists(sbAdmin, 'portal_entity_audit'))) return [];
  const { data, error } = await sbAdmin
    .from('portal_entity_audit')
    .select('id, created_at, actor_user_id, entity_id, action, before_payload, after_payload, meta')
    .eq('entity_type', 'user_access')
    .eq('entity_id', cleanUserId)
    .order('id', { ascending: false })
    .limit(limit);
  if (error) return [];
  return Array.isArray(data) ? data : [];
}

function buildAccessAuditSummary(rows = []) {
  const summary = {
    lastAction: '',
    lastActionLabel: '',
    lastActionAt: '',
    lastActorUserId: '',
    provisionedAt: '',
    resetAt: '',
    invitedAt: '',
    suspendedAt: '',
    restoredAt: '',
  };
  for (const row of rows) {
    const action = cleanStr(row?.action, 80).toLowerCase();
    const createdAt = cleanStr(row?.created_at, 80);
    if (!summary.lastActionAt && action) {
      summary.lastAction = action;
      summary.lastActionLabel = accessActionLabel(action);
      summary.lastActionAt = createdAt;
      summary.lastActorUserId = cleanStr(row?.actor_user_id, 80);
    }
    if (!summary.provisionedAt && ['provision', 'provision_refresh'].includes(action)) summary.provisionedAt = createdAt;
    if (!summary.resetAt && action === 'reset_password') summary.resetAt = createdAt;
    if (!summary.invitedAt && action === 'resend_invite') summary.invitedAt = createdAt;
    if (!summary.suspendedAt && action === 'suspend_access') summary.suspendedAt = createdAt;
    if (!summary.restoredAt && action === 'restore_access') summary.restoredAt = createdAt;
  }
  return summary;
}

function mapAccessAuditRows(rows = [], actorNames = new Map()) {
  return rows.map((row) => {
    const action = cleanStr(row?.action, 80).toLowerCase();
    const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
    const afterPayload = row?.after_payload && typeof row.after_payload === 'object' ? row.after_payload : {};
    const actorUserId = cleanStr(row?.actor_user_id, 80);
    return {
      id: Number(row?.id || 0) || 0,
      createdAt: cleanStr(row?.created_at, 80),
      action,
      actionLabel: accessActionLabel(action),
      actorUserId,
      actorName: cleanStr(actorNames.get(actorUserId), 120) || '',
      email: cleanStr(afterPayload.email || meta.email, 320),
      role: cleanStr(afterPayload.role, 40),
      mode: cleanStr(afterPayload.mode || meta.mode, 40),
      meta,
    };
  });
}

function buildRosterEntry(record, authUser, auditRows, actorNames, supports) {
  const identity = summarizeAuthIdentity(authUser, { emailFallback: '' });
  const auditSummary = buildAccessAuditSummary(auditRows);
  const lastActorName = cleanStr(actorNames.get(auditSummary.lastActorUserId), 120);
  return {
    userId: cleanStr(record?.user_id, 80),
    fullName: cleanStr(record?.full_name, 120),
    role: cleanStr(record?.role, 40),
    email: identity.email,
    managerUserId: cleanStr(record?.manager_user_id, 80),
    managerName: cleanStr(actorNames.get(cleanStr(record?.manager_user_id, 80)), 120),
    employmentStatus: cleanStr(record?.employment_status, 40),
    readinessStatus: cleanStr(record?.readiness_status, 40),
    canBeAssigned: record?.can_be_assigned != null ? Boolean(record.can_be_assigned) : true,
    createdAt: cleanStr(record?.created_at, 80),
    updatedAt: cleanStr(record?.updated_at || record?.created_at, 80),
    authIdentity: identity,
    accessAudit: Object.assign({}, auditSummary, {
      lastActorName,
    }),
    supports,
  };
}

async function setAccessSuspendedState(sbAdmin, userId, suspended) {
  if (typeof sbAdmin?.auth?.admin?.updateUserById !== 'function') {
    return { ok: false, error: 'auth_update_unavailable' };
  }
  try {
    const result = await sbAdmin.auth.admin.updateUserById(cleanStr(userId, 80), {
      ban_duration: suspended ? '876000h' : 'none',
    });
    if (result?.error) return { ok: false, error: 'auth_update_failed', detail: result.error.message || '' };
    return { ok: true, user: result?.data?.user || null };
  } catch (error) {
    return { ok: false, error: 'auth_update_failed', detail: String(error?.message || error || '') };
  }
}

async function resendInvite(sbAdmin, email) {
  const cleanEmail = cleanStr(email, 320).toLowerCase();
  if (!cleanEmail) return { ok: false, error: 'valid_email_required' };

  if (typeof sbAdmin?.auth?.admin?.inviteUserByEmail === 'function') {
    try {
      const result = await sbAdmin.auth.admin.inviteUserByEmail(cleanEmail);
      if (!result?.error) {
        return {
          ok: true,
          mode: 'invite_email',
          actionLink: '',
          user: result?.data?.user || null,
        };
      }
    } catch {}
  }

  if (typeof sbAdmin?.auth?.admin?.generateLink === 'function') {
    try {
      const result = await sbAdmin.auth.admin.generateLink({ type: 'invite', email: cleanEmail });
      if (result?.error) return { ok: false, error: 'invite_failed', detail: result.error.message || '' };
      const props = result?.data?.properties || {};
      return {
        ok: true,
        mode: 'invite_link',
        actionLink: cleanStr(props.action_link || result?.data?.action_link, 4000),
        user: result?.data?.user || null,
      };
    } catch (error) {
      return { ok: false, error: 'invite_failed', detail: String(error?.message || error || '') };
    }
  }

  return { ok: false, error: 'invite_unavailable' };
}

async function ensurePortalIdentity(sbAdmin, { userId, email, role, fullName, managerUserId = '' } = {}) {
  const cleanUserId = cleanStr(userId, 80);
  if (!cleanUserId) return { ok: false, error: 'missing_user_id' };
  const nextRole = normalizePortalRole(role, 'dialer');
  const nextFullName = cleanStr(fullName, 120) || fallbackFullName(email, nextRole);

  const { data, error } = await sbAdmin
    .from('portal_profiles')
    .upsert({ user_id: cleanUserId, role: nextRole, full_name: nextFullName }, { onConflict: 'user_id' })
    .select('user_id, role, full_name, created_at')
    .limit(1);
  if (error) return { ok: false, error: 'profile_provision_failed', detail: error.message || '' };

  const profile = Array.isArray(data) ? data[0] || null : null;
  const synced = await syncPortalPerson(sbAdmin, {
    userId: cleanUserId,
    role: nextRole,
    fullName: nextFullName,
    createdAt: profile?.created_at,
    patch: {
      manager_user_id: cleanStr(managerUserId, 80) || undefined,
    },
  });
  if (!synced.ok) return { ok: false, error: synced.error || 'portal_people_sync_failed', detail: synced.detail || '' };

  return {
    ok: true,
    profile: profile || { user_id: cleanUserId, role: nextRole, full_name: nextFullName, created_at: '' },
    person: synced.person || null,
  };
}

async function generateRecoveryLink(sbAdmin, email) {
  if (typeof sbAdmin?.auth?.admin?.generateLink !== 'function') {
    return { ok: false, error: 'generate_link_unavailable' };
  }

  try {
    const result = await sbAdmin.auth.admin.generateLink({ type: 'recovery', email: cleanStr(email, 320).toLowerCase() });
    if (result?.error) return { ok: false, error: 'recovery_link_failed', detail: result.error.message || '' };
    const props = result?.data?.properties || {};
    return {
      ok: true,
      actionLink: cleanStr(props.action_link || result?.data?.action_link, 4000),
      hashedToken: cleanStr(props.hashed_token || result?.data?.hashed_token, 400),
      emailOtp: cleanStr(props.email_otp || result?.data?.email_otp, 40),
    };
  } catch (error) {
    return { ok: false, error: 'recovery_link_failed', detail: String(error?.message || error || '') };
  }
}

async function updateUserMetadata(sbAdmin, userId, role) {
  if (typeof sbAdmin?.auth?.admin?.updateUserById !== 'function') return { ok: true, skipped: true };
  try {
    const result = await sbAdmin.auth.admin.updateUserById(cleanStr(userId, 80), {
      user_metadata: { role: normalizePortalRole(role, 'dialer') },
    });
    if (result?.error) return { ok: false, error: 'auth_update_failed', detail: result.error.message || '' };
    return { ok: true, user: result?.data?.user || null };
  } catch (error) {
    return { ok: false, error: 'auth_update_failed', detail: String(error?.message || error || '') };
  }
}

function actionAuditMeta(session, extra = {}) {
  return Object.assign({
    realActorUserId: cleanStr(session.realActorUserId || session.user?.id, 80) || null,
    effectiveActorUserId: cleanStr(session.actorUserId, 80) || null,
    realRole: cleanStr(session.realProfile?.role, 40) || null,
    effectiveRole: cleanStr(session.profile?.role, 40) || null,
    viewAsRole: cleanStr(session.viewAsRole, 40) || null,
    viewAsUserId: cleanStr(session.viewAsUserId, 80) || null,
    impersonating: !!session.impersonating,
  }, extra);
}

async function syncIdentityFromAuthUser(sbAdmin, authUser, {
  actorUserId = '',
  action = '',
  mode = '',
  suspended = false,
} = {}) {
  const identity = summarizeAuthIdentity(authUser, { emailFallback: authUser?.email || '' });
  return syncPortalUserIdentity(sbAdmin, {
    userId: cleanStr(authUser?.id, 80),
    email: identity.email,
    phone: identity.phone,
    credentialState: identity.status,
    inviteSentAt: identity.invitedAt || (action === 'resend_invite' ? new Date().toISOString() : ''),
    emailConfirmedAt: identity.emailConfirmedAt,
    lastSignInAt: identity.lastSignInAt,
    suspendedAt: suspended ? new Date().toISOString() : '',
    suspendedReason: suspended ? 'access_suspended_from_portal' : '',
    provisionedBy: action === 'provision' ? cleanStr(actorUserId, 80) : '',
    lastAccessActionAt: new Date().toISOString(),
    lastAccessActionBy: cleanStr(actorUserId, 80),
    meta: {
      syncSource: 'api/portal/user_access',
      lastAction: cleanStr(action, 40),
      lastMode: cleanStr(mode, 40) || null,
    },
  });
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;
  if (!['GET', 'POST'].includes(req.method)) return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const capabilities = s.capabilities || buildPortalCapabilities(s);

  if (req.method === 'GET') {
    if (!capabilities.canManageUserAccess) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const url = new URL(req.url || '/api/portal/user_access', 'http://localhost');
    const requestedUserId = cleanStr(url.searchParams.get('userId'), 80);
    const supports = accessSupportFlags(s.sbAdmin);

    const listed = await listPeopleRecords(s.sbAdmin);
    if (!listed.ok) return sendJson(res, 500, { ok: false, error: listed.error, detail: listed.detail || '' });

    const authList = await s.sbAdmin.auth.admin.listUsers({ page: 1, perPage: 500 });
    if (authList?.error) {
      return sendJson(res, 500, { ok: false, error: 'auth_list_failed', detail: authList.error.message || '' });
    }
    const authUsers = Array.isArray(authList?.data?.users) ? authList.data.users : [];
    const authById = new Map(authUsers.map((user) => [cleanStr(user?.id, 80), user]));
    const recordIds = listed.rows.map((row) => cleanStr(row?.user_id, 80)).filter(Boolean);
    const auditRows = requestedUserId
      ? await listRecentAccessAuditForUser(s.sbAdmin, requestedUserId, 20)
      : await listRecentAccessAudit(s.sbAdmin, recordIds, 1000);
    const actorNames = await listProfileNames(s.sbAdmin, [
      ...recordIds,
      ...auditRows.map((row) => row?.actor_user_id),
      ...listed.rows.map((row) => row?.manager_user_id),
    ]);

    if (requestedUserId) {
      const record = listed.rows.find((row) => cleanStr(row?.user_id, 80) === requestedUserId) || null;
      if (!record) return sendJson(res, 404, { ok: false, error: 'user_access_record_not_found' });
      const entry = buildRosterEntry(
        record,
        authById.get(requestedUserId) || null,
        auditRows,
        actorNames,
        supports,
      );
      return sendJson(res, 200, {
        ok: true,
        entry,
        history: mapAccessAuditRows(auditRows, actorNames),
        permissions: {
          canManageUserAccess: capabilities.canManageUserAccess,
        },
      });
    }

    const accounts = listed.rows
      .map((row) => {
        const userId = cleanStr(row?.user_id, 80);
        const perUserAuditRows = auditRows.filter((item) => cleanStr(item?.entity_id, 160) === userId);
        return buildRosterEntry(row, authById.get(userId) || null, perUserAuditRows, actorNames, supports);
      })
      .sort((left, right) => {
        const leftName = String(left.fullName || left.email || left.userId || '').toLowerCase();
        const rightName = String(right.fullName || right.email || right.userId || '').toLowerCase();
        return leftName.localeCompare(rightName);
      });

    return sendJson(res, 200, {
      ok: true,
      accounts,
      supports,
      permissions: {
        canManageUserAccess: capabilities.canManageUserAccess,
      },
    });
  }

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const action = cleanStr(body.action, 40).toLowerCase();
  if (!action) return sendJson(res, 422, { ok: false, error: 'missing_action' });

  if (action === 'provision') {
    if (!capabilities.canManageUsers) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const email = cleanStr(body.email, 320).toLowerCase();
    const role = normalizePortalRole(body.role, 'dialer');
    const fullName = cleanStr(body.fullName, 120) || fallbackFullName(email, role);
    const managerUserId = cleanStr(body.managerUserId, 80);
    if (!email || !isValidEmail(email)) return sendJson(res, 422, { ok: false, error: 'valid_email_required' });
    if (!isAllowedEmail(email)) return sendJson(res, 403, { ok: false, error: 'email_not_allowed' });

    const found = await findAuthUserByEmail(s.sbAdmin, email);
    if (!found.ok) return sendJson(res, 500, { ok: false, error: found.error, detail: found.detail || '' });

    let authUser = found.user;
    let createdNew = false;
    let bootstrapPassword = '';

    if (!authUser) {
      bootstrapPassword = tempPassword();
      try {
        const created = await s.sbAdmin.auth.admin.createUser({
          email,
          password: bootstrapPassword,
          email_confirm: false,
          user_metadata: { role },
        });
        if (created?.error) {
          return sendJson(res, 500, { ok: false, error: 'auth_create_failed', detail: created.error.message || '' });
        }
        authUser = created?.data?.user || null;
        createdNew = !!authUser;
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: 'auth_create_failed', detail: String(error?.message || error || '') });
      }
    }

    if (!authUser?.id) return sendJson(res, 500, { ok: false, error: 'auth_user_missing' });

    const identity = await ensurePortalIdentity(s.sbAdmin, {
      userId: authUser.id,
      email,
      role,
      fullName,
      managerUserId,
    });
    if (!identity.ok) return sendJson(res, 500, { ok: false, error: identity.error, detail: identity.detail || '' });

    const onboarding = await ensureProvisionOnboarding(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      userId: authUser.id,
      email,
      approvedRole: role,
      fullName,
      managerUserId,
    });
    if (!onboarding.ok) return sendJson(res, 500, { ok: false, error: onboarding.error, detail: onboarding.detail || '' });

    const recovery = await generateRecoveryLink(s.sbAdmin, email);
    const accessMode = recovery.ok ? 'recovery_link' : 'manual_recovery_required';

    await updateUserMetadata(s.sbAdmin, authUser.id, role).catch(() => ({}));
    await syncIdentityFromAuthUser(s.sbAdmin, authUser, {
      actorUserId: s.realActorUserId || s.user.id,
      action: createdNew ? 'provision' : 'provision_refresh',
      mode: accessMode,
    }).catch(() => {});

    await writePortalAudit(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      entityType: 'user_access',
      entityId: cleanStr(authUser.id, 160),
      action: createdNew ? 'provision' : 'provision_refresh',
      beforePayload: null,
      afterPayload: {
        email,
        role,
        fullName,
        createdNew,
        managerUserId: managerUserId || null,
        mode: accessMode,
        onboardingSubmissionId: onboarding.submission?.id || null,
        onboardingJourneyId: onboarding.journey?.id || null,
      },
      meta: actionAuditMeta(s, { action, email }),
    }).catch(() => {});

    return sendJson(res, 200, {
      ok: true,
      createdNew,
      user: {
        id: authUser.id,
        email,
      },
      profile: {
        role: identity.profile?.role || role,
        fullName: identity.profile?.full_name || fullName,
      },
      access: {
        actionLink: recovery.ok ? recovery.actionLink : '',
        mode: accessMode,
      },
      onboarding: {
        submissionId: onboarding.submission?.id || null,
        journeyId: onboarding.journey?.id || null,
        journeyStage: onboarding.journey?.stage_key || '',
      },
    });
  }

  if (action === 'reset_password') {
    const requestedUserId = cleanStr(body.userId, 80);
    const requestedEmail = cleanStr(body.email, 320).toLowerCase();
    const targetUserId = capabilities.canManageUsers
      ? (requestedUserId || cleanStr(s.user?.id, 80))
      : cleanStr(s.user?.id, 80);

    if (!capabilities.canManageUsers && requestedUserId && requestedUserId !== cleanStr(s.user?.id, 80)) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    let authUser = null;
    if (targetUserId) {
      const found = await findAuthUserById(s.sbAdmin, targetUserId);
      if (!found.ok) return sendJson(res, 500, { ok: false, error: found.error, detail: found.detail || '' });
      authUser = found.user;
    }
    if (!authUser && requestedEmail) {
      const found = await findAuthUserByEmail(s.sbAdmin, requestedEmail);
      if (!found.ok) return sendJson(res, 500, { ok: false, error: found.error, detail: found.detail || '' });
      authUser = found.user;
    }
    if (!authUser?.email) return sendJson(res, 404, { ok: false, error: 'auth_user_not_found' });

    const recovery = await generateRecoveryLink(s.sbAdmin, authUser.email);
    if (!recovery.ok) return sendJson(res, 500, { ok: false, error: recovery.error, detail: recovery.detail || '' });

    await writePortalAudit(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      entityType: 'user_access',
      entityId: cleanStr(authUser.id, 160),
      action: 'reset_password',
      beforePayload: null,
      afterPayload: { email: authUser.email, mode: 'recovery_link' },
      meta: actionAuditMeta(s, { action, email: authUser.email }),
    }).catch(() => {});

    await syncIdentityFromAuthUser(s.sbAdmin, authUser, {
      actorUserId: s.realActorUserId || s.user.id,
      action,
      mode: 'recovery_link',
    }).catch(() => {});

    return sendJson(res, 200, {
      ok: true,
      user: {
        id: authUser.id,
        email: authUser.email || '',
      },
      access: {
        actionLink: recovery.actionLink || '',
        mode: 'recovery_link',
      },
    });
  }

  if (action === 'resend_invite') {
    if (!capabilities.canManageUserAccess) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const requestedUserId = cleanStr(body.userId, 80);
    const requestedEmail = cleanStr(body.email, 320).toLowerCase();

    let authUser = null;
    if (requestedUserId) {
      const found = await findAuthUserById(s.sbAdmin, requestedUserId);
      if (!found.ok) return sendJson(res, 500, { ok: false, error: found.error, detail: found.detail || '' });
      authUser = found.user;
    }
    if (!authUser && requestedEmail) {
      const found = await findAuthUserByEmail(s.sbAdmin, requestedEmail);
      if (!found.ok) return sendJson(res, 500, { ok: false, error: found.error, detail: found.detail || '' });
      authUser = found.user;
    }
    if (!authUser?.email) return sendJson(res, 404, { ok: false, error: 'auth_user_not_found' });

    const invited = await resendInvite(s.sbAdmin, authUser.email);
    if (!invited.ok) return sendJson(res, 500, { ok: false, error: invited.error, detail: invited.detail || '' });

    await writePortalAudit(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      entityType: 'user_access',
      entityId: cleanStr(authUser.id, 160),
      action: 'resend_invite',
      beforePayload: summarizeAuthIdentity(authUser, { emailFallback: authUser.email || '' }),
      afterPayload: { email: authUser.email, mode: invited.mode || '' },
      meta: actionAuditMeta(s, { action, email: authUser.email, mode: invited.mode || '' }),
    }).catch(() => {});

    await syncIdentityFromAuthUser(s.sbAdmin, authUser, {
      actorUserId: s.realActorUserId || s.user.id,
      action,
      mode: invited.mode || '',
    }).catch(() => {});

    return sendJson(res, 200, {
      ok: true,
      user: {
        id: authUser.id,
        email: authUser.email || '',
      },
      access: {
        actionLink: invited.actionLink || '',
        mode: invited.mode || 'invite_email',
      },
    });
  }

  if (action === 'suspend_access' || action === 'restore_access') {
    if (!capabilities.canManageUserAccess) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const requestedUserId = cleanStr(body.userId, 80);
    if (!requestedUserId) return sendJson(res, 422, { ok: false, error: 'missing_user_id' });
    if (requestedUserId === cleanStr(s.user?.id, 80)) {
      return sendJson(res, 422, { ok: false, error: 'self_access_change_blocked' });
    }

    const found = await findAuthUserById(s.sbAdmin, requestedUserId);
    if (!found.ok) return sendJson(res, 500, { ok: false, error: found.error, detail: found.detail || '' });
    if (!found.user?.id) return sendJson(res, 404, { ok: false, error: 'auth_user_not_found' });

    const beforeIdentity = summarizeAuthIdentity(found.user, { emailFallback: found.user.email || '' });
    const updated = await setAccessSuspendedState(s.sbAdmin, requestedUserId, action === 'suspend_access');
    if (!updated.ok) return sendJson(res, 500, { ok: false, error: updated.error, detail: updated.detail || '' });

    const refreshed = await findAuthUserById(s.sbAdmin, requestedUserId);
    if (!refreshed.ok) return sendJson(res, 500, { ok: false, error: refreshed.error, detail: refreshed.detail || '' });
    const afterIdentity = summarizeAuthIdentity(refreshed.user, { emailFallback: found.user.email || '' });

    await writePortalAudit(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      entityType: 'user_access',
      entityId: cleanStr(requestedUserId, 160),
      action,
      beforePayload: beforeIdentity,
      afterPayload: afterIdentity,
      meta: actionAuditMeta(s, { action, email: found.user.email || '' }),
    }).catch(() => {});

    await syncIdentityFromAuthUser(s.sbAdmin, refreshed.user || found.user, {
      actorUserId: s.realActorUserId || s.user.id,
      action,
      suspended: action === 'suspend_access',
    }).catch(() => {});

    return sendJson(res, 200, {
      ok: true,
      user: {
        id: requestedUserId,
        email: found.user.email || '',
      },
      authIdentity: afterIdentity,
    });
  }

  return sendJson(res, 422, { ok: false, error: 'unsupported_action' });
};