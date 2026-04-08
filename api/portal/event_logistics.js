const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');
const { upsertRoutePlan, upsertEquipmentHandoff, ensureDispatchWorkOrder } = require('../../lib/portalFoundation');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!hasRole(s.profile, ['event_coordinator', 'manager'])) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const url = new URL(req.url || '/api/portal/event_logistics', 'http://localhost');
  const eventId = clampInt(url.searchParams.get('eventId'), 1, 1e12, null);

  if (req.method === 'GET') {
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const [{ data: routes }, { data: handoffs }, { data: orders }] = await Promise.all([
      s.sbAdmin.from('portal_route_plans').select('*').eq('event_id', eventId).order('updated_at', { ascending: false }).limit(20),
      s.sbAdmin.from('portal_equipment_handoffs').select('*').eq('event_id', eventId).order('updated_at', { ascending: false }).limit(20),
      s.sbAdmin.from('portal_dispatch_work_orders').select('*').eq('event_id', eventId).limit(1),
    ]);

    return sendJson(res, 200, {
      ok: true,
      eventId,
      routePlans: Array.isArray(routes) ? routes : [],
      equipmentHandoffs: Array.isArray(handoffs) ? handoffs : [],
      workOrder: Array.isArray(orders) ? orders[0] || null : null,
    });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const bodyEventId = clampInt(body.eventId, 1, 1e12, null);
    if (!bodyEventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const { data: events, error: eventError } = await s.sbAdmin
      .from('portal_events')
      .select('*')
      .eq('id', bodyEventId)
      .limit(1);
    if (eventError) return sendJson(res, 500, { ok: false, error: 'event_lookup_failed' });
    const event = Array.isArray(events) ? events[0] || null : null;
    if (!event) return sendJson(res, 404, { ok: false, error: 'event_not_found' });

    const routeInput = body.route && typeof body.route === 'object' ? body.route : {};
    const equipmentInput = body.equipment && typeof body.equipment === 'object' ? body.equipment : {};
    const workOrderInput = body.workOrder && typeof body.workOrder === 'object' ? body.workOrder : {};
    const hasRouteInput = !!(
      clampInt(routeInput.id, 1, 1e12, null)
      || cleanStr(routeInput.personUserId, 80)
      || cleanStr(routeInput.departureTime, 80)
      || cleanStr(routeInput.arrivalTarget, 80)
      || cleanStr(routeInput.parkingNotes, 4000)
      || cleanStr(routeInput.loadInNotes, 4000)
      || cleanStr(routeInput.lastKnownEta, 80)
    );
    const hasEquipmentInput = !!(
      clampInt(equipmentInput.id, 1, 1e12, null)
      || clampInt(equipmentInput.assetId, 1, 1e12, null)
      || clampInt(equipmentInput.fromLocationId, 1, 1e12, null)
      || cleanStr(equipmentInput.toPersonUserId, 80)
      || cleanStr(equipmentInput.checkedOutAt, 80)
      || cleanStr(equipmentInput.receivedAt, 80)
      || cleanStr(equipmentInput.returnedAt, 80)
      || cleanStr(equipmentInput.conditionNotes, 4000)
    );

    const [routeResult, equipmentResult, workOrderResult] = await Promise.all([
      hasRouteInput ? upsertRoutePlan(s.sbAdmin, {
        id: clampInt(routeInput.id, 1, 1e12, null),
        eventId: bodyEventId,
        personUserId: cleanStr(routeInput.personUserId, 80),
        departureTime: cleanStr(routeInput.departureTime, 80),
        arrivalTarget: cleanStr(routeInput.arrivalTarget, 80),
        routeStatus: cleanStr(routeInput.routeStatus, 40) || 'planned',
        parkingNotes: cleanStr(routeInput.parkingNotes, 4000),
        loadInNotes: cleanStr(routeInput.loadInNotes, 4000),
        lastKnownEta: cleanStr(routeInput.lastKnownEta, 80),
        meta: routeInput.meta && typeof routeInput.meta === 'object' ? routeInput.meta : {},
      }) : Promise.resolve({ ok: true, routePlan: null }),
      hasEquipmentInput ? upsertEquipmentHandoff(s.sbAdmin, {
        id: clampInt(equipmentInput.id, 1, 1e12, null),
        eventId: bodyEventId,
        assetId: clampInt(equipmentInput.assetId, 1, 1e12, null),
        fromLocationId: clampInt(equipmentInput.fromLocationId, 1, 1e12, null),
        toPersonUserId: cleanStr(equipmentInput.toPersonUserId, 80),
        checkedOutAt: cleanStr(equipmentInput.checkedOutAt, 80),
        receivedAt: cleanStr(equipmentInput.receivedAt, 80),
        returnedAt: cleanStr(equipmentInput.returnedAt, 80),
        status: cleanStr(equipmentInput.status, 40) || 'planned',
        conditionNotes: cleanStr(equipmentInput.conditionNotes, 4000),
        meta: equipmentInput.meta && typeof equipmentInput.meta === 'object' ? equipmentInput.meta : {},
      }) : Promise.resolve({ ok: true, equipmentHandoff: null }),
      ensureDispatchWorkOrder(s.sbAdmin, {
        event,
        ownerUserId: cleanStr(workOrderInput.ownerUserId, 80) || cleanStr(routeInput.personUserId, 80) || event.assigned_user_id || event.coordinator_user_id || event.created_by,
        status: cleanStr(workOrderInput.status, 40) || event.status || 'open',
        dispatchType: cleanStr(workOrderInput.dispatchType, 80) || cleanStr(event.meta?.dispatchType, 80) || 'event_ops',
        priority: workOrderInput.priority != null ? workOrderInput.priority : event.meta?.priority,
        notes: cleanStr(workOrderInput.notes, 4000) || cleanStr(equipmentInput.conditionNotes, 4000) || cleanStr(routeInput.parkingNotes, 4000),
        meta: Object.assign({}, workOrderInput.meta && typeof workOrderInput.meta === 'object' ? workOrderInput.meta : {}, {
          routePlanId: routeResult.routePlan?.id || null,
          equipmentHandoffId: equipmentResult.equipmentHandoff?.id || null,
          vendorDependencyCount: clampInt(workOrderInput.vendorDependencyCount, 0, 1000, 0),
          source: 'api/portal/event_logistics',
        }),
      }),
    ]);

    if (!routeResult.ok) return sendJson(res, 500, { ok: false, error: routeResult.error, detail: routeResult.detail || '' });
    if (!equipmentResult.ok) return sendJson(res, 500, { ok: false, error: equipmentResult.error, detail: equipmentResult.detail || '' });
    if (!workOrderResult.ok) return sendJson(res, 500, { ok: false, error: workOrderResult.error, detail: workOrderResult.detail || '' });

    const routePlanId = routeResult.routePlan?.id || null;
    const equipmentHandoffId = equipmentResult.equipmentHandoff?.id || null;
    if (routePlanId || equipmentHandoffId) {
      await s.sbAdmin
        .from('portal_dispatch_work_orders')
        .update({
          route_plan_id: routePlanId,
          equipment_bundle_id: equipmentHandoffId,
          vendor_dependency_count: clampInt(workOrderInput.vendorDependencyCount, 0, 1000, 0),
          updated_at: new Date().toISOString(),
        })
        .eq('id', workOrderResult.workOrder?.id || 0);
    }

    return sendJson(res, 200, {
      ok: true,
      eventId: bodyEventId,
      routePlan: routeResult.routePlan || null,
      equipmentHandoff: equipmentResult.equipmentHandoff || null,
      workOrder: workOrderResult.workOrder || null,
    });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};