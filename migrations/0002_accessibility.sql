-- Accessibility issues tracking
CREATE TABLE IF NOT EXISTS accessibility_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  issue_type TEXT NOT NULL,  -- missing_alt, missing_lang, empty_links, missing_labels, no_skip_link, heading_hierarchy, empty_buttons
  severity TEXT NOT NULL,    -- high, medium, low
  page_path TEXT NOT NULL,
  page_url TEXT,
  issue_count INTEGER DEFAULT 1,
  first_seen DATE NOT NULL,
  last_seen DATE NOT NULL,
  fixed_at DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(domain, issue_type, page_path)
);

CREATE INDEX IF NOT EXISTS idx_a11y_domain ON accessibility_issues(domain);
CREATE INDEX IF NOT EXISTS idx_a11y_fixed ON accessibility_issues(domain, fixed_at);
