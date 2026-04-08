const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, buildPortalCapabilities } = require('../../lib/portalAuth');
const { cleanStr, normalizePortalRole, tableExists, syncPortalPerson, writePortalAudit } = require('../../lib/portalFoundation');
const { summarizeAuthIdentity } = require('../../lib/portalIdentity');
const { addHoursIso, buildActorMeta, emitOpsTrigger } = require('../../lib/portalOpsTriggers');

function normalizeStatus(v, allowed, fallback = '') {
  const s = cleanStr(v, 40).toLowerCase();
  return allowed.includes(s) ? s : fallback;
}

function normalizeBool(v, fallback = null) {
  if (typeof v === 'boolean') return v;
  const s = cleanStr(v, 12).toLowerCase();
  if (!s) return fallback;
  if (['1', 'true', 'yes'].includes(s)) return true;
  if (['0', 'false', 'no'].includes(s)) return false;
  return fallback;
}

async function getKvValue(sbAdmin, key) {
  const { data, error } = await sbAdmin
    .from('purestay_kv')
    .select('value')
    .eq('key', String(key))
    .limit(1);
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : null;
  return row?.value ?? null;
}

function normalizeLegacyTalentProfile(raw, userId) {
  const profile = raw && typeof raw === 'object' ? raw : {};
  const pub = profile.public && typeof profile.public === 'object' ? profile.public : profile;
  const internal = profile.internal && typeof profile.internal === 'object' ? profile.internal : profile;
  return {
    userId,
    public: {
      displayName: cleanStr(pub.displayName, 120),
      bio: cleanStr(pub.bio, 2000),
      homeBaseCity: cleanStr(pub.homeBaseCity, 80),
      homeBaseState: cleanStr(pub.homeBaseState, 20),
      specialties: Array.isArray(pub.specialties) ? pub.specialties.map((x) => cleanStr(x, 60)).filter(Boolean) : [],
    },
    internal: {
      reliability: internal.reliability && typeof internal.reliability === 'object'
        ? internal.reliability
        : { score: internal.reliabilityScore != null ? Number(internal.reliabilityScore) : null, flags: [] },
      notes: cleanStr(internal.notes, 2000),
    },
    source: 'legacy_kv',
  };
}

function normalizeLegacyAvailability(value) {
  return value && typeof value === 'object' ? value : null;
}

async function getLatestOnboardingJourney(sbAdmin, userId) {
  const hasJourneys = await tableExists(sbAdmin, 'portal_onboarding_journeys');
  if (!hasJourneys) return null;
  const { data, error } = await sbAdmin
    .from('portal_onboarding_journeys')
    .select('id, status, stage_key, started_at, target_ready_at, completed_at, owner_user_id, manager_user_id, updated_at, created_at, notes, meta')
    .eq('person_user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) return null;
  const row = Array.isArray(data) ? data[0] || null : null;
  if (!row) return null;
  return {
    id: row.id,
    status: row.status || '',
    stageKey: row.stage_key || '',
    startedAt: row.started_at || '',
    targetReadyAt: row.target_ready_at || '',
    completedAt: row.completed_at || '',
    ownerUserId: row.owner_user_id || '',
    managerUserId: row.manager_user_id || '',
    updatedAt: row.updated_at || row.created_at || '',
    notes: cleanStr(row.notes, 4000),
    meta: row.meta && typeof row.meta === 'object' ? row.meta : {},
  };
}

async function listPeopleRows(sbAdmin, { canListFull, userId, filters = {} }) {
  const usePeople = await tableExists(sbAdmin, 'portal_people');
  let query = usePeople
    ? sbAdmin
      .from('portal_people')
      .select('user_id, role, full_name, employment_status, readiness_status, team_code, manager_user_id, can_be_assigned, home_base_city, home_base_state, start_date, end_date, created_at, updated_at, meta')
      .order('created_at', { ascending: true })
      .limit(500)
    : sbAdmin
      .from('portal_profiles')
      .select('user_id, role, full_name, created_at')
      .order('created_at', { ascending: true })
      .limit(500);

  if (!canListFull) query = query.eq('user_id', userId);
  if (filters.userId) query = query.eq('user_id', filters.userId);
  if (filters.role) query = query.eq('role', filters.role);
  if (usePeople && filters.employmentStatus) query = query.eq('employment_status', filters.employmentStatus);
  if (usePeople && filters.readinessStatus) query = query.eq('readiness_status', filters.readinessStatus);

  const { data, error } = await query;
  if (error) return { ok: false, error: 'people_query_failed', detail: error.message || '' };

  let rows = Array.isArray(data) ? data : [];
  if (filters.q) {
    const q = filters.q;
    rows = rows.filter((row) => {
      const hay = [
        row.full_name,
        row.role,
        row.team_code,
        row.home_base_city,
        row.home_base_state,
      ].map((x) => String(x || '').toLowerCase()).join(' ');
      return hay.includes(q);
    });
  }

  return { ok: true, rows, usePeople };
}

async function getTrainingSummary(sbAdmin, { userId, role }) {
  const hasModules = await tableExists(sbAdmin, 'portal_training_modules');
  const hasCompletions = await tableExists(sbAdmin, 'portal_training_completions');
  if (!hasModules || !hasCompletions) return null;

  let moduleQuery = sbAdmin
    .from('portal_training_modules')
    .select('id, audience_role, required')
    .eq('required', true)
    .limit(500);

  if (role) moduleQuery = moduleQuery.or(`audience_role.eq.${role},audience_role.is.null`);
  else moduleQuery = moduleQuery.is('audience_role', null);

  const { data: modules, error: mErr } = await moduleQuery;
  if (mErr) return null;

  const requiredModules = Array.isArray(modules) ? modules : [];
  if (!requiredModules.length) return { requiredCount: 0, passedCount: 0, expiredCount: 0 };

  const moduleIds = requiredModules.map((m) => m.id).filter(Boolean);
  const { data: completions, error: cErr } = await sbAdmin
    .from('portal_training_completions')
    .select('module_id, passed, expires_at')
    .eq('user_id', userId)
    .in('module_id', moduleIds)
    .limit(500);
  if (cErr) return null;

  const now = Date.now();
  let passedCount = 0;
  let expiredCount = 0;
  for (const row of (completions || [])) {
    const expiresAt = row?.expires_at ? new Date(row.expires_at).getTime() : null;
    if (expiresAt && Number.isFinite(expiresAt) && expiresAt < now) expiredCount += 1;
    if (row?.passed === true && (!expiresAt || expiresAt >= now)) passedCount += 1;
  }

  return {
    requiredCount: moduleIds.length,
    passedCount,
    expiredCount,
  };
}

async function getOpenTaskCount(sbAdmin, userId) {
  const hasTasks = await tableExists(sbAdmin, 'portal_tasks');
  if (!hasTasks) return null;
  const { count, error } = await sbAdmin
    .from('portal_tasks')
    .select('*', { count: 'exact', head: true })
    .eq('assigned_user_id', userId)
    .in('status', ['open', 'in_progress', 'blocked']);
  if (error) return null;
  return Number(count || 0);
}

async function getIdentityRecord(sbAdmin, userId) {
  if (!(await tableExists(sbAdmin, 'portal_user_identities'))) return null;
  const { data, error } = await sbAdmin
    .from('portal_user_identities')
    .select('*')
    .eq('user_id', userId)
    .limit(1);
  if (error) return null;
  return Array.isArray(data) ? data[0] || null : null;
}

async function getEmploymentProfileDetail(sbAdmin, userId) {
  if (!(await tableExists(sbAdmin, 'portal_employment_profiles'))) return null;
  const { data, error } = await sbAdmin
    .from('portal_employment_profiles')
    .select('*')
    .eq('person_user_id', userId)
    .limit(1);
  if (error) return null;
  return Array.isArray(data) ? data[0] || null : null;
}

async function listRoleAuthorizations(sbAdmin, userId) {
  if (!(await tableExists(sbAdmin, 'portal_person_role_authorizations'))) return [];
  const { data, error } = await sbAdmin
    .from('portal_person_role_authorizations')
    .select('id, created_at, role_code, status, granted_by, granted_at, revoked_by, revoked_at, scope_type, scope_id, notes, meta')
    .eq('person_user_id', userId)
    .order('granted_at', { ascending: false })
    .limit(50);
  if (error) return [];
  return Array.isArray(data) ? data : [];
}

async function listMarketAssignments(sbAdmin, userId) {
  if (!(await tableExists(sbAdmin, 'portal_person_market_assignments'))) return [];
  const { data, error } = await sbAdmin
    .from('portal_person_market_assignments')
    .select('id, created_at, updated_at, market_code, is_primary, coverage_radius_miles, travel_required, active_from, active_to, notes, meta')
    .eq('person_user_id', userId)
    .order('is_primary', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) return [];
  return Array.isArray(data) ? data : [];
}

async function listPersonDocuments(sbAdmin, userId) {
  if (!(await tableExists(sbAdmin, 'portal_person_documents'))) return [];
  const { data, error } = await sbAdmin
    .from('portal_person_documents')
    .select('id, created_at, updated_at, document_type, status, required, submitted_at, verified_at, verified_by, expires_at, storage_ref, notes, meta')
    .eq('person_user_id', userId)
    .order('required', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) return [];
  return Array.isArray(data) ? data : [];
}

async function listDeviceAccessRecords(sbAdmin, userId) {
  if (!(await tableExists(sbAdmin, 'portal_device_access_records'))) return [];
  const { data, error } = await sbAdmin
    .from('portal_device_access_records')
    .select('id, created_at, updated_at, device_type, asset_id, portal_access_enabled, email_access_enabled, messaging_access_enabled, issued_at, revoked_at, issued_by, notes, meta')
    .eq('person_user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) return [];
  return Array.isArray(data) ? data : [];
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const url = new URL(req.url || '/api/portal/people', 'http://localhost');
  const requestedUserId = cleanStr(url.searchParams.get('userId'), 80);
  const filters = {
    userId: requestedUserId,
    role: normalizePortalRole(url.searchParams.get('role'), ''),
    employmentStatus: normalizeStatus(url.searchParams.get('employmentStatus'), ['candidate', 'active', 'inactive', 'contractor', 'alumni'], ''),
    readinessStatus: normalizeStatus(url.searchParams.get('readinessStatus'), ['not_started', 'in_training', 'shadowing', 'ready', 'restricted'], ''),
    q: cleanStr(url.searchParams.get('q'), 200).toLowerCase(),
  };

  const capabilities = s.capabilities || buildPortalCapabilities(s);

  const canListFull = capabilities.canViewPeopleDirectoryData;
  const targetUserId = requestedUserId || s.user.id;

  if (req.method === 'GET') {
    if (!canListFull && targetUserId !== s.user.id) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const listed = await listPeopleRows(s.sbAdmin, {
      canListFull,
      userId: s.user.id,
      filters,
    });
    if (!listed.ok) return sendJson(res, 500, { ok: false, error: listed.error, detail: listed.detail || '' });

    let byId = new Map();
    if (canListFull) {
      const authList = await s.sbAdmin.auth.admin.listUsers({ page: 1, perPage: 500 });
      byId = new Map((authList?.data?.users || []).map((u) => [u.id, u]));
    }

    const people = listed.rows.map((row) => {
      const authUser = byId.get(row.user_id);
      return {
        userId: row.user_id,
        role: row.role,
        fullName: row.full_name || '',
        email: canListFull ? (authUser?.email || '') : '',
        employmentStatus: row.employment_status || '',
        readinessStatus: row.readiness_status || '',
        teamCode: row.team_code || '',
        managerUserId: row.manager_user_id || '',
        canBeAssigned: row.can_be_assigned != null ? Boolean(row.can_be_assigned) : true,
        homeBaseCity: row.home_base_city || '',
        homeBaseState: row.home_base_state || '',
        startDate: row.start_date || '',
        endDate: row.end_date || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at || row.created_at,
        meta: row.meta && typeof row.meta === 'object' ? row.meta : {},
        source: listed.usePeople ? 'portal_people' : 'portal_profiles',
      };
    });

    if (!requestedUserId) {
      return sendJson(res, 200, {
        ok: true,
        people,
        source: listed.usePeople ? 'portal_people' : 'portal_profiles',
        permissions: {
          canManage: capabilities.canManagePeople,
          canAssignManagerOwnership: capabilities.canAssignPeopleManagers,
        },
      });
    }

    const person = people[0] || null;
    if (!person) return sendJson(res, 404, { ok: false, error: 'person_not_found' });

    let authUser = null;
    if (canListFull) {
      const authLookup = await s.sbAdmin.auth.admin.getUserById(targetUserId).catch(() => null);
      authUser = authLookup?.data?.user || null;
    } else if (targetUserId === s.user.id) {
      authUser = s.user;
    }
    const authIdentity = summarizeAuthIdentity(authUser, { emailFallback: person.email || '' });

    let talentProfile = null;
    if (await tableExists(s.sbAdmin, 'portal_talent_profiles')) {
      const { data } = await s.sbAdmin
        .from('portal_talent_profiles')
        .select('*')
        .eq('user_id', targetUserId)
        .limit(1);
      talentProfile = Array.isArray(data) ? data[0] || null : null;
      if (talentProfile) talentProfile.source = 'portal_talent_profiles';
    }
    if (!talentProfile) {
      const kv = await getKvValue(s.sbAdmin, 'portal:talent_profiles:v1');
      const profiles = Array.isArray(kv?.profiles) ? kv.profiles : [];
      const hit = profiles.find((x) => String(x?.userId || '') === targetUserId) || null;
      if (hit) talentProfile = normalizeLegacyTalentProfile(hit, targetUserId);
    }

    let availability = null;
    if (await tableExists(s.sbAdmin, 'portal_availability_windows')) {
      const { data } = await s.sbAdmin
        .from('portal_availability_windows')
        .select('id, starts_at, ends_at, status, source, notes, created_at, meta')
        .eq('user_id', targetUserId)
        .gte('ends_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order('starts_at', { ascending: true })
        .limit(50);
      availability = { source: 'portal_availability_windows', windows: Array.isArray(data) ? data : [] };
    }
    if (!availability || !Array.isArray(availability.windows) || !availability.windows.length) {
      const legacy = await getKvValue(s.sbAdmin, `portal:availability:${targetUserId}`);
      availability = { source: 'legacy_kv', value: normalizeLegacyAvailability(legacy) };
    }

    const [
      trainingSummary,
      openTaskCount,
      onboardingJourney,
      identityRecord,
      employmentProfile,
      roleAuthorizations,
      marketAssignments,
      documents,
      deviceAccessRecords,
    ] = await Promise.all([
      getTrainingSummary(s.sbAdmin, { userId: targetUserId, role: person.role }),
      getOpenTaskCount(s.sbAdmin, targetUserId),
      getLatestOnboardingJourney(s.sbAdmin, targetUserId),
      getIdentityRecord(s.sbAdmin, targetUserId),
      getEmploymentProfileDetail(s.sbAdmin, targetUserId),
      listRoleAuthorizations(s.sbAdmin, targetUserId),
      listMarketAssignments(s.sbAdmin, targetUserId),
      listPersonDocuments(s.sbAdmin, targetUserId),
      listDeviceAccessRecords(s.sbAdmin, targetUserId),
    ]);

    return sendJson(res, 200, {
      ok: true,
      person,
      authIdentity,
      identityRecord,
      employmentProfile,
      talentProfile,
      availability,
      trainingSummary,
      onboardingJourney,
      openTaskCount,
      roleAuthorizations,
      marketAssignments,
      documents,
      deviceAccessRecords,
      permissions: {
        canManage: capabilities.canManagePeople,
        canAssignManagerOwnership: capabilities.canAssignPeopleManagers,
      },
    });
  }

  if (req.method !== 'PATCH') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!capabilities.canManagePeople) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  if (!(await tableExists(s.sbAdmin, 'portal_people'))) {
    return sendJson(res, 503, { ok: false, error: 'foundation_phase1_not_applied' });
  }

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const userId = cleanStr(body.userId, 80);
  if (!userId) return sendJson(res, 422, { ok: false, error: 'missing_user_id' });

  const { data: existingPeopleRows } = await s.sbAdmin
    .from('portal_people')
    .select('*')
    .eq('user_id', userId)
    .limit(1);
  const existingPerson = Array.isArray(existingPeopleRows) ? existingPeopleRows[0] || null : null;

  const { data: profiles } = await s.sbAdmin
    .from('portal_profiles')
    .select('user_id, role, full_name, created_at')
    .eq('user_id', userId)
    .limit(1);
  const profile = Array.isArray(profiles) ? profiles[0] || null : null;
  if (!profile) return sendJson(res, 404, { ok: false, error: 'profile_not_found' });

  const role = body.role != null ? normalizePortalRole(body.role, profile.role) : profile.role;
  const fullName = body.fullName != null ? cleanStr(body.fullName, 120) : profile.full_name;
  const patch = {
    employment_status: body.employmentStatus != null ? normalizeStatus(body.employmentStatus, ['candidate', 'active', 'inactive', 'contractor', 'alumni'], 'active') : undefined,
    readiness_status: body.readinessStatus != null ? normalizeStatus(body.readinessStatus, ['not_started', 'in_training', 'shadowing', 'ready', 'restricted'], 'not_started') : undefined,
    team_code: body.teamCode != null ? (cleanStr(body.teamCode, 80) || null) : undefined,
    manager_user_id: body.managerUserId != null ? (cleanStr(body.managerUserId, 80) || null) : undefined,
    start_date: body.startDate != null ? (cleanStr(body.startDate, 20) || null) : undefined,
    end_date: body.endDate != null ? (cleanStr(body.endDate, 20) || null) : undefined,
    can_be_assigned: body.canBeAssigned != null ? Boolean(body.canBeAssigned) : undefined,
    home_base_city: body.homeBaseCity != null ? (cleanStr(body.homeBaseCity, 80) || null) : undefined,
    home_base_state: body.homeBaseState != null ? (cleanStr(body.homeBaseState, 20) || null) : undefined,
    meta: body.meta && typeof body.meta === 'object' ? body.meta : undefined,
  };

  const sync = await syncPortalPerson(s.sbAdmin, {
    userId,
    role,
    fullName,
    createdAt: profile.created_at,
    patch,
  });
  if (!sync.ok) return sendJson(res, 500, { ok: false, error: sync.error || 'portal_people_sync_failed', detail: sync.detail || '' });

  const { error: profileErr } = await s.sbAdmin
    .from('portal_profiles')
    .update({ role, full_name: fullName })
    .eq('user_id', userId);
  if (profileErr) return sendJson(res, 500, { ok: false, error: 'profile_update_failed', detail: profileErr.message || '' });

  const actorMeta = buildActorMeta(s);

  await writePortalAudit(s.sbAdmin, {
    actorUserId: s.realActorUserId || s.user.id,
    entityType: 'person',
    entityId: userId,
    action: 'update',
    beforePayload: existingPerson || profile,
    afterPayload: sync.person || null,
    meta: actorMeta,
  }).catch(() => {});

  const beforeReadiness = cleanStr(existingPerson?.readiness_status, 40);
  const afterReadiness = cleanStr(sync.person?.readiness_status, 40);
  const managerUserId = cleanStr(sync.person?.manager_user_id, 80) || null;
  const assigneeUserId = managerUserId || s.realActorUserId || s.user.id;

  if (beforeReadiness !== afterReadiness && afterReadiness === 'ready') {
    await emitOpsTrigger(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      ownerUserId: managerUserId || userId,
      entityType: 'person',
      entityId: userId,
      eventType: 'person_ready',
      priority: 6,
      sourceTable: 'portal_people',
      sourceId: userId,
      payload: { before: existingPerson, after: sync.person || null },
      meta: actorMeta,
      dedupKey: `person_ready:person:${userId}:${afterReadiness}:${String(sync.person?.can_be_assigned)}`,
      task: {
        assignedUserId: assigneeUserId,
        taskType: 'training',
        priority: 5,
        dueAt: addHoursIso(24),
        title: `Review ready staffing status${fullName ? `: ${fullName}` : ''}`,
        description: cleanStr(`Confirm assignment readiness and next staffing step for ${fullName || userId}.`, 5000),
        meta: { userId, trigger: 'person_ready' },
      },
      notification: managerUserId ? {
        userId: managerUserId,
        channel: 'in_app',
        subject: 'Team member ready',
        bodyText: cleanStr(`${fullName || userId} is now marked ready.`, 8000),
        meta: { userId, trigger: 'person_ready' },
      } : null,
    }).catch(() => {});
  }

  if (beforeReadiness !== afterReadiness && afterReadiness === 'restricted') {
    await emitOpsTrigger(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      ownerUserId: managerUserId || userId,
      entityType: 'person',
      entityId: userId,
      eventType: 'person_restricted',
      priority: 8,
      sourceTable: 'portal_people',
      sourceId: userId,
      payload: { before: existingPerson, after: sync.person || null },
      meta: actorMeta,
      dedupKey: `person_restricted:person:${userId}:${afterReadiness}:${String(sync.person?.can_be_assigned)}`,
      task: {
        assignedUserId: assigneeUserId,
        taskType: 'admin',
        priority: 8,
        dueAt: addHoursIso(12),
        title: `Review staffing restriction${fullName ? `: ${fullName}` : ''}`,
        description: cleanStr(`Review restriction status and active workload impact for ${fullName || userId}.`, 5000),
        meta: { userId, trigger: 'person_restricted' },
      },
      notification: managerUserId ? {
        userId: managerUserId,
        channel: 'in_app',
        subject: 'Team member restricted',
        bodyText: cleanStr(`${fullName || userId} is now marked restricted.`, 8000),
        meta: { userId, trigger: 'person_restricted' },
      } : null,
    }).catch(() => {});
  }

  return sendJson(res, 200, { ok: true, person: sync.person || null });
};
