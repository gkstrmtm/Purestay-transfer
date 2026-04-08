const { cleanStr } = require('./portalFoundation');

function summarizeAuthIdentity(authUser, { emailFallback = '' } = {}) {
  const user = authUser && typeof authUser === 'object' ? authUser : null;
  if (!user) {
    const email = cleanStr(emailFallback, 160);
    return {
      email,
      phone: '',
      status: email ? 'verification_pending' : 'unlinked',
      statusLabel: email ? 'Verification pending' : 'No login identity',
      credentialLabel: email ? 'Email identity linked' : 'Identity not linked',
      emailConfirmedAt: '',
      lastSignInAt: '',
      createdAt: '',
      invitedAt: '',
      bannedUntil: '',
      providers: [],
      resetEligible: !!email,
    };
  }

  const identities = Array.isArray(user.identities) ? user.identities : [];
  const providers = Array.from(new Set([
    ...identities.map((entry) => cleanStr(entry?.provider || entry?.identity_data?.provider, 40).toLowerCase()).filter(Boolean),
    cleanStr(user.app_metadata?.provider, 40).toLowerCase(),
  ].filter(Boolean)));
  const email = cleanStr(user.email || emailFallback, 160);
  const phone = cleanStr(user.phone, 40);
  const emailConfirmedAt = cleanStr(user.email_confirmed_at || user.confirmed_at, 64);
  const lastSignInAt = cleanStr(user.last_sign_in_at, 64);
  const createdAt = cleanStr(user.created_at, 64);
  const invitedAt = cleanStr(user.invited_at, 64);
  const bannedUntil = cleanStr(user.banned_until, 64);

  let status = 'active';
  let statusLabel = 'Account active';
  if (!email) {
    status = 'unlinked';
    statusLabel = 'No login identity';
  } else if (bannedUntil && Number.isFinite(new Date(bannedUntil).getTime()) && new Date(bannedUntil).getTime() > Date.now()) {
    status = 'suspended';
    statusLabel = 'Access suspended';
  } else if (!emailConfirmedAt) {
    status = invitedAt ? 'invite_pending' : 'verification_pending';
    statusLabel = invitedAt ? 'Invite pending' : 'Verification pending';
  }

  const credentialLabel = providers.includes('email')
    ? 'Managed email login'
    : providers.length
      ? `${providers.map((item) => item.replace(/_/g, ' ')).join(', ')} linked`
      : (email ? 'Email identity linked' : 'Identity not linked');

  return {
    email,
    phone,
    status,
    statusLabel,
    credentialLabel,
    emailConfirmedAt,
    lastSignInAt,
    createdAt,
    invitedAt,
    bannedUntil,
    providers,
    resetEligible: providers.includes('email') || !!email,
  };
}

module.exports = {
  summarizeAuthIdentity,
};