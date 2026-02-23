const { slugify } = require('./blogs');

const TOPICS = [
  'resident retention ideas for apartment communities',
  'apartment resident events that improve renewals',
  'how to increase apartment renewal rates without discounts',
  'multifamily resident experience strategy',
  'resident engagement calendar planning',
  'community-building in multifamily housing',
  'leasing and retention: aligning marketing and on-site experiences',
  'resident appreciation programs that actually work',
  'how to reduce apartment turnover costs',
  'amenity activation ideas for apartment properties',
  'measuring resident satisfaction and sentiment',
  'event ROI for multifamily: what to track',
  'move-in, move-out, and renewal touchpoints that matter',
  'retention marketing content from on-site events',
];

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function pickTopic(sequence, date) {
  const idx = Math.abs(Number(sequence || 0)) % TOPICS.length;
  const base = TOPICS[idx];

  const d = new Date(date || Date.now());
  const month = d.getUTCMonth();
  const seasonal = (
    month === 11 || month === 0 ? 'winter' :
    month >= 2 && month <= 4 ? 'spring' :
    month >= 5 && month <= 7 ? 'summer' :
    'fall'
  );

  return `${base} (${seasonal} playbook)`;
}

function buildPrompt({ topic, publishedAt, siteUrl }) {
  const date = new Date(publishedAt || Date.now());
  const dateStr = Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);

  return {
    system: [
      'You write original SEO blog posts for a company called PureStay.',
      'PureStay provides resident retention experiences for apartment communities: resident events, community engagement, on-site hosting, and reporting. They have three packages: Core Package, Culture Shift, and Signature Stay.',
      'Audience: property managers, regional managers, asset managers, leasing teams (multifamily).',
      'Do NOT copy or paraphrase any specific source. Write fresh, original content.',
      'No fluff, no filler. Make it genuinely useful and specific.',
      'Output MUST be valid JSON only. No markdown, no code fences.',
    ].join('\n'),
    user: [
      `Write one SEO blog post about: ${topic}.`,
      `Publishing date: ${dateStr || 'today'}.`,
      'Requirements:',
      '- Provide an attention-grabbing, keyword-strong title that reads like a real blog.',
      '- Provide a slug in kebab-case (no dates in slug unless needed for uniqueness).',
      '- Provide a meta description (150-160 chars).',
      '- Provide an excerpt (1-2 sentences).',
      '- Provide 7-10 target keywords (array).',
      '- Provide 1 primary keyword (string).',
      '- Provide 2-4 internal links as plain URLs using this site:',
      `  - ${siteUrl}/discovery`,
      `  - ${siteUrl}/core`,
      `  - ${siteUrl}/culture-shift`,
      `  - ${siteUrl}/signature-stay`,
      '- Provide the body as HTML with: h2 sections, short paragraphs, bullets, and 1 call-to-action block linking to /discovery.',
      '- Include a short FAQ section with 4 questions (FAQ items array).',
      '- Include a short conclusion with a next step.',
      '- Keep it ~1100-1700 words.',
      'JSON schema to return:',
      `{
        "title": string,
        "slug": string,
        "metaDescription": string,
        "excerpt": string,
        "primaryKeyword": string,
        "keywords": string[],
        "tags": string[],
        "html": string,
        "faq": [{"q": string, "a": string}]
      }`,
    ].join('\n'),
  };
}

async function callOpenAIChat({ apiKey, baseUrl, model, messages, timeoutMs }) {
  const url = `${String(baseUrl).replace(/\/$/, '')}/chat/completions`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.8,
        messages,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });

    const j = await r.json().catch(() => null);
    if (!r.ok || !j) {
      const msg = j?.error?.message || `ai_request_failed_${r.status}`;
      return { ok: false, error: msg };
    }

    const content = j?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, error: 'ai_empty_response' };
    }

    const obj = safeJsonParse(content);
    if (!obj || typeof obj !== 'object') return { ok: false, error: 'ai_invalid_json' };
    return { ok: true, data: obj };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'ai_timeout' : 'ai_network_error' };
  } finally {
    clearTimeout(t);
  }
}

function normalizeGenerated(obj) {
  const title = String(obj?.title || '').trim();
  const metaDescription = String(obj?.metaDescription || '').trim();
  const excerpt = String(obj?.excerpt || '').trim();
  const primaryKeyword = String(obj?.primaryKeyword || '').trim();
  const keywords = Array.isArray(obj?.keywords) ? obj.keywords.map((k) => String(k || '').trim()).filter(Boolean).slice(0, 20) : [];
  const tags = Array.isArray(obj?.tags) ? obj.tags.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 10) : [];
  const html = String(obj?.html || '').trim();
  const faq = Array.isArray(obj?.faq) ? obj.faq
    .map((it) => ({ q: String(it?.q || '').trim(), a: String(it?.a || '').trim() }))
    .filter((it) => it.q && it.a)
    .slice(0, 10) : [];

  const rawSlug = String(obj?.slug || '').trim();
  const slug = slugify(rawSlug || title);

  return { title, slug, metaDescription, excerpt, primaryKeyword, keywords, tags, html, faq };
}

async function generateBlogPost({ sequence, publishedAt, siteUrl }) {
  const apiKey = process.env.AI_API_KEY || '';
  if (!apiKey) return { ok: false, error: 'missing_ai_api_key' };

  const baseUrl = process.env.AI_API_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const timeoutMs = clampInt(process.env.AI_TIMEOUT_MS, 5_000, 60_000, 45_000);

  const topic = pickTopic(sequence, publishedAt);
  const prompt = buildPrompt({ topic, publishedAt, siteUrl });

  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];

  const r = await callOpenAIChat({ apiKey, baseUrl, model, messages, timeoutMs });
  if (!r.ok) return r;

  const norm = normalizeGenerated(r.data);
  if (!norm.title || !norm.html || !norm.metaDescription) {
    return { ok: false, error: 'ai_missing_fields' };
  }

  return { ok: true, data: { ...norm, topic } };
}

module.exports = {
  generateBlogPost,
};
