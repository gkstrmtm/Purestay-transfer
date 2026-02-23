let kvClient = null;

function hasKvEnv() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
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

async function getJson(key, fallback = null) {
  const client = await kv();
  if (!client) return fallback;

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
  const client = await kv();
  if (!client) return false;
  await client.set(key, JSON.stringify(value));
  return true;
}

async function appendLog(listKey, entry) {
  const client = await kv();
  if (!client) return false;
  await client.rpush(listKey, JSON.stringify(entry));
  return true;
}

async function getLogTail(listKey, count = 200) {
  const client = await kv();
  if (!client) return [];
  const start = -Math.max(1, Math.min(1000, Number(count) || 200));
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
  const client = await kv();
  if (!client) return false;
  await client.sadd(setKey, member);
  return true;
}

async function getSetMembers(setKey) {
  const client = await kv();
  if (!client) return [];
  const members = await client.smembers(setKey);
  return Array.isArray(members) ? members : [];
}

module.exports = {
  hasKvEnv,
  getJson,
  setJson,
  appendLog,
  getLogTail,
  addToSet,
  getSetMembers,
};
