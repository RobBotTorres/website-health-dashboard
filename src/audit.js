import { getPropertyIdForDomain, getCredentials } from './config.js';
import { fetchPageSpeedInsights, fetchAndStoreSearchConsole } from './google-api.js';
import { fetchCloudflareTraffic } from './cloudflare-api.js';
import { fetchGA4Analytics } from './google-api.js';

// Run full SEO audit for all properties
export async function runScheduledAudit(env) {
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
export async function collectPerformanceSnapshot(env) {
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
  const now = new Date().toISOString();

  const PARALLEL = 3;
  for (let i = 0; i < domains.length; i += PARALLEL) {
    const batch = domains.slice(i, i + PARALLEL);
    const results = await Promise.allSettled(
      batch.map(domain => fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY).then(cwv => ({ domain, cwv })))
    );

    const stmts = [];
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { domain, cwv } = result.value;
      if (!cwv || cwv.error) continue;

      stmts.push(env.DB.prepare(`
        INSERT INTO performance_history (domain, date, lcp_ms, fcp_ms, cls, inp_ms, ttfb_ms, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain, date) DO UPDATE SET
          lcp_ms = excluded.lcp_ms, fcp_ms = excluded.fcp_ms, cls = excluded.cls,
          inp_ms = excluded.inp_ms, ttfb_ms = excluded.ttfb_ms, recorded_at = excluded.recorded_at
      `).bind(domain, today, cwv.LCP || null, cwv.FCP || null, cwv.CLS || null, cwv.INP || null, cwv.TTFB || null, now));

      console.log(`Stored performance for ${domain}: LCP=${cwv.LCP}ms`);
    }

    if (stmts.length > 0) {
      try { await env.DB.batch(stmts); } catch(e) { console.error('Performance batch store error:', e.message); }
    }
  }
}

// Full sitemap audit - crawls ALL pages and stores in D1
export async function runFullSitemapAudit(domain, env) {
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
      missingTitle: 0, shortTitle: 0, longTitle: 0,
      missingDescription: 0, shortDescription: 0, longDescription: 0,
      missingH1: 0, multipleH1: 0,
      missingSchema: 0, schemaErrors: 0,
      httpErrors: 0, brokenLinks: 0
    },
    issues: []
  };

  try {
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

    const urls = await getAllSitemapUrls(sitemapUrl);

    // Deduplicate URLs
    const seenKeys = new Set();
    const uniqueUrls = [];
    for (const url of urls) {
      try {
        const parsed = new URL(url);
        const normalizedPath = parsed.pathname.replace(/\/$/, '') || '/';
        const key = `${parsed.hostname}${normalizedPath}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          uniqueUrls.push(url);
        }
      } catch (e) {
        uniqueUrls.push(url);
      }
    }

    audit.totalUrls = uniqueUrls.length;
    console.log(`Found ${uniqueUrls.length} unique URLs in sitemap for ${domain} (from ${urls.length} total, ${urls.length - uniqueUrls.length} duplicates)`);

    const allInternalLinks = new Set();

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
    const sitemapKeys = new Set(seenKeys);
    const linksToCheck = [...allInternalLinks].filter(link => {
      try {
        const parsed = new URL(link);
        const path = parsed.pathname.replace(/\/$/, '') || '/';
        const key = `${parsed.hostname}${path}`;
        return !sitemapKeys.has(key);
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
    try {
      console.log(`Storing audit in D1 for ${domain}...`);
      await storeAuditInD1(env.DB, domain, today, audit);
      console.log(`SUCCESS: Stored audit for ${domain} in D1 (${audit.audited} pages)`);
    } catch (e) {
      console.error(`FAILED to store audit in D1: ${e.message}`);
      console.error(e.stack);
      audit.d1Error = e.message;
    }

    // Fetch and store Search Console data
    try {
      const propertyId = getPropertyIdForDomain(domain);
      if (propertyId) {
        console.log(`Fetching Search Console data for ${domain}...`);
        await fetchAndStoreSearchConsole(env, domain, propertyId, today);
      }
    } catch (e) {
      console.error(`Failed Search Console for ${domain}: ${e.message}`);
    }

    // Fetch and store performance history data
    try {
      if (env.PAGESPEED_API_KEY) {
        console.log(`Fetching performance data for ${domain}...`);
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
          console.log(`Stored performance history for ${domain}: LCP=${cwv.LCP}ms`);
        }
      }
    } catch (e) {
      console.error(`Failed performance for ${domain}: ${e.message}`);
    }

    // Fetch and store full performance snapshot
    try {
      const propertyId = getPropertyIdForDomain(domain);
      if (propertyId) {
        console.log(`Storing performance snapshot for ${domain}...`);
        await fetchAndStorePerformance(env, domain, propertyId, today);
      }
    } catch (e) {
      console.error(`Failed performance snapshot for ${domain}: ${e.message}`);
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
export async function storeAuditInD1(db, domain, auditDate, audit) {
  console.log(`storeAuditInD1: Starting for ${domain} on ${auditDate}`);

  const auditResult = await db.prepare(`
    INSERT INTO audits (domain, audit_date, total_pages, pages_audited, duration_seconds)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(domain, audit_date) DO UPDATE SET
      total_pages = excluded.total_pages,
      pages_audited = excluded.pages_audited,
      duration_seconds = excluded.duration_seconds
  `).bind(domain, auditDate, audit.totalUrls, audit.audited, audit.duration).run();
  console.log(`storeAuditInD1: Audit record inserted, changes: ${auditResult.meta?.changes}`);

  const currentIssues = new Map();
  let issueCount = 0;

  for (const page of audit.pages) {
    if (page.error) continue;

    const rawPath = page.path || '/';
    const isSubdomain = page.hostname && page.hostname !== `www.${domain}` && page.hostname !== domain;
    const path = isSubdomain ? `${page.hostname}:${rawPath}` : rawPath;
    const url = page.url || '';

    if (page.title?.status === 'missing') {
      currentIssues.set(`missing_title|${path}`, { type: 'missing_title', severity: 'high', path, url, details: null });
      issueCount++;
    } else if (page.title?.status === 'too_short') {
      currentIssues.set(`short_title|${path}`, { type: 'short_title', severity: 'medium', path, url, details: JSON.stringify({ length: page.title.length }) });
      issueCount++;
    }

    if (page.description?.status === 'missing') {
      currentIssues.set(`missing_description|${path}`, { type: 'missing_description', severity: 'high', path, url, details: null });
      issueCount++;
    } else if (page.description?.status === 'too_short') {
      currentIssues.set(`short_description|${path}`, { type: 'short_description', severity: 'medium', path, url, details: JSON.stringify({ length: page.description.length }) });
      issueCount++;
    }

    if (page.h1?.count === 0) {
      currentIssues.set(`missing_h1|${path}`, { type: 'missing_h1', severity: 'medium', path, url, details: null });
      issueCount++;
    } else if (page.h1?.count > 1) {
      currentIssues.set(`multiple_h1|${path}`, { type: 'multiple_h1', severity: 'low', path, url, details: JSON.stringify({ count: page.h1.count }) });
      issueCount++;
    }

    if (page.schema && !page.schema.found) {
      currentIssues.set(`missing_schema|${path}`, { type: 'missing_schema', severity: 'low', path, url, details: null });
      issueCount++;
    } else if (page.schema?.errors > 0) {
      currentIssues.set(`schema_error|${path}`, { type: 'schema_error', severity: 'high', path, url, details: null });
      issueCount++;
    }

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

    if (page.socialMeta?.status === 'poor') {
      currentIssues.set(`missing_social_tags|${path}`, { type: 'missing_social_tags', severity: 'medium', path, url, details: JSON.stringify({ missing: page.socialMeta.issues }) });
      issueCount++;
    } else if (page.socialMeta?.status === 'partial') {
      currentIssues.set(`partial_social_tags|${path}`, { type: 'partial_social_tags', severity: 'low', path, url, details: JSON.stringify({ missing: page.socialMeta.issues }) });
      issueCount++;
    }

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

  // Duplicate titles/descriptions
  const titleMap = new Map();
  const descMap = new Map();

  for (const page of audit.pages) {
    if (page.error || !page.title?.value || !page.description?.value) continue;
    const path = page.path || '/';
    const url = page.url || '';

    if (page.title.value && page.title.value.length > 10) {
      const titleKey = page.title.value.toLowerCase().trim();
      if (!titleMap.has(titleKey)) titleMap.set(titleKey, []);
      titleMap.get(titleKey).push({ path, url });
    }

    if (page.description.value && page.description.value.length > 20) {
      const descKey = page.description.value.toLowerCase().trim();
      if (!descMap.has(descKey)) descMap.set(descKey, []);
      descMap.get(descKey).push({ path, url });
    }
  }

  for (const [titleVal, pages] of titleMap) {
    if (pages.length > 1) {
      const firstPage = pages[0];
      currentIssues.set(`duplicate_title|${firstPage.path}`, {
        type: 'duplicate_title', severity: 'medium', path: firstPage.path, url: firstPage.url,
        details: JSON.stringify({ title: titleVal.substring(0, 60), duplicatePages: pages.map(p => p.path) })
      });
      issueCount++;
    }
  }

  for (const [descVal, pages] of descMap) {
    if (pages.length > 1) {
      const firstPage = pages[0];
      currentIssues.set(`duplicate_description|${firstPage.path}`, {
        type: 'duplicate_description', severity: 'medium', path: firstPage.path, url: firstPage.url,
        details: JSON.stringify({ description: descVal.substring(0, 80), duplicatePages: pages.map(p => p.path) })
      });
      issueCount++;
    }
  }

  console.log(`storeAuditInD1: Found ${issueCount} issues to store`);

  const existingIssues = await db.prepare(`
    SELECT id, issue_type, page_path FROM issues
    WHERE domain = ? AND fixed_at IS NULL
  `).bind(domain).all();

  console.log(`storeAuditInD1: Found ${existingIssues.results?.length || 0} existing issues`);

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

  // Mark fixed issues
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

  // Handle broken links
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

  await db.prepare(`
    UPDATE broken_links SET fixed_at = ?
    WHERE domain = ? AND fixed_at IS NULL AND last_seen < ?
  `).bind(auditDate, domain, auditDate).run();

  // Handle accessibility issues
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

  await db.prepare(`
    UPDATE accessibility_issues SET fixed_at = ?
    WHERE domain = ? AND fixed_at IS NULL AND last_seen < ?
  `).bind(auditDate, domain, auditDate).run();

  console.log(`storeAuditInD1: Complete for ${domain}`);
}

// Audit a single page and extract internal links + accessibility
export async function auditSinglePageWithLinks(url, domain) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'WineHealthDashboard/1.0' }
    });

    if (!response.ok) {
      return {
        url,
        path: new URL(url).pathname,
        hostname: new URL(url).hostname,
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

      const hasLazyLoading = img.includes('loading="lazy"') || img.includes("loading='lazy'") ||
                             img.includes('data-src') || img.includes('lazyload');
      const hasWidth = img.includes('width=') || img.includes('width:');
      const hasHeight = img.includes('height=') || img.includes('height:');
      const isModernFormat = src.includes('.webp') || src.includes('.avif');

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

    let missingAltSnippets = [];
    imgMatches.forEach(img => {
      if (!img.includes('alt=') || img.match(/alt=["']\s*["']/)) {
        const snippet = img.length > 500 ? img.substring(0, 500) + '...' : img;
        if (missingAltSnippets.length < 5) missingAltSnippets.push(snippet);
      }
    });
    if (missingAltSnippets.length > 0) {
      a11yIssues.push({ type: 'missing_alt', count: missingAltSnippets.length, severity: 'high', snippets: missingAltSnippets });
    }

    if (!html.match(/<html[^>]*lang=["'][^"']+["']/i)) {
      const htmlTag = html.match(/<html[^>]*>/i);
      const langSnippets = htmlTag ? [htmlTag[0].length > 500 ? htmlTag[0].substring(0, 500) + '...' : htmlTag[0]] : ['<html> (no lang attribute)'];
      a11yIssues.push({ type: 'missing_lang', count: 1, severity: 'high', snippets: langSnippets });
    }

    const emptyLinkRegex = /<a([^>]*)>(\s*)<\/a>/gi;
    const emptyLinkMatches = [];
    let linkMatch;
    while ((linkMatch = emptyLinkRegex.exec(html)) !== null) {
      const attrs = linkMatch[1] || '';
      if (!/aria-label/i.test(attrs) && !/title\s*=/i.test(attrs)) {
        emptyLinkMatches.push(linkMatch[0]);
      }
    }
    const emptyLinkSnippets = emptyLinkMatches.slice(0, 5).map(l => l.length > 500 ? l.substring(0, 500) + '...' : l);
    if (emptyLinkMatches.length > 0) {
      a11yIssues.push({ type: 'empty_links', count: emptyLinkMatches.length, severity: 'medium', snippets: emptyLinkSnippets });
    }

    const inputMatches = html.match(/<input[^>]*type=["'](text|email|password|tel|number|search)["'][^>]*>/gi) || [];
    const labels = (html.match(/<label[^>]*>/gi) || []).length;
    if (inputMatches.length > labels) {
      const missingLabelSnippets = inputMatches.slice(0, 5).map(s => s.length > 500 ? s.substring(0, 500) + '...' : s);
      a11yIssues.push({ type: 'missing_labels', count: inputMatches.length - labels, severity: 'high', snippets: missingLabelSnippets });
    }

    if (!html.match(/skip[- ]?(to[- ]?)?(main|content|nav)/i)) {
      a11yIssues.push({ type: 'no_skip_link', count: 1, severity: 'low' });
    }

    const headingOrder = html.match(/<h[1-6][^>]*>/gi) || [];
    let lastLevel = 0;
    let badHierarchy = false;
    const hierarchySnippets = [];
    headingOrder.forEach(h => {
      const level = parseInt(h.match(/h([1-6])/i)[1]);
      if (level > lastLevel + 1 && lastLevel > 0) {
        badHierarchy = true;
        if (hierarchySnippets.length < 5) {
          hierarchySnippets.push('h' + lastLevel + ' → h' + level + ' (skipped h' + (lastLevel + 1) + ')');
        }
      }
      lastLevel = level;
    });
    if (badHierarchy) {
      a11yIssues.push({ type: 'heading_hierarchy', count: 1, severity: 'medium', snippets: hierarchySnippets });
    }

    const emptyBtnRegex = /<button([^>]*)>(\s*)<\/button>/gi;
    const emptyButtonMatches = [];
    let btnMatch;
    while ((btnMatch = emptyBtnRegex.exec(html)) !== null) {
      const attrs = btnMatch[1] || '';
      if (!/aria-label/i.test(attrs) && !/title\s*=/i.test(attrs)) {
        emptyButtonMatches.push(btnMatch[0]);
      }
    }
    const emptyButtonSnippets = emptyButtonMatches.slice(0, 5).map(b => b.length > 500 ? b.substring(0, 500) + '...' : b);
    if (emptyButtonMatches.length > 0) {
      a11yIssues.push({ type: 'empty_buttons', count: emptyButtonMatches.length, severity: 'high', snippets: emptyButtonSnippets });
    }

    // Extract internal links
    const internalLinks = [];
    const pageHost = new URL(url).origin;
    const linkMatches = html.matchAll(/<a[^>]*href=["']([^"'#]+)["'][^>]*>/gi);
    for (const match of linkMatches) {
      const href = match[1];
      try {
        let fullUrl;
        if (href.startsWith('http')) {
          fullUrl = href;
        } else if (href.startsWith('/')) {
          fullUrl = `${pageHost}${href}`;
        } else {
          continue;
        }

        const linkUrl = new URL(fullUrl);
        if (linkUrl.hostname === domain || linkUrl.hostname.endsWith(`.${domain}`)) {
          internalLinks.push(fullUrl);
        }
      } catch (e) {
        // Invalid URL, skip
      }
    }

    return {
      url,
      path,
      hostname: new URL(url).hostname,
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
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch (_) {}
    return {
      url,
      path: '',
      hostname,
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

// Simple single page audit (no links/a11y)
export async function auditSinglePage(url) {
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

    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const titleLen = title.length;
    let titleStatus = 'good';
    if (!title) titleStatus = 'missing';
    else if (titleLen < 30) titleStatus = 'too_short';
    else if (titleLen > 60) titleStatus = 'too_long';

    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
                      html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
    const description = descMatch ? descMatch[1].trim() : '';
    const descLen = description.length;
    let descStatus = 'good';
    if (!description) descStatus = 'missing';
    else if (descLen < 70) descStatus = 'too_short';
    else if (descLen > 160) descStatus = 'too_long';

    const h1Matches = html.match(/<h1[^>]*>/gi) || [];
    const h1Count = h1Matches.length;

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

export async function checkBrokenLinks(urls) {
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

export async function getAllSitemapUrls(sitemapUrl) {
  const urls = [];

  let xml = await fetchSitemapXml(sitemapUrl);

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
    const urlMatches = xml.matchAll(/<loc>([^<]+)<\/loc>/gi);
    urls.push(...[...urlMatches].map(m => m[1]));
  }

  console.log(`Found ${urls.length} URLs in sitemap`);
  return urls;
}

export async function fetchSitemapXml(url) {
  try {
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

export async function auditSitemapPages(sitemapUrl, maxPages = 25) {
  const audit = {
    sitemapUrl,
    totalUrls: 0,
    audited: 0,
    pages: [],
    summary: {
      missingTitle: 0, shortTitle: 0, longTitle: 0,
      missingDescription: 0, shortDescription: 0, longDescription: 0,
      missingH1: 0, multipleH1: 0,
      missingSchema: 0, schemaErrors: 0
    },
    issues: []
  };

  try {
    const response = await fetch(sitemapUrl);
    if (!response.ok) {
      audit.error = `Could not fetch sitemap: ${response.status}`;
      return audit;
    }

    const xml = await response.text();

    let urls = [];

    if (xml.includes('<sitemapindex')) {
      const sitemapMatches = xml.matchAll(/<loc>([^<]+)<\/loc>/gi);
      const childSitemaps = [...sitemapMatches].map(m => m[1]).slice(0, 3);

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

    uniqueUrls.sort((a, b) => {
      const aPath = new URL(a).pathname;
      const bPath = new URL(b).pathname;
      if (aPath === '/' || aPath === '') return -1;
      if (bPath === '/' || bPath === '') return 1;
      return aPath.split('/').length - bPath.split('/').length;
    });

    const urlsToAudit = uniqueUrls.slice(0, maxPages);

    for (let i = 0; i < urlsToAudit.length; i += 5) {
      const batch = urlsToAudit.slice(i, i + 5);
      const results = await Promise.all(batch.map(url => auditSinglePage(url)));

      results.forEach(result => {
        if (result) {
          audit.pages.push(result);
          audit.audited++;

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

    audit.issues = generateSEOIssues(audit);

  } catch (e) {
    audit.error = e.message;
  }

  return audit;
}

export function generateSEOIssues(audit) {
  const issues = [];

  const missingTitles = audit.pages.filter(p => p.title.status === 'missing');
  const shortTitles = audit.pages.filter(p => p.title.status === 'too_short');
  const missingDescs = audit.pages.filter(p => p.description.status === 'missing');
  const shortDescs = audit.pages.filter(p => p.description.status === 'too_short');
  const missingH1s = audit.pages.filter(p => p.h1.count === 0);
  const multipleH1s = audit.pages.filter(p => p.h1.count > 1);
  const missingSchema = audit.pages.filter(p => !p.schema.found);
  const schemaErrors = audit.pages.filter(p => p.schema.errors > 0);

  if (missingTitles.length > 0) {
    issues.push({ type: 'missing_title', severity: 'high', count: missingTitles.length, message: `${missingTitles.length} page(s) missing title tag`, pages: missingTitles.map(p => p.path) });
  }
  if (missingDescs.length > 0) {
    issues.push({ type: 'missing_description', severity: 'high', count: missingDescs.length, message: `${missingDescs.length} page(s) missing meta description`, pages: missingDescs.map(p => p.path) });
  }
  if (shortTitles.length > 0) {
    issues.push({ type: 'short_title', severity: 'medium', count: shortTitles.length, message: `${shortTitles.length} page(s) with short titles (<30 chars)`, pages: shortTitles.map(p => p.path) });
  }
  if (shortDescs.length > 0) {
    issues.push({ type: 'short_description', severity: 'medium', count: shortDescs.length, message: `${shortDescs.length} page(s) with short descriptions (<70 chars)`, pages: shortDescs.map(p => p.path) });
  }
  if (missingH1s.length > 0) {
    issues.push({ type: 'missing_h1', severity: 'medium', count: missingH1s.length, message: `${missingH1s.length} page(s) missing H1 tag`, pages: missingH1s.map(p => p.path) });
  }
  if (multipleH1s.length > 0) {
    issues.push({ type: 'multiple_h1', severity: 'low', count: multipleH1s.length, message: `${multipleH1s.length} page(s) with multiple H1 tags`, pages: multipleH1s.map(p => p.path) });
  }
  if (missingSchema.length > 0) {
    issues.push({ type: 'missing_schema', severity: 'low', count: missingSchema.length, message: `${missingSchema.length} page(s) without structured data`, pages: missingSchema.map(p => p.path) });
  }
  if (schemaErrors.length > 0) {
    issues.push({ type: 'schema_error', severity: 'high', count: schemaErrors.length, message: `${schemaErrors.length} page(s) with invalid JSON-LD`, pages: schemaErrors.map(p => p.path) });
  }

  if (audit.brokenLinks && audit.brokenLinks.length > 0) {
    issues.push({
      type: 'broken_links', severity: 'high', count: audit.brokenLinks.length,
      message: `${audit.brokenLinks.length} broken internal link(s) found`,
      pages: audit.brokenLinks.map(b => `${new URL(b.url).pathname} (${b.status})`)
    });
  }

  return issues.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.severity] - order[b.severity];
  });
}

export async function checkRobotsTxt(domain) {
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

// Quick fallback audit when KV cache is empty
export async function fetchSiteHealth(domain) {
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

  return await auditSitemapPages(sitemapUrl, 15);
}

// Fetch and store performance data in D1
export async function fetchAndStorePerformance(env, domain, propertyId, dataDate) {
  if (!env.DB) return;

  try {
    const creds = getCredentials(propertyId, env);

    const [cloudflare, cwv, ga4] = await Promise.all([
      fetchCloudflareTraffic(creds.cloudflare, env).catch(e => ({ error: e.message })),
      fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY).catch(e => ({ error: e.message })),
      fetchGA4Analytics(creds.ga4).catch(e => ({ error: e.message }))
    ]);

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
      rs.success || 0, rs.redirect || 0, rs.clientError || 0, rs.serverError || 0,
      cwv.LCP || null, cwv.lcpRating || null, cwv.INP || null, cwv.inpRating || null,
      cwv.CLS ?? null, cwv.clsRating || null, cwv.FCP || null, cwv.fcpRating || null,
      cwv.TTFB || null, cwv.overallCategory || null,
      ga4.sessions || null, parseFloat(ga4.sessionsChange) || null,
      ga4.newUsers || null, parseFloat(ga4.newUsersChange) || null,
      parseFloat(ga4.bounceRate) || null, ga4.avgDuration || null,
      parseFloat(ga4.engagementRate) || null, ga4.pageViews || null,
      ga4.topPages ? JSON.stringify(ga4.topPages) : null
    ).run();

    console.log(`Stored performance snapshot for ${domain}`);
  } catch (e) {
    console.error(`Failed to store performance data: ${e.message}`);
  }
}
