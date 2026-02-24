const { sendJson, handleCors } = require('../../lib/vercelApi');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const supabaseAnonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();

  if (!supabaseUrl || !supabaseAnonKey) {
    return sendJson(res, 503, {
      ok: false,
      error: 'missing_portal_env',
      missing: {
        SUPABASE_URL: !supabaseUrl,
        SUPABASE_ANON_KEY: !supabaseAnonKey,
      },
    });
  }

  return sendJson(res, 200, {
    ok: true,
    supabaseUrl,
    supabaseAnonKey,
  });
};
