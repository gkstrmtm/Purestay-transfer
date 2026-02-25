function cleanRole(role) {
  return String(role || '').trim();
}

function expandRoleAliases(role) {
  const r = cleanRole(role);
  if (!r) return [];
  if (r === 'dialer' || r === 'remote_setter') return ['dialer', 'remote_setter'];
  if (r === 'closer' || r === 'account_manager') return ['closer', 'account_manager'];
  return [r];
}

function roleMatchesAny(actualRole, requestedRole) {
  const actual = cleanRole(actualRole);
  if (!actual) return false;
  const roles = expandRoleAliases(requestedRole);
  if (!roles.length) return false;
  return roles.includes(actual);
}

function applyRoleFilter(query, column, role) {
  const roles = expandRoleAliases(role);
  if (!roles.length) return query;
  if (roles.length === 1) return query.eq(column, roles[0]);
  return query.in(column, roles);
}

function buildRoleOrParts(column, role) {
  const roles = expandRoleAliases(role);
  return roles.map((r) => `${column}.eq.${r}`);
}

module.exports = {
  expandRoleAliases,
  roleMatchesAny,
  applyRoleFilter,
  buildRoleOrParts,
};
