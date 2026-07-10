// ============================================================================
// MAGIC LINK AUTHENTICATION
// Passwordless email auth: user enters email → receives magic link → clicks
// to log in → session cookie set. Sessions stored in KV with 30-day TTL.
// ============================================================================

import { sendWelcomeEmail } from './emails.js';

const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const MAGIC_LINK_TTL_MINUTES = 15;

/**
 * Send a magic link email to the given address.
 * Creates a one-time token in D1, sends via Brevo API.
 *
 * @param {string} email
 * @param {object} env - Worker env bindings
 * @param {string} baseUrl - e.g. "https://shelobweb.com"
 * @param {boolean} [marketingOptIn=false] - consent chosen on the login form;
 *   parked on the magic_links row and carried to the user record on verify
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function sendMagicLink(email, env, baseUrl, marketingOptIn = false) {
  if (!env.BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY not configured');
  }

  // Normalize email
  email = email.toLowerCase().trim();

  // Basic email validation
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { success: false, error: 'Invalid email address' };
  }

  // Generate token
  const token = crypto.randomUUID() + '-' + crypto.randomUUID();

  // Calculate expiry
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000);

  // Store in D1
  await env.DB.prepare(
    'INSERT INTO magic_links (id, email, expires_at, marketing_opt_in) VALUES (?, ?, ?, ?)'
  ).bind(token, email, expiresAt.toISOString(), marketingOptIn ? 1 : 0).run();

  // Build magic link URL
  const magicLink = `${baseUrl}/api/auth/verify?token=${token}`;

  // Send email via Brevo (formerly Sendinblue)
  const senderEmail = env.EMAIL_FROM || 'noreply@shelobweb.com';
  const senderName = env.EMAIL_FROM_NAME || 'Shelob Web';

  const emailResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: [{ email: email }],
      subject: 'Your Shelob Web Login Link',
      htmlContent: buildMagicLinkEmail(magicLink, MAGIC_LINK_TTL_MINUTES)
    })
  });

  if (!emailResponse.ok) {
    const err = await emailResponse.text();
    console.error('Brevo API error:', err);
    return { success: false, error: 'Failed to send email. Please try again.' };
  }

  // Clean up expired tokens (fire-and-forget)
  env.DB.prepare(
    "DELETE FROM magic_links WHERE expires_at < datetime('now') OR (used = 1 AND created_at < datetime('now', '-1 hour'))"
  ).run().catch(() => {});

  return { success: true };
}

/**
 * Verify a magic link token.
 * Validates the token, marks it used, upserts the user, and creates a session.
 * Fires the welcome email on first account creation.
 *
 * @param {string} token
 * @param {object} env
 * @param {string} [baseUrl] - origin used to build links in the welcome email
 * @returns {Promise<{success: boolean, sessionId?: string, error?: string}>}
 */
export async function verifyMagicLink(token, env, baseUrl) {
  // Look up token
  const row = await env.DB.prepare(
    'SELECT * FROM magic_links WHERE id = ?'
  ).bind(token).first();

  if (!row) {
    return { success: false, error: 'Invalid or expired link. Please request a new one.' };
  }

  // Check if already used
  if (row.used) {
    return { success: false, error: 'This link has already been used. Please request a new one.' };
  }

  // Check expiry
  if (new Date(row.expires_at) < new Date()) {
    await env.DB.prepare('DELETE FROM magic_links WHERE id = ?').bind(token).run();
    return { success: false, error: 'This link has expired. Please request a new one.' };
  }

  // Mark as used
  await env.DB.prepare(
    'UPDATE magic_links SET used = 1 WHERE id = ?'
  ).bind(token).run();

  const email = row.email;

  // Upsert user, carrying the consent choice made when the link was requested
  const { userId, isNew } = await upsertUser(env.DB, email, row.marketing_opt_in === 1);

  // Welcome email is transactional onboarding — first login only, never blocking
  if (isNew && baseUrl) {
    sendWelcomeEmail(email, env, baseUrl).catch(e =>
      console.error('Welcome email failed:', e.message)
    );
  }

  // Create session
  const sessionId = await createSession(userId, email, env);

  return { success: true, sessionId };
}

/**
 * Create a new session in KV.
 *
 * @param {string} userId
 * @param {string} email
 * @param {object} env
 * @returns {Promise<string>} session ID
 */
export async function createSession(userId, email, env) {
  const sessionId = crypto.randomUUID() + '-' + crypto.randomUUID();

  await env.SEO_AUDITS.put(
    `session:${sessionId}`,
    JSON.stringify({ userId, email, createdAt: new Date().toISOString() }),
    { expirationTtl: SESSION_TTL }
  );

  return sessionId;
}

/**
 * Authenticate a request by reading the session cookie.
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<{userId: string, email: string} | null>}
 */
export async function authenticateRequest(request, env) {
  const sessionId = getCookieValue(request, 'session');
  if (!sessionId) return null;

  const sessionData = await env.SEO_AUDITS.get(`session:${sessionId}`, 'json');
  if (!sessionData) return null;

  return { userId: sessionData.userId, email: sessionData.email };
}

/**
 * Destroy a session (logout).
 *
 * @param {Request} request
 * @param {object} env
 */
export async function destroySession(request, env) {
  const sessionId = getCookieValue(request, 'session');
  if (sessionId) {
    await env.SEO_AUDITS.delete(`session:${sessionId}`);
  }
}

/**
 * Upsert user in D1. Creates with a 7-day trial on first login.
 *
 * Consent is upgrade-only for returning users: checking the box grants consent,
 * but leaving it unchecked never revokes it. Unsubscribe is the only opt-out
 * path, so a default-unchecked form can't silently strip an existing consent.
 *
 * @param {D1Database} db
 * @param {string} email
 * @param {boolean} [marketingOptIn=false]
 * @returns {Promise<{userId: string, isNew: boolean}>}
 */
async function upsertUser(db, email, marketingOptIn = false) {
  // Check if user exists by email
  const existing = await db.prepare(
    'SELECT id FROM users WHERE email = ?'
  ).bind(email).first();

  if (existing) {
    if (marketingOptIn) {
      await db.prepare(
        `UPDATE users SET updated_at = datetime('now'),
           marketing_opt_in = 1,
           marketing_opt_in_at = COALESCE(marketing_opt_in_at, ?)
         WHERE id = ?`
      ).bind(new Date().toISOString(), existing.id).run();
    } else {
      await db.prepare(
        "UPDATE users SET updated_at = datetime('now') WHERE id = ?"
      ).bind(existing.id).run();
    }
    return { userId: existing.id, isNew: false };
  }

  // Create new user with 7-day trial
  const userId = crypto.randomUUID();
  const trialEnds = new Date();
  trialEnds.setDate(trialEnds.getDate() + 7);

  await db.prepare(
    `INSERT INTO users (id, email, plan, trial_ends_at, marketing_opt_in, marketing_opt_in_at)
     VALUES (?, ?, 'trial', ?, ?, ?)`
  ).bind(
    userId,
    email,
    trialEnds.toISOString().split('T')[0],
    marketingOptIn ? 1 : 0,
    marketingOptIn ? new Date().toISOString() : null
  ).run();

  return { userId, isNew: true };
}

/**
 * Build the session cookie header value.
 *
 * @param {string} sessionId
 * @param {boolean} [clear=false] - if true, sets an expired cookie to clear it
 * @returns {string} Set-Cookie header value
 */
export function buildSessionCookie(sessionId, clear = false) {
  if (clear) {
    return 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
  }
  return `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`;
}

/**
 * Get full user record from D1 (includes plan, trial info, etc.)
 */
export async function getUserRecord(db, userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
}

// ---- Helpers ----

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

function buildMagicLinkEmail(magicLink, ttlMinutes) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 20px">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#1a1d2e;border-radius:12px;overflow:hidden">
        <tr><td style="padding:32px 32px 24px;text-align:center">
          <div style="font-size:28px;margin-bottom:8px">&#9889;</div>
          <h1 style="color:#fff;font-size:22px;margin:0 0 8px">Sign in to Shelob Web</h1>
          <p style="color:#94a3b8;font-size:14px;margin:0;line-height:1.5">Click the button below to sign in to your dashboard. This link expires in ${ttlMinutes} minutes.</p>
        </td></tr>
        <tr><td style="padding:0 32px 24px;text-align:center">
          <a href="${magicLink}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600">Sign In to Dashboard</a>
        </td></tr>
        <tr><td style="padding:0 32px 24px;text-align:center">
          <p style="color:#64748b;font-size:12px;margin:0;line-height:1.5">If you didn't request this link, you can safely ignore this email.</p>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #2a2d3e;text-align:center">
          <p style="color:#475569;font-size:11px;margin:0">Shelob Web &mdash; Website Monitoring Dashboard</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
