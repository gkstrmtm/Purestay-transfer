const { sendJson, handleCors, readJson, sendBodyReadFailure } = require('../../../lib/vercelApi');
const { requirePortalSession } = require('../../../lib/portalAuth');
const { cleanStr } = require('../../../lib/portalFoundation');
const {
  hasChatPersistence,
  listThreads,
  getThread,
  listThreadMessages,
  createThread,
  updateThread,
  deleteThread,
} = require('../../../lib/portalChat');

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function messageFingerprint(entry) {
  const item = entry && typeof entry === 'object' ? entry : {};
  const id = cleanStr(item.id, 120);
  if (id) return `id:${id}`;
  const role = cleanStr(item.role, 20) || 'assistant';
  const content = cleanStr(String(item.content || '').replace(/\s+/g, ' '), 320);
  const createdAt = cleanStr(item.createdAt || item.created_at, 32);
  return [role, content, createdAt].join('::');
}

function dedupeMessages(messages) {
  const seen = new Set();
  const out = [];
  for (const entry of (Array.isArray(messages) ? messages : [])) {
    if (!entry || typeof entry !== 'object') continue;
    const role = cleanStr(entry.role, 20) || 'assistant';
    const content = String(entry.content || '').trim();
    if (!content) continue;
    const key = messageFingerprint(entry);
    if (!key || seen.has(key)) continue;
    const prev = out[out.length - 1] || null;
    if (prev && String(prev.role || '').trim() === role && String(prev.content || '').trim() === content) {
      continue;
    }
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function buildSyntheticAssistantFromThread(thread, messages) {
  const item = thread && typeof thread === 'object' ? thread : null;
  const meta = item?.meta && typeof item.meta === 'object' ? item.meta : {};
  const reply = cleanStr(meta.lastAssistantReply, 3000);
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1] || null;
  if (!item?.id || !reply || !last || String(last.role || '') !== 'user') return null;
  if (list.some((entry) => String(entry?.role || '') === 'assistant' && String(entry?.content || '').trim())) return null;
  return {
    id: '',
    threadId: item.id,
    role: 'assistant',
    content: reply,
    actions: Array.isArray(meta.lastAssistantActions) ? meta.lastAssistantActions : [],
    context: meta.lastContext && typeof meta.lastContext === 'object' ? meta.lastContext : null,
    createdAt: item.lastMessageAt || item.updatedAt || item.createdAt || new Date().toISOString(),
    createdBy: '',
    meta: { reconstructedFromThread: true },
  };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) {
    console.error('[AI threads] session_failed', { error: s.error, status: s.status || 401 });
    return sendJson(res, s.status || 401, { ok: false, error: s.error });
  }

  const ready = await hasChatPersistence(s.sbAdmin);
  const url = new URL(req.url || '/api/portal/ai/threads', 'http://localhost');

  if (req.method === 'GET') {
    if (!ready) {
      return sendJson(res, 200, {
        ok: true,
        ready: false,
        warning: 'foundation_phase1_not_applied',
        threads: [],
        thread: null,
        messages: [],
      });
    }

    const threadId = cleanStr(url.searchParams.get('threadId'), 80);
    const includeArchived = cleanStr(url.searchParams.get('archived'), 10) === '1';
    const threadLimit = clampInt(url.searchParams.get('limit'), 1, 100, 50);
    const messageLimit = clampInt(url.searchParams.get('messageLimit'), 1, 300, 120);
    const listed = await listThreads(s.sbAdmin, s, { includeArchived, limit: threadLimit });
    if (!listed.ok) {
      console.error('[AI threads] list_failed', { error: listed.error, detail: listed.detail || '' });
      return sendJson(res, 500, { ok: false, error: listed.error, detail: listed.detail || '' });
    }

    if (!threadId) return sendJson(res, 200, { ok: true, ready: true, threads: listed.threads });

    const found = await getThread(s.sbAdmin, s, threadId);
    if (!found.ok) {
      console.error('[AI threads] get_failed', { threadId, error: found.error, detail: found.detail || '' });
      const status = found.error === 'thread_not_found' ? 404 : 500;
      return sendJson(res, status, { ok: false, error: found.error, detail: found.detail || '' });
    }

    const messages = await listThreadMessages(s.sbAdmin, threadId, { limit: messageLimit });
    if (!messages.ok) {
      console.error('[AI threads] messages_failed', { threadId, error: messages.error, detail: messages.detail || '' });
      return sendJson(res, 500, { ok: false, error: messages.error, detail: messages.detail || '' });
    }

    let finalMessages = messages.messages;
    let finalThread = found.thread;

    finalMessages = dedupeMessages(finalMessages);
    if (Number(finalThread?.messageCount || 0) > finalMessages.length) {
      const syntheticAssistant = buildSyntheticAssistantFromThread(finalThread, finalMessages);
      if (syntheticAssistant) finalMessages = dedupeMessages(finalMessages.concat([syntheticAssistant]));
    }

    console.info('[AI threads] loaded', { threadId, threadCount: listed.threads.length, messageCount: finalMessages.length });

    return sendJson(res, 200, {
      ok: true,
      ready: true,
      threads: listed.threads,
      thread: finalThread,
      messages: finalMessages,
    });
  }

  if (req.method === 'POST') {
    if (!ready) return sendJson(res, 503, { ok: false, error: 'foundation_phase1_not_applied' });
    const body = await readJson(req, { maxBytes: 128 * 1024 });
    if (!body || typeof body !== 'object') return sendBodyReadFailure(res, req, 'invalid_body');

    const created = await createThread(s.sbAdmin, s, {
      title: body.title,
      summary: body.summary,
      meta: body.meta,
    });
    if (!created.ok) return sendJson(res, 500, { ok: false, error: created.error, detail: created.detail || '' });
    return sendJson(res, 200, { ok: true, ready: true, thread: created.thread });
  }

  if (req.method === 'PATCH') {
    if (!ready) return sendJson(res, 503, { ok: false, error: 'foundation_phase1_not_applied' });
    const body = await readJson(req, { maxBytes: 128 * 1024 });
    if (!body || typeof body !== 'object') return sendBodyReadFailure(res, req, 'invalid_body');
    const threadId = cleanStr(body.threadId || body.id, 80);
    if (!threadId) return sendJson(res, 422, { ok: false, error: 'missing_thread_id' });

    const updated = await updateThread(s.sbAdmin, s, threadId, {
      title: body.title,
      summary: body.summary,
      pinned: body.pinned,
      archived: body.archived,
      meta: body.meta,
    });
    if (!updated.ok) {
      const status = updated.error === 'thread_not_found' ? 404 : 500;
      return sendJson(res, status, { ok: false, error: updated.error, detail: updated.detail || '' });
    }
    return sendJson(res, 200, { ok: true, ready: true, thread: updated.thread });
  }

  if (req.method === 'DELETE') {
    if (!ready) return sendJson(res, 503, { ok: false, error: 'foundation_phase1_not_applied' });
    const body = await readJson(req, { maxBytes: 64 * 1024 }).catch(() => null);
    const threadId = cleanStr(body?.threadId || body?.id || url.searchParams.get('threadId'), 80);
    if (!threadId) return req?.bodyReadError ? sendBodyReadFailure(res, req, 'invalid_body') : sendJson(res, 422, { ok: false, error: 'missing_thread_id' });

    const removed = await deleteThread(s.sbAdmin, s, threadId);
    if (!removed.ok) {
      const status = removed.error === 'thread_not_found' ? 404 : 500;
      return sendJson(res, status, { ok: false, error: removed.error, detail: removed.detail || '' });
    }
    return sendJson(res, 200, { ok: true, ready: true, thread: removed.thread });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
