const { sendJson, handleCors, bearerToken } = require('../../lib/vercelApi');
const { getState, setState, getSiteUrl, getPost, putPost } = require('../../lib/blogs');
const { generateBlogPost } = require('../../lib/aiBlog');

function nowIso() {
  return new Date().toISOString();
}

function minutesFromWordCount(html) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;
  return { words, minutes: Math.max(3, Math.round(words / 220)) };
}

function hoursSince(iso) {
  const t = new Date(String(iso || '')).getTime();
  if (!t) return Infinity;
  return (Date.now() - t) / (1000 * 60 * 60);
}

async function isAuthorized(req) {
  // If this request was triggered by Vercel Cron, it includes a header.
  const cronHeader = req.headers?.['x-vercel-cron'];
  if (cronHeader) return true;

  const adminToken = process.env.ADMIN_TOKEN || '';
  if (!adminToken) return true;

  const token = bearerToken(req) || (req.url ? new URL(req.url, 'http://localhost').searchParams.get('token') : '') || '';
  return token === adminToken;
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;
  if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const okAuth = await isAuthorized(req);
  if (!okAuth) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  const state = await getState();

  const minDays = Number(process.env.BLOG_AUTOGEN_MIN_DAYS || 2);
  const minHours = Math.max(12, Math.min(168, Math.round(minDays * 24)));
  if (hoursSince(state.lastGeneratedAt) < minHours) {
    return sendJson(res, 200, { ok: true, skipped: true, reason: 'too_soon', lastGeneratedAt: state.lastGeneratedAt });
  }

  const siteUrl = getSiteUrl(req);
  const gen = await generateBlogPost({
    sequence: Number(state.sequence || 0),
    publishedAt: nowIso(),
    siteUrl,
  });

  if (!gen.ok) return sendJson(res, 503, { ok: false, error: gen.error || 'ai_failed' });

  const baseSlug = gen.data.slug;
  let slug = baseSlug;
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
    publishedAt: nowIso(),
    updatedAt: nowIso(),
    automated: true,
  };

  const stored = await putPost(post);
  if (!stored) return sendJson(res, 503, { ok: false, error: 'storage_unavailable' });

  await setState({
    ...state,
    sequence: Number(state.sequence || 0) + 1,
    lastGeneratedAt: nowIso(),
  });

  return sendJson(res, 200, { ok: true, post });
};
