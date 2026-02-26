const { getJson, setJson, appendLog, hasStorageEnv } = require('./storage');

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function splitList(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function hasResend() {
  return Boolean(String(process.env.RESEND_API_KEY || '').trim());
}

function hasTwilio() {
  return Boolean(
    String(process.env.TWILIO_ACCOUNT_SID || '').trim()
    && String(process.env.TWILIO_AUTH_TOKEN || '').trim()
    && String(process.env.TWILIO_FROM_PHONE || '').trim()
  );
}

async function sendEmailResend({ to, cc, bcc, from, replyTo, subject, html, text }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) return { ok: false, error: 'email_not_configured' };

  const payload = {
    from: cleanStr(from || process.env.NOTIFY_FROM_EMAIL || 'PureStay <no-reply@purestay.com>', 200),
    to: Array.isArray(to) ? to : [String(to || '')],
    subject: cleanStr(subject, 300),
    html: typeof html === 'string' && html.trim() ? html : undefined,
    text: typeof text === 'string' && text.trim() ? text : undefined,
    reply_to: replyTo ? cleanStr(replyTo, 200) : undefined,
    cc: Array.isArray(cc) && cc.length ? cc : undefined,
    bcc: Array.isArray(bcc) && bcc.length ? bcc : undefined,
  };

  for (const k of Object.keys(payload)) {
    if (payload[k] === undefined) delete payload[k];
  }

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = j?.message || j?.error || `resend_failed_${r.status}`;
    return { ok: false, error: String(msg) };
  }

  return { ok: true, id: j?.id || null, provider: 'resend' };
}

async function sendSmsTwilio({ to, body }) {
  const sid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
  const from = String(process.env.TWILIO_FROM_PHONE || '').trim();

  if (!sid || !token || !from) return { ok: false, error: 'sms_not_configured' };

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const basic = Buffer.from(`${sid}:${token}`).toString('base64');

  const params = new URLSearchParams();
  params.set('From', from);
  params.set('To', cleanStr(to, 40));
  params.set('Body', cleanStr(body, 1600));

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const text = await r.text().catch(() => '');
  if (!r.ok) return { ok: false, error: `twilio_failed_${r.status}` };

  let j = null;
  try { j = JSON.parse(text); } catch { j = null; }
  return { ok: true, id: j?.sid || null, provider: 'twilio' };
}

async function shouldSendOnce(dedupKey, withinMinutes) {
  const k = cleanStr(dedupKey, 240);
  if (!k) return { ok: true, allow: true };
  const prev = await getJson(`portal:notif:sent:${k}`, null);
  const last = prev?.sentAt ? Date.parse(prev.sentAt) : null;
  if (!last || !Number.isFinite(last)) return { ok: true, allow: true };
  const ageMs = Date.now() - last;
  const maxMs = Math.max(1, Number(withinMinutes || 0)) * 60 * 1000;
  return { ok: true, allow: ageMs > maxMs };
}

async function markSent(dedupKey, info) {
  const k = cleanStr(dedupKey, 240);
  if (!k) return;
  await setJson(`portal:notif:sent:${k}`, {
    sentAt: new Date().toISOString(),
    info: info && typeof info === 'object' ? info : {},
  });
}

async function notifyEmail({
  to,
  cc,
  bcc,
  subject,
  text,
  html,
  dedupKey,
  onceWithinMinutes = 360,
  requireStorageForDedup = true,
}) {
  const listTo = Array.isArray(to) ? to.filter(Boolean) : splitList(to);
  if (!listTo.length) return { ok: false, error: 'missing_to' };

  // Safety: without a shared storage backend, dedup cannot work across serverless invocations.
  // Default to refusing sends when dedup is requested to prevent cron-driven spam.
  const wantsDedup = Boolean(cleanStr(dedupKey, 240)) && Number(onceWithinMinutes || 0) > 0;
  if (requireStorageForDedup && wantsDedup && !hasStorageEnv()) {
    return { ok: false, error: 'storage_not_configured_for_dedup' };
  }

  const gate = await shouldSendOnce(dedupKey, onceWithinMinutes);
  if (gate.ok && !gate.allow) return { ok: true, skipped: true, reason: 'dedup' };

  let result = null;
  if (hasResend()) {
    result = await sendEmailResend({ to: listTo, cc, bcc, subject, html, text });
  } else {
    result = { ok: false, error: 'email_not_configured' };
  }

  await appendLog('portal:notifications', {
    ts: new Date().toISOString(),
    channel: 'email',
    to: listTo,
    subject: cleanStr(subject, 300),
    ok: !!result?.ok,
    skipped: !!result?.skipped,
    error: result?.ok ? null : String(result?.error || 'send_failed'),
    provider: result?.provider || null,
    providerId: result?.id || null,
    dedupKey: cleanStr(dedupKey, 240) || null,
  });

  if (result?.ok) await markSent(dedupKey, { channel: 'email', provider: result.provider, id: result.id });
  return result;
}

async function notifySms({
  to,
  body,
  dedupKey,
  onceWithinMinutes = 180,
  requireStorageForDedup = true,
}) {
  const phone = cleanStr(to, 40);
  if (!phone) return { ok: false, error: 'missing_to' };

  const wantsDedup = Boolean(cleanStr(dedupKey, 240)) && Number(onceWithinMinutes || 0) > 0;
  if (requireStorageForDedup && wantsDedup && !hasStorageEnv()) {
    return { ok: false, error: 'storage_not_configured_for_dedup' };
  }

  const gate = await shouldSendOnce(dedupKey, onceWithinMinutes);
  if (gate.ok && !gate.allow) return { ok: true, skipped: true, reason: 'dedup' };

  const result = hasTwilio() ? await sendSmsTwilio({ to: phone, body }) : { ok: false, error: 'sms_not_configured' };

  await appendLog('portal:notifications', {
    ts: new Date().toISOString(),
    channel: 'sms',
    to: phone,
    ok: !!result?.ok,
    skipped: !!result?.skipped,
    error: result?.ok ? null : String(result?.error || 'send_failed'),
    provider: result?.provider || null,
    providerId: result?.id || null,
    dedupKey: cleanStr(dedupKey, 240) || null,
  });

  if (result?.ok) await markSent(dedupKey, { channel: 'sms', provider: result.provider, id: result.id });
  return result;
}

module.exports = {
  splitList,
  notifyEmail,
  notifySms,
  hasResend,
  hasTwilio,
};
