const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');
const { cleanStr, tableExists, writePortalAgentActionAudit } = require('../../lib/portalFoundation');

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
  return ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(s) ? s : fallback;
}

function mapAudit(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    actorUserId: row.actor_user_id || '',
    agentKey: row.agent_key || '',
    actionType: row.action_type || '',
    status: row.status || '',
    entityType: row.entity_type || '',
    entityId: row.entity_id || '',
    threadId: row.thread_id || '',
    workflowEventId: row.workflow_event_id || null,
    inputPayload: asObject(row.input_payload),
    outputPayload: row.output_payload && typeof row.output_payload === 'object' ? row.output_payload : row.output_payload ?? null,
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
    model: row.model || '',
    meta: asObject(row.meta),
  };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!(await tableExists(s.sbAdmin, 'portal_agent_action_audit'))) {
    return sendJson(res, 503, { ok: false, error: 'workflow_foundation_not_applied' });
  }

  const url = new URL(req.url || '/api/portal/agent_audit', 'http://localhost');
  const actorUserId = String(s.actorUserId || s.user.id || '');
  const operator = canOperate(s.realProfile);

  if (req.method === 'GET') {
    const id = clampInt(url.searchParams.get('id'), 1, 1e12, null);
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 80);
    const agentKey = cleanStr(url.searchParams.get('agentKey'), 80);
    const actionType = cleanStr(url.searchParams.get('actionType'), 80);
    const entityType = cleanStr(url.searchParams.get('entityType'), 80);
    const entityId = cleanStr(url.searchParams.get('entityId'), 160);
    const status = normalizeStatus(url.searchParams.get('status'));

    let query = s.sbAdmin
      .from('portal_agent_action_audit')
      .select('*')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);

    if (id) query = query.eq('id', id);
    if (agentKey) query = query.eq('agent_key', agentKey);
    if (actionType) query = query.eq('action_type', actionType);
    if (entityType) query = query.eq('entity_type', entityType);
    if (entityId) query = query.eq('entity_id', entityId);
    if (status) query = query.eq('status', status);
    if (!operator) query = query.eq('actor_user_id', actorUserId);

    const { data, error } = await query;
    if (error) return sendJson(res, 500, { ok: false, error: 'agent_audit_query_failed', detail: error.message || '' });

    return sendJson(res, 200, { ok: true, audits: (Array.isArray(data) ? data : []).map(mapAudit) });
  }

  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const requestedActorUserId = operator ? (cleanStr(body.actorUserId, 80) || actorUserId) : actorUserId;
  const agentKey = cleanStr(body.agentKey, 80);
  const actionType = cleanStr(body.actionType, 80);
  if (!agentKey || !actionType) return sendJson(res, 422, { ok: false, error: 'missing_audit_fields' });

  const created = await writePortalAgentActionAudit(s.sbAdmin, {
    actorUserId: requestedActorUserId,
    agentKey,
    actionType,
    status: normalizeStatus(body.status, 'completed') || 'completed',
    entityType: cleanStr(body.entityType, 80),
    entityId: cleanStr(body.entityId, 160),
    threadId: cleanStr(body.threadId, 80),
    workflowEventId: clampInt(body.workflowEventId, 1, 1e12, null),
    inputPayload: asObject(body.inputPayload),
    outputPayload: body.outputPayload && typeof body.outputPayload === 'object' ? body.outputPayload : null,
    durationMs: clampInt(body.durationMs, 0, 86400000, null),
    model: cleanStr(body.model, 120),
    meta: asObject(body.meta),
  });

  if (!created.ok) {
    return sendJson(res, 500, { ok: false, error: created.error || 'agent_audit_create_failed', detail: created.detail || '' });
  }

  return sendJson(res, 200, { ok: true, audit: mapAudit(created.audit) });
};
