function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function stripDashes(s) {
  return String(s || '').replace(/[\u2014\u2013]/g, '-');
}

function stripDashesDeep(obj) {
  if (obj == null) return obj;
  if (typeof obj === 'string') return stripDashes(obj);
  if (Array.isArray(obj)) return obj.map(stripDashesDeep);
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = stripDashesDeep(obj[k]);
    return out;
  }
  return obj;
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
        temperature: 0.4,
        max_tokens: 900,
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
    return { ok: true, data: stripDashesDeep(obj) };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'ai_timeout' : 'ai_network_error' };
  } finally {
    clearTimeout(t);
  }
}

function getAiConfig() {
  const apiKey = process.env.AI_API_KEY || '';
  if (!apiKey) return { ok: false, error: 'missing_ai_api_key' };

  const baseUrl = process.env.AI_API_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const timeoutMs = clampInt(process.env.AI_TIMEOUT_MS, 5_000, 60_000, 45_000);

  return { ok: true, apiKey, baseUrl, model, timeoutMs };
}

function leadContext(lead) {
  const pick = (k) => String(lead?.[k] || '').trim();
  return {
    name: [pick('first_name'), pick('last_name')].filter(Boolean).join(' ').trim(),
    phone: pick('phone'),
    email: pick('email'),
    company: pick('company'),
    propertyName: pick('property_name'),
    city: pick('city'),
    state: pick('state'),
    source: pick('source'),
    notes: pick('notes'),
  };
}

async function generateFollowup({ lead, outcome, notes }) {
  const cfg = getAiConfig();
  if (!cfg.ok) return cfg;

  const ctx = leadContext(lead);
  const system = [
    'You write concise sales follow-ups for PureStay (resident retention experiences for apartment communities).',
    'No em dashes (—) or en dashes (–). Use commas or hyphens.',
    'Output MUST be valid JSON only.',
  ].join('\n');

  const user = [
    'Create a personalized follow-up based on this lead and call outcome.',
    `Lead: ${JSON.stringify(ctx)}`,
    `Outcome: ${String(outcome || '').trim()}`,
    `Dialer notes: ${String(notes || '').trim()}`,
    'Return JSON with schema:',
    '{"emailSubject": string, "emailBody": string, "sms": string, "nextStep": string}',
    'Keep the SMS under 320 characters.',
  ].join('\n');

  return callOpenAIChat({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
}

async function generateResearch({ lead }) {
  const cfg = getAiConfig();
  if (!cfg.ok) return cfg;

  const ctx = leadContext(lead);
  const system = [
    'You are a closer assistant for PureStay.',
    'Given lead context, produce call prep that is specific and practical.',
    'No em dashes (—) or en dashes (–).',
    'Output MUST be valid JSON only.',
  ].join('\n');

  const user = [
    'Create a short research and call prep brief.',
    `Lead: ${JSON.stringify(ctx)}`,
    'Return JSON with schema:',
    '{"summary": string, "talkingPoints": string[], "likelyObjections": string[], "nextSteps": string[]}',
    'Avoid making up facts about the company; if unknown, say what to ask.',
  ].join('\n');

  return callOpenAIChat({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
}

function eventContext(ev) {
  const meta = ev?.meta && typeof ev.meta === 'object' ? ev.meta : {};
  const plan = meta?.plan && typeof meta.plan === 'object' ? meta.plan : {};
  const budget = meta?.budget && typeof meta.budget === 'object' ? meta.budget : {};
  const property = meta?.property && typeof meta.property === 'object' ? meta.property : {};

  return {
    id: ev?.id,
    title: String(ev?.title || '').trim(),
    eventDate: String(ev?.event_date || '').trim(),
    city: String(ev?.city || '').trim(),
    state: String(ev?.state || '').trim(),
    address: String(ev?.address || '').trim(),
    notes: String(ev?.notes || '').trim(),
    propertyName: String(property?.name || '').trim(),
    propertyAddress: String(property?.address || '').trim(),
    plan: {
      strategy: String(plan?.strategy || '').trim(),
      eventType: String(plan?.eventType || '').trim(),
      justification: String(plan?.justification || '').trim(),
    },
    budget: {
      hostPayCents: Number(budget?.hostPayCents || 0) || 0,
      mediaPayCents: Number(budget?.mediaPayCents || 0) || 0,
      foodCents: Number(budget?.foodCents || 0) || 0,
      decorCents: Number(budget?.decorCents || 0) || 0,
      suppliesCents: Number(budget?.suppliesCents || 0) || 0,
      contingencyCents: Number(budget?.contingencyCents || 0) || 0,
    },
  };
}

async function generateVendorSuggestions({ event, vendors }) {
  const cfg = getAiConfig();
  if (!cfg.ok) return cfg;

  const ctx = eventContext(event);
  const pool = Array.isArray(vendors) ? vendors : [];

  const system = [
    'You are the Event Coordinator AI for PureStay.',
    'You MUST pick vendors ONLY from the provided candidate list by index.',
    'Do NOT invent vendors, addresses, prices, categories, or availability.',
    'No em dashes (—) or en dashes (–). Use commas or hyphens.',
    'Output MUST be valid JSON only.',
  ].join('\n');

  const user = [
    'Choose the best-fit vendors for this event. Favor location match (same city/state), relevant specialization, and operational simplicity.',
    `Event: ${JSON.stringify(ctx)}`,
    `Vendor candidates (array indices matter): ${JSON.stringify(pool)}`,
    'Return JSON with schema:',
    '{"suggestions": [{"idx": number, "reason": string}], "searchQuery": string, "missingInfo": string[]}',
    'Rules:',
    '- suggestions: 3 to 8 items',
    '- idx must be a valid index into the candidates array',
    '- reason must be short and specific to the event context',
    '- searchQuery: a short query the coordinator could use to find more options',
    '- missingInfo: questions to ask if you cannot decide confidently',
  ].join('\n');

  return callOpenAIChat({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
}

async function generateTalentRecommendations({ event, talent }) {
  const cfg = getAiConfig();
  if (!cfg.ok) return cfg;

  const ctx = eventContext(event);
  const pool = Array.isArray(talent) ? talent : [];

  const system = [
    'You are the Event Coordinator AI for PureStay.',
    'You MUST recommend talent ONLY from the provided candidates by userId.',
    'Do NOT invent credentials, licensing, or gear.',
    'No em dashes (—) or en dashes (–). Use commas or hyphens.',
    'Output MUST be valid JSON only.',
  ].join('\n');

  const user = [
    'Recommend the best host(s) and media team member(s) for this event based on location, specialties, and reliability.',
    `Event: ${JSON.stringify(ctx)}`,
    `Talent candidates: ${JSON.stringify(pool)}`,
    'Return JSON with schema:',
    '{"hosts": [{"userId": string, "reason": string}], "media": [{"userId": string, "reason": string}], "missingInfo": string[]}',
    'Rules:',
    '- hosts and media each 1 to 5 items',
    '- userId must exist in the provided candidates',
    '- reason must be short and specific to event context',
  ].join('\n');

  return callOpenAIChat({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
}

module.exports = {
  generateFollowup,
  generateResearch,
  generateVendorSuggestions,
  generateTalentRecommendations,
};
