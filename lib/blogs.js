const { getJson, setJson } = require('./storage');

const INDEX_KEY = 'purestay:blogs:v1:index';
const STATE_KEY = 'purestay:blogs:v1:state';
const POST_KEY_PREFIX = 'purestay:blogs:v1:post:';

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function slugify(input) {
  const s = String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'post';
}

function stripDangerousTags(html) {
  const s = String(html || '');
  // Strip script/iframe/object/embed tags very defensively.
  return s
    .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*iframe[^>]*>[\s\S]*?<\s*\/\s*iframe\s*>/gi, '')
    .replace(/<\s*(object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(object|embed)\b[^>]*\/?>/gi, '');
}

function addDays(date, days) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return new Date();
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d;
}

function isoDateOnly(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

async function getState() {
  return getJson(STATE_KEY, {
    sequence: 0,
    lastGeneratedAt: '',
    backfill: {
      cursor: '',
      years: 2,
      stepDays: 3,
      done: false,
    },
  });
}

async function setState(next) {
  return setJson(STATE_KEY, next);
}

async function getIndex() {
  const idx = await getJson(INDEX_KEY, []);
  return Array.isArray(idx) ? idx : [];
}

async function setIndex(slugs) {
  const safe = Array.isArray(slugs) ? slugs.filter((s) => typeof s === 'string' && s) : [];
  return setJson(INDEX_KEY, safe.slice(0, 2000));
}

async function getPost(slug) {
  const s = String(slug || '').trim();
  if (!s) return null;
  return getJson(POST_KEY_PREFIX + s, null);
}

async function putPost(post) {
  const slug = String(post?.slug || '').trim();
  if (!slug) return false;
  const next = {
    ...post,
    slug,
    html: stripDangerousTags(post?.html || ''),
  };
  const stored = await setJson(POST_KEY_PREFIX + slug, next);
  if (!stored) return false;

  // Update index ordered by publishedAt desc.
  const index = await getIndex();
  const without = index.filter((s) => s !== slug);
  const publishedAt = String(next.publishedAt || next.createdAt || '').trim();
  const items = [];
  items.push({ slug, publishedAt });

  // Pull a small set of existing posts to sort properly.
  // (Avoids reading everything; we'll rehydrate up to 300 posts.)
  const rehydrate = without.slice(0, 300);
  for (const s of rehydrate) {
    const p = await getPost(s);
    if (p && p.slug) items.push({ slug: p.slug, publishedAt: String(p.publishedAt || p.createdAt || '') });
  }

  items.sort((a, b) => {
    const at = new Date(a.publishedAt || 0).getTime();
    const bt = new Date(b.publishedAt || 0).getTime();
    return bt - at;
  });

  const nextIndex = items.map((it) => it.slug).filter(Boolean);
  // Append the rest in original order.
  for (const s of without.slice(300)) nextIndex.push(s);
  const indexed = await setIndex(nextIndex);
  return Boolean(indexed);
}

async function listPosts({ limit = 50, offset = 0 } = {}) {
  const lim = clampInt(limit, 1, 200, 50);
  const off = clampInt(offset, 0, 5000, 0);

  const index = await getIndex();
  const slice = index.slice(off, off + lim);
  const posts = [];
  for (const slug of slice) {
    // eslint-disable-next-line no-await-in-loop
    const p = await getPost(slug);
    if (p && p.slug) {
      posts.push({
        slug: p.slug,
        title: p.title || '',
        excerpt: p.excerpt || '',
        metaDescription: p.metaDescription || '',
        publishedAt: p.publishedAt || '',
        tags: Array.isArray(p.tags) ? p.tags : [],
      });
    }
  }
  return { total: index.length, posts };
}

function getSiteUrl(req) {
  const envUrl = process.env.SITE_URL || process.env.PUBLIC_SITE_URL || '';
  if (envUrl) return String(envUrl).replace(/\/$/, '');
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host || 'purestaync.com';
  const proto = req?.headers?.['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`.replace(/\/$/, '');
}

function computeBackfillStart(years) {
  const y = Math.max(1, Math.min(10, Number(years || 2)));
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.round(365 * y));
  // Normalize to noon UTC to reduce DST issues.
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

module.exports = {
  INDEX_KEY,
  STATE_KEY,
  slugify,
  addDays,
  isoDateOnly,
  getState,
  setState,
  getPost,
  putPost,
  listPosts,
  getSiteUrl,
  computeBackfillStart,
};
