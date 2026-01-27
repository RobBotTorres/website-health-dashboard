-- Keywords table to store Search Console query data
CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  query TEXT NOT NULL,
  clicks INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0,
  position REAL DEFAULT 0,
  prev_position REAL,
  position_change REAL,
  data_date DATE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(domain, query, data_date)
);

CREATE INDEX IF NOT EXISTS idx_keywords_domain_date ON keywords(domain, data_date);
CREATE INDEX IF NOT EXISTS idx_keywords_clicks ON keywords(domain, clicks DESC);
