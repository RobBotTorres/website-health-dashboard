-- ============================================================================
-- MIGRATION 0009: Stripe Billing Support
-- Adds subscription tracking and billing event log.
-- Users table already has stripe_customer_id and stripe_subscription_id
-- from migration 0006. This adds detailed subscription state and history.
-- ============================================================================

-- Subscriptions table — detailed Stripe subscription state
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,                          -- Stripe subscription ID (sub_xxx)
  user_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'pro',             -- 'pro' or 'agency'
  status TEXT NOT NULL DEFAULT 'active',        -- active, past_due, canceled, trialing, unpaid
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER DEFAULT 0,
  canceled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_customer ON subscriptions(stripe_customer_id);

-- Billing events log — track all Stripe webhook events for debugging
CREATE TABLE IF NOT EXISTS billing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_event_id TEXT NOT NULL UNIQUE,         -- evt_xxx (for idempotency)
  event_type TEXT NOT NULL,                      -- e.g. checkout.session.completed
  user_id TEXT,
  subscription_id TEXT,
  data TEXT,                                     -- JSON payload summary
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_billing_events_user ON billing_events(user_id);
CREATE INDEX idx_billing_events_type ON billing_events(event_type);
