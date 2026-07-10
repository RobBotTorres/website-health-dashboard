import { getGoogleAccessToken } from './google-auth.js';
import { getDateRange, formatDuration } from './utils.js';
import { getCredentials } from './config.js';

/**
 * Get an access token from credentials — handles both OAuth and service account paths.
 * @param {object} creds - credentials object with { credentials, useOAuth, env }
 * @returns {Promise<string>} access token
 */
async function getAccessToken(creds) {
  return getGoogleAccessToken(creds.credentials, {
    useOAuth: creds.useOAuth,
    encryptedRefreshToken: creds.useOAuth ? creds.credentials : undefined,
    env: creds.env
  });
}

/**
 * Extract metrics from a GA4 API row by name instead of array index.
 * Uses metricHeaders from the response to build a name→value map.
 */
function extractMetrics(metricHeaders, metricValues) {
  const map = {};
  if (!metricHeaders || !metricValues) return map;
  metricHeaders.forEach((header, i) => {
    map[header.name] = metricValues[i]?.value || '0';
  });
  return map;
}

/**
 * Fetch with retry for transient GA4 API failures (429, 500, 502, 503).
 */
async function fetchWithRetry(url, options, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, options);
    if (response.ok || attempt === retries) return response;
    const status = response.status;
    if (status !== 429 && status !== 500 && status !== 502 && status !== 503) return response;
    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
  }
}


/**
 * Pages whose GA4 page title looks like a 404 — i.e. real visitors are
 * landing on broken URLs. 28-day window, top 25 by views.
 */
export async function fetchGA4NotFound(creds) {
  if (!creds || !creds.propertyId || !creds.credentials) return { pages: [] };
  try {
    const accessToken = await getAccessToken(creds);
    const response = await fetchWithRetry(
      `https://analyticsdata.googleapis.com/v1beta/properties/${creds.propertyId}:runReport`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }],
          dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
          metrics: [{ name: 'screenPageViews' }],
          dimensionFilter: { orGroup: { expressions: [
            { filter: { fieldName: 'pageTitle', stringFilter: { matchType: 'CONTAINS', value: '404', caseSensitive: false } } },
            { filter: { fieldName: 'pageTitle', stringFilter: { matchType: 'CONTAINS', value: 'not found', caseSensitive: false } } }
          ] } },
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: 25
        })
      }
    );
    if (!response.ok) return { pages: [], error: 'GA4 error ' + response.status };
    const data = await response.json();
    const pages = (data.rows || []).map(r => ({
      path: r.dimensionValues?.[0]?.value || '',
      title: r.dimensionValues?.[1]?.value || '',
      views: parseInt(r.metricValues?.[0]?.value || '0', 10)
    }));
    return { pages };
  } catch (e) {
    return { pages: [], error: e.message };
  }
}

export async function fetchGA4Analytics(creds) {
  if (!creds.propertyId || !creds.credentials) {
    return { error: 'GA4 not configured' };
  }

  try {
    const accessToken = await getAccessToken(creds);
    const propertyId = creds.propertyId;

    const response = await fetchWithRetry(
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
    const headers = data.metricHeaders || [];
    const rows = data.rows || [];

    const cur = extractMetrics(headers, rows[0]?.metricValues);
    const prev = extractMetrics(headers, rows[1]?.metricValues);

    const sessions = parseInt(cur.sessions || 0);
    const prevSessions = parseInt(prev.sessions || 0);
    const avgDuration = parseFloat(cur.averageSessionDuration || 0);
    const pageViews = parseInt(cur.screenPageViews || 0);
    const bounceRate = parseFloat(cur.bounceRate || 0) * 100;
    const newUsers = parseInt(cur.newUsers || 0);
    const prevNewUsers = parseInt(prev.newUsers || 0);
    const engagementRate = parseFloat(cur.engagementRate || 0) * 100;

    const sessionsChange = prevSessions > 0 ? ((sessions - prevSessions) / prevSessions) * 100 : 0;
    const newUsersChange = prevNewUsers > 0 ? ((newUsers - prevNewUsers) / prevNewUsers) * 100 : 0;

    // Get top pages
    const pagesResponse = await fetchWithRetry(
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

export async function fetchGA4Performance(creds) {
  if (!creds.propertyId || !creds.credentials) {
    return { error: 'GA4 not configured', note: 'Add GA4_PROPERTY_ID to enable' };
  }

  try {
    const accessToken = await getAccessToken(creds);
    const propertyId = creds.propertyId;

    const response = await fetchWithRetry(
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
    const headers = data.metricHeaders || [];
    const rows = data.rows || [];

    const cur = extractMetrics(headers, rows[0]?.metricValues);
    const prev = extractMetrics(headers, rows[1]?.metricValues);

    const sessions = parseInt(cur.sessions || 0);
    const users = parseInt(cur.totalUsers || 0);
    const bounceRate = parseFloat(cur.bounceRate || 0) * 100;
    const avgDuration = parseFloat(cur.averageSessionDuration || 0);
    const engagementRate = parseFloat(cur.engagementRate || 0) * 100;
    const pageViews = parseInt(cur.screenPageViews || 0);

    const prevSessions = parseInt(prev.sessions || 0);
    const prevUsers = parseInt(prev.totalUsers || 0);

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

export async function fetchSearchConsoleSummary(creds) {
  if (!creds.credentials || creds.properties.length === 0) {
    return { error: 'Search Console not configured' };
  }

  try {
    const accessToken = await getAccessToken(creds);
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

export async function fetchSearchConsoleDetail(creds) {
  const summary = await fetchSearchConsoleSummary(creds);
  if (summary.error) return summary;

  try {
    const accessToken = await getAccessToken(creds);
    const { startDate, endDate } = getDateRange(7);
    const { startDate: prevStartDate, endDate: prevEndDate } = getDateRange(7, 7);

    let topQueries = [], topPages = [], indexingStatus = [], indexingIssues = [];
    let prevQueryData = {};

    for (const siteUrl of creds.properties) {
      try {
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

export async function inspectSitemapUrls(sitemapUrl, siteUrl, accessToken, maxUrls = 10) {
  const issues = [];

  try {
    const sitemapResponse = await fetch(sitemapUrl);
    if (!sitemapResponse.ok) return issues;

    const sitemapXml = await sitemapResponse.text();

    const urlMatches = sitemapXml.match(/<loc>([^<]+)<\/loc>/g) || [];
    const urls = urlMatches.map(m => m.replace(/<\/?loc>/g, '')).slice(0, maxUrls);

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

export async function fetchAndStoreSearchConsole(env, domain, propertyId, dataDate, resolvedCreds = null) {
  try {
    let creds;
    if (resolvedCreds) {
      creds = resolvedCreds;
    } else {
      try { creds = getCredentials(propertyId, env); } catch (e) { creds = null; }
    }
    if (!creds?.searchConsole?.properties?.length || !creds?.searchConsole?.credentials) {
      console.log(`No Search Console credentials for ${propertyId}`);
      return;
    }

    const accessToken = await getAccessToken(creds.searchConsole);
    const { startDate, endDate } = getDateRange(28);
    const { startDate: prevStartDate, endDate: prevEndDate } = getDateRange(28, 28);

    let prevQueryData = {};
    let keywords = [];

    for (const siteUrl of creds.searchConsole.properties) {
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

    keywords.sort((a, b) => b.clicks - a.clicks);
    keywords = keywords.slice(0, 50);

    if (env.DB && keywords.length > 0) {
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

export async function fetchPageSpeedInsights(domain, apiKey) {
  const domainsToTry = [domain, `www.${domain}`];

  for (const testDomain of domainsToTry) {
    try {
      let url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://${testDomain}&strategy=mobile&category=performance&category=accessibility`;
      if (apiKey) {
        url += `&key=${apiKey}`;
      }

      const response = await fetch(url, {
        headers: { 'Referer': 'https://shelobweb.com/' }
      });

      if (!response.ok) {
        console.error(`PageSpeed API error for ${testDomain}: ${response.status}`);
        continue;
      }

      const data = await response.json();

      if (data.error) {
        console.error(`PageSpeed API returned error for ${testDomain}:`, data.error);
        continue;
      }

      const crux = data.loadingExperience?.metrics || {};
      const originCrux = data.originLoadingExperience?.metrics || {};

      const metrics = Object.keys(originCrux).length > 0 ? originCrux : crux;
      const hasCrux = Object.keys(metrics).length > 0;

      // Extract Lighthouse accessibility data (available in both CrUX and non-CrUX paths)
      const a11yData = parseLighthouseAccessibility(data);

      // Try CrUX real-user data first
      if (hasCrux) {
        return {
          LCP: metrics.LARGEST_CONTENTFUL_PAINT_MS?.percentile || null,
          INP: metrics.INTERACTION_TO_NEXT_PAINT?.percentile || metrics.EXPERIMENTAL_INTERACTION_TO_NEXT_PAINT?.percentile || null,
          CLS: metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile ? metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null,
          FCP: metrics.FIRST_CONTENTFUL_PAINT_MS?.percentile || null,
          TTFB: metrics.EXPERIMENTAL_TIME_TO_FIRST_BYTE?.percentile || null,
          FID: metrics.FIRST_INPUT_DELAY_MS?.percentile || null,
          lcpRating: metrics.LARGEST_CONTENTFUL_PAINT_MS?.category || null,
          inpRating: metrics.INTERACTION_TO_NEXT_PAINT?.category || metrics.EXPERIMENTAL_INTERACTION_TO_NEXT_PAINT?.category || null,
          clsRating: metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.category || null,
          fcpRating: metrics.FIRST_CONTENTFUL_PAINT_MS?.category || null,
          overallCategory: data.loadingExperience?.overall_category || data.originLoadingExperience?.overall_category || null,
          source: Object.keys(originCrux).length > 0 ? 'origin' : 'url',
          testedDomain: testDomain,
          accessibility: a11yData
        };
      }

      // Fall back to Lighthouse lab data (always available)
      const lhr = data.lighthouseResult;
      if (lhr) {
        const audits = lhr.audits || {};
        const perfScore = lhr.categories?.performance?.score;
        const lcpMs = audits['largest-contentful-paint']?.numericValue;
        const fcpMs = audits['first-contentful-paint']?.numericValue;
        const clsVal = audits['cumulative-layout-shift']?.numericValue;
        const tbtMs = audits['total-blocking-time']?.numericValue;
        const siMs = audits['speed-index']?.numericValue;
        const ttfbMs = audits['server-response-time']?.numericValue;

        function labRating(audit) {
          if (!audit) return null;
          const score = audit.score;
          if (score === null || score === undefined) return null;
          if (score >= 0.9) return 'GOOD';
          if (score >= 0.5) return 'NEEDS_IMPROVEMENT';
          return 'POOR';
        }

        const overallCat = perfScore >= 0.9 ? 'GOOD' : perfScore >= 0.5 ? 'NEEDS_IMPROVEMENT' : 'POOR';

        return {
          LCP: lcpMs ? Math.round(lcpMs) : null,
          INP: tbtMs ? Math.round(tbtMs) : null,
          CLS: clsVal !== undefined ? clsVal : null,
          FCP: fcpMs ? Math.round(fcpMs) : null,
          TTFB: ttfbMs ? Math.round(ttfbMs) : null,
          FID: null,
          lcpRating: labRating(audits['largest-contentful-paint']),
          inpRating: labRating(audits['total-blocking-time']),
          clsRating: labRating(audits['cumulative-layout-shift']),
          fcpRating: labRating(audits['first-contentful-paint']),
          ttfbRating: labRating(audits['server-response-time']),
          overallCategory: overallCat,
          performanceScore: perfScore ? Math.round(perfScore * 100) : null,
          speedIndex: siMs ? Math.round(siMs) : null,
          source: 'lighthouse',
          testedDomain: testDomain,
          accessibility: a11yData
        };
      }

      console.log(`No CrUX or Lighthouse data for ${testDomain}, trying next...`);
      continue;
    } catch (error) {
      console.error(`PageSpeed fetch error for ${testDomain}:`, error);
      continue;
    }
  }

  return { note: 'Could not reach site for performance analysis' };
}

/**
 * Parse Lighthouse accessibility audit results from a PageSpeed Insights response.
 * Extracts failing audits with their details, scores, and affected elements.
 *
 * @param {object} data - Full PSI API response
 * @returns {object} { score, failingAudits[], passingCount, manualCount }
 */
function parseLighthouseAccessibility(data) {
  const lhr = data?.lighthouseResult;
  if (!lhr) return null;

  const a11yCat = lhr.categories?.accessibility;
  if (!a11yCat) return null;

  const score = a11yCat.score !== null && a11yCat.score !== undefined
    ? Math.round(a11yCat.score * 100)
    : null;

  const audits = lhr.audits || {};
  const auditRefs = a11yCat.auditRefs || [];

  const failingAudits = [];
  let passingCount = 0;
  let manualCount = 0;
  let notApplicableCount = 0;

  // Group IDs for human-readable categories
  const groupLabels = {
    'a11y-aria': 'ARIA',
    'a11y-color-contrast': 'Color Contrast',
    'a11y-names-labels': 'Names & Labels',
    'a11y-navigation': 'Navigation',
    'a11y-language': 'Language',
    'a11y-audio-video': 'Audio & Video',
    'a11y-tables-lists': 'Tables & Lists',
    'a11y-best-practices': 'Best Practices'
  };

  for (const ref of auditRefs) {
    const audit = audits[ref.id];
    if (!audit) continue;

    // Skip informative/manual audits
    if (audit.scoreDisplayMode === 'manual' || audit.scoreDisplayMode === 'informative') {
      manualCount++;
      continue;
    }

    if (audit.scoreDisplayMode === 'notApplicable' || audit.score === null) {
      notApplicableCount++;
      continue;
    }

    // Passing audit
    if (audit.score === 1) {
      passingCount++;
      continue;
    }

    // Failing audit — extract details
    const items = audit.details?.items || [];
    const elements = items.slice(0, 10).map(item => {
      const node = item.node || {};
      return {
        selector: node.selector || null,
        snippet: node.snippet || null,
        nodeLabel: node.nodeLabel || null,
        explanation: node.explanation || null
      };
    }).filter(el => el.selector || el.snippet);

    failingAudits.push({
      id: ref.id,
      title: audit.title || ref.id,
      description: (audit.description || '').replace(/\[.*?\]\(.*?\)/g, '').trim(),
      score: audit.score,
      weight: ref.weight || 0,
      group: ref.group || 'other',
      groupLabel: groupLabels[ref.group] || 'Other',
      severity: ref.weight >= 7 ? 'high' : ref.weight >= 3 ? 'medium' : 'low',
      elementCount: items.length,
      elements
    });
  }

  // Sort by weight (most impactful first)
  failingAudits.sort((a, b) => b.weight - a.weight);

  return {
    score,
    failingAudits,
    passingCount,
    manualCount,
    notApplicableCount,
    totalChecks: failingAudits.length + passingCount + notApplicableCount + manualCount
  };
}

// Export for use in handlers
export { parseLighthouseAccessibility };

export async function fetchCoreWebVitals(domain) {
  try {
    const url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://www.${domain}&category=performance&strategy=mobile`;
    const response = await fetch(url);

    if (!response.ok) {
      return { error: 'PageSpeed API error' };
    }

    const data = await response.json();
    const crux = data.loadingExperience || {};
    const metrics = crux.metrics || {};

    const lcp = metrics.LARGEST_CONTENTFUL_PAINT_MS;
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
