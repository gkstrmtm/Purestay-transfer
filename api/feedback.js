const { sendJson, handleCors, readJson, isValidEmail } = require('../lib/vercelApi');
const { supabaseAdmin } = require('../lib/portalAuth');
const { appendLog } = require('../lib/storage');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function tokenFromQuery(url) {
  return cleanStr(url.searchParams.get('t') || url.searchParams.get('token'), 220);
}

function defaultForm() {
  return {
    subtitle: 'Thanks for joining us. Your feedback helps us improve future events.',
    thanksMessage: 'Your feedback was received.',
    questions: [
      { type: 'long_text', label: 'What was your favorite part?' },
      { type: 'long_text', label: 'What should we do differently next time?' },
    ],
  };
}

async function loadEventAndValidate({ sbAdmin, eventId, token }) {
  const { data, error } = await sbAdmin
    .from('portal_events')
    .select('id, title, event_date, city, state, meta')
    .eq('id', eventId)
    .limit(1);

  if (error) return { ok: false, status: 500, error: 'event_lookup_failed' };
  const ev = Array.isArray(data) ? data[0] : null;
  if (!ev) return { ok: false, status: 404, error: 'event_not_found' };

  const meta = ev.meta && typeof ev.meta === 'object' ? ev.meta : {};
  const feedbackForm = meta.feedbackForm && typeof meta.feedbackForm === 'object' ? meta.feedbackForm : null;

  const expected = cleanStr(feedbackForm?.token || '', 220);
  const enabled = String(feedbackForm?.enabled || '') === 'yes';

  if (!enabled || !expected || !token || token !== expected) {
    return { ok: false, status: 401, error: 'invalid_or_expired_link' };
  }

  const form = Object.assign({}, defaultForm(), feedbackForm);
  if (!Array.isArray(form.questions)) form.questions = defaultForm().questions;
  form.questions = form.questions
    .filter((q) => q && typeof q === 'object')
    .slice(0, 10)
    .map((q) => ({
      type: cleanStr(q.type || 'long_text', 40) || 'long_text',
      label: cleanStr(q.label || '', 140) || 'Question',
    }));

  return {
    ok: true,
    event: {
      id: ev.id,
      title: ev.title || '',
      event_date: ev.event_date || '',
      city: ev.city || '',
      state: ev.state || '',
    },
    form,
  };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const sbAdmin = supabaseAdmin();
  if (!sbAdmin) return sendJson(res, 503, { ok: false, error: 'missing_supabase_service_role' });

  const url = new URL(req.url || '/api/feedback', 'http://localhost');
  const eventId = clampInt(url.searchParams.get('eventId') || url.searchParams.get('event_id'), 1, 1e12, null);
  const token = tokenFromQuery(url);

  if (req.method === 'GET') {
    if (!eventId || !token) return sendJson(res, 422, { ok: false, error: 'missing_params' });

    const r = await loadEventAndValidate({ sbAdmin, eventId, token });
    if (!r.ok) return sendJson(res, r.status || 400, { ok: false, error: r.error });

    return sendJson(res, 200, { ok: true, event: r.event, form: r.form });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const bodyEventId = clampInt(body.eventId || body.event_id, 1, 1e12, null);
    const bodyToken = cleanStr(body.t || body.token, 220);
    if (!bodyEventId || !bodyToken) return sendJson(res, 422, { ok: false, error: 'missing_params' });

    const r = await loadEventAndValidate({ sbAdmin, eventId: bodyEventId, token: bodyToken });
    if (!r.ok) return sendJson(res, r.status || 400, { ok: false, error: r.error });

    const rating = clampInt(body.rating, 1, 5, null);
    if (!rating) return sendJson(res, 422, { ok: false, error: 'rating_required' });

    const name = cleanStr(body.name, 80);
    const email = cleanStr(body.email, 120);
    if (email && !isValidEmail(email)) return sendJson(res, 422, { ok: false, error: 'invalid_email' });

    const comment = cleanStr(body.comment, 2000);
    const answers = Array.isArray(body.answers) ? body.answers.slice(0, 10) : [];
    const safeAnswers = answers.map((a, idx) => {
      const obj = a && typeof a === 'object' ? a : {};
      return {
        idx,
        label: cleanStr(obj.label, 140) || cleanStr(r.form.questions?.[idx]?.label, 140) || ('Question ' + (idx + 1)),
        type: cleanStr(obj.type, 40) || cleanStr(r.form.questions?.[idx]?.type, 40) || 'long_text',
        value: cleanStr(obj.value, 1200),
      };
    });

    const entry = {
      type: 'resident_feedback',
      ts: new Date().toISOString(),
      eventId: bodyEventId,
      rating,
      name: name || null,
      email: email || null,
      comment: comment || null,
      answers: safeAnswers,
      meta: {
        ua: cleanStr(req.headers['user-agent'], 240) || null,
        ip: cleanStr(req.headers['x-forwarded-for'], 120) || null,
      },
    };

    const listKey = `portal:event_feedback:${bodyEventId}`;
    const ok = await appendLog(listKey, entry);
    if (!ok) return sendJson(res, 503, { ok: false, error: 'storage_unavailable' });

    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
