-- ============================================================================
-- MIGRATION 0013: Team Members
-- Allows multiple users to share a single dashboard.
-- The owner (admin) can invite members who see the same properties/data.
-- Only the admin can manage billing, add/remove sites, and manage the team.
-- ============================================================================

CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT NOT NULL,
  member_user_id TEXT,
  member_email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  invited_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT,
  invite_token TEXT,
  invite_expires_at TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_team_owner ON team_members(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_team_member ON team_members(member_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_unique ON team_members(owner_user_id, member_email);
