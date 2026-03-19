-- Magic link tokens for passwordless authentication
CREATE TABLE IF NOT EXISTS magic_links (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);

-- Clean up expired magic links (run periodically)
-- DELETE FROM magic_links WHERE expires_at < datetime('now') OR used = 1;
