// ============================================================================
// WEBSITE HEALTH DASHBOARD - ROUTER
// Full self-service SaaS: marketing page, magic link auth, dashboard, and API.
// Includes daily cron job for scheduled SEO audits across all tenants.
// ============================================================================

import DASHBOARD_HTML from './dashboard.html';
import MARKETING_HTML from './marketing.html';
import LOGIN_HTML from './login.html';
import POLICIES_HTML from './policies.html';
import HELP_HTML from './help.html';
import {
  authenticateRequest,
  sendMagicLink,
  verifyMagicLink,
  destroySession,
  buildSessionCookie,
  getUserRecord
} from './auth.js';
import { getDateRange } from './utils.js';
import { cloudflareGraphQL } from './cloudflare-api.js';
import { runScheduledAudit, runFullSitemapAudit } from './audit.js';
import {
  getGoogleAuthUrl,
  exchangeCodeForTokens,
  encryptToken,
  createOAuthState,
  consumeOAuthState,
  cleanupExpiredStates
} from './google-oauth.js';
import {
  getUserProperties,
  getPropertyByDomain,
  validatePropertyAccess,
  getPropertyCredentials,
  createProperty,
  deleteProperty,
  updateProperty,
  checkPlanLimits,
  resolveEffectiveUser,
  getTeamMembers,
  inviteTeamMember,
  acceptTeamInvite,
  removeTeamMember
} from './tenant.js';
import {
  handleAPI,
  handleSiteHealth,
  handleCoreWebVitals,
  handlePerformance,
  handleSEOStats,
  handleAccessibility,
  handleKeywords,
  handle404Errors,
  handlePerformanceHistory,
  handleAllFixedIssues,
  storePerformanceSnapshot,
  fetchCloudflareData,
  fetchSearchConsoleData,
  handleIssueStatus
} from './handlers.js';
import { runQuickAudit } from './quick-audit.js';
import {
  createCheckoutSession,
  createPortalSession,
  handleStripeWebhook,
  getBillingStatus
} from './stripe.js';

// CORS headers applied to all responses
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders }
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS, ...extraHeaders }
  });
}

/**
 * Replace "Sign In" nav link with "Dashboard" when user is authenticated.
 * Works by finding the Sign In button in the nav and swapping it.
 */
function swapNavForAuth(html, user) {
  if (!user) return html;
  // Replace Sign In button (primary) → Dashboard
  html = html.replace(
    /<a href="\/login" class="btn btn-primary">Sign In<\/a>/g,
    '<a href="/dashboard" class="btn btn-primary">Dashboard</a>'
  );
  // Replace "Get Started Free" → "Go to Dashboard" on marketing page
  html = html.replace(
    /<a href="\/login" class="btn btn-primary">Get Started Free <svg/g,
    '<a href="/dashboard" class="btn btn-primary">Go to Dashboard <svg'
  );
  // Replace outline Sign In button → Dashboard
  html = html.replace(
    /<a href="\/login" class="btn btn-outline">Sign In<\/a>/g,
    '<a href="/dashboard" class="btn btn-outline">Dashboard</a>'
  );
  // Replace footer Sign In links
  html = html.replace(
    /<a href="\/login">Sign In<\/a>/g,
    '<a href="/dashboard">Dashboard</a>'
  );
  // Replace hero CTA "Get Started Free" links
  html = html.replace(
    />Get Started Free<\/a>/g,
    '>Go to Dashboard</a>'
  );
  // Replace "Start Free Trial" links
  html = html.replace(
    /<a href="\/login" class="btn btn-outline">Start Free Trial<\/a>/g,
    '<a href="/dashboard" class="btn btn-outline">Go to Dashboard</a>'
  );
  return html;
}

function extractPathParam(pathname, basePath) {
  if (!pathname.startsWith(basePath)) return null;
  const remaining = pathname.slice(basePath.length);
  const segments = remaining.split('/').filter(Boolean);
  return segments[0] || null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- CORS preflight ----
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ================================================================
    // PUBLIC PAGES (no auth required)
    // ================================================================

    // Marketing landing page
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const user = await authenticateRequest(request, env).catch(() => null);
      return htmlResponse(swapNavForAuth(MARKETING_HTML, user));
    }

    // Policies page
    if (url.pathname === '/policies') {
      const user = await authenticateRequest(request, env).catch(() => null);
      return htmlResponse(swapNavForAuth(POLICIES_HTML, user));
    }

    // Help page
    if (url.pathname === '/help') {
      const user = await authenticateRequest(request, env).catch(() => null);
      return htmlResponse(swapNavForAuth(HELP_HTML, user));
    }

    // Sitemap
    if (url.pathname === '/sitemap.xml') {
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://shelobweb.com/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>https://shelobweb.com/login</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>
  <url><loc>https://shelobweb.com/policies</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>
  <url><loc>https://shelobweb.com/help</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>
</urlset>`;
      return new Response(sitemap, {
        headers: { 'Content-Type': 'application/xml', ...CORS_HEADERS }
      });
    }

    // Robots.txt
    if (url.pathname === '/robots.txt') {
      const robots = `User-agent: *
Allow: /
Allow: /policies
Allow: /help
Disallow: /dashboard
Disallow: /api/

Sitemap: https://shelobweb.com/sitemap.xml`;
      return new Response(robots, {
        headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS }
      });
    }

    // Login page
    if (url.pathname === '/login') {
      // If already logged in, redirect to dashboard
      const user = await authenticateRequest(request, env);
      if (user) {
        return Response.redirect(url.origin + '/dashboard', 302);
      }
      return htmlResponse(LOGIN_HTML);
    }

    // ================================================================
    // PUBLIC API ROUTES (no auth required)
    // ================================================================

    // Magic link: send login email
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      return handleAuthLogin(request, env, url);
    }

    // Magic link: verify token and create session
    if (url.pathname === '/api/auth/verify') {
      return handleAuthVerify(url, env);
    }

    // Logout
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      return handleAuthLogout(request, env, url);
    }

    // Accept team invite (public — token identifies the invite)
    if (url.pathname === '/api/team/accept') {
      return handleTeamAcceptInvite(url, request, env);
    }

    // Stripe webhooks (verified by signature, not session)
    if (url.pathname === '/api/webhooks/stripe' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }

    // Google OAuth callback (state param identifies the user)
    if (url.pathname === '/api/oauth/google/callback') {
      return handleGoogleOAuthCallback(url, env);
    }

    // ================================================================
    // AUTHENTICATED: Dashboard page
    // ================================================================

    if (url.pathname === '/dashboard' || url.pathname === '/dashboard/') {
      const user = await authenticateRequest(request, env);

      // Dev mode fallback
      if (!user && !env.BREVO_API_KEY) {
        return htmlResponse(DASHBOARD_HTML);
      }

      if (!user) {
        return Response.redirect(url.origin + '/login', 302);
      }
      return htmlResponse(DASHBOARD_HTML);
    }

    // ================================================================
    // AUTHENTICATED: API routes
    // ================================================================

    if (url.pathname.startsWith('/api/')) {
      const user = await authenticateRequest(request, env);

      // Dev mode fallback: if no auth service configured, use dev user
      if (!user && !env.BREVO_API_KEY) {
        const devUser = { userId: 'dev-user', email: 'dev@localhost' };
        if (env.DB) {
          const existing = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(devUser.userId).first();
          if (!existing) {
            const trialEnds = new Date();
            trialEnds.setDate(trialEnds.getDate() + 7);
            await env.DB.prepare(
              `INSERT INTO users (id, email, plan, trial_ends_at) VALUES (?, ?, 'trial', ?)`
            ).bind(devUser.userId, devUser.email, trialEnds.toISOString().split('T')[0]).run();
          }
        }
        return routeAuthenticated(url, request, env, devUser);
      }

      if (!user) {
        return jsonResponse({ error: 'Authentication required' }, 401);
      }

      return routeAuthenticated(url, request, env, user);
    }

    // ================================================================
    // FALLBACK: redirect unknown paths to marketing
    // ================================================================
    return Response.redirect(url.origin + '/', 302);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledAudit(env));
  }
};

// ============================================================================
// AUTH HANDLERS
// ============================================================================

/**
 * POST /api/auth/login — Send magic link email
 */
async function handleAuthLogin(request, env, url) {
  try {
    const body = await request.json();
    const email = body.email;

    if (!email) {
      return errorResponse('Email is required');
    }

    const result = await sendMagicLink(email, env, url.origin);

    if (!result.success) {
      return jsonResponse({ success: false, error: result.error }, 400);
    }

    return jsonResponse({ success: true, message: 'Magic link sent! Check your email.' });
  } catch (err) {
    console.error('Auth login error:', err);
    return errorResponse(err.message || 'Failed to send login email', 500);
  }
}

/**
 * GET /api/auth/verify?token=X — Verify magic link, create session, redirect
 */
async function handleAuthVerify(url, env) {
  const token = url.searchParams.get('token');
  if (!token) {
    return htmlResponse(authResultPage('Invalid link. No token provided.', 'error'), 400);
  }

  const result = await verifyMagicLink(token, env);

  if (!result.success) {
    return htmlResponse(authResultPage(result.error, 'error'), 400);
  }

  // Set session cookie and redirect to dashboard
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/dashboard',
      'Set-Cookie': buildSessionCookie(result.sessionId)
    }
  });
}

/**
 * POST /api/auth/logout — Destroy session, clear cookie
 */
async function handleAuthLogout(request, env, url) {
  await destroySession(request, env);

  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': buildSessionCookie('', true)
    }
  });
}

/**
 * Build a simple HTML page for auth results (errors, etc.)
 */
function authResultPage(message, type) {
  const color = type === 'success' ? '#22c55e' : '#ef4444';
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Sign In</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1117;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1a1d2e;border-radius:12px;padding:32px;text-align:center;max-width:400px;border:1px solid #2a2d3e}
.msg{margin-bottom:24px;color:#94a3b8;line-height:1.5}
.icon{font-size:48px;margin-bottom:16px;color:${color}}
a{color:#6366f1;text-decoration:none;font-weight:600}</style></head>
<body><div class="card"><div class="icon">${type === 'success' ? '✓' : '✕'}</div><p class="msg">${message}</p><a href="/login">Try Again</a></div></body></html>`;
}

// ============================================================================
// AUTHENTICATED ROUTES
// ============================================================================

async function routeAuthenticated(url, request, env, user) {
  try {
    // Resolve effective user (team member sees owner's data)
    if (env.DB) {
      const resolved = await resolveEffectiveUser(user.userId, env.DB);
      user.effectiveUserId = resolved.effectiveUserId;
      user.role = resolved.role;
      user.isTeamMember = resolved.isTeamMember;
      user.actualUserId = resolved.actualUserId;
      user.ownerEmail = resolved.ownerEmail;
    } else {
      user.effectiveUserId = user.userId;
      user.role = 'admin';
      user.isTeamMember = false;
    }

    // ---- User & Account ----
    if (url.pathname === '/api/me') {
      return handleMe(env, user);
    }

    // ---- Property CRUD ----
    if (url.pathname === '/api/properties' && request.method === 'GET') {
      return handleListProperties(env, user);
    }

    if (url.pathname === '/api/properties' && request.method === 'POST') {
      if (user.role !== 'admin') return errorResponse('Only admins can add websites', 403);
      return handleCreatePropertyRoute(request, env, user);
    }

    if (url.pathname.startsWith('/api/properties/') && request.method === 'DELETE') {
      if (user.role !== 'admin') return errorResponse('Only admins can remove websites', 403);
      const propertyId = extractPathParam(url.pathname, '/api/properties/');
      if (!propertyId) return errorResponse('Missing property ID');
      return handleDeleteProperty(propertyId, env, user);
    }

    if (url.pathname.startsWith('/api/properties/') && request.method === 'PUT') {
      const propertyId = extractPathParam(url.pathname, '/api/properties/');
      if (!propertyId) return errorResponse('Missing property ID');
      return handleUpdatePropertyRoute(propertyId, request, env, user);
    }

    // POST /api/properties/:id/audit
    if (url.pathname.match(/^\/api\/properties\/[^/]+\/audit$/) && request.method === 'POST') {
      const propertyId = extractPathParam(url.pathname, '/api/properties/');
      return handleTriggerPropertyAudit(propertyId, env, user);
    }

    // ---- Integration endpoints ----

    // PUT /api/properties/:id/integrations/cloudflare
    if (url.pathname.match(/^\/api\/properties\/[^/]+\/integrations\/cloudflare$/) && request.method === 'PUT') {
      const propertyId = extractPathParam(url.pathname, '/api/properties/');
      return handleUpdateCFIntegration(propertyId, request, env, user);
    }

    // POST /api/properties/:id/integrations/cloudflare/test
    if (url.pathname.match(/^\/api\/properties\/[^/]+\/integrations\/cloudflare\/test$/) && request.method === 'POST') {
      const propertyId = extractPathParam(url.pathname, '/api/properties/');
      return handleTestCFIntegration(propertyId, env, user);
    }

    // PUT /api/properties/:id/integrations/google
    if (url.pathname.match(/^\/api\/properties\/[^/]+\/integrations\/google$/) && request.method === 'PUT') {
      const propertyId = extractPathParam(url.pathname, '/api/properties/');
      return handleUpdateGoogleIntegration(propertyId, request, env, user);
    }

    // ---- Billing endpoints ----
    if (url.pathname === '/api/billing/status' && request.method === 'GET') {
      return handleBillingStatus(env, user);
    }

    if (url.pathname === '/api/billing/checkout' && request.method === 'POST') {
      return handleBillingCheckout(request, env, user, url);
    }

    if (url.pathname === '/api/billing/portal' && request.method === 'POST') {
      return handleBillingPortal(env, user, url);
    }

    // ---- Team management ----
    if (url.pathname === '/api/team' && request.method === 'GET') {
      return handleTeamList(env, user);
    }

    if (url.pathname === '/api/team/invite' && request.method === 'POST') {
      if (user.role !== 'admin') return errorResponse('Only admins can invite team members', 403);
      return handleTeamInvite(request, env, user);
    }

    if (url.pathname.match(/^\/api\/team\/\d+$/) && request.method === 'DELETE') {
      if (user.role !== 'admin') return errorResponse('Only admins can remove team members', 403);
      const memberId = parseInt(url.pathname.split('/')[3]);
      return handleTeamRemove(memberId, env, user);
    }

    // ---- Issue status (mark complete / reopen) ----
    if (url.pathname.match(/^\/api\/issues\/\d+\/status$/) && request.method === 'POST') {
      const issueId = parseInt(url.pathname.split('/')[3]);
      return handleIssueStatus(issueId, request, env, user);
    }

    // ---- Data endpoints ----
    if (url.pathname === '/api/data') return handleAPI(request, env, user);
    if (url.pathname === '/api/site-health') return handleSiteHealth(request, env, user);
    if (url.pathname === '/api/core-web-vitals') return handleCoreWebVitals(request, env, user);
    if (url.pathname === '/api/performance') return handlePerformance(request, env, user);

    if (url.pathname === '/api/seo-stats') {
      return handleSEOStats(url.searchParams.get('domain'), env, user);
    }

    if (url.pathname === '/api/accessibility') {
      return handleAccessibility(url.searchParams.get('domain'), env, user);
    }

    if (url.pathname === '/api/keywords') {
      return handleKeywords(url.searchParams.get('domain'), env, user);
    }

    if (url.pathname === '/api/404-errors') {
      return handle404Errors(url.searchParams.get('property'), env, user);
    }

    if (url.pathname === '/api/performance-history') return handlePerformanceHistory(env, user);
    if (url.pathname === '/api/all-fixed-issues') return handleAllFixedIssues(env, user);

    if (url.pathname === '/api/cloudflare') {
      const propertyId = url.searchParams.get('property');
      if (!propertyId) return errorResponse('Missing property parameter');
      try {
        const data = await fetchCloudflareData(propertyId, env, user);
        return jsonResponse(data, 200, { 'Cache-Control': 'public, max-age=300' });
      } catch (e) {
        return errorResponse(e.message, 500);
      }
    }

    if (url.pathname === '/api/search-console') {
      const propertyId = url.searchParams.get('property');
      if (!propertyId) return errorResponse('Missing property parameter');
      try {
        const data = await fetchSearchConsoleData(propertyId, env, user);
        return jsonResponse(data, 200, { 'Cache-Control': 'public, max-age=300' });
      } catch (e) {
        return errorResponse(e.message, 500);
      }
    }

    // ---- Google OAuth ----
    if (url.pathname === '/api/oauth/google/start' && request.method === 'GET') {
      return handleGoogleOAuthStart(url, env, user);
    }

    if (url.pathname === '/api/oauth/google/disconnect' && request.method === 'POST') {
      return handleGoogleOAuthDisconnect(request, env, user);
    }

    // ---- Admin/debug ----
    if (url.pathname === '/api/trigger-audit') {
      const domain = url.searchParams.get('domain');
      if (domain) {
        const result = await runFullSitemapAudit(domain, env, user.userId);
        return jsonResponse(result);
      }
      await runScheduledAudit(env);
      return jsonResponse({ status: 'Audit triggered for all properties' });
    }

    if (url.pathname === '/api/debug-sitemap') {
      const domain = url.searchParams.get('domain');
      if (!domain) return errorResponse('Missing domain parameter');
      return handleDebugSitemap(domain);
    }

    if (url.pathname === '/api/cleanup-a11y') return handleCleanupA11y(env, user);
    if (url.pathname === '/api/store-performance') return storePerformanceSnapshot(env, user);

    return errorResponse('Not found', 404);

  } catch (err) {
    console.error('Route error:', err);
    return errorResponse('Internal server error', 500);
  }
}

// ============================================================================
// HANDLER IMPLEMENTATIONS
// ============================================================================

async function handleMe(env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const userRecord = await getUserRecord(env.DB, user.userId);
  if (!userRecord) {
    return jsonResponse({ userId: user.userId, email: user.email, plan: 'trial', isNew: true });
  }

  const propertyCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM properties WHERE user_id = ?'
  ).bind(user.userId).first();

  const billing = getBillingStatus(userRecord);

  return jsonResponse({
    userId: userRecord.id,
    email: userRecord.email,
    name: userRecord.name,
    plan: userRecord.plan,
    trialEndsAt: userRecord.trial_ends_at,
    stripeCustomerId: userRecord.stripe_customer_id ? '***' : null,
    propertyCount: propertyCount?.count || 0,
    createdAt: userRecord.created_at,
    billing,
    role: user.role || 'admin',
    isTeamMember: user.isTeamMember || false,
    ownerEmail: user.ownerEmail || null
  });
}

async function handleListProperties(env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const properties = await getUserProperties(user.effectiveUserId || user.userId, env.DB);

  const enriched = properties.map(p => ({
    id: p.id,
    name: p.name,
    domain: p.domain,
    color: p.color,
    createdAt: p.created_at,
    integrations: {
      google: !!p.google_refresh_token_encrypted,
      cloudflare: !!p.cf_api_token_encrypted || !!p.cf_zone_ids,
      ga4: !!p.ga4_property_id,
      searchConsole: !!p.gsc_properties
    }
  }));

  return jsonResponse({ properties: enriched });
}

/**
 * POST /api/properties — Add a new website + run quick audit.
 */
async function handleCreatePropertyRoute(request, env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const body = await request.json();
  const { name, domain, color } = body;

  if (!name || !domain) return errorResponse('Name and domain are required');

  const userRecord = await getUserRecord(env.DB, user.userId);
  const plan = userRecord?.plan || 'trial';
  const billing = getBillingStatus(userRecord || { plan: 'trial' });

  // Block if trial has expired and no paid plan
  if (billing.isTrialExpired && !billing.hasActiveSubscription) {
    return jsonResponse({
      error: 'Your free trial has expired. Please upgrade to continue adding websites.',
      trialExpired: true
    }, 403);
  }

  const limits = await checkPlanLimits(user.userId, plan, env.DB);
  if (!limits.allowed) {
    return jsonResponse({
      error: `You've reached the limit of ${limits.limit} sites on the ${plan} plan. Upgrade to add more.`,
      current: limits.current,
      limit: limits.limit
    }, 403);
  }

  try {
    const property = await createProperty(user.userId, { name, domain, color }, env.DB);

    // Run quick audit (homepage only) — returns instant results
    let quickAuditResult = null;
    try {
      quickAuditResult = await runQuickAudit(domain, property.id, user.userId, env);
    } catch (e) {
      console.error(`Quick audit failed for ${domain}:`, e.message);
    }

    // Trigger full sitemap audit in the background (don't await)
    runFullSitemapAudit(property.domain, env, user.userId).catch(err => {
      console.error(`Background audit failed for ${property.domain}:`, err.message);
    });

    return jsonResponse({
      property,
      quickAudit: quickAuditResult,
      message: 'Website added! Quick audit complete — full site crawl running in background.'
    }, 201);
  } catch (e) {
    if (e.message?.includes('UNIQUE constraint')) {
      return errorResponse('You already have this domain added');
    }
    return errorResponse(e.message, 500);
  }
}

async function handleDeleteProperty(propertyId, env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const deleted = await deleteProperty(user.userId, propertyId, env.DB);
  if (!deleted) return errorResponse('Property not found or access denied', 404);

  return jsonResponse({ message: 'Property and all associated data deleted' });
}

async function handleUpdatePropertyRoute(propertyId, request, env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const body = await request.json();
  const updated = await updateProperty(user.userId, propertyId, body, env.DB);

  if (!updated) return errorResponse('Property not found or access denied', 404);
  return jsonResponse({ property: updated });
}

async function handleTriggerPropertyAudit(propertyId, env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
  if (!property) return errorResponse('Property not found or access denied', 404);

  try {
    const result = await runFullSitemapAudit(property.domain, env, user.userId);
    return jsonResponse(result);
  } catch (e) {
    return errorResponse(e.message, 500);
  }
}

// ============================================================================
// INTEGRATION HANDLERS
// ============================================================================

/**
 * PUT /api/properties/:id/integrations/cloudflare — Save CF API token + zone IDs
 */
async function handleUpdateCFIntegration(propertyId, request, env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
  if (!property) return errorResponse('Property not found or access denied', 404);

  const body = await request.json();
  const { apiToken, zoneIds } = body;

  if (!apiToken && !zoneIds) return errorResponse('API token or zone IDs required');

  // Encrypt token if provided
  let encryptedToken = property.cf_api_token_encrypted;
  if (apiToken) {
    if (!env.ENCRYPTION_KEY) return errorResponse('Encryption not configured', 500);
    encryptedToken = await encryptToken(apiToken, env.ENCRYPTION_KEY);
  }

  await env.DB.prepare(
    'UPDATE properties SET cf_api_token_encrypted = ?, cf_zone_ids = ? WHERE id = ? AND user_id = ?'
  ).bind(encryptedToken, zoneIds || property.cf_zone_ids, propertyId, user.userId).run();

  return jsonResponse({ message: 'Cloudflare integration updated' });
}

/**
 * POST /api/properties/:id/integrations/cloudflare/test — Test CF API token
 */
async function handleTestCFIntegration(propertyId, env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
  if (!property) return errorResponse('Property not found or access denied', 404);

  if (!property.cf_api_token_encrypted || !env.ENCRYPTION_KEY) {
    return errorResponse('No Cloudflare token configured for this property');
  }

  try {
    const { decryptToken } = await import('./google-oauth.js');
    const token = await decryptToken(property.cf_api_token_encrypted, env.ENCRYPTION_KEY);

    const response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();

    if (data.success) {
      return jsonResponse({ success: true, message: 'Cloudflare token is valid' });
    } else {
      return jsonResponse({ success: false, error: 'Token verification failed' }, 400);
    }
  } catch (e) {
    return errorResponse('Failed to test token: ' + e.message, 500);
  }
}

/**
 * PUT /api/properties/:id/integrations/google — Update GA4 property ID, GSC properties
 */
async function handleUpdateGoogleIntegration(propertyId, request, env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
  if (!property) return errorResponse('Property not found or access denied', 404);

  const body = await request.json();
  const { ga4PropertyId, gscProperties } = body;

  const updates = [];
  const params = [];

  if (ga4PropertyId !== undefined) {
    updates.push('ga4_property_id = ?');
    params.push(ga4PropertyId || null);
  }

  if (gscProperties !== undefined) {
    updates.push('gsc_properties = ?');
    params.push(gscProperties || null);
  }

  if (updates.length === 0) return errorResponse('No fields to update');

  params.push(propertyId, user.userId);

  await env.DB.prepare(
    `UPDATE properties SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
  ).bind(...params).run();

  return jsonResponse({ message: 'Google integration updated' });
}

// ============================================================================
// BILLING HANDLERS
// ============================================================================

/**
 * GET /api/billing/status — Get current billing status for the user
 */
async function handleBillingStatus(env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const userRecord = await getUserRecord(env.DB, user.userId);
  if (!userRecord) return errorResponse('User not found', 404);

  const status = getBillingStatus(userRecord);

  // Get subscription details if active
  let subscription = null;
  if (userRecord.stripe_subscription_id) {
    subscription = await env.DB.prepare(
      'SELECT * FROM subscriptions WHERE id = ? AND user_id = ?'
    ).bind(userRecord.stripe_subscription_id, user.userId).first();
  }

  return jsonResponse({
    ...status,
    subscription: subscription ? {
      id: subscription.id,
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end,
      cancelAtPeriodEnd: !!subscription.cancel_at_period_end
    } : null
  });
}

/**
 * POST /api/billing/checkout — Create a Stripe Checkout session
 */
async function handleBillingCheckout(request, env, user, url) {
  try {
    const body = await request.json();
    const plan = body.plan;

    if (!plan || !['pro', 'agency'].includes(plan)) {
      return errorResponse('Invalid plan. Choose "pro" or "agency".');
    }

    // Check if user already has an active paid plan
    const userRecord = await getUserRecord(env.DB, user.userId);
    if (userRecord && ['pro', 'agency'].includes(userRecord.plan)) {
      return errorResponse(
        'You already have an active subscription. Use the billing portal to change plans.',
        400
      );
    }

    const result = await createCheckoutSession(plan, user, env, url.origin);
    return jsonResponse(result);
  } catch (err) {
    console.error('Checkout error:', err);
    return errorResponse(err.message, 500);
  }
}

/**
 * POST /api/billing/portal — Create a Stripe Customer Portal session
 */
async function handleBillingPortal(env, user, url) {
  try {
    const result = await createPortalSession(user, env, url.origin);
    return jsonResponse(result);
  } catch (err) {
    console.error('Portal error:', err);
    return errorResponse(err.message, 500);
  }
}

// ============================================================================
// GOOGLE OAUTH HANDLERS
// ============================================================================

async function handleGoogleOAuthStart(url, env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return errorResponse('Google OAuth not configured', 500);
  }

  const propertyId = url.searchParams.get('property_id');
  if (!propertyId) return errorResponse('Missing property_id parameter');

  const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
  if (!property) return errorResponse('Property not found or access denied', 404);

  const redirectUri = `${url.origin}/api/oauth/google/callback`;
  const state = await createOAuthState(env.DB, user.userId, propertyId, 'google', redirectUri);

  cleanupExpiredStates(env.DB).catch(() => {});

  const authUrl = getGoogleAuthUrl(env.GOOGLE_OAUTH_CLIENT_ID, redirectUri, state);

  return new Response(null, {
    status: 302,
    headers: { Location: authUrl, ...CORS_HEADERS }
  });
}

async function handleGoogleOAuthCallback(url, env) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const callbackError = url.searchParams.get('error');

  if (callbackError) {
    return htmlResponse(oauthResultPage('Google connection cancelled.', 'error'));
  }

  if (!code || !state) {
    return htmlResponse(oauthResultPage('Missing authorization code or state.', 'error'), 400);
  }

  const oauthState = await consumeOAuthState(env.DB, state);
  if (!oauthState) {
    return htmlResponse(oauthResultPage('Invalid or expired OAuth state. Please try connecting again.', 'error'), 400);
  }

  const { user_id, property_id } = oauthState;

  try {
    const redirectUri = `${url.origin}/api/oauth/google/callback`;
    const tokens = await exchangeCodeForTokens(
      code, env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri
    );

    if (!tokens.refresh_token) {
      return htmlResponse(oauthResultPage('No refresh token received. Revoke access at myaccount.google.com/permissions and try again.', 'error'), 400);
    }

    if (!env.ENCRYPTION_KEY) {
      return htmlResponse(oauthResultPage('Encryption key not configured.', 'error'), 500);
    }

    const encryptedRefreshToken = await encryptToken(tokens.refresh_token, env.ENCRYPTION_KEY);

    await env.DB.prepare(
      'UPDATE properties SET google_refresh_token_encrypted = ? WHERE id = ? AND user_id = ?'
    ).bind(encryptedRefreshToken, property_id, user_id).run();

    return htmlResponse(oauthResultPage('Google connected successfully!', 'success'));

  } catch (err) {
    console.error('OAuth callback error:', err);
    return htmlResponse(oauthResultPage('Failed to connect Google: ' + err.message, 'error'), 500);
  }
}

async function handleGoogleOAuthDisconnect(request, env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const body = await request.json();
  const propertyId = body.property_id;
  if (!propertyId) return errorResponse('Missing property_id');

  const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
  if (!property) return errorResponse('Property not found or access denied', 404);

  await env.DB.prepare(
    'UPDATE properties SET google_refresh_token_encrypted = NULL WHERE id = ? AND user_id = ?'
  ).bind(propertyId, user.userId).run();

  return jsonResponse({ message: 'Google disconnected successfully' });
}

function oauthResultPage(message, type) {
  const color = type === 'success' ? '#22c55e' : '#ef4444';
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Google OAuth</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1117;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1a1d2e;border-radius:12px;padding:32px;text-align:center;max-width:400px;border:1px solid #2a2d3e}
.icon{font-size:48px;color:${color};margin-bottom:16px}
.msg{margin-bottom:24px;color:#94a3b8;line-height:1.5}
a{color:#6366f1;text-decoration:none;font-weight:600}</style></head>
<body><div class="card"><div class="icon">${type === 'success' ? '✓' : '✕'}</div><p class="msg">${message}</p><a href="/dashboard">Return to Dashboard</a></div>
<script>setTimeout(function(){window.location.href='/dashboard'},3000)</script></body></html>`;
}

// ============================================================================
// TEAM HANDLERS
// ============================================================================

async function handleTeamList(env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  // Use effectiveUserId (owner's ID) to list team members
  const ownerId = user.effectiveUserId || user.userId;
  const members = await getTeamMembers(ownerId, env.DB);

  return jsonResponse({
    members: members.map(m => ({
      id: m.id,
      email: m.member_email,
      role: m.role,
      invitedAt: m.invited_at,
      acceptedAt: m.accepted_at,
      isPending: !m.accepted_at
    }))
  });
}

async function handleTeamInvite(request, env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const body = await request.json();
  const email = body.email?.trim().toLowerCase();

  if (!email || !email.includes('@')) {
    return errorResponse('Valid email address is required');
  }

  // Cannot invite yourself
  if (email === user.email) {
    return errorResponse('You cannot invite yourself');
  }

  try {
    const result = await inviteTeamMember(user.userId, email, env.DB);

    // Send invite email via Brevo if configured
    if (env.BREVO_API_KEY) {
      const inviteUrl = new URL(request.url).origin + '/api/team/accept?token=' + result.token;
      try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'api-key': env.BREVO_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            sender: { name: 'Shelob Web', email: 'noreply@shelobweb.com' },
            to: [{ email }],
            subject: `You've been invited to join ${user.email}'s team on Shelob Web`,
            htmlContent: `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:500px;margin:0 auto;padding:32px">
              <h2 style="color:#333">Team Invite</h2>
              <p>${user.email} has invited you to join their team on Shelob Web. You'll be able to view their website health data and help manage SEO issues.</p>
              <p><a href="${inviteUrl}" style="display:inline-block;padding:12px 24px;background:#6366f1;color:white;border-radius:8px;text-decoration:none;font-weight:600">Accept Invite</a></p>
              <p style="color:#666;font-size:13px">This invite expires in 7 days.</p>
            </div>`
          })
        });
      } catch (e) {
        console.error('Failed to send invite email:', e.message);
      }
    }

    return jsonResponse({
      success: true,
      message: 'Invitation sent to ' + email,
      pending: !result.alreadyHasAccount
    });
  } catch (e) {
    return errorResponse(e.message);
  }
}

async function handleTeamAcceptInvite(url, request, env) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const token = url.searchParams.get('token');
  if (!token) {
    return htmlResponse(authResultPage('Invalid invite link. No token provided.', 'error'), 400);
  }

  // Check if user is logged in
  const user = await authenticateRequest(request, env);

  if (!user) {
    // Redirect to login with a return URL
    return Response.redirect(url.origin + '/login?redirect=' + encodeURIComponent('/api/team/accept?token=' + token), 302);
  }

  try {
    const invite = await acceptTeamInvite(token, user.userId, user.email, env.DB);

    // Get owner info for display
    const owner = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(invite.owner_user_id).first();

    return htmlResponse(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Team Invite Accepted</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1117;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1a1d2e;border-radius:12px;padding:32px;text-align:center;max-width:400px;border:1px solid #2a2d3e}
.icon{font-size:48px;color:#22c55e;margin-bottom:16px}
.msg{margin-bottom:24px;color:#94a3b8;line-height:1.5}
a{color:#6366f1;text-decoration:none;font-weight:600}</style></head>
<body><div class="card"><div class="icon">&#10003;</div><h3>You're on the team!</h3><p class="msg">You've joined ${owner?.email || 'the team'}'s dashboard. You can now view their website health data.</p><a href="/dashboard">Go to Dashboard</a></div>
<script>setTimeout(function(){window.location.href='/dashboard'},3000)</script></body></html>`);
  } catch (e) {
    return htmlResponse(authResultPage(e.message, 'error'), 400);
  }
}

async function handleTeamRemove(memberId, env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const removed = await removeTeamMember(user.userId, memberId, env.DB);
  if (!removed) return errorResponse('Member not found or access denied', 404);

  return jsonResponse({ success: true, message: 'Team member removed' });
}

// ============================================================================
// DEBUG / ADMIN HANDLERS
// ============================================================================

async function handleDebugSitemap(domain) {
  const results = { domain, checks: [] };

  let sitemapFromRobots = null;
  try {
    const robotsUrl = `https://www.${domain}/robots.txt`;
    const robotsRes = await fetch(robotsUrl);
    const robotsText = robotsRes.ok ? await robotsRes.text() : null;
    const sitemapMatch = robotsText?.match(/sitemap:\s*(https?:\/\/[^\s]+)/i);
    sitemapFromRobots = sitemapMatch ? sitemapMatch[1] : null;
    results.checks.push({ url: robotsUrl, status: robotsRes.status, sitemapFromRobots });
  } catch (e) {
    results.checks.push({ url: `https://www.${domain}/robots.txt`, error: e.message });
  }

  const sitemapUrls = [
    sitemapFromRobots,
    sitemapFromRobots?.replace('http://', 'https://'),
    `https://www.${domain}/sitemap.xml`,
    `https://www.${domain}/sitemap_index.xml`,
    `https://${domain}/sitemap.xml`
  ].filter(Boolean);

  for (const sitemapUrl of [...new Set(sitemapUrls)]) {
    try {
      const res = await fetch(sitemapUrl, { headers: { 'User-Agent': 'WebHealthDashboard/1.0' } });
      const text = res.ok ? await res.text() : null;
      const urlCount = text ? (text.match(/<loc>/gi) || []).length : 0;
      results.checks.push({
        url: sitemapUrl,
        status: res.status,
        contentType: res.headers.get('content-type'),
        size: text?.length || 0,
        urlCount,
        looksLikeXml: text?.includes('<?xml') || text?.includes('<urlset') || text?.includes('<sitemapindex'),
        preview: text?.substring(0, 500)
      });
    } catch (e) {
      results.checks.push({ url: sitemapUrl, error: e.message });
    }
  }

  return jsonResponse(results);
}

async function handleCleanupA11y(env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await env.DB.prepare(`
      UPDATE accessibility_issues SET fixed_at = ?
      WHERE fixed_at IS NULL
      AND user_id = ?
      AND issue_type IN ('empty_buttons', 'empty_links')
      AND (snippets LIKE '%aria-label%' OR snippets LIKE '%title=%' OR snippets IS NULL)
    `).bind(today, user.userId).run();

    return jsonResponse({ status: 'Cleaned up', rowsUpdated: result.meta?.changes || 0 });
  } catch (e) {
    return errorResponse(e.message, 500);
  }
}
