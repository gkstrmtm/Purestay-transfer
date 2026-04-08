const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');
const {
  cleanStr,
  tableExists,
  writePortalAudit,
  writePortalWorkflowEvent,
} = require('../../lib/portalFoundation');
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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

async function resolvePersonManagerUserId(sbAdmin, userId) {
  const cleanUserId = cleanStr(userId, 80);
  if (!cleanUserId) return '';
  if (!(await tableExists(sbAdmin, 'portal_people'))) return '';
  const { data, error } = await sbAdmin
    .from('portal_people')
    .select('manager_user_id')
    .eq('user_id', cleanUserId)
    .limit(1);
  if (error) return '';
  const row = Array.isArray(data) ? data[0] || null : null;
  return cleanStr(row?.manager_user_id, 80);
}

function canOperate(profile) {
  return hasRole(profile, OPERATOR_ROLES);
}

function normalizeIntakeType(v) {
  const s = cleanStr(v, 40).toLowerCase();
  return ['employee_onboarding', 'contractor_onboarding', 'account_assignment', 'account_onboarding', 'general'].includes(s) ? s : '';
}

function normalizeIntakeStatus(v, fallback = '') {
  const s = cleanStr(v, 20).toLowerCase();
  return ['draft', 'submitted', 'in_review', 'approved', 'rejected', 'archived'].includes(s) ? s : fallback;
}

function normalizeJourneyStatus(v, fallback = '') {
  const s = cleanStr(v, 20).toLowerCase();
  return ['pending', 'queued', 'active', 'blocked', 'completed', 'cancelled'].includes(s) ? s : fallback;
}

function normalizeTags(value) {
  return asArray(value)
    .map((item) => cleanStr(item, 40))
    .filter(Boolean)
    .slice(0, 30);
}

function mapIntakeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at || null,
    reviewedAt: row.reviewed_at || null,
    submittedBy: row.submitted_by || '',
    personUserId: row.person_user_id || '',
    ownerUserId: row.owner_user_id || '',
    assignedUserId: row.assigned_user_id || '',
    reviewedBy: row.reviewed_by || '',
    intakeType: row.intake_type || '',
    status: row.status || '',
    subjectRole: row.subject_role || '',
    source: row.source || 'portal',
    formKey: row.form_key || '',
    title: row.title || '',
    description: row.description || '',
    payload: asObject(row.payload),
    normalizedData: asObject(row.normalized_data),
    tags: Array.isArray(row.tags) ? row.tags : [],
    dedupKey: row.dedup_key || '',
    meta: asObject(row.meta),
  };
}

function mapJourneyRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at || null,
    targetReadyAt: row.target_ready_at || null,
    completedAt: row.completed_at || null,
    personUserId: row.person_user_id || '',
    intakeSubmissionId: row.intake_submission_id || null,
    role: row.role || '',
    status: row.status || '',
    stageKey: row.stage_key || '',
    ownerUserId: row.owner_user_id || '',
    managerUserId: row.manager_user_id || '',
    checklist: asObject(row.checklist),
    requiredForms: asArray(row.required_forms),
    collectedData: asObject(row.collected_data),
    notes: row.notes || '',
    meta: asObject(row.meta),
  };
}

async function listJourneys(sbAdmin, { id, personUserId, intakeSubmissionId, limit }) {
  if (!(await tableExists(sbAdmin, 'portal_onboarding_journeys'))) return [];

  let query = sbAdmin
    .from('portal_onboarding_journeys')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (id) query = query.eq('id', id);
  if (personUserId) query = query.eq('person_user_id', personUserId);
  if (intakeSubmissionId) query = query.eq('intake_submission_id', intakeSubmissionId);

  const { data, error } = await query;
  if (error) return [];
  return (Array.isArray(data) ? data : []).map(mapJourneyRow);
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const hasIntake = await tableExists(s.sbAdmin, 'portal_intake_submissions');
  if (!hasIntake) return sendJson(res, 503, { ok: false, error: 'workflow_foundation_not_applied' });

  const url = new URL(req.url || '/api/portal/onboarding', 'http://localhost');
  const intakeId = clampInt(url.searchParams.get('id'), 1, 1e12, null);
  const journeyId = clampInt(url.searchParams.get('journeyId'), 1, 1e12, null);
  const requestedPersonUserId = cleanStr(url.searchParams.get('personUserId'), 80);
  const status = normalizeIntakeStatus(url.searchParams.get('status'));
  const intakeType = normalizeIntakeType(url.searchParams.get('intakeType'));
  const limit = clampInt(url.searchParams.get('limit'), 1, 200, 60);
  const actorUserId = String(s.actorUserId || s.user.id || '');
  const operator = canOperate(s.realProfile);

  if (req.method === 'GET') {
    const targetPersonUserId = requestedPersonUserId || (!operator ? actorUserId : '');
    if (!operator && requestedPersonUserId && requestedPersonUserId !== actorUserId) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    let query = s.sbAdmin
      .from('portal_intake_submissions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (intakeId) query = query.eq('id', intakeId);
    if (targetPersonUserId) query = query.eq('person_user_id', targetPersonUserId);
    if (status) query = query.eq('status', status);
    if (intakeType) query = query.eq('intake_type', intakeType);
    if (!operator) {
      query = query.or([
        `submitted_by.eq.${actorUserId}`,
        `person_user_id.eq.${actorUserId}`,
        `owner_user_id.eq.${actorUserId}`,
      ].join(','));
    }

    const { data, error } = await query;
    if (error) return sendJson(res, 500, { ok: false, error: 'intake_query_failed', detail: error.message || '' });

    const submissions = (Array.isArray(data) ? data : []).map(mapIntakeRow);
    const journeys = await listJourneys(s.sbAdmin, {
      id: journeyId,
      personUserId: targetPersonUserId,
      intakeSubmissionId: intakeId,
      limit,
    });

    return sendJson(res, 200, {
      ok: true,
      submissions,
      journeys,
      ready: true,
      source: 'workflow_foundation',
    });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const personUserId = cleanStr(body.personUserId, 80) || actorUserId;
    if (!operator && personUserId !== actorUserId) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    const selfManagerUserId = !operator && personUserId === actorUserId
      ? await resolvePersonManagerUserId(s.sbAdmin, personUserId)
      : '';
    const reviewOwnerUserId = selfManagerUserId || personUserId;

    const intakeRow = {
      submitted_by: actorUserId,
      person_user_id: personUserId,
      owner_user_id: operator ? (cleanStr(body.ownerUserId, 80) || personUserId) : reviewOwnerUserId,
      assigned_user_id: operator ? (cleanStr(body.assignedUserId, 80) || null) : (selfManagerUserId || null),
      reviewed_by: null,
      intake_type: normalizeIntakeType(body.intakeType) || 'employee_onboarding',
      status: normalizeIntakeStatus(body.status, body.draft ? 'draft' : 'submitted') || 'submitted',
      subject_role: cleanStr(body.subjectRole, 40) || null,
      source: cleanStr(body.source, 40) || 'portal',
      form_key: cleanStr(body.formKey, 80) || null,
      title: cleanStr(body.title, 200) || null,
      description: cleanStr(body.description, 4000) || null,
      payload: asObject(body.payload),
      normalized_data: asObject(body.normalizedData),
      tags: normalizeTags(body.tags),
      dedup_key: cleanStr(body.dedupKey, 200) || null,
      meta: asObject(body.meta),
      submitted_at: (body.draft || normalizeIntakeStatus(body.status) === 'draft') ? null : (cleanStr(body.submittedAt, 80) || new Date().toISOString()),
    };

    const { data, error } = await s.sbAdmin
      .from('portal_intake_submissions')
      .insert(intakeRow)
      .select('*')
      .limit(1);
    if (error) return sendJson(res, 500, { ok: false, error: 'intake_insert_failed', detail: error.message || '' });

    const intake = mapIntakeRow(Array.isArray(data) ? data[0] || null : null);
    let journey = null;

    if (body.createJourney || body.journey) {
      const hasJourneys = await tableExists(s.sbAdmin, 'portal_onboarding_journeys');
      if (hasJourneys) {
        const journeyBody = asObject(body.journey);
        const journeyRow = {
          person_user_id: personUserId,
          intake_submission_id: intake?.id || null,
          role: cleanStr(journeyBody.role || body.subjectRole, 40) || null,
          status: normalizeJourneyStatus(journeyBody.status, 'pending') || 'pending',
          stage_key: cleanStr(journeyBody.stageKey, 80) || 'intake',
          owner_user_id: operator ? (cleanStr(journeyBody.ownerUserId || body.ownerUserId, 80) || personUserId) : reviewOwnerUserId,
          manager_user_id: operator ? (cleanStr(journeyBody.managerUserId, 80) || null) : (selfManagerUserId || null),
          checklist: asObject(journeyBody.checklist),
          required_forms: asArray(journeyBody.requiredForms),
          collected_data: asObject(journeyBody.collectedData),
          notes: cleanStr(journeyBody.notes, 4000) || null,
          meta: asObject(journeyBody.meta),
          started_at: cleanStr(journeyBody.startedAt, 80) || null,
          target_ready_at: cleanStr(journeyBody.targetReadyAt, 80) || null,
          completed_at: cleanStr(journeyBody.completedAt, 80) || null,
        };

        const { data: journeyData, error: journeyError } = await s.sbAdmin
          .from('portal_onboarding_journeys')
          .insert(journeyRow)
          .select('*')
          .limit(1);
        if (!journeyError) journey = mapJourneyRow(Array.isArray(journeyData) ? journeyData[0] || null : null);
      }
    }

    const actorMeta = buildActorMeta(s);

    await writePortalAudit(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      entityType: 'onboarding_intake',
      entityId: String(intake?.id || ''),
      action: 'create',
      beforePayload: null,
      afterPayload: { intake, journey },
      meta: actorMeta,
    }).catch(() => {});

    if (intake?.status === 'draft') {
      await writePortalWorkflowEvent(s.sbAdmin, {
        actorUserId: s.realActorUserId || s.user.id,
        ownerUserId: intake?.ownerUserId || personUserId,
        entityType: 'onboarding_intake',
        entityId: String(intake?.id || ''),
        eventType: 'intake_saved',
        status: 'pending',
        sourceTable: 'portal_intake_submissions',
        sourceId: String(intake?.id || ''),
        intakeSubmissionId: intake?.id || null,
        onboardingJourneyId: journey?.id || null,
        payload: { intake, journey },
        meta: Object.assign({ personUserId }, actorMeta),
      }).catch(() => {});
    } else {
      const reviewUserId = intake?.assignedUserId || intake?.ownerUserId || null;
      await emitOpsTrigger(s.sbAdmin, {
        actorUserId: s.realActorUserId || s.user.id,
        ownerUserId: reviewUserId || personUserId,
        entityType: 'intake_submission',
        entityId: String(intake?.id || ''),
        eventType: 'intake_submitted',
        priority: 5,
        sourceTable: 'portal_intake_submissions',
        sourceId: String(intake?.id || ''),
        intakeSubmissionId: intake?.id || null,
        onboardingJourneyId: journey?.id || null,
        payload: { intake, journey },
        meta: Object.assign({ personUserId }, actorMeta),
        dedupKey: `intake_submitted:intake_submission:${intake?.id || ''}:${intake?.submittedAt || intake?.createdAt || ''}`,
        task: {
          assignedUserId: reviewUserId,
          taskType: 'admin',
          priority: 5,
          dueAt: addHoursIso(24),
          title: `Review onboarding intake${intake?.title ? `: ${intake.title}` : ''}`,
          description: cleanStr(intake?.description || `Review submitted onboarding intake for ${personUserId}.`, 5000),
          meta: { intakeSubmissionId: intake?.id || null, journeyId: journey?.id || null, trigger: 'intake_submitted' },
        },
        notification: reviewUserId ? {
          userId: reviewUserId,
          channel: 'in_app',
          subject: 'Onboarding intake submitted',
          bodyText: cleanStr(intake?.title || `A new onboarding intake is ready for review for ${personUserId}.`, 8000),
          meta: { intakeSubmissionId: intake?.id || null, journeyId: journey?.id || null },
        } : null,
      }).catch(() => {});
    }

    return sendJson(res, 200, { ok: true, submission: intake, journey });
  }

  if (req.method !== 'PATCH') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const submissionId = clampInt(body.id || body.submissionId, 1, 1e12, null);
  const patchJourneyId = clampInt(body.journeyId, 1, 1e12, null);
  if (!operator && (submissionId || !patchJourneyId)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  let submission = null;
  let journey = null;

  if (submissionId) {
    const { data: existing, error: lookupError } = await s.sbAdmin
      .from('portal_intake_submissions')
      .select('*')
      .eq('id', submissionId)
      .limit(1);
    if (lookupError) return sendJson(res, 500, { ok: false, error: 'intake_lookup_failed', detail: lookupError.message || '' });
    const before = Array.isArray(existing) ? existing[0] || null : null;
    if (!before) return sendJson(res, 404, { ok: false, error: 'intake_not_found' });

    const nextStatus = normalizeIntakeStatus(body.status, before.status);
    const patch = {
      updated_at: new Date().toISOString(),
      assigned_user_id: body.assignedUserId != null ? (cleanStr(body.assignedUserId, 80) || null) : undefined,
      owner_user_id: body.ownerUserId != null ? (cleanStr(body.ownerUserId, 80) || null) : undefined,
      reviewed_by: nextStatus !== before.status && ['approved', 'rejected', 'in_review', 'archived'].includes(nextStatus) ? actorUserId : undefined,
      reviewed_at: nextStatus !== before.status && ['approved', 'rejected', 'in_review', 'archived'].includes(nextStatus) ? new Date().toISOString() : undefined,
      status: nextStatus,
      title: body.title != null ? (cleanStr(body.title, 200) || null) : undefined,
      description: body.description != null ? (cleanStr(body.description, 4000) || null) : undefined,
      payload: body.payload != null ? asObject(body.payload) : undefined,
      normalized_data: body.normalizedData != null ? asObject(body.normalizedData) : undefined,
      tags: body.tags != null ? normalizeTags(body.tags) : undefined,
      meta: body.meta != null ? asObject(body.meta) : undefined,
    };

    Object.keys(patch).forEach((key) => patch[key] === undefined && delete patch[key]);

    const { data: updatedRows, error: updateError } = await s.sbAdmin
      .from('portal_intake_submissions')
      .update(patch)
      .eq('id', submissionId)
      .select('*')
      .limit(1);
    if (updateError) return sendJson(res, 500, { ok: false, error: 'intake_update_failed', detail: updateError.message || '' });

    submission = mapIntakeRow(Array.isArray(updatedRows) ? updatedRows[0] || null : null);

    const actorMeta = buildActorMeta(s);

    await writePortalAudit(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      entityType: 'onboarding_intake',
      entityId: String(submissionId),
      action: 'update',
      beforePayload: mapIntakeRow(before),
      afterPayload: submission,
      meta: actorMeta,
    }).catch(() => {});

    if (before.status !== submission?.status) {
      if (submission?.status === 'submitted') {
        const reviewUserId = submission?.assignedUserId || submission?.ownerUserId || null;
        await emitOpsTrigger(s.sbAdmin, {
          actorUserId: s.realActorUserId || s.user.id,
          ownerUserId: reviewUserId || submission?.personUserId || null,
          entityType: 'intake_submission',
          entityId: String(submissionId),
          eventType: 'intake_submitted',
          priority: 5,
          sourceTable: 'portal_intake_submissions',
          sourceId: String(submissionId),
          intakeSubmissionId: submissionId,
          payload: { before: mapIntakeRow(before), after: submission },
          meta: actorMeta,
          dedupKey: `intake_submitted:intake_submission:${submissionId}:${submission?.submittedAt || submission?.updatedAt || ''}`,
          task: {
            assignedUserId: reviewUserId,
            taskType: 'admin',
            priority: 5,
            dueAt: addHoursIso(24),
            title: `Review onboarding intake${submission?.title ? `: ${submission.title}` : ''}`,
            description: cleanStr(submission?.description || `Review submitted onboarding intake ${submissionId}.`, 5000),
            meta: { intakeSubmissionId: submissionId, trigger: 'intake_submitted' },
          },
          notification: reviewUserId ? {
            userId: reviewUserId,
            channel: 'in_app',
            subject: 'Onboarding intake submitted',
            bodyText: cleanStr(submission?.title || `Onboarding intake ${submissionId} is ready for review.`, 8000),
            meta: { intakeSubmissionId: submissionId },
          } : null,
        }).catch(() => {});
      } else {
        await writePortalWorkflowEvent(s.sbAdmin, {
          actorUserId: s.realActorUserId || s.user.id,
          ownerUserId: submission?.ownerUserId || submission?.personUserId || null,
          entityType: 'onboarding_intake',
          entityId: String(submissionId),
          eventType: `intake_${submission?.status || 'updated'}`,
          status: 'pending',
          sourceTable: 'portal_intake_submissions',
          sourceId: String(submissionId),
          intakeSubmissionId: submissionId,
          payload: { before: mapIntakeRow(before), after: submission },
          meta: actorMeta,
        }).catch(() => {});
      }
    }
  }

  if (patchJourneyId) {
    if (!(await tableExists(s.sbAdmin, 'portal_onboarding_journeys'))) {
      return sendJson(res, 503, { ok: false, error: 'workflow_foundation_not_applied' });
    }

    const { data: existingJourney, error: journeyLookupError } = await s.sbAdmin
      .from('portal_onboarding_journeys')
      .select('*')
      .eq('id', patchJourneyId)
      .limit(1);
    if (journeyLookupError) return sendJson(res, 500, { ok: false, error: 'journey_lookup_failed', detail: journeyLookupError.message || '' });
    const beforeJourney = Array.isArray(existingJourney) ? existingJourney[0] || null : null;
    if (!beforeJourney) return sendJson(res, 404, { ok: false, error: 'journey_not_found' });
    if (!operator && cleanStr(beforeJourney.person_user_id, 80) !== actorUserId) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const requestedJourneyStatus = normalizeJourneyStatus(body.journeyStatus || body.status, beforeJourney.status);
    const selfJourneyStatus = ['pending', 'active', 'completed'].includes(requestedJourneyStatus)
      ? requestedJourneyStatus
      : beforeJourney.status;

    const journeyPatch = {
      updated_at: new Date().toISOString(),
      status: operator ? requestedJourneyStatus : selfJourneyStatus,
      stage_key: body.stageKey != null ? (cleanStr(body.stageKey, 80) || 'intake') : undefined,
      owner_user_id: operator && body.ownerUserId != null ? (cleanStr(body.ownerUserId, 80) || null) : undefined,
      manager_user_id: operator && body.managerUserId != null ? (cleanStr(body.managerUserId, 80) || null) : undefined,
      checklist: body.checklist != null ? asObject(body.checklist) : undefined,
      required_forms: operator && body.requiredForms != null ? asArray(body.requiredForms) : undefined,
      collected_data: body.collectedData != null ? asObject(body.collectedData) : undefined,
      notes: body.notes != null ? (cleanStr(body.notes, 4000) || null) : undefined,
      meta: body.meta != null ? asObject(body.meta) : undefined,
      target_ready_at: operator && body.targetReadyAt != null ? (cleanStr(body.targetReadyAt, 80) || null) : undefined,
      completed_at: body.completedAt != null ? (cleanStr(body.completedAt, 80) || null) : undefined,
    };
    Object.keys(journeyPatch).forEach((key) => journeyPatch[key] === undefined && delete journeyPatch[key]);

    const { data: updatedJourneyRows, error: journeyUpdateError } = await s.sbAdmin
      .from('portal_onboarding_journeys')
      .update(journeyPatch)
      .eq('id', patchJourneyId)
      .select('*')
      .limit(1);
    if (journeyUpdateError) return sendJson(res, 500, { ok: false, error: 'journey_update_failed', detail: journeyUpdateError.message || '' });

    journey = mapJourneyRow(Array.isArray(updatedJourneyRows) ? updatedJourneyRows[0] || null : null);

    if (beforeJourney.status !== journey?.status) {
      const actorMeta = buildActorMeta(s);
      if (journey?.status === 'blocked') {
        const ownerUserId = journey?.ownerUserId || journey?.managerUserId || null;
        await emitOpsTrigger(s.sbAdmin, {
          actorUserId: s.realActorUserId || s.user.id,
          ownerUserId: ownerUserId || journey?.personUserId || null,
          entityType: 'onboarding_journey',
          entityId: String(patchJourneyId),
          eventType: 'journey_blocked',
          priority: 8,
          sourceTable: 'portal_onboarding_journeys',
          sourceId: String(patchJourneyId),
          onboardingJourneyId: patchJourneyId,
          intakeSubmissionId: journey?.intakeSubmissionId || null,
          payload: { before: mapJourneyRow(beforeJourney), after: journey },
          meta: actorMeta,
          dedupKey: `journey_blocked:onboarding_journey:${patchJourneyId}:${journey?.updatedAt || ''}:${journey?.stageKey || ''}`,
          task: {
            assignedUserId: ownerUserId,
            taskType: 'admin',
            priority: 8,
            dueAt: addHoursIso(12),
            title: `Resolve blocked onboarding journey${journey?.stageKey ? `: ${journey.stageKey}` : ''}`,
            description: cleanStr(journey?.notes || `Investigate onboarding blocker for ${journey?.personUserId || 'assigned person'}.`, 5000),
            meta: { onboardingJourneyId: patchJourneyId, intakeSubmissionId: journey?.intakeSubmissionId || null, trigger: 'journey_blocked' },
          },
          notification: ownerUserId ? {
            userId: ownerUserId,
            channel: 'in_app',
            subject: 'Onboarding journey blocked',
            bodyText: cleanStr(journey?.notes || `A journey is blocked at stage ${journey?.stageKey || 'unknown'}.`, 8000),
            meta: { onboardingJourneyId: patchJourneyId, intakeSubmissionId: journey?.intakeSubmissionId || null },
          } : null,
        }).catch(() => {});
      } else {
        await writePortalWorkflowEvent(s.sbAdmin, {
          actorUserId: s.realActorUserId || s.user.id,
          ownerUserId: journey?.ownerUserId || journey?.personUserId || null,
          entityType: 'onboarding_journey',
          entityId: String(patchJourneyId),
          eventType: `journey_${journey?.status || 'updated'}`,
          status: 'pending',
          sourceTable: 'portal_onboarding_journeys',
          sourceId: String(patchJourneyId),
          onboardingJourneyId: patchJourneyId,
          intakeSubmissionId: journey?.intakeSubmissionId || null,
          payload: { before: mapJourneyRow(beforeJourney), after: journey },
          meta: actorMeta,
        }).catch(() => {});
      }
    }
  }

  return sendJson(res, 200, { ok: true, submission, journey });
};
