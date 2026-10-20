-- Serves "submissions of an assignment pushed after T, sorted by last push" straight from the index.
-- Its assignment_name prefix still serves plain assignment lookups, so the old single-column index goes.
DROP INDEX IF EXISTS idx_submissions_assignment_name;
CREATE INDEX idx_submissions_assignment_last_push ON submissions (assignment_name, last_push);
