-- Marketing email consent (PRD: trial conversion funnel, P0-1)
--
-- The column default is 0. The login page renders the checkbox pre-checked only
-- for visitors outside the EU/EEA/UK, so a stored 1 always reflects an actual
-- affirmative choice by the user (GDPR Art. 4(11)).
ALTER TABLE users ADD COLUMN marketing_opt_in INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN marketing_opt_in_at TEXT;

-- Auth is magic-link based: the user record is created at verify time, but
-- consent is chosen earlier when the link is requested. Park it on the
-- magic_links row so it can be carried across to the users row on verify.
ALTER TABLE magic_links ADD COLUMN marketing_opt_in INTEGER DEFAULT 0;
