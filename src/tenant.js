// ============================================================================
// TENANT RESOLUTION
// Replaces hardcoded PROPERTIES / getCredentials from config.js.
// All property and credential lookups now go through D1.
// ============================================================================

/**
 * Resolve effective user for team access.
 * If the user is a team member, returns the owner's userId so all queries use the owner's data.
 * @param {string} userId - the actual logged-in user ID
 * @param {D1Database} db
 * @returns {Promise<object>} { effectiveUserId, role, isTeamMember, actualUserId, ownerEmail }
 */
export async function resolveEffectiveUser(userId, db) {
  // Check if user is a member of someone's team
  const membership = await db.prepare(`
    SELECT tm.owner_user_id, tm.role, u.email as owner_email
    FROM team_members tm
    LEFT JOIN users u ON u.id = tm.owner_user_id
    WHERE tm.member_user_id = ? AND tm.accepted_at IS NOT NULL
    LIMIT 1
  `).bind(userId).first();

  if (membership) {
    return {
      effectiveUserId: membership.owner_user_id,
      role: membership.role || 'member',
      isTeamMember: true,
      actualUserId: userId,
      ownerEmail: membership.owner_email
    };
  }

  // User is not a team member — they're an admin of their own account
  return {
    effectiveUserId: userId,
    role: 'admin',
    isTeamMember: false,
    actualUserId: userId,
    ownerEmail: null
  };
}

/**
 * Get all properties for a user (or their team owner).
 * @param {string} userId
 * @param {D1Database} db
 * @returns {Promise<Array>} list of property rows
 */
export async function getUserProperties(userId, db) {
  const { results } = await db.prepare(
    'SELECT * FROM properties WHERE user_id = ? ORDER BY created_at ASC'
  ).bind(userId).all();
  return results || [];
}

/**
 * Get a single property by ID, scoped to a user.
 * @param {string} userId
 * @param {string} propertyId
 * @param {D1Database} db
 * @returns {Promise<object|null>}
 */
export async function getProperty(userId, propertyId, db) {
  return db.prepare(
    'SELECT * FROM properties WHERE id = ? AND user_id = ?'
  ).bind(propertyId, userId).first();
}

/**
 * Find a user's property by domain.
 * @param {string} userId
 * @param {string} domain
 * @param {D1Database} db
 * @returns {Promise<object|null>}
 */
export async function getPropertyByDomain(userId, domain, db) {
  return db.prepare(
    'SELECT * FROM properties WHERE user_id = ? AND domain = ?'
  ).bind(userId, domain).first();
}

/**
 * Validate that a user has access to a given property.
 * Checks direct ownership first, then team membership.
 * @param {string} userId
 * @param {string} propertyId
 * @param {D1Database} db
 * @returns {Promise<object|null>}
 */
export async function validatePropertyAccess(userId, propertyId, db) {
  // Check direct ownership
  const direct = await getProperty(userId, propertyId, db);
  if (direct) return direct;

  // Check team membership — member can access owner's properties
  const membership = await db.prepare(`
    SELECT owner_user_id FROM team_members
    WHERE member_user_id = ? AND accepted_at IS NOT NULL
  `).bind(userId).first();

  if (membership) {
    return getProperty(membership.owner_user_id, propertyId, db);
  }

  return null;
}

/**
 * Build credentials object for a property (for API integrations).
 * Pulls from DB row instead of environment variables.
 * Falls back to env vars for backward compatibility during migration.
 *
 * @param {object} property - property row from D1
 * @param {object} env - Worker environment bindings
 * @returns {object} credentials object matching the existing creds shape
 */
export function getPropertyCredentials(property, env) {
  const cfZoneIds = property.cf_zone_ids
    ? property.cf_zone_ids.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const gscProperties = property.gsc_properties
    ? property.gsc_properties.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  return {
    cloudflare: {
      // User's own CF token if provided, otherwise fall back to system token
      apiToken: property.cf_api_token_encrypted || env.CLOUDFLARE_API_TOKEN,
      zoneIds: cfZoneIds
    },
    searchConsole: {
      properties: gscProperties,
      // OAuth refresh token if connected, otherwise fall back to service account
      credentials: property.google_refresh_token_encrypted || env.GOOGLE_SERVICE_ACCOUNT,
      useOAuth: !!property.google_refresh_token_encrypted,
      env: !!property.google_refresh_token_encrypted ? env : undefined
    },
    ga4: {
      propertyId: property.ga4_property_id,
      credentials: property.google_refresh_token_encrypted || env.GOOGLE_SERVICE_ACCOUNT,
      useOAuth: !!property.google_refresh_token_encrypted,
      env: !!property.google_refresh_token_encrypted ? env : undefined
    }
  };
}

/**
 * Create a new property for a user.
 * @param {string} userId
 * @param {{ name: string, domain: string, color?: string }} data
 * @param {D1Database} db
 * @returns {Promise<object>} the created property
 */
export async function createProperty(userId, data, db) {
  const id = crypto.randomUUID();
  const color = data.color || generateColor(data.domain);

  await db.prepare(
    `INSERT INTO properties (id, user_id, name, domain, color)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(id, userId, data.name, normalizeDomain(data.domain), color).run();

  return db.prepare('SELECT * FROM properties WHERE id = ?').bind(id).first();
}

/**
 * Delete a property and all associated data.
 * @param {string} userId
 * @param {string} propertyId
 * @param {D1Database} db
 * @returns {Promise<boolean>} true if deleted
 */
export async function deleteProperty(userId, propertyId, db) {
  // Verify ownership first
  const property = await validatePropertyAccess(userId, propertyId, db);
  if (!property) return false;

  const domain = property.domain;

  // Delete associated data in all tables
  const deletes = [
    db.prepare('DELETE FROM audits WHERE domain = ? AND user_id = ?').bind(domain, userId),
    db.prepare('DELETE FROM issues WHERE domain = ? AND user_id = ?').bind(domain, userId),
    db.prepare('DELETE FROM broken_links WHERE domain = ? AND user_id = ?').bind(domain, userId),
    db.prepare('DELETE FROM accessibility_issues WHERE domain = ? AND user_id = ?').bind(domain, userId),
    db.prepare('DELETE FROM keywords WHERE domain = ? AND user_id = ?').bind(domain, userId),
    db.prepare('DELETE FROM performance_snapshots WHERE domain = ? AND user_id = ?').bind(domain, userId),
    db.prepare('DELETE FROM performance_history WHERE domain = ? AND user_id = ?').bind(domain, userId),
    db.prepare('DELETE FROM properties WHERE id = ? AND user_id = ?').bind(propertyId, userId)
  ];

  await db.batch(deletes);
  return true;
}

/**
 * Update a property's integration settings.
 * @param {string} userId
 * @param {string} propertyId
 * @param {object} updates - fields to update
 * @param {D1Database} db
 */
export async function updateProperty(userId, propertyId, updates, db) {
  const property = await validatePropertyAccess(userId, propertyId, db);
  if (!property) return null;

  const allowedFields = [
    'name', 'color', 'cf_zone_ids', 'cf_api_token_encrypted',
    'google_refresh_token_encrypted', 'ga4_property_id', 'gsc_properties'
  ];

  const setClauses = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (setClauses.length === 0) return property;

  values.push(propertyId, userId);
  await db.prepare(
    `UPDATE properties SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?`
  ).bind(...values).run();

  return db.prepare('SELECT * FROM properties WHERE id = ?').bind(propertyId).first();
}

/**
 * Count how many properties a user has.
 */
export async function getPropertyCount(userId, db) {
  const row = await db.prepare(
    'SELECT COUNT(*) as count FROM properties WHERE user_id = ?'
  ).bind(userId).first();
  return row?.count || 0;
}

/**
 * Get the site limit for a plan.
 */
export function getPlanLimit(plan) {
  const limits = {
    trial: 1,
    pro: 5,
    agency: 25
  };
  return limits[plan] || 0;
}

/**
 * Check if user can add more properties.
 * @returns {{ allowed: boolean, current: number, limit: number }}
 */
export async function checkPlanLimits(userId, plan, db) {
  const current = await getPropertyCount(userId, db);
  const limit = getPlanLimit(plan);
  return {
    allowed: current < limit,
    current,
    limit
  };
}

// ---- Helpers ----

/**
 * Normalize a domain: strip protocol, www, trailing slash.
 */
function normalizeDomain(input) {
  let domain = input.toLowerCase().trim();
  domain = domain.replace(/^https?:\/\//, '');
  domain = domain.replace(/^www\./, '');
  domain = domain.replace(/\/+$/, '');
  return domain;
}

/**
 * Generate a pleasant color from a domain string.
 */
function generateColor(domain) {
  const colors = [
    '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e',
    '#f97316', '#eab308', '#22c55e', '#14b8a6',
    '#06b6d4', '#3b82f6', '#6d28d9', '#059669'
  ];
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = ((hash << 5) - hash) + domain.charCodeAt(i);
    hash |= 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

// ============================================================================
// TEAM MANAGEMENT
// ============================================================================

/**
 * List team members for an owner.
 */
export async function getTeamMembers(ownerUserId, db) {
  const { results } = await db.prepare(`
    SELECT tm.*, u.email as actual_email
    FROM team_members tm
    LEFT JOIN users u ON u.id = tm.member_user_id
    WHERE tm.owner_user_id = ?
    ORDER BY tm.invited_at ASC
  `).bind(ownerUserId).all();
  return results || [];
}

/**
 * Invite a team member by email.
 */
export async function inviteTeamMember(ownerUserId, memberEmail, db) {
  // Check if already invited
  const existing = await db.prepare(
    'SELECT id FROM team_members WHERE owner_user_id = ? AND member_email = ?'
  ).bind(ownerUserId, memberEmail).first();

  if (existing) {
    throw new Error('This email has already been invited');
  }

  // Generate invite token
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

  // Check if the invitee already has an account
  const existingUser = await db.prepare(
    'SELECT id FROM users WHERE email = ?'
  ).bind(memberEmail.toLowerCase()).first();

  await db.prepare(`
    INSERT INTO team_members (owner_user_id, member_user_id, member_email, role, invite_token, invite_expires_at)
    VALUES (?, ?, ?, 'member', ?, ?)
  `).bind(ownerUserId, existingUser?.id || null, memberEmail.toLowerCase(), token, expiresAt).run();

  return { token, expiresAt, alreadyHasAccount: !!existingUser };
}

/**
 * Accept a team invite via token.
 */
export async function acceptTeamInvite(token, userId, userEmail, db) {
  const invite = await db.prepare(
    'SELECT * FROM team_members WHERE invite_token = ?'
  ).bind(token).first();

  if (!invite) {
    throw new Error('Invalid invite token');
  }

  if (invite.invite_expires_at && new Date(invite.invite_expires_at) < new Date()) {
    throw new Error('Invite has expired');
  }

  if (invite.accepted_at) {
    throw new Error('Invite has already been accepted');
  }

  // Cannot invite yourself
  if (invite.owner_user_id === userId) {
    throw new Error('You cannot join your own team');
  }

  await db.prepare(`
    UPDATE team_members
    SET member_user_id = ?, accepted_at = datetime('now'), invite_token = NULL
    WHERE id = ?
  `).bind(userId, invite.id).run();

  return invite;
}

/**
 * Remove a team member.
 */
export async function removeTeamMember(ownerUserId, memberId, db) {
  const result = await db.prepare(
    'DELETE FROM team_members WHERE id = ? AND owner_user_id = ?'
  ).bind(memberId, ownerUserId).run();

  return result.meta?.changes > 0;
}
