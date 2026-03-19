-- ============================================================================
-- MIGRATION 0011: Lighthouse Accessibility Cache
-- Stores Lighthouse accessibility audit results in performance_snapshots
-- so we don't need to re-call the PSI API for accessibility data.
-- ============================================================================

ALTER TABLE performance_snapshots ADD COLUMN lighthouse_a11y TEXT;
