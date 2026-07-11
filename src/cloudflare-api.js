import { getDateRange, formatBytes } from './utils.js';

export async function cloudflareGraphQL(headers, query) {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers, body: JSON.stringify({ query })
  });
  return response.json();
}

export async function fetchCloudflareSummary(creds) {
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

export async function fetchCloudflareDetail(creds, env) {
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
      if (!accountId) {
        const zoneResponse = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}`, {
          headers: { 'Authorization': `Bearer ${creds.apiToken}` }
        });
        const zoneData = await zoneResponse.json();
        accountId = zoneData?.result?.account?.id;
        zoneName = zoneData?.result?.name;
      }

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
                dimensions { siteTag }
                avg { firstContentfulPaint firstPaint loadEventTime pageRenderTime }
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
                dimensions { siteTag requestHost }
              }
            }
          }
        }
      `;

      const rumResult = await cloudflareGraphQL(headers, rumQuery);
      const pageloads = rumResult?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
      const perfEvents = rumResult?.data?.viewer?.accounts?.[0]?.rumPerformanceEventsAdaptiveGroups || [];

      const matchingHosts = pageloads.filter(p => {
        const host = (p.dimensions?.requestHost || '').toLowerCase();
        const zone = zoneName.toLowerCase();
        return host === zone || host === 'www.' + zone || host.endsWith('.' + zone);
      });

      if (matchingHosts.length > 0) {
        const siteTags = [...new Set(matchingHosts.map(h => h.dimensions?.siteTag))];
        const matchingPerf = perfEvents.filter(p => siteTags.includes(p.dimensions?.siteTag));

        if (matchingPerf.length > 0) {
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
              FCP: Math.round((totalFCP / totalCount) / 1000),
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

  const coreWebVitals = { lazy: true, note: 'Click to load Core Web Vitals' };
  const siteHealth = { lazy: true };

  let responseCodes = {};
  let geoPerformance = [];

  for (const zoneId of creds.zoneIds) {
    try {
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
    zoneName,
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

export async function fetchCloudflareTraffic(creds, env) {
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
  let errors = null;

  for (const zoneId of creds.zoneIds) {
    try {
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

      if (result?.errors && result.errors.length > 0) {
        if (!errors) errors = [];
        errors.push(`Zone ${zoneId.substring(0,8)}... GraphQL: ${result.errors[0]?.message || 'Unknown error'}`);
      }

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

        (day.sum?.responseStatusMap || []).forEach(s => {
          const status = s.edgeResponseStatus;
          const count = s.requests || 0;
          if (status >= 200 && status < 300) responseStatus.success += count;
          else if (status >= 300 && status < 400) responseStatus.redirect += count;
          else if (status >= 400 && status < 500) responseStatus.clientError += count;
          else if (status >= 500) responseStatus.serverError += count;
        });
      });

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
      console.error(`Cloudflare traffic error for zone ${zoneId}:`, e);
      if (!errors) errors = [];
      errors.push(`Zone ${zoneId.substring(0,8)}...: ${e.message}`);
    }
  }

  const cacheRatio = totalBytes > 0 ? (totalCachedBytes / totalBytes) * 100 : 0;
  const requestsChange = prevRequests > 0 ? ((totalRequests - prevRequests) / prevRequests) * 100 : 0;
  const pageViewsChange = prevPageViews > 0 ? ((totalPageViews - prevPageViews) / prevPageViews) * 100 : 0;

  if (totalRequests === 0 && totalBytes === 0 && errors && errors.length > 0) {
    return {
      error: 'Cloudflare API errors: ' + errors.join('; '),
      requests: 0, bandwidth: '0 B', cacheRatio: '0.0', pageViews: 0,
      threats: 0, responseStatus, errorRate: 0, dailyData: []
    };
  }

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
    dailyData,
    ...(errors ? { warnings: errors } : {})
  };
}

export async function fetchCloudflarePerformance(creds, env) {
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

      (zone?.current || []).forEach(day => {
        traffic.requests += day.sum?.requests || 0;
        traffic.pageViews += day.sum?.pageViews || 0;
        traffic.bandwidth += day.sum?.bytes || 0;
        traffic.cachedBytes += day.sum?.cachedBytes || 0;
        traffic.threats += day.sum?.threats || 0;
      });

      (zone?.previous || []).forEach(day => {
        prevTraffic.requests += day.sum?.requests || 0;
        prevTraffic.pageViews += day.sum?.pageViews || 0;
      });

      (zone?.statusCodes || []).forEach(s => {
        const code = s.dimensions?.edgeResponseStatus;
        if (code >= 200 && code < 300) responseCodes.success += s.count;
        else if (code >= 300 && code < 400) responseCodes.redirect += s.count;
        else if (code >= 400 && code < 500) responseCodes.clientError += s.count;
        else if (code >= 500) responseCodes.serverError += s.count;
      });

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

// AI crawler user-agents worth tracking, mapped to the engines they feed.
const AI_CRAWLERS = [
  { alias: 'gptbot', like: '%GPTBot%', bot: 'GPTBot', engine: 'ChatGPT (model training)', vendor: 'OpenAI' },
  { alias: 'oaisearch', like: '%OAI-SearchBot%', bot: 'OAI-SearchBot', engine: 'ChatGPT Search', vendor: 'OpenAI' },
  { alias: 'chatgptuser', like: '%ChatGPT-User%', bot: 'ChatGPT-User', engine: 'ChatGPT (live browsing)', vendor: 'OpenAI' },
  { alias: 'claudebot', like: '%ClaudeBot%', bot: 'ClaudeBot', engine: 'Claude', vendor: 'Anthropic' },
  { alias: 'perplexbot', like: '%PerplexityBot%', bot: 'PerplexityBot', engine: 'Perplexity (indexing)', vendor: 'Perplexity' },
  { alias: 'perplexuser', like: '%Perplexity-User%', bot: 'Perplexity-User', engine: 'Perplexity (live browsing)', vendor: 'Perplexity' },
  { alias: 'ccbot', like: '%CCBot%', bot: 'CCBot', engine: 'Common Crawl (feeds many models)', vendor: 'Common Crawl' },
  { alias: 'bytespider', like: '%Bytespider%', bot: 'Bytespider', engine: 'ByteDance / Doubao', vendor: 'ByteDance' },
  { alias: 'metaext', like: '%meta-externalagent%', bot: 'Meta-ExternalAgent', engine: 'Meta AI', vendor: 'Meta' },
  { alias: 'amazonbot', like: '%Amazonbot%', bot: 'Amazonbot', engine: 'Amazon / Alexa AI', vendor: 'Amazon' }
];

/**
 * How often AI crawlers actually hit the site — request counts per bot over
 * the last 7 days, from Cloudflare's adaptive request logs (user-agent match).
 */
export async function fetchAICrawlerActivity(creds) {
  if (!creds.apiToken || !creds.zoneIds?.length) return { available: false };
  const headers = { 'Authorization': `Bearer ${creds.apiToken}`, 'Content-Type': 'application/json' };
  const iso = d => d.toISOString().split('.')[0] + 'Z';
  const DAYS = 7;

  const subQueries = AI_CRAWLERS.map(c =>
    `${c.alias}: httpRequestsAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end, userAgent_like: "${c.like}"}) { count }`
  ).join('\n');

  // Free-plan zones cap adaptive queries at a 1-day window — query per day and sum.
  const dayQuery = (start, end) => `
    query {
      viewer {
        zones(filter: {zoneTag: "${creds.zoneIds[0]}"}) {
          ${subQueries.replaceAll('$start', `"${iso(start)}"`).replaceAll('$end', `"${iso(end)}"`)}
        }
      }
    }`;

  try {
    const now = new Date();
    const windows = [];
    for (let i = DAYS; i > 0; i--) {
      windows.push([new Date(now.getTime() - i * 86400000), new Date(now.getTime() - (i - 1) * 86400000)]);
    }
    const results = await Promise.all(windows.map(([a, b]) => cloudflareGraphQL(headers, dayQuery(a, b))));

    const totals = {};
    let firstError = null;
    for (const r of results) {
      if (r.errors?.length) { firstError = r.errors[0].message; continue; }
      const zone = r.data?.viewer?.zones?.[0];
      if (!zone) continue;
      for (const c of AI_CRAWLERS) {
        totals[c.alias] = (totals[c.alias] || 0) + (zone[c.alias]?.[0]?.count || 0);
      }
    }
    if (Object.keys(totals).length === 0) {
      return { available: false, error: firstError || 'no data returned' };
    }
    const crawlers = AI_CRAWLERS.map(c => ({
      bot: c.bot, engine: c.engine, vendor: c.vendor, requests: totals[c.alias] || 0
    }));
    return {
      available: true,
      days: DAYS,
      total: crawlers.reduce((a, b) => a + b.requests, 0),
      crawlers: crawlers.sort((a, b) => b.requests - a.requests)
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}
