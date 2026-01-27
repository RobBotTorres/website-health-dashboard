-- Performance metrics storage for fast loading
CREATE TABLE IF NOT EXISTS performance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  
  -- Cloudflare metrics
  cf_requests INTEGER,
  cf_requests_change REAL,
  cf_bandwidth TEXT,
  cf_cache_ratio REAL,
  cf_error_rate REAL,
  cf_threats INTEGER,
  cf_2xx INTEGER,
  cf_3xx INTEGER,
  cf_4xx INTEGER,
  cf_5xx INTEGER,
  
  -- Core Web Vitals
  cwv_lcp INTEGER,
  cwv_lcp_rating TEXT,
  cwv_inp INTEGER,
  cwv_inp_rating TEXT,
  cwv_cls REAL,
  cwv_cls_rating TEXT,
  cwv_fcp INTEGER,
  cwv_fcp_rating TEXT,
  cwv_ttfb INTEGER,
  cwv_overall TEXT,
  
  -- GA4 metrics (when available)
  ga4_sessions INTEGER,
  ga4_sessions_change REAL,
  ga4_users INTEGER,
  ga4_users_change REAL,
  ga4_bounce_rate REAL,
  ga4_avg_duration TEXT,
  ga4_engagement_rate REAL,
  ga4_page_views INTEGER,
  ga4_top_pages TEXT, -- JSON array
  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(domain, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_perf_domain_date ON performance_snapshots(domain, snapshot_date DESC);
