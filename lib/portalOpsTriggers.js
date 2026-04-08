const {
  cleanStr,
  tableExists,
  writePortalWorkflowEvent,
  enqueuePortalNotification,
} = require('./portalFoundation');

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function addHoursIso(hours) {
  return new Date(Date.now() + Math.max(0, Number(hours || 0)) * 60 * 60 * 1000).toISOString();
}

function buildActorMeta(session, extra = {}) {
  return Object.assign({
    realActorUserId: cleanStr(session?.realActorUserId || session?.user?.id, 80) || null,
    effectiveActorUserId: cleanStr(session?.actorUserId, 80) || null,
    realRole: cleanStr(session?.realProfile?.role, 40) || null,
    effectiveRole: cleanStr(session?.profile?.role, 40) || null,
    viewAsRole: cleanStr(session?.viewAsRole, 40) || null,
    viewAsUserId: cleanStr(session?.viewAsUserId, 80) || null,
    impersonating: !!session?.impersonating,
  }, extra);
}

async function writeWorkflowEventOnce(sbAdmin, payload = {}) {
  const dedupKey = cleanStr(payload.dedupKey, 200);
  if (dedupKey && await tableExists(sbAdmin, 'portal_workflow_events')) {
    const { data, error } = await sbAdmin
      .from('portal_workflow_events')
      .select('*')
      .eq('dedup_key', dedupKey)
      .limit(1);
    if (!error && Array.isArray(data) && data[0]) return { ok: true, event: data[0], duplicate: true };
  }
  return writePortalWorkflowEvent(sbAdmin, Object.assign({}, payload, { dedupKey }));
}

async function enqueueNotificationOnce(sbAdmin, payload = {}) {
  const dedupKey = cleanStr(payload.dedupKey, 200);
  if (dedupKey && await tableExists(sbAdmin, 'portal_notification_queue')) {
    const { data, error } = await sbAdmin
      .from('portal_notification_queue')
      .select('*')
      .eq('dedup_key', dedupKey)
      .limit(1);
    if (!error && Array.isArray(data) && data[0]) return { ok: true, notification: data[0], duplicate: true };
  }
  return enqueuePortalNotification(sbAdmin, Object.assign({}, payload, { dedupKey }));
}

async function createPortalTaskIfMissing(sbAdmin, {
  createdBy,
  assignedUserId = '',
  approvedBy = '',
  taskType = 'admin',
  status = 'open',
  priority = 0,
  title,
  description = '',
  dueAt = null,
  leadId = null,
  eventId = null,
  accountId = null,
  meta = {},
  dedupKey = '',
} = {}) {
  if (!(await tableExists(sbAdmin, 'portal_tasks'))) return { ok: true, skipped: true, reason: 'portal_tasks_missing' };

  const cleanTitle = cleanStr(title, 200);
  if (!cleanTitle) return { ok: false, error: 'missing_task_title' };

  const cleanDedupKey = cleanStr(dedupKey, 200);
  if (cleanDedupKey) {
    const { data, error } = await sbAdmin
      .from('portal_tasks')
      .select('*')
      .contains('meta', { opsDedupKey: cleanDedupKey })
      .in('status', ['open', 'in_progress', 'blocked'])
      .limit(1);
    if (!error && Array.isArray(data) && data[0]) return { ok: true, task: data[0], duplicate: true };
  }

  const row = {
    created_by: cleanStr(createdBy, 80) || null,
    assigned_user_id: cleanStr(assignedUserId, 80) || null,
    approved_by: cleanStr(approvedBy, 80) || null,
    task_type: ['dispatch', 'media', 'followup', 'account', 'training', 'event', 'lead', 'admin'].includes(cleanStr(taskType, 20)) ? cleanStr(taskType, 20) : 'admin',
    status: ['open', 'in_progress', 'blocked', 'completed', 'cancelled'].includes(cleanStr(status, 20)) ? cleanStr(status, 20) : 'open',
    priority: clampInt(priority, -5, 10, 0),
    title: cleanTitle,
    description: cleanStr(description, 5000) || null,
    due_at: cleanStr(dueAt, 80) || null,
    lead_id: Number.isFinite(Number(leadId)) ? Math.trunc(Number(leadId)) : null,
    event_id: Number.isFinite(Number(eventId)) ? Math.trunc(Number(eventId)) : null,
    account_id: Number.isFinite(Number(accountId)) ? Math.trunc(Number(accountId)) : null,
    meta: Object.assign({}, asObject(meta), cleanDedupKey ? { opsDedupKey: cleanDedupKey } : {}),
  };

  const { data, error } = await sbAdmin
    .from('portal_tasks')
    .insert(row)
    .select('*')
    .limit(1);
  if (error) return { ok: false, error: 'portal_task_create_failed', detail: error.message || '' };
  return { ok: true, task: Array.isArray(data) ? data[0] || null : null };
}

async function emitOpsTrigger(sbAdmin, {
  actorUserId,
  ownerUserId = '',
  entityType,
  entityId,
  eventType,
  priority = 0,
  sourceTable = '',
  sourceId = '',
  intakeSubmissionId = null,
  onboardingJourneyId = null,
  payload = {},
  meta = {},
  dedupKey = '',
  task = null,
  notification = null,
} = {}) {
  const workflow = await writeWorkflowEventOnce(sbAdmin, {
    actorUserId,
    ownerUserId,
    entityType,
    entityId,
    eventType,
    priority,
    status: 'pending',
    sourceTable,
    sourceId,
    intakeSubmissionId,
    onboardingJourneyId,
    payload: asObject(payload),
    meta: asObject(meta),
    dedupKey,
  });

  let taskResult = null;
  if (task) {
    taskResult = await createPortalTaskIfMissing(sbAdmin, Object.assign({}, task, {
      createdBy: task.createdBy || actorUserId,
      dedupKey: task.dedupKey || (dedupKey ? `task:${dedupKey}` : ''),
      meta: Object.assign({}, asObject(task.meta), {
        workflowEventType: cleanStr(eventType, 80),
        workflowEntityType: cleanStr(entityType, 80),
        workflowEntityId: cleanStr(entityId, 160),
      }),
    }));
  }

  let notificationResult = null;
  if (notification && cleanStr(notification.userId, 80)) {
    notificationResult = await enqueueNotificationOnce(sbAdmin, {
      createdBy: notification.createdBy || actorUserId,
      userId: notification.userId,
      workflowEventId: workflow?.event?.id || null,
      channel: cleanStr(notification.channel, 20) || 'in_app',
      status: 'pending',
      templateKey: cleanStr(notification.templateKey, 80) || eventType,
      subject: cleanStr(notification.subject, 300),
      bodyText: cleanStr(notification.bodyText, 8000),
      bodyHtml: cleanStr(notification.bodyHtml, 20000),
      toEmail: cleanStr(notification.toEmail, 320),
      toPhone: cleanStr(notification.toPhone, 40),
      scheduledFor: cleanStr(notification.scheduledFor, 80) || null,
      entityType,
      entityId,
      meta: Object.assign({}, asObject(notification.meta), { eventType }),
      dedupKey: notification.dedupKey || (dedupKey ? `notification:${dedupKey}:${cleanStr(notification.userId, 80)}` : ''),
    });
  }

  return { ok: true, workflow, task: taskResult, notification: notificationResult };
}

module.exports = {
  addHoursIso,
  asObject,
  buildActorMeta,
  createPortalTaskIfMissing,
  emitOpsTrigger,
  enqueueNotificationOnce,
  writeWorkflowEventOnce,
};
