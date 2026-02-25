const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, isManager } = require('../../lib/portalAuth');
const { applyRoleFilter, buildRoleOrParts, roleMatchesAny } = require('../../lib/portalRoleAliases');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function canSeeLead({ profile, userId, lead }) {
  if (isManager(profile)) return true;
  const role = String(profile?.role || '');
  return (
    (lead.assigned_user_id && lead.assigned_user_id === userId) ||
    (lead.created_by && lead.created_by === userId) ||
    (role && lead.assigned_role && roleMatchesAny(lead.assigned_role, role))
  );
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const url = new URL(req.url || '/api/portal/leads', 'http://localhost');

  if (req.method === 'GET') {
    const status = cleanStr(url.searchParams.get('status'), 40);
    const assignedRole = cleanStr(url.searchParams.get('assignedRole'), 40);
    const q = cleanStr(url.searchParams.get('q'), 200);
    const state = cleanStr(url.searchParams.get('state'), 40);
    const city = cleanStr(url.searchParams.get('city'), 80);
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 100);

    let query = s.sbAdmin
      .from('portal_leads')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);
    if (assignedRole) query = applyRoleFilter(query, 'assigned_role', assignedRole);
    if (state) query = query.eq('state', state);
    if (city) query = query.ilike('city', `%${city}%`);

    if (!isManager(s.profile)) {
      const role = String(s.profile.role || '');
      const uid = String(s.effectiveUserId || s.user.id || '');

      // View-as role without a specific user: constrain to the role.
      if (s.viewAsRole && role && !s.effectiveUserId) {
        query = applyRoleFilter(query, 'assigned_role', role);
      } else {
        const parts = [
          `assigned_user_id.eq.${uid}`,
          `created_by.eq.${uid}`,
        ];
        if (role) parts.push(...buildRoleOrParts('assigned_role', role));
        query = query.or(parts.join(','));
      }
    }

    if (q) {
      const qEsc = q.replace(/,/g, ' ');
      query = query.or([
        `first_name.ilike.%${qEsc}%`,
        `last_name.ilike.%${qEsc}%`,
        `company.ilike.%${qEsc}%`,
        `property_name.ilike.%${qEsc}%`,
        `email.ilike.%${qEsc}%`,
        `phone.ilike.%${qEsc}%`,
      ].join(','));
    }

    const { data, error } = await query;
    if (error) return sendJson(res, 500, { ok: false, error: 'leads_query_failed' });
    return sendJson(res, 200, { ok: true, leads: Array.isArray(data) ? data : [] });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const lead = {
      created_by: s.user.id,
      assigned_role: cleanStr(body.assignedRole || s.profile.role || 'dialer', 40),
      assigned_user_id: cleanStr(body.assignedUserId, 60) || null,
      source: cleanStr(body.source, 80),
      status: cleanStr(body.status || 'new', 40),
      priority: clampInt(body.priority, -5, 5, 0),

      first_name: cleanStr(body.firstName, 80),
      last_name: cleanStr(body.lastName, 80),
      phone: cleanStr(body.phone, 40),
      email: cleanStr(body.email, 200),

      company: cleanStr(body.company, 120),
      property_name: cleanStr(body.propertyName, 160),
      address: cleanStr(body.address, 200),
      city: cleanStr(body.city, 120),
      state: cleanStr(body.state, 20),
      postal_code: cleanStr(body.postalCode, 20),

      notes: cleanStr(body.notes, 5000),
      meta: (body.meta && typeof body.meta === 'object') ? body.meta : {},
    };

    const { data, error } = await s.sbAdmin
      .from('portal_leads')
      .insert(lead)
      .select('*')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'lead_insert_failed' });
    return sendJson(res, 200, { ok: true, lead: Array.isArray(data) ? data[0] : null });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const leadId = clampInt(body.id, 1, 1e12, null);
    if (!leadId) return sendJson(res, 422, { ok: false, error: 'missing_lead_id' });

    const { data: existing, error: e1 } = await s.sbAdmin
      .from('portal_leads')
      .select('*')
      .eq('id', leadId)
      .limit(1);

    if (e1) return sendJson(res, 500, { ok: false, error: 'lead_lookup_failed' });
    const row = Array.isArray(existing) ? existing[0] : null;
    if (!row) return sendJson(res, 404, { ok: false, error: 'lead_not_found' });
    const uid = String(s.effectiveUserId || s.user.id || '');
    if (!canSeeLead({ profile: s.profile, userId: uid, lead: row })) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const patch = {
      assigned_role: body.assignedRole != null ? cleanStr(body.assignedRole, 40) : undefined,
      assigned_user_id: body.assignedUserId != null ? (cleanStr(body.assignedUserId, 60) || null) : undefined,
      status: body.status != null ? cleanStr(body.status, 40) : undefined,
      priority: body.priority != null ? clampInt(body.priority, -5, 5, row.priority || 0) : undefined,

      first_name: body.firstName != null ? cleanStr(body.firstName, 80) : undefined,
      last_name: body.lastName != null ? cleanStr(body.lastName, 80) : undefined,
      phone: body.phone != null ? cleanStr(body.phone, 40) : undefined,
      email: body.email != null ? cleanStr(body.email, 200) : undefined,

      company: body.company != null ? cleanStr(body.company, 120) : undefined,
      property_name: body.propertyName != null ? cleanStr(body.propertyName, 160) : undefined,
      address: body.address != null ? cleanStr(body.address, 200) : undefined,
      city: body.city != null ? cleanStr(body.city, 120) : undefined,
      state: body.state != null ? cleanStr(body.state, 20) : undefined,
      postal_code: body.postalCode != null ? cleanStr(body.postalCode, 20) : undefined,

      notes: body.notes != null ? cleanStr(body.notes, 5000) : undefined,
      meta: body.meta != null ? ((body.meta && typeof body.meta === 'object') ? body.meta : {}) : undefined,
    };

    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined) delete patch[k];
    }

    if (!Object.keys(patch).length) return sendJson(res, 200, { ok: true, lead: row });

    const { data, error } = await s.sbAdmin
      .from('portal_leads')
      .update(patch)
      .eq('id', leadId)
      .select('*')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'lead_update_failed' });
    return sendJson(res, 200, { ok: true, lead: Array.isArray(data) ? data[0] : null });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
