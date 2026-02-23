const { sendJson, handleCors } = require('../lib/vercelApi');
const { listPosts } = require('../lib/blogs');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const url = new URL(req.url || '/', 'http://localhost');
  const limit = url.searchParams.get('limit');
  const offset = url.searchParams.get('offset');

  const data = await listPosts({ limit, offset });
  return sendJson(res, 200, { ok: true, ...data });
};
