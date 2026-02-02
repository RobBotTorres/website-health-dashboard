// ============================================================================
// WINE HEALTH DASHBOARD - COMBINED WORKER
// Serves both the dashboard UI and API
// Includes daily cron job for full sitemap SEO audits
// ============================================================================

export default {
  // HTTP request handler
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // API endpoints
    if (url.pathname === '/api/data') {
      return handleAPI(request, env);
    }
    
    // Lazy-load endpoints for slow data
    if (url.pathname === '/api/site-health') {
      return handleSiteHealth(request, env);
    }
    
    if (url.pathname === '/api/core-web-vitals') {
      return handleCoreWebVitals(request, env);
    }
    
    // Comprehensive performance endpoint (Cloudflare + GA4 + CWV)
    if (url.pathname === '/api/performance') {
      return handlePerformance(request, env);
    }
    
    // Debug endpoint to check GA4 config
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
    
    // Manual trigger for SEO audit (for testing)
    if (url.pathname === '/api/trigger-audit') {
      const domain = url.searchParams.get('domain');
      if (domain) {
        // Audit single domain
        const result = await runFullSitemapAudit(domain, env);
        return new Response(JSON.stringify(result, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        // Audit all domains
        await runScheduledAudit(env);
        return new Response(JSON.stringify({ status: 'Audit triggered for all properties' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // Quick SEO stats from D1 (for overview)
    if (url.pathname === '/api/seo-stats') {
      const domain = url.searchParams.get('domain');
      return handleSEOStats(domain, env);
    }
    
    // Accessibility issues from D1
    if (url.pathname === '/api/accessibility') {
      const domain = url.searchParams.get('domain');
      return handleAccessibility(domain, env);
    }
    
    // Keywords from D1 (fast)
    if (url.pathname === '/api/keywords') {
      const domain = url.searchParams.get('domain');
      return handleKeywords(domain, env);
    }
    
    // 404 errors from Cloudflare
    if (url.pathname === '/api/404-errors') {
      const propertyId = url.searchParams.get('property');
      return handle404Errors(propertyId, env);
    }
    
    // Performance history for charts
    if (url.pathname === '/api/performance-history') {
      return handlePerformanceHistory(env);
    }
    
    // All fixed issues across all domains
    if (url.pathname === '/api/all-fixed-issues') {
      return handleAllFixedIssues(env);
    }
    
    // Store today's performance snapshot (call daily)
    if (url.pathname === '/api/store-performance') {
      return storePerformanceSnapshot(env);
    }
    
    // Lazy-load Cloudflare data (slow - external API)
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
    
    // Lazy-load Search Console data (slow - external API)
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
    
    // Comprehensive performance endpoint (Cloudflare + GA4 + CWV)
    if (url.pathname === '/api/performance') {
      const propertyId = url.searchParams.get('property');
      const domain = url.searchParams.get('domain');
      if (!propertyId || !domain) {
        return new Response(JSON.stringify({ error: 'Missing property or domain parameter' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
      try {
        const data = await fetchComprehensivePerformance(propertyId, domain, env);
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // Debug endpoint to check sitemap
    if (url.pathname === '/api/debug-sitemap') {
      const domain = url.searchParams.get('domain') || 'kunde.com';
      const results = { domain, checks: [] };
      
      // Check robots.txt
      let sitemapFromRobots = null;
      try {
        const robotsUrl = `https://www.${domain}/robots.txt`;
        const robotsRes = await fetch(robotsUrl);
        const robotsText = robotsRes.ok ? await robotsRes.text() : null;
        const sitemapMatch = robotsText?.match(/sitemap:\s*(https?:\/\/[^\s]+)/i);
        sitemapFromRobots = sitemapMatch ? sitemapMatch[1] : null;
        results.checks.push({
          url: robotsUrl,
          status: robotsRes.status,
          sitemapFromRobots
        });
      } catch (e) {
        results.checks.push({ url: `https://www.${domain}/robots.txt`, error: e.message });
      }
      
      // Try various sitemap URLs - including the one from robots.txt
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
  
  // Cron trigger handler - runs daily at 3am UTC
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledAudit(env));
  }
};

// Run full SEO audit for all properties
async function runScheduledAudit(env) {
  const domains = [
    'adairfamilywines.com',
    'brcohn.com', 
    'clospegase.com',
    'girardwinery.com',
    'kunde.com',
    'viansa.com'
  ];
  
  console.log(`Starting scheduled SEO audit for ${domains.length} domains`);
  
  for (const domain of domains) {
    try {
      console.log(`Auditing ${domain}...`);
      await runFullSitemapAudit(domain, env);
      console.log(`Completed ${domain}`);
    } catch (error) {
      console.error(`Error auditing ${domain}:`, error);
    }
  }
  
  console.log('Scheduled tasks complete');
}

// Collect performance data for all domains
async function collectPerformanceSnapshot(env) {
  if (!env.DB || !env.PAGESPEED_API_KEY) {
    console.log('Performance collection skipped - missing DB or API key');
    return;
  }
  
  const domains = [
    'viansa.com',
    'kunde.com', 
    'brcohn.com',
    'clospegase.com',
    'girardwinery.com',
    'adairfamilywines.com'
  ];
  
  const today = new Date().toISOString().split('T')[0];
  
  for (const domain of domains) {
    try {
      const cwv = await fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY);
      
      if (cwv && !cwv.error) {
        await env.DB.prepare(`
          INSERT INTO performance_history (domain, date, lcp_ms, fcp_ms, cls, inp_ms, ttfb_ms, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(domain, date) DO UPDATE SET
            lcp_ms = excluded.lcp_ms,
            fcp_ms = excluded.fcp_ms,
            cls = excluded.cls,
            inp_ms = excluded.inp_ms,
            ttfb_ms = excluded.ttfb_ms,
            recorded_at = excluded.recorded_at
        `).bind(
          domain, 
          today, 
          cwv.LCP || null, 
          cwv.FCP || null, 
          cwv.CLS || null, 
          cwv.INP || null, 
          cwv.TTFB || null,
          new Date().toISOString()
        ).run();
        
        console.log(`Stored performance for ${domain}: LCP=${cwv.LCP}ms`);
      }
    } catch (e) {
      console.error(`Performance error for ${domain}:`, e.message);
    }
  }
}

// Full sitemap audit - crawls ALL pages and stores in D1
async function runFullSitemapAudit(domain, env) {
  const startTime = Date.now();
  const today = new Date().toISOString().split('T')[0];
  
  const audit = {
    domain,
    startedAt: new Date().toISOString(),
    completedAt: null,
    sitemapUrl: null,
    totalUrls: 0,
    audited: 0,
    failed: 0,
    pages: [],
    brokenLinks: [],
    summary: {
      missingTitle: 0,
      shortTitle: 0,
      longTitle: 0,
      missingDescription: 0,
      shortDescription: 0,
      longDescription: 0,
      missingH1: 0,
      multipleH1: 0,
      missingSchema: 0,
      schemaErrors: 0,
      httpErrors: 0,
      brokenLinks: 0
    },
    issues: []
  };
  
  try {
    // Get sitemap URL from robots.txt
    let sitemapUrl = `https://www.${domain}/sitemap.xml`;
    try {
      const robotsResponse = await fetch(`https://www.${domain}/robots.txt`);
      if (robotsResponse.ok) {
        const robotsText = await robotsResponse.text();
        const sitemapMatch = robotsText.match(/sitemap:\s*(https?:\/\/[^\s]+)/i);
        if (sitemapMatch) {
          sitemapUrl = sitemapMatch[1];
        }
      }
    } catch (e) {
      console.log(`Could not fetch robots.txt for ${domain}, using default sitemap URL`);
    }
    
    audit.sitemapUrl = sitemapUrl;
    
    // Fetch all URLs from sitemap (including sitemap indexes)
    const urls = await getAllSitemapUrls(sitemapUrl);
    
    // Deduplicate URLs - normalize and remove duplicates
    const seenPaths = new Set();
    const uniqueUrls = [];
    for (const url of urls) {
      try {
        const parsed = new URL(url);
        const normalizedPath = parsed.pathname.replace(/\/$/, '') || '/';
        if (!seenPaths.has(normalizedPath)) {
          seenPaths.add(normalizedPath);
          uniqueUrls.push(url);
        }
      } catch (e) {
        uniqueUrls.push(url);
      }
    }
    
    audit.totalUrls = uniqueUrls.length;
    console.log(`Found ${uniqueUrls.length} unique URLs in sitemap for ${domain}`);
    
    // Collect all internal links for broken link checking
    const allInternalLinks = new Set();
    
    // Audit pages in batches
    const BATCH_SIZE = 10;
    const MAX_PAGES = 500;
    const urlsToAudit = uniqueUrls.slice(0, MAX_PAGES);
    
    for (let i = 0; i < urlsToAudit.length; i += BATCH_SIZE) {
      const batch = urlsToAudit.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(url => auditSinglePageWithLinks(url, domain)));
      
      results.forEach(result => {
        if (result) {
          if (result.internalLinks) {
            result.internalLinks.forEach(link => allInternalLinks.add(link));
            delete result.internalLinks;
          }
          
          audit.pages.push(result);
          audit.audited++;
          
          if (result.error) {
            audit.summary.httpErrors++;
          } else {
            if (result.title.status === 'missing') audit.summary.missingTitle++;
            else if (result.title.status === 'too_short') audit.summary.shortTitle++;
            else if (result.title.status === 'too_long') audit.summary.longTitle++;
            
            if (result.description.status === 'missing') audit.summary.missingDescription++;
            else if (result.description.status === 'too_short') audit.summary.shortDescription++;
            else if (result.description.status === 'too_long') audit.summary.longDescription++;
            
            if (result.h1.count === 0) audit.summary.missingH1++;
            else if (result.h1.count > 1) audit.summary.multipleH1++;
            
            if (!result.schema.found) audit.summary.missingSchema++;
            else if (result.schema.errors > 0) audit.summary.schemaErrors++;
          }
        } else {
          audit.failed++;
        }
      });
      
      if (i + BATCH_SIZE < urlsToAudit.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    
    // Check for broken internal links
    const sitemapPaths = new Set(seenPaths);
    const linksToCheck = [...allInternalLinks].filter(link => {
      try {
        const path = new URL(link).pathname.replace(/\/$/, '') || '/';
        return !sitemapPaths.has(path);
      } catch (e) {
        return true;
      }
    }).slice(0, 100);
    
    if (linksToCheck.length > 0) {
      console.log(`Checking ${linksToCheck.length} potential broken links for ${domain}`);
      const brokenResults = await checkBrokenLinks(linksToCheck);
      audit.brokenLinks = brokenResults;
      audit.summary.brokenLinks = brokenResults.length;
    }
    
    audit.issues = generateSEOIssues(audit);
    
  } catch (error) {
    audit.error = error.message;
    console.error(`Audit error for ${domain}:`, error);
  }
  
  audit.completedAt = new Date().toISOString();
  audit.duration = Math.round((Date.now() - startTime) / 1000);
  
  // Store in D1 database
  if (env.DB) {
    // 1. Store audit results
    try {
      console.log(`Storing audit in D1 for ${domain}...`);
      await storeAuditInD1(env.DB, domain, today, audit);
      console.log(`SUCCESS: Stored audit for ${domain} in D1 (${audit.audited} pages)`);
    } catch (e) {
      console.error(`FAILED to store audit in D1: ${e.message}`);
      console.error(e.stack);
      audit.d1Error = e.message;
    }
    
    // 2. Fetch and store Search Console data (independent)
    try {
      const propertyId = getPropertyIdForDomain(domain);
      if (propertyId) {
        console.log(`Fetching Search Console data for ${domain}...`);
        await fetchAndStoreSearchConsole(env, domain, propertyId, today);
      }
    } catch (e) {
      console.error(`Failed Search Console for ${domain}: ${e.message}`);
    }
    
    // 3. Fetch and store performance history data (independent)
    try {
      if (env.PAGESPEED_API_KEY) {
        console.log(`Fetching performance data for ${domain}...`);
        const cwv = await fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY);
        if (cwv && !cwv.error) {
          await env.DB.prepare(`
            INSERT INTO performance_history (domain, date, lcp_ms, fcp_ms, cls, inp_ms, ttfb_ms, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(domain, date) DO UPDATE SET
              lcp_ms = excluded.lcp_ms,
              fcp_ms = excluded.fcp_ms,
              cls = excluded.cls,
              inp_ms = excluded.inp_ms,
              ttfb_ms = excluded.ttfb_ms,
              recorded_at = excluded.recorded_at
          `).bind(
            domain, today,
            cwv.LCP || null, cwv.FCP || null, cwv.CLS || null,
            cwv.INP || null, cwv.TTFB || null,
            new Date().toISOString()
          ).run();
          console.log(`Stored performance history for ${domain}: LCP=${cwv.LCP}ms`);
        }
      }
    } catch (e) {
      console.error(`Failed performance for ${domain}: ${e.message}`);
    }
  } else {
    console.log('D1 not available (env.DB is undefined)');
    audit.d1Error = 'D1 not configured';
  }
  
  // Also cache in KV for fast reads
  if (env.SEO_AUDITS) {
    await env.SEO_AUDITS.put(`audit:${domain}`, JSON.stringify(audit), {
      expirationTtl: 48 * 60 * 60
    });
  }
  
  return audit;
}

// Store audit results in D1 with change tracking
async function storeAuditInD1(db, domain, auditDate, audit) {
  console.log(`storeAuditInD1: Starting for ${domain} on ${auditDate}`);
  
  // 1. Insert/update audit record
  const auditResult = await db.prepare(`
    INSERT INTO audits (domain, audit_date, total_pages, pages_audited, duration_seconds)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(domain, audit_date) DO UPDATE SET
      total_pages = excluded.total_pages,
      pages_audited = excluded.pages_audited,
      duration_seconds = excluded.duration_seconds
  `).bind(domain, auditDate, audit.totalUrls, audit.audited, audit.duration).run();
  console.log(`storeAuditInD1: Audit record inserted, changes: ${auditResult.meta?.changes}`);
  
  // 2. Collect current issues from audit
  const currentIssues = new Map(); // key: type|path
  let issueCount = 0;
  
  for (const page of audit.pages) {
    if (page.error) continue;
    
    const path = page.path || '/';
    const url = page.url || '';
    
    // Title issues
    if (page.title?.status === 'missing') {
      currentIssues.set(`missing_title|${path}`, { type: 'missing_title', severity: 'high', path, url, details: null });
      issueCount++;
    } else if (page.title?.status === 'too_short') {
      currentIssues.set(`short_title|${path}`, { type: 'short_title', severity: 'medium', path, url, details: JSON.stringify({ length: page.title.length }) });
      issueCount++;
    }
    
    // Description issues
    if (page.description?.status === 'missing') {
      currentIssues.set(`missing_description|${path}`, { type: 'missing_description', severity: 'high', path, url, details: null });
      issueCount++;
    } else if (page.description?.status === 'too_short') {
      currentIssues.set(`short_description|${path}`, { type: 'short_description', severity: 'medium', path, url, details: JSON.stringify({ length: page.description.length }) });
      issueCount++;
    }
    
    // H1 issues
    if (page.h1?.count === 0) {
      currentIssues.set(`missing_h1|${path}`, { type: 'missing_h1', severity: 'medium', path, url, details: null });
      issueCount++;
    } else if (page.h1?.count > 1) {
      currentIssues.set(`multiple_h1|${path}`, { type: 'multiple_h1', severity: 'low', path, url, details: JSON.stringify({ count: page.h1.count }) });
      issueCount++;
    }
    
    // Schema issues  
    if (page.schema && !page.schema.found) {
      currentIssues.set(`missing_schema|${path}`, { type: 'missing_schema', severity: 'low', path, url, details: null });
      issueCount++;
    } else if (page.schema?.errors > 0) {
      currentIssues.set(`schema_error|${path}`, { type: 'schema_error', severity: 'high', path, url, details: null });
      issueCount++;
    }
    
    // Canonical URL issues
    if (page.canonical?.status === 'missing') {
      currentIssues.set(`missing_canonical|${path}`, { type: 'missing_canonical', severity: 'medium', path, url, details: null });
      issueCount++;
    } else if (page.canonical?.status === 'mismatch') {
      currentIssues.set(`canonical_mismatch|${path}`, { type: 'canonical_mismatch', severity: 'medium', path, url, details: JSON.stringify({ canonical: page.canonical.url }) });
      issueCount++;
    } else if (page.canonical?.status === 'invalid') {
      currentIssues.set(`invalid_canonical|${path}`, { type: 'invalid_canonical', severity: 'high', path, url, details: null });
      issueCount++;
    }
    
    // Social meta tag issues
    if (page.socialMeta?.status === 'poor') {
      currentIssues.set(`missing_social_tags|${path}`, { type: 'missing_social_tags', severity: 'medium', path, url, details: JSON.stringify({ missing: page.socialMeta.issues }) });
      issueCount++;
    } else if (page.socialMeta?.status === 'partial') {
      currentIssues.set(`partial_social_tags|${path}`, { type: 'partial_social_tags', severity: 'low', path, url, details: JSON.stringify({ missing: page.socialMeta.issues }) });
      issueCount++;
    }
    
    // Image optimization issues
    const imgIssues = page.imageOptimization?.issues || [];
    const noLazyCount = imgIssues.filter(i => i.issues.includes('no-lazy')).length;
    const noDimsCount = imgIssues.filter(i => i.issues.includes('no-dimensions')).length;
    const notWebpCount = imgIssues.filter(i => i.issues.includes('not-webp')).length;
    
    if (noLazyCount > 0) {
      const snippets = imgIssues.filter(i => i.issues.includes('no-lazy')).slice(0, 3).map(i => i.snippet);
      currentIssues.set(`images_no_lazy|${path}`, { type: 'images_no_lazy', severity: 'medium', path, url, details: JSON.stringify({ count: noLazyCount, snippets }) });
      issueCount++;
    }
    if (noDimsCount > 2) {
      const snippets = imgIssues.filter(i => i.issues.includes('no-dimensions')).slice(0, 3).map(i => i.snippet);
      currentIssues.set(`images_no_dimensions|${path}`, { type: 'images_no_dimensions', severity: 'low', path, url, details: JSON.stringify({ count: noDimsCount, snippets }) });
      issueCount++;
    }
    if (notWebpCount > 2) {
      const snippets = imgIssues.filter(i => i.issues.includes('not-webp')).slice(0, 3).map(i => i.snippet);
      currentIssues.set(`images_not_webp|${path}`, { type: 'images_not_webp', severity: 'low', path, url, details: JSON.stringify({ count: notWebpCount, snippets }) });
      issueCount++;
    }
  }
  
  // Check for duplicate titles and descriptions across pages
  const titleMap = new Map();
  const descMap = new Map();
  
  for (const page of audit.pages) {
    if (page.error || !page.title?.value || !page.description?.value) continue;
    const path = page.path || '/';
    const url = page.url || '';
    
    // Track titles (only non-empty ones longer than 10 chars to avoid false positives)
    if (page.title.value && page.title.value.length > 10) {
      const titleKey = page.title.value.toLowerCase().trim();
      if (!titleMap.has(titleKey)) titleMap.set(titleKey, []);
      titleMap.get(titleKey).push({ path, url });
    }
    
    // Track descriptions
    if (page.description.value && page.description.value.length > 20) {
      const descKey = page.description.value.toLowerCase().trim();
      if (!descMap.has(descKey)) descMap.set(descKey, []);
      descMap.get(descKey).push({ path, url });
    }
  }
  
  // Add duplicate issues
  for (const [titleVal, pages] of titleMap) {
    if (pages.length > 1) {
      const firstPage = pages[0];
      currentIssues.set(`duplicate_title|${firstPage.path}`, { 
        type: 'duplicate_title', 
        severity: 'medium', 
        path: firstPage.path, 
        url: firstPage.url, 
        details: JSON.stringify({ title: titleVal.substring(0, 60), duplicatePages: pages.map(p => p.path) })
      });
      issueCount++;
    }
  }
  
  for (const [descVal, pages] of descMap) {
    if (pages.length > 1) {
      const firstPage = pages[0];
      currentIssues.set(`duplicate_description|${firstPage.path}`, { 
        type: 'duplicate_description', 
        severity: 'medium', 
        path: firstPage.path, 
        url: firstPage.url, 
        details: JSON.stringify({ description: descVal.substring(0, 80), duplicatePages: pages.map(p => p.path) })
      });
      issueCount++;
    }
  }
  
  console.log(`storeAuditInD1: Found ${issueCount} issues to store`);
  
  // 3. Get existing unfixed issues for this domain
  const existingIssues = await db.prepare(`
    SELECT id, issue_type, page_path FROM issues 
    WHERE domain = ? AND fixed_at IS NULL
  `).bind(domain).all();
  
  console.log(`storeAuditInD1: Found ${existingIssues.results?.length || 0} existing issues`);
  
  const existingKeys = new Set(existingIssues.results?.map(i => `${i.issue_type}|${i.page_path}`) || []);
  
  // 4. Upsert all current issues using batched ON CONFLICT
  // Handles: new issues (INSERT), existing open issues (UPDATE last_seen),
  // AND previously-fixed issues that reappear (clears fixed_at)
  const BATCH_SIZE = 25;
  const issueEntries = [...currentIssues.entries()];
  let upserted = 0;
  
  for (let i = 0; i < issueEntries.length; i += BATCH_SIZE) {
    const batch = issueEntries.slice(i, i + BATCH_SIZE);
    const stmts = batch.map(([key, issue]) => {
      return db.prepare(`
        INSERT INTO issues (domain, issue_type, severity, page_path, page_url, details, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain, issue_type, page_path) DO UPDATE SET
          severity = excluded.severity,
          page_url = excluded.page_url,
          details = excluded.details,
          last_seen = excluded.last_seen,
          fixed_at = NULL
      `).bind(domain, issue.type, issue.severity, issue.path, issue.url, issue.details, auditDate, auditDate);
    });
    
    await db.batch(stmts);
    upserted += batch.length;
  }
  
  console.log(`storeAuditInD1: Upserted ${upserted} issues`);
  
  // 5. Mark fixed issues - issues in DB that are NOT in current audit
  const allUnfixed = await db.prepare(`
    SELECT id, issue_type, page_path FROM issues 
    WHERE domain = ? AND fixed_at IS NULL
  `).bind(domain).all();
  
  const toFix = (allUnfixed.results || []).filter(existing => {
    const key = `${existing.issue_type}|${existing.page_path}`;
    return !currentIssues.has(key);
  });
  
  if (toFix.length > 0) {
    for (let i = 0; i < toFix.length; i += BATCH_SIZE) {
      const batch = toFix.slice(i, i + BATCH_SIZE);
      const stmts = batch.map(existing => {
        return db.prepare(`UPDATE issues SET fixed_at = ? WHERE id = ?`).bind(auditDate, existing.id);
      });
      await db.batch(stmts);
    }
  }
  
  console.log(`storeAuditInD1: Marked ${toFix.length} issues as fixed`);
  
  // 6. Handle broken links (batched)
  const brokenLinks = audit.brokenLinks || [];
  if (brokenLinks.length > 0) {
    for (let i = 0; i < brokenLinks.length; i += BATCH_SIZE) {
      const batch = brokenLinks.slice(i, i + BATCH_SIZE);
      const stmts = [];
      for (const broken of batch) {
        try {
          const linkPath = new URL(broken.url).pathname;
          stmts.push(db.prepare(`
            INSERT INTO broken_links (domain, link_url, link_path, status_code, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(domain, link_path) DO UPDATE SET
              status_code = excluded.status_code,
              last_seen = excluded.last_seen,
              fixed_at = NULL
          `).bind(domain, broken.url, linkPath, broken.status, auditDate, auditDate));
        } catch (e) {
          // skip invalid URLs
        }
      }
      if (stmts.length > 0) await db.batch(stmts);
    }
  }
  
  console.log(`storeAuditInD1: Processed ${brokenLinks.length} broken links`);
  
  // Mark fixed broken links
  await db.prepare(`
    UPDATE broken_links SET fixed_at = ?
    WHERE domain = ? AND fixed_at IS NULL AND last_seen < ?
  `).bind(auditDate, domain, auditDate).run();
  
  // 7. Handle accessibility issues (batched)
  const a11yStmts = [];
  const currentA11yKeys = new Set();
  
  for (const page of audit.pages) {
    if (page.error || !page.accessibility?.issues) continue;
    
    const path = page.path || '/';
    const url = page.url || '';
    
    for (const issue of page.accessibility.issues) {
      const key = `${issue.type}|${path}`;
      currentA11yKeys.add(key);
      const snippetsJson = issue.snippets ? JSON.stringify(issue.snippets) : null;
      
      a11yStmts.push(db.prepare(`
        INSERT INTO accessibility_issues (domain, issue_type, severity, page_path, page_url, issue_count, snippets, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain, issue_type, page_path) DO UPDATE SET
          severity = excluded.severity,
          issue_count = excluded.issue_count,
          snippets = excluded.snippets,
          last_seen = excluded.last_seen,
          fixed_at = NULL
      `).bind(domain, issue.type, issue.severity, path, url, issue.count, snippetsJson, auditDate, auditDate));
    }
  }
  
  for (let i = 0; i < a11yStmts.length; i += BATCH_SIZE) {
    const batch = a11yStmts.slice(i, i + BATCH_SIZE);
    await db.batch(batch);
  }
  
  console.log(`storeAuditInD1: Upserted ${a11yStmts.length} accessibility issues`);
  
  // Mark fixed accessibility issues
  await db.prepare(`
    UPDATE accessibility_issues SET fixed_at = ?
    WHERE domain = ? AND fixed_at IS NULL AND last_seen < ?
  `).bind(auditDate, domain, auditDate).run();
  
  console.log(`storeAuditInD1: Complete for ${domain}`);
}

// Get property ID from domain
function getPropertyIdForDomain(domain) {
  const domainMap = {
    'adairfamilywines.com': 'adair',
    'brcohn.com': 'brcohn',
    'clospegase.com': 'clospegase',
    'girardwinery.com': 'girard',
    'kunde.com': 'kunde',
    'viansa.com': 'viansa'
  };
  return domainMap[domain] || null;
}

// Fetch Search Console data and store in D1
async function fetchAndStoreSearchConsole(env, domain, propertyId, dataDate) {
  try {
    const creds = getCredentials(propertyId, env);
    if (!creds.searchConsole.properties.length || !creds.searchConsole.credentials) {
      console.log(`No Search Console credentials for ${propertyId}`);
      return;
    }
    
    const accessToken = await getGoogleAccessToken(creds.searchConsole.credentials);
    const { startDate, endDate } = getDateRange(28); // 28 days of data
    const { startDate: prevStartDate, endDate: prevEndDate } = getDateRange(28, 28);
    
    let prevQueryData = {};
    let keywords = [];
    
    for (const siteUrl of creds.searchConsole.properties) {
      // Get previous period for comparison
      try {
        const prevResponse = await fetch(
          `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ startDate: prevStartDate, endDate: prevEndDate, dimensions: ['query'], rowLimit: 100 })
          }
        );
        if (prevResponse.ok) {
          const prevData = await prevResponse.json();
          (prevData.rows || []).forEach(row => {
            prevQueryData[row.keys[0].toLowerCase().trim()] = row.position;
          });
        }
      } catch (e) {
        console.log(`Could not fetch previous period SC data: ${e.message}`);
      }
      
      // Get current period
      const response = await fetch(
        `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: 100 })
        }
      );
      
      if (response.ok) {
        const data = await response.json();
        keywords = keywords.concat((data.rows || []).map(row => {
          const query = row.keys[0];
          const prevPos = prevQueryData[query.toLowerCase().trim()];
          return {
            query,
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.clicks / row.impressions,
            position: row.position,
            prevPosition: prevPos || null,
            positionChange: prevPos ? (prevPos - row.position) : null
          };
        }));
      }
    }
    
    // Sort by clicks and take top 50
    keywords.sort((a, b) => b.clicks - a.clicks);
    keywords = keywords.slice(0, 50);
    
    // Store in D1
    if (env.DB && keywords.length > 0) {
      // Delete old keywords for this domain/date
      await env.DB.prepare(`DELETE FROM keywords WHERE domain = ? AND data_date = ?`).bind(domain, dataDate).run();
      
      for (const kw of keywords) {
        await env.DB.prepare(`
          INSERT INTO keywords (domain, query, clicks, impressions, ctr, position, prev_position, position_change, data_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(domain, kw.query, kw.clicks, kw.impressions, kw.ctr, kw.position, kw.prevPosition, kw.positionChange, dataDate).run();
      }
      console.log(`Stored ${keywords.length} keywords for ${domain}`);
    }
  } catch (e) {
    console.error(`Failed to fetch/store Search Console data: ${e.message}`);
  }
}

// Fetch and store performance data in D1
async function fetchAndStorePerformance(env, domain, propertyId, dataDate) {
  if (!env.DB) return;
  
  try {
    const creds = getCredentials(propertyId, env);
    
    // Fetch Cloudflare and CWV in parallel
    const [cloudflare, cwv, ga4] = await Promise.all([
      fetchCloudflareTraffic(creds.cloudflare, env).catch(e => ({ error: e.message })),
      fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY).catch(e => ({ error: e.message })),
      fetchGA4Analytics(creds.ga4).catch(e => ({ error: e.message }))
    ]);
    
    // Store in D1
    const rs = cloudflare.responseStatus || {};
    
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
      domain, dataDate,
      cloudflare.requests || 0,
      parseFloat(cloudflare.requestsChange) || 0,
      cloudflare.bandwidth || '0 B',
      parseFloat(cloudflare.cacheRatio) || 0,
      parseFloat(cloudflare.errorRate) || 0,
      cloudflare.threats || 0,
      rs.success || 0,
      rs.redirect || 0,
      rs.clientError || 0,
      rs.serverError || 0,
      cwv.LCP || null,
      cwv.lcpRating || null,
      cwv.INP || null,
      cwv.inpRating || null,
      cwv.CLS ?? null,
      cwv.clsRating || null,
      cwv.FCP || null,
      cwv.fcpRating || null,
      cwv.TTFB || null,
      cwv.overallCategory || null,
      ga4.sessions || null,
      parseFloat(ga4.sessionsChange) || null,
      ga4.newUsers || null,
      parseFloat(ga4.newUsersChange) || null,
      parseFloat(ga4.bounceRate) || null,
      ga4.avgDuration || null,
      parseFloat(ga4.engagementRate) || null,
      ga4.pageViews || null,
      ga4.topPages ? JSON.stringify(ga4.topPages) : null
    ).run();
    
    console.log(`Stored performance snapshot for ${domain}`);
  } catch (e) {
    console.error(`Failed to store performance data: ${e.message}`);
  }
}

// Audit a single page and extract internal links + accessibility
async function auditSinglePageWithLinks(url, domain) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'WineHealthDashboard/1.0' }
    });
    
    if (!response.ok) {
      return {
        url,
        path: new URL(url).pathname,
        status: response.status,
        error: true,
        title: { status: 'error' },
        description: { status: 'error' },
        h1: { count: 0 },
        schema: { found: false },
        accessibility: { issues: [] }
      };
    }
    
    const html = await response.text();
    const path = new URL(url).pathname;
    
    // Parse title
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const titleLen = title.length;
    let titleStatus = 'good';
    if (!title) titleStatus = 'missing';
    else if (titleLen < 30) titleStatus = 'too_short';
    else if (titleLen > 60) titleStatus = 'too_long';
    
    // Parse meta description
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
                      html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
    const description = descMatch ? descMatch[1].trim() : '';
    const descLen = description.length;
    let descStatus = 'good';
    if (!description) descStatus = 'missing';
    else if (descLen < 70) descStatus = 'too_short';
    else if (descLen > 160) descStatus = 'too_long';
    
    // Parse H1
    const h1Matches = html.match(/<h1[^>]*>/gi) || [];
    const h1Count = h1Matches.length;
    
    // Parse Schema.org JSON-LD
    const jsonLdMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    let schemaFound = jsonLdMatches.length > 0;
    let schemaTypes = [];
    let schemaErrors = 0;
    
    jsonLdMatches.forEach(match => {
      try {
        const jsonContent = match.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
        const parsed = JSON.parse(jsonContent);
        const items = parsed['@graph'] || [parsed];
        items.forEach(item => {
          if (item['@type']) {
            const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
            schemaTypes.push(...types);
          }
        });
      } catch (e) {
        schemaErrors++;
      }
    });
    
    // Parse Canonical URL
    const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["'][^>]*>/i) ||
                           html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["'][^>]*>/i);
    const canonical = canonicalMatch ? canonicalMatch[1].trim() : null;
    let canonicalStatus = 'good';
    if (!canonical) {
      canonicalStatus = 'missing';
    } else {
      try {
        const canonicalUrl = new URL(canonical, url);
        const pageUrl = new URL(url);
        // Check if canonical points to a different page (potential issue)
        if (canonicalUrl.pathname !== pageUrl.pathname && !canonical.includes(pageUrl.pathname)) {
          canonicalStatus = 'mismatch';
        }
      } catch (e) {
        canonicalStatus = 'invalid';
      }
    }
    
    // Parse Social Meta Tags (Open Graph)
    const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i)?.[1] || 
                    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:title["']/i)?.[1] || '';
    const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1] ||
                   html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:description["']/i)?.[1] || '';
    const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i)?.[1] ||
                    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:image["']/i)?.[1] || '';
    const ogUrl = html.match(/<meta[^>]*property=["']og:url["'][^>]*content=["']([^"']*)["']/i)?.[1] ||
                  html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:url["']/i)?.[1] || '';
    
    // Parse Twitter Card tags
    const twitterCard = html.match(/<meta[^>]*name=["']twitter:card["'][^>]*content=["']([^"']*)["']/i)?.[1] ||
                        html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']twitter:card["']/i)?.[1] || '';
    const twitterTitle = html.match(/<meta[^>]*name=["']twitter:title["'][^>]*content=["']([^"']*)["']/i)?.[1] ||
                         html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']twitter:title["']/i)?.[1] || '';
    const twitterDesc = html.match(/<meta[^>]*name=["']twitter:description["'][^>]*content=["']([^"']*)["']/i)?.[1] ||
                        html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']twitter:description["']/i)?.[1] || '';
    const twitterImage = html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']*)["']/i)?.[1] ||
                         html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']twitter:image["']/i)?.[1] || '';
    
    const socialMeta = {
      og: { title: ogTitle, description: ogDesc, image: ogImage, url: ogUrl },
      twitter: { card: twitterCard, title: twitterTitle, description: twitterDesc, image: twitterImage }
    };
    
    // Determine social meta status
    let socialStatus = 'good';
    const socialIssues = [];
    if (!ogTitle) socialIssues.push('Missing og:title');
    if (!ogDesc) socialIssues.push('Missing og:description');
    if (!ogImage) socialIssues.push('Missing og:image');
    if (!twitterCard) socialIssues.push('Missing twitter:card');
    if (socialIssues.length >= 3) socialStatus = 'poor';
    else if (socialIssues.length > 0) socialStatus = 'partial';
    
    // Image optimization checks
    const imgMatches = html.match(/<img[^>]*>/gi) || [];
    const imageIssues = [];
    imgMatches.forEach(img => {
      const issues = [];
      const src = img.match(/src=["']([^"']+)["']/i)?.[1] || '';
      
      // Check for lazy loading
      const hasLazyLoading = img.includes('loading="lazy"') || img.includes("loading='lazy'") || 
                             img.includes('data-src') || img.includes('lazyload');
      
      // Check for explicit dimensions
      const hasWidth = img.includes('width=') || img.includes('width:');
      const hasHeight = img.includes('height=') || img.includes('height:');
      
      // Check image format
      const isModernFormat = src.includes('.webp') || src.includes('.avif');
      const isLargeImage = src.includes('hero') || src.includes('banner') || src.includes('background') || 
                           src.includes('full') || src.includes('large');
      
      if (!hasLazyLoading && !img.includes('above-fold') && !src.includes('logo')) {
        issues.push('no-lazy');
      }
      if (!hasWidth || !hasHeight) {
        issues.push('no-dimensions');
      }
      if (!isModernFormat && (src.includes('.jpg') || src.includes('.jpeg') || src.includes('.png'))) {
        issues.push('not-webp');
      }
      
      if (issues.length > 0 && imageIssues.length < 10) {
        const snippet = img.length > 80 ? img.substring(0, 80) + '...' : img;
        imageIssues.push({ src: src.substring(0, 100), issues, snippet });
      }
    });
    
    // Accessibility checks
    const a11yIssues = [];
    
    // Check for images without alt text
    let missingAltSnippets = [];
    imgMatches.forEach(img => {
      if (!img.includes('alt=') || img.match(/alt=["']\s*["']/)) {
        // Truncate long img tags
        const snippet = img.length > 100 ? img.substring(0, 100) + '...' : img;
        if (missingAltSnippets.length < 5) missingAltSnippets.push(snippet);
      }
    });
    if (missingAltSnippets.length > 0) {
      a11yIssues.push({ type: 'missing_alt', count: missingAltSnippets.length, severity: 'high', snippets: missingAltSnippets });
    }
    
    // Check for missing lang attribute
    if (!html.match(/<html[^>]*lang=["'][^"']+["']/i)) {
      a11yIssues.push({ type: 'missing_lang', count: 1, severity: 'high' });
    }
    
    // Check for empty links
    const emptyLinkMatches = html.match(/<a[^>]*>(\s*)<\/a>/gi) || [];
    const emptyLinkSnippets = emptyLinkMatches.slice(0, 5).map(l => l.length > 80 ? l.substring(0, 80) + '...' : l);
    if (emptyLinkMatches.length > 0) {
      a11yIssues.push({ type: 'empty_links', count: emptyLinkMatches.length, severity: 'medium', snippets: emptyLinkSnippets });
    }
    
    // Check for missing form labels
    const inputs = (html.match(/<input[^>]*type=["'](text|email|password|tel|number|search)["'][^>]*>/gi) || []).length;
    const labels = (html.match(/<label[^>]*>/gi) || []).length;
    if (inputs > labels) {
      a11yIssues.push({ type: 'missing_labels', count: inputs - labels, severity: 'high' });
    }
    
    // Check for skip link
    if (!html.match(/skip[- ]?(to[- ]?)?(main|content|nav)/i)) {
      a11yIssues.push({ type: 'no_skip_link', count: 1, severity: 'low' });
    }
    
    // Check heading hierarchy (h1 should come before h2, etc)
    const headingOrder = html.match(/<h[1-6][^>]*>/gi) || [];
    let lastLevel = 0;
    let badHierarchy = false;
    headingOrder.forEach(h => {
      const level = parseInt(h.match(/h([1-6])/i)[1]);
      if (level > lastLevel + 1 && lastLevel > 0) {
        badHierarchy = true;
      }
      lastLevel = level;
    });
    if (badHierarchy) {
      a11yIssues.push({ type: 'heading_hierarchy', count: 1, severity: 'medium' });
    }
    
    // Check for buttons with no accessible text
    const emptyButtonMatches = html.match(/<button[^>]*>(\s*)<\/button>/gi) || [];
    const emptyButtonSnippets = emptyButtonMatches.slice(0, 5).map(b => b.length > 80 ? b.substring(0, 80) + '...' : b);
    if (emptyButtonMatches.length > 0) {
      a11yIssues.push({ type: 'empty_buttons', count: emptyButtonMatches.length, severity: 'high', snippets: emptyButtonSnippets });
    }
    
    // Extract internal links
    const internalLinks = [];
    const linkMatches = html.matchAll(/<a[^>]*href=["']([^"'#]+)["'][^>]*>/gi);
    for (const match of linkMatches) {
      const href = match[1];
      try {
        let fullUrl;
        if (href.startsWith('http')) {
          fullUrl = href;
        } else if (href.startsWith('/')) {
          fullUrl = `https://www.${domain}${href}`;
        } else {
          continue;
        }
        
        const linkUrl = new URL(fullUrl);
        if (linkUrl.hostname.includes(domain)) {
          internalLinks.push(fullUrl);
        }
      } catch (e) {
        // Invalid URL, skip
      }
    }
    
    return {
      url,
      path,
      status: response.status,
      title: { value: title.substring(0, 70), length: titleLen, status: titleStatus },
      description: { value: description.substring(0, 100), length: descLen, status: descStatus },
      h1: { count: h1Count },
      schema: { found: schemaFound, types: [...new Set(schemaTypes)], errors: schemaErrors },
      canonical: { url: canonical, status: canonicalStatus },
      socialMeta: { ...socialMeta, status: socialStatus, issues: socialIssues },
      imageOptimization: { issues: imageIssues, totalImages: imgMatches.length },
      accessibility: { issues: a11yIssues },
      internalLinks: [...new Set(internalLinks)]
    };
    
  } catch (e) {
    return {
      url,
      path: '',
      error: true,
      errorMessage: e.message,
      title: { status: 'error' },
      description: { status: 'error' },
      h1: { count: 0 },
      schema: { found: false },
      accessibility: { issues: [] }
    };
  }
}

// Check a list of URLs for broken links
async function checkBrokenLinks(urls) {
  const broken = [];
  const BATCH_SIZE = 10;
  
  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (url) => {
      try {
        const response = await fetch(url, { 
          method: 'HEAD',
          headers: { 'User-Agent': 'WineHealthDashboard/1.0' }
        });
        if (response.status >= 400) {
          return { url, status: response.status };
        }
        return null;
      } catch (e) {
        return { url, status: 0, error: e.message };
      }
    }));
    
    results.forEach(r => {
      if (r) broken.push(r);
    });
  }
  
  return broken;
}

// Fetch all URLs from a sitemap (handles sitemap indexes)
async function getAllSitemapUrls(sitemapUrl) {
  const urls = [];
  
  // Try the provided sitemap URL
  let xml = await fetchSitemapXml(sitemapUrl);
  
  // If that fails, try common sitemap paths
  if (!xml) {
    const domain = new URL(sitemapUrl).hostname;
    const fallbacks = [
      `https://${domain}/sitemap.xml`,
      `https://${domain}/sitemap_index.xml`,
      `https://www.${domain.replace('www.', '')}/sitemap.xml`
    ];
    
    for (const fallback of fallbacks) {
      if (fallback !== sitemapUrl) {
        console.log(`Trying fallback sitemap: ${fallback}`);
        xml = await fetchSitemapXml(fallback);
        if (xml) break;
      }
    }
  }
  
  if (!xml) {
    console.error(`Could not fetch any sitemap for ${sitemapUrl}`);
    return urls;
  }
  
  // Check if it's a sitemap index
  if (xml.includes('<sitemapindex')) {
    const sitemapMatches = xml.matchAll(/<loc>([^<]+)<\/loc>/gi);
    const childSitemaps = [...sitemapMatches].map(m => m[1]);
    
    console.log(`Found sitemap index with ${childSitemaps.length} child sitemaps`);
    
    for (const childUrl of childSitemaps) {
      try {
        const childXml = await fetchSitemapXml(childUrl);
        if (childXml) {
          const childUrls = [...childXml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1]);
          urls.push(...childUrls);
        }
      } catch (e) {
        console.error(`Error fetching child sitemap ${childUrl}:`, e);
      }
    }
  } else {
    // Regular sitemap
    const urlMatches = xml.matchAll(/<loc>([^<]+)<\/loc>/gi);
    urls.push(...[...urlMatches].map(m => m[1]));
  }
  
  console.log(`Found ${urls.length} URLs in sitemap`);
  return urls;
}

async function fetchSitemapXml(url) {
  try {
    // Ensure HTTPS
    const secureUrl = url.replace('http://', 'https://');
    console.log(`Fetching sitemap: ${secureUrl}`);
    
    const response = await fetch(secureUrl, {
      headers: { 'User-Agent': 'WineHealthDashboard/1.0' },
      redirect: 'follow'
    });
    
    if (!response.ok) {
      console.log(`Sitemap ${secureUrl} returned ${response.status}`);
      return null;
    }
    
    const text = await response.text();
    
    // Check if it looks like XML
    if (!text.includes('<') || !text.includes('loc>')) {
      console.log(`Sitemap ${secureUrl} doesn't appear to be valid XML (${text.length} bytes)`);
      return null;
    }
    
    return text;
  } catch (e) {
    console.error(`Error fetching sitemap ${url}:`, e.message);
    return null;
  }
}

// Lazy endpoint for site health (slow - fetches/parses HTML)
async function handleSiteHealth(request, env) {
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
    // Try to get data from D1 first (fast!)
    if (env.DB) {
      const data = await getActionableDataFromD1(env.DB, domain);
      if (data.hasData) {
        data.robotsTxt = await checkRobotsTxt(domain);
        return new Response(JSON.stringify(data), { headers });
      }
    }
    
    // Fallback to KV cache
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
    
    // No data - return empty with message
    return new Response(JSON.stringify({
      hasData: false,
      message: 'No audit data yet. Run /api/trigger-audit to start.',
      robotsTxt: await checkRobotsTxt(domain)
    }), { headers });
    
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
  }
}

// Get action-focused data from D1 - fast queries only
async function getActionableDataFromD1(db, domain) {
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  
  // Get latest audit info
  const latestAudit = await db.prepare(`
    SELECT audit_date, total_pages, pages_audited, duration_seconds 
    FROM audits WHERE domain = ? ORDER BY audit_date DESC LIMIT 1
  `).bind(domain).first();
  
  if (!latestAudit) {
    return { hasData: false };
  }
  
  // Get open issues grouped by type
  const openIssues = await db.prepare(`
    SELECT issue_type, severity, COUNT(*) as count,
           GROUP_CONCAT(page_url, '|||') as urls,
           GROUP_CONCAT(page_path, '|||') as paths,
           MIN(first_seen) as oldest,
           SUM(CASE WHEN first_seen >= ? THEN 1 ELSE 0 END) as new_this_week
    FROM issues 
    WHERE domain = ? AND fixed_at IS NULL
    GROUP BY issue_type, severity
    ORDER BY 
      CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      count DESC
  `).bind(weekAgo, domain).all();
  
  // Get recently fixed issues count
  const fixedThisWeek = await db.prepare(`
    SELECT COUNT(*) as count FROM issues 
    WHERE domain = ? AND fixed_at >= ?
  `).bind(domain, weekAgo).first();
  
  // Get new issues this week
  const newThisWeek = await db.prepare(`
    SELECT COUNT(*) as count FROM issues 
    WHERE domain = ? AND first_seen >= ? AND fixed_at IS NULL
  `).bind(domain, weekAgo).first();
  
  // Get open broken links
  const brokenLinks = await db.prepare(`
    SELECT link_url, link_path, status_code, first_seen, source_path,
           CASE WHEN first_seen >= ? THEN 1 ELSE 0 END as is_new
    FROM broken_links 
    WHERE domain = ? AND fixed_at IS NULL
    ORDER BY first_seen DESC
    LIMIT 25
  `).bind(weekAgo, domain).all();
  
  // Get total broken links count
  const brokenCount = await db.prepare(`
    SELECT COUNT(*) as count FROM broken_links WHERE domain = ? AND fixed_at IS NULL
  `).bind(domain).first();
  
  // Get progress - issues over last 4 weeks
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
  
  // Format issues for UI
  const actionItems = openIssues.results.map(i => ({
    type: i.issue_type,
    severity: i.severity,
    count: i.count,
    newThisWeek: i.new_this_week,
    message: formatIssueMessage(i.issue_type, i.count),
    urls: i.urls ? i.urls.split('|||').slice(0, 100) : [],
    pages: i.paths ? i.paths.split('|||').slice(0, 100) : []
  }));
  
  // Calculate totals
  const totalOpen = openIssues.results.reduce((sum, i) => sum + i.count, 0);
  
  return {
    hasData: true,
    fromD1: true,
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
      url: b.link_url,
      path: b.link_path,
      status: b.status_code,
      source: b.source_path,
      isNew: b.is_new === 1
    })),
    progress: progress.results.map(p => ({
      week: p.week,
      date: p.date,
      openIssues: p.open_issues
    }))
  };
}

function formatIssueMessage(type, count) {
  const messages = {
    missing_title: `${count} page(s) missing title tag`,
    short_title: `${count} page(s) with short titles`,
    missing_description: `${count} page(s) missing meta description`,
    short_description: `${count} page(s) with short descriptions`,
    missing_h1: `${count} page(s) missing H1 tag`,
    multiple_h1: `${count} page(s) with multiple H1 tags`,
    missing_schema: `${count} page(s) without structured data`,
    schema_error: `${count} page(s) with invalid schema`
  };
  return messages[type] || `${count} ${type} issue(s)`;
}

async function checkRobotsTxt(domain) {
  try {
    const robotsResponse = await fetch(`https://www.${domain}/robots.txt`);
    if (robotsResponse.ok) {
      const robotsText = await robotsResponse.text();
      const hasSitemap = robotsText.toLowerCase().includes('sitemap:');
      const hasDisallow = robotsText.toLowerCase().includes('disallow:');
      const sitemapMatch = robotsText.match(/sitemap:\s*(https?:\/\/[^\s]+)/i);
      
      return {
        accessible: true,
        hasSitemap,
        hasDisallow,
        sitemapUrl: sitemapMatch ? sitemapMatch[1] : `https://www.${domain}/sitemap.xml`,
        length: robotsText.length
      };
    } else {
      return { accessible: false, status: robotsResponse.status };
    }
  } catch (e) {
    return { accessible: false, error: e.message };
  }
}

// Quick SEO stats endpoint for Overview tab
async function handleSEOStats(domain, env) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=60'
  };
  
  if (!domain || !env.DB) {
    return new Response(JSON.stringify({ hasData: false }), { headers });
  }
  
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    // Get quick summary counts
    const stats = await env.DB.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND fixed_at IS NULL) as open_issues,
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND fixed_at >= ?) as fixed_this_week,
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND first_seen >= ? AND fixed_at IS NULL) as new_this_week,
        (SELECT COUNT(*) FROM broken_links WHERE domain = ? AND fixed_at IS NULL) as broken_links,
        (SELECT audit_date FROM audits WHERE domain = ? ORDER BY audit_date DESC LIMIT 1) as last_audit
    `).bind(domain, domain, weekAgo, domain, weekAgo, domain, domain).first();
    
    // Get top issues with URLs
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
    
    // Get recently fixed issues
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
        type: i.issue_type,
        severity: i.severity,
        count: i.count,
        newCount: i.new_count,
        message: formatIssueMessage(i.issue_type, i.count),
        urls: i.urls ? i.urls.split('|||') : [],
        pages: i.pages ? i.pages.split('|||') : []
      })),
      fixedIssues: fixedIssues.results.map(i => ({
        type: i.issue_type,
        severity: i.severity,
        count: i.count,
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

// Accessibility issues API endpoint
async function handleAccessibility(domain, env) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=60'
  };
  
  if (!domain || !env.DB) {
    return new Response(JSON.stringify({ hasData: false }), { headers });
  }
  
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    // Get accessibility issues with individual page details
    const issues = await env.DB.prepare(`
      SELECT issue_type, severity, page_path, page_url, issue_count, snippets, first_seen
      FROM accessibility_issues 
      WHERE domain = ? AND fixed_at IS NULL
      ORDER BY 
        CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        issue_type, page_path
    `).bind(domain).all();
    
    // Group by issue type
    const grouped = {};
    for (const row of issues.results || []) {
      if (!grouped[row.issue_type]) {
        grouped[row.issue_type] = {
          type: row.issue_type,
          severity: row.severity,
          count: 0,
          pageCount: 0,
          newThisWeek: 0,
          pages: []
        };
      }
      grouped[row.issue_type].count += row.issue_count || 1;
      grouped[row.issue_type].pageCount++;
      if (row.first_seen >= weekAgo) grouped[row.issue_type].newThisWeek++;
      
      // Parse snippets for this page
      let snippets = [];
      if (row.snippets) {
        try { snippets = JSON.parse(row.snippets); } catch(e) {}
      }
      
      grouped[row.issue_type].pages.push({
        url: row.page_url,
        path: row.page_path,
        count: row.issue_count || 1,
        snippets: snippets
      });
    }
    
    // Convert to array and limit pages per issue
    const issueList = Object.values(grouped).map(g => ({
      ...g,
      pages: g.pages.slice(0, 50)
    }));
    
    return new Response(JSON.stringify({
      hasData: issueList.length > 0,
      issues: issueList
    }), { headers });
    
  } catch (e) {
    console.error('Accessibility error:', e);
    return new Response(JSON.stringify({ hasData: false, error: e.message }), { headers });
  }
}

// Keywords from D1
async function handleKeywords(domain, env) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  };
  
  if (!domain || !env.DB) {
    return new Response(JSON.stringify({ hasData: false }), { headers });
  }
  
  // Branded terms to filter out
  const brandedTerms = [
    'viansa', 'kunde', 'br cohn', 'brcohn', 'b.r. cohn', 'girard', 'clos pegase', 
    'clospegase', 'adair', 'adair family', 'adair vineyards',
    // Common brand misspellings
    'viansa sonoma', 'kunde family', 'girard winery', 'clos pegase winery'
  ];
  
  function isBranded(query) {
    const q = query.toLowerCase();
    return brandedTerms.some(brand => q.includes(brand));
  }
  
  try {
    // Get latest keywords for this domain (top performers)
    const keywords = await env.DB.prepare(`
      SELECT query, clicks, impressions, ctr, position, prev_position, position_change, data_date
      FROM keywords 
      WHERE domain = ? AND data_date = (SELECT MAX(data_date) FROM keywords WHERE domain = ?)
      ORDER BY clicks DESC
      LIMIT 30
    `).bind(domain, domain).all();
    
    // Get keyword opportunities: non-branded, position 5-30, decent impressions
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
    
    // Filter opportunities to remove branded terms and calculate potential
    const filteredOpportunities = (opportunities.results || [])
      .filter(k => !isBranded(k.query))
      .map(k => {
        // Potential score: higher impressions + room to improve position = higher potential
        const positionGap = k.position - 3; // How far from top 3
        const potential = Math.round(k.impressions * (positionGap / 10));
        return {
          query: k.query,
          clicks: k.clicks,
          impressions: k.impressions,
          ctr: (k.ctr * 100).toFixed(1) + '%',
          position: k.position.toFixed(1),
          positionChange: k.position_change,
          potential,
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
        query: k.query,
        clicks: k.clicks,
        impressions: k.impressions,
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

// All Fixed Issues - for portfolio view
async function handleAllFixedIssues(env) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  };
  
  if (!env.DB) {
    return new Response(JSON.stringify({ hasData: false }), { headers });
  }
  
  try {
    // Get all fixed SEO issues
    const seoFixed = await env.DB.prepare(`
      SELECT domain, issue_type, severity, page_path, page_url, first_seen, fixed_at
      FROM issues 
      WHERE fixed_at IS NOT NULL
      ORDER BY fixed_at DESC
    `).all();
    
    // Get all fixed accessibility issues
    const a11yFixed = await env.DB.prepare(`
      SELECT domain, issue_type, severity, page_path, page_url, first_seen, fixed_at
      FROM accessibility_issues 
      WHERE fixed_at IS NOT NULL
      ORDER BY fixed_at DESC
    `).all();
    
    const allFixed = [
      ...(seoFixed.results || []).map(i => ({ ...i, category: 'SEO' })),
      ...(a11yFixed.results || []).map(i => ({ ...i, category: 'Accessibility' }))
    ].sort((a, b) => new Date(b.fixed_at) - new Date(a.fixed_at));
    
    return new Response(JSON.stringify({
      hasData: allFixed.length > 0,
      totalFixed: allFixed.length,
      issues: allFixed
    }), { headers });
    
  } catch (e) {
    console.error('All fixed issues error:', e);
    return new Response(JSON.stringify({ hasData: false, error: e.message }), { headers });
  }
}

// Performance History for Charts
async function handlePerformanceHistory(env) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  };
  
  if (!env.DB) {
    return new Response(JSON.stringify({ hasData: false }), { headers });
  }
  
  try {
    // Get last 30 days of performance data for all domains
    const history = await env.DB.prepare(`
      SELECT domain, date, lcp_ms, fcp_ms, cls, inp_ms, ttfb_ms
      FROM performance_history
      WHERE date >= date('now', '-30 days')
      ORDER BY date ASC
    `).all();
    
    // Group by domain
    const byDomain = {};
    for (const row of history.results || []) {
      if (!byDomain[row.domain]) {
        byDomain[row.domain] = [];
      }
      byDomain[row.domain].push({
        date: row.date,
        lcp: row.lcp_ms,
        fcp: row.fcp_ms,
        cls: row.cls,
        inp: row.inp_ms,
        ttfb: row.ttfb_ms
      });
    }
    
    return new Response(JSON.stringify({
      hasData: Object.keys(byDomain).length > 0,
      history: byDomain
    }), { headers });
    
  } catch (e) {
    console.error('Performance history error:', e);
    return new Response(JSON.stringify({ hasData: false, error: e.message }), { headers });
  }
}

// Store Performance Snapshot (call daily via cron or manually)
async function storePerformanceSnapshot(env) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };
  
  if (!env.DB || !env.PAGESPEED_API_KEY) {
    return new Response(JSON.stringify({ success: false, error: 'Not configured' }), { headers });
  }
  
  const domains = [
    'viansa.com',
    'kunde.com', 
    'brcohn.com',
    'clospegase.com',
    'girardwinery.com',
    'adairfamilywines.com'
  ];
  
  const today = new Date().toISOString().split('T')[0];
  const results = [];
  
  for (const domain of domains) {
    try {
      const cwv = await fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY);
      
      if (cwv && !cwv.error) {
        await env.DB.prepare(`
          INSERT INTO performance_history (domain, date, lcp_ms, fcp_ms, cls, inp_ms, ttfb_ms, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(domain, date) DO UPDATE SET
            lcp_ms = excluded.lcp_ms,
            fcp_ms = excluded.fcp_ms,
            cls = excluded.cls,
            inp_ms = excluded.inp_ms,
            ttfb_ms = excluded.ttfb_ms,
            recorded_at = excluded.recorded_at
        `).bind(
          domain, 
          today, 
          cwv.LCP || null, 
          cwv.FCP || null, 
          cwv.CLS || null, 
          cwv.INP || null, 
          cwv.TTFB || null,
          new Date().toISOString()
        ).run();
        
        results.push({ domain, success: true, lcp: cwv.LCP });
      } else {
        results.push({ domain, success: false, error: cwv?.error || 'No data' });
      }
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

// 404 Errors from Cloudflare Analytics
async function handle404Errors(propertyId, env) {
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
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const query = `
      query {
        viewer {
          zones(filter: {zoneTag: "${zoneId}"}) {
            httpRequests1dGroups(
              filter: {date_geq: "${startDate}", date_leq: "${endDate}"}
              limit: 100
              orderBy: [sum_requests_DESC]
            ) {
              dimensions {
                clientRequestPath
              }
              sum {
                requests
                pageViews
                edgeResponseStatus404
              }
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
    
    // Filter to just 404s and aggregate
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
    
    // Sort by count and take top 50
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

// Lazy endpoint for Core Web Vitals (slow - PageSpeed API)
async function handleCoreWebVitals(request, env) {
  const url = new URL(request.url);
  const domain = url.searchParams.get('domain');
  
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
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

// Comprehensive performance endpoint - Cloudflare + GA4 + CWV
async function handlePerformance(request, env) {
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
    // Try D1 cache first (unless fresh requested)
    if (!fresh && env.DB) {
      const cached = await getPerformanceFromD1(env.DB, domain);
      if (cached) {
        return new Response(JSON.stringify({ ...cached, fromCache: true }), { headers });
      }
    }
    
    const creds = getCredentials(propertyId, env);
    
    // Fetch all data in parallel
    const [cloudflare, ga4, cwv] = await Promise.all([
      fetchCloudflareTraffic(creds.cloudflare, env),
      fetchGA4Analytics(creds.ga4),
      fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY).catch(e => ({ error: e.message }))
    ]);
    
    return new Response(JSON.stringify({
      cloudflare,
      ga4,
      cwv,
      fromCache: false
    }), { headers });
    
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
  }
}

// Get cached performance data from D1
async function getPerformanceFromD1(db, domain) {
  try {
    const row = await db.prepare(`
      SELECT * FROM performance_snapshots 
      WHERE domain = ? 
      ORDER BY snapshot_date DESC 
      LIMIT 1
    `).bind(domain).first();
    
    if (!row) return null;
    
    // Return formatted data
    return {
      cloudflare: {
        requests: row.cf_requests,
        requestsChange: row.cf_requests_change?.toFixed(1) || '0.0',
        bandwidth: row.cf_bandwidth,
        cacheRatio: row.cf_cache_ratio?.toFixed(1) || '0.0',
        errorRate: row.cf_error_rate?.toFixed(2) || '0.00',
        threats: row.cf_threats,
        responseStatus: {
          success: row.cf_2xx || 0,
          redirect: row.cf_3xx || 0,
          clientError: row.cf_4xx || 0,
          serverError: row.cf_5xx || 0
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
        LCP: row.cwv_lcp,
        lcpRating: row.cwv_lcp_rating,
        INP: row.cwv_inp,
        inpRating: row.cwv_inp_rating,
        CLS: row.cwv_cls,
        clsRating: row.cwv_cls_rating,
        FCP: row.cwv_fcp,
        fcpRating: row.cwv_fcp_rating,
        TTFB: row.cwv_ttfb,
        overallCategory: row.cwv_overall
      } : { error: 'No CWV data' },
      snapshotDate: row.snapshot_date
    };
  } catch (e) {
    console.error('D1 performance cache error:', e);
    return null;
  }
}

// Fetch Cloudflare traffic metrics
async function fetchCloudflareTraffic(creds, env) {
  if (!creds.apiToken || creds.zoneIds.length === 0) {
    return { error: 'Cloudflare not configured' };
  }
  
  const cfHeaders = { 'Authorization': `Bearer ${creds.apiToken}`, 'Content-Type': 'application/json' };
  const { startDate, endDate } = getDateRange(7);
  const { startDate: prevStartDate, endDate: prevEndDate } = getDateRange(14, 7);
  
  let totalRequests = 0, totalBytes = 0, totalCachedBytes = 0, totalThreats = 0, totalPageViews = 0;
  let prevRequests = 0, prevPageViews = 0;
  let responseStatus = { success: 0, redirect: 0, clientError: 0, serverError: 0 };
  let dailyData = [];
  
  for (const zoneId of creds.zoneIds) {
    try {
      // Current period
      const result = await cloudflareGraphQL(cfHeaders, `
        query {
          viewer {
            zones(filter: {zoneTag: "${zoneId}"}) {
              httpRequests1dGroups(limit: 7, filter: {date_geq: "${startDate}", date_leq: "${endDate}"}, orderBy: [date_ASC]) {
                dimensions { date }
                sum { 
                  requests bytes cachedBytes threats pageViews
                  responseStatusMap { edgeResponseStatus requests }
                }
              }
            }
          }
        }
      `);
      
      const data = result?.data?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
      data.forEach(day => {
        totalRequests += day.sum?.requests || 0;
        totalBytes += day.sum?.bytes || 0;
        totalCachedBytes += day.sum?.cachedBytes || 0;
        totalThreats += day.sum?.threats || 0;
        totalPageViews += day.sum?.pageViews || 0;
        
        dailyData.push({
          date: day.dimensions?.date,
          requests: day.sum?.requests || 0,
          pageViews: day.sum?.pageViews || 0
        });
        
        // Response status codes
        (day.sum?.responseStatusMap || []).forEach(s => {
          const status = s.edgeResponseStatus;
          const count = s.requests || 0;
          if (status >= 200 && status < 300) responseStatus.success += count;
          else if (status >= 300 && status < 400) responseStatus.redirect += count;
          else if (status >= 400 && status < 500) responseStatus.clientError += count;
          else if (status >= 500) responseStatus.serverError += count;
        });
      });
      
      // Previous period for comparison
      const prevResult = await cloudflareGraphQL(cfHeaders, `
        query {
          viewer {
            zones(filter: {zoneTag: "${zoneId}"}) {
              httpRequests1dGroups(limit: 7, filter: {date_geq: "${prevStartDate}", date_leq: "${prevEndDate}"}) {
                sum { requests pageViews }
              }
            }
          }
        }
      `);
      
      const prevData = prevResult?.data?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
      prevData.forEach(day => {
        prevRequests += day.sum?.requests || 0;
        prevPageViews += day.sum?.pageViews || 0;
      });
      
    } catch (e) {
      console.error(`Cloudflare traffic error:`, e);
    }
  }
  
  const cacheRatio = totalBytes > 0 ? (totalCachedBytes / totalBytes) * 100 : 0;
  const requestsChange = prevRequests > 0 ? ((totalRequests - prevRequests) / prevRequests) * 100 : 0;
  const pageViewsChange = prevPageViews > 0 ? ((totalPageViews - prevPageViews) / prevPageViews) * 100 : 0;
  
  return {
    requests: totalRequests,
    requestsChange: requestsChange.toFixed(1),
    bandwidth: formatBytes(totalBytes),
    cacheRatio: cacheRatio.toFixed(1),
    pageViews: totalPageViews,
    pageViewsChange: pageViewsChange.toFixed(1),
    threats: totalThreats,
    responseStatus,
    errorRate: totalRequests > 0 ? ((responseStatus.clientError + responseStatus.serverError) / totalRequests * 100).toFixed(2) : 0,
    dailyData
  };
}

// Fetch GA4 Analytics data
async function fetchGA4Analytics(creds) {
  if (!creds.propertyId || !creds.credentials) {
    return { error: 'GA4 not configured' };
  }
  
  try {
    const accessToken = await getGoogleAccessToken(creds.credentials);
    const propertyId = creds.propertyId;
    
    // Fetch current period (7 days)
    const response = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          dateRanges: [
            { startDate: '7daysAgo', endDate: 'yesterday' },
            { startDate: '14daysAgo', endDate: '8daysAgo' }
          ],
          metrics: [
            { name: 'sessions' },
            { name: 'averageSessionDuration' },
            { name: 'screenPageViews' },
            { name: 'bounceRate' },
            { name: 'newUsers' },
            { name: 'engagementRate' }
          ]
        })
      }
    );
    
    if (!response.ok) {
      const errText = await response.text();
      console.error('GA4 API error:', errText);
      return { error: 'GA4 API error', details: errText.substring(0, 200) };
    }
    
    const data = await response.json();
    const rows = data.rows || [];
    
    // Current period is first row, previous period is second
    const current = rows[0]?.metricValues || [];
    const previous = rows[1]?.metricValues || [];
    
    const sessions = parseInt(current[0]?.value || 0);
    const prevSessions = parseInt(previous[0]?.value || 0);
    const avgDuration = parseFloat(current[1]?.value || 0);
    const pageViews = parseInt(current[2]?.value || 0);
    const bounceRate = parseFloat(current[3]?.value || 0) * 100;
    const newUsers = parseInt(current[4]?.value || 0);
    const prevNewUsers = parseInt(previous[4]?.value || 0);
    const engagementRate = parseFloat(current[5]?.value || 0) * 100;
    
    const sessionsChange = prevSessions > 0 ? ((sessions - prevSessions) / prevSessions) * 100 : 0;
    const newUsersChange = prevNewUsers > 0 ? ((newUsers - prevNewUsers) / prevNewUsers) * 100 : 0;
    
    // Get top pages
    const pagesResponse = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
          dimensions: [{ name: 'pagePath' }],
          metrics: [{ name: 'screenPageViews' }, { name: 'averageSessionDuration' }],
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: 10
        })
      }
    );
    
    let topPages = [];
    if (pagesResponse.ok) {
      const pagesData = await pagesResponse.json();
      topPages = (pagesData.rows || []).map(row => ({
        path: row.dimensionValues[0]?.value || '/',
        views: parseInt(row.metricValues[0]?.value || 0),
        avgTime: parseFloat(row.metricValues[1]?.value || 0).toFixed(1)
      }));
    }
    
    return {
      sessions,
      sessionsChange: sessionsChange.toFixed(1),
      newUsers,
      newUsersChange: newUsersChange.toFixed(1),
      pageViews,
      bounceRate: bounceRate.toFixed(1),
      avgDuration: formatDuration(avgDuration),
      avgDurationSec: avgDuration,
      engagementRate: engagementRate.toFixed(1),
      topPages
    };
    
  } catch (e) {
    console.error('GA4 error:', e);
    return { error: e.message };
  }
}

function formatDuration(seconds) {
  if (seconds < 60) return Math.round(seconds) + 's';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return mins + 'm ' + secs + 's';
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const PROPERTIES = {
  adair: { name: "Adair Family Wines", shortName: "Adair", color: "#8B4513", domain: "adairfamilywines.com" },
  brcohn: { name: "BR Cohn", shortName: "BR Cohn", color: "#722F37", domain: "brcohn.com" },
  clospegase: { name: "Clos Pegase", shortName: "Clos Pegase", color: "#4A0E0E", domain: "clospegase.com" },
  girard: { name: "Girard Winery", shortName: "Girard", color: "#1a1a2e", domain: "girardwinery.com" },
  kunde: { name: "Kunde Family Winery", shortName: "Kunde", color: "#2E5339", domain: "kunde.com" },
  viansa: { name: "Viansa Sonoma", shortName: "Viansa", color: "#D4A84B", domain: "viansa.com" }
};

const PROPERTY_IDS = Object.keys(PROPERTIES);

function getCredentials(propertyId, env) {
  const prefix = propertyId.toUpperCase();
  return {
    cloudflare: {
      apiToken: env.CLOUDFLARE_API_TOKEN,
      zoneIds: parseList(env[`${prefix}_CF_ZONE_IDS`])
    },
    searchConsole: {
      properties: parseList(env[`${prefix}_GSC_PROPERTIES`]),
      credentials: env.GOOGLE_SERVICE_ACCOUNT
    },
    ga4: {
      propertyId: env[`${prefix}_GA4_PROPERTY_ID`],
      credentials: env.GOOGLE_SERVICE_ACCOUNT
    }
  };
}

function parseList(value) {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

// ============================================================================
// API HANDLER
// ============================================================================

async function handleAPI(request, env) {
  const url = new URL(request.url);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  };

  try {
    const propertyParam = url.searchParams.get('property');
    const debugParam = url.searchParams.get('debug');
    
    // Debug endpoint to check Web Vitals query
    if (debugParam === 'vitals') {
      const zoneId = url.searchParams.get('zone') || '152084b83d9eccf45eee4eb6606bb9e0';
      const { startDate, endDate } = getDateRange(7);
      
      const cfHeaders = { 
        'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 
        'Content-Type': 'application/json' 
      };
      
      // First get the account ID from the zone
      const zoneInfoQuery = `
        query {
          viewer {
            zones(filter: {zoneTag: "${zoneId}"}) {
              accountName
              name
            }
          }
        }
      `;
      
      // Try to get account ID via REST API
      const zoneResponse = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}`, {
        headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` }
      });
      const zoneData = await zoneResponse.json();
      const accountId = zoneData?.result?.account?.id;
      const zoneName = zoneData?.result?.name;
      
      let rumResult = null;
      if (accountId) {
        // Get site tags with hostnames and try to get web vitals
        const rumQuery = `
          query {
            viewer {
              accounts(filter: {accountTag: "${accountId}"}) {
                rumPageloadEventsAdaptiveGroups(
                  filter: {
                    AND: [
                      {date_geq: "${startDate}"},
                      {date_leq: "${endDate}"}
                    ]
                  }
                  limit: 10
                ) {
                  count
                  dimensions {
                    siteTag
                    requestHost
                  }
                  avg {
                    sampleInterval
                  }
                }
                rumPerformanceEventsAdaptiveGroups(
                  filter: {
                    AND: [
                      {date_geq: "${startDate}"},
                      {date_leq: "${endDate}"}
                    ]
                  }
                  limit: 10
                ) {
                  count
                  dimensions {
                    siteTag
                  }
                  avg {
                    firstContentfulPaint
                    firstPaint
                    loadEventTime
                    pageRenderTime
                  }
                }
              }
            }
          }
        `;
        rumResult = await cloudflareGraphQL(cfHeaders, rumQuery);
      }
      
      return new Response(JSON.stringify({
        zoneId,
        zoneName,
        accountId,
        dateRange: { startDate, endDate },
        rumResult
      }, null, 2), { headers });
    }
    
    // Debug PageSpeed specifically
    if (debugParam === 'pagespeed') {
      const domain = url.searchParams.get('domain') || 'viansa.com';
      const apiKey = env.PAGESPEED_API_KEY;
      
      try {
        let psUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://www.${domain}&strategy=mobile&category=performance`;
        if (apiKey) {
          psUrl += `&key=${apiKey}`;
        }
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
        return new Response(JSON.stringify({
          domain,
          error: e.message
        }, null, 2), { headers });
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
// DATA FETCHING
// ============================================================================

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
    name: property.name,
    shortName: property.shortName,
    color: property.color,
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
  
  // FAST PATH: Only fetch D1 stats for overview (instant)
  const seoStats = env.DB ? await getSEOStatsFromD1(env.DB, property.domain) : null;
  
  return {
    type: 'detail',
    propertyId,
    property: { name: property.name, shortName: property.shortName, color: property.color, domain: property.domain },
    generatedAt: new Date().toISOString(),
    seoStats
  };
}

// Separate slow endpoint for Cloudflare data (called lazily)
async function fetchCloudflareData(propertyId, env) {
  const property = PROPERTIES[propertyId];
  if (!property) throw new Error(`Unknown property: ${propertyId}`);
  
  const creds = getCredentials(propertyId, env);
  return await fetchCloudflareDetail(creds.cloudflare, env);
}

// Separate slow endpoint for Search Console data (called lazily)  
async function fetchSearchConsoleData(propertyId, env) {
  const property = PROPERTIES[propertyId];
  if (!property) throw new Error(`Unknown property: ${propertyId}`);
  
  const creds = getCredentials(propertyId, env);
  return await fetchSearchConsoleDetail(creds.searchConsole);
}

// Comprehensive performance data from Cloudflare + GA4 + CWV
async function fetchComprehensivePerformance(propertyId, domain, env) {
  const creds = getCredentials(propertyId, env);
  const { startDate, endDate } = getDateRange(7);
  
  // Fetch all data sources in parallel
  const [cloudflare, ga4, cwv] = await Promise.all([
    fetchCloudflarePerformance(creds.cloudflare, env),
    fetchGA4Performance(creds.ga4),
    fetchCoreWebVitals(domain)
  ]);
  
  return { cloudflare, ga4, cwv };
}

// Cloudflare traffic and performance data
async function fetchCloudflarePerformance(creds, env) {
  if (!creds.apiToken || creds.zoneIds.length === 0) {
    return { error: 'Cloudflare not configured' };
  }
  
  const headers = { 'Authorization': `Bearer ${creds.apiToken}`, 'Content-Type': 'application/json' };
  const { startDate, endDate } = getDateRange(7);
  const { startDate: prevStartDate, endDate: prevEndDate } = getDateRange(14, 7);
  
  let traffic = { requests: 0, pageViews: 0, bandwidth: 0, cachedBytes: 0, threats: 0 };
  let prevTraffic = { requests: 0, pageViews: 0 };
  let responseCodes = { success: 0, redirect: 0, clientError: 0, serverError: 0 };
  let ttfb = { total: 0, count: 0 };
  
  for (const zoneId of creds.zoneIds) {
    try {
      // Current period traffic
      const result = await cloudflareGraphQL(headers, `
        query {
          viewer {
            zones(filter: {zoneTag: "${zoneId}"}) {
              current: httpRequests1dGroups(limit: 7, filter: {date_geq: "${startDate}", date_leq: "${endDate}"}) {
                sum { requests bytes cachedBytes threats pageViews }
              }
              previous: httpRequests1dGroups(limit: 7, filter: {date_geq: "${prevStartDate}", date_leq: "${prevEndDate}"}) {
                sum { requests pageViews }
              }
              statusCodes: httpRequestsAdaptiveGroups(
                filter: {date_geq: "${startDate}", date_leq: "${endDate}"}
                limit: 20
                orderBy: [count_DESC]
              ) {
                count
                dimensions { edgeResponseStatus }
              }
              performance: httpRequestsAdaptiveGroups(
                filter: {date_geq: "${startDate}", date_leq: "${endDate}"}
                limit: 1
              ) {
                count
                avg { edgeTimeToFirstByteMs }
              }
            }
          }
        }
      `);
      
      const zone = result?.data?.viewer?.zones?.[0];
      
      // Current traffic
      (zone?.current || []).forEach(day => {
        traffic.requests += day.sum?.requests || 0;
        traffic.pageViews += day.sum?.pageViews || 0;
        traffic.bandwidth += day.sum?.bytes || 0;
        traffic.cachedBytes += day.sum?.cachedBytes || 0;
        traffic.threats += day.sum?.threats || 0;
      });
      
      // Previous traffic for comparison
      (zone?.previous || []).forEach(day => {
        prevTraffic.requests += day.sum?.requests || 0;
        prevTraffic.pageViews += day.sum?.pageViews || 0;
      });
      
      // Response codes
      (zone?.statusCodes || []).forEach(s => {
        const code = s.dimensions?.edgeResponseStatus;
        if (code >= 200 && code < 300) responseCodes.success += s.count;
        else if (code >= 300 && code < 400) responseCodes.redirect += s.count;
        else if (code >= 400 && code < 500) responseCodes.clientError += s.count;
        else if (code >= 500) responseCodes.serverError += s.count;
      });
      
      // TTFB
      (zone?.performance || []).forEach(p => {
        if (p.avg?.edgeTimeToFirstByteMs) {
          ttfb.total += p.avg.edgeTimeToFirstByteMs * p.count;
          ttfb.count += p.count;
        }
      });
      
    } catch (e) {
      console.error('Cloudflare performance error:', e);
    }
  }
  
  // Calculate metrics
  const cacheHitRatio = traffic.bandwidth > 0 ? (traffic.cachedBytes / traffic.bandwidth) * 100 : 0;
  const avgTTFB = ttfb.count > 0 ? Math.round(ttfb.total / ttfb.count) : null;
  const requestsChange = prevTraffic.requests > 0 ? ((traffic.requests - prevTraffic.requests) / prevTraffic.requests) * 100 : 0;
  const pageViewsChange = prevTraffic.pageViews > 0 ? ((traffic.pageViews - prevTraffic.pageViews) / prevTraffic.pageViews) * 100 : 0;
  
  return {
    requests: traffic.requests,
    pageViews: traffic.pageViews,
    bandwidth: formatBytes(traffic.bandwidth),
    bandwidthBytes: traffic.bandwidth,
    cacheHitRatio: cacheHitRatio.toFixed(1),
    threats: traffic.threats,
    ttfb: avgTTFB,
    responseCodes,
    requestsChange: requestsChange.toFixed(1),
    pageViewsChange: pageViewsChange.toFixed(1)
  };
}

// GA4 user experience data
async function fetchGA4Performance(creds) {
  if (!creds.propertyId || !creds.credentials) {
    return { error: 'GA4 not configured', note: 'Add GA4_PROPERTY_ID to enable' };
  }
  
  try {
    const accessToken = await getGoogleAccessToken(creds.credentials);
    const propertyId = creds.propertyId;
    
    // GA4 Data API request
    const response = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
      {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${accessToken}`, 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({
          dateRanges: [
            { startDate: '7daysAgo', endDate: 'today' },
            { startDate: '14daysAgo', endDate: '8daysAgo' }
          ],
          metrics: [
            { name: 'sessions' },
            { name: 'totalUsers' },
            { name: 'bounceRate' },
            { name: 'averageSessionDuration' },
            { name: 'engagementRate' },
            { name: 'screenPageViews' }
          ]
        })
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('GA4 API error:', errorText);
      return { error: 'GA4 API error', details: errorText };
    }
    
    const data = await response.json();
    const rows = data.rows || [];
    
    // Current period (first row)
    const current = rows[0]?.metricValues || [];
    // Previous period (second row)  
    const previous = rows[1]?.metricValues || [];
    
    const sessions = parseInt(current[0]?.value || 0);
    const users = parseInt(current[1]?.value || 0);
    const bounceRate = parseFloat(current[2]?.value || 0) * 100;
    const avgDuration = parseFloat(current[3]?.value || 0);
    const engagementRate = parseFloat(current[4]?.value || 0) * 100;
    const pageViews = parseInt(current[5]?.value || 0);
    
    const prevSessions = parseInt(previous[0]?.value || 0);
    const prevUsers = parseInt(previous[1]?.value || 0);
    
    return {
      sessions,
      users,
      bounceRate: bounceRate.toFixed(1),
      avgDuration: formatDuration(avgDuration),
      avgDurationSec: avgDuration,
      engagementRate: engagementRate.toFixed(1),
      pageViews,
      sessionsChange: prevSessions > 0 ? (((sessions - prevSessions) / prevSessions) * 100).toFixed(1) : '0',
      usersChange: prevUsers > 0 ? (((users - prevUsers) / prevUsers) * 100).toFixed(1) : '0'
    };
    
  } catch (e) {
    console.error('GA4 fetch error:', e);
    return { error: e.message };
  }
}

// Format duration in seconds to human readable
// Core Web Vitals from PageSpeed/CrUX
async function fetchCoreWebVitals(domain) {
  try {
    const url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://www.${domain}&category=performance&strategy=mobile`;
    const response = await fetch(url);
    
    if (!response.ok) {
      return { error: 'PageSpeed API error' };
    }
    
    const data = await response.json();
    const crux = data.loadingExperience || {};
    const metrics = crux.metrics || {};
    
    // Extract CrUX field data (real users)
    const lcp = metrics.LARGEST_CONTENTFUL_PAINT_MS;
    const fid = metrics.FIRST_INPUT_DELAY_MS;
    const inp = metrics.INTERACTION_TO_NEXT_PAINT;
    const cls = metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE;
    const fcp = metrics.FIRST_CONTENTFUL_PAINT_MS;
    const ttfb = metrics.EXPERIMENTAL_TIME_TO_FIRST_BYTE;
    
    return {
      LCP: lcp?.percentile,
      lcpRating: lcp?.category,
      INP: inp?.percentile,
      inpRating: inp?.category,
      CLS: cls?.percentile ? cls.percentile / 100 : null,
      clsRating: cls?.category,
      FCP: fcp?.percentile,
      fcpRating: fcp?.category,
      TTFB: ttfb?.percentile,
      ttfbRating: ttfb?.category,
      overallCategory: crux.overall_category
    };
    
  } catch (e) {
    console.error('CWV fetch error:', e);
    return { error: e.message };
  }
}
async function getSEOStatsFromD1(db, domain) {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const stats = await db.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND fixed_at IS NULL) as open_issues,
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND fixed_at >= ?) as fixed_this_week,
        (SELECT COUNT(*) FROM issues WHERE domain = ? AND first_seen >= ? AND fixed_at IS NULL) as new_this_week,
        (SELECT COUNT(*) FROM broken_links WHERE domain = ? AND fixed_at IS NULL) as broken_links,
        (SELECT audit_date FROM audits WHERE domain = ? ORDER BY audit_date DESC LIMIT 1) as last_audit
    `).bind(domain, domain, weekAgo, domain, weekAgo, domain, domain).first();
    
    if (!stats || !stats.last_audit) {
      return null;
    }
    
    // Get top 3 issues for overview
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
        type: i.issue_type,
        severity: i.severity,
        count: i.count,
        newCount: i.new_count,
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
// CLOUDFLARE API
// ============================================================================

async function fetchCloudflareSummary(creds) {
  if (!creds.apiToken || creds.zoneIds.length === 0) {
    return { error: 'Cloudflare not configured' };
  }

  const headers = { 'Authorization': `Bearer ${creds.apiToken}`, 'Content-Type': 'application/json' };
  const { startDate, endDate } = getDateRange(7);

  let totalRequests = 0, totalBytes = 0, totalCachedBytes = 0, totalThreats = 0, totalPageViews = 0;

  for (const zoneId of creds.zoneIds) {
    try {
      const result = await cloudflareGraphQL(headers, `
        query {
          viewer {
            zones(filter: {zoneTag: "${zoneId}"}) {
              httpRequests1dGroups(limit: 7, filter: {date_geq: "${startDate}", date_leq: "${endDate}"}) {
                sum { requests bytes cachedBytes threats pageViews }
              }
            }
          }
        }
      `);

      const data = result?.data?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
      data.forEach(day => {
        totalRequests += day.sum?.requests || 0;
        totalBytes += day.sum?.bytes || 0;
        totalCachedBytes += day.sum?.cachedBytes || 0;
        totalThreats += day.sum?.threats || 0;
        totalPageViews += day.sum?.pageViews || 0;
      });
    } catch (e) {
      console.error(`Cloudflare error for zone ${zoneId}:`, e);
    }
  }

  const cacheHitRatio = totalBytes > 0 ? ((totalCachedBytes / totalBytes) * 100).toFixed(1) + '%' : 'N/A';

  return {
    totalRequests, totalBandwidth: formatBytes(totalBytes), cacheHitRatio,
    cacheHitRatioNum: totalBytes > 0 ? (totalCachedBytes / totalBytes) * 100 : null,
    threatsBlocked: totalThreats, pageViews: totalPageViews
  };
}

async function fetchCloudflareDetail(creds, env) {
  const summary = await fetchCloudflareSummary(creds);
  if (summary.error) return summary;

  const headers = { 'Authorization': `Bearer ${creds.apiToken}`, 'Content-Type': 'application/json' };
  const { startDate, endDate } = getDateRange(7);
  const { startDate: prevStartDate, endDate: prevEndDate } = getDateRange(14, 7);

  let firewallEvents = [];
  let webVitals = null;
  let previousThreats = 0;
  let accountId = null;
  let zoneName = null;

  for (const zoneId of creds.zoneIds) {
    try {
      // Get account ID and zone name (only need once)
      if (!accountId) {
        const zoneResponse = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}`, {
          headers: { 'Authorization': `Bearer ${creds.apiToken}` }
        });
        const zoneData = await zoneResponse.json();
        accountId = zoneData?.result?.account?.id;
        zoneName = zoneData?.result?.name;
      }

      // Current period security events
      const secResult = await cloudflareGraphQL(headers, `
        query {
          viewer {
            zones(filter: {zoneTag: "${zoneId}"}) {
              firewallEventsAdaptiveGroups(limit: 10, filter: {date_geq: "${startDate}", date_leq: "${endDate}"}, orderBy: [count_DESC]) {
                count
                dimensions { action }
              }
            }
          }
        }
      `);
      
      const events = secResult?.data?.viewer?.zones?.[0]?.firewallEventsAdaptiveGroups || [];
      firewallEvents = firewallEvents.concat(events.map(e => ({ action: e.dimensions?.action, count: e.count })));

      // Previous period threats for comparison
      const prevSecResult = await cloudflareGraphQL(headers, `
        query {
          viewer {
            zones(filter: {zoneTag: "${zoneId}"}) {
              httpRequests1dGroups(limit: 7, filter: {date_geq: "${prevStartDate}", date_leq: "${prevEndDate}"}) {
                sum { threats }
              }
            }
          }
        }
      `);
      
      const prevData = prevSecResult?.data?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
      prevData.forEach(day => { previousThreats += day.sum?.threats || 0; });

    } catch (e) {
      console.error(`Cloudflare detail error:`, e);
    }
  }

  // Fetch Web Vitals from account-level RUM data
  if (accountId && zoneName) {
    try {
      const rumQuery = `
        query {
          viewer {
            accounts(filter: {accountTag: "${accountId}"}) {
              rumPerformanceEventsAdaptiveGroups(
                filter: {
                  AND: [
                    {date_geq: "${startDate}"},
                    {date_leq: "${endDate}"}
                  ]
                }
                limit: 20
                orderBy: [count_DESC]
              ) {
                count
                dimensions {
                  siteTag
                }
                avg {
                  firstContentfulPaint
                  firstPaint
                  loadEventTime
                  pageRenderTime
                }
              }
              rumPageloadEventsAdaptiveGroups(
                filter: {
                  AND: [
                    {date_geq: "${startDate}"},
                    {date_leq: "${endDate}"}
                  ]
                }
                limit: 30
                orderBy: [count_DESC]
              ) {
                count
                dimensions {
                  siteTag
                  requestHost
                }
              }
            }
          }
        }
      `;
      
      const rumResult = await cloudflareGraphQL(headers, rumQuery);
      const pageloads = rumResult?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
      const perfEvents = rumResult?.data?.viewer?.accounts?.[0]?.rumPerformanceEventsAdaptiveGroups || [];
      
      // Find siteTag(s) that match this zone's hostname
      const matchingHosts = pageloads.filter(p => {
        const host = (p.dimensions?.requestHost || '').toLowerCase();
        const zone = zoneName.toLowerCase();
        return host === zone || host === 'www.' + zone || host.endsWith('.' + zone);
      });
      
      if (matchingHosts.length > 0) {
        const siteTags = [...new Set(matchingHosts.map(h => h.dimensions?.siteTag))];
        
        // Find performance data for these siteTags
        const matchingPerf = perfEvents.filter(p => siteTags.includes(p.dimensions?.siteTag));
        
        if (matchingPerf.length > 0) {
          // Aggregate performance metrics (weighted by count)
          let totalCount = 0;
          let totalFCP = 0, totalFP = 0, totalLoad = 0, totalRender = 0;
          
          matchingPerf.forEach(p => {
            const count = p.count || 0;
            totalCount += count;
            totalFCP += (p.avg?.firstContentfulPaint || 0) * count;
            totalFP += (p.avg?.firstPaint || 0) * count;
            totalLoad += (p.avg?.loadEventTime || 0) * count;
            totalRender += (p.avg?.pageRenderTime || 0) * count;
          });
          
          if (totalCount > 0) {
            webVitals = {
              FCP: Math.round((totalFCP / totalCount) / 1000), // microseconds to ms
              FP: Math.round((totalFP / totalCount) / 1000),
              loadTime: Math.round(totalLoad / totalCount),
              renderTime: Math.round((totalRender / totalCount) / 1000),
              sampleSize: totalCount
            };
          }
        }
      }
    } catch (rumError) {
      console.error('RUM query error:', rumError);
    }
  }

  // Fetch Core Web Vitals from PageSpeed Insights (CrUX data) - LAZY LOADED
  // Don't fetch here - will be loaded on demand when user clicks tab
  const coreWebVitals = { lazy: true, note: 'Click to load Core Web Vitals' };

  // Site health - LAZY LOADED
  // Don't fetch here - will be loaded on demand when user clicks Site Health tab
  const siteHealth = { lazy: true };

  // Response codes and geo data - these are fast Cloudflare queries
  let responseCodes = {};
  let geoPerformance = [];
  
  for (const zoneId of creds.zoneIds) {
    try {
      // Response status codes and geo in one query
      const statsResult = await cloudflareGraphQL(headers, `
        query {
          viewer {
            zones(filter: {zoneTag: "${zoneId}"}) {
              statusCodes: httpRequestsAdaptiveGroups(
                filter: {date_geq: "${startDate}", date_leq: "${endDate}"}
                limit: 20
                orderBy: [count_DESC]
              ) {
                count
                dimensions { edgeResponseStatus }
              }
              geoData: httpRequestsAdaptiveGroups(
                filter: {date_geq: "${startDate}", date_leq: "${endDate}"}
                limit: 10
                orderBy: [count_DESC]
              ) {
                count
                dimensions { clientCountryName }
                avg { edgeTimeToFirstByteMs }
              }
            }
          }
        }
      `);
      
      const statusData = statsResult?.data?.viewer?.zones?.[0]?.statusCodes || [];
      statusData.forEach(s => {
        const code = s.dimensions?.edgeResponseStatus;
        if (code) responseCodes[code] = (responseCodes[code] || 0) + s.count;
      });

      const geoData = statsResult?.data?.viewer?.zones?.[0]?.geoData || [];
      geoData.forEach(g => {
        const country = g.dimensions?.clientCountryName;
        if (country) {
          const existing = geoPerformance.find(p => p.country === country);
          if (existing) existing.requests += g.count;
          else geoPerformance.push({ country, requests: g.count, ttfb: Math.round(g.avg?.edgeTimeToFirstByteMs || 0) });
        }
      });
    } catch (e) {
      console.error('Stats query error:', e);
    }
  }

  geoPerformance.sort((a, b) => b.requests - a.requests);

  const responseCodeSummary = { success: 0, redirect: 0, clientError: 0, serverError: 0, details: responseCodes };
  Object.entries(responseCodes).forEach(([code, count]) => {
    const c = parseInt(code);
    if (c >= 200 && c < 300) responseCodeSummary.success += count;
    else if (c >= 300 && c < 400) responseCodeSummary.redirect += count;
    else if (c >= 400 && c < 500) responseCodeSummary.clientError += count;
    else if (c >= 500) responseCodeSummary.serverError += count;
  });

  const eventMap = {};
  firewallEvents.forEach(e => { eventMap[e.action] = (eventMap[e.action] || 0) + e.count; });

  return {
    zoneName, // Pass domain for lazy loading
    performance: {
      totalRequests: summary.totalRequests, totalBandwidth: summary.totalBandwidth,
      cacheHitRatio: summary.cacheHitRatio, cacheHitRatioNum: summary.cacheHitRatioNum, pageViews: summary.pageViews
    },
    security: {
      threatsBlocked: summary.threatsBlocked,
      previousThreatsBlocked: previousThreats,
      firewallEvents: Object.entries(eventMap).map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count)
    },
    webVitals: webVitals || { note: 'No Web Analytics data for this site yet' },
    coreWebVitals: coreWebVitals,
    responseCodes: responseCodeSummary,
    geoPerformance: geoPerformance.slice(0, 10),
    siteHealth: siteHealth
  };
}

async function cloudflareGraphQL(headers, query) {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers, body: JSON.stringify({ query })
  });
  return response.json();
}

// Fetch Core Web Vitals from PageSpeed Insights API (CrUX data)
async function fetchPageSpeedInsights(domain, apiKey) {
  // Try multiple subdomains - shop often has more traffic/CrUX data
  const domainsToTry = [`www.${domain}`, `shop.${domain}`, domain];
  
  for (const testDomain of domainsToTry) {
    try {
      let url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://${testDomain}&strategy=mobile&category=performance`;
      if (apiKey) {
        url += `&key=${apiKey}`;
      }
      
      const response = await fetch(url);
      
      if (!response.ok) {
        console.error(`PageSpeed API error for ${testDomain}: ${response.status}`);
        continue; // Try next domain
      }
      
      const data = await response.json();
      
      // Check for API errors
      if (data.error) {
        console.error(`PageSpeed API returned error for ${testDomain}:`, data.error);
        continue;
      }
      
      // Extract CrUX metrics (real user data)
      const crux = data.loadingExperience?.metrics || {};
      const originCrux = data.originLoadingExperience?.metrics || {};
      
      // Prefer origin-level data (more samples), fall back to URL-level
      const metrics = Object.keys(originCrux).length > 0 ? originCrux : crux;
      
      if (Object.keys(metrics).length === 0) {
        console.log(`No CrUX data for ${testDomain}, trying next...`);
        continue; // Try next subdomain
      }
      
      // Extract p75 values (75th percentile - what Google uses for ranking)
      const result = {
        LCP: metrics.LARGEST_CONTENTFUL_PAINT_MS?.percentile || null,
        INP: metrics.INTERACTION_TO_NEXT_PAINT?.percentile || metrics.EXPERIMENTAL_INTERACTION_TO_NEXT_PAINT?.percentile || null,
        CLS: metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile ? metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null,
        FCP: metrics.FIRST_CONTENTFUL_PAINT_MS?.percentile || null,
        TTFB: metrics.EXPERIMENTAL_TIME_TO_FIRST_BYTE?.percentile || null,
        FID: metrics.FIRST_INPUT_DELAY_MS?.percentile || null,
        
        // Also get the category ratings
        lcpRating: metrics.LARGEST_CONTENTFUL_PAINT_MS?.category || null,
        inpRating: metrics.INTERACTION_TO_NEXT_PAINT?.category || metrics.EXPERIMENTAL_INTERACTION_TO_NEXT_PAINT?.category || null,
        clsRating: metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.category || null,
        fcpRating: metrics.FIRST_CONTENTFUL_PAINT_MS?.category || null,
        
        // Overall assessment
        overallCategory: data.loadingExperience?.overall_category || data.originLoadingExperience?.overall_category || null,
        
        source: Object.keys(originCrux).length > 0 ? 'origin' : 'url',
        testedDomain: testDomain
      };
      
      return result;
    } catch (error) {
      console.error(`PageSpeed fetch error for ${testDomain}:`, error);
      continue; // Try next domain
    }
  }
  
  return { note: 'No CrUX data available (needs more Chrome traffic)' };
}

// ============================================================================
// SITE HEALTH CHECKS
// ============================================================================

// Quick fallback audit when KV cache is empty (15 pages max, no link checking)
async function fetchSiteHealth(domain) {
  // Get sitemap URL
  let sitemapUrl = `https://www.${domain}/sitemap.xml`;
  try {
    const robotsResponse = await fetch(`https://www.${domain}/robots.txt`);
    if (robotsResponse.ok) {
      const robotsText = await robotsResponse.text();
      const sitemapMatch = robotsText.match(/sitemap:\s*(https?:\/\/[^\s]+)/i);
      if (sitemapMatch) {
        sitemapUrl = sitemapMatch[1];
      }
    }
  } catch (e) {
    // Use default
  }
  
  // Run quick audit (15 pages, no link checking)
  return await auditSitemapPages(sitemapUrl, 15);
}

async function auditSitemapPages(sitemapUrl, maxPages = 25) {
  const audit = {
    sitemapUrl,
    totalUrls: 0,
    audited: 0,
    pages: [],
    summary: {
      missingTitle: 0,
      shortTitle: 0,
      longTitle: 0,
      missingDescription: 0,
      shortDescription: 0,
      longDescription: 0,
      missingH1: 0,
      multipleH1: 0,
      missingSchema: 0,
      schemaErrors: 0
    },
    issues: []
  };
  
  try {
    // Fetch sitemap
    const response = await fetch(sitemapUrl);
    if (!response.ok) {
      audit.error = `Could not fetch sitemap: ${response.status}`;
      return audit;
    }
    
    const xml = await response.text();
    
    // Parse URLs from sitemap (handles both regular sitemaps and sitemap indexes)
    let urls = [];
    
    // Check if it's a sitemap index
    if (xml.includes('<sitemapindex')) {
      // Extract child sitemap URLs
      const sitemapMatches = xml.matchAll(/<loc>([^<]+)<\/loc>/gi);
      const childSitemaps = [...sitemapMatches].map(m => m[1]).slice(0, 3); // Limit to 3 child sitemaps
      
      for (const childUrl of childSitemaps) {
        try {
          const childResponse = await fetch(childUrl);
          if (childResponse.ok) {
            const childXml = await childResponse.text();
            const childUrls = [...childXml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1]);
            urls.push(...childUrls);
          }
        } catch (e) {
          console.error(`Error fetching child sitemap ${childUrl}:`, e);
        }
      }
    } else {
      // Regular sitemap
      const urlMatches = xml.matchAll(/<loc>([^<]+)<\/loc>/gi);
      urls = [...urlMatches].map(m => m[1]);
    }
    
    // Deduplicate URLs by normalized path
    const seenPaths = new Set();
    const uniqueUrls = [];
    for (const url of urls) {
      try {
        const parsed = new URL(url);
        const normalizedPath = parsed.pathname.replace(/\/$/, '') || '/';
        if (!seenPaths.has(normalizedPath)) {
          seenPaths.add(normalizedPath);
          uniqueUrls.push(url);
        }
      } catch (e) {
        uniqueUrls.push(url);
      }
    }
    
    audit.totalUrls = uniqueUrls.length;
    
    // Prioritize important pages: homepage, then shorter URLs (likely main pages)
    uniqueUrls.sort((a, b) => {
      const aPath = new URL(a).pathname;
      const bPath = new URL(b).pathname;
      if (aPath === '/' || aPath === '') return -1;
      if (bPath === '/' || bPath === '') return 1;
      return aPath.split('/').length - bPath.split('/').length;
    });
    
    // Audit pages (limit to maxPages to avoid timeout)
    const urlsToAudit = uniqueUrls.slice(0, maxPages);
    
    // Process in parallel batches of 5
    for (let i = 0; i < urlsToAudit.length; i += 5) {
      const batch = urlsToAudit.slice(i, i + 5);
      const results = await Promise.all(batch.map(url => auditSinglePage(url)));
      
      results.forEach(result => {
        if (result) {
          audit.pages.push(result);
          audit.audited++;
          
          // Update summary counts
          if (result.title.status === 'missing') audit.summary.missingTitle++;
          else if (result.title.status === 'too_short') audit.summary.shortTitle++;
          else if (result.title.status === 'too_long') audit.summary.longTitle++;
          
          if (result.description.status === 'missing') audit.summary.missingDescription++;
          else if (result.description.status === 'too_short') audit.summary.shortDescription++;
          else if (result.description.status === 'too_long') audit.summary.longDescription++;
          
          if (result.h1.count === 0) audit.summary.missingH1++;
          else if (result.h1.count > 1) audit.summary.multipleH1++;
          
          if (!result.schema.found) audit.summary.missingSchema++;
          else if (result.schema.errors > 0) audit.summary.schemaErrors++;
        }
      });
    }
    
    // Generate prioritized issues list
    audit.issues = generateSEOIssues(audit);
    
  } catch (e) {
    audit.error = e.message;
  }
  
  return audit;
}

async function auditSinglePage(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'WineHealthDashboard/1.0' }
    });
    
    if (!response.ok) {
      return {
        url,
        status: response.status,
        error: true,
        title: { status: 'error' },
        description: { status: 'error' },
        h1: { count: 0 },
        schema: { found: false }
      };
    }
    
    const html = await response.text();
    const path = new URL(url).pathname;
    
    // Parse title
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const titleLen = title.length;
    let titleStatus = 'good';
    if (!title) titleStatus = 'missing';
    else if (titleLen < 30) titleStatus = 'too_short';
    else if (titleLen > 60) titleStatus = 'too_long';
    
    // Parse meta description
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
                      html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
    const description = descMatch ? descMatch[1].trim() : '';
    const descLen = description.length;
    let descStatus = 'good';
    if (!description) descStatus = 'missing';
    else if (descLen < 70) descStatus = 'too_short';
    else if (descLen > 160) descStatus = 'too_long';
    
    // Parse H1
    const h1Matches = html.match(/<h1[^>]*>/gi) || [];
    const h1Count = h1Matches.length;
    
    // Parse Schema.org JSON-LD
    const jsonLdMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    let schemaFound = jsonLdMatches.length > 0;
    let schemaTypes = [];
    let schemaErrors = 0;
    
    jsonLdMatches.forEach(match => {
      try {
        const jsonContent = match.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
        const parsed = JSON.parse(jsonContent);
        const items = parsed['@graph'] || [parsed];
        items.forEach(item => {
          if (item['@type']) {
            const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
            schemaTypes.push(...types);
          }
        });
      } catch (e) {
        schemaErrors++;
      }
    });
    
    return {
      url,
      path,
      status: response.status,
      title: { value: title.substring(0, 70), length: titleLen, status: titleStatus },
      description: { value: description.substring(0, 100), length: descLen, status: descStatus },
      h1: { count: h1Count },
      schema: { found: schemaFound, types: [...new Set(schemaTypes)], errors: schemaErrors }
    };
    
  } catch (e) {
    return {
      url,
      error: true,
      errorMessage: e.message,
      title: { status: 'error' },
      description: { status: 'error' },
      h1: { count: 0 },
      schema: { found: false }
    };
  }
}

function generateSEOIssues(audit) {
  const issues = [];
  
  // Group pages by issue type
  const missingTitles = audit.pages.filter(p => p.title.status === 'missing');
  const shortTitles = audit.pages.filter(p => p.title.status === 'too_short');
  const missingDescs = audit.pages.filter(p => p.description.status === 'missing');
  const shortDescs = audit.pages.filter(p => p.description.status === 'too_short');
  const missingH1s = audit.pages.filter(p => p.h1.count === 0);
  const multipleH1s = audit.pages.filter(p => p.h1.count > 1);
  const missingSchema = audit.pages.filter(p => !p.schema.found);
  const schemaErrors = audit.pages.filter(p => p.schema.errors > 0);
  
  if (missingTitles.length > 0) {
    issues.push({
      type: 'missing_title',
      severity: 'high',
      count: missingTitles.length,
      message: `${missingTitles.length} page(s) missing title tag`,
      pages: missingTitles.map(p => p.path)
    });
  }
  
  if (missingDescs.length > 0) {
    issues.push({
      type: 'missing_description',
      severity: 'high',
      count: missingDescs.length,
      message: `${missingDescs.length} page(s) missing meta description`,
      pages: missingDescs.map(p => p.path)
    });
  }
  
  if (shortTitles.length > 0) {
    issues.push({
      type: 'short_title',
      severity: 'medium',
      count: shortTitles.length,
      message: `${shortTitles.length} page(s) with short titles (<30 chars)`,
      pages: shortTitles.map(p => p.path)
    });
  }
  
  if (shortDescs.length > 0) {
    issues.push({
      type: 'short_description',
      severity: 'medium',
      count: shortDescs.length,
      message: `${shortDescs.length} page(s) with short descriptions (<70 chars)`,
      pages: shortDescs.map(p => p.path)
    });
  }
  
  if (missingH1s.length > 0) {
    issues.push({
      type: 'missing_h1',
      severity: 'medium',
      count: missingH1s.length,
      message: `${missingH1s.length} page(s) missing H1 tag`,
      pages: missingH1s.map(p => p.path)
    });
  }
  
  if (multipleH1s.length > 0) {
    issues.push({
      type: 'multiple_h1',
      severity: 'low',
      count: multipleH1s.length,
      message: `${multipleH1s.length} page(s) with multiple H1 tags`,
      pages: multipleH1s.map(p => p.path)
    });
  }
  
  if (missingSchema.length > 0) {
    issues.push({
      type: 'missing_schema',
      severity: 'low',
      count: missingSchema.length,
      message: `${missingSchema.length} page(s) without structured data`,
      pages: missingSchema.map(p => p.path)
    });
  }
  
  if (schemaErrors.length > 0) {
    issues.push({
      type: 'schema_error',
      severity: 'high',
      count: schemaErrors.length,
      message: `${schemaErrors.length} page(s) with invalid JSON-LD`,
      pages: schemaErrors.map(p => p.path)
    });
  }
  
  // Broken links
  if (audit.brokenLinks && audit.brokenLinks.length > 0) {
    issues.push({
      type: 'broken_links',
      severity: 'high',
      count: audit.brokenLinks.length,
      message: `${audit.brokenLinks.length} broken internal link(s) found`,
      pages: audit.brokenLinks.map(b => `${new URL(b.url).pathname} (${b.status})`)
    });
  }
  
  return issues.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.severity] - order[b.severity];
  });
}

// ============================================================================
// GOOGLE SEARCH CONSOLE API
// ============================================================================

async function fetchSearchConsoleSummary(creds) {
  if (!creds.credentials || creds.properties.length === 0) {
    return { error: 'Search Console not configured' };
  }

  try {
    const accessToken = await getGoogleAccessToken(creds.credentials);
    const { startDate, endDate } = getDateRange(7);

    let totalClicks = 0, totalImpressions = 0, weightedPosition = 0, positionWeight = 0;

    for (const siteUrl of creds.properties) {
      try {
        const response = await fetch(
          `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ startDate, endDate, dimensions: [], rowLimit: 1 })
          }
        );

        if (!response.ok) continue;
        const data = await response.json();
        const row = data.rows?.[0];
        
        if (row) {
          totalClicks += row.clicks || 0;
          totalImpressions += row.impressions || 0;
          weightedPosition += (row.position || 0) * (row.impressions || 0);
          positionWeight += row.impressions || 0;
        }
      } catch (e) {
        console.error(`GSC error for ${siteUrl}:`, e);
      }
    }

    const avgPosition = positionWeight > 0 ? weightedPosition / positionWeight : null;
    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : null;

    return {
      clicks: totalClicks, impressions: totalImpressions,
      ctr: ctr ? ctr.toFixed(2) + '%' : 'N/A', ctrNum: ctr,
      position: avgPosition ? avgPosition.toFixed(1) : 'N/A', positionNum: avgPosition
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function fetchSearchConsoleDetail(creds) {
  const summary = await fetchSearchConsoleSummary(creds);
  if (summary.error) return summary;

  try {
    const accessToken = await getGoogleAccessToken(creds.credentials);
    const { startDate, endDate } = getDateRange(7);
    const { startDate: prevStartDate, endDate: prevEndDate } = getDateRange(7, 7);

    let topQueries = [], topPages = [], indexingStatus = [], indexingIssues = [];
    let prevQueryData = {};

    for (const siteUrl of creds.properties) {
      try {
        // Previous period queries (for position comparison)
        const prevQueriesResponse = await fetch(
          `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ startDate: prevStartDate, endDate: prevEndDate, dimensions: ['query'], rowLimit: 100 })
          }
        );

        if (prevQueriesResponse.ok) {
          const prevData = await prevQueriesResponse.json();
          (prevData.rows || []).forEach(row => {
            const query = row.keys[0].toLowerCase().trim();
            prevQueryData[query] = { position: row.position, clicks: row.clicks, impressions: row.impressions };
          });
        }

        // Current period queries
        const queriesResponse = await fetch(
          `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: 50 })
          }
        );

        if (queriesResponse.ok) {
          const queriesData = await queriesResponse.json();
          topQueries = topQueries.concat((queriesData.rows || []).map(row => {
            const query = row.keys[0];
            const queryKey = query.toLowerCase().trim();
            const prev = prevQueryData[queryKey];
            const positionChange = prev ? (prev.position - row.position) : null;
            return {
              query: query, 
              clicks: row.clicks, 
              impressions: row.impressions,
              ctr: ((row.clicks / row.impressions) * 100).toFixed(2) + '%', 
              position: row.position.toFixed(1),
              positionNum: row.position,
              positionChange: positionChange,
              prevPosition: prev ? prev.position.toFixed(1) : null
            };
          }));
        }

        // Current period pages
        const pagesResponse = await fetch(
          `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ startDate, endDate, dimensions: ['page'], rowLimit: 25 })
          }
        );

        if (pagesResponse.ok) {
          const pagesData = await pagesResponse.json();
          topPages = topPages.concat((pagesData.rows || []).map(row => ({
            page: row.keys[0], clicks: row.clicks, impressions: row.impressions,
            ctr: ((row.clicks / row.impressions) * 100).toFixed(2) + '%', position: row.position.toFixed(1)
          })));
        }

        // Sitemaps - get the full details
        const sitemapsResponse = await fetch(
          `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
          { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );

        if (sitemapsResponse.ok) {
          const sitemapsData = await sitemapsResponse.json();
          for (const sm of (sitemapsData.sitemap || [])) {
            let submitted = 0, indexed = 0;
            (sm.contents || []).forEach(c => {
              submitted += parseInt(c.submitted) || 0;
              indexed += parseInt(c.indexed) || 0;
            });
            
            indexingStatus.push({ 
              sitemap: sm.path, 
              warnings: parseInt(sm.warnings) || 0, 
              errors: parseInt(sm.errors) || 0,
              submitted: submitted,
              indexed: indexed,
              isPending: sm.isPending || false,
              lastDownloaded: sm.lastDownloaded,
              lastSubmitted: sm.lastSubmitted,
              siteUrl: siteUrl
            });

            // If there are errors, fetch sitemap and inspect URLs
            if (sm.errors > 0 || (submitted > 0 && indexed < submitted * 0.9)) {
              const issues = await inspectSitemapUrls(sm.path, siteUrl, accessToken, 10);
              indexingIssues = indexingIssues.concat(issues);
            }
          }
        }

      } catch (e) {
        console.error(`GSC detail error for ${siteUrl}:`, e);
      }
    }

    topQueries = topQueries.sort((a, b) => b.clicks - a.clicks);
    topPages = topPages.sort((a, b) => b.clicks - a.clicks).slice(0, 10);

    const movers = [...topQueries]
      .filter(q => q.positionChange !== null && Math.abs(q.positionChange) >= 0.5 && q.impressions >= 10)
      .sort((a, b) => Math.abs(b.positionChange) - Math.abs(a.positionChange))
      .slice(0, 10);

    return { ...summary, topQueries, topPages, indexingStatus, indexingIssues, movers, siteUrls: creds.properties };
  } catch (error) {
    return { ...summary, detailError: error.message };
  }
}

// Fetch sitemap XML and inspect URLs for issues
async function inspectSitemapUrls(sitemapUrl, siteUrl, accessToken, maxUrls = 10) {
  const issues = [];
  
  try {
    // Fetch the sitemap XML
    const sitemapResponse = await fetch(sitemapUrl);
    if (!sitemapResponse.ok) return issues;
    
    const sitemapXml = await sitemapResponse.text();
    
    // Parse URLs from sitemap (simple regex for <loc> tags)
    const urlMatches = sitemapXml.match(/<loc>([^<]+)<\/loc>/g) || [];
    const urls = urlMatches.map(m => m.replace(/<\/?loc>/g, '')).slice(0, maxUrls);
    
    // Inspect each URL
    for (const url of urls) {
      try {
        const inspectResponse = await fetch(
          'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ inspectionUrl: url, siteUrl: siteUrl })
          }
        );

        if (inspectResponse.ok) {
          const data = await inspectResponse.json();
          const result = data.inspectionResult;
          const indexStatus = result?.indexStatusResult;
          
          // Only add if there's an issue (not indexed or has problems)
          if (indexStatus && indexStatus.coverageState !== 'Submitted and indexed') {
            issues.push({
              url: url,
              status: indexStatus.coverageState || 'Unknown',
              verdict: indexStatus.verdict || 'Unknown',
              robotsTxtState: indexStatus.robotsTxtState,
              indexingState: indexStatus.indexingState,
              lastCrawlTime: indexStatus.lastCrawlTime,
              pageFetchState: indexStatus.pageFetchState,
              crawledAs: indexStatus.crawledAs,
              googleCanonical: indexStatus.googleCanonical,
              userCanonical: indexStatus.userCanonical,
              referringUrls: indexStatus.referringUrls,
              sitemap: sitemapUrl.split('/').pop()
            });
          }
        }
      } catch (e) {
        console.error(`URL inspection error for ${url}:`, e);
      }
    }
  } catch (e) {
    console.error(`Sitemap fetch error for ${sitemapUrl}:`, e);
  }
  
  return issues;
}

// ============================================================================
// GOOGLE AUTH
// ============================================================================

async function getGoogleAccessToken(credentialsJson) {
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

function generateDetailedIssues(data) {
  const issues = [];
  
  // ===================
  // POSITION OPPORTUNITIES (queries ranking 8-20)
  // ===================
  const positionOpportunities = (data.searchConsole?.topQueries || [])
    .filter(q => q.positionNum >= 8 && q.positionNum <= 20 && q.impressions >= 50)
    .sort((a, b) => a.positionNum - b.positionNum)
    .slice(0, 3);
  
  positionOpportunities.forEach(q => {
    issues.push({
      priority: q.positionNum <= 12 ? 'HIGH' : 'MEDIUM',
      category: 'seo',
      issue: `"${q.query}" ranking #${Math.round(q.positionNum)} with ${q.impressions.toLocaleString()} impressions`,
      action: q.positionNum <= 12 
        ? 'Close to page 1 - optimize content to push into top 7'
        : 'Page 2 opportunity - add content depth, internal links, or backlinks'
    });
  });

  // ===================
  // TRENDING KEYWORDS (big movers)
  // ===================
  const movers = data.searchConsole?.movers || [];
  
  // Rising stars - keywords improving significantly
  const risers = movers.filter(q => parseFloat(q.positionChange) >= 3).slice(0, 2);
  risers.forEach(q => {
    issues.push({
      priority: 'LOW',
      category: 'seo',
      issue: `UP: "${q.query}" improved +${parseFloat(q.positionChange).toFixed(1)} positions (now #${q.position})`,
      action: 'Keep momentum - add more internal links, update content freshness'
    });
  });

  // Declining - keywords losing position
  const fallers = movers.filter(q => parseFloat(q.positionChange) <= -3 && q.impressions >= 30).slice(0, 2);
  fallers.forEach(q => {
    issues.push({
      priority: 'MEDIUM',
      category: 'seo',
      issue: `DOWN: "${q.query}" dropped ${Math.abs(parseFloat(q.positionChange)).toFixed(1)} positions (now #${q.position})`,
      action: 'Investigate: check if content is outdated, competitors improved, or technical issues'
    });
  });

  // ===================
  // INDEXING ISSUES
  // ===================
  const siteUrls = data.searchConsole?.siteUrls || [];
  const indexingIssues = data.searchConsole?.indexingIssues || [];
  
  // Group issues by type
  const issuesByType = {};
  indexingIssues.forEach(issue => {
    const type = issue.status || 'Unknown';
    if (!issuesByType[type]) issuesByType[type] = [];
    issuesByType[type].push(issue);
  });
  
  // Create action items for each issue type
  Object.entries(issuesByType).forEach(([status, urls]) => {
    const isError = status.includes('error') || status.includes('404') || status.includes('5xx') || status.includes('401') || status.includes('403');
    const urlList = urls.slice(0, 3).map(u => u.url.replace(/https?:\/\/[^\/]+/, '')).join(', ');
    const moreCount = urls.length > 3 ? ` (+${urls.length - 3} more)` : '';
    
    issues.push({
      priority: isError ? 'HIGH' : 'MEDIUM',
      category: 'seo',
      issue: `${urls.length} page(s): ${formatIssueStatus(status)}`,
      action: `Affected: ${urlList}${moreCount}`,
      issueType: 'indexing',
      details: urls
    });
  });
  
  data.searchConsole?.indexingStatus?.forEach(sm => {
    if (sm.warnings > 5) {
      issues.push({
        priority: 'MEDIUM',
        category: 'seo',
        issue: `Sitemap "${sm.sitemap.split('/').pop()}" has ${sm.warnings} warnings`,
        action: 'Review sitemap for potential issues'
      });
    }
    // Low index coverage (only if we don't have specific issues already)
    if (sm.submitted > 0 && sm.indexed < sm.submitted * 0.7 && indexingIssues.length === 0) {
      const coverage = ((sm.indexed / sm.submitted) * 100).toFixed(0);
      issues.push({
        priority: 'HIGH',
        category: 'seo',
        issue: `Only ${coverage}% of submitted URLs are indexed (${sm.indexed}/${sm.submitted})`,
        action: 'Check Search Console tab for detailed indexing issues'
      });
    }
  });

  // Pages with good position but 0 or very few clicks (possible indexing/display issue)
  const lowClickPages = (data.searchConsole?.topPages || [])
    .filter(p => p.impressions >= 100 && p.clicks === 0);
  
  if (lowClickPages.length > 0) {
    issues.push({
      priority: 'MEDIUM',
      category: 'seo',
      issue: `${lowClickPages.length} page(s) getting impressions but zero clicks`,
      action: 'Check if titles/descriptions are compelling - may have display issues'
    });
  }

  // ===================
  // SLOW PAGES (Core Web Vitals from CrUX)
  // ===================
  const cwv = data.cloudflare?.coreWebVitals;
  if (cwv && !cwv.note) {
    // LCP
    if (cwv.LCP && cwv.LCP > 2500) {
      issues.push({ 
        priority: cwv.LCP > 4000 ? 'HIGH' : 'MEDIUM', 
        category: 'performance', 
        issue: `LCP is ${(cwv.LCP / 1000).toFixed(2)}s (target: <2.5s)`,
        action: cwv.LCP > 4000 
          ? 'Critical: Optimize hero images, reduce server response time, preload key resources'
          : 'Compress images, enable lazy loading, consider CDN for large assets'
      });
    }

    // INP (Interaction to Next Paint)
    if (cwv.INP && cwv.INP > 200) {
      issues.push({
        priority: cwv.INP > 500 ? 'HIGH' : 'MEDIUM',
        category: 'performance',
        issue: `INP is ${cwv.INP}ms (target: <200ms)`,
        action: 'Reduce JavaScript execution time, break up long tasks, optimize event handlers'
      });
    }

    // CLS
    if (cwv.CLS && cwv.CLS > 0.1) {
      issues.push({ 
        priority: cwv.CLS > 0.25 ? 'HIGH' : 'MEDIUM', 
        category: 'performance', 
        issue: `CLS is ${cwv.CLS.toFixed(2)} (target: <0.1)`,
        action: 'Add explicit width/height to images and embeds, avoid inserting content above existing content'
      });
    }

    // FCP
    if (cwv.FCP && cwv.FCP > 1800) {
      issues.push({
        priority: cwv.FCP > 3000 ? 'HIGH' : 'MEDIUM',
        category: 'performance',
        issue: `FCP is ${(cwv.FCP / 1000).toFixed(2)}s (target: <1.8s)`,
        action: 'Eliminate render-blocking resources, inline critical CSS, defer non-critical JS'
      });
    }

    // TTFB
    if (cwv.TTFB && cwv.TTFB > 800) {
      issues.push({
        priority: cwv.TTFB > 1800 ? 'HIGH' : 'MEDIUM',
        category: 'performance',
        issue: `TTFB is ${cwv.TTFB}ms (target: <800ms)`,
        action: 'Improve server response time, use CDN, optimize database queries, enable caching'
      });
    }
    
    // Overall poor rating
    if (cwv.overallCategory === 'SLOW') {
      issues.push({
        priority: 'HIGH',
        category: 'performance',
        issue: 'Google rates this site as SLOW',
        action: 'Poor Core Web Vitals may affect search rankings. Address LCP, INP, and CLS issues above.'
      });
    }
  }

  // ===================
  // SECURITY SPIKES
  // ===================
  const threats = data.cloudflare?.security?.threatsBlocked || 0;
  const prevThreats = data.cloudflare?.security?.previousThreatsBlocked || 0;
  
  if (threats > 100) {
    const threatIncrease = prevThreats > 0 ? ((threats - prevThreats) / prevThreats) * 100 : 0;
    
    if (threatIncrease > 50) {
      issues.push({
        priority: 'HIGH',
        category: 'security',
        issue: `Threats up ${Math.round(threatIncrease)}% (${threats.toLocaleString()} blocked this week vs ${prevThreats.toLocaleString()} last week)`,
        action: 'Review Cloudflare Security Events for attack patterns - consider tightening WAF rules'
      });
    } else if (threats > 500) {
      issues.push({
        priority: 'MEDIUM',
        category: 'security',
        issue: `${threats.toLocaleString()} threats blocked this week`,
        action: 'Monitor firewall events - high volume may indicate targeted attacks'
      });
    }
  }

  // Check for unusual firewall patterns
  const firewallEvents = data.cloudflare?.security?.firewallEvents || [];
  const challengeEvents = firewallEvents.filter(e => e.action === 'managed_challenge' || e.action === 'jschallenge');
  const totalChallenges = challengeEvents.reduce((sum, e) => sum + e.count, 0);
  
  if (totalChallenges > 1000) {
    issues.push({
      priority: 'MEDIUM',
      category: 'security',
      issue: `${totalChallenges.toLocaleString()} bot challenges issued`,
      action: 'High bot activity - review if legitimate crawlers or malicious bots'
    });
  }

  // ===================
  // CACHE PERFORMANCE
  // ===================
  const cacheRatio = data.cloudflare?.performance?.cacheHitRatioNum;
  if (cacheRatio !== null && cacheRatio < 70) {
    const bandwidth = data.cloudflare?.performance?.totalBandwidth || 'significant';
    issues.push({
      priority: cacheRatio < 50 ? 'HIGH' : 'MEDIUM',
      category: 'performance',
      issue: `Cache hit ratio is only ${cacheRatio.toFixed(0)}%`,
      action: `Review Cloudflare cache rules - caching more content could reduce ${bandwidth} of origin load`
    });
  }

  // ===================
  // SITE HEALTH (Robots.txt check from lazy-loaded data is handled in Site Health tab)
  // Note: SEO audits are done via lazy-loaded site health endpoint, not in action items

  // ===================
  // RESPONSE CODE ISSUES
  // ===================
  const responseCodes = data.cloudflare?.responseCodes;
  if (responseCodes) {
    // Server errors
    if (responseCodes.serverError > 100) {
      issues.push({
        priority: 'HIGH',
        category: 'performance',
        issue: `${responseCodes.serverError.toLocaleString()} server errors (5xx) in the past 7 days`,
        action: 'Check server logs - indicates backend issues that need immediate attention'
      });
    } else if (responseCodes.serverError > 10) {
      issues.push({
        priority: 'MEDIUM',
        category: 'performance',
        issue: `${responseCodes.serverError} server errors (5xx) detected`,
        action: 'Monitor for patterns - may indicate intermittent backend issues'
      });
    }
    
    // High 404 rate
    const total = responseCodes.success + responseCodes.redirect + responseCodes.clientError + responseCodes.serverError;
    const error404Rate = (responseCodes.clientError / total) * 100;
    if (error404Rate > 5) {
      issues.push({
        priority: 'MEDIUM',
        category: 'seo',
        issue: `${error404Rate.toFixed(1)}% of requests returning 4xx errors`,
        action: 'Check for broken links or missing pages - consider redirects for removed content'
      });
    }
  }

  return issues.sort((a, b) => ({ CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[a.priority] || 3) - ({ CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[b.priority] || 3));
}

// ============================================================================
// UTILITIES
// ============================================================================

function getDateRange(days, offsetDays = 0) {
  const end = new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { startDate: start.toISOString().split('T')[0], endDate: end.toISOString().split('T')[0] };
}

function formatIssueStatus(status) {
  const map = {
    'Submitted and indexed': 'Indexed',
    'Crawled - currently not indexed': 'Crawled but not indexed',
    'Discovered - currently not indexed': 'Discovered but not indexed',
    'URL is unknown to Google': 'Unknown to Google',
    'Excluded by noindex tag': 'Blocked by noindex',
    'Blocked by robots.txt': 'Blocked by robots.txt',
    'Blocked due to unauthorized request (401)': '401 Unauthorized',
    'Not found (404)': '404 Not Found',
    'Blocked due to access forbidden (403)': '403 Forbidden',
    'Blocked due to other 4xx issue': '4xx Error',
    'Server error (5xx)': '5xx Server Error',
    'Redirect error': 'Redirect Error',
    'Soft 404': 'Soft 404',
    'Duplicate without user-selected canonical': 'Duplicate (no canonical)',
    'Duplicate, Google chose different canonical than user': 'Canonical mismatch',
    'Page with redirect': 'Redirected',
    'Alternate page with proper canonical tag': 'Alternate page'
  };
  return map[status] || status;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ============================================================================
// DASHBOARD HTML
// ============================================================================

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Web Health Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0f0f1a;--bg2:#1a1a2e;--card:#242438;--text:#fff;--text2:#a0a0b0;--text3:#6a6a7a;--blue:#6366f1;--green:#10b981;--yellow:#f59e0b;--red:#ef4444;--purple:#8b5cf6;--wine:#722F37;--border:#2d2d44}
    body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
    .app{display:flex;min-height:100vh}
    .sidebar{width:260px;background:var(--bg2);border-right:1px solid var(--border);position:fixed;top:0;left:0;bottom:0;display:flex;flex-direction:column}
    .sidebar-header{padding:20px;border-bottom:1px solid var(--border)}
    .logo{display:flex;align-items:center;gap:12px}
    .logo-icon{width:40px;height:40px;background:linear-gradient(135deg,var(--wine),#4A0E0E);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px}
    .logo h1{font-size:17px;font-weight:600}
    .logo span{color:var(--text2);font-size:12px}
    .sidebar-nav{flex:1;overflow-y:auto;padding:12px}
    .nav-section{margin-bottom:20px}
    .nav-section-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text3);padding:8px 12px}
    .nav-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;color:var(--text2);transition:all 0.15s;margin-bottom:2px;border:none;background:none;width:100%;text-align:left;font-size:14px}
    .nav-item:hover{background:var(--card);color:var(--text)}
    .nav-item.active{background:var(--blue);color:#fff}
    .nav-item .color-bar{width:3px;height:20px;border-radius:2px}
    .nav-item .label{flex:1}
    .nav-item .status{width:8px;height:8px;border-radius:50%}
    .status.healthy{background:var(--green)}
    .status.warning{background:var(--yellow)}
    .status.critical{background:var(--red)}
    .main{flex:1;margin-left:260px;padding:28px}
    .page-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px}
    .page-title h2{font-size:26px;font-weight:700;margin-bottom:4px}
    .page-title p{color:var(--text2);font-size:14px}
    .header-actions{display:flex;gap:12px;align-items:center}
    .last-updated{color:var(--text3);font-size:13px}
    .btn{padding:10px 16px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:8px;transition:all 0.15s;border:none}
    .btn-primary{background:var(--blue);color:#fff}
    .btn-primary:hover{background:#5558e3}
    .btn:disabled{opacity:0.5;cursor:not-allowed}
    @keyframes spin{to{transform:rotate(360deg)}}
    .btn.loading .icon{animation:spin 1s linear infinite}
    .view{display:none}
    .view.active{display:block}
    .summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:28px}
    .summary-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px}
    .summary-card .icon{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:10px}
    .summary-card .icon.blue{background:rgba(99,102,241,0.2)}
    .summary-card .icon.green{background:rgba(16,185,129,0.2)}
    .summary-card .icon.yellow{background:rgba(245,158,11,0.2)}
    .summary-card .icon.red{background:rgba(239,68,68,0.2)}
    .summary-card .value{font-size:28px;font-weight:700}
    .summary-card .label{font-size:13px;color:var(--text2)}
    .properties-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-bottom:28px}
    .property-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px;cursor:pointer;transition:all 0.15s;position:relative;overflow:hidden}
    .property-card:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,0.25)}
    .property-card .color-top{position:absolute;top:0;left:0;right:0;height:4px}
    .property-card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
    .property-card h3{font-size:16px;font-weight:600;margin-bottom:2px}
    .property-card .domains{font-size:12px;color:var(--text3)}
    .health-badge{font-size:11px;font-weight:600;padding:4px 10px;border-radius:10px}
    .health-badge.healthy{background:rgba(16,185,129,0.2);color:var(--green)}
    .health-badge.warning{background:rgba(245,158,11,0.2);color:var(--yellow)}
    .health-badge.critical{background:rgba(239,68,68,0.2);color:var(--red)}
    .health-badge.info{background:rgba(99,102,241,0.2);color:var(--blue)}
    .property-metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
    .mini-metric .value{font-size:18px;font-weight:600}
    .mini-metric .label{font-size:11px;color:var(--text2);text-transform:uppercase}
    .metrics-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:24px}
    .metric-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px}
    .metric-card.clickable{cursor:pointer;transition:all 0.2s}
    .metric-card.clickable:hover{border-color:var(--green);background:var(--bg2)}
    .metric-card .label{font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px}
    .metric-card .value{font-size:24px;font-weight:700}
    .metric-card .value.good{color:var(--green)}
    .metric-card .value.warning{color:var(--yellow)}
    .metric-card .value.bad{color:var(--red)}
    .metric-card .subtext{font-size:11px;color:var(--text3);margin-top:2px}
    .section{margin-bottom:28px}
    .section-header{margin-bottom:14px}
    .section-header h3{font-size:16px;font-weight:600}
    .status-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
    .status-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px}
    .status-card h4{font-size:14px;font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:8px}
    .status-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px}
    .status-row:last-child{border-bottom:none}
    .status-row .label{color:var(--text2)}
    .status-row .value{font-weight:500}
    .data-table{background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden}
    .data-table table{width:100%;border-collapse:collapse}
    .data-table th,.data-table td{padding:12px 14px;text-align:left;border-bottom:1px solid var(--border)}
    .data-table th{background:var(--bg2);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text2)}
    .data-table tr:last-child td{border-bottom:none}
    .data-table td{font-size:13px}
    .action-items{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px}
    .action-item{background:var(--bg2);border-radius:8px;padding:14px;margin-bottom:10px;border-left:4px solid var(--border);display:flex;gap:12px}
    .action-item:last-child{margin-bottom:0}
    .action-item.high{border-left-color:var(--yellow)}
    .action-item.medium{border-left-color:var(--blue)}
    .action-item.critical{border-left-color:var(--red)}
    .action-item .priority{font-size:10px;font-weight:700;padding:3px 7px;border-radius:4px;flex-shrink:0;height:fit-content}
    .action-item.high .priority{background:rgba(245,158,11,0.2);color:var(--yellow)}
    .action-item.medium .priority{background:rgba(99,102,241,0.2);color:var(--blue)}
    .action-item.critical .priority{background:rgba(239,68,68,0.2);color:var(--red)}
    .action-item.low{border-left-color:var(--green)}
    .action-item.low .priority{background:rgba(16,185,129,0.2);color:var(--green)}
    .action-item-content{flex:1}
    .action-item .property-tag{font-size:11px;color:var(--text3);margin-bottom:3px}
    .action-item .issue{font-weight:500;font-size:14px}
    .action-item .action{font-size:12px;color:var(--text2);margin-top:3px}
    .all-clear{background:rgba(16,185,129,0.1);border:1px solid var(--green);border-radius:10px;padding:24px;text-align:center}
    .all-clear .icon{font-size:32px;margin-bottom:10px}
    .all-clear h3{color:var(--green);font-size:16px}
    .all-clear p{color:var(--text2);font-size:13px}
    .rec-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:12px}
    .rec-card h4{margin:0 0 8px 0;font-size:14px;color:var(--text1)}
    .rec-card p{margin:0 0 12px 0;font-size:13px;color:var(--text2)}
    .rec-card code{display:block;background:var(--bg);padding:10px;border-radius:4px;font-size:12px;color:var(--text2);white-space:pre-wrap;font-family:monospace}
    .modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:1000;opacity:0;visibility:hidden;transition:all 0.2s}
    .modal-overlay.active{opacity:1;visibility:visible}
    .modal{background:var(--card);border-radius:12px;width:90%;max-width:600px;max-height:80vh;overflow:hidden;display:flex;flex-direction:column}
    .modal-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
    .modal-header h3{margin:0;font-size:16px}
    .modal-close{background:none;border:none;color:var(--text2);font-size:24px;cursor:pointer;padding:0;line-height:1}
    .modal-body{padding:20px;overflow-y:auto;flex:1;max-height:60vh}
    .modal-body ul{margin:0;padding:0;list-style:none}
    .modal-body li{padding:10px 12px;border-bottom:1px solid var(--border);font-size:13px}
    .modal-body li:last-child{border-bottom:none}
    .modal-body li a{color:var(--blue);text-decoration:none;word-break:break-all}
    .modal-body li a:hover{text-decoration:underline}
    .modal-body li:last-child{border-bottom:none}
    .modal-body li a{color:var(--blue);text-decoration:none;word-break:break-all}
    .modal-body li a:hover{text-decoration:underline}
    .progress-bar{height:4px;background:var(--border);border-radius:2px;overflow:hidden;margin-bottom:16px}
    .progress-bar-fill{height:100%;background:linear-gradient(90deg,var(--blue),var(--green));width:0%;animation:progress 2s ease-in-out infinite}
    @keyframes progress{0%{width:0%}50%{width:70%}100%{width:100%}}
    .info-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:var(--border);color:var(--text3);font-size:10px;cursor:help;margin-left:4px}
    .clickable-issue{cursor:pointer;transition:transform 0.1s}
    .clickable-issue:hover{transform:translateX(2px)}
    .styled-table-wrap{overflow-x:auto;border-radius:10px;border:1px solid var(--border);background:var(--bg2)}
    .styled-table{width:100%;border-collapse:collapse;font-size:13px}
    .styled-table thead{background:var(--card);position:sticky;top:0}
    .styled-table th{padding:12px 16px;text-align:left;font-weight:600;color:var(--text2);font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid var(--border)}
    .styled-table th.num{text-align:right}
    .styled-table td{padding:12px 16px;border-bottom:1px solid var(--border);color:var(--text)}
    .styled-table td.num{text-align:right;font-variant-numeric:tabular-nums}
    .styled-table td.keyword{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .styled-table tbody tr:hover{background:var(--card)}
    .styled-table tbody tr:last-child td{border-bottom:none}
    .styled-table a{color:var(--blue);text-decoration:none}
    .styled-table a:hover{text-decoration:underline}
    .status-badge{display:inline-block;padding:4px 8px;border-radius:4px;font-size:11px;font-weight:600}
    .status-badge.bad{background:rgba(239,68,68,0.15);color:var(--red)}
    .pos-change{font-size:11px;margin-left:6px;padding:2px 6px;border-radius:4px}
    .pos-change.up{color:var(--green);background:rgba(16,185,129,0.15)}
    .pos-change.down{color:var(--red);background:rgba(239,68,68,0.15)}
    .opportunities-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
    .opportunity-card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px;border-left:4px solid var(--blue)}
    .opportunity-card.page1{border-left-color:var(--green)}
    .opportunity-card.page2{border-left-color:var(--yellow)}
    .opportunity-card.page3{border-left-color:var(--red)}
    .opp-keyword{font-weight:600;color:var(--text1);margin-bottom:8px;font-size:14px}
    .opp-metrics{display:flex;gap:12px;margin-bottom:8px}
    .opp-stat{font-size:12px;color:var(--text2)}
    .opp-stat strong{color:var(--text3)}
    .opp-tip{font-size:11px;color:var(--text3);background:var(--card);padding:6px 10px;border-radius:6px}
    .issue-card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:12px;border-left:4px solid var(--red)}
    .issue-card.warning{border-left-color:var(--yellow)}
    .issue-card .issue-url{font-family:monospace;font-size:13px;color:var(--blue);word-break:break-all;margin-bottom:12px}
    .issue-card .issue-status{display:inline-block;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600;margin-bottom:12px}
    .issue-card .issue-status.error{background:rgba(239,68,68,0.2);color:var(--red)}
    .issue-card .issue-status.warning{background:rgba(245,158,11,0.2);color:var(--yellow)}
    .issue-card .issue-details{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}
    .issue-card .detail-row{display:flex;justify-content:space-between;font-size:12px;padding:4px 0}
    .issue-card .detail-row .label{color:var(--text3)}
    .issue-card .detail-row .value{color:var(--text);font-weight:500}
    .tabs{display:flex;gap:4px;background:var(--bg2);padding:4px;border-radius:10px;margin-bottom:20px;width:fit-content}
    .tab{padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;color:var(--text2);background:none;border:none}
    .tab:hover{color:var(--text)}
    .tab.active{background:var(--card);color:var(--text)}
    .tab-content{display:none}
    .tab-content.active{display:block}
    .loading-overlay{display:none;position:fixed;inset:0;background:rgba(15,15,26,0.9);z-index:1000;align-items:center;justify-content:center}
    .loading-overlay.active{display:flex}
    .spinner{width:40px;height:40px;border:3px solid var(--border);border-top-color:var(--blue);border-radius:50%;animation:spin 0.8s linear infinite}
    @media(max-width:900px){.sidebar{transform:translateX(-100%)}.main{margin-left:0}}
  </style>
</head>
<body>
  <div class="loading-overlay" id="loading"><div class="spinner"></div></div>
  <div class="app">
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="logo">
          <div class="logo-icon">W</div>
          <div><h1>Web Health Dashboard</h1><span>Adair Family Wines</span></div>
        </div>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-section">
          <div class="nav-section-title">Overview</div>
          <button class="nav-item active" data-view="portfolio"><span>=</span><span class="label">All Properties</span></button>
        </div>
        <div class="nav-section">
          <div class="nav-section-title">Properties</div>
          <div id="property-nav"></div>
        </div>
      </nav>
    </aside>
    <main class="main">
      <div class="view active" id="view-portfolio">
        <div class="page-header">
          <div class="page-title"><h2>Portfolio Overview</h2><p>All properties summary</p></div>
          <div class="header-actions">
            <span class="last-updated" id="lastUpdated">Last audit: -</span>
          </div>
        </div>
        <div class="summary-grid">
          <div class="summary-card"><div class="icon yellow">*</div><div class="value" id="total-open">-</div><div class="label">Open Issues</div></div>
          <div class="summary-card"><div class="icon green">OK</div><div class="value" id="total-fixed">-</div><div class="label">Total Fixed</div></div>
          <div class="summary-card"><div class="icon red">+</div><div class="value" id="total-new">-</div><div class="label">New This Week</div></div>
          <div class="summary-card"><div class="icon red">!</div><div class="value" id="total-high">-</div><div class="label">High Priority</div></div>
        </div>
        <div class="section"><div class="section-header"><h3>Performance Trends</h3><span style="font-size:12px;color:var(--text3)">LCP (Largest Contentful Paint) over time - lower is better</span></div><div style="background:var(--card);border-radius:12px;padding:20px;height:300px;position:relative"><canvas id="perf-trends-chart"></canvas><div id="perf-trends-loading" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--text3)">Loading performance data...</div></div></div>
        <div class="section"><div class="section-header"><h3>Properties</h3></div><div class="properties-grid" id="properties-grid"></div></div>
      </div>
      <div class="view" id="view-property">
        <div class="page-header">
          <div class="page-title"><h2 id="prop-name">Property</h2><p id="prop-domains">-</p></div>
          <div class="header-actions"><button class="btn" style="background:var(--card)" onclick="showView('portfolio')"><- Back</button></div>
        </div>
        <div class="tabs">
          <button class="tab active" data-tab="overview">Overview</button>
          <button class="tab" data-tab="performance">Performance</button>
          <button class="tab" data-tab="seo">SEO</button>
          <button class="tab" data-tab="accessibility">Accessibility</button>
        </div>
        <div class="tab-content active" id="tab-overview">
          <div class="metrics-grid" id="overview-stats"></div>
          <div class="section"><div class="section-header"><h3>Quick Stats</h3><span style="font-size:12px;color:var(--text3)">Performance & SEO at a glance</span></div><div class="metrics-grid" id="overview-quick"></div></div>
          <div class="section"><div class="section-header"><h3>High Priority Issues</h3></div><div id="overview-issues"></div></div>
        </div>
        <div class="tab-content" id="tab-performance">
          <div class="section"><div class="section-header"><h3>Traffic Overview</h3><span style="font-size:12px;color:var(--text3)">Last 7 days from Cloudflare</span></div><div class="metrics-grid" id="perf-traffic"></div></div>
          <div class="section"><div class="section-header"><h3>User Analytics</h3><span style="font-size:12px;color:var(--text3)">From Google Analytics 4</span></div><div class="metrics-grid" id="perf-ga4"></div></div>
          <div class="section"><div class="section-header"><h3>Response Codes</h3><span style="font-size:12px;color:var(--text3)">HTTP status distribution</span></div><div class="metrics-grid" id="perf-codes"></div></div>
          <div class="section"><div class="section-header"><h3>Top Pages</h3><span style="font-size:12px;color:var(--text3)">Most viewed pages</span></div><div id="perf-pages"></div></div>
          <div class="section"><div class="section-header"><h3>Core Web Vitals</h3><span style="font-size:12px;color:var(--text3)">Real user data from CrUX</span></div><div class="metrics-grid" id="perf-cwv"></div></div>
          <div class="section"><div class="section-header"><h3>Recommendations</h3></div><div id="perf-recommendations"></div></div>
        </div>
        <div class="tab-content" id="tab-seo">
          <div class="section"><div class="section-header"><h3>SEO Issues</h3><span id="seo-audit-info" style="font-size:12px;color:var(--text3)"></span></div><div id="seo-issues"></div></div>
          <div class="section"><div class="section-header"><h3>Broken Links &amp; 404s</h3></div><div id="seo-broken"></div><div id="seo-404s" style="margin-top:16px"></div></div>
          <div class="section"><div class="section-header"><h3>Keyword Opportunities</h3><span style="font-size:12px;color:var(--text3)">Non-branded keywords with growth potential</span></div><div id="seo-opportunities"></div></div>
          <div class="section"><div class="section-header"><h3>Top Keywords</h3><span style="font-size:12px;color:var(--text3)">From Google Search Console (28 days)</span></div><div id="seo-keywords"></div></div>
        </div>
        <div class="tab-content" id="tab-accessibility">
          <div class="section"><div class="section-header"><h3>Accessibility Issues</h3></div><div id="a11y-issues"></div></div>
          <div class="section"><div class="section-header"><h3>How to Fix</h3></div><div id="a11y-recommendations"></div></div>
        </div>
      </div>
    </main>
  </div>
  <div class="modal-overlay" id="issue-modal" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <div class="modal-header">
        <h3 id="modal-title">Issue Details</h3>
        <button class="modal-close" onclick="closeModal()">&times;</button>
      </div>
      <div class="modal-body" id="modal-body"></div>
    </div>
  </div>
  <script>
    const PROPERTIES={adair:{name:"Adair Family Wines",shortName:"Adair",color:"#8B4513",domain:"adairfamilywines.com"},brcohn:{name:"BR Cohn",shortName:"BR Cohn",color:"#722F37",domain:"brcohn.com"},clospegase:{name:"Clos Pegase",shortName:"Clos Pegase",color:"#4A0E0E",domain:"clospegase.com"},girard:{name:"Girard Winery",shortName:"Girard",color:"#1a1a2e",domain:"girardwinery.com"},kunde:{name:"Kunde Family Winery",shortName:"Kunde",color:"#2E5339",domain:"kunde.com"},viansa:{name:"Viansa Sonoma",shortName:"Viansa",color:"#D4A84B",domain:"viansa.com"}};
    let data=null,propertyData={},currentDomain=null,currentPropertyId=null,tabDataLoaded={};
    document.addEventListener('DOMContentLoaded',()=>{buildPropertyNav();initTabs();renderPortfolio()});
    function buildPropertyNav(){const nav=document.getElementById('property-nav');nav.innerHTML=Object.entries(PROPERTIES).map(function(e){var id=e[0],p=e[1];return '<button class="nav-item" data-property="'+id+'"><div class="color-bar" style="background:'+p.color+'"></div><span class="label">'+p.shortName+'</span><div class="status" id="nav-status-'+id+'"></div></button>'}).join('');nav.querySelectorAll('.nav-item').forEach(btn=>{btn.addEventListener('click',()=>showProperty(btn.dataset.property))});document.querySelector('.nav-item[data-view="portfolio"]').addEventListener('click',()=>showView('portfolio'))}
    function initTabs(){document.querySelectorAll('.tab').forEach(tab=>{tab.addEventListener('click',async()=>{const view=tab.closest('.view');view.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));view.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));tab.classList.add('active');document.getElementById('tab-'+tab.dataset.tab).classList.add('active');if(tab.dataset.tab==='performance'){await loadPerformance()}if(tab.dataset.tab==='seo'){await loadSEO()}if(tab.dataset.tab==='accessibility'){await loadAccessibility()}})})}
    async function loadPerformance(){if(!currentDomain||!currentPropertyId||tabDataLoaded[currentDomain+'-perf'])return;document.getElementById('perf-traffic').innerHTML='<div class="metric-card" style="grid-column:1/-1"><div class="value" style="font-size:14px">Loading Cloudflare data...</div></div>';document.getElementById('perf-ga4').innerHTML='<div class="metric-card" style="grid-column:1/-1"><div class="value" style="font-size:14px">Loading GA4 data...</div></div>';document.getElementById('perf-codes').innerHTML='';document.getElementById('perf-pages').innerHTML='';document.getElementById('perf-cwv').innerHTML='<div class="metric-card" style="grid-column:1/-1"><div class="value" style="font-size:14px">Loading Core Web Vitals...</div></div>';document.getElementById('perf-recommendations').innerHTML='';try{const res=await fetch('/api/performance?property='+currentPropertyId+'&domain='+currentDomain);const data=await res.json();tabDataLoaded[currentDomain+'-perf']=true;renderPerformance(data)}catch(e){document.getElementById('perf-traffic').innerHTML='<div class="metric-card" style="grid-column:1/-1"><div class="value bad">Failed to load</div></div>';document.getElementById('perf-ga4').innerHTML='';document.getElementById('perf-cwv').innerHTML=''}}
    function renderPerformance(data){var cf=data.cloudflare||{};var ga=data.ga4||{};var cwv=data.cwv||{};renderTraffic(cf);renderGA4(ga);renderCWV(cwv);renderResponseCodes(cf.responseStatus||cf.responseCodes);renderTopPages(ga.topPages);renderPerfRecs(cf,ga,cwv)}
    function renderTraffic(cf){if(cf.error){document.getElementById('perf-traffic').innerHTML='<div class="metric-card" style="grid-column:1/-1"><div class="value" style="font-size:14px;color:var(--text3)">'+cf.error+'</div></div>';return}var reqChange=parseFloat(cf.requestsChange)||0;var pvChange=parseFloat(cf.pageViewsChange)||0;var cacheVal=cf.cacheRatio||cf.cacheHitRatio||0;var errorRate=cf.errorRate||0;document.getElementById('perf-traffic').innerHTML='<div class="metric-card"><div class="label">Total Requests</div><div class="value">'+fmt(cf.requests)+'</div><div class="subtext">'+(reqChange>=0?'<span class="good">^':'<span class="bad">v')+Math.abs(reqChange).toFixed(1)+'%</span> vs last week</div></div><div class="metric-card"><div class="label">Bandwidth</div><div class="value">'+cf.bandwidth+'</div><div class="subtext">Total transferred</div></div><div class="metric-card"><div class="label">Cache Hit Ratio</div><div class="value '+cacheClass(parseFloat(cacheVal))+'">'+cacheVal+'%</div><div class="subtext">Target: >80%</div></div><div class="metric-card"><div class="label">Error Rate</div><div class="value '+(parseFloat(errorRate)<1?'good':parseFloat(errorRate)<5?'warning':'bad')+'">'+errorRate+'%</div><div class="subtext">4xx + 5xx</div></div><div class="metric-card"><div class="label">Threats Blocked</div><div class="value '+(cf.threats>0?'warning':'good')+'">'+fmt(cf.threats)+'</div><div class="subtext">Last 7 days</div></div>'}
    function renderGA4(ga){if(ga.error||ga.note){document.getElementById('perf-ga4').innerHTML='<div class="metric-card" style="grid-column:1/-1"><div class="value" style="font-size:14px;color:var(--text3)">'+(ga.note||ga.error)+'</div></div>';return}var sessChange=parseFloat(ga.sessionsChange)||0;var newUsersChange=parseFloat(ga.newUsersChange)||0;document.getElementById('perf-ga4').innerHTML='<div class="metric-card"><div class="label">Sessions</div><div class="value">'+fmt(ga.sessions)+'</div><div class="subtext">'+(sessChange>=0?'<span class="good">^':'<span class="bad">v')+Math.abs(sessChange).toFixed(1)+'%</span> vs last week</div></div><div class="metric-card"><div class="label">New Users</div><div class="value">'+fmt(ga.newUsers)+'</div><div class="subtext">'+(newUsersChange>=0?'<span class="good">^':'<span class="bad">v')+Math.abs(newUsersChange).toFixed(1)+'%</span> vs last week</div></div><div class="metric-card"><div class="label">Bounce Rate</div><div class="value '+(parseFloat(ga.bounceRate)<40?'good':parseFloat(ga.bounceRate)<60?'warning':'bad')+'">'+ga.bounceRate+'%</div><div class="subtext">Target: <40%</div></div><div class="metric-card"><div class="label">Avg Duration</div><div class="value '+(ga.avgDurationSec>120?'good':ga.avgDurationSec>60?'warning':'bad')+'">'+ga.avgDuration+'</div><div class="subtext">Target: >2m</div></div><div class="metric-card"><div class="label">Engagement Rate</div><div class="value '+(parseFloat(ga.engagementRate)>60?'good':parseFloat(ga.engagementRate)>40?'warning':'bad')+'">'+ga.engagementRate+'%</div><div class="subtext">Target: >60%</div></div><div class="metric-card"><div class="label">Page Views</div><div class="value">'+fmt(ga.pageViews)+'</div><div class="subtext">Last 7 days</div></div>'}
    function renderCWV(cwv){if(cwv.error){document.getElementById('perf-cwv').innerHTML='<div class="metric-card" style="grid-column:1/-1"><div class="value" style="font-size:14px;color:var(--text3)">'+cwv.error+'</div></div>';return}document.getElementById('perf-cwv').innerHTML='<div class="metric-card"><div class="label">LCP <span class="info-icon" title="Largest Contentful Paint: Time until the largest visible element loads.">?</span></div><div class="value '+cwvClass(cwv.lcpRating)+'">'+(cwv.LCP?(cwv.LCP/1000).toFixed(2)+'s':'-')+'</div><div class="subtext">Target: <2.5s</div></div><div class="metric-card"><div class="label">INP <span class="info-icon" title="Interaction to Next Paint: Time from click to visual response.">?</span></div><div class="value '+cwvClass(cwv.inpRating)+'">'+(cwv.INP?cwv.INP+'ms':'-')+'</div><div class="subtext">Target: <200ms</div></div><div class="metric-card"><div class="label">CLS <span class="info-icon" title="Cumulative Layout Shift: How much content moves during loading.">?</span></div><div class="value '+cwvClass(cwv.clsRating)+'">'+(cwv.CLS!==null?cwv.CLS.toFixed(2):'-')+'</div><div class="subtext">Target: <0.1</div></div><div class="metric-card"><div class="label">FCP</div><div class="value '+cwvClass(cwv.fcpRating)+'">'+(cwv.FCP?(cwv.FCP/1000).toFixed(2)+'s':'-')+'</div><div class="subtext">Target: <1.8s</div></div><div class="metric-card"><div class="label">TTFB</div><div class="value '+cwvClass(cwv.ttfbRating)+'">'+(cwv.TTFB?cwv.TTFB+'ms':'-')+'</div><div class="subtext">Target: <800ms</div></div><div class="metric-card"><div class="label">Overall</div><div class="value '+cwvClass(cwv.overallCategory)+'">'+(cwv.overallCategory||'-')+'</div><div class="subtext">Google Rating</div></div>'}
    function renderResponseCodes(codes){if(!codes)return;var total=codes.success+codes.redirect+codes.clientError+codes.serverError||1;document.getElementById('perf-codes').innerHTML='<div class="metric-card"><div class="label">2xx Success</div><div class="value good">'+fmt(codes.success)+'</div><div class="subtext">'+((codes.success/total)*100).toFixed(1)+'%</div></div><div class="metric-card"><div class="label">3xx Redirect</div><div class="value">'+fmt(codes.redirect)+'</div><div class="subtext">'+((codes.redirect/total)*100).toFixed(1)+'%</div></div><div class="metric-card"><div class="label">4xx Client Error</div><div class="value '+(codes.clientError>0?'warning':'')+'">'+fmt(codes.clientError)+'</div><div class="subtext">'+((codes.clientError/total)*100).toFixed(1)+'%</div></div><div class="metric-card"><div class="label">5xx Server Error</div><div class="value '+(codes.serverError>0?'bad':'')+'">'+fmt(codes.serverError)+'</div><div class="subtext">'+((codes.serverError/total)*100).toFixed(1)+'%</div></div>'}
    function renderTopPages(pages){var el=document.getElementById('perf-pages');if(!el)return;if(!pages||pages.length===0){el.innerHTML='<p style="color:var(--text3)">No page data available</p>';return}el.innerHTML='<div class="styled-table-wrap"><table class="styled-table"><thead><tr><th>Page</th><th class="num">Views</th><th class="num">Avg Time</th></tr></thead><tbody>'+pages.map(function(p){var path=p.path||'/';var shortPath=path.length>50?path.substring(0,50)+'...':path;var avgTime=parseFloat(p.avgTime)||0;var timeStr=avgTime<60?Math.round(avgTime)+'s':Math.floor(avgTime/60)+'m '+Math.round(avgTime%60)+'s';return '<tr><td title="'+escapeHtml(path)+'">'+escapeHtml(shortPath)+'</td><td class="num">'+fmt(p.views)+'</td><td class="num">'+timeStr+'</td></tr>'}).join('')+'</tbody></table></div>'}
    function renderPerfRecs(cf,ga,cwv){var recs=[];var codes=cf.responseStatus||cf.responseCodes||{};var cacheVal=cf.cacheRatio||cf.cacheHitRatio||0;if(cwv.lcpRating&&cwv.lcpRating!=='GOOD')recs.push({title:'Improve LCP ('+((cwv.LCP/1000).toFixed(1))+'s)',tip:'Optimize hero images with WebP, add preload for critical images, ensure explicit dimensions.',severity:'high'});if(cwv.inpRating&&cwv.inpRating!=='GOOD')recs.push({title:'Improve INP ('+cwv.INP+'ms)',tip:'Reduce JavaScript execution, break up long tasks, defer non-critical JS.',severity:'medium'});if(cwv.clsRating&&cwv.clsRating!=='GOOD')recs.push({title:'Improve CLS ('+(cwv.CLS?.toFixed(2)||'?')+')',tip:'Set explicit width/height on images and embeds, reserve space for dynamic content.',severity:'medium'});if(parseFloat(cacheVal)<70)recs.push({title:'Improve Cache Hit Ratio ('+cacheVal+'%)',tip:'Review cache rules, increase TTLs for static assets, use Cache-Control headers.',severity:'medium'});if(ga.bounceRate&&parseFloat(ga.bounceRate)>60)recs.push({title:'Reduce Bounce Rate ('+ga.bounceRate+'%)',tip:'Improve page load speed, enhance above-fold content, add clear CTAs.',severity:'medium'});if(codes.clientError>100)recs.push({title:'Fix 4xx Errors ('+codes.clientError+' requests)',tip:'Check for broken links, missing pages, and incorrect redirects.',severity:'high'});if(codes.serverError>0)recs.push({title:'Fix 5xx Server Errors ('+codes.serverError+' requests)',tip:'Check server logs for errors, ensure adequate resources and uptime.',severity:'high'});if(recs.length===0)recs.push({title:'Performance is healthy!',tip:'Keep monitoring to maintain good user experience.',severity:'good'});document.getElementById('perf-recommendations').innerHTML=recs.map(function(r){return '<div class="action-item '+r.severity+'"><span class="priority">'+(r.severity==='good'?'OK':r.severity.toUpperCase())+'</span><div class="action-item-content"><div class="issue">'+r.title+'</div><div class="action" style="font-size:12px;color:var(--text3);margin-top:4px">'+r.tip+'</div></div></div>'}).join('')}
    async function loadSEO(){if(!currentDomain||tabDataLoaded[currentDomain+'-seo'])return;document.getElementById('seo-issues').innerHTML='<p>Loading...</p>';document.getElementById('seo-keywords').innerHTML='<p>Loading keywords...</p>';document.getElementById('seo-opportunities').innerHTML='<p>Loading opportunities...</p>';document.getElementById('seo-404s').innerHTML='';try{var healthRes=fetch('/api/site-health?domain='+currentDomain);var kwRes=fetch('/api/keywords?domain='+currentDomain);var errors404Res=fetch('/api/404-errors?property='+currentPropertyId);var data=await (await healthRes).json();var kwData=await (await kwRes).json();var errors404Data=await (await errors404Res).json();tabDataLoaded[currentDomain+'-seo']=true;renderSEO(data,kwData,errors404Data)}catch(e){document.getElementById('seo-issues').innerHTML='<p class="bad">Failed to load</p>';document.getElementById('seo-keywords').innerHTML='<p class="bad">Failed to load</p>';document.getElementById('seo-opportunities').innerHTML=''}}
    function renderSEO(data,kwData,errors404Data){if(!data.hasData){document.getElementById('seo-audit-info').textContent='';document.getElementById('seo-issues').innerHTML='<p style="color:var(--text3)">No audit data. Run /api/trigger-audit</p>';document.getElementById('seo-broken').innerHTML='';document.getElementById('seo-keywords').innerHTML='';document.getElementById('seo-opportunities').innerHTML='';}else{var lastAudit=data.lastAudit||{};document.getElementById('seo-audit-info').textContent=lastAudit.date?'Last audit: '+fmtDatePST(lastAudit.date)+' ('+(lastAudit.pagesAudited||0)+' pages)':'';var actions=data.actionItems||[];if(actions.length===0){document.getElementById('seo-issues').innerHTML='<div class="all-clear"><div class="icon">OK</div><h3>All Clear</h3><p>No SEO issues</p></div>'}else{window.seoIssueData=actions;document.getElementById('seo-issues').innerHTML=actions.map(function(a,idx){var newBadge=a.newThisWeek>0?' <span style="background:var(--red);color:white;padding:2px 6px;border-radius:4px;font-size:10px;margin-left:4px">'+a.newThisWeek+' NEW</span>':'';var previewUrls=(a.urls||a.pages||[]).slice(0,2).map(function(u){return u.length>50?u.substring(0,50)+'...':u}).join(', ');return '<div class="action-item clickable-issue '+a.severity+' " data-idx="'+idx+'" data-type="seo"><span class="priority">'+a.severity.toUpperCase()+'</span><div class="action-item-content"><div class="issue">'+a.message+newBadge+'</div><div class="action" style="font-size:12px;color:var(--text3);margin-top:4px">'+previewUrls+(a.count>2?' (+'+(a.count-2)+' more)':'')+ '</div></div></div>'}).join('');attachIssueClicks()}var broken=data.brokenLinks||[];if(broken.length===0){document.getElementById('seo-broken').innerHTML='<p style="color:var(--text3)">No broken links detected</p>'}else{document.getElementById('seo-broken').innerHTML='<div class="styled-table-wrap"><table class="styled-table"><thead><tr><th>Broken URL</th><th>Status</th><th>Found On</th></tr></thead><tbody>'+broken.map(function(b){var displayUrl=b.url||b.path;var shortUrl=displayUrl.length>60?displayUrl.substring(0,60)+'...':displayUrl;var source=b.source||'';var shortSource=source.length>30?'...'+source.slice(-30):source;return '<tr><td><a href="'+(b.url||'#')+'" target="_blank" title="'+escapeHtml(displayUrl)+'">'+escapeHtml(shortUrl)+'</a></td><td><span class="status-badge bad">'+(b.status||'Error')+'</span></td><td title="'+escapeHtml(source)+'">'+escapeHtml(shortSource)+'</td></tr>'}).join('')+'</tbody></table></div>'}}var errors404=errors404Data?.errors||[];if(errors404.length>0){document.getElementById('seo-404s').innerHTML='<h4 style="margin:0 0 12px;color:var(--text2)">404 Errors from Cloudflare ('+errors404Data.period+')</h4><div class="styled-table-wrap"><table class="styled-table"><thead><tr><th>Path</th><th class="num">404 Count</th><th class="num">Total Requests</th></tr></thead><tbody>'+errors404.slice(0,20).map(function(e){return '<tr><td>'+escapeHtml(e.path)+'</td><td class="num bad">'+fmt(e.count)+'</td><td class="num">'+fmt(e.totalRequests)+'</td></tr>'}).join('')+'</tbody></table></div>'}var keywords=(kwData&&kwData.keywords)||[];if(keywords.length===0){document.getElementById('seo-keywords').innerHTML='<p style="color:var(--text3)">No keyword data. Run audit to fetch from Search Console.</p>'}else{document.getElementById('seo-keywords').innerHTML='<div class="styled-table-wrap"><table class="styled-table"><thead><tr><th>Keyword</th><th class="num">Clicks</th><th class="num">Impressions</th><th class="num">CTR</th><th class="num">Position</th></tr></thead><tbody>'+keywords.map(function(k){var posChange=k.positionChange||0;var changeClass=posChange>0.5?'up':posChange<-0.5?'down':'';var changeIcon=posChange>0.5?'<span class="pos-change up" title="Improved by '+posChange.toFixed(1)+' positions">^ '+Math.abs(posChange).toFixed(1)+'</span>':posChange<-0.5?'<span class="pos-change down" title="Dropped by '+Math.abs(posChange).toFixed(1)+' positions">v '+Math.abs(posChange).toFixed(1)+'</span>':'';return '<tr><td class="keyword">'+escapeHtml(k.query)+'</td><td class="num"><strong>'+fmt(k.clicks)+'</strong></td><td class="num">'+fmt(k.impressions)+'</td><td class="num">'+k.ctr+'</td><td class="num">'+k.position+' '+changeIcon+'</td></tr>'}).join('')+'</tbody></table></div>'}var opps=(kwData&&kwData.opportunities)||[];if(opps.length===0){document.getElementById('seo-opportunities').innerHTML='<p style="color:var(--text3)">No keyword opportunities found. Need more Search Console data.</p>'}else{document.getElementById('seo-opportunities').innerHTML='<div class="opportunities-grid">'+opps.map(function(o){var posClass=parseFloat(o.position)<=10?'page1':parseFloat(o.position)<=20?'page2':'page3';return '<div class="opportunity-card '+posClass+'"><div class="opp-keyword">'+escapeHtml(o.query)+'</div><div class="opp-metrics"><span class="opp-stat"><strong>Pos:</strong> '+o.position+'</span><span class="opp-stat"><strong>Impr:</strong> '+fmt(o.impressions)+'</span><span class="opp-stat"><strong>Clicks:</strong> '+fmt(o.clicks)+'</span></div><div class="opp-tip">'+o.tip+'</div></div>'}).join('')+'</div>'}}
    async function loadAccessibility(){if(!currentDomain||tabDataLoaded[currentDomain+'-a11y'])return;document.getElementById('a11y-issues').innerHTML='<p>Loading...</p>';try{const res=await fetch('/api/accessibility?domain='+currentDomain);const data=await res.json();tabDataLoaded[currentDomain+'-a11y']=true;renderAccessibility(data)}catch(e){document.getElementById('a11y-issues').innerHTML='<p class="bad">Failed to load</p>'}}
    async function loadOverviewData(){if(!currentDomain)return;try{var seoRes=fetch('/api/seo-stats?domain='+currentDomain);var a11yRes=fetch('/api/accessibility?domain='+currentDomain);var perfRes=fetch('/api/performance?property='+currentPropertyId+'&domain='+currentDomain);var kwRes=fetch('/api/keywords?domain='+currentDomain);var seo=(await (await seoRes).json());var a11y=(await (await a11yRes).json());var perf=(await (await perfRes).json());var kwData=(await (await kwRes).json());var allHighIssues=[];var a11yOpenCount=0;var a11yNewCount=0;if(seo&&seo.hasData!==false){(seo.topIssues||[]).filter(function(i){return i.severity==='high'}).forEach(function(i){allHighIssues.push({type:'seo',issueType:i.type,issue:i.message||formatIssueMsg(i.type,i.count),urls:i.urls||i.pages||[],pages:i.pages||[],count:i.count,pageCount:i.count})})}if(a11y&&a11y.hasData){(a11y.issues||[]).forEach(function(i){a11yOpenCount+=i.pageCount||1;a11yNewCount+=i.newThisWeek||0;if(i.severity==='high'){allHighIssues.push({type:'a11y',issueType:i.type,issue:formatA11yIssue(i.type,i.count),pages:i.pages||[],count:i.count,pageCount:i.pageCount||i.pages?.length||1})}})}var totalOpen=(seo?.openIssues||0)+a11yOpenCount;var totalFixed=(seo?.fixedThisWeek||0);var totalNew=(seo?.newThisWeek||0)+a11yNewCount;var highCount=allHighIssues.reduce(function(s,i){return s+(i.pageCount||1)},0);window.fixedIssuesData=seo?.fixedIssues||[];document.getElementById('overview-stats').innerHTML='<div class="metric-card"><div class="label">OPEN ISSUES</div><div class="value '+(totalOpen>0?'warning':'good')+'">'+totalOpen+'</div></div><div class="metric-card'+(totalFixed>0?' clickable" onclick="showFixedModal()"':'"')+'><div class="label">FIXED THIS WEEK</div><div class="value '+(totalFixed>0?'good':'')+'">'+totalFixed+'</div>'+(totalFixed>0?'<div class="subtext" style="font-size:10px">Click to view</div>':'')+'</div><div class="metric-card"><div class="label">NEW THIS WEEK</div><div class="value '+(totalNew>0?'bad':'good')+'">'+totalNew+'</div></div><div class="metric-card"><div class="label">HIGH PRIORITY</div><div class="value '+(highCount>0?'bad':'good')+'">'+highCount+'</div></div>';renderQuickStats(perf,kwData);if(allHighIssues.length===0){document.getElementById('overview-issues').innerHTML='<div class="all-clear"><div class="icon">OK</div><h3>No High Priority Issues</h3><p>Check other tabs for details</p></div>'}else{window.overviewIssueData=allHighIssues;document.getElementById('overview-issues').innerHTML=allHighIssues.map(function(i,idx){var badge=i.type==='a11y'?'<span style="background:var(--purple);color:white;padding:2px 6px;border-radius:4px;font-size:10px;margin-left:6px">A11Y</span>':'';var previewUrls=(i.pages||i.urls||[]).slice(0,2).map(function(p){return typeof p==='object'?(p.path||p.url):p}).join(', ');return '<div class="action-item high clickable-issue" data-idx="'+idx+'" data-type="overview"><span class="priority">HIGH</span><div class="action-item-content"><div class="issue">'+i.issue+badge+'</div><div class="action" style="font-size:12px;color:var(--text3);margin-top:4px">'+previewUrls+(i.pageCount>2?' (+'+(i.pageCount-2)+' more)':'')+'</div></div></div>'}).join('');attachIssueClicks()}}catch(e){console.error('loadOverviewData error:',e)}}
    function renderQuickStats(perf,kwData){var el=document.getElementById('overview-quick');if(!el)return;var cf=perf?.cloudflare||{};var ga=perf?.ga4||{};var cwv=perf?.cwv||{};var kw=kwData?.keywords||[];var avgPos=kw.length>0?kw.reduce(function(s,k){return s+parseFloat(k.position)},0)/kw.length:null;var sessChange=parseFloat(ga.sessionsChange)||0;var lcpSec=cwv.LCP?(cwv.LCP/1000).toFixed(1):null;var cacheVal=parseFloat(cf.cacheRatio)||0;el.innerHTML='<div class="metric-card"><div class="label">SESSIONS</div><div class="value">'+(ga.sessions?fmt(ga.sessions):'-')+'</div>'+(ga.sessions?'<div class="subtext">'+(sessChange>=0?'<span class="good">^':'<span class="bad">v')+Math.abs(sessChange).toFixed(1)+'%</span> vs last week</div>':'')+'</div><div class="metric-card"><div class="label">PAGE SPEED (LCP)</div><div class="value '+(cwv.lcpRating==='FAST'?'good':cwv.lcpRating==='AVERAGE'?'warning':'bad')+'">'+(lcpSec?lcpSec+'s':'-')+'</div><div class="subtext">'+(cwv.lcpRating||'No data')+' - Target <2.5s</div></div><div class="metric-card"><div class="label">CACHE HIT RATIO</div><div class="value '+(cacheVal>=80?'good':cacheVal>=60?'warning':'bad')+'">'+(cacheVal?cacheVal.toFixed(0)+'%':'-')+'</div><div class="subtext">Target >80%</div></div><div class="metric-card"><div class="label">AVG POSITION</div><div class="value '+(avgPos&&avgPos<=10?'good':avgPos&&avgPos<=20?'warning':'bad')+'">'+(avgPos?avgPos.toFixed(1):'-')+'</div><div class="subtext">'+(avgPos?avgPos<=10?'Page 1 avg':avgPos<=20?'Page 2 avg':'Page 3+ avg':'No keyword data')+'</div></div>'}
    function renderAccessibility(data){if(!data.hasData||!data.issues||data.issues.length===0){document.getElementById('a11y-issues').innerHTML='<div class="all-clear"><div class="icon">OK</div><h3>All Clear</h3><p>No accessibility issues</p></div>';document.getElementById('a11y-recommendations').innerHTML='';return}var issues=data.issues;window.a11yIssueData=issues;document.getElementById('a11y-issues').innerHTML=issues.map(function(i,idx){var newBadge=i.newThisWeek>0?' <span style="background:var(--red);color:white;padding:2px 6px;border-radius:4px;font-size:10px;margin-left:4px">'+i.newThisWeek+' NEW</span>':'';var previewUrls=(i.pages||[]).slice(0,2).map(function(p){var u=typeof p==='object'?(p.path||p.url):p;return u.length>50?u.substring(0,50)+'...':u}).join(', ');return '<div class="action-item clickable-issue '+i.severity+'" data-idx="'+idx+'" data-type="a11y"><span class="priority">'+i.severity.toUpperCase()+'</span><div class="action-item-content"><div class="issue">'+formatA11yIssue(i.type,i.count)+newBadge+'</div><div class="action" style="font-size:12px;color:var(--text3);margin-top:4px">'+previewUrls+(i.pageCount>2?' (+'+(i.pageCount-2)+' more pages)':'')+'</div></div></div>'}).join('');attachIssueClicks();var recs=getA11yRecs(issues);document.getElementById('a11y-recommendations').innerHTML=recs.map(function(r){return '<div class="rec-card"><h4>'+r.title+'</h4><p>'+r.desc+'</p><code>'+r.code+'</code></div>'}).join('')}
    function formatA11yIssue(type,count){var msgs={'missing_alt':count+' images missing alt text','missing_lang':'Missing lang attribute','empty_links':count+' empty links','missing_labels':count+' inputs without labels','no_skip_link':'No skip navigation link','heading_hierarchy':'Heading hierarchy issues','empty_buttons':count+' empty buttons'};return msgs[type]||count+' '+type+' issues'}
    function getA11yRecs(issues){var recs=[],types=issues.map(function(i){return i.type});if(types.includes('missing_alt'))recs.push({title:'Add alt text to images',desc:'Every image needs descriptive alt text.',code:'<img src="wine.jpg" alt="2024 Cabernet">'});if(types.includes('missing_labels'))recs.push({title:'Add labels to form inputs',desc:'Form inputs need linked labels.',code:'<label for="email">Email</label>\\n<input id="email">'});if(types.includes('missing_lang'))recs.push({title:'Add lang attribute',desc:'Helps screen readers.',code:'<html lang="en">'});if(types.includes('heading_hierarchy'))recs.push({title:'Fix heading order',desc:'Do not skip levels (h1 to h3).',code:'<h1>Title</h1>\\n<h2>Section</h2>'});return recs}
    function renderSiteHealthData(data){
      if(!data.hasData){
        document.getElementById('health-progress').innerHTML='<div class="metric-card" style="grid-column:1/-1"><div class="value">No audit data yet. Trigger an audit to start.</div></div>';
        document.getElementById('health-actions').innerHTML='';
        document.getElementById('health-broken').innerHTML='';
        return;
      }
      
      var sum=data.summary||{};
      var lastAudit=data.lastAudit||{};
      var auditDate=lastAudit.date?new Date(lastAudit.date).toLocaleDateString():'';
      
      document.getElementById('audit-info').textContent=lastAudit.date?'Last audit: '+auditDate+' ('+lastAudit.pagesAudited+' pages)':'';
      
      document.getElementById('health-progress').innerHTML='<div class="metric-card"><div class="label">Open Issues</div><div class="value '+(sum.totalOpenIssues>0?'warning':'good')+'">'+sum.totalOpenIssues+'</div></div><div class="metric-card"><div class="label">Fixed This Week</div><div class="value '+(sum.fixedThisWeek>0?'good':'')+'">'+sum.fixedThisWeek+'</div></div><div class="metric-card"><div class="label">New This Week</div><div class="value '+(sum.newThisWeek>0?'bad':'good')+'">'+sum.newThisWeek+'</div></div><div class="metric-card"><div class="label">Broken Links</div><div class="value '+(sum.brokenLinks>0?'bad':'good')+'">'+sum.brokenLinks+'</div></div>';
      
      var actions=data.actionItems||[];
      if(actions.length===0){
        document.getElementById('health-actions').innerHTML='<div class="all-clear"><div class="icon">OK</div><h3>All Clear</h3><p>No SEO issues to fix</p></div>';
      }else{
        document.getElementById('health-actions').innerHTML=actions.map(function(a){
          var newBadge=a.newThisWeek>0?' <span style="background:var(--red);color:white;padding:2px 6px;border-radius:4px;font-size:10px;margin-left:4px">'+a.newThisWeek+' NEW</span>':'';
          return '<div class="action-item '+a.severity+'"><span class="priority">'+a.severity.toUpperCase()+'</span><div class="action-item-content"><div class="issue">'+a.message+newBadge+'</div><div class="action" style="font-size:12px;color:var(--text3);margin-top:4px">'+a.pages.slice(0,5).join(', ')+(a.pages.length>5?' (+'+(a.pages.length-5)+' more)':'')+'</div></div></div>';
        }).join('');
      }
      
      var broken=data.brokenLinks||[];
      if(broken.length===0){
        document.getElementById('health-broken').innerHTML='<p style="color:var(--text3)">No broken links found</p>';
      }else{
        document.getElementById('health-broken').innerHTML='<table><thead><tr><th>URL</th><th>Status</th><th></th></tr></thead><tbody>'+broken.map(function(b){
          var newBadge=b.isNew?'<span style="background:var(--red);color:white;padding:2px 6px;border-radius:4px;font-size:10px">NEW</span>':'';
          return '<tr><td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">'+b.path+'</td><td class="bad">'+(b.status||'Error')+'</td><td>'+newBadge+'</td></tr>';
        }).join('')+'</tbody></table>';
      }
    }
    function statusClass(s){return s==='good'?'good':s==='too_short'||s==='too_long'?'warning':'bad'}
    function statusIcon(s){return s==='good'?'OK':s==='too_short'?'!':s==='too_long'?'~':s==='missing'?'X':s==='error'?'!':'?'}
    function showView(viewId){document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));document.getElementById('view-'+viewId).classList.add('active');document.querySelector('.nav-item[data-view="'+viewId+'"]')?.classList.add('active')}
    async function showProperty(id){showView('property');document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));document.querySelector('.nav-item[data-property="'+id+'"]')?.classList.add('active');document.querySelectorAll('#view-property .tab').forEach(t=>t.classList.remove('active'));document.querySelectorAll('#view-property .tab-content').forEach(c=>c.classList.remove('active'));document.querySelector('#view-property .tab[data-tab="overview"]').classList.add('active');document.getElementById('tab-overview').classList.add('active');currentPropertyId=id;currentDomain=PROPERTIES[id]?.domain;await fetchProperty(id)}

    async function fetchProperty(id){document.getElementById('loading').classList.add('active');try{const res=await fetch('/api/data?property='+id);propertyData[id]=await res.json();renderProperty(propertyData[id])}catch(e){console.error(e)}finally{document.getElementById('loading').classList.remove('active')}}
    function renderPortfolio(){document.getElementById('total-open').textContent='...';document.getElementById('total-fixed').textContent='...';document.getElementById('total-new').textContent='...';document.getElementById('total-high').textContent='...';const grid=document.getElementById('properties-grid');grid.innerHTML=Object.entries(PROPERTIES).map(function(e){var id=e[0],p=e[1];return '<div class="property-card" data-id="'+id+'"><div class="color-top" style="background:'+(p.color||'#666')+'"></div><div class="property-card-header"><div><h3>'+p.name+'</h3></div><span class="health-badge" id="badge-'+id+'">Loading</span></div><div class="property-metrics"><div class="mini-metric"><div class="value" id="stat-sessions-'+id+'">-</div><div class="label">Sessions</div></div><div class="mini-metric"><div class="value" id="stat-lcp-'+id+'">-</div><div class="label">LCP</div></div><div class="mini-metric"><div class="value" id="stat-cache-'+id+'">-</div><div class="label">Cache</div></div><div class="mini-metric"><div class="value" id="stat-issues-'+id+'">-</div><div class="label">Issues</div></div></div></div>'}).join('');grid.querySelectorAll('.property-card').forEach(card=>{card.addEventListener('click',()=>showProperty(card.dataset.id))});loadAllPropertyStats();loadPerformanceTrendsChart()}
    var perfTrendsChart=null;
    async function loadPerformanceTrendsChart(){try{var res=await fetch('/api/performance-history');var data=await res.json();document.getElementById('perf-trends-loading').style.display='none';if(!data.hasData||!data.history||Object.keys(data.history).length===0){document.getElementById('perf-trends-loading').style.display='block';document.getElementById('perf-trends-loading').textContent='No historical data yet. Run /api/store-performance to start collecting.';return}var datasets=[];var allDates=new Set();var colors={'viansa.com':'#722F37','kunde.com':'#2E7D32','brcohn.com':'#1565C0','clospegase.com':'#6A1B9A','girardwinery.com':'#EF6C00','adairfamilywines.com':'#00838F'};Object.entries(data.history).forEach(function(e){var domain=e[0],points=e[1];points.forEach(function(p){allDates.add(p.date)})});var sortedDates=Array.from(allDates).sort();Object.entries(data.history).forEach(function(e){var domain=e[0],points=e[1];var dataMap={};points.forEach(function(p){dataMap[p.date]=p.lcp?p.lcp/1000:null});var chartData=sortedDates.map(function(d){return dataMap[d]||null});var shortName=domain.replace('.com','').replace('www.','');datasets.push({label:shortName,data:chartData,borderColor:colors[domain]||'#666',backgroundColor:(colors[domain]||'#666')+'20',tension:0.3,fill:false,pointRadius:3,pointHoverRadius:5})});var ctx=document.getElementById('perf-trends-chart').getContext('2d');if(perfTrendsChart)perfTrendsChart.destroy();perfTrendsChart=new Chart(ctx,{type:'line',data:{labels:sortedDates.map(function(d){return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric'})}),datasets:datasets},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom',labels:{color:'#888',usePointStyle:true,padding:15}},tooltip:{backgroundColor:'#1a1a2e',titleColor:'#fff',bodyColor:'#ccc',callbacks:{label:function(ctx){return ctx.dataset.label+': '+(ctx.parsed.y?ctx.parsed.y.toFixed(2)+'s':'N/A')}}}},scales:{x:{grid:{color:'#333'},ticks:{color:'#888'}},y:{grid:{color:'#333'},ticks:{color:'#888',callback:function(v){return v+'s'}},title:{display:true,text:'LCP (seconds)',color:'#888'}}}}})}catch(e){console.error('Chart error:',e);document.getElementById('perf-trends-loading').textContent='Failed to load chart'}}
    async function loadAllPropertyStats(){var totals={open:0,fixed:0,newIssues:0,high:0};var lastAuditDate=null;var allFixedRes=fetch('/api/all-fixed-issues');for(var id in PROPERTIES){var p=PROPERTIES[id];try{var seoRes=fetch('/api/seo-stats?domain='+p.domain);var a11yRes=fetch('/api/accessibility?domain='+p.domain);var perfRes=fetch('/api/performance?property='+id+'&domain='+p.domain);var seo=await (await seoRes).json();var a11y=await (await a11yRes).json();var perf=await (await perfRes).json();if(seo?.lastAudit&&(!lastAuditDate||seo.lastAudit>lastAuditDate))lastAuditDate=seo.lastAudit;var a11yOpen=0,a11yNew=0,a11yHigh=0;if(a11y&&a11y.hasData){(a11y.issues||[]).forEach(function(i){a11yOpen+=i.pageCount||1;a11yNew+=i.newThisWeek||0;if(i.severity==='high')a11yHigh+=i.pageCount||1})}var seoHigh=0;if(seo&&seo.hasData!==false){(seo.topIssues||[]).filter(function(i){return i.severity==='high'}).forEach(function(i){seoHigh+=i.count})}var propOpen=(seo?.openIssues||0)+a11yOpen;var propNew=(seo?.newThisWeek||0)+a11yNew;var propHigh=seoHigh+a11yHigh;totals.open+=propOpen;totals.newIssues+=propNew;totals.high+=propHigh;var cf=perf?.cloudflare||{};var ga=perf?.ga4||{};var cwv=perf?.cwv||{};var sessions=ga.sessions;var lcp=cwv.LCP?(cwv.LCP/1000).toFixed(1)+'s':null;var lcpRating=cwv.lcpRating;var cache=parseFloat(cf.cacheRatio)||0;document.getElementById('stat-sessions-'+id).innerHTML=sessions?fmt(sessions):'-';document.getElementById('stat-lcp-'+id).innerHTML=lcp?'<span class="'+(lcpRating==='FAST'?'good':lcpRating==='AVERAGE'?'warning':'bad')+'">'+lcp+'</span>':'-';document.getElementById('stat-cache-'+id).innerHTML=cache?'<span class="'+(cache>=80?'good':cache>=60?'warning':'bad')+'">'+cache.toFixed(0)+'%</span>':'-';document.getElementById('stat-issues-'+id).innerHTML='<span class="'+(propOpen>20?'bad':propOpen>0?'warning':'good')+'">'+propOpen+'</span>';var status=propHigh>5?'critical':propHigh>0?'warning':'healthy';var badge=document.getElementById('badge-'+id);if(badge){badge.className='health-badge '+status;badge.textContent=propHigh>5?'Critical':propHigh>0?'Warning':'Healthy'}var dot=document.getElementById('nav-status-'+id);if(dot)dot.className='status '+status;document.getElementById('total-open').innerHTML='<span class="'+(totals.open>0?'warning':'good')+'">'+totals.open+'</span>';document.getElementById('total-new').innerHTML='<span class="'+(totals.newIssues>0?'bad':'good')+'">'+totals.newIssues+'</span>';document.getElementById('total-high').innerHTML='<span class="'+(totals.high>0?'bad':'good')+'">'+totals.high+'</span>'}catch(e){console.error('Error loading stats for '+id,e);document.getElementById('stat-sessions-'+id).textContent='-';document.getElementById('stat-lcp-'+id).textContent='-';document.getElementById('stat-cache-'+id).textContent='-';document.getElementById('stat-issues-'+id).textContent='-';var badge=document.getElementById('badge-'+id);if(badge){badge.className='health-badge';badge.textContent='Error'}}}try{var allFixed=await (await allFixedRes).json();window.allFixedIssuesData=allFixed.issues||[];totals.fixed=allFixed.totalFixed||0;var fixedCard=document.getElementById('total-fixed').parentElement;fixedCard.style.cursor='pointer';fixedCard.onclick=showAllFixedModal;document.getElementById('total-fixed').innerHTML='<span class="'+(totals.fixed>0?'good':'')+'">'+totals.fixed+'</span>'}catch(e){console.error('Error loading fixed issues',e)}if(lastAuditDate){document.getElementById('lastUpdated').textContent='Last audit: '+fmtDatePST(lastAuditDate)}}
    function renderProperty(d){if(!d||d.type!=='detail')return;const p=d.property||{};const seo=d.seoStats;document.getElementById('prop-name').textContent=p.name;document.getElementById('prop-domains').textContent=p.domain||p.shortName||'';currentDomain=p.domain;document.getElementById('overview-stats').innerHTML='<div class="metric-card" style="grid-column:1/-1"><div class="value" style="font-size:14px;color:var(--text3)">Loading...</div></div>';document.getElementById('overview-quick').innerHTML='<div class="metric-card" style="grid-column:1/-1"><div class="value" style="font-size:14px;color:var(--text3)">Loading stats...</div></div>';document.getElementById('overview-issues').innerHTML='';loadOverviewData();document.getElementById('perf-traffic').innerHTML='<p style="color:var(--text2)">Click tab to load...</p>';document.getElementById('perf-ga4').innerHTML='';document.getElementById('perf-cwv').innerHTML='';document.getElementById('perf-codes').innerHTML='';document.getElementById('perf-recommendations').innerHTML='';document.getElementById('seo-issues').innerHTML='<p style="color:var(--text2)">Click tab to load...</p>';document.getElementById('seo-broken').innerHTML='';document.getElementById('seo-keywords').innerHTML='';document.getElementById('seo-opportunities').innerHTML='';document.getElementById('a11y-issues').innerHTML='<p style="color:var(--text2)">Click tab to load...</p>';document.getElementById('a11y-recommendations').innerHTML=''}
    function formatIssueMsg(type,count){var msgs={missing_title:count+' pages missing title',short_title:count+' pages with short titles',missing_description:count+' pages missing meta description',short_description:count+' pages with short descriptions',missing_h1:count+' pages missing H1 tag',multiple_h1:count+' pages with multiple H1s',missing_schema:count+' pages without schema',schema_error:count+' pages with schema errors',missing_canonical:count+' pages missing canonical URL',canonical_mismatch:count+' pages with mismatched canonical',invalid_canonical:count+' pages with invalid canonical URL',missing_social_tags:count+' pages missing social meta tags',partial_social_tags:count+' pages with incomplete social tags',images_no_lazy:count+' pages with images missing lazy loading',images_no_dimensions:count+' pages with images missing dimensions',images_not_webp:count+' pages with non-WebP images',duplicate_title:count+' pages with duplicate titles',duplicate_description:count+' pages with duplicate descriptions',error_404:count+' 404 errors detected'};return msgs[type]||count+' '+type+' issues'}
    function renderGeoTable(geo){if(!geo||!geo.length)return'<table><tbody><tr><td>No data</td></tr></tbody></table>';return'<table><thead><tr><th>Country</th><th>Requests</th><th>TTFB</th></tr></thead><tbody>'+geo.map(g=>'<tr><td>'+g.country+'</td><td>'+fmt(g.requests)+'</td><td class="'+(g.ttfb<=200?'good':g.ttfb<=500?'warning':'bad')+'">'+g.ttfb+'ms</td></tr>').join('')+'</tbody></table>'}
    function renderActions(containerId,items,showProp=false){const el=document.getElementById(containerId);if(!items.length){el.innerHTML='<div class="all-clear"><div class="icon">OK</div><h3>All Clear</h3><p>No issues detected</p></div>';return}el.innerHTML=items.map(i=>'<div class="action-item '+((i.priority||'medium').toLowerCase())+'"><span class="priority">'+(i.priority||'MEDIUM')+'</span><div class="action-item-content">'+(showProp&&i.propertyName?'<div class="property-tag">'+i.propertyName+'</div>':'')+'<div class="issue">'+i.issue+'</div>'+(i.action?'<div class="action">'+i.action+'</div>':'')+(i.link?'<a href="'+i.link+'" target="_blank" style="display:inline-block;margin-top:8px;color:var(--blue);font-size:12px;text-decoration:underline">'+(i.linkText||'View ->')+'</a>':'')+'</div></div>').join('')}
    function fmt(n){return n==null?'-':n.toLocaleString()}
    function fmtDatePST(dateStr){var d=new Date(dateStr);return d.toLocaleDateString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',year:'numeric'})+' PST'}
    function cacheClass(v){if(!v)return'';return v>=80?'good':v>=60?'warning':'bad'}
    function lcpClass(v){if(!v)return'';return v<=2500?'good':v<=4000?'warning':'bad'}
    function fcpClass(v){if(!v)return'';return v<=1800?'good':v<=3000?'warning':'bad'}
    function cwvClass(rating){if(!rating)return'';const r=rating.toUpperCase();return r==='GOOD'||r==='FAST'?'good':r==='NEEDS_IMPROVEMENT'||r==='NEEDS IMPROVEMENT'||r==='AVERAGE'?'warning':'bad'}
    function getIssueInfo(issueType){var info={missing_title:{desc:'Pages without a title tag. Title tags are critical for SEO as they appear in search results and browser tabs.',fix:'Add a unique, descriptive title tag to each page (50-60 characters). Include your primary keyword near the beginning.'},short_title:{desc:'Title tags that are too short (under 30 characters) may not fully describe the page content.',fix:'Expand titles to 50-60 characters. Include relevant keywords and make each title unique and descriptive.'},missing_description:{desc:'Pages without a meta description. While not a direct ranking factor, descriptions appear in search results and affect click-through rates.',fix:'Add a compelling meta description (150-160 characters) that summarizes the page content and includes a call-to-action.'},short_description:{desc:'Meta descriptions that are too short may not effectively communicate page content in search results.',fix:'Expand descriptions to 150-160 characters. Make them compelling and include relevant keywords naturally.'},missing_h1:{desc:'Pages without an H1 heading. The H1 is the main heading and helps search engines understand page content.',fix:'Add one clear H1 tag per page that describes the main topic. It should be visible and near the top of the content.'},multiple_h1:{desc:'Pages with more than one H1 tag. While not strictly wrong, having multiple H1s can confuse the page hierarchy.',fix:'Use only one H1 per page for the main title. Use H2-H6 for subheadings to create a clear content hierarchy.'},missing_schema:{desc:'Pages without structured data (Schema.org markup). Structured data helps search engines understand your content and can enable rich results.',fix:'Add relevant schema markup (LocalBusiness, Product, Organization, etc.) using JSON-LD format in the page head.'},schema_error:{desc:'Pages with invalid or malformed structured data that may not be recognized by search engines.',fix:'Validate your schema using the Google Rich Results Test tool and fix any errors or warnings.'},missing_alt:{desc:'Images without alt text. Alt text is essential for accessibility (screen readers) and helps search engines understand image content.',fix:'Add descriptive alt text to every image. Describe what the image shows, keep it concise (under 125 characters).'},empty_buttons:{desc:'Buttons without accessible text. Screen reader users cannot understand what these buttons do.',fix:'Add text content inside buttons, or use aria-label attribute.'},missing_labels:{desc:'Form inputs without associated labels. This makes forms difficult or impossible to use for screen reader users.',fix:'Add label elements linked to inputs via the for attribute.'},missing_lang:{desc:'Pages without a lang attribute on the HTML element. This helps screen readers pronounce content correctly.',fix:'Add lang attribute to your HTML tag (e.g. lang=en).'},low_contrast:{desc:'Text without enough contrast against its background, making it difficult to read for users with vision impairments.',fix:'Ensure text has at least 4.5:1 contrast ratio (3:1 for large text). Use a contrast checker tool to verify.'},heading_hierarchy:{desc:'Headings that skip levels (e.g., H1 to H3). This can confuse screen reader users navigating by headings.',fix:'Use headings in order: H1, H2, H3. Do not skip levels. Use CSS for styling instead of choosing headings by size.'},missing_canonical:{desc:'Pages without a canonical URL tag. Canonical tags help prevent duplicate content issues by telling search engines which version of a page is the primary one.',fix:'Add a canonical link tag in the head: <link rel="canonical" href="https://yoursite.com/page">'},canonical_mismatch:{desc:'The canonical URL points to a different page. This could be intentional (for similar pages) or an error that confuses search engines.',fix:'Verify the canonical URL is correct. If this page should be indexed, update the canonical to point to itself.'},invalid_canonical:{desc:'The canonical URL is malformed or invalid. Search engines may ignore it or misinterpret it.',fix:'Fix the canonical URL format. It should be a complete, valid URL starting with https://.'},missing_social_tags:{desc:'Pages missing most Open Graph and Twitter Card tags. Social sharing will show generic or incorrect previews.',fix:'Add og:title, og:description, og:image, and twitter:card tags to control how your pages appear when shared.'},partial_social_tags:{desc:'Some social meta tags are missing. Social previews may be incomplete on some platforms.',fix:'Add the missing Open Graph or Twitter Card tags for complete social sharing previews.'},images_no_lazy:{desc:'Images without lazy loading. This forces all images to load immediately, slowing down initial page load.',fix:'Add loading="lazy" to images below the fold. Keep above-fold images without lazy loading.'},images_no_dimensions:{desc:'Images without explicit width and height attributes. This causes layout shift (CLS) as images load.',fix:'Add width and height attributes to images to reserve space and prevent layout shift.'},images_not_webp:{desc:'Images using older formats (JPG, PNG) instead of modern WebP. WebP provides better compression and faster loading.',fix:'Convert images to WebP format. Most CDNs and image services can do this automatically.'},duplicate_title:{desc:'Multiple pages share the same title tag. Each page should have a unique title for better SEO and user experience.',fix:'Write unique, descriptive titles for each page that reflect its specific content.'},duplicate_description:{desc:'Multiple pages share the same meta description. Unique descriptions help each page stand out in search results.',fix:'Write unique meta descriptions for each page that summarize its specific content.'},error_404:{desc:'Pages returning 404 Not Found errors. These create poor user experience and waste crawl budget.',fix:'Either restore the missing content, redirect to a relevant page, or remove links pointing to this URL.'}};return info[issueType]||{desc:'This issue may affect SEO or accessibility.',fix:'Review the affected pages and address the issue based on web best practices.'}}
    function showIssueModal(type,idx){var data=type==='seo'?window.seoIssueData:type==='a11y'?window.a11yIssueData:window.overviewIssueData;if(!data||!data[idx])return;var issue=data[idx];var issueType=issue.type||issue.issueType||'';var title=type==='seo'?issue.message:type==='overview'?issue.issue:formatA11yIssue(issue.type,issue.count);var info=getIssueInfo(issueType);document.getElementById('modal-title').textContent=title;var html='<div style="background:var(--bg2);border-radius:8px;padding:14px;margin-bottom:16px"><p style="margin:0 0 10px;color:var(--text2)"><strong>What this means:</strong> '+info.desc+'</p><p style="margin:0;color:var(--green)"><strong>How to fix:</strong> '+info.fix+'</p></div>';html+='<p style="margin:0 0 12px;color:var(--text3);font-size:13px">'+(issue.pageCount||issue.count)+' affected page(s):</p><div style="max-height:350px;overflow-y:auto">';var pages=issue.pages||[];var urls=issue.urls||[];if(pages.length>0&&typeof pages[0]==='object'){pages.forEach(function(p){var href=p.url&&p.url.startsWith('http')?p.url:'https://www.'+currentDomain+(p.path||p.url||'');var displayUrl=p.path||p.url||'';html+='<div style="margin-bottom:12px;padding:10px;background:var(--bg);border-radius:6px;border-left:3px solid var(--border)"><a href="'+href+'" target="_blank" style="color:var(--blue);font-size:13px">'+escapeHtml(displayUrl)+'</a>';if(p.snippets&&p.snippets.length>0){p.snippets.forEach(function(s){html+='<pre style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:8px;margin:8px 0 0;overflow-x:auto;font-size:11px;color:var(--red);white-space:pre-wrap;word-break:break-all">'+escapeHtml(s)+'</pre>'})}html+='</div>'})}else{urls.forEach(function(u){var displayUrl=u;var href=u.startsWith('http')?u:'https://www.'+currentDomain+u;html+='<div style="margin-bottom:8px"><a href="'+href+'" target="_blank" style="color:var(--blue);font-size:13px">'+escapeHtml(displayUrl)+'</a></div>'});if(urls.length<(issue.pageCount||issue.count)){html+='<p style="color:var(--text3);font-style:italic;font-size:12px">...and '+((issue.pageCount||issue.count)-urls.length)+' more pages</p>'}}html+='</div>';document.getElementById('modal-body').innerHTML=html;document.getElementById('issue-modal').classList.add('active')}
    function showFixedModal(){var fixed=window.fixedIssuesData||[];if(fixed.length===0)return;document.getElementById('modal-title').textContent='Fixed This Week';var html='<p style="margin:0 0 16px;color:var(--text2)">Issues that have been resolved:</p>';fixed.forEach(function(i){html+='<div style="margin-bottom:16px;padding:12px;background:var(--bg2);border-radius:8px;border-left:3px solid var(--green)"><div style="font-weight:600;color:var(--green);margin-bottom:4px">OK '+i.message+'</div><div style="font-size:12px;color:var(--text3)">'+(i.urls||[]).slice(0,3).join(', ')+(i.count>3?' (+' +(i.count-3)+' more)':'')+'</div></div>'});document.getElementById('modal-body').innerHTML=html;document.getElementById('issue-modal').classList.add('active')}
    function showAllFixedModal(){var fixed=window.allFixedIssuesData||[];if(fixed.length===0)return;document.getElementById('modal-title').textContent='All Fixed Issues ('+fixed.length+')';var html='<div style="margin-bottom:16px;display:flex;justify-content:space-between;align-items:center"><p style="margin:0;color:var(--text2)">All issues that have been resolved across all properties:</p><button onclick="exportFixedCSV()" style="padding:8px 16px;background:var(--green);color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px">Export CSV</button></div>';html+='<div style="max-height:400px;overflow-y:auto">';var byDomain={};fixed.forEach(function(i){if(!byDomain[i.domain])byDomain[i.domain]=[];byDomain[i.domain].push(i)});Object.keys(byDomain).sort().forEach(function(domain){html+='<div style="margin-bottom:16px"><h4 style="margin:0 0 8px;color:var(--text);font-size:14px;border-bottom:1px solid var(--border);padding-bottom:4px">'+domain+' ('+byDomain[domain].length+')</h4>';byDomain[domain].slice(0,10).forEach(function(i){var fixedDate=i.fixed_at?fmtDatePST(i.fixed_at):'';html+='<div style="margin-bottom:8px;padding:8px;background:var(--bg2);border-radius:6px;border-left:3px solid var(--green);font-size:13px"><div style="display:flex;justify-content:space-between"><span style="color:var(--green)">OK '+formatIssueMsg(i.issue_type,1).replace('1 ','')+'</span><span style="color:var(--text3);font-size:11px">'+fixedDate+'</span></div><div style="color:var(--text3);font-size:11px;margin-top:2px">'+escapeHtml(i.page_path||'')+'</div></div>'});if(byDomain[domain].length>10)html+='<div style="color:var(--text3);font-size:12px;padding:4px 8px">+'+(byDomain[domain].length-10)+' more...</div>';html+='</div>'});html+='</div>';document.getElementById('modal-body').innerHTML=html;document.getElementById('issue-modal').classList.add('active')}
    window.exportFixedCSV=function(){var fixed=window.allFixedIssuesData||[];if(fixed.length===0)return;var nl=String.fromCharCode(10);var dq=String.fromCharCode(34);var rows=['Domain,Issue Type,Category,Severity,Page Path,Page URL,First Seen,Fixed At'];fixed.forEach(function(i){rows.push(dq+i.domain+dq+','+dq+i.issue_type+dq+','+dq+i.category+dq+','+dq+i.severity+dq+','+dq+(i.page_path||'')+dq+','+dq+(i.page_url||'')+dq+','+dq+(i.first_seen||'')+dq+','+dq+(i.fixed_at||'')+dq)});var csv=rows.join(nl);var blob=new Blob([csv],{type:'text/csv'});var url=URL.createObjectURL(blob);var a=document.createElement('a');a.href=url;a.download='fixed-issues-'+new Date().toISOString().split('T')[0]+'.csv';a.click();URL.revokeObjectURL(url)};
    function closeModal(){document.getElementById('issue-modal').classList.remove('active')}
    function attachIssueClicks(){document.querySelectorAll('.clickable-issue[data-type]').forEach(function(el){el.addEventListener('click',function(){var idx=parseInt(el.dataset.idx);var type=el.dataset.type;showIssueModal(type,idx)})})}
    function priorityOrder(p){return{CRITICAL:0,HIGH:1,MEDIUM:2,LOW:3}[p]||3}
    function formatIndexStatus(status){const map={'Submitted and indexed':'OK Indexed','Crawled - currently not indexed':'Crawled but not indexed','Discovered - currently not indexed':'Discovered but not indexed','URL is unknown to Google':'Unknown to Google','Excluded by noindex tag':'Blocked by noindex','Blocked by robots.txt':'Blocked by robots.txt','Blocked due to unauthorized request (401)':'401 Unauthorized','Not found (404)':'404 Not Found','Blocked due to access forbidden (403)':'403 Forbidden','Blocked due to other 4xx issue':'4xx Error','Server error (5xx)':'5xx Server Error','Redirect error':'Redirect Error','Soft 404':'Soft 404','Duplicate without user-selected canonical':'Duplicate (no canonical)','Duplicate, Google chose different canonical than user':'Canonical mismatch','Page with redirect':'Redirected','Alternate page with proper canonical tag':'Alternate page'};return map[status]||status}
    function seoStatusClass(status){return status==='good'?'good':status==='too_short'||status==='too_long'?'warning':'bad'}
    function escapeHtml(str){return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
  </script>
</body>
</html>`;