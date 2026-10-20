-- Optional maintenance, after migration 0007. Compact identity/digest records are never deleted.
-- npx wrangler d1 execute grader-db --remote --file scripts/prune-grading.sql
UPDATE grading_runs SET result_json = NULL
WHERE result_json IS NOT NULL
  AND superseded_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')
  AND NOT EXISTS (SELECT 1 FROM leaderboard WHERE result_run_id = grading_runs.run_id);
