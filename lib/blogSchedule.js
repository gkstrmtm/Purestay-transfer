const { slugify, isoDateOnly } = require('./blogs');

const DEFAULT_INTERVAL_DAYS = 3;
const DEFAULT_YEARS_BACK = 2;

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function intervalDays() {
  return DEFAULT_INTERVAL_DAYS;
}

function yearsBack() {
  return DEFAULT_YEARS_BACK;
}

function startDateAligned({ years = yearsBack(), stepDays = intervalDays() } = {}) {
  const now = new Date();
  now.setUTCHours(12, 0, 0, 0);

  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - Math.round(365 * years));
  start.setUTCHours(12, 0, 0, 0);

  // Align to step boundary so sequence math is stable.
  const diffDays = Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  const remainder = diffDays % stepDays;
  start.setUTCDate(start.getUTCDate() + remainder);
  return start;
}

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

function seasonalWord(date) {
  const d = new Date(date);
  const m = d.getUTCMonth();
  if (m === 11 || m === 0) return 'Winter';
  if (m >= 2 && m <= 4) return 'Spring';
  if (m >= 5 && m <= 7) return 'Summer';
  return 'Fall';
}

function titleCase(s) {
  return String(s || '')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.length <= 3 ? w.toLowerCase() : (w[0].toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/\b(roi|seo|cta)\b/gi, (m) => m.toUpperCase());
}

function topicForSequence(sequence) {
  const idx = Math.abs(Number(sequence || 0)) % TOPICS.length;
  return TOPICS[idx];
}

function scheduledMeta({ sequence, publishedAt, stepDays = intervalDays(), start = startDateAligned({ years: yearsBack(), stepDays }) } = {}) {
  const d = new Date(publishedAt);
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  date.setUTCHours(12, 0, 0, 0);

  const topic = topicForSequence(sequence);
  const season = seasonalWord(date);

  const datePrefix = isoDateOnly(date);
  const topicSlug = slugify(topic);
  const slug = `${datePrefix}-${topicSlug}`;

  const title = `${titleCase(topic)}: A ${season} Playbook for Multifamily Resident Retention`;
  const excerpt = `A practical ${season.toLowerCase()} guide for property teams: resident events, retention touchpoints, and measurable ways to increase renewals.`;

  return {
    mode: 'scheduled',
    sequence: Number(sequence || 0),
    topic,
    slug,
    title,
    excerpt,
    publishedAt: date.toISOString(),
    stepDays,
    start: start.toISOString(),
  };
}

function sequenceForDate(date, { start = startDateAligned(), stepDays = intervalDays() } = {}) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return 0;
  const a = new Date(start);
  if (Number.isNaN(a.getTime())) return 0;
  const diffDays = Math.floor((d.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(0, Math.floor(diffDays / stepDays));
}

function dateForSequence(sequence, { start = startDateAligned(), stepDays = intervalDays() } = {}) {
  const a = new Date(start);
  a.setUTCHours(12, 0, 0, 0);
  a.setUTCDate(a.getUTCDate() + Number(sequence || 0) * stepDays);
  return a;
}

function listScheduled({ limit = 50, offset = 0, years = yearsBack(), stepDays = intervalDays() } = {}) {
  const lim = clampInt(limit, 1, 200, 50);
  const off = clampInt(offset, 0, 10000, 0);

  const start = startDateAligned({ years, stepDays });
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);

  const total = Math.max(0, sequenceForDate(today, { start, stepDays }) + 1);

  // newest first
  const items = [];
  const startSeq = Math.max(0, total - 1 - off);
  for (let i = 0; i < lim; i += 1) {
    const seq = startSeq - i;
    if (seq < 0) break;
    const d = dateForSequence(seq, { start, stepDays });
    items.push(scheduledMeta({ sequence: seq, publishedAt: d.toISOString(), stepDays, start }));
  }

  return { total, posts: items, schedule: { years, stepDays, start: start.toISOString() } };
}

function parseDateFromSlug(slug) {
  const s = String(slug || '').trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})-/);
  if (!m) return null;
  const d = new Date(`${m[1]}T12:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = {
  intervalDays,
  yearsBack,
  startDateAligned,
  scheduledMeta,
  listScheduled,
  parseDateFromSlug,
  sequenceForDate,
  dateForSequence,
};
