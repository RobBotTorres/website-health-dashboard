## Sprint Plan: Trial Conversion Funnel

**Dates:** Wed Jul 8 — Tue Jul 21, 2026 (2 weeks) | **Team:** 1 (solo)
**Sprint Goal:** Ship the trial→paid email funnel — marketing consent captured at signup and the 3-email lifecycle sequence sending automatically off trial state.

> One-sentence test: if by Jul 21 a new trial gets a welcome email, a mid-trial educational email, and a pre-expiry upgrade nudge — with a working consent checkbox and unsubscribe — the sprint succeeded.

### Capacity

| Person | Available | Committed | Notes |
|--------|-----------|-----------|-------|
| Robbie | 40 hrs (20/wk × 2) | ~26 hrs | Solo; planned to ~75% to absorb interrupts |
| **Total** | **40 hrs** | **~26 hrs (65% raw / 87% of buffered budget)** | Buffer reserved for bugs + Brevo/deliverability unknowns |

### Sprint Backlog

Scoped to the PRD (`docs/PRD-trial-conversion-funnel.md`). Estimates in hours since it's a solo sprint.

| Priority | Item | Est. | Depends on |
|----------|------|------|------------|
| **P0** | **Consent capture** — checkbox at signup + D1 migration (`marketing_opt_in`, `marketing_opt_in_at`) + write to Brevo contact | 5h | Consent-default decision (see Risks) |
| **P0** | **Welcome email (day 0)** — transactional send on trial start; founder intro + first actions | 4h | Brevo (already wired) |
| **P0** | **Sequence orchestration** — extend/adapt scheduled pass to evaluate trial state; idempotent per-stage tracking (`lifecycle_emails` or per-stage timestamps); PST date math | 7h | Consent capture |
| **P0** | **Educational email (~day 3–4)** — value framing of audit categories; consent- + active-trial-gated | 3h | Orchestration |
| **P0** | **Pre-expiry upgrade email (~day 6)** — "trial ending" + direct Stripe checkout link | 3h | Orchestration |
| **P0** | **Suppression & unsubscribe** — working unsubscribe, consent respected, converts/cancels exit sequence | 4h | Consent capture |
| **P1 (stretch)** | **Founder-story copy** — the About/welcome narrative; feeds the welcome email *and* seeds a future About page | 2h | — |
| **P1 (stretch)** | **Personalization token** — reference the user's worst audit score / top issue in emails | 2h | Orchestration |
| **P2 (deferred)** | Second educational email (4-email arc from notes) | — | Ships after 3-email core proves out |

**Planned P0 load: ~26 hrs | Capacity: ~30 hrs (buffered) → ~87% utilized.** Stretch items only if P0 lands early.

### Friday milestones

| Date | Deliverable | Status |
|------|-------------|--------|
| **Fri Jul 10** (hard) | Consent checkbox live + welcome email sending on trial start — the visible slice you asked for by Friday. | ✅ **Shipped Jul 9** — E2E verified in prod with real signups |
| Fri Jul 17 | Orchestration + educational + pre-expiry emails firing on schedule; unsubscribe working. | ✅ **Shipped Jul 9** — dedicated 16:00 UTC cron (9am PT); idempotency, exclusion & unsubscribe all verified live |
| Tue Jul 21 | Full funnel end-to-end in production; baseline conversion rate captured. | ✅ Funnel live. Baseline recorded Jul 9: 5 users (3 trial / 2 agency). Caveat: the 2 paid accounts are comped operator accounts, so the true self-serve baseline is **0% — any organic conversion is a win**. |

### Explicitly NOT this sprint (and why)

| Deferred | Why |
|----------|-----|
| Pro-feature previews / dummy data | Own workstream — needs design + product decisions on which features to tease. Spec separately. |
| AEO/GEO AI-ranking feature | New product surface with R&D/discovery unknowns; too large to fit alongside the funnel. |
| Simpler onboarding / starter interface | Needs UX design pass; not sized. Candidate for next sprint. |
| About *page* build | Copy is a P1 stretch this sprint (it feeds the welcome email); the page build itself waits. |
| General bug/polish backlog | No dedicated slot — the ~14 hrs of unplanned buffer absorbs anything urgent that surfaces. |

Trying to do all six in 30 hours would mean shipping none of them well. Ship the funnel; it's the one directly tied to revenue.

### Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Consent default undecided** (pre-checked box isn't GDPR-valid) | Blocks the consent checkbox (P0-1); legal exposure if shipped wrong | Decide default before Fri Jul 10. Recommendation: unchecked, or region-aware. This is the one true blocker. |
| **Friday deadline is 2 days out** | Full funnel can't land by Fri | Scope Friday to consent + welcome only; rest across the sprint (already reflected above) |
| **Solo dev, no slack** | Any interrupt eats the sprint | 25% buffer built in; stretch items are cuttable |
| **Brevo templates / deliverability** | Emails land in spam or render poorly | Test sends to yourself early; verify SPF/DKIM before the day-0 email goes live |
| **No conversion baseline** | Can't prove the funnel worked | Capture current trial→paid rate before launch (query D1) — the scheduled digest we set up will help |

### Definition of Done

- [ ] Code reviewed (self-review / diff) and merged to main *(only item outstanding — changes are deployed but not yet committed to git)*
- [x] D1 migrations applied to production (`0016_marketing_consent`, `0017_lifecycle_emails`)
- [x] Test send verified for each email — welcome, educational, and pre-expiry all received and rendering correctly (Jul 9, +alias test accounts)
- [x] Unsubscribe + consent gating confirmed working — HMAC-signed link flips `marketing_opt_in=0`, forged sig rejected, unsubscribed user excluded from next run
- [x] Deployed to production (shelobweb.com); sequence exercised end-to-end via seeded trials at day-3 and day-6 states
- [x] Baseline conversion metric recorded (see milestones — effectively 0% organic)

### Key Dates

| Date | Event |
|------|-------|
| Wed Jul 8 | Sprint start |
| Fri Jul 10 | Milestone 1 — consent + welcome live |
| Wed Jul 15 | Mid-sprint check-in |
| Fri Jul 17 | Milestone 2 — full sequence firing |
| Tue Jul 21 | Sprint end / demo |
| Wed Jul 22 | Retro |
