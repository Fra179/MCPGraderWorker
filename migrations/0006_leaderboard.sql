-- Push versions survive acknowledgement, so an old acknowledgement cannot consume a new push.
ALTER TABLE submissions ADD COLUMN push_version INTEGER NOT NULL DEFAULT 0;
UPDATE submissions SET push_version = 1
WHERE last_push IS NOT NULL OR repo_ssh_url IN (SELECT repo_ssh_url FROM updates);
ALTER TABLE updates ADD COLUMN update_id INTEGER NOT NULL DEFAULT 1;
DELETE FROM updates WHERE repo_ssh_url NOT IN (SELECT repo_ssh_url FROM submissions);
CREATE TRIGGER submissions_delete_updates AFTER DELETE ON submissions
BEGIN
  DELETE FROM updates WHERE repo_ssh_url = OLD.repo_ssh_url;
END;

CREATE TABLE leaderboard (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  task TEXT NOT NULL,
  name TEXT NOT NULL,
  result_json TEXT,
  result_update_id INTEGER,
  active_update_id INTEGER,
  active_commit_hash TEXT,
  grading_started_at TEXT,
  graded_at TEXT,
  PRIMARY KEY (submission_id, task)
);
