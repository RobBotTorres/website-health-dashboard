-- Add quick_audit flag to distinguish quick audits from full crawls
-- Quick audits run on property creation (homepage only, ~3-5 seconds)
-- Full audits run on the daily cron (full sitemap crawl, ~90-120 seconds)
ALTER TABLE audits ADD COLUMN quick_audit INTEGER DEFAULT 0;
