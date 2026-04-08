const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');
const { cleanStr, tableExists, enqueuePortalNotification } = require('../../lib/portalFoundation');
const { addHoursIso, buildActorMeta, emitOpsTrigger } = require('../../lib/portalOpsTriggers');

const OPERATOR_ROLES = ['manager', 'territory_specialist', 'event_coordinator', 'account_manager'];

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function canOperate(profile) {
  return hasRole(profile, OPERATOR_ROLES);
}

function normalizeChannel(v) {
  const s = cleanStr(v, 20).toLowerCase();
  return ['email', 'sms', 'in_app', 'webhook'].includes(s) ? s : '';
}

function normalizeStatus(v, fallback = '') {
  const s = cleanStr(v, 20).toLowerCase();
  return ['pending', 'processing', 'sent', 'failed', 'cancelled'].includes(s) ? s : fallback;
}

function mapQueueRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scheduledFor: row.scheduled_for || null,
    sentAt: row.sent_at || null,
    createdBy: row.created_by || '',
    userId: row.user_id || '',
    workflowEventId: row.workflow_event_id || null,
    channel: row.channel || '',
    status: row.status || '',
    templateKey: row.template_key || '',
    toEmail: row.to_email || '',
    toPhone: row.to_phone || '',
    subject: row.subject || '',
    bodyText: row.body_text || '',
    bodyHtml: row.body_html || '',
    dedupKey: row.dedup_key || '',
    entityType: row.entity_type || '',
    entityId: row.entity_id || '',
    attemptCount: Number(row.attempt_count || 0),
    lastError: row.last_error || '',
    meta: asObject(row.meta),
  };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!(await tableExists(s.sbAdmin, 'portal_notification_queue'))) {
    return sendJson(res, 503, { ok: false, error: 'workflow_foundation_not_applied' });
  }

  const url = new URL(req.url || '/api/portal/notifications', 'http://localhost');
  const actorUserId = String(s.actorUserId || s.user.id || '');
  const operator = canOperate(s.realProfile);

  if (req.method === 'GET') {
    const id = clampInt(url.searchParams.get('id'), 1, 1e12, null);
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 80);
    const status = normalizeStatus(url.searchParams.get('status'));
    const channel = normalizeChannel(url.searchParams.get('channel'));
    const userId = cleanStr(url.searchParams.get('userId'), 80);

    let query = s.sbAdmin
      .from('portal_notification_queue')
      .select('*')
      .order('scheduled_for', { ascending: true, nullsFirst: true })
      .order('id', { ascending: false })
      .limit(limit);

    if (id) query = query.eq('id', id);
    if (status) query = query.eq('status', status);
    if (channel) query = query.eq('channel', channel);
    if (userId && operator) query = query.eq('user_id', userId);
    if (!operator) query = query.eq('user_id', actorUserId);

    const { data, error } = await query;
    if (error) return sendJson(res, 500, { ok: false, error: 'notifications_query_failed', detail: error.message || '' });

    return sendJson(res, 200, { ok: true, notifications: (Array.isArray(data) ? data : []).map(mapQueueRow) });
  }

  if (req.method === 'POST') {
    if (!operator) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const channel = normalizeChannel(body.channel);
    if (!channel) return sendJson(res, 422, { ok: false, error: 'invalid_channel' });

    const queued = await enqueuePortalNotification(s.sbAdmin, {
      createdBy: s.realActorUserId || s.user.id,
      userId: cleanStr(body.userId, 80),
      workflowEventId: clampInt(body.workflowEventId, 1, 1e12, null),
      channel,
      status: normalizeStatus(body.status, 'pending') || 'pending',
      templateKey: cleanStr(body.templateKey, 80),
      toEmail: cleanStr(body.toEmail, 320),
      toPhone: cleanStr(body.toPhone, 40),
      subject: cleanStr(body.subject, 300),
      bodyText: cleanStr(body.bodyText, 8000),
      bodyHtml: cleanStr(body.bodyHtml, 20000),
      dedupKey: cleanStr(body.dedupKey, 200),
      scheduledFor: cleanStr(body.scheduledFor, 80),
      entityType: cleanStr(body.entityType, 80),
      entityId: cleanStr(body.entityId, 160),
      meta: asObject(body.meta),
    });

    if (!queued.ok) {
      return sendJson(res, 500, { ok: false, error: queued.error || 'notification_queue_failed', detail: queued.detail || '' });
    }

    return sendJson(res, 200, { ok: true, notification: mapQueueRow(queued.notification) });
  }

  if (req.method !== 'PATCH') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!operator) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const id = clampInt(body.id, 1, 1e12, null);
  if (!id) return sendJson(res, 422, { ok: false, error: 'missing_notification_id' });

  const { data: existingRows, error: lookupError } = await s.sbAdmin
    .from('portal_notification_queue')
    .select('*')
    .eq('id', id)
    .limit(1);
  if (lookupError) return sendJson(res, 500, { ok: false, error: 'notification_lookup_failed', detail: lookupError.message || '' });
  const beforeRow = Array.isArray(existingRows) ? existingRows[0] || null : null;
  if (!beforeRow) return sendJson(res, 404, { ok: false, error: 'notification_not_found' });

  const patch = {
    updated_at: new Date().toISOString(),
    status: body.status != null ? (normalizeStatus(body.status) || undefined) : undefined,
    scheduled_for: body.scheduledFor != null ? (cleanStr(body.scheduledFor, 80) || null) : undefined,
    sent_at: body.sentAt != null
      ? (cleanStr(body.sentAt, 80) || null)
      : (normalizeStatus(body.status) === 'sent' ? new Date().toISOString() : undefined),
    attempt_count: body.attemptCount != null ? clampInt(body.attemptCount, 0, 1000, 0) : undefined,
    last_error: body.lastError != null ? (cleanStr(body.lastError, 2000) || null) : undefined,
    meta: body.meta != null ? asObject(body.meta) : undefined,
  };
  Object.keys(patch).forEach((key) => patch[key] === undefined && delete patch[key]);

  const { data, error } = await s.sbAdmin
    .from('portal_notification_queue')
    .update(patch)
    .eq('id', id)
    .select('*')
    .limit(1);
  if (error) return sendJson(res, 500, { ok: false, error: 'notification_update_failed', detail: error.message || '' });

  const row = Array.isArray(data) ? data[0] || null : null;
  if (!row) return sendJson(res, 404, { ok: false, error: 'notification_not_found' });

  if (cleanStr(beforeRow.status, 20) !== 'failed' && cleanStr(row.status, 20) === 'failed') {
    const ownerUserId = cleanStr(row.created_by || row.user_id || s.realActorUserId || s.user.id, 80) || null;
    await emitOpsTrigger(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      ownerUserId,
      entityType: 'notification',
      entityId: String(id),
      eventType: 'notification_failed',
      priority: 8,
      sourceTable: 'portal_notification_queue',
      sourceId: String(id),
      payload: { before: mapQueueRow(beforeRow), after: mapQueueRow(row) },
      meta: buildActorMeta(s),
      dedupKey: `notification_failed:notification:${id}:${row.attempt_count || 0}`,
      task: {
        assignedUserId: ownerUserId,
        taskType: 'admin',
        priority: 7,
        dueAt: addHoursIso(12),
        title: `Resolve failed notification${row.subject ? `: ${row.subject}` : ''}`,
        description: cleanStr(row.last_error || row.body_text || 'Review retry path and fallback channel.', 5000),
        meta: { notificationId: id, trigger: 'notification_failed' },
      },
      notification: ownerUserId ? {
        userId: ownerUserId,
        channel: 'in_app',
        subject: 'Notification failed',
        bodyText: cleanStr(row.subject || `Notification ${id} failed and needs review.`, 8000),
        meta: { notificationId: id, trigger: 'notification_failed' },
      } : null,
    }).catch(() => {});
  }

  return sendJson(res, 200, { ok: true, notification: mapQueueRow(row) });
};
