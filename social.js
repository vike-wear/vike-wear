/**
 * Social helper — user relationships, groups, and profiles for generated apps.
 * Requires Auth — user must be signed in to use social features.
 */

import { getAppUserId } from './user'
import { getHeaders } from './_headers'
import { absorbSessionRenewal } from './_session-expiry'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { auth } from './auth'
import { armSeatNotice } from './_seat-notice'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID

// ─────────────────────────────────────────────
// Internal helper
// ─────────────────────────────────────────────

// Failures throw the SDK's standard Error (.message = the server's sentence,
// .status, .code — e.g. AUTH_REQUIRED, FORBIDDEN, NOT_FOUND, RATE_LIMITED;
// TIMEOUT / NETWORK without a status when the server never answered).
// inviteToGroup onto the team answers QUOTA_EXCEEDED when the plan has no team place
// left; the shell says so at the bottom of the screen too (_seat-notice.js, ledger P108).
async function socialAction(action, params = {}) {
  const userId = getAppUserId()
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/social`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ action, userId, ...params }),
  }, { route: 'social' })
  absorbSessionRenewal(res)
  if (!res.ok) {
    await throwFromResponse(res, 'Social action failed', 'social')
      .catch((e) => { if (action === 'inviteToGroup') armSeatNotice(e, auth.isAppOwner()); throw e })
  }
  return res.json()
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export const social = {
  // ── User Relationships ──

  /**
   * Follow a user.
   * @param {string} userId - ID of the user to follow
   * @example await social.follow(userId)
   */
  async follow(userId) {
    return socialAction('follow', { targetId: userId })
  },

  /**
   * Unfollow a user.
   * @param {string} userId - ID of the user to unfollow
   * @example await social.unfollow(userId)
   */
  async unfollow(userId) {
    return socialAction('unfollow', { targetId: userId })
  },

  /**
   * Get the current user's followers.
   * @returns {Promise<Array<{ id, email, displayName, avatarUrl }>>}
   * @example const { users } = await social.getFollowers()
   */
  async getFollowers() {
    const data = await socialAction('getFollowers')
    return data.users
  },

  /**
   * Get the users the current user is following.
   * @returns {Promise<Array<{ id, email, displayName, avatarUrl }>>}
   * @example const { users } = await social.getFollowing()
   */
  async getFollowing() {
    const data = await socialAction('getFollowing')
    return data.users
  },

  /**
   * Check if the current user follows a specific user.
   * @param {string} userId
   * @returns {Promise<boolean>}
   * @example const isFollowing = await social.isFollowing(userId)
   */
  async isFollowing(userId) {
    const data = await socialAction('isFollowing', { targetId: userId })
    return data.following
  },

  /**
   * Find people, for a signed-in caller: this app's people by name, or one
   * account anywhere by its whole email address. Anonymous callers get [].
   * @param {string} query - A name, or a whole email address
   * @returns {Promise<Array<{ id, email, displayName, avatarUrl }>>}
   * @example const users = await social.searchUsers('alice')
   */
  async searchUsers(query) {
    const data = await socialAction('searchUsers', { query })
    return data.users
  },

  /**
   * Get a user's profile with follower/following counts.
   * @param {string} userId
   * @returns {Promise<{ id, email, displayName, avatarUrl, followersCount, followingCount, isFollowing }>}
   * @example const profile = await social.getUserProfile(userId)
   */
  async getUserProfile(userId) {
    const data = await socialAction('getUserProfile', { targetId: userId })
    return data.user
  },

  // ── Groups ──
  //
  // Every groupId parameter below also accepts the data path's named-audience
  // form 'key:<slug>' — it resolves to the SAME group your key-scoped rows
  // ({ groupId: 'key:<slug>' }) live in, with the app owner as its top admin.
  // Binding roles to key-scoped data? Pass that same 'key:<slug>' here, and don't
  // also getOrCreateGroup that name: when anyone but the app owner calls it first,
  // it makes a separate group your rows are not in.

  /**
   * Create a new group. The creator automatically becomes the owner.
   *
   * closed: true — nobody joins by themselves (joinGroup answers GROUP_CLOSED);
   * someone who manages the group adds people with inviteToGroup.
   * powers — what each role of this group may do, beyond its own records:
   *   'read' (see every record bound to the group), 'write' (change every record,
   *   includes read), 'manage' (add people and set their roles). '<role>@team'
   *   gives a role of the app's team roster those powers here without making them
   *   members (e.g. HR reads every department group) — the app owner's to set: they
   *   are dropped from anyone else's call. 'owner' and 'admin' always hold all three.
   * @param {object} options
   * @param {string} options.name - Group name
   * @param {string} [options.description] - Group description
   * @param {string} [options.avatarUrl] - Group avatar URL
   * @param {boolean} [options.closed] - members only added by someone who manages the group
   * @param {Object<string, Array<'read'|'write'|'manage'>>} [options.powers] - role → powers ('<role>@team' for a roster role)
   * @returns {Promise<{ id, name, description, avatarUrl, createdBy, createdAt, closed }>}  (roles' powers: getRolePowers)
   * @example const group = await social.createGroup({ name: 'Family', description: 'Our family group' })
   * @example const dept = await social.createGroup({ name: 'Sales', closed: true, powers: { manager: ['read', 'write'], 'hr@team': ['read', 'manage'] } })
   */
  async createGroup(options) {
    const data = await socialAction('createGroup', options)
    return data.group
  },

  /**
   * Get an existing group by a stable key, or create it if it doesn't exist yet.
   * Idempotent: calling this repeatedly with the same `key` (on every app launch,
   * from multiple devices, or during a render race) always returns the SAME group
   * — it never creates duplicates. The creator becomes the owner.
   *
   * Use this instead of createGroup whenever the app needs exactly one group for a
   * stable identity: the app's single team (key e.g. 'main'), or one group per
   * tenant entity (key = that entity's id). Plain createGroup in a boot/effect path
   * spawns duplicate groups on remount/refresh — getOrCreateGroup is the safe way.
   *
   * For data scoped with { groupId: 'key:<slug>' }, pass that 'key:<slug>'
   * string itself as the groupId to any role/member method — not this method
   * with that name: when anyone but the app owner calls it first, it makes a
   * separate group your rows are not in.
   *
   * closed / powers (see createGroup) apply when this call makes the group; an
   * existing group keeps its own — change them with setGroupClosed / setRolePowers.
   *
   * @param {object} options
   * @param {string} options.name - Group name (set once, by the first creator)
   * @param {string} options.key  - Stable idempotency key, unique per group in this app
   * @param {string} [options.description]
   * @param {string} [options.avatarUrl]
   * @param {boolean} [options.closed]
   * @param {Object<string, Array<'read'|'write'|'manage'>>} [options.powers]
   * @returns {Promise<{ id, name, description, avatarUrl, createdBy, createdAt, closed }>}  (roles' powers: getRolePowers)
   * @example const team = await social.getOrCreateGroup({ name: 'Staff', key: 'main' })
   */
  async getOrCreateGroup(options) {
    const data = await socialAction('getOrCreateGroup', options)
    return data.group
  },

  /**
   * Get the groups the current user is a member of WITHIN THIS APP. Server
   * scopes results to the current project; groups the user joined in other
   * Whacka apps are not returned.
   * @returns {Promise<Array<{ id, name, description, avatarUrl, projectId, role, joinedAt, closed }>>}
   * @example const groups = await social.getGroups()
   */
  async getGroups() {
    const data = await socialAction('getGroups')
    return data.groups
  },

  /**
   * Join a group. A closed group refuses with code GROUP_CLOSED — its people are
   * added by someone who manages it (inviteToGroup). Already a member: no change.
   * @param {string} groupId
   * @example await social.joinGroup(groupId)
   */
  async joinGroup(groupId) {
    return socialAction('joinGroup', { groupId })
  },

  /**
   * Leave a group. The owner cannot leave (it would orphan the group with no
   * recovery) — transfer ownership first with transferOwnership, or delete the
   * group. Any other member may leave freely.
   * @param {string} groupId
   * @example await social.leaveGroup(groupId)
   */
  async leaveGroup(groupId) {
    return socialAction('leaveGroup', { groupId })
  },

  /**
   * Get all members of a group. Each member's user id is returned as BOTH `id` and
   * `userId` (same value) — pass member.userId (or member.id) to setRole /
   * appointAdmin / record assignment.
   * @param {string} groupId
   * @returns {Promise<Array<{ id, userId, displayName, avatarUrl, role, joinedAt }>>}
   * @example const members = await social.getGroupMembers(groupId)
   */
  async getGroupMembers(groupId) {
    const data = await socialAction('getGroupMembers', { groupId })
    return data.members
  },

  /**
   * Add another user to a group (as 'member'). Needs the group's 'manage' power
   * (its owner, an admin, or a role given manage) — groups are permission
   * boundaries. For open, self-service joining, use joinGroup instead.
   * @param {string} groupId
   * @param {string} userId
   * @example await social.inviteToGroup(groupId, userId)  // caller must be group admin
   */
  async inviteToGroup(groupId, userId) {
    return socialAction('inviteToGroup', { groupId, targetId: userId })
  },

  /**
   * Get the current user's role in a group. Returns the literal stored role string
   * (defaults: 'owner' / 'admin' / 'member'; can be any custom name set via setRole).
   * @param {string} groupId
   * @returns {Promise<string|null>}
   * @example const role = await social.getMyRole(groupId)
   */
  async getMyRole(groupId) {
    const data = await socialAction('getMyRole', { groupId })
    return data.role
  },

  /**
   * Server-authoritative check: may the current caller change every record of this
   * group (its 'write' power — 'admin', 'owner', a role in setAdminRoles, or a role
   * given write)? Gate edit controls with it; for the separate powers use getMyPowers.
   * Do not replicate the role list in front-end code.
   * @param {string} groupId
   * @returns {Promise<boolean>}
   * @example if (await social.canAdmin(groupId)) showEditControls()
   */
  async canAdmin(groupId) {
    const data = await socialAction('canAdmin', { groupId })
    return data.canAdmin === true
  },

  /**
   * The current caller's powers in this group, server-checked: 'read' (sees every
   * record bound to it), 'write' (changes every record), 'manage' (adds people,
   * sets roles). For UI gating; the server checks again on every action.
   * @param {string} groupId
   * @returns {Promise<Array<'read'|'write'|'manage'>>}
   * @example const powers = await social.getMyPowers(deptId); const canApprove = powers.includes('write')
   */
  async getMyPowers(groupId) {
    const data = await socialAction('getMyPowers', { groupId })
    return data.powers || []
  },

  /**
   * Give one role its powers in this group (replaces what it had; [] = none).
   * role = a role of this group, or '<role>@team' for a role of the app's team
   * roster (they get the powers here without being members; the app owner only,
   * on a group the app owner holds). Only the group's owner or the app owner —
   * someone who manages the group cannot raise roles.
   * @param {string} groupId
   * @param {string} role
   * @param {Array<'read'|'write'|'manage'>} powers - 'write' includes 'read'
   * @returns {Promise<{ ok: boolean, powers: Object<string, string[]> }>}
   * @example await social.setRolePowers(deptId, 'accountant@team', ['read'])
   */
  async setRolePowers(groupId, role, powers) {
    return socialAction('setRolePowers', { groupId, role, powers })
  },

  /**
   * The group's closed switch and every role's powers (members, and roles given a power, may read it).
   * @param {string} groupId
   * @returns {Promise<{ closed: boolean, adminRoles: string[], powers: Object<string, string[]> }>}
   */
  async getRolePowers(groupId) {
    return socialAction('getRolePowers', { groupId })
  },

  /**
   * Close or open a group. Closed: nobody joins by themselves (joinGroup answers
   * GROUP_CLOSED); someone who manages it adds people with inviteToGroup. Only the
   * group's owner or the app owner.
   * @param {string} groupId
   * @param {boolean} closed
   * @example await social.setGroupClosed(deptId, true)
   */
  async setGroupClosed(groupId, closed) {
    return socialAction('setGroupClosed', { groupId, closed })
  },

  /**
   * Promote an existing group member to admin (all three powers). The caller needs
   * all three themselves (an admin or the owner) — nobody gives more than they hold.
   * Admins can update / delete any shared record bound to this group (via its _groupId).
   * Equivalent to setRole(groupId, userId, 'admin'). Kept for ergonomics.
   * @param {string} groupId
   * @param {string} userId
   * @example await social.appointAdmin(clubGroupId, userId)
   */
  async appointAdmin(groupId, userId) {
    return socialAction('appointAdmin', { groupId, targetId: userId })
  },

  /**
   * Demote an admin back to regular member. Caller must be admin or owner.
   * Cannot target the owner. Equivalent to setRole(groupId, userId, 'member').
   * @param {string} groupId
   * @param {string} userId
   * @example await social.revokeAdmin(clubGroupId, userId)
   */
  async revokeAdmin(groupId, userId) {
    return socialAction('revokeAdmin', { groupId, targetId: userId })
  },

  /**
   * Transfer group ownership to another member. The current owner becomes an admin
   * and the named member becomes the sole owner — atomically. Owner-only; the new
   * owner must already be a member. This is the only way to move ownership, and it's
   * how an owner hands off before leaving (the owner cannot leaveGroup directly).
   * @param {string} groupId
   * @param {string} newOwnerId  - user id of the member to promote to owner
   * @example await social.transferOwnership(groupId, successorUserId)
   */
  async transferOwnership(groupId, newOwnerId) {
    return socialAction('transferOwnership', { groupId, newOwnerId })
  },

  /**
   * Make the app BUILDER the owner of a group — yourself by default (call from the
   * app-owner's session), or a named member. Unlike transferOwnership (which only the
   * current group owner can call), this is authorized by APP ownership, so the builder
   * can always (re)claim a group their app created — e.g. when a member happened to open
   * the app first and became the group's owner. Demotes the current owner. App-owner only.
   * @param {string} groupId
   * @param {string} [newOwnerId] - member to install as owner; defaults to the caller (the builder)
   * @example await social.claimGroupOwnership(team.id)  // builder takes ownership of the team
   */
  async claimGroupOwnership(groupId, newOwnerId) {
    return socialAction('claimGroupOwnership', { groupId, newOwnerId })
  },

  /**
   * Assign any role name to a group member. Needs the group's 'manage' power, and
   * every power of the role given and of the role taken away (never above your own).
   * Role names: lowercase letters, digits, hyphen, underscore; start with a letter; max
   * 32 chars. 'owner' is reserved (only createGroup makes owners). Owners cannot be
   * re-assigned via this API.
   *
   * Role names alone do NOT grant powers. Give a role its powers with setRolePowers
   * (read / write / manage), or all three with setAdminRoles.
   *
   * @param {string} groupId
   * @param {string} userId
   * @param {string} role  Lowercase, alphanumeric + hyphen/underscore, 1-32 chars.
   * @example await social.setRole(groupId, userId, 'accountant')
   */
  async setRole(groupId, userId, role) {
    return socialAction('setRole', { groupId, targetId: userId, role })
  },

  /**
   * Configure which custom role names count as admin-equivalent in this group.
   * Owner-only. The role names 'admin' and 'owner' are always admin-equivalent and
   * cannot be listed here; 'member' is never admin and cannot be listed either.
   *
   * Setting [] (or never calling this) keeps the group at the default — only 'admin'
   * and 'owner' have admin powers.
   *
   * @param {string} groupId
   * @param {string[]} roles  Custom role names to grant admin-equivalence.
   * @example await social.setAdminRoles(groupId, ['accountant'])
   */
  async setAdminRoles(groupId, roles) {
    return socialAction('setAdminRoles', { groupId, roles })
  },

  /**
   * Read the current admin_roles config for a group.
   * @param {string} groupId
   * @returns {Promise<string[]>}
   * @example const adminRoles = await social.getAdminRoles(groupId)
   */
  async getAdminRoles(groupId) {
    const data = await socialAction('getAdminRoles', { groupId })
    return data.adminRoles || []
  },
}
