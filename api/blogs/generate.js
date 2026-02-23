const { sendJson, handleCors, bearerToken, readJson } = require('../../lib/vercelApi');
const { getState, setState, getPost, putPost, getSiteUrl } = require('../../lib/blogs');
const { generateBlogPost } = require('../../lib/aiBlog');

function minutesFromWordCount(html) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;
  return { words, minutes: Math.max(3, Math.round(words / 220)) };
}

function nowIso() {
  return new Date().toISOString();
}

async function requireAdminIfConfigured(req) {
  const adminToken = process.env.ADMIN_TOKEN || '';
  if (!adminToken) return { ok: true, warning: 'unprotected' };

  const token = bearerToken(req) || (req.url ? new URL(req.url, 'http://localhost').searchParams.get('token') : '') || '';
  if (token !== adminToken) return { ok: false };
  return { ok: true };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const auth = await requireAdminIfConfigured(req);
  if (!auth.ok) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  const payload = await readJson(req);
  const publishedAt = String(payload?.publishedAt || '').trim() || nowIso();

  const state = await getState();
  const siteUrl = getSiteUrl(req);

  const gen = await generateBlogPost({
    sequence: Number(state.sequence || 0),
    publishedAt,
    siteUrl,
  });

  if (!gen.ok) return sendJson(res, 503, { ok: false, error: gen.error || 'ai_failed' });

  const baseSlug = gen.data.slug;
  let slug = baseSlug;
  // ensure uniqueness
  for (let i = 2; i <= 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await getPost(slug);
    if (!existing) break;
    slug = `${baseSlug}-${i}`;
  }

  const wc = minutesFromWordCount(gen.data.html);

  const post = {
    id: `ps_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    title: gen.data.title,
    slug,
    topic: gen.data.topic,
    metaDescription: gen.data.metaDescription,
    excerpt: gen.data.excerpt,
    primaryKeyword: gen.data.primaryKeyword,
    keywords: gen.data.keywords,
    tags: gen.data.tags,
    html: gen.data.html,
    faq: gen.data.faq,
    wordCount: wc.words,
    readingMinutes: wc.minutes,
    createdAt: nowIso(),
    publishedAt: new Date(publishedAt).toISOString(),
    updatedAt: nowIso(),
  };

  const ok = await putPost(post);
  if (!ok) return sendJson(res, 503, { ok: false, error: 'storage_unavailable' });

  await setState({
    ...state,
    sequence: Number(state.sequence || 0) + 1,
    lastGeneratedAt: nowIso(),
  });

  return sendJson(res, 200, { ok: true, post, ...(auth.warning ? { warning: auth.warning } : {}) });
};
