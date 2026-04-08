const { sendJson, handleCors } = require('../../lib/vercelApi');
const { requirePortalSession, buildPortalCapabilities } = require('../../lib/portalAuth');
const { cleanStr, tableExists } = require('../../lib/portalFoundation');
const { summarizeAuthIdentity } = require('../../lib/portalIdentity');
const { buildRoleOrParts } = require('../../lib/portalRoleAliases');

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function todayYmd() {
  return ymdFromDate(new Date());
}

function ymdFromDate(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (!Number.isFinite(date.getTime())) return '';
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysYmd(ymd, days) {
  const source = cleanStr(ymd, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source)) return '';
  const date = new Date(`${source}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return ymdFromDate(date);
}

function ymdFromValue(value) {
  const raw = cleanStr(value, 80);
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? ymdFromDate(date) : '';
}

function isOpenTaskStatus(status) {
  return ['open', 'in_progress', 'blocked', 'assigned'].includes(cleanStr(status, 20));
}

function isTaskOverdue(task) {
  if (!isOpenTaskStatus(task?.status)) return false;
  const dueAt = cleanStr(task?.due_at || task?.dueAt, 80);
  if (!dueAt) return false;
  const ms = new Date(dueAt).getTime();
  return Number.isFinite(ms) && ms < Date.now();
}

function eventStartsAt(event) {
  const direct = cleanStr(event?.starts_at || event?.startsAt, 80);
  if (direct) {
    const ts = new Date(direct).getTime();
    if (Number.isFinite(ts)) return ts;
  }
  const eventDate = cleanStr(event?.event_date || event?.eventDate, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return NaN;
  const startTime = cleanStr(event?.start_time || event?.startTime, 20);
  const time = /^\d{2}:\d{2}/.test(startTime) ? startTime.slice(0, 5) : '09:00';
  return new Date(`${eventDate}T${time}:00Z`).getTime();
}

function eventIsUpcoming(event, today, horizon) {
  const dateKey = ymdFromValue(event?.event_date || event?.starts_at || event?.startsAt);
  return !!dateKey && dateKey >= today && dateKey <= horizon;
}

function staffingRisk(event) {
  const required = safeNumber(event?.staffing_required_people || event?.staffing?.requiredPeople || 0);
  const accepted = safeNumber(event?.staffing_accepted_people || event?.staffing?.acceptedPeople || 0);
  if (!(required > accepted)) return false;
  const startTs = eventStartsAt(event);
  if (!Number.isFinite(startTs)) return false;
  return startTs - Date.now() <= 72 * 60 * 60 * 1000;
}

function closureReady(event) {
  const reportStatus = cleanStr(event?.report_status || event?.reportStatus, 40);
  const internalLogSubmitted = !!event?.internal_log_submitted;
  return internalLogSubmitted && reportStatus && reportStatus !== 'not_started';
}

function makeDateBuckets(windowDays) {
  const days = [];
  const end = todayYmd();
  const start = addDaysYmd(end, -(windowDays - 1));
  for (let i = 0; i < windowDays; i += 1) days.push(addDaysYmd(start, i));
  return days;
}

function makeSeries(days, fields) {
  return days.map((date) => {
    const row = { date };
    for (const field of fields) row[field] = 0;
    return row;
  });
}

function makeSeriesIndex(series) {
  return new Map(series.map((row) => [row.date, row]));
}

function bumpSeries(index, date, field, amount = 1) {
  const row = index.get(date);
  if (!row) return;
  row[field] = safeNumber(row[field]) + safeNumber(amount);
}

function breakdownFromMap(map, { limit = 12 } = {}) {
  return Array.from(map.entries())
    .map(([key, count]) => ({ key, label: key, count: safeNumber(count) }))
    .filter((item) => item.key)
    .sort((left, right) => right.count - left.count || String(left.label).localeCompare(String(right.label)))
    .slice(0, limit);
}

function incrementCount(map, key, amount = 1) {
  const cleanKey = cleanStr(key, 120) || 'unknown';
  map.set(cleanKey, safeNumber(map.get(cleanKey), 0) + safeNumber(amount));
}

function compactLabel(...parts) {
  return parts.map((part) => cleanStr(part, 160)).filter(Boolean).join(' • ');
}

function topKeyFromCountMap(map) {
  if (!(map instanceof Map) || !map.size) return '';
  let bestKey = '';
  let bestCount = -1;
  for (const [key, count] of map.entries()) {
    const nextCount = safeNumber(count, 0);
    if (nextCount > bestCount) {
      bestKey = key;
      bestCount = nextCount;
    }
  }
  return bestKey;
}

function queueEventRow(event) {
  return {
    id: event.id,
    label: cleanStr(event.title, 200) || `Event ${event.id}`,
    meta: compactLabel(
      cleanStr(event.account_name, 160),
      cleanStr(event.location_name, 160),
      ymdFromValue(event.starts_at || event.event_date),
      cleanStr(event.event_type_label, 160) || cleanStr(event.event_type_code, 80)
    ),
    eventId: event.id,
    accountId: event.account_id || null,
    locationId: event.location_id || null,
  };
}

function queueTaskRow(task) {
  return {
    id: task.id,
    label: cleanStr(task.title, 200) || `Task ${task.id}`,
    meta: compactLabel(cleanStr(task.task_type, 40), cleanStr(task.status, 40), cleanStr(task.due_at, 80)),
    taskId: task.id,
    accountId: task.account_id || null,
    eventId: task.event_id || null,
  };
}

function queueAccountRow(account) {
  return {
    id: account.id,
    label: cleanStr(account.name || account.property_name, 200) || `Account ${account.id}`,
    meta: compactLabel(cleanStr(account.status, 40), cleanStr(account.contract_end, 20), cleanStr(account.renewal_reminder_date, 20)),
    accountId: account.id,
  };
}

function queuePersonRow(person) {
  return {
    id: cleanStr(person.user_id, 80),
    label: cleanStr(person.full_name, 160) || cleanStr(person.user_id, 80),
    meta: compactLabel(cleanStr(person.role, 40), cleanStr(person.employment_status, 40), cleanStr(person.readiness_status, 40)),
    userId: cleanStr(person.user_id, 80),
  };
}

function queueJourneyRow(journey) {
  return {
    id: journey.id,
    label: cleanStr(journey.stage_key, 120) || `Journey ${journey.id}`,
    meta: compactLabel(cleanStr(journey.status, 40), cleanStr(journey.target_ready_at, 80), cleanStr(journey.person_user_id, 80)),
    journeyId: journey.id,
    userId: cleanStr(journey.person_user_id, 80),
  };
}

function queueWorkflowRow(row) {
  return {
    id: row.id,
    label: cleanStr(row.event_type, 160) || `Workflow ${row.id}`,
    meta: compactLabel(cleanStr(row.status, 40), cleanStr(row.entity_type, 80), cleanStr(row.entity_id, 160)),
    workflowEventId: row.id,
  };
}

function queueNotificationRow(row) {
  return {
    id: row.id,
    label: cleanStr(row.subject, 200) || cleanStr(row.template_key, 120) || `Notification ${row.id}`,
    meta: compactLabel(cleanStr(row.channel, 40), cleanStr(row.status, 40), cleanStr(row.entity_type, 80), cleanStr(row.entity_id, 160)),
    notificationId: row.id,
  };
}

async function queryRows(query) {
  const { data, error } = await query;
  if (error) return [];
  return Array.isArray(data) ? data : [];
}

function applyOperatorScope(query, session, field = 'assigned_user_id') {
  const actorUserId = cleanStr(session.actorUserId || session.user?.id, 80);
  const role = cleanStr(session.profile?.role, 40);
  const parts = [];
  if (actorUserId) {
    parts.push(`${field}.eq.${actorUserId}`);
    parts.push(`created_by.eq.${actorUserId}`);
  }
  if (role) parts.push(...buildRoleOrParts('assigned_role', role));
  return parts.length ? query.or(parts.join(',')) : query;
}

async function loadAccessSummary(sbAdmin, enabled) {
  if (!enabled || typeof sbAdmin?.auth?.admin?.listUsers !== 'function') {
    return { total: 0, active: 0, pending: 0, suspended: 0, byStatus: [] };
  }

  try {
    const authList = await sbAdmin.auth.admin.listUsers({ page: 1, perPage: 500 });
    const users = asArray(authList?.data?.users);
    const counts = new Map();
    for (const user of users) {
      const identity = summarizeAuthIdentity(user, { emailFallback: cleanStr(user?.email, 160) });
      incrementCount(counts, identity.status);
    }
    return {
      total: users.length,
      active: safeNumber(counts.get('active')),
      pending: safeNumber(counts.get('invite_pending')) + safeNumber(counts.get('verification_pending')) + safeNumber(counts.get('unlinked')),
      suspended: safeNumber(counts.get('suspended')),
      byStatus: breakdownFromMap(counts),
    };
  } catch {
    return { total: 0, active: 0, pending: 0, suspended: 0, byStatus: [] };
  }
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const session = await requirePortalSession(req);
  if (!session.ok) return sendJson(res, session.status || 401, { ok: false, error: session.error });

  const capabilities = session.capabilities || buildPortalCapabilities(session);
  const url = new URL(req.url || '/api/portal/overview', 'http://localhost');
  const windowDays = clampInt(url.searchParams.get('windowDays'), 7, 90, 30);
  const horizonDays = clampInt(url.searchParams.get('horizonDays'), 7, 120, 30);
  const queueLimit = clampInt(url.searchParams.get('limit'), 3, 20, 8);
  const today = todayYmd();
  const horizon = addDaysYmd(today, horizonDays);
  const operator = capabilities.canCoordinateOperations || capabilities.canManageAccounts || capabilities.canManageUsers || Boolean(session.realIsManager);

  const [
    hasLeads,
    hasAccounts,
    hasPeople,
    hasTasks,
    hasEvents,
    hasEventSnapshot,
    hasOnboarding,
    hasJourneys,
    hasWorkflow,
    hasNotifications,
    hasPayouts,
    hasLocations,
    hasEventTypes,
    hasVendors,
    hasAssets,
    hasFormTemplates,
    hasFormResponses,
  ] = await Promise.all([
    tableExists(session.sbAdmin, 'portal_leads'),
    tableExists(session.sbAdmin, 'portal_accounts'),
    tableExists(session.sbAdmin, 'portal_people'),
    tableExists(session.sbAdmin, 'portal_tasks'),
    tableExists(session.sbAdmin, 'portal_events'),
    tableExists(session.sbAdmin, 'portal_event_operations_snapshot_v'),
    tableExists(session.sbAdmin, 'portal_intake_submissions'),
    tableExists(session.sbAdmin, 'portal_onboarding_journeys'),
    tableExists(session.sbAdmin, 'portal_workflow_events'),
    tableExists(session.sbAdmin, 'portal_notification_queue'),
    tableExists(session.sbAdmin, 'portal_payouts'),
    tableExists(session.sbAdmin, 'portal_locations'),
    tableExists(session.sbAdmin, 'portal_event_types'),
    tableExists(session.sbAdmin, 'portal_vendors'),
    tableExists(session.sbAdmin, 'portal_assets'),
    tableExists(session.sbAdmin, 'portal_form_templates'),
    tableExists(session.sbAdmin, 'portal_form_responses'),
  ]);

  const actorUserId = cleanStr(session.actorUserId || session.user?.id, 80);
  const role = cleanStr(session.profile?.role, 40);

  let leadsQuery = null;
  if (hasLeads) {
    leadsQuery = session.sbAdmin
      .from('portal_leads')
      .select('id, created_at, created_by, assigned_user_id, assigned_role, source, status, priority, company, property_name')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (!operator) leadsQuery = applyOperatorScope(leadsQuery, session);
  }

  let accountsQuery = null;
  if (hasAccounts && operator) {
    accountsQuery = session.sbAdmin
      .from('portal_accounts')
      .select('id, created_at, updated_at, name, property_name, status, account_owner_user_id, closer_user_id, coordinator_user_id, contract_end, renewal_reminder_date')
      .order('updated_at', { ascending: false })
      .limit(1000);
  }

  let peopleQuery = null;
  if (hasPeople) {
    peopleQuery = session.sbAdmin
      .from('portal_people')
      .select('user_id, created_at, updated_at, role, full_name, employment_status, readiness_status, team_code, manager_user_id, can_be_assigned')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (!capabilities.canViewPeopleDirectoryData) peopleQuery = peopleQuery.eq('user_id', actorUserId);
  }

  let tasksQuery = null;
  if (hasTasks) {
    tasksQuery = session.sbAdmin
      .from('portal_tasks')
      .select('id, created_at, updated_at, created_by, assigned_user_id, task_type, status, priority, title, due_at, event_id, account_id')
      .order('updated_at', { ascending: false })
      .limit(1000);
    if (!operator) tasksQuery = tasksQuery.or([`assigned_user_id.eq.${actorUserId}`, `created_by.eq.${actorUserId}`].join(','));
  }

  let eventsQuery = null;
  if (hasEvents) {
    eventsQuery = session.sbAdmin
      .from('portal_events')
      .select('id, created_at, created_by, status, title, event_date, start_time, end_time, starts_at, ends_at, assigned_role, assigned_user_id, payout_cents, account_id, location_id, event_type_code, event_kind, event_owner_user_id, coordinator_user_id, execution_status, logistics_status, report_status, meta')
      .order('event_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(1000);
    if (!operator) {
      const parts = [`assigned_user_id.eq.${actorUserId}`, `event_owner_user_id.eq.${actorUserId}`, `coordinator_user_id.eq.${actorUserId}`, `created_by.eq.${actorUserId}`];
      if (role) parts.push(...buildRoleOrParts('assigned_role', role));
      eventsQuery = eventsQuery.or(parts.join(','));
    }
  }

  let eventSnapshotQuery = null;
  if (hasEventSnapshot) {
    eventSnapshotQuery = session.sbAdmin
      .from('portal_event_operations_snapshot_v')
      .select('event_id, account_name, location_name, event_type_label, staffing_required_people, staffing_accepted_people, vendor_rows, asset_rows, form_rows, report_status')
      .limit(1000);
  }

  let submissionsQuery = null;
  if (hasOnboarding) {
    submissionsQuery = session.sbAdmin
      .from('portal_intake_submissions')
      .select('id, created_at, submitted_at, person_user_id, owner_user_id, assigned_user_id, intake_type, status, title')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (!operator) submissionsQuery = submissionsQuery.or([`person_user_id.eq.${actorUserId}`, `owner_user_id.eq.${actorUserId}`, `assigned_user_id.eq.${actorUserId}`, `submitted_by.eq.${actorUserId}`].join(','));
  }

  let journeysQuery = null;
  if (hasJourneys) {
    journeysQuery = session.sbAdmin
      .from('portal_onboarding_journeys')
      .select('id, created_at, updated_at, target_ready_at, person_user_id, owner_user_id, manager_user_id, status, stage_key')
      .order('updated_at', { ascending: false })
      .limit(1000);
    if (!operator) journeysQuery = journeysQuery.or([`person_user_id.eq.${actorUserId}`, `owner_user_id.eq.${actorUserId}`, `manager_user_id.eq.${actorUserId}`].join(','));
  }

  let workflowQuery = null;
  if (hasWorkflow) {
    workflowQuery = session.sbAdmin
      .from('portal_workflow_events')
      .select('id, occurred_at, actor_user_id, owner_user_id, entity_type, entity_id, event_type, status, priority')
      .order('occurred_at', { ascending: false })
      .limit(1000);
    if (!operator) workflowQuery = workflowQuery.or([`actor_user_id.eq.${actorUserId}`, `owner_user_id.eq.${actorUserId}`].join(','));
  }

  let notificationsQuery = null;
  if (hasNotifications) {
    notificationsQuery = session.sbAdmin
      .from('portal_notification_queue')
      .select('id, created_at, scheduled_for, sent_at, user_id, channel, status, entity_type, entity_id, subject, template_key')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (!operator) notificationsQuery = notificationsQuery.eq('user_id', actorUserId);
  }

  let payoutsQuery = null;
  if (hasPayouts) {
    payoutsQuery = session.sbAdmin
      .from('portal_payouts')
      .select('id, created_at, user_id, role, amount_cents, status, period_start, period_end, meta')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (!operator) payoutsQuery = payoutsQuery.eq('user_id', actorUserId);
  }

  const [
    leads,
    accounts,
    people,
    tasks,
    events,
    eventSnapshots,
    submissions,
    journeys,
    workflowEvents,
    notifications,
    payouts,
    locations,
    eventTypes,
    vendors,
    assets,
    formTemplates,
    formResponses,
    access,
  ] = await Promise.all([
    leadsQuery ? queryRows(leadsQuery) : Promise.resolve([]),
    accountsQuery ? queryRows(accountsQuery) : Promise.resolve([]),
    peopleQuery ? queryRows(peopleQuery) : Promise.resolve([]),
    tasksQuery ? queryRows(tasksQuery) : Promise.resolve([]),
    eventsQuery ? queryRows(eventsQuery) : Promise.resolve([]),
    eventSnapshotQuery ? queryRows(eventSnapshotQuery) : Promise.resolve([]),
    submissionsQuery ? queryRows(submissionsQuery) : Promise.resolve([]),
    journeysQuery ? queryRows(journeysQuery) : Promise.resolve([]),
    workflowQuery ? queryRows(workflowQuery) : Promise.resolve([]),
    notificationsQuery ? queryRows(notificationsQuery) : Promise.resolve([]),
    payoutsQuery ? queryRows(payoutsQuery) : Promise.resolve([]),
    hasLocations && operator ? queryRows(session.sbAdmin.from('portal_locations').select('id, status, city, state, default_event_type_code').limit(1000)) : Promise.resolve([]),
    hasEventTypes && operator ? queryRows(session.sbAdmin.from('portal_event_types').select('code, category, default_kind').limit(1000)) : Promise.resolve([]),
    hasVendors && operator ? queryRows(session.sbAdmin.from('portal_vendors').select('id, service_category, status').limit(1000)) : Promise.resolve([]),
    hasAssets && operator ? queryRows(session.sbAdmin.from('portal_assets').select('id, asset_type, status').limit(1000)) : Promise.resolve([]),
    hasFormTemplates && operator ? queryRows(session.sbAdmin.from('portal_form_templates').select('id, template_key, form_kind, status, required').limit(1000)) : Promise.resolve([]),
    hasFormResponses && operator ? queryRows(session.sbAdmin.from('portal_form_responses').select('id, created_at, due_at, submitted_at, status, template_id, event_id, account_id, person_user_id').limit(1000)) : Promise.resolve([]),
    loadAccessSummary(session.sbAdmin, capabilities.canManageUserAccess),
  ]);

  const eventSnapshotById = new Map(eventSnapshots.map((row) => [safeNumber(row.event_id), row]));
  const locationById = new Map(locations.map((row) => [safeNumber(row.id), row]));
  const eventTypeByCode = new Map(eventTypes.map((row) => [cleanStr(row.code, 80), row]));
  const mergedEvents = events.map((event) => Object.assign({}, event, asObject(eventSnapshotById.get(safeNumber(event.id)))));
  const days = makeDateBuckets(windowDays);

  const leadsSeries = makeSeries(days, ['new', 'working', 'booked', 'won', 'lost']);
  const tasksSeries = makeSeries(days, ['created', 'completed', 'blocked', 'overdue']);
  const eventsSeries = makeSeries(days, ['scheduled', 'completed', 'staffingRisk', 'reportPending']);
  const onboardingSeries = makeSeries(days, ['submitted', 'approved', 'blocked', 'completed']);
  const systemSeries = makeSeries(days, ['workflowFailed', 'workflowPending', 'notificationFailed', 'notificationPending']);
  const payoutsSeries = makeSeries(days, ['count', 'amount']);

  const leadsSeriesIndex = makeSeriesIndex(leadsSeries);
  const tasksSeriesIndex = makeSeriesIndex(tasksSeries);
  const eventsSeriesIndex = makeSeriesIndex(eventsSeries);
  const onboardingSeriesIndex = makeSeriesIndex(onboardingSeries);
  const systemSeriesIndex = makeSeriesIndex(systemSeries);
  const payoutsSeriesIndex = makeSeriesIndex(payoutsSeries);

  const leadsByStatus = new Map();
  const tasksByStatus = new Map();
  const tasksByType = new Map();
  const eventsByStatus = new Map();
  const eventsByKind = new Map();
  const eventsByType = new Map();
  const eventsByLocation = new Map();
  const accountsByStatus = new Map();
  const peopleByRole = new Map();
  const peopleByReadiness = new Map();
  const workflowByType = new Map();
  const workflowByStatus = new Map();
  const notificationsByChannel = new Map();
  const notificationsByStatus = new Map();
  const vendorsByCategory = new Map();
  const vendorsByStatus = new Map();
  const assetsByType = new Map();
  const assetsByStatus = new Map();
  const formsByStatus = new Map();
  const locationsByState = new Map();
  const eventTypesByCategory = new Map();
  const payoutsByStatus = new Map();

  for (const lead of leads) {
    incrementCount(leadsByStatus, cleanStr(lead.status, 40));
    const dateKey = ymdFromValue(lead.created_at);
    const statusKey = cleanStr(lead.status, 40) || 'new';
    bumpSeries(leadsSeriesIndex, dateKey, ['new', 'working', 'booked', 'won', 'lost'].includes(statusKey) ? statusKey : 'new');
  }

  for (const task of tasks) {
    incrementCount(tasksByStatus, cleanStr(task.status, 40));
    incrementCount(tasksByType, cleanStr(task.task_type, 40));
    const dateKey = ymdFromValue(task.created_at);
    bumpSeries(tasksSeriesIndex, dateKey, 'created');
    if (cleanStr(task.status, 40) === 'completed') bumpSeries(tasksSeriesIndex, ymdFromValue(task.updated_at || task.created_at), 'completed');
    if (cleanStr(task.status, 40) === 'blocked') bumpSeries(tasksSeriesIndex, ymdFromValue(task.updated_at || task.created_at), 'blocked');
    if (isTaskOverdue(task)) bumpSeries(tasksSeriesIndex, ymdFromValue(task.due_at || task.created_at), 'overdue');
  }

  for (const event of mergedEvents) {
    incrementCount(eventsByStatus, cleanStr(event.status, 40));
    incrementCount(eventsByKind, cleanStr(event.event_kind || asObject(event.meta).kind, 40) || 'delivery');
    incrementCount(eventsByType, cleanStr(event.event_type_label || event.event_type_code, 120) || 'untyped');
    incrementCount(eventsByLocation, cleanStr(event.location_name, 160) || 'unassigned');

    const createdDate = ymdFromValue(event.created_at || event.event_date || event.starts_at);
    const status = cleanStr(event.status, 40);
    bumpSeries(eventsSeriesIndex, createdDate, 'scheduled');
    if (['completed', 'closed'].includes(status)) bumpSeries(eventsSeriesIndex, ymdFromValue(event.event_date || event.starts_at), 'completed');
    if (staffingRisk(event)) bumpSeries(eventsSeriesIndex, ymdFromValue(event.event_date || event.starts_at), 'staffingRisk');
    if (cleanStr(event.report_status, 40) && !['sent', 'completed'].includes(cleanStr(event.report_status, 40))) {
      bumpSeries(eventsSeriesIndex, ymdFromValue(event.event_date || event.starts_at), 'reportPending');
    }
  }

  for (const submission of submissions) {
    const dateKey = ymdFromValue(submission.submitted_at || submission.created_at);
    const status = cleanStr(submission.status, 40);
    if (status === 'submitted') bumpSeries(onboardingSeriesIndex, dateKey, 'submitted');
    if (status === 'approved') bumpSeries(onboardingSeriesIndex, ymdFromValue(submission.created_at), 'approved');
  }

  for (const journey of journeys) {
    const dateKey = ymdFromValue(journey.updated_at || journey.created_at);
    const status = cleanStr(journey.status, 40);
    if (status === 'blocked') bumpSeries(onboardingSeriesIndex, dateKey, 'blocked');
    if (status === 'completed') bumpSeries(onboardingSeriesIndex, dateKey, 'completed');
  }

  for (const workflowEvent of workflowEvents) {
    incrementCount(workflowByType, cleanStr(workflowEvent.event_type, 120));
    incrementCount(workflowByStatus, cleanStr(workflowEvent.status, 40));
    const dateKey = ymdFromValue(workflowEvent.occurred_at);
    if (cleanStr(workflowEvent.status, 40) === 'failed') bumpSeries(systemSeriesIndex, dateKey, 'workflowFailed');
    if (cleanStr(workflowEvent.status, 40) === 'pending') bumpSeries(systemSeriesIndex, dateKey, 'workflowPending');
  }

  for (const notification of notifications) {
    incrementCount(notificationsByChannel, cleanStr(notification.channel, 40));
    incrementCount(notificationsByStatus, cleanStr(notification.status, 40));
    const dateKey = ymdFromValue(notification.created_at || notification.scheduled_for || notification.sent_at);
    if (cleanStr(notification.status, 40) === 'failed') bumpSeries(systemSeriesIndex, dateKey, 'notificationFailed');
    if (cleanStr(notification.status, 40) === 'pending') bumpSeries(systemSeriesIndex, dateKey, 'notificationPending');
  }

  for (const payout of payouts) {
    incrementCount(payoutsByStatus, cleanStr(payout.status, 40));
    const dateKey = ymdFromValue(payout.created_at);
    bumpSeries(payoutsSeriesIndex, dateKey, 'count');
    bumpSeries(payoutsSeriesIndex, dateKey, 'amount', safeNumber(payout.amount_cents) / 100);
  }

  for (const account of accounts) incrementCount(accountsByStatus, cleanStr(account.status, 40));
  for (const person of people) {
    incrementCount(peopleByRole, cleanStr(person.role, 40));
    incrementCount(peopleByReadiness, cleanStr(person.readiness_status, 40));
  }
  for (const location of locations) incrementCount(locationsByState, cleanStr(location.state, 20) || 'unknown');
  for (const item of eventTypes) incrementCount(eventTypesByCategory, cleanStr(item.category, 80) || 'uncategorized');
  for (const vendor of vendors) {
    incrementCount(vendorsByCategory, cleanStr(vendor.service_category, 80) || 'uncategorized');
    incrementCount(vendorsByStatus, cleanStr(vendor.status, 40));
  }
  for (const asset of assets) {
    incrementCount(assetsByType, cleanStr(asset.asset_type, 80) || 'uncategorized');
    incrementCount(assetsByStatus, cleanStr(asset.status, 40));
  }
  for (const response of formResponses) incrementCount(formsByStatus, cleanStr(response.status, 40));

  const activePeople = people.filter((person) => ['active', 'contractor'].includes(cleanStr(person.employment_status, 40)));
  const readyPeople = activePeople.filter((person) => cleanStr(person.readiness_status, 40) === 'ready');
  const notReadyPeople = activePeople.filter((person) => cleanStr(person.readiness_status, 40) !== 'ready');
  const openTasks = tasks.filter((task) => isOpenTaskStatus(task.status));
  const blockedTasks = tasks.filter((task) => cleanStr(task.status, 40) === 'blocked');
  const overdueTasks = tasks.filter((task) => isTaskOverdue(task));
  const unassignedTasks = openTasks.filter((task) => !cleanStr(task.assigned_user_id, 80));
  const readyIdlePeople = readyPeople.filter((person) => {
    if (person.can_be_assigned === false) return false;
    return !openTasks.some((task) => cleanStr(task.assigned_user_id, 80) === cleanStr(person.user_id, 80));
  });
  const upcomingEvents = mergedEvents.filter((event) => eventIsUpcoming(event, today, horizon));
  const staffingRiskEvents = mergedEvents.filter((event) => staffingRisk(event));
  const reportPendingEvents = mergedEvents.filter((event) => {
    const reportStatus = cleanStr(event.report_status, 40);
    return eventIsUpcoming(event, today, addDaysYmd(today, 7)) && reportStatus && !['sent', 'completed'].includes(reportStatus);
  });
  const closureReadyEvents = mergedEvents.filter((event) => closureReady(event));
  const accountsAtRisk = accounts.filter((account) => ['at_risk', 'renewal'].includes(cleanStr(account.status, 40)));
  const ownerlessAccounts = accounts.filter((account) => !cleanStr(account.account_owner_user_id, 80));
  const pendingSubmissions = submissions.filter((submission) => ['submitted', 'in_review'].includes(cleanStr(submission.status, 40)));
  const blockedJourneys = journeys.filter((journey) => cleanStr(journey.status, 40) === 'blocked');
  const intakeLeads = leads.filter((lead) => ['new', 'working', 'booked'].includes(cleanStr(lead.status, 40)));
  const failedWorkflow = workflowEvents.filter((item) => cleanStr(item.status, 40) === 'failed');
  const pendingWorkflow = workflowEvents.filter((item) => cleanStr(item.status, 40) === 'pending');
  const failedNotifications = notifications.filter((item) => cleanStr(item.status, 40) === 'failed');
  const pendingNotifications = notifications.filter((item) => cleanStr(item.status, 40) === 'pending');
  const payoutTotal = payouts.reduce((sum, row) => sum + safeNumber(row.amount_cents), 0) / 100;

  const upcomingEventIds = new Set(upcomingEvents.map((event) => safeNumber(event.id)));
  const staffingRiskEventIds = new Set(staffingRiskEvents.map((event) => safeNumber(event.id)));
  const reportPendingEventIds = new Set(reportPendingEvents.map((event) => safeNumber(event.id)));
  const territoryByState = new Map();

  function ensureTerritory(stateKey) {
    const cleanState = cleanStr(stateKey, 20) || 'Unknown';
    if (!territoryByState.has(cleanState)) {
      territoryByState.set(cleanState, {
        state: cleanState,
        locations: 0,
        upcoming: 0,
        staffingRisk: 0,
        reportPending: 0,
        defaultEventTypeCounts: new Map(),
      });
    }
    return territoryByState.get(cleanState);
  }

  for (const location of locations) {
    const territory = ensureTerritory(location.state);
    territory.locations += 1;
    incrementCount(territory.defaultEventTypeCounts, cleanStr(location.default_event_type_code, 80) || 'untyped');
  }

  for (const event of mergedEvents) {
    const location = locationById.get(safeNumber(event.location_id)) || null;
    const territory = ensureTerritory(location?.state || event.state || 'Unknown');
    const eventId = safeNumber(event.id);
    if (upcomingEventIds.has(eventId)) territory.upcoming += 1;
    if (staffingRiskEventIds.has(eventId)) territory.staffingRisk += 1;
    if (reportPendingEventIds.has(eventId)) territory.reportPending += 1;
  }

  const territoryLoad = Array.from(territoryByState.values())
    .map((row) => ({
      state: row.state,
      locations: row.locations,
      upcoming: row.upcoming,
      staffingRisk: row.staffingRisk,
      reportPending: row.reportPending,
      defaultEventType: topKeyFromCountMap(row.defaultEventTypeCounts),
    }))
    .sort((left, right) => (right.upcoming + right.staffingRisk + right.reportPending) - (left.upcoming + left.staffingRisk + left.reportPending) || String(left.state).localeCompare(String(right.state)))
    .slice(0, 8);

  const vendorCoverageMap = new Map();
  for (const vendor of vendors) {
    const category = cleanStr(vendor.service_category, 80) || 'uncategorized';
    if (!vendorCoverageMap.has(category)) vendorCoverageMap.set(category, { category, total: 0, active: 0 });
    const row = vendorCoverageMap.get(category);
    row.total += 1;
    if (['active', 'approved', 'ready', 'available'].includes(cleanStr(vendor.status, 40))) row.active += 1;
  }
  const vendorCoverage = Array.from(vendorCoverageMap.values())
    .sort((left, right) => right.total - left.total || String(left.category).localeCompare(String(right.category)))
    .slice(0, 8);

  const eventTypeMixMap = new Map();
  for (const event of mergedEvents) {
    const code = cleanStr(event.event_type_code, 80) || 'untyped';
    if (!eventTypeMixMap.has(code)) {
      const typeRow = eventTypeByCode.get(code) || null;
      eventTypeMixMap.set(code, {
        code,
        label: cleanStr(event.event_type_label, 160) || code,
        category: cleanStr(typeRow?.category, 80) || 'general',
        count: 0,
      });
    }
    eventTypeMixMap.get(code).count += 1;
  }
  const eventTypeMix = Array.from(eventTypeMixMap.values())
    .sort((left, right) => right.count - left.count || String(left.label).localeCompare(String(right.label)))
    .slice(0, 8);

  const summary = {
    pipeline: {
      total: leads.length,
      intake: intakeLeads.length,
      new: safeNumber(leadsByStatus.get('new')),
      working: safeNumber(leadsByStatus.get('working')),
      booked: safeNumber(leadsByStatus.get('booked')),
      won: safeNumber(leadsByStatus.get('won')),
      lost: safeNumber(leadsByStatus.get('lost')),
    },
    accounts: {
      total: accounts.length,
      active: safeNumber(accountsByStatus.get('active')),
      atRisk: accountsAtRisk.length,
      ownerless: ownerlessAccounts.length,
    },
    people: {
      total: people.length,
      active: activePeople.length,
      ready: readyPeople.length,
      notReady: notReadyPeople.length,
      readyIdle: readyIdlePeople.length,
    },
    tasks: {
      total: tasks.length,
      open: openTasks.length,
      blocked: blockedTasks.length,
      overdue: overdueTasks.length,
      unassigned: unassignedTasks.length,
    },
    events: {
      total: mergedEvents.length,
      upcoming: upcomingEvents.length,
      staffingRisk: staffingRiskEvents.length,
      reportPending: reportPendingEvents.length,
      closureReady: closureReadyEvents.length,
    },
    onboarding: {
      submissionsPending: pendingSubmissions.length,
      journeysBlocked: blockedJourneys.length,
      journeysActive: journeys.filter((journey) => cleanStr(journey.status, 40) === 'active').length,
      journeysCompleted: journeys.filter((journey) => cleanStr(journey.status, 40) === 'completed').length,
    },
    system: {
      workflowFailed: failedWorkflow.length,
      workflowPending: pendingWorkflow.length,
      notificationsFailed: failedNotifications.length,
      notificationsPending: pendingNotifications.length,
    },
    finance: {
      payoutRecords: payouts.length,
      payoutTotal,
      payoutPending: safeNumber(payoutsByStatus.get('pending')),
    },
    foundation: {
      locations: locations.length,
      eventTypes: eventTypes.length,
      vendors: vendors.length,
      assets: assets.length,
      formTemplates: formTemplates.length,
      formResponses: formResponses.length,
    },
    access,
  };

  const response = {
    ok: true,
    generatedAt: new Date().toISOString(),
    role,
    actorUserId,
    windowDays,
    horizonDays,
    sources: {
      portal_leads: hasLeads,
      portal_accounts: hasAccounts,
      portal_people: hasPeople,
      portal_tasks: hasTasks,
      portal_events: hasEvents,
      portal_event_operations_snapshot_v: hasEventSnapshot,
      portal_intake_submissions: hasOnboarding,
      portal_onboarding_journeys: hasJourneys,
      portal_workflow_events: hasWorkflow,
      portal_notification_queue: hasNotifications,
      portal_payouts: hasPayouts,
      portal_locations: hasLocations,
      portal_event_types: hasEventTypes,
      portal_vendors: hasVendors,
      portal_assets: hasAssets,
      portal_form_templates: hasFormTemplates,
      portal_form_responses: hasFormResponses,
    },
    summary,
    series: {
      leads: leadsSeries,
      tasks: tasksSeries,
      events: eventsSeries,
      onboarding: onboardingSeries,
      system: systemSeries,
      payouts: payoutsSeries,
    },
    breakdowns: {
      leadsByStatus: breakdownFromMap(leadsByStatus),
      tasksByStatus: breakdownFromMap(tasksByStatus),
      tasksByType: breakdownFromMap(tasksByType),
      eventsByStatus: breakdownFromMap(eventsByStatus),
      eventsByKind: breakdownFromMap(eventsByKind),
      eventsByType: breakdownFromMap(eventsByType),
      eventsByLocation: breakdownFromMap(eventsByLocation),
      accountsByStatus: breakdownFromMap(accountsByStatus),
      peopleByRole: breakdownFromMap(peopleByRole),
      peopleByReadiness: breakdownFromMap(peopleByReadiness),
      workflowByType: breakdownFromMap(workflowByType),
      workflowByStatus: breakdownFromMap(workflowByStatus),
      notificationsByChannel: breakdownFromMap(notificationsByChannel),
      notificationsByStatus: breakdownFromMap(notificationsByStatus),
      vendorsByCategory: breakdownFromMap(vendorsByCategory),
      vendorsByStatus: breakdownFromMap(vendorsByStatus),
      assetsByType: breakdownFromMap(assetsByType),
      assetsByStatus: breakdownFromMap(assetsByStatus),
      formsByStatus: breakdownFromMap(formsByStatus),
      locationsByState: breakdownFromMap(locationsByState),
      eventTypesByCategory: breakdownFromMap(eventTypesByCategory),
      payoutsByStatus: breakdownFromMap(payoutsByStatus),
      accessByStatus: access.byStatus,
    },
    queues: {
      overdueTasks: overdueTasks.slice(0, queueLimit).map(queueTaskRow),
      blockedTasks: blockedTasks.slice(0, queueLimit).map(queueTaskRow),
      unassignedTasks: unassignedTasks.slice(0, queueLimit).map(queueTaskRow),
      staffingRiskEvents: staffingRiskEvents.slice(0, queueLimit).map(queueEventRow),
      upcomingEvents: upcomingEvents.slice(0, queueLimit).map(queueEventRow),
      reportPendingEvents: reportPendingEvents.slice(0, queueLimit).map(queueEventRow),
      accountsAtRisk: accountsAtRisk.slice(0, queueLimit).map(queueAccountRow),
      ownerlessAccounts: ownerlessAccounts.slice(0, queueLimit).map(queueAccountRow),
      peopleNotReady: notReadyPeople.slice(0, queueLimit).map(queuePersonRow),
      readyIdlePeople: readyIdlePeople.slice(0, queueLimit).map(queuePersonRow),
      pendingSubmissions: pendingSubmissions.slice(0, queueLimit).map((submission) => ({
        id: submission.id,
        label: cleanStr(submission.title, 200) || cleanStr(submission.intake_type, 120) || `Submission ${submission.id}`,
        meta: compactLabel(cleanStr(submission.status, 40), cleanStr(submission.assigned_user_id, 80), cleanStr(submission.person_user_id, 80)),
        submissionId: submission.id,
      })),
      blockedJourneys: blockedJourneys.slice(0, queueLimit).map(queueJourneyRow),
      failedWorkflow: failedWorkflow.slice(0, queueLimit).map(queueWorkflowRow),
      failedNotifications: failedNotifications.slice(0, queueLimit).map(queueNotificationRow),
    },
    highlights: {
      recentLeads: intakeLeads.slice(0, queueLimit).map((lead) => ({
        id: lead.id,
        label: compactLabel(cleanStr(lead.property_name, 160), cleanStr(lead.company, 160)) || `Lead ${lead.id}`,
        meta: compactLabel(cleanStr(lead.status, 40), cleanStr(lead.source, 80), ymdFromValue(lead.created_at)),
        leadId: lead.id,
      })),
      recentTasks: tasks.slice(0, queueLimit).map(queueTaskRow),
      recentEvents: mergedEvents.slice(0, queueLimit).map(queueEventRow),
    },
    operations: {
      territoryLoad,
      vendorCoverage,
      eventTypeMix,
    },
    drilldowns: {
      overdueTasks: { tab: 'tasks', filters: { status: ['open', 'in_progress', 'blocked'], overdue: true } },
      blockedTasks: { tab: 'tasks', filters: { status: ['blocked'] } },
      unassignedTasks: { tab: 'tasks', filters: { status: ['open', 'in_progress', 'blocked'], assigned: 'unassigned' } },
      staffingRiskEvents: { tab: 'events', filters: { staffingRisk: true } },
      upcomingEvents: { tab: 'events', filters: { upcoming: true, horizonDays } },
      reportPendingEvents: { tab: 'events', filters: { reportStatus: ['not_started', 'draft', 'queued', 'pending'] } },
      accountsAtRisk: { tab: 'accounts', filters: { status: ['at_risk', 'renewal'] } },
      ownerlessAccounts: { tab: 'accounts', filters: { owner: 'missing' } },
      peopleNotReady: { tab: 'people', filters: { readinessStatus: ['not_started', 'in_training', 'shadowing', 'restricted'] } },
      readyIdlePeople: { tab: 'people', filters: { readinessStatus: ['ready'], idle: true } },
      pendingSubmissions: { tab: 'manager', subtab: 'admin', filters: { submissionStatus: ['submitted', 'in_review'] } },
      blockedJourneys: { tab: 'manager', subtab: 'admin', filters: { journeyStatus: ['blocked'] } },
      failedWorkflow: { tab: 'manager', subtab: 'admin', filters: { workflowStatus: ['failed'] } },
      failedNotifications: { tab: 'manager', subtab: 'admin', filters: { notificationStatus: ['failed'] } },
    },
  };

  return sendJson(res, 200, response);
};