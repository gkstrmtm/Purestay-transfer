const { bearerToken } = require('./vercelApi');

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;

  try {
    // Lazily require so local dev still runs without deps installed.
    // eslint-disable-next-line global-require
    const { createClient } = require('@supabase/supabase-js');
    return createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    return null;
  }
}

async function getUserFromReq(sbAdmin, req) {
  const token = bearerToken(req);
  if (!token) return { ok: false, error: 'missing_bearer_token' };

  const { data, error } = await sbAdmin.auth.getUser(token);
  if (error || !data?.user) return { ok: false, error: 'invalid_token' };
  return { ok: true, token, user: data.user };
}

async function getProfile(sbAdmin, userId) {
  const { data, error } = await sbAdmin
    .from('portal_profiles')
    .select('user_id, role, full_name, created_at')
    .eq('user_id', userId)
    .limit(1);

  if (error) return { ok: false, error: 'profile_lookup_failed' };
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return { ok: false, error: 'profile_missing' };
  return { ok: true, profile: row };
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

const VIEW_AS_HEADER = 'x-portal-view-as';
const VIEW_AS_USER_HEADER = 'x-portal-view-as-user';
const VIEW_AS_ROLES = new Set([
  'dialer',
  'in_person_setter',
  'remote_setter',
  'closer',
  'account_manager',
  'event_host',
  'event_coordinator',
  'media_team',
]);

function roleAliases(role) {
  const r = String(role || '').trim();
  if (!r) return [];
  if (r === 'dialer' || r === 'remote_setter') return ['dialer', 'remote_setter'];
  if (r === 'closer' || r === 'account_manager') return ['closer', 'account_manager'];
  return [r];
}

function viewAsRoleFromReq(req) {
  const h = req?.headers || {};
  const raw = h[VIEW_AS_HEADER] || h[VIEW_AS_HEADER.toLowerCase()] || '';
  const role = cleanStr(raw, 40);
  if (!role) return '';
  if (role === 'manager') return '';
  return VIEW_AS_ROLES.has(role) ? role : '';
}

function viewAsUserFromReq(req) {
  const h = req?.headers || {};
  const raw = h[VIEW_AS_USER_HEADER] || h[VIEW_AS_USER_HEADER.toLowerCase()] || '';
  const userId = cleanStr(raw, 80);
  if (!userId) return '';
  // Very light validation; Supabase will enforce actual uuid type.
  if (!/^[0-9a-fA-F-]{10,}$/.test(userId)) return '';
  return userId;
}

async function pickDefaultUserForRole(sbAdmin, role) {
  const r = cleanStr(role, 40);
  if (!r) return { userId: '', role: '' };

  // Prefer an exact role match so the UI behaves consistently.
  {
    const { data, error } = await sbAdmin
      .from('portal_profiles')
      .select('user_id, role, created_at')
      .eq('role', r)
      .order('created_at', { ascending: true })
      .limit(1);
    if (!error) {
      const row = Array.isArray(data) ? data[0] : null;
      const userId = String(row?.user_id || '').trim();
      if (userId) return { userId, role: String(row?.role || '').trim() };
    }
  }

  // Fallback: pick the earliest user in any related role group.
  const roles = roleAliases(r);
  if (!roles.length) return { userId: '', role: '' };
  const { data, error } = await sbAdmin
    .from('portal_profiles')
    .select('user_id, role, created_at')
    .in('role', roles)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) return { userId: '', role: '' };
  const row = Array.isArray(data) ? data[0] : null;
  const userId = String(row?.user_id || '').trim();
  if (!userId) return { userId: '', role: '' };
  return { userId, role: String(row?.role || '').trim() };
}

async function roleForUserId(sbAdmin, userId) {
  const { data, error } = await sbAdmin
    .from('portal_profiles')
    .select('role')
    .eq('user_id', userId)
    .limit(1);
  if (error) return '';
  const row = Array.isArray(data) ? data[0] : null;
  return String(row?.role || '').trim();
}

function isManager(profile) {
  return String(profile?.role || '') === 'manager';
}

function hasRole(profile, roles) {
  const role = String(profile?.role || '');
  const allowed = Array.isArray(roles) ? roles : [roles];
  return allowed.includes(role) || role === 'manager';
}

async function requirePortalSession(req) {
  const sbAdmin = supabaseAdmin();
  if (!sbAdmin) return { ok: false, error: 'missing_supabase_service_role', status: 503 };

  const u = await getUserFromReq(sbAdmin, req);
  if (!u.ok) return { ok: false, error: u.error, status: 401 };

  const p = await getProfile(sbAdmin, u.user.id);
  if (!p.ok) return { ok: false, error: p.error, status: 403 };

  const realProfile = p.profile;
  const realIsManager = isManager(realProfile);
  let profile = realProfile;

  // Manager-only: allow the UI to request a narrowed view of data.
  const viewAsRole = realIsManager ? viewAsRoleFromReq(req) : '';
  let viewAsUserId = '';
  let effectiveUserId = '';
  let impersonating = false;
  if (viewAsRole) {
    profile = Object.assign({}, realProfile, { role: viewAsRole });

    // Optional: view-as a specific person within the role.
    viewAsUserId = viewAsUserFromReq(req);
    if (viewAsUserId) {
      const theirRole = await roleForUserId(sbAdmin, viewAsUserId);
      if (!roleAliases(viewAsRole).includes(theirRole)) {
        viewAsUserId = '';
      } else {
        // When a specific person is selected, simulate their actual role so
        // role-gated permissions and role-scoped queries match what they see.
        profile = Object.assign({}, realProfile, { role: theirRole });
      }
    }

    // Always impersonate a single concrete user for the selected role.
    // - If the UI provides a user id, use it.
    // - Otherwise, pick a deterministic default demo user.
    if (viewAsUserId) {
      effectiveUserId = viewAsUserId;
      impersonating = true;
    } else {
      const picked = await pickDefaultUserForRole(sbAdmin, viewAsRole);
      effectiveUserId = String(picked.userId || '').trim();
      impersonating = !!effectiveUserId;
      // Keep the UI role the manager selected.
      profile = Object.assign({}, realProfile, { role: viewAsRole });
    }
  }

  const actorUserId = String(effectiveUserId || u.user.id || '');

  return {
    ok: true,
    sbAdmin,
    token: u.token,
    user: u.user,
    actorUserId,
    profile,
    realProfile,
    viewAsRole,
    viewAsUserId,
    effectiveUserId,
    impersonating,
    realIsManager,
  };
}

module.exports = {
  supabaseAdmin,
  requirePortalSession,
  isManager,
  hasRole,
  viewAsRoleFromReq,
  viewAsUserFromReq,
  roleAliases,
};
