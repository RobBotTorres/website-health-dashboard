import { refreshAccessToken, decryptToken } from './google-oauth.js';

/**
 * Get a Google access token — dual path:
 *   1. OAuth (user-connected): decrypt refresh token → refresh for access token
 *   2. Service account (legacy): sign JWT → exchange for access token
 *
 * @param {string|object} credentialsJson - service account JSON, OR unused when useOAuth=true
 * @param {object} [opts] - optional overrides
 * @param {boolean} [opts.useOAuth] - if true, use OAuth refresh token flow
 * @param {string} [opts.encryptedRefreshToken] - encrypted refresh token from DB
 * @param {object} [opts.env] - Worker env bindings (for ENCRYPTION_KEY, GOOGLE_OAUTH_*)
 * @returns {Promise<string>} access token
 */
export async function getGoogleAccessToken(credentialsJson, opts = {}) {
  // ---- Path 1: OAuth refresh token ----
  if (opts.useOAuth && opts.encryptedRefreshToken && opts.env) {
    return getOAuthAccessToken(opts.encryptedRefreshToken, opts.env);
  }

  // ---- Path 2: Service account JWT (original flow) ----
  const creds = typeof credentialsJson === 'string' ? JSON.parse(credentialsJson) : credentialsJson;

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  };

  const jwt = await signJWT(header, payload, creds.private_key);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const data = await response.json();
  if (!data.access_token) throw new Error(`Google auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

/**
 * Get an access token using an encrypted OAuth refresh token.
 * Decrypts the stored refresh token, then exchanges it for a fresh access token.
 *
 * @param {string} encryptedRefreshToken - AES-GCM encrypted refresh token
 * @param {object} env - Worker env (needs ENCRYPTION_KEY, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET)
 * @returns {Promise<string>} access token
 */
export async function getOAuthAccessToken(encryptedRefreshToken, env) {
  if (!env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY not configured — cannot decrypt OAuth tokens');
  }
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('Google OAuth credentials not configured');
  }

  const refreshToken = await decryptToken(encryptedRefreshToken, env.ENCRYPTION_KEY);

  const result = await refreshAccessToken(
    refreshToken,
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET
  );

  return result.access_token;
}

async function signJWT(header, payload, privateKey) {
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signInput = `${headerB64}.${payloadB64}`;

  const pemContents = privateKey.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s/g, '');
  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey('pkcs8', binaryKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signInput));

  return `${signInput}.${base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)))}`;
}

function base64UrlEncode(str) {
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
