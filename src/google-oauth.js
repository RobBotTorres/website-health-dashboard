// ============================================================================
// GOOGLE OAUTH 2.0
// Handles the OAuth consent flow for connecting Google (GA4 + Search Console).
// Users click "Connect Google" → redirected to Google → callback stores tokens.
// ============================================================================

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Scopes needed for GA4 + Search Console (read-only)
const SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly'
].join(' ');

/**
 * Build the Google OAuth consent URL.
 * @param {string} clientId
 * @param {string} redirectUri
 * @param {string} state - opaque state for CSRF protection
 * @returns {string} consent URL
 */
export function getGoogleAuthUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',    // Required to get a refresh token
    prompt: 'consent',         // Force consent to always get refresh_token
    state
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * @param {string} code - authorization code from Google callback
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} redirectUri
 * @returns {Promise<{ access_token: string, refresh_token: string, expires_in: number }>}
 */
export async function exchangeCodeForTokens(code, clientId, clientSecret, redirectUri) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }).toString()
  });

  const data = await response.json();

  if (!data.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,  // Only present on first authorization
    expires_in: data.expires_in,
    token_type: data.token_type
  };
}

/**
 * Refresh an access token using a stored refresh token.
 * @param {string} refreshToken
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {Promise<{ access_token: string, expires_in: number }>}
 */
export async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token'
    }).toString()
  });

  const data = await response.json();

  if (!data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }

  return {
    access_token: data.access_token,
    expires_in: data.expires_in
  };
}

// ============================================================================
// TOKEN ENCRYPTION
// Uses AES-GCM with a key derived from the ENCRYPTION_KEY secret.
// Stored format: base64(iv:ciphertext)
// ============================================================================

/**
 * Derive an AES-GCM CryptoKey from a hex-encoded secret.
 * @param {string} hexKey - 32-byte hex string (64 chars)
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(hexKey) {
  // Convert hex to raw bytes
  const keyBytes = new Uint8Array(
    hexKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16))
  );

  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a string using AES-GCM.
 * @param {string} plaintext
 * @param {string} encryptionKey - hex-encoded key
 * @returns {Promise<string>} base64-encoded "iv:ciphertext"
 */
export async function encryptToken(plaintext, encryptionKey) {
  const key = await deriveKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );

  // Combine IV + ciphertext, encode as base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a string encrypted with encryptToken.
 * @param {string} encrypted - base64-encoded "iv:ciphertext"
 * @param {string} encryptionKey - hex-encoded key
 * @returns {Promise<string>} decrypted plaintext
 */
export async function decryptToken(encrypted, encryptionKey) {
  const key = await deriveKey(encryptionKey);
  const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}

// ============================================================================
// OAUTH STATE MANAGEMENT
// ============================================================================

/**
 * Create and store an OAuth state parameter for CSRF protection.
 * @param {D1Database} db
 * @param {string} userId
 * @param {string} propertyId
 * @param {string} provider - 'google'
 * @param {string} redirectUri
 * @returns {Promise<string>} state token
 */
export async function createOAuthState(db, userId, propertyId, provider, redirectUri) {
  const state = crypto.randomUUID();

  await db.prepare(`
    INSERT INTO oauth_states (state, user_id, property_id, provider, redirect_uri)
    VALUES (?, ?, ?, ?, ?)
  `).bind(state, userId, propertyId, provider, redirectUri).run();

  return state;
}

/**
 * Validate and consume an OAuth state parameter.
 * @param {D1Database} db
 * @param {string} state
 * @returns {Promise<{ user_id: string, property_id: string, provider: string, redirect_uri: string }|null>}
 */
export async function consumeOAuthState(db, state) {
  const row = await db.prepare(
    'SELECT * FROM oauth_states WHERE state = ?'
  ).bind(state).first();

  if (!row) return null;

  // Check expiry — states are valid for 10 minutes
  const created = new Date(row.created_at);
  const now = new Date();
  if ((now - created) > 10 * 60 * 1000) {
    await db.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
    return null;
  }

  // Delete the state (one-time use)
  await db.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();

  return {
    user_id: row.user_id,
    property_id: row.property_id,
    provider: row.provider,
    redirect_uri: row.redirect_uri
  };
}

/**
 * Clean up expired OAuth states (older than 15 minutes).
 * @param {D1Database} db
 */
export async function cleanupExpiredStates(db) {
  await db.prepare(
    "DELETE FROM oauth_states WHERE created_at < datetime('now', '-15 minutes')"
  ).run();
}
