const { sendJson, handleCors } = require('../lib/vercelApi');
const { hasKvEnv, hasSupabaseEnv, hasStorageEnv } = require('../lib/storage');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  return sendJson(res, 200, {
    ok: true,
    now: new Date().toISOString(),
    storage: {
      enabled: hasStorageEnv(),
      supabase: hasSupabaseEnv(),
      kv: hasKvEnv(),
    },
  });
};
