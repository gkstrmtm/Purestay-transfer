const { sendJson, handleCors, readJson, sendBodyReadFailure } = require('../../../lib/vercelApi');
const { requirePortalSession } = require('../../../lib/portalAuth');
const { explainTableMissing } = require('../../../lib/portalFoundation');
const { generateAssistantMessage, generateThreadTitle } = require('../../../lib/aiPortal');
const {
  hasChatPersistence,
  getThread,
  createThread,
  updateThread,
  createThreadMessage,
  listThreadMessages,
  summarizeText,
} = require('../../../lib/portalChat');

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function sanitizeActionPayload(value, depth = 0) {
  if (depth > 3 || value == null) return null;
  if (typeof value === 'string') return cleanStr(value, 2000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 12)
      .map((item) => sanitizeActionPayload(item, depth + 1))
      .filter((item) => item != null);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, raw] of Object.entries(value).slice(0, 20)) {
      const safeKey = cleanStr(key, 40).replace(/[^a-zA-Z0-9_]/g, '');
      if (!safeKey) continue;
      const next = sanitizeActionPayload(raw, depth + 1);
      if (next != null) out[safeKey] = next;
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

function sanitizeAiActions(actions) {
  const out = [];
  for (const raw of (Array.isArray(actions) ? actions : [])) {
    if (!raw || typeof raw !== 'object') continue;
    const label = cleanStr(raw.label, 80);
    const type = cleanStr(raw.type, 40);
    if (!label || !type) continue;
    const payload = sanitizeActionPayload(raw.payload);
    const action = { label, type };
    if (payload !== null) action.payload = payload;
    out.push(action);
    if (out.length >= 3) break;
  }
  return out;
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) {
    console.error('[AI chat] session_failed', { error: s.error, status: s.status || 401 });
    return sendJson(res, s.status || 401, { ok: false, error: s.error });
  }

  const body = await readJson(req, { maxBytes: 128 * 1024 }).catch(() => null);
  if (!body || typeof body !== 'object') {
    return sendBodyReadFailure(res, req, 'invalid_body');
  }

  const message = cleanStr(body?.message, 1200);
  if (!message) return sendJson(res, 422, { ok: false, error: 'missing_message' });

  const role = String(s.profile?.role || '').trim();
  const context = (body?.context && typeof body.context === 'object') ? body.context : null;
  const incomingHistory = Array.isArray(body?.history) ? body.history.slice(-10) : [];
  const requestedThreadId = cleanStr(body?.threadId, 80);
  const explicitThreadTitle = cleanStr(body?.threadTitle, 120);
  const seedThreadTitle = explicitThreadTitle;

  const ready = await hasChatPersistence(s.sbAdmin);
  let activeThread = null;
  let priorHistory = incomingHistory;
  let userMessage = null;
  let createdThread = false;

  if (ready) {
    if (requestedThreadId) {
      const found = await getThread(s.sbAdmin, s, requestedThreadId);
      if (!found.ok) {
        console.error('[AI chat] thread_lookup_failed', { threadId: requestedThreadId, error: found.error, detail: found.detail || '' });
        const status = found.error === 'thread_not_found' ? 404 : 500;
        return sendJson(res, status, { ok: false, error: found.error, detail: found.detail || '' });
      }
      activeThread = found.thread;
      const prior = await listThreadMessages(s.sbAdmin, requestedThreadId, { limit: 16 });
      if (prior.ok) {
        priorHistory = prior.messages
          .filter((entry) => entry && ['user', 'assistant'].includes(String(entry.role || '')))
          .slice(-10)
          .map((entry) => ({ role: entry.role, content: entry.content }));
      }
    }
    if (!activeThread) {
      const created = await createThread(s.sbAdmin, s, {
        title: seedThreadTitle,
        summary: summarizeText(message, 180),
        meta: context ? { seedContext: context } : {},
      });
      if (!created.ok) {
        console.error('[AI chat] thread_create_failed', { error: created.error, detail: created.detail || '' });
        return sendJson(res, 500, { ok: false, error: created.error, detail: created.detail || '' });
      }
      activeThread = created.thread;
      createdThread = true;
    }

    const savedUserMessage = await createThreadMessage(s.sbAdmin, activeThread.id, {
      role: 'user',
      content: message,
      context,
      createdBy: s.realActorUserId || s.user.id,
      meta: {
        effectiveActorUserId: s.actorUserId || null,
        effectiveRole: role || null,
      },
    });
    if (!savedUserMessage.ok) {
      console.error('[AI chat] user_message_create_failed', { error: savedUserMessage.error, detail: savedUserMessage.detail || '' });
      return sendJson(res, 500, { ok: false, error: savedUserMessage.error, detail: savedUserMessage.detail || '' });
    }
    userMessage = savedUserMessage.message;

    await updateThread(s.sbAdmin, s, activeThread.id, {
      title: activeThread.messageCount ? activeThread.title : seedThreadTitle,
      summary: summarizeText(message, 180),
      lastMessageAt: new Date().toISOString(),
      messageCount: Number(activeThread.messageCount || 0) + 1,
      meta: context ? { lastContext: context } : undefined,
    }).then((updated) => {
      if (updated?.ok) activeThread = updated.thread;
    }).catch(() => {});
  }

  const ai = await generateAssistantMessage({ role, context, message, history: priorHistory });
  if (!ai.ok) {
    console.error('[AI chat] assistant_generation_failed', { error: ai.error });
    return sendJson(res, 502, { ok: false, error: ai.error });
  }

  const reply = cleanStr(ai.data?.reply, 3000);
  const actions = sanitizeAiActions(ai.data?.actions);

  let thread = activeThread;
  let assistantMessage = null;
  let assistantPersisted = false;
  let assistantDbError = null;
  const assistantMeta = {
    effectiveActorUserId: s.actorUserId || null,
    effectiveRole: role || null,
  };

  if (ready && thread?.id) {
    const savedAssistant = await createThreadMessage(s.sbAdmin, thread.id, {
      role: 'assistant',
      content: reply,
      actions,
      context,
      createdBy: s.realActorUserId || s.user.id,
      meta: assistantMeta,
    });
    if (savedAssistant.ok) {
      assistantMessage = savedAssistant.message;
      assistantPersisted = true;
    } else {
      console.error('[AI chat] assistant_message_create_failed', { error: savedAssistant.error, detail: savedAssistant.detail || '' });
      const retryAssistant = await createThreadMessage(s.sbAdmin, thread.id, {
        role: 'assistant',
        content: reply,
        actions: [],
        context: null,
        createdBy: s.realActorUserId || s.user.id,
        meta: Object.assign({}, assistantMeta, {
          persistenceFallback: true,
          originalPersistError: cleanStr(savedAssistant.error, 80),
        }),
      });
      if (retryAssistant.ok) {
        assistantMessage = Object.assign({}, retryAssistant.message, {
          actions,
          meta: Object.assign({}, retryAssistant.message?.meta || {}, {
            actionDisplayOnly: actions.length > 0,
          }),
        });
        assistantPersisted = true;
        console.info('[AI chat] assistant_message_recovered', {
          threadId: thread.id,
          originalError: savedAssistant.error,
        });
      } else {
        console.error('[AI chat] assistant_message_retry_failed', { error: retryAssistant.error, detail: retryAssistant.detail || '' });
        assistantDbError = {
          error: savedAssistant.error,
          detail: savedAssistant.detail,
          retryError: retryAssistant.error,
          retryDetail: retryAssistant.detail,
        };
      }
    }

    const updated = await updateThread(s.sbAdmin, s, thread.id, {
      summary: summarizeText(reply || message, 180),
      lastMessageAt: new Date().toISOString(),
      messageCount: Number(thread.messageCount || 0) + 1,
      meta: {
        ...(context ? { lastContext: context } : {}),
        lastAssistantReply: reply,
        lastAssistantActions: actions,
      },
    });
    if (updated.ok) thread = updated.thread;

    if (createdThread && !explicitThreadTitle) {
      const titled = await generateThreadTitle({
        role,
        context,
        message,
        reply,
        history: priorHistory,
      }).catch(() => ({ ok: false }));
      const nextTitle = cleanStr(titled?.data?.title, 48);
      if (nextTitle) {
        const retitled = await updateThread(s.sbAdmin, s, thread.id, { title: nextTitle }).catch(() => null);
        if (retitled?.ok) thread = retitled.thread;
      }
    }
  }

  if (!assistantMessage) {
    assistantMessage = {
      id: '',
      threadId: thread?.id || '',
      role: 'assistant',
      content: reply,
      actions,
      context,
      createdAt: new Date().toISOString(),
      createdBy: s.realActorUserId || s.user.id,
      meta: {
        transient: true,
      },
    };
  } else if (Array.isArray(actions) && actions.length) {
    assistantMessage = Object.assign({}, assistantMessage, { actions });
  }

  const responsePayload = { 
    ok: true, 
    ready, 
    reply, 
    actions, 
    thread, 
    userMessage,
    message: assistantMessage, 
    messagePersisted: assistantPersisted 
  };
  
    if (!ready) {
    const threadTableCheck = await explainTableMissing(s.sbAdmin, 'portal_chat_threads');
    const msgTableCheck = await explainTableMissing(s.sbAdmin, 'portal_chat_messages');
    
    responsePayload.debugSchema = {
      threadsExists: threadTableCheck.ok,
      threadsError: threadTableCheck.error || null,
      messagesExists: msgTableCheck.ok,
      messagesError: msgTableCheck.error || null,
    };
  }

  if (assistantDbError) {
    responsePayload.debugDbError = assistantDbError;
  }

  console.info('[AI chat] success', {
    ready,
    requestedThreadId,
    threadId: responsePayload.thread?.id || '',
    messagePersisted: assistantPersisted,
    hasUserMessage: !!responsePayload.userMessage,
    hasAssistantMessage: !!responsePayload.message,
  });

  return sendJson(res, 200, responsePayload);
};
