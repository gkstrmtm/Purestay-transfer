const crypto = require('crypto');
const { bearerToken } = require('./vercelApi');

const PREVIEW_TOKEN_PREFIX = 'preview.';
const VIEW_AS_HEADER = 'x-portal-view-as';
const VIEW_AS_USER_HEADER = 'x-portal-view-as-user';
const VIEW_AS_ROLES = new Set([
  'dialer',
  'in_person_setter',
  'remote_setter',
  'closer',
  'account_manager',
  'territory_specialist',
  'event_host',
  'event_coordinator',
  'media_team',
]);

let cachedSupabaseAdmin = null;
let cachedSupabaseAdminKey = '';

function b64urlEncode(input) {
  return Buffer.from(String(input || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function b64urlDecode(input) {
  const raw = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = raw.length % 4 ? '='.repeat(4 - (raw.length % 4)) : '';
  return Buffer.from(raw + pad, 'base64').toString('utf8');
}

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;

  const cacheKey = `${url}\u0001${key}`;
  if (cachedSupabaseAdmin && cachedSupabaseAdminKey === cacheKey) return cachedSupabaseAdmin;

  try {
    // Lazily require so local dev still runs without deps installed.
    // eslint-disable-next-line global-require
    const { createClient } = require('@supabase/supabase-js');
    cachedSupabaseAdmin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    cachedSupabaseAdminKey = cacheKey;
    return cachedSupabaseAdmin;
  } catch {
    cachedSupabaseAdmin = null;
    cachedSupabaseAdminKey = '';
    return null;
  }
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function nonProdRuntime() {
  const vercelEnv = cleanStr(process.env.VERCEL_ENV, 40).toLowerCase();
  const nodeEnv = cleanStr(process.env.NODE_ENV, 40).toLowerCase();
  if (vercelEnv === 'production') return false;
  if (!vercelEnv && nodeEnv === 'production') return false;
  return true;
}

function previewAccessCode() {
  const configured = cleanStr(process.env.PORTAL_PREVIEW_ACCESS_CODE, 200);
  if (configured) return configured;
  // Local safety net: if preview auth is explicitly forced in non-prod,
  // allow a deterministic dev code so env drift does not block testing.
  if (String(process.env.PORTAL_PREVIEW_AUTH_FORCE || '').trim() === '1' && nonProdRuntime()) {
    return 'manager123';
  }
  return '';
}

function previewSessionSecret() {
  const configured = cleanStr(process.env.PORTAL_PREVIEW_SESSION_SECRET || process.env.PORTAL_PREVIEW_ACCESS_CODE, 500);
  if (configured) return configured;
  if (String(process.env.PORTAL_PREVIEW_AUTH_FORCE || '').trim() === '1' && nonProdRuntime()) {
    return 'manager123-dev-session-secret';
  }
  return '';
}

function previewSessionTtlSeconds() {
  const raw = Number(process.env.PORTAL_PREVIEW_SESSION_TTL_SECONDS || 60 * 60 * 24 * 14);
  if (!Number.isFinite(raw)) return 60 * 60 * 24 * 14;
  return Math.max(300, Math.trunc(raw));
}

function previewAuthEnabled() {
  if (!previewAccessCode() || !previewSessionSecret()) return false;
  if (String(process.env.PORTAL_PREVIEW_AUTH_FORCE || '').trim() === '1') return true;
  const vercelEnv = cleanStr(process.env.VERCEL_ENV, 40).toLowerCase();
    if (vercelEnv === 'preview' || vercelEnv === 'development') return true;
  const nodeEnv = cleanStr(process.env.NODE_ENV, 40).toLowerCase();
  return !vercelEnv && nodeEnv !== 'production';
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function verifyPreviewAccessCode(code) {
  if (!previewAuthEnabled()) return false;
  return timingSafeEqualText(cleanStr(code, 200), previewAccessCode());
}

function previewTokenLike(token) {
  return String(token || '').startsWith(PREVIEW_TOKEN_PREFIX);
}

function signPreviewPayload(payload) {
  return crypto
    .createHmac('sha256', previewSessionSecret())
    .update(String(payload || ''))
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createPreviewToken(payload) {
  const encoded = b64urlEncode(JSON.stringify(payload || {}));
  const signature = signPreviewPayload(encoded);
  return `${PREVIEW_TOKEN_PREFIX}${encoded}.${signature}`;
}

function verifyPreviewToken(token) {
  const raw = String(token || '').trim();
  if (!previewTokenLike(raw)) return { ok: false, error: 'not_preview_token' };
  if (!previewAuthEnabled()) return { ok: false, error: 'preview_auth_disabled' };

  const body = raw.slice(PREVIEW_TOKEN_PREFIX.length);
  const dot = body.lastIndexOf('.');
  if (dot <= 0) return { ok: false, error: 'invalid_preview_token' };

  const encoded = body.slice(0, dot);
  const signature = body.slice(dot + 1);
  if (!timingSafeEqualText(signature, signPreviewPayload(encoded))) {
    return { ok: false, error: 'invalid_preview_token' };
  }

  try {
    const payload = JSON.parse(b64urlDecode(encoded));
    const userId = cleanStr(payload?.userId, 80);
    const exp = Number(payload?.exp || 0);
    if (!userId || !Number.isFinite(exp)) return { ok: false, error: 'invalid_preview_token' };
    if (exp <= Math.floor(Date.now() / 1000)) return { ok: false, error: 'preview_session_expired' };
    return { ok: true, payload };
  } catch {
    return { ok: false, error: 'invalid_preview_token' };
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

async function resolvePreviewManagerProfile(sbAdmin, requestedUserId) {
  const explicitUserId = cleanStr(requestedUserId || process.env.PORTAL_PREVIEW_MANAGER_USER_ID, 80);
  if (explicitUserId) {
    const prof = await getProfile(sbAdmin, explicitUserId);
    if (prof.ok && isManager(prof.profile)) return { ok: true, profile: prof.profile };
    // If explicit preview manager config is stale, gracefully fall back.
    // This avoids hard lockout in local preview auth.
  }

  const { data, error } = await sbAdmin
    .from('portal_profiles')
    .select('user_id, role, full_name, created_at')
    .eq('role', 'manager')
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) return { ok: false, error: 'profile_lookup_failed' };
  const row = Array.isArray(data) ? data[0] : null;
  if (!row?.user_id) return { ok: false, error: 'preview_manager_missing' };
  return { ok: true, profile: row };
}

async function getAuthUserById(sbAdmin, userId) {
  const id = cleanStr(userId, 80);
  if (!id) return null;
  try {
    const result = await sbAdmin.auth.admin.getUserById(id);
    return result?.data?.user || null;
  } catch {
    return null;
  }
}

async function createPreviewSession(sbAdmin, options = {}) {
  if (!previewAuthEnabled()) return { ok: false, error: 'preview_auth_disabled', status: 403 };

  const resolved = await resolvePreviewManagerProfile(sbAdmin, options.userId);
  if (!resolved.ok) {
    const status = resolved.error === 'preview_manager_missing' ? 503 : 403;
    return { ok: false, error: resolved.error, status };
  }

  const profile = resolved.profile;
  const authUser = await getAuthUserById(sbAdmin, profile.user_id);
  const expiresIn = previewSessionTtlSeconds();
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  const token = createPreviewToken({
    v: 1,
    mode: 'preview',
    userId: profile.user_id,
    exp: expiresAt,
  });

  return {
    ok: true,
    session: {
      access_token: token,
      refresh_token: token,
      expires_at: expiresAt,
      expires_in: expiresIn,
      token_type: 'bearer',
      mode: 'preview',
    },
    user: {
      id: profile.user_id,
      email: String(authUser?.email || '').trim(),
    },
    profile: {
      role: profile.role,
      fullName: profile.full_name || '',
      createdAt: profile.created_at,
    },
  };
}

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
  if (!/^[0-9a-fA-F-]{10,}$/.test(userId)) return '';
  return userId;
}

async function getKvValue(sbAdmin, key) {
  try {
    const { data, error } = await sbAdmin
      .from('purestay_kv')
      .select('value')
      .eq('key', String(key))
      .limit(1);
    if (error) return null;
    const row = Array.isArray(data) ? data[0] : null;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function pickDefaultUserForRole(sbAdmin, role) {
  const r = cleanStr(role, 40);
  if (!r) return { userId: '', role: '' };

  {
    const kv = await getKvValue(sbAdmin, 'portal:demo_user_ids_by_role');
    const map = kv && typeof kv === 'object' ? kv.userIdsByRole : null;
    if (map && typeof map === 'object') {
      const direct = cleanStr(map[r], 80);
      if (direct) return { userId: direct, role: r };
      for (const alias of roleAliases(r)) {
        const id = cleanStr(map[alias], 80);
        if (id) return { userId: id, role: alias };
      }
    }
  }

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

function buildPortalCapabilities(sessionLike = {}) {
  const profile = sessionLike?.profile || {};
  const realProfile = sessionLike?.realProfile || profile;
  const effectiveRole = cleanStr(profile?.role, 40);
  const realRole = cleanStr(realProfile?.role, 40) || effectiveRole;
  const viewAsRole = cleanStr(sessionLike?.viewAsRole, 40);
  const viewAsUserId = cleanStr(sessionLike?.viewAsUserId, 80);
  const effectiveUserId = cleanStr(sessionLike?.effectiveUserId, 80);
  const realIsManager = sessionLike?.realIsManager != null ? Boolean(sessionLike.realIsManager) : realRole === 'manager';
  const viewAsActive = Boolean(viewAsRole || viewAsUserId || effectiveUserId || sessionLike?.impersonating);
  const viewAsPreviewOnly = Boolean(viewAsRole) && !viewAsUserId;
  const canManagePeople = realIsManager && !viewAsActive;

  return {
    realRole,
    effectiveRole,
    viewAsActive,
    viewAsPreviewOnly,
    canAccessPeopleWorkspace: ['manager', 'event_coordinator', 'account_manager'].includes(effectiveRole),
    canViewPeopleDirectoryData: realIsManager || ['event_coordinator', 'account_manager'].includes(realRole),
    canManagePeople,
    canAssignPeopleManagers: canManagePeople,
    canManageUsers: realIsManager && !viewAsActive,
    canManageUserAccess: realIsManager && !viewAsActive,
    canManageAdmin: realIsManager && !viewAsActive,
    canAccessManagerWorkspace: ['manager', 'event_coordinator'].includes(effectiveRole),
    canAccessManagerRoster: realIsManager && !viewAsActive,
    canAccessManagerAdmin: realIsManager && !viewAsActive,
    canCoordinateOperations: ['manager', 'event_coordinator'].includes(effectiveRole),
    canCreateFoundationTasks: ['manager', 'event_coordinator', 'account_manager'].includes(effectiveRole) && !viewAsPreviewOnly,
    canManageAccounts: ['manager', 'account_manager'].includes(effectiveRole),
  };
}

async function getPreviewIdentityFromReq(sbAdmin, req) {
  const token = bearerToken(req);
  if (!previewTokenLike(token)) return { ok: false, handled: false };

  const verified = verifyPreviewToken(token);
  if (!verified.ok) return { ok: false, handled: true, error: verified.error, status: 401 };

  const resolved = await resolvePreviewManagerProfile(sbAdmin, verified.payload.userId);
  if (!resolved.ok) {
    const status = resolved.error === 'preview_manager_missing' ? 503 : 403;
    return { ok: false, handled: true, error: resolved.error, status };
  }

  const profile = resolved.profile;
  const authUser = await getAuthUserById(sbAdmin, profile.user_id);
  return {
    ok: true,
    handled: true,
    token,
    user: {
      id: profile.user_id,
      email: String(authUser?.email || '').trim(),
    },
    profile,
    sessionMode: 'preview',
    previewAccess: true,
  };
}

async function getPortalIdentityFromReq(sbAdmin, req) {
  const preview = await getPreviewIdentityFromReq(sbAdmin, req);
  if (preview.ok || preview.handled) return preview;

  const u = await getUserFromReq(sbAdmin, req);
  if (!u.ok) return { ok: false, error: u.error, status: 401 };

  const p = await getProfile(sbAdmin, u.user.id);
  if (!p.ok) return { ok: false, error: p.error, status: 403 };

  return {
    ok: true,
    token: u.token,
    user: u.user,
    profile: p.profile,
    sessionMode: 'supabase',
    previewAccess: false,
  };
}

async function requirePortalSession(req) {
  const sbAdmin = supabaseAdmin();
  if (!sbAdmin) return { ok: false, error: 'missing_supabase_service_role', status: 503 };

  const identity = await getPortalIdentityFromReq(sbAdmin, req);
  if (!identity.ok) return { ok: false, error: identity.error, status: identity.status || 401 };

  const realProfile = identity.profile;
  const realIsManager = isManager(realProfile);
  let profile = realProfile;

  const viewAsRole = realIsManager ? viewAsRoleFromReq(req) : '';
  let viewAsUserId = '';
  let effectiveUserId = '';
  let impersonating = false;
  if (viewAsRole) {
    profile = Object.assign({}, realProfile, { role: viewAsRole });

    viewAsUserId = viewAsUserFromReq(req);
    if (viewAsUserId) {
      const theirRole = await roleForUserId(sbAdmin, viewAsUserId);
      if (!roleAliases(viewAsRole).includes(theirRole)) {
        viewAsUserId = '';
      } else {
        profile = Object.assign({}, realProfile, { role: theirRole });
      }
    }

    if (viewAsUserId) {
      effectiveUserId = viewAsUserId;
      impersonating = true;
    } else {
      const picked = await pickDefaultUserForRole(sbAdmin, viewAsRole);
      effectiveUserId = String(picked.userId || '').trim();
      impersonating = !!effectiveUserId;
      profile = Object.assign({}, realProfile, { role: viewAsRole });
    }
  }

  const actorUserId = String(effectiveUserId || identity.user.id || '');
  const capabilities = buildPortalCapabilities({
    profile,
    realProfile,
    viewAsRole,
    viewAsUserId,
    effectiveUserId,
    impersonating,
    realIsManager,
  });

  return {
    ok: true,
    sbAdmin,
    token: identity.token,
    user: identity.user,
    realActorUserId: String(identity.user.id || ''),
    actorUserId,
    profile,
    realProfile,
    viewAsRole,
    viewAsUserId,
    effectiveUserId,
    impersonating,
    realIsManager,
    capabilities,
    sessionMode: identity.sessionMode || 'supabase',
    previewAccess: !!identity.previewAccess,
  };
}

module.exports = {
  createPreviewSession,
  supabaseAdmin,
  requirePortalSession,
  isManager,
  hasRole,
  buildPortalCapabilities,
  previewAuthEnabled,
  verifyPreviewAccessCode,
  verifyPreviewToken,
  viewAsRoleFromReq,
  viewAsUserFromReq,
  roleAliases,
};
