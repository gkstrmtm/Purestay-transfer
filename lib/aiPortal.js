const fs = require('fs');
const path = require('path');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

const ROOT_DIR = path.resolve(__dirname, '..');
const AI_ENV_KEYS = new Set([
  'AI_API_KEY',
  'AI_API_BASE_URL',
  'AI_PORTAL_MODEL',
  'AI_MODEL',
  'AI_PORTAL_TIMEOUT_MS',
  'AI_TIMEOUT_MS',
  'AI_PORTAL_MAX_TOKENS',
]);

function decodeEnvText(rawBuffer) {
  if (!rawBuffer || !rawBuffer.length) return '';
  let text = rawBuffer.toString('utf8');
  if (text.includes('\u0000')) {
    text = text.replace(/^\u00ff\u00fe/, '').replace(/\u0000/g, '');
  }
  return text.replace(/^\uFEFF/, '');
}

function parseEnvValue(rawValue) {
  const trimmed = String(rawValue || '').trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isHostedVercelRuntime() {
  const hasPlatformRegion = !!String(
    process.env.VERCEL_REGION || process.env.AWS_REGION || process.env.NOW_REGION || ''
  ).trim();
  const vercelUrl = String(process.env.VERCEL_URL || '').trim();
  return hasPlatformRegion || (!!vercelUrl && !/^localhost(?::\d+)?$/i.test(vercelUrl));
}

function refreshLocalAiEnv() {
  if (isHostedVercelRuntime()) return;
  const candidates = [
    '.env',
    '.env.local',
    '.env.development.local',
    '.env.production',
    '.env.prod.local',
    'auth.env',
  ];

  for (const name of candidates) {
    const filePath = path.join(ROOT_DIR, name);
    if (!fs.existsSync(filePath)) continue;
    const text = decodeEnvText(fs.readFileSync(filePath));
    if (!text) continue;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;

      const key = line.slice(0, eqIdx).trim();
      if (!AI_ENV_KEYS.has(key)) continue;

      const parsed = parseEnvValue(line.slice(eqIdx + 1));
      if (!parsed) continue;
      process.env[key] = parsed;
    }
  }
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
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

async function callOpenAIChat({ apiKey, baseUrl, model, messages, timeoutMs, maxTokens }) {
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
        max_tokens: clampInt(maxTokens, 150, 1200, 550),
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
  refreshLocalAiEnv();
  const apiKey = process.env.AI_API_KEY || '';
  if (!apiKey) return { ok: false, error: 'missing_ai_api_key' };

  const baseUrl = process.env.AI_API_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_PORTAL_MODEL || process.env.AI_MODEL || 'gpt-4.1-mini';
  const timeoutMs = clampInt(process.env.AI_PORTAL_TIMEOUT_MS || process.env.AI_TIMEOUT_MS, 5_000, 60_000, 30_000);
  const maxTokens = clampInt(process.env.AI_PORTAL_MAX_TOKENS, 150, 1200, 550);

  return { ok: true, apiKey, baseUrl, model, timeoutMs, maxTokens };
}

function uniqStrings(arr, max) {
  const seen = new Set();
  const out = [];
  for (const item of (Array.isArray(arr) ? arr : [])) {
    const s = cleanStr(item, 160);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (max && out.length >= max) break;
  }
  return out;
}

function normalizeSpace(s) {
  return cleanStr(String(s || '').replace(/\s+/g, ' '), 1200);
}

function toWords(...values) {
  const text = values.map((v) => normalizeSpace(v)).filter(Boolean).join(' ').toLowerCase();
  const raw = text.match(/[a-z0-9]+/g) || [];
  const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'their', 'they', 'have', 'will', 'into', 'about', 'would', 'there', 'what', 'when', 'where', 'which', 'while', 'need', 'needs', 'event', 'events', 'lead', 'community', 'property', 'purestay', 'resident']);
  return uniqStrings(raw.filter((w) => w.length > 2 && !stop.has(w)), 30);
}

function overlapScore(a, b) {
  const aa = new Set(toWords(a));
  const bb = toWords(b);
  let score = 0;
  for (const w of bb) if (aa.has(w)) score += 1;
  return score;
}

function money(cents) {
  const n = Number(cents || 0);
  if (!Number.isFinite(n) || n <= 0) return '$0';
  return `$${(n / 100).toFixed(0)}`;
}

function bullets(items) {
  const arr = (Array.isArray(items) ? items : []).map((x) => cleanStr(x, 280)).filter(Boolean);
  return arr.map((x) => `- ${x}`).join('\n');
}

function section(title, items) {
  const body = Array.isArray(items) ? bullets(items) : cleanStr(items, 1200);
  return body ? `${title}\n${body}` : '';
}

function joinSections(parts) {
  return parts.filter(Boolean).join('\n\n').trim();
}

function roleLabel(role) {
  const map = {
    dialer: 'Remote Setter',
    remote_setter: 'Remote Setter',
    in_person_setter: 'In Person Setter',
    closer: 'Closer',
    account_manager: 'Account Manager',
    territory_specialist: 'Territory Specialist',
    event_coordinator: 'Event Coordinator',
    event_host: 'Event Host',
    media_team: 'Media Team',
    manager: 'Manager',
  };
  return map[String(role || '').trim()] || cleanStr(role, 60) || 'Team member';
}

function sumBudgetCents(budget) {
  const b = (budget && typeof budget === 'object') ? budget : {};
  return ['hostPayCents', 'mediaPayCents', 'foodCents', 'decorCents', 'suppliesCents', 'contingencyCents']
    .reduce((sum, key) => sum + (Number(b[key] || 0) || 0), 0);
}

async function withAiFallback(runRemote, buildFallback) {
  const cfg = getAiConfig();
  if (!cfg.ok) return { ok: true, data: buildFallback(cfg.error) };
  const remote = await runRemote(cfg);
  if (remote.ok) return remote;
  return { ok: true, data: buildFallback(remote.error || 'ai_unavailable') };
}

function leadContext(lead) {
  const pick = (k) => String(lead?.[k] || '').trim();
  const meta = (lead?.meta && typeof lead.meta === 'object') ? lead.meta : {};
  return {
    id: lead?.id,
    name: [pick('first_name'), pick('last_name')].filter(Boolean).join(' ').trim(),
    phone: pick('phone'),
    email: pick('email'),
    company: pick('company'),
    propertyName: pick('property_name'),
    city: pick('city'),
    state: pick('state'),
    source: pick('source'),
    status: pick('status'),
    assignedRole: pick('assigned_role'),
    nextTouch: cleanStr(meta?.followup, 80),
    notes: pick('notes'),
  };
}

function fallbackFollowupData({ lead, outcome, notes }) {
  const ctx = leadContext(lead);
  const firstName = cleanStr((ctx.name || '').split(/\s+/)[0], 40) || 'there';
  const account = ctx.propertyName || ctx.company || 'your community';
  const outcomeLine = cleanStr(outcome, 160) || 'our recent conversation';
  const noteLine = cleanStr(notes, 180);
  const emailSubject = `Next steps for ${account} resident events`;
  const emailBody = [
    `Hi ${firstName},`,
    '',
    `Thanks again for the time around ${outcomeLine}. Based on what we know about ${account}, I would keep the next move simple: align on the goal, pick the right event format, and confirm timing for the first activation.`,
    noteLine ? `The main thing I captured is: ${noteLine}.` : 'The main thing to lock next is the decision path and target timing.',
    '',
    'If helpful, I can send over a short recommendation with 2-3 event concepts and a clean rollout plan for your team.',
    '',
    'Best,',
    'PureStay',
  ].join('\n');
  const sms = cleanStr(`Hi ${firstName}, thanks again for the time today. I can send a simple event recommendation for ${account} with next steps and timing options if that helps. What works best for your team?`, 320);
  const nextStep = 'Send the follow-up now, then book the next touch around the decision maker, budget, and first target date.';
  return { emailSubject, emailBody, sms, nextStep };
}

function fallbackResearchData({ lead }) {
  const ctx = leadContext(lead);
  const account = ctx.propertyName || ctx.company || 'this community';
  return {
    summary: `${account} should be treated as a retention conversation first. Anchor on resident engagement goals, event timing, and how quickly they can approve a first activation.`.trim(),
    talkingPoints: uniqStrings([
      `Open with the outcome they care about most, resident retention, renewals, tours, or community sentiment.`,
      `Ask how ${account} currently drives turnout and what has underperformed.`,
      'Position PureStay as a repeatable system, not just a one-off event vendor.',
      ctx.city || ctx.state ? `Use the local market angle, ${[ctx.city, ctx.state].filter(Boolean).join(', ')}, to discuss turnout and resident fit.` : '',
      ctx.nextTouch ? `Reference the current next-touch timing, ${ctx.nextTouch}, so the close path feels organized.` : '',
    ], 5),
    likelyObjections: uniqStrings([
      'Budget is not approved yet.',
      'They need proof turnout will justify the spend.',
      'They already have internal vendors or staff handling events.',
      'Decision makers are split between onsite and regional leadership.',
    ], 4),
    nextSteps: uniqStrings([
      'Confirm the main success metric for the first activation.',
      'Map the decision maker, approver, and ideal launch window.',
      'Offer 2 package-fit options instead of too many choices.',
      'Close on a specific follow-up date with the right stakeholders.',
    ], 4),
  };
}

function fallbackVendorSearchQuery(ctx) {
  return cleanStr([
    ctx.city,
    ctx.state,
    ctx.plan?.eventType,
    ctx.logistics?.vendorNeeds,
    ctx.title,
  ].filter(Boolean).join(' '), 120);
}

function vendorCategoryHint(text) {
  const t = String(text || '').toLowerCase();
  if (/(photo|video|media|camera)/.test(t)) return 'media coverage';
  if (/(food|drink|cater|snack|coffee|ice cream)/.test(t)) return 'food and beverage';
  if (/(dj|music|audio|speaker)/.test(t)) return 'music or audio support';
  if (/(decor|balloon|floral|backdrop)/.test(t)) return 'decor';
  return 'event support';
}

function fallbackVendorSuggestionsData({ event, vendors }) {
  const ctx = eventContext(event);
  const pool = Array.isArray(vendors) ? vendors : [];
  const eventText = [ctx.title, ctx.notes, ctx.plan?.strategy, ctx.plan?.eventType, ctx.logistics?.vendorNeeds, ctx.logistics?.equipment, ctx.logistics?.setupNotes].filter(Boolean).join(' ');
  const ranked = pool.map((vendor, idx) => {
    const city = cleanStr(vendor?.city, 80).toLowerCase();
    const state = cleanStr(vendor?.state, 20).toLowerCase();
    const type = cleanStr(vendor?.type, 80);
    let score = 0;
    if (ctx.city && city && ctx.city.toLowerCase() === city) score += 5;
    if (ctx.state && state && ctx.state.toLowerCase() === state) score += 2;
    score += overlapScore(eventText, [vendor?.name, type].join(' ')) * 2;
    if (vendorCategoryHint(eventText) === vendorCategoryHint(type)) score += 2;
    return { idx, score, vendor, type };
  }).sort((a, b) => b.score - a.score || a.idx - b.idx);

  const suggestions = ranked.slice(0, Math.min(5, ranked.length)).map(({ idx, vendor, type }) => ({
    idx,
    reason: cleanStr([
      vendor?.city && vendor?.state ? `${vendor.city}, ${vendor.state} coverage lines up with the event market.` : '',
      type ? `${type} fits the likely need for ${vendorCategoryHint(eventText)}.` : 'This is one of the better market-fit options in the current pool.',
    ].filter(Boolean).join(' '), 280),
  }));

  const missingInfo = uniqStrings([
    !ctx.eventDate ? 'Confirm the event date before locking vendors.' : '',
    !ctx.logistics?.vendorNeeds ? 'List the exact vendor categories still missing.' : '',
    sumBudgetCents(ctx.budget) <= 0 ? 'Set an event budget so vendor choices can be narrowed by spend.' : '',
  ], 4);

  return {
    suggestions,
    searchQuery: fallbackVendorSearchQuery(ctx),
    missingInfo,
  };
}

function fallbackTalentRecommendationsData({ event, talent }) {
  const ctx = eventContext(event);
  const pool = Array.isArray(talent) ? talent : [];
  const targetText = [ctx.title, ctx.plan?.eventType, ctx.plan?.strategy, ctx.logistics?.equipment, ctx.logistics?.setupNotes].filter(Boolean).join(' ');
  function scoreCandidate(t) {
    let score = 0;
    if (ctx.city && String(t?.homeBaseCity || '').trim().toLowerCase() === ctx.city.toLowerCase()) score += 4;
    if (ctx.state && String(t?.homeBaseState || '').trim().toLowerCase() === ctx.state.toLowerCase()) score += 2;
    score += overlapScore(targetText, Array.isArray(t?.specialties) ? t.specialties.join(' ') : '') * 2;
    const rel = Number(t?.reliabilityScore);
    if (Number.isFinite(rel)) score += Math.max(0, Math.min(100, rel)) / 25;
    return score;
  }
  function reasonFor(t) {
    return cleanStr([
      t?.homeBaseCity || t?.homeBaseState ? `Local coverage is stronger from ${[t.homeBaseCity, t.homeBaseState].filter(Boolean).join(', ')}.` : '',
      Array.isArray(t?.specialties) && t.specialties.length ? `Specialties match the event focus: ${t.specialties.slice(0, 3).join(', ')}.` : '',
      Number.isFinite(Number(t?.reliabilityScore)) ? `Reliability score is ${Math.round(Number(t.reliabilityScore))}.` : '',
    ].filter(Boolean).join(' '), 280);
  }
  function pickRole(role, limit) {
    return pool
      .filter((t) => String(t?.role || '').trim() === role)
      .map((t) => ({ userId: String(t.userId || ''), score: scoreCandidate(t), reason: reasonFor(t) }))
      .sort((a, b) => b.score - a.score || String(a.userId).localeCompare(String(b.userId)))
      .slice(0, limit)
      .map(({ userId, reason }) => ({ userId, reason }));
  }
  return {
    hosts: pickRole('event_host', 3),
    media: pickRole('media_team', 3),
    missingInfo: uniqStrings([
      !ctx.eventDate ? 'Confirm the event date before assigning talent.' : '',
      !ctx.logistics?.equipment ? 'Note any gear or setup requirements for the team.' : '',
      !ctx.plan?.eventType ? 'Choose the event type so host and media fit can be narrowed.' : '',
    ], 4),
  };
}

function fallbackEventTypeSuggestionsData({ eventTypes, propertyContext, strategy, count }) {
  const pool = Array.isArray(eventTypes) ? eventTypes.slice(0, 80) : [];
  const ctx = (propertyContext && typeof propertyContext === 'object') ? propertyContext : {};
  const n = clampInt(count, 3, 10, 5);
  const goalText = [ctx.goals, ctx.classType, ctx.strategy, strategy, ctx.city, ctx.name].filter(Boolean).join(' ');
  const ranked = pool.map((e, idx) => {
    const type = cleanStr(e?.Type, 80);
    const classFit = cleanStr(e?.['Class Fit'], 120).toLowerCase();
    let score = 0;
    if (strategy && type && String(type).toLowerCase() === String(strategy).toLowerCase()) score += 4;
    if (ctx.classType && classFit.includes(String(ctx.classType).toLowerCase())) score += 4;
    if (classFit.includes('all')) score += 1;
    score += overlapScore(goalText, [e?.['Goal'], e?.['Psychological Hook'], e?.Notes, e?.['Event Type']].join(' '));
    return { idx, score, e };
  }).sort((a, b) => b.score - a.score || a.idx - b.idx);

  const picks = ranked.slice(0, Math.min(n, ranked.length)).map(({ idx, e }) => ({
    idx,
    reason: cleanStr([
      e?.['Goal'] ? `Goal fit: ${e['Goal']}.` : '',
      e?.['Class Fit'] ? `Class fit: ${e['Class Fit']}.` : '',
    ].filter(Boolean).join(' '), 300),
    hook: cleanStr(e?.['Psychological Hook'], 200),
  }));

  const tip = cleanStr('Favor the first event type that matches the resident profile and is simple to staff. The fastest win is usually better than the most creative concept.', 400);
  return { picks, tip };
}

async function generateFollowup({ lead, outcome, notes }) {
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

  return withAiFallback((cfg) => callOpenAIChat({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }), () => fallbackFollowupData({ lead, outcome, notes }));
}

async function generateResearch({ lead }) {
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

  return withAiFallback((cfg) => callOpenAIChat({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }), () => fallbackResearchData({ lead }));
}

function eventContext(ev) {
  const meta = ev?.meta && typeof ev.meta === 'object' ? ev.meta : {};
  const plan = meta?.plan && typeof meta.plan === 'object' ? meta.plan : {};
  const budget = meta?.budget && typeof meta.budget === 'object' ? meta.budget : {};
  const property = meta?.property && typeof meta.property === 'object' ? meta.property : {};
  const logistics = meta?.logistics && typeof meta.logistics === 'object' ? meta.logistics : {};

  return {
    id: ev?.id,
    title: String(ev?.title || '').trim(),
    eventDate: String(ev?.event_date || '').trim(),
    startTime: String(ev?.start_time || '').trim(),
    endTime: String(ev?.end_time || '').trim(),
    city: String(ev?.city || '').trim(),
    state: String(ev?.state || '').trim(),
    address: String(ev?.address || '').trim(),
    notes: String(ev?.notes || '').trim(),
    status: String(ev?.status || '').trim(),
    assignedRole: String(ev?.assigned_role || '').trim(),
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
    logistics: {
      loadInHours: Number(logistics?.loadInHours || 0) || 0,
      arrivalLeadMinutes: Number(logistics?.arrivalLeadMinutes || 0) || 0,
      teardownMinutes: Number(logistics?.teardownMinutes || 0) || 0,
      equipment: cleanStr(logistics?.equipment, 240),
      vendorNeeds: cleanStr(logistics?.vendorNeeds, 240),
      setupNotes: cleanStr(logistics?.setupNotes, 240),
      accessNotes: cleanStr(logistics?.accessNotes, 240),
      pointOfContact: cleanStr(logistics?.pointOfContact, 120),
      pointOfContactPhone: cleanStr(logistics?.pointOfContactPhone, 80),
    },
  };
}

async function generateVendorSuggestions({ event, vendors }) {
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

  return withAiFallback((cfg) => callOpenAIChat({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }), () => fallbackVendorSuggestionsData({ event, vendors }));
}

async function generateTalentRecommendations({ event, talent }) {
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

  return withAiFallback((cfg) => callOpenAIChat({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }), () => fallbackTalentRecommendationsData({ event, talent }));
}

async function generateEventTypeSuggestions({ eventTypes, propertyContext, strategy, count }) {
  const pool = Array.isArray(eventTypes) ? eventTypes.slice(0, 80) : [];
  const n = clampInt(count, 3, 10, 5);

  const system = [
    'You are the Event Strategy AI for PureStay.',
    'PureStay runs resident experience events at apartment communities (Class A/B/C, Student, Lease-Up, Workforce, 55+).',
    'Recommend the best-fit event types for a property strictly from the provided candidate list.',
    'No em dashes (—) or en dashes (–). Use commas or hyphens.',
    'Output MUST be valid JSON only.',
  ].join('\n');

  const candidates = pool.map((e, i) => ({
    idx: i,
    name: e['Event Type'] || '',
    type: e['Type'] || '',
    classFit: e['Class Fit'] || '',
    goal: e['Goal'] || '',
    hook: e['Psychological Hook'] || '',
  }));

  const user = [
    `Select the ${n} best event types for this property from the candidates.`,
    `Property context: ${JSON.stringify(propertyContext)}`,
    `Strategy preference: ${strategy || 'any'}`,
    `Candidates (use idx to reference): ${JSON.stringify(candidates)}`,
    'Return JSON: {"picks": [{"idx": number, "reason": string, "hook": string}], "tip": string}',
    'Rules: idx must be valid index. reason is specific to the property context (1-2 sentences). hook summarizes the resident psychology. tip is one strategic note for the coordinator.',
  ].join('\n');

  return withAiFallback((cfg) => callOpenAIChat({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }), () => fallbackEventTypeSuggestionsData({ eventTypes, propertyContext, strategy, count }));
}

function normalizeAssistantContext(context) {
  const src = (context && typeof context === 'object') ? context : {};
  const view = (src.view && typeof src.view === 'object') ? src.view : {};
  const request = (src.request && typeof src.request === 'object') ? src.request : {};
  const lead = (src.lead && typeof src.lead === 'object') ? src.lead : null;
  const event = (src.event && typeof src.event === 'object') ? src.event : null;
  const task = (src.task && typeof src.task === 'object') ? src.task : null;
  const account = (src.account && typeof src.account === 'object') ? src.account : null;
  const offers = (src.offers && typeof src.offers === 'object') ? src.offers : null;
  const appointments = (src.appointments && typeof src.appointments === 'object') ? src.appointments : null;
  const dispatch = (src.dispatch && typeof src.dispatch === 'object') ? src.dispatch : null;
  return {
    view: {
      activeTab: cleanStr(view.activeTab, 40),
      activeLabel: cleanStr(view.activeLabel, 60),
      subtab: cleanStr(view.subtab, 40),
      role: cleanStr(view.role, 40),
      realRole: cleanStr(view.realRole, 40),
      viewAsRole: cleanStr(view.viewAsRole, 40),
      viewAsUser: cleanStr(view.viewAsUser, 80),
      counts: (view.counts && typeof view.counts === 'object') ? view.counts : {},
    },
    request: {
      mode: cleanStr(request.mode, 40),
      assistantMode: cleanStr(request.assistantMode, 40),
    },
    lead: lead ? {
      id: lead.id,
      name: cleanStr(lead.name, 120),
      company: cleanStr(lead.company, 120),
      propertyName: cleanStr(lead.propertyName, 120),
      city: cleanStr(lead.city, 80),
      state: cleanStr(lead.state, 20),
      phone: cleanStr(lead.phone, 40),
      email: cleanStr(lead.email, 120),
      status: cleanStr(lead.status, 40),
      source: cleanStr(lead.source, 80),
      nextTouch: cleanStr(lead.nextTouch, 80),
      assignedRole: cleanStr(lead.assignedRole, 40),
      notes: cleanStr(lead.notes, 240),
    } : null,
    event: event ? {
      id: event.id,
      title: cleanStr(event.title, 120),
      city: cleanStr(event.city, 80),
      state: cleanStr(event.state, 20),
      date: cleanStr(event.date || event.eventDate, 40),
      startTime: cleanStr(event.startTime, 20),
      endTime: cleanStr(event.endTime, 20),
      status: cleanStr(event.status, 40),
      assignedRole: cleanStr(event.assignedRole, 40),
      plan: (event.plan && typeof event.plan === 'object') ? {
        strategy: cleanStr(event.plan.strategy, 60),
        eventType: cleanStr(event.plan.eventType, 80),
        justification: cleanStr(event.plan.justification, 180),
      } : null,
      budget: (event.budget && typeof event.budget === 'object') ? event.budget : null,
      logistics: (event.logistics && typeof event.logistics === 'object') ? {
        loadInHours: Number(event.logistics.loadInHours || 0) || 0,
        arrivalLeadMinutes: Number(event.logistics.arrivalLeadMinutes || 0) || 0,
        teardownMinutes: Number(event.logistics.teardownMinutes || 0) || 0,
        equipment: cleanStr(event.logistics.equipment, 180),
        vendorNeeds: cleanStr(event.logistics.vendorNeeds, 180),
        setupNotes: cleanStr(event.logistics.setupNotes, 180),
        accessNotes: cleanStr(event.logistics.accessNotes, 180),
        pointOfContact: cleanStr(event.logistics.pointOfContact, 80),
      } : null,
    } : null,
    task: task ? {
      id: task.id,
      title: cleanStr(task.title, 120),
      taskType: cleanStr(task.taskType, 80),
      status: cleanStr(task.status, 40),
      priority: Number(task.priority || 0) || 0,
      dueAt: cleanStr(task.dueAt, 40),
      assignedRole: cleanStr(task.assignedRole, 40),
      description: cleanStr(task.description, 240),
    } : null,
    account: account ? {
      id: account.id,
      name: cleanStr(account.name, 120),
      address: cleanStr(account.address, 180),
      city: cleanStr(account.city, 80),
      state: cleanStr(account.state, 20),
      tier: cleanStr(account.tier, 60),
      contactName: cleanStr(account.contactName, 120),
      contactEmail: cleanStr(account.contactEmail, 120),
      contactPhone: cleanStr(account.contactPhone, 40),
      renewalDate: cleanStr(account.renewalDate, 40),
      notes: cleanStr(account.notes, 240),
    } : null,
    offers: offers ? {
      total: Number(offers.total || 0) || 0,
      selectedEventId: offers.selectedEventId || null,
      selectedTitle: cleanStr(offers.selectedTitle, 120),
      selectedRole: cleanStr(offers.selectedRole, 40),
      selectedState: cleanStr(offers.selectedState, 40),
    } : null,
    appointments: appointments ? {
      total: Number(appointments.total || 0) || 0,
      next: appointments.next && typeof appointments.next === 'object' ? {
        id: appointments.next.id,
        status: cleanStr(appointments.next.status, 40),
        date: cleanStr(appointments.next.date, 40),
        title: cleanStr(appointments.next.title, 120),
      } : null,
    } : null,
    dispatch: dispatch ? {
      total: Number(dispatch.total || 0) || 0,
      open: Number(dispatch.open || 0) || 0,
      overdue: Number(dispatch.overdue || 0) || 0,
      next: dispatch.next && typeof dispatch.next === 'object' ? {
        id: dispatch.next.id,
        title: cleanStr(dispatch.next.title, 120),
        status: cleanStr(dispatch.next.status, 40),
        due: cleanStr(dispatch.next.due, 40),
      } : null,
    } : null,
  };
}

function detectAssistantIntent(message, ctx) {
  const q = String(message || '').toLowerCase();
  if (/(add|create|new).{0,20}lead/.test(q)) return 'create_lead';
  if (/(open|show|take me to|go to|navigate).{0,20}account/.test(q)) return 'open_account';
  if (/(open|show|take me to|go to|navigate).{0,20}event/.test(q)) return 'open_event';
  if (/(accept|approve).{0,20}(offer|assignment)/.test(q)) return 'offer_accept';
  if (/(decline|reject).{0,20}(offer|assignment)/.test(q)) return 'offer_decline';
  if (/(mark|set).{0,20}(meeting|appointment).{0,20}(complete|done)|complete.{0,20}(meeting|appointment)/.test(q)) return 'appointment_complete';
  if (/(claim|take).{0,20}(task|dispatch)/.test(q)) return 'dispatch_claim';
  if (/(mark|set).{0,20}(task|dispatch).{0,20}(done|complete)|complete.{0,20}(task|dispatch)/.test(q)) return 'dispatch_complete';
  if (/(cancel).{0,20}(task|dispatch)/.test(q)) return 'dispatch_cancel';
  if (/(escalat).{0,20}(task|dispatch)/.test(q)) return 'dispatch_escalate';
  if (/(follow.?up|sms|text message|email|subject line|draft)/.test(q)) return 'followup';
  if (/(vendor|cater|food|drink|dj|music|decor|photo|video|photobooth)/.test(q)) return 'vendors';
  if (/(staff|staffing|talent|host|media|assign|crew)/.test(q)) return 'staffing';
  if (ctx?.lead && /(call|objection|pitch|close|meeting|lead|prospect|prep)/.test(q)) return 'lead';
  if (ctx?.event && /(ops|brief|setup|logistics|focus|break|timeline|event)/.test(q)) return 'event';
  return 'general';
}

function fallbackAssistantEventBrief(event) {
  const e = event || {};
  const budgetTotal = sumBudgetCents(e.budget);
  return {
    focus: uniqStrings([
      e.plan?.eventType ? `Keep the event plan centered on ${e.plan.eventType}.` : 'Lock the event type before adding more moving pieces.',
      e.logistics?.vendorNeeds ? `Secure these vendors first: ${e.logistics.vendorNeeds}.` : 'List the vendor categories still missing, then lock the critical one first.',
      e.logistics?.pointOfContact ? `Confirm final access and day-of decisions with ${e.logistics.pointOfContact}.` : 'Confirm who owns day-of access and approvals onsite.',
      budgetTotal > 0 ? `Work inside the current budget ceiling of about ${money(budgetTotal)}.` : 'Set a working budget before approving optional add-ons.',
    ], 4),
    risks: uniqStrings([
      !e.logistics?.accessNotes ? 'Access and load-in instructions are still thin.' : '',
      !e.logistics?.equipment ? 'Equipment needs are not fully defined yet.' : '',
      !e.logistics?.vendorNeeds ? 'Vendor scope is vague, which creates last-minute scrambling.' : '',
      !e.date ? 'The event date is not locked.' : '',
    ], 4),
    missing: uniqStrings([
      !e.date ? 'Final event date and operating window.' : '',
      !e.plan?.eventType ? 'Confirmed event type.' : '',
      !e.logistics?.pointOfContact ? 'Day-of point of contact.' : '',
    ], 4),
  };
}

function fallbackAssistantData({ role, context, message, fallbackReason }) {
  const ctx = normalizeAssistantContext(context);
  const intent = detectAssistantIntent(message, ctx);
  const lead = ctx.lead;
  const event = ctx.event;
  const account = ctx.account;
  const offers = ctx.offers;
  const appointments = ctx.appointments;
  const dispatch = ctx.dispatch;
  const intro = fallbackReason
    ? `The live model is unavailable right now, so this response is being composed from the recorded portal context and operating rules.`
    : `Here is the current ${roleLabel(role).toLowerCase()} read based on the portal context.`;

  if (intent === 'offer_accept' && (offers?.selectedEventId || event?.id)) {
    const eventId = offers?.selectedEventId || event?.id;
    const roleForOffer = offers?.selectedRole || event?.assignedRole || role;
    return {
      reply: joinSections([
        intro,
        section('Best move', [`Accept ${offers?.selectedTitle || event?.title || 'the selected offer'} so staffing can stop waiting on this response.`]),
      ]),
      actions: [
        {
          label: 'Accept offer',
          type: 'confirm_action',
          payload: {
            title: 'Accept offer?',
            message: 'This will update the assignment response to accepted.',
            confirmLabel: 'Accept offer',
            action: { type: 'offer_response', payload: { eventId, role: roleForOffer, decision: 'accepted' } },
          },
        },
      ],
    };
  }

  if (intent === 'offer_decline' && (offers?.selectedEventId || event?.id)) {
    const eventId = offers?.selectedEventId || event?.id;
    const roleForOffer = offers?.selectedRole || event?.assignedRole || role;
    return {
      reply: joinSections([
        intro,
        section('Best move', [`Decline ${offers?.selectedTitle || event?.title || 'the selected offer'} so operations can reroute coverage quickly.`]),
      ]),
      actions: [
        {
          label: 'Decline offer',
          type: 'confirm_action',
          payload: {
            title: 'Decline offer?',
            message: 'This will update the assignment response to declined.',
            confirmLabel: 'Decline offer',
            action: { type: 'offer_response', payload: { eventId, role: roleForOffer, decision: 'declined' } },
          },
        },
      ],
    };
  }

  if (intent === 'appointment_complete' && appointments?.next?.id) {
    return {
      reply: joinSections([
        intro,
        section('Best move', [`Mark ${appointments.next.title || 'the next meeting'} complete so the pipeline reflects the real outcome.`]),
      ]),
      actions: [
        {
          label: 'Complete meeting',
          type: 'confirm_action',
          payload: {
            title: 'Mark meeting complete?',
            message: 'This will update the appointment status to completed.',
            confirmLabel: 'Mark complete',
            action: { type: 'appointment_complete', payload: { appointmentId: appointments.next.id } },
          },
        },
      ],
    };
  }

  if (intent === 'dispatch_claim' && dispatch?.next?.id) {
    return {
      reply: joinSections([
        intro,
        section('Best move', [`Claim ${dispatch.next.title || 'the next dispatch task'} so it has a clear owner.`]),
      ]),
      actions: [
        {
          label: 'Claim task',
          type: 'confirm_action',
          payload: {
            title: 'Claim task?',
            message: 'This will assign the task to the current user and move it to assigned.',
            confirmLabel: 'Claim task',
            action: { type: 'dispatch_claim', payload: { taskId: dispatch.next.id } },
          },
        },
      ],
    };
  }

  if (intent === 'dispatch_complete' && dispatch?.next?.id) {
    return {
      reply: joinSections([
        intro,
        section('Best move', [`Close ${dispatch.next.title || 'the next dispatch task'} if the work is already done.`]),
      ]),
      actions: [
        {
          label: 'Mark task done',
          type: 'confirm_action',
          payload: {
            title: 'Mark task done?',
            message: 'This will move the dispatch task to completed.',
            confirmLabel: 'Mark done',
            action: { type: 'dispatch_complete', payload: { taskId: dispatch.next.id } },
          },
        },
      ],
    };
  }

  if (intent === 'dispatch_cancel' && dispatch?.next?.id) {
    return {
      reply: joinSections([
        intro,
        section('Best move', [`Cancel ${dispatch.next.title || 'the next dispatch task'} only if it should leave the queue entirely.`]),
      ]),
      actions: [
        {
          label: 'Cancel task',
          type: 'confirm_action',
          payload: {
            title: 'Cancel task?',
            message: 'This will cancel the dispatch task.',
            confirmLabel: 'Cancel task',
            action: { type: 'dispatch_cancel', payload: { taskId: dispatch.next.id } },
          },
        },
      ],
    };
  }

  if (intent === 'dispatch_escalate' && dispatch?.next?.id) {
    return {
      reply: joinSections([
        intro,
        section('Best move', [`Escalate ${dispatch.next.title || 'the next dispatch task'} if it is blocked or overdue.`]),
      ]),
      actions: [
        {
          label: 'Escalate task',
          type: 'confirm_action',
          payload: {
            title: 'Escalate task?',
            message: 'This will escalate the dispatch task for management attention.',
            confirmLabel: 'Escalate',
            action: { type: 'dispatch_escalate', payload: { taskId: dispatch.next.id } },
          },
        },
      ],
    };
  }

  if (intent === 'create_lead') {
    return {
      reply: joinSections([
        intro,
        section('Best move', [
          'I prepared a lead draft route so you can review the contact details before it is saved.',
          'If you already know the name, property, or market, add it in the lead tray and create it from there.',
        ]),
      ]),
      actions: [
        { label: 'Open lead draft', type: 'create_lead', payload: { autoCreate: false } },
      ],
    };
  }

  if (intent === 'open_account' && account) {
    return {
      reply: joinSections([
        intro,
        section('Best move', [`Open ${account.name || 'the selected account'} so you can work sentiment, issues, and contract details in one place.`]),
      ]),
      actions: [
        { label: 'Open account', type: 'open_account', payload: { accountId: account.id } },
      ],
    };
  }

  if (intent === 'open_event' && event) {
    return {
      reply: joinSections([
        intro,
        section('Best move', [`Open ${event.title || 'the selected event'} so staffing, recap, logistics, and follow-up stay together.`]),
      ]),
      actions: [
        { label: 'Open event', type: 'open_event', payload: { eventId: event.id } },
      ],
    };
  }

  if (intent === 'followup' && lead) {
    const follow = fallbackFollowupData({ lead, outcome: message, notes: lead.notes });
    return {
      reply: joinSections([
        intro,
        section('Best move', [
          `Use a soft next-step ask tied to ${lead.propertyName || lead.company || lead.name || 'the account'}.`,
          'Keep it about timing, goals, and the first simple activation.',
        ]),
        `Email subject\n${follow.emailSubject}`,
        `Email body\n${follow.emailBody}`,
        `SMS\n${follow.sms}`,
        section('Next step', [follow.nextStep]),
      ]),
      actions: [
        { label: 'Copy email', type: 'copy_text', payload: follow.emailBody },
        { label: 'Copy SMS', type: 'copy_text', payload: follow.sms },
      ],
    };
  }

  if (intent === 'lead' && lead) {
    const prep = fallbackResearchData({ lead });
    return {
      reply: joinSections([
        intro,
        section('Lead context', [
          `${lead.name || 'Selected lead'}${lead.propertyName || lead.company ? `, ${lead.propertyName || lead.company}` : ''}${[lead.city, lead.state].filter(Boolean).length ? `, ${[lead.city, lead.state].filter(Boolean).join(', ')}` : ''}.`,
        ]),
        section('Focus', prep.talkingPoints),
        section('Likely objections', prep.likelyObjections),
        section('Next moves', prep.nextSteps),
      ]),
      actions: [],
    };
  }

  if ((intent === 'vendors' || intent === 'staffing' || intent === 'event') && event) {
    const brief = fallbackAssistantEventBrief(event);
    const title = event.title || 'Selected event';
    return {
      reply: joinSections([
        intro,
        section('Event context', [
          `${title}${event.date ? ` on ${event.date}` : ''}${[event.city, event.state].filter(Boolean).length ? ` in ${[event.city, event.state].filter(Boolean).join(', ')}` : ''}.`,
          event.plan?.eventType ? `Planned type: ${event.plan.eventType}.` : '',
          event.logistics?.vendorNeeds ? `Vendor needs: ${event.logistics.vendorNeeds}.` : '',
        ]),
        section('Focus now', brief.focus),
        section('What could break', brief.risks),
        section('Missing info', brief.missing),
      ]),
      actions: [
        {
          label: 'Copy brief',
          type: 'copy_text',
          payload: joinSections([
            `Event: ${title}`,
            section('Focus now', brief.focus),
            section('What could break', brief.risks),
            section('Missing info', brief.missing),
          ]),
        },
      ],
    };
  }

  const generalMoves = {
    dialer: ['Start with call objective, pain, next meeting.', 'Keep the ask narrow and time-bound.', 'Document the exact next touch before ending the call.'],
    remote_setter: ['Open with relevance and curiosity.', 'Get the next meeting instead of over-selling on call one.', 'Leave with a clean follow-up promise.'],
    in_person_setter: ['Qualify the contact quickly.', 'Drive toward a committed next step.', 'Use urgency without sounding rushed.'],
    closer: ['Tie the pitch to retention or leasing outcomes.', 'Surface approval path and timeline early.', 'Close on a decision meeting, not vague interest.'],
    account_manager: ['Protect client confidence first.', 'Own kickoff, follow-through, and the next promised touch.', 'Translate delivery facts into a clear client-safe plan without becoming the planner.'],
    territory_specialist: ['Start with territory drift, owner gaps, and handoff failures before diving into single-record detail.', 'Use cross-role context to decide who needs to move next, not just what is wrong.', 'Reduce manager-level noise by turning regional mess into a short, explicit action plan.'],
    event_coordinator: ['Lock scope, staffing, and vendor sequencing.', 'Remove ambiguous owners before event week.', 'Keep a short risk list and review it daily.'],
    event_host: ['Confirm arrival time, event brief, and the first 10 minutes before you leave for site.', 'Hold the room calmly if something is late or missing, then escalate fast and clearly.', 'Treat recap submission as part of finishing the job, not admin after the fact.'],
    media_team: ['Confirm shot list, timing, and access.', 'Protect load-in and battery or storage readiness.', 'Get the must-have shots first.'],
    manager: ['Reduce ambiguity across owners.', 'Push the team toward one next decision each.', 'Use the current tab context to clear bottlenecks.'],
  };

  const viewLine = ctx.view?.activeLabel
    ? `You are currently in ${ctx.view.activeLabel}${ctx.view.subtab ? `, ${ctx.view.subtab}` : ''}${ctx.view.role ? `, as ${roleLabel(ctx.view.role)}` : ''}.`
    : '';

  return {
    reply: joinSections([
      intro,
      viewLine,
      section('Best next moves', generalMoves[String(role || '').trim()] || generalMoves.manager),
      lead ? section('Selected lead', [`${lead.name || 'Lead'}${lead.propertyName || lead.company ? `, ${lead.propertyName || lead.company}` : ''}`, lead.nextTouch ? `Next touch: ${lead.nextTouch}.` : 'Next touch is not set yet.']) : '',
      event ? section('Selected event', [`${event.title || 'Event'}${event.date ? ` on ${event.date}` : ''}`, event.plan?.eventType ? `Planned type: ${event.plan.eventType}.` : 'Event type is not set yet.']) : '',
      section('If you want more', ['Ask for a follow-up draft, an event brief, vendor priorities, or a call plan and I will make it concrete.']),
    ]),
    actions: [],
  };
}

async function generateAssistantMessage({ role, context, message, history }) {
  const roleDescs = {
    dialer: 'a sales development rep who makes outbound calls to generate leads for apartment communities',
    remote_setter: 'a remote setter who books qualified meetings with apartment communities',
    in_person_setter: 'an in-person setter who drives booked meetings and handoffs',
    closer: 'an account executive who closes deals with apartment property managers',
    event_coordinator: 'an event coordinator who plans and executes resident events at apartment communities',
    account_manager: 'an account manager who owns the client relationship after close, protects retention, and coordinates internal follow-through without directly planning events',
    territory_specialist: 'a regional operator who oversees sales, account continuity, and fulfillment alignment across a territory without acting as a full people manager',
    event_host: 'an event host who represents PureStay on-site, protects the guest experience, and closes the loop with a same-day recap',
    media_team: 'a media team member who captures event coverage and content',
    manager: 'a PureStay operations manager who oversees all team roles and reviews performance',
  };
  const roleDesc = roleDescs[role] || 'a PureStay team member';
  const normalizedContext = normalizeAssistantContext(context);
  const hasRecordContext = !!(
    normalizedContext?.lead
    || normalizedContext?.event
    || normalizedContext?.task
    || normalizedContext?.account
  );

  const roleSpecificGuidance = {
    account_manager: [
      'For account managers, prioritize relationship continuity, kickoff readiness, cadence, retention risk, and recovery clarity.',
      'Do not frame the account manager as the owner of staffing, event design, media assignment, or calendar administration.',
      'When asked for next steps, bias toward client communication, internal alignment, and owner clarity.',
    ],
    territory_specialist: [
      'For territory specialists, prioritize regional continuity, cross-role handoffs, owner clarity, and portfolio-level drift before isolated record detail.',
      'Do not frame the territory specialist as a full admin, a direct people manager by default, or the substitute owner for every workflow record.',
      'When asked for next steps, bias toward cross-functional coordination, escalation compression, and the single best owner-level move.',
    ],
    event_host: [
      'For event hosts, prioritize arrival readiness, professional conduct, resident-facing execution, issue escalation, and same-day recap completion.',
      'Do not frame the event host as the planner, staffing owner, account strategist, or decision-maker on event scope changes.',
      'When asked for next steps, bias toward the event brief, first on-site checks, calm troubleshooting, and recap completion.',
    ],
  };

  const system = [
    `You are Pura, the PureStay AI team member. You are assisting ${roleDesc}.`,
    'PureStay delivers resident retention experiences (events) for apartment communities.',
    'Products: Core (entry), Culture Shift (mid), Signature Stay (premium). Events: Anchor (high-attendance) and Momentum (smaller, niche).',
    'You help with event planning, vendor selection, call prep, follow-up drafting, strategy, and operations questions.',
    'When live portal context is provided, ground your answer in that exact tab, role, lead, or event instead of answering generically.',
    'You only know the current user message, recent chat history, and the explicit portal context provided with the request. Treat everything else as unknown.',
    'Do not imply that you searched the database, checked hidden records, synchronized external systems, or saw calendars, availability, payments, or credentials unless that information is explicitly present in context.',
    'Do not reveal secrets, internal credentials, hidden team data, or records outside the visible workspace scope and actor role.',
    'If context.request.assistantMode is "operational", be action-first. Lead with the move, owner, blocker, and recommended action payload when the portal can help.',
    'If context.request.assistantMode is "discuss", stay collaborative and exploratory, but still keep the answer practical.',
    'If context.request.mode is present, shape the reply to match it: summary = concise recap, next_move = best action first, reply_draft = user-ready copy, risk_review = blockers and missing information.',
    'Lead with the single most useful next move. If something important is missing, say exactly what is missing instead of guessing.',
    'Never state that a record was changed, approved, scheduled, synced, or written unless you are only recommending a portal action and you label it as a suggestion.',
    'When the user is broad, or the workspace is quiet, explain the concrete things you can do from this context before asking for more input.',
    'Be concise, direct, and practical. Use short paragraphs or bullet lists when helpful.',
    'Do not default to executive briefs, leadership updates, or formal operating summaries unless the user explicitly asks for a brief, summary, report, or update.',
    'For normal chat, answer like a direct teammate, not a memo.',
    ...(hasRecordContext ? [] : [
      'No live lead, event, task, or account is attached. Keep factual claims general, avoid record-specific assertions, and ask for the record when exact guidance is needed.',
      'Operational guidance without a live record stays advisory only. Do not pretend to know owner, status, next checkpoint, or system state for a hidden record.',
    ]),
    ...(roleSpecificGuidance[role] || []),
    'Never make up names, prices, or contact details you were not given.',
    'No em dashes (—) or en dashes (–). Use commas or hyphens.',
    'Output MUST be valid JSON only: {"reply": string, "actions": [{"label": string, "type": string, "payload": string|object}]}',
    'actions is optional (0 to 3). Include actions only when clicking them would genuinely help.',
    'If the portal can do the next step, prefer returning a specific action instead of only describing the step.',
    'Allowed action types:',
    '- "copy_text": payload is plain text to copy.',
    '- "navigate": payload object {"tab": string, "subtab"?: string, "focus"?: string}.',
    '- "open_lead": payload object {"leadId"?: number}. Use only when the lead id is known from context.',
    '- "create_lead" or "new_lead": payload object with any of {"firstName","lastName","phone","email","propertyName","city","state","notes","autoCreate"}. Use this when the user wants to add a lead.',
    '- "create_task" or "draft_task": payload object with any of {"taskType","assignedUserId","title","description","dueAt","priority","leadId","accountId","autoCreate"}. Use this when the user wants a tracked handoff or follow-through task.',
    '- "open_event": payload object {"eventId"?: number}. Use when a selected event or known event id should be opened.',
    '- "open_offer": payload object {"eventId"?: number}. Use when the user should open an offer card.',
    '- "open_account": payload object {"accountId"?: string}. Use only when the account id is known from context.',
    '- "open_schedule": payload can be {} when opening the scheduling modal is the best next step.',
    '- "appointment_complete": payload object {"appointmentId"?: number}. Use when a meeting should be marked completed.',
    '- "dispatch_claim": payload object {"taskId"?: number}. Use when the current user should claim an open task.',
    '- "dispatch_complete": payload object {"taskId"?: number}. Use when a dispatch task should be marked done.',
    '- "dispatch_cancel": payload object {"taskId"?: number}. Use when a dispatch task should be cancelled.',
    '- "dispatch_escalate": payload object {"taskId"?: number}. Use when a dispatch task needs escalation.',
    '- "offer_response": payload object {"eventId"?: number, "role"?: string, "decision": "accepted"|"declined"}. Use when the user wants to accept or decline an offer.',
    '- "confirm_action": payload object {"title": string, "message": string, "confirmLabel"?: string, "action": {"type": string, "payload": object|string}}. Use this wrapper for any durable write action.',
    '- "refresh_view": payload can be {} when the user should refresh the current workflow after a change.',
    'Prefer an action over explanation when the user asks to open, navigate, or create something in the portal.',
    'Wrap mutations like accepting offers, completing meetings, or changing dispatch tasks in "confirm_action" unless the user clearly asked for an immediate mutation.',
    'Do not invent ids. If an id is not present in context, use navigate or create_lead without ids instead.',
  ].join('\n');

  const msgs = [{ role: 'system', content: system }];
  if (Array.isArray(history)) {
    for (const h of history.slice(-8)) {
      if (h.role === 'user' || h.role === 'assistant') {
        msgs.push({ role: h.role, content: String(h.content || '').slice(0, 800) });
      }
    }
  }

  const parts = [];
  if (normalizedContext && typeof normalizedContext === 'object') {
    parts.push(`Context: ${JSON.stringify(normalizedContext).slice(0, 2400)}`);
  }
  parts.push(`Request: ${String(message || '').trim()}`);
  msgs.push({ role: 'user', content: parts.join('\n') });

  const cfg = getAiConfig();
  if (!cfg.ok) {
    return { ok: false, error: cfg.error };
  }

  const remote = await callOpenAIChat({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    maxTokens: cfg.maxTokens,
    messages: msgs,
  });

  if (!remote.ok) {
    return { ok: false, error: remote.error || 'ai_unavailable' };
  }

  return remote;
}

async function generateThreadTitle({ role, context, message, reply, history }) {
  const roleDesc = {
    dialer: 'sales outreach',
    remote_setter: 'meeting-setting',
    in_person_setter: 'in-person pipeline work',
    closer: 'deal progression',
    event_coordinator: 'event planning',
    account_manager: 'client success',
    event_host: 'event execution',
    media_team: 'event coverage',
    manager: 'operations oversight',
  }[String(role || '').trim()] || 'operations work';

  const normalizedContext = normalizeAssistantContext(context);
  const system = [
    'You create concise PureStay chat thread titles.',
    'Return valid JSON only: {"title": string}.',
    'The title must be 2 to 6 words, under 48 characters, and easy to scan in a sidebar.',
    'Do not quote the user.',
    'Do not copy the first message verbatim.',
    'Do not end with punctuation.',
    'Do not use generic fillers like "Workspace thread", "New conversation", or "Help request".',
    `Prefer the real work focus for ${roleDesc}.`,
  ].join('\n');

  const msgs = [{ role: 'system', content: system }];
  if (Array.isArray(history)) {
    for (const h of history.slice(-4)) {
      if (h.role === 'user' || h.role === 'assistant') {
        msgs.push({ role: h.role, content: String(h.content || '').slice(0, 400) });
      }
    }
  }

  const parts = [];
  if (normalizedContext && typeof normalizedContext === 'object') {
    parts.push(`Context: ${JSON.stringify(normalizedContext).slice(0, 1600)}`);
  }
  if (message) parts.push(`User request: ${String(message || '').trim().slice(0, 800)}`);
  if (reply) parts.push(`Assistant reply: ${String(reply || '').trim().slice(0, 800)}`);
  msgs.push({ role: 'user', content: parts.join('\n') });

  const cfg = getAiConfig();
  if (!cfg.ok) return { ok: false, error: cfg.error };

  const remote = await callOpenAIChat({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    timeoutMs: Math.min(cfg.timeoutMs, 12000),
    maxTokens: 160,
    messages: msgs,
  });

  const title = cleanStr(String(remote?.data?.title || '').replace(/["']/g, '').replace(/[.!?]+$/g, ''), 48);
  if (!remote.ok || !title) return { ok: false, error: remote.error || 'ai_invalid_title' };
  return { ok: true, data: { title } };
}

module.exports = {
  generateFollowup,
  generateResearch,
  generateVendorSuggestions,
  generateTalentRecommendations,
  generateEventTypeSuggestions,
  generateAssistantMessage,
  generateThreadTitle,
};
