-- Add AI fix suggestion columns
ALTER TABLE issues ADD COLUMN ai_suggestion TEXT;
ALTER TABLE accessibility_issues ADD COLUMN ai_suggestion TEXT;
