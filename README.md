# Shelob Web

> Website health monitoring dashboard — SEO, Core Web Vitals, accessibility, AI readiness, and broken links across all your sites. Daily automated audits with AI-powered fix suggestions.

Live at [shelobweb.com](https://shelobweb.com).

## What it does

Shelob Web crawls your websites every night and reports on:

- **SEO health** — titles, meta descriptions, H1 tags, schema markup, canonicals, Open Graph tags, image optimization
- **Core Web Vitals** — LCP, INP, CLS, FCP, TTFB (real CrUX field data with Lighthouse fallback)
- **Accessibility** — Lighthouse axe-core checks across every page
- **AI readiness** — llms.txt detection, AI bot access (GPTBot, ClaudeBot, PerplexityBot, etc.), structured data depth, content clarity, CSR detection
- **Broken links** — internal 404 detection across the full sitemap
- **AI-powered fix suggestions** — Workers AI generates copy-paste-ready fixes for every issue

Connects to **Google Analytics 4**, **Google Search Console**, and **Cloudflare** for traffic, keyword, and edge analytics.

## Architecture

Single Cloudflare Worker serving the entire app:

| Component | Purpose |
|-----------|---------|
| **Cloudflare Worker** | All routing, API endpoints, scheduled audits, HTML serving |
| **D1 Database** | Properties, users, audits, issues, performance snapshots, keywords, team members, billing |
| **KV Namespace** | Session tokens, audit cache, OAuth state |
| **Workers AI** | Generates AI fix suggestions (uses `@cf/zai-org/glm-4.7-flash`) |
| **Cron trigger** | Nightly full-site audit at 11:00 UTC |

External APIs: Google Analytics Data API v1beta, Search Console API, GA4 Admin API, PageSpeed Insights API, Cloudflare GraphQL Analytics, Stripe, Brevo (transactional email).

## Source layout

```
src/
├── index.js          # Main router, OAuth handlers, property CRUD, scheduled audit trigger
├── handlers.js       # Data endpoints (/api/data, /api/performance, /api/seo-stats, etc.)
├── audit.js          # Full-site sitemap crawl + AI readiness checks
├── quick-audit.js    # Instant homepage audit when adding a new property
├── auth.js           # Magic-link authentication
├── tenant.js         # Multi-tenant property + credentials resolution
├── google-oauth.js   # OAuth token exchange + AES encryption
├── google-api.js     # GA4 Data API + Search Console API clients
├── google-auth.js    # OAuth scope definitions
├── cloudflare-api.js # Cloudflare GraphQL Analytics client
├── stripe.js         # Checkout sessions + webhook handling
├── cf-access-auth.js # Cloudflare Access JWT validation
├── config.js         # Plan tiers + feature flags
├── utils.js          # Shared helpers (PST date math, CORS, response wrappers)
├── dashboard.html    # Main dashboard SPA
├── marketing.html    # Public homepage
├── login.html        # Magic-link login page
├── help.html         # FAQ + help docs
├── policies.html     # Privacy policy + terms of service
└── images/           # Logo PNG + SVG (served as Worker assets)
```

## Plan tiers

| Tier | Price | Sites | Integrations | AI Readiness | Team | CSV Export |
|------|-------|-------|--------------|--------------|------|------------|
| **Trial** | Free (7 days) | 1 | — | — | — | — |
| **Pro** | $29/mo | 5 | GA4, Search Console, Cloudflare | ✓ | — | — |
| **Agency** | $59/mo | 25 | All | ✓ | RBAC | ✓ |

Trial expiry locks users into the upgrade page only — all API endpoints except `/api/me` and `/api/billing/*` return 403 until they subscribe.

## Local development

```bash
npm install
npm run dev          # wrangler dev (production env bindings)
npm run dev:staging  # wrangler dev --env staging
```

Required environment bindings (set via `wrangler secret put`):

- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
- `ENCRYPTION_KEY` (used to AES-encrypt OAuth refresh tokens at rest)
- `PAGESPEED_API_KEY`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_AGENCY`
- `BREVO_API_KEY` (magic-link emails)
- `JWT_SECRET` (session signing)

D1 database bindings, KV namespaces, and cron triggers are configured in `wrangler.toml`.

## Database migrations

D1 migrations live in `migrations/` and are numbered sequentially:

```bash
# Apply latest migration locally
npx wrangler d1 migrations apply wine-seo-audits --local

# Apply to production
npx wrangler d1 migrations apply wine-seo-audits --remote
```

## Deployment

```bash
npm run deploy           # Deploy to production (shelobweb.com)
npm run deploy:staging   # Deploy to staging
npm run tail             # Stream production logs
```

The production worker handles two custom domains: `shelobweb.com` and `www.shelobweb.com`.

## Audit pipeline

1. **Quick audit** runs synchronously when a user adds a website — homepage SEO + PageSpeed + AI readiness checks complete in 3-5 seconds.
2. **Full sitemap audit** fires in the background — recursively parses sitemap index files, audits up to 500 pages in batches of 10, runs broken-link detection, AI readiness per-page, and stores everything in D1.
3. **Nightly cron** (11:00 UTC) re-runs the full audit for every active property, batched 5 at a time.

After every audit, the `ai_readiness` table is updated with a domain-level score, and `ai_readiness_issues` tracks per-page issues with full lifecycle (detected → manually fixed → automatically reactivated if it returns).

## OAuth + integrations

Google OAuth uses two scopes: `analytics.readonly` and `webmasters.readonly`. Refresh tokens are AES-encrypted before storage in D1.

When a user connects Google on any property:
- The token is copied to **all** their properties automatically
- GA4 properties + Search Console sites are auto-discovered and matched by domain
- Initial GA4 sessions/keywords are prefetched and stored in `performance_snapshots` so the dashboard shows data within seconds

Disconnecting removes the token from every property at once.

## Key design decisions

- **Static assets via Workers** — PNG and SVG logos are imported as binary modules and served from the Worker, not R2. This keeps deployments self-contained.
- **Per-user OAuth, per-property settings** — one Google token shared across a user's properties, but each property has its own GA4 property ID and GSC site URL.
- **Effective user resolution** — team members see the dashboard scoped to their inviter's properties via `resolveEffectiveUser()` in `tenant.js`.
- **Issue lifecycle** — issues stay in the database forever with `first_seen`, `last_seen`, `manually_fixed_at`, and `reactivated_at` timestamps, so the dashboard can show fix history and warn when an issue returns.

## License

Proprietary. All rights reserved.
