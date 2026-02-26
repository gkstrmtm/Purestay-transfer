const { sendJson, handleCors, bearerToken } = require('../lib/vercelApi');
const { hasKvEnv, hasSupabaseEnv, hasStorageEnv } = require('../lib/storage');
const { supabaseAdmin } = require('../lib/portalAuth');

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function isAdmin(req) {
  const adminToken = process.env.ADMIN_TOKEN || '';
  if (!adminToken) return false;
  const url = new URL(req.url || '/api/health', 'http://localhost');
  const token = bearerToken(req) || cleanStr(url.searchParams.get('token'), 300);
  return token && token === adminToken;
}

async function probeSupabase() {
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, error: 'missing_supabase_service_role' };
  try {
    const t0 = Date.now();
    const { error } = await sb.from('purestay_kv').select('key').limit(1);
    const ms = Date.now() - t0;
    if (error) return { ok: false, error: 'supabase_query_failed', ms };
    return { ok: true, ms };
  } catch {
    return { ok: false, error: 'supabase_exception' };
  }
}

async function probeKv() {
  try {
    // eslint-disable-next-line global-require
    const { kv } = require('@vercel/kv');
    if (!kv) return { ok: false, error: 'kv_client_missing' };
    const t0 = Date.now();
    await kv.ping();
    const ms = Date.now() - t0;
    return { ok: true, ms };
  } catch {
    return { ok: false, error: 'kv_unavailable' };
  }
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const url = new URL(req.url || '/api/health', 'http://localhost');
  const wantDetails = cleanStr(url.searchParams.get('details'), 10) === '1';
  const allowDetails = wantDetails && isAdmin(req);

  const base = {
    ok: true,
    now: new Date().toISOString(),
    storage: {
      enabled: hasStorageEnv(),
      supabase: hasSupabaseEnv(),
      kv: hasKvEnv(),
    },

    // Minimal diagnostics; detailed probes require ADMIN_TOKEN.
    diagnostics: allowDetails ? {
      supabase: hasSupabaseEnv() ? await probeSupabase() : { ok: false, error: 'not_configured' },
      kv: hasKvEnv() ? await probeKv() : { ok: false, error: 'not_configured' },
      note: 'Pass ?details=1&token=ADMIN_TOKEN for probes.',
    } : undefined,
  };

  if (!allowDetails) delete base.diagnostics;
  return sendJson(res, 200, base);
};
