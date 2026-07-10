// ============================================================================
// QUICK AUDIT
// Runs a fast homepage-only audit when a user adds a new website.
// Checks SEO, accessibility, and Core Web Vitals in parallel (~3-5 seconds).
// Results are stored in D1 and cached in KV for immediate dashboard display.
// ============================================================================

import { auditSinglePageWithLinks, storeAuditInD1, checkAIReadiness } from './audit.js';
import { fetchPageSpeedInsights } from './google-api.js';

/**
 * Run a quick audit on the homepage of a domain.
 * Returns results immediately for the frontend to display.
 *
 * @param {string} domain - e.g. "example.com"
 * @param {string} propertyId - property UUID
 * @param {string} userId - user UUID
 * @param {object} env - Worker environment
 * @returns {Promise<object>} Quick audit results
 */
export async function runQuickAudit(domain, propertyId, userId, env) {
  const startTime = Date.now();

  // Try both www and non-www
  const homepageUrl = `https://www.${domain}/`;
  const altUrl = `https://${domain}/`;

  // Run homepage audit + PageSpeed + AI readiness in parallel
  const [pageResult, pageSpeedResult, aiReadinessResult] = await Promise.allSettled([
    auditHomepage(homepageUrl, altUrl, domain),
    fetchPageSpeedInsights(domain, env.PAGESPEED_API_KEY).catch(e => ({ error: e.message })),
    checkAIReadiness(domain).catch(e => ({ error: e.message }))
  ]);

  const pageAudit = pageResult.status === 'fulfilled' ? pageResult.value : null;
  const pageSpeed = pageSpeedResult.status === 'fulfilled' ? pageSpeedResult.value : null;
  const aiReadiness = aiReadinessResult.status === 'fulfilled' ? aiReadinessResult.value : null;

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Build quick audit summary
  const result = {
    domain,
    propertyId,
    auditedAt: new Date().toISOString(),
    durationSeconds: parseFloat(duration),
    homepage: summarizePageAudit(pageAudit),
    performance: summarizePageSpeed(pageSpeed),
    aiReadiness: aiReadiness && !aiReadiness.error ? aiReadiness : null,
    issueCount: 0
  };

  // Count total issues
  if (result.homepage) {
    result.issueCount += result.homepage.seoIssues.length + result.homepage.a11yIssues.length;
  }

  // Store results in D1
  try {
    await storeQuickAuditResults(env, domain, propertyId, userId, pageAudit, pageSpeed, aiReadiness);
  } catch (e) {
    console.error('Failed to store quick audit results:', e.message);
  }

  // Cache in KV for immediate dashboard display (use both key formats for compatibility)
  try {
    const resultJson = JSON.stringify(result);
    await env.SEO_AUDITS.put(`quickaudit:${userId}:${domain}`, resultJson, { expirationTtl: 86400 });
    // Also store under the key that handleSiteHealth reads from
    await env.SEO_AUDITS.put(`audit:${userId}:${domain}`, JSON.stringify({
      domain,
      auditDate: new Date().toISOString().split('T')[0],
      totalUrls: 1,
      audited: 1,
      pages: pageAudit ? [pageAudit] : [],
      brokenLinks: [],
      quickAudit: true
    }), { expirationTtl: 86400 });
  } catch (e) {
    console.error('Failed to cache quick audit:', e.message);
  }

  return result;
}

/**
 * Fetch and audit the homepage, trying www first then bare domain.
 */
async function auditHomepage(wwwUrl, bareUrl, domain) {
  try {
    const result = await auditSinglePageWithLinks(wwwUrl, domain);
    if (result && !result.error) return result;
  } catch (e) {
    // Fall through to try bare domain
  }

  try {
    return await auditSinglePageWithLinks(bareUrl, domain);
  } catch (e) {
    return { error: true, errorMessage: e.message, url: bareUrl };
  }
}

/**
 * Summarize a page audit result into a clean frontend-friendly format.
 */
function summarizePageAudit(pageAudit) {
  if (!pageAudit || pageAudit.error) {
    return {
      reachable: false,
      error: pageAudit?.errorMessage || 'Could not reach the homepage',
      seoIssues: [],
      a11yIssues: [],
      seo: {}
    };
  }

  // Collect SEO issues
  const seoIssues = [];

  if (pageAudit.title?.status === 'missing') {
    seoIssues.push({ type: 'missing_title', severity: 'high', label: 'Missing page title' });
  } else if (pageAudit.title?.status === 'too_short') {
    seoIssues.push({ type: 'short_title', severity: 'medium', label: `Title too short (${pageAudit.title.length} chars)` });
  } else if (pageAudit.title?.status === 'too_long') {
    seoIssues.push({ type: 'long_title', severity: 'low', label: `Title too long (${pageAudit.title.length} chars)` });
  }

  if (pageAudit.description?.status === 'missing') {
    seoIssues.push({ type: 'missing_description', severity: 'high', label: 'Missing meta description' });
  } else if (pageAudit.description?.status === 'too_short') {
    seoIssues.push({ type: 'short_description', severity: 'medium', label: `Meta description too short (${pageAudit.description.length} chars)` });
  }

  if (pageAudit.h1?.count === 0) {
    seoIssues.push({ type: 'missing_h1', severity: 'medium', label: 'Missing H1 tag' });
  } else if (pageAudit.h1?.count > 1) {
    seoIssues.push({ type: 'multiple_h1', severity: 'low', label: `Multiple H1 tags (${pageAudit.h1.count})` });
  }

  if (pageAudit.schema && !pageAudit.schema.found) {
    seoIssues.push({ type: 'missing_schema', severity: 'low', label: 'No structured data (JSON-LD) found' });
  }

  if (pageAudit.canonical?.status === 'missing') {
    seoIssues.push({ type: 'missing_canonical', severity: 'medium', label: 'Missing canonical URL' });
  }

  // Social meta tags
  if (pageAudit.og && !pageAudit.og.title) {
    seoIssues.push({ type: 'missing_og', severity: 'low', label: 'Missing Open Graph tags' });
  }

  // Collect accessibility issues
  const a11yIssues = [];
  if (pageAudit.accessibility?.issues) {
    for (const issue of pageAudit.accessibility.issues) {
      a11yIssues.push({
        type: issue.type,
        severity: issue.severity || 'medium',
        label: issue.description || issue.type,
        count: issue.count || 1
      });
    }
  }

  return {
    reachable: true,
    url: pageAudit.url,
    statusCode: pageAudit.status,
    seoIssues,
    a11yIssues,
    seo: {
      title: pageAudit.title,
      description: pageAudit.description,
      h1Count: pageAudit.h1?.count,
      schemaFound: pageAudit.schema?.found,
      schemaTypes: pageAudit.schema?.types || [],
      canonical: pageAudit.canonical,
      og: pageAudit.og
    }
  };
}

/**
 * Summarize PageSpeed data into a clean format.
 */
function summarizePageSpeed(ps) {
  if (!ps || ps.error) {
    return {
      available: false,
      error: ps?.error || 'No PageSpeed data available'
    };
  }

  return {
    available: true,
    lcp: ps.lcp,
    lcpRating: ps.lcpRating,
    inp: ps.inp,
    inpRating: ps.inpRating,
    cls: ps.cls,
    clsRating: ps.clsRating,
    fcp: ps.fcp,
    fcpRating: ps.fcpRating,
    ttfb: ps.ttfb,
    ttfbRating: ps.ttfbRating,
    overallRating: ps.overallRating || calculateOverallRating(ps)
  };
}

function calculateOverallRating(ps) {
  const ratings = [ps.lcpRating, ps.inpRating, ps.clsRating].filter(Boolean);
  if (ratings.length === 0) return 'unknown';
  if (ratings.includes('poor')) return 'poor';
  if (ratings.includes('needs_improvement')) return 'needs_improvement';
  return 'good';
}

/**
 * Store quick audit results in D1 tables (issues, accessibility_issues, performance).
 */
async function storeQuickAuditResults(env, domain, propertyId, userId, pageAudit, pageSpeed, aiReadiness) {
  const db = env.DB;
  const auditDate = new Date().toISOString().split('T')[0];

  // If we got a valid page audit, build the audit object and store it
  if (pageAudit && !pageAudit.error) {
    const quickAuditData = {
      totalUrls: 1,
      audited: 1,
      duration: 0,
      pages: [pageAudit],
      brokenLinks: [],
      aiReadiness: aiReadiness || null
    };

    await storeAuditInD1(env, domain, auditDate, quickAuditData, userId);
  } else if (aiReadiness && !aiReadiness.error) {
    // Even if page audit failed, still store AI readiness data
    const minimalAudit = {
      totalUrls: 0, audited: 0, duration: 0,
      pages: [], brokenLinks: [],
      aiReadiness
    };
    await storeAuditInD1(env, domain, auditDate, minimalAudit, userId);
  }

  // Store performance data if available
  if (pageSpeed && !pageSpeed.error) {
    try {
      await db.prepare(`
        INSERT INTO performance_history (domain, date, lcp_ms, fcp_ms, cls, inp_ms, ttfb_ms, recorded_at, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain, date) DO UPDATE SET
          lcp_ms = excluded.lcp_ms, fcp_ms = excluded.fcp_ms, cls = excluded.cls,
          inp_ms = excluded.inp_ms, ttfb_ms = excluded.ttfb_ms, recorded_at = excluded.recorded_at
      `).bind(
        domain, auditDate,
        pageSpeed.LCP || null, pageSpeed.FCP || null, pageSpeed.CLS || null,
        pageSpeed.INP || null, pageSpeed.TTFB || null,
        new Date().toISOString(), userId
      ).run();
    } catch (e) {
      console.error('Failed to store performance history:', e.message);
    }

    // Store performance snapshot with Lighthouse a11y data
    try {
      await db.prepare(`
        INSERT OR REPLACE INTO performance_snapshots (
          domain, snapshot_date, user_id,
          cwv_lcp, cwv_lcp_rating, cwv_inp, cwv_inp_rating, cwv_cls, cwv_cls_rating,
          cwv_fcp, cwv_fcp_rating, cwv_ttfb, cwv_overall, cwv_source, cwv_performance_score,
          cwv_speed_index, cwv_tested_domain, lighthouse_a11y
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        domain, auditDate, userId,
        pageSpeed.LCP || null, pageSpeed.lcpRating || null,
        pageSpeed.INP || null, pageSpeed.inpRating || null,
        pageSpeed.CLS ?? null, pageSpeed.clsRating || null,
        pageSpeed.FCP || null, pageSpeed.fcpRating || null,
        pageSpeed.TTFB || null, pageSpeed.overallCategory || null,
        pageSpeed.source || 'lighthouse',
        pageSpeed.performanceScore || null,
        pageSpeed.speedIndex || null,
        pageSpeed.testedUrl || domain,
        pageSpeed.accessibility ? JSON.stringify(pageSpeed.accessibility) : null
      ).run();
    } catch (e) {
      console.error('Failed to store performance snapshot:', e.message);
    }
  }
}
