-- ============================================================================
-- MIGRATION 0006: Multi-Tenant SaaS Support
-- Adds users, properties, and oauth_states tables.
-- Adds user_id column to all existing tables for tenant isolation.
-- ============================================================================

-- Users table (populated from Cloudflare Access JWT on first login)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  plan TEXT NOT NULL DEFAULT 'trial',
  trial_ends_at TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_stripe ON users(stripe_customer_id);

-- User's websites (replaces hardcoded PROPERTIES in config.js)
CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1',
  cf_zone_ids TEXT,
  cf_api_token_encrypted TEXT,
  google_refresh_token_encrypted TEXT,
  ga4_property_id TEXT,
  gsc_properties TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_properties_user ON properties(user_id);
CREATE UNIQUE INDEX idx_properties_domain_user ON properties(user_id, domain);

-- OAuth state tracking (for Google OAuth flow)
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  property_id TEXT,
  provider TEXT NOT NULL DEFAULT 'google',
  redirect_uri TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Add user_id to all existing tables for tenant isolation
ALTER TABLE audits ADD COLUMN user_id TEXT;
ALTER TABLE issues ADD COLUMN user_id TEXT;
ALTER TABLE broken_links ADD COLUMN user_id TEXT;
ALTER TABLE accessibility_issues ADD COLUMN user_id TEXT;
ALTER TABLE keywords ADD COLUMN user_id TEXT;
ALTER TABLE performance_snapshots ADD COLUMN user_id TEXT;
ALTER TABLE performance_history ADD COLUMN user_id TEXT;

-- Indexes for tenant-scoped queries on existing tables
CREATE INDEX idx_audits_user ON audits(user_id);
CREATE INDEX idx_issues_user ON issues(user_id);
CREATE INDEX idx_broken_links_user ON broken_links(user_id);
CREATE INDEX idx_a11y_user ON accessibility_issues(user_id);
CREATE INDEX idx_keywords_user ON keywords(user_id);
CREATE INDEX idx_perf_snap_user ON performance_snapshots(user_id);
CREATE INDEX idx_perf_hist_user ON performance_history(user_id);
