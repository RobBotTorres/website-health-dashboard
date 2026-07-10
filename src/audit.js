import { getPropertyIdForDomain, getCredentials } from './config.js';
import { getUserProperties, getPropertyCredentials } from './tenant.js';
import { fetchPageSpeedInsights, fetchAndStoreSearchConsole } from './google-api.js';
import { fetchCloudflareTraffic } from './cloudflare-api.js';
import { fetchGA4Analytics } from './google-api.js';
import { getDateRangePST } from './utils.js';

// Legacy hardcoded domains used when no DB-backed properties are available
const LEGACY_DOMAINS = [
  'adairfamilywines.com',
  'brcohn.com',
  'clospegase.com',
  'girardwinery.com',
  'kunde.com',
  'viansa.com'
];

// ============================================================================
// SHARED HELPERS
// ============================================================================

// Run an array of prepared D1 statements in chunked batches
async function runInBatches(db, stmts, size = 25) {
  for (let i = 0; i < stmts.length; i += size) {
    await db.batch(stmts.slice(i, i + size));
  }
}

// Extract a <meta> tag's content, trying both attribute orders
function getMetaContent(html, attr, value) {
  const v = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.match(new RegExp(`<meta[^>]*${attr}=["']${v}["'][^>]*content=["']([^"']*)["']`, 'i'))?.[1] ||
         html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*${attr}=["']${v}["']`, 'i'))?.[1] || '';
}

// Parse the <title> tag into { value, length, status }
function parseTitle(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const length = title.length;
  let status = 'good';
  if (!title) status = 'missing';
  else if (length < 30) status = 'too_short';
  else if (length > 60) status = 'too_long';
  return { value: title.substring(0, 70), length, status };
}

// Parse the meta description into { value, length, status }
function parseDescription(html) {
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
                    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
  const description = descMatch ? descMatch[1].trim() : '';
  const length = description.length;
  let status = 'good';
  if (!description) status = 'missing';
  else if (length < 70) status = 'too_short';
  else if (length > 160) status = 'too_long';
  return { value: description.substring(0, 100), length, status };
}

// Count <h1> tags
function parseH1(html) {
  return { count: (html.match(/<h1[^>]*>/gi) || []).length };
}

// Parse all JSON-LD blocks once, returning schema presence, types, per-type
// field counts (for AI-readiness depth scoring), and parse-error count.
function parseJsonLd(html) {
  const matches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const types = [];
  const fieldCounts = {};
  let errors = 0;

  matches.forEach(match => {
    try {
      const jsonContent = match.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
      const parsed = JSON.parse(jsonContent);
      const items = parsed['@graph'] || [parsed];
      items.forEach(item => {
        if (item['@type']) {
          const itemTypes = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
          types.push(...itemTypes);
          const typeName = itemTypes[0];
          fieldCounts[typeName] = Object.keys(item).filter(k => !k.startsWith('@')).length;
        }
      });
    } catch (e) {
      errors++;
    }
  });

  return {
    found: matches.length > 0,
    types,
    uniqueTypes: [...new Set(types)],
    fieldCounts,
    errors
  };
}

// Pull all <loc> URLs from sitemap XML
function extractSitemapLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1]);
}

// Deduplicate URLs by a caller-supplied key; URLs that throw in keyFn are kept.
// Returns the unique list plus the Set of seen keys.
function dedupeUrls(urls, keyFn) {
  const seen = new Set();
  const unique = [];
  for (const url of urls) {
    let key;
    try {
      key = keyFn(url);
    } catch (e) {
      unique.push(url);
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(url);
    }
  }
  return { unique, seen };
}

// Build the performance_history upsert statement (shared by snapshot + audit flows)
function performanceHistoryStmt(env, domain, date, cwv, userId, now) {
  return env.DB.prepare(`
    INSERT INTO performance_history (domain, date, lcp_ms, fcp_ms, cls, inp_ms, ttfb_ms, recorded_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(domain, date) DO UPDATE SET
      lcp_ms = excluded.lcp_ms, fcp_ms = excluded.fcp_ms, cls = excluded.cls,
      inp_ms = excluded.inp_ms, ttfb_ms = excluded.ttfb_ms, recorded_at = excluded.recorded_at
  `).bind(domain, date, cwv.LCP || null, cwv.FCP || null, cwv.CLS || null, cwv.INP || null, cwv.TTFB || null, now, userId);
}

// Run full SEO audit for all properties (multi-tenant aware)
export async function runScheduledAudit(env) {
  // Multi-tenant: query all active properties from DB
  if (env.DB) {
    try {
      const { results: allProperties } = await env.DB.prepare(`
        SELECT p.*, u.plan, u.trial_ends_at, u.stripe_subscription_id
        FROM properties p
        JOIN users u ON p.user_id = u.id
        WHERE u.plan IN ('trial', 'pro', 'agency')
      `).all();

      if (allProperties && allProperties.length > 0) {
        // Filter out expired trials
        const today = new Date().toISOString().split('T')[0];
        const activeProperties = allProperties.filter(p => {
          if (p.plan === 'trial' && p.trial_ends_at && p.trial_ends_at < today) return false;
          return true;
        });

        console.log(`Starting scheduled SEO audit for ${activeProperties.length} properties (${allProperties.length} total, ${allProperties.length - activeProperties.length} expired)`);

        const BATCH_SIZE = 5;
        for (let i = 0; i < activeProperties.length; i += BATCH_SIZE) {
          const batch = activeProperties.slice(i, i + BATCH_SIZE);
          await Promise.allSettled(
            batch.map(async (prop) => {
              try {
                console.log(`Auditing ${prop.domain} (user: ${prop.user_id})...`);
                await runFullSitemapAudit(prop.domain, env, prop.user_id);
                console.log(`Completed ${prop.domain}`);
              } catch (error) {
                console.error(`Error auditing ${prop.domain}:`, error.message);
              }
            })
          );
        }

        console.log('Scheduled tasks complete (multi-tenant)');
        return;
      }
    } catch (e) {
      console.error('Failed to load properties from DB, falling back to legacy:', e.message);
    }
  }

  // Legacy fallback: hardcoded domains
  const domains = LEGACY_DOMAINS;

  console.log(`Starting scheduled SEO audit for ${domains.length} domains (legacy mode)`);

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

// Collect performance data for all domains (multi-tenant aware)
export async function collectPerformanceSnapshot(env) {
  if (!env.DB || !env.PAGESPEED_API_KEY) {
    console.log('Performance collection skipped - missing DB or API key');
    return;
  }

  // Multi-tenant: get all active properties from DB
  let domains = [];
  try {
    const { results: allProperties } = await env.DB.prepare(`
      SELECT p.domain, p.user_id FROM properties p
      JOIN users u ON p.user_id = u.id
      WHERE u.plan IN ('trial', 'pro', 'agency')
    `).all();

    if (allProperties && allProperties.length > 0) {
      domains = allProperties.map(p => ({ domain: p.domain, userId: p.user_id }));
    }
  } catch (e) {
    console.error('Failed to load properties from DB:', e.message);
  }

  // Legacy fallback
  if (domains.length === 0) {
    domains = LEGACY_DOMAINS.map(d => ({ domain: d, userId: null }));
  }

  const { endDate: today } = getDateRangePST(0);
  const now = new Date().toISOString();

  const PARALLEL = 3;
  for (let i = 0; i < domains.length; i += PARALLEL) {
    const batch = domains.slice(i, i + PARALLEL);
    const results = await Promise.allSettled(
      batch.map(({ domain }) => fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY).then(cwv => ({ domain, cwv })))
    );

    const stmts = [];
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status !== 'fulfilled') continue;
      const { domain, cwv } = result.value;
      if (!cwv || cwv.error) continue;
      const userId = batch[j]?.userId || null;

      stmts.push(performanceHistoryStmt(env, domain, today, cwv, userId, now));

      console.log(`Stored performance for ${domain}: LCP=${cwv.LCP}ms`);
    }

    if (stmts.length > 0) {
      try { await env.DB.batch(stmts); } catch(e) { console.error('Performance batch store error:', e.message); }
    }
  }
}

// Full sitemap audit - crawls ALL pages and stores in D1
export async function runFullSitemapAudit(domain, env, userId = null) {
  const startTime = Date.now();
  const { endDate: today } = getDateRangePST(0);

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
    let sitemapUrl = `https://${domain}/sitemap.xml`;
    // Try non-www first (most common), then www
    const robotsUrls = [
      `https://${domain}/robots.txt`,
      `https://www.${domain}/robots.txt`
    ];
    let foundRobots = false;
    let robotsTxtContent = null;
    for (const robotsUrl of robotsUrls) {
      try {
        const robotsResponse = await fetch(robotsUrl, { redirect: 'follow' });
        if (robotsResponse.ok) {
          robotsTxtContent = await robotsResponse.text();
          const sitemapMatch = robotsTxtContent.match(/sitemap:\s*(https?:\/\/[^\s]+)/i);
          if (sitemapMatch) {
            sitemapUrl = sitemapMatch[1];
          }
          foundRobots = true;
          console.log(`Found robots.txt at ${robotsUrl}, sitemap: ${sitemapUrl}`);
          break;
        }
      } catch (e) {
        // Try next URL
      }
    }
    if (!foundRobots) {
      console.log(`Could not fetch robots.txt for ${domain}, using default sitemap URL: ${sitemapUrl}`);
    }

    audit.sitemapUrl = sitemapUrl;

    const urls = await getAllSitemapUrls(sitemapUrl);

    // Deduplicate URLs by hostname + normalized path
    const { unique: uniqueUrls, seen: seenKeys } = dedupeUrls(urls, url => {
      const parsed = new URL(url);
      const normalizedPath = parsed.pathname.replace(/\/$/, '') || '/';
      return `${parsed.hostname}${normalizedPath}`;
    });

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

    // AI Readiness: domain-level checks (reuse already-fetched robots.txt)
    try {
      audit.aiReadiness = await checkAIReadiness(domain, robotsTxtContent);
      console.log(`AI readiness check complete for ${domain}: score pending storage`);
    } catch (e) {
      console.error(`AI readiness check failed for ${domain}:`, e.message);
      audit.aiReadiness = null;
    }

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
      await storeAuditInD1(env, domain, today, audit, userId);
      console.log(`SUCCESS: Stored audit for ${domain} in D1 (${audit.audited} pages)`);
    } catch (e) {
      console.error(`FAILED to store audit in D1: ${e.message}`);
      console.error(e.stack);
      audit.d1Error = e.message;
    }

    // Fetch and store Search Console data
    try {
      const legacyPropertyId = getPropertyIdForDomain(domain);
      if (legacyPropertyId) {
        // Legacy hardcoded properties
        console.log(`Fetching Search Console data for ${domain}...`);
        await fetchAndStoreSearchConsole(env, domain, legacyPropertyId, today);
      }

      // SaaS users: fetch via OAuth if connected
      if (userId) {
        const dbProp = await env.DB.prepare(
          'SELECT * FROM properties WHERE domain = ? AND user_id = ? AND google_refresh_token_encrypted IS NOT NULL AND gsc_properties IS NOT NULL'
        ).bind(domain, userId).first();
        if (dbProp) {
          const { getPropertyCredentials } = await import('./tenant.js');
          const creds = getPropertyCredentials(dbProp, env);
          if (creds.searchConsole.properties.length > 0) {
            console.log(`Fetching OAuth Search Console data for ${domain}...`);
            await fetchAndStoreSearchConsole(env, domain, dbProp.id, today, creds);
          }
        }
      }
    } catch (e) {
      console.error(`Failed Search Console for ${domain}: ${e.message}`);
    }

    // Fetch PageSpeed Insights once — reuse for history, snapshot, and Lighthouse a11y
    let psiResult = null;
    try {
      if (env.PAGESPEED_API_KEY) {
        console.log(`Fetching performance data for ${domain}...`);
        psiResult = await fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY);
        if (psiResult && !psiResult.error) {
          await performanceHistoryStmt(env, domain, today, psiResult, userId, new Date().toISOString()).run();
          console.log(`Stored performance history for ${domain}: LCP=${psiResult.LCP}ms`);
        }
      }
    } catch (e) {
      console.error(`Failed performance for ${domain}: ${e.message}`);
    }

    // Fetch and store full performance snapshot
    // Try legacy config first, then look up the DB property for SaaS users
    try {
      const legacyPropertyId = getPropertyIdForDomain(domain);
      if (legacyPropertyId) {
        console.log(`Storing performance snapshot for ${domain} (legacy)...`);
        await fetchAndStorePerformance(env, domain, legacyPropertyId, today, userId, psiResult);
      } else {
        // SaaS user — look up property from DB and store snapshot directly
        console.log(`Storing performance snapshot for ${domain} (SaaS)...`);
        const dbProperty = await env.DB.prepare(
          'SELECT id FROM properties WHERE domain = ? AND user_id = ?'
        ).bind(domain, userId).first();
        if (dbProperty) {
          await fetchAndStorePerformance(env, domain, dbProperty.id, today, userId, psiResult);
        } else if (psiResult && !psiResult.error) {
          // No specific property found, store basic CWV snapshot (reuse PSI result)
          console.log(`Storing basic CWV snapshot for ${domain}...`);
          await env.DB.prepare(`
            INSERT OR REPLACE INTO performance_snapshots (
              domain, snapshot_date, user_id,
              cwv_lcp, cwv_lcp_rating, cwv_inp, cwv_inp_rating, cwv_cls, cwv_cls_rating,
              cwv_fcp, cwv_fcp_rating, cwv_ttfb, cwv_overall, lighthouse_a11y
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            domain, today, userId,
            psiResult.LCP || null, psiResult.lcpRating || null, psiResult.INP || null, psiResult.inpRating || null,
            psiResult.CLS ?? null, psiResult.clsRating || null, psiResult.FCP || null, psiResult.fcpRating || null,
            psiResult.TTFB || null, psiResult.overallCategory || null,
            psiResult.accessibility ? JSON.stringify(psiResult.accessibility) : null
          ).run();
          console.log(`Stored basic CWV snapshot for ${domain}`);
        }
      }
    } catch (e) {
      console.error(`Failed performance snapshot for ${domain}: ${e.message}`);
    }
  } else {
    console.log('D1 not available (env.DB is undefined)');
    audit.d1Error = 'D1 not configured';
  }

  // Also cache in KV for fast reads (tenant-aware key)
  if (env.SEO_AUDITS) {
    const cacheKey = userId ? `audit:${userId}:${domain}` : `audit:${domain}`;
    await env.SEO_AUDITS.put(cacheKey, JSON.stringify(audit), {
      expirationTtl: 48 * 60 * 60
    });
  }

  return audit;
}

// Store audit results in D1 with change tracking
// ============================================================================
// AI FIX SUGGESTION GENERATOR
// ============================================================================

export function buildFixPrompt(domain, issue, pageData) {
  const url = `https://${domain}${issue.path}`;
  let details = {};
  try { details = issue.details ? JSON.parse(issue.details) : {}; } catch(e) {}

  const titleVal = pageData?.title?.value || '';
  const descVal = pageData?.description?.value || '';

  switch (issue.type) {
    case 'missing_title':
      return `Page ${url} has no <title> tag. The page content starts with: "${titleVal || 'unknown'}". Write a specific <title> tag (50-60 chars) for this page on ${domain}.`;
    case 'short_title':
      return `Page ${url} has a short title: "${details.value || ''}" (${details.length || 0} chars). Write an improved <title> tag (50-60 chars) that expands on this while keeping the meaning.`;
    case 'missing_description':
      return `Page ${url} on ${domain} has no meta description. The title is "${titleVal}". Write a specific meta description (150-160 chars) for this page.`;
    case 'short_description':
      return `Page ${url} has a short meta description: "${details.value || ''}" (${details.length || 0} chars). Write an improved meta description (150-160 chars).`;
    case 'missing_h1':
      return `Page ${url} has no H1 heading. The title is "${titleVal}". Suggest an appropriate H1 heading for this page.`;
    case 'multiple_h1':
      return `Page ${url} has ${details.count || 'multiple'} H1 headings. Explain which to keep as H1 and how to restructure the rest as H2s.`;
    case 'missing_schema':
      return `Page ${url} (title: "${titleVal}") on ${domain} has no Schema.org JSON-LD markup. Provide a specific JSON-LD snippet appropriate for this page.`;
    case 'schema_error':
      return `Page ${url} has invalid Schema.org JSON-LD that fails parsing. Provide a corrected, minimal JSON-LD WebPage snippet for this page.`;
    case 'missing_canonical':
      return `Page ${url} has no canonical tag. Provide the exact <link rel="canonical" href="..."> tag to add.`;
    case 'canonical_mismatch':
      return `Page ${url} has canonical pointing to "${details.canonical || 'different URL'}" instead of itself. Should the canonical be the page URL or is this intentional? Provide the fix.`;
    case 'invalid_canonical':
      return `Page ${url} has a malformed canonical URL. Provide the correct <link rel="canonical"> tag.`;
    case 'missing_social_tags':
      return `Page ${url} (title: "${titleVal}") is missing Open Graph/Twitter Card tags. Provide the essential og:title, og:description, og:image, and twitter:card meta tags.`;
    case 'partial_social_tags':
      return `Page ${url} has incomplete social meta tags. Missing: ${details.missing || 'some tags'}. Provide the missing tags.`;
    case 'images_no_lazy':
      return `Page ${url} has ${details.count || 'some'} images without lazy loading. Show how to add loading="lazy" to below-fold images. Example snippet: ${(details.snippets || []).slice(0,1).join('')}`;
    case 'images_no_dimensions':
      return `Page ${url} has ${details.count || 'some'} images without width/height attributes causing layout shift. Show how to add explicit dimensions.`;
    case 'images_not_webp':
      return `Page ${url} has ${details.count || 'some'} images not using WebP format. Explain how to convert or serve WebP with a <picture> element.`;
    case 'duplicate_title':
      return `Multiple pages share the title "${details.title || ''}": ${(details.duplicatePages || []).slice(0,3).join(', ')}. Suggest unique titles for each.`;
    case 'duplicate_description':
      return `Multiple pages share the same meta description: ${(details.duplicatePages || []).slice(0,3).join(', ')}. Suggest unique descriptions for each.`;
    // Accessibility issues
    case 'missing_alt':
      return `Page ${url} has images without alt text. Describe how to write good alt text and give 2 examples for a ${domain} website.`;
    case 'empty_buttons':
      return `Page ${url} has buttons with no accessible text. Snippets: ${(details.snippets || []).slice(0,2).join('; ')}. Suggest aria-label values for each.`;
    case 'empty_links':
      return `Page ${url} has links with no accessible text. Suggest adding aria-label or visible text content.`;
    case 'missing_labels':
      return `Page ${url} has form inputs without associated labels. Show how to add <label for="..."> elements.`;
    case 'missing_lang':
      return `Page ${url} is missing the lang attribute on <html>. Provide the exact fix.`;
    case 'low_contrast':
      return `Page ${url} has text with insufficient color contrast. Explain the WCAG 4.5:1 ratio requirement and suggest checking with a contrast tool.`;
    case 'heading_hierarchy':
      return `Page ${url} has headings that skip levels (e.g., H1 to H3). Explain proper heading hierarchy and how to fix it.`;
    case 'no_skip_link':
      return `Page ${url} has no skip navigation link. Provide the HTML/CSS for a skip-to-content link.`;
    // AI Readiness issues
    case 'shallow_schema':
      const topType = details.topType || 'WebPage';
      return `Page ${url} has Schema.org ${topType} markup but with very few fields (${details.fieldCounts?.[topType] || 'few'} properties). List the recommended properties for ${topType} schema that should be added to make this richer for AI systems.`;
    case 'missing_faq_schema':
      return `Page ${url} has Q&A-like content (questions in headings) but no FAQPage schema. Provide a JSON-LD FAQPage snippet template this page could use.`;
    case 'low_content_ratio':
      return `Page ${url} has a low content-to-boilerplate ratio (${Math.round((details.contentRatio || 0) * 100)}%). AI crawlers struggle to extract useful content. Suggest ways to increase meaningful content density.`;
    case 'missing_dates':
      return `Page ${url} has no publication or modification dates in meta tags or schema. AI systems prefer dated content for freshness. Provide the meta tags and JSON-LD datePublished/dateModified markup to add.`;
    case 'missing_author':
      return `Page ${url} has no author attribution in meta tags or schema. Provide the meta author tag and JSON-LD author markup to add for ${domain}.`;
    case 'client_side_rendered':
      return `Page ${url} appears to be client-side rendered (only ${details.visibleTextLength || 0} chars of visible text in the HTML source). AI crawlers cannot execute JavaScript. Suggest SSR, prerendering, or static generation approaches.`;
    default:
      return `Page ${url} on ${domain} has the issue: "${issue.type}". Provide a specific, copy-paste-ready fix.`;
  }
}

export async function generateAISuggestions(env, domain, issueMap, auditPages) {
  console.log(`generateAISuggestions: env.AI exists: ${!!env.AI}, issueMap size: ${issueMap.size}, pages: ${auditPages.length}`);
  if (!env.AI) {
    console.log('AI binding not available, skipping suggestions');
    return new Map();
  }

  // Build page data lookup for context
  const pageDataMap = new Map();
  for (const page of auditPages) {
    if (!page.error) {
      const path = page.path || '/';
      pageDataMap.set(path, page);
    }
  }

  const suggestions = new Map();
  const entries = [...issueMap.entries()];

  // Cap at 100 issues (prioritize high severity)
  const highFirst = entries.sort((a, b) => {
    const sevOrder = { high: 0, medium: 1, low: 2 };
    return (sevOrder[a[1].severity] || 2) - (sevOrder[b[1].severity] || 2);
  });
  const capped = highFirst.slice(0, 100);

  const AI_BATCH = 5;
  let generated = 0;

  for (let i = 0; i < capped.length; i += AI_BATCH) {
    const batch = capped.slice(i, i + AI_BATCH);
    const results = await Promise.allSettled(
      batch.map(async ([key, issue]) => {
        const pageData = pageDataMap.get(issue.path);
        const prompt = buildFixPrompt(domain, issue, pageData);
        try {
          const response = await env.AI.run('@cf/zai-org/glm-4.7-flash', {
            messages: [
              {
                role: 'system',
                content: 'You are a web developer and SEO expert. Give a brief, specific, actionable fix. Include actual code when helpful. Max 3 sentences. No preamble or explanation of the problem — just the fix.'
              },
              { role: 'user', content: prompt }
            ],
            max_tokens: 250
          });
          const text = response?.response?.trim();
          if (!text) console.log(`AI returned empty for ${key}:`, JSON.stringify(response).substring(0, 200));
          return { key, suggestion: text || null };
        } catch (e) {
          console.error(`AI suggestion FAILED for ${key}: ${e.message}`, e.stack?.substring(0, 200));
          return { key, suggestion: null };
        }
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value?.suggestion) {
        suggestions.set(result.value.key, result.value.suggestion);
        generated++;
      }
    }

    // Small delay between batches to be kind to the AI API
    if (i + AI_BATCH < capped.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`generateAISuggestions: Generated ${generated}/${capped.length} suggestions for ${domain}`);
  return suggestions;
}

// ============================================================================
// AI READINESS: Domain-level checks
// ============================================================================

const AI_BOTS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'CCBot'];

export async function checkAIReadiness(domain, robotsTxt = null) {
  const result = {
    llmsTxt: { exists: false, quality: 'missing', size: 0 },
    llmsFullTxt: { exists: false, size: 0 },
    aiBotRules: {},
    botsBlocked: 0,
    botsAllowed: 0,
  };

  // Check llms.txt and llms-full.txt
  const llmsChecks = await Promise.allSettled([
    fetch(`https://${domain}/llms.txt`, { redirect: 'follow' }).then(async r => {
      if (r.ok) {
        const text = await r.text();
        return { exists: true, text, size: text.length };
      }
      return { exists: false };
    }),
    fetch(`https://${domain}/llms-full.txt`, { redirect: 'follow' }).then(async r => {
      if (r.ok) {
        const text = await r.text();
        return { exists: true, size: text.length };
      }
      return { exists: false };
    }),
  ]);

  if (llmsChecks[0].status === 'fulfilled' && llmsChecks[0].value.exists) {
    const data = llmsChecks[0].value;
    result.llmsTxt.exists = true;
    result.llmsTxt.size = data.size;
    // Quality: check if it has meaningful content (URLs, sections)
    const hasUrls = /https?:\/\//.test(data.text);
    const hasStructure = data.text.includes('#') || data.text.includes('>');
    result.llmsTxt.quality = data.size > 100 && hasUrls ? 'good' : data.size > 20 ? 'partial' : 'empty';
  }
  if (llmsChecks[1].status === 'fulfilled' && llmsChecks[1].value.exists) {
    result.llmsFullTxt.exists = true;
    result.llmsFullTxt.size = llmsChecks[1].value.size;
  }

  // Parse robots.txt for AI bot rules
  if (!robotsTxt) {
    try {
      const resp = await fetch(`https://${domain}/robots.txt`, { redirect: 'follow' });
      if (resp.ok) robotsTxt = await resp.text();
    } catch (e) { /* no robots.txt */ }
  }

  if (robotsTxt) {
    // Parse user-agent blocks
    const lines = robotsTxt.split('\n').map(l => l.trim());
    let currentAgents = [];

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (/^user-agent\s*:/i.test(line)) {
        const agent = line.replace(/^user-agent\s*:\s*/i, '').trim();
        // If previous line was also user-agent, accumulate; otherwise start new block
        if (currentAgents.length === 0 || /^user-agent\s*:/i.test(lines[idx - 1] || '')) {
          currentAgents.push(agent);
        } else {
          currentAgents = [agent];
        }
      } else if (/^disallow\s*:\s*\/\s*$/i.test(line) && currentAgents.length > 0) {
        // Disallow: / — blocks the entire site for these agents
        for (const agent of currentAgents) {
          for (const bot of AI_BOTS) {
            if (agent === '*' || agent.toLowerCase() === bot.toLowerCase()) {
              if (!result.aiBotRules[bot] || agent.toLowerCase() === bot.toLowerCase()) {
                result.aiBotRules[bot] = 'blocked';
              }
            }
          }
        }
      } else if (/^allow\s*:\s*\//i.test(line) && currentAgents.length > 0) {
        for (const agent of currentAgents) {
          for (const bot of AI_BOTS) {
            if (agent.toLowerCase() === bot.toLowerCase()) {
              result.aiBotRules[bot] = 'allowed';
            }
          }
        }
      }
    }

    // Fill in bots not specifically mentioned
    for (const bot of AI_BOTS) {
      if (!result.aiBotRules[bot]) {
        // Check if there's a wildcard Disallow: /
        const hasWildcardBlock = lines.some((l, i) => {
          if (!/^disallow\s*:\s*\/\s*$/i.test(l)) return false;
          // Look back for User-agent: *
          for (let j = i - 1; j >= 0; j--) {
            if (/^user-agent\s*:\s*\*/i.test(lines[j])) return true;
            if (!/^user-agent\s*:/i.test(lines[j]) && lines[j] !== '') break;
          }
          return false;
        });
        result.aiBotRules[bot] = hasWildcardBlock ? 'blocked' : 'allowed';
      }
    }
  } else {
    // No robots.txt = all allowed
    for (const bot of AI_BOTS) {
      result.aiBotRules[bot] = 'allowed';
    }
  }

  result.botsBlocked = Object.values(result.aiBotRules).filter(v => v === 'blocked').length;
  result.botsAllowed = Object.values(result.aiBotRules).filter(v => v === 'allowed').length;

  return result;
}

// Compute composite AI readiness score (0-100)
function computeAIReadinessScore(domainChecks, pageStats) {
  let score = 0;

  // llms.txt presence (15 points)
  if (domainChecks.llmsTxt.exists) {
    score += domainChecks.llmsTxt.quality === 'good' ? 15 : domainChecks.llmsTxt.quality === 'partial' ? 8 : 3;
  }

  // AI bot accessibility (15 points)
  const botRatio = domainChecks.botsAllowed / Math.max(1, AI_BOTS.length);
  score += Math.round(botRatio * 15);

  // Schema depth (25 points)
  score += Math.round((pageStats.avgSchemaDepth / 100) * 25);

  // Content clarity (25 points) — based on avg content ratio
  score += Math.round(Math.min(1, pageStats.avgContentRatio / 0.6) * 15);
  // Date/author presence
  score += Math.round(pageStats.pctWithDates * 5);
  score += Math.round(pageStats.pctWithAuthor * 5);

  // CSR penalty (20 points — lose points for CSR pages)
  const csrPenalty = Math.round((pageStats.csrPages / Math.max(1, pageStats.totalPages)) * 20);
  score += 20 - csrPenalty;

  return Math.min(100, Math.max(0, score));
}

// ============================================================================
// STORE AUDIT IN D1
// ============================================================================

// Store AI-readiness page issues and the domain-level readiness score for one audit.
// Wrapped in its own try/catch so a failure here never blocks the main issue storage.
async function storeAIReadinessData(db, domain, auditDate, audit, userId) {
  try {
    let totalSchemaDepth = 0, totalContentRatio = 0, pagesWithDates = 0, pagesWithAuthor = 0, csrPages = 0, faqOpportunityPages = 0;
    let analyzedPages = 0;
    const airStmts = [];

    for (const page of audit.pages) {
      if (page.error || !page.aiReadiness) continue;
      analyzedPages++;
      const air = page.aiReadiness;
      const path = page.path || '/';
      const pageUrl = page.url || '';
      totalSchemaDepth += air.schemaDepthScore;
      totalContentRatio += air.contentRatio;
      if (air.hasPublishDate || air.hasModifiedDate) pagesWithDates++;
      if (air.hasAuthor) pagesWithAuthor++;
      if (air.isCSR) csrPages++;

      const issues = [];
      if (page.schema?.found && air.schemaDepthScore < 50 && air.schemaDepthScore > 0) {
        const topType = Object.entries(air.schemaFieldCounts || {}).sort((a, b) => b[1] - a[1])[0];
        issues.push({ type: 'shallow_schema', severity: 'medium', details: JSON.stringify({ schemaTypes: Object.keys(air.schemaFieldCounts), fieldCounts: air.schemaFieldCounts, topType: topType?.[0] }) });
      }
      if (air.hasFaqContent && !air.hasFaqSchema) { faqOpportunityPages++; issues.push({ type: 'missing_faq_schema', severity: 'low', details: null }); }
      if (air.contentRatio < 0.3 && air.visibleTextLength > 0) { issues.push({ type: 'low_content_ratio', severity: 'medium', details: JSON.stringify({ contentRatio: air.contentRatio, visibleTextLength: air.visibleTextLength }) }); }
      if (!air.hasPublishDate && !air.hasModifiedDate) { issues.push({ type: 'missing_dates', severity: 'low', details: null }); }
      if (!air.hasAuthor) { issues.push({ type: 'missing_author', severity: 'low', details: null }); }
      if (air.isCSR) { issues.push({ type: 'client_side_rendered', severity: 'high', details: JSON.stringify({ visibleTextLength: air.visibleTextLength }) }); }

      for (const issue of issues) {
        airStmts.push(db.prepare(`
          INSERT INTO ai_readiness_issues (domain, issue_type, severity, page_path, page_url, details, first_seen, last_seen, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(domain, issue_type, page_path) DO UPDATE SET
            severity = excluded.severity, details = excluded.details, last_seen = excluded.last_seen,
            fixed_at = CASE WHEN ai_readiness_issues.manually_fixed_at IS NOT NULL THEN ai_readiness_issues.fixed_at ELSE NULL END,
            reactivated_at = CASE WHEN ai_readiness_issues.manually_fixed_at IS NOT NULL THEN excluded.last_seen ELSE ai_readiness_issues.reactivated_at END
        `).bind(domain, issue.type, issue.severity, path, pageUrl, issue.details, auditDate, auditDate, userId));
      }
    }

    await runInBatches(db, airStmts);
    await db.prepare(`UPDATE ai_readiness_issues SET fixed_at = ? WHERE domain = ? AND fixed_at IS NULL AND manually_fixed_at IS NULL AND last_seen < ?`).bind(auditDate, domain, auditDate).run();
    await db.prepare(`UPDATE ai_readiness_issues SET reactivated_at = NULL, fixed_at = ? WHERE domain = ? AND manually_fixed_at IS NOT NULL AND reactivated_at IS NOT NULL AND last_seen < ?`).bind(auditDate, domain, auditDate).run();

    const domainChecks = audit.aiReadiness || { llmsTxt: { exists: false, quality: 'missing' }, llmsFullTxt: { exists: false }, aiBotRules: {}, botsBlocked: 0, botsAllowed: 0 };
    const pageStats = { totalPages: analyzedPages, avgSchemaDepth: analyzedPages > 0 ? totalSchemaDepth / analyzedPages : 0, avgContentRatio: analyzedPages > 0 ? totalContentRatio / analyzedPages : 0, pctWithDates: analyzedPages > 0 ? pagesWithDates / analyzedPages : 0, pctWithAuthor: analyzedPages > 0 ? pagesWithAuthor / analyzedPages : 0, csrPages };
    const aiScore = computeAIReadinessScore(domainChecks, pageStats);

    await db.prepare(`
      INSERT INTO ai_readiness (domain, audit_date, user_id, llms_txt_exists, llms_txt_quality, llms_full_txt_exists, ai_bot_rules, ai_bots_blocked, ai_bots_allowed, ai_readiness_score, schema_depth_avg, content_clarity_avg, csr_pages, faq_opportunity_pages)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain, audit_date) DO UPDATE SET llms_txt_exists=excluded.llms_txt_exists, llms_txt_quality=excluded.llms_txt_quality, llms_full_txt_exists=excluded.llms_full_txt_exists, ai_bot_rules=excluded.ai_bot_rules, ai_bots_blocked=excluded.ai_bots_blocked, ai_bots_allowed=excluded.ai_bots_allowed, ai_readiness_score=excluded.ai_readiness_score, schema_depth_avg=excluded.schema_depth_avg, content_clarity_avg=excluded.content_clarity_avg, csr_pages=excluded.csr_pages, faq_opportunity_pages=excluded.faq_opportunity_pages
    `).bind(domain, auditDate, userId, domainChecks.llmsTxt.exists ? 1 : 0, domainChecks.llmsTxt.quality, domainChecks.llmsFullTxt.exists ? 1 : 0, JSON.stringify(domainChecks.aiBotRules), domainChecks.botsBlocked, domainChecks.botsAllowed, aiScore, Math.round(pageStats.avgSchemaDepth), Math.round(pageStats.avgContentRatio * 100), csrPages, faqOpportunityPages).run();

    console.log(`storeAuditInD1: AI readiness stored (score=${aiScore}, ${airStmts.length} issues, ${analyzedPages} pages analyzed)`);
  } catch (e) {
    console.error(`storeAuditInD1: AI readiness storage error: ${e.message}`);
  }
}

// Collect all SEO issues (meta, headings, schema, canonical, social, images,
// duplicates) for an audit into a Map keyed by `${type}|${path}`.
function collectSEOIssues(audit, domain) {
  const currentIssues = new Map();

  for (const page of audit.pages) {
    if (page.error) continue;

    const rawPath = page.path || '/';
    const isSubdomain = page.hostname && page.hostname !== `www.${domain}` && page.hostname !== domain;
    const path = isSubdomain ? `${page.hostname}:${rawPath}` : rawPath;
    const url = page.url || '';

    if (page.title?.status === 'missing') {
      currentIssues.set(`missing_title|${path}`, { type: 'missing_title', severity: 'high', path, url, details: null });
    } else if (page.title?.status === 'too_short') {
      currentIssues.set(`short_title|${path}`, { type: 'short_title', severity: 'medium', path, url, details: JSON.stringify({ length: page.title.length, value: page.title.value }) });
    }

    if (page.description?.status === 'missing') {
      currentIssues.set(`missing_description|${path}`, { type: 'missing_description', severity: 'high', path, url, details: null });
    } else if (page.description?.status === 'too_short') {
      currentIssues.set(`short_description|${path}`, { type: 'short_description', severity: 'medium', path, url, details: JSON.stringify({ length: page.description.length, value: page.description.value }) });
    }

    if (page.h1?.count === 0) {
      currentIssues.set(`missing_h1|${path}`, { type: 'missing_h1', severity: 'medium', path, url, details: null });
    } else if (page.h1?.count > 1) {
      currentIssues.set(`multiple_h1|${path}`, { type: 'multiple_h1', severity: 'low', path, url, details: JSON.stringify({ count: page.h1.count }) });
    }

    if (page.schema && !page.schema.found) {
      currentIssues.set(`missing_schema|${path}`, { type: 'missing_schema', severity: 'low', path, url, details: null });
    } else if (page.schema?.errors > 0) {
      currentIssues.set(`schema_error|${path}`, { type: 'schema_error', severity: 'high', path, url, details: null });
    }

    if (page.canonical?.status === 'missing') {
      currentIssues.set(`missing_canonical|${path}`, { type: 'missing_canonical', severity: 'medium', path, url, details: null });
    } else if (page.canonical?.status === 'mismatch') {
      currentIssues.set(`canonical_mismatch|${path}`, { type: 'canonical_mismatch', severity: 'medium', path, url, details: JSON.stringify({ canonical: page.canonical.url }) });
    } else if (page.canonical?.status === 'invalid') {
      currentIssues.set(`invalid_canonical|${path}`, { type: 'invalid_canonical', severity: 'high', path, url, details: null });
    }

    if (page.socialMeta?.status === 'poor') {
      currentIssues.set(`missing_social_tags|${path}`, { type: 'missing_social_tags', severity: 'medium', path, url, details: JSON.stringify({ missing: page.socialMeta.issues }) });
    } else if (page.socialMeta?.status === 'partial') {
      currentIssues.set(`partial_social_tags|${path}`, { type: 'partial_social_tags', severity: 'low', path, url, details: JSON.stringify({ missing: page.socialMeta.issues }) });
    }

    const imgIssues = page.imageOptimization?.issues || [];
    const noLazyCount = imgIssues.filter(i => i.issues.includes('no-lazy')).length;
    const noDimsCount = imgIssues.filter(i => i.issues.includes('no-dimensions')).length;
    const notWebpCount = imgIssues.filter(i => i.issues.includes('not-webp')).length;

    if (noLazyCount > 0) {
      const snippets = imgIssues.filter(i => i.issues.includes('no-lazy')).slice(0, 3).map(i => i.snippet);
      currentIssues.set(`images_no_lazy|${path}`, { type: 'images_no_lazy', severity: 'medium', path, url, details: JSON.stringify({ count: noLazyCount, snippets }) });
    }
    if (noDimsCount > 2) {
      const snippets = imgIssues.filter(i => i.issues.includes('no-dimensions')).slice(0, 3).map(i => i.snippet);
      currentIssues.set(`images_no_dimensions|${path}`, { type: 'images_no_dimensions', severity: 'low', path, url, details: JSON.stringify({ count: noDimsCount, snippets }) });
    }
    if (notWebpCount > 2) {
      const snippets = imgIssues.filter(i => i.issues.includes('not-webp')).slice(0, 3).map(i => i.snippet);
      currentIssues.set(`images_not_webp|${path}`, { type: 'images_not_webp', severity: 'low', path, url, details: JSON.stringify({ count: notWebpCount, snippets }) });
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
    }
  }

  for (const [descVal, pages] of descMap) {
    if (pages.length > 1) {
      const firstPage = pages[0];
      currentIssues.set(`duplicate_description|${firstPage.path}`, {
        type: 'duplicate_description', severity: 'medium', path: firstPage.path, url: firstPage.url,
        details: JSON.stringify({ description: descVal.substring(0, 80), duplicatePages: pages.map(p => p.path) })
      });
    }
  }

  return currentIssues;
}

// Collect accessibility issues into parallel maps keyed by `${type}|${path}`:
// one of issue records (for AI suggestions + upsert) and one of count/snippet data.
function collectA11yIssues(audit) {
  const a11yIssueMap = new Map();
  const a11ySnippetsMap = new Map();

  for (const page of audit.pages) {
    if (page.error || !page.accessibility?.issues) continue;

    const path = page.path || '/';
    const url = page.url || '';

    for (const issue of page.accessibility.issues) {
      const key = `${issue.type}|${path}`;
      a11yIssueMap.set(key, { type: issue.type, severity: issue.severity, path, url, details: issue.snippets ? JSON.stringify({ snippets: issue.snippets }) : null });
      a11ySnippetsMap.set(key, { count: issue.count, snippetsJson: issue.snippets ? JSON.stringify(issue.snippets) : null });
    }
  }

  return { a11yIssueMap, a11ySnippetsMap };
}

export async function storeAuditInD1(env, domain, auditDate, audit, userId = null) {
  const db = env.DB;
  const BATCH_SIZE = 25;
  console.log(`storeAuditInD1: Starting for ${domain} on ${auditDate} (user: ${userId || 'legacy'})`);

  const auditResult = await db.prepare(`
    INSERT INTO audits (domain, audit_date, total_pages, pages_audited, duration_seconds, user_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(domain, audit_date) DO UPDATE SET
      total_pages = excluded.total_pages,
      pages_audited = excluded.pages_audited,
      duration_seconds = excluded.duration_seconds
  `).bind(domain, auditDate, audit.totalUrls, audit.audited, audit.duration, userId).run();
  console.log(`storeAuditInD1: Audit record inserted, changes: ${auditResult.meta?.changes}`);

  // ---- AI Readiness: store early (before AI suggestions which may timeout on HTTP triggers) ----
  await storeAIReadinessData(db, domain, auditDate, audit, userId);

  const currentIssues = collectSEOIssues(audit, domain);
  console.log(`storeAuditInD1: Found ${currentIssues.size} issues to store`);

  // Generate AI fix suggestions for all issues
  const aiSuggestions = await generateAISuggestions(env, domain, currentIssues, audit.pages);
  console.log(`storeAuditInD1: Generated ${aiSuggestions.size} AI suggestions`);

  const existingIssues = await db.prepare(`
    SELECT id, issue_type, page_path FROM issues
    WHERE domain = ? AND fixed_at IS NULL
  `).bind(domain).all();

  console.log(`storeAuditInD1: Found ${existingIssues.results?.length || 0} existing issues`);

  // If a manually-fixed issue is found again by the crawl, set reactivated_at
  // instead of clearing fixed_at — this preserves the manual completion state
  // and triggers a reactivation alert in the dashboard.
  const issueStmts = [...currentIssues.entries()].map(([key, issue]) => {
    const suggestion = aiSuggestions.get(key) || null;
    return db.prepare(`
      INSERT INTO issues (domain, issue_type, severity, page_path, page_url, details, first_seen, last_seen, user_id, ai_suggestion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain, issue_type, page_path) DO UPDATE SET
        severity = excluded.severity,
        page_url = excluded.page_url,
        details = excluded.details,
        last_seen = excluded.last_seen,
        ai_suggestion = COALESCE(excluded.ai_suggestion, issues.ai_suggestion),
        fixed_at = CASE
          WHEN issues.manually_fixed_at IS NOT NULL THEN issues.fixed_at
          ELSE NULL
        END,
        reactivated_at = CASE
          WHEN issues.manually_fixed_at IS NOT NULL THEN excluded.last_seen
          ELSE issues.reactivated_at
        END
    `).bind(domain, issue.type, issue.severity, issue.path, issue.url, issue.details, auditDate, auditDate, userId, suggestion);
  });

  await runInBatches(db, issueStmts, BATCH_SIZE);
  console.log(`storeAuditInD1: Upserted ${issueStmts.length} issues`);

  // Mark fixed issues — skip manually-fixed issues (they have their own lifecycle)
  const allUnfixed = await db.prepare(`
    SELECT id, issue_type, page_path, manually_fixed_at FROM issues
    WHERE domain = ? AND fixed_at IS NULL AND manually_fixed_at IS NULL
  `).bind(domain).all();

  const toFix = (allUnfixed.results || []).filter(existing => {
    const key = `${existing.issue_type}|${existing.page_path}`;
    return !currentIssues.has(key);
  });

  if (toFix.length > 0) {
    await runInBatches(db, toFix.map(existing => db.prepare(`UPDATE issues SET fixed_at = ? WHERE id = ?`).bind(auditDate, existing.id)), BATCH_SIZE);
  }

  // Also verify manually-fixed issues that are no longer found in crawl — mark as "verified fixed"
  const manuallyFixedUnverified = await db.prepare(`
    SELECT id, issue_type, page_path FROM issues
    WHERE domain = ? AND manually_fixed_at IS NOT NULL AND reactivated_at IS NOT NULL
  `).bind(domain).all();

  const verifiedFixes = (manuallyFixedUnverified.results || []).filter(existing => {
    const key = `${existing.issue_type}|${existing.page_path}`;
    return !currentIssues.has(key);
  });

  if (verifiedFixes.length > 0) {
    await runInBatches(db, verifiedFixes.map(existing => db.prepare(`UPDATE issues SET reactivated_at = NULL, fixed_at = ? WHERE id = ?`).bind(auditDate, existing.id)), BATCH_SIZE);
    console.log(`storeAuditInD1: Verified ${verifiedFixes.length} manually-fixed issues are now truly fixed`);
  }

  console.log(`storeAuditInD1: Marked ${toFix.length} issues as fixed`);

  // Handle broken links
  const brokenLinks = audit.brokenLinks || [];
  const brokenLinkStmts = [];
  for (const broken of brokenLinks) {
    try {
      const linkPath = new URL(broken.url).pathname;
      brokenLinkStmts.push(db.prepare(`
        INSERT INTO broken_links (domain, link_url, link_path, status_code, first_seen, last_seen, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain, link_path) DO UPDATE SET
          status_code = excluded.status_code,
          last_seen = excluded.last_seen,
          fixed_at = NULL
      `).bind(domain, broken.url, linkPath, broken.status, auditDate, auditDate, userId));
    } catch (e) {
      // skip invalid URLs
    }
  }
  await runInBatches(db, brokenLinkStmts, BATCH_SIZE);

  console.log(`storeAuditInD1: Processed ${brokenLinks.length} broken links`);

  await db.prepare(`
    UPDATE broken_links SET fixed_at = ?
    WHERE domain = ? AND fixed_at IS NULL AND last_seen < ?
  `).bind(auditDate, domain, auditDate).run();

  // Handle accessibility issues — collect into maps first for AI suggestions
  const { a11yIssueMap, a11ySnippetsMap } = collectA11yIssues(audit);

  // Generate AI suggestions for accessibility issues
  const a11yAISuggestions = await generateAISuggestions(env, domain, a11yIssueMap, audit.pages);
  console.log(`storeAuditInD1: Generated ${a11yAISuggestions.size} a11y AI suggestions`);

  const a11yStmts = [];
  for (const [key, issue] of a11yIssueMap.entries()) {
    const snippetData = a11ySnippetsMap.get(key);
    const suggestion = a11yAISuggestions.get(key) || null;
    a11yStmts.push(db.prepare(`
      INSERT INTO accessibility_issues (domain, issue_type, severity, page_path, page_url, issue_count, snippets, first_seen, last_seen, user_id, ai_suggestion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain, issue_type, page_path) DO UPDATE SET
        severity = excluded.severity,
        issue_count = excluded.issue_count,
        snippets = excluded.snippets,
        last_seen = excluded.last_seen,
        ai_suggestion = COALESCE(excluded.ai_suggestion, accessibility_issues.ai_suggestion),
        fixed_at = CASE
          WHEN accessibility_issues.manually_fixed_at IS NOT NULL THEN accessibility_issues.fixed_at
          ELSE NULL
        END,
        reactivated_at = CASE
          WHEN accessibility_issues.manually_fixed_at IS NOT NULL THEN excluded.last_seen
          ELSE accessibility_issues.reactivated_at
        END
    `).bind(domain, issue.type, issue.severity, issue.path, issue.url, snippetData.count, snippetData.snippetsJson, auditDate, auditDate, userId, suggestion));
  }

  await runInBatches(db, a11yStmts, BATCH_SIZE);
  console.log(`storeAuditInD1: Upserted ${a11yStmts.length} accessibility issues`);

  // Mark a11y issues as fixed — skip manually-fixed ones
  await db.prepare(`
    UPDATE accessibility_issues SET fixed_at = ?
    WHERE domain = ? AND fixed_at IS NULL AND manually_fixed_at IS NULL AND last_seen < ?
  `).bind(auditDate, domain, auditDate).run();

  // Verify manually-fixed a11y issues that are no longer found
  await db.prepare(`
    UPDATE accessibility_issues SET reactivated_at = NULL, fixed_at = ?
    WHERE domain = ? AND manually_fixed_at IS NOT NULL AND reactivated_at IS NOT NULL AND last_seen < ?
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

    const title = parseTitle(html);
    const description = parseDescription(html);
    const h1 = parseH1(html);
    const schema = parseJsonLd(html);
    const schemaTypes = schema.types;

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

    // Parse Social Meta Tags (Open Graph + Twitter Card)
    const ogTitle = getMetaContent(html, 'property', 'og:title');
    const ogDesc = getMetaContent(html, 'property', 'og:description');
    const ogImage = getMetaContent(html, 'property', 'og:image');
    const ogUrl = getMetaContent(html, 'property', 'og:url');

    const twitterCard = getMetaContent(html, 'name', 'twitter:card');
    const twitterTitle = getMetaContent(html, 'name', 'twitter:title');
    const twitterDesc = getMetaContent(html, 'name', 'twitter:description');
    const twitterImage = getMetaContent(html, 'name', 'twitter:image');

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

    const hiddenTypes = /type=["']?(hidden|submit|button|reset|image)["']?/i;
    const allInputs = html.match(/<input\b[^>]*>/gi) || [];
    const inputMatches = allInputs.filter(tag => !hiddenTypes.test(tag));
    const labels = (html.match(/<label[^>]*>/gi) || []).length;
    const ariaLabelledInputs = inputMatches.filter(tag => /aria-label/i.test(tag) || /aria-labelledby/i.test(tag)).length;
    const unlabelled = inputMatches.length - labels - ariaLabelledInputs;
    if (unlabelled > 0) {
      const missingLabelSnippets = inputMatches
        .filter(tag => !/aria-label/i.test(tag) && !/aria-labelledby/i.test(tag))
        .slice(0, 5)
        .map(s => s.length > 500 ? s.substring(0, 500) + '...' : s);
      a11yIssues.push({ type: 'missing_labels', count: unlabelled, severity: 'high', snippets: missingLabelSnippets });
    }

    if (!html.match(/skip[- ]?(to[- ]?)?(main|content|nav)/i)) {
      a11yIssues.push({ type: 'no_skip_link', count: 1, severity: 'low' });
    }

    const headingOrder = html.match(/<h[1-6][^>]*>/gi) || [];
    let lastLevel = 0;
    let badHierarchy = false;
    const hierarchySnippets = [];
    headingOrder.forEach(h => {
      const hMatch = h.match(/h([1-6])/i);
      if (!hMatch) return;
      const level = parseInt(hMatch[1]);
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

    // AI Readiness: Structured data depth scoring (reuse field counts parsed above)
    let schemaDepthScore = 0;
    const schemaFieldCounts = schema.fieldCounts;
    if (Object.keys(schemaFieldCounts).length > 0) {
      const counts = Object.values(schemaFieldCounts);
      const avgFields = counts.reduce((a, b) => a + b, 0) / counts.length;
      schemaDepthScore = Math.min(100, Math.round(avgFields * 10)); // 10 fields = 100
    }

    // AI Readiness: FAQ/How-To schema detection
    const headingTexts = (html.match(/<h[2-4][^>]*>[^<]*\?[^<]*<\/h[2-4]>/gi) || []);
    const dtElements = (html.match(/<dt[^>]*>/gi) || []);
    const hasFaqContent = headingTexts.length >= 2 || dtElements.length >= 2;
    const hasFaqSchema = schemaTypes.includes('FAQPage') || schemaTypes.includes('HowTo');

    // AI Readiness: Content clarity signals
    const strippedHtml = html
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').trim();
    const fullText = html.replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').trim();
    const contentRatio = fullText.length > 0 ? strippedHtml.length / fullText.length : 0;

    // Publication/modification dates
    const hasPublishDate = !!html.match(/<meta[^>]*property=["']article:published_time["']/i) ||
      !!html.match(/["']datePublished["']\s*:/i) ||
      !!html.match(/<time[^>]*datetime=["'][^"']+["']/i);
    const hasModifiedDate = !!html.match(/<meta[^>]*property=["']article:modified_time["']/i) ||
      !!html.match(/["']dateModified["']\s*:/i);

    // Author attribution
    const hasAuthor = !!html.match(/<meta[^>]*name=["']author["']/i) ||
      !!html.match(/["']author["']\s*:/i) ||
      !!html.match(/<a[^>]*rel=["']author["']/i);

    // Client-side rendering detection
    const bodyContent = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] || '';
    const visibleText = bodyContent.replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const scriptContent = (bodyContent.match(/<script[\s\S]*?<\/script>/gi) || []).join('');
    const hasRootDiv = /<div\s+id=["'](root|app|__next)["'][^>]*>\s*<\/div>/i.test(html);
    const isCSR = (visibleText.length < 200 && scriptContent.length > 5000) || hasRootDiv;

    const aiReadiness = {
      schemaDepthScore,
      schemaFieldCounts,
      hasFaqContent,
      hasFaqSchema,
      contentRatio: Math.round(contentRatio * 100) / 100,
      hasPublishDate,
      hasModifiedDate,
      hasAuthor,
      isCSR,
      visibleTextLength: visibleText.length,
    };

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
      title,
      description,
      h1,
      schema: { found: schema.found, types: schema.uniqueTypes, errors: schema.errors },
      canonical: { url: canonical, status: canonicalStatus },
      socialMeta: { ...socialMeta, status: socialStatus, issues: socialIssues },
      imageOptimization: { issues: imageIssues, totalImages: imgMatches.length },
      accessibility: { issues: a11yIssues },
      aiReadiness,
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

    const schema = parseJsonLd(html);

    return {
      url,
      path,
      status: response.status,
      title: parseTitle(html),
      description: parseDescription(html),
      h1: parseH1(html),
      schema: { found: schema.found, types: schema.uniqueTypes, errors: schema.errors }
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
    const nonWww = domain.replace('www.', '');
    const fallbacks = [
      `https://${nonWww}/sitemap.xml`,
      `https://www.${nonWww}/sitemap.xml`,
      `https://${nonWww}/sitemap_index.xml`,
      `https://www.${nonWww}/sitemap_index.xml`
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
    const childSitemaps = extractSitemapLocs(xml);

    console.log(`Found sitemap index with ${childSitemaps.length} child sitemaps`);

    for (const childUrl of childSitemaps) {
      try {
        const childXml = await fetchSitemapXml(childUrl);
        if (childXml) {
          urls.push(...extractSitemapLocs(childXml));
        }
      } catch (e) {
        console.error(`Error fetching child sitemap ${childUrl}:`, e);
      }
    }
  } else {
    urls.push(...extractSitemapLocs(xml));
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
      const childSitemaps = extractSitemapLocs(xml).slice(0, 3);

      for (const childUrl of childSitemaps) {
        try {
          const childResponse = await fetch(childUrl);
          if (childResponse.ok) {
            const childXml = await childResponse.text();
            urls.push(...extractSitemapLocs(childXml));
          }
        } catch (e) {
          console.error(`Error fetching child sitemap ${childUrl}:`, e);
        }
      }
    } else {
      urls = extractSitemapLocs(xml);
    }

    // Deduplicate URLs by normalized path
    const { unique: uniqueUrls } = dedupeUrls(urls, url => new URL(url).pathname.replace(/\/$/, '') || '/');

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
export async function fetchAndStorePerformance(env, domain, propertyId, dataDate, userId = null, existingPsiResult = null) {
  if (!env.DB) return;

  try {
    // Try DB-based credentials first for multi-tenant, fall back to config.js
    let creds;
    if (env.DB && userId) {
      try {
        const property = await env.DB.prepare(
          'SELECT * FROM properties WHERE id = ? AND user_id = ?'
        ).bind(propertyId, userId).first();
        if (property) {
          creds = getPropertyCredentials(property, env);
        }
      } catch (e) {
        // Fall through to legacy
      }
    }
    if (!creds) {
      creds = getCredentials(propertyId, env);
    }

    // Reuse existing PSI result if provided, otherwise fetch fresh
    const [cloudflare, cwv, ga4] = await Promise.all([
      fetchCloudflareTraffic(creds.cloudflare, env).catch(e => ({ error: e.message })),
      existingPsiResult
        ? Promise.resolve(existingPsiResult)
        : fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY).catch(e => ({ error: e.message })),
      fetchGA4Analytics(creds.ga4).catch(e => ({ error: e.message }))
    ]);

    const rs = cloudflare.responseStatus || {};

    await env.DB.prepare(`
      INSERT OR REPLACE INTO performance_snapshots (
        domain, snapshot_date, user_id,
        cf_requests, cf_requests_change, cf_bandwidth, cf_cache_ratio, cf_error_rate, cf_threats,
        cf_2xx, cf_3xx, cf_4xx, cf_5xx,
        cwv_lcp, cwv_lcp_rating, cwv_inp, cwv_inp_rating, cwv_cls, cwv_cls_rating,
        cwv_fcp, cwv_fcp_rating, cwv_ttfb, cwv_overall,
        ga4_sessions, ga4_sessions_change, ga4_users, ga4_users_change,
        ga4_bounce_rate, ga4_avg_duration, ga4_engagement_rate, ga4_page_views, ga4_top_pages,
        lighthouse_a11y
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      domain, dataDate, userId,
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
      ga4.topPages ? JSON.stringify(ga4.topPages) : null,
      cwv.accessibility ? JSON.stringify(cwv.accessibility) : null
    ).run();

    console.log(`Stored performance snapshot for ${domain}`);
  } catch (e) {
    console.error(`Failed to store performance data: ${e.message}`);
  }
}
