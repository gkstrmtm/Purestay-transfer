const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager } = require('../../lib/portalAuth');
const { cleanStr, tableExists, writePortalAudit } = require('../../lib/portalFoundation');
const { addHoursIso, buildActorMeta, emitOpsTrigger } = require('../../lib/portalOpsTriggers');
const { applyRoleFilter, buildRoleOrParts, roleMatchesAny } = require('../../lib/portalRoleAliases');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function normalizeTaskType(v) {
  const s = cleanStr(v, 20).toLowerCase();
  return ['dispatch', 'media', 'followup', 'account', 'training', 'event', 'lead', 'admin'].includes(s) ? s : '';
}

function normalizeTaskStatus(v) {
  const s = cleanStr(v, 20).toLowerCase();
  return ['open', 'in_progress', 'blocked', 'completed', 'cancelled'].includes(s) ? s : '';
}

function isActiveTaskStatus(status) {
  return ['open', 'in_progress', 'blocked'].includes(cleanStr(status, 20));
}

function isOverdueTask(task) {
  if (!isActiveTaskStatus(task?.status)) return false;
  const dueAt = cleanStr(task?.dueAt, 80);
  if (!dueAt) return false;
  const ms = new Date(dueAt).getTime();
  if (!Number.isFinite(ms)) return false;
  return ms < Date.now();
}

function mapTaskRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by || '',
    assignedUserId: row.assigned_user_id || '',
    approvedBy: row.approved_by || '',
    taskType: row.task_type,
    status: row.status,
    priority: Number(row.priority || 0),
    title: row.title || '',
    description: row.description || '',
    dueAt: row.due_at || null,
    leadId: row.lead_id || null,
    eventId: row.event_id || null,
    accountId: row.account_id || null,
    meta: row.meta && typeof row.meta === 'object' ? row.meta : {},
    source: 'portal_tasks',
  };
}

function mapLegacyDispatchTask(row) {
  const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
  const dueAt = row.event_date ? `${row.event_date}T${cleanStr(row.start_time, 20) || '00:00'}:00Z` : null;
  return {
    id: `dispatch:${row.id}`,
    createdAt: row.created_at,
    updatedAt: row.created_at,
    createdBy: row.created_by || '',
    assignedUserId: row.assigned_user_id || '',
    approvedBy: '',
    taskType: 'dispatch',
    status: row.status || 'open',
    priority: Number(meta.priority || 0),
    title: row.title || '',
    description: row.notes || '',
    dueAt,
    leadId: meta.leadId || null,
    eventId: meta.eventId || null,
    accountId: meta.accountId || null,
    meta,
    source: 'legacy_dispatch',
  };
}

async function runTaskTriggers(sbAdmin, session, beforeTask, afterTask) {
  const actorMeta = buildActorMeta(session);
  const assigneeUserId = cleanStr(afterTask?.assignedUserId || afterTask?.createdBy || session?.realActorUserId || session?.user?.id, 80) || null;
  const entityId = String(afterTask?.id || beforeTask?.id || '');
  if (!entityId) return;

  if (cleanStr(beforeTask?.status, 20) !== 'blocked' && cleanStr(afterTask?.status, 20) === 'blocked') {
    await emitOpsTrigger(sbAdmin, {
      actorUserId: session.realActorUserId || session.user.id,
      ownerUserId: assigneeUserId,
      entityType: 'task',
      entityId,
      eventType: 'task_blocked',
      priority: 8,
      sourceTable: 'portal_tasks',
      sourceId: entityId,
      payload: { before: beforeTask, after: afterTask },
      meta: actorMeta,
      dedupKey: `task_blocked:task:${entityId}:${afterTask?.updatedAt || ''}`,
      task: {
        assignedUserId: assigneeUserId,
        taskType: 'admin',
        priority: 8,
        dueAt: addHoursIso(12),
        title: `Resolve blocked task${afterTask?.title ? `: ${afterTask.title}` : ''}`,
        description: cleanStr(afterTask?.description || 'Review blocker, dependencies, and owner escalation.', 5000),
        meta: { taskId: afterTask?.id || null, trigger: 'task_blocked' },
      },
      notification: assigneeUserId ? {
        userId: assigneeUserId,
        channel: 'in_app',
        subject: 'Task blocked',
        bodyText: cleanStr(afterTask?.title || `Task ${entityId} is blocked and needs review.`, 8000),
        meta: { taskId: afterTask?.id || null, trigger: 'task_blocked' },
      } : null,
    }).catch(() => {});
  }

  if ((!beforeTask || !isOverdueTask(beforeTask)) && isOverdueTask(afterTask)) {
    await emitOpsTrigger(sbAdmin, {
      actorUserId: session.realActorUserId || session.user.id,
      ownerUserId: assigneeUserId,
      entityType: 'task',
      entityId,
      eventType: 'task_overdue',
      priority: 7,
      sourceTable: 'portal_tasks',
      sourceId: entityId,
      payload: { before: beforeTask, after: afterTask },
      meta: actorMeta,
      dedupKey: `task_overdue:task:${entityId}:${afterTask?.dueAt || ''}`,
      task: {
        assignedUserId: assigneeUserId,
        taskType: 'admin',
        priority: 7,
        dueAt: addHoursIso(6),
        title: `Resolve overdue task${afterTask?.title ? `: ${afterTask.title}` : ''}`,
        description: cleanStr(afterTask?.description || 'Review the overdue work and reset the next action.', 5000),
        meta: { taskId: afterTask?.id || null, trigger: 'task_overdue' },
      },
      notification: assigneeUserId ? {
        userId: assigneeUserId,
        channel: 'in_app',
        subject: 'Task overdue',
        bodyText: cleanStr(afterTask?.title || `Task ${entityId} is overdue.`, 8000),
        meta: { taskId: afterTask?.id || null, trigger: 'task_overdue' },
      } : null,
    }).catch(() => {});
  }
}

async function listLegacyDispatchTasks(s, { status, limit, q, mineOnly }) {
  let query = s.sbAdmin
    .from('portal_events')
    .select('*')
    .or('area_tag.eq.dispatch,meta->>kind.eq.dispatch')
    .order('event_date', { ascending: true })
    .order('id', { ascending: false })
    .limit(limit);

  if (status) query = query.eq('status', status);

  if (!isManager(s.profile)) {
    const uid = String(s.actorUserId || s.user.id || '');
    const role = String(s.profile?.role || '');
    if (mineOnly) {
      query = query.or([`assigned_user_id.eq.${uid}`, `created_by.eq.${uid}`].join(','));
    } else {
      const parts = [`assigned_user_id.eq.${uid}`, `created_by.eq.${uid}`];
      if (role) parts.push(...buildRoleOrParts('assigned_role', role));
      query = query.or(parts.join(','));
    }
  }

  const { data, error } = await query;
  if (error) return { ok: false, error: 'legacy_tasks_query_failed', detail: error.message || '' };

  let rows = Array.isArray(data) ? data : [];
  if (q) {
    rows = rows.filter((row) => {
      const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
      const hay = [row.title, row.notes, meta.reason, meta.leadLabel]
        .map((x) => String(x || '').toLowerCase())
        .join(' ');
      return hay.includes(q);
    });
  }

  return { ok: true, tasks: rows.map(mapLegacyDispatchTask) };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const url = new URL(req.url || '/api/portal/tasks', 'http://localhost');
  const status = normalizeTaskStatus(url.searchParams.get('status'));
  const taskType = normalizeTaskType(url.searchParams.get('taskType'));
  const q = cleanStr(url.searchParams.get('q'), 200).toLowerCase();
  const requestedAssignedUserId = cleanStr(url.searchParams.get('assignedUserId'), 80);
  const mineOnly = cleanStr(url.searchParams.get('mine'), 10) === '1';
  const limit = clampInt(url.searchParams.get('limit'), 1, 200, 80);

  const hasPortalTasks = await tableExists(s.sbAdmin, 'portal_tasks');

  if (req.method === 'GET') {
    if (!hasPortalTasks) {
      const legacy = await listLegacyDispatchTasks(s, { status, limit, q, mineOnly: true });
      if (!legacy.ok) return sendJson(res, 500, { ok: false, error: legacy.error, detail: legacy.detail || '' });
      return sendJson(res, 200, {
        ok: true,
        tasks: legacy.tasks,
        source: 'legacy_dispatch',
        ready: false,
        warning: 'foundation_phase1_not_applied',
      });
    }

    let query = s.sbAdmin
      .from('portal_tasks')
      .select('*')
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('priority', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);
    if (taskType) query = query.eq('task_type', taskType);
    if (requestedAssignedUserId) query = query.eq('assigned_user_id', requestedAssignedUserId);

    if (!isManager(s.profile)) {
      const uid = String(s.actorUserId || s.user.id || '');
      query = query.or([`assigned_user_id.eq.${uid}`, `created_by.eq.${uid}`].join(','));
    }

    const { data, error } = await query;
    if (error) return sendJson(res, 500, { ok: false, error: 'tasks_query_failed', detail: error.message || '' });

    let tasks = (Array.isArray(data) ? data : []).map(mapTaskRow);
    if (mineOnly && !isManager(s.profile)) {
      const uid = String(s.actorUserId || s.user.id || '');
      tasks = tasks.filter((t) => t.assignedUserId === uid || t.createdBy === uid);
    }
    if (q) {
      tasks = tasks.filter((task) => {
        const hay = [task.title, task.description, task.taskType, task.status, task.meta?.reason]
          .map((x) => String(x || '').toLowerCase())
          .join(' ');
        return hay.includes(q);
      });
    }

    return sendJson(res, 200, { ok: true, tasks, source: 'portal_tasks', ready: true });
  }

  if (req.method === 'POST') {
    if (!hasPortalTasks) return sendJson(res, 503, { ok: false, error: 'foundation_phase1_not_applied' });
    if (!hasRole(s.profile, ['manager', 'event_coordinator', 'account_manager'])) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const nextTaskType = normalizeTaskType(body.taskType);
    const title = cleanStr(body.title, 200);
    if (!nextTaskType) return sendJson(res, 422, { ok: false, error: 'invalid_task_type' });
    if (!title) return sendJson(res, 422, { ok: false, error: 'missing_title' });

    const insertRow = {
      created_by: s.actorUserId,
      assigned_user_id: cleanStr(body.assignedUserId, 80) || null,
      approved_by: cleanStr(body.approvedBy, 80) || null,
      task_type: nextTaskType,
      status: normalizeTaskStatus(body.status) || 'open',
      priority: clampInt(body.priority, -5, 10, 0),
      title,
      description: cleanStr(body.description, 5000) || null,
      due_at: cleanStr(body.dueAt, 80) || null,
      lead_id: clampInt(body.leadId, 1, 1e12, null),
      event_id: clampInt(body.eventId, 1, 1e12, null),
      account_id: clampInt(body.accountId, 1, 1e12, null),
      meta: body.meta && typeof body.meta === 'object' ? body.meta : {},
    };

    const { data, error } = await s.sbAdmin
      .from('portal_tasks')
      .insert(insertRow)
      .select('*')
      .limit(1);
    if (error) return sendJson(res, 500, { ok: false, error: 'task_insert_failed', detail: error.message || '' });

    const created = mapTaskRow(Array.isArray(data) ? data[0] : null);
    await writePortalAudit(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      entityType: 'task',
      entityId: String(created?.id || ''),
      action: 'create',
      beforePayload: null,
      afterPayload: created,
      meta: {
        realActorUserId: s.realActorUserId || s.user.id,
        effectiveActorUserId: s.actorUserId || null,
        realRole: s.realProfile?.role || null,
        effectiveRole: s.profile?.role || null,
        viewAsRole: s.viewAsRole || null,
        viewAsUserId: s.viewAsUserId || null,
        impersonating: !!s.impersonating,
      },
    }).catch(() => {});

    await runTaskTriggers(s.sbAdmin, s, null, created).catch(() => {});

    return sendJson(res, 200, { ok: true, task: created });
  }

  if (req.method !== 'PATCH') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!hasPortalTasks) return sendJson(res, 503, { ok: false, error: 'foundation_phase1_not_applied' });

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const taskId = clampInt(body.id, 1, 1e12, null);
  if (!taskId) return sendJson(res, 422, { ok: false, error: 'missing_task_id' });

  const { data: existing, error: lookupError } = await s.sbAdmin
    .from('portal_tasks')
    .select('*')
    .eq('id', taskId)
    .limit(1);
  if (lookupError) return sendJson(res, 500, { ok: false, error: 'task_lookup_failed', detail: lookupError.message || '' });
  const row = Array.isArray(existing) ? existing[0] || null : null;
  if (!row) return sendJson(res, 404, { ok: false, error: 'task_not_found' });

  const uid = String(s.actorUserId || s.user.id || '');
  const canEdit = isManager(s.profile)
    || hasRole(s.profile, ['event_coordinator', 'account_manager'])
    || String(row.assigned_user_id || '') === uid
    || String(row.created_by || '') === uid;
  if (!canEdit) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const patch = {
    assigned_user_id: body.assignedUserId != null ? (cleanStr(body.assignedUserId, 80) || null) : undefined,
    approved_by: body.approvedBy != null ? (cleanStr(body.approvedBy, 80) || null) : undefined,
    task_type: body.taskType != null ? normalizeTaskType(body.taskType) : undefined,
    status: body.status != null ? normalizeTaskStatus(body.status) : undefined,
    priority: body.priority != null ? clampInt(body.priority, -5, 10, 0) : undefined,
    title: body.title != null ? cleanStr(body.title, 200) : undefined,
    description: body.description != null ? (cleanStr(body.description, 5000) || null) : undefined,
    due_at: body.dueAt != null ? (cleanStr(body.dueAt, 80) || null) : undefined,
    lead_id: body.leadId != null ? clampInt(body.leadId, 1, 1e12, null) : undefined,
    event_id: body.eventId != null ? clampInt(body.eventId, 1, 1e12, null) : undefined,
    account_id: body.accountId != null ? clampInt(body.accountId, 1, 1e12, null) : undefined,
    meta: body.meta != null && body.meta && typeof body.meta === 'object' ? body.meta : undefined,
    updated_at: new Date().toISOString(),
  };

  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined || patch[key] === '') delete patch[key];
  }
  if (!Object.keys(patch).length) return sendJson(res, 200, { ok: true, task: mapTaskRow(row) });
  if (patch.task_type === '') delete patch.task_type;
  if (patch.status === '') delete patch.status;

  const { data, error } = await s.sbAdmin
    .from('portal_tasks')
    .update(patch)
    .eq('id', taskId)
    .select('*')
    .limit(1);
  if (error) return sendJson(res, 500, { ok: false, error: 'task_update_failed', detail: error.message || '' });

  const updated = mapTaskRow(Array.isArray(data) ? data[0] : row);
  await writePortalAudit(s.sbAdmin, {
    actorUserId: s.realActorUserId || s.user.id,
    entityType: 'task',
    entityId: String(taskId),
    action: 'update',
    beforePayload: mapTaskRow(row),
    afterPayload: updated,
    meta: {
      realActorUserId: s.realActorUserId || s.user.id,
      effectiveActorUserId: s.actorUserId || null,
      realRole: s.realProfile?.role || null,
      effectiveRole: s.profile?.role || null,
      viewAsRole: s.viewAsRole || null,
      viewAsUserId: s.viewAsUserId || null,
      impersonating: !!s.impersonating,
    },
  }).catch(() => {});

  await runTaskTriggers(s.sbAdmin, s, mapTaskRow(row), updated).catch(() => {});

  return sendJson(res, 200, { ok: true, task: updated });
};
