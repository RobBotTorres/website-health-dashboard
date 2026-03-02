// ============================================================================
// WINE HEALTH DASHBOARD - ROUTER
// Serves both the dashboard UI and API
// Includes daily cron job for full sitemap SEO audits
// ============================================================================

import DASHBOARD_HTML from './dashboard.html';
import { authenticate } from './auth.js';
import { getDateRange } from './utils.js';
import { cloudflareGraphQL } from './cloudflare-api.js';
import { runScheduledAudit, runFullSitemapAudit } from './audit.js';
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
  fetchSearchConsoleData
} from './handlers.js';

// Admin routes that require authentication
const ADMIN_ROUTES = new Set([
  '/api/debug-ga4',
  '/api/debug-cache',
  '/api/debug-sitemap',
  '/api/trigger-audit',
  '/api/cleanup-a11y',
  '/api/store-performance'
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight passes through without auth
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    // Authenticate admin routes
    if (ADMIN_ROUTES.has(url.pathname)) {
      const authError = authenticate(request, env);
      if (authError) return authError;
    }

    // ---- Public API endpoints ----

    if (url.pathname === '/api/data') {
      return handleAPI(request, env);
    }

    if (url.pathname === '/api/site-health') {
      return handleSiteHealth(request, env);
    }

    if (url.pathname === '/api/core-web-vitals') {
      return handleCoreWebVitals(request, env);
    }

    if (url.pathname === '/api/performance') {
      return handlePerformance(request, env);
    }

    if (url.pathname === '/api/seo-stats') {
      const domain = url.searchParams.get('domain');
      return handleSEOStats(domain, env);
    }

    if (url.pathname === '/api/accessibility') {
      const domain = url.searchParams.get('domain');
      return handleAccessibility(domain, env);
    }

    if (url.pathname === '/api/keywords') {
      const domain = url.searchParams.get('domain');
      return handleKeywords(domain, env);
    }

    if (url.pathname === '/api/404-errors') {
      const propertyId = url.searchParams.get('property');
      return handle404Errors(propertyId, env);
    }

    if (url.pathname === '/api/performance-history') {
      return handlePerformanceHistory(env);
    }

    if (url.pathname === '/api/all-fixed-issues') {
      return handleAllFixedIssues(env);
    }

    if (url.pathname === '/api/cloudflare') {
      const propertyId = url.searchParams.get('property');
      if (!propertyId) {
        return new Response(JSON.stringify({ error: 'Missing property parameter' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
      try {
        const data = await fetchCloudflareData(propertyId, env);
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname === '/api/search-console') {
      const propertyId = url.searchParams.get('property');
      if (!propertyId) {
        return new Response(JSON.stringify({ error: 'Missing property parameter' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
      try {
        const data = await fetchSearchConsoleData(propertyId, env);
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // ---- Admin/debug endpoints (auth checked above) ----

    if (url.pathname === '/api/debug-ga4') {
      const properties = ['ADAIR', 'BRCOHN', 'CLOSPEGASE', 'GIRARD', 'KUNDE', 'VIANSA'];
      const config = {};
      for (const p of properties) {
        config[p] = {
          ga4PropertyId: env[`${p}_GA4_PROPERTY_ID`] ? 'SET (' + env[`${p}_GA4_PROPERTY_ID`].substring(0, 4) + '...)' : 'NOT SET',
          cfZoneIds: env[`${p}_CF_ZONE_IDS`] ? 'SET' : 'NOT SET',
          gscProperties: env[`${p}_GSC_PROPERTIES`] ? 'SET' : 'NOT SET'
        };
      }
      config.GOOGLE_SERVICE_ACCOUNT = env.GOOGLE_SERVICE_ACCOUNT ? 'SET' : 'NOT SET';
      return new Response(JSON.stringify(config, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (url.pathname === '/api/trigger-audit') {
      const domain = url.searchParams.get('domain');
      if (domain) {
        const result = await runFullSitemapAudit(domain, env);
        return new Response(JSON.stringify(result, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        await runScheduledAudit(env);
        return new Response(JSON.stringify({ status: 'Audit triggered for all properties' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname === '/api/cleanup-a11y') {
      if (!env.DB) {
        return new Response(JSON.stringify({ error: 'DB not available' }), { headers: { 'Content-Type': 'application/json' } });
      }
      try {
        const today = new Date().toISOString().split('T')[0];
        const result = await env.DB.prepare(`
          UPDATE accessibility_issues SET fixed_at = ?
          WHERE fixed_at IS NULL
          AND issue_type IN ('empty_buttons', 'empty_links')
          AND (snippets LIKE '%aria-label%' OR snippets LIKE '%title=%' OR snippets IS NULL)
        `).bind(today).run();
        return new Response(JSON.stringify({
          status: 'Cleaned up aria-label false positives',
          rowsUpdated: result.meta?.changes || 0
        }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (url.pathname === '/api/store-performance') {
      return storePerformanceSnapshot(env);
    }

    if (url.pathname === '/api/debug-cache') {
      const results = {};
      const properties = {
        adair: 'adairfamilywines.com',
        brcohn: 'brcohn.com',
        clospegase: 'clospegase.com',
        girard: 'girardwinery.com',
        kunde: 'kunde.com',
        viansa: 'viansa.com'
      };

      const tokenSet = !!env.CLOUDFLARE_API_TOKEN;
      const tokenPreview = tokenSet ? env.CLOUDFLARE_API_TOKEN.substring(0, 8) + '...' : 'NOT SET';

      let tokenValid = false;
      let tokenError = null;
      if (tokenSet) {
        try {
          const testRes = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
            headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` }
          });
          const testData = await testRes.json();
          tokenValid = testData.success === true;
          tokenError = testData.success ? null : JSON.stringify(testData.errors);
        } catch (e) {
          tokenError = e.message;
        }
      }

      let d1SnapshotCount = 0;
      let d1SampleRow = null;
      if (env.DB) {
        try {
          const count = await env.DB.prepare('SELECT COUNT(*) as cnt FROM performance_snapshots').first();
          d1SnapshotCount = count?.cnt || 0;
          d1SampleRow = await env.DB.prepare('SELECT domain, snapshot_date, cf_cache_ratio, cf_requests FROM performance_snapshots ORDER BY snapshot_date DESC LIMIT 1').first();
        } catch(e) {
          d1SampleRow = { error: e.message };
        }
      }

      const { startDate, endDate } = getDateRange(7);
      const cfHeaders = { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' };

      for (const [propId, domain] of Object.entries(properties)) {
        const prefix = propId.toUpperCase();
        const zoneIdsRaw = env[`${prefix}_CF_ZONE_IDS`];
        const zoneIds = zoneIdsRaw ? zoneIdsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

        const propResult = {
          domain,
          zoneIdsConfigured: !!zoneIdsRaw,
          zoneCount: zoneIds.length,
          zoneIds: zoneIds.map(z => z.substring(0, 8) + '...'),
          apiResults: []
        };

        for (const zoneId of zoneIds) {
          try {
            const graphqlResult = await cloudflareGraphQL(cfHeaders, `
              query {
                viewer {
                  zones(filter: {zoneTag: "${zoneId}"}) {
                    httpRequests1dGroups(limit: 7, filter: {date_geq: "${startDate}", date_leq: "${endDate}"}, orderBy: [date_ASC]) {
                      dimensions { date }
                      sum { requests bytes cachedBytes }
                    }
                  }
                }
              }
            `);

            const zones = graphqlResult?.data?.viewer?.zones || [];
            const days = zones[0]?.httpRequests1dGroups || [];
            let totalBytes = 0, totalCached = 0, totalReqs = 0;

            days.forEach(d => {
              totalBytes += d.sum?.bytes || 0;
              totalCached += d.sum?.cachedBytes || 0;
              totalReqs += d.sum?.requests || 0;
            });

            const cacheRatio = totalBytes > 0 ? (totalCached / totalBytes * 100).toFixed(1) : 'N/A (0 bytes)';

            propResult.apiResults.push({
              zoneId: zoneId.substring(0, 8) + '...',
              success: true,
              daysReturned: days.length,
              totalRequests: totalReqs,
              totalBytes,
              totalCachedBytes: totalCached,
              cacheRatio,
              rawErrors: graphqlResult?.errors || null,
              sampleDay: days[0] ? { date: days[0].dimensions?.date, bytes: days[0].sum?.bytes, cachedBytes: days[0].sum?.cachedBytes } : null
            });
          } catch (e) {
            propResult.apiResults.push({
              zoneId: zoneId.substring(0, 8) + '...',
              success: false,
              error: e.message
            });
          }
        }

        results[propId] = propResult;
      }

      return new Response(JSON.stringify({
        diagnosis: 'Cache Ratio Debug Report',
        timestamp: new Date().toISOString(),
        dateRange: { startDate, endDate },
        token: { set: tokenSet, preview: tokenPreview, valid: tokenValid, error: tokenError },
        d1Cache: { snapshotCount: d1SnapshotCount, latestRow: d1SampleRow },
        deadCodeNote: 'fetchAndStorePerformance() runs during scheduled audit and via /api/store-performance',
        properties: results
      }, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (url.pathname === '/api/debug-sitemap') {
      const domain = url.searchParams.get('domain') || 'kunde.com';
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
          const res = await fetch(sitemapUrl, { headers: { 'User-Agent': 'WineHealthDashboard/1.0' }});
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

      return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Dashboard HTML
    return new Response(DASHBOARD_HTML, {
      headers: { 'Content-Type': 'text/html' }
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledAudit(env));
  }
};
