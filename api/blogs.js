const { sendJson, handleCors } = require('../lib/vercelApi');
const { listPosts } = require('../lib/blogs');
const { hasKvEnv } = require('../lib/storage');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const url = new URL(req.url || '/', 'http://localhost');
  const limit = url.searchParams.get('limit');
  const offset = url.searchParams.get('offset');

  if (hasKvEnv()) {
    const data = await listPosts({ limit, offset });
    return sendJson(res, 200, { ok: true, mode: 'kv', ...data });
  }

  return sendJson(res, 200, { ok: true, mode: 'disabled', reason: 'kv_required', total: 0, posts: [] });
};
