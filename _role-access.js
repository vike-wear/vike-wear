// Which roles <TeamAdmin> asks the server to make team managers (delivery ledger P63, 2026-10-21). The app's own roles
// list marks a role `admin: true`; 'admin' already is a manager and 'member' never can be, so neither is asked for,
// and a role the roster already lists is left alone. Before, TeamAdmin asked for 'admin' too, the team route refused
// it and the refusal stopped the sync: every admin role listed after 'admin' stayed without the power the app gave it.
// Since W2-B (2026-10-26) TeamAdmin hands the whole list to the server in one call (team.syncRoles), which skips a role
// it cannot set and syncs the rest; rolesToGrant stays for the bundles published before.
export const BUILT_IN_ROLES = new Set(['admin', 'member'])

export function rolesToGrant(roleOptions, current) {
  const have = new Set(Array.isArray(current) ? current : [])
  return (Array.isArray(roleOptions) ? roleOptions : [])
    .filter((r) => r && r.admin && !BUILT_IN_ROLES.has(r.name) && !have.has(r.name))
    .map((r) => r.name)
}

// A role's powers on the team (W2-B): see every record, change every record (includes seeing), manage people.
export const POWERS = ['read', 'write', 'manage']

export function normalizePowers(list) {
  const set = new Set((Array.isArray(list) ? list : []).filter((p) => POWERS.includes(p)))
  if (set.has('write')) set.add('read')
  return POWERS.filter((p) => set.has(p))
}

/** What the app's roles list gives a role: admin: true = all three, else its `powers`. */
export function declaredPowers(roleOptions, name) {
  const o = (Array.isArray(roleOptions) ? roleOptions : []).find((r) => r && r.name === name)
  if (!o) return []
  return o.admin ? [...POWERS] : normalizePowers(o.powers)
}

/** The list team.syncRoles takes: every role the app names (not admin / member), with what it gives. */
export function manifestPowers(roleOptions) {
  return (Array.isArray(roleOptions) ? roleOptions : [])
    .filter((r) => r && r.name && !BUILT_IN_ROLES.has(r.name))
    .map((r) => ({ name: r.name, powers: declaredPowers(roleOptions, r.name) }))
}
