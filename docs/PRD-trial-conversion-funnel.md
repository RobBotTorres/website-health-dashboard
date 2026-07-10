# PRD: Trial → Paid Conversion Funnel

**Product:** Shelob Web
**Author:** Robbie
**Status:** Draft v1
**Last updated:** 2026-07-08

---

## Problem Statement

Free-trial users sign up, poke around, and the 7-day trial expires with no structured nudging to convert. Right now the only lifecycle touch is a magic-link login email; there is no welcome, no education on *why* the audits matter, and no upgrade push before the trial locks out. The result is trials that quietly lapse instead of turning into Pro ($29/mo) or Agency ($59/mo) subscribers — the single biggest lever on revenue for a self-serve SaaS at this stage.

## Goals

1. **Increase trial → paid conversion rate** — the core outcome. Establish a baseline in week 1, then target a measurable lift within one quarter.
2. **Get every trial user onto the lifecycle email track** — capture marketing consent at signup so the drip can run at all.
3. **Deliver a value-framed education sequence** — by trial end, a user should understand what each audit category does for them and what they lose when the trial locks.
4. **Make the upgrade path frictionless at the moment of highest intent** — the pre-expiry email and the lockout screen should route straight to checkout.
5. **Stay compliant** — email consent handling that holds up under CAN-SPAM and (if any EU users) GDPR.

## Non-Goals

- **Pro-feature previews / dummy data** — enticing upgrades by showing locked features with sample data is its own workstream; specced separately. This PRD is only the *email/consent funnel*.
- **Lead-magnet capture for non-signups** (email capture on the marketing site before someone starts a trial) — related but a separate top-of-funnel effort; noted as a future consideration, not built here.
- **About section / founder story / positioning copy** — separate marketing-site workstream.
- **AEO/GEO "how do you rank in AI tools" feature** — separate product workstream.
- **A full visual email-template builder / marketing automation platform** — we send a fixed, code-defined sequence via Brevo, not a drag-and-drop campaign tool.
- **SMS or in-app notification channels** — email only for v1.

## Target Users

- **Primary: new free-trial signups** — individual site owners and small operators who just added their first property and are inside the 7-day window.
- **Secondary: trial users who lapsed without converting** — a win-back angle (P1, not P0).

## User Stories

**New trial user**

- As a new trial user, I want a welcome email that introduces who's behind the tool and what to do first, so that I feel oriented and trust the product.
- As a new trial user, I want to understand *why* each audit category (SEO, Core Web Vitals, accessibility, AI readiness, broken links) matters, so that I see the value before my trial ends.
- As a new trial user approaching day 7, I want a clear reminder that my trial is ending and a one-click path to upgrade, so that I don't lose access by inaction.

**Signing-up user (consent)**

- As a user signing up, I want a clear checkbox to receive product tips and updates, so that I know what I'm opting into and can decline.

**Founder / operator (Robbie)**

- As the operator, I want every new trial automatically enrolled in the sequence (subject to consent), so that conversion doesn't depend on me sending anything manually.
- As the operator, I want to see how many users open, click, and convert from each email, so that I can improve the sequence over time.

## Requirements

### Must-Have (P0)

**P0-1 — Marketing consent capture at signup**
Add a marketing-email opt-in checkbox to the trial signup flow.

- Acceptance criteria:
  - Given a user is on the signup/trial-start form, when the page loads, then a consent checkbox is shown with plain-language copy (e.g. "Send me product tips and updates").
  - When the user submits, then their consent choice is persisted to the user record (new column, e.g. `marketing_opt_in` + `marketing_opt_in_at` timestamp).
  - Consent state is written to the Brevo contact (attribute or list membership) so sends can be gated on it.
  - ⚠️ **Default state is an open question** — see Open Questions. Pre-checked maximizes list size but is not GDPR-valid; unchecked is compliant. Decision needed before build.

**P0-2 — Transactional welcome email (day 0)**
On trial start, send a welcome email immediately.

- Acceptance criteria:
  - Given a user starts a trial, when the account is created, then a welcome email is sent within a few minutes.
  - Email introduces the founder, sets expectations, and gives 1–3 concrete first actions ("add your site," "connect Google," "check your first audit").
  - This is a transactional onboarding email tied to account creation; it may send regardless of marketing consent (confirm in Open Questions).
  - Send failures are logged and retried or surfaced, not silent.

**P0-3 — Educational email (≈ day 3–4)**
Send a value-framed email mid-trial.

- Acceptance criteria:
  - Given a user is ~3–4 days into an active trial, when the scheduled send fires, then they receive an email explaining what the audit categories do for them and pointing back to their dashboard results.
  - Only sent to users who (a) still have an active, unconverted trial and (b) have marketing consent.
  - Suppressed if the user has already upgraded.

**P0-4 — Pre-expiry upgrade email (≈ day 6, before day-7 lockout)**
Send an upgrade push before the trial locks.

- Acceptance criteria:
  - Given a user's trial expires in ~24 hours, when the scheduled send fires, then they receive an email stating the trial is ending, what they'll lose at lockout, and a direct upgrade link.
  - The upgrade link routes straight to Stripe checkout (or the upgrade page pre-scoped to a plan).
  - Only sent to active, unconverted trials with consent; suppressed if already upgraded.

**P0-5 — Sequence orchestration & scheduling**
The drip must run automatically off trial state.

- Acceptance criteria:
  - The existing nightly cron (or a dedicated scheduled pass) evaluates each active trial and sends the correct stage based on days since signup.
  - Each user receives each email at most once (idempotent — track sent stages per user, e.g. a `lifecycle_emails` table or per-stage timestamps).
  - Converting or cancelling removes the user from remaining sends.
  - Timezone handling uses the app's existing PST date math to avoid off-by-one sends.

**P0-6 — Suppression & unsubscribe**
Respect consent and law.

- Acceptance criteria:
  - Every marketing email includes a working unsubscribe link (Brevo-managed or custom).
  - Unsubscribing sets `marketing_opt_in = false` and stops all future marketing sends (transactional/magic-link email is unaffected).
  - No marketing email is sent to a user without current consent.

### Nice-to-Have (P1)

- **P1-1 — Conversion analytics dashboard**: per-stage open/click/convert metrics for the operator (could start as a simple query/export before a UI).
- **P1-2 — Win-back email** for trials that lapsed without converting (e.g. day 10–14 post-expiry).
- **P1-3 — Second educational email** — your notes mention a 4-email arc; splitting education into two sends is an easy extension once the 3-email core proves out.
- **P1-4 — Personalization tokens**: reference the user's actual worst audit score / top issue in the educational and pre-expiry emails to sharpen relevance.

### Future Considerations (P2)

- **P2-1 — Lead-magnet email capture** on the marketing site (free mini-audit in exchange for email) feeding the same sequence. Design the consent + contact model so this slots in later.
- **P2-2 — Behavior-triggered branches** (e.g. different email if the user never connected Google vs. never viewed results).
- **P2-3 — A/B testing** of subject lines and send timing.

## Success Metrics

**Leading indicators (days to weeks)**

- **Opt-in rate** — % of new trials that consent to marketing email. (Target set after we pick the default.)
- **Email open rate** per stage — welcome / educational / pre-expiry.
- **Email click-through rate** to dashboard and to checkout.
- **Upgrade-page visits sourced from emails.**

**Lagging indicators (weeks to months)**

- **Trial → paid conversion rate** — *the* metric. Measure a pre-launch baseline, then target a specific lift (e.g. +X percentage points) within one quarter. *(Need current baseline — see Open Questions.)*
- **Time-to-conversion** — does the sequence pull conversions earlier in the window?
- **Revenue from self-serve conversions** (Pro vs. Agency mix).
- **Unsubscribe rate** — guardrail; keep below a threshold (e.g. <0.5% per send).

Measurement: Brevo for email engagement; Stripe + D1 for conversion; evaluate at 2 weeks (engagement) and 1 quarter (conversion).

## Open Questions

- **[Legal / Stakeholder — BLOCKING] Default consent state:** pre-checked box or unchecked? Pre-checked grows the list but violates GDPR affirmative-consent rules; if there are any EU users, unchecked (or a region-aware default) is safer. This gates P0-1.
- **[Product] Welcome email vs. consent:** should the day-0 welcome be treated as transactional (always sent) or marketing (consent-gated)? Recommendation: transactional onboarding, always sent; only stages 2–3 require marketing consent.
- **[Data — BLOCKING for target-setting] Current baseline conversion rate:** what % of trials convert today? Needed to set a credible goal.
- **[Product] Exact send timing:** confirm the day offsets (proposed: day 0, day 3–4, day 6 of a 7-day trial). Do we want the 4th email from your notes now (P1-3) or start with 3?
- **[Engineering] Orchestration home:** extend the existing 11:00 UTC nightly cron, or add a separate scheduled trigger for lifecycle sends? Affects idempotency design.
- **[Engineering] Consent sync:** store consent in D1 as source of truth and mirror to Brevo, or let Brevo list membership be authoritative? Recommendation: D1 authoritative, Brevo mirrored.

## Timeline Considerations

- **Dependencies:** Brevo (already integrated for magic links), Stripe checkout (already live), D1 schema migration for consent + sent-stage tracking (new migration, follows existing numbered pattern).
- **Suggested phasing:**
  - **Phase 1 (this PRD, P0):** consent capture + 3-email sequence + orchestration + unsubscribe. Ships the core funnel.
  - **Phase 2 (P1):** operator analytics, win-back, second educational email, personalization.
  - **Phase 3 (P2):** marketing-site lead magnet, behavioral branching, A/B testing.
- **No hard external deadline** identified. Recommend establishing the conversion baseline *before* launch so the lift is measurable.
