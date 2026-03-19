-- ============================================================================
-- MIGRATION 0012: Manual Issue Actions
-- Lets users mark issues as "completed" and tracks reactivation when crawls
-- find the same issue again after manual completion.
-- ============================================================================

-- Action log for issue status changes (complete, reopen, reactivated)
CREATE TABLE IF NOT EXISTS issue_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL,
  issue_table TEXT NOT NULL DEFAULT 'issues',
  action TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_email TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_issue_actions_issue ON issue_actions(issue_id, issue_table);

-- Add manual-fix tracking columns to issues table
ALTER TABLE issues ADD COLUMN manually_fixed_at TEXT;
ALTER TABLE issues ADD COLUMN manually_fixed_by TEXT;
ALTER TABLE issues ADD COLUMN reactivated_at TEXT;

-- Add manual-fix tracking columns to accessibility_issues table
ALTER TABLE accessibility_issues ADD COLUMN manually_fixed_at TEXT;
ALTER TABLE accessibility_issues ADD COLUMN manually_fixed_by TEXT;
ALTER TABLE accessibility_issues ADD COLUMN reactivated_at TEXT;
