const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, isManager } = require('../../lib/portalAuth');
const { getJson, setJson } = require('../../lib/storage');
const { bookingIntegrationSummary } = require('../../lib/portalBooking');

const SETTINGS_KEY = 'purestay:settings:v1';

function canManageAdmin(s) {
  return isManager(s.realProfile || s.profile) && !s.viewAsRole && !s.viewAsUserId;
}

function sanitizeSettings(settings) {
  const s = settings || {};
  const booking = bookingIntegrationSummary();
  return {
    bookingCalendarUrl: typeof s.bookingCalendarUrl === 'string' ? s.bookingCalendarUrl : '',
    stripeCheckoutUrl: typeof s.stripeCheckoutUrl === 'string' ? s.stripeCheckoutUrl : '',
    stripePricingUrl: typeof s.stripePricingUrl === 'string' ? s.stripePricingUrl : '',
    internalNotes: typeof s.googleSheets === 'string' ? s.googleSheets : '',
    bookingPlatformConfigured: booking.configured,
    bookingPlatformProvider: booking.provider,
    bookingPlatformBaseUrl: booking.baseUrl,
    bookingPlatformAccountLinked: booking.accountLinked,
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : '',
  };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!canManageAdmin(s)) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  if (req.method === 'GET') {
    const settings = await getJson(SETTINGS_KEY, {});
    return sendJson(res, 200, { ok: true, settings: sanitizeSettings(settings) });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const current = await getJson(SETTINGS_KEY, {});
    const next = {
      ...current,
      bookingCalendarUrl: String(body.bookingCalendarUrl || '').trim().slice(0, 2000),
      stripeCheckoutUrl: String(body.stripeCheckoutUrl || '').trim().slice(0, 2000),
      stripePricingUrl: String(body.stripePricingUrl || '').trim().slice(0, 2000),
      googleSheets: String(body.internalNotes || body.googleSheets || '').trim().slice(0, 20000),
      updatedAt: new Date().toISOString(),
    };

    const ok = await setJson(SETTINGS_KEY, next);
    if (!ok) {
      return sendJson(res, 503, { ok: false, error: 'storage_unavailable', hint: 'Configure Supabase or Vercel KV to persist settings.' });
    }

    return sendJson(res, 200, { ok: true, settings: sanitizeSettings(next) });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
