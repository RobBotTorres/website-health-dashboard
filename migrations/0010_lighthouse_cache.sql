-- ============================================================================
-- MIGRATION 0010: Lighthouse Cache Enhancements
-- Adds performance score, data source, and speed index columns to
-- performance_snapshots so Lighthouse lab data can be fully cached.
-- ============================================================================

ALTER TABLE performance_snapshots ADD COLUMN cwv_performance_score INTEGER;
ALTER TABLE performance_snapshots ADD COLUMN cwv_source TEXT;
ALTER TABLE performance_snapshots ADD COLUMN cwv_speed_index INTEGER;
ALTER TABLE performance_snapshots ADD COLUMN cwv_tested_domain TEXT;
