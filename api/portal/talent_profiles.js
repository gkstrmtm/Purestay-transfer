const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function cleanList(input, { maxItems = 20, maxLen = 60 } = {}) {
  const arr = Array.isArray(input)
    ? input
    : cleanStr(input, maxItems * (maxLen + 1)).split(',').map((x) => x.trim());
  return arr.map((x) => cleanStr(x, maxLen)).filter(Boolean).slice(0, maxItems);
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

async function getKv(sbAdmin, key) {
  const { data, error } = await sbAdmin
    .from('purestay_kv')
    .select('key, value')
    .eq('key', key)
    .limit(1);
  if (error) return { ok: false, error: 'kv_read_failed' };
  const row = Array.isArray(data) ? data[0] : null;
  return { ok: true, value: row?.value };
}

async function upsertKv(sbAdmin, key, value) {
  const { error } = await sbAdmin
    .from('purestay_kv')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) return { ok: false, error: 'kv_write_failed' };
  return { ok: true };
}

function normalizeAvatarDataUrl(v) {
  const s = cleanStr(v, 250000);
  if (!s) return '';
  if (!(s.startsWith('data:image/png;base64,') || s.startsWith('data:image/jpeg;base64,'))) return '';
  // Basic size guard: data urls can bloat KV quickly.
  if (s.length > 220000) return '';
  return s;
}

function normalizePublicProfile(input, { userId, defaultRole = '' } = {}) {
  const p = isPlainObject(input) ? input : {};
  return {
    userId: cleanStr(userId, 80),
    displayName: cleanStr(p.displayName, 120),
    role: cleanStr(p.role, 40) || cleanStr(defaultRole, 40),
    bio: cleanStr(p.bio, 2000),
    homeBaseCity: cleanStr(p.homeBaseCity, 80),
    homeBaseState: cleanStr(p.homeBaseState, 20),
    specialties: cleanList(p.specialties, { maxItems: 30, maxLen: 60 }),
    tone: cleanList(p.tone, { maxItems: 30, maxLen: 60 }),
    gear: cleanList(p.gear, { maxItems: 30, maxLen: 80 }),
    preferredPairings: cleanList(p.preferredPairings, { maxItems: 30, maxLen: 80 }),
    notes: cleanStr(p.notes, 2000),
    avatarDataUrl: normalizeAvatarDataUrl(p.avatarDataUrl),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeInternalProfile(input, { userId, allowReliability = false } = {}) {
  const p = isPlainObject(input) ? input : {};
  const out = {
    userId: cleanStr(userId, 80),
    specialties: cleanList(p.specialties, { maxItems: 30, maxLen: 60 }),
    tone: cleanList(p.tone, { maxItems: 30, maxLen: 60 }),
    gear: cleanList(p.gear, { maxItems: 30, maxLen: 80 }),
    preferredPairings: cleanList(p.preferredPairings, { maxItems: 30, maxLen: 80 }),
    notes: cleanStr(p.notes, 2000),
    updatedAt: new Date().toISOString(),
  };

  if (allowReliability) {
    out.reliability = {
      score: clampInt(p?.reliability?.score, 0, 100, clampInt(p.reliabilityScore, 0, 100, null)),
      flags: Array.isArray(p?.reliability?.flags)
        ? p.reliability.flags.map((x) => cleanStr(x, 60)).filter(Boolean).slice(0, 30)
        : cleanList(p.reliabilityFlags, { maxItems: 30, maxLen: 60 }),
    };
  }

  return out;
}

function normalizeStoredRecord(raw, { fallbackUserId = '' } = {}) {
  const r = isPlainObject(raw) ? raw : {};
  const userId = cleanStr(r.userId || fallbackUserId, 80);
  const pubIn = isPlainObject(r.public) ? r.public : r;
  const intIn = isPlainObject(r.internal) ? r.internal : r;

  const publicProfile = normalizePublicProfile(pubIn, { userId, defaultRole: cleanStr(pubIn.role || r.role, 40) });
  const internalProfile = normalizeInternalProfile(intIn, { userId, allowReliability: true });

  // Back-compat: older rows stored reliability/notes at top-level.
  if (isPlainObject(r.reliability) && !isPlainObject(internalProfile.reliability)) {
    internalProfile.reliability = {
      score: clampInt(r.reliability.score, 0, 100, null),
      flags: Array.isArray(r.reliability.flags) ? r.reliability.flags.map((x) => cleanStr(x, 60)).filter(Boolean).slice(0, 30) : [],
    };
  }
  if (r.notes && !internalProfile.notes) internalProfile.notes = cleanStr(r.notes, 2000);

  // Back-compat: older rows stored tone/gear as strings.
  if (!publicProfile.tone.length && r.tone) publicProfile.tone = cleanList(r.tone, { maxItems: 30, maxLen: 60 });
  if (!publicProfile.gear.length && r.gear) publicProfile.gear = cleanList(r.gear, { maxItems: 30, maxLen: 80 });

  return {
    userId,
    public: publicProfile,
    internal: internalProfile,
    updatedAt: cleanStr(r.updatedAt, 40) || new Date().toISOString(),
  };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const key = 'portal:talent_profiles:v1';
  const url = new URL(req.url || '/api/portal/talent_profiles', 'http://localhost');

  const requesterRole = String(s.profile?.role || '');
  // Enforce permissions based on the real authenticated role (view-as should not grant access).
  const isCoordinator = hasRole(s.realProfile, ['event_coordinator', 'manager']);

  if (req.method === 'GET') {
    const requestedUserId = cleanStr(url.searchParams.get('userId'), 80);
    const effectiveUserId = requestedUserId || s.user.id;

    if (!isCoordinator && effectiveUserId !== s.user.id) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const r = await getKv(s.sbAdmin, key);
    if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });

    const value = (r.value && typeof r.value === 'object') ? r.value : {};
    const profiles = Array.isArray(value.profiles) ? value.profiles : [];

    if (!requestedUserId && isCoordinator) {
      const normalized = profiles.map((p) => normalizeStoredRecord(p));
      return sendJson(res, 200, { ok: true, profiles: normalized });
    }

    const hit = profiles.find((x) => String(x?.userId || '') === String(effectiveUserId)) || null;
    const normalized = hit ? normalizeStoredRecord(hit, { fallbackUserId: effectiveUserId }) : null;
    return sendJson(res, 200, { ok: true, profile: normalized, role: requesterRole });
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const targetUserId = cleanStr(body.userId, 80) || s.user.id;
    if (!isCoordinator && targetUserId !== s.user.id) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const allowReliability = isCoordinator;

    const r = await getKv(s.sbAdmin, key);
    if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });

    const value = (r.value && typeof r.value === 'object') ? r.value : {};
    const profiles = Array.isArray(value.profiles) ? value.profiles : [];

    const next = profiles.slice();
    const idx = next.findIndex((x) => String(x?.userId || '') === String(targetUserId));
    const baseRaw = idx >= 0 && next[idx] && typeof next[idx] === 'object' ? next[idx] : { userId: targetUserId };
    const base = normalizeStoredRecord(baseRaw, { fallbackUserId: targetUserId });

    const incoming = isPlainObject(body.profile) ? body.profile : (isPlainObject(body) ? body : {});
    const incomingPublic = isPlainObject(incoming.public) ? incoming.public : incoming;
    const incomingInternal = isPlainObject(incoming.internal) ? incoming.internal : incoming;

    const selfEdit = String(targetUserId) === String(s.user.id);

    // Build next record with strict field ownership:
    // - Self can edit public fields (name/city/state/bio/lists/avatar).
    // - Coordinator editing someone else can only edit internal fields + reliability.
    // - Coordinator editing self can edit both.
    const nextPublic = (() => {
      if (!selfEdit && !isCoordinator) return base.public;
      if (!selfEdit && isCoordinator) return base.public;

      const normalizedPub = normalizePublicProfile(incomingPublic, { userId: targetUserId, defaultRole: String(base.public?.role || s.profile?.role || '') });

      // Role should not be user-editable; keep existing if present.
      normalizedPub.role = cleanStr(base.public?.role || s.profile?.role || '', 40);

      // Preserve any existing avatar if the incoming one is rejected/empty.
      if (!normalizedPub.avatarDataUrl && base.public?.avatarDataUrl) normalizedPub.avatarDataUrl = base.public.avatarDataUrl;

      return Object.assign({}, base.public, normalizedPub);
    })();

    const nextInternal = (() => {
      if (!isCoordinator && selfEdit) return base.internal;

      const normalizedInt = normalizeInternalProfile(incomingInternal, { userId: targetUserId, allowReliability });
      // Never allow avatar updates through internal.
      if (normalizedInt.avatarDataUrl) delete normalizedInt.avatarDataUrl;
      return Object.assign({}, base.internal, normalizedInt);
    })();

    const merged = {
      userId: cleanStr(targetUserId, 80),
      public: nextPublic,
      internal: nextInternal,
      updatedAt: new Date().toISOString(),
    };
    if (idx >= 0) next[idx] = merged;
    else next.push(merged);

    const w = await upsertKv(s.sbAdmin, key, { profiles: next });
    if (!w.ok) return sendJson(res, 500, { ok: false, error: w.error });

    return sendJson(res, 200, { ok: true, profile: merged });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
