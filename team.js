/**
 * Teams helper — app-scoped member roster, invites, and credential login for
 * generated apps. Design: an owner provisions SEATS (username + password) via an
 * invite; each seat is a real Whacka identity scoped to this app, so the entire
 * groups / roles / visibility / writableBy engine works for it unchanged.
 *
 * Use this for SaaS-like team apps where an admin hands logins to staff/colleagues
 * who should NOT need their own Whacka account (field-service techs, cashiers,
 * assistants, office staff). For consumer apps where users sign up themselves, use
 * auth.signIn() (Whacka ID) instead.
 *
 * Two lists of people (2026-10-30): the TEAM (the roster — people who run the app
 * with its owner, counted by the plan) and the USERS (people the app serves — never
 * counted). Every people call takes an optional `list: 'team' | 'users'` (default
 * 'team'); people on the users list may sign up themselves (team.signUp, when the
 * owner allows it — team.setSignup) and never manage: they change their own records,
 * records that name them, and an empty one they take.
 *
 * Identity integration: after login/acceptInvite this persists the SAME token/user
 * keys auth.js reads, so auth.getCurrentUser(), auth.isAuthenticated(),
 * auth.onAuthChange(), getAppUserId(), and all db/social calls work for the seat
 * with no extra wiring. Sign a seat out with team.logout() (= auth.signOut()).
 *
 * Roles & permissions: a seat joins the app's roster (a social group) with a role.
 * Gate admin UI with social.canAdmin() and scope data with db visibleTo/writableBy
 * (see the database + roles skills) — never with a client-side `if (role === ...)`.
 * Roles are assigned server-side (team.setRole) and cannot be self-edited.
 */

import { getHeaders } from './_headers'
import { setSupabaseToken } from './_supabase-token'
import { getAnonymousId } from './user'
import { auth, adoptSession } from './auth'
import { storeSet } from './_session-store'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { absorbSessionRenewal } from './_session-expiry'
import { armSeatNotice } from './_seat-notice'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID
const TOKEN_KEY = '__whacka_auth_token'
const USER_KEY = '__whacka_auth_user'
// Provisioning a whole roster hashes up to 100 passwords server-side.
const BULK_TIMEOUT_MS = 180_000

// Failures throw the SDK's standard Error (.message = the server's sentence,
// .status, .code — e.g. AUTH_REQUIRED, FORBIDDEN, OWNER_REQUIRED, QUOTA_EXCEEDED,
// RATE_LIMITED; TIMEOUT / NETWORK without a status when the server never answered).
// QUOTA_EXCEEDED here is always the team's places (an add the plan has no room for):
// the shell says so at the bottom of the screen too (_seat-notice.js, ledger P108).
async function teamAction(action, params = {}, { timeoutMs } = {}) {
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/team`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ action, ...params }),
  }, { timeoutMs, route: 'team' })
  absorbSessionRenewal(res)
  if (!res.ok) {
    await throwFromResponse(res, 'Team request failed', 'team')
      .catch((e) => { armSeatNotice(e, auth.isAppOwner()); throw e })
  }
  return res.json().catch(() => ({}))
}

// Persist a seat session exactly like auth-modal does for Whacka ID, then make
// the in-memory auth state reflect it.
function applySession(data) {
  if (data.token) storeSet(TOKEN_KEY, data.token)
  if (data.user) storeSet(USER_KEY, JSON.stringify(data.user))
  if (data.supabaseToken) setSupabaseToken(data.supabaseToken)
  adoptSession(data.user || null)
  return { user: data.user, role: data.member?.role ?? null, list: data.member?.list ?? 'team' }
}

export const team = {
  // ─────────────────────────────────────────────
  // Staff side — login / accept invite
  // ─────────────────────────────────────────────

  /**
   * Accept an invite. The username was assigned by the admin on the invite, so the staff
   * member only sets a password (and optional display name). Signs them in and joins them
   * with the invite's role. Pass the `?join=<code>` value as `code`. Call team.inviteInfo(code)
   * first to show the assigned username on the form.
   *
   * @param {object} p
   * @param {string} p.code      - invite code (from the invite link)
   * @param {string} p.password  - password (min 6 chars)
   * @param {string} [p.displayName] - shown name; defaults to the username
   * @returns {Promise<{ user, role }>}
   * @example const { role } = await team.acceptInvite({ code, password })
   */
  async acceptInvite({ code, password, displayName, handle } = {}) {
    const anonymousId = getAnonymousId() // carry prior guest activity into the seat
    // handle is normally undefined (the invite carries the admin-assigned username);
    // it's only sent for legacy invites that had no assigned username.
    const data = await teamAction('acceptInvite', { code, password, displayName, handle, anonymousId })
    return applySession(data)
  },

  /**
   * Look up an invite's admin-assigned username + role (public; for the accept screen).
   * @param {string} code
   * @returns {Promise<{ handle, role, valid }>}
   */
  async inviteInfo(code) {
    return teamAction('inviteInfo', { code })
  },

  /**
   * Sign a returning seat in with their username + password.
   * @param {object} p
   * @param {string} p.handle
   * @param {string} p.password
   * @returns {Promise<{ user, role }>}
   * @example const { role } = await team.login({ handle, password })
   */
  async login({ handle, password } = {}) {
    const data = await teamAction('login', { handle, password })
    return applySession(data)
  },

  /**
   * Request to join (self-signup) — only works when the owner has turned self-signup ON
   * (see team.config().selfSignup). Creates a PENDING account with NO access until an admin
   * approves it; the person then signs in normally with team.login. Does not sign them in.
   * @param {object} p
   * @param {string} p.handle - desired username (3-30 chars: letters, digits, underscore)
   * @param {string} p.password - min 6 chars
   * @param {string} [p.displayName]
   * @returns {Promise<{ ok: boolean, pending: boolean }>}
   * @example await team.requestAccess({ handle: 'sara', password, displayName: 'Sara' })
   */
  async requestAccess({ handle, password, displayName } = {}) {
    return teamAction('requestAccess', { handle, password, displayName })
  },

  /**
   * Sign up to the app's USERS list — a username (or phone number) and a password (or
   * the app's 6-digit PIN), no e-mail. Works only when the owner allows sign-ups
   * (team.config().signup.signup is 'anyone' or 'approval'). 'anyone': signed in at
   * once, like team.login. 'approval': waits for the team — resolves { pending: true },
   * no session. Never counted against the plan. `role` must be one the owner opened for
   * sign-up (config().signup.signupRoles); omit it for the default role.
   * @param {{ handle: string, password: string, displayName?: string, role?: string }} p
   * @returns {Promise<{ user, role, list: 'users' } | { pending: true }>}
   * @example const r = await team.signUp({ handle: '0551234567', password, displayName: 'سارة' })
   */
  async signUp({ handle, password, displayName, role } = {}) {
    const data = await teamAction('signUp', { handle, password, displayName, role })
    if (data.pending) return { pending: true }
    return applySession(data)
  },

  /**
   * Read public team config. { selfSignup } tells the login screen whether to offer a
   * "request to join" option; { loginConfig: { pin, memberPicker, loginName } } tells it
   * how to render the credential form; { signup } who may sign up to the users list;
   * { usersList } whether the app has one, { lists } whether the platform keeps two
   * lists (<TeamLogin> / <TeamAdmin> read this themselves — you rarely need to). Safe
   * to call without being signed in.
   * @returns {Promise<{ selfSignup: boolean, loginConfig: { pin: boolean, memberPicker: boolean, loginName: 'username'|'phone' }, signup: { signup: 'invite'|'approval'|'anyone', signupRoles: string[], defaultRole: string }, usersList: boolean, lists: boolean }>}
   */
  async config() {
    return teamAction('config')
  },

  /**
   * Who may sign up to the users list (whoever manages the users): signup 'invite'
   * (nobody — the default; the team makes logins, invites or imports them), 'approval'
   * (a sign-up waits for the team), 'anyone' (in at once); signupRoles = the user roles a
   * person may pick when signing up; defaultRole = the one they get otherwise. Users
   * roles never manage ('admin' is refused). keep: true = the app's starting setting —
   * applied only while nobody has chosen one yet, so the owner's later choice (in
   * <TeamAdmin>) is never overwritten.
   * @param {{ signup?: 'invite'|'approval'|'anyone', signupRoles?: string[], defaultRole?: string, keep?: boolean }} p
   * @example await team.setSignup({ signup: 'approval', signupRoles: ['parent', 'student'] })
   */
  async setSignup({ signup, signupRoles, defaultRole, keep } = {}) {
    return teamAction('setSignup', { signup, signupRoles, defaultRole, keep })
  },

  /**
   * The id of THIS app's USERS list — bind the users' shared records here ('@users' in
   * src/rules.json), as team.groupId() is the team's. Made on first call, the owner's,
   * closed. A role of this list never manages; give team roles their powers over the
   * users with team.setUsersPowers.
   * @returns {Promise<string>}
   */
  async usersGroupId() {
    const data = await teamAction('usersGroupId')
    return data.groupId
  },

  /**
   * The team places the app owner has used across all their apps, and their plan's
   * number (null = no fixed number). APP OWNER only — <TeamAdmin> shows it on the Team tab.
   * @returns {Promise<{ used: number, limit: number | null }>}
   */
  async seatUsage() {
    return teamAction('seatUsage')
  },

  /**
   * Move someone between the lists: onto the team (counted — refused once the plan's
   * team number is reached) or off it to the users (frees the place). Needs whoever
   * manages both lists; onto the team only with a role within your own powers.
   * @param {string} userId
   * @param {'team'|'users'} list - where they go
   * @param {string} [role] - their role there (default 'member', or the users' default role)
   * @example await team.moveToList(userId, 'team', 'teacher')
   */
  async moveToList(userId, list, role) {
    return teamAction('moveToList', { userId, list, role })
  },

  /**
   * What each TEAM role may do with the users: { teamPowers: { role: ['read'|'write'|'manage'] } }
   * — see every user's records, change them, manage their accounts. Needs 'manage'.
   * @returns {Promise<Object<string, string[]>>}
   */
  async getUsersPowers() {
    const data = await teamAction('getRoleAccess', { list: 'users' })
    return data.teamPowers || {}
  },

  /**
   * Give a TEAM role its powers over the users (replaces what it had; [] = none):
   * 'read' (see every user's records), 'write' (change them, includes read), 'manage'
   * (users' accounts: add, reset passwords, disable). APP OWNER only.
   * @param {string} role - a team role name
   * @param {Array<'read'|'write'|'manage'>} powers
   * @example await team.setUsersPowers('teacher', ['read', 'write'])
   */
  async setUsersPowers(role, powers) {
    return teamAction('setRolePowers', { list: 'users', role, powers })
  },

  /**
   * Turn PIN mode / the tap-your-name member picker on or off for this app's sign-in
   * (both OFF by default). Admin only; call once when setting the app up.
   *
   * - pin: new logins use a 6-digit PIN instead of a password — <TeamLogin> shows a
   *   numeric keypad, <TeamAdmin> generates 6-digit PINs. Existing passwords keep
   *   working; the mode only constrains newly set secrets.
   * - memberPicker: the sign-in screen lists active members so people tap their name
   *   instead of typing a username. This shows the member list to ANYONE who opens
   *   the app — right for a classroom or a small shop; leave it off for rosters
   *   whose membership is sensitive.
   * - loginName: 'username' (the default) or 'phone' — <TeamLogin> asks for a phone
   *   number (digits only; nothing is sent to it, it is only the login name).
   *
   * @param {object} p - { pin?: boolean, memberPicker?: boolean, loginName?: 'username'|'phone' } (omitted keys unchanged)
   * @example await team.setLoginConfig({ pin: true, memberPicker: true })
   */
  async setLoginConfig({ pin, memberPicker, loginName } = {}) {
    return teamAction('setLoginConfig', { pin, memberPicker, loginName })
  },

  /**
   * The tap-your-name list for the sign-in screen (active members only). Only works
   * when the owner enabled the member picker (team.setLoginConfig). <TeamLogin> calls
   * this itself; members is null with tooMany:true above 200 people (the form falls
   * back to typing).
   * @returns {Promise<{ members: Array<{handle, displayName, avatarUrl}> | null, tooMany: boolean }>}
   */
  async loginRoster() {
    return teamAction('loginRoster')
  },

  /** Sign the current seat out. Same as auth.signOut(). */
  logout() {
    auth.signOut()
  },

  /**
   * Convenience: open the prebuilt <TeamLogin> as a modal and resolve when the seat
   * signs in (or null if dismissed). Auto-detects an `?join=<code>` invite link. For a
   * page-embedded form, render the <TeamLogin> component directly instead.
   * @param {object} [options] - { appName, code, mode } forwarded to <TeamLogin>
   * @returns {Promise<{ user, role } | null>}
   * @example const member = await team.signIn({ appName: 'Bouchaib' })
   */
  async signIn(options = {}) {
    const { openTeamLogin } = await import('../components/TeamLogin.jsx')
    return openTeamLogin(options)
  },

  /**
   * Open the roster manager (<TeamAdmin>) as a modal — the owner's screen to add staff,
   * assign roles, reset passwords, disable. Self-gates with canManage() (non-admins see an
   * access notice), so it's safe to wire to a single owner-only button. Use this to give the
   * owner a one-line entry to provisioning instead of hand-building an admin route — a Teams
   * app that renders <TeamLogin> but gives the owner no way to add people is an app no one can
   * be added to.
   * If the app has DISTINCT roles with different powers, pass them as `roles` so the
   * roster shows the owner a DROPDOWN of exactly those roles (instead of a free-text
   * box) — the role they assign then always matches the role strings your code scopes
   * on (db visibleTo:'role:cashier'). A role's `powers` on the team: 'read' (see every
   * team record), 'write' (change every team record, includes read), 'manage' (add
   * people, reset passwords, set roles — never above their own powers);
   * { admin: true } = all three. The panel grants them when the owner opens it, takes
   * back what this list once gave and no longer gives, and never touches what the owner
   * switched on by hand. Each entry is a string or { name, label?, admin?, powers? }.
   * Omit `roles` for a simple member roster. `userRoles` = the roles of the app's USERS
   * list (the people it serves, never counted; names or { name, label }): the panel then
   * shows Team · Users · Sign-in.
   * @param {object} [options]
   * @param {Array<string|{name:string,label?:string,admin?:boolean,powers?:Array<'read'|'write'|'manage'>}>} [options.roles]
   * @param {Array<string|{name:string,label?:string}>} [options.userRoles]
   * @returns {Promise<void>} resolves when the modal is dismissed
   * @example
   * // canManage() is async — resolve it into state, then render the entry (never await in JSX):
   * const ROLES = [{ name: 'cashier', label: 'Cashier' }, { name: 'accountant', label: 'Accountant', powers: ['read'] }, { name: 'manager', label: 'Manager', admin: true }]
   * const [canManage, setCanManage] = useState(false)
   * useEffect(() => { team.canManage().then(setCanManage) }, [])
   * return canManage && <button onClick={() => team.openAdmin({ roles: ROLES })}>Manage team</button>
   */
  async openAdmin(options) {
    const { openTeamAdmin } = await import('../components/TeamAdmin.jsx')
    // Forward only real config values — guards the common onClick={team.openAdmin}
    // wiring, where `options` is a DOM event, not a config object.
    const roles = Array.isArray(options?.roles) ? options.roles : undefined
    const userRoles = Array.isArray(options?.userRoles) ? options.userRoles : undefined
    const labels = options?.labels && typeof options.labels === 'object' ? options.labels : undefined
    return openTeamAdmin({ roles, userRoles, labels })
  },

  /**
   * Server-authoritative check: can the current caller manage the team's people (app
   * builder, or a role with the team's 'manage' power)? Use it to gate showing
   * <TeamAdmin> / people controls.
   * @returns {Promise<boolean>}
   */
  async canManage({ list } = {}) {
    const data = await teamAction('canManage', { list })
    return data.canManage === true
  },

  /**
   * The id of THIS app's team group — the single group the roster (and everyone's
   * roles) lives in. SCOPE A TEAMS APP'S SHARED DATA TO THIS GROUP so the roles you
   * assign actually govern that data: with the records bound here, admin-equivalent
   * roles (a role you marked admin:true) can read/edit everything, visibleTo /
   * writableBy 'role:<name>' gate by the seat's roster role, and creators see their own.
   * Do NOT create a separate group (social.getOrCreateGroup) for team data — the roster
   * roles don't exist in that other group, so every non-owner role silently sees/edits
   * nothing (only the owner works, via app-owner superadmin). The group is created on
   * first call, owned by the builder.
   * @returns {Promise<string>} the team group id
   * @example
   * const gid = await team.groupId()
   * // staff see their own, the manager (admin:true) sees all, cashiers gated by role — all server-enforced:
   * await db.insertShared('orders', order, undefined, { groupId: gid, visibleTo: 'creator-and-admin' })
   */
  async groupId() {
    const data = await teamAction('teamGroupId')
    return data.groupId
  },

  /**
   * The signed-in seat's membership in THIS app, or null if the caller isn't a seat.
   * displayName is the person's real name (falls back to the handle) — show it in
   * the UI instead of the handle when handles are ID/staff numbers.
   * @returns {Promise<{ userId, handle, role, status, displayName, avatarUrl } | null>}
   */
  async currentMember() {
    const data = await teamAction('currentMember')
    return data.member ?? null
  },

  /**
   * Change the signed-in seat's own password.
   * @param {string} currentPassword
   * @param {string} newPassword - min 6 chars
   */
  async changePassword(currentPassword, newPassword) {
    return teamAction('changePassword', { currentPassword, newPassword })
  },

  // ─────────────────────────────────────────────
  // Admin side — roster + invites (caller must be an app admin)
  // ─────────────────────────────────────────────

  /**
   * Create an invite for ONE person: the admin assigns their username + role here and gets
   * a single-use link to hand them. The staff member opens it and only sets a password.
   * The username must be unique in this app (and not already pending on another invite).
   *
   * @param {object} p
   * @param {string} p.handle   - the member's username (3-30 chars: letters, digits, underscore)
   * @param {string} [p.role='member'] - role the seat gets (e.g. 'cashier'); never 'owner'
   * @param {string} [p.label] - admin-only note
   * @param {number} [p.expiresIn] - ms until expiry (omit = never)
   * @returns {Promise<{ code, url, handle, role, expiresAt }>}
   * @example const { url } = await team.createInvite({ handle: 'sara', role: 'cashier' })
   */
  async createInvite({ handle, role, label, expiresIn, list } = {}) {
    return teamAction('createInvite', { handle, role, label, expiresIn, list })
  },

  /**
   * Create a member DIRECTLY (no invite link): the admin picks the username and either
   * sets the password or gets a generated temporary one back — then hands both to the
   * person ("here's your login"). Use when the owner provisions logins in person;
   * use createInvite when they'd rather send a join link.
   *
   * @param {object} p
   * @param {string} p.handle   - username (3-30 chars: letters, digits, underscore)
   * @param {string} [p.password] - min 6 chars; omit to auto-generate
   * @param {string} [p.role='member'] - role the seat gets; never 'owner'
   * @param {string} [p.displayName]
   * @returns {Promise<{ ok, userId, handle, role, url, tempPassword? }>} tempPassword
   *   is returned ONCE, only when the password was auto-generated.
   * @example const { tempPassword } = await team.createMember({ handle: 'sara', role: 'cashier' })
   */
  async createMember({ handle, password, role, displayName, list } = {}) {
    return teamAction('createMember', { handle, password, role, displayName, list })
  },

  /**
   * Bulk-create staff logins in ONE request — provision a whole roster at once instead of
   * adding people one by one. Pass an array of { handle, role?, displayName? }; passwords are
   * auto-generated and returned per row to hand out. Admin only. Skips usernames that already
   * exist (idempotent) and duplicates within the batch; capped at 100 per call. Pair it with
   * readSpreadsheet() to import an .xlsx/.csv of staff (the <TeamAdmin> "Import file" tab does
   * exactly this).
   * @param {Array<{handle:string, role?:string, displayName?:string}>} rows
   * @returns {Promise<{ created:number, results:Array<{handle:string, ok:boolean, role?:string, tempPassword?:string, reason?:string}> }>}
   * @example const { results } = await team.bulkCreateMembers([{ handle:'sara', role:'cashier' }, { handle:'omar' }])
   */
  async bulkCreateMembers(rows, { list } = {}) {
    return teamAction('bulkCreateMembers', { rows, list }, { timeoutMs: BULK_TIMEOUT_MS })
  },

  /**
   * Turn self-signup on/off for this app (OFF by default). When on, visitors can request to
   * join and the admin approves them from the pending list. Admin only.
   * @param {boolean} enabled
   * @example await team.setSelfSignup(true)
   */
  async setSelfSignup(enabled) {
    return teamAction('setSelfSignup', { enabled })
  },

  /**
   * People who requested to join and are awaiting approval (self-signup). Admin only.
   * @returns {Promise<Array<{ userId, handle, displayName, avatarUrl, requestedAt }>>}
   */
  async listPending({ list } = {}) {
    const data = await teamAction('listPending', { list })
    return data.pending || []
  },

  /**
   * Approve a pending request: activates the account and joins them with a role (default
   * 'member'). Admin only.
   * @example await team.approveMember(userId, 'cashier')
   */
  async approveMember(userId, role, list) {
    return teamAction('approveMember', { userId, role, list })
  },

  /** Reject (delete) a pending request. Admin only. For active members use disableMember. */
  async rejectMember(userId) {
    return teamAction('rejectMember', { userId })
  },

  /**
   * Reject (delete) ALL pending requests at once — clears a flooded queue in one call instead
   * of rejecting each request individually. Admin only.
   * @returns {Promise<{ rejected: number }>}
   */
  async rejectAllPending({ list } = {}) {
    return teamAction('rejectAllPending', { list })
  },

  /**
   * List this app's invites. Admin only. Each invite has an `active` flag and, while
   * still open, the join `url` so the admin can re-copy/re-send it.
   * Returns up to 1000 invites — for apps with more, page with listInvitesPage.
   */
  async listInvites() {
    const data = await teamAction('listInvites')
    return data.invites || []
  },

  /**
   * List invites one page at a time (for apps with >1000 invites). Admin only. `list`
   * keeps one list's invites ('team' | 'users'); each invite says its `list`.
   * @param {{ pageSize?: number, cursor?: string, list?: 'team'|'users' }} [opts] pageSize 1..1000; cursor from a prior page
   * @returns {Promise<{ invites: Array, hasMore: boolean, nextCursor: string|null }>}
   */
  async listInvitesPage({ pageSize, cursor, list } = {}) {
    const data = await teamAction('listInvites', { pageSize, cursor, list })
    return { invites: data.invites || [], hasMore: !!data.hasMore, nextCursor: data.nextCursor ?? null }
  },

  /** Revoke (delete) an invite by its code. Admin only. */
  async revokeInvite(code) {
    return teamAction('revokeInvite', { code })
  },

  /**
   * List the app's members with role + status. Admin only. A disabled member has
   * role null and disabledRole = the role they come back with (null = 'member').
   * Returns up to 1000 members — for larger rosters, page with listMembersPage.
   * @returns {Promise<Array<{ userId, handle, displayName, avatarUrl, role, disabledRole?, status, lastLoginAt, joinedAt }>>}
   */
  async listMembers({ list } = {}) {
    const data = await teamAction('listMembers', { list })
    return data.members || []
  },

  /**
   * List members one page at a time — use for rosters that can exceed 1000 seats.
   * Pages follow roster order (join date), then disabled/removed credentials.
   * A page may be EMPTY with hasMore still true while the server scans a large
   * roster — loop on hasMore, never on members.length.
   * @param {{ pageSize?: number, cursor?: string }} [opts] pageSize 1..1000; cursor from a prior page
   * @returns {Promise<{ members: Array, hasMore: boolean, nextCursor: string|null }>}
   * @example
   *   let cursor, all = []
   *   do {
   *     const page = await team.listMembersPage({ pageSize: 500, cursor })
   *     all = all.concat(page.members)
   *     if (!page.hasMore) break
   *     cursor = page.nextCursor
   *   } while (cursor)
   */
  async listMembersPage({ pageSize, cursor, list } = {}) {
    const data = await teamAction('listMembers', { pageSize, cursor, list })
    return { members: data.members || [], hasMore: !!data.hasMore, nextCursor: data.nextCursor ?? null }
  },

  /**
   * Set a member's role. Needs the team's 'manage' power, and every power of the role
   * given and of the role taken away. Role names: lowercase letters/digits/hyphen/
   * underscore, start with a letter, max 32 chars; 'owner' is reserved. A role's powers
   * come from team.setRolePowers (or the roles list of team.openAdmin).
   * @param {string} userId
   * @param {string} role
   * @example await team.setRole(userId, 'manager')
   */
  async setRole(userId, role) {
    return teamAction('setRole', { userId, role })
  },

  /**
   * Which custom roles can manage the team (invite, set roles, reset passwords)?
   * 'admin' always can; 'member' never can. Admin only.
   * @returns {Promise<string[]>} the admin-equivalent custom role names
   */
  async getRoleAccess() {
    const data = await teamAction('getRoleAccess')
    return data.adminRoles || []
  },

  /**
   * Grant or revoke team-management access for a custom role (e.g. make every
   * 'manager' an admin-equivalent). Only the APP OWNER can change this.
   * @param {string} role - custom role name (not 'admin'/'member'/'owner')
   * @param {boolean} admin - true to grant, false to revoke
   * @example await team.setRoleAccess('manager', true)
   */
  async setRoleAccess(role, admin) {
    return teamAction('setRoleAccess', { role, admin })
  },

  /**
   * Every role's powers on the team: { adminRoles, powers: { role: ['read'|'write'|'manage'] },
   * codePowers } (codePowers = what the app's roles list granted). Needs 'manage'.
   * @returns {Promise<{ adminRoles: string[], powers: Object<string, string[]>, codePowers: Object<string, string[]> }>}
   */
  async getRolePowers() {
    const data = await teamAction('getRoleAccess')
    return { adminRoles: data.adminRoles || [], powers: data.powers || {}, codePowers: data.codePowers || {} }
  },

  /**
   * Give one role its powers on the team (replaces what it had; [] = none): 'read' (see
   * every team record), 'write' (change every team record, includes read), 'manage'
   * (add people, reset passwords, set roles). All three = an admin role. APP OWNER only.
   * @param {string} role - custom role name (not 'admin'/'member'/'owner')
   * @param {Array<'read'|'write'|'manage'>} powers
   * @example await team.setRolePowers('accountant', ['read'])
   */
  async setRolePowers(role, powers) {
    return teamAction('setRolePowers', { role, powers })
  },

  /**
   * Bring the team's role powers in line with the app's own roles list (APP OWNER only;
   * <TeamAdmin roles> does this itself when the owner opens it): grants what the list
   * gives, takes back what it once gave and no longer gives, keeps the owner's own grants.
   * @param {Array<{ name: string, powers: Array<'read'|'write'|'manage'> }>} roles
   */
  async syncRoles(roles) {
    return teamAction('syncRoles', { roles })
  },

  /**
   * Disable a member: blocks login, signs them out wherever they are signed in, and
   * removes them from the roster (no team data). Re-enable with enableMember — they
   * come back with the role they had. Resolves { ok, status, disabledRole? }.
   * @param {string} userId
   */
  async disableMember(userId) {
    return teamAction('setStatus', { userId, status: 'disabled' })
  },

  /**
   * Re-enable a disabled member: they rejoin with the role they held when disabled
   * (else 'member'). Resolves { ok, status, role }.
   */
  async enableMember(userId) {
    return teamAction('setStatus', { userId, status: 'active' })
  },

  /**
   * PERMANENTLY remove a member: revokes access and signs them out, frees their quota
   * seat, and frees the username for reuse. Irreversible — for someone who might come
   * back, use disableMember instead. Rows the member created stay in the app's data.
   * <TeamAdmin> already offers this with a confirm step; only call it directly from
   * your own UI behind an explicit confirmation.
   * @param {string} userId
   */
  async deleteMember(userId) {
    return teamAction('deleteMember', { userId })
  },

  /**
   * Reset a member's password. Admin only. Omit newPassword to have the platform
   * generate a temporary one, returned ONCE as { tempPassword } to hand to the member.
   * Also re-enables a disabled member, with the role they held.
   * @param {string} userId
   * @param {string} [newPassword] - min 6 chars; omit to auto-generate
   * @returns {Promise<{ ok, tempPassword?, role }>}
   */
  async resetPassword(userId, newPassword) {
    return teamAction('resetPassword', { userId, newPassword })
  },
}
