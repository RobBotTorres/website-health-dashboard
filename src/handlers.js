import { PROPERTIES, PROPERTY_IDS, getCredentials } from './config.js';
import { getUserProperties, getPropertyByDomain, getPropertyCredentials, validatePropertyAccess } from './tenant.js';
import { getDateRange, getDateRangePST, formatIssueMessage, formatIssueStatus } from './utils.js';
import { cloudflareGraphQL, fetchCloudflareSummary, fetchCloudflareDetail, fetchCloudflareTraffic, fetchCloudflarePerformance } from './cloudflare-api.js';
import { fetchGA4Analytics, fetchGA4Performance, fetchSearchConsoleSummary, fetchSearchConsoleDetail, fetchPageSpeedInsights, fetchCoreWebVitals } from './google-api.js';
import { checkRobotsTxt, fetchAndStorePerformance } from './audit.js';

// ============================================================================
// MAIN API HANDLER
// ============================================================================

export async function handleAPI(request, env, user) {
  const url = new URL(request.url);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  };

  try {
    const propertyParam = url.searchParams.get('property');
    const debugParam = url.searchParams.get('debug');

    if (debugParam === 'vitals') {
      const zoneId = url.searchParams.get('zone') || '152084b83d9eccf45eee4eb6606bb9e0';
      const { startDate, endDate } = getDateRangePST(7);

      const cfHeaders = {
        'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json'
      };

      const zoneResponse = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}`, {
        headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` }
      });
      const zoneData = await zoneResponse.json();
      const accountId = zoneData?.result?.account?.id;
      const zoneName = zoneData?.result?.name;

      let rumResult = null;
      if (accountId) {
        const rumQuery = `
          query {
            viewer {
              accounts(filter: {accountTag: "${accountId}"}) {
                rumPageloadEventsAdaptiveGroups(
                  filter: { AND: [{date_geq: "${startDate}"}, {date_leq: "${endDate}"}] }
                  limit: 10
                ) {
                  count
                  dimensions { siteTag requestHost }
                  avg { sampleInterval }
                }
                rumPerformanceEventsAdaptiveGroups(
                  filter: { AND: [{date_geq: "${startDate}"}, {date_leq: "${endDate}"}] }
                  limit: 10
                ) {
                  count
                  dimensions { siteTag }
                  avg { firstContentfulPaint firstPaint loadEventTime pageRenderTime }
                }
              }
            }
          }
        `;
        rumResult = await cloudflareGraphQL(cfHeaders, rumQuery);
      }

      return new Response(JSON.stringify({
        zoneId, zoneName, accountId,
        dateRange: { startDate, endDate },
        rumResult
      }, null, 2), { headers });
    }

    if (debugParam === 'pagespeed') {
      const domain = url.searchParams.get('domain') || 'viansa.com';
      const apiKey = env.PAGESPEED_API_KEY;

      try {
        let psUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://www.${domain}&strategy=mobile&category=performance`;
        if (apiKey) psUrl += `&key=${apiKey}`;
        const response = await fetch(psUrl);
        const status = response.status;
        const data = await response.json();

        return new Response(JSON.stringify({
          domain,
          requestUrl: psUrl.replace(apiKey || '', 'REDACTED'),
          hasApiKey: !!apiKey,
          status,
          hasLoadingExperience: !!data.loadingExperience,
          hasOriginLoadingExperience: !!data.originLoadingExperience,
          loadingExperienceMetrics: data.loadingExperience?.metrics ? Object.keys(data.loadingExperience.metrics) : [],
          originLoadingExperienceMetrics: data.originLoadingExperience?.metrics ? Object.keys(data.originLoadingExperience.metrics) : [],
          overallCategory: data.loadingExperience?.overall_category || data.originLoadingExperience?.overall_category,
          error: data.error
        }, null, 2), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ domain, error: e.message }, null, 2), { headers });
      }
    }

    let data;
    if (propertyParam) {
      data = await fetchPropertyDetail(propertyParam, env, user);
    } else {
      data = await fetchPortfolioOverview(env, user);
    }

    return new Response(JSON.stringify(data), { headers });
  } catch (error) {
    console.error('API Error:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
  }
}

// ============================================================================
// SITE HEALTH HANDLER
// ============================================================================

export async function handleSiteHealth(request, env, user) {
  const url = new URL(request.url);
  const domain = url.searchParams.get('domain');

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=60'
  };

  if (!domain) {
    return new Response(JSON.stringify({ error: 'Missing domain parameter' }), { status: 400, headers });
  }

  try {
    if (env.DB) {
      const data = await getActionableDataFromD1(env.DB, domain, user?.userId);
      if (data.hasData) {
        data.robotsTxt = await checkRobotsTxt(domain);
        return new Response(JSON.stringify(data), { headers });
      }
    }

    if (env.SEO_AUDITS) {
      const cacheKey = user?.userId ? `audit:${user.userId}:${domain}` : `audit:${domain}`;
      const cached = await env.SEO_AUDITS.get(cacheKey);
      if (cached) {
        const audit = JSON.parse(cached);
        const robotsTxt = await checkRobotsTxt(domain);
        return new Response(JSON.stringify({
          hasData: true,
          fromCache: true,
          sitemapAudit: audit,
          robotsTxt
        }), { headers });
      }
    }

    // No data yet — use no-cache so refreshes always check
    const noCacheHeaders = { ...headers, 'Cache-Control': 'no-cache' };
    return new Response(JSON.stringify({
      hasData: false,
      message: 'Your audit is running now. Refresh in a moment to see results.',
      robotsTxt: await checkRobotsTxt(domain)
    }), { headers: noCacheHeaders });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
  }
}

// ============================================================================
// CORE WEB VITALS HANDLER
// ============================================================================

export async function handleCoreWebVitals(request, env, user) {
  const url = new URL(request.url);
  const domain = url.searchParams.get('domain');

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600'
  };

  if (!domain) {
    return new Response(JSON.stringify({ error: 'Missing domain parameter' }), { status: 400, headers });
  }

  try {
    const cwv = await fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY);
    return new Response(JSON.stringify(cwv), { headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
  }
}

// ============================================================================
// PERFORMANCE HANDLER
// ============================================================================

export async function handlePerformance(request, env, user) {
  const url = new URL(request.url);
  const propertyId = url.searchParams.get('property');
  const domain = url.searchParams.get('domain');
  const fresh = url.searchParams.get('fresh') === 'true';

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  };

  if (!propertyId || !domain) {
    return new Response(JSON.stringify({ error: 'Missing property or domain' }), { status: 400, headers });
  }

  try {
    let staleCache = null;
    if (!fresh && env.DB) {
      const cached = await getPerformanceFromD1(env.DB, domain, user?.userId);
      if (cached && cached.snapshotDate) {
        const snapshotTime = new Date(cached.snapshotDate + 'T00:00:00Z').getTime();
        const ageHours = (Date.now() - snapshotTime) / (1000 * 60 * 60);
        if (ageHours < 24) {
          // Check if cached data is missing GA4 but property now has GA4 configured
          const cachedMissingGA4 = cached.ga4?.error || !cached.ga4?.sessions;
          let ga4NowConfigured = false;
          if (cachedMissingGA4 && user?.userId) {
            const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
            if (property?.ga4_property_id) {
              ga4NowConfigured = true;
            }
          }
          if (!ga4NowConfigured) {
            return new Response(JSON.stringify({ ...cached, fromCache: true }), { headers });
          }
          // GA4 was recently configured — fall through to live fetch
          staleCache = cached;
        } else {
          staleCache = cached;
        }
      }
    }

    // Resolve credentials: try DB property first, fall back to config.js
    const creds = await resolveCredentials(propertyId, env, user);

    const [cloudflare, ga4, cwv] = await Promise.all([
      fetchCloudflareTraffic(creds.cloudflare, env).catch(e => ({ error: e.message })),
      fetchGA4Analytics(creds.ga4).catch(e => ({ error: e.message })),
      fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY).catch(e => ({ error: e.message }))
    ]);

    const result = {
      cloudflare: cloudflare?.error && staleCache?.cloudflare ? staleCache.cloudflare : cloudflare,
      ga4: ga4?.error && staleCache?.ga4 && !staleCache.ga4.error ? staleCache.ga4 : ga4,
      cwv: cwv?.error && staleCache?.cwv && !staleCache.cwv.error ? staleCache.cwv : cwv,
      fromCache: false,
      partialStale: !!(staleCache && (cloudflare?.error || ga4?.error || cwv?.error))
    };

    // Cache to D1 when we have any useful data (CWV/Lighthouse OR Cloudflare)
    const hasCfData = cloudflare && !cloudflare.error;
    const hasCwvData = cwv && !cwv.error && !cwv.note;
    if (env.DB && (hasCfData || hasCwvData)) {
      try {
        const { endDate: today } = getDateRangePST(0);
        const cf = hasCfData ? cloudflare : {};
        const rs = cf.responseStatus || {};
        const mergedGa4 = ga4?.error ? (staleCache?.ga4 || {}) : ga4;
        const mergedCwv = hasCwvData ? cwv : (staleCache?.cwv && !staleCache.cwv.error ? staleCache.cwv : {});
        // Serialize Lighthouse a11y data if available from fresh CWV fetch
        const a11yJson = (hasCwvData && cwv.accessibility) ? JSON.stringify(cwv.accessibility) : null;
        await env.DB.prepare(`
          INSERT OR REPLACE INTO performance_snapshots (
            domain, snapshot_date, user_id,
            cf_requests, cf_requests_change, cf_bandwidth, cf_cache_ratio, cf_error_rate, cf_threats,
            cf_2xx, cf_3xx, cf_4xx, cf_5xx,
            cwv_lcp, cwv_lcp_rating, cwv_inp, cwv_inp_rating, cwv_cls, cwv_cls_rating,
            cwv_fcp, cwv_fcp_rating, cwv_ttfb, cwv_overall,
            cwv_performance_score, cwv_source, cwv_speed_index, cwv_tested_domain,
            ga4_sessions, ga4_sessions_change, ga4_users, ga4_users_change,
            ga4_bounce_rate, ga4_avg_duration, ga4_engagement_rate, ga4_page_views, ga4_top_pages,
            lighthouse_a11y
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          domain, today, user?.userId || null,
          cf.requests || null,
          parseFloat(cf.requestsChange) || null,
          cf.bandwidth || null,
          parseFloat(cf.cacheRatio) || null,
          parseFloat(cf.errorRate) || null,
          cf.threats || null,
          rs.success || null, rs.redirect || null, rs.clientError || null, rs.serverError || null,
          mergedCwv.LCP || null, mergedCwv.lcpRating || null, mergedCwv.INP || null, mergedCwv.inpRating || null,
          mergedCwv.CLS ?? null, mergedCwv.clsRating || null, mergedCwv.FCP || null, mergedCwv.fcpRating || null,
          mergedCwv.TTFB || null, mergedCwv.overallCategory || null,
          mergedCwv.performanceScore || null, mergedCwv.source || null,
          mergedCwv.speedIndex || null, mergedCwv.testedDomain || null,
          mergedGa4.sessions || null, parseFloat(mergedGa4.sessionsChange) || null,
          mergedGa4.newUsers || null, parseFloat(mergedGa4.newUsersChange) || null,
          parseFloat(mergedGa4.bounceRate) || null, mergedGa4.avgDuration || null,
          parseFloat(mergedGa4.engagementRate) || null, mergedGa4.pageViews || null,
          mergedGa4.topPages ? JSON.stringify(mergedGa4.topPages) : null,
          a11yJson
        ).run();
      } catch(e) {
        console.error('D1 perf cache write error:', e.message);
      }
    }

    return new Response(JSON.stringify(result), { headers });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
  }
}

// ============================================================================
// SEO STATS HANDLER
// ============================================================================

export async function handleSEOStats(domain, env, user) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=60'
  };

  if (!domain || !env.DB) {
    return new Response(JSON.stringify({ hasData: false }), { headers });
  }

  try {
    const { startDate: weekAgo } = getDateRangePST(7);

    // Domain-scoped queries: show audit data for the domain regardless of which user triggered the audit
    const stats = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND fixed_at IS NULL) as open_issues,
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND fixed_at >= ?) as fixed_this_week,
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND first_seen >= ? AND fixed_at IS NULL) as new_this_week,
        (SELECT COUNT(*) FROM broken_links WHERE domain = ? AND fixed_at IS NULL) as broken_links,
        (SELECT audit_date FROM audits WHERE domain = ? ORDER BY audit_date DESC LIMIT 1) as last_audit
    `).bind(
      domain,
      domain, weekAgo,
      domain, weekAgo,
      domain,
      domain
    ).first();

    const topIssues = await env.DB.prepare(`
      SELECT issue_type, severity, COUNT(*) as count,
             SUM(CASE WHEN first_seen >= ? THEN 1 ELSE 0 END) as new_count,
             GROUP_CONCAT(page_url, '|||') as urls,
             GROUP_CONCAT(page_path, '|||') as pages,
             GROUP_CONCAT(id, '|||') as ids,
             GROUP_CONCAT(COALESCE(manually_fixed_at,''), '|||') as manually_fixed_ats,
             GROUP_CONCAT(COALESCE(manually_fixed_by,''), '|||') as manually_fixed_bys,
             GROUP_CONCAT(COALESCE(reactivated_at,''), '|||') as reactivated_ats,
             GROUP_CONCAT(COALESCE(ai_suggestion,''), '|||') as ai_suggestions
      FROM issues
      WHERE domain = ? AND fixed_at IS NULL
      GROUP BY issue_type, severity
      ORDER BY
        CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        count DESC
    `).bind(weekAgo, domain).all();

    const fixedIssues = await env.DB.prepare(`
      SELECT issue_type, severity, COUNT(*) as count, fixed_at,
             GROUP_CONCAT(page_url, '|||') as urls,
             GROUP_CONCAT(page_path, '|||') as pages,
             GROUP_CONCAT(id, '|||') as ids,
             GROUP_CONCAT(COALESCE(manually_fixed_at,''), '|||') as manually_fixed_ats,
             GROUP_CONCAT(COALESCE(manually_fixed_by,''), '|||') as manually_fixed_bys
      FROM issues
      WHERE domain = ? AND fixed_at >= ?
      GROUP BY issue_type, severity
      ORDER BY fixed_at DESC
    `).bind(domain, weekAgo).all();

    // Fetch reactivated issues (were marked complete but came back in a crawl)
    const reactivatedIssues = await env.DB.prepare(`
      SELECT id, issue_type, severity, page_url, page_path, reactivated_at, manually_fixed_at, manually_fixed_by
      FROM issues
      WHERE domain = ? AND reactivated_at IS NOT NULL AND manually_fixed_at IS NOT NULL AND fixed_at IS NULL
      ORDER BY reactivated_at DESC
      LIMIT 20
    `).bind(domain).all();

    return new Response(JSON.stringify({
      hasData: stats?.last_audit ? true : false,
      lastAudit: stats?.last_audit,
      openIssues: stats?.open_issues || 0,
      fixedThisWeek: stats?.fixed_this_week || 0,
      newThisWeek: stats?.new_this_week || 0,
      brokenLinks: stats?.broken_links || 0,
      topIssues: topIssues.results.map(i => ({
        type: i.issue_type, severity: i.severity, count: i.count, newCount: i.new_count,
        message: formatIssueMessage(i.issue_type, i.count),
        urls: i.urls ? i.urls.split('|||') : [],
        pages: i.pages ? i.pages.split('|||') : [],
        ids: i.ids ? i.ids.split('|||').map(Number) : [],
        manuallyFixedAts: i.manually_fixed_ats ? i.manually_fixed_ats.split('|||') : [],
        manuallyFixedBys: i.manually_fixed_bys ? i.manually_fixed_bys.split('|||') : [],
        reactivatedAts: i.reactivated_ats ? i.reactivated_ats.split('|||') : [],
        aiSuggestions: i.ai_suggestions ? i.ai_suggestions.split('|||') : []
      })),
      fixedIssues: fixedIssues.results.map(i => ({
        type: i.issue_type, severity: i.severity, count: i.count,
        message: formatIssueMessage(i.issue_type, i.count),
        urls: i.urls ? i.urls.split('|||').slice(0, 20) : [],
        pages: i.pages ? i.pages.split('|||').slice(0, 20) : [],
        ids: i.ids ? i.ids.split('|||').map(Number) : [],
        manuallyFixedAts: i.manually_fixed_ats ? i.manually_fixed_ats.split('|||') : [],
        manuallyFixedBys: i.manually_fixed_bys ? i.manually_fixed_bys.split('|||') : []
      })),
      reactivatedIssues: (reactivatedIssues.results || []).map(i => ({
        id: i.id, type: i.issue_type, severity: i.severity,
        url: i.page_url, path: i.page_path,
        reactivatedAt: i.reactivated_at, manuallyFixedAt: i.manually_fixed_at,
        manuallyFixedBy: i.manually_fixed_by,
        message: formatIssueMessage(i.issue_type, 1)
      }))
    }), { headers });

  } catch (e) {
    console.error('SEO stats error:', e);
    return new Response(JSON.stringify({ hasData: false, error: e.message }), { headers });
  }
}

// ============================================================================
// ACCESSIBILITY HANDLER
// ============================================================================

export async function handleAccessibility(domain, env, user) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  };

  if (!domain || !env.DB) {
    return new Response(JSON.stringify({ hasData: false }), { headers });
  }

  try {
    const { startDate: weekAgo } = getDateRangePST(7);

    const issues = await env.DB.prepare(`
      SELECT id, issue_type, severity, page_path, page_url, issue_count, first_seen,
             manually_fixed_at, manually_fixed_by, reactivated_at, ai_suggestion
      FROM accessibility_issues
      WHERE domain = ? AND fixed_at IS NULL
      ORDER BY
        CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        issue_type, page_path
    `).bind(domain).all();

    const falsePositiveIds = [];

    const grouped = {};
    for (const row of issues.results || []) {
      let snippets = [];
      if (row.snippets) {
        try { snippets = JSON.parse(row.snippets); } catch(e) {}
      }

      if (row.issue_type === 'empty_buttons' || row.issue_type === 'empty_links') {
        const filtered = snippets.filter(s => !/aria-label/i.test(s) && !/\btitle\s*=/i.test(s));

        if (filtered.length === 0) {
          falsePositiveIds.push(row.id);
          continue;
        }

        if (filtered.length < snippets.length) {
          const ratio = filtered.length / snippets.length;
          row.issue_count = Math.max(1, Math.round((row.issue_count || 1) * ratio));
          snippets = filtered;
        }
      }

      if (!grouped[row.issue_type]) {
        grouped[row.issue_type] = {
          type: row.issue_type, severity: row.severity,
          count: 0, pageCount: 0, newThisWeek: 0, pages: []
        };
      }
      grouped[row.issue_type].count += row.issue_count || 1;
      grouped[row.issue_type].pageCount++;
      if (row.first_seen >= weekAgo) grouped[row.issue_type].newThisWeek++;

      grouped[row.issue_type].pages.push({
        id: row.id, url: row.page_url, path: row.page_path,
        count: row.issue_count || 1, snippets: snippets,
        manuallyFixedAt: row.manually_fixed_at || null,
        manuallyFixedBy: row.manually_fixed_by || null,
        reactivatedAt: row.reactivated_at || null,
        aiSuggestion: row.ai_suggestion || null
      });
    }

    if (falsePositiveIds.length > 0) {
      const { endDate: today } = getDateRangePST(0);
      const BATCH = 50;
      for (let i = 0; i < falsePositiveIds.length; i += BATCH) {
        const batch = falsePositiveIds.slice(i, i + BATCH);
        try {
          const stmts = batch.map(id =>
            env.DB.prepare('UPDATE accessibility_issues SET fixed_at = ? WHERE id = ?').bind(today, id)
          );
          await env.DB.batch(stmts);
        } catch(e) {
          console.error('Auto-cleanup error:', e.message);
        }
      }
      console.log(`handleAccessibility: Auto-cleaned ${falsePositiveIds.length} aria-label false positives for ${domain}`);
    }

    const issueList = Object.values(grouped)
      .filter(g => g.pageCount > 0)
      .map(g => ({ ...g, pages: g.pages.slice(0, 50) }));

    // Fetch Lighthouse accessibility data (cached or fresh)
    let lighthouse = null;
    try {
      lighthouse = await getLighthouseA11y(domain, env, user);
    } catch (e) {
      console.error('Lighthouse a11y fetch error:', e.message);
    }

    // Fetch reactivated a11y issues
    const reactivatedA11y = await env.DB.prepare(`
      SELECT id, issue_type, severity, page_url, page_path, reactivated_at, manually_fixed_at, manually_fixed_by
      FROM accessibility_issues
      WHERE domain = ? AND reactivated_at IS NOT NULL AND manually_fixed_at IS NOT NULL AND fixed_at IS NULL
      ORDER BY reactivated_at DESC
      LIMIT 20
    `).bind(domain).all();

    return new Response(JSON.stringify({
      hasData: issueList.length > 0 || (lighthouse && lighthouse.score !== null),
      issues: issueList,
      lighthouse,
      reactivatedIssues: (reactivatedA11y.results || []).map(i => ({
        id: i.id, type: i.issue_type, severity: i.severity,
        url: i.page_url, path: i.page_path,
        reactivatedAt: i.reactivated_at, manuallyFixedAt: i.manually_fixed_at,
        manuallyFixedBy: i.manually_fixed_by
      }))
    }), { headers });

  } catch (e) {
    console.error('Accessibility error:', e);
    return new Response(JSON.stringify({ hasData: false, error: e.message }), { headers });
  }
}

// ============================================================================
// AI READINESS HANDLER
// ============================================================================

export async function handleAIReadiness(domain, env, user) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  };

  if (!domain || !env.DB) {
    return new Response(JSON.stringify({ hasData: false }), { headers });
  }

  try {
    const { startDate: weekAgo } = getDateRangePST(7);

    // Domain-level data
    const domainData = await env.DB.prepare(`
      SELECT * FROM ai_readiness WHERE domain = ? ORDER BY audit_date DESC LIMIT 1
    `).bind(domain).first();

    // Page-level issues
    const issues = await env.DB.prepare(`
      SELECT id, issue_type, severity, page_path, page_url, details, first_seen,
             manually_fixed_at, manually_fixed_by, reactivated_at, ai_suggestion
      FROM ai_readiness_issues
      WHERE domain = ? AND fixed_at IS NULL
      ORDER BY
        CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        issue_type, page_path
    `).bind(domain).all();

    const grouped = {};
    for (const row of issues.results || []) {
      if (!grouped[row.issue_type]) {
        grouped[row.issue_type] = {
          type: row.issue_type, severity: row.severity,
          count: 0, pageCount: 0, newThisWeek: 0, pages: []
        };
      }
      grouped[row.issue_type].pageCount++;
      grouped[row.issue_type].count++;
      if (row.first_seen >= weekAgo) grouped[row.issue_type].newThisWeek++;

      let details = {};
      if (row.details) { try { details = JSON.parse(row.details); } catch(e) {} }

      grouped[row.issue_type].pages.push({
        id: row.id, url: row.page_url, path: row.page_path,
        details,
        manuallyFixedAt: row.manually_fixed_at || null,
        manuallyFixedBy: row.manually_fixed_by || null,
        reactivatedAt: row.reactivated_at || null,
        aiSuggestion: row.ai_suggestion || null
      });
    }

    const issueList = Object.values(grouped)
      .filter(g => g.pageCount > 0)
      .map(g => ({ ...g, pages: g.pages.slice(0, 50) }));

    // Reactivated issues
    const reactivated = await env.DB.prepare(`
      SELECT id, issue_type, severity, page_url, page_path, reactivated_at, manually_fixed_at, manually_fixed_by
      FROM ai_readiness_issues
      WHERE domain = ? AND reactivated_at IS NOT NULL AND manually_fixed_at IS NOT NULL AND fixed_at IS NULL
      ORDER BY reactivated_at DESC LIMIT 20
    `).bind(domain).all();

    // Parse domain checks
    let domainChecks = null;
    if (domainData) {
      let aiBotRules = {};
      try { aiBotRules = JSON.parse(domainData.ai_bot_rules || '{}'); } catch(e) {}
      domainChecks = {
        llmsTxt: { exists: !!domainData.llms_txt_exists, quality: domainData.llms_txt_quality || 'missing' },
        llmsFullTxt: { exists: !!domainData.llms_full_txt_exists },
        aiBotRules,
        botsBlocked: domainData.ai_bots_blocked || 0,
        botsAllowed: domainData.ai_bots_allowed || 0,
      };
    }

    // ---- Answer Engine Optimization (AEO) signal breakdown ----
    // Derived from the same audit data, framed for AI answer engines
    // (ChatGPT, Perplexity, Google AI Overviews, Claude).
    const schemaDepth = domainData?.schema_depth_avg || 0;
    const contentClarity = domainData?.content_clarity_avg || 0;
    const csrPages = domainData?.csr_pages || 0;
    const faqOpp = domainData?.faq_opportunity_pages || 0;
    const botsBlocked = domainChecks?.botsBlocked || 0;
    const botsAllowed = domainChecks?.botsAllowed || 0;
    const llmsExists = !!(domainChecks && domainChecks.llmsTxt && domainChecks.llmsTxt.exists);

    const aeoSignals = [
      {
        key: 'llms_txt',
        label: 'llms.txt file',
        status: llmsExists ? (domainChecks.llmsTxt.quality === 'good' ? 'good' : 'warning') : 'bad',
        detail: llmsExists
          ? `Present (${domainChecks.llmsTxt.quality}). Gives AI answer engines a curated map of your content.`
          : 'Missing. Add /llms.txt so AI answer engines can discover and summarize your site.'
      },
      {
        key: 'ai_crawlers',
        label: 'AI crawler access',
        status: botsBlocked === 0 ? 'good' : botsBlocked >= botsAllowed ? 'bad' : 'warning',
        detail: botsBlocked === 0
          ? 'All known AI crawlers are allowed in robots.txt.'
          : `${botsBlocked} AI crawler(s) blocked. Blocked bots cannot cite your content in AI answers.`
      },
      {
        key: 'structured_data',
        label: 'Structured data depth',
        status: schemaDepth >= 50 ? 'good' : schemaDepth >= 20 ? 'warning' : 'bad',
        detail: `Average ${Math.round(schemaDepth)}% schema field coverage. Rich schema helps AI engines understand and quote your content accurately.`
      },
      {
        key: 'faq_schema',
        label: 'FAQ / Q&A markup',
        status: faqOpp === 0 ? 'good' : 'warning',
        detail: faqOpp === 0
          ? 'No pages with unmarked FAQ content detected.'
          : `${faqOpp} page(s) have Q&A content without FAQPage schema — a missed answer-engine opportunity.`
      },
      {
        key: 'content_clarity',
        label: 'Content clarity',
        status: contentClarity >= 50 ? 'good' : contentClarity >= 30 ? 'warning' : 'bad',
        detail: `${Math.round(contentClarity)}% content-to-boilerplate ratio. Higher means AI engines extract your actual answers, not navigation.`
      },
      {
        key: 'server_rendered',
        label: 'Server-rendered content',
        status: csrPages === 0 ? 'good' : 'bad',
        detail: csrPages === 0
          ? 'Content is present in initial HTML — readable by AI crawlers.'
          : `${csrPages} page(s) rely on client-side rendering. Most AI crawlers cannot run JavaScript and will see an empty page.`
      }
    ];
    const aeoPassing = aeoSignals.filter(s => s.status === 'good').length;

    // ---- Per-engine AI visibility readiness ----
    // An honest composite of what we can actually measure: can this engine's
    // crawler reach the site, and how digestible is the content once it does.
    // This is visibility *readiness*, not a claim about actual rankings.
    const botRules = domainChecks?.aiBotRules || {};
    const engineDefs = [
      { key: 'chatgpt', name: 'ChatGPT', vendor: 'OpenAI', bot: 'GPTBot' },
      { key: 'claude', name: 'Claude', vendor: 'Anthropic', bot: 'ClaudeBot' },
      { key: 'perplexity', name: 'Perplexity', vendor: 'Perplexity AI', bot: 'PerplexityBot' },
      { key: 'gemini', name: 'Gemini / AI Overviews', vendor: 'Google', bot: 'Google-Extended' },
      { key: 'apple', name: 'Apple Intelligence', vendor: 'Apple', bot: 'Applebot-Extended' }
    ];
    const llmsPts = llmsExists ? (domainChecks.llmsTxt.quality === 'good' ? 20 : 10) : 0;
    const schemaPts = Math.round((Math.min(100, schemaDepth) / 100) * 20);
    const ssrPts = csrPages === 0 ? 20 : Math.max(0, 20 - csrPages * 4);
    const aiVisibility = engineDefs.map(e => {
      const access = botRules[e.bot] || 'unknown';
      const accessPts = access === 'allowed' ? 40 : access === 'unknown' ? 25 : 0;
      const score = Math.min(100, accessPts + llmsPts + schemaPts + ssrPts);
      return {
        engine: e.name, vendor: e.vendor, bot: e.bot,
        access,
        score,
        rating: score >= 70 ? 'good' : score >= 40 ? 'warning' : 'bad'
      };
    });

    return new Response(JSON.stringify({
      aiVisibility,
      hasData: !!domainData || issueList.length > 0,
      score: domainData?.ai_readiness_score || 0,
      schemaDepthAvg: domainData?.schema_depth_avg || 0,
      contentClarityAvg: domainData?.content_clarity_avg || 0,
      csrPages: domainData?.csr_pages || 0,
      faqOpportunityPages: domainData?.faq_opportunity_pages || 0,
      aeoSignals,
      aeoPassing,
      aeoTotal: aeoSignals.length,
      domainChecks,
      issues: issueList,
      reactivatedIssues: (reactivated.results || []).map(i => ({
        id: i.id, type: i.issue_type, severity: i.severity,
        url: i.page_url, path: i.page_path,
        reactivatedAt: i.reactivated_at, manuallyFixedAt: i.manually_fixed_at,
        manuallyFixedBy: i.manually_fixed_by
      }))
    }), { headers });

  } catch (e) {
    console.error('AI Readiness error:', e);
    return new Response(JSON.stringify({ hasData: false, error: e.message }), { headers });
  }
}

/**
 * Get Lighthouse accessibility data — from D1 cache or fresh PSI API call.
 */
async function getLighthouseA11y(domain, env, user) {
  // Check D1 cache first (from performance_snapshots) — domain-scoped
  if (env.DB) {
    try {
      const row = await env.DB.prepare(`
        SELECT lighthouse_a11y, snapshot_date FROM performance_snapshots
        WHERE domain = ? AND lighthouse_a11y IS NOT NULL
        ORDER BY snapshot_date DESC LIMIT 1
      `).bind(domain).first();

      if (row?.lighthouse_a11y) {
        const snapshotTime = new Date(row.snapshot_date + 'T00:00:00Z').getTime();
        const ageHours = (Date.now() - snapshotTime) / (1000 * 60 * 60);
        if (ageHours < 24) {
          const cached = JSON.parse(row.lighthouse_a11y);
          cached.fromCache = true;
          cached.snapshotDate = row.snapshot_date;
          return cached;
        }
      }
    } catch (e) {
      console.error('Lighthouse a11y cache read error:', e.message);
    }
  }

  // No cache — make a fresh PSI API call for accessibility
  if (!env.PAGESPEED_API_KEY) {
    return null;
  }

  try {
    const psiResult = await fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY);
    if (psiResult?.accessibility) {
      // Cache the result in performance_snapshots
      if (env.DB && psiResult.accessibility) {
        const { endDate: today } = getDateRangePST(0);
        try {
          await env.DB.prepare(`
            UPDATE performance_snapshots SET lighthouse_a11y = ?
            WHERE domain = ? AND snapshot_date = ?
          `).bind(JSON.stringify(psiResult.accessibility), domain, today).run();
        } catch(e) {
          // If no row exists yet, insert a minimal one
          try {
            await env.DB.prepare(`
              INSERT OR REPLACE INTO performance_snapshots (domain, snapshot_date, user_id, lighthouse_a11y)
              VALUES (?, ?, ?, ?)
            `).bind(domain, today, user?.userId || null, JSON.stringify(psiResult.accessibility)).run();
          } catch(e2) { /* ignore */ }
        }
      }
      return psiResult.accessibility;
    }
  } catch (e) {
    console.error('Lighthouse a11y fresh fetch error:', e.message);
  }

  return null;
}

// ============================================================================
// KEYWORDS HANDLER
// ============================================================================

export async function handleKeywords(domain, env, user) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  };

  if (!domain || !env.DB) {
    return new Response(JSON.stringify({ hasData: false }), { headers });
  }

  try {
    const keywords = await env.DB.prepare(`
      SELECT query, clicks, impressions, ctr, position, prev_position, position_change, data_date
      FROM keywords
      WHERE domain = ? AND data_date = (SELECT MAX(data_date) FROM keywords WHERE domain = ?)
      ORDER BY clicks DESC
      LIMIT 30
    `).bind(domain, domain).all();

    const opportunities = await env.DB.prepare(`
      SELECT query, clicks, impressions, ctr, position, prev_position, position_change
      FROM keywords
      WHERE domain = ?
        AND data_date = (SELECT MAX(data_date) FROM keywords WHERE domain = ?)
        AND position >= 5
        AND position <= 30
        AND impressions >= 50
      ORDER BY impressions DESC
      LIMIT 50
    `).bind(domain, domain).all();

    if (!keywords.results?.length) {
      return new Response(JSON.stringify({ hasData: false }), { headers });
    }

    const filteredOpportunities = (opportunities.results || [])
      .map(k => {
        const positionGap = k.position - 3;
        const potential = Math.round(k.impressions * (positionGap / 10));
        return {
          query: k.query, clicks: k.clicks, impressions: k.impressions,
          ctr: (k.ctr * 100).toFixed(1) + '%',
          position: k.position.toFixed(1),
          positionChange: k.position_change, potential,
          tip: k.position <= 10
            ? 'Page 1 - optimize for top 3'
            : k.position <= 20
              ? 'Page 2 - push to page 1'
              : 'Page 3 - needs content focus'
        };
      })
      .sort((a, b) => b.potential - a.potential)
      .slice(0, 10);

    return new Response(JSON.stringify({
      hasData: true,
      dataDate: keywords.results[0]?.data_date,
      keywords: keywords.results.map(k => ({
        query: k.query, clicks: k.clicks, impressions: k.impressions,
        ctr: (k.ctr * 100).toFixed(1) + '%',
        position: k.position.toFixed(1),
        prevPosition: k.prev_position ? k.prev_position.toFixed(1) : null,
        positionChange: k.position_change
      })),
      opportunities: filteredOpportunities
    }), { headers });

  } catch (e) {
    console.error('Keywords error:', e);
    return new Response(JSON.stringify({ hasData: false, error: e.message }), { headers });
  }
}

// ============================================================================
// 404 ERRORS HANDLER
// ============================================================================

export async function handle404Errors(propertyId, env, user) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  };

  if (!propertyId) {
    return new Response(JSON.stringify({ hasData: false, error: 'Missing property ID' }), { headers });
  }

  try {
    // Try DB-based credential resolution first
    let zoneId = null;
    let apiToken = env.CLOUDFLARE_API_TOKEN;

    if (env.DB && user?.userId) {
      const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
      if (property) {
        const creds = await getPropertyCredentials(property, env);
        zoneId = creds.cloudflare.zoneIds?.[0];
        apiToken = creds.cloudflare.apiToken;
      }
    }

    // Fall back to env var lookup for legacy data
    if (!zoneId) {
      const zoneIds = env[`${propertyId}_CF_ZONE_IDS`] || env[`${propertyId.toUpperCase()}_CF_ZONE_IDS`];
      if (zoneIds) {
        zoneId = zoneIds.split(',')[0].trim();
      }
    }

    if (!zoneId || !apiToken) {
      return new Response(JSON.stringify({ hasData: false, error: 'Cloudflare not configured for this property' }), { headers });
    }

    const { startDate, endDate } = getDateRangePST(7);

    const query = `
      query {
        viewer {
          zones(filter: {zoneTag: "${zoneId}"}) {
            httpRequests1dGroups(
              filter: {date_geq: "${startDate}", date_leq: "${endDate}"}
              limit: 100
              orderBy: [sum_requests_DESC]
            ) {
              dimensions { clientRequestPath }
              sum { requests pageViews edgeResponseStatus404 }
            }
          }
        }
      }
    `;

    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });

    const data = await response.json();
    const groups = data?.data?.viewer?.zones?.[0]?.httpRequests1dGroups || [];

    const error404s = [];
    for (const g of groups) {
      const count404 = g.sum?.edgeResponseStatus404 || 0;
      if (count404 > 0) {
        error404s.push({
          path: g.dimensions?.clientRequestPath || '/',
          count: count404,
          totalRequests: g.sum?.requests || 0
        });
      }
    }

    error404s.sort((a, b) => b.count - a.count);

    return new Response(JSON.stringify({
      hasData: error404s.length > 0,
      period: `${startDate} to ${endDate}`,
      total404s: error404s.reduce((s, e) => s + e.count, 0),
      errors: error404s.slice(0, 50)
    }), { headers });

  } catch (e) {
    console.error('404 errors fetch error:', e);
    return new Response(JSON.stringify({ hasData: false, error: e.message }), { headers });
  }
}

// ============================================================================
// PERFORMANCE HISTORY HANDLER
// ============================================================================

export async function handlePerformanceHistory(env, user) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  };

  if (!env.DB) {
    return new Response(JSON.stringify({ hasData: false }), { headers });
  }

  try {
    const { startDate, endDate } = getDateRangePST(7);
    const userId = user?.userId;

    let history;
    if (userId) {
      history = await env.DB.prepare(`
        SELECT domain, date, lcp_ms, fcp_ms, cls, inp_ms, ttfb_ms
        FROM performance_history
        WHERE date >= ? AND date <= ? AND (user_id = ? OR user_id IS NULL)
        ORDER BY date ASC
      `).bind(startDate, endDate, userId).all();
    } else {
      history = await env.DB.prepare(`
        SELECT domain, date, lcp_ms, fcp_ms, cls, inp_ms, ttfb_ms
        FROM performance_history
        WHERE date >= ? AND date <= ?
        ORDER BY date ASC
      `).bind(startDate, endDate).all();
    }

    // Filter to only domains owned by this user
    let userDomains = null;
    if (userId && env.DB) {
      const props = await getUserProperties(userId, env.DB);
      userDomains = new Set(props.map(p => p.domain));
    }

    const byDomain = {};
    for (const row of history.results || []) {
      if (userDomains && !userDomains.has(row.domain)) continue;

      if (!byDomain[row.domain]) {
        byDomain[row.domain] = [];
      }
      byDomain[row.domain].push({
        date: row.date, lcp: row.lcp_ms, fcp: row.fcp_ms,
        cls: row.cls, inp: row.inp_ms, ttfb: row.ttfb_ms
      });
    }

    return new Response(JSON.stringify({
      hasData: Object.keys(byDomain).length > 0,
      startDate,
      endDate,
      history: byDomain
    }), { headers });

  } catch (e) {
    console.error('Performance history error:', e);
    return new Response(JSON.stringify({ hasData: false, error: e.message }), { headers });
  }
}

// ============================================================================
// ALL FIXED ISSUES HANDLER
// ============================================================================

export async function handleAllFixedIssues(env, user) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  };

  if (!env.DB) {
    return new Response(JSON.stringify({ hasData: false }), { headers });
  }

  try {
    const allFixed = await env.DB.prepare(`
      SELECT domain, issue_type, severity, page_path, page_url, first_seen, fixed_at, 'SEO' as category
      FROM issues WHERE fixed_at IS NOT NULL
      UNION ALL
      SELECT domain, issue_type, severity, page_path, page_url, first_seen, fixed_at, 'Accessibility' as category
      FROM accessibility_issues WHERE fixed_at IS NOT NULL
      ORDER BY fixed_at DESC
      LIMIT 500
    `).bind().all();

    return new Response(JSON.stringify({
      hasData: (allFixed.results?.length || 0) > 0,
      totalFixed: allFixed.results?.length || 0,
      issues: allFixed.results || []
    }), { headers });

  } catch (e) {
    console.error('All fixed issues error:', e);
    return new Response(JSON.stringify({ hasData: false, error: e.message }), { headers });
  }
}

// ============================================================================
// STORE PERFORMANCE SNAPSHOT HANDLER
// ============================================================================

export async function storePerformanceSnapshot(env, user) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  if (!env.DB) {
    return new Response(JSON.stringify({ success: false, error: 'DB not configured' }), { headers });
  }

  const { endDate: today } = getDateRangePST(0);
  const results = [];

  // Get properties from DB if user is provided, else fall back to legacy config
  let properties = [];
  if (user?.userId && env.DB) {
    const userProps = await getUserProperties(user.userId, env.DB);
    properties = userProps.map(p => ({ domain: p.domain, propertyId: p.id, userId: user.userId }));
  } else {
    // Legacy: use hardcoded domain map
    const domainMap = {
      'viansa.com': 'viansa',
      'kunde.com': 'kunde',
      'brcohn.com': 'brcohn',
      'clospegase.com': 'clospegase',
      'girardwinery.com': 'girard',
      'adairfamilywines.com': 'adair'
    };
    properties = Object.entries(domainMap).map(([domain, propertyId]) => ({
      domain, propertyId, userId: null
    }));
  }

  for (const prop of properties) {
    try {
      const cwv = await fetchPageSpeedInsights(prop.domain, env.PAGESPEED_API_KEY);

      if (cwv && !cwv.error) {
        await env.DB.prepare(`
          INSERT INTO performance_history (domain, date, lcp_ms, fcp_ms, cls, inp_ms, ttfb_ms, recorded_at, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(domain, date) DO UPDATE SET
            lcp_ms = excluded.lcp_ms, fcp_ms = excluded.fcp_ms, cls = excluded.cls,
            inp_ms = excluded.inp_ms, ttfb_ms = excluded.ttfb_ms, recorded_at = excluded.recorded_at
        `).bind(
          prop.domain, today,
          cwv.LCP || null, cwv.FCP || null, cwv.CLS || null,
          cwv.INP || null, cwv.TTFB || null,
          new Date().toISOString(),
          prop.userId
        ).run();
      }

      await fetchAndStorePerformance(env, prop.domain, prop.propertyId, today, prop.userId);

      results.push({ domain: prop.domain, success: true, lcp: cwv?.LCP, snapshotStored: true });
    } catch (e) {
      results.push({ domain: prop.domain, success: false, error: e.message });
    }
  }

  return new Response(JSON.stringify({
    success: true,
    date: today,
    results
  }), { headers });
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Resolve credentials for a property.
 * Tries DB-based lookup first (multi-tenant), falls back to config.js (legacy).
 */
async function resolveCredentials(propertyId, env, user) {
  // Try DB lookup first
  if (env.DB && user?.userId) {
    const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
    if (property) {
      return await getPropertyCredentials(property, env);
    }
  }

  // Fall back to legacy config.js
  try {
    return getCredentials(propertyId, env);
  } catch (e) {
    // If property isn't in legacy config either, return empty creds
    return {
      cloudflare: { apiToken: env.CLOUDFLARE_API_TOKEN, zoneIds: [] },
      searchConsole: { properties: [], credentials: env.GOOGLE_SERVICE_ACCOUNT },
      ga4: { propertyId: null, credentials: env.GOOGLE_SERVICE_ACCOUNT }
    };
  }
}

async function getActionableDataFromD1(db, domain, userId) {
  const { startDate: weekAgo, endDate: today } = getDateRangePST(7);

  const latestAudit = await db.prepare(`
    SELECT audit_date, total_pages, pages_audited, duration_seconds
    FROM audits WHERE domain = ? ORDER BY audit_date DESC LIMIT 1
  `).bind(domain).first();

  if (!latestAudit) {
    return { hasData: false };
  }

  const openIssues = await db.prepare(`
    SELECT issue_type, severity, COUNT(*) as count,
           GROUP_CONCAT(page_url, '|||') as urls,
           GROUP_CONCAT(page_path, '|||') as paths,
           GROUP_CONCAT(COALESCE(details, ''), '|||') as all_details,
           GROUP_CONCAT(COALESCE(ai_suggestion, ''), '|||') as ai_suggestions,
           MIN(first_seen) as oldest,
           SUM(CASE WHEN first_seen >= ? THEN 1 ELSE 0 END) as new_this_week
    FROM issues
    WHERE domain = ? AND fixed_at IS NULL
    GROUP BY issue_type, severity
    ORDER BY
      CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      count DESC
  `).bind(weekAgo, domain).all();

  const fixedThisWeek = await db.prepare(`
    SELECT COUNT(*) as count FROM issues
    WHERE domain = ? AND fixed_at >= ?
  `).bind(domain, weekAgo).first();

  const newThisWeek = await db.prepare(`
    SELECT COUNT(*) as count FROM issues
    WHERE domain = ? AND first_seen >= ? AND fixed_at IS NULL
  `).bind(domain, weekAgo).first();

  const brokenLinks = await db.prepare(`
    SELECT link_url, link_path, status_code, first_seen, source_path,
           CASE WHEN first_seen >= ? THEN 1 ELSE 0 END as is_new
    FROM broken_links
    WHERE domain = ? AND fixed_at IS NULL
    ORDER BY first_seen DESC
    LIMIT 25
  `).bind(weekAgo, domain).all();

  const brokenCount = await db.prepare(`
    SELECT COUNT(*) as count FROM broken_links WHERE domain = ? AND fixed_at IS NULL
  `).bind(domain).first();

  const progress = await db.prepare(`
    SELECT
      strftime('%Y-%W', audit_date) as week,
      MAX(audit_date) as date,
      (SELECT COUNT(*) FROM issues WHERE domain = ? AND first_seen <= MAX(a.audit_date) AND (fixed_at IS NULL OR fixed_at > MAX(a.audit_date))) as open_issues
    FROM audits a
    WHERE domain = ? AND audit_date >= date('now', '-28 days')
    GROUP BY week
    ORDER BY week
  `).bind(domain, domain).all();

  const actionItems = openIssues.results.map(i => {
    const paths = i.paths ? i.paths.split('|||').slice(0, 100) : [];
    const urls = i.urls ? i.urls.split('|||').slice(0, 100) : [];
    const details = i.all_details ? i.all_details.split('|||').slice(0, 100) : [];
    const aiSuggs = i.ai_suggestions ? i.ai_suggestions.split('|||').slice(0, 100) : [];
    const hasValues = ['short_title', 'short_description'].includes(i.issue_type);
    let pages;
    if (hasValues && details.length > 0) {
      const label = i.issue_type === 'short_title' ? 'Title' : 'Description';
      pages = paths.map((p, idx) => {
        let snippet = null;
        try {
          const d = details[idx] ? JSON.parse(details[idx]) : null;
          if (d && d.value) snippet = `Current ${label} (${d.length} chars): "${d.value}"`;
        } catch(e) {}
        return { path: p, url: urls[idx] || '', snippets: snippet ? [snippet] : [], aiSuggestion: aiSuggs[idx] || null };
      });
    } else {
      pages = paths.map((p, idx) => ({ path: p, url: urls[idx] || '', snippets: [], aiSuggestion: aiSuggs[idx] || null }));
    }
    return {
      type: i.issue_type, severity: i.severity, count: i.count,
      newThisWeek: i.new_this_week,
      message: formatIssueMessage(i.issue_type, i.count),
      urls, pages
    };
  });

  const totalOpen = openIssues.results.reduce((sum, i) => sum + i.count, 0);

  return {
    hasData: true, fromD1: true,
    lastAudit: {
      date: latestAudit.audit_date,
      totalPages: latestAudit.total_pages,
      pagesAudited: latestAudit.pages_audited,
      duration: latestAudit.duration_seconds
    },
    summary: {
      totalOpenIssues: totalOpen,
      fixedThisWeek: fixedThisWeek?.count || 0,
      newThisWeek: newThisWeek?.count || 0,
      brokenLinks: brokenCount?.count || 0
    },
    actionItems,
    brokenLinks: brokenLinks.results.map(b => ({
      url: b.link_url, path: b.link_path, status: b.status_code,
      source: b.source_path, isNew: b.is_new === 1
    })),
    progress: progress.results.map(p => ({
      week: p.week, date: p.date, openIssues: p.open_issues
    }))
  };
}

async function getPerformanceFromD1(db, domain, userId) {
  try {
    // Domain-scoped: show performance data regardless of which user triggered the snapshot
    const row = await db.prepare(`
      SELECT * FROM performance_snapshots
      WHERE domain = ?
      ORDER BY snapshot_date DESC
      LIMIT 1
    `).bind(domain).first();

    if (!row) return null;

    // Cloudflare: return error if no CF data was cached (user has no CF integration)
    const hasCfData = row.cf_requests !== null && row.cf_requests !== undefined;
    const cloudflare = hasCfData ? {
      requests: row.cf_requests,
      requestsChange: row.cf_requests_change?.toFixed(1) || '0.0',
      bandwidth: row.cf_bandwidth,
      cacheRatio: row.cf_cache_ratio?.toFixed(1) || '0.0',
      errorRate: row.cf_error_rate?.toFixed(2) || '0.00',
      threats: row.cf_threats,
      responseStatus: {
        success: row.cf_2xx || 0, redirect: row.cf_3xx || 0,
        clientError: row.cf_4xx || 0, serverError: row.cf_5xx || 0
      }
    } : { error: 'Cloudflare not configured' };

    // GA4: return error if no GA4 data was cached
    const ga4 = row.ga4_sessions ? {
      sessions: row.ga4_sessions,
      sessionsChange: row.ga4_sessions_change?.toFixed(1) || '0.0',
      newUsers: row.ga4_users || 0,
      newUsersChange: row.ga4_users_change?.toFixed(1) || '0.0',
      bounceRate: row.ga4_bounce_rate?.toFixed(1) || '0.0',
      avgDuration: row.ga4_avg_duration || '0s',
      avgDurationSec: 0,
      engagementRate: row.ga4_engagement_rate?.toFixed(1) || '0.0',
      pageViews: row.ga4_page_views,
      topPages: row.ga4_top_pages ? JSON.parse(row.ga4_top_pages) : []
    } : { error: 'GA4 not configured' };

    // CWV: include Lighthouse-specific fields (performanceScore, source, speedIndex)
    const cwv = row.cwv_lcp ? {
      LCP: row.cwv_lcp, lcpRating: row.cwv_lcp_rating,
      INP: row.cwv_inp, inpRating: row.cwv_inp_rating,
      CLS: row.cwv_cls, clsRating: row.cwv_cls_rating,
      FCP: row.cwv_fcp, fcpRating: row.cwv_fcp_rating,
      TTFB: row.cwv_ttfb, overallCategory: row.cwv_overall,
      performanceScore: row.cwv_performance_score || null,
      source: row.cwv_source || null,
      speedIndex: row.cwv_speed_index || null,
      testedDomain: row.cwv_tested_domain || null
    } : { error: 'No CWV data' };

    return { cloudflare, ga4, cwv, snapshotDate: row.snapshot_date };
  } catch (e) {
    console.error('D1 performance cache error:', e);
    return null;
  }
}

async function fetchPortfolioOverview(env, user) {
  // Multi-tenant: load properties from DB
  if (env.DB && user?.userId) {
    const userProps = await getUserProperties(user.userId, env.DB);

    if (userProps.length === 0) {
      return {
        type: 'overview',
        generatedAt: new Date().toISOString(),
        portfolio: { totalClicks: 0, totalImpressions: 0, totalRequests: 0, totalThreats: 0, issueCount: 0 },
        properties: [],
        isEmpty: true
      };
    }

    const results = await Promise.all(
      userProps.map(async (prop) => {
        try {
          const seoStats = await getSEOStatsFromD1(env.DB, prop.domain, user.userId);
          return {
            id: prop.id,
            name: prop.name,
            shortName: prop.name,
            color: prop.color,
            domain: prop.domain,
            healthStatus: seoStats ? (seoStats.openIssues > 10 ? 'warning' : 'healthy') : 'unknown',
            metrics: {
              requests: 0, cacheHitRatio: 'N/A', threatsBlocked: 0,
              clicks: 0, impressions: 0, ctr: 'N/A', position: 'N/A'
            },
            seoStats,
            integrations: {
              google: !!prop.google_refresh_token_encrypted,
              cloudflare: !!prop.cf_api_token_encrypted || !!prop.cf_zone_ids
            }
          };
        } catch (error) {
          return { id: prop.id, error: error.message, name: prop.name };
        }
      })
    );

    const totals = results.reduce((acc, prop) => {
      if (!prop.error && prop.seoStats) {
        acc.issueCount += prop.seoStats.openIssues || 0;
      }
      return acc;
    }, { totalClicks: 0, totalImpressions: 0, totalRequests: 0, totalThreats: 0, issueCount: 0 });

    return { type: 'overview', generatedAt: new Date().toISOString(), portfolio: totals, properties: results };
  }

  // Legacy: use hardcoded PROPERTIES
  const results = await Promise.all(
    PROPERTY_IDS.map(async (id) => {
      try {
        return { id, ...(await fetchPropertySummary(id, env)) };
      } catch (error) {
        return { id, error: error.message, name: PROPERTIES[id]?.name };
      }
    })
  );

  const totals = results.reduce((acc, prop) => {
    if (!prop.error && prop.metrics) {
      acc.totalClicks += prop.metrics.clicks || 0;
      acc.totalImpressions += prop.metrics.impressions || 0;
      acc.totalRequests += prop.metrics.requests || 0;
      acc.totalThreats += prop.metrics.threatsBlocked || 0;
      acc.issueCount += prop.issues?.length || 0;
    }
    return acc;
  }, { totalClicks: 0, totalImpressions: 0, totalRequests: 0, totalThreats: 0, issueCount: 0 });

  return { type: 'overview', generatedAt: new Date().toISOString(), portfolio: totals, properties: results };
}

async function fetchPropertySummary(propertyId, env) {
  const property = PROPERTIES[propertyId];
  if (!property) throw new Error(`Unknown property: ${propertyId}`);

  const creds = getCredentials(propertyId, env);

  const [cloudflare, searchConsole] = await Promise.all([
    fetchCloudflareSummary(creds.cloudflare),
    fetchSearchConsoleSummary(creds.searchConsole)
  ]);

  const issues = generateIssues({ cloudflare, searchConsole });
  const healthStatus = issues.length === 0 ? 'healthy'
    : issues.some(i => i.priority === 'CRITICAL') ? 'critical'
    : issues.some(i => i.priority === 'HIGH') ? 'warning' : 'info';

  return {
    name: property.name, shortName: property.shortName, color: property.color,
    healthStatus,
    metrics: {
      requests: cloudflare.totalRequests || 0,
      cacheHitRatio: cloudflare.cacheHitRatio,
      threatsBlocked: cloudflare.threatsBlocked || 0,
      clicks: searchConsole.clicks || 0,
      impressions: searchConsole.impressions || 0,
      ctr: searchConsole.ctr,
      position: searchConsole.position
    },
    issues
  };
}

async function fetchPropertyDetail(propertyId, env, user) {
  // Multi-tenant: look up property from DB
  if (env.DB && user?.userId) {
    const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
    if (property) {
      const seoStats = await getSEOStatsFromD1(env.DB, property.domain, user.userId);
      return {
        type: 'detail', propertyId: property.id,
        property: { name: property.name, shortName: property.name, color: property.color, domain: property.domain },
        generatedAt: new Date().toISOString(),
        seoStats
      };
    }
  }

  // Legacy fallback
  const property = PROPERTIES[propertyId];
  if (!property) throw new Error(`Unknown property: ${propertyId}`);

  const seoStats = env.DB ? await getSEOStatsFromD1(env.DB, property.domain) : null;

  return {
    type: 'detail', propertyId,
    property: { name: property.name, shortName: property.shortName, color: property.color, domain: property.domain },
    generatedAt: new Date().toISOString(),
    seoStats
  };
}

export async function fetchCloudflareData(propertyId, env, user) {
  // Multi-tenant
  if (env.DB && user?.userId) {
    const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
    if (property) {
      const creds = await getPropertyCredentials(property, env);
      return await fetchCloudflareDetail(creds.cloudflare, env);
    }
  }

  // Legacy
  const property = PROPERTIES[propertyId];
  if (!property) throw new Error(`Unknown property: ${propertyId}`);

  const creds = getCredentials(propertyId, env);
  return await fetchCloudflareDetail(creds.cloudflare, env);
}

export async function fetchSearchConsoleData(propertyId, env, user) {
  // Multi-tenant
  if (env.DB && user?.userId) {
    const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
    if (property) {
      const creds = await getPropertyCredentials(property, env);
      return await fetchSearchConsoleDetail(creds.searchConsole);
    }
  }

  // Legacy
  const property = PROPERTIES[propertyId];
  if (!property) throw new Error(`Unknown property: ${propertyId}`);

  const creds = getCredentials(propertyId, env);
  return await fetchSearchConsoleDetail(creds.searchConsole);
}

async function getSEOStatsFromD1(db, domain, userId) {
  try {
    const { startDate: weekAgo } = getDateRangePST(7);

    const stats = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND fixed_at IS NULL) as open_issues,
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND fixed_at >= ?) as fixed_this_week,
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND first_seen >= ? AND fixed_at IS NULL) as new_this_week,
        (SELECT COUNT(*) FROM broken_links WHERE domain = ? AND fixed_at IS NULL) as broken_links,
        (SELECT audit_date FROM audits WHERE domain = ? ORDER BY audit_date DESC LIMIT 1) as last_audit
    `).bind(
      domain,
      domain, weekAgo,
      domain, weekAgo,
      domain,
      domain
    ).first();

    if (!stats || !stats.last_audit) return null;

    const topIssues = await db.prepare(`
      SELECT issue_type, severity, COUNT(*) as count,
             SUM(CASE WHEN first_seen >= ? THEN 1 ELSE 0 END) as new_count,
             GROUP_CONCAT(page_url, '|||') as urls,
             GROUP_CONCAT(page_path, '|||') as pages
      FROM issues
      WHERE domain = ? AND fixed_at IS NULL
      GROUP BY issue_type, severity
      ORDER BY
        CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        count DESC
      LIMIT 5
    `).bind(weekAgo, domain).all();

    return {
      openIssues: stats.open_issues || 0,
      fixedThisWeek: stats.fixed_this_week || 0,
      newThisWeek: stats.new_this_week || 0,
      brokenLinks: stats.broken_links || 0,
      lastAudit: stats.last_audit,
      topIssues: topIssues.results.map(i => ({
        type: i.issue_type, severity: i.severity, count: i.count, newCount: i.new_count,
        urls: i.urls ? i.urls.split('|||').slice(0, 100) : [],
        pages: i.pages ? i.pages.split('|||').slice(0, 100) : []
      }))
    };
  } catch (e) {
    console.error('D1 stats error:', e);
    return null;
  }
}

// ============================================================================
// ISSUE GENERATION
// ============================================================================

function generateIssues(data) {
  const issues = [];

  if (data.cloudflare?.cacheHitRatioNum !== null && data.cloudflare.cacheHitRatioNum < 70) {
    issues.push({ priority: data.cloudflare.cacheHitRatioNum < 50 ? 'HIGH' : 'MEDIUM', category: 'performance', issue: `Low cache ratio: ${data.cloudflare.cacheHitRatio}` });
  }

  if (data.cloudflare?.threatsBlocked > 500) {
    issues.push({ priority: 'HIGH', category: 'security', issue: `${data.cloudflare.threatsBlocked} threats blocked` });
  }

  if (data.searchConsole?.positionNum && data.searchConsole.positionNum > 30) {
    issues.push({ priority: 'MEDIUM', category: 'seo', issue: `Average position is ${data.searchConsole.position} (target: <20)` });
  }

  if (data.searchConsole?.ctrNum && data.searchConsole.ctrNum < 2) {
    issues.push({ priority: 'MEDIUM', category: 'seo', issue: `Low CTR: ${data.searchConsole.ctr}` });
  }

  return issues;
}

// ============================================================================
// ISSUE STATUS HANDLER — Mark issues as complete or reopen
// ============================================================================

export async function handleIssueStatus(issueId, request, env, user) {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not available' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  try {
    const body = await request.json();
    const { table, action } = body;

    // Validate table param
    if (!table || !['issues', 'accessibility_issues', 'ai_readiness_issues'].includes(table)) {
      return new Response(JSON.stringify({ error: 'Invalid table.' }), { status: 400, headers });
    }

    // Validate action param
    if (!action || !['complete', 'reopen'].includes(action)) {
      return new Response(JSON.stringify({ error: 'Invalid action. Use "complete" or "reopen".' }), { status: 400, headers });
    }

    const userId = user.userId;
    const userEmail = user.email;

    // Verify the issue exists and belongs to the user's domains
    const issue = await env.DB.prepare(`
      SELECT i.id, i.domain, i.issue_type, i.page_url, i.manually_fixed_at
      FROM ${table} i
      JOIN properties p ON p.domain = i.domain AND p.user_id = ?
      WHERE i.id = ?
    `).bind(userId, issueId).first();

    if (!issue) {
      return new Response(JSON.stringify({ error: 'Issue not found or access denied' }), { status: 404, headers });
    }

    const now = new Date().toISOString();

    if (action === 'complete') {
      // Mark as manually completed
      await env.DB.prepare(`
        UPDATE ${table}
        SET manually_fixed_at = ?, manually_fixed_by = ?, fixed_at = ?, reactivated_at = NULL
        WHERE id = ?
      `).bind(now, userEmail || userId, now, issueId).run();

      // Log the action
      await env.DB.prepare(`
        INSERT INTO issue_actions (issue_id, issue_table, action, user_id, user_email, created_at)
        VALUES (?, ?, 'complete', ?, ?, ?)
      `).bind(issueId, table, userId, userEmail, now).run();

      return new Response(JSON.stringify({
        success: true,
        message: 'Issue marked as completed',
        issueId,
        action: 'complete',
        completedAt: now,
        completedBy: userEmail || userId
      }), { headers });

    } else if (action === 'reopen') {
      // Reopen: clear all manual-fix fields
      await env.DB.prepare(`
        UPDATE ${table}
        SET manually_fixed_at = NULL, manually_fixed_by = NULL, fixed_at = NULL, reactivated_at = NULL
        WHERE id = ?
      `).bind(issueId).run();

      // Log the action
      await env.DB.prepare(`
        INSERT INTO issue_actions (issue_id, issue_table, action, user_id, user_email, created_at)
        VALUES (?, ?, 'reopen', ?, ?, ?)
      `).bind(issueId, table, userId, userEmail, now).run();

      return new Response(JSON.stringify({
        success: true,
        message: 'Issue reopened',
        issueId,
        action: 'reopen'
      }), { headers });
    }

  } catch (e) {
    console.error('Issue status error:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}
