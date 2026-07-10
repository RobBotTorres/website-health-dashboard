# Friday Milestone — Engineering Tickets

**Goal (Fri Jul 10):** Marketing-consent checkbox live + welcome email sending on new trial.
**Key architecture note:** Auth is magic-link based (`src/auth.js`). There is no signup form — a user record is created inside `upsertUser()` at *verify* time, but consent is chosen earlier at *email-entry* time. So consent must be stored on the `magic_links` row when the link is requested, then copied to the `users` row on verify.

---

## Ticket 1 — Decide consent default ✅ RESOLVED

**Decision (Jul 9): region-aware.** The checkbox renders **unchecked** for visitors from the EU/EEA/UK/Switzerland (affirmative consent per GDPR Art. 4(11)) and **pre-checked** everywhere else.

- Implemented via `request.cf.country` against a `GDPR_COUNTRIES` set in `src/index.js`; `renderLoginPage()` swaps a `__CONSENT_CHECKED__` placeholder in `login.html`.
- Unknown country (local dev, `cf` absent) falls back to **unchecked** — fail-safe.
- Column `DEFAULT 0`; a stored `1` therefore always reflects a real affirmative choice.
- The `/login` response sets `Cache-Control: private, no-store` so a region-varying page can never be served from a shared cache.

**Secondary decision: consent is upgrade-only for returning users.** Checking the box grants consent; leaving it unchecked never revokes it (unsubscribe is the only opt-out path). This stops a default-unchecked form from silently stripping consent on a routine login.

---

## Ticket 2 — D1 migration: marketing consent

**File:** `migrations/0016_marketing_consent.sql` (new, follows the numbered pattern)

```sql
-- Marketing email consent
ALTER TABLE users ADD COLUMN marketing_opt_in INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN marketing_opt_in_at TEXT;

-- Carry consent from magic-link request through to user creation at verify time
ALTER TABLE magic_links ADD COLUMN marketing_opt_in INTEGER DEFAULT 0;
```

**Apply:**
```bash
npx wrangler d1 migrations apply wine-seo-audits --local     # test
npx wrangler d1 migrations apply wine-seo-audits --remote    # staging/prod
```

---

## Ticket 3 — Capture consent on the login page + request handler

**a) `src/login.html`** — add a checkbox under the email input on the magic-link request form. Copy: "Send me product tips and occasional updates (you can unsubscribe anytime)". Default state per Ticket 1. Ensure it's part of the POST body (name e.g. `marketing_opt_in`).

**b) `src/index.js` (~L334–352, the request-magic-link handler)** — read the checkbox from the parsed body and pass it into `sendMagicLink(email, env, baseUrl, marketingOptIn)`.

**c) `src/auth.js` → `sendMagicLink()`** — add a `marketingOptIn` param; include it in the INSERT:
```js
await env.DB.prepare(
  'INSERT INTO magic_links (id, email, expires_at, marketing_opt_in) VALUES (?, ?, ?, ?)'
).bind(token, email, expiresAt.toISOString(), marketingOptIn ? 1 : 0).run();
```

---

## Ticket 4 — Persist consent to the user on verify

**`src/auth.js` → `verifyMagicLink()`** — the `magic_links` row is already fetched (`row`); pass `row.marketing_opt_in` into `upsertUser`.

**`src/auth.js` → `upsertUser()`** — two changes:
1. On the new-user INSERT, set consent:
```js
await db.prepare(
  `INSERT INTO users (id, email, plan, trial_ends_at, marketing_opt_in, marketing_opt_in_at)
   VALUES (?, ?, 'trial', ?, ?, ?)`
).bind(userId, email, trialEnds.toISOString().split('T')[0],
       marketingOptIn ? 1 : 0, marketingOptIn ? new Date().toISOString() : null).run();
```
2. **Return `{ userId, isNew }`** instead of just `userId` (so Ticket 5 can fire the welcome only on first creation). Update the caller in `verifyMagicLink` accordingly.

*(Brevo contact attribute sync can be fire-and-forget here, but D1 is the source of truth — the Brevo mirror can slip to the drip work next week without blocking Friday.)*

---

## Ticket 5 — Welcome email (transactional, day 0)

**`src/auth.js`** (or a new `src/emails.js` if you'd rather split it) — add `sendWelcomeEmail(email, env, baseUrl)`, mirroring the existing Brevo `fetch` in `sendMagicLink`. Add a `buildWelcomeEmail()` template reusing the dark card styling from `buildMagicLinkEmail()`. Content:
- Founder intro (1–2 lines, your voice).
- 3 first actions: add your first site, connect Google (GA4 + Search Console), check your first audit.
- Link to the dashboard.

**Trigger — `verifyMagicLink()`**, only for new users, non-blocking:
```js
const { userId, isNew } = await upsertUser(env.DB, email, row.marketing_opt_in);
if (isNew) {
  sendWelcomeEmail(email, env, baseUrl).catch(e => console.error('welcome email failed', e));
}
```
Transactional onboarding → send regardless of consent (per PRD). Do **not** block session creation on it.

---

## Ticket 6 — Test & ship

Shipped Jul 9 (Version `4f95bdc5`). Migration `0016` applied to production D1.

**Verified**
- [x] Migration applied; `users.marketing_opt_in`/`marketing_opt_in_at` + `magic_links.marketing_opt_in` exist with `DEFAULT 0`.
- [x] Checkbox renders `checked` from a US origin (confirms `request.cf.country` is populated and the region branch works).
- [x] `__CONSENT_CHECKED__` placeholder never leaks to the client.
- [x] `/login` returns `Cache-Control: private, no-store`.
- [x] Sender auth already good (magic links deliver, so Brevo SPF/DKIM is set).

**End-to-end verified in production (Jul 9, via `retorres99+trial01/02@gmail.com` test signups, cleaned up after)**
- [x] Fresh email, box **unchecked** → `magic_links.marketing_opt_in = 0`, `users.marketing_opt_in = 0`, `marketing_opt_in_at = NULL`.
- [x] Fresh email, box **checked** → both = 1, `marketing_opt_in_at` set.
- [x] Welcome email arrives once on first login (~seconds after verify); does **not** re-send on subsequent logins.
- [x] Welcome email sends regardless of consent (transactional, per PRD P0-2) — confirmed on the unchecked signup.
- [x] Re-login with box unchecked does **not** downgrade existing consent (still 1, original timestamp).
- [x] Magic link works through Brevo's click-tracking redirect (sendibt2/3 → /api/auth/verify → 302 /dashboard + session cookie).

**Rough est:** Ticket 2 ~1h · Ticket 3 ~2h · Ticket 4 ~1.5h · Ticket 5 ~3h · Ticket 6 ~1.5h ≈ **9h**, comfortably inside two days.
