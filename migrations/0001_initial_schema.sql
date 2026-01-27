-- Daily audit runs
CREATE TABLE IF NOT EXISTS audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  audit_date DATE NOT NULL,
  total_pages INTEGER DEFAULT 0,
  pages_audited INTEGER DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(domain, audit_date)
);

-- SEO issues (missing titles, descriptions, H1s, schema errors)
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  issue_type TEXT NOT NULL,  -- missing_title, short_title, missing_description, short_description, missing_h1, multiple_h1, missing_schema, schema_error
  severity TEXT NOT NULL,    -- high, medium, low
  page_path TEXT NOT NULL,
  page_url TEXT,
  details TEXT,              -- JSON for extra info like title length, etc.
  first_seen DATE NOT NULL,
  last_seen DATE NOT NULL,
  fixed_at DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(domain, issue_type, page_path)
);

-- Broken links
CREATE TABLE IF NOT EXISTS broken_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  source_path TEXT,          -- Page where the link was found
  link_url TEXT NOT NULL,
  link_path TEXT NOT NULL,
  status_code INTEGER,
  first_seen DATE NOT NULL,
  last_seen DATE NOT NULL,
  fixed_at DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(domain, link_path)
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_issues_domain ON issues(domain);
CREATE INDEX IF NOT EXISTS idx_issues_domain_type ON issues(domain, issue_type);
CREATE INDEX IF NOT EXISTS idx_issues_fixed ON issues(domain, fixed_at);
CREATE INDEX IF NOT EXISTS idx_issues_first_seen ON issues(domain, first_seen);
CREATE INDEX IF NOT EXISTS idx_broken_domain ON broken_links(domain);
CREATE INDEX IF NOT EXISTS idx_broken_fixed ON broken_links(domain, fixed_at);
CREATE INDEX IF NOT EXISTS idx_audits_domain ON audits(domain, audit_date);
