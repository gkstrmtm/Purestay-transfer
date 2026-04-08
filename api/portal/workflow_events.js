const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');
const { cleanStr, tableExists, writePortalWorkflowEvent } = require('../../lib/portalFoundation');
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

function normalizeStatus(v, fallback = '') {
  const s = cleanStr(v, 20).toLowerCase();
  return ['pending', 'processing', 'processed', 'failed', 'cancelled'].includes(s) ? s : fallback;
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    occurredAt: row.occurred_at,
    processedAt: row.processed_at || null,
    actorUserId: row.actor_user_id || '',
    ownerUserId: row.owner_user_id || '',
    entityType: row.entity_type || '',
    entityId: row.entity_id || '',
    eventType: row.event_type || '',
    status: row.status || '',
    priority: Number(row.priority || 0),
    sourceTable: row.source_table || '',
    sourceId: row.source_id || '',
    intakeSubmissionId: row.intake_submission_id || null,
    onboardingJourneyId: row.onboarding_journey_id || null,
    payload: asObject(row.payload),
    resultPayload: row.result_payload && typeof row.result_payload === 'object' ? row.result_payload : row.result_payload ?? null,
    errorText: row.error_text || '',
    dedupKey: row.dedup_key || '',
    meta: asObject(row.meta),
  };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!(await tableExists(s.sbAdmin, 'portal_workflow_events'))) {
    return sendJson(res, 503, { ok: false, error: 'workflow_foundation_not_applied' });
  }

  const url = new URL(req.url || '/api/portal/workflow_events', 'http://localhost');
  const actorUserId = String(s.actorUserId || s.user.id || '');
  const operator = canOperate(s.realProfile);
  const id = clampInt(url.searchParams.get('id'), 1, 1e12, null);
  const limit = clampInt(url.searchParams.get('limit'), 1, 200, 80);
  const status = normalizeStatus(url.searchParams.get('status'));
  const entityType = cleanStr(url.searchParams.get('entityType'), 80);
  const entityId = cleanStr(url.searchParams.get('entityId'), 160);
  const eventType = cleanStr(url.searchParams.get('eventType'), 80);
  const ownerUserId = cleanStr(url.searchParams.get('ownerUserId'), 80);

  if (req.method === 'GET') {
    let query = s.sbAdmin
      .from('portal_workflow_events')
      .select('*')
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);

    if (id) query = query.eq('id', id);
    if (status) query = query.eq('status', status);
    if (entityType) query = query.eq('entity_type', entityType);
    if (entityId) query = query.eq('entity_id', entityId);
    if (eventType) query = query.eq('event_type', eventType);
    if (ownerUserId && operator) query = query.eq('owner_user_id', ownerUserId);
    if (!operator) {
      query = query.or([`actor_user_id.eq.${actorUserId}`, `owner_user_id.eq.${actorUserId}`].join(','));
    }

    const { data, error } = await query;
    if (error) return sendJson(res, 500, { ok: false, error: 'workflow_events_query_failed', detail: error.message || '' });

    return sendJson(res, 200, { ok: true, events: (Array.isArray(data) ? data : []).map(mapEvent) });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const nextEntityType = cleanStr(body.entityType, 80);
    const nextEntityId = cleanStr(body.entityId, 160);
    const nextEventType = cleanStr(body.eventType, 80);
    if (!nextEntityType || !nextEntityId || !nextEventType) {
      return sendJson(res, 422, { ok: false, error: 'missing_event_fields' });
    }

    const requestedOwnerUserId = cleanStr(body.ownerUserId, 80) || actorUserId;
    if (!operator && requestedOwnerUserId !== actorUserId) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const created = await writePortalWorkflowEvent(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      ownerUserId: requestedOwnerUserId,
      entityType: nextEntityType,
      entityId: nextEntityId,
      eventType: nextEventType,
      status: normalizeStatus(body.status, 'pending') || 'pending',
      priority: clampInt(body.priority, -5, 10, 0),
      sourceTable: cleanStr(body.sourceTable, 80),
      sourceId: cleanStr(body.sourceId, 160),
      intakeSubmissionId: clampInt(body.intakeSubmissionId, 1, 1e12, null),
      onboardingJourneyId: clampInt(body.onboardingJourneyId, 1, 1e12, null),
      payload: asObject(body.payload),
      resultPayload: body.resultPayload && typeof body.resultPayload === 'object' ? body.resultPayload : null,
      errorText: cleanStr(body.errorText, 2000),
      dedupKey: cleanStr(body.dedupKey, 200),
      meta: asObject(body.meta),
    });

    if (!created.ok) {
      return sendJson(res, 500, { ok: false, error: created.error || 'workflow_event_create_failed', detail: created.detail || '' });
    }

    return sendJson(res, 200, { ok: true, event: mapEvent(created.event) });
  }

  if (req.method !== 'PATCH') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!operator) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const eventId = clampInt(body.id, 1, 1e12, null);
  if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

  const { data: existingRows, error: lookupError } = await s.sbAdmin
    .from('portal_workflow_events')
    .select('*')
    .eq('id', eventId)
    .limit(1);
  if (lookupError) return sendJson(res, 500, { ok: false, error: 'workflow_event_lookup_failed', detail: lookupError.message || '' });
  const beforeRow = Array.isArray(existingRows) ? existingRows[0] || null : null;
  if (!beforeRow) return sendJson(res, 404, { ok: false, error: 'workflow_event_not_found' });

  const patch = {
    status: body.status != null ? (normalizeStatus(body.status) || undefined) : undefined,
    priority: body.priority != null ? clampInt(body.priority, -5, 10, 0) : undefined,
    result_payload: body.resultPayload != null ? (body.resultPayload && typeof body.resultPayload === 'object' ? body.resultPayload : null) : undefined,
    error_text: body.errorText != null ? (cleanStr(body.errorText, 2000) || null) : undefined,
    meta: body.meta != null ? asObject(body.meta) : undefined,
    processed_at: body.processedAt != null
      ? (cleanStr(body.processedAt, 80) || null)
      : (['processed', 'failed', 'cancelled'].includes(normalizeStatus(body.status)) ? new Date().toISOString() : undefined),
  };
  Object.keys(patch).forEach((key) => patch[key] === undefined && delete patch[key]);

  const { data, error } = await s.sbAdmin
    .from('portal_workflow_events')
    .update(patch)
    .eq('id', eventId)
    .select('*')
    .limit(1);
  if (error) return sendJson(res, 500, { ok: false, error: 'workflow_event_update_failed', detail: error.message || '' });

  const row = Array.isArray(data) ? data[0] || null : null;
  if (!row) return sendJson(res, 404, { ok: false, error: 'workflow_event_not_found' });

  if (cleanStr(beforeRow.status, 20) !== 'failed' && cleanStr(row.status, 20) === 'failed' && cleanStr(beforeRow.event_type, 80) !== 'workflow_failed') {
    const ownerUserId = cleanStr(row.owner_user_id || row.actor_user_id || s.realActorUserId || s.user.id, 80) || null;
    await emitOpsTrigger(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      ownerUserId,
      entityType: 'workflow_event',
      entityId: String(eventId),
      eventType: 'workflow_failed',
      priority: 8,
      sourceTable: 'portal_workflow_events',
      sourceId: String(eventId),
      payload: { before: mapEvent(beforeRow), after: mapEvent(row) },
      meta: buildActorMeta(s),
      dedupKey: `workflow_failed:workflow_event:${eventId}:${cleanStr(row.error_text || '', 120)}`,
      task: {
        assignedUserId: ownerUserId,
        taskType: 'admin',
        priority: 8,
        dueAt: addHoursIso(12),
        title: `Recover failed workflow${row.event_type ? `: ${row.event_type}` : ''}`,
        description: cleanStr(row.error_text || 'Review workflow failure details and decide whether to retry.', 5000),
        meta: { workflowEventId: eventId, trigger: 'workflow_failed' },
      },
      notification: ownerUserId ? {
        userId: ownerUserId,
        channel: 'in_app',
        subject: 'Workflow failed',
        bodyText: cleanStr(row.event_type || `Workflow event ${eventId} failed.`, 8000),
        meta: { workflowEventId: eventId, trigger: 'workflow_failed' },
      } : null,
    }).catch(() => {});
  }

  return sendJson(res, 200, { ok: true, event: mapEvent(row) });
};
