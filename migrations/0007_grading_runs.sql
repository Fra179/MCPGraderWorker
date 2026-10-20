-- Stop the old grader and drain/cancel its active snapshots before applying this migration.
-- Fail rather than silently abandon legacy work. Completed legacy results stay visible.
CREATE TABLE grading_runs_migration_guard (no_active_legacy_tasks INTEGER CHECK (no_active_legacy_tasks = 1));
INSERT INTO grading_runs_migration_guard
SELECT NOT EXISTS (SELECT 1 FROM leaderboard WHERE active_update_id IS NOT NULL);
DROP TABLE grading_runs_migration_guard;

CREATE TABLE grading_runs (
  run_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  task TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  previous_run_id TEXT,
  update_id INTEGER,
  name TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  perf_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'completed', 'cancelled')),
  started_at TEXT NOT NULL,
  terminal_at TEXT,
  cancellation_reason TEXT,
  result_json TEXT,
  result_digest TEXT,
  superseded_at TEXT,
  UNIQUE (submission_id, task, revision)
);
CREATE UNIQUE INDEX grading_runs_one_active ON grading_runs(submission_id, task) WHERE state = 'active';
CREATE INDEX grading_runs_active_update ON grading_runs(submission_id, update_id) WHERE state = 'active';
CREATE INDEX grading_runs_expired_payload ON grading_runs(superseded_at) WHERE result_json IS NOT NULL;

ALTER TABLE leaderboard ADD COLUMN latest_run_id TEXT;
ALTER TABLE leaderboard ADD COLUMN active_run_id TEXT;
ALTER TABLE leaderboard ADD COLUMN result_run_id TEXT;
ALTER TABLE leaderboard ADD COLUMN last_revision INTEGER NOT NULL DEFAULT 0;

-- These projections run in the same transaction as each accepted run transition.
CREATE TRIGGER grading_runs_start AFTER INSERT ON grading_runs
BEGIN
  INSERT INTO leaderboard (submission_id, task, name, active_update_id, active_commit_hash,
    grading_started_at, latest_run_id, active_run_id, last_revision)
  VALUES (NEW.submission_id, NEW.task, NEW.name, NEW.update_id, NEW.commit_hash,
    NEW.started_at, NEW.run_id, NEW.run_id, NEW.revision)
  ON CONFLICT (submission_id, task) DO UPDATE SET
    name = excluded.name, active_update_id = excluded.active_update_id,
    active_commit_hash = excluded.active_commit_hash, grading_started_at = excluded.grading_started_at,
    latest_run_id = excluded.latest_run_id, active_run_id = excluded.active_run_id,
    last_revision = excluded.last_revision;
END;

CREATE TRIGGER grading_runs_finish AFTER UPDATE OF state ON grading_runs
WHEN OLD.state = 'active' AND NEW.state = 'completed'
BEGIN
  UPDATE grading_runs SET superseded_at = NEW.terminal_at
  WHERE run_id = (SELECT result_run_id FROM leaderboard
    WHERE submission_id = NEW.submission_id AND task = NEW.task AND active_run_id = NEW.run_id);
  UPDATE leaderboard SET result_json = NEW.result_json, result_update_id = NEW.update_id,
    result_run_id = NEW.run_id, graded_at = NEW.terminal_at,
    active_update_id = NULL, active_commit_hash = NULL, grading_started_at = NULL, active_run_id = NULL
  WHERE submission_id = NEW.submission_id AND task = NEW.task AND active_run_id = NEW.run_id;
END;

CREATE TRIGGER grading_runs_cancel AFTER UPDATE OF state ON grading_runs
WHEN OLD.state = 'active' AND NEW.state = 'cancelled'
BEGIN
  UPDATE leaderboard SET active_update_id = NULL, active_commit_hash = NULL,
    grading_started_at = NULL, active_run_id = NULL
  WHERE submission_id = NEW.submission_id AND task = NEW.task AND active_run_id = NEW.run_id;
END;
