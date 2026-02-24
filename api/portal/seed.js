const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { supabaseAdmin, requirePortalSession, isManager } = require('../../lib/portalAuth');

const DEFAULT_ROLES = [
  'dialer',
  'in_person_setter',
  'remote_setter',
  'closer',
  'event_host',
  'account_manager',
  'event_coordinator',
  'media_team',
  'manager',
];

function titleCase(s) {
  return String(s || '')
    .split(/[_\-\s]+/g)
    .filter(Boolean)
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
    .join(' ');
}

async function assertServiceRole(sb) {
  try {
    const r = await sb.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (r?.error) return { ok: false, error: 'invalid_supabase_service_role', detail: r.error.message || '' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'invalid_supabase_service_role', detail: String(e?.message || e || '') };
  }
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const sb = supabaseAdmin();
  if (!sb) return sendJson(res, 503, { ok: false, error: 'missing_supabase_service_role' });

  const svc = await assertServiceRole(sb);
  if (!svc.ok) return sendJson(res, 503, { ok: false, error: svc.error, detail: svc.detail });

  // Bootstrap mode: allow seeding only if no profiles exist yet.
  // Otherwise require a manager session.
  const { count, error: cErr } = await sb
    .from('portal_profiles')
    .select('user_id', { count: 'exact', head: true });
  if (cErr) return sendJson(res, 500, { ok: false, error: 'seed_bootstrap_check_failed' });

  const bootstrap = Number(count || 0) === 0;

  const body = await readJson(req);

  if (!bootstrap) {
    // Prefer bearer-token auth.
    const s = await requirePortalSession(req);
    if (s.ok) {
      if (!isManager(s.profile)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    } else {
      // Fallback: allow reseed if the request includes manager credentials.
      const email = String(body?.email || '').trim().toLowerCase();
      const password = String(body?.password || '').trim();
      if (!email || !password) return sendJson(res, 401, { ok: false, error: 'missing_bearer_token' });

      const login = await sb.auth.signInWithPassword({ email, password });
      const user = login?.data?.user || null;
      if (login?.error || !user) return sendJson(res, 401, { ok: false, error: 'invalid_login' });

      const localPart = String(email.split('@')[0] || '').toLowerCase();
      const metaRole = user?.user_metadata?.role;
      const isMgr = String(metaRole || '').toLowerCase() === 'manager' || localPart === 'manager';
      if (!isMgr) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }
  }
  const password = String(body?.password || process.env.PORTAL_DEMO_PASSWORD || 'PurestayDemo!234');
  const domain = String(body?.domain || 'demo.purestaync.com');
  const roles = Array.isArray(body?.roles) ? body.roles : DEFAULT_ROLES;

  const results = [];

  for (const roleRaw of roles) {
    const role = String(roleRaw || '').trim();
    if (!role) continue;

    const localPart = role.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
    const email = `${localPart}@${domain}`;

    // Create or fetch
    const created = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role },
    });

    let userId = created?.data?.user?.id || '';

    if (!userId) {
      // If already exists, look it up
      const listed = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
      const found = (listed?.data?.users || []).find((u) => String(u.email || '').toLowerCase() === email.toLowerCase());
      userId = found?.id || '';
    }

    if (!userId) {
      results.push({ role, email, ok: false, error: created?.error?.message || 'create_user_failed' });
      continue;
    }

    const fullName = titleCase(role);

    const { error: upsertErr } = await sb
      .from('portal_profiles')
      .upsert({ user_id: userId, role, full_name: fullName }, { onConflict: 'user_id' });

    if (upsertErr) {
      results.push({ role, email, ok: false, error: 'profile_upsert_failed', detail: upsertErr.message || '' });
      continue;
    }

    results.push({ role, email, ok: true, userId });
  }

  const ok = results.every((x) => x && x.ok);

  return sendJson(res, 200, {
    ok,
    bootstrap,
    domain,
    passwordHint: 'Use the password you supplied to this endpoint.',
    users: results,
  });
};
