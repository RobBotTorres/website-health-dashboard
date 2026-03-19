// ============================================================================
// CLOUDFLARE ACCESS JWT AUTHENTICATION
// Validates CF Access JWTs and manages user sessions.
// On first login, auto-creates user record in D1 with 14-day trial.
// ============================================================================

import { jwtVerify, createRemoteJWKSet } from 'jose';

/**
 * Validate the Cloudflare Access JWT and return the authenticated user.
 * Upserts the user into D1 on first login.
 *
 * @param {Request} request
 * @param {object} env - Worker environment bindings
 * @returns {{ userId: string, email: string } | null} user info, or null if invalid
 */
export async function authenticateRequest(request, env) {
  const token =
    request.headers.get('cf-access-jwt-assertion') ||
    getCookieValue(request, 'CF_Authorization');

  if (!token) {
    return null;
  }

  try {
    const payload = await verifyToken(token, env);
    if (!payload) return null;

    const userId = payload.sub;
    const email = payload.email;

    if (!userId || !email) return null;

    // Upsert user in D1 (creates on first login)
    if (env.DB) {
      await upsertUser(env.DB, userId, email);
    }

    return { userId, email };
  } catch (err) {
    console.error('CF Access auth error:', err.message);
    return null;
  }
}

/**
 * Verify JWT token against Cloudflare Access JWKS.
 * Caches the JWKS keyset URL creation (jose handles key caching internally).
 */
async function verifyToken(token, env) {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  if (!teamDomain) {
    console.error('CF_ACCESS_TEAM_DOMAIN not configured');
    return null;
  }

  const certsUrl = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const JWKS = createRemoteJWKSet(new URL(certsUrl));

  const verifyOptions = {};

  // If POLICY_AUD is set, validate the audience claim
  if (env.POLICY_AUD) {
    verifyOptions.audience = env.POLICY_AUD;
  }

  // Validate issuer matches team domain
  verifyOptions.issuer = `https://${teamDomain}.cloudflareaccess.com`;

  const { payload } = await jwtVerify(token, JWKS, verifyOptions);

  return payload;
}

/**
 * Upsert user record in D1.
 * Creates the user with a 14-day trial on first login.
 * Updates last-seen on subsequent logins.
 */
async function upsertUser(db, userId, email) {
  try {
    const existing = await db.prepare(
      'SELECT id FROM users WHERE id = ?'
    ).bind(userId).first();

    if (!existing) {
      // First login — create user with 7-day trial
      const trialEnds = new Date();
      trialEnds.setDate(trialEnds.getDate() + 7);
      const trialEndsStr = trialEnds.toISOString().split('T')[0];

      await db.prepare(
        `INSERT INTO users (id, email, plan, trial_ends_at)
         VALUES (?, ?, 'trial', ?)`
      ).bind(userId, email, trialEndsStr).run();
    } else {
      // Returning user — update timestamp
      await db.prepare(
        `UPDATE users SET updated_at = datetime('now') WHERE id = ?`
      ).bind(userId).run();
    }
  } catch (err) {
    // Log but don't fail auth — user can still proceed
    console.error('User upsert error:', err.message);
  }
}

/**
 * Extract a cookie value from the request.
 */
function getCookieValue(request, name) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.split('=');
    if (key.trim() === name) {
      return valueParts.join('=');
    }
  }
  return null;
}

/**
 * Return a 401 JSON response for unauthenticated requests.
 */
export function unauthorizedResponse(message = 'Authentication required') {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

/**
 * Get full user record from D1 (includes plan, trial info, etc.)
 */
export async function getUserRecord(db, userId) {
  return db.prepare(
    'SELECT * FROM users WHERE id = ?'
  ).bind(userId).first();
}
