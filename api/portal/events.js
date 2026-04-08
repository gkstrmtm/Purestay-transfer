const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager } = require('../../lib/portalAuth');
const { applyRoleFilter, buildRoleOrParts, roleMatchesAny } = require('../../lib/portalRoleAliases');
const { addHoursIso, buildActorMeta, emitOpsTrigger } = require('../../lib/portalOpsTriggers');
const { tableExists, writePortalAudit, normalizeEventCompletionState, ensureDispatchWorkOrder } = require('../../lib/portalFoundation');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeRole(role) {
  const value = cleanStr(role, 40);
  const allowed = new Set(['event_host', 'media_team', 'event_coordinator']);
  return allowed.has(value) ? value : '';
}

function normalizeAssignmentStatus(status) {
  const value = cleanStr(status, 20);
  const allowed = new Set(['pending', 'accepted', 'declined', 'removed', 'confirmed', 'proposed', 'cancelled']);
  return allowed.has(value) ? value : 'pending';
}

function normalizeLegacyAssignments(eventRow) {
  const meta = asObject(eventRow?.meta);
  const list = Array.isArray(meta.assignments) ? meta.assignments : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const role = normalizeRole(item?.role);
    const userId = cleanStr(item?.userId, 80);
    if (!role || !userId) continue;
    const dedup = `${role}:${userId}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push({
      role,
      userId,
      status: normalizeAssignmentStatus(item?.status),
      note: cleanStr(item?.note, 500),
      updatedAt: cleanStr(item?.updatedAt || item?.decidedAt || '', 40) || '',
      decidedAt: cleanStr(item?.decidedAt, 40) || null,
    });
  }
  return out;
}

function assignmentRowToClient(row) {
  return {
    role: normalizeRole(row?.role),
    userId: cleanStr(row?.user_id, 80),
    status: normalizeAssignmentStatus(row?.status),
    note: cleanStr(row?.notes, 500),
    updatedAt: cleanStr(row?.updated_at || row?.created_at || '', 40) || '',
    decidedAt: cleanStr(row?.responded_at || row?.confirmed_at || row?.removed_at || '', 40) || null,
  };
}

function normalizeEventLifecycleStatus(value, fallback = '') {
  const status = cleanStr(value, 40).toLowerCase();
  return status || fallback;
}

function normalizeEventKind(value, fallback = null) {
  const kind = cleanStr(value, 20).toLowerCase();
  return ['appointment', 'delivery', 'dispatch', 'internal'].includes(kind) ? kind : fallback;
}

function deriveLegacyStartsAt(row) {
  const eventDate = cleanStr(row?.event_date, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return '';
  const rawTime = cleanStr(row?.start_time, 20);
  const time = /^\d{2}:\d{2}/.test(rawTime) ? rawTime.slice(0, 5) : '09:00';
  const date = new Date(`${eventDate}T${time}:00`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function deriveLegacyEndsAt(row) {
  const eventDate = cleanStr(row?.event_date, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return '';
  const rawTime = cleanStr(row?.end_time, 20) || cleanStr(row?.start_time, 20);
  const time = /^\d{2}:\d{2}/.test(rawTime) ? rawTime.slice(0, 5) : '10:00';
  const date = new Date(`${eventDate}T${time}:00`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function deriveLegacyDateParts(startsAt, fallbackDate = '', fallbackTime = '') {
  const iso = cleanStr(startsAt, 80);
  const date = iso ? new Date(iso) : null;
  if (date && Number.isFinite(date.getTime())) {
    const yyyy = String(date.getFullYear()).padStart(4, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return {
      event_date: `${yyyy}-${mm}-${dd}`,
      start_time: `${hh}:${min}`,
    };
  }
  return {
    event_date: cleanStr(fallbackDate, 20) || null,
    start_time: cleanStr(fallbackTime, 20),
  };
}

function eventStartsAt(row) {
  const directStartsAt = cleanStr(row?.starts_at, 80);
  if (directStartsAt) {
    const dt = new Date(directStartsAt);
    if (Number.isFinite(dt.getTime())) return dt;
  }
  const eventDate = cleanStr(row?.event_date, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return null;
  const rawTime = cleanStr(row?.start_time, 20);
  const time = /^\d{2}:\d{2}/.test(rawTime) ? rawTime.slice(0, 5) : '09:00';
  const dt = new Date(`${eventDate}T${time}:00`);
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function isStaffingRisk(row) {
  const status = cleanStr(row?.status, 40).toLowerCase();
  if (['completed', 'cancelled', 'closed'].includes(status)) return false;
  const acceptedAssignments = normalizeLegacyAssignments(row).filter((item) => ['accepted', 'confirmed'].includes(String(item?.status || ''))).length;
  if (cleanStr(row?.assigned_user_id, 80) || acceptedAssignments > 0) return false;
  const startsAt = eventStartsAt(row);
  if (!startsAt) return false;
  return startsAt.getTime() - Date.now() <= 72 * 60 * 60 * 1000;
}

function groupByEventId(rows, mapper) {
  const map = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const eventId = Number(row?.event_id || 0);
    if (!Number.isFinite(eventId) || eventId <= 0) continue;
    if (!map.has(eventId)) map.set(eventId, []);
    map.get(eventId).push(mapper ? mapper(row) : row);
  }
  return map;
}

async function loadEventRelationships(sbAdmin, eventRows) {
  const rows = Array.isArray(eventRows) ? eventRows : [];
  if (!rows.length) return [];

  const eventIds = rows.map((row) => Number(row?.id || 0)).filter((id) => Number.isFinite(id) && id > 0);
  const accountIds = Array.from(new Set(rows.map((row) => Number(row?.account_id || 0)).filter((id) => Number.isFinite(id) && id > 0)));
  const locationIds = Array.from(new Set(rows.map((row) => Number(row?.location_id || 0)).filter((id) => Number.isFinite(id) && id > 0)));
  const eventTypeCodes = Array.from(new Set(rows.map((row) => cleanStr(row?.event_type_code, 80)).filter(Boolean)));

  const [
    hasRequirements,
    hasAssignments,
    hasAccounts,
    hasLocations,
    hasEventTypes,
    hasForms,
    hasVendors,
    hasAssets,
    hasLogs,
    hasAttendance,
    hasSurveys,
    hasClosures,
    hasDispatchWorkOrders,
    hasExceptions,
    hasRoutePlans,
    hasEquipmentHandoffs,
  ] = await Promise.all([
    tableExists(sbAdmin, 'portal_event_staff_requirements'),
    tableExists(sbAdmin, 'portal_event_staff_assignments'),
    tableExists(sbAdmin, 'portal_accounts'),
    tableExists(sbAdmin, 'portal_locations'),
    tableExists(sbAdmin, 'portal_event_types'),
    tableExists(sbAdmin, 'portal_form_responses'),
    tableExists(sbAdmin, 'portal_event_vendors'),
    tableExists(sbAdmin, 'portal_event_assets'),
    tableExists(sbAdmin, 'portal_event_logs'),
    tableExists(sbAdmin, 'portal_event_attendance_records'),
    tableExists(sbAdmin, 'portal_event_survey_distributions'),
    tableExists(sbAdmin, 'portal_event_closure_records'),
    tableExists(sbAdmin, 'portal_dispatch_work_orders'),
    tableExists(sbAdmin, 'portal_operations_exceptions'),
    tableExists(sbAdmin, 'portal_route_plans'),
    tableExists(sbAdmin, 'portal_equipment_handoffs'),
  ]);

  const [requirementsResult, assignmentsResult, accountsResult, locationsResult, eventTypesResult, formsResult, vendorsResult, assetsResult, logsResult, attendanceResult, surveyResult, closureResult, dispatchResult, exceptionResult, routeResult, equipmentResult] = await Promise.all([
    hasRequirements && eventIds.length
      ? sbAdmin.from('portal_event_staff_requirements').select('event_id, role, required_count, filled_count, status, required_readiness, travel_required, notes').in('event_id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    hasAssignments && eventIds.length
      ? sbAdmin.from('portal_event_staff_assignments').select('event_id, user_id, role, status, notes, created_at, updated_at, responded_at, confirmed_at, removed_at').in('event_id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    hasAccounts && accountIds.length
      ? sbAdmin.from('portal_accounts').select('id, name, property_name, status, account_owner_user_id, coordinator_user_id').in('id', accountIds)
      : Promise.resolve({ data: [], error: null }),
    hasLocations && locationIds.length
      ? sbAdmin.from('portal_locations').select('id, account_id, location_name, location_code, city, state, timezone, default_event_type_code, status').in('id', locationIds)
      : Promise.resolve({ data: [], error: null }),
    hasEventTypes && eventTypeCodes.length
      ? sbAdmin.from('portal_event_types').select('code, label, category, default_kind, required_roles').in('code', eventTypeCodes)
      : Promise.resolve({ data: [], error: null }),
    hasForms && eventIds.length
      ? sbAdmin.from('portal_form_responses').select('event_id, status').in('event_id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    hasVendors && eventIds.length
      ? sbAdmin.from('portal_event_vendors').select('event_id, status').in('event_id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    hasAssets && eventIds.length
      ? sbAdmin.from('portal_event_assets').select('event_id, status').in('event_id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    hasLogs && eventIds.length
      ? sbAdmin.from('portal_event_logs').select('event_id, status, log_type').in('event_id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    hasAttendance && eventIds.length
      ? sbAdmin.from('portal_event_attendance_records').select('event_id, attendance_source, estimated_count, actual_count, checkin_count, no_show_count, captured_at, captured_by, notes').in('event_id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    hasSurveys && eventIds.length
      ? sbAdmin.from('portal_event_survey_distributions').select('event_id, distribution_channel, recipient_group, status, sent_at, response_count, completion_rate').in('event_id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    hasClosures && eventIds.length
      ? sbAdmin.from('portal_event_closure_records').select('event_id, closure_status, staffing_complete, forms_complete, assets_returned, vendor_items_closed, report_complete, payout_review_complete, approved_by, approved_at, notes').in('event_id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    hasDispatchWorkOrders && eventIds.length
      ? sbAdmin.from('portal_dispatch_work_orders').select('event_id, owner_user_id, status, dispatch_type, priority, vendor_dependency_count, updated_at, notes').in('event_id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    hasExceptions && eventIds.length
      ? sbAdmin.from('portal_operations_exceptions').select('event_id, exception_type, severity, status, owner_user_id, opened_at, resolved_at').in('event_id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    hasRoutePlans && eventIds.length
      ? sbAdmin.from('portal_route_plans').select('*').in('event_id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    hasEquipmentHandoffs && eventIds.length
      ? sbAdmin.from('portal_equipment_handoffs').select('*').in('event_id', eventIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const requirementsByEvent = groupByEventId(requirementsResult.data);
  const assignmentsByEvent = groupByEventId(assignmentsResult.data, assignmentRowToClient);
  const accountById = new Map((Array.isArray(accountsResult.data) ? accountsResult.data : []).map((row) => [Number(row.id), row]));
  const locationById = new Map((Array.isArray(locationsResult.data) ? locationsResult.data : []).map((row) => [Number(row.id), row]));
  const eventTypeByCode = new Map((Array.isArray(eventTypesResult.data) ? eventTypesResult.data : []).map((row) => [String(row.code || ''), row]));
  const formsByEvent = groupByEventId(formsResult.data);
  const vendorsByEvent = groupByEventId(vendorsResult.data);
  const assetsByEvent = groupByEventId(assetsResult.data);
  const logsByEvent = groupByEventId(logsResult.data);
  const attendanceByEvent = groupByEventId(attendanceResult.data);
  const surveysByEvent = groupByEventId(surveyResult.data);
  const closuresByEvent = groupByEventId(closureResult.data);
  const dispatchByEvent = groupByEventId(dispatchResult.data);
  const exceptionsByEvent = groupByEventId(exceptionResult.data);
  const routesByEvent = groupByEventId(routeResult.data);
  const equipmentByEvent = groupByEventId(equipmentResult.data);

  return rows.map((row) => {
    const eventId = Number(row?.id || 0);
    const requirements = requirementsByEvent.get(eventId) || [];
    const normalizedAssignments = assignmentsByEvent.get(eventId) || [];
    const assignments = normalizedAssignments.length ? normalizedAssignments : normalizeLegacyAssignments(row);
    const requiredPeople = requirements.length
      ? requirements.reduce((sum, item) => sum + Math.max(1, Number(item?.required_count || 1)), 0)
      : (cleanStr(row?.assigned_role, 40) ? 1 : 0);
    const acceptedPeople = assignments.filter((item) => ['accepted', 'confirmed'].includes(String(item?.status || ''))).length + (assignments.length ? 0 : (cleanStr(row?.assigned_user_id, 80) ? 1 : 0));
    const startsAtIso = cleanStr(row?.starts_at, 80) || deriveLegacyStartsAt(row);
    const startsAt = startsAtIso ? new Date(startsAtIso) : null;
    const needsStaffing = requiredPeople > 0 && acceptedPeople < requiredPeople;
    const staffingRisk = !!(startsAt && Number.isFinite(startsAt.getTime()) && startsAt.getTime() - Date.now() <= 72 * 60 * 60 * 1000 && needsStaffing);
    const account = accountById.get(Number(row?.account_id || 0)) || null;
    const location = locationById.get(Number(row?.location_id || 0)) || null;
    const eventType = eventTypeByCode.get(cleanStr(row?.event_type_code, 80)) || null;
    const eventForms = formsByEvent.get(eventId) || [];
    const eventVendors = vendorsByEvent.get(eventId) || [];
    const eventAssets = assetsByEvent.get(eventId) || [];
    const eventLogs = logsByEvent.get(eventId) || [];
    const eventAttendance = attendanceByEvent.get(eventId) || [];
    const eventSurveys = surveysByEvent.get(eventId) || [];
    const eventClosure = (closuresByEvent.get(eventId) || [])[0] || null;
    const eventDispatch = (dispatchByEvent.get(eventId) || [])[0] || null;
    const eventExceptions = exceptionsByEvent.get(eventId) || [];
    const eventRoutePlans = routesByEvent.get(eventId) || [];
    const eventEquipmentHandoffs = equipmentByEvent.get(eventId) || [];
    const internalLogSubmitted = eventLogs.some((item) => String(item?.log_type || '') === 'internal' && String(item?.status || '') === 'submitted');
    const latestAttendance = eventAttendance
      .slice()
      .sort((a, b) => String(b?.captured_at || '').localeCompare(String(a?.captured_at || '')))[0] || null;
    const openExceptions = eventExceptions.filter((item) => !['resolved', 'closed'].includes(String(item?.status || '').toLowerCase()));

    return Object.assign({}, row, {
      event_kind: row?.event_kind || eventType?.default_kind || null,
      starts_at: startsAtIso || null,
      ends_at: cleanStr(row?.ends_at, 80) || deriveLegacyEndsAt(row) || null,
      property_id: Number(row?.property_id || location?.property_id || 0) || null,
      timezone: cleanStr(row?.timezone || location?.timezone, 80) || '',
      host_user_id: cleanStr(row?.host_user_id || '', 80) || null,
      completion_state: normalizeEventCompletionState(row?.completion_state, String(row?.status || 'planned').toLowerCase()),
      cancelled_at: cleanStr(row?.cancelled_at, 80) || null,
      cancel_reason: cleanStr(row?.cancel_reason, 1000) || null,
      account_name: cleanStr(account?.name || account?.property_name || '', 200) || '',
      location_name: cleanStr(location?.location_name, 160) || '',
      event_type_label: cleanStr(eventType?.label, 160) || '',
      account: account ? {
        id: account.id,
        name: cleanStr(account.name, 200),
        status: cleanStr(account.status, 40),
        ownerUserId: cleanStr(account.account_owner_user_id, 80),
        coordinatorUserId: cleanStr(account.coordinator_user_id, 80),
      } : null,
      location: location ? {
        id: location.id,
        name: cleanStr(location.location_name, 160),
        code: cleanStr(location.location_code, 80),
        city: cleanStr(location.city, 120),
        state: cleanStr(location.state, 20),
        timezone: cleanStr(location.timezone, 80),
        status: cleanStr(location.status, 40),
      } : null,
      eventType: eventType ? {
        code: cleanStr(eventType.code, 80),
        label: cleanStr(eventType.label, 160),
        category: cleanStr(eventType.category, 80),
        defaultKind: cleanStr(eventType.default_kind, 20),
        requiredRoles: Array.isArray(eventType.required_roles) ? eventType.required_roles : [],
      } : null,
      assignments,
      staffing: {
        source: normalizedAssignments.length ? 'normalized' : 'legacy',
        requirements,
        assignments,
        requirementRows: requirements.length,
        requiredPeople,
        assignmentRows: assignments.length,
        acceptedPeople,
        openRoles: requirements
          .filter((item) => Number(item?.filled_count || 0) < Math.max(1, Number(item?.required_count || 1)) && String(item?.status || '') !== 'cancelled')
          .map((item) => cleanStr(item?.role, 40))
          .filter(Boolean),
        risk: staffingRisk,
      },
      opsSummary: {
        staffingRisk,
        vendorCount: eventVendors.length,
        assetCount: eventAssets.length,
        formCount: eventForms.length,
        submittedFormCount: eventForms.filter((item) => String(item?.status || '') === 'submitted').length,
        internalLogSubmitted,
        internalLogCount: eventLogs.length,
        attendanceCaptured: !!latestAttendance,
        surveyDistributionCount: eventSurveys.length,
        dispatchWorkOrderCount: eventDispatch ? 1 : 0,
        openExceptionCount: openExceptions.length,
        routePlanCount: eventRoutePlans.length,
        equipmentHandoffCount: eventEquipmentHandoffs.length,
        closureStatus: cleanStr(eventClosure?.closure_status || '', 40) || 'not_started',
        closureReady: eventClosure
          ? !!(eventClosure.report_complete && eventClosure.forms_complete)
          : (internalLogSubmitted && String(row?.report_status || 'not_started') !== 'not_started'),
      },
      workflow: {
        attendance: latestAttendance,
        attendanceRecords: eventAttendance,
        surveys: eventSurveys,
        closure: eventClosure,
        dispatchWorkOrder: eventDispatch,
        exceptions: eventExceptions,
        routePlans: eventRoutePlans,
        routePlan: eventRoutePlans[0] || null,
        equipmentHandoffs: eventEquipmentHandoffs,
        equipmentHandoff: eventEquipmentHandoffs[0] || null,
      },
    });
  });
}

async function hasRecordedPayout(sbAdmin, eventId, userId) {
  const cleanUserId = cleanStr(userId, 80);
  if (!eventId || !cleanUserId) return false;
  const { data, error } = await sbAdmin
    .from('portal_payouts')
    .select('id, meta')
    .eq('user_id', cleanUserId)
    .limit(100);
  if (error) return false;
  return (Array.isArray(data) ? data : []).some((row) => String(row?.meta?.eventId || '') === String(eventId));
}

async function hasSubmittedInternalLog(sbAdmin, eventId) {
  if (!eventId) return null;
  const exists = await tableExists(sbAdmin, 'portal_event_logs');
  if (!exists) return null;
  const { data, error } = await sbAdmin
    .from('portal_event_logs')
    .select('id, status')
    .eq('event_id', eventId)
    .eq('log_type', 'internal')
    .eq('status', 'submitted')
    .order('id', { ascending: false })
    .limit(1);
  if (error) return null;
  return !!(Array.isArray(data) && data[0]);
}

async function runEventTriggers(sbAdmin, session, beforeEvent, afterEvent) {
  const eventId = String(afterEvent?.id || beforeEvent?.id || '');
  if (!eventId) return;

  const actorMeta = buildActorMeta(session);
  const ownerUserId = cleanStr(
    afterEvent?.event_owner_user_id
      || afterEvent?.coordinator_user_id
      || afterEvent?.created_by
      || beforeEvent?.event_owner_user_id
      || beforeEvent?.coordinator_user_id
      || beforeEvent?.created_by
      || session?.realActorUserId
      || session?.user?.id,
    80
  ) || null;

  if ((!beforeEvent || !isStaffingRisk(beforeEvent)) && isStaffingRisk(afterEvent)) {
    const startsAt = eventStartsAt(afterEvent);
    await emitOpsTrigger(sbAdmin, {
      actorUserId: session.realActorUserId || session.user.id,
      ownerUserId,
      entityType: 'event',
      entityId: eventId,
      eventType: 'event_staffing_risk',
      priority: 8,
      sourceTable: 'portal_events',
      sourceId: eventId,
      payload: { before: beforeEvent, after: afterEvent },
      meta: actorMeta,
      dedupKey: `event_staffing_risk:event:${eventId}:${cleanStr(afterEvent?.event_date, 20)}:${cleanStr(afterEvent?.assigned_role, 40)}`,
      task: {
        assignedUserId: ownerUserId,
        taskType: 'event',
        priority: 8,
        dueAt: startsAt ? startsAt.toISOString() : addHoursIso(6),
        eventId: Number(eventId),
        title: `Staff upcoming event${afterEvent?.title ? `: ${afterEvent.title}` : ''}`,
        description: cleanStr(afterEvent?.notes || 'This event is nearing delivery without a confirmed assignee.', 5000),
        meta: { eventId: afterEvent?.id || null, trigger: 'event_staffing_risk' },
      },
      notification: ownerUserId ? {
        userId: ownerUserId,
        channel: 'in_app',
        subject: 'Event staffing risk',
        bodyText: cleanStr(afterEvent?.title || `Event ${eventId} is approaching without confirmed staffing.`, 8000),
        meta: { eventId: afterEvent?.id || null, trigger: 'event_staffing_risk' },
      } : null,
    }).catch(() => {});
  }

  const statusBefore = cleanStr(beforeEvent?.status, 40).toLowerCase();
  const statusAfter = cleanStr(afterEvent?.status, 40).toLowerCase();
  const assignedUserId = cleanStr(afterEvent?.assigned_user_id, 80);
  const expectedPayout = Number(afterEvent?.payout_cents || 0);
  if (statusBefore !== 'completed' && statusAfter === 'completed' && assignedUserId && expectedPayout > 0 && !afterEvent?.meta?.payoutRecorded && !afterEvent?.meta?.skipPayoutReview) {
    const recorded = await hasRecordedPayout(sbAdmin, afterEvent?.id, assignedUserId);
    if (!recorded) {
      await emitOpsTrigger(sbAdmin, {
        actorUserId: session.realActorUserId || session.user.id,
        ownerUserId,
        entityType: 'event',
        entityId: eventId,
        eventType: 'payout_missing',
        priority: 8,
        sourceTable: 'portal_events',
        sourceId: eventId,
        payload: { before: beforeEvent, after: afterEvent, expectedPayoutCents: expectedPayout },
        meta: actorMeta,
        dedupKey: `payout_missing:event:${eventId}:${assignedUserId}:${expectedPayout}`,
        task: {
          assignedUserId: ownerUserId,
          taskType: 'admin',
          priority: 8,
          dueAt: addHoursIso(24),
          eventId: Number(eventId),
          title: `Review missing payout${afterEvent?.title ? `: ${afterEvent.title}` : ''}`,
          description: cleanStr(`Confirm payout recording for ${afterEvent?.title || `event ${eventId}`}. Expected payout: ${expectedPayout} cents.`, 5000),
          meta: { eventId: afterEvent?.id || null, assignedUserId, trigger: 'payout_missing' },
        },
        notification: ownerUserId ? {
          userId: ownerUserId,
          channel: 'in_app',
          subject: 'Payout review needed',
          bodyText: cleanStr(afterEvent?.title || `A completed event may be missing a payout record.`, 8000),
          meta: { eventId: afterEvent?.id || null, assignedUserId, trigger: 'payout_missing' },
        } : null,
      }).catch(() => {});
    }
  }

  if (statusBefore !== 'completed' && statusAfter === 'completed') {
    const hasInternalLog = await hasSubmittedInternalLog(sbAdmin, afterEvent?.id);
    if (hasInternalLog === false) {
      const logOwnerUserId = cleanStr(afterEvent?.assigned_user_id || afterEvent?.created_by || ownerUserId, 80) || ownerUserId;
      await emitOpsTrigger(sbAdmin, {
        actorUserId: session.realActorUserId || session.user.id,
        ownerUserId: logOwnerUserId,
        entityType: 'event',
        entityId: eventId,
        eventType: 'event_internal_log_due',
        priority: 7,
        sourceTable: 'portal_events',
        sourceId: eventId,
        payload: { before: beforeEvent, after: afterEvent },
        meta: actorMeta,
        dedupKey: `event_internal_log_due:event:${eventId}:${statusAfter}`,
        task: {
          assignedUserId: logOwnerUserId,
          taskType: 'event',
          priority: 7,
          dueAt: addHoursIso(12),
          eventId: Number(eventId),
          title: `Complete internal event log${afterEvent?.title ? `: ${afterEvent.title}` : ''}`,
          description: cleanStr('Capture attendance, sentiment, issues, and next steps so the client handoff is complete.', 5000),
          meta: { eventId: afterEvent?.id || null, trigger: 'event_internal_log_due' },
        },
        notification: logOwnerUserId ? {
          userId: logOwnerUserId,
          channel: 'in_app',
          subject: 'Internal event log due',
          bodyText: cleanStr(`${afterEvent?.title || `Event ${eventId}`} was completed without an internal event log.`, 8000),
          meta: { eventId: afterEvent?.id || null, trigger: 'event_internal_log_due' },
        } : null,
      }).catch(() => {});
    }
  }
}

function canSeeEvent({ profile, userId, event }) {
  if (isManager(profile)) return true;
  const role = String(profile?.role || '');
  return (
    (event.assigned_user_id && event.assigned_user_id === userId) ||
    (event.event_owner_user_id && event.event_owner_user_id === userId) ||
    (event.coordinator_user_id && event.coordinator_user_id === userId) ||
    (event.created_by && event.created_by === userId) ||
    (role && event.assigned_role && roleMatchesAny(event.assigned_role, role)) ||
    // Allow Events + Media to collaborate on the same event records.
    (role === 'event_host' && event.assigned_role === 'media_team') ||
    (role === 'media_team' && event.assigned_role === 'event_host')
  );
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const url = new URL(req.url || '/api/portal/events', 'http://localhost');

  if (req.method === 'GET') {
    const status = cleanStr(url.searchParams.get('status'), 40);
    const assignedRole = cleanStr(url.searchParams.get('assignedRole'), 40);
    const areaTag = cleanStr(url.searchParams.get('areaTag'), 80);
    const eventKind = normalizeEventKind(url.searchParams.get('eventKind'), '');
    const eventTypeCode = cleanStr(url.searchParams.get('eventTypeCode'), 80);
    const accountId = clampInt(url.searchParams.get('accountId'), 1, 1e12, null);
    const locationId = clampInt(url.searchParams.get('locationId'), 1, 1e12, null);
    const ownerUserId = cleanStr(url.searchParams.get('ownerUserId'), 80);
    const coordinatorUserId = cleanStr(url.searchParams.get('coordinatorUserId'), 80);
    const logisticsStatus = cleanStr(url.searchParams.get('logisticsStatus'), 40);
    const reportStatus = cleanStr(url.searchParams.get('reportStatus'), 40);
    const executionStatus = cleanStr(url.searchParams.get('executionStatus'), 40);
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 100);

    let query = s.sbAdmin
      .from('portal_events')
      .select('*')
      .order('event_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);
    if (assignedRole) query = applyRoleFilter(query, 'assigned_role', assignedRole);
    if (areaTag) query = query.eq('area_tag', areaTag);
    if (eventKind) query = query.eq('event_kind', eventKind);
    if (eventTypeCode) query = query.eq('event_type_code', eventTypeCode);
    if (accountId) query = query.eq('account_id', accountId);
    if (locationId) query = query.eq('location_id', locationId);
    if (ownerUserId) query = query.eq('event_owner_user_id', ownerUserId);
    if (coordinatorUserId) query = query.eq('coordinator_user_id', coordinatorUserId);
    if (logisticsStatus) query = query.eq('logistics_status', logisticsStatus);
    if (reportStatus) query = query.eq('report_status', reportStatus);
    if (executionStatus) query = query.eq('execution_status', executionStatus);

    if (!isManager(s.profile)) {
      const role = String(s.profile.role || '');
      const uid = String(s.effectiveUserId || s.user.id || '');

      if (s.viewAsRole && role && !s.effectiveUserId) {
        if (role === 'event_host') query = query.in('assigned_role', ['event_host', 'media_team']);
        else if (role === 'media_team') query = query.in('assigned_role', ['media_team', 'event_host']);
        else query = applyRoleFilter(query, 'assigned_role', role);
      } else {
        const parts = [
          `assigned_user_id.eq.${uid}`,
          `event_owner_user_id.eq.${uid}`,
          `coordinator_user_id.eq.${uid}`,
          `created_by.eq.${uid}`,
        ];
        if (role) {
          parts.push(...buildRoleOrParts('assigned_role', role));
          // Coordinators need operational visibility across staffing roles.
          if (role === 'event_coordinator') {
            parts.push(...buildRoleOrParts('assigned_role', 'event_host'));
            parts.push(...buildRoleOrParts('assigned_role', 'media_team'));
          }
          if (role === 'event_host') parts.push(...buildRoleOrParts('assigned_role', 'media_team'));
          if (role === 'media_team') parts.push(...buildRoleOrParts('assigned_role', 'event_host'));
        }
        query = query.or(parts.join(','));
      }
    }

    const { data, error } = await query;
    if (error) return sendJson(res, 500, { ok: false, error: 'events_query_failed' });
    const events = await loadEventRelationships(s.sbAdmin, Array.isArray(data) ? data : []);
    return sendJson(res, 200, { ok: true, events });
  }

  if (req.method === 'POST') {
    if (!hasRole(s.profile, ['event_coordinator', 'manager'])) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const startsAt = cleanStr(body.startsAt, 80);
    const dateParts = deriveLegacyDateParts(startsAt, body.eventDate, body.startTime);

    const event = {
      created_by: s.actorUserId,
      status: cleanStr(body.status || 'open', 40),
      title: cleanStr(body.title, 200),
      event_date: dateParts.event_date,
      start_time: cleanStr(body.startTime, 20) || dateParts.start_time,
      end_time: cleanStr(body.endTime, 20),
      address: cleanStr(body.address, 200),
      city: cleanStr(body.city, 120),
      state: cleanStr(body.state, 20),
      postal_code: cleanStr(body.postalCode, 20),
      area_tag: cleanStr(body.areaTag, 80),
      assigned_role: cleanStr(body.assignedRole, 40),
      assigned_user_id: cleanStr(body.assignedUserId, 60) || null,
      payout_cents: clampInt(body.payoutCents, 0, 1e9, 0),
      event_kind: normalizeEventKind(body.eventKind, null),
      account_id: clampInt(body.accountId, 1, 1e12, null),
      location_id: clampInt(body.locationId, 1, 1e12, null),
      property_id: clampInt(body.propertyId, 1, 1e12, null),
      event_type_code: cleanStr(body.eventTypeCode, 80) || null,
      event_owner_user_id: cleanStr(body.eventOwnerUserId, 80) || null,
      coordinator_user_id: cleanStr(body.coordinatorUserId, 80) || null,
      host_user_id: cleanStr(body.hostUserId, 80) || null,
      starts_at: startsAt || null,
      ends_at: cleanStr(body.endsAt, 80) || null,
      timezone: cleanStr(body.timezone, 80) || null,
      execution_status: normalizeEventLifecycleStatus(body.executionStatus, 'planned'),
      logistics_status: normalizeEventLifecycleStatus(body.logisticsStatus, 'not_started'),
      report_status: normalizeEventLifecycleStatus(body.reportStatus, 'not_started'),
      completion_state: normalizeEventCompletionState(body.completionState, 'planned'),
      cancelled_at: cleanStr(body.cancelledAt, 80) || null,
      cancel_reason: cleanStr(body.cancelReason, 1000) || null,
      notes: cleanStr(body.notes, 5000),
      meta: (body.meta && typeof body.meta === 'object') ? body.meta : {},
    };

    const { data, error } = await s.sbAdmin
      .from('portal_events')
      .insert(event)
      .select('*')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'event_insert_failed' });
    const created = Array.isArray(data) ? data[0] : null;
    const enriched = (await loadEventRelationships(s.sbAdmin, created ? [created] : []))[0] || created;

    await writePortalAudit(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      entityType: 'event',
      entityId: String(enriched?.id || ''),
      action: 'create',
      beforePayload: null,
      afterPayload: enriched,
      meta: buildActorMeta(s),
    }).catch(() => {});

    if (created && (String(created.area_tag || '') === 'dispatch' || String(created.meta?.kind || '') === 'dispatch')) {
      await ensureDispatchWorkOrder(s.sbAdmin, {
        event: created,
        ownerUserId: created.assigned_user_id || created.coordinator_user_id || created.created_by,
        status: created.status || 'open',
        dispatchType: created.meta?.dispatchType || 'general',
        meta: { source: 'api/portal/events' },
      }).catch(() => {});
    }

    await runEventTriggers(s.sbAdmin, s, null, enriched).catch(() => {});
    return sendJson(res, 200, { ok: true, event: enriched });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const eventId = clampInt(body.id, 1, 1e12, null);
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const { data: existing, error: e1 } = await s.sbAdmin
      .from('portal_events')
      .select('*')
      .eq('id', eventId)
      .limit(1);

    if (e1) return sendJson(res, 500, { ok: false, error: 'event_lookup_failed' });
    const row = Array.isArray(existing) ? existing[0] : null;
    if (!row) return sendJson(res, 404, { ok: false, error: 'event_not_found' });

    const canEdit = isManager(s.profile)
      || hasRole(s.profile, ['event_coordinator'])
      || (row.assigned_user_id && row.assigned_user_id === s.actorUserId)
      || (row.created_by && row.created_by === s.actorUserId);

    const requestedAssignedUserId = body.assignedUserId != null ? (cleanStr(body.assignedUserId, 60) || null) : undefined;
    const wantsSelfAssign = requestedAssignedUserId && requestedAssignedUserId === s.actorUserId;
    const role = String(s.profile?.role || '');
    const canClaim = !canEdit
      && wantsSelfAssign
      && !row.assigned_user_id
      && row.assigned_role
      && role
      && roleMatchesAny(row.assigned_role, role)
      && String(row.status || 'open') === 'open';

    if (!canEdit && !canClaim) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const startsAt = body.startsAt != null ? cleanStr(body.startsAt, 80) : undefined;
    const derivedDateParts = startsAt !== undefined
      ? deriveLegacyDateParts(startsAt, body.eventDate != null ? body.eventDate : row.event_date, body.startTime != null ? body.startTime : row.start_time)
      : null;

    const patch = {
      status: body.status != null ? cleanStr(body.status, 40) : undefined,
      title: body.title != null ? cleanStr(body.title, 200) : undefined,
      event_date: body.eventDate != null ? (cleanStr(body.eventDate, 20) || null) : (derivedDateParts ? derivedDateParts.event_date : undefined),
      start_time: body.startTime != null ? cleanStr(body.startTime, 20) : (derivedDateParts ? derivedDateParts.start_time : undefined),
      end_time: body.endTime != null ? cleanStr(body.endTime, 20) : undefined,
      address: body.address != null ? cleanStr(body.address, 200) : undefined,
      city: body.city != null ? cleanStr(body.city, 120) : undefined,
      state: body.state != null ? cleanStr(body.state, 20) : undefined,
      postal_code: body.postalCode != null ? cleanStr(body.postalCode, 20) : undefined,
      area_tag: body.areaTag != null ? cleanStr(body.areaTag, 80) : undefined,
      assigned_role: body.assignedRole != null ? cleanStr(body.assignedRole, 40) : undefined,
      assigned_user_id: body.assignedUserId != null ? (cleanStr(body.assignedUserId, 60) || null) : undefined,
      payout_cents: body.payoutCents != null ? clampInt(body.payoutCents, 0, 1e9, row.payout_cents || 0) : undefined,
      event_kind: body.eventKind != null ? normalizeEventKind(body.eventKind, null) : undefined,
      account_id: body.accountId != null ? clampInt(body.accountId, 1, 1e12, null) : undefined,
      location_id: body.locationId != null ? clampInt(body.locationId, 1, 1e12, null) : undefined,
      property_id: body.propertyId != null ? clampInt(body.propertyId, 1, 1e12, null) : undefined,
      event_type_code: body.eventTypeCode != null ? (cleanStr(body.eventTypeCode, 80) || null) : undefined,
      event_owner_user_id: body.eventOwnerUserId != null ? (cleanStr(body.eventOwnerUserId, 80) || null) : undefined,
      coordinator_user_id: body.coordinatorUserId != null ? (cleanStr(body.coordinatorUserId, 80) || null) : undefined,
      host_user_id: body.hostUserId != null ? (cleanStr(body.hostUserId, 80) || null) : undefined,
      starts_at: startsAt,
      ends_at: body.endsAt != null ? (cleanStr(body.endsAt, 80) || null) : undefined,
      timezone: body.timezone != null ? (cleanStr(body.timezone, 80) || null) : undefined,
      execution_status: body.executionStatus != null ? normalizeEventLifecycleStatus(body.executionStatus, row.execution_status || 'planned') : undefined,
      logistics_status: body.logisticsStatus != null ? normalizeEventLifecycleStatus(body.logisticsStatus, row.logistics_status || 'not_started') : undefined,
      report_status: body.reportStatus != null ? normalizeEventLifecycleStatus(body.reportStatus, row.report_status || 'not_started') : undefined,
      completion_state: body.completionState != null ? normalizeEventCompletionState(body.completionState, row.completion_state || 'planned') : undefined,
      cancelled_at: body.cancelledAt != null ? (cleanStr(body.cancelledAt, 80) || null) : undefined,
      cancel_reason: body.cancelReason != null ? (cleanStr(body.cancelReason, 1000) || null) : undefined,
      notes: body.notes != null ? cleanStr(body.notes, 5000) : undefined,
      meta: body.meta != null ? Object.assign({}, asObject(row.meta), ((body.meta && typeof body.meta === 'object') ? body.meta : {})) : undefined,
    };

    if (patch.meta) {
      const budget = patch.meta?.budget && typeof patch.meta.budget === 'object' ? patch.meta.budget : null;
      if (budget) {
        const hostPayCents = Number(budget.hostPayCents || 0);
        const mediaPayCents = Number(budget.mediaPayCents || 0);
        if (Number.isFinite(hostPayCents) && Number.isFinite(mediaPayCents) && mediaPayCents > 0) {
          const minHost = Math.ceil(mediaPayCents * 0.75);
          if (hostPayCents < minHost) {
            return sendJson(res, 422, { ok: false, error: 'budget_constraint_failed', minHostPayCents: minHost });
          }
        }
      }
    }

    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined) delete patch[k];
    }

    if (canClaim) {
      // Claimers can only self-assign and move status to assigned.
      const allowed = {
        assigned_user_id: patch.assigned_user_id,
        status: patch.status || 'assigned',
      };
      for (const k of Object.keys(patch)) delete patch[k];
      patch.assigned_user_id = allowed.assigned_user_id;
      patch.status = allowed.status;
    }

    if (!Object.keys(patch).length) return sendJson(res, 200, { ok: true, event: row });

    const { data, error } = await s.sbAdmin
      .from('portal_events')
      .update(patch)
      .eq('id', eventId)
      .select('*')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'event_update_failed' });
    const updated = Array.isArray(data) ? data[0] : null;
    const enriched = (await loadEventRelationships(s.sbAdmin, updated ? [updated] : []))[0] || updated;

    await writePortalAudit(s.sbAdmin, {
      actorUserId: s.realActorUserId || s.user.id,
      entityType: 'event',
      entityId: String(enriched?.id || eventId),
      action: 'update',
      beforePayload: row,
      afterPayload: enriched,
      meta: buildActorMeta(s),
    }).catch(() => {});

    if (updated && (String(updated.area_tag || '') === 'dispatch' || String(updated.meta?.kind || '') === 'dispatch')) {
      await ensureDispatchWorkOrder(s.sbAdmin, {
        event: updated,
        ownerUserId: updated.assigned_user_id || updated.coordinator_user_id || updated.created_by,
        status: updated.status || 'open',
        dispatchType: updated.meta?.dispatchType || 'general',
        meta: { source: 'api/portal/events' },
      }).catch(() => {});
    }

    await runEventTriggers(s.sbAdmin, s, row, enriched).catch(() => {});
    if (enriched && !canSeeEvent({ profile: s.profile, userId: s.actorUserId, event: enriched })) {
      // If they edited it into a state they can no longer view (rare), just return ok.
      return sendJson(res, 200, { ok: true, event: null });
    }
    return sendJson(res, 200, { ok: true, event: enriched });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
