const { cleanStr, tableExists } = require('./portalFoundation');

const DEFAULT_THREAD_TITLE = 'New conversation';
const DEFAULT_SUMMARY = '';

function normalizeThreadTitle(value, fallback = DEFAULT_THREAD_TITLE) {
  const compact = cleanStr(String(value || '').replace(/\s+/g, ' '), 120);
  return compact || fallback;
}

function summarizeText(value, maxLen = 180) {
  return cleanStr(String(value || '').replace(/\s+/g, ' '), maxLen);
}

function inferThreadTitleFromMessage(message) {
  const compact = summarizeText(message, 120);
  if (!compact) return DEFAULT_THREAD_TITLE;
  if (compact.length <= 72) return compact;
  return compact.slice(0, 69).trimEnd() + '…';
}

function deriveThreadTitleFromContext(context, fallback = DEFAULT_THREAD_TITLE) {
  const ctx = context && typeof context === 'object' ? context : {};
  const scope = ctx.scope && typeof ctx.scope === 'object' ? ctx.scope : null;
  const task = ctx.task && typeof ctx.task === 'object' ? ctx.task : null;
  const lead = ctx.lead && typeof ctx.lead === 'object' ? ctx.lead : null;
  const event = ctx.event && typeof ctx.event === 'object' ? ctx.event : null;
  const account = ctx.account && typeof ctx.account === 'object' ? ctx.account : null;
  const view = ctx.view && typeof ctx.view === 'object' ? ctx.view : null;
  const activeTab = cleanStr(view?.activeTab, 40).toLowerCase();
  const laneLabel = cleanStr(scope?.laneLabel || '', 60);
  const scopeKind = cleanStr(scope?.kind || '', 40).toLowerCase();

  let title = '';
  if (task?.title || scopeKind === 'task') title = 'Task follow-up';
  else if (scopeKind === 'dispatch') title = 'Dispatch follow-up';
  else if (lead?.name || lead?.propertyName || lead?.company || activeTab === 'leads') title = 'Lead follow-up';
  else if (event?.title || activeTab === 'events') title = 'Event planning';
  else if (account?.name || account?.contactName || activeTab === 'accounts') title = 'Client follow-up';
  else if (activeTab === 'offers') title = 'Offer decision';
  else if (activeTab === 'meetings') title = 'Meeting follow-up';
  else if (activeTab === 'calls') title = 'Call planning';
  else if (activeTab === 'people') title = 'People review';
  else if (activeTab === 'tasks') title = 'Task planning';
  else if (laneLabel) title = `${laneLabel} thread`;

  return normalizeThreadTitle(title, fallback);
}

function normalizeThreadMeta(meta) {
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
}

function buildChatScope(session) {
  const ownerUserId = cleanStr(session?.realActorUserId || session?.user?.id, 80);
  const scopeRole = cleanStr(session?.viewAsRole || session?.profile?.role, 40);
  const effectiveActorUserId = cleanStr(session?.actorUserId || session?.user?.id, 80);
  const viewAsRole = cleanStr(session?.viewAsRole, 40) || null;
  const viewAsUserId = cleanStr(session?.viewAsUserId, 80) || null;
  return {
    ownerUserId,
    scopeRole,
    effectiveActorUserId,
    viewAsRole,
    viewAsUserId,
  };
}

async function hasChatPersistence(sbAdmin) {
  const [hasThreads, hasMessages] = await Promise.all([
    tableExists(sbAdmin, 'portal_chat_threads'),
    tableExists(sbAdmin, 'portal_chat_messages'),
  ]);
  return hasThreads && hasMessages;
}

function applyScope(query, session) {
  const scope = buildChatScope(session);
  query = query.eq('owner_user_id', scope.ownerUserId).eq('scope_role', scope.scopeRole || '');
  query = scope.viewAsRole ? query.eq('view_as_role', scope.viewAsRole) : query.is('view_as_role', null);
  query = scope.viewAsUserId ? query.eq('view_as_user_id', scope.viewAsUserId) : query.is('view_as_user_id', null);
  return query;
}

function mapThreadRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title || DEFAULT_THREAD_TITLE,
    summary: row.summary || DEFAULT_SUMMARY,
    pinned: !!row.pinned,
    archived: !!row.archived,
    messageCount: Number(row.message_count || 0) || 0,
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || row.created_at || '',
    lastMessageAt: row.last_message_at || row.updated_at || row.created_at || '',
    scopeRole: row.scope_role || '',
    viewAsRole: row.view_as_role || '',
    viewAsUserId: row.view_as_user_id || '',
    meta: normalizeThreadMeta(row.meta),
  };
}

function mapMessageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    role: cleanStr(row.role, 20) || 'assistant',
    content: String(row.content || ''),
    actions: Array.isArray(row.actions) ? row.actions : [],
    context: row.context && typeof row.context === 'object' ? row.context : null,
    createdAt: row.created_at || '',
    createdBy: row.created_by || '',
    meta: normalizeThreadMeta(row.meta),
  };
}

async function listThreads(sbAdmin, session, { includeArchived = false, limit = 60 } = {}) {
  let query = applyScope(
    sbAdmin
      .from('portal_chat_threads')
      .select('*')
      .order('pinned', { ascending: false })
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false })
      .limit(Math.max(1, Math.min(100, Number(limit) || 60))),
    session,
  );

  if (!includeArchived) query = query.eq('archived', false);

  const { data, error } = await query;
  if (error) return { ok: false, error: 'chat_threads_query_failed', detail: error.message || '' };
  return { ok: true, threads: (Array.isArray(data) ? data : []).map(mapThreadRow).filter(Boolean) };
}

async function getThread(sbAdmin, session, threadId) {
  const id = cleanStr(threadId, 80);
  if (!id) return { ok: false, error: 'missing_thread_id' };

  const { data, error } = await applyScope(
    sbAdmin.from('portal_chat_threads').select('*').eq('id', id).limit(1),
    session,
  );

  if (error) return { ok: false, error: 'chat_thread_lookup_failed', detail: error.message || '' };
  const row = Array.isArray(data) ? data[0] || null : null;
  if (!row) return { ok: false, error: 'thread_not_found' };
  return { ok: true, thread: mapThreadRow(row), row };
}

async function listThreadMessages(sbAdmin, threadId, { limit = 120 } = {}) {
  const id = cleanStr(threadId, 80);
  if (!id) return { ok: false, error: 'missing_thread_id' };
  const { data, error } = await sbAdmin
    .from('portal_chat_messages')
    .select('*')
    .eq('thread_id', id)
    .order('id', { ascending: true })
    .limit(Math.max(1, Math.min(300, Number(limit) || 120)));
  if (error) return { ok: false, error: 'chat_messages_query_failed', detail: error.message || '' };
  return { ok: true, messages: (Array.isArray(data) ? data : []).map(mapMessageRow).filter(Boolean) };
}

async function createThread(sbAdmin, session, { title = '', summary = '', meta = {} } = {}) {
  const scope = buildChatScope(session);
  if (!scope.ownerUserId || !scope.scopeRole) {
    return { ok: false, error: 'invalid_chat_scope' };
  }

  const insertRow = {
    owner_user_id: scope.ownerUserId,
    created_by: scope.ownerUserId,
    effective_actor_user_id: scope.effectiveActorUserId || null,
    scope_role: scope.scopeRole,
    view_as_role: scope.viewAsRole,
    view_as_user_id: scope.viewAsUserId,
    title: normalizeThreadTitle(title),
    summary: summarizeText(summary, 180) || null,
    meta: normalizeThreadMeta(meta),
    updated_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  };

  const { data, error } = await sbAdmin
    .from('portal_chat_threads')
    .insert(insertRow)
    .select('*')
    .limit(1);

  if (error) return { ok: false, error: 'chat_thread_create_failed', detail: error.message || '' };
  const row = Array.isArray(data) ? data[0] || null : null;
  return { ok: true, thread: mapThreadRow(row), row };
}

async function updateThread(sbAdmin, session, threadId, patch = {}) {
  const found = await getThread(sbAdmin, session, threadId);
  if (!found.ok) return found;

  const next = {
    updated_at: new Date().toISOString(),
  };

  if (patch.title !== undefined) next.title = normalizeThreadTitle(patch.title, found.thread?.title || DEFAULT_THREAD_TITLE);
  if (patch.summary !== undefined) next.summary = summarizeText(patch.summary, 180) || null;
  if (patch.pinned !== undefined) next.pinned = !!patch.pinned;
  if (patch.archived !== undefined) next.archived = !!patch.archived;
  if (patch.lastMessageAt !== undefined) next.last_message_at = patch.lastMessageAt || new Date().toISOString();
  if (patch.messageCount !== undefined) next.message_count = Math.max(0, Number(patch.messageCount || 0) || 0);
  if (patch.meta !== undefined) {
    next.meta = Object.assign({}, normalizeThreadMeta(found.row?.meta), normalizeThreadMeta(patch.meta));
  }

  const { data, error } = await sbAdmin
    .from('portal_chat_threads')
    .update(next)
    .eq('id', found.thread.id)
    .select('*')
    .limit(1);

  if (error) return { ok: false, error: 'chat_thread_update_failed', detail: error.message || '' };
  const row = Array.isArray(data) ? data[0] || null : null;
  return { ok: true, thread: mapThreadRow(row), row };
}

async function deleteThread(sbAdmin, session, threadId) {
  const found = await getThread(sbAdmin, session, threadId);
  if (!found.ok) return found;
  const { error } = await sbAdmin.from('portal_chat_threads').delete().eq('id', found.thread.id);
  if (error) return { ok: false, error: 'chat_thread_delete_failed', detail: error.message || '' };
  return { ok: true, thread: found.thread };
}

async function createThreadMessage(sbAdmin, threadId, { role, content, actions = [], context = null, createdBy = '', meta = {} } = {}) {
  const payload = {
    thread_id: cleanStr(threadId, 80),
    role: cleanStr(role, 20) || 'assistant',
    content: String(content || '').trim(),
    actions: Array.isArray(actions) ? actions.slice(0, 3) : [],
    context: context && typeof context === 'object' ? context : null,
    created_by: cleanStr(createdBy, 80) || null,
    meta: normalizeThreadMeta(meta),
  };

  if (!payload.thread_id || !payload.content) {
    return { ok: false, error: 'invalid_chat_message_payload' };
  }

  const { data, error } = await sbAdmin
    .from('portal_chat_messages')
    .insert(payload)
    .select('*')
    .limit(1);

  if (error) return { ok: false, error: 'chat_message_create_failed', detail: error.message || '' };
  const row = Array.isArray(data) ? data[0] || null : null;
  return { ok: true, message: mapMessageRow(row), row };
}

module.exports = {
  DEFAULT_THREAD_TITLE,
  normalizeThreadTitle,
  summarizeText,
  inferThreadTitleFromMessage,
  deriveThreadTitleFromContext,
  buildChatScope,
  hasChatPersistence,
  mapThreadRow,
  mapMessageRow,
  listThreads,
  getThread,
  listThreadMessages,
  createThread,
  updateThread,
  deleteThread,
  createThreadMessage,
};
