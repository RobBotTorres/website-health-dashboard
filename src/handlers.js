import { PROPERTIES, PROPERTY_IDS, getCredentials } from './config.js';
import { getDateRange, getDateRangePST, formatIssueMessage, formatIssueStatus } from './utils.js';
import { cloudflareGraphQL, fetchCloudflareSummary, fetchCloudflareDetail, fetchCloudflareTraffic, fetchCloudflarePerformance } from './cloudflare-api.js';
import { fetchGA4Analytics, fetchGA4Performance, fetchSearchConsoleSummary, fetchSearchConsoleDetail, fetchPageSpeedInsights, fetchCoreWebVitals } from './google-api.js';
import { checkRobotsTxt, fetchAndStorePerformance } from './audit.js';

// ============================================================================
// MAIN API HANDLER
// ============================================================================

export async function handleAPI(request, env) {
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
      data = await fetchPropertyDetail(propertyParam, env);
    } else {
      data = await fetchPortfolioOverview(env);
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

export async function handleSiteHealth(request, env) {
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
      const data = await getActionableDataFromD1(env.DB, domain);
      if (data.hasData) {
        data.robotsTxt = await checkRobotsTxt(domain);
        return new Response(JSON.stringify(data), { headers });
      }
    }

    if (env.SEO_AUDITS) {
      const cached = await env.SEO_AUDITS.get(`audit:${domain}`);
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

    return new Response(JSON.stringify({
      hasData: false,
      message: 'No audit data yet. Run /api/trigger-audit to start.',
      robotsTxt: await checkRobotsTxt(domain)
    }), { headers });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
  }
}

// ============================================================================
// CORE WEB VITALS HANDLER
// ============================================================================

export async function handleCoreWebVitals(request, env) {
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

export async function handlePerformance(request, env) {
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
      const cached = await getPerformanceFromD1(env.DB, domain);
      if (cached && cached.snapshotDate) {
        const snapshotTime = new Date(cached.snapshotDate + 'T00:00:00Z').getTime();
        const ageHours = (Date.now() - snapshotTime) / (1000 * 60 * 60);
        if (ageHours < 24) {
          return new Response(JSON.stringify({ ...cached, fromCache: true }), { headers });
        }
        staleCache = cached;
      }
    }

    const creds = getCredentials(propertyId, env);

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

    if (env.DB && cloudflare && !cloudflare.error) {
      try {
        const { endDate: today } = getDateRangePST(0);
        const rs = cloudflare.responseStatus || {};
        const mergedGa4 = ga4?.error ? (staleCache?.ga4 || {}) : ga4;
        const mergedCwv = cwv?.error ? (staleCache?.cwv || {}) : cwv;
        await env.DB.prepare(`
          INSERT OR REPLACE INTO performance_snapshots (
            domain, snapshot_date,
            cf_requests, cf_requests_change, cf_bandwidth, cf_cache_ratio, cf_error_rate, cf_threats,
            cf_2xx, cf_3xx, cf_4xx, cf_5xx,
            cwv_lcp, cwv_lcp_rating, cwv_inp, cwv_inp_rating, cwv_cls, cwv_cls_rating,
            cwv_fcp, cwv_fcp_rating, cwv_ttfb, cwv_overall,
            ga4_sessions, ga4_sessions_change, ga4_users, ga4_users_change,
            ga4_bounce_rate, ga4_avg_duration, ga4_engagement_rate, ga4_page_views, ga4_top_pages
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          domain, today,
          cloudflare.requests || 0,
          parseFloat(cloudflare.requestsChange) || 0,
          cloudflare.bandwidth || '0 B',
          parseFloat(cloudflare.cacheRatio) || 0,
          parseFloat(cloudflare.errorRate) || 0,
          cloudflare.threats || 0,
          rs.success || 0, rs.redirect || 0, rs.clientError || 0, rs.serverError || 0,
          mergedCwv.LCP || null, mergedCwv.lcpRating || null, mergedCwv.INP || null, mergedCwv.inpRating || null,
          mergedCwv.CLS ?? null, mergedCwv.clsRating || null, mergedCwv.FCP || null, mergedCwv.fcpRating || null,
          mergedCwv.TTFB || null, mergedCwv.overallCategory || null,
          mergedGa4.sessions || null, parseFloat(mergedGa4.sessionsChange) || null,
          mergedGa4.newUsers || null, parseFloat(mergedGa4.newUsersChange) || null,
          parseFloat(mergedGa4.bounceRate) || null, mergedGa4.avgDuration || null,
          parseFloat(mergedGa4.engagementRate) || null, mergedGa4.pageViews || null,
          mergedGa4.topPages ? JSON.stringify(mergedGa4.topPages) : null
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

export async function handleSEOStats(domain, env) {
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

    const stats = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND fixed_at IS NULL) as open_issues,
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND fixed_at >= ?) as fixed_this_week,
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND first_seen >= ? AND fixed_at IS NULL) as new_this_week,
        (SELECT COUNT(*) FROM broken_links WHERE domain = ? AND fixed_at IS NULL) as broken_links,
        (SELECT audit_date FROM audits WHERE domain = ? ORDER BY audit_date DESC LIMIT 1) as last_audit
    `).bind(domain, domain, weekAgo, domain, weekAgo, domain, domain).first();

    const topIssues = await env.DB.prepare(`
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
    `).bind(weekAgo, domain).all();

    const fixedIssues = await env.DB.prepare(`
      SELECT issue_type, severity, COUNT(*) as count, fixed_at,
             GROUP_CONCAT(page_url, '|||') as urls,
             GROUP_CONCAT(page_path, '|||') as pages
      FROM issues
      WHERE domain = ? AND fixed_at >= ?
      GROUP BY issue_type, severity
      ORDER BY fixed_at DESC
    `).bind(domain, weekAgo).all();

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
        pages: i.pages ? i.pages.split('|||') : []
      })),
      fixedIssues: fixedIssues.results.map(i => ({
        type: i.issue_type, severity: i.severity, count: i.count,
        message: formatIssueMessage(i.issue_type, i.count),
        urls: i.urls ? i.urls.split('|||').slice(0, 20) : [],
        pages: i.pages ? i.pages.split('|||').slice(0, 20) : []
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

export async function handleAccessibility(domain, env) {
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
      SELECT id, issue_type, severity, page_path, page_url, issue_count, snippets, first_seen
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
        url: row.page_url, path: row.page_path,
        count: row.issue_count || 1, snippets: snippets
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

    return new Response(JSON.stringify({
      hasData: issueList.length > 0,
      issues: issueList
    }), { headers });

  } catch (e) {
    console.error('Accessibility error:', e);
    return new Response(JSON.stringify({ hasData: false, error: e.message }), { headers });
  }
}

// ============================================================================
// KEYWORDS HANDLER
// ============================================================================

export async function handleKeywords(domain, env) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  };

  if (!domain || !env.DB) {
    return new Response(JSON.stringify({ hasData: false }), { headers });
  }

  const brandedTerms = [
    'viansa', 'kunde', 'br cohn', 'brcohn', 'b.r. cohn', 'girard', 'clos pegase',
    'clospegase', 'adair', 'adair family', 'adair vineyards',
    'viansa sonoma', 'kunde family', 'girard winery', 'clos pegase winery'
  ];

  function isBranded(query) {
    const q = query.toLowerCase();
    return brandedTerms.some(brand => q.includes(brand));
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
      .filter(k => !isBranded(k.query))
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

export async function handle404Errors(propertyId, env) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  };

  if (!propertyId || !env.CLOUDFLARE_API_TOKEN) {
    return new Response(JSON.stringify({ hasData: false, error: 'Not configured' }), { headers });
  }

  try {
    const zoneIds = env[`${propertyId}_CF_ZONE_IDS`];
    if (!zoneIds) {
      return new Response(JSON.stringify({ hasData: false, error: 'No zone configured' }), { headers });
    }

    const zoneId = zoneIds.split(',')[0].trim();
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
        'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
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

export async function handlePerformanceHistory(env) {
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
    const history = await env.DB.prepare(`
      SELECT domain, date, lcp_ms, fcp_ms, cls, inp_ms, ttfb_ms
      FROM performance_history
      WHERE date >= ? AND date <= ?
      ORDER BY date ASC
    `).bind(startDate, endDate).all();

    const byDomain = {};
    for (const row of history.results || []) {
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

export async function handleAllFixedIssues(env) {
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
    `).all();

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

export async function storePerformanceSnapshot(env) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  if (!env.DB || !env.PAGESPEED_API_KEY) {
    return new Response(JSON.stringify({ success: false, error: 'Not configured' }), { headers });
  }

  const domainMap = {
    'viansa.com': 'viansa',
    'kunde.com': 'kunde',
    'brcohn.com': 'brcohn',
    'clospegase.com': 'clospegase',
    'girardwinery.com': 'girard',
    'adairfamilywines.com': 'adair'
  };

  const { endDate: today } = getDateRangePST(0);
  const results = [];

  for (const [domain, propertyId] of Object.entries(domainMap)) {
    try {
      const cwv = await fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY);

      if (cwv && !cwv.error) {
        await env.DB.prepare(`
          INSERT INTO performance_history (domain, date, lcp_ms, fcp_ms, cls, inp_ms, ttfb_ms, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(domain, date) DO UPDATE SET
            lcp_ms = excluded.lcp_ms, fcp_ms = excluded.fcp_ms, cls = excluded.cls,
            inp_ms = excluded.inp_ms, ttfb_ms = excluded.ttfb_ms, recorded_at = excluded.recorded_at
        `).bind(
          domain, today,
          cwv.LCP || null, cwv.FCP || null, cwv.CLS || null,
          cwv.INP || null, cwv.TTFB || null,
          new Date().toISOString()
        ).run();
      }

      await fetchAndStorePerformance(env, domain, propertyId, today);

      results.push({ domain, success: true, lcp: cwv?.LCP, snapshotStored: true });
    } catch (e) {
      results.push({ domain, success: false, error: e.message });
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

async function getActionableDataFromD1(db, domain) {
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
        return { path: p, url: urls[idx] || '', snippets: snippet ? [snippet] : [] };
      });
    } else {
      pages = paths;
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

async function getPerformanceFromD1(db, domain) {
  try {
    const row = await db.prepare(`
      SELECT * FROM performance_snapshots
      WHERE domain = ?
      ORDER BY snapshot_date DESC
      LIMIT 1
    `).bind(domain).first();

    if (!row) return null;

    return {
      cloudflare: {
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
      },
      ga4: row.ga4_sessions ? {
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
      } : { error: 'GA4 not configured' },
      cwv: row.cwv_lcp ? {
        LCP: row.cwv_lcp, lcpRating: row.cwv_lcp_rating,
        INP: row.cwv_inp, inpRating: row.cwv_inp_rating,
        CLS: row.cwv_cls, clsRating: row.cwv_cls_rating,
        FCP: row.cwv_fcp, fcpRating: row.cwv_fcp_rating,
        TTFB: row.cwv_ttfb, overallCategory: row.cwv_overall
      } : { error: 'No CWV data' },
      snapshotDate: row.snapshot_date
    };
  } catch (e) {
    console.error('D1 performance cache error:', e);
    return null;
  }
}

async function fetchPortfolioOverview(env) {
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

async function fetchPropertyDetail(propertyId, env) {
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

export async function fetchCloudflareData(propertyId, env) {
  const property = PROPERTIES[propertyId];
  if (!property) throw new Error(`Unknown property: ${propertyId}`);

  const creds = getCredentials(propertyId, env);
  return await fetchCloudflareDetail(creds.cloudflare, env);
}

export async function fetchSearchConsoleData(propertyId, env) {
  const property = PROPERTIES[propertyId];
  if (!property) throw new Error(`Unknown property: ${propertyId}`);

  const creds = getCredentials(propertyId, env);
  return await fetchSearchConsoleDetail(creds.searchConsole);
}

async function getSEOStatsFromD1(db, domain) {
  try {
    const { startDate: weekAgo } = getDateRangePST(7);

    const stats = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND fixed_at IS NULL) as open_issues,
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND fixed_at >= ?) as fixed_this_week,
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND first_seen >= ? AND fixed_at IS NULL) as new_this_week,
        (SELECT COUNT(*) FROM broken_links WHERE domain = ? AND fixed_at IS NULL) as broken_links,
        (SELECT audit_date FROM audits WHERE domain = ? ORDER BY audit_date DESC LIMIT 1) as last_audit
    `).bind(domain, domain, weekAgo, domain, weekAgo, domain, domain).first();

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
