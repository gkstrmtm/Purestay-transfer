const { sendJson, handleCors, bearerToken, readJson } = require('../../lib/vercelApi');
const { supabaseAdmin } = require('../../lib/portalAuth');

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

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const seedToken = process.env.PORTAL_SEED_TOKEN || '';
  if (!seedToken) return sendJson(res, 503, { ok: false, error: 'missing_portal_seed_token' });

  const token = bearerToken(req);
  if (token !== seedToken) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  const sb = supabaseAdmin();
  if (!sb) return sendJson(res, 503, { ok: false, error: 'missing_supabase_service_role' });

  const body = await readJson(req);
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
      results.push({ role, email, ok: false, error: 'profile_upsert_failed' });
      continue;
    }

    results.push({ role, email, ok: true, userId });
  }

  return sendJson(res, 200, {
    ok: true,
    domain,
    passwordHint: 'Use the password you supplied to this endpoint.',
    users: results,
  });
};
