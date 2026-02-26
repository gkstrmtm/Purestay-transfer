const { sendJson, handleCors, bearerToken } = require('../../lib/vercelApi');
const { supabaseAdmin } = require('../../lib/portalAuth');
const { getLogTail } = require('../../lib/storage');
const { notifyEmail, splitList } = require('../../lib/notify');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function ymdTodayUtc() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
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

async function isAuthorized(req) {
  const cronHeader = req.headers?.['x-vercel-cron'];
  if (cronHeader) return true;

  const adminToken = process.env.ADMIN_TOKEN || '';
  if (!adminToken) return true;

  const token = bearerToken(req) || (req.url ? new URL(req.url, 'http://localhost').searchParams.get('token') : '') || '';
  return token === adminToken;
}

async function loadUsersByRole(sbAdmin, roles) {
  const { data, error } = await sbAdmin
    .from('portal_profiles')
    .select('user_id, role')
    .in('role', roles)
    .limit(500);

  if (error || !Array.isArray(data)) return [];
  const ids = data.map((r) => String(r.user_id || '')).filter(Boolean);
  if (!ids.length) return [];

  const listed = await sbAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const byId = new Map((listed?.data?.users || []).map((u) => [String(u.id), u]));

  const emails = [];
  for (const id of ids) {
    const u = byId.get(String(id));
    const email = cleanStr(u?.email, 200);
    if (email) emails.push(email);
  }
  return emails;
}

function recipientsFromAssignments(assignments, role) {
  const arr = Array.isArray(assignments) ? assignments : [];
  return arr
    .filter((a) => String(a?.role || '') === role)
    .map((a) => String(a?.userId || '').trim())
    .filter(Boolean);
}

async function mapUserIdsToEmails(sbAdmin, userIds) {
  const ids = Array.isArray(userIds) ? userIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (!ids.length) return [];
  const listed = await sbAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const byId = new Map((listed?.data?.users || []).map((u) => [String(u.id), u]));
  const emails = [];
  for (const id of ids) {
    const email = cleanStr(byId.get(id)?.email, 200);
    if (email) emails.push(email);
  }
  return emails;
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;
  if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const okAuth = await isAuthorized(req);
  if (!okAuth) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  const sbAdmin = supabaseAdmin();
  if (!sbAdmin) return sendJson(res, 503, { ok: false, error: 'missing_supabase_service_role' });

  const url = new URL(req.url || '/api/cron/event-reminders', 'http://localhost');
  const limit = Math.max(1, Math.min(500, clampInt(url.searchParams.get('limit'), 1, 500, 200)));

  const today = ymdTodayUtc();
  const start = addDaysYmd(today, -3);
  const end = addDaysYmd(today, 3);

  const { data, error } = await sbAdmin
    .from('portal_events')
    .select('*')
    .neq('area_tag', 'dispatch')
    .gte('event_date', start)
    .lte('event_date', end)
    .order('event_date', { ascending: true })
    .order('id', { ascending: false })
    .limit(limit);

  if (error) return sendJson(res, 500, { ok: false, error: 'events_query_failed' });

  const events = Array.isArray(data) ? data : [];
  const eventIds = events.map((e) => e.id).filter(Boolean);

  // Fetch any recaps for these events (recent only)
  const recapByEventId = new Map();
  if (eventIds.length) {
    const { data: recaps } = await sbAdmin
      .from('portal_event_recaps')
      .select('*')
      .in('event_id', eventIds)
      .order('id', { ascending: false })
      .limit(1000);

    for (const r of (Array.isArray(recaps) ? recaps : [])) {
      const eid = Number(r?.event_id);
      if (!eid || recapByEventId.has(eid)) continue;
      recapByEventId.set(eid, r);
    }
  }

  const ccRoles = splitList(process.env.REMINDER_CC_ROLES || 'event_coordinator,manager');
  const ccEmails = (ccRoles.length ? await loadUsersByRole(sbAdmin, ccRoles) : [])
    .concat(splitList(process.env.REMINDER_CC_EMAILS || ''));

  let scanned = 0;
  let attempted = 0;
  let sent = 0;
  let skipped = 0;

  for (const ev of events) {
    scanned += 1;
    const eventId = Number(ev?.id);
    const eventDate = cleanStr(ev?.event_date, 20);
    if (!eventId || !eventDate) continue;

    const meta = ev.meta && typeof ev.meta === 'object' ? ev.meta : {};
    const checklist = meta.checklist && typeof meta.checklist === 'object' ? meta.checklist : {};
    const assignments = Array.isArray(meta.assignments) ? meta.assignments : [];

    const propertyName = cleanStr(meta.propertyName || ev.title, 200) || `Event #${eventId}`;

    const recap = recapByEventId.get(eventId) || null;
    const recapPayload = recap?.payload && typeof recap.payload === 'object' ? recap.payload : {};
    const mediaUrls = Array.isArray(recap?.media_urls) ? recap.media_urls : [];
    const photosUploaded = String(recapPayload.photosUploaded || '').toLowerCase();

    const isPast = eventDate < today;
    const isSoon = eventDate === today || eventDate === addDaysYmd(today, 1);

    // Upcoming reminder: send to all assigned staff.
    if (isSoon) {
      const ids = assignments.map((a) => String(a?.userId || '')).filter(Boolean);
      const to = await mapUserIdsToEmails(sbAdmin, ids);
      if (to.length) {
        attempted += 1;
        const r = await notifyEmail({
          to,
          cc: ccEmails.length ? Array.from(new Set(ccEmails)) : undefined,
          subject: `Reminder: ${propertyName} (${eventDate})`,
          text: [
            `Event reminder: ${propertyName}`,
            `Date: ${eventDate}`,
            `Event ID: ${eventId}`,
            '',
            'Please confirm you are ready and review the event details in the portal.',
          ].join('\n'),
          dedupKey: `reminder:upcoming:${eventId}:${eventDate}`,
          onceWithinMinutes: 720,
        });
        if (r.ok && !r.skipped) sent += 1;
        else if (r.ok && r.skipped) skipped += 1;
      }
    }

    if (!isPast) continue;

    // Post-event reminders.
    const needsRecap = !recap && String(checklist.recapReceived || '') !== 'yes';
    const needsMedia = (!mediaUrls.length && photosUploaded !== 'yes' && String(checklist.mediaReceived || '') !== 'yes');

    let hasFeedback = false;
    try {
      const tail = await getLogTail(`portal:event_feedback:${eventId}`, 1);
      hasFeedback = Array.isArray(tail) && tail.length > 0;
    } catch {
      hasFeedback = false;
    }

    const needsFeedback = String(checklist.feedbackReceived || '') !== 'yes'
      && !hasFeedback
      && !cleanStr(recapPayload.feedbackHighlights, 5000);

    const needsReport = String(checklist.reportSent || '') !== 'yes';

    if (needsRecap) {
      const hostIds = recipientsFromAssignments(assignments, 'event_host');
      const to = await mapUserIdsToEmails(sbAdmin, hostIds);
      if (to.length) {
        attempted += 1;
        const r = await notifyEmail({
          to,
          cc: ccEmails.length ? Array.from(new Set(ccEmails)) : undefined,
          subject: `Action needed: recap missing — ${propertyName} (${eventDate})`,
          text: [
            `Recap is missing for: ${propertyName}`,
            `Date: ${eventDate}`,
            `Event ID: ${eventId}`,
            '',
            'Please submit the recap (attendance estimate, issues, standouts, giveaway winners, feedback highlights, and any media links).',
          ].join('\n'),
          dedupKey: `reminder:missing_recap:${eventId}:${today}`,
          onceWithinMinutes: 720,
        });
        if (r.ok && !r.skipped) sent += 1;
        else if (r.ok && r.skipped) skipped += 1;
      }
    }

    if (needsMedia) {
      const mediaIds = recipientsFromAssignments(assignments, 'media_team');
      const to = await mapUserIdsToEmails(sbAdmin, mediaIds);
      if (to.length) {
        attempted += 1;
        const r = await notifyEmail({
          to,
          cc: ccEmails.length ? Array.from(new Set(ccEmails)) : undefined,
          subject: `Action needed: media missing — ${propertyName} (${eventDate})`,
          text: [
            `Media links are missing for: ${propertyName}`,
            `Date: ${eventDate}`,
            `Event ID: ${eventId}`,
            '',
            'Please upload/share the photo/video links and add them to the recap in the portal.',
          ].join('\n'),
          dedupKey: `reminder:missing_media:${eventId}:${today}`,
          onceWithinMinutes: 720,
        });
        if (r.ok && !r.skipped) sent += 1;
        else if (r.ok && r.skipped) skipped += 1;
      }
    }

    if (needsFeedback) {
      const hostIds = recipientsFromAssignments(assignments, 'event_host');
      const to = await mapUserIdsToEmails(sbAdmin, hostIds);
      if (to.length) {
        attempted += 1;
        const r = await notifyEmail({
          to,
          cc: ccEmails.length ? Array.from(new Set(ccEmails)) : undefined,
          subject: `Action needed: feedback missing — ${propertyName} (${eventDate})`,
          text: [
            `Feedback is missing for: ${propertyName}`,
            `Date: ${eventDate}`,
            `Event ID: ${eventId}`,
            '',
            'Please ensure the feedback link was used and add feedback highlights to the recap.',
          ].join('\n'),
          dedupKey: `reminder:missing_feedback:${eventId}:${today}`,
          onceWithinMinutes: 720,
        });
        if (r.ok && !r.skipped) sent += 1;
        else if (r.ok && r.skipped) skipped += 1;
      }
    }

    // Coordinator/management reminder to send report.
    if (needsReport && recap) {
      const to = ccEmails.length ? Array.from(new Set(ccEmails)) : [];
      if (to.length) {
        attempted += 1;
        const r = await notifyEmail({
          to,
          subject: `Reminder: send event report — ${propertyName} (${eventDate})`,
          text: [
            `Report not marked as sent for: ${propertyName}`,
            `Date: ${eventDate}`,
            `Event ID: ${eventId}`,
            '',
            'Coordinator: generate and send the report draft from the portal, then mark Report sent.',
          ].join('\n'),
          dedupKey: `reminder:missing_report:${eventId}:${today}`,
          onceWithinMinutes: 1440,
        });
        if (r.ok && !r.skipped) sent += 1;
        else if (r.ok && r.skipped) skipped += 1;
      }
    }
  }

  return sendJson(res, 200, {
    ok: true,
    scanned,
    attempted,
    sent,
    skipped,
    window: { start, end, today },
    note: 'Email/SMS sending is env-var gated (RESEND_API_KEY / TWILIO_*).',
  });
};
