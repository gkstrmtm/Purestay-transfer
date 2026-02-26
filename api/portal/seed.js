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
}) {
  const seedKey = `portal:demo_seed:${demoSeedId}`;
  const existing = await getKv(sb, seedKey);
  const already = existing.ok && existing.row && existing.row.value && typeof existing.row.value === 'object';

  if (already && !force) {
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

  const mgrId = userIdsByRole.manager || null;
  const closerId = userIdsByRole.closer || mgrId;
  const amId = userIdsByRole.account_manager || mgrId;
  const dialerId = userIdsByRole.dialer || mgrId;
  const setterId = userIdsByRole.remote_setter || userIdsByRole.in_person_setter || mgrId;
  const coordId = userIdsByRole.event_coordinator || mgrId;
  const hostId = userIdsByRole.event_host || mgrId;
  const mediaId = userIdsByRole.media_team || mgrId;

  const today = ymdFromDate(new Date());
  const seedTag = { demoSeed: demoSeedId, demoRun: runId, demoDomain: domain };

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
  const leadStatuses = ['new', 'contacted', 'booked', 'won', 'lost'];
  const states = ['NC', 'SC', 'VA'];
  const cities = ['Raleigh', 'Durham', 'Cary', 'Charlotte', 'Wilmington', 'Greensboro'];
  const propertyTypes = ['Apartment', 'Condo', 'Townhome', 'Single-family', 'Build-to-rent'];
  const companies = ['Oakline Property Group', 'BlueSky Living', 'HarborView Realty', 'Ridgeway Communities', 'Pinecrest Partners'];

  const leadsToInsert = [];
  for (let i = 0; i < 28; i++) {
    const p = pick(leadPeople, i);
    const first = p?.first || `Lead${i + 1}`;
    const last = p?.last || 'Demo';
    const source = pick(leadSources, i);
    const status = pick(leadStatuses, i + 1);
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
  const eventStatuses = ['open', 'assigned', 'scheduled', 'done', 'cancelled'];
  const areaTags = ['Triangle', 'Charlotte', 'Coastal', 'Triad'];

  const eventsToInsert = [];
  const selectedLeadIds = leadIds.slice(0, 14);
  for (let i = 0; i < 14; i++) {
    const leadId = selectedLeadIds[i] || null;
    const status = pick(eventStatuses, i + 1);
    const eventDate = addDaysYmd(today, -10 + i);

    const isPast = i < 8;
    const isCancelled = status === 'cancelled';

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

    const assignments = [
      { role: 'event_coordinator', userId: coordId },
      { role: 'event_host', userId: hostId },
      ...(i % 2 === 0 ? [{ role: 'media_team', userId: mediaId }] : []),
    ].filter((a) => a && a.role && a.userId);

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
      assigned_role: 'event_coordinator',
      assigned_user_id: coordId,
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
    if (String(e.status || '') === 'cancelled') continue;

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
  // Payouts
  // -----------------------------
  const payoutsToInsert = [];
  const rolesForPayout = [
    { role: 'remote_setter', userId: setterId },
    { role: 'closer', userId: closerId },
    { role: 'account_manager', userId: amId },
    { role: 'event_host', userId: hostId },
    { role: 'media_team', userId: mediaId },
  ].filter((r) => r.userId);

  const periodStart = addDaysYmd(today, -30);
  const periodEnd = today;
  for (let i = 0; i < 18; i++) {
    const r = pick(rolesForPayout, i);
    if (!r) continue;
    payoutsToInsert.push({
      created_at: nowIso(),
      user_id: r.userId,
      role: r.role,
      amount_cents: [3500, 5000, 7500, 12000, 18000][i % 5],
      status: pick(['pending', 'approved', 'paid'], i),
      period_start: periodStart,
      period_end: periodEnd,
      description: pick([
        'Weekly performance bonus',
        'Commission payout',
        'Event delivery bonus',
        'Monthly account renewal incentive',
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
  const usersForAvail = [closerId, amId, mgrId].filter(Boolean);
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

  const seedState = {
    demoSeedId,
    runId,
    seededAt: nowIso(),
    counts: {
      leads: leads.length,
      leadActivities: activities.length,
      events: events.length,
      recaps: recapsToInsert.length,
      payouts: payoutsToInsert.length,
      docs: docsToInsert.length,
      accounts: demoAccounts.length,
      availabilityUsers: usersForAvail.length,
    },
  };

  await upsertKv(sb, seedKey, seedState);

  return {
    ok: true,
    alreadySeeded: false,
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
      // If already exists, look it up
      const listed = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
      const found = (listed?.data?.users || []).find((u) => String(u.email || '').toLowerCase() === email.toLowerCase());
      userId = found?.id || '';
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

  let demo = null;
  if (seedData) {
    demo = await seedDemoData(sb, {
      demoSeedId,
      runId,
      userIdsByRole,
      domain,
      force,
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
