const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');
const { cleanStr, writePortalAudit } = require('../../lib/portalFoundation');
const { addHoursIso, buildActorMeta, emitOpsTrigger } = require('../../lib/portalOpsTriggers');
const { listAccounts, normalizeAccount, upsertAccount, deleteAccount } = require('../../lib/portalAccounts');

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function accountAuditMeta(s, extra = {}) {
  return Object.assign({
    realActorUserId: cleanStr(s.realActorUserId || s.user?.id, 80) || null,
    effectiveActorUserId: cleanStr(s.actorUserId, 80) || null,
    realRole: cleanStr(s.realProfile?.role, 40) || null,
    effectiveRole: cleanStr(s.profile?.role, 40) || null,
    viewAsRole: cleanStr(s.viewAsRole, 40) || null,
    viewAsUserId: cleanStr(s.viewAsUserId, 80) || null,
    impersonating: !!s.impersonating,
  }, extra);
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const readOk = hasRole(s.profile, ['account_manager', 'manager', 'event_coordinator']) || Boolean(s.realIsManager);
  const writeOk = hasRole(s.profile, ['account_manager', 'manager']) || Boolean(s.realIsManager);
  if (req.method === 'GET') {
    if (!readOk) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  } else if (!writeOk) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const url = new URL(req.url || '/api/portal/accounts', 'http://localhost');
  const requestedId = cleanStr(url.searchParams.get('id'), 80);
  const q = cleanStr(url.searchParams.get('q'), 200).toLowerCase();
  const expiringSoon = cleanStr(url.searchParams.get('expiringSoon'), 10) === '1';

  if (req.method === 'GET') {
    const listed = await listAccounts(s.sbAdmin, { actorUserId: s.realActorUserId || s.user.id });
    if (!listed.ok) return sendJson(res, 500, { ok: false, error: listed.error, detail: listed.detail || '' });

    const now = new Date();
    const soonDays = 45;
    const soon = new Date(now.getTime() + soonDays * 86400 * 1000);

    let out = listed.accounts || [];
    if (q) {
      out = out.filter((a) => {
        const hay = [
          a.name,
          a.propertyName,
          a.address,
          a.city,
          a.state,
          a.postalCode,
          a.primaryContactName,
          a.primaryContactEmail,
          a.primaryContactPhone,
          a.contractTier,
          a.email,
          a.phone,
          a.notes,
        ]
          .map((x) => String(x || '').toLowerCase())
          .join(' ');
        return hay.includes(q);
      });
    }
    if (expiringSoon) {
      out = out.filter((a) => {
        if (!a.contractEnd) return false;
        const d = new Date(`${a.contractEnd}T00:00:00`);
        if (Number.isNaN(d.getTime())) return false;
        return d <= soon;
      });
    }

    if (requestedId) {
      const account = out.find((item) => String(item.id) === requestedId || String(item.legacyAccountId || '') === requestedId) || null;
      if (!account) return sendJson(res, 404, { ok: false, error: 'not_found' });
      return sendJson(res, 200, {
        ok: true,
        account,
        source: listed.source || '',
        ready: !!listed.ready,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      accounts: out,
      source: listed.source || '',
      ready: !!listed.ready,
    });
  }

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  if (req.method === 'POST') {
    const account = normalizeAccount({
      id: cleanStr(body.id, 80) || cleanStr(body.legacyAccountId, 80),
      legacyAccountId: cleanStr(body.legacyAccountId, 80),
      name: cleanStr(body.name, 200),
      leadId: cleanStr(body.leadId, 80),
      propertyName: cleanStr(body.propertyName, 200),
      address: cleanStr(body.address, 240),
      city: cleanStr(body.city, 120),
      state: cleanStr(body.state, 20),
      postalCode: cleanStr(body.postalCode, 20),
      primaryContactName: cleanStr(body.primaryContactName, 200),
      primaryContactEmail: cleanStr(body.primaryContactEmail, 200),
      primaryContactPhone: cleanStr(body.primaryContactPhone, 80),
      contractTier: cleanStr(body.contractTier || body.tier, 40),
      termMonths: body.termMonths,
      contractSendDate: cleanStr(body.contractSendDate, 20),
      contractStart: cleanStr(body.contractStart, 20),
      contractEnd: cleanStr(body.contractEnd, 20),
      renewalReminderDays: body.renewalReminderDays,
      renewalReminderDate: cleanStr(body.renewalReminderDate, 20),
      email: cleanStr(body.email, 200),
      phone: cleanStr(body.phone, 80),
      notes: cleanStr(body.notes, 8000),
      status: cleanStr(body.status, 40) || 'prospect',
      accountOwnerUserId: cleanStr(body.accountOwnerUserId, 80),
      closerUserId: cleanStr(body.closerUserId, 80),
      coordinatorUserId: cleanStr(body.coordinatorUserId, 80),
      meta: isPlainObject(body.meta) ? body.meta : {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (!account) return sendJson(res, 400, { ok: false, error: 'name_required' });

    const saved = await upsertAccount(s.sbAdmin, account, { actorUserId: s.realActorUserId || s.user.id });
    if (!saved.ok) return sendJson(res, 500, { ok: false, error: saved.error, detail: saved.detail || '' });

    const actorMeta = buildActorMeta(s);

    await writePortalAudit(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      entityType: 'account',
      entityId: String(saved.account?.id || account.id || ''),
      action: 'create',
      beforePayload: null,
      afterPayload: saved.account || account,
      meta: Object.assign(accountAuditMeta(s, { source: saved.source || '' }), actorMeta),
    }).catch(() => {});

    const createdAccount = saved.account || account;
    const accountEntityId = String(createdAccount?.id || account.id || '');
    const reviewUserId = cleanStr(createdAccount?.accountOwnerUserId || createdAccount?.coordinatorUserId || createdAccount?.closerUserId || s.realActorUserId || s.user.id, 80) || null;

    if (!cleanStr(createdAccount?.accountOwnerUserId, 80)) {
      await emitOpsTrigger(s.sbAdmin, {
        actorUserId: s.realActorUserId || s.user.id,
        ownerUserId: reviewUserId,
        entityType: 'account',
        entityId: accountEntityId,
        eventType: 'account_owner_missing',
        priority: 8,
        sourceTable: 'portal_accounts',
        sourceId: accountEntityId,
        payload: { before: null, after: createdAccount },
        meta: actorMeta,
        dedupKey: `account_owner_missing:account:${accountEntityId}:${createdAccount?.updatedAt || createdAccount?.createdAt || ''}`,
        task: {
          assignedUserId: reviewUserId,
          taskType: 'account',
          priority: 8,
          dueAt: addHoursIso(12),
          accountId: Number.isFinite(Number(createdAccount?.id)) ? Number(createdAccount.id) : null,
          title: `Assign account owner${createdAccount?.name ? `: ${createdAccount.name}` : ''}`,
          description: cleanStr(`Assign an owner so account coverage is not left open for ${createdAccount?.name || 'this account'}.`, 5000),
          meta: { accountId: createdAccount?.id || null, trigger: 'account_owner_missing' },
        },
        notification: reviewUserId ? {
          userId: reviewUserId,
          channel: 'in_app',
          subject: 'Account owner missing',
          bodyText: cleanStr(`${createdAccount?.name || 'An account'} does not have an owner assigned.`, 8000),
          meta: { accountId: createdAccount?.id || null, trigger: 'account_owner_missing' },
        } : null,
      }).catch(() => {});
    }

    if (cleanStr(createdAccount?.status, 40) === 'at_risk') {
      await emitOpsTrigger(s.sbAdmin, {
        actorUserId: s.realActorUserId || s.user.id,
        ownerUserId: reviewUserId,
        entityType: 'account',
        entityId: accountEntityId,
        eventType: 'account_at_risk',
        priority: 8,
        sourceTable: 'portal_accounts',
        sourceId: accountEntityId,
        payload: { before: null, after: createdAccount },
        meta: actorMeta,
        dedupKey: `account_at_risk:account:${accountEntityId}:${createdAccount?.updatedAt || createdAccount?.createdAt || ''}`,
        task: {
          assignedUserId: reviewUserId,
          taskType: 'account',
          priority: 8,
          dueAt: addHoursIso(24),
          accountId: Number.isFinite(Number(createdAccount?.id)) ? Number(createdAccount.id) : null,
          title: `Create recovery plan${createdAccount?.name ? `: ${createdAccount.name}` : ''}`,
          description: cleanStr(createdAccount?.notes || `Review risk factors and next actions for ${createdAccount?.name || 'this account'}.`, 5000),
          meta: { accountId: createdAccount?.id || null, trigger: 'account_at_risk' },
        },
        notification: reviewUserId ? {
          userId: reviewUserId,
          channel: 'in_app',
          subject: 'Account marked at risk',
          bodyText: cleanStr(`${createdAccount?.name || 'An account'} is marked at risk.`, 8000),
          meta: { accountId: createdAccount?.id || null, trigger: 'account_at_risk' },
        } : null,
      }).catch(() => {});
    }

    return sendJson(res, 200, { ok: true, account: saved.account, source: saved.source || '', ready: !!saved.ready });
  }

  if (req.method === 'PUT') {
    const id = cleanStr(body.id, 80);
    const patch = isPlainObject(body.patch) ? body.patch : {};
    if (!id) return sendJson(res, 400, { ok: false, error: 'id_required' });

    const listed = await listAccounts(s.sbAdmin, { actorUserId: s.realActorUserId || s.user.id });
    if (!listed.ok) return sendJson(res, 500, { ok: false, error: listed.error, detail: listed.detail || '' });
    const existing = (listed.accounts || []).find((a) => String(a.id) === id || String(a.legacyAccountId || '') === id) || null;
    if (!existing) return sendJson(res, 404, { ok: false, error: 'not_found' });

    const updated = normalizeAccount(Object.assign({}, existing, patch, {
      id: existing.id,
      legacyAccountId: existing.legacyAccountId || existing.id,
      updatedAt: new Date().toISOString(),
      meta: Object.assign({}, existing.meta || {}, isPlainObject(patch.meta) ? patch.meta : {}),
    }));
    if (!updated) return sendJson(res, 400, { ok: false, error: 'invalid_account_payload' });

    const saved = await upsertAccount(s.sbAdmin, updated, { actorUserId: s.realActorUserId || s.user.id });
    if (!saved.ok) return sendJson(res, 500, { ok: false, error: saved.error, detail: saved.detail || '' });

    const actorMeta = buildActorMeta(s);

    await writePortalAudit(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      entityType: 'account',
      entityId: String(saved.account?.id || id),
      action: 'update',
      beforePayload: existing,
      afterPayload: saved.account || updated,
      meta: Object.assign(accountAuditMeta(s, { source: saved.source || '' }), actorMeta),
    }).catch(() => {});

    const nextAccount = saved.account || updated;
    const accountEntityId = String(nextAccount?.id || id);
    const reviewUserId = cleanStr(nextAccount?.accountOwnerUserId || nextAccount?.coordinatorUserId || nextAccount?.closerUserId || s.realActorUserId || s.user.id, 80) || null;

    if (cleanStr(existing?.accountOwnerUserId, 80) && !cleanStr(nextAccount?.accountOwnerUserId, 80)) {
      await emitOpsTrigger(s.sbAdmin, {
        actorUserId: s.realActorUserId || s.user.id,
        ownerUserId: reviewUserId,
        entityType: 'account',
        entityId: accountEntityId,
        eventType: 'account_owner_missing',
        priority: 8,
        sourceTable: 'portal_accounts',
        sourceId: accountEntityId,
        payload: { before: existing, after: nextAccount },
        meta: actorMeta,
        dedupKey: `account_owner_missing:account:${accountEntityId}:${nextAccount?.updatedAt || ''}`,
        task: {
          assignedUserId: reviewUserId,
          taskType: 'account',
          priority: 8,
          dueAt: addHoursIso(12),
          accountId: Number.isFinite(Number(nextAccount?.id)) ? Number(nextAccount.id) : null,
          title: `Assign account owner${nextAccount?.name ? `: ${nextAccount.name}` : ''}`,
          description: cleanStr(`Assign an owner so account coverage is restored for ${nextAccount?.name || 'this account'}.`, 5000),
          meta: { accountId: nextAccount?.id || null, trigger: 'account_owner_missing' },
        },
        notification: reviewUserId ? {
          userId: reviewUserId,
          channel: 'in_app',
          subject: 'Account owner removed',
          bodyText: cleanStr(`${nextAccount?.name || 'An account'} no longer has an owner assigned.`, 8000),
          meta: { accountId: nextAccount?.id || null, trigger: 'account_owner_missing' },
        } : null,
      }).catch(() => {});
    }

    if (cleanStr(existing?.status, 40) !== 'at_risk' && cleanStr(nextAccount?.status, 40) === 'at_risk') {
      await emitOpsTrigger(s.sbAdmin, {
        actorUserId: s.realActorUserId || s.user.id,
        ownerUserId: reviewUserId,
        entityType: 'account',
        entityId: accountEntityId,
        eventType: 'account_at_risk',
        priority: 8,
        sourceTable: 'portal_accounts',
        sourceId: accountEntityId,
        payload: { before: existing, after: nextAccount },
        meta: actorMeta,
        dedupKey: `account_at_risk:account:${accountEntityId}:${nextAccount?.updatedAt || ''}`,
        task: {
          assignedUserId: reviewUserId,
          taskType: 'account',
          priority: 8,
          dueAt: addHoursIso(24),
          accountId: Number.isFinite(Number(nextAccount?.id)) ? Number(nextAccount.id) : null,
          title: `Create recovery plan${nextAccount?.name ? `: ${nextAccount.name}` : ''}`,
          description: cleanStr(nextAccount?.notes || `Review risk factors and next actions for ${nextAccount?.name || 'this account'}.`, 5000),
          meta: { accountId: nextAccount?.id || null, trigger: 'account_at_risk' },
        },
        notification: reviewUserId ? {
          userId: reviewUserId,
          channel: 'in_app',
          subject: 'Account marked at risk',
          bodyText: cleanStr(`${nextAccount?.name || 'An account'} is now at risk.`, 8000),
          meta: { accountId: nextAccount?.id || null, trigger: 'account_at_risk' },
        } : null,
      }).catch(() => {});
    }

    return sendJson(res, 200, { ok: true, account: saved.account, source: saved.source || '', ready: !!saved.ready });
  }

  if (req.method === 'DELETE') {
    const id = cleanStr(body.id, 80);
    if (!id) return sendJson(res, 400, { ok: false, error: 'id_required' });

    const listed = await listAccounts(s.sbAdmin, { actorUserId: s.realActorUserId || s.user.id });
    const existing = listed.ok
      ? ((listed.accounts || []).find((a) => String(a.id) === id || String(a.legacyAccountId || '') === id) || null)
      : null;

    const removed = await deleteAccount(s.sbAdmin, id);
    if (!removed.ok) return sendJson(res, 500, { ok: false, error: removed.error, detail: removed.detail || '' });

    await writePortalAudit(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      entityType: 'account',
      entityId: id,
      action: 'delete',
      beforePayload: existing,
      afterPayload: null,
      meta: accountAuditMeta(s, { source: removed.source || '' }),
    }).catch(() => {});

    return sendJson(res, 200, { ok: true, source: removed.source || '', ready: !!removed.ready });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
