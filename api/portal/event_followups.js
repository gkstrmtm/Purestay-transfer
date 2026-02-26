const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');
const { getLogTail } = require('../../lib/storage');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function addDaysYmd(ymd, days) {
  const s = String(ymd || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

async function findDispatchByFollowupKey(sbAdmin, followupKey) {
  const { data, error } = await sbAdmin
    .from('portal_events')
    .select('id')
    .contains('meta', { kind: 'dispatch', followupKey })
    .limit(1);
  if (error) return null;
  return Array.isArray(data) ? data[0] : null;
}

async function insertDispatch(sbAdmin, { actorId, assignedRole, dueDate, title, notes, followupKey, eventId }) {
  const task = {
    created_by: actorId,
    status: 'open',
    title: cleanStr(title, 200),
    event_date: cleanStr(dueDate, 20) || null,
    start_time: '',
    end_time: '',
    address: '',
    city: '',
    state: '',
    postal_code: '',
    area_tag: 'dispatch',
    assigned_role: cleanStr(assignedRole, 40),
    assigned_user_id: null,
    payout_cents: 0,
    notes: cleanStr(notes, 5000),
    meta: {
      kind: 'dispatch',
      followupKey: cleanStr(followupKey, 200),
      reason: 'event_followup',
      eventId: clampInt(eventId, 1, 1e12, null),
    },
  };

  const { data, error } = await sbAdmin
    .from('portal_events')
    .insert(task)
    .select('id')
    .limit(1);

  if (error) return { ok: false, error: 'dispatch_insert_failed' };
  const row = Array.isArray(data) ? data[0] : null;
  return { ok: true, taskId: row?.id || null };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!hasRole(s.profile, ['event_coordinator', 'manager'])) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const eventId = clampInt(body.eventId, 1, 1e12, null);
  if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

  const { data: events, error: e1 } = await s.sbAdmin
    .from('portal_events')
    .select('*')
    .eq('id', eventId)
    .limit(1);

  if (e1) return sendJson(res, 500, { ok: false, error: 'event_lookup_failed' });
  const ev = Array.isArray(events) ? events[0] : null;
  if (!ev) return sendJson(res, 404, { ok: false, error: 'event_not_found' });

  const meta = ev.meta && typeof ev.meta === 'object' ? ev.meta : {};
  const checklist = meta.checklist && typeof meta.checklist === 'object' ? meta.checklist : {};

  const { data: recaps, error: e2 } = await s.sbAdmin
    .from('portal_event_recaps')
    .select('*')
    .eq('event_id', eventId)
    .order('id', { ascending: false })
    .limit(5);

  if (e2) return sendJson(res, 500, { ok: false, error: 'recaps_query_failed' });
  const latest = Array.isArray(recaps) && recaps.length ? recaps[0] : null;
  const latestPayload = latest?.payload && typeof latest.payload === 'object' ? latest.payload : {};
  const latestMedia = Array.isArray(latest?.media_urls) ? latest.media_urls : [];

  const needsRecap = !latest;
  const photosUploaded = String(latestPayload.photosUploaded || '').toLowerCase();
  const needsMedia = !latestMedia.length && photosUploaded !== 'yes' && String(checklist.mediaReceived || '') !== 'yes';

  let hasFeedbackSubmissions = false;
  try {
    const tail = await getLogTail(`portal:event_feedback:${eventId}`, 1);
    hasFeedbackSubmissions = Array.isArray(tail) && tail.length > 0;
  } catch {
    hasFeedbackSubmissions = false;
  }

  const hasFeedbackHighlights = !!String(latestPayload.feedbackHighlights || '').trim();
  const needsFeedback = (
    String(checklist.feedbackReceived || '') !== 'yes'
    && !hasFeedbackSubmissions
    && !hasFeedbackHighlights
  );

  const eventDate = cleanStr(ev.event_date, 20);
  const dueDate = eventDate ? addDaysYmd(eventDate, 1) : null;

  const created = [];
  const skipped = [];

  async function ensureTask(key, assignedRole, title, notes) {
    const followupKey = `event:${eventId}:${key}`;
    const existing = await findDispatchByFollowupKey(s.sbAdmin, followupKey);
    if (existing?.id) {
      skipped.push({ key, taskId: existing.id });
      return;
    }
    const r = await insertDispatch(s.sbAdmin, {
      actorId: s.user.id,
      assignedRole,
      dueDate,
      title,
      notes,
      followupKey,
      eventId,
    });
    if (r.ok) created.push({ key, taskId: r.taskId });
  }

  if (needsRecap) {
    await ensureTask(
      'missing_recap',
      'event_host',
      `Event #${eventId}: recap missing`,
      `Please submit the event recap for #${eventId} (attendance, issues, media links, highlights).`
    );
  }

  if (needsMedia) {
    await ensureTask(
      'missing_media',
      'media_team',
      `Event #${eventId}: media missing`,
      `Please upload/share photo/video links for event #${eventId}.`
    );
  }

  if (needsFeedback) {
    await ensureTask(
      'missing_feedback',
      'event_host',
      `Event #${eventId}: resident feedback missing`,
      `Please provide resident feedback highlights (or confirm feedback form submission) for event #${eventId}.`
    );
  }

  return sendJson(res, 200, {
    ok: true,
    eventId,
    dueDate,
    needs: { recap: needsRecap, media: needsMedia, feedback: needsFeedback },
    created,
    skipped,
  });
};
