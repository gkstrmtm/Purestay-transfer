const { sendJson, handleCors, bearerToken, readJson } = require('../lib/vercelApi');
const { getJson, setJson } = require('../lib/storage');

const SETTINGS_KEY = 'purestay:settings:v1';

function sanitizeSettingsForPublic(settings) {
  const s = settings || {};
  return {
    bookingCalendarUrl: typeof s.bookingCalendarUrl === 'string' ? s.bookingCalendarUrl : '',
    stripeCheckoutUrl: typeof s.stripeCheckoutUrl === 'string' ? s.stripeCheckoutUrl : '',
    stripePricingUrl: typeof s.stripePricingUrl === 'string' ? s.stripePricingUrl : '',
    googleSheets: typeof s.googleSheets === 'string' ? s.googleSheets : '',
  };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  if (req.method === 'GET') {
    const settings = await getJson(SETTINGS_KEY, {});
    return sendJson(res, 200, { ok: true, settings: sanitizeSettingsForPublic(settings) });
  }

  if (req.method === 'POST') {
    const adminToken = process.env.ADMIN_TOKEN || '';
    const token = bearerToken(req) || (req.url ? new URL(req.url, 'http://localhost').searchParams.get('token') : '') || '';

    if (!adminToken || token !== adminToken) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }

    const payload = await readJson(req);
    if (!payload) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const current = await getJson(SETTINGS_KEY, {});
    const next = {
      ...current,
      bookingCalendarUrl: String(payload.bookingCalendarUrl || '').trim().slice(0, 2000),
      stripeCheckoutUrl: String(payload.stripeCheckoutUrl || '').trim().slice(0, 2000),
      stripePricingUrl: String(payload.stripePricingUrl || '').trim().slice(0, 2000),
      googleSheets: String(payload.googleSheets || '').trim().slice(0, 20000),
      updatedAt: new Date().toISOString(),
    };

    const ok = await setJson(SETTINGS_KEY, next);
    if (!ok) {
      return sendJson(res, 503, { ok: false, error: 'storage_unavailable', hint: 'Create a Vercel KV store to persist settings.' });
    }

    return sendJson(res, 200, { ok: true, settings: sanitizeSettingsForPublic(next) });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
