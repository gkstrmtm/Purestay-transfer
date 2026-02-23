const { sendJson, handleCors, readJson, isValidEmail } = require('../lib/vercelApi');
const { appendLog, getJson } = require('../lib/storage');

const SETTINGS_KEY = 'purestay:settings:v1';

function computeQuote(payload) {
  const propertyCount = Math.max(1, Math.min(500, Number(payload?.property_count || 1)));
  const term = String(payload?.term || '3').trim();
  const pkg = String(payload?.package || payload?.package_name || '').trim();

  const baseByPkg = {
    core: 1000,
    culture_shift: 1500,
    signature: 2000,
    discounted_core: 900,
  };

  const base = baseByPkg[pkg] ?? 1000;

  const termDiscount = term === '12' ? 0.1 : term === '6' ? 0.05 : 0;
  const bulkDiscount = propertyCount >= 6 ? 0.08 : propertyCount >= 3 ? 0.05 : 0;
  const discount = Math.min(0.2, termDiscount + bulkDiscount);

  const perPropertyMonthly = Math.round(base * (1 - discount));
  const totalMonthly = perPropertyMonthly * propertyCount;

  return {
    propertyCount,
    termMonths: Number(term) || 3,
    pkg,
    perPropertyMonthly,
    totalMonthly,
    discount,
  };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const payload = await readJson(req);
  if (!payload) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const email = String(payload.email || '').trim();
  if (email && !isValidEmail(email)) return sendJson(res, 422, { ok: false, error: 'invalid_email' });

  const q = computeQuote(payload);
  const entry = {
    type: 'quote',
    ts: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || '',
    userAgent: String(req.headers['user-agent'] || ''),
    payload,
    quote: q,
  };

  await appendLog('purestay:log:quote:v1', entry);

  const settings = await getJson(SETTINGS_KEY, {});
  const stripeCheckoutUrl = typeof settings.stripeCheckoutUrl === 'string' ? settings.stripeCheckoutUrl.trim() : '';
  const bookingCalendarUrl = typeof settings.bookingCalendarUrl === 'string' ? settings.bookingCalendarUrl.trim() : '';
  const fallbackUrl = '/Discovery.html#ps-calendar';
  const checkoutUrl = stripeCheckoutUrl || bookingCalendarUrl || fallbackUrl;

  return sendJson(res, 200, {
    ok: true,
    quote: {
      band: `$${q.perPropertyMonthly.toLocaleString()}/mo per property`,
      per_property: q.perPropertyMonthly,
      total_monthly: q.totalMonthly,
      properties: q.propertyCount,
      term: q.termMonths,
      package: q.pkg,
    },
    checkout: { url: checkoutUrl },
  });
};
