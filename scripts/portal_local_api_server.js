const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');
const { bookingIntegrationSummary } = require('../lib/portalBooking');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const MANAGER_EMAIL = 'manager@demo.purestaync.com';
const MANAGER_PREVIEW_CODE = process.env.PORTAL_PREVIEW_ACCESS_CODE || 'manager123';
const ACCESS_TOKEN = 'local-preview-manager-token';
const REFRESH_TOKEN = 'local-preview-manager-refresh-token';

const managerProfile = {
  role: 'manager',
  fullName: 'PureStay Manager',
  createdAt: '2026-01-15T14:00:00.000Z',
};

const managerUser = {
  id: 'local-manager-user',
  email: MANAGER_EMAIL,
};

const managerPerson = {
  user_id: managerUser.id,
  role: 'manager',
  full_name: managerProfile.fullName,
  employment_status: 'active',
  readiness_status: 'ready',
  team_code: 'OPS',
  manager_user_id: '',
  can_be_assigned: true,
  home_base_city: 'Charlotte',
  home_base_state: 'NC',
  created_at: managerProfile.createdAt,
  updated_at: '2026-04-07T09:00:00.000Z',
};

const managerCapabilities = {
  realRole: 'manager',
  effectiveRole: 'manager',
  viewAsActive: false,
  viewAsPreviewOnly: false,
  canAccessPeopleWorkspace: true,
  canViewPeopleDirectoryData: true,
  canManagePeople: true,
  canAssignPeopleManagers: true,
  canManageUsers: true,
  canManageUserAccess: true,
  canManageAdmin: true,
  canAccessManagerWorkspace: true,
  canAccessManagerRoster: true,
  canAccessManagerAdmin: true,
  canCoordinateOperations: true,
  canCreateFoundationTasks: true,
  canManageAccounts: true,
};

let nextLeadId = 5;
let nextEventId = 4;
let nextTaskId = 4;
let nextThreadId = 3;
let nextIntakeId = 1;
let nextOnboardingSubmissionId = 2;
let nextOnboardingJourneyId = 3;

const leads = [
  {
    id: 1,
    first_name: 'Avery',
    last_name: 'Cole',
    email: 'avery@harborflats.com',
    phone: '704-555-0100',
    company: 'Harbor Flats',
    property_name: 'Harbor Flats Uptown',
    city: 'Charlotte',
    state: 'NC',
    status: 'new',
    assigned_role: 'dialer',
    assigned_user_id: 'dialer-01',
    source: 'referral',
    notes: 'Requested pricing review before the quarterly meeting.',
    meta: { followup: '2026-04-09T14:00:00.000Z' },
  },
  {
    id: 2,
    first_name: 'Jordan',
    last_name: 'Miles',
    email: 'jordan@pinecrestliving.com',
    phone: '919-555-0141',
    company: 'Pinecrest Living',
    property_name: 'Pinecrest South',
    city: 'Raleigh',
    state: 'NC',
    status: 'qualified',
    assigned_role: 'account_manager',
    assigned_user_id: 'acct-02',
    source: 'site',
    notes: 'Annual meeting requested with onboarding handoff included.',
    meta: { followup: '2026-04-10T16:30:00.000Z' },
  },
  {
    id: 3,
    first_name: 'Taylor',
    last_name: 'Reed',
    email: 'taylor@meadowparkapts.com',
    phone: '803-555-0188',
    company: 'Meadow Park Apartments',
    property_name: 'Meadow Park',
    city: 'Columbia',
    state: 'SC',
    status: 'proposal',
    assigned_role: 'closer',
    assigned_user_id: 'closer-01',
    source: 'outbound',
    notes: 'Needs executive summary before proposal close.',
    meta: { followup: '2026-04-11T10:00:00.000Z' },
  },
  {
    id: 4,
    first_name: 'Morgan',
    last_name: 'Lane',
    email: 'morgan@bellriver.com',
    phone: '980-555-0195',
    company: 'Bell River Communities',
    property_name: 'Bell River East',
    city: 'Charlotte',
    state: 'NC',
    status: 'won',
    assigned_role: 'account_manager',
    assigned_user_id: 'acct-04',
    source: 'partner',
    notes: 'Move into onboarding and staffing readiness immediately.',
    meta: { followup: '2026-04-08T09:30:00.000Z' },
  },
];

const events = [
  {
    id: 1,
    title: 'Harbor Flats annual resident event',
    account_name: 'Harbor Flats',
    account: { name: 'Harbor Flats' },
    location: { location_name: 'Uptown courtyard' },
    city: 'Charlotte',
    state: 'NC',
    event_date: '2026-04-12',
    start_time: '17:30',
    end_time: '20:00',
    starts_at: '2026-04-12T17:30:00.000Z',
    ends_at: '2026-04-12T20:00:00.000Z',
    status: 'assigned',
    assigned_role: 'event_coordinator',
    area_tag: 'events',
    event_kind: 'delivery',
    payout_cents: 280000,
    execution_status: 'planned',
    logistics_status: 'in_progress',
    report_status: 'not_started',
    staffing: { requiredPeople: 4, acceptedPeople: 3 },
    notes: 'Quarterly client meeting plus live resident activation.',
  },
  {
    id: 2,
    title: 'Pinecrest onboarding kickoff',
    account_name: 'Pinecrest Living',
    account: { name: 'Pinecrest Living' },
    location: { location_name: 'Leasing office' },
    city: 'Raleigh',
    state: 'NC',
    event_date: '2026-04-15',
    start_time: '14:00',
    end_time: '15:30',
    starts_at: '2026-04-15T14:00:00.000Z',
    ends_at: '2026-04-15T15:30:00.000Z',
    status: 'open',
    assigned_role: 'event_coordinator',
    area_tag: 'ops',
    event_kind: 'appointment',
    payout_cents: 0,
    execution_status: 'planned',
    logistics_status: 'not_started',
    report_status: 'not_started',
    staffing: { requiredPeople: 2, acceptedPeople: 2 },
    notes: 'Core annual meeting and onboarding readiness review.',
  },
  {
    id: 3,
    title: 'Bell River dispatch media follow-through',
    account_name: 'Bell River Communities',
    account: { name: 'Bell River Communities' },
    location: { location_name: 'Pool deck' },
    city: 'Charlotte',
    state: 'NC',
    event_date: '2026-04-09',
    start_time: '11:00',
    end_time: '13:00',
    starts_at: '2026-04-09T11:00:00.000Z',
    ends_at: '2026-04-09T13:00:00.000Z',
    status: 'in_progress',
    assigned_role: 'media_team',
    area_tag: 'media',
    event_kind: 'dispatch',
    payout_cents: 95000,
    execution_status: 'in_progress',
    logistics_status: 'complete',
    report_status: 'in_progress',
    staffing: { requiredPeople: 1, acceptedPeople: 1 },
    notes: 'Capture recap assets and closeout notes.',
  },
];

const tasks = [
  {
    id: 1,
    title: 'Confirm Harbor Flats staffing gap',
    description: 'Close the last coordinator coverage gap before the weekend event.',
    taskType: 'event',
    status: 'blocked',
    priority: 3,
    dueAt: '2026-04-08T16:00:00.000Z',
    assignedUserId: 'ops-01',
    leadId: null,
    eventId: 1,
    accountId: null,
    source: 'portal_tasks',
  },
  {
    id: 2,
    title: 'Draft Pinecrest quarterly meeting brief',
    description: 'Summarize onboarding state, open risks, and next checkpoints.',
    taskType: 'account',
    status: 'open',
    priority: 2,
    dueAt: '2026-04-10T13:00:00.000Z',
    assignedUserId: 'acct-02',
    leadId: 2,
    eventId: 2,
    accountId: null,
    source: 'portal_tasks',
  },
  {
    id: 3,
    title: 'Send Bell River recap follow-up',
    description: 'Close the loop on resident response and vendor follow-through.',
    taskType: 'followup',
    status: 'in_progress',
    priority: 1,
    dueAt: '2026-04-07T19:00:00.000Z',
    assignedUserId: managerUser.id,
    leadId: 4,
    eventId: 3,
    accountId: null,
    source: 'portal_tasks',
  },
];

const previewVendors = [
  { name: 'Queen City Catering', type: 'catering', coverage: 'Charlotte, NC', contact: '704-555-2121 • catering@queencity.test' },
  { name: 'Raleigh Resident DJ Co', type: 'entertainment', coverage: 'Raleigh, NC', contact: '919-555-4411 • bookings@raleighdj.test' },
  { name: 'Coastal Photo Booth', type: 'photo', coverage: 'Charlotte, NC', contact: '704-555-8891 • hello@coastalbooth.test' },
  { name: 'Palmetto Security Team', type: 'security', coverage: 'Columbia, SC', contact: '803-555-1055 • ops@palmetto-sec.test' },
  { name: 'Triangle Floral Studio', type: 'decor', coverage: 'Raleigh, NC', contact: '919-555-0062 • studio@trianglefloral.test' },
  { name: 'Blue Ridge Shuttle', type: 'transport', coverage: 'Charlotte, NC', contact: '704-555-1120 • dispatch@blueridge-shuttle.test' },
];

const previewEventTypes = [
  { name: 'Resident appreciation', kind: 'anchor', goal: 'Retention and community trust', classFit: 'Class A / B+' },
  { name: 'Open house day', kind: 'momentum', goal: 'Prospect traffic and lead capture', classFit: 'Lease-up / active leasing' },
  { name: 'Food truck night', kind: 'anchor', goal: 'High participation with simple logistics', classFit: 'Large communities' },
  { name: 'Move-in welcome', kind: 'anchor', goal: 'Reduce churn and increase belonging', classFit: 'New resident cohorts' },
  { name: 'Pool social', kind: 'momentum', goal: 'Seasonal engagement and visuals', classFit: 'Sunbelt assets' },
  { name: 'Vendor day', kind: 'anchor', goal: 'Traffic plus partner visibility', classFit: 'Broad resident mix' },
];

let adminSettings = {
  bookingCalendarUrl: 'https://calendar.purestay.local/manager',
  stripeCheckoutUrl: 'https://payments.purestay.local/checkout',
  stripePricingUrl: 'https://payments.purestay.local/pricing',
  internalNotes: 'Local manager preview server is active for product iteration.',
  updatedAt: '2026-04-07T09:00:00.000Z',
};

const talentProfiles = {
  [managerUser.id]: {
    userId: managerUser.id,
    public: {
      displayName: managerProfile.fullName,
      role: 'manager',
      bio: 'Regional operations lead for preview mode.',
      homeBaseCity: 'Charlotte',
      homeBaseState: 'NC',
      specialties: ['operations', 'handoffs'],
      tone: ['direct', 'calm'],
      gear: ['laptop'],
      preferredPairings: [],
      notes: '',
      avatarDataUrl: '',
      updatedAt: '2026-04-07T09:00:00.000Z',
    },
    internal: {
      specialties: ['operations'],
      tone: ['direct'],
      gear: ['laptop'],
      preferredPairings: [],
      notes: '',
      reliability: { score: 100, flags: [] },
      updatedAt: '2026-04-07T09:00:00.000Z',
    },
    source: 'local_preview',
  },
  'hire-01': {
    userId: 'hire-01',
    public: {
      displayName: 'Morgan Lee',
      role: 'dialer',
      bio: 'New team member completing first-login setup.',
      homeBaseCity: 'Charlotte',
      homeBaseState: 'NC',
      specialties: ['phone outreach'],
      tone: ['steady'],
      gear: ['headset'],
      preferredPairings: [],
      notes: '',
      avatarDataUrl: '',
      updatedAt: '2026-04-07T08:40:00.000Z',
    },
    internal: {
      specialties: ['phone outreach'],
      tone: ['steady'],
      gear: ['headset'],
      preferredPairings: [],
      notes: 'Requested closer access during setup review.',
      reliability: { score: null, flags: [] },
      updatedAt: '2026-04-07T08:40:00.000Z',
    },
    source: 'local_preview',
  },
};

const onboardingByUser = {
  [managerUser.id]: {
    id: 1,
    personUserId: managerUser.id,
    status: 'completed',
    stageKey: 'ready',
    startedAt: '2026-01-15T14:00:00.000Z',
    targetReadyAt: '2026-01-15T14:00:00.000Z',
    completedAt: '2026-01-15T14:00:00.000Z',
    ownerUserId: managerUser.id,
    managerUserId: managerUser.id,
    updatedAt: '2026-04-07T09:00:00.000Z',
    notes: 'Preview manager account is already active.',
    meta: { approvalStatus: 'approved' },
  },
  'hire-01': {
    id: 2,
    personUserId: 'hire-01',
    status: 'pending',
    stageKey: 'pending_role_review',
    startedAt: '2026-04-07T08:10:00.000Z',
    targetReadyAt: '2026-04-08T17:00:00.000Z',
    completedAt: '',
    ownerUserId: managerUser.id,
    managerUserId: managerUser.id,
    updatedAt: '2026-04-07T08:46:00.000Z',
    notes: 'Requested role differs from approved provisioning role. Review before workspace release.',
    checklist: {
      accessActivated: true,
      profileCompleted: true,
      roleConfirmed: false,
    },
    collectedData: {
      requestedRole: 'closer',
      approvedRole: 'dialer',
    },
    meta: {
      approvalStatus: 'in_review',
      requestedRole: 'closer',
      approvedRole: 'dialer',
    },
  },
};

const accessAccounts = [
  {
    userId: managerUser.id,
    fullName: managerProfile.fullName,
    email: managerUser.email,
    role: 'manager',
    employmentStatus: 'active',
    readinessStatus: 'ready',
    managerUserId: '',
    managerName: '',
    authIdentity: { status: 'active' },
    accessAudit: {
      provisionedAt: '2026-01-15T14:00:00.000Z',
      lastActionLabel: 'Preview session ready',
      lastActorName: 'Local preview server',
      lastActorUserId: 'system',
      suspendedAt: '',
      restoredAt: '',
    },
    supports: { invite: false },
  },
  {
    userId: 'acct-02',
    fullName: 'Jordan Miles',
    email: 'jordan@demo.purestaync.com',
    role: 'account_manager',
    employmentStatus: 'active',
    readinessStatus: 'ready',
    managerUserId: managerUser.id,
    managerName: managerProfile.fullName,
    authIdentity: { status: 'active' },
    accessAudit: {
      provisionedAt: '2026-02-10T12:00:00.000Z',
      lastActionLabel: 'Invite resent',
      lastActorName: managerProfile.fullName,
      lastActorUserId: managerUser.id,
      suspendedAt: '',
      restoredAt: '',
    },
    supports: { invite: true },
  },
  {
    userId: 'ops-01',
    fullName: 'Riley Brooks',
    email: 'riley@demo.purestaync.com',
    role: 'event_coordinator',
    employmentStatus: 'active',
    readinessStatus: 'active',
    managerUserId: managerUser.id,
    managerName: managerProfile.fullName,
    authIdentity: { status: 'active' },
    accessAudit: {
      provisionedAt: '2026-02-28T10:15:00.000Z',
      lastActionLabel: 'Password reset sent',
      lastActorName: managerProfile.fullName,
      lastActorUserId: managerUser.id,
      suspendedAt: '',
      restoredAt: '',
    },
    supports: { invite: true },
  },
  {
    userId: 'hire-01',
    fullName: 'Morgan Lee',
    email: 'morgan@demo.purestaync.com',
    role: 'dialer',
    employmentStatus: 'candidate',
    readinessStatus: 'in_training',
    managerUserId: managerUser.id,
    managerName: managerProfile.fullName,
    canBeAssigned: false,
    homeBaseCity: 'Charlotte',
    homeBaseState: 'NC',
    authIdentity: { status: 'active' },
    accessAudit: {
      provisionedAt: '2026-04-07T08:05:00.000Z',
      lastActionLabel: 'Profile setup submitted for review',
      lastActorName: 'Morgan Lee',
      lastActorUserId: 'hire-01',
      suspendedAt: '',
      restoredAt: '',
    },
    supports: { invite: true },
    createdAt: '2026-04-07T08:05:00.000Z',
    updatedAt: '2026-04-07T08:46:00.000Z',
  },
];

const accessHistory = {
  [managerUser.id]: [
    { actionLabel: 'Preview session initialized', createdAt: '2026-04-07T09:00:00.000Z', actorName: 'Local preview server', actorUserId: 'system' },
  ],
  'acct-02': [
    { actionLabel: 'Invite resent', createdAt: '2026-04-06T11:20:00.000Z', actorName: managerProfile.fullName, actorUserId: managerUser.id },
    { actionLabel: 'Access provisioned', createdAt: '2026-02-10T12:00:00.000Z', actorName: managerProfile.fullName, actorUserId: managerUser.id },
  ],
  'ops-01': [
    { actionLabel: 'Password reset sent', createdAt: '2026-04-06T08:10:00.000Z', actorName: managerProfile.fullName, actorUserId: managerUser.id },
    { actionLabel: 'Access provisioned', createdAt: '2026-02-28T10:15:00.000Z', actorName: managerProfile.fullName, actorUserId: managerUser.id },
  ],
  'hire-01': [
    { actionLabel: 'Role review requested', createdAt: '2026-04-07T08:46:00.000Z', actorName: 'Morgan Lee', actorUserId: 'hire-01' },
    { actionLabel: 'Access provisioned', createdAt: '2026-04-07T08:05:00.000Z', actorName: managerProfile.fullName, actorUserId: managerUser.id },
  ],
};

const threads = [
  {
    id: 'thread-1',
    title: 'What should I decide first before anything slips?',
    summary: 'Manager operating brief across leads, staffing, and delivery risk.',
    messageCount: 2,
    updatedAt: '2026-04-07T08:45:00.000Z',
    lastMessageAt: '2026-04-07T08:45:00.000Z',
  },
  {
    id: 'thread-2',
    title: 'whats going on',
    summary: 'Current workload and next steps across clients and fulfillment.',
    messageCount: 2,
    updatedAt: '2026-04-07T09:15:00.000Z',
    lastMessageAt: '2026-04-07T09:15:00.000Z',
  },
];

const threadMessages = {
  'thread-1': [
    { id: 'm-1', role: 'user', content: 'What should I decide first before anything slips?' },
    { id: 'm-2', role: 'assistant', content: 'Start with the staffing gap on Harbor Flats, then clear the blocked task and confirm the Pinecrest meeting brief owner.' },
  ],
  'thread-2': [
    { id: 'm-3', role: 'user', content: 'whats going on' },
    { id: 'm-4', role: 'assistant', content: 'You have one new client ready for outreach, one onboarding kickoff due this week, and one blocked staffing item that needs a manager decision.' },
  ],
};

const publicIntakes = [];
const onboardingSubmissions = [
  {
    id: 1,
    personUserId: 'hire-01',
    ownerUserId: managerUser.id,
    assignedUserId: managerUser.id,
    intakeType: 'employee_onboarding',
    status: 'submitted',
    subjectRole: 'closer',
    title: 'Role review requested',
    description: 'Requested role change from dialer to closer during first-login setup.',
    normalizedData: {
      requestedRole: 'closer',
      approvedRole: 'dialer',
      approvalStatus: 'in_review',
    },
    meta: {
      requestedRole: 'closer',
      approvedRole: 'dialer',
      approvalStatus: 'in_review',
      requestSource: 'first_login_setup',
    },
    createdAt: '2026-04-07T08:46:00.000Z',
    updatedAt: '2026-04-07T08:46:00.000Z',
    submittedAt: '2026-04-07T08:46:00.000Z',
  },
];

function cleanText(value, maxLen) {
  return String(value || '').trim().slice(0, maxLen);
}

function cleanEmail(value) {
  return cleanText(value, 200).toLowerCase();
}

function cleanPhone(value) {
  return cleanText(value, 40).replace(/[^\d+x#*()\-\.\s]/g, '');
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stablePreviewDedupKey(source, parts = []) {
  const seed = [cleanText(source, 40).toLowerCase()]
    .concat((Array.isArray(parts) ? parts : []).map((part) => cleanText(part, 240).toLowerCase()).filter(Boolean))
    .filter(Boolean)
    .join('|');
  if (!seed) return '';
  return `public_intake:${crypto.createHash('sha1').update(seed).digest('hex')}`;
}

function normalizePreviewPublicIntake(body = {}, req) {
  const contact = asObject(body.contact);
  const property = asObject(body.property);
  const requestedWindow = asObject(body.requestedWindow);
  const context = asObject(body.context);
  const firstName = cleanText(body.firstName || contact.firstName, 80);
  const lastName = cleanText(body.lastName || contact.lastName, 80);

  return {
    source: cleanText(body.source, 40).toLowerCase() || 'website',
    intakeChannel: cleanText(body.intakeChannel || body.intake_channel, 40).toLowerCase() || cleanText(body.source, 40).toLowerCase() || 'website',
    formKey: cleanText(body.formKey || body.form_key, 80),
    submittedAt: cleanText(body.submittedAt || body.submitted_at, 80) || nowIso(),
    contact: {
      name: cleanText(contact.name || [firstName, lastName].filter(Boolean).join(' '), 160),
      email: cleanEmail(body.email || contact.email),
      phone: cleanPhone(body.phone || contact.phone),
      company: cleanText(body.company || contact.company, 120),
    },
    property: {
      name: cleanText(body.propertyName || property.name, 160),
      address: cleanText(body.address || property.address, 200),
      city: cleanText(body.city || property.city, 120),
      state: cleanText(body.state || property.state, 20),
      postalCode: cleanText(body.postalCode || property.postalCode, 20),
    },
    requestedWindow: {
      date: cleanText(body.requestedDate || requestedWindow.date, 20),
      time: cleanText(body.requestedTime || requestedWindow.time, 40),
      tz: cleanText(body.requestedTz || requestedWindow.tz, 80),
    },
    context: {
      landingPage: cleanText(context.landingPage || body.landingPage, 240),
      pagePath: cleanText(context.pagePath || body.pagePath, 240),
      referrer: cleanText(context.referrer || body.referrer || req.headers.referer, 500),
      userAgent: cleanText(context.userAgent || req.headers['user-agent'], 500),
    },
    title: cleanText(body.title, 200),
    description: cleanText([body.description, body.message, body.notes].filter(Boolean).join('\n'), 4000),
    rawPayload: asObject(body),
  };
}

function previewLeadSignal(normalized) {
  return !!(
    cleanText(normalized?.contact?.name, 160) ||
    cleanEmail(normalized?.contact?.email) ||
    cleanPhone(normalized?.contact?.phone) ||
    cleanText(normalized?.contact?.company, 120) ||
    cleanText(normalized?.property?.name, 160)
  );
}

function splitName(value) {
  const compactValue = cleanText(String(value || '').replace(/\s+/g, ' '), 160);
  if (!compactValue) return { firstName: '', lastName: '' };
  const parts = compactValue.split(' ');
  return {
    firstName: cleanText(parts.shift(), 80),
    lastName: cleanText(parts.join(' '), 80),
  };
}

function findPreviewLead(normalized) {
  const email = cleanEmail(normalized?.contact?.email);
  const phone = cleanPhone(normalized?.contact?.phone);
  const propertyName = cleanText(normalized?.property?.name, 160).toLowerCase();
  return leads.find((lead) => {
    const emailMatch = email && cleanEmail(lead.email) === email;
    const phoneMatch = phone && cleanPhone(lead.phone) === phone;
    const propertyMatch = propertyName && cleanText(lead.property_name, 160).toLowerCase() === propertyName;
    return emailMatch || phoneMatch || propertyMatch;
  }) || null;
}

function upsertPreviewLeadFromIntake(normalized) {
  const existing = findPreviewLead(normalized);
  const name = splitName(normalized?.contact?.name);
  const requestedWindow = asObject(normalized.requestedWindow);
  const notes = [
    cleanText(normalized.description, 4000),
    [requestedWindow.date, requestedWindow.time, requestedWindow.tz].filter(Boolean).join(' ')
      ? `Requested window: ${[requestedWindow.date, requestedWindow.time, requestedWindow.tz].filter(Boolean).join(' ')}`
      : '',
    `Source: ${cleanText(normalized.source, 40)}`,
  ].filter(Boolean).join('\n');

  if (existing) {
    Object.assign(existing, {
      first_name: existing.first_name || name.firstName,
      last_name: existing.last_name || name.lastName,
      email: existing.email || normalized.contact.email,
      phone: existing.phone || normalized.contact.phone,
      company: existing.company || normalized.contact.company,
      property_name: existing.property_name || normalized.property.name,
      address: existing.address || normalized.property.address,
      city: existing.city || normalized.property.city,
      state: existing.state || normalized.property.state,
      postal_code: existing.postal_code || normalized.property.postalCode,
      notes: existing.notes || notes,
      meta: Object.assign({}, existing.meta || {}, {
        publicIntake: Object.assign({}, (existing.meta || {}).publicIntake || {}, {
          lastReceivedAt: normalized.submittedAt,
          lastSource: normalized.source,
          channels: Array.from(new Set([].concat((((existing.meta || {}).publicIntake || {}).channels || []), [normalized.intakeChannel]).filter(Boolean))),
        }),
      }),
    });
    return { lead: existing, action: 'matched' };
  }

  const lead = {
    id: nextLeadId++,
    first_name: name.firstName,
    last_name: name.lastName,
    email: normalized.contact.email,
    phone: normalized.contact.phone,
    company: normalized.contact.company,
    property_name: normalized.property.name,
    address: normalized.property.address,
    city: normalized.property.city,
    state: normalized.property.state,
    postal_code: normalized.property.postalCode,
    status: 'new',
    assigned_role: 'dialer',
    assigned_user_id: '',
    source: normalized.source,
    notes,
    meta: {
      publicIntake: {
        lastReceivedAt: normalized.submittedAt,
        lastSource: normalized.source,
        channels: [normalized.intakeChannel].filter(Boolean),
      },
    },
  };
  leads.unshift(lead);
  return { lead, action: 'created' };
}

function nowIso() {
  return new Date().toISOString();
}

function cleanList(value) {
  return Array.isArray(value)
    ? value.map((item) => cleanText(item, 80)).filter(Boolean)
    : [];
}

function normalizeTalentProfileInput(input = {}, { userId = '', role = '' } = {}) {
  const profile = input && typeof input === 'object' ? input : {};
  const publicInput = profile.public && typeof profile.public === 'object' ? profile.public : profile;
  const existing = talentProfiles[userId] || {};
  const existingPublic = existing.public && typeof existing.public === 'object' ? existing.public : {};
  const existingInternal = existing.internal && typeof existing.internal === 'object' ? existing.internal : {};
  return {
    userId,
    public: Object.assign({}, existingPublic, {
      displayName: cleanText(publicInput.displayName, existingPublic.displayName || ''),
      role: cleanText(existingPublic.role || role, role),
      bio: cleanText(publicInput.bio, existingPublic.bio || ''),
      homeBaseCity: cleanText(publicInput.homeBaseCity, existingPublic.homeBaseCity || ''),
      homeBaseState: cleanText(publicInput.homeBaseState, existingPublic.homeBaseState || ''),
      specialties: cleanList(publicInput.specialties).length ? cleanList(publicInput.specialties) : cleanList(existingPublic.specialties),
      tone: cleanList(publicInput.tone).length ? cleanList(publicInput.tone) : cleanList(existingPublic.tone),
      gear: cleanList(publicInput.gear).length ? cleanList(publicInput.gear) : cleanList(existingPublic.gear),
      preferredPairings: cleanList(publicInput.preferredPairings).length ? cleanList(publicInput.preferredPairings) : cleanList(existingPublic.preferredPairings),
      notes: cleanText(publicInput.notes, existingPublic.notes || ''),
      avatarDataUrl: cleanText(publicInput.avatarDataUrl, existingPublic.avatarDataUrl || ''),
      updatedAt: nowIso(),
    }),
    internal: Object.assign({}, existingInternal, {
      specialties: cleanList(existingInternal.specialties),
      tone: cleanList(existingInternal.tone),
      gear: cleanList(existingInternal.gear),
      preferredPairings: cleanList(existingInternal.preferredPairings),
      notes: cleanText(existingInternal.notes, ''),
      reliability: existingInternal.reliability || { score: null, flags: [] },
      updatedAt: nowIso(),
    }),
    source: 'local_preview',
  };
}

function findAccessAccount(userId) {
  return accessAccounts.find((account) => String(account.userId) === String(userId || '').trim()) || null;
}

function buildPreviewPersonDetail(userId) {
  const entry = findAccessAccount(userId) || (String(userId) === String(managerUser.id) ? accessAccounts[0] : null);
  if (!entry) return null;
  return {
    ok: true,
    person: {
      userId: entry.userId,
      role: entry.role,
      fullName: entry.fullName,
      email: entry.email,
      employmentStatus: entry.employmentStatus || 'active',
      readinessStatus: entry.readinessStatus || 'not_started',
      teamCode: entry.teamCode || 'OPS',
      managerUserId: entry.managerUserId || '',
      canBeAssigned: entry.canBeAssigned !== false,
      homeBaseCity: entry.homeBaseCity || 'Charlotte',
      homeBaseState: entry.homeBaseState || 'NC',
      createdAt: entry.createdAt || nowIso(),
      updatedAt: entry.updatedAt || nowIso(),
      meta: {},
      source: 'portal_people',
    },
    authIdentity: entry.authIdentity || { status: 'active', email: entry.email },
    identityRecord: {
      user_id: entry.userId,
      email: entry.email,
      credential_state: entry.authIdentity?.status || 'active',
    },
    employmentProfile: {
      person_user_id: entry.userId,
      employment_status: entry.employmentStatus || 'active',
      readiness_status: entry.readinessStatus || 'not_started',
      manager_user_id: entry.managerUserId || '',
      home_base_city: entry.homeBaseCity || 'Charlotte',
      home_base_state: entry.homeBaseState || 'NC',
      can_be_assigned: entry.canBeAssigned !== false,
    },
    talentProfile: talentProfiles[entry.userId] || null,
    availability: { source: 'local_preview', value: null },
    trainingSummary: { requiredCount: 1, passedCount: entry.readinessStatus === 'ready' ? 1 : 0, expiredCount: 0 },
    onboardingJourney: onboardingByUser[entry.userId] || null,
    openTaskCount: tasks.filter((task) => String(task.assignedUserId || '') === String(entry.userId) && ['open', 'in_progress', 'blocked'].includes(String(task.status || ''))).length,
    roleAuthorizations: [{ id: `${entry.userId}:${entry.role}`, role_code: entry.role, status: 'active', granted_at: entry.createdAt || nowIso() }],
    marketAssignments: [],
    documents: [],
    deviceAccessRecords: [],
    permissions: {
      canManage: true,
      canAssignManagerOwnership: true,
    },
  };
}

function onboardingJourneysList(personUserId = '') {
  const rows = Object.values(onboardingByUser || {});
  if (!personUserId) return rows;
  return rows.filter((row) => String(row.personUserId || row.ownerUserId || '') === String(personUserId) || String(findAccessAccount(personUserId)?.userId || '') === String(personUserId));
}

function adminSettingsPayload() {
  const booking = bookingIntegrationSummary();
  return Object.assign({}, adminSettings, {
    bookingPlatformConfigured: booking.configured,
    bookingPlatformProvider: booking.provider,
    bookingPlatformBaseUrl: booking.baseUrl,
    bookingPlatformAccountLinked: booking.accountLinked,
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Portal-View-As, X-Portal-View-As-User',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Portal-View-As, X-Portal-View-As-User',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end();
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function authToken(req) {
  const header = String(req.headers.authorization || '').trim();
  if (!/^Bearer\s+/i.test(header)) return '';
  return header.replace(/^Bearer\s+/i, '').trim();
}

function requireAuth(req, res) {
  const token = authToken(req);
  if (!token || (token !== ACCESS_TOKEN && token !== REFRESH_TOKEN)) {
    sendJson(res, 401, { ok: false, error: 'invalid_token' });
    return false;
  }
  return true;
}

function roleLabel(role) {
  return String(role || '').replace(/_/g, ' ');
}

function compact(text, max) {
  const value = String(text || '').trim().replace(/\s+/g, ' ');
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function queueLead(lead) {
  return {
    id: lead.id,
    label: `${lead.first_name} ${lead.last_name}`.trim(),
    meta: compact([lead.company || lead.property_name, lead.status].filter(Boolean).join(' • '), 120),
    leadId: lead.id,
  };
}

function queueEvent(event) {
  return {
    id: event.id,
    label: event.title,
    meta: compact([event.account_name, event.event_date, event.status].filter(Boolean).join(' • '), 120),
    eventId: event.id,
  };
}

function queueTask(task) {
  return {
    id: task.id,
    label: task.title,
    meta: compact([task.taskType, task.status, task.dueAt].filter(Boolean).join(' • '), 120),
    taskId: task.id,
  };
}

function queueSubmission(submission) {
  return {
    id: submission.id,
    label: submission.title || `Submission ${submission.id}`,
    meta: compact([submission.subjectRole, submission.status, submission.personUserId].filter(Boolean).join(' • '), 120),
    submissionId: submission.id,
    userId: submission.personUserId,
  };
}

function queueJourney(journey) {
  return {
    id: journey.id,
    label: humanizeLabel(journey.stageKey || `Journey ${journey.id}`),
    meta: compact([journey.status, journey.personUserId, journey.targetReadyAt].filter(Boolean).join(' • '), 120),
    journeyId: journey.id,
    userId: journey.personUserId,
  };
}

function queueSubmission(submission) {
  return {
    id: submission.id,
    label: submission.title,
    meta: compact([submission.subjectRole, submission.status, submission.personUserId].filter(Boolean).join(' • '), 120),
    submissionId: submission.id,
    userId: submission.personUserId,
  };
}

function queueJourney(journey) {
  return {
    id: journey.id,
    label: String(journey.stageKey || `journey ${journey.id}`).replace(/_/g, ' '),
    meta: compact([journey.status, journey.personUserId, journey.targetReadyAt].filter(Boolean).join(' • '), 120),
    journeyId: journey.id,
    userId: journey.personUserId,
  };
}

function buildOverview() {
  const intakeLeads = leads.filter((lead) => ['new', 'working', 'booked'].includes(String(lead.status || '').trim().toLowerCase()));
  const upcomingEvents = events.filter((event) => ['open', 'assigned', 'in_progress'].includes(event.status));
  const staffingRiskEvents = events.filter((event) => Number(event.staffing?.requiredPeople || 0) > Number(event.staffing?.acceptedPeople || 0));
  const reportPendingEvents = events.filter((event) => event.report_status !== 'complete');
  const openTasks = tasks.filter((task) => ['open', 'in_progress', 'blocked'].includes(task.status));
  const blockedTasks = tasks.filter((task) => task.status === 'blocked');
  const unassignedTasks = tasks.filter((task) => !task.assignedUserId);
  const overdueTasks = tasks.filter((task) => new Date(task.dueAt).getTime() < Date.now() && task.status !== 'completed');
  const pendingSubmissions = onboardingSubmissions.filter((submission) => ['submitted', 'in_review'].includes(String(submission.status || '').trim().toLowerCase()));
  const journeys = Object.values(onboardingByUser || {});
  const activeJourneys = journeys.filter((journey) => ['pending', 'queued', 'active'].includes(String(journey.status || '').trim().toLowerCase()));
  const blockedJourneys = journeys.filter((journey) => String(journey.status || '').trim().toLowerCase() === 'blocked');
  const territoryMap = new Map();

  for (const event of events) {
    const stateKey = String(event.state || 'Unknown').trim() || 'Unknown';
    if (!territoryMap.has(stateKey)) territoryMap.set(stateKey, { state: stateKey, locations: new Set(), upcoming: 0, staffingRisk: 0, reportPending: 0 });
    const row = territoryMap.get(stateKey);
    row.locations.add(String(event.location?.location_name || `${event.city || ''} site`).trim());
    if (upcomingEvents.includes(event)) row.upcoming += 1;
    if (staffingRiskEvents.includes(event)) row.staffingRisk += 1;
    if (reportPendingEvents.includes(event)) row.reportPending += 1;
  }

  const territoryLoad = Array.from(territoryMap.values()).map((row) => ({
    state: row.state,
    locations: row.locations.size,
    upcoming: row.upcoming,
    staffingRisk: row.staffingRisk,
    reportPending: row.reportPending,
  })).sort((left, right) => (right.upcoming + right.staffingRisk + right.reportPending) - (left.upcoming + left.staffingRisk + left.reportPending));

  const vendorCoverageMap = new Map();
  for (const vendor of previewVendors) {
    const key = String(vendor.type || 'general').trim();
    if (!vendorCoverageMap.has(key)) vendorCoverageMap.set(key, { category: key, total: 0, active: 0 });
    const row = vendorCoverageMap.get(key);
    row.total += 1;
    row.active += 1;
  }

  const eventTypeMixMap = new Map();
  for (const event of events) {
    const key = String(event.event_kind || 'general').trim();
    if (!eventTypeMixMap.has(key)) eventTypeMixMap.set(key, { label: key.replace(/_/g, ' '), category: key === 'appointment' ? 'planning' : 'activation', count: 0 });
    eventTypeMixMap.get(key).count += 1;
  }

  return {
    ok: true,
    generatedAt: nowIso(),
    summary: {
      pipeline: {
        intake: intakeLeads.length,
        new: leads.filter((lead) => lead.status === 'new').length,
        working: leads.filter((lead) => lead.status === 'working').length,
        booked: leads.filter((lead) => lead.status === 'booked').length,
      },
      onboarding: {
        submissionsPending: pendingSubmissions.length,
        journeysActive: activeJourneys.length,
        journeysBlocked: blockedJourneys.length,
      },
      events: {
        upcoming: upcomingEvents.length,
        staffingRisk: staffingRiskEvents.length,
        reportPending: reportPendingEvents.length,
      },
      tasks: {
        open: openTasks.length,
        unassigned: unassignedTasks.length,
      },
    },
    highlights: {
      recentLeads: intakeLeads.map(queueLead),
    },
    queues: {
      pendingSubmissions: pendingSubmissions.map(queueSubmission),
      blockedJourneys: blockedJourneys.map(queueJourney),
      ownerlessAccounts: [{ id: 'account-1', label: 'Bell River Communities', meta: 'Quarterly meeting date needs owner', accountId: 'account-1' }],
      upcomingEvents: upcomingEvents.map(queueEvent),
      staffingRiskEvents: staffingRiskEvents.map(queueEvent),
      reportPendingEvents: reportPendingEvents.map(queueEvent),
      overdueTasks: overdueTasks.map(queueTask),
      unassignedTasks: unassignedTasks.map(queueTask),
      blockedTasks: blockedTasks.map(queueTask),
      readyIdlePeople: [{ id: 'ops-01', label: 'Riley Brooks', meta: 'event coordinator • ready', userId: 'ops-01' }],
      peopleNotReady: [{ id: 'media-02', label: 'Skyler West', meta: 'media team • readiness follow-up', userId: 'media-02' }],
    },
    operations: {
      territoryLoad,
      vendorCoverage: Array.from(vendorCoverageMap.values()),
      eventTypeMix: Array.from(eventTypeMixMap.values()),
    },
  };
}

function filterByQuery(items, query, fields) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return items.slice();
  return items.filter((item) => fields.some((field) => String(item[field] || '').toLowerCase().includes(q)));
}

function threadRecord(threadId) {
  return threads.find((thread) => String(thread.id) === String(threadId)) || null;
}

function updateThreadMeta(thread) {
  const messages = threadMessages[thread.id] || [];
  thread.messageCount = messages.length;
  thread.updatedAt = nowIso();
  thread.lastMessageAt = thread.updatedAt;
  const assistantMessage = [...messages].reverse().find((message) => message.role === 'assistant');
  thread.summary = compact(assistantMessage?.content || thread.summary || 'Ready', 84);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendNoContent(res);
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = url.pathname;

  if (pathname === '/api/portal/auth_config' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, preview: { enabled: true } });
    return;
  }

  if (pathname === '/api/portal/public_intake' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: 'invalid_body' });
      return;
    }

    const normalized = normalizePreviewPublicIntake(body, req);
    if (!previewLeadSignal(normalized)) {
      sendJson(res, 422, { ok: false, error: 'insufficient_identity' });
      return;
    }

    const dedupKey = cleanText(body.dedupKey || body.dedup_key, 200) || stablePreviewDedupKey(normalized.source, [
      normalized.formKey,
      normalized.contact.email,
      normalized.contact.phone,
      normalized.property.name,
      normalized.requestedWindow.date,
      normalized.requestedWindow.time,
    ]);

    const existingIntake = publicIntakes.find((entry) => String(entry.dedupKey) === String(dedupKey)) || null;
    const linked = upsertPreviewLeadFromIntake(normalized);

    if (existingIntake) {
      existingIntake.lastSeenAt = normalized.submittedAt;
      existingIntake.leadId = linked.lead.id;
      existingIntake.leadAction = linked.action;
      sendJson(res, 200, {
        ok: true,
        intakeId: existingIntake.id,
        leadId: linked.lead.id,
        leadAction: linked.action,
        duplicate: true,
        dedupKey,
        source: normalized.source,
        intakeChannel: normalized.intakeChannel,
        formKey: normalized.formKey,
      });
      return;
    }

    const intake = {
      id: nextIntakeId++,
      dedupKey,
      source: normalized.source,
      intakeChannel: normalized.intakeChannel,
      formKey: normalized.formKey,
      submittedAt: normalized.submittedAt,
      leadId: linked.lead.id,
      leadAction: linked.action,
      normalizedData: normalized,
      payload: normalized.rawPayload,
      lastSeenAt: normalized.submittedAt,
    };
    publicIntakes.unshift(intake);

    sendJson(res, 200, {
      ok: true,
      intakeId: intake.id,
      leadId: linked.lead.id,
      leadAction: linked.action,
      duplicate: false,
      dedupKey,
      source: normalized.source,
      intakeChannel: normalized.intakeChannel,
      formKey: normalized.formKey,
    });
    return;
  }

  if (pathname === '/api/portal/login' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) {
      sendJson(res, 400, { ok: false, error: 'invalid_body' });
      return;
    }
    const previewCode = String(body.previewCode || body.preview_code || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '').trim();
    const previewAllowed = previewCode && previewCode === MANAGER_PREVIEW_CODE;
    const emailAllowed = email === MANAGER_EMAIL && password === MANAGER_PREVIEW_CODE;
    if (!previewAllowed && !emailAllowed) {
      sendJson(res, 401, { ok: false, error: 'invalid_login' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      session: {
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
        expires_in: 60 * 60 * 24,
        token_type: 'bearer',
        mode: 'preview',
      },
      user: managerUser,
      profile: managerProfile,
    });
    return;
  }

  if (pathname === '/api/portal/refresh' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || String(body.refreshToken || '').trim() !== REFRESH_TOKEN) {
      sendJson(res, 401, { ok: false, error: 'invalid_refresh_token' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      session: {
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
        expires_in: 60 * 60 * 24,
        token_type: 'bearer',
        mode: 'preview',
      },
      user: managerUser,
      profile: managerProfile,
    });
    return;
  }

  if (pathname === '/api/portal/me' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    sendJson(res, 200, {
      ok: true,
      session: { mode: 'preview', preview: true },
      user: managerUser,
      profile: managerProfile,
      roleContext: {
        realRole: 'manager',
        effectiveRole: 'manager',
        viewAsRole: '',
        viewAsUserId: '',
      },
      capabilities: managerCapabilities,
      person: managerPerson,
    });
    return;
  }

  if (pathname === '/api/portal/overview' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    sendJson(res, 200, buildOverview());
    return;
  }

  if (pathname === '/api/portal/leads') {
    if (!requireAuth(req, res)) return;
    if (req.method === 'GET') {
      let results = leads.slice();
      const status = String(url.searchParams.get('status') || '').trim().toLowerCase();
      const q = String(url.searchParams.get('q') || '').trim();
      if (status) results = results.filter((lead) => String(lead.status || '').toLowerCase() === status);
      results = filterByQuery(results, q, ['first_name', 'last_name', 'email', 'phone', 'company', 'property_name', 'city', 'state']);
      sendJson(res, 200, { ok: true, leads: results });
      return;
    }
    const body = await readJson(req);
    if (!body) {
      sendJson(res, 400, { ok: false, error: 'invalid_body' });
      return;
    }
    if (req.method === 'POST') {
      const lead = {
        id: nextLeadId++,
        first_name: String(body.firstName || '').trim(),
        last_name: String(body.lastName || '').trim(),
        email: String(body.email || '').trim(),
        phone: String(body.phone || '').trim(),
        company: String(body.company || '').trim(),
        property_name: String(body.propertyName || '').trim(),
        address: String(body.address || '').trim(),
        city: String(body.city || '').trim(),
        state: String(body.state || '').trim(),
        postal_code: String(body.postalCode || '').trim(),
        status: String(body.status || 'new').trim(),
        assigned_role: String(body.assignedRole || 'dialer').trim(),
        assigned_user_id: String(body.assignedUserId || '').trim(),
        source: 'local_preview',
        notes: String(body.notes || '').trim(),
        meta: {},
      };
      leads.unshift(lead);
      sendJson(res, 200, { ok: true, lead });
      return;
    }
    if (req.method === 'PATCH') {
      const lead = leads.find((item) => Number(item.id) === Number(body.id));
      if (!lead) {
        sendJson(res, 404, { ok: false, error: 'lead_not_found' });
        return;
      }
      Object.assign(lead, {
        first_name: body.firstName != null ? String(body.firstName).trim() : lead.first_name,
        last_name: body.lastName != null ? String(body.lastName).trim() : lead.last_name,
        email: body.email != null ? String(body.email).trim() : lead.email,
        phone: body.phone != null ? String(body.phone).trim() : lead.phone,
        company: body.company != null ? String(body.company).trim() : lead.company,
        property_name: body.propertyName != null ? String(body.propertyName).trim() : lead.property_name,
        address: body.address != null ? String(body.address).trim() : lead.address,
        city: body.city != null ? String(body.city).trim() : lead.city,
        state: body.state != null ? String(body.state).trim() : lead.state,
        postal_code: body.postalCode != null ? String(body.postalCode).trim() : lead.postal_code,
        status: body.status != null ? String(body.status).trim() : lead.status,
        assigned_role: body.assignedRole != null ? String(body.assignedRole).trim() : lead.assigned_role,
        assigned_user_id: body.assignedUserId != null ? String(body.assignedUserId).trim() : lead.assigned_user_id,
        notes: body.notes != null ? String(body.notes).trim() : lead.notes,
      });
      sendJson(res, 200, { ok: true, lead });
      return;
    }
  }

  if (pathname === '/api/portal/events') {
    if (!requireAuth(req, res)) return;
    if (req.method === 'GET') {
      let results = events.slice();
      const status = String(url.searchParams.get('status') || '').trim().toLowerCase();
      const areaTag = String(url.searchParams.get('areaTag') || '').trim().toLowerCase();
      if (status) results = results.filter((event) => String(event.status || '').toLowerCase() === status);
      if (areaTag) results = results.filter((event) => String(event.area_tag || '').toLowerCase() === areaTag);
      sendJson(res, 200, { ok: true, events: results });
      return;
    }
    const body = await readJson(req);
    if (!body) {
      sendJson(res, 400, { ok: false, error: 'invalid_body' });
      return;
    }
    if (req.method === 'POST') {
      const event = {
        id: nextEventId++,
        title: String(body.title || 'New event').trim(),
        account_name: 'Local account',
        account: { name: 'Local account' },
        location: { location_name: 'Local location' },
        city: String(body.city || '').trim(),
        state: String(body.state || '').trim(),
        event_date: String(body.eventDate || '').trim(),
        start_time: String(body.startTime || '').trim(),
        end_time: String(body.endTime || '').trim(),
        starts_at: `${String(body.eventDate || '').trim()}T${String(body.startTime || '09:00').trim()}:00.000Z`,
        ends_at: `${String(body.eventDate || '').trim()}T${String(body.endTime || '10:00').trim()}:00.000Z`,
        status: String(body.status || 'open').trim(),
        assigned_role: String(body.assignedRole || '').trim(),
        area_tag: String(body.areaTag || '').trim(),
        event_kind: String(body.eventKind || '').trim(),
        payout_cents: Number(body.payoutCents || 0) || 0,
        execution_status: String(body.executionStatus || '').trim(),
        logistics_status: String(body.logisticsStatus || '').trim(),
        report_status: String(body.reportStatus || '').trim(),
        staffing: { requiredPeople: 1, acceptedPeople: 0 },
        notes: String(body.notes || '').trim(),
      };
      events.unshift(event);
      sendJson(res, 200, { ok: true, event });
      return;
    }
    if (req.method === 'PATCH') {
      const event = events.find((item) => Number(item.id) === Number(body.id));
      if (!event) {
        sendJson(res, 404, { ok: false, error: 'event_not_found' });
        return;
      }
      Object.assign(event, {
        title: body.title != null ? String(body.title).trim() : event.title,
        city: body.city != null ? String(body.city).trim() : event.city,
        state: body.state != null ? String(body.state).trim() : event.state,
        event_date: body.eventDate != null ? String(body.eventDate).trim() : event.event_date,
        start_time: body.startTime != null ? String(body.startTime).trim() : event.start_time,
        end_time: body.endTime != null ? String(body.endTime).trim() : event.end_time,
        status: body.status != null ? String(body.status).trim() : event.status,
        assigned_role: body.assignedRole != null ? String(body.assignedRole).trim() : event.assigned_role,
        area_tag: body.areaTag != null ? String(body.areaTag).trim() : event.area_tag,
        event_kind: body.eventKind != null ? String(body.eventKind).trim() : event.event_kind,
        payout_cents: body.payoutCents != null ? Number(body.payoutCents) || 0 : event.payout_cents,
        execution_status: body.executionStatus != null ? String(body.executionStatus).trim() : event.execution_status,
        logistics_status: body.logisticsStatus != null ? String(body.logisticsStatus).trim() : event.logistics_status,
        report_status: body.reportStatus != null ? String(body.reportStatus).trim() : event.report_status,
        notes: body.notes != null ? String(body.notes).trim() : event.notes,
      });
      sendJson(res, 200, { ok: true, event });
      return;
    }
  }

  if (pathname === '/api/portal/tasks') {
    if (!requireAuth(req, res)) return;
    if (req.method === 'GET') {
      let results = tasks.slice();
      const status = String(url.searchParams.get('status') || '').trim().toLowerCase();
      const q = String(url.searchParams.get('q') || '').trim();
      const mine = String(url.searchParams.get('mine') || '').trim() === '1';
      if (status) results = results.filter((task) => String(task.status || '').toLowerCase() === status);
      results = filterByQuery(results, q, ['title', 'description', 'taskType']);
      if (mine) results = results.filter((task) => String(task.assignedUserId || '') === managerUser.id);
      sendJson(res, 200, { ok: true, tasks: results, source: 'portal_tasks', ready: true });
      return;
    }
    const body = await readJson(req);
    if (!body) {
      sendJson(res, 400, { ok: false, error: 'invalid_body' });
      return;
    }
    if (req.method === 'POST') {
      const task = {
        id: nextTaskId++,
        title: String(body.title || 'New task').trim(),
        description: String(body.description || '').trim(),
        taskType: String(body.taskType || 'admin').trim(),
        status: String(body.status || 'open').trim(),
        priority: Number(body.priority || 0) || 0,
        dueAt: String(body.dueAt || '').trim(),
        assignedUserId: String(body.assignedUserId || managerUser.id).trim(),
        leadId: body.leadId || null,
        eventId: body.eventId || null,
        accountId: body.accountId || null,
        source: 'portal_tasks',
      };
      tasks.unshift(task);
      sendJson(res, 200, { ok: true, task });
      return;
    }
    if (req.method === 'PATCH') {
      const task = tasks.find((item) => Number(item.id) === Number(body.id));
      if (!task) {
        sendJson(res, 404, { ok: false, error: 'task_not_found' });
        return;
      }
      Object.assign(task, {
        title: body.title != null ? String(body.title).trim() : task.title,
        description: body.description != null ? String(body.description).trim() : task.description,
        taskType: body.taskType != null ? String(body.taskType).trim() : task.taskType,
        status: body.status != null ? String(body.status).trim() : task.status,
        priority: body.priority != null ? Number(body.priority) || 0 : task.priority,
        dueAt: body.dueAt != null ? String(body.dueAt).trim() : task.dueAt,
        assignedUserId: body.assignedUserId != null ? String(body.assignedUserId).trim() : task.assignedUserId,
        leadId: body.leadId != null ? body.leadId : task.leadId,
        eventId: body.eventId != null ? body.eventId : task.eventId,
        accountId: body.accountId != null ? body.accountId : task.accountId,
      });
      sendJson(res, 200, { ok: true, task });
      return;
    }
  }

  if (pathname === '/api/portal/admin_settings') {
    if (!requireAuth(req, res)) return;
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, settings: adminSettingsPayload() });
      return;
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (!body) {
        sendJson(res, 400, { ok: false, error: 'invalid_body' });
        return;
      }
      adminSettings = Object.assign({}, adminSettings, {
        bookingCalendarUrl: String(body.bookingCalendarUrl || '').trim(),
        stripeCheckoutUrl: String(body.stripeCheckoutUrl || '').trim(),
        stripePricingUrl: String(body.stripePricingUrl || '').trim(),
        internalNotes: String(body.internalNotes || '').trim(),
        updatedAt: nowIso(),
      });
      sendJson(res, 200, { ok: true, settings: adminSettingsPayload() });
      return;
    }
  }

  if (pathname === '/api/portal/vendors') {
    if (!requireAuth(req, res)) return;
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const vendors = previewVendors.filter((vendor) => {
      if (!q) return true;
      return JSON.stringify(vendor).toLowerCase().includes(q);
    });
    sendJson(res, 200, { ok: true, vendors, seeded: false, seedSource: 'local_preview' });
    return;
  }

  if (pathname === '/api/portal/event_types') {
    if (!requireAuth(req, res)) return;
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const types = previewEventTypes.filter((item) => {
      if (!q) return true;
      return JSON.stringify(item).toLowerCase().includes(q);
    });
    sendJson(res, 200, { ok: true, types, seeded: false, seedSource: 'local_preview' });
    return;
  }

  if (pathname === '/api/portal/people') {
    if (!requireAuth(req, res)) return;
    const requestedUserId = String(url.searchParams.get('userId') || managerUser.id).trim();
    const detail = buildPreviewPersonDetail(requestedUserId);
    if (!detail) {
      sendJson(res, 404, { ok: false, error: 'person_not_found' });
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  if (pathname === '/api/portal/talent_profiles') {
    if (!requireAuth(req, res)) return;
    if (req.method === 'GET') {
      const requestedUserId = String(url.searchParams.get('userId') || managerUser.id).trim();
      sendJson(res, 200, { ok: true, profile: talentProfiles[requestedUserId] || null, role: findAccessAccount(requestedUserId)?.role || 'manager' });
      return;
    }
    if (req.method === 'POST' || req.method === 'PATCH') {
      const body = await readJson(req);
      if (!body) {
        sendJson(res, 400, { ok: false, error: 'invalid_body' });
        return;
      }
      const targetUserId = String(body.userId || managerUser.id).trim();
      const entry = findAccessAccount(targetUserId) || { role: 'manager' };
      talentProfiles[targetUserId] = normalizeTalentProfileInput(body.profile || body, { userId: targetUserId, role: entry.role || 'dialer' });
      sendJson(res, 200, { ok: true, profile: talentProfiles[targetUserId] });
      return;
    }
  }

  if (pathname === '/api/portal/users') {
    if (!requireAuth(req, res)) return;
    if (req.method === 'GET') {
      const users = accessAccounts.map((entry) => ({
        userId: entry.userId,
        role: entry.role,
        fullName: entry.fullName,
        email: entry.email,
        createdAt: entry.createdAt || nowIso(),
        employmentStatus: entry.employmentStatus || '',
        readinessStatus: entry.readinessStatus || '',
        teamCode: entry.teamCode || 'OPS',
        managerUserId: entry.managerUserId || '',
        canBeAssigned: entry.canBeAssigned !== false,
        homeBaseCity: entry.homeBaseCity || '',
        homeBaseState: entry.homeBaseState || '',
        updatedAt: entry.updatedAt || entry.createdAt || nowIso(),
      }));
      sendJson(res, 200, { ok: true, users });
      return;
    }

    if (req.method !== 'PATCH') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }

    const body = await readJson(req);
    if (!body) {
      sendJson(res, 400, { ok: false, error: 'invalid_body' });
      return;
    }

    const userId = String(body.userId || '').trim();
    const entry = findAccessAccount(userId);
    if (!entry) {
      sendJson(res, 404, { ok: false, error: 'profile_not_found' });
      return;
    }

    if (body.role != null) entry.role = cleanText(body.role, 80) || entry.role;
    if (body.fullName != null) entry.fullName = cleanText(body.fullName, 120) || entry.fullName;
    if (body.employmentStatus != null) entry.employmentStatus = cleanText(body.employmentStatus, 40) || entry.employmentStatus;
    if (body.readinessStatus != null) entry.readinessStatus = cleanText(body.readinessStatus, 40) || entry.readinessStatus;
    if (body.managerUserId != null) entry.managerUserId = cleanText(body.managerUserId, 80);
    if (body.canBeAssigned != null) entry.canBeAssigned = Boolean(body.canBeAssigned);
    if (body.homeBaseCity != null) entry.homeBaseCity = cleanText(body.homeBaseCity, 80) || entry.homeBaseCity;
    if (body.homeBaseState != null) entry.homeBaseState = cleanText(body.homeBaseState, 20) || entry.homeBaseState;
    entry.managerName = findAccessAccount(entry.managerUserId)?.fullName || (entry.managerUserId === managerUser.id ? managerProfile.fullName : entry.managerName || '');
    entry.updatedAt = nowIso();

    const profile = talentProfiles[userId] || normalizeTalentProfileInput({}, { userId, role: entry.role });
    talentProfiles[userId] = normalizeTalentProfileInput({
      public: Object.assign({}, profile.public || {}, {
        displayName: entry.fullName,
        role: entry.role,
        homeBaseCity: entry.homeBaseCity || 'Charlotte',
        homeBaseState: entry.homeBaseState || 'NC',
      }),
      internal: profile.internal || {},
    }, { userId, role: entry.role });

    if (onboardingByUser[userId]) {
      onboardingByUser[userId].updatedAt = nowIso();
      onboardingByUser[userId].meta = Object.assign({}, onboardingByUser[userId].meta || {}, {
        approvedRole: entry.role,
      });
    }

    sendJson(res, 200, {
      ok: true,
      profile: {
        user_id: entry.userId,
        role: entry.role,
        full_name: entry.fullName,
        created_at: entry.createdAt || nowIso(),
      },
      person: buildPreviewPersonDetail(userId)?.person || null,
    });
    return;
  }

  if (pathname === '/api/portal/onboarding') {
    if (!requireAuth(req, res)) return;
    if (req.method === 'GET') {
      const personUserId = String(url.searchParams.get('personUserId') || '').trim();
      const journeys = Object.values(onboardingByUser).filter((row) => !personUserId || String(row.personUserId || '') === personUserId);
      const submissions = onboardingSubmissions.filter((row) => !personUserId || String(row.personUserId || '') === personUserId);
      sendJson(res, 200, { ok: true, submissions, journeys, ready: true, source: 'local_preview' });
      return;
    }

    const body = await readJson(req);
    if (!body) {
      sendJson(res, 400, { ok: false, error: 'invalid_body' });
      return;
    }

    if (req.method === 'POST') {
      const personUserId = String(body.personUserId || managerUser.id).trim();
      const managerUserId = findAccessAccount(personUserId)?.managerUserId || managerUser.id;
      const submission = {
        id: nextOnboardingSubmissionId++,
        personUserId,
        ownerUserId: managerUserId,
        assignedUserId: managerUserId,
        intakeType: String(body.intakeType || 'employee_onboarding').trim(),
        status: String(body.status || 'submitted').trim(),
        subjectRole: String(body.subjectRole || '').trim(),
        title: String(body.title || '').trim(),
        description: String(body.description || '').trim(),
        normalizedData: body.normalizedData && typeof body.normalizedData === 'object' ? body.normalizedData : {},
        meta: body.meta && typeof body.meta === 'object' ? body.meta : {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
        submittedAt: nowIso(),
      };
      onboardingSubmissions.unshift(submission);
      sendJson(res, 200, { ok: true, submission, journey: null });
      return;
    }

    if (req.method === 'PATCH') {
      const journeyId = Number(body.journeyId || 0) || 0;
      const submissionId = Number(body.id || body.submissionId || 0) || 0;

      if (submissionId) {
        const submission = onboardingSubmissions.find((row) => Number(row.id || 0) === submissionId) || null;
        if (!submission) {
          sendJson(res, 404, { ok: false, error: 'intake_not_found' });
          return;
        }
        Object.assign(submission, {
          status: body.status != null ? String(body.status).trim() : submission.status,
          normalizedData: body.normalizedData && typeof body.normalizedData === 'object' ? body.normalizedData : submission.normalizedData,
          meta: body.meta && typeof body.meta === 'object' ? body.meta : submission.meta,
          updatedAt: nowIso(),
        });
        sendJson(res, 200, { ok: true, submission, journey: null });
        return;
      }

      const journey = Object.values(onboardingByUser).find((row) => Number(row.id || 0) === journeyId) || null;
      if (!journey) {
        sendJson(res, 404, { ok: false, error: 'journey_not_found' });
        return;
      }
      journey.status = body.journeyStatus != null ? String(body.journeyStatus).trim() : journey.status;
      journey.stageKey = body.stageKey != null ? String(body.stageKey).trim() : journey.stageKey;
      journey.notes = body.notes != null ? String(body.notes).trim() : journey.notes;
      journey.checklist = body.checklist && typeof body.checklist === 'object' ? body.checklist : (journey.checklist || {});
      journey.collectedData = body.collectedData && typeof body.collectedData === 'object' ? body.collectedData : (journey.collectedData || {});
      journey.meta = body.meta && typeof body.meta === 'object' ? body.meta : (journey.meta || {});
      journey.completedAt = body.completedAt != null ? String(body.completedAt).trim() : journey.completedAt;
      journey.updatedAt = nowIso();
      sendJson(res, 200, { ok: true, submission: null, journey });
      return;
    }
  }

  if (pathname === '/api/portal/user_access') {
    if (!requireAuth(req, res)) return;
    if (req.method === 'GET') {
      const userId = String(url.searchParams.get('userId') || '').trim();
      if (userId) {
        const entry = accessAccounts.find((account) => String(account.userId) === userId) || null;
        sendJson(res, 200, { ok: true, entry, history: accessHistory[userId] || [] });
        return;
      }
      sendJson(res, 200, { ok: true, accounts: accessAccounts, supports: { invite: true } });
      return;
    }
    const body = await readJson(req);
    if (!body) {
      sendJson(res, 400, { ok: false, error: 'invalid_body' });
      return;
    }
    const action = String(body.action || '').trim();
    if (action === 'provision') {
      const userId = `user-${Date.now()}`;
      const entry = {
        userId,
        fullName: String(body.fullName || '').trim(),
        email: String(body.email || '').trim(),
        role: String(body.role || 'dialer').trim(),
        employmentStatus: 'active',
        readinessStatus: 'active',
        managerUserId: String(body.managerUserId || managerUser.id).trim(),
        managerName: managerProfile.fullName,
        authIdentity: { status: 'invited' },
        accessAudit: {
          provisionedAt: nowIso(),
          lastActionLabel: 'Access provisioned',
          lastActorName: managerProfile.fullName,
          lastActorUserId: managerUser.id,
          suspendedAt: '',
          restoredAt: '',
        },
        supports: { invite: true },
      };
      accessAccounts.unshift(entry);
      talentProfiles[userId] = normalizeTalentProfileInput({ public: { displayName: entry.fullName, role: entry.role, homeBaseCity: 'Charlotte', homeBaseState: 'NC' } }, { userId, role: entry.role });
      onboardingByUser[userId] = {
        id: Date.now(),
        personUserId: userId,
        status: 'pending',
        stageKey: 'access_setup',
        startedAt: nowIso(),
        targetReadyAt: '',
        completedAt: '',
        ownerUserId: userId,
        managerUserId: entry.managerUserId || managerUser.id,
        updatedAt: nowIso(),
        notes: 'Profile setup and activation are ready.',
        meta: { approvalStatus: 'approved', approvedRole: entry.role },
      };
      accessHistory[userId] = [
        { actionLabel: 'Access provisioned', createdAt: nowIso(), actorName: managerProfile.fullName, actorUserId: managerUser.id },
      ];
      sendJson(res, 200, {
        ok: true,
        createdNew: true,
        user: { id: userId, email: entry.email },
        access: { actionLink: `mailto:${entry.email}` },
        onboarding: { submissionId: null, journeyId: onboardingByUser[userId].id, journeyStage: onboardingByUser[userId].stageKey },
      });
      return;
    }
    const userId = String(body.userId || '').trim();
    const entry = accessAccounts.find((account) => String(account.userId) === userId) || null;
    if (!entry) {
      sendJson(res, 404, { ok: false, error: 'user_not_found' });
      return;
    }
    const labelMap = {
      reset_password: 'Password reset sent',
      resend_invite: 'Invite resent',
      suspend_access: 'Access suspended',
      restore_access: 'Access restored',
    };
    entry.accessAudit.lastActionLabel = labelMap[action] || 'Access updated';
    entry.accessAudit.lastActorName = managerProfile.fullName;
    entry.accessAudit.lastActorUserId = managerUser.id;
    if (action === 'suspend_access') {
      entry.authIdentity.status = 'suspended';
      entry.accessAudit.suspendedAt = nowIso();
    }
    if (action === 'restore_access') {
      entry.authIdentity.status = 'active';
      entry.accessAudit.restoredAt = nowIso();
    }
    if (!accessHistory[userId]) accessHistory[userId] = [];
    accessHistory[userId].unshift({ actionLabel: entry.accessAudit.lastActionLabel, createdAt: nowIso(), actorName: managerProfile.fullName, actorUserId: managerUser.id });
    sendJson(res, 200, {
      ok: true,
      user: { id: entry.userId, email: entry.email },
      access: { actionLink: action === 'reset_password' ? `mailto:${entry.email}` : '' },
    });
    return;
  }

  if (pathname === '/api/portal/ai/threads') {
    if (!requireAuth(req, res)) return;
    if (req.method === 'GET') {
      const threadId = String(url.searchParams.get('threadId') || '').trim();
      const selectedThread = threadRecord(threadId || threads[0]?.id || '');
      sendJson(res, 200, {
        ok: true,
        ready: true,
        threads,
        thread: selectedThread,
        messages: selectedThread ? (threadMessages[selectedThread.id] || []) : [],
      });
      return;
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if (!body) {
        sendJson(res, 400, { ok: false, error: 'invalid_body' });
        return;
      }
      const thread = threadRecord(body.threadId);
      if (!thread) {
        sendJson(res, 404, { ok: false, error: 'thread_not_found' });
        return;
      }
      thread.title = String(body.title || thread.title).trim() || thread.title;
      updateThreadMeta(thread);
      sendJson(res, 200, { ok: true, thread });
      return;
    }
  }

  if (pathname === '/api/portal/ai/chat' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const body = await readJson(req);
    if (!body) {
      sendJson(res, 400, { ok: false, error: 'invalid_body' });
      return;
    }
    let thread = threadRecord(body.threadId);
    if (!thread) {
      thread = {
        id: `thread-${nextThreadId++}`,
        title: compact(String(body.message || 'New chat').trim(), 48) || 'New chat',
        summary: '',
        messageCount: 0,
        updatedAt: nowIso(),
        lastMessageAt: nowIso(),
      };
      threads.unshift(thread);
      threadMessages[thread.id] = [];
    }
    const userMessage = { id: `msg-${Date.now()}-u`, role: 'user', content: String(body.message || '').trim() };
    const contextLead = body.context?.lead?.name ? `Lead in focus: ${body.context.lead.name}.` : '';
    const contextEvent = body.context?.event?.title ? ` Event in focus: ${body.context.event.title}.` : '';
    const contextTask = body.context?.task?.title ? ` Task in focus: ${body.context.task.title}.` : '';
    const assistantMessage = {
      id: `msg-${Date.now()}-a`,
      role: 'assistant',
      content: compact(`Manager preview response: ${String(body.message || '').trim()}. ${contextLead}${contextEvent}${contextTask} Continue from here with the live backend when it is available.`, 420),
    };
    threadMessages[thread.id].push(userMessage, assistantMessage);
    updateThreadMeta(thread);
    sendJson(res, 200, { ok: true, ready: true, thread, userMessage, message: assistantMessage });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found', path: pathname });
});

server.listen(PORT, HOST, () => {
  console.log(`Portal local API running at http://${HOST}:${PORT}`);
  console.log(`Manager preview code: ${MANAGER_PREVIEW_CODE}`);
  console.log(`Manager email: ${MANAGER_EMAIL}`);
});