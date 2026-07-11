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
import LOGO_PNG from './images/sw_logo.png';
import LOGO_SVG from './images/sw_logo.svg';
import {
  authenticateRequest,
  sendMagicLink,
  verifyMagicLink,
  destroySession,
  buildSessionCookie,
  getUserRecord
} from './auth.js';
import { getDateRange } from './utils.js';
import { handleExecutiveReport } from './report.js';
import { runLifecycleEmails, verifyUnsubscribeToken } from './emails.js';
import { cloudflareGraphQL } from './cloudflare-api.js';
import { runScheduledAudit, runFullSitemapAudit, generateAISuggestions, buildFixPrompt } from './audit.js';
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
  handleIssueStatus,
  handleAIReadiness
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
  // Nav: collapse the two auth buttons into a SINGLE "Dashboard" CTA.
  // Remove the outline "Sign In" button entirely so logged-in users don't
  // see two redundant dashboard buttons.
  html = html.replace(
    /<a href="\/login" class="btn btn-outline">Sign In<\/a>\s*/g,
    ''
  );
  // Primary nav "Get Started" (no icon) → single "Dashboard" button
  html = html.replace(
    /<a href="\/login" class="btn btn-primary">Get Started<\/a>/g,
    '<a href="/dashboard" class="btn btn-primary">Dashboard</a>'
  );
  // Primary nav plain "Sign In" → Dashboard (other pages: help, policies)
  html = html.replace(
    /<a href="\/login" class="btn btn-primary">Sign In<\/a>/g,
    '<a href="/dashboard" class="btn btn-primary">Dashboard</a>'
  );
  // Any remaining outline Sign In buttons → Dashboard
  html = html.replace(
    /<a href="\/login" class="btn btn-outline">Sign In<\/a>/g,
    '<a href="/dashboard" class="btn btn-outline">Dashboard</a>'
  );
  // Footer Sign In links
  html = html.replace(
    /<a href="\/login">Sign In<\/a>/g,
    '<a href="/dashboard">Dashboard</a>'
  );
  // Any other hero/CTA "Get Started Free" → "Go to Dashboard"
  html = html.replace(
    />Get Started Free<\/a>/g,
    '>Go to Dashboard</a>'
  );
  // Hero glow CTA "Start Free Trial <svg/>" → "Go to Dashboard <svg/>"
  html = html.replace(
    /(<a href=)"\/login"( class="btn btn-glow"[^>]*>)Start (?:Your )?Free Trial( <svg)/g,
    '$1"/dashboard"$2Go to Dashboard$3'
  );
  // Pricing/other "Start Free Trial" outline buttons → Go to Dashboard
  html = html.replace(
    /(<a href=)"\/login"( class="btn btn-outline"[^>]*>)Start Free Trial(<\/a>)/g,
    '$1"/dashboard"$2Go to Dashboard$3'
  );
  return html;
}

/**
 * EU + EEA + UK (+ Switzerland). Visitors from these countries must give
 * affirmative consent (GDPR Art. 4(11) / UK GDPR / Swiss FADP), so the
 * marketing-email checkbox renders unchecked for them. Elsewhere it renders
 * pre-checked.
 */
const GDPR_COUNTRIES = new Set([
  // EU 27
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
  // EEA
  'IS', 'LI', 'NO',
  // UK GDPR / Swiss FADP
  'GB', 'CH'
]);

/**
 * Render the login page with a region-aware marketing-consent checkbox.
 * An unknown country (local dev, or cf absent) is treated as GDPR — unchecked.
 */
function renderLoginPage(request) {
  const country = request.cf?.country;
  const requiresOptIn = !country || GDPR_COUNTRIES.has(country);
  return LOGIN_HTML.replace('__CONSENT_CHECKED__', requiresOptIn ? '' : ' checked');
}

/** Confirmation page for the marketing-email unsubscribe link. */
function unsubscribePage(success) {
  const title = success ? 'You\'re unsubscribed' : 'Invalid unsubscribe link';
  const body = success
    ? 'You won\'t receive any more product tips or marketing emails from Shelob Web. Sign-in links and account emails are unaffected. Changed your mind? Just tick the box next time you sign in.'
    : 'This unsubscribe link is invalid or incomplete. Please use the unsubscribe link at the bottom of a recent email, or reply to any of our emails and we\'ll take care of it.';
  const icon = success ? '&#10003;' : '&#9888;';
  const iconColor = success ? '#22c55e' : '#f59e0b';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title} — Shelob Web</title><meta name="robots" content="noindex">
<link rel="icon" type="image/png" href="/images/sw_logo.png"></head>
<body style="margin:0;background:#0f1117;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px">
  <div style="max-width:420px;background:#1a1d2e;border:1px solid #2a2d3e;border-radius:12px;padding:36px 32px;text-align:center">
    <div style="font-size:40px;color:${iconColor};margin-bottom:12px" aria-hidden="true">${icon}</div>
    <h1 style="font-size:20px;margin:0 0 10px">${title}</h1>
    <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 24px">${body}</p>
    <a href="/" style="color:#6366f1;text-decoration:none;font-size:14px">&larr; Back to Shelob Web</a>
  </div>
</body>
</html>`;
}

function extractPathParam(pathname, basePath) {
  if (!pathname.startsWith(basePath)) return null;
  const remaining = pathname.slice(basePath.length);
  const segments = remaining.split('/').filter(Boolean);
  return segments[0] || null;
}

export default {
  async fetch(request, env, ctx) {
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

    // Static assets
    if (url.pathname === '/images/sw_logo.png') {
      return new Response(LOGO_PNG, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } });
    }
    if (url.pathname === '/images/sw_logo.svg') {
      return new Response(LOGO_SVG, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=31536000, immutable' } });
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

    // Robots.txt — explicitly welcomes AI answer-engine crawlers (AEO)
    if (url.pathname === '/robots.txt') {
      const robots = `User-agent: *
Allow: /
Allow: /policies
Allow: /help
Disallow: /dashboard
Disallow: /api/

# AI answer engines & LLM crawlers are welcome on public pages
User-agent: GPTBot
Allow: /
User-agent: OAI-SearchBot
Allow: /
User-agent: ChatGPT-User
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: Claude-Web
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Google-Extended
Allow: /
User-agent: Applebot-Extended
Allow: /
User-agent: CCBot
Allow: /

Sitemap: https://shelobweb.com/sitemap.xml`;
      return new Response(robots, {
        headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS }
      });
    }

    // llms.txt — structured site summary for AI answer engines (AEO)
    if (url.pathname === '/llms.txt') {
      const llms = `# Shelob Web

> Shelob Web is a website health monitoring platform that runs automated daily audits of SEO, Core Web Vitals, accessibility, AI readiness, and Answer Engine Optimization (AEO) across all of your websites, with AI-powered fix suggestions.

Shelob Web crawls your sitemap every night and reports issues on a single dashboard. It integrates with Google Analytics 4, Google Search Console, and Cloudflare. No code or scripts are installed on your site — it works by crawling your public pages.

## What it monitors

- SEO: titles, meta descriptions, H1 tags, schema markup, canonicals, Open Graph tags, image optimization, broken links
- Core Web Vitals: LCP, INP, CLS, FCP, TTFB (real Chrome UX field data with Lighthouse fallback)
- Accessibility: Lighthouse axe-core checks for WCAG issues across every page
- AI Readiness & AEO: llms.txt detection, AI bot access in robots.txt, structured data depth, FAQ schema, content clarity, author/date signals, and client-side rendering detection
- AI-powered fix suggestions for every issue

## Pricing

- Trial: Free for 7 days, 1 website, no credit card required
- Pro: $29/month, up to 5 websites, all integrations, AI readiness & AEO scoring, AI fix suggestions
- Agency: $59/month, up to 25 websites, team invites with role-based access control, CSV export, priority support

## Key pages

- Home: https://shelobweb.com/
- Help & FAQ: https://shelobweb.com/help
- Privacy & Terms: https://shelobweb.com/policies
- Sign in / Start free trial: https://shelobweb.com/login

## About

Shelob Web is built on Cloudflare Workers. Contact: via the website. It helps site owners, agencies, and marketers improve how their sites perform in both traditional search engines and AI answer engines like ChatGPT, Perplexity, Google AI Overviews, and Claude.
`;
      return new Response(llms, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS }
      });
    }

    // Unsubscribe from marketing emails (public, HMAC-signed link; PRD P0-6)
    if (url.pathname === '/unsubscribe') {
      const uid = url.searchParams.get('uid');
      const sig = url.searchParams.get('sig');
      const valid = env.ENCRYPTION_KEY && await verifyUnsubscribeToken(uid, sig, env.ENCRYPTION_KEY);
      if (!valid || !env.DB) {
        return htmlResponse(unsubscribePage(false), 400);
      }
      await env.DB.prepare(
        'UPDATE users SET marketing_opt_in = 0 WHERE id = ?'
      ).bind(uid).run();
      return htmlResponse(unsubscribePage(true));
    }

    // Login page
    if (url.pathname === '/login') {
      // If already logged in, redirect to dashboard
      const user = await authenticateRequest(request, env);
      if (user) {
        return Response.redirect(url.origin + '/dashboard', 302);
      }
      // Content varies by visitor country (consent checkbox default), so it
      // must never be served from a shared cache populated by another region.
      return htmlResponse(renderLoginPage(request), 200, {
        'Cache-Control': 'private, no-store'
      });
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
      return handleGoogleOAuthCallback(url, env, ctx);
    }

    // ================================================================
    // AUTHENTICATED: Dashboard page
    // ================================================================

    if (url.pathname === '/report') {
      const rUser = await authenticateRequest(request, env);
      if (!rUser) return Response.redirect(url.origin + '/login', 302);
      return handleExecutiveReport(url, env, rUser);
    }

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
    // 16:00 UTC = lifecycle/drip emails; anything else = nightly audits
    if (event.cron === '0 16 * * *') {
      ctx.waitUntil(runLifecycleEmails(env));
    } else {
      ctx.waitUntil(runScheduledAudit(env));
    }
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

    const result = await sendMagicLink(email, env, url.origin, body.marketing_opt_in === true);

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

  const result = await verifyMagicLink(token, env, url.origin);

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

    // Resolve user plan for feature gating
    if (env.DB) {
      const userRecord = await getUserRecord(env.DB, user.effectiveUserId || user.userId);
      user.plan = userRecord?.plan || 'trial';
    } else {
      user.plan = 'trial';
    }

    // ---- Expired trial lockout ----
    // Allow only /api/me, /api/billing/*, and /api/properties (GET) for expired trials
    if (env.DB && user.plan === 'trial') {
      const userRecord = await getUserRecord(env.DB, user.effectiveUserId || user.userId);
      const billing = getBillingStatus(userRecord || { plan: 'trial' });
      if (billing.isTrialExpired && !billing.hasActiveSubscription) {
        const allowed = ['/api/me', '/api/billing/status', '/api/billing/checkout', '/api/billing/portal'];
        const isAllowed = allowed.includes(url.pathname)
          || (url.pathname === '/api/properties' && request.method === 'GET');
        if (!isAllowed) {
          return jsonResponse({
            error: 'Your free trial has expired. Please choose a plan to continue.',
            trialExpired: true
          }, 403);
        }
      }
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
      return handleCreatePropertyRoute(request, env, user, ctx);
    }

    if (url.pathname.startsWith('/api/properties/') && request.method === 'DELETE') {
      if (user.role !== 'admin') return errorResponse('Only admins can remove websites', 403);
      const propertyId = extractPathParam(url.pathname, '/api/properties/');
      if (!propertyId) return errorResponse('Missing property ID');
      return handleDeleteProperty(propertyId, env, user);
    }

    if (url.pathname.startsWith('/api/properties/') && !url.pathname.includes('/integrations/') && request.method === 'PUT') {
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
      if (user.plan === 'trial') return errorResponse('Cloudflare integration requires a paid plan. Please upgrade.', 403);
      const propertyId = extractPathParam(url.pathname, '/api/properties/');
      return handleUpdateCFIntegration(propertyId, request, env, user);
    }

    // POST /api/properties/:id/integrations/cloudflare/test
    if (url.pathname.match(/^\/api\/properties\/[^/]+\/integrations\/cloudflare\/test$/) && request.method === 'POST') {
      if (user.plan === 'trial') return errorResponse('Cloudflare integration requires a paid plan. Please upgrade.', 403);
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
      if (user.plan !== 'agency') return errorResponse('Team invites require the Agency plan. Please upgrade.', 403);
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

    if (url.pathname === '/api/ai-readiness') {
      if (user.plan === 'trial') return errorResponse('AI Readiness scoring requires a paid plan. Please upgrade.', 403);
      return handleAIReadiness(url.searchParams.get('domain'), env, user);
    }

    if (url.pathname === '/api/keywords') {
      return handleKeywords(url.searchParams.get('domain'), env, user);
    }

    if (url.pathname === '/api/ai-crawlers') {
      const pid2 = url.searchParams.get('property');
      if (!pid2 || !env.DB) return jsonResponse({ available: false });
      const prop2 = await validatePropertyAccess(user.userId, pid2, env.DB);
      if (!prop2) return jsonResponse({ available: false });
      const creds2 = await getPropertyCredentials(prop2, env);
      if (!creds2.cloudflare.apiToken || !creds2.cloudflare.zoneIds?.length || !prop2.cf_api_token_encrypted) {
        return jsonResponse({ available: false, reason: 'cloudflare_not_connected' });
      }
      const { fetchAICrawlerActivity } = await import('./cloudflare-api.js');
      return jsonResponse(await fetchAICrawlerActivity(creds2.cloudflare));
    }

    if (url.pathname === '/api/ga4-404s') {
      const pid = url.searchParams.get('property');
      if (!pid || !env.DB) return jsonResponse({ pages: [] });
      const prop = await validatePropertyAccess(user.userId, pid, env.DB);
      if (!prop) return jsonResponse({ pages: [] });
      const creds = await getPropertyCredentials(prop, env);
      const { fetchGA4NotFound } = await import('./google-api.js');
      return jsonResponse(await fetchGA4NotFound(creds.ga4));
    }

    if (url.pathname === '/api/404-errors') {
      return handle404Errors(url.searchParams.get('property'), env, user);
    }

    if (url.pathname === '/api/performance-history') return handlePerformanceHistory(env, user);
    if (url.pathname === '/api/all-fixed-issues') return handleAllFixedIssues(env, user);

    if (url.pathname === '/api/cloudflare') {
      if (user.plan === 'trial') return errorResponse('Cloudflare integration requires a paid plan. Please upgrade.', 403);
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
      if (user.plan === 'trial') return errorResponse('Google Search Console requires a paid plan. Please upgrade.', 403);
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
      if (user.plan === 'trial') return errorResponse('Google integration requires a paid plan. Please upgrade.', 403);
      return handleGoogleOAuthStart(url, env, user, ctx);
    }

    if (url.pathname === '/api/oauth/google/disconnect' && request.method === 'POST') {
      return handleGoogleOAuthDisconnect(request, env, user);
    }

    // List GA4 properties available to the user's Google account
    if (url.pathname === '/api/google/ga4-properties' && request.method === 'GET') {
      if (user.plan === 'trial') return errorResponse('Google integration requires a paid plan. Please upgrade.', 403);
      const propertyId = url.searchParams.get('property_id');
      if (!propertyId) return errorResponse('Missing property_id');
      const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
      if (!property) return errorResponse('Property not found', 404);
      if (!property.google_refresh_token_encrypted) return errorResponse('Google not connected for this property');
      try {
        const ga4Props = await listGA4Properties(property.google_refresh_token_encrypted, env);
        return jsonResponse({ properties: ga4Props });
      } catch (e) {
        return jsonResponse({ error: e.message, properties: [] });
      }
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

    // Generate AI fix suggestions for existing issues (no re-crawl needed)
    if (url.pathname === '/api/keyword-plan') {
      return handleKeywordPlan(url, env, user);
    }

    if (url.pathname === '/api/generate-ai-suggestions') {
      if (user.plan === 'trial') return errorResponse('AI fix suggestions require a paid plan. Please upgrade.', 403);
      try {
        if (!env.AI) return errorResponse('AI binding not available', 500);
        if (!env.DB) return errorResponse('Database not available', 500);

        const domain = url.searchParams.get('domain');
        if (!domain) return errorResponse('Missing domain parameter');

        // Verify user has access to this domain
        const effectiveUser = await resolveEffectiveUser(user.userId, env.DB);
        const effectiveUserId = effectiveUser.effectiveUserId || user.userId;
        const property = await getPropertyByDomain(effectiveUserId, domain, env.DB);
        if (!property) return errorResponse('Property not found', 404);
        const access = await validatePropertyAccess(effectiveUserId, property.id, env.DB);
        if (!access) return errorResponse('Access denied', 403);

        // Fetch open SEO issues without AI suggestions
        const { results: seoIssues } = await env.DB.prepare(`
          SELECT id, issue_type, severity, page_path, page_url, details
          FROM issues
          WHERE domain = ? AND fixed_at IS NULL AND ai_suggestion IS NULL
          ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
          LIMIT 100
        `).bind(domain).all();

        // Fetch open accessibility issues without AI suggestions
        const { results: a11yIssues } = await env.DB.prepare(`
          SELECT id, issue_type, severity, page_path, page_url
          FROM accessibility_issues
          WHERE domain = ? AND fixed_at IS NULL AND ai_suggestion IS NULL
          ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
          LIMIT 100
        `).bind(domain).all();

        const totalIssues = seoIssues.length + a11yIssues.length;
        if (totalIssues === 0) {
          return jsonResponse({ success: true, message: 'All issues already have AI suggestions', generated: 0 });
        }

        // Build issue maps for generateAISuggestions
        // SEO issues
        const seoIssueMap = new Map();
        for (const issue of seoIssues) {
          const key = `${issue.issue_type}::${issue.page_path}`;
          seoIssueMap.set(key, {
            type: issue.issue_type,
            severity: issue.severity,
            path: issue.page_path,
            url: issue.page_url || '',
            details: issue.details ? JSON.parse(issue.details) : {}
          });
        }

        // A11y issues
        const a11yIssueMap = new Map();
        for (const issue of a11yIssues) {
          const key = `${issue.issue_type}::${issue.page_path}`;
          a11yIssueMap.set(key, {
            type: issue.issue_type,
            severity: issue.severity,
            path: issue.page_path,
            url: issue.page_url || ''
          });
        }

        // Generate suggestions (no auditPages needed — we pass empty array, prompts use domain + issue data)
        let seoGenerated = 0;
        let a11yGenerated = 0;

        if (seoIssueMap.size > 0) {
          const seoSuggestions = await generateAISuggestions(env, domain, seoIssueMap, []);
          // Write suggestions to D1
          for (const [key, suggestion] of seoSuggestions) {
            const [issueType, pagePath] = key.split('::');
            await env.DB.prepare(
              'UPDATE issues SET ai_suggestion = ? WHERE domain = ? AND issue_type = ? AND page_path = ?'
            ).bind(suggestion, domain, issueType, pagePath).run();
            seoGenerated++;
          }
        }

        if (a11yIssueMap.size > 0) {
          const a11ySuggestions = await generateAISuggestions(env, domain, a11yIssueMap, []);
          for (const [key, suggestion] of a11ySuggestions) {
            const [issueType, pagePath] = key.split('::');
            await env.DB.prepare(
              'UPDATE accessibility_issues SET ai_suggestion = ? WHERE domain = ? AND issue_type = ? AND page_path = ?'
            ).bind(suggestion, domain, issueType, pagePath).run();
            a11yGenerated++;
          }
        }

        // AI readiness issues
        const { results: airIssues } = await env.DB.prepare(`
          SELECT id, issue_type, severity, page_path, page_url, details
          FROM ai_readiness_issues
          WHERE domain = ? AND fixed_at IS NULL AND ai_suggestion IS NULL
          ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
          LIMIT 100
        `).bind(domain).all();

        let airGenerated = 0;
        if (airIssues.length > 0) {
          const airIssueMap = new Map();
          for (const issue of airIssues) {
            const key = `${issue.issue_type}::${issue.page_path}`;
            airIssueMap.set(key, {
              type: issue.issue_type, severity: issue.severity,
              path: issue.page_path, url: issue.page_url || '',
              details: issue.details ? JSON.parse(issue.details) : {}
            });
          }
          const airSuggestions = await generateAISuggestions(env, domain, airIssueMap, []);
          for (const [key, suggestion] of airSuggestions) {
            const [issueType, pagePath] = key.split('::');
            await env.DB.prepare(
              'UPDATE ai_readiness_issues SET ai_suggestion = ? WHERE domain = ? AND issue_type = ? AND page_path = ?'
            ).bind(suggestion, domain, issueType, pagePath).run();
            airGenerated++;
          }
        }

        return jsonResponse({
          success: true,
          generated: seoGenerated + a11yGenerated + airGenerated,
          seoGenerated,
          a11yGenerated,
          airGenerated,
          totalIssuesProcessed: totalIssues + airIssues.length
        });
      } catch (e) {
        console.error('AI suggestion generation error:', e);
        return jsonResponse({ error: e.message }, 500);
      }
    }

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
    ga4PropertyId: p.ga4_property_id || null,
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
async function handleCreatePropertyRoute(request, env, user, ctx) {
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
    ctx.waitUntil(runFullSitemapAudit(property.domain, env, user.userId).catch(err => {
      console.error(`Background audit failed for ${property.domain}:`, err.message);
    }));

    // Auto-copy Google token from another property if available
    let googleAutoConnected = false;
    try {
      const existingToken = await env.DB.prepare(
        'SELECT google_refresh_token_encrypted FROM properties WHERE user_id = ? AND google_refresh_token_encrypted IS NOT NULL AND id != ? LIMIT 1'
      ).bind(user.userId, property.id).first();

      if (existingToken?.google_refresh_token_encrypted) {
        await env.DB.prepare(
          'UPDATE properties SET google_refresh_token_encrypted = ? WHERE id = ? AND user_id = ?'
        ).bind(existingToken.google_refresh_token_encrypted, property.id, user.userId).run();

        // Auto-discover GA4 + Search Console and prefetch data in the background
        ctx.waitUntil(autoDiscoverIntegrations(property.id, user.userId, existingToken.google_refresh_token_encrypted, env)
          .then(() => prefetchIntegrationData(property.id, user.userId, env))
          .catch(err => console.error(`Auto-discover for new property failed: ${err.message}`)));

        googleAutoConnected = true;
      }
    } catch (e) {
      console.error(`Google token auto-copy failed: ${e.message}`);
    }

    return jsonResponse({
      property,
      quickAudit: quickAuditResult,
      googleAutoConnected,
      message: 'Website added! Quick audit complete — full site crawl running in background.' +
        (googleAutoConnected ? ' Google integration connected automatically.' : '')
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
  // Never leak stored credentials — even encrypted — in API responses
  const { google_refresh_token_encrypted, cf_api_token_encrypted, ...safe } = updated;
  return jsonResponse({ property: safe });
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

  // Auto-resolve the zone ID from the domain so users never hunt for it
  let resolvedZones = zoneIds || property.cf_zone_ids;
  let zoneNote = '';
  if (apiToken && !resolvedZones) {
    try {
      const zr = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(property.domain)}&status=active`, {
        headers: { 'Authorization': `Bearer ${apiToken}` }
      });
      const zd = await zr.json();
      if (zd.success && zd.result?.length) {
        resolvedZones = zd.result[0].id;
        zoneNote = ` Zone auto-detected for ${property.domain}.`;
      } else {
        zoneNote = ' Token saved, but no active zone found for this domain on that Cloudflare account — check the token scope or add the zone ID manually.';
      }
    } catch (e) {
      zoneNote = ' Token saved; zone auto-detection failed — add the zone ID manually.';
    }
  }

  await env.DB.prepare(
    'UPDATE properties SET cf_api_token_encrypted = ?, cf_zone_ids = ? WHERE id = ? AND user_id = ?'
  ).bind(encryptedToken, resolvedZones || null, propertyId, user.userId).run();

  return jsonResponse({ message: 'Cloudflare integration updated.' + zoneNote });
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


/**
 * GET /api/keyword-plan?domain=&query=&position=&impressions=
 * AI content plan for a keyword opportunity: target page, placement, copy.
 * Cached in KV for 24h per domain+query. Pro+ only.
 */
async function handleKeywordPlan(url, env, user) {
  if (user.plan === 'trial') return errorResponse('AI keyword plans require a paid plan. Please upgrade.', 403);
  if (!env.AI) return errorResponse('AI binding not available', 500);
  if (!env.DB) return errorResponse('Database not available', 500);

  const domain = url.searchParams.get('domain');
  const query = (url.searchParams.get('query') || '').slice(0, 120);
  const position = url.searchParams.get('position') || '?';
  const impressions = url.searchParams.get('impressions') || '0';
  if (!domain || !query) return errorResponse('Missing domain or query');

  const effectiveUser = await resolveEffectiveUser(user.userId, env.DB);
  const effectiveUserId = effectiveUser.effectiveUserId || user.userId;
  const property = await getPropertyByDomain(effectiveUserId, domain, env.DB);
  if (!property) return errorResponse('Property not found', 404);

  const cacheKey = `kwplan:${effectiveUserId}:${domain}:${query.toLowerCase()}`;
  const cached = await env.SEO_AUDITS.get(cacheKey);
  if (cached) return jsonResponse({ plan: cached, cached: true });

  // Site context: known page paths from the crawl + GA4 top pages
  let pages = [];
  try {
    const rows = await env.DB.prepare(
      'SELECT DISTINCT page_path FROM issues WHERE domain = ? LIMIT 15'
    ).bind(domain).all();
    pages = (rows.results || []).map(r => r.page_path).filter(Boolean);
  } catch (e) { /* page inventory optional */ }
  try {
    const snap = await env.DB.prepare(
      'SELECT ga4_top_pages FROM performance_snapshots WHERE domain = ? AND ga4_top_pages IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1'
    ).bind(domain).first();
    if (snap?.ga4_top_pages) {
      JSON.parse(snap.ga4_top_pages).forEach(tp => { if (tp.path && !pages.includes(tp.path)) pages.push(tp.path); });
    }
  } catch (e) { /* optional */ }

  const prompt = `Site: ${domain}
Keyword: "${query}" — currently ranking at position ${position} on Google with ${impressions} impressions in the last 28 days.
Known pages on the site: ${pages.length ? pages.slice(0, 20).join(', ') : '(homepage only)'}

Produce a concrete plan to improve ranking for this keyword:
1. Target page: pick ONE page from the list (or say "create new page at /suggested-path").
2. Placement: exactly where to add the keyword (title tag, H1, first paragraph, FAQ, etc.).
3. Suggested copy: write 2-3 ready-to-paste sentences that naturally use the keyword.
Keep the whole answer under 120 words. No preamble.`;

  try {
    const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: 'You are a pragmatic SEO strategist. Be specific and concise; never invent pages that were not listed unless proposing a clearly-labeled new page.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 350
    });
    let plan = response?.response?.trim();
    if (plan) plan = plan.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!plan) return errorResponse('AI returned no plan — try again', 502);
    await env.SEO_AUDITS.put(cacheKey, plan, { expirationTtl: 86400 });
    return jsonResponse({ plan });
  } catch (e) {
    console.error('keyword-plan error:', e.message);
    return errorResponse('Plan generation failed — try again', 502);
  }
}

async function handleGoogleOAuthStart(url, env, user, ctx) {
  if (!env.DB) return errorResponse('Database not available', 500);

  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return errorResponse('Google OAuth not configured', 500);
  }

  const propertyId = url.searchParams.get('property_id');
  if (!propertyId) return errorResponse('Missing property_id parameter');

  const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
  if (!property) return errorResponse('Property not found or access denied', 404);

  // Check if the user already has a Google OAuth token on another property — reuse it
  const existingToken = await env.DB.prepare(
    'SELECT google_refresh_token_encrypted FROM properties WHERE user_id = ? AND google_refresh_token_encrypted IS NOT NULL LIMIT 1'
  ).bind(user.userId).first();

  if (existingToken?.google_refresh_token_encrypted) {
    // Reuse the existing token — copy it to this property
    await env.DB.prepare(
      'UPDATE properties SET google_refresh_token_encrypted = ? WHERE id = ? AND user_id = ?'
    ).bind(existingToken.google_refresh_token_encrypted, propertyId, user.userId).run();

    // Auto-discover GA4 and Search Console for this property
    try {
      await autoDiscoverIntegrations(propertyId, user.userId, existingToken.google_refresh_token_encrypted, env);
    } catch (e) {
      console.error('Auto-discover after token reuse failed:', e.message);
    }

    // Trigger background data prefetch (must survive the response)
    ctx.waitUntil(prefetchIntegrationData(propertyId, user.userId, env).catch(err => {
      console.error('Prefetch after token reuse failed:', err.message);
    }));

    // Redirect back to dashboard with success message
    return htmlResponse(oauthResultPage('Google connected! Using your existing Google account.', 'success'));
  }

  // No existing token — start fresh OAuth flow
  const redirectUri = `${url.origin}/api/oauth/google/callback`;
  const state = await createOAuthState(env.DB, user.userId, propertyId, 'google', redirectUri);

  cleanupExpiredStates(env.DB).catch(() => {});

  const authUrl = getGoogleAuthUrl(env.GOOGLE_OAUTH_CLIENT_ID, redirectUri, state);

  return new Response(null, {
    status: 302,
    headers: { Location: authUrl, ...CORS_HEADERS }
  });
}

async function handleGoogleOAuthCallback(url, env, ctx) {
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

    // Copy token to ALL user properties (not just the one that initiated OAuth)
    await env.DB.prepare(
      'UPDATE properties SET google_refresh_token_encrypted = ? WHERE user_id = ?'
    ).bind(encryptedRefreshToken, user_id).run();

    // Auto-discover GA4 + Search Console for the initiating property first
    const discoveryResult = await autoDiscoverIntegrations(property_id, user_id, encryptedRefreshToken, env);

    // Background: auto-discover + prefetch for ALL user properties
    // MUST be in ctx.waitUntil — Workers kills bare background promises
    ctx.waitUntil((async () => {
      try {
        const allProps = await env.DB.prepare(
          'SELECT id FROM properties WHERE user_id = ? AND id != ?'
        ).bind(user_id, property_id).all();

        for (const prop of (allProps.results || [])) {
          try {
            await autoDiscoverIntegrations(prop.id, user_id, encryptedRefreshToken, env);
            await prefetchIntegrationData(prop.id, user_id, env);
          } catch (e) {
            console.error(`Auto-discover/prefetch for property ${prop.id} failed:`, e.message);
          }
        }
      } catch (e) {
        console.error('Background multi-property discovery failed:', e.message);
      }
    })());

    // Prefetch data for the initiating property
    ctx.waitUntil(prefetchIntegrationData(property_id, user_id, env).catch(err => {
      console.error('Background integration prefetch failed:', err.message);
    }));

    return htmlResponse(oauthResultPage('Google connected successfully!' + discoveryResult.status, 'success'));

  } catch (err) {
    console.error('OAuth callback error:', err);
    return htmlResponse(oauthResultPage('Failed to connect Google: ' + err.message, 'error'), 500);
  }
}

/**
 * Auto-discover GA4 property and Search Console site for a property after OAuth connection.
 * Shared by both fresh OAuth flow and token-reuse flow.
 */
async function autoDiscoverIntegrations(propertyId, userId, encryptedRefreshToken, env) {
  let status = '';

  // Auto-discover GA4
  try {
    const property = await env.DB.prepare('SELECT domain, ga4_property_id FROM properties WHERE id = ?').bind(propertyId).first();
    if (property && !property.ga4_property_id) {
      const ga4Props = await listGA4Properties(encryptedRefreshToken, env);
      const domain = property.domain?.toLowerCase().replace(/^www\./, '');
      const match = ga4Props.find(p => {
        const url = (p.websiteUrl || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
        return url === domain || url.includes(domain);
      });
      if (match) {
        await env.DB.prepare('UPDATE properties SET ga4_property_id = ? WHERE id = ? AND user_id = ?')
          .bind(match.propertyId, propertyId, userId).run();
        status += ' GA4: ' + match.displayName + '.';
      } else if (ga4Props.length === 1) {
        await env.DB.prepare('UPDATE properties SET ga4_property_id = ? WHERE id = ? AND user_id = ?')
          .bind(ga4Props[0].propertyId, propertyId, userId).run();
        status += ' GA4: ' + ga4Props[0].displayName + '.';
      } else if (ga4Props.length > 1) {
        status += ' Found ' + ga4Props.length + ' GA4 properties — select one in Settings.';
      }
    }
  } catch (e) {
    console.error('GA4 auto-detect error:', e.message);
  }

  // Auto-discover Search Console
  try {
    const { decryptToken, refreshAccessToken } = await import('./google-oauth.js');
    const refreshToken = await decryptToken(encryptedRefreshToken, env.ENCRYPTION_KEY);
    const oauthTokens = await refreshAccessToken(refreshToken, env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET);
    const accessToken = oauthTokens.access_token;

    const sitesRes = await fetch('https://searchconsole.googleapis.com/webmasters/v3/sites', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (sitesRes.ok) {
      const sitesData = await sitesRes.json();
      const sites = sitesData.siteEntry || [];
      const prop = await env.DB.prepare('SELECT domain, gsc_properties FROM properties WHERE id = ?').bind(propertyId).first();
      if (prop && !prop.gsc_properties) {
        const domain = prop.domain?.toLowerCase().replace(/^www\./, '');
        const match = sites.find(s => {
          const siteUrl = (s.siteUrl || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').replace(/^sc-domain:/, '');
          return siteUrl === domain || siteUrl.includes(domain);
        });
        if (match) {
          await env.DB.prepare('UPDATE properties SET gsc_properties = ? WHERE id = ? AND user_id = ?')
            .bind(match.siteUrl, propertyId, userId).run();
          status += ' Search Console connected.';
        }
      }
    }
  } catch (e) {
    console.error('GSC auto-detect error:', e.message);
  }

  return { status };
}

/**
 * Background prefetch of GA4 and Search Console data after OAuth connection.
 * Fetches data immediately so the dashboard has results without waiting for the nightly audit.
 */
async function prefetchIntegrationData(propertyId, userId, env) {
  const { getPropertyCredentials } = await import('./tenant.js');
  const { fetchGA4Analytics, fetchAndStoreSearchConsole } = await import('./google-api.js');

  // Re-read property to pick up the just-written GA4 and GSC config
  const property = await env.DB.prepare('SELECT * FROM properties WHERE id = ?').bind(propertyId).first();
  if (!property) return;

  const creds = await getPropertyCredentials(property, env);

  // Fetch GA4 data and store in performance_snapshots for immediate dashboard display
  if (creds.ga4.propertyId && creds.ga4.credentials) {
    try {
      const ga4 = await fetchGA4Analytics(creds.ga4);
      console.log(`Prefetched GA4 data for ${property.domain}: ${ga4.sessions || 0} sessions`);

      // Store GA4 data in performance_snapshots so it's immediately available
      const today = new Date().toISOString().split('T')[0];
      await env.DB.prepare(`
        INSERT INTO performance_snapshots (domain, snapshot_date, user_id, ga4_sessions, ga4_sessions_change, ga4_users, ga4_users_change, ga4_bounce_rate, ga4_avg_duration, ga4_engagement_rate, ga4_page_views, ga4_top_pages)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain, snapshot_date) DO UPDATE SET
          ga4_sessions = excluded.ga4_sessions, ga4_sessions_change = excluded.ga4_sessions_change,
          ga4_users = excluded.ga4_users, ga4_users_change = excluded.ga4_users_change,
          ga4_bounce_rate = excluded.ga4_bounce_rate, ga4_avg_duration = excluded.ga4_avg_duration,
          ga4_engagement_rate = excluded.ga4_engagement_rate, ga4_page_views = excluded.ga4_page_views,
          ga4_top_pages = excluded.ga4_top_pages
      `).bind(
        property.domain, today, userId,
        ga4.sessions || null, parseFloat(ga4.sessionsChange) || null,
        ga4.newUsers || null, parseFloat(ga4.newUsersChange) || null,
        parseFloat(ga4.bounceRate) || null, ga4.avgDuration || null,
        parseFloat(ga4.engagementRate) || null, ga4.pageViews || null,
        ga4.topPages ? JSON.stringify(ga4.topPages) : null
      ).run();
    } catch (e) {
      console.error(`GA4 prefetch error for ${property.domain}:`, e.message);
    }
  }

  // Fetch and store Search Console keyword data into D1
  if (property.gsc_properties && creds.searchConsole.properties?.length > 0) {
    try {
      const today = new Date().toISOString().split('T')[0];
      await fetchAndStoreSearchConsole(env, property.domain, propertyId, today, creds);
      console.log(`Prefetched Search Console data for ${property.domain}`);
    } catch (e) {
      console.error(`Search Console prefetch error for ${property.domain}:`, e.message);
    }
  }
}

async function handleGoogleOAuthDisconnect(request, env, user) {
  if (!env.DB) return errorResponse('Database not available', 500);

  const body = await request.json();
  const propertyId = body.property_id;
  if (!propertyId) return errorResponse('Missing property_id');

  const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
  if (!property) return errorResponse('Property not found or access denied', 404);

  // Disconnect Google from ALL user properties (token is shared across properties).
  // Keep ga4_property_id / gsc_properties: they're inert without a token, and
  // preserving them means reconnecting restores everything without re-picking.
  await env.DB.prepare(
    'UPDATE properties SET google_refresh_token_encrypted = NULL WHERE user_id = ?'
  ).bind(user.userId).run();

  return jsonResponse({ message: 'Google disconnected from all properties' });
}

/**
 * List GA4 properties accessible via the user's OAuth token.
 * Uses the GA4 Admin API to enumerate properties.
 */
async function listGA4Properties(encryptedRefreshToken, env) {
  const { decryptToken, refreshAccessToken } = await import('./google-oauth.js');
  const refreshToken = await decryptToken(encryptedRefreshToken, env.ENCRYPTION_KEY);
  const tokens = await refreshAccessToken(refreshToken, env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET);
  const accessToken = tokens.access_token;

  // List all GA4 accounts first
  const accountsRes = await fetch('https://analyticsadmin.googleapis.com/v1beta/accounts', {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const accountsData = await accountsRes.json();

  let properties = [];

  // If the Admin API returns an error (e.g. API not enabled), try account summaries
  if (accountsData.error) {
    console.error('GA4 Admin API error:', JSON.stringify(accountsData.error));
    const summariesRes = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const summariesData = await summariesRes.json();
    if (summariesData.error) {
      throw new Error(summariesData.error.message || 'GA4 Admin API not available. Enable "Google Analytics Admin API" in your Google Cloud Console.');
    }
    for (const acctSummary of (summariesData.accountSummaries || [])) {
      for (const propSummary of (acctSummary.propertySummaries || [])) {
        const numericId = propSummary.property.replace('properties/', '');
        properties.push({
          propertyId: numericId,
          displayName: propSummary.displayName,
          websiteUrl: '',
          name: propSummary.property,
          account: acctSummary.displayName
        });
      }
    }
  } else {
    const accounts = accountsData.accounts || [];
    for (const account of accounts) {
      const accountId = account.name;
      const propsRes = await fetch(
        `https://analyticsadmin.googleapis.com/v1beta/properties?filter=parent:${accountId}`, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        }
      );
      const propsData = await propsRes.json();
      for (const prop of (propsData.properties || [])) {
        const numericId = prop.name.replace('properties/', '');
        properties.push({
          propertyId: numericId,
          displayName: prop.displayName,
          websiteUrl: '',
          name: prop.name,
          account: account.displayName
        });
      }
    }
  }

  // For each property, try to get data streams to find the website URL
  for (const prop of properties) {
    try {
      const streamsRes = await fetch(
        `https://analyticsadmin.googleapis.com/v1beta/${prop.name}/dataStreams`, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        }
      );
      const streamsData = await streamsRes.json();
      const webStreams = (streamsData.dataStreams || []).filter(s => s.type === 'WEB_DATA_STREAM');
      if (webStreams.length > 0) {
        prop.websiteUrl = webStreams[0].webStreamData?.defaultUri || '';
        prop.streamName = webStreams[0].displayName || '';
      }
    } catch (e) {
      // Non-critical
    }
  }

  return properties;
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
<script>setTimeout(function(){window.location.href='/dashboard?refresh=1'},2000)</script></body></html>`;
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
<script>setTimeout(function(){window.location.href='/dashboard?refresh=1'},2000)</script></body></html>`);
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
