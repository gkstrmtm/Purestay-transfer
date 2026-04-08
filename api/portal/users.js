const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager } = require('../../lib/portalAuth');
const { normalizePortalRole, cleanStr, tableExists, syncPortalPerson } = require('../../lib/portalFoundation');

function normalizeStatus(v, allowed, fallback = '') {
  const s = cleanStr(v, 40).toLowerCase();
  return allowed.includes(s) ? s : fallback;
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  // Managers and event coordinators can view the full directory; only managers can edit.
  // Dialers/setters/closers/AMs can view a limited list (no emails) for scheduling.
  const canListFull = isManager(s.realProfile) || hasRole(s.realProfile, ['event_coordinator']);
  const canListLimited = hasRole(s.profile, ['dialer', 'remote_setter', 'in_person_setter', 'closer', 'account_manager']);
  if (!canListFull && !canListLimited) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  if (req.method === 'PATCH') {
    if (!isManager(s.realProfile)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const userId = cleanStr(body.userId, 80);
    if (!userId) return sendJson(res, 422, { ok: false, error: 'missing_user_id' });

    const patch = {
      role: body.role != null ? normalizePortalRole(body.role, '') : undefined,
      full_name: body.fullName != null ? cleanStr(body.fullName, 120) : undefined,
    };

    const personPatch = {
      role: patch.role,
      full_name: patch.full_name,
      employment_status: body.employmentStatus != null ? normalizeStatus(body.employmentStatus, ['candidate', 'active', 'inactive', 'contractor', 'alumni'], '') : undefined,
      readiness_status: body.readinessStatus != null ? normalizeStatus(body.readinessStatus, ['not_started', 'in_training', 'shadowing', 'ready', 'restricted'], '') : undefined,
      team_code: body.teamCode != null ? cleanStr(body.teamCode, 80) : undefined,
      manager_user_id: body.managerUserId != null ? (cleanStr(body.managerUserId, 80) || null) : undefined,
      start_date: body.startDate != null ? (cleanStr(body.startDate, 20) || null) : undefined,
      end_date: body.endDate != null ? (cleanStr(body.endDate, 20) || null) : undefined,
      can_be_assigned: body.canBeAssigned != null ? Boolean(body.canBeAssigned) : undefined,
      home_base_city: body.homeBaseCity != null ? cleanStr(body.homeBaseCity, 80) : undefined,
      home_base_state: body.homeBaseState != null ? cleanStr(body.homeBaseState, 20) : undefined,
    };

    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined) delete patch[k];
    }
    for (const k of Object.keys(personPatch)) {
      if (personPatch[k] === undefined || personPatch[k] === '') delete personPatch[k];
    }

    if (!Object.keys(patch).length && !Object.keys(personPatch).length) {
      return sendJson(res, 422, { ok: false, error: 'missing_patch_fields' });
    }

    let profile = null;
    if (Object.keys(patch).length) {
      const { data, error } = await s.sbAdmin
        .from('portal_profiles')
        .update(patch)
        .eq('user_id', userId)
        .select('user_id, role, full_name, created_at')
        .limit(1);

      if (error) return sendJson(res, 500, { ok: false, error: 'profile_update_failed' });
      profile = Array.isArray(data) ? data[0] : null;
    } else {
      const { data, error } = await s.sbAdmin
        .from('portal_profiles')
        .select('user_id, role, full_name, created_at')
        .eq('user_id', userId)
        .limit(1);
      if (error) return sendJson(res, 500, { ok: false, error: 'profile_lookup_failed' });
      profile = Array.isArray(data) ? data[0] : null;
    }

    if (!profile) return sendJson(res, 404, { ok: false, error: 'profile_not_found' });

    let person = null;
    if (await tableExists(s.sbAdmin, 'portal_people')) {
      const sync = await syncPortalPerson(s.sbAdmin, {
        userId,
        role: profile.role,
        fullName: profile.full_name,
        createdAt: profile.created_at,
        patch: personPatch,
      });
      if (!sync.ok) {
        return sendJson(res, 500, {
          ok: false,
          error: sync.error || 'portal_people_sync_failed',
          detail: sync.detail || '',
        });
      }
      person = sync.person || null;
    }

    return sendJson(res, 200, { ok: true, profile, person });
  }

  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const usePeople = await tableExists(s.sbAdmin, 'portal_people');
  let query = usePeople
    ? s.sbAdmin
      .from('portal_people')
      .select('user_id, role, full_name, employment_status, readiness_status, team_code, manager_user_id, can_be_assigned, home_base_city, home_base_state, created_at, updated_at')
      .order('created_at', { ascending: true })
      .limit(500)
    : s.sbAdmin
      .from('portal_profiles')
      .select('user_id, role, full_name, created_at')
      .order('created_at', { ascending: true })
      .limit(500);

  if (!canListFull) {
    // Limited directory: only return people relevant for scheduling.
    query = query.in('role', ['closer', 'account_manager', 'manager', 'event_coordinator']);
  }

  const { data: profiles, error } = await query;

  if (error) return sendJson(res, 500, { ok: false, error: 'profiles_query_failed' });

  let byId = new Map();
  if (canListFull) {
    const listed = await s.sbAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
    byId = new Map((listed?.data?.users || []).map((u) => [u.id, u]));
  }

  const users = (profiles || []).map((p) => {
    const u = byId.get(p.user_id);
    return {
      userId: p.user_id,
      role: p.role,
      fullName: p.full_name || '',
      email: canListFull ? (u?.email || '') : '',
      createdAt: p.created_at,
      employmentStatus: p.employment_status || '',
      readinessStatus: p.readiness_status || '',
      teamCode: p.team_code || '',
      managerUserId: p.manager_user_id || '',
      canBeAssigned: p.can_be_assigned != null ? Boolean(p.can_be_assigned) : true,
      homeBaseCity: p.home_base_city || '',
      homeBaseState: p.home_base_state || '',
      updatedAt: p.updated_at || p.created_at,
    };
  });

  return sendJson(res, 200, { ok: true, users });
};
