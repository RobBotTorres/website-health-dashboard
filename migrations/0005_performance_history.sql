-- Performance history for trend charts (CWV over time)
CREATE TABLE IF NOT EXISTS performance_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  date TEXT NOT NULL,
  lcp_ms INTEGER,
  fcp_ms INTEGER,
  cls REAL,
  inp_ms INTEGER,
  ttfb_ms INTEGER,
  recorded_at TEXT DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(domain, date)
);

CREATE INDEX IF NOT EXISTS idx_perf_history_domain_date ON performance_history(domain, date DESC);
