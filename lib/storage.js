let kvClient = null;
let supabaseClient = null;

function hasSupabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(url && String(key || '').trim());
}

function hasKvEnv() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function hasStorageEnv() {
  return hasSupabaseEnv() || hasKvEnv();
}

async function supabase() {
  if (!hasSupabaseEnv()) return null;
  if (supabaseClient) return supabaseClient;

  try {
    // Lazily require so local dev still works without deps.
    // eslint-disable-next-line global-require
    const { createClient } = require('@supabase/supabase-js');
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    supabaseClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return supabaseClient;
  } catch {
    return null;
  }
}

async function kv() {
  if (!hasKvEnv()) return null;
  if (kvClient) return kvClient;

  try {
    // Lazily require so local dev still works without deps.
    // On Vercel, this package is expected to be installed via package.json.
    // eslint-disable-next-line global-require
    const { kv: client } = require('@vercel/kv');
    kvClient = client;
    return kvClient;
  } catch {
    return null;
  }
}

async function storageBackend() {
  const sb = await supabase();
  if (sb) return { type: 'supabase', client: sb };
  const k = await kv();
  if (k) return { type: 'kv', client: k };
  return { type: 'none', client: null };
}

async function getJson(key, fallback = null) {
  const { type, client } = await storageBackend();
  if (!client) return fallback;

  if (type === 'supabase') {
    const { data, error } = await client
      .from('purestay_kv')
      .select('value')
      .eq('key', String(key))
      .limit(1);
    if (error) return fallback;
    const row = Array.isArray(data) ? data[0] : null;
    return row && row.value != null ? row.value : fallback;
  }

  const raw = await client.get(key);
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

async function setJson(key, value) {
  const { type, client } = await storageBackend();
  if (!client) return false;

  if (type === 'supabase') {
    const { error } = await client
      .from('purestay_kv')
      .upsert({
        key: String(key),
        value,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
    return !error;
  }

  await client.set(key, JSON.stringify(value));
  return true;
}

async function delKey(key) {
  const { type, client } = await storageBackend();
  if (!client) return false;

  if (type === 'supabase') {
    const { error } = await client.from('purestay_kv').delete().eq('key', String(key));
    return !error;
  }

  await client.del(key);
  return true;
}

async function delKeys(keys) {
  const { type, client } = await storageBackend();
  if (!client) return false;
  const arr = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string' && k) : [];
  if (!arr.length) return true;

  if (type === 'supabase') {
    const { error } = await client.from('purestay_kv').delete().in('key', arr);
    return !error;
  }

  // Vercel KV supports del with multiple args
  await client.del(...arr);
  return true;
}

async function appendLog(listKey, entry) {
  const { type, client } = await storageBackend();
  if (!client) return false;

  if (type === 'supabase') {
    const { error } = await client.from('purestay_logs').insert({
      list_key: String(listKey),
      entry,
      created_at: new Date().toISOString(),
    });
    return !error;
  }

  await client.rpush(listKey, JSON.stringify(entry));
  return true;
}

async function getLogTail(listKey, count = 200) {
  const { type, client } = await storageBackend();
  if (!client) return [];
  const lim = Math.max(1, Math.min(1000, Number(count) || 200));

  if (type === 'supabase') {
    const { data, error } = await client
      .from('purestay_logs')
      .select('entry')
      .eq('list_key', String(listKey))
      .order('id', { ascending: false })
      .limit(lim);
    if (error || !Array.isArray(data)) return [];
    return data.map((r) => r.entry).filter(Boolean).reverse();
  }

  const start = -lim;
  const end = -1;
  const items = await client.lrange(listKey, start, end);
  if (!Array.isArray(items)) return [];
  return items
    .map((s) => {
      if (typeof s !== 'string') return null;
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function addToSet(setKey, member) {
  const { type, client } = await storageBackend();
  if (!client) return false;

  if (type === 'supabase') {
    const m = String(member || '').trim();
    if (!m) return true;
    const { error } = await client.from('purestay_sets').upsert({
      set_key: String(setKey),
      member: m,
      created_at: new Date().toISOString(),
    }, { onConflict: 'set_key,member' });
    return !error;
  }

  await client.sadd(setKey, member);
  return true;
}

async function getSetMembers(setKey) {
  const { type, client } = await storageBackend();
  if (!client) return [];

  if (type === 'supabase') {
    const { data, error } = await client
      .from('purestay_sets')
      .select('member')
      .eq('set_key', String(setKey))
      .order('member', { ascending: true })
      .limit(5000);
    if (error || !Array.isArray(data)) return [];
    return data.map((r) => r.member).filter(Boolean);
  }

  const members = await client.smembers(setKey);
  return Array.isArray(members) ? members : [];
}

module.exports = {
  hasSupabaseEnv,
  hasKvEnv,
  hasStorageEnv,
  getJson,
  setJson,
  delKey,
  delKeys,
  appendLog,
  getLogTail,
  addToSet,
  getSetMembers,
};
