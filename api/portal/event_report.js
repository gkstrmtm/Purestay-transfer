const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager, roleAliases } = require('../../lib/portalAuth');
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

function dollars(cents) {
  const n = Number(cents || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

function ymdTodayUtc() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function feedbackSummary(entries) {
  const items = Array.isArray(entries) ? entries : [];
  const hist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  let count = 0;
  const comments = [];

  for (const it of items) {
    const rating = Number(it?.rating);
    if (rating >= 1 && rating <= 5) {
      hist[String(rating)] += 1;
      sum += rating;
      count += 1;
    }

    const comment = cleanStr(it?.comment, 2000);
    const name = cleanStr(it?.name, 80);
    if (comment) {
      comments.push({
        ts: cleanStr(it?.ts, 40),
        rating: (rating >= 1 && rating <= 5) ? rating : null,
        name: name || null,
        comment,
      });
    }
  }

  const avg = count ? (sum / count) : null;
  return {
    count,
    avgRating: avg == null ? null : Math.round(avg * 100) / 100,
    histogram: hist,
    comments: comments.slice(0, 10),
  };
}

function mdEscapeInline(s) {
  return String(s || '').replace(/\|/g, '\\|');
}

function buildMarkdownReport({ event, recap, recapPayload, mediaUrls, feedback, assignments }) {
  const propertyName = cleanStr(event?.meta?.propertyName || event?.title || '', 200);
  const when = cleanStr(event?.event_date || '', 20);
  const where = [cleanStr(event?.city, 80), cleanStr(event?.state, 20)].filter(Boolean).join(', ');
  const title = `Event Report — ${propertyName}${when ? ` — ${when}` : ''}`;

  const checklist = (event?.meta?.checklist && typeof event.meta.checklist === 'object') ? event.meta.checklist : {};
  const plan = (event?.meta?.plan && typeof event.meta.plan === 'object') ? event.meta.plan : {};
  const budget = (event?.meta?.budget && typeof event.meta.budget === 'object') ? event.meta.budget : {};

  const attendance = recapPayload?.attendanceEstimate != null ? String(recapPayload.attendanceEstimate) : '';
  const rating = cleanStr(recapPayload?.rating, 40);
  const issuesReported = cleanStr(recapPayload?.issuesReported, 20);

  const issuesDetails = cleanStr(recapPayload?.issuesDetails, 8000);
  const hostNotes = cleanStr(recapPayload?.hostNotes, 8000);
  const standouts = cleanStr(recapPayload?.standouts, 8000);
  const giveawayWinners = cleanStr(recapPayload?.giveawayWinners, 8000);
  const feedbackHighlights = cleanStr(recapPayload?.feedbackHighlights, 8000);
  const eventFlowDocUrl = cleanStr(recapPayload?.eventFlowDocUrl, 2000);

  const asgLines = Array.isArray(assignments) ? assignments.map((a) => {
    const r = cleanStr(a?.role, 40);
    const n = cleanStr(a?.label || a?.email || a?.userId || '', 200);
    const st = cleanStr(a?.status, 20);
    return `- ${r}: ${n}${st ? ` (${st})` : ''}`;
  }) : [];

  const mediaLines = (Array.isArray(mediaUrls) ? mediaUrls : []).map((u) => `- ${u}`);

  const feedbackLine = feedback?.count
    ? `- Submissions: ${feedback.count}${feedback.avgRating != null ? ` • Avg rating: ${feedback.avgRating}/5` : ''}`
    : '- Submissions: 0';

  const budgetTotal = (Number(budget.hostPayCents || 0) + Number(budget.mediaPayCents || 0) + Number(budget.foodCents || 0) + Number(budget.decorCents || 0) + Number(budget.suppliesCents || 0) + Number(budget.contingencyCents || 0));

  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`**Property:** ${mdEscapeInline(propertyName || '(unknown)')}`);
  lines.push(`**Date:** ${mdEscapeInline(when || '(unscheduled)')}`);
  if (where) lines.push(`**Location:** ${mdEscapeInline(where)}`);
  lines.push(`**Event ID:** ${String(event?.id || '')}`);
  lines.push('');

  lines.push('## Staffing');
  if (asgLines.length) lines.push(...asgLines);
  else lines.push('- (none assigned)');
  lines.push('');

  lines.push('## Attendance & resident feedback');
  if (attendance) lines.push(`- Attendance estimate: ${mdEscapeInline(attendance)}`);
  if (rating) lines.push(`- How it went: ${mdEscapeInline(rating)}`);
  if (issuesReported) lines.push(`- Issues reported: ${mdEscapeInline(issuesReported)}`);
  lines.push(feedbackLine);
  lines.push('');

  if (feedbackHighlights) {
    lines.push('### Feedback highlights');
    lines.push(feedbackHighlights);
    lines.push('');
  }

  if (feedback?.comments && feedback.comments.length) {
    lines.push('### Notable comments (sample)');
    for (const c of feedback.comments) {
      const who = c.name ? `${c.name}: ` : '';
      const rt = c.rating ? ` (${c.rating}/5)` : '';
      lines.push(`- ${who}${cleanStr(c.comment, 500)}${rt}`);
    }
    lines.push('');
  }

  lines.push('## Media');
  if (mediaLines.length) lines.push(...mediaLines);
  else lines.push('- (no media links yet)');
  if (eventFlowDocUrl) lines.push(`- Event flow doc: ${eventFlowDocUrl}`);
  lines.push('');

  if (standouts) {
    lines.push('## Standout moments / wins');
    lines.push(standouts);
    lines.push('');
  }

  if (giveawayWinners) {
    lines.push('## Giveaway winners');
    lines.push(giveawayWinners);
    lines.push('');
  }

  if (issuesDetails) {
    lines.push('## Issues & follow-ups');
    lines.push(issuesDetails);
    lines.push('');
  }

  if (hostNotes && hostNotes !== issuesDetails) {
    lines.push('## Host notes');
    lines.push(hostNotes);
    lines.push('');
  }

  lines.push('## Plan & budget');
  const strat = cleanStr(plan.strategy, 40);
  const et = cleanStr(plan.eventType, 200);
  const just = cleanStr(plan.justification, 5000);
  lines.push(`- Strategy: ${strat || '(not set)'}`);
  lines.push(`- Event type: ${et || '(not set)'}`);
  if (just) lines.push(`- Justification: ${just}`);
  lines.push('');
  lines.push(`- Budget (host): $${dollars(budget.hostPayCents || 0).toFixed(2)}`);
  lines.push(`- Budget (media): $${dollars(budget.mediaPayCents || 0).toFixed(2)}`);
  lines.push(`- Budget (food): $${dollars(budget.foodCents || 0).toFixed(2)}`);
  lines.push(`- Budget (decor): $${dollars(budget.decorCents || 0).toFixed(2)}`);
  lines.push(`- Budget (supplies): $${dollars(budget.suppliesCents || 0).toFixed(2)}`);
  lines.push(`- Budget (contingency): $${dollars(budget.contingencyCents || 0).toFixed(2)}`);
  lines.push(`- Budget (total planned): $${dollars(budgetTotal).toFixed(2)}`);
  lines.push('');

  lines.push('## Coordinator checklist');
  lines.push(`- Recap received: ${String(checklist.recapReceived || '') === 'yes' ? 'Yes' : 'No'}`);
  lines.push(`- Media received: ${String(checklist.mediaReceived || '') === 'yes' ? 'Yes' : 'No'}`);
  lines.push(`- Feedback received: ${String(checklist.feedbackReceived || '') === 'yes' ? 'Yes' : 'No'}`);
  lines.push(`- Report sent: ${String(checklist.reportSent || '') === 'yes' ? 'Yes' : 'No'}`);

  return lines.join('\n').trim() + '\n';
}

function stripMarkdown(md) {
  const s = String(md || '');
  return s
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1 ($2)')
    .replace(/^\s*-\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function loadUsersById(sbAdmin, userIds) {
  const ids = Array.isArray(userIds) ? userIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (!ids.length) return new Map();

  const listed = await sbAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const byId = new Map((listed?.data?.users || []).map((u) => [String(u.id), u]));
  return byId;
}

function normKey(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function loadAccountsStore(sbAdmin) {
  const { data, error } = await sbAdmin
    .from('purestay_kv')
    .select('value')
    .eq('key', 'portal:accounts:v1')
    .limit(1);
  if (error) return [];
  const row = Array.isArray(data) ? data[0] : null;
  const store = row?.value && typeof row.value === 'object' ? row.value : {};
  const list = Array.isArray(store.accounts) ? store.accounts : [];
  return list.filter((a) => a && typeof a === 'object');
}

function findAccountForEvent(accounts, ev) {
  const meta = ev?.meta && typeof ev.meta === 'object' ? ev.meta : {};
  const wantedId = cleanStr(meta.accountId, 80);
  if (wantedId) {
    const byId = accounts.find((a) => cleanStr(a?.id, 80) === wantedId);
    if (byId) return byId;
  }

  const propertyName = cleanStr(meta.propertyName || ev?.title || '', 200);
  const ek = normKey(propertyName);
  if (!ek) return null;

  const candidates = [];
  for (const a of accounts) {
    const ak = normKey(cleanStr(a?.propertyName || a?.name || '', 200));
    if (!ak) continue;
    if (ak === ek) return a;
    if (ak.includes(ek) || ek.includes(ak)) candidates.push(a);
  }

  // Only accept a fuzzy match if it's unambiguous.
  if (candidates.length === 1) return candidates[0];
  return null;
}

async function loadLeadAssignedUserId(sbAdmin, leadIdRaw) {
  const leadId = clampInt(leadIdRaw, 1, 1e12, null);
  if (!leadId) return null;
  const { data, error } = await sbAdmin
    .from('portal_leads')
    .select('id, assigned_user_id')
    .eq('id', leadId)
    .limit(1);
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : null;
  const uid = cleanStr(row?.assigned_user_id, 80);
  return uid || null;
}

async function deriveAccountOwnerEmails(sbAdmin, ev) {
  const accounts = await loadAccountsStore(sbAdmin);
  const acct = findAccountForEvent(accounts, ev);
  if (!acct) return { account: null, ownerEmails: [] };

  const leadId = cleanStr(acct?.leadId, 80);
  const ownerUserId = await loadLeadAssignedUserId(sbAdmin, leadId);
  if (!ownerUserId) return { account: acct, ownerEmails: [] };

  const byId = await loadUsersById(sbAdmin, [ownerUserId]);
  const email = cleanStr(byId.get(String(ownerUserId))?.email, 200);
  return { account: acct, ownerEmails: email ? [email.toLowerCase()] : [] };
}

async function deriveReportRecipients(sbAdmin) {
  const rolesIn = splitList(process.env.REPORT_TO_ROLES || 'account_manager,manager');
  const roles = Array.from(new Set(rolesIn.flatMap((r) => roleAliases(r))));
  const { data, error } = await sbAdmin
    .from('portal_profiles')
    .select('user_id, role')
    .in('role', roles)
    .limit(500);

  if (error || !Array.isArray(data)) return [];
  const ids = data.map((r) => String(r.user_id || '')).filter(Boolean);
  const byId = await loadUsersById(sbAdmin, ids);
  const emails = [];
  for (const id of ids) {
    const u = byId.get(String(id));
    const email = cleanStr(u?.email, 200);
    if (email) emails.push(email);
  }

  // Append explicit emails if configured.
  emails.push(...splitList(process.env.REPORT_TO_EMAILS || ''));

  // Dedup
  return Array.from(new Set(emails.map((e) => e.toLowerCase())));
}

async function deriveReportCcs(sbAdmin) {
  const rolesIn = splitList(process.env.REPORT_CC_ROLES || 'manager');
  const roles = Array.from(new Set(rolesIn.flatMap((r) => roleAliases(r))));
  if (!roles.length) return splitList(process.env.REPORT_CC_EMAILS || '').map((e) => e.toLowerCase());

  const { data, error } = await sbAdmin
    .from('portal_profiles')
    .select('user_id, role')
    .in('role', roles)
    .limit(500);

  const emails = [];
  if (!error && Array.isArray(data)) {
    const ids = data.map((r) => String(r.user_id || '')).filter(Boolean);
    const byId = await loadUsersById(sbAdmin, ids);
    for (const id of ids) {
      const u = byId.get(String(id));
      const email = cleanStr(u?.email, 200);
      if (email) emails.push(email);
    }
  }

  emails.push(...splitList(process.env.REPORT_CC_EMAILS || ''));
  return Array.from(new Set(emails.map((e) => e.toLowerCase())));
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const canView = hasRole(s.profile, ['event_coordinator', 'account_manager', 'manager']);
  if (!canView) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const url = new URL(req.url || '/api/portal/event_report', 'http://localhost');

  if (req.method === 'GET') {
    const eventId = clampInt(url.searchParams.get('eventId'), 1, 1e12, null);
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const { data: events, error: e1 } = await s.sbAdmin
      .from('portal_events')
      .select('*')
      .eq('id', eventId)
      .limit(1);

    if (e1) return sendJson(res, 500, { ok: false, error: 'event_lookup_failed' });
    const ev = Array.isArray(events) ? events[0] : null;
    if (!ev) return sendJson(res, 404, { ok: false, error: 'event_not_found' });

    // Best-effort account linkage for future recipient targeting.
    let linkedAccount = null;
    try {
      const { account } = await deriveAccountOwnerEmails(s.sbAdmin, ev);
      linkedAccount = account;
    } catch {
      linkedAccount = null;
    }

    const { data: recaps, error: e2 } = await s.sbAdmin
      .from('portal_event_recaps')
      .select('*')
      .eq('event_id', eventId)
      .order('id', { ascending: false })
      .limit(1);

    if (e2) return sendJson(res, 500, { ok: false, error: 'recaps_query_failed' });
    const recap = Array.isArray(recaps) ? recaps[0] : null;
    const recapPayload = recap?.payload && typeof recap.payload === 'object' ? recap.payload : {};
    const mediaUrls = Array.isArray(recap?.media_urls) ? recap.media_urls : [];

    const entries = await getLogTail(`portal:event_feedback:${eventId}`, 500);
    const fb = feedbackSummary(entries);

    const meta = ev.meta && typeof ev.meta === 'object' ? ev.meta : {};
    const assignments = Array.isArray(meta.assignments) ? meta.assignments : [];
    const userIds = assignments.map((a) => String(a?.userId || '')).filter(Boolean);

    const userMap = await loadUsersById(s.sbAdmin, userIds);
    const labeledAssignments = assignments.map((a) => {
      const u = userMap.get(String(a.userId));
      return {
        role: cleanStr(a?.role, 40),
        userId: cleanStr(a?.userId, 80),
        status: cleanStr(a?.status, 20),
        email: cleanStr(u?.email, 200),
        label: cleanStr(u?.user_metadata?.full_name || u?.email || a?.userId || '', 200),
      };
    });

    const markdown = buildMarkdownReport({
      event: ev,
      recap,
      recapPayload,
      mediaUrls,
      feedback: fb,
      assignments: labeledAssignments,
    });

    const plainText = stripMarkdown(markdown);

    const canPersist = hasRole(s.profile, ['event_coordinator', 'manager']) && !s.viewAsRole && !s.viewAsUserId && !s.effectiveUserId;
    if (canPersist) {
      const nextMeta = Object.assign({}, meta, {
        accountId: cleanStr(meta.accountId, 80) || cleanStr(linkedAccount?.id, 80) || undefined,
        reportDraft: {
          generatedAt: new Date().toISOString(),
          markdown,
          plainText,
          eventId,
          feedback: fb,
        },
      });
      if (nextMeta.accountId === undefined) delete nextMeta.accountId;
      await s.sbAdmin.from('portal_events').update({ meta: nextMeta }).eq('id', eventId);
    }

    return sendJson(res, 200, { ok: true, eventId, markdown, plainText, generatedAt: new Date().toISOString(), today: ymdTodayUtc() });
  }

  if (req.method === 'POST') {
    const canSend = hasRole(s.profile, ['event_coordinator', 'manager']);
    if (!canSend) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    if (s.viewAsRole || s.viewAsUserId || s.effectiveUserId) return sendJson(res, 403, { ok: false, error: 'read_only_view_as' });

    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const eventId = clampInt(body.eventId, 1, 1e12, null);
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const action = cleanStr(body.action, 30) || 'send';
    if (action !== 'send') return sendJson(res, 422, { ok: false, error: 'unknown_action' });

    const draft = body.draft && typeof body.draft === 'object' ? body.draft : null;
    const markdown = cleanStr(draft?.markdown || body.markdown, 200_000);
    const plainText = cleanStr(draft?.plainText || body.plainText, 200_000);

    if (!markdown && !plainText) return sendJson(res, 422, { ok: false, error: 'missing_draft_generate_first' });

    const { data: events, error: e1 } = await s.sbAdmin
      .from('portal_events')
      .select('id, title, event_date, meta')
      .eq('id', eventId)
      .limit(1);

    if (e1) return sendJson(res, 500, { ok: false, error: 'event_lookup_failed' });
    const ev = Array.isArray(events) ? events[0] : null;
    if (!ev) return sendJson(res, 404, { ok: false, error: 'event_not_found' });

    const propertyName = cleanStr(ev?.meta?.propertyName || ev?.title || '', 200);
    const when = cleanStr(ev?.event_date || '', 20);
    const subject = cleanStr(body.subject || `Event Report — ${propertyName}${when ? ` — ${when}` : ''}`, 300);

    const toEmails = Array.isArray(body.toEmails) ? body.toEmails : splitList(body.toEmails);
    const ccEmails = Array.isArray(body.ccEmails) ? body.ccEmails : splitList(body.ccEmails);

    const owner = await deriveAccountOwnerEmails(s.sbAdmin, ev);
    const recipients = toEmails.length
      ? toEmails
      : (owner.ownerEmails.length ? owner.ownerEmails : await deriveReportRecipients(s.sbAdmin));
    if (!recipients.length) return sendJson(res, 422, { ok: false, error: 'no_recipients' });

    const autoCcs = await deriveReportCcs(s.sbAdmin);
    const nextCcs = ccEmails.length ? ccEmails : autoCcs;

    const result = await notifyEmail({
      to: recipients,
      cc: nextCcs.length ? nextCcs : undefined,
      subject,
      text: plainText || stripMarkdown(markdown),
      html: null,
      dedupKey: `report:${eventId}:${ymdTodayUtc()}`,
      onceWithinMinutes: 10,
    });

    if (!result.ok) {
      return sendJson(res, 503, { ok: false, error: result.error || 'send_failed', provider: result.provider || null });
    }

    const meta = ev.meta && typeof ev.meta === 'object' ? ev.meta : {};
    const checklist = meta.checklist && typeof meta.checklist === 'object' ? meta.checklist : {};
    const nextChecklist = Object.assign({}, checklist, { reportSent: 'yes', updatedAt: new Date().toISOString() });

    const nextMeta = Object.assign({}, meta, {
      checklist: nextChecklist,
      accountId: cleanStr(meta.accountId, 80) || cleanStr(owner.account?.id, 80) || undefined,
      reportSentAt: new Date().toISOString(),
      reportSentTo: recipients,
      reportSentSubject: subject,
    });
    if (nextMeta.accountId === undefined) delete nextMeta.accountId;

    const { data: updatedRows } = await s.sbAdmin
      .from('portal_events')
      .update({ meta: nextMeta })
      .eq('id', eventId)
      .select('*')
      .limit(1);

    const updatedEvent = Array.isArray(updatedRows) ? updatedRows[0] : null;

    return sendJson(res, 200, {
      ok: true,
      eventId,
      sent: true,
      to: recipients,
      subject,
      provider: result.provider || null,
      providerId: result.id || null,
      event: updatedEvent,
    });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
