-- Domain-level AI readiness checks (one row per domain per audit)
CREATE TABLE IF NOT EXISTS ai_readiness (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  audit_date DATE NOT NULL,
  user_id TEXT,
  llms_txt_exists INTEGER DEFAULT 0,
  llms_txt_quality TEXT,
  llms_full_txt_exists INTEGER DEFAULT 0,
  ai_bot_rules TEXT,
  ai_bots_blocked INTEGER DEFAULT 0,
  ai_bots_allowed INTEGER DEFAULT 0,
  ai_readiness_score INTEGER DEFAULT 0,
  schema_depth_avg REAL DEFAULT 0,
  content_clarity_avg REAL DEFAULT 0,
  csr_pages INTEGER DEFAULT 0,
  faq_opportunity_pages INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(domain, audit_date)
);

-- Page-level AI readiness issues
CREATE TABLE IF NOT EXISTS ai_readiness_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  page_path TEXT NOT NULL,
  page_url TEXT,
  details TEXT,
  first_seen DATE NOT NULL,
  last_seen DATE NOT NULL,
  fixed_at DATE,
  manually_fixed_at DATE,
  manually_fixed_by TEXT,
  reactivated_at DATE,
  ai_suggestion TEXT,
  user_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(domain, issue_type, page_path)
);

CREATE INDEX IF NOT EXISTS idx_ai_readiness_domain ON ai_readiness(domain, audit_date);
CREATE INDEX IF NOT EXISTS idx_ai_readiness_issues_domain ON ai_readiness_issues(domain);
CREATE INDEX IF NOT EXISTS idx_ai_readiness_issues_fixed ON ai_readiness_issues(domain, fixed_at);
