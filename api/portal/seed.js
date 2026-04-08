const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { supabaseAdmin, requirePortalSession, isManager } = require('../../lib/portalAuth');
const { randomUUID } = require('crypto');

const DEFAULT_ROLES = [
  'dialer',
  'in_person_setter',
  'remote_setter',
  'closer',
  'event_host',
  'account_manager',
  'event_coordinator',
  'media_team',
  'manager',
];

function titleCase(s) {
  return String(s || '')
    .split(/[_\-\s]+/g)
    .filter(Boolean)
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
    .join(' ');
}

async function assertServiceRole(sb) {
  try {
    const r = await sb.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (r?.error) return { ok: false, error: 'invalid_supabase_service_role', detail: r.error.message || '' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'invalid_supabase_service_role', detail: String(e?.message || e || '') };
  }
}

function nowIso() {
  return new Date().toISOString();
}

function ymdFromDate(d) {
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysYmd(baseYmd, days) {
  const s = String(baseYmd || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + Number(days || 0));
  return ymdFromDate(d);
}

function pick(arr, idx) {
  const a = Array.isArray(arr) ? arr : [];
  if (!a.length) return null;
  const i = Math.abs(Number(idx || 0)) % a.length;
  return a[i];
}

function mkUuid() {
  try {
    return randomUUID();
  } catch {
    // eslint-disable-next-line no-bitwise
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      // eslint-disable-next-line no-bitwise
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}

async function findAuthUserIdByEmail(sb, email, { perPage = 200, maxPages = 25 } = {}) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return '';
  const pp = Math.max(1, Math.min(1000, Number(perPage || 200)));
  const pages = Math.max(1, Math.min(200, Number(maxPages || 25)));
  for (let page = 1; page <= pages; page++) {
    // eslint-disable-next-line no-await-in-loop
    const listed = await sb.auth.admin.listUsers({ page, perPage: pp });
    const users = listed?.data?.users || [];
    const found = users.find((u) => String(u?.email || '').trim().toLowerCase() === target);
    if (found?.id) return String(found.id);
    if (!users.length) break;
  }
  return '';
}

async function findProfileUserIdByRole(sb, role) {
  const r = String(role || '').trim();
  if (!r) return '';
  const { data, error } = await sb
    .from('portal_profiles')
    .select('user_id, role, created_at')
    .eq('role', r)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) return '';
  const row = Array.isArray(data) ? data[0] : null;
  return String(row?.user_id || '').trim();
}

async function getKv(sb, key) {
  const { data, error } = await sb
    .from('purestay_kv')
    .select('key, value, updated_at')
    .eq('key', String(key))
    .limit(1);
  if (error) return { ok: false, error: 'kv_read_failed', detail: error.message || '' };
  return { ok: true, row: Array.isArray(data) ? data[0] : null };
}

async function upsertKv(sb, key, value) {
  const { data, error } = await sb
    .from('purestay_kv')
    .upsert({ key: String(key), value, updated_at: nowIso() }, { onConflict: 'key' })
    .select('key, value, updated_at')
    .limit(1);
  if (error) return { ok: false, error: 'kv_write_failed', detail: error.message || '' };
  return { ok: true, row: Array.isArray(data) ? data[0] : null };
}

async function safeDeleteByJsonTag(sb, table, jsonCol, tagKey, tagValue) {
  try {
    const { error } = await sb
      .from(table)
      .delete()
      .contains(jsonCol, { [tagKey]: tagValue });
    if (error) return { ok: false, error: 'delete_failed', detail: error.message || '' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'delete_failed', detail: String(e?.message || e || '') };
  }
}

async function seedDemoData(sb, {
  demoSeedId,
  runId,
  userIdsByRole,
  domain,
  force,
  append,
}) {
  const seedKey = `portal:demo_seed:${demoSeedId}`;
  const existing = await getKv(sb, seedKey);
  const already = existing.ok && existing.row && existing.row.value && typeof existing.row.value === 'object';

  if (already && !force && !append) {
    return {
      ok: true,
      alreadySeeded: true,
      seedKey,
      seedState: existing.row.value,
    };
  }

  // Clean up only prior demo rows tagged with this seedId.
  if (force) {
    await safeDeleteByJsonTag(sb, 'portal_lead_activities', 'payload', 'demoSeed', demoSeedId);
    await safeDeleteByJsonTag(sb, 'portal_leads', 'meta', 'demoSeed', demoSeedId);
    await safeDeleteByJsonTag(sb, 'portal_event_recaps', 'payload', 'demoSeed', demoSeedId);
    await safeDeleteByJsonTag(sb, 'portal_events', 'meta', 'demoSeed', demoSeedId);
    await safeDeleteByJsonTag(sb, 'portal_payouts', 'meta', 'demoSeed', demoSeedId);
    await safeDeleteByJsonTag(sb, 'portal_docs', 'meta', 'demoSeed', demoSeedId);

    // Demo logs/sets are stored under a dedicated prefix.
    await sb.from('purestay_logs').delete().like('list_key', `portal:demo:${demoSeedId}:%`);
    await sb.from('purestay_sets').delete().like('set_key', `portal:demo:${demoSeedId}:%`);
  }

  const mgrId = userIdsByRole.manager || await findProfileUserIdByRole(sb, 'manager') || null;
  const closerId = userIdsByRole.closer || await findProfileUserIdByRole(sb, 'closer') || mgrId;
  const amId = userIdsByRole.account_manager || await findProfileUserIdByRole(sb, 'account_manager') || mgrId;
  const dialerId = userIdsByRole.dialer || await findProfileUserIdByRole(sb, 'dialer') || mgrId;
  const setterId = userIdsByRole.remote_setter || userIdsByRole.in_person_setter || await findProfileUserIdByRole(sb, 'remote_setter') || await findProfileUserIdByRole(sb, 'in_person_setter') || mgrId;
  const coordId = userIdsByRole.event_coordinator || await findProfileUserIdByRole(sb, 'event_coordinator') || mgrId;
  const hostId = userIdsByRole.event_host || await findProfileUserIdByRole(sb, 'event_host') || mgrId;
  const mediaId = userIdsByRole.media_team || await findProfileUserIdByRole(sb, 'media_team') || mgrId;

  const today = ymdFromDate(new Date());
  const seedTag = { demoSeed: demoSeedId, demoRun: runId, demoDomain: domain };

  const isAppend = Boolean(append);
  const leadsCount = isAppend ? 18 : 28;
  const eventsCount = isAppend ? 10 : 14;
  const appointmentsCount = isAppend ? 16 : 20;
  const dispatchCount = isAppend ? 12 : 10;
  const payoutsCount = isAppend ? 28 : 18;

  let vendorsSeeded = 0;
  let eventTypesSeeded = 0;
  let talentProfilesSeeded = 0;

  // -----------------------------
  // Leads
  // -----------------------------
  const leadPeople = [
    { first: 'Ava', last: 'Martinez' },
    { first: 'Noah', last: 'Johnson' },
    { first: 'Mia', last: 'Nguyen' },
    { first: 'Ethan', last: 'Patel' },
    { first: 'Sophia', last: 'Williams' },
    { first: 'Liam', last: 'Brown' },
    { first: 'Isabella', last: 'Davis' },
    { first: 'Lucas', last: 'Moore' },
    { first: 'Amelia', last: 'Garcia' },
    { first: 'James', last: 'Wilson' },
    { first: 'Charlotte', last: 'Anderson' },
    { first: 'Benjamin', last: 'Thomas' },
  ];

  const leadSources = ['web', 'referral', 'cold_call', 'event', 'partner'];
  const leadStatuses = ['new', 'working', 'booked', 'won', 'lost'];
  const states = ['NC', 'SC', 'VA'];
  const cities = ['Raleigh', 'Durham', 'Cary', 'Charlotte', 'Wilmington', 'Greensboro'];
  const propertyTypes = ['Apartment', 'Condo', 'Townhome', 'Single-family', 'Build-to-rent'];
  const companies = ['Oakline Property Group', 'BlueSky Living', 'HarborView Realty', 'Ridgeway Communities', 'Pinecrest Partners'];

  const leadsToInsert = [];
  for (let i = 0; i < leadsCount; i++) {
    const p = pick(leadPeople, i);
    const first = p?.first || `Lead${i + 1}`;
    const last = p?.last || 'Demo';
    const source = pick(leadSources, i);
    const st0 = pick(leadStatuses, i + 1);
    const st = pick(states, i);
    const city = pick(cities, i + 2);
    const company = pick(companies, i + 3);
    const propertyType = pick(propertyTypes, i + 4);
    const units = [12, 24, 48, 96][i % 4];
    const priority = [0, 1, 2][i % 3];
    const assignedRole = i % 5 === 0 ? 'dialer' : (i % 5 === 1 ? 'remote_setter' : (i % 5 === 2 ? 'in_person_setter' : (i % 5 === 3 ? 'closer' : 'account_manager')));
    const assignedUserId = (
      assignedRole === 'dialer' ? dialerId
        : (assignedRole === 'remote_setter' || assignedRole === 'in_person_setter') ? setterId
          : assignedRole === 'closer' ? closerId
            : amId
    );

    const createdAt = new Date();
    createdAt.setDate(createdAt.getDate() - (2 + (i % 18)));

    const email = `${String(first).toLowerCase()}.${String(last).toLowerCase()}+${i + 1}@${domain}`;
    const phone = `+1919${String(1000000 + (i * 137) % 8999999).padStart(7, '0')}`;

    // Ensure the closer role actually sees pipeline-ready data.
    // Queue kind=closer only shows working/booked.
    let status = st0;
    if (assignedRole === 'closer') {
      status = pick(['working', 'booked'], i);
    } else if (assignedRole === 'dialer') {
      status = pick(['new', 'working', 'booked'], i + 1);
    } else if (assignedRole === 'account_manager') {
      status = pick(['working', 'booked', 'won', 'lost'], i + 2);
    }

    leadsToInsert.push({
      created_at: createdAt.toISOString(),
      created_by: mgrId,

      assigned_role: assignedRole,
      assigned_user_id: assignedUserId,

      source,
      status,
      priority,

      first_name: first,
      last_name: last,
      phone,
      email,

      company,
      property_name: `${company} • ${pick(['North', 'South', 'Central', 'East'], i)} ${propertyType} ${units}u`,
      address: `${100 + i} ${pick(['Maple', 'Oak', 'Pine', 'Cedar', 'Willow'], i)} St`,
      city,
      state: st,
      postal_code: `27${String(100 + i).padStart(3, '0')}`,

      notes: pick([
        'Interested in a recurring event cadence (monthly).',
        'Needs a quick turnaround; targeting next 2–3 weeks.',
        'Wants a simple package to test results first.',
        'Asks for media deliverables + post-event recap template.',
      ], i),
      meta: {
        ...seedTag,
        propertyType,
        units,
        bestContactTime: pick(['Morning', 'Midday', 'Afternoon', 'Evening'], i),
        doNotCall: i % 11 === 0,
        utm: { source, campaign: pick(['spring_push', 'q2_growth', 'resident_events', 'brand_awareness'], i) },
        tags: [pick(['hot', 'warm', 'cold'], i), pick(['new_area', 'renewal', 'upsell', 'standard'], i + 2)].filter(Boolean),
        estValueCents: [250000, 500000, 800000, 1200000][i % 4],
      },
    });
  }

  const { data: insertedLeads, error: leadErr } = await sb
    .from('portal_leads')
    .insert(leadsToInsert)
    .select('id, status, first_name, last_name, property_name, city, state')
    .limit(200);
  if (leadErr) return { ok: false, error: 'seed_leads_failed', detail: leadErr.message || '' };

  const leads = Array.isArray(insertedLeads) ? insertedLeads : [];
  const leadIds = leads.map((l) => l.id).filter(Boolean);

  // Activities (3–4 variations)
  const activityTypes = ['call', 'text', 'email', 'note'];
  const outcomes = ['left_voicemail', 'connected', 'no_answer', 'scheduled', 'follow_up'];
  const activities = [];
  for (let i = 0; i < leadIds.length; i++) {
    const leadId = leadIds[i];
    const baseCreatedAt = new Date();
    baseCreatedAt.setDate(baseCreatedAt.getDate() - (1 + (i % 12)));
    for (let j = 0; j < 3; j++) {
      const createdAt = new Date(baseCreatedAt.getTime());
      createdAt.setHours(9 + j * 3, 10 + (i % 40), 0, 0);
      const t = pick(activityTypes, i + j);
      const outcome = pick(outcomes, i + j * 2);
      activities.push({
        created_at: createdAt.toISOString(),
        lead_id: leadId,
        created_by: pick([dialerId, setterId, closerId, mgrId], i + j) || mgrId,
        activity_type: t,
        outcome,
        notes: pick([
          'Quick check-in, shared next steps and timeline.',
          'Confirmed decision maker and best contact channel.',
          'Shared package options and a sample recap.',
          'Scheduled a follow-up for later this week.',
        ], i + j),
        payload: {
          ...seedTag,
          channel: t,
          outcome,
          followUpOn: addDaysYmd(today, (i % 7) + 2),
        },
      });
    }
  }

  const { error: actErr } = await sb
    .from('portal_lead_activities')
    .insert(activities);
  if (actErr) return { ok: false, error: 'seed_activities_failed', detail: actErr.message || '' };

  // -----------------------------
  // Events + Recaps
  // -----------------------------
  // Align with UI filters (completed/canceled) while still supporting scheduled.
  const eventStatuses = ['open', 'assigned', 'scheduled', 'completed', 'canceled'];
  const areaTags = ['Triangle', 'Charlotte', 'Coastal', 'Triad'];

  const eventsToInsert = [];
  const selectedLeadIds = leadIds.slice(0, eventsCount);
  for (let i = 0; i < eventsCount; i++) {
    const leadId = selectedLeadIds[i] || null;
    const status0 = pick(eventStatuses, i + 1);
    const eventDate = addDaysYmd(today, -10 + i);

    const isPast = i < 8;

    // Ensure each role preview has visible events:
    // - Some events are coordinator-run
    // - Some are host/media offers (open + unassigned)
    // - Some are already accepted/assigned for host/media
    const slot = i % 6;
    const isOffer = slot === 0 || slot === 1 || slot === 2;
    const primaryRole = isOffer
      ? (slot % 2 === 0 ? 'event_host' : 'media_team')
      : (slot === 3 ? 'event_host' : (slot === 4 ? 'media_team' : 'event_coordinator'));

    const primaryUserId = (
      primaryRole === 'event_host' ? hostId
        : primaryRole === 'media_team' ? mediaId
          : coordId
    );

    // Offers are always open + unassigned.
    const status = isOffer ? 'open' : status0;
    const isCancelled = status === 'canceled' || status === 'cancelled';

    const budget = {
      hostPayCents: [25000, 35000, 45000, 60000][i % 4],
      mediaPayCents: [0, 15000, 25000][i % 3],
      foodCents: [8000, 12000, 18000, 22000][i % 4],
      decorCents: [3000, 6000, 9000][i % 3],
      suppliesCents: [1500, 2500, 4000][i % 3],
      contingencyCents: [2000, 3500, 5000][i % 3],
    };

    const plan = {
      strategy: pick(['Retention push', 'Prospect day', 'Resident appreciation', 'Referral program'], i),
      eventType: pick(['Open house', 'Pop-up', 'Happy hour', 'Vendor day'], i + 2),
      justification: pick([
        'Targeted follow-up from warm leads and local walk-ins.',
        'Boost weekend traffic and capture contact info.',
        'Build resident goodwill and encourage referrals.',
        'Partner with vendors to expand reach.',
      ], i + 3),
    };

    const checklist = {
      recapReceived: isPast && !isCancelled ? 'yes' : 'no',
      mediaReceived: isPast && !isCancelled ? (i % 2 ? 'yes' : 'no') : 'no',
      feedbackReceived: isPast && !isCancelled ? (i % 3 ? 'yes' : 'no') : 'no',
      reportSent: isPast && !isCancelled ? (i % 4 ? 'yes' : 'no') : 'no',
    };

    const baseAssignments = [
      { role: 'event_coordinator', userId: coordId },
      { role: 'event_host', userId: hostId },
      ...(i % 2 === 0 ? [{ role: 'media_team', userId: mediaId }] : []),
    ].filter((a) => a && a.role && a.userId);

    // For offer-style events, keep assignments scoped to the primary role so
    // the Offers tab can render consistent statuses.
    let assignments = baseAssignments;
    if (isOffer) {
      const offerAssignee = primaryUserId;
      const offerStatus = (slot === 0) ? 'pending' : (slot === 1 ? 'declined' : 'pending');
      const sendMode = (slot === 0) ? 'sent' : (slot === 1 ? 'sent' : 'open');
      assignments = (sendMode === 'open')
        ? []
        : [{
          role: primaryRole,
          userId: offerAssignee,
          status: offerStatus,
          note: offerStatus === 'declined' ? 'Schedule conflict (demo).' : '',
          updatedAt: nowIso(),
          decidedAt: offerStatus === 'declined' ? nowIso() : null,
        }];
    }

    // If this is an accepted/assigned event for host/media, assign it to that user.
    const assignedUserId = (!isOffer && ['event_host', 'media_team'].includes(primaryRole) && (slot === 3 || slot === 4))
      ? primaryUserId
      : (primaryRole === 'event_coordinator' ? coordId : null);

    const createdAt = new Date();
    createdAt.setDate(createdAt.getDate() - (15 - i));

    eventsToInsert.push({
      created_at: createdAt.toISOString(),
      created_by: mgrId,
      status,
      title: `${pick(['Resident Event', 'Open House', 'Pop-up', 'Referral Night'], i)} • ${pick(areaTags, i)}`,
      event_date: eventDate,
      start_time: pick(['10:00', '11:00', '15:00', '17:30'], i),
      end_time: pick(['12:00', '13:00', '17:00', '19:00'], i),
      address: `${700 + i} ${pick(['Main', 'Broad', 'Hillside', 'Lakeview'], i)} Ave`,
      city: pick(cities, i + 1),
      state: pick(states, i + 2),
      postal_code: `27${String(200 + i).padStart(3, '0')}`,
      area_tag: pick(areaTags, i),
      assigned_role: primaryRole,
      assigned_user_id: assignedUserId,
      payout_cents: budget.hostPayCents + budget.mediaPayCents,
      notes: pick([
        'Confirm vendor table layout and signage plan.',
        'Ensure lead capture QR is printed + tested.',
        'Coordinate a quick on-site walkthrough 48h prior.',
        'Bring extra extension cords and tablecloths.',
      ], i),
      meta: {
        ...seedTag,
        leadId,
        plan,
        budget,
        checklist,
        assignments,
        venue: {
          indoor: i % 3 === 0,
          rainPlan: i % 3 !== 0,
          parkingNotes: pick(['Front lot', 'Garage level 2', 'Street parking nearby'], i),
        },
      },
    });
  }

  const { data: insertedEvents, error: eventErr } = await sb
    .from('portal_events')
    .insert(eventsToInsert)
    .select('id, status, event_date, title')
    .limit(200);
  if (eventErr) return { ok: false, error: 'seed_events_failed', detail: eventErr.message || '' };

  const events = Array.isArray(insertedEvents) ? insertedEvents : [];
  const recapsToInsert = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const isPast = (() => {
      const d = String(e.event_date || '');
      return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d < today : false;
    })();
    if (!isPast) continue;
    if (['canceled', 'cancelled'].includes(String(e.status || ''))) continue;

    recapsToInsert.push({
      event_id: e.id,
      created_by: hostId,
      recap: pick([
        'Solid turnout and strong lead capture. Residents asked about upcoming move-in specials.',
        'Great energy; vendor partnerships drove meaningful traffic. Follow-up cadence recommended.',
        'Lower turnout than expected due to weather, but quality conversations with decision makers.',
        'Strong resident participation; referrals were the standout channel. Recommend repeating monthly.',
      ], i),
      media_urls: [
        'https://picsum.photos/seed/purestay1/900/600',
        'https://picsum.photos/seed/purestay2/900/600',
        ...(i % 2 ? ['https://picsum.photos/seed/purestay3/900/600'] : []),
      ],
      payload: {
        ...seedTag,
        attendanceEstimate: [18, 27, 34, 42][i % 4],
        leadCount: [6, 9, 12, 15][i % 4],
        rating: [3, 4, 5][i % 3],
        issues: (i % 3 === 0) ? ['Late vendor arrival'] : (i % 5 === 0 ? ['Signage placement'] : []),
        nextSteps: pick([
          'Send recap + photos to client; schedule follow-up call for next cadence.',
          'Add leads to nurture sequence; review conversion pipeline in 7 days.',
          'Recommend a second event with stronger promo and more signage.',
        ], i + 2),
      },
    });
  }

  if (recapsToInsert.length) {
    const { error: recapErr } = await sb
      .from('portal_event_recaps')
      .insert(recapsToInsert);
    if (recapErr) return { ok: false, error: 'seed_recaps_failed', detail: recapErr.message || '' };
  }

  // -----------------------------
  // Appointments (Booked Meetings)
  // -----------------------------
  const appointmentsToInsert = [];
  for (let i = 0; i < Math.min(appointmentsCount, leadIds.length); i++) {
    const leadId = leadIds[i];
    const when = addDaysYmd(today, (i % 12) - 1);
    const createdAt = new Date();
    createdAt.setDate(createdAt.getDate() - (6 - (i % 6)));

    const creatorPool = [dialerId, setterId, mgrId].filter(Boolean);

    const apptAssignedRole = (i % 4 === 1) ? 'account_manager' : 'closer';
    const apptAssignedUserId = (apptAssignedRole === 'account_manager') ? amId : closerId;

    appointmentsToInsert.push({
      created_at: createdAt.toISOString(),
      created_by: pick(creatorPool, i) || mgrId,
      status: 'scheduled',
      title: `Appointment • Demo Lead ${leadId}`,
      event_date: when,
      start_time: pick(['09:00', '10:30', '13:00', '15:30', '17:00'], i),
      end_time: pick(['09:30', '11:00', '13:30', '16:00', '17:30'], i),
      area_tag: 'appointment',
      assigned_role: apptAssignedRole,
      assigned_user_id: apptAssignedUserId,
      payout_cents: 0,
      notes: pick([
        'Discovery + next steps.',
        'Quick intro and qualification.',
        'Review package tiers and timeline.',
      ], i),
      meta: {
        ...seedTag,
        kind: 'appointment',
        leadId,
        leadLabel: `Demo Lead ${leadId}`,
      },
    });
  }

  if (appointmentsToInsert.length) {
    const { error: apptErr } = await sb
      .from('portal_events')
      .insert(appointmentsToInsert);
    if (apptErr) return { ok: false, error: 'seed_appointments_failed', detail: apptErr.message || '' };
  }

  // -----------------------------
  // Dispatch Tasks (seed a few)
  // -----------------------------
  const dispatchTasks = [];
  for (let i = 0; i < dispatchCount; i++) {
    const leadId = leadIds[(i * 2) % leadIds.length] || null;
    const due = addDaysYmd(today, (i % 10) - 3);
    dispatchTasks.push({
      created_at: nowIso(),
      created_by: mgrId,
      status: pick(['open', 'assigned', 'completed'], i),
      title: pick([
        'Prep call talking points',
        'Verify contact email + decision maker',
        'Send recap template + examples',
        'Confirm best time window for meeting',
      ], i),
      event_date: due,
      start_time: pick(['', '09:00', '12:00', '16:00'], i),
      area_tag: 'dispatch',
      assigned_role: pick(['remote_setter', 'dialer', 'event_coordinator'], i) || 'remote_setter',
      assigned_user_id: (i % 3 === 0) ? null : pick([setterId, dialerId, coordId], i) || null,
      payout_cents: 0,
      notes: pick([
        'Demo task seeded for workflow testing.',
        'Demo: keep notes short and factual.',
      ], i),
      meta: {
        ...seedTag,
        kind: 'dispatch',
        leadId,
        leadLabel: leadId ? `Demo Lead ${leadId}` : '',
        priority: [0, 1, 3, 5][i % 4],
      },
    });
  }

  if (dispatchTasks.length) {
    const { error: dErr } = await sb
      .from('portal_events')
      .insert(dispatchTasks);
    if (dErr) return { ok: false, error: 'seed_dispatch_failed', detail: dErr.message || '' };
  }

  // -----------------------------
  // Payouts
  // -----------------------------
  const payoutsToInsert = [];
  const rolesForPayout = [
    { role: 'dialer', userId: userIdsByRole.dialer || dialerId },
    { role: 'in_person_setter', userId: userIdsByRole.in_person_setter || null },
    { role: 'remote_setter', userId: userIdsByRole.remote_setter || setterId },
    { role: 'closer', userId: userIdsByRole.closer || closerId },
    { role: 'account_manager', userId: userIdsByRole.account_manager || amId },
    { role: 'event_coordinator', userId: userIdsByRole.event_coordinator || coordId },
    { role: 'event_host', userId: userIdsByRole.event_host || hostId },
    { role: 'media_team', userId: userIdsByRole.media_team || mediaId },
    { role: 'manager', userId: userIdsByRole.manager || mgrId },
  ].filter((r) => r.userId);

  const periodStart = addDaysYmd(today, -30);
  const periodEnd = today;
  for (let i = 0; i < payoutsCount; i++) {
    const r = pick(rolesForPayout, i);
    if (!r) continue;
    payoutsToInsert.push({
      created_at: nowIso(),
      user_id: r.userId,
      role: r.role,
      amount_cents: [3500, 5000, 7500, 12000, 18000, 22500, 30000][i % 7],
      status: pick(['pending', 'approved', 'paid'], i),
      period_start: periodStart,
      period_end: periodEnd,
      description: pick([
        'Weekly performance bonus',
        'Commission payout',
        'Event delivery bonus',
        'Monthly account renewal incentive',
        'Travel stipend',
        'On-call coverage',
      ], i),
      meta: {
        ...seedTag,
        ref: `DEMO-${String(i + 1).padStart(3, '0')}`,
      },
    });
  }

  const { error: payoutErr } = await sb
    .from('portal_payouts')
    .insert(payoutsToInsert);
  if (payoutErr) return { ok: false, error: 'seed_payouts_failed', detail: payoutErr.message || '' };

  // -----------------------------
  // Docs
  // -----------------------------
  const docsToInsert = [
    {
      title: 'Event Recap Template (Demo)',
      audience_role: 'event_host',
      content: [
        '## Summary',
        '- What happened (high level)',
        '- Attendance estimate',
        '- Lead capture count',
        '',
        '## What went well',
        '- ...',
        '',
        '## Issues / blockers',
        '- ...',
        '',
        '## Next steps',
        '- ...',
      ].join('\n'),
      source: 'seed',
      meta: { ...seedTag, version: '1.0' },
    },
    {
      title: 'Closer Call Checklist (Demo)',
      audience_role: 'closer',
      content: [
        '1) Confirm decision maker',
        '2) Confirm timeline and objections',
        '3) Share tier options (3 variations)',
        '4) Close with a date and next step',
      ].join('\n'),
      source: 'seed',
      meta: { ...seedTag, format: 'checklist' },
    },
    {
      title: 'Account Manager QBR Notes (Demo)',
      audience_role: 'account_manager',
      content: [
        'Focus: renewal signals, sentiment trend, and next event cadence. Track issues and close the loop.',
      ].join('\n'),
      source: 'seed',
      meta: { ...seedTag, format: 'notes' },
    },
    {
      title: 'Manager KPI Definitions (Demo)',
      audience_role: 'manager',
      content: [
        '- Queue: open leads assigned to role/user',
        '- Booked: scheduled meetings / appointments',
        '- Dispatch: tasks and overdue counts',
        '- Revenue: payouts + account renewals',
      ].join('\n'),
      source: 'seed',
      meta: { ...seedTag, format: 'kpi' },
    },
  ].map((d, i) => ({
    created_at: nowIso(),
    created_by: mgrId,
    ...d,
    meta: { ...(d.meta || {}), demoDocId: `doc_${i + 1}` },
  }));

  const { error: docsErr } = await sb
    .from('portal_docs')
    .insert(docsToInsert);
  if (docsErr) return { ok: false, error: 'seed_docs_failed', detail: docsErr.message || '' };

  // -----------------------------
  // Accounts (KV store)
  // -----------------------------
  const acctKey = 'portal:accounts:v1';
  const acctStore = await getKv(sb, acctKey);
  const existingStore = acctStore.ok && acctStore.row && acctStore.row.value && typeof acctStore.row.value === 'object'
    ? acctStore.row.value
    : {};
  const existingAccounts = Array.isArray(existingStore.accounts) ? existingStore.accounts : [];
  const kept = existingAccounts.filter((a) => !(a && typeof a === 'object' && String(a.id || '').startsWith('demo_acct_')));

  const demoAccounts = [];
  for (let i = 0; i < 14; i++) {
    const company = pick(companies, i);
    const city = pick(cities, i + 2);
    const st = pick(states, i + 1);
    const tier = pick(['Starter', 'Growth', 'Premium', 'Enterprise'], i);
    const termMonths = [3, 6, 12, 24][i % 4];
    const start = addDaysYmd(today, -(60 + i * 3));
    const send = addDaysYmd(start, -5);
    const end = addDaysYmd(start, termMonths * 30);

    demoAccounts.push({
      id: `demo_acct_${demoSeedId}_${i + 1}`,
      name: `${company} Account ${i + 1}`,
      leadId: String(selectedLeadIds[i] || ''),
      propertyName: `${company} • ${pick(['North', 'South', 'Central'], i)} Portfolio`,
      address: `${1000 + i} ${pick(['Market', 'Glenwood', 'Franklin', 'Tryon'], i)} Blvd`,
      city,
      state: st,
      postalCode: `27${String(500 + i).padStart(3, '0')}`,
      primaryContactName: pick(['Jordan Lee', 'Taylor Kim', 'Morgan Reed', 'Casey Parker'], i),
      primaryContactEmail: `contact+acct${i + 1}@${domain}`,
      primaryContactPhone: `+1919${String(2000000 + (i * 551) % 7999999).padStart(7, '0')}`,
      email: `contact+acct${i + 1}@${domain}`,
      phone: `+1919${String(2000000 + (i * 551) % 7999999).padStart(7, '0')}`,
      contractTier: tier,
      tier,
      termMonths,
      contractSendDate: send,
      contractStart: start,
      contractEnd: end,
      renewalReminderDays: pick([14, 30, 45, 60], i),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      demoSeed: demoSeedId,
      notes: pick([
        'Prefers weekday events and strong media recap.',
        'Renewal likely; watching resident referral performance.',
        'Sensitive about noise — confirm quiet hours for vendor setup.',
      ], i),
    });
  }

  await upsertKv(sb, acctKey, {
    ...(existingStore && typeof existingStore === 'object' ? existingStore : {}),
    accounts: kept.concat(demoAccounts),
    updatedAt: nowIso(),
  });

  // -----------------------------
  // Availability (KV store)
  // -----------------------------
  const availBase = {
    notes: 'Demo availability — adjust as needed.',
    slots: {
      tz: 'America/New_York',
      byDate: {
        [addDaysYmd(today, 1)]: ['09:00', '09:30', '10:00', '15:00', '15:30'],
        [addDaysYmd(today, 2)]: ['11:00', '11:30', '16:00', '16:30'],
        [addDaysYmd(today, 3)]: ['10:00', '10:30', '14:00', '14:30'],
        [addDaysYmd(today, 4)]: ['09:00', '13:00', '13:30', '17:00'],
      },
    },
  };
  const usersForAvail = [closerId, amId, mgrId, coordId, hostId, mediaId].filter(Boolean);
  for (let i = 0; i < usersForAvail.length; i++) {
    const uid = usersForAvail[i];
    const key = `portal:availability:${uid}`;
    const bump = i * 2;
    const v = JSON.parse(JSON.stringify(availBase));
    v.notes = pick([
      'Demo: mornings preferred; afternoons flexible.',
      'Demo: blocked mid-day; best mornings + late afternoon.',
      'Demo: open most weekdays except Fridays.',
    ], i);
    // slight variation
    const k1 = addDaysYmd(today, 1 + bump);
    if (k1) v.slots.byDate[k1] = ['10:00', '10:30', '11:00', '11:30'];
    await upsertKv(sb, key, v);
  }

  // -----------------------------
  // Vendors + Event Types (KV store)
  // -----------------------------
  {
    const vendorsKey = 'portal:vendors:v1';
    const existingV = await getKv(sb, vendorsKey);
    const store = existingV.ok && existingV.row && existingV.row.value && typeof existingV.row.value === 'object'
      ? existingV.row.value
      : {};
    const existingVendors = Array.isArray(store.vendors) ? store.vendors : [];
    const kept = existingVendors.filter((v) => !(v && typeof v === 'object' && v.demoSeed === demoSeedId));
    const demoVendors = [
      { name: 'Triangle Tacos', category: 'Food Truck', city: 'Raleigh', state: 'NC', phone: '+19195550101', email: `vendors+tacos@${domain}`, website: 'https://example.com/tacos', notes: 'Fast setup; popular at resident events.' },
      { name: 'HarborView Coffee Cart', category: 'Coffee', city: 'Durham', state: 'NC', phone: '+19195550102', email: `vendors+coffee@${domain}`, website: 'https://example.com/coffee', notes: 'Great for morning pop-ups.' },
      { name: 'BlueSky Balloon Co.', category: 'Decor', city: 'Cary', state: 'NC', phone: '+19195550103', email: `vendors+balloons@${domain}`, website: 'https://example.com/balloons', notes: 'Reliable delivery; confirm colors 7 days out.' },
      { name: 'Ridgeway Photo Booth', category: 'Photo Booth', city: 'Charlotte', state: 'NC', phone: '+19195550104', email: `vendors+photobooth@${domain}`, website: 'https://example.com/photobooth', notes: 'Needs 8x8 space + power.' },
      { name: 'Coastal DJ Services', category: 'DJ', city: 'Wilmington', state: 'NC', phone: '+19195550105', email: `vendors+dj@${domain}`, website: 'https://example.com/dj', notes: 'Confirm quiet hours and playlist style.' },
      { name: 'Triad Kids Corner', category: 'Kids', city: 'Greensboro', state: 'NC', phone: '+19195550106', email: `vendors+kids@${domain}`, website: 'https://example.com/kids', notes: 'Best for weekend afternoon events.' },
    ].map((v, i) => ({
      ...v,
      demoSeed: demoSeedId,
      demoRun: runId,
      id: `demo_vendor_${demoSeedId}_${i + 1}`,
      createdAt: nowIso(),
    }));
    vendorsSeeded = demoVendors.length;
    await upsertKv(sb, vendorsKey, {
      ...(store && typeof store === 'object' ? store : {}),
      vendors: kept.concat(demoVendors),
      updatedAt: nowIso(),
    });
  }

  {
    const typesKey = 'portal:event_types:v1';
    const existingT = await getKv(sb, typesKey);
    const store = existingT.ok && existingT.row && existingT.row.value && typeof existingT.row.value === 'object'
      ? existingT.row.value
      : {};
    const existingTypes = Array.isArray(store.types) ? store.types : [];
    const kept = existingTypes.filter((t) => !(t && typeof t === 'object' && t.demoSeed === demoSeedId));
    const demoTypes = [
      { name: 'Open House Pop-up', kind: 'anchor', description: 'High-intent tours + lead capture.' },
      { name: 'Resident Appreciation', kind: 'momentum', description: 'Retention + referrals.' },
      { name: 'Vendor Day', kind: 'anchor', description: 'Partner activation + traffic.' },
      { name: 'Happy Hour Social', kind: 'momentum', description: 'Community building + photo recap.' },
      { name: 'Move-in Special Push', kind: 'anchor', description: 'Drive near-term occupancy.' },
      { name: 'Referral Program Kickoff', kind: 'momentum', description: 'Referral awareness + sign-ups.' },
    ].map((t, i) => ({
      ...t,
      demoSeed: demoSeedId,
      demoRun: runId,
      id: `demo_event_type_${demoSeedId}_${i + 1}`,
      createdAt: nowIso(),
    }));
    eventTypesSeeded = demoTypes.length;
    await upsertKv(sb, typesKey, {
      ...(store && typeof store === 'object' ? store : {}),
      types: kept.concat(demoTypes),
      updatedAt: nowIso(),
    });
  }

  // -----------------------------
  // Talent profiles (KV store)
  // -----------------------------
  {
    const key = 'portal:talent_profiles:v1';
    const existingT = await getKv(sb, key);
    const store = existingT.ok && existingT.row && existingT.row.value && typeof existingT.row.value === 'object'
      ? existingT.row.value
      : {};
    const existingProfiles = Array.isArray(store.profiles) ? store.profiles : [];

    const demoUserIds = [
      userIdsByRole.event_host,
      userIdsByRole.media_team,
      userIdsByRole.event_coordinator,
      userIdsByRole.manager,
      userIdsByRole.account_manager,
      userIdsByRole.closer,
    ].filter(Boolean);

    const kept = existingProfiles.filter((p) => {
      const uid = String(p?.userId || '');
      if (demoUserIds.includes(uid)) return false;
      if (p && typeof p === 'object' && p.demoSeed === demoSeedId) return false;
      return true;
    });

    const demoProfiles = [];
    for (let i = 0; i < demoUserIds.length; i++) {
      const uid = demoUserIds[i];
      demoProfiles.push({
        userId: uid,
        displayName: pick(['Alex Carter', 'Jamie Rivera', 'Sam Brooks', 'Riley Quinn', 'Jordan Hayes', 'Taylor Shaw'], i) || `Demo Talent ${i + 1}`,
        role: pick(['event_host', 'media_team', 'event_coordinator'], i) || 'event_host',
        bio: pick([
          'Friendly, high-energy host focused on smooth check-ins and strong lead capture.',
          'Detail-oriented media partner with fast turnaround and consistent branding.',
          'Coordinator who keeps vendors aligned and the run-of-show tight.',
        ], i),
        homeBaseCity: pick(cities, i) || 'Raleigh',
        homeBaseState: pick(states, i) || 'NC',
        specialties: pick([
          ['Lead capture', 'Resident engagement', 'Vendor coordination'],
          ['Photo recap', 'Short-form video', 'Brand consistency'],
          ['Run of show', 'Timeline management', 'Stakeholder comms'],
        ], i) || ['Lead capture'],
        preferredPairings: pick([
          ['Triangle Tacos', 'HarborView Coffee Cart'],
          ['Ridgeway Photo Booth', 'BlueSky Balloon Co.'],
          ['Coastal DJ Services', 'Triad Kids Corner'],
        ], i) || [],
        gear: pick([
          'iPhone 15 Pro, DJI gimbal, lapel mic, portable lights.',
          'Canon mirrorless, prime lens kit, LED panels, backups.',
          'Signage kit, QR stands, extension cords, tablecloths.',
        ], i),
        tone: pick(['Warm + professional', 'Upbeat + concise', 'Calm + confident'], i),
        notes: pick([
          'Arrives 30 minutes early; confirms layout and QR placement.',
          'Shares same-day highlight reel; full recap within 24h.',
          'Prefers clear owner contact + parking instructions.',
        ], i),
        reliability: {
          score: [92, 88, 96, 85, 90, 94][i % 6],
          lastEventAt: addDaysYmd(today, -(7 + i * 3)),
          flags: (i % 4 === 0) ? ['Needs parking instructions'] : [],
        },
        updatedAt: nowIso(),
        demoSeed: demoSeedId,
        demoRun: runId,
      });
    }

    // Add a few extra directory-only demo profiles for coordinator browsing.
    for (let i = 0; i < 8; i++) {
      demoProfiles.push({
        userId: `demo_talent_${demoSeedId}_${i + 1}`,
        displayName: pick(['Morgan Reed', 'Casey Parker', 'Drew Ellis', 'Avery James', 'Rowan Blake', 'Cameron Lane'], i + 3),
        role: pick(['event_host', 'media_team'], i),
        bio: pick([
          'Seasoned event host with a focus on friendly, inclusive resident experiences.',
          'Media pro who delivers consistent, on-brand recaps with fast turnaround.',
        ], i),
        homeBaseCity: pick(cities, i + 2),
        homeBaseState: pick(states, i + 1),
        specialties: pick([
          ['Check-in flow', 'Lead capture', 'Vendor coordination'],
          ['Photo recap', 'Video snippets', 'Editing'],
        ], i) || ['Lead capture'],
        preferredPairings: [],
        gear: pick([
          'QR signage kit, extension cords, tablecloths, clipboards.',
          'Mirrorless camera, gimbal, wireless mic, portable lights.',
        ], i),
        tone: pick(['Friendly', 'Professional', 'High-energy'], i),
        notes: pick([
          'Best for evening events; confirm lighting conditions.',
          'Comfortable with vendor-heavy activations and tight timelines.',
        ], i),
        reliability: {
          score: [84, 89, 91, 86, 93, 88][i % 6],
          lastEventAt: addDaysYmd(today, -(14 + i * 5)),
          flags: (i % 5 === 0) ? ['Follow up on media upload'] : [],
        },
        updatedAt: nowIso(),
        demoSeed: demoSeedId,
        demoRun: runId,
      });
    }

    talentProfilesSeeded = demoProfiles.length;

    await upsertKv(sb, key, {
      profiles: kept.concat(demoProfiles),
    });
  }

  // Demo logs/sets
  await sb.from('purestay_logs').insert([
    {
      list_key: `portal:demo:${demoSeedId}:timeline`,
      entry: { ...seedTag, type: 'seed', message: 'Demo dataset seeded', at: nowIso() },
      created_at: nowIso(),
    },
    {
      list_key: `portal:demo:${demoSeedId}:timeline`,
      entry: { ...seedTag, type: 'note', message: 'This data is safe to delete/reseed.', at: nowIso() },
      created_at: nowIso(),
    },
  ]);

  await sb.from('purestay_sets').upsert([
    { set_key: `portal:demo:${demoSeedId}:tags`, member: 'hot', created_at: nowIso() },
    { set_key: `portal:demo:${demoSeedId}:tags`, member: 'warm', created_at: nowIso() },
    { set_key: `portal:demo:${demoSeedId}:tags`, member: 'renewal', created_at: nowIso() },
    { set_key: `portal:demo:${demoSeedId}:regions`, member: 'Triangle', created_at: nowIso() },
    { set_key: `portal:demo:${demoSeedId}:regions`, member: 'Charlotte', created_at: nowIso() },
  ], { onConflict: 'set_key,member' });

  const prev = already && existing.row && existing.row.value && typeof existing.row.value === 'object'
    ? existing.row.value
    : null;

  const prevRuns = Array.isArray(prev?.runs)
    ? prev.runs
    : (prev && prev.counts)
      ? [{ runId: String(prev.runId || 'unknown'), seededAt: String(prev.seededAt || ''), counts: prev.counts }]
      : [];

  const thisRun = {
    runId,
    seededAt: nowIso(),
    mode: force ? 'force' : (isAppend ? 'append' : 'seed'),
    counts: {
      leads: leads.length,
      leadActivities: activities.length,
      events: events.length,
      recaps: recapsToInsert.length,
      appointments: appointmentsToInsert.length,
      dispatchTasks: dispatchTasks.length,
      payouts: payoutsToInsert.length,
      docs: docsToInsert.length,
      accounts: demoAccounts.length,
      availabilityUsers: usersForAvail.length,
      vendors: vendorsSeeded,
      eventTypes: eventTypesSeeded,
      talentProfiles: talentProfilesSeeded,
    },
  };

  const seedState = {
    demoSeedId,
    seededAt: thisRun.seededAt,
    lastRunId: runId,
    counts: thisRun.counts,
    runs: prevRuns.concat([thisRun]).slice(-20),
  };

  await upsertKv(sb, seedKey, seedState);

  return {
    ok: true,
    alreadySeeded: false,
    appended: Boolean(isAppend && already && !force),
    seedKey,
    seedState,
  };
}

function supabaseAuthClient() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  try {
    // eslint-disable-next-line global-require
    const { createClient } = require('@supabase/supabase-js');
    return createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const sb = supabaseAdmin();
  if (!sb) return sendJson(res, 503, { ok: false, error: 'missing_supabase_service_role' });

  const svc = await assertServiceRole(sb);
  if (!svc.ok) return sendJson(res, 503, { ok: false, error: svc.error, detail: svc.detail });

  // Bootstrap mode: allow seeding only if no profiles exist yet.
  // Otherwise require a manager session.
  const { count, error: cErr } = await sb
    .from('portal_profiles')
    .select('user_id', { count: 'exact', head: true });
  if (cErr) return sendJson(res, 500, { ok: false, error: 'seed_bootstrap_check_failed' });

  const bootstrap = Number(count || 0) === 0;

  const body = await readJson(req);

  if (!bootstrap) {
    // Prefer bearer-token auth.
    const s = await requirePortalSession(req);
    if (s.ok) {
      if (!isManager(s.profile)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    } else {
      // Fallback: allow reseed if the request includes manager credentials.
      const email = String(body?.email || '').trim().toLowerCase();
      const password = String(body?.password || '').trim();
      if (!email || !password) return sendJson(res, 401, { ok: false, error: 'missing_bearer_token' });

      const sbAuth = supabaseAuthClient();
      if (!sbAuth) return sendJson(res, 503, { ok: false, error: 'missing_supabase_service_role' });

      const login = await sbAuth.auth.signInWithPassword({ email, password });
      const user = login?.data?.user || null;
      if (login?.error || !user) return sendJson(res, 401, { ok: false, error: 'invalid_login' });

      const localPart = String(email.split('@')[0] || '').toLowerCase();
      const metaRole = user?.user_metadata?.role;
      const isMgr = String(metaRole || '').toLowerCase() === 'manager' || localPart === 'manager';
      if (!isMgr) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }
  }
  const password = String(body?.password || process.env.PORTAL_DEMO_PASSWORD || 'PurestayDemo!234');
  const domain = String(body?.domain || 'demo.purestaync.com');
  const roles = Array.isArray(body?.roles) ? body.roles : DEFAULT_ROLES;
  const seedData = Boolean(body?.seedData || body?.demoData || body?.demo || body?.seed);
  const force = Boolean(body?.force);
  const append = Boolean(body?.append || body?.more || body?.seedMore || body?.seed_more);
  const demoSeedId = String(body?.demoSeedId || 'v2').trim() || 'v2';
  const runId = mkUuid();

  const results = [];
  const userIdsByRole = {};

  for (const roleRaw of roles) {
    const role = String(roleRaw || '').trim();
    if (!role) continue;

    const localPart = role.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
    const email = `${localPart}@${domain}`;

    // Create or fetch
    const created = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role },
    });

    let userId = created?.data?.user?.id || '';

    if (!userId) {
      // If already exists, look it up (paging, projects may have >200 users).
      userId = await findAuthUserIdByEmail(sb, email, { perPage: 200, maxPages: 25 });
    }

    if (!userId) {
      // Fallback: if auth lookup fails, use any existing profile row for this role.
      userId = await findProfileUserIdByRole(sb, role);
    }

    if (!userId) {
      results.push({ role, email, ok: false, error: created?.error?.message || 'create_user_failed' });
      continue;
    }

    const fullName = titleCase(role);

    const { error: upsertErr } = await sb
      .from('portal_profiles')
      .upsert({ user_id: userId, role, full_name: fullName }, { onConflict: 'user_id' });

    if (upsertErr) {
      results.push({ role, email, ok: false, error: 'profile_upsert_failed', detail: upsertErr.message || '' });
      continue;
    }

    results.push({ role, email, ok: true, userId });
    userIdsByRole[role] = userId;
  }

  const ok = results.every((x) => x && x.ok);

  // Store the role→userId mapping so manager view-as can deterministically
  // impersonate the canonical demo users without needing a person picker.
  try {
    await upsertKv(sb, 'portal:demo_user_ids_by_role', {
      updatedAt: nowIso(),
      domain,
      userIdsByRole,
    });
  } catch {
    // Best-effort only.
  }

  let demo = null;
  if (seedData) {
    demo = await seedDemoData(sb, {
      demoSeedId,
      runId,
      userIdsByRole,
      domain,
      force,
      append,
    });
  }

  return sendJson(res, 200, {
    ok,
    bootstrap,
    domain,
    passwordHint: 'Use the password you supplied to this endpoint.',
    users: results,
    ...(demo ? { demo } : {}),
  });
};
