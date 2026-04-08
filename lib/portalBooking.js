const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const BOOKING_ENV_KEYS = new Set([
  'PORTAL_BOOKING_API_KEY',
  'PORTAL_BOOKING_API_BASE_URL',
  'PORTAL_BOOKING_PROVIDER',
  'PORTAL_BOOKING_ACCOUNT_ID',
]);

function decodeEnvText(rawBuffer) {
  if (!rawBuffer || !rawBuffer.length) return '';
  let text = rawBuffer.toString('utf8');
  if (text.includes('\u0000')) {
    text = text.replace(/^\u00ff\u00fe/, '').replace(/\u0000/g, '');
  }
  return text.replace(/^\uFEFF/, '');
}

function parseEnvValue(rawValue) {
  const trimmed = String(rawValue || '').trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isHostedRuntime() {
  const hasPlatformRegion = !!String(
    process.env.VERCEL_REGION || process.env.AWS_REGION || process.env.NOW_REGION || ''
  ).trim();
  const vercelUrl = String(process.env.VERCEL_URL || '').trim();
  return hasPlatformRegion || (!!vercelUrl && !/^localhost(?::\d+)?$/i.test(vercelUrl));
}

function refreshLocalBookingEnv() {
  if (isHostedRuntime()) return;
  const candidates = [
    '.env',
    '.env.local',
    '.env.development.local',
    '.env.production',
    '.env.prod.local',
    'auth.env',
  ];

  for (const name of candidates) {
    const filePath = path.join(ROOT_DIR, name);
    if (!fs.existsSync(filePath)) continue;
    const text = decodeEnvText(fs.readFileSync(filePath));
    if (!text) continue;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;

      const key = line.slice(0, eqIdx).trim();
      if (!BOOKING_ENV_KEYS.has(key)) continue;

      const parsed = parseEnvValue(line.slice(eqIdx + 1));
      if (!parsed) continue;
      process.env[key] = parsed;
    }
  }
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function getBookingConfig() {
  refreshLocalBookingEnv();
  return {
    apiKey: cleanStr(process.env.PORTAL_BOOKING_API_KEY, 400),
    baseUrl: cleanStr(process.env.PORTAL_BOOKING_API_BASE_URL, 2000),
    provider: cleanStr(process.env.PORTAL_BOOKING_PROVIDER, 80),
    accountId: cleanStr(process.env.PORTAL_BOOKING_ACCOUNT_ID, 160),
  };
}

function bookingIntegrationSummary() {
  const config = getBookingConfig();
  return {
    configured: !!config.apiKey,
    provider: config.provider,
    baseUrl: config.baseUrl,
    accountLinked: !!config.accountId,
  };
}

module.exports = {
  bookingIntegrationSummary,
  getBookingConfig,
  refreshLocalBookingEnv,
};