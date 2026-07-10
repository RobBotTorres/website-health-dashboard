-- Lifecycle email stage tracking (PRD: trial conversion funnel, P0-5)
--
-- One row per (user, stage) ever sent. The UNIQUE constraint is the
-- idempotency guarantee: the orchestrator claims a stage with INSERT OR
-- IGNORE before sending, so each user receives each email at most once
-- even if the cron overlaps or retries.
CREATE TABLE IF NOT EXISTS lifecycle_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  stage TEXT NOT NULL,            -- 'educational' | 'pre_expiry' (extensible: 'win_back', ...)
  sent_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_emails_user ON lifecycle_emails(user_id);
