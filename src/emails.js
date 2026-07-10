// ============================================================================
// LIFECYCLE EMAILS
// Transactional onboarding + the trial→paid drip sequence.
// Magic-link auth email lives in auth.js; everything else lives here.
// ============================================================================

import { getDateRangePST } from './utils.js';

/**
 * Send one email through Brevo.
 *
 * @param {object} env - Worker env bindings
 * @param {object} message
 * @param {string} message.to - recipient email
 * @param {string} message.subject
 * @param {string} message.htmlContent
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function sendBrevoEmail(env, { to, subject, htmlContent }) {
  if (!env.BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY not configured');
  }

  const senderEmail = env.EMAIL_FROM || 'noreply@shelobweb.com';
  const senderName = env.EMAIL_FROM_NAME || 'Shelob Web';

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: [{ email: to }],
      subject,
      htmlContent
    })
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`Brevo send failed (${subject}):`, err);
    return { success: false, error: err };
  }

  return { success: true };
}

/**
 * Day-0 welcome email. Transactional onboarding tied to account creation —
 * sent regardless of marketing consent (see PRD P0-2).
 *
 * @param {string} email
 * @param {object} env
 * @param {string} baseUrl - e.g. "https://shelobweb.com"
 */
export async function sendWelcomeEmail(email, env, baseUrl) {
  return sendBrevoEmail(env, {
    to: email,
    subject: 'Welcome to Shelob Web — here\'s where to start',
    htmlContent: buildWelcomeEmail(baseUrl)
  });
}

function buildWelcomeEmail(baseUrl) {
  const step = (num, title, body) => `
    <tr><td style="padding:0 32px 16px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="32" valign="top" style="padding-top:2px">
            <div style="width:24px;height:24px;border-radius:12px;background:#6366f1;color:#fff;font-size:13px;font-weight:700;text-align:center;line-height:24px">${num}</div>
          </td>
          <td valign="top">
            <div style="color:#fff;font-size:15px;font-weight:600;margin-bottom:2px">${title}</div>
            <div style="color:#94a3b8;font-size:13px;line-height:1.5">${body}</div>
          </td>
        </tr>
      </table>
    </td></tr>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 20px">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#1a1d2e;border-radius:12px;overflow:hidden">
        <tr><td style="padding:32px 32px 8px">
          <h1 style="color:#fff;font-size:22px;margin:0 0 12px">Welcome to Shelob Web</h1>
          <p style="color:#94a3b8;font-size:14px;margin:0;line-height:1.6">Hi — I'm Robbie, the person behind Shelob Web. I built it because keeping track of SEO, performance, accessibility, and now AI readiness across a handful of sites meant juggling five different tools. This does it in one place, automatically, every night.</p>
          <p style="color:#94a3b8;font-size:14px;margin:12px 0 0;line-height:1.6">Your 7-day trial is live. Here's how to get value out of it in the next few minutes:</p>
        </td></tr>
        <tr><td style="height:20px"></td></tr>
        ${step(1, 'Add your first site', 'Enter your domain. We run an instant audit of your homepage right away — no scripts, no plugins.')}
        ${step(2, 'Connect Google', 'One-click OAuth for Analytics and Search Console pulls in sessions, keywords, and rankings.')}
        ${step(3, 'Check your first audit', 'Your full-site crawl runs tonight. Tomorrow morning you\'ll see every SEO, accessibility, and AI-readiness issue we found.')}
        <tr><td style="padding:8px 32px 28px;text-align:center">
          <a href="${baseUrl}/dashboard" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600">Open Your Dashboard</a>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #2a2d3e;text-align:center">
          <p style="color:#64748b;font-size:12px;margin:0 0 6px;line-height:1.5">Just reply to this email if you get stuck — it reaches me directly.</p>
          <p style="color:#475569;font-size:11px;margin:0">Shelob Web &mdash; Website Monitoring Dashboard</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ============================================================================
// UNSUBSCRIBE TOKENS
// HMAC-SHA256 over the userId, keyed off ENCRYPTION_KEY. No schema needed;
// the link is valid for the life of the account and can't be forged or
// enumerated without the key.
// ============================================================================

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('unsubscribe:' + secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/** Hex HMAC token for a user's unsubscribe link. */
export async function unsubscribeToken(userId, secret) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(userId));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-length comparison of a presented token against the expected one. */
export async function verifyUnsubscribeToken(userId, token, secret) {
  if (!userId || !token) return false;
  const expected = await unsubscribeToken(userId, secret);
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function buildUnsubscribeUrl(userId, env, baseUrl) {
  const token = await unsubscribeToken(userId, env.ENCRYPTION_KEY);
  return `${baseUrl}/unsubscribe?uid=${encodeURIComponent(userId)}&sig=${token}`;
}

// ============================================================================
// DRIP SEQUENCE TEMPLATES
// Shared dark-card shell with a legally required unsubscribe footer on every
// marketing send (PRD P0-6).
// ============================================================================

function marketingShell({ heading, intro, bodyRows, ctaText, ctaUrl, unsubUrl }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 20px">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#1a1d2e;border-radius:12px;overflow:hidden">
        <tr><td style="padding:32px 32px 8px">
          <h1 style="color:#fff;font-size:22px;margin:0 0 12px">${heading}</h1>
          <p style="color:#94a3b8;font-size:14px;margin:0;line-height:1.6">${intro}</p>
        </td></tr>
        <tr><td style="height:20px"></td></tr>
        ${bodyRows}
        <tr><td style="padding:8px 32px 28px;text-align:center">
          <a href="${ctaUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600">${ctaText}</a>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #2a2d3e;text-align:center">
          <p style="color:#475569;font-size:11px;margin:0 0 6px">Shelob Web &mdash; Website Monitoring Dashboard</p>
          <p style="color:#475569;font-size:11px;margin:0">Don't want these emails? <a href="${unsubUrl}" style="color:#64748b">Unsubscribe</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function categoryRow(title, body) {
  return `
    <tr><td style="padding:0 32px 14px">
      <div style="background:#131624;border:1px solid #2a2d3e;border-radius:8px;padding:14px 16px">
        <div style="color:#fff;font-size:14px;font-weight:600;margin-bottom:3px">${title}</div>
        <div style="color:#94a3b8;font-size:13px;line-height:1.5">${body}</div>
      </div>
    </td></tr>`;
}

/** Day 3–4: value framing of the audit categories. */
function buildEducationalEmail(baseUrl, unsubUrl) {
  return marketingShell({
    heading: 'What your audits are actually telling you',
    intro: 'Your site gets a full crawl every night. Here\'s what each score means for your traffic and your visitors — and why it\'s worth a look before your trial wraps up.',
    bodyRows:
      categoryRow('SEO issues', 'Missing titles, descriptions, and schema are the difference between ranking and being invisible. Each issue links to the exact pages affected, with an AI-generated fix you can copy-paste.') +
      categoryRow('Core Web Vitals', 'Google uses these speed metrics as a ranking signal. If LCP is red, slow pages are costing you both rankings and conversions.') +
      categoryRow('Accessibility', 'Contrast, alt text, and label issues lock out real visitors and carry legal risk. Lighthouse checks every page nightly.') +
      categoryRow('AI readiness &amp; AEO', 'ChatGPT, Perplexity, and Google AI Overviews are the new front page. Your score shows whether AI systems can read — and cite — your content.') +
      categoryRow('Broken links', 'Every 404 wastes crawl budget and trust. We find them across your whole sitemap before your visitors do.'),
    ctaText: 'See Your Latest Audit',
    ctaUrl: `${baseUrl}/dashboard`,
    unsubUrl
  });
}

/** Day 6: trial ends tomorrow — upgrade push. */
function buildPreExpiryEmail(baseUrl, unsubUrl) {
  return marketingShell({
    heading: 'Your trial ends tomorrow',
    intro: 'Your 7-day Shelob Web trial wraps up tomorrow. After that, nightly audits stop and your dashboard locks to the upgrade screen — your data stays safe, but monitoring pauses until you pick a plan.',
    bodyRows:
      categoryRow('Keep what\'s working', 'Nightly full-site audits, Core Web Vitals tracking, accessibility checks, and broken-link detection keep running without a gap.') +
      categoryRow('Pro — $29/mo', 'Up to 5 websites, Google Analytics &amp; Search Console integrations, AI readiness &amp; AEO scoring, and AI-powered fix suggestions.') +
      categoryRow('Agency — $59/mo', 'Everything in Pro across 25 websites, plus team invites with role-based access and CSV export.'),
    ctaText: 'Choose Your Plan',
    ctaUrl: `${baseUrl}/dashboard`,
    unsubUrl
  });
}

// ============================================================================
// ORCHESTRATION (PRD P0-5)
// Runs from the scheduled trigger. Evaluates every active, consenting trial
// and sends at most ONE stage per user per run:
//   pre_expiry   when 0–1 days remain
//   educational  when 2–4 days remain (i.e. ~day 3 of a 7-day trial)
// Conversion (plan != 'trial'), expiry, and unsubscribe all drop the user out
// of the eligibility query itself, so exits are automatic.
// ============================================================================

const LIFECYCLE_STAGES = {
  educational: {
    subject: 'What your Shelob Web audits are telling you',
    build: buildEducationalEmail
  },
  pre_expiry: {
    subject: 'Your Shelob Web trial ends tomorrow',
    build: buildPreExpiryEmail
  }
};

/**
 * Evaluate all active trials and send due lifecycle emails.
 * Idempotency: a stage is claimed with INSERT OR IGNORE before sending; if the
 * send fails the claim is released so tomorrow's run retries it.
 *
 * @param {object} env
 * @param {string} [baseUrl]
 * @returns {Promise<{evaluated: number, sent: string[], failed: string[]}>}
 */
export async function runLifecycleEmails(env, baseUrl = 'https://shelobweb.com') {
  const result = { evaluated: 0, sent: [], failed: [] };
  if (!env.DB || !env.BREVO_API_KEY || !env.ENCRYPTION_KEY) {
    console.error('Lifecycle emails: missing DB/BREVO_API_KEY/ENCRYPTION_KEY');
    return result;
  }

  const { endDate: today } = getDateRangePST(0);

  // Active, unconverted, unexpired trials with marketing consent
  const trials = await env.DB.prepare(`
    SELECT id, email, trial_ends_at FROM users
    WHERE plan = 'trial'
      AND marketing_opt_in = 1
      AND trial_ends_at IS NOT NULL
      AND trial_ends_at >= ?
  `).bind(today).all();

  const users = trials.results || [];
  result.evaluated = users.length;
  if (users.length === 0) return result;

  // All previously sent stages, one query
  const sentRows = await env.DB.prepare(
    'SELECT user_id, stage FROM lifecycle_emails'
  ).all();
  const sent = new Set((sentRows.results || []).map(r => `${r.user_id}:${r.stage}`));

  const todayMs = new Date(today + 'T00:00:00Z').getTime();

  for (const user of users) {
    const daysLeft = Math.round(
      (new Date(user.trial_ends_at + 'T00:00:00Z').getTime() - todayMs) / 86400000
    );

    // Pick at most one due stage, latest-first so a user never gets two in one day
    let stage = null;
    if (daysLeft <= 1 && !sent.has(`${user.id}:pre_expiry`)) stage = 'pre_expiry';
    else if (daysLeft >= 2 && daysLeft <= 4 && !sent.has(`${user.id}:educational`)) stage = 'educational';
    if (!stage) continue;

    // Claim the stage before sending — UNIQUE(user_id, stage) makes this atomic
    const claim = await env.DB.prepare(
      'INSERT OR IGNORE INTO lifecycle_emails (user_id, stage) VALUES (?, ?)'
    ).bind(user.id, stage).run();
    if (!claim.meta?.changes) continue; // another run already claimed it

    try {
      const unsubUrl = await buildUnsubscribeUrl(user.id, env, baseUrl);
      const def = LIFECYCLE_STAGES[stage];
      const sendResult = await sendBrevoEmail(env, {
        to: user.email,
        subject: def.subject,
        htmlContent: def.build(baseUrl, unsubUrl)
      });
      if (!sendResult.success) throw new Error(sendResult.error || 'send failed');
      result.sent.push(`${user.email}:${stage}`);
      console.log(`Lifecycle email sent: ${stage} → ${user.email} (${daysLeft}d left)`);
    } catch (e) {
      // Release the claim so tomorrow's run retries
      await env.DB.prepare(
        'DELETE FROM lifecycle_emails WHERE user_id = ? AND stage = ?'
      ).bind(user.id, stage).run().catch(() => {});
      result.failed.push(`${user.email}:${stage}`);
      console.error(`Lifecycle email FAILED: ${stage} → ${user.email}: ${e.message}`);
    }
  }

  return result;
}
