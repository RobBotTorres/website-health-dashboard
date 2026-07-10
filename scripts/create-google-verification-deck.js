const pptxgen = require("pptxgenjs");

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.author = "Shelob Web";
pres.title = "Shelob Web — Google OAuth Verification Video Storyboard";

// ──────────────────────────────────────────────
// Color palette — Midnight + Indigo (matches brand)
// ──────────────────────────────────────────────
const C = {
  bgDark: "0A0C14",
  bgCard: "131624",
  border: "1E2235",
  indigo: "6366F1",
  indigoLight: "818CF8",
  indigoGlow: "A5B4FC",
  purple: "C084FC",
  green: "34D399",
  greenDim: "0D3D30",
  orange: "FBBF24",
  red: "F87171",
  white: "F1F5F9",
  textSub: "94A3B8",
  textDim: "64748B",
};

const font = "Calibri";
const fontMono = "Consolas";

// Helper to make fresh shadow objects (PptxGenJS mutates them)
const cardShadow = () => ({
  type: "outer",
  blur: 10,
  offset: 3,
  angle: 135,
  color: "000000",
  opacity: 0.3,
});

// ══════════════════════════════════════════════
// SLIDE 1 — Title
// ══════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bgDark };

  // Decorative accent shape — indigo glow bar at top
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.06,
    fill: { color: C.indigo },
  });

  // Subtle brand circle
  s.addShape(pres.shapes.OVAL, {
    x: 7.2, y: 0.6, w: 4, h: 4,
    fill: { color: C.indigo, transparency: 92 },
  });

  s.addText("Shelob Web", {
    x: 0.8, y: 1.2, w: 8, h: 0.7,
    fontFace: font, fontSize: 42, bold: true, color: C.white,
    margin: 0,
  });

  s.addText("Google OAuth Verification — App Demonstration", {
    x: 0.8, y: 1.95, w: 8, h: 0.5,
    fontFace: font, fontSize: 20, color: C.indigoLight,
    margin: 0,
  });

  // Scope badges
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 2.85, w: 3.6, h: 0.36,
    fill: { color: C.bgCard },
    line: { color: C.border, width: 1 },
    rectRadius: 0.05,
  });
  s.addText("analytics.readonly  ·  webmasters.readonly", {
    x: 0.8, y: 2.85, w: 3.6, h: 0.36,
    fontFace: fontMono, fontSize: 11, color: C.indigoGlow,
    align: "center", valign: "middle", margin: 0,
  });

  // Info block
  s.addText([
    { text: "App Name:  ", options: { color: C.textDim, fontSize: 13, breakLine: false } },
    { text: "Shelob Web", options: { color: C.white, fontSize: 13, bold: true, breakLine: true } },
    { text: "Homepage:  ", options: { color: C.textDim, fontSize: 13, breakLine: false } },
    { text: "https://shelobweb.com", options: { color: C.indigoLight, fontSize: 13, breakLine: true } },
    { text: "Privacy Policy:  ", options: { color: C.textDim, fontSize: 13, breakLine: false } },
    { text: "https://shelobweb.com/policies", options: { color: C.indigoLight, fontSize: 13, breakLine: true } },
    { text: "OAuth Callback:  ", options: { color: C.textDim, fontSize: 13, breakLine: false } },
    { text: "https://shelobweb.com/api/oauth/google/callback", options: { color: C.indigoLight, fontSize: 13, breakLine: true } },
  ], {
    x: 0.8, y: 3.6, w: 8, h: 1.6,
    fontFace: font, lineSpacingMultiple: 1.5,
    margin: 0,
  });
}

// ══════════════════════════════════════════════
// SLIDE 2 — App Overview
// ══════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bgDark };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.indigo } });

  s.addText("01", {
    x: 0.8, y: 0.4, w: 1, h: 0.4,
    fontFace: fontMono, fontSize: 14, color: C.indigo, margin: 0,
  });
  s.addText("What Shelob Web Does", {
    x: 0.8, y: 0.75, w: 8, h: 0.6,
    fontFace: font, fontSize: 30, bold: true, color: C.white, margin: 0,
  });

  // Description
  s.addText(
    "Shelob Web is a website health monitoring dashboard that runs automated nightly audits " +
    "on our users' websites. It checks SEO, Core Web Vitals, accessibility, AI readiness, " +
    "and broken links across all pages in the sitemap.",
    {
      x: 0.8, y: 1.5, w: 8.4, h: 0.8,
      fontFace: font, fontSize: 14, color: C.textSub, lineSpacingMultiple: 1.6, margin: 0,
    }
  );

  // Feature cards
  const features = [
    { label: "Google Analytics 4", scope: "analytics.readonly", desc: "Sessions, bounce rate, engagement rate, page views, session duration, top pages", color: C.green },
    { label: "Google Search Console", scope: "webmasters.readonly", desc: "Keywords, clicks, impressions, CTR, average position, ranking opportunities", color: C.indigoLight },
  ];

  features.forEach((f, i) => {
    const yBase = 2.6 + i * 1.25;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.8, y: yBase, w: 8.4, h: 1.05,
      fill: { color: C.bgCard },
      line: { color: C.border, width: 1 },
      shadow: cardShadow(),
    });
    // Accent left bar
    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.8, y: yBase, w: 0.06, h: 1.05,
      fill: { color: f.color },
    });
    s.addText(f.label, {
      x: 1.1, y: yBase + 0.12, w: 4, h: 0.35,
      fontFace: font, fontSize: 15, bold: true, color: C.white, margin: 0,
    });
    s.addText(f.scope, {
      x: 5.5, y: yBase + 0.14, w: 3.5, h: 0.3,
      fontFace: fontMono, fontSize: 10, color: f.color, align: "right", margin: 0,
    });
    s.addText(f.desc, {
      x: 1.1, y: yBase + 0.5, w: 7.8, h: 0.4,
      fontFace: font, fontSize: 12, color: C.textSub, margin: 0,
    });
  });
}

// ══════════════════════════════════════════════
// SLIDE 3 — Scope Justification
// ══════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bgDark };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.indigo } });

  s.addText("02", {
    x: 0.8, y: 0.4, w: 1, h: 0.4,
    fontFace: fontMono, fontSize: 14, color: C.indigo, margin: 0,
  });
  s.addText("Why We Need Each Scope", {
    x: 0.8, y: 0.75, w: 8, h: 0.6,
    fontFace: font, fontSize: 30, bold: true, color: C.white, margin: 0,
  });

  // Scope 1
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 1.55, w: 8.4, h: 1.7,
    fill: { color: C.bgCard },
    line: { color: C.border, width: 1 },
    shadow: cardShadow(),
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 1.55, w: 0.06, h: 1.7,
    fill: { color: C.green },
  });
  s.addText("analytics.readonly", {
    x: 1.1, y: 1.65, w: 5, h: 0.35,
    fontFace: fontMono, fontSize: 14, bold: true, color: C.green, margin: 0,
  });
  s.addText("Google Analytics Data API v1beta", {
    x: 5.5, y: 1.68, w: 3.5, h: 0.3,
    fontFace: font, fontSize: 11, color: C.textDim, align: "right", margin: 0,
  });
  s.addText([
    { text: "We use this scope to read aggregated analytics data from GA4 properties:", options: { breakLine: true, color: C.textSub } },
    { text: "Sessions, bounce rate, engagement rate, page views, avg session duration", options: { bullet: true, breakLine: true, color: C.white } },
    { text: "Top-performing pages by traffic and engagement", options: { bullet: true, breakLine: true, color: C.white } },
    { text: "Property listing and auto-discovery via Admin API", options: { bullet: true, breakLine: true, color: C.white } },
    { text: "Read-only — we never modify any GA4 data or settings", options: { bullet: true, color: C.orange } },
  ], {
    x: 1.1, y: 2.05, w: 7.8, h: 1.1,
    fontFace: font, fontSize: 12, lineSpacingMultiple: 1.4, margin: 0,
  });

  // Scope 2
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 3.5, w: 8.4, h: 1.7,
    fill: { color: C.bgCard },
    line: { color: C.border, width: 1 },
    shadow: cardShadow(),
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 3.5, w: 0.06, h: 1.7,
    fill: { color: C.indigoLight },
  });
  s.addText("webmasters.readonly", {
    x: 1.1, y: 3.6, w: 5, h: 0.35,
    fontFace: fontMono, fontSize: 14, bold: true, color: C.indigoLight, margin: 0,
  });
  s.addText("Search Console API", {
    x: 5.5, y: 3.63, w: 3.5, h: 0.3,
    fontFace: font, fontSize: 11, color: C.textDim, align: "right", margin: 0,
  });
  s.addText([
    { text: "We use this scope to read search performance data from Google Search Console:", options: { breakLine: true, color: C.textSub } },
    { text: "Top search queries, clicks, impressions, CTR, and average position", options: { bullet: true, breakLine: true, color: C.white } },
    { text: "Keyword ranking opportunities (queries positioned 8-20)", options: { bullet: true, breakLine: true, color: C.white } },
    { text: "Property listing for auto-discovery during OAuth", options: { bullet: true, breakLine: true, color: C.white } },
    { text: "Read-only — we never submit URLs, sitemaps, or modify any data", options: { bullet: true, color: C.orange } },
  ], {
    x: 1.1, y: 4.0, w: 7.8, h: 1.1,
    fontFace: font, fontSize: 12, lineSpacingMultiple: 1.4, margin: 0,
  });
}

// ══════════════════════════════════════════════
// SLIDE 4 — OAuth Flow (Narrated Walkthrough)
// ══════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bgDark };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.indigo } });

  s.addText("03", {
    x: 0.8, y: 0.4, w: 1, h: 0.4,
    fontFace: fontMono, fontSize: 14, color: C.indigo, margin: 0,
  });
  s.addText("OAuth Consent Flow — Step by Step", {
    x: 0.8, y: 0.75, w: 8, h: 0.6,
    fontFace: font, fontSize: 30, bold: true, color: C.white, margin: 0,
  });

  s.addText("Record your screen performing these steps. This is the core of the video.", {
    x: 0.8, y: 1.35, w: 8.4, h: 0.4,
    fontFace: font, fontSize: 13, italic: true, color: C.orange, margin: 0,
  });

  const steps = [
    { num: "1", title: "Open Settings in Dashboard", desc: "Log in at shelobweb.com → Navigate to Settings. Show a property with no Google integration connected yet." },
    { num: "2", title: 'Click "Connect Google"', desc: "Click the Connect Google button on a property card. This initiates the OAuth flow and redirects to Google's consent screen." },
    { num: "3", title: "Google Consent Screen", desc: "Show the Google consent screen requesting analytics.readonly and webmasters.readonly. Select your Google account and click Allow." },
    { num: "4", title: "Redirect Back to Shelob Web", desc: "After granting consent, Google redirects back to shelobweb.com/api/oauth/google/callback. A success message is shown." },
    { num: "5", title: "Data Appears in Dashboard", desc: 'Return to the dashboard. Show the GA4 tab (sessions, bounce rate, pages) and the Search Console tab (keywords, clicks, impressions).' },
  ];

  steps.forEach((step, i) => {
    const yBase = 1.95 + i * 0.67;
    // Step number circle
    s.addShape(pres.shapes.OVAL, {
      x: 0.8, y: yBase + 0.05, w: 0.38, h: 0.38,
      fill: { color: C.indigo },
    });
    s.addText(step.num, {
      x: 0.8, y: yBase + 0.05, w: 0.38, h: 0.38,
      fontFace: font, fontSize: 13, bold: true, color: C.white,
      align: "center", valign: "middle", margin: 0,
    });
    s.addText(step.title, {
      x: 1.35, y: yBase, w: 3, h: 0.32,
      fontFace: font, fontSize: 14, bold: true, color: C.white, margin: 0,
    });
    s.addText(step.desc, {
      x: 1.35, y: yBase + 0.3, w: 7.8, h: 0.3,
      fontFace: font, fontSize: 11, color: C.textSub, margin: 0,
    });
  });
}

// ══════════════════════════════════════════════
// SLIDE 5 — Where Scope Data is Displayed
// ══════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bgDark };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.indigo } });

  s.addText("04", {
    x: 0.8, y: 0.4, w: 1, h: 0.4,
    fontFace: fontMono, fontSize: 14, color: C.indigo, margin: 0,
  });
  s.addText("Where Scope Data Appears in the App", {
    x: 0.8, y: 0.75, w: 8, h: 0.6,
    fontFace: font, fontSize: 30, bold: true, color: C.white, margin: 0,
  });

  s.addText("Show each of these sections during the screen recording.", {
    x: 0.8, y: 1.35, w: 8.4, h: 0.4,
    fontFace: font, fontSize: 13, italic: true, color: C.orange, margin: 0,
  });

  // GA4 section
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 1.95, w: 4, h: 2.6,
    fill: { color: C.bgCard },
    line: { color: C.border, width: 1 },
    shadow: cardShadow(),
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 1.95, w: 4, h: 0.06,
    fill: { color: C.green },
  });
  s.addText("GA4 Tab  (analytics.readonly)", {
    x: 1.05, y: 2.15, w: 3.5, h: 0.35,
    fontFace: font, fontSize: 14, bold: true, color: C.green, margin: 0,
  });
  s.addText([
    { text: "Property selector dropdown", options: { bullet: true, breakLine: true } },
    { text: "Sessions count", options: { bullet: true, breakLine: true } },
    { text: "Bounce rate percentage", options: { bullet: true, breakLine: true } },
    { text: "Engagement rate", options: { bullet: true, breakLine: true } },
    { text: "Page views", options: { bullet: true, breakLine: true } },
    { text: "Avg session duration", options: { bullet: true, breakLine: true } },
    { text: "Top pages table", options: { bullet: true } },
  ], {
    x: 1.05, y: 2.55, w: 3.5, h: 1.9,
    fontFace: font, fontSize: 12, color: C.textSub, lineSpacingMultiple: 1.2, margin: 0,
  });

  // Search Console section
  s.addShape(pres.shapes.RECTANGLE, {
    x: 5.2, y: 1.95, w: 4, h: 2.6,
    fill: { color: C.bgCard },
    line: { color: C.border, width: 1 },
    shadow: cardShadow(),
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 5.2, y: 1.95, w: 4, h: 0.06,
    fill: { color: C.indigoLight },
  });
  s.addText("Search Tab  (webmasters.readonly)", {
    x: 5.45, y: 2.15, w: 3.5, h: 0.35,
    fontFace: font, fontSize: 14, bold: true, color: C.indigoLight, margin: 0,
  });
  s.addText([
    { text: "Top search queries table", options: { bullet: true, breakLine: true } },
    { text: "Clicks per keyword", options: { bullet: true, breakLine: true } },
    { text: "Impressions", options: { bullet: true, breakLine: true } },
    { text: "Click-through rate (CTR)", options: { bullet: true, breakLine: true } },
    { text: "Average position", options: { bullet: true, breakLine: true } },
    { text: "Ranking opportunities (pos 8-20)", options: { bullet: true, breakLine: true } },
    { text: "Indexed page count", options: { bullet: true } },
  ], {
    x: 5.45, y: 2.55, w: 3.5, h: 1.9,
    fontFace: font, fontSize: 12, color: C.textSub, lineSpacingMultiple: 1.2, margin: 0,
  });

  // Note
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 4.8, w: 8.4, h: 0.5,
    fill: { color: C.indigo, transparency: 88 },
    line: { color: C.indigo, width: 1 },
  });
  s.addText("All data is displayed read-only. Users cannot modify, delete, or write any data back to Google services.", {
    x: 1.0, y: 4.8, w: 8.0, h: 0.5,
    fontFace: font, fontSize: 12, color: C.indigoGlow, valign: "middle", margin: 0,
  });
}

// ══════════════════════════════════════════════
// SLIDE 6 — Disconnect / Revoke Flow
// ══════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bgDark };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.indigo } });

  s.addText("05", {
    x: 0.8, y: 0.4, w: 1, h: 0.4,
    fontFace: fontMono, fontSize: 14, color: C.indigo, margin: 0,
  });
  s.addText("How Users Revoke Access", {
    x: 0.8, y: 0.75, w: 8, h: 0.6,
    fontFace: font, fontSize: 30, bold: true, color: C.white, margin: 0,
  });

  s.addText("Show the disconnect flow during the screen recording.", {
    x: 0.8, y: 1.35, w: 8.4, h: 0.4,
    fontFace: font, fontSize: 13, italic: true, color: C.orange, margin: 0,
  });

  // Method 1
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 2.0, w: 4, h: 2.4,
    fill: { color: C.bgCard },
    line: { color: C.border, width: 1 },
    shadow: cardShadow(),
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 2.0, w: 4, h: 0.06,
    fill: { color: C.green },
  });
  s.addText("In-App Disconnect", {
    x: 1.05, y: 2.2, w: 3.5, h: 0.35,
    fontFace: font, fontSize: 16, bold: true, color: C.white, margin: 0,
  });
  s.addText([
    { text: "Go to Settings in the dashboard", options: { bullet: true, breakLine: true } },
    { text: 'Each property shows a "Disconnect" button next to the Google integration status', options: { bullet: true, breakLine: true } },
    { text: "Clicking Disconnect removes the stored OAuth refresh token from our database", options: { bullet: true, breakLine: true } },
    { text: "The property returns to the unconnected state immediately", options: { bullet: true } },
  ], {
    x: 1.05, y: 2.65, w: 3.5, h: 1.5,
    fontFace: font, fontSize: 12, color: C.textSub, lineSpacingMultiple: 1.4, margin: 0,
  });

  // Method 2
  s.addShape(pres.shapes.RECTANGLE, {
    x: 5.2, y: 2.0, w: 4, h: 2.4,
    fill: { color: C.bgCard },
    line: { color: C.border, width: 1 },
    shadow: cardShadow(),
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 5.2, y: 2.0, w: 4, h: 0.06,
    fill: { color: C.indigoLight },
  });
  s.addText("Google Account Settings", {
    x: 5.45, y: 2.2, w: 3.5, h: 0.35,
    fontFace: font, fontSize: 16, bold: true, color: C.white, margin: 0,
  });
  s.addText([
    { text: "Users can also revoke access directly via Google:", options: { breakLine: true, color: C.textSub } },
    { text: "Visit myaccount.google.com/permissions", options: { bullet: true, breakLine: true } },
    { text: 'Find "Shelob Web" in the list', options: { bullet: true, breakLine: true } },
    { text: "Click Remove Access", options: { bullet: true, breakLine: true } },
    { text: "This instantly invalidates the OAuth token", options: { bullet: true } },
  ], {
    x: 5.45, y: 2.65, w: 3.5, h: 1.5,
    fontFace: font, fontSize: 12, color: C.textSub, lineSpacingMultiple: 1.4, margin: 0,
  });

  // API endpoint callout
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 4.7, w: 8.4, h: 0.5,
    fill: { color: C.bgCard },
    line: { color: C.border, width: 1 },
  });
  s.addText([
    { text: "API endpoint:  ", options: { color: C.textDim, fontSize: 12 } },
    { text: "POST /api/oauth/google/disconnect", options: { color: C.indigoLight, fontSize: 12, fontFace: fontMono } },
    { text: "  — deletes encrypted refresh token from D1 database", options: { color: C.textDim, fontSize: 11 } },
  ], {
    x: 1.0, y: 4.7, w: 8.0, h: 0.5,
    fontFace: font, valign: "middle", margin: 0,
  });
}

// ══════════════════════════════════════════════
// SLIDE 7 — Data Security & Privacy
// ══════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bgDark };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.indigo } });

  s.addText("06", {
    x: 0.8, y: 0.4, w: 1, h: 0.4,
    fontFace: fontMono, fontSize: 14, color: C.indigo, margin: 0,
  });
  s.addText("Data Handling & Privacy", {
    x: 0.8, y: 0.75, w: 8, h: 0.6,
    fontFace: font, fontSize: 30, bold: true, color: C.white, margin: 0,
  });

  const items = [
    { icon: "ENCRYPTED", title: "Tokens encrypted at rest", desc: "OAuth refresh tokens are AES-encrypted before storage in Cloudflare D1. Encryption keys are stored as Worker secrets, never in source code.", color: C.green },
    { icon: "READ-ONLY", title: "Read-only access only", desc: "Both scopes are read-only. We never write, modify, or delete any data in Google Analytics or Search Console.", color: C.indigoLight },
    { icon: "NO SHARE", title: "Data is never shared", desc: "Google API data is displayed only to the authenticated user and their authorized team members. We do not sell, share, or transfer data to third parties.", color: C.purple },
    { icon: "MINIMAL", title: "Minimal data retention", desc: "We only store the refresh token and the GA4 property ID. Analytics data is fetched on-demand from Google's API and is not permanently stored.", color: C.orange },
    { icon: "PRIVACY", title: "Published privacy policy", desc: "Full privacy policy available at shelobweb.com/policies — covers data collection, storage, sharing, and user rights.", color: C.white },
  ];

  items.forEach((item, i) => {
    const yBase = 1.55 + i * 0.78;
    // Left colored dot
    s.addShape(pres.shapes.OVAL, {
      x: 0.8, y: yBase + 0.12, w: 0.22, h: 0.22,
      fill: { color: item.color },
    });
    s.addText(item.title, {
      x: 1.2, y: yBase + 0.02, w: 4, h: 0.3,
      fontFace: font, fontSize: 14, bold: true, color: C.white, margin: 0,
    });
    s.addText(item.desc, {
      x: 1.2, y: yBase + 0.34, w: 7.8, h: 0.35,
      fontFace: font, fontSize: 11, color: C.textSub, margin: 0,
    });
  });
}

// ══════════════════════════════════════════════
// SLIDE 8 — Video Recording Script
// ══════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bgDark };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.orange } });

  s.addText("Recording Script", {
    x: 0.8, y: 0.35, w: 8, h: 0.6,
    fontFace: font, fontSize: 30, bold: true, color: C.white, margin: 0,
  });
  s.addText("Follow this sequence when recording. Keep the video under 3 minutes.", {
    x: 0.8, y: 0.9, w: 8.4, h: 0.35,
    fontFace: font, fontSize: 13, italic: true, color: C.orange, margin: 0,
  });

  const script = [
    { time: "0:00", action: "Show shelobweb.com homepage — scroll briefly to show the product overview" },
    { time: "0:15", action: "Log in and show the dashboard with a property already added" },
    { time: "0:25", action: "Navigate to Settings → show a property with no Google integration" },
    { time: "0:35", action: 'Click "Connect Google" — show the redirect to Google\'s consent screen' },
    { time: "0:45", action: "Show the consent screen with both scopes listed — select account and click Allow" },
    { time: "0:55", action: "Show the redirect back to Shelob Web with the success message" },
    { time: "1:05", action: "Navigate to the property → click the GA4 tab → show sessions, bounce rate, top pages" },
    { time: "1:25", action: "Click the Search tab → show keywords, clicks, impressions, CTR, positions" },
    { time: "1:45", action: 'Go back to Settings → click "Disconnect" on the Google integration' },
    { time: "1:55", action: "Show the property returns to unconnected state — GA4/Search data is no longer displayed" },
    { time: "2:05", action: "Open shelobweb.com/policies — briefly show the privacy policy page" },
    { time: "2:15", action: "End recording" },
  ];

  script.forEach((step, i) => {
    const yBase = 1.4 + i * 0.33;
    const isEven = i % 2 === 0;
    if (isEven) {
      s.addShape(pres.shapes.RECTANGLE, {
        x: 0.5, y: yBase, w: 9, h: 0.33,
        fill: { color: C.bgCard, transparency: 50 },
      });
    }
    s.addText(step.time, {
      x: 0.65, y: yBase, w: 0.6, h: 0.33,
      fontFace: fontMono, fontSize: 11, color: C.indigo, valign: "middle", margin: 0,
    });
    s.addText(step.action, {
      x: 1.35, y: yBase, w: 7.8, h: 0.33,
      fontFace: font, fontSize: 11, color: C.textSub, valign: "middle", margin: 0,
    });
  });
}

// ══════════════════════════════════════════════
// SLIDE 9 — Checklist / Summary
// ══════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.bgDark };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.green } });

  s.addText("Verification Checklist", {
    x: 0.8, y: 0.4, w: 8, h: 0.6,
    fontFace: font, fontSize: 30, bold: true, color: C.white, margin: 0,
  });
  s.addText("Ensure all of these are covered in your submission.", {
    x: 0.8, y: 0.95, w: 8.4, h: 0.35,
    fontFace: font, fontSize: 13, color: C.textSub, margin: 0,
  });

  const checks = [
    { text: "Homepage shown (shelobweb.com)", done: true },
    { text: "OAuth consent screen shown with both scopes visible", done: true },
    { text: "User grants access and redirect completes successfully", done: true },
    { text: "GA4 data displayed in dashboard (analytics.readonly)", done: true },
    { text: "Search Console data displayed in dashboard (webmasters.readonly)", done: true },
    { text: "Disconnect flow shown — user can revoke in-app", done: true },
    { text: "Privacy policy page shown (shelobweb.com/policies)", done: true },
    { text: "Video is under 3 minutes", done: true },
    { text: "Video is uploaded as Unlisted on YouTube", done: false },
    { text: "YouTube link submitted in Google Cloud Console", done: false },
  ];

  checks.forEach((item, i) => {
    const yBase = 1.55 + i * 0.39;
    const color = item.done ? C.green : C.textDim;
    const symbol = item.done ? "\u2713" : "\u25CB";
    s.addText(symbol, {
      x: 0.8, y: yBase, w: 0.4, h: 0.35,
      fontFace: font, fontSize: 16, bold: true, color: color, valign: "middle", margin: 0,
    });
    s.addText(item.text, {
      x: 1.25, y: yBase, w: 7.8, h: 0.35,
      fontFace: font, fontSize: 14, color: item.done ? C.white : C.textDim, valign: "middle", margin: 0,
    });
  });
}

// ══════════════════════════════════════════════
// Write file
// ══════════════════════════════════════════════
const outputPath = "/Users/roberttorres/Documents/websites/webhealthdashboard/Shelob-Web-Google-OAuth-Verification.pptx";
pres.writeFile({ fileName: outputPath }).then(() => {
  console.log("Created: " + outputPath);
}).catch(err => {
  console.error("Error:", err);
});
