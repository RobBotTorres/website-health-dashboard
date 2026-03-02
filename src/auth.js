/**
 * Authenticate admin requests via Bearer token.
 * Returns null if authenticated, or a Response (401/403) if not.
 * If AUTH_TOKEN is not configured, auth is skipped (backward compatible).
 */
export function authenticate(request, env) {
  // If no AUTH_TOKEN configured, skip auth (backward compatible)
  if (!env.AUTH_TOKEN) {
    return null;
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' }
    });
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || token !== env.AUTH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return null;
}
