// ============================================================================
// EXECUTIVE REPORT
// Print-ready, plain-English website health report a site owner can hand to
// their boss or client. Server-rendered from D1 snapshots — no live API calls.
// ============================================================================

import { validatePropertyAccess } from './tenant.js';

function grade(score) {
  if (score === null || score === undefined || isNaN(score)) return { letter: '—', color: '#94a3b8', word: 'No data yet' };
  if (score >= 90) return { letter: 'A', color: '#059669', word: 'Excellent' };
  if (score >= 80) return { letter: 'B', color: '#10b981', word: 'Good' };
  if (score >= 70) return { letter: 'C', color: '#d97706', word: 'Fair' };
  if (score >= 55) return { letter: 'D', color: '#ea580c', word: 'Needs work' };
  return { letter: 'F', color: '#dc2626', word: 'At risk' };
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function handleExecutiveReport(url, env, user) {
  const propertyId = url.searchParams.get('property');
  if (!propertyId || !env.DB) return new Response('Missing property', { status: 400 });

  const property = await validatePropertyAccess(user.userId, propertyId, env.DB);
  if (!property) return new Response('Property not found or access denied', { status: 404 });
  const domain = property.domain;

  // ---- Gather everything from D1 (cheap, cached-by-design) ----
  const [snap, air, seoOpen, a11yOpen, airOpen, fixed30, kws, audit] = await Promise.all([
    env.DB.prepare('SELECT * FROM performance_snapshots WHERE domain = ? ORDER BY snapshot_date DESC LIMIT 1').bind(domain).first(),
    env.DB.prepare('SELECT * FROM ai_readiness WHERE domain = ? ORDER BY audit_date DESC LIMIT 1').bind(domain).first(),
    env.DB.prepare("SELECT severity, COUNT(*) n FROM issues WHERE domain = ? AND fixed_at IS NULL GROUP BY severity").bind(domain).all(),
    env.DB.prepare("SELECT severity, COUNT(*) n FROM accessibility_issues WHERE domain = ? AND fixed_at IS NULL GROUP BY severity").bind(domain).all(),
    env.DB.prepare("SELECT severity, COUNT(*) n FROM ai_readiness_issues WHERE domain = ? AND fixed_at IS NULL GROUP BY severity").bind(domain).all(),
    env.DB.prepare("SELECT (SELECT COUNT(*) FROM issues WHERE domain = ?1 AND fixed_at >= date('now','-30 day')) + (SELECT COUNT(*) FROM accessibility_issues WHERE domain = ?1 AND fixed_at >= date('now','-30 day')) AS n").bind(domain).first(),
    env.DB.prepare('SELECT query, clicks, impressions, position FROM keywords WHERE domain = ? AND data_date = (SELECT MAX(data_date) FROM keywords WHERE domain = ?) ORDER BY clicks DESC, impressions DESC LIMIT 8').bind(domain, domain).all(),
    env.DB.prepare('SELECT audit_date, pages_audited FROM audits WHERE domain = ? ORDER BY audit_date DESC LIMIT 1').bind(domain).first()
  ]);

  const sevCount = rows => (rows.results || []).reduce((m, r) => (m[r.severity] = r.n, m), {});
  const seoSev = sevCount(seoOpen), a11ySev = sevCount(a11yOpen), airSev = sevCount(airOpen);
  const sum = m => Object.values(m).reduce((a, b) => a + b, 0);
  const seoN = sum(seoSev), a11yN = sum(a11ySev), airN = sum(airSev);

  // ---- Category scores ----
  const perfScore = snap?.cwv_performance_score ?? null;
  const seoScore = Math.max(0, 100 - seoN * 3 - (seoSev.high || 0) * 5);
  let lhScore = null;
  try { lhScore = snap?.lighthouse_a11y ? JSON.parse(snap.lighthouse_a11y).score : null; } catch (e) {}
  const a11yScore = lhScore !== null ? Math.max(0, Math.round(lhScore * 0.7 + Math.max(0, 100 - a11yN * 4) * 0.3)) : null;
  const aiScore = air?.ai_readiness_score ?? null;

  const parts = [[perfScore, 0.3], [seoScore, 0.3], [a11yScore, 0.2], [aiScore, 0.2]].filter(([v]) => v !== null && v !== undefined);
  const totalW = parts.reduce((a, [, w]) => a + w, 0);
  const overall = parts.length ? Math.round(parts.reduce((a, [v, w]) => a + v * w, 0) / totalW) : null;
  const G = grade(overall), gPerf = grade(perfScore), gSeo = grade(seoScore), gA11y = grade(a11yScore), gAi = grade(aiScore);

  // ---- Business-English narrative bits ----
  const wins = [];
  if ((fixed30?.n || 0) > 0) wins.push(`${fixed30.n} issue${fixed30.n === 1 ? '' : 's'} fixed in the last 30 days`);
  if (snap?.ga4_sessions) wins.push(`${snap.ga4_sessions} visits in the last 7 days${snap.ga4_sessions_change > 0 ? ` — up ${Math.round(snap.ga4_sessions_change)}% week over week` : ''}`);
  const kwRows = kws.results || [];
  if (kwRows.length) wins.push(`Ranking on Google for ${kwRows.length}+ search terms`);
  if (air && !air.ai_bots_blocked) wins.push('Every major AI assistant (ChatGPT, Claude, Perplexity) can read and recommend this site');
  if (!wins.length) wins.push('Monitoring is active — every page is checked nightly');

  const attention = [];
  if ((seoSev.high || 0) > 0) attention.push({ n: seoSev.high, what: 'high-priority SEO issues', why: 'These make pages harder for Google to rank — lost free traffic every week they stay open.' });
  if (perfScore !== null && perfScore < 70) attention.push({ n: null, what: `site speed scores ${perfScore}/100`, why: 'Slow pages lose visitors: every extra second of load time measurably cuts conversions.' });
  if ((a11ySev.high || 0) > 0) attention.push({ n: a11ySev.high, what: 'serious accessibility barriers', why: 'These lock real customers out of the site and carry legal exposure (ADA/WCAG).' });
  if (air && air.ai_bots_blocked > 0) attention.push({ n: air.ai_bots_blocked, what: 'AI assistants blocked from the site', why: "Blocked assistants can't cite or recommend the business when customers ask them for suggestions." });
  if (!air?.llms_txt_exists) attention.push({ n: null, what: 'no llms.txt file', why: 'A simple file that tells AI search engines what the business offers — competitors who have one get summarized more accurately.' });
  if (seoN + a11yN + airN === 0 && !attention.length) attention.push({ n: null, what: 'nothing urgent', why: 'All monitored checks are passing. The nightly crawl will flag anything that changes.' });

  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'long', day: 'numeric' });

  const catCard = (name, g, meaning) => `
    <div class="cat">
      <div class="cat-grade" style="color:${g.color}">${g.letter}</div>
      <div><div class="cat-name">${name}</div><div class="cat-word" style="color:${g.color}">${g.word}</div><div class="cat-meaning">${meaning}</div></div>
    </div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Website Health Report — ${esc(domain)}</title>
<meta name="robots" content="noindex">
<link rel="icon" type="image/png" href="/images/sw_logo.png">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f7fb;color:#181c2b;line-height:1.6;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:820px;margin:0 auto;padding:40px 32px;background:#fff}
.rpt-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid #181c2b;padding-bottom:20px;margin-bottom:28px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px}
.brand img{width:28px;height:28px;border-radius:6px}
h1{font-size:26px;font-weight:700;letter-spacing:-0.02em;margin:6px 0 2px}
.sub{color:#5b6172;font-size:13px}
.overall{display:flex;align-items:center;gap:20px;background:#f6f7fb;border:1px solid #e3e6f0;border-radius:14px;padding:22px 26px;margin-bottom:26px}
.big-grade{font-size:56px;font-weight:800;line-height:1}
.overall p{font-size:14px;color:#3c4257;max-width:52ch}
.cats{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:30px}
.cat{display:flex;gap:14px;align-items:flex-start;border:1px solid #e3e6f0;border-radius:12px;padding:16px}
.cat-grade{font-size:34px;font-weight:800;line-height:1;min-width:34px}
.cat-name{font-weight:700;font-size:14px}
.cat-word{font-size:12px;font-weight:600}
.cat-meaning{font-size:12px;color:#5b6172;margin-top:3px}
h2{font-size:16px;font-weight:700;margin:26px 0 10px;letter-spacing:-0.01em}
ul.plain{list-style:none}
ul.plain li{padding:9px 0 9px 26px;position:relative;font-size:14px;border-bottom:1px solid #eef0f6}
ul.plain li:before{content:'✓';position:absolute;left:2px;color:#059669;font-weight:700}
.att li:before{content:'!';color:#d97706}
.att .why{display:block;font-size:12.5px;color:#5b6172}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
th{text-align:left;color:#5b6172;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:6px 8px;border-bottom:1px solid #d9dcea}
td{padding:7px 8px;border-bottom:1px solid #eef0f6}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.foot{margin-top:34px;padding-top:14px;border-top:1px solid #e3e6f0;font-size:11.5px;color:#8a90a3;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
.printbtn{position:fixed;top:16px;right:16px;background:#4f46e5;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
@media print{.printbtn{display:none}body{background:#fff}.page{padding:10px 0}}
@page{margin:14mm}
</style>
</head>
<body>
<button class="printbtn" onclick="window.print()">Print / Save PDF</button>
<div class="page">
  <div class="rpt-head">
    <div>
      <div class="brand"><img src="/images/sw_logo.png" alt="">Shelob Web</div>
      <h1>Website Health Report</h1>
      <div class="sub">${esc(domain)} &middot; ${today}${audit ? ` &middot; last full scan ${esc(audit.audit_date)} (${audit.pages_audited} pages)` : ''}</div>
    </div>
  </div>

  <div class="overall">
    <div class="big-grade" style="color:${G.color}">${G.letter}</div>
    <div>
      <div style="font-weight:700;font-size:15px;margin-bottom:2px">Overall health: ${G.word}${overall !== null ? ` (${overall}/100)` : ''}</div>
      <p>This grade combines how fast the site feels to visitors, how easy it is to find on Google, whether anyone is locked out by accessibility barriers, and whether AI assistants like ChatGPT can read and recommend it.</p>
    </div>
  </div>

  <div class="cats">
    ${catCard('Site Speed', gPerf, 'How fast pages load. Slow pages lose visitors and rank lower on Google.')}
    ${catCard('Search Visibility (SEO)', gSeo, `How findable the site is on Google. ${seoN} open issue${seoN === 1 ? '' : 's'}.`)}
    ${catCard('Accessibility', gA11y, `Whether all customers can use the site. ${a11yN} open issue${a11yN === 1 ? '' : 's'}.`)}
    ${catCard('AI Readiness', gAi, 'Whether ChatGPT, Perplexity & Google AI can read and cite the site.')}
  </div>

  <h2>What's working</h2>
  <ul class="plain">${wins.map(w => `<li>${esc(w)}</li>`).join('')}</ul>

  <h2>What needs attention</h2>
  <ul class="plain att">${attention.map(a => `<li><strong>${a.n ? a.n + ' ' : ''}${esc(a.what)}</strong><span class="why">${esc(a.why)}</span></li>`).join('')}</ul>

  ${kwRows.length ? `<h2>What people search to find this site</h2>
  <table><thead><tr><th>Search term</th><th class="num">Clicks</th><th class="num">Times shown</th><th class="num">Google position</th></tr></thead>
  <tbody>${kwRows.map(k => `<tr><td>${esc(k.query)}</td><td class="num">${k.clicks}</td><td class="num">${k.impressions}</td><td class="num">${Number(k.position).toFixed(1)}</td></tr>`).join('')}</tbody></table>` : ''}

  <div class="foot">
    <span>Generated by Shelob Web — automated nightly monitoring for ${esc(domain)}</span>
    <span>shelobweb.com</span>
  </div>
</div>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
}
